const express = require('express');
const router = express.Router();
const { getRepoById } = require('../lib/mongo');
const { deployApp, addLog } = require('../lib/pipeline');

const CLOUDFLARE_DOMAIN = process.env.CLOUDFLARE_DOMAIN || 'sycord.site';

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

    // No per-site Cloudflare changes. A single wildcard tunnel (*.sycord.site → runner:4500)
    // handles all routing. Runner's proxy middleware reads the registry and forwards
    // <project>.sycord.site → 127.0.0.1:<port>.
    const publicUrl = `https://${projectName}.${CLOUDFLARE_DOMAIN}`;

    addLog(projectName, `════════════════════════════════════════════════`);
    addLog(projectName, `✅ DEPLOYMENT COMPLETE`);
    addLog(projectName, `   project: ${projectName}`);
    addLog(projectName, `   local:   http://127.0.0.1:${result.port}`);
    addLog(projectName, `   public:  ${publicUrl}`);
    addLog(projectName, `   routing: wildcard tunnel → runner:${process.env.PORT || 4500} → registry → :${result.port}`);
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
