const express = require('express');
const router = express.Router();
const { getRepoById } = require('../lib/mongo');
const { deployApp, addLog } = require('../lib/pipeline');
const { connectTunnel, enabled: tunnelEnabled } = require('../lib/cloudflaredTunnel');

const CLOUDFLARE_DOMAIN = process.env.CLOUDFLARE_DOMAIN || 'sycord.site';
const RUNNER_PORT = parseInt(process.env.PORT || '4500', 10);


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
    if (!repoDoc) return res.status(404).json({ success: false, message: `Repository ${repoId} not found` });

    const gitToken = repoDoc.git_token;
    const gitUrl = repoDoc.git_url;
    const username = repoDoc.username;

    if (!gitToken) return res.status(404).json({ success: false, message: 'GitHub token (git_token) not found for repository' });
    if (!gitUrl) return res.status(404).json({ success: false, message: 'Git URL (git_url) not found for repository' });

    const [owner, repoName] = parseGitUrl(gitUrl);
    if (!owner || !repoName) return res.status(400).json({ success: false, message: `Could not parse git_url: ${gitUrl}` });

    const projectName = sanitizeProjectName(repoName);

    // Clone + build + spawn mini-server (returns the free local port it bound to)
    const result = await deployApp(projectName, gitUrl, gitToken);

    // Single wildcard tunnel routes *.sycord.site → runner:4500. Make sure both
    // the DNS CNAME and the tunnel ingress rule exist for this host so Cloudflare
    // can resolve it (otherwise visitors get Error 1033 — "Cloudflare Tunnel error,
    // host configured as a Cloudflare Tunnel and Cloudflare is unable to resolve it").
    const publicUrl = `https://${projectName}.${CLOUDFLARE_DOMAIN}`;

    if (tunnelEnabled()) {
      try {
        const ingressResult = await connectTunnel(
          projectName,
          RUNNER_PORT, // point Cloudflare at the runner; runner's proxy forwards to the app port
          (msg) => addLog(projectName, msg)
        );
        if (!ingressResult.success) {
          addLog(projectName, `⚠ tunnel ingress/DNS setup did not complete: ${ingressResult.error || ingressResult.mode}`);
        }
      } catch (e) {
        addLog(projectName, `⚠ tunnel ingress/DNS setup threw: ${e.message}`);
      }
    } else {
      addLog(projectName, '⚠ CLOUDFLARED_TUNNEL_ID / CLOUDFLARE_ACCOUNT_ID not set — skipping tunnel ingress setup (Error 1033 likely if DNS not pre-configured).');
    }

    addLog(projectName, `════════════════════════════════════════════════`);
    addLog(projectName, `✅ DEPLOYMENT COMPLETE`);
    addLog(projectName, `   project: ${projectName}`);
    addLog(projectName, `   local:   http://127.0.0.1:${result.port}`);
    addLog(projectName, `   public:  ${publicUrl}`);
    addLog(projectName, `   routing: tunnel → runner:${RUNNER_PORT} → registry → :${result.port}`);
    addLog(projectName, `════════════════════════════════════════════════`);

    return res.status(200).json({

      success: true,
      message: `Deployment successful! Project: ${projectName}`,
      project_name: projectName,
      url: publicUrl,
      link: publicUrl,
      subdomain: `${projectName}.${CLOUDFLARE_DOMAIN}`,
      target: `127.0.0.1:${result.port}`,
      port: result.port,
      username,
      repo_id: repoId,
      mode: 'wildcard-tunnel',
    });

  } catch (err) {
    console.error('Deployment error:', err);
    return res.status(500).json({
      success: false,
      message: 'Deployment failed',
      error: err.message,
    });
  }
});

module.exports = router;
