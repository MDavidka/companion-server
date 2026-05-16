const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_DOMAIN = process.env.CLOUDFLARE_DOMAIN || 'micro1.sycord.com';
const API_TIMEOUT = 30000;

async function createCloudflareDnsRecord(projectName, targetDomain) {
  if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ZONE_ID) {
    console.error("Cloudflare API token or zone ID not configured for DNS record creation");
    return null;
  }

  const subdomain = `${projectName}.${CLOUDFLARE_DOMAIN}`;
  const recordsUrl = `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records`;
  
  const headers = {
    'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
    'Content-Type': 'application/json'
  };

  try {
    // Check whether a CNAME already exists for this subdomain
    const listResponse = await fetch(`${recordsUrl}?type=CNAME&name=${subdomain}`, {
      method: 'GET',
      headers,
      timeout: API_TIMEOUT
    });
    
    const listData = await listResponse.json();
    const existingRecords = listData.result || [];

    const payload = {
      type: 'CNAME',
      name: subdomain,
      content: targetDomain,
      ttl: 1, // 1 = automatic TTL (recommended for proxied records)
      proxied: true
    };

    let response;
    let action;

    if (existingRecords.length > 0) {
      // Update the existing record
      const recordId = existingRecords[0].id;
      response = await fetch(`${recordsUrl}/${recordId}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(payload),
        timeout: API_TIMEOUT
      });
      action = 'Updated';
    } else {
      // Create a new record
      response = await fetch(recordsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        timeout: API_TIMEOUT
      });
      action = 'Created';
    }

    if (response.status === 200 || response.status === 201) {
      const result = await response.json();
      if (result.success) {
        console.log(`${action} DNS record: ${subdomain} -> ${targetDomain}`);
        return {
          success: true,
          subdomain: subdomain,
          url: `https://${subdomain}`
        };
      } else {
        console.error(`Cloudflare DNS API error: ${JSON.stringify(result.errors)}`);
        return null;
      }
    } else {
      console.error(`Cloudflare DNS API error: ${response.status} - ${await response.text()}`);
      return null;
    }
  } catch (error) {
    console.error(`Error creating Cloudflare DNS record: ${error.message}`);
    return null;
  }
}

module.exports = {
  createCloudflareDnsRecord,
  CLOUDFLARE_DOMAIN
};
