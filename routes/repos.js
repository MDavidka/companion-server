const express = require('express');
const router = express.Router();
const { getRepositoryDocuments, getUserRepos } = require('../lib/mongo');
const { parseGitUrl } = require('./deploy');

router.get('/', async (req, res) => {
  try {
    const repoDocs = await getRepositoryDocuments();
    if (!repoDocs || repoDocs.length === 0) {
      return res.json({ success: true, message: 'No repositories found in database', repositories: [] });
    }

    const formattedRepos = [];
    for (const repoDoc of repoDocs) {
      const username = repoDoc.username;
      const repoId = repoDoc.repo_id;
      const gitUrl = repoDoc.git_url;
      const repoNameFromDb = repoDoc.repo_name;

      if (!username || !repoId) continue;

      let owner = null;
      let repoNameFromUrl = null;
      if (gitUrl) {
        const httpsMatch = gitUrl.match(/https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
        const sshMatch = gitUrl.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
        if (httpsMatch) { owner = httpsMatch[1]; repoNameFromUrl = httpsMatch[2]; }
        else if (sshMatch) { owner = sshMatch[1]; repoNameFromUrl = sshMatch[2]; }
      }

      const repoName = repoNameFromDb || repoNameFromUrl || `repo-${repoId}`;
      formattedRepos.push({
        username: username,
        repo_id: String(repoId),
        git_url: gitUrl,
        name: repoName,
        owner: owner,
        full_name: owner && repoNameFromUrl ? `${owner}/${repoNameFromUrl}` : null
      });
    }

    return res.json({ success: true, repositories: formattedRepos });
  } catch (err) {
    console.error('Error fetching repositories:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch repositories', error: err.message, repositories: [] });
  }
});

router.get('/:username', async (req, res) => {
  const username = req.params.username;
  try {
    const repos = await getUserRepos(username);
    const formattedRepos = [];
    for (const repo of repos) {
      const gitUrl = repo.git_url;
      const repoNameFromDb = repo.repo_name;

      let owner = null;
      let repoNameFromUrl = null;
      if (gitUrl) {
        const httpsMatch = gitUrl.match(/https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
        const sshMatch = gitUrl.match(/git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
        if (httpsMatch) { owner = httpsMatch[1]; repoNameFromUrl = httpsMatch[2]; }
        else if (sshMatch) { owner = sshMatch[1]; repoNameFromUrl = sshMatch[2]; }
      }

      const repoName = repoNameFromDb || repoNameFromUrl || `repo-${repo.repo_id}`;
      formattedRepos.push({
        repo_id: String(repo.repo_id),
        git_url: gitUrl,
        name: repoName,
        owner: owner,
        full_name: owner && repoNameFromUrl ? `${owner}/${repoNameFromUrl}` : null
      });
    }
    return res.json({ success: true, username: username, repositories: formattedRepos });
  } catch (err) {
    console.error(`Error fetching repositories for user ${username}:`, err);
    return res.status(500).json({ success: false, message: `Failed to fetch repositories for user ${username}`, error: err.message, repositories: [] });
  }
});

module.exports = router;
