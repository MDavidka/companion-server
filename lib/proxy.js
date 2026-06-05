const { createProxyMiddleware } = require('http-proxy-middleware');
const { getApp } = require('./registry');

const DEBUG = process.env.PROXY_DEBUG !== 'false';
const DOMAIN = (process.env.CLOUDFLARE_DOMAIN || 'sycord.site').toLowerCase();

function dlog(...args) {
  if (DEBUG) console.log('[proxy]', ...args);
}

// Cache proxy instances per port so we don't recreate on every request
const proxyCache = new Map();
function getProxy(port) {
  if (proxyCache.has(port)) return proxyCache.get(port);
  const target = `http://127.0.0.1:${port}`;
  const mw = createProxyMiddleware({
    target,
    changeOrigin: true,
    ws: true,
    xfwd: true,
    logger: console,
    proxyTimeout: 30000,
    timeout: 30000,
    on: {
      error(err, req, res) {
        console.error(`[proxy] upstream error host="${req.headers.host}" target="${target}":`, err.message);
        if (res && !res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Bad gateway: ${err.message}`);
        }
      },
      proxyReq(proxyReq, req) {
        dlog(`proxy request host="${req.headers.host}" url="${req.url}" target="${target}${req.url}"`);
      },
      proxyRes(proxyRes, req) {
        dlog(`proxy response host="${req.headers.host}" status=${proxyRes.statusCode} target="${target}"`);
      },
    },
  });
  proxyCache.set(port, mw);
  return mw;
}

function extractHost(req) {
  const raw = req.headers.host || req.headers[':authority'] || '';
  // Strip an optional port while preserving IPv6 literals well enough for non-domain bypasses.
  return String(raw).trim().toLowerCase().replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '');
}

function proxyMiddleware(req, res, next) {
  const host = extractHost(req);
  dlog(`incoming host="${host}" url="${req.url}"`);

  if (!host) {
    dlog('no host header → next()');
    return next();
  }

  // Root domain or www → runner dashboard / API
  if (host === DOMAIN || host === `www.${DOMAIN}`) {
    dlog(`root domain bypass host="${host}" → runner/dashboard`);
    return next();
  }

  // Localhost / IPs / no-dot hosts → runner dashboard
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') && !host.includes('.');
  if (host === 'localhost' || isIp || !host.includes('.')) {
    dlog(`local/IP host "${host}" → runner`);
    return next();
  }

  // Determine appName from leftmost subdomain label
  let appName;
  if (host.endsWith(`.${DOMAIN}`)) {
    const sub = host.slice(0, host.length - DOMAIN.length - 1);
    appName = sub.split('.')[0];
    dlog(`matched configured DOMAIN host="${host}" appName="${appName}"`);
  } else {
    // Host is some other FQDN — still treat leftmost label as app candidate so
    // a DOMAIN env mismatch never silently leaks the dashboard.
    appName = host.split('.')[0];
    dlog(`host "${host}" not under .${DOMAIN} — trying leftmost label appName="${appName}"`);
  }

  if (!appName) {
    dlog('empty appName → 404');
    return res.status(404).type('text/plain').send(`No app in hostname: ${host}`);
  }

  let entry;
  try {
    entry = getApp(appName);
  } catch (e) {
    console.error('[proxy] registry lookup failed:', e);
    return res.status(500).type('text/plain').send('Registry lookup error');
  }

  dlog(`registry entry appName="${appName}":`, entry ? { port: entry.port, status: entry.status, url: entry.url, publicUrl: entry.publicUrl } : null);

  if (!entry) {
    dlog(`registry miss host="${host}" appName="${appName}" → 404`);
    return res.status(404).type('text/plain').send(`No app registered for "${appName}" (${host})`);
  }

  if (!entry.port) {
    dlog(`registry entry missing port host="${host}" appName="${appName}" → 503`);
    return res.status(503).type('text/plain').send(`App "${appName}" has no port assigned`);
  }

  if (entry.status && entry.status !== 'online') {
    dlog(`registry entry offline host="${host}" appName="${appName}" status="${entry.status}" → 503`);
    return res.status(503).type('text/plain').send(`App "${appName}" not online (status: ${entry.status})`);
  }

  const target = `http://127.0.0.1:${entry.port}`;
  dlog(`proxy target host="${host}" appName="${appName}" → ${target}`);

  try {
    const proxy = getProxy(entry.port);
    return proxy(req, res, (err) => {
      if (err) {
        console.error(`[proxy] middleware next(err) host="${host}" target="${target}":`, err.message || err);
        if (!res.headersSent) {
          return res.status(502).type('text/plain').send(`Proxy error: ${err.message || err}`);
        }
        return;
      }

      // A matching wildcard subdomain must never silently fall through to the dashboard/API routes.
      console.error(`[proxy] unexpected fallthrough host="${host}" appName="${appName}" target="${target}"`);
      if (!res.headersSent) {
        return res.status(502).type('text/plain').send(`Proxy did not handle ${host}`);
      }
    });
  } catch (e) {
    console.error('[proxy] middleware threw:', e);
    if (!res.headersSent) {
      res.status(502).type('text/plain').send(`Proxy error: ${e.message}`);
    }
  }
}

module.exports = proxyMiddleware;
