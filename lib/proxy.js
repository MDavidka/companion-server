const { createProxyMiddleware } = require('http-proxy-middleware');
const { getApp } = require('./registry');

function proxyMiddleware(req, res, next) {
  const host = req.headers.host?.split(':')[0];
  const domain = process.env.CLOUDFLARE_DOMAIN || 'micro1.sycord.com';

  if (host && host.endsWith(`.${domain}`) && host !== domain && host !== `www.${domain}`) {
    const appName = host.replace(`.${domain}`, '');
    const entry = getApp(appName);

    if (entry && entry.status === 'online' && entry.port) {
      return createProxyMiddleware({
        target: `http://localhost:${entry.port}`,
        changeOrigin: true,
        ws: true,
        logLevel: 'error',
      })(req, res, next);
    }
  }
  next();
}

module.exports = proxyMiddleware;
