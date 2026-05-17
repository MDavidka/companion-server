// Cloudflare Tunnel (cloudflared) ingress manager.
//
// When CLOUDFLARED_TUNNEL_ID and CLOUDFLARE_ACCOUNT_ID are configured, this
// module updates the named tunnel's ingress configuration via the Cloudflare
// API so that <subdomain>.<CLOUDFLARE_DOMAIN> is routed to the local
// mini-server bound to http://localhost:<port>. This is the correct way to
// expose a local port through Cloudflare without opening the public host.

const API = 'https://api.cloudflare.com/client/v4';
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const TUNNEL_ID = process.env.CLOUDFLARED_TUNNEL_ID;
const ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const DOMAIN = process.env.CLOUDFLARE_DOMAIN || 'sycord.site';

function noop() {}

function enabled() {
  return Boolean(TOKEN && ACCOUNT_ID && TUNNEL_ID);
}

async function cf(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

/**
 * Connect a localhost port to a Cloudflare tunnel hostname.
 * - Adds an ingress rule { hostname: <sub>.<domain>, service: http://localhost:<port> }
 *   to the tunnel configuration (preserving existing rules).
 * - Creates / updates the DNS CNAME so <sub>.<domain> → <tunnel-id>.cfargotunnel.com
 */
async function connectTunnel(projectName, port, logger) {
  const log = typeof logger === 'function' ? logger : noop;
  const hostname = `${projectName}.${DOMAIN}`;
  const service = `http://localhost:${port}`;

  log(`[cloudflare] ── tunnel ingress step ─────────────────────────`);
  log(`[cloudflare] tunnel id:       ${TUNNEL_ID || '(missing)'}`);
  log(`[cloudflare] account id:      ${ACCOUNT_ID ? ACCOUNT_ID.slice(0,6)+'…' : '(missing)'}`);
  log(`[cloudflare] mapping:         ${hostname}  →  ${service}`);

  if (!enabled()) {
    log(`[cloudflare] tunnel mode DISABLED (missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARED_TUNNEL_ID).`);
    log(`[cloudflare] Falling back to plain CNAME → SERVER_HOST. This only works if the public host`);
    log(`[cloudflare] terminates TLS for *.${DOMAIN} and proxies the Host header back to localhost:${port}.`);
    log(`[cloudflare] To route localhost:${port} directly via cloudflared, set:`);
    log(`[cloudflare]   CLOUDFLARE_ACCOUNT_ID=<acct>  CLOUDFLARED_TUNNEL_ID=<tunnel-uuid>`);
    return { success: false, mode: 'disabled' };
  }

  // 1) GET current tunnel configuration
  const cfgPath = `/accounts/${ACCOUNT_ID}/cfd_tunnel/${TUNNEL_ID}/configurations`;
  log(`[cloudflare] → GET ${cfgPath}`);
  const t0 = Date.now();
  const cur = await cf(cfgPath);
  log(`[cloudflare] ← ${cur.status} (${Date.now()-t0}ms)`);
  if (!cur.ok) {
    log(`[cloudflare] ERROR fetching tunnel config: ${JSON.stringify(cur.body.errors || cur.body)}`);
    return { success: false, mode: 'tunnel', error: 'fetch config failed' };
  }

  const config = (cur.body.result && cur.body.result.config) || {};
  const ingress = Array.isArray(config.ingress) ? config.ingress.slice() : [];
  log(`[cloudflare] existing ingress rules: ${ingress.length}`);

  // 2) Remove any existing rule with same hostname, then prepend ours
  const filtered = ingress.filter(r => r && r.hostname !== hostname);
  const newRule = { hostname, service, originRequest: { connectTimeout: 30, noTLSVerify: true } };
  const catchAll = filtered.find(r => r && !r.hostname);
  const withoutCatch = filtered.filter(r => r && r.hostname);
  const finalIngress = [...withoutCatch, newRule, catchAll || { service: 'http_status:404' }];

  log(`[cloudflare] new ingress rule:  ${JSON.stringify(newRule)}`);
  log(`[cloudflare] total ingress after update: ${finalIngress.length}`);

  // 3) PUT updated configuration
  log(`[cloudflare] → PUT ${cfgPath}`);
  const t1 = Date.now();
  const put = await cf(cfgPath, {
    method: 'PUT',
    body: JSON.stringify({ config: { ...config, ingress: finalIngress } })
  });
  log(`[cloudflare] ← ${put.status} (${Date.now()-t1}ms)`);
  if (!put.ok) {
    log(`[cloudflare] ERROR updating ingress: ${JSON.stringify(put.body.errors || put.body)}`);
    return { success: false, mode: 'tunnel', error: 'put config failed' };
  }
  log(`[cloudflare] SUCCESS ingress rule installed for ${hostname}`);

  // 4) Ensure DNS CNAME → <tunnel-id>.cfargotunnel.com (proxied)
  if (ZONE_ID) {
    const cnameTarget = `${TUNNEL_ID}.cfargotunnel.com`;
    log(`[cloudflare] ensuring DNS CNAME ${hostname} → ${cnameTarget}`);
    const list = await cf(`/zones/${ZONE_ID}/dns_records?type=CNAME&name=${hostname}`);
    const existing = (list.body.result || [])[0];
    const payload = { type: 'CNAME', name: hostname, content: cnameTarget, ttl: 1, proxied: true };

    let r;
    if (existing) {
      log(`[cloudflare] → PUT /zones/${ZONE_ID}/dns_records/${existing.id}`);
      r = await cf(`/zones/${ZONE_ID}/dns_records/${existing.id}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      log(`[cloudflare] → POST /zones/${ZONE_ID}/dns_records`);
      r = await cf(`/zones/${ZONE_ID}/dns_records`, { method: 'POST', body: JSON.stringify(payload) });
    }
    log(`[cloudflare] ← ${r.status} (DNS upsert)`);
    if (!r.ok) {
      log(`[cloudflare] ERROR DNS upsert: ${JSON.stringify(r.body.errors || r.body)}`);
    } else {
      log(`[cloudflare] SUCCESS DNS routed via tunnel`);
    }
  } else {
    log(`[cloudflare] CLOUDFLARE_ZONE_ID missing — skipping DNS upsert (you must add the CNAME manually).`);
  }

  log(`[cloudflare] public url:       https://${hostname}`);
  return { success: true, mode: 'tunnel', url: `https://${hostname}`, hostname };
}

module.exports = { connectTunnel, enabled, DOMAIN };
