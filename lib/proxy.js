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

  // Not our wildcard domain → let runner handle (could be IP, localhost, etc.)
  if (!host.endsWith(`.${DOMAIN}`)) {
    dlog(`host "${host}" not under .${DOMAIN} → runner`);
    return next();
  }

  // Extract leftmost label as app name: "shop.sycord.site" → "shop"
  // For nested like "a.b.sycord.site" we take everything before .DOMAIN
  const sub = host.slice(0, host.length - DOMAIN.length - 1); // strip ".DOMAIN"
  const appName = sub.split('.')[0];
  dlog(`matched wildcard host="${host}" subdomain="${sub}" extracted appName="${appName}"`);

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
    return getProxy(entry.port)(req, res, next);
  } catch (e) {
    console.error('[proxy] middleware threw:', e);
    if (!res.headersSent) {
      res.status(502).type('text/plain').send(`Proxy error: ${e.message}`);
    }
  }
}

module.exports = proxyMiddleware;
