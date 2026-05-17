const express = require('express');
const router = express.Router();
const { getRepoById } = require('../lib/mongo');
const { deployApp } = require('../lib/pipeline');
const { createCloudflareDnsRecord, CLOUDFLARE_DOMAIN } = require('../lib/cloudflare');
const { connectTunnel, enabled: tunnelEnabled } = require('../lib/cloudflaredTunnel');
const { startQuickTunnel } = require('../lib/quickTunnel');
const { addLog } = require('../lib/pipeline');

function sanitizeProjectName(name) {
  if (!name) return 'unnamed-project';
  const sanitized = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return sanitized.substring(0, 63);
}

function parseGitUrl(gitUrl) {
  if (!gitUrl) return [null, null];
  const httpsMatch = gitUrl.match(/https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) return [httpsMatch[1], httpsMatch[2]];
  const sshMatch = gitUrl.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) return [sshMatch[1], sshMatch[2]];
  return [null, null];
}

router.all('/:repo_id', async (req, res) => {
  const repoId = req.params.repo_id;
  
  if (!repoId || !/^\d+$/.test(repoId)) {
    return res.status(400).json({ success: false, message: 'Invalid repo_id format. Expected numeric identifier.' });
  }

  try {
    const repoDoc = await getRepoById(repoId);

    if (!repoDoc) {
      return res.status(404).json({ success: false, message: `Repository ${repoId} not found` });
    }

    const gitToken = repoDoc.git_token;
    const gitUrl = repoDoc.git_url;
    const username = repoDoc.username;

    if (!gitToken) return res.status(404).json({ success: false, message: 'GitHub token (git_token) not found for repository' });
    if (!gitUrl) return res.status(404).json({ success: false, message: 'Git URL (git_url) not found for repository' });

    const [owner, repoName] = parseGitUrl(gitUrl);
    if (!owner || !repoName) return res.status(400).json({ success: false, message: `Could not parse git_url: ${gitUrl}` });

    const projectName = sanitizeProjectName(repoName);

    // Run deployment in background or await it? The original app.py awaits it but it might timeout for big apps.
    // However, the prompt says POST /api/deploy/:repo_id -> git pull -> npm install -> next build -> spawn process
    // Let's await it to send the response when done, just like app.py did.
    
    // Using a longer timeout in express might be needed, but we'll try awaiting
    // Build + spawn the mini-server (returns the local port it bound to)
    const result = await deployApp(projectName, gitUrl, gitToken);

    // After a successful build/spawn, connect the mini-server (host:port)
    // to a Cloudflare DNS CNAME at <subdomain>.<CLOUDFLARE_DOMAIN>.
    // CNAME targets a hostname (SERVER_HOST), and this runner's proxy
    // forwards <subdomain>.<domain> traffic to localhost:<port>.
    const targetHost = process.env.SERVER_HOST || CLOUDFLARE_DOMAIN;
    let dnsResult = null;
    let tunnelResult = null;
    let quickResult = null;
    const cfLogger = (line) => { addLog(projectName, line); console.log(line); };

    cfLogger(`[cloudflare] ══════════════════════════════════════════════════`);
    cfLogger(`[cloudflare] connecting local mini-server localhost:${result.port} to a public Cloudflare URL`);
    cfLogger(`[cloudflare] project: ${projectName} · domain: ${CLOUDFLARE_DOMAIN}`);
    cfLogger(`[cloudflare] env detected → API_TOKEN:${!!process.env.CLOUDFLARE_API_TOKEN} ZONE_ID:${!!process.env.CLOUDFLARE_ZONE_ID} ACCOUNT_ID:${!!process.env.CLOUDFLARE_ACCOUNT_ID} TUNNEL_ID:${!!process.env.CLOUDFLARED_TUNNEL_ID}`);

    if (tunnelEnabled()) {
      cfLogger(`[cloudflare] strategy: NAMED TUNNEL (cloudflared) → ${projectName}.${CLOUDFLARE_DOMAIN} → http://localhost:${result.port}`);
      tunnelResult = await connectTunnel(projectName, result.port, cfLogger);
      if (!tunnelResult || !tunnelResult.success) {
        cfLogger(`[cloudflare] named tunnel FAILED — falling back to quick-tunnel.`);
        tunnelResult = null;
      }
    }

    if (!tunnelResult && process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID) {
      cfLogger(`[cloudflare] strategy: DNS CNAME ${projectName}.${CLOUDFLARE_DOMAIN} → ${targetHost}`);
      dnsResult = await createCloudflareDnsRecord(projectName, targetHost, cfLogger);
      if (!dnsResult) cfLogger(`[cloudflare] CNAME creation FAILED — falling back to quick-tunnel.`);
    }

    // Always-on fallback: ephemeral trycloudflare.com URL via `cloudflared`.
    // This works without any Cloudflare credentials and guarantees the local
    // port becomes publicly reachable from outside the server.
    if (!tunnelResult && !dnsResult) {
      cfLogger(`[cloudflare] strategy: QUICK TUNNEL (ephemeral trycloudflare.com URL)`);
      quickResult = await startQuickTunnel(projectName, result.port, cfLogger);
    }

    const finalUrl =
      (tunnelResult && tunnelResult.url) ||
      (dnsResult && dnsResult.url) ||
      (quickResult && quickResult.url) ||
      `http://localhost:${result.port}`;
    const mode = tunnelResult ? 'tunnel' : (dnsResult ? 'cname' : (quickResult ? 'quick-tunnel' : 'local-only'));

    cfLogger(`[cloudflare] ══════════════════════════════════════════════════`);
    cfLogger(`[deploy] ✅ DEPLOYMENT COMPLETE`);
    cfLogger(`[deploy]   project: ${projectName}`);
    cfLogger(`[deploy]   local:   http://localhost:${result.port}`);
    cfLogger(`[deploy]   public:  ${finalUrl}`);
    cfLogger(`[deploy]   mode:    ${mode}`);
    cfLogger(`[cloudflare] ══════════════════════════════════════════════════`);

    return res.status(200).json({
      success: true,
      message: `Deployment successful! Project: ${projectName}`,
      project_name: projectName,
      url: finalUrl,
      link: finalUrl,
      subdomain: `${projectName}.${CLOUDFLARE_DOMAIN}`,
      target: `localhost:${result.port}`,
      port: result.port,
      username: username,
      repo_id: repoId,
      mode,
      dns_record_created: !!(dnsResult || tunnelResult || quickResult)
    });
    
  } catch (err) {
    console.error('Deployment error:', err);
    return res.status(500).json({
      success: false,
      message: 'Deployment failed',
      error: err.message
    });
  }
});

module.exports = router;
