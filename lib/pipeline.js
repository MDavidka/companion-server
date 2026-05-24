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
    console.log(`Directory ${targetDir} exists. Force-syncing with remote...`);
    const opts = { cwd: targetDir, maxBuffer: 10 * 1024 * 1024 };
    try {
      // Ensure remote URL is current (token may have rotated)
      await execPromise(`git remote set-url origin ${cloneUrl}`, opts).catch(() =>
        execPromise(`git remote add origin ${cloneUrl}`, opts)
      );

      // Determine default branch from remote HEAD (fallback to main, then master)
      let branch = 'main';
      try {
        const { stdout } = await execPromise('git remote show origin', opts);
        const m = stdout.match(/HEAD branch:\s*(\S+)/);
        if (m && m[1] && m[1] !== '(unknown)') branch = m[1];
      } catch {}

      // Fetch everything and force-reset local tree to remote, discarding ALL local changes
      await execPromise('git fetch --all --prune --tags --force', opts);
      try {
        await execPromise(`git reset --hard origin/${branch}`, opts);
      } catch {
        await execPromise('git reset --hard origin/master', opts);
      }
      // Wipe any untracked files / dirs (build artifacts, generated configs, etc.)
      await execPromise('git clean -fdx', opts);
    } catch (err) {
      // Last-resort recovery: nuke directory and re-clone fresh
      console.warn(`Force-sync failed (${err.message}). Re-cloning from scratch...`);
      fs.rmSync(targetDir, { recursive: true, force: true });
      await execPromise(`git clone ${cloneUrl} ${targetDir}`, { maxBuffer: 10 * 1024 * 1024 });
    }
  } else {
    console.log(`Cloning ${gitUrl} to ${targetDir}...`);
    await execPromise(`git clone ${cloneUrl} ${targetDir}`, { maxBuffer: 10 * 1024 * 1024 });
  }
}

function detectFramework(targetDir) {
  const pkgPath = path.join(targetDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return { type: 'static' };
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps.next) return { type: 'next', pkg };
  if (deps.vite) return { type: 'vite', pkg };
  return { type: 'node', pkg };
}

async function buildApp(appName, targetDir) {
  const fw = detectFramework(targetDir);
  addLog(appName, `Detected framework: ${fw.type}`);

  console.log(`Running npm install in ${targetDir}...`);
  addLog(appName, 'Installing dependencies (npm install)...');
  await execPromise('npm install', { cwd: targetDir, maxBuffer: 50 * 1024 * 1024 });

  if (fw.type === 'next') {
    addLog(appName, 'Building Next.js app (next build)...');
    const buildCmd = fw.pkg.scripts && fw.pkg.scripts.build ? 'npm run build' : 'npx next build';
    await execPromise(buildCmd, { cwd: targetDir, maxBuffer: 50 * 1024 * 1024, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  } else if (fw.pkg && fw.pkg.scripts && fw.pkg.scripts.build) {
    addLog(appName, 'Running npm run build...');
    await execPromise('npm run build', { cwd: targetDir, maxBuffer: 50 * 1024 * 1024 });
  }
  return fw;
}

function spawnApp(appName, targetDir, port, framework) {
  // Kill existing if any
  if (activeProcesses[appName]) {
    console.log(`Killing existing process for ${appName}`);
    activeProcesses[appName].kill();
    delete activeProcesses[appName];
  }

  const fw = framework || detectFramework(targetDir);
  let cmd, args;
  if (fw.type === 'next') {
    // Run Next.js mini-server: prefer `next start` for the built app
    cmd = 'npx';
    args = ['next', 'start', '-p', port.toString(), '-H', '0.0.0.0'];
    addLog(appName, `Starting Next.js server: next start -p ${port}`);
  } else {
    cmd = 'npm';
    args = ['start'];
    addLog(appName, `Starting via npm start on PORT=${port}`);
  }

  console.log(`Spawning app ${appName} on port ${port} (${fw.type})...`);
  const child = spawn(cmd, args, {
    cwd: targetDir,
    env: { ...process.env, PORT: port.toString(), HOST: '0.0.0.0', NODE_ENV: 'production' }
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
    
    const fw = await buildApp(appName, targetDir);
    addLog(appName, 'Build finished.');

    const port = await findFreePort();
    const child = spawnApp(appName, targetDir, port, fw);
    
    const domain = process.env.CLOUDFLARE_DOMAIN || 'sycord.site';

    registerApp(appName, {
      port,
      pid: child.pid,
      dir: targetDir,
      url: `https://${appName}.${domain}`,
      deployedAt: new Date().toISOString(),
      status: 'online',
      framework: fw.type,
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
  getLogs,
  addLog
};
