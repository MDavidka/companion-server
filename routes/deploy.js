const express = require('express');
const router = express.Router();
const { getRepoById } = require('../lib/mongo');
const { deployApp } = require('../lib/pipeline');
const { createCloudflareDnsRecord, CLOUDFLARE_DOMAIN } = require('../lib/cloudflare');
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
    if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ZONE_ID) {
      dnsResult = await createCloudflareDnsRecord(projectName, targetHost);
      if (!dnsResult) {
        return res.status(500).json({
          success: false,
          message: `Built and started on port ${result.port}, but Cloudflare DNS record creation failed for ${projectName}.${CLOUDFLARE_DOMAIN}.`,
          project_name: projectName,
          port: result.port
        });
      }
    }

    const url = dnsResult ? dnsResult.url : `https://${projectName}.${CLOUDFLARE_DOMAIN}`;

    return res.status(200).json({
      success: true,
      message: `Deployment successful! Project: ${projectName}`,
      project_name: projectName,
      url: url,
      link: url,
      subdomain: `${projectName}.${CLOUDFLARE_DOMAIN}`,
      target: `${targetHost}:${result.port}`,
      port: result.port,
      username: username,
      repo_id: repoId,
      dns_record_created: !!dnsResult
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
