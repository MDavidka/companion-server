// /run vps — new runner command
// Provisions / returns a workspace daemon connection endpoint for an AI agent.
//
// POST /api/run/vps
// Body: { workspace?: string, repo?: string, token?: string }
// Returns: { wsUrl, workspace, dir }

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WORKSPACES_ROOT } = require('../lib/workspaceDaemon');

const router = express.Router();

router.post('/vps', (req, res) => {
  const { workspace, repo } = req.body || {};
  const name = (workspace || `ws-${crypto.randomBytes(4).toString('hex')}`).replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = path.join(WORKSPACES_ROOT, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const host = req.get('host');
  const proto = req.secure ? 'wss' : 'ws';
  const token = process.env.WORKSPACE_TOKEN || '';
  const wsUrl = `${proto}://${host}/api/v1/workspace?workspace=${encodeURIComponent(name)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;

  res.json({
    success: true,
    command: '/run vps',
    workspace: name,
    dir,
    repo: repo || null,
    wsUrl,
    api: {
      shell: 'shell:run',
      fs: ['fs:write', 'fs:read', 'fs:delete', 'fs:tree', 'fs:search'],
      diagnostics: 'workspace:diagnostics',
      deploy: 'workspace:deploy',
    },
  });
});

router.get('/vps', (req, res) => {
  const list = fs.existsSync(WORKSPACES_ROOT)
    ? fs.readdirSync(WORKSPACES_ROOT).filter(n => fs.statSync(path.join(WORKSPACES_ROOT, n)).isDirectory())
    : [];
  res.json({ workspaces: list });
});

module.exports = router;
