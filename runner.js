require('dotenv').config();
const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');
const proxyMiddleware = require('./lib/proxy');
const deployRoute = require('./routes/deploy');
const statusRoute = require('./routes/status');
const logsRoute = require('./routes/logs');
const reposRoute = require('./routes/repos');
const healthRoute = require('./routes/health');
const updaterRoute = require('./routes/updater');
const systemRoute = require('./routes/system');
const vpsRoute = require('./routes/vps');
const autoUpdater = require('./lib/autoUpdater');
const workspaceDaemon = require('./lib/workspaceDaemon');
const { getApp, removeApp } = require('./lib/registry');
const { killAppProcess, deployApp } = require('./lib/pipeline');

const app = express();

// Subdomain proxy middleware MUST be first
app.use(proxyMiddleware);

app.use(express.json({ limit: '10mb' }));

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

// API Routes
app.use('/api/deploy', deployRoute);
app.use('/api/status', statusRoute);
app.use('/api/sites', statusRoute);
app.use('/api/logs', logsRoute);
app.use('/api/repos', reposRoute);
app.use('/api/health', healthRoute);
app.use('/api/updater', updaterRoute);
app.use('/api/system', systemRoute);
app.use('/api/run', vpsRoute); // /run vps -> POST /api/run/vps

// Redeploy
app.post('/api/redeploy/:name', async (req, res) => {
  const appName = req.params.name;
  const appData = getApp(appName);
  if (!appData) return res.status(404).json({ success: false, message: 'App not found' });
  try {
    await killAppProcess(appName);
    const result = await deployApp(appName, appData.gitUrl, appData.token);
    return res.json({ success: true, message: 'Redeployed successfully', result });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Redeploy failed', error: err.message });
  }
});

// Delete
app.delete('/api/delete/:name', async (req, res) => {
  const appName = req.params.name;
  const appData = getApp(appName);
  if (!appData) return res.status(404).json({ success: false, message: 'App not found' });
  try {
    await killAppProcess(appName);
    if (appData.dir && fs.existsSync(appData.dir)) {
      fs.rmSync(appData.dir, { recursive: true, force: true });
    }
    removeApp(appName);
    return res.json({ success: true, message: 'Deleted successfully' });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Delete failed', error: err.message });
  }
});

const port = process.env.PORT || 4500;
const server = http.createServer(app);

// Attach Sycord Workspace Daemon (WebSocket) at /api/v1/workspace
workspaceDaemon.attach(server);

server.listen(port, () => {
  console.log(`Runner listening on port ${port}`);
  console.log(`Sycord Workspace Daemon: ws://0.0.0.0:${port}/api/v1/workspace`);
  if (process.env.AUTO_UPDATE !== 'false') {
    autoUpdater.start();
  }
});

