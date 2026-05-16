const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const util = require('util');
const { findFreePort } = require('./ports');
const { registerApp, getApp } = require('./registry');

const execPromise = util.promisify(exec);
const APPS_DIR = path.join(__dirname, '..', 'deployments');

if (!fs.existsSync(APPS_DIR)) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
}

// In-memory store for active processes to be able to kill them
const activeProcesses = {};
// In-memory buffer for logs (for SSE)
const logsBuffer = {};

function addLog(appName, message) {
  if (!logsBuffer[appName]) {
    logsBuffer[appName] = [];
  }
  logsBuffer[appName].push(message);
  if (logsBuffer[appName].length > 500) {
    logsBuffer[appName].shift();
  }
}

function getLogs(appName) {
  return logsBuffer[appName] || [];
}

async function cloneRepo(gitUrl, token, targetDir) {
  // Convert git URL to https with token
  let url = gitUrl;
  if (url.startsWith('git@github.com:')) {
    url = url.replace('git@github.com:', 'https://github.com/');
  }
  if (!url.endsWith('.git')) url += '.git';
  
  const cloneUrl = url.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
  
  if (fs.existsSync(targetDir)) {
    console.log(`Directory ${targetDir} exists. Running git pull...`);
    await execPromise('git pull', { cwd: targetDir, maxBuffer: 10 * 1024 * 1024 });
  } else {
    console.log(`Cloning ${gitUrl} to ${targetDir}...`);
    await execPromise(`git clone ${cloneUrl} ${targetDir}`, { maxBuffer: 10 * 1024 * 1024 });
  }
}

async function buildApp(targetDir) {
  console.log(`Running npm install in ${targetDir}...`);
  await execPromise('npm install', { cwd: targetDir, maxBuffer: 10 * 1024 * 1024 });
  
  const pkgPath = path.join(targetDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  
  if (pkg.scripts && pkg.scripts.build) {
    console.log(`Running npm run build in ${targetDir}...`);
    await execPromise('npm run build', { cwd: targetDir, maxBuffer: 10 * 1024 * 1024 });
  }
}

function spawnApp(appName, targetDir, port) {
  // Kill existing if any
  if (activeProcesses[appName]) {
    console.log(`Killing existing process for ${appName}`);
    activeProcesses[appName].kill();
    delete activeProcesses[appName];
  }

  console.log(`Spawning app ${appName} on port ${port}...`);
  const child = spawn('npm', ['start'], {
    cwd: targetDir,
    env: { ...process.env, PORT: port.toString() }
  });

  activeProcesses[appName] = child;

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    lines.forEach(line => addLog(appName, line));
    console.log(`[${appName}] ${data.toString().trim()}`);
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    lines.forEach(line => addLog(appName, `ERROR: ${line}`));
    console.error(`[${appName}] ERROR: ${data.toString().trim()}`);
  });

  child.on('close', (code) => {
    addLog(appName, `Process exited with code ${code}`);
    console.log(`[${appName}] Process exited with code ${code}`);
    delete activeProcesses[appName];
    registerApp(appName, { status: 'offline' });
  });

  return child;
}

async function killAppProcess(appName) {
  if (activeProcesses[appName]) {
    activeProcesses[appName].kill();
    delete activeProcesses[appName];
  }
}

async function deployApp(appName, gitUrl, token) {
  const targetDir = path.join(APPS_DIR, appName);
  
  try {
    addLog(appName, 'Starting deployment...');
    registerApp(appName, { status: 'deploying' });
    
    await cloneRepo(gitUrl, token, targetDir);
    addLog(appName, 'Repository cloned/updated.');
    
    await buildApp(targetDir);
    addLog(appName, 'Build finished.');

    const port = await findFreePort();
    const child = spawnApp(appName, targetDir, port);
    
    const domain = process.env.CLOUDFLARE_DOMAIN || 'micro1.sycord.com';

    registerApp(appName, {
      port,
      pid: child.pid,
      dir: targetDir,
      url: `https://${appName}.${domain}`,
      deployedAt: new Date().toISOString(),
      status: 'online',
      gitUrl
    });
    
    addLog(appName, `App deployed successfully on port ${port}`);
    return { success: true, port, targetDir };
  } catch (err) {
    console.error(`Deployment failed for ${appName}:`, err);
    addLog(appName, `Deployment failed: ${err.message}`);
    registerApp(appName, { status: 'failed', error: err.message });
    throw err;
  }
}

module.exports = {
  deployApp,
  killAppProcess,
  getLogs
};
