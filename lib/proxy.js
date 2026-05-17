const { createProxyMiddleware } = require('http-proxy-middleware');
const { getApp } = require('./registry');

function proxyMiddleware(req, res, next) {
  const host = req.headers.host?.split(':')[0];
  const domain = process.env.CLOUDFLARE_DOMAIN || 'sycord.site';

  if (!host) return next();

  // Root domain → serve runner dashboard
  if (host === domain || host === `www.${domain}`) {
    return next();
  }

  // Not our domain → let runner handle it
  if (!host.endsWith(`.${domain}`)) {
    return next();
  }

  const appName = host.replace(`.${domain}`, '');
  const entry = getApp(appName);

  if (!entry) {
    return res.status(404).send(`No app found for ${host}`);
  }

  if (entry.status !== 'online' || !entry.port) {
    return res.status(503).send(`${appName} is not online (status: ${entry.status || 'unknown'})`);
  }

  return createProxyMiddleware({
    target: `http://127.0.0.1:${entry.port}`,
    changeOrigin: true,
    ws: true,
    xfwd: true,
    logLevel: 'warn',
  })(req, res, next);
}

module.exports = proxyMiddleware;
