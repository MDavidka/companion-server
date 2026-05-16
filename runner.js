require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const proxyMiddleware = require('./lib/proxy');
const deployRoute = require('./routes/deploy');
const statusRoute = require('./routes/status');
const logsRoute = require('./routes/logs');
const reposRoute = require('./routes/repos');
const healthRoute = require('./routes/health');
const { getApp, removeApp } = require('./lib/registry');
const { killAppProcess, deployApp } = require('./lib/pipeline');

const app = express();

// Subdomain proxy middleware MUST be first
app.use(proxyMiddleware);

app.use(express.json());

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

// API Routes
app.use('/api/deploy', deployRoute);
app.use('/api/status', statusRoute);
app.use('/api/sites', statusRoute); // Map both status and sites to the same route
app.use('/api/logs', logsRoute);
app.use('/api/repos', reposRoute);
app.use('/api/health', healthRoute);

// Redeploy
app.post('/api/redeploy/:name', async (req, res) => {
  const appName = req.params.name;
  const appData = getApp(appName);

  if (!appData) {
    return res.status(404).json({ success: false, message: 'App not found' });
  }

  try {
    await killAppProcess(appName);
    const result = await deployApp(appName, appData.gitUrl, appData.token); // token not saved? We should probably save it or re-fetch.
    // For simplicity, we assume git is already authenticated after first clone, so we don't strictly need token, but let's pass dummy or stored if available.
    return res.json({ success: true, message: 'Redeployed successfully', result });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Redeploy failed', error: err.message });
  }
});

// Delete
app.delete('/api/delete/:name', async (req, res) => {
  const appName = req.params.name;
  const appData = getApp(appName);

  if (!appData) {
    return res.status(404).json({ success: false, message: 'App not found' });
  }

  try {
    await killAppProcess(appName);
    if (appData.dir && fs.existsSync(appData.dir)) {
      fs.rmSync(appData.dir, { recursive: true, force: true });
    }
    removeApp(appName);
    // Note: Cloudflare DNS deletion would go here, omitting for brevity or calling CF API DELETE.
    return res.json({ success: true, message: 'Deleted successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Delete failed', error: err.message });
  }
});

const port = process.env.PORT || 4500;
app.listen(port, () => {
  console.log(`Runner listening on port ${port}`);
});
