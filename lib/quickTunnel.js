// Cloudflare "quick tunnel" fallback.
//
// When no named tunnel / DNS credentials are configured (or they fail), spawn
// `cloudflared tunnel --url http://localhost:<port>` to obtain an ephemeral
// https://*.trycloudflare.com URL that exposes the local mini-server.
//
// Requires the `cloudflared` binary to be installed on the host.

const { spawn } = require('child_process');

const activeTunnels = {};

function isAvailable() {
  return new Promise((resolve) => {
    const p = spawn('cloudflared', ['--version']);
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

function stopQuickTunnel(appName) {
  if (activeTunnels[appName]) {
    try { activeTunnels[appName].kill(); } catch (_) {}
    delete activeTunnels[appName];
  }
}

/**
 * Start a quick tunnel for localhost:<port>. Resolves with the public URL once
 * cloudflared prints the trycloudflare.com hostname (or null on timeout).
 */
async function startQuickTunnel(appName, port, logger) {
  const log = typeof logger === 'function' ? logger : () => {};

  const available = await isAvailable();
  if (!available) {
    log(`[cloudflare] quick-tunnel UNAVAILABLE — \`cloudflared\` binary not found on PATH.`);
    log(`[cloudflare] install with:  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared`);
    return null;
  }

  stopQuickTunnel(appName);

  log(`[cloudflare] ── quick-tunnel step ───────────────────────────`);
  log(`[cloudflare] spawning: cloudflared tunnel --url http://localhost:${port}`);

  return new Promise((resolve) => {
    const child = spawn('cloudflared', [
      'tunnel',
      '--no-autoupdate',
      '--url', `http://localhost:${port}`
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    activeTunnels[appName] = child;
    let resolved = false;
    const urlRegex = /https?:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

    const handle = (data) => {
      const text = data.toString();
      text.split('\n').filter(l => l.trim()).forEach(line => log(`[cloudflared] ${line.trim()}`));
      if (!resolved) {
        const m = text.match(urlRegex);
        if (m) {
          resolved = true;
          const url = m[0];
          log(`[cloudflare] quick-tunnel READY → ${url}  ⇄  http://localhost:${port}`);
          resolve({ success: true, mode: 'quick-tunnel', url, hostname: url.replace(/^https?:\/\//, '') });
        }
      }
    };

    child.stdout.on('data', handle);
    child.stderr.on('data', handle);

    child.on('exit', (code) => {
      log(`[cloudflared] process exited with code ${code}`);
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
      delete activeTunnels[appName];
    });

    // Safety timeout — cloudflared usually prints URL within 5–10s
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        log(`[cloudflare] quick-tunnel TIMEOUT after 30s waiting for URL.`);
        resolve(null);
      }
    }, 30000);
  });
}

module.exports = { startQuickTunnel, stopQuickTunnel, isAvailable };
