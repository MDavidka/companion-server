const CLOUDFLARE_API_KEY = process.env.CLOUDFLARE_API_KEY;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_DOMAIN = process.env.CLOUDFLARE_DOMAIN || 'sycord.site';
const API_TIMEOUT = 30000;

function noop() {}

async function createCloudflareDnsRecord(projectName, targetDomain, logger) {
  const log = typeof logger === 'function' ? logger : noop;
  const subdomain = `${projectName}.${CLOUDFLARE_DOMAIN}`;

  log(`[cloudflare] ── DNS connection step ─────────────────────────`);
  log(`[cloudflare] project: ${projectName}`);
  log(`[cloudflare] target subdomain: ${subdomain}`);
  log(`[cloudflare] CNAME target host: ${targetDomain}`);
  log(`[cloudflare] zone id: ${CLOUDFLARE_ZONE_ID ? CLOUDFLARE_ZONE_ID.slice(0,6) + '…' : '(missing)'}`);
  log(`[cloudflare] api token: ${CLOUDFLARE_API_KEY ? 'present (' + CLOUDFLARE_API_KEY.length + ' chars)' : '(missing)'}`);

  if (!CLOUDFLARE_API_KEY || !CLOUDFLARE_ZONE_ID) {
    const msg = 'Cloudflare API token or zone ID not configured for DNS record creation';
    console.error(msg);
    log(`[cloudflare] ERROR: ${msg}`);
    return null;
  }

  const recordsUrl = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records`;
  const headers = {
    'Authorization': `Bearer ${CLOUDFLARE_API_KEY}`,
    'Content-Type': 'application/json'
  };

  try {
    log(`[cloudflare] → GET ${recordsUrl}?type=CNAME&name=${subdomain}`);
    const t0 = Date.now();
    const listResponse = await fetch(`${recordsUrl}?type=CNAME&name=${subdomain}`, {
      method: 'GET',
      headers,
      timeout: API_TIMEOUT
    });
    log(`[cloudflare] ← ${listResponse.status} ${listResponse.statusText} (${Date.now()-t0}ms)`);

    const listData = await listResponse.json();
    if (!listResponse.ok) {
      log(`[cloudflare] ERROR list response: ${JSON.stringify(listData.errors || listData)}`);
      return null;
    }
    const existingRecords = listData.result || [];
    log(`[cloudflare] existing CNAME records found: ${existingRecords.length}`);

    const payload = {
      type: 'CNAME',
      name: subdomain,
      content: targetDomain,
      ttl: 1,
      proxied: true
    };
    log(`[cloudflare] payload: ${JSON.stringify(payload)}`);

    let response;
    let action;

    if (existingRecords.length > 0) {
      const recordId = existingRecords[0].id;
      log(`[cloudflare] → PUT ${recordsUrl}/${recordId} (updating existing record)`);
      const t1 = Date.now();
      response = await fetch(`${recordsUrl}/${recordId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
        timeout: API_TIMEOUT
      });
      log(`[cloudflare] ← ${response.status} ${response.statusText} (${Date.now()-t1}ms)`);
      action = 'Updated';
    } else {
      log(`[cloudflare] → POST ${recordsUrl} (creating new record)`);
      const t1 = Date.now();
      response = await fetch(recordsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        timeout: API_TIMEOUT
      });
      log(`[cloudflare] ← ${response.status} ${response.statusText} (${Date.now()-t1}ms)`);
      action = 'Created';
    }

    if (response.status === 200 || response.status === 201) {
      const result = await response.json();
      if (result.success) {
        const ok = `${action} DNS record: ${subdomain} -> ${targetDomain}`;
        console.log(ok);
        log(`[cloudflare] SUCCESS ${ok}`);
        log(`[cloudflare] record id: ${result.result && result.result.id}`);
        log(`[cloudflare] proxied: ${result.result && result.result.proxied} · ttl: ${result.result && result.result.ttl}`);
        log(`[cloudflare] public url: https://${subdomain}`);
        return {
          success: true,
          subdomain: subdomain,
          url: `https://${subdomain}`
        };
      } else {
        const err = `Cloudflare DNS API error: ${JSON.stringify(result.errors)}`;
        console.error(err);
        log(`[cloudflare] ERROR ${err}`);
        return null;
      }
    } else {
      const body = await response.text();
      const err = `Cloudflare DNS API error: ${response.status} - ${body}`;
      console.error(err);
      log(`[cloudflare] ERROR ${err}`);
      return null;
    }
  } catch (error) {
    const err = `Error creating Cloudflare DNS record: ${error.message}`;
    console.error(err);
    log(`[cloudflare] EXCEPTION ${err}`);
    return null;
  }
}

module.exports = {
  createCloudflareDnsRecord,
  CLOUDFLARE_DOMAIN
};
