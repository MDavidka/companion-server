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

async function cloneRepo(gitUrl, token, targetDir, appName) {
  // Convert git URL to https with token
  let url = gitUrl;
  if (url.startsWith('git@github.com:')) {
    url = url.replace('git@github.com:', 'https://github.com/');
  }
  if (!url.endsWith('.git')) url += '.git';
  
  const cloneUrl = url.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
  
  if (fs.existsSync(targetDir)) {
    const message = `Existing checkout found. Deleting and cloning fresh from GitHub (no git pull/merge).`;
    console.log(`[${appName || 'deploy'}] ${message}`);
    if (appName) addLog(appName, message);
    fs.rmSync(targetDir, { recursive: true, force: true });
  } else {
    const message = `Fresh clone from GitHub.`;
    console.log(`[${appName || 'deploy'}] Cloning ${gitUrl} to ${targetDir}...`);
    if (appName) addLog(appName, message);
  }

  await execPromise(`git clone ${cloneUrl} ${targetDir}`, { maxBuffer: 10 * 1024 * 1024 });
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

  // Clear npm cache to avoid corrupted metadata (ETARGET errors)
  addLog(appName, 'Clearing npm cache...');
  try {
    await execPromise('npm cache clean --force', { maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    addLog(appName, `npm cache clean warning: ${e.message}`);
  }

  // Remove stale node_modules, lockfile, and any local .npmrc that could intercept registry requests
  const nmPath = path.join(targetDir, 'node_modules');
  const lockPath = path.join(targetDir, 'package-lock.json');
  const npmrcPath = path.join(targetDir, '.npmrc');
  if (fs.existsSync(nmPath)) {
    addLog(appName, 'Removing stale node_modules...');
    fs.rmSync(nmPath, { recursive: true, force: true });
  }
  if (fs.existsSync(lockPath)) {
    addLog(appName, 'Removing stale package-lock.json...');
    fs.rmSync(lockPath, { force: true });
  }
  if (fs.existsSync(npmrcPath)) {
    addLog(appName, 'Removing local .npmrc (could intercept registry requests)...');
    fs.rmSync(npmrcPath, { force: true });
  }

  // Also strip any "resolved"/"integrity" pinning if a shrinkwrap exists
  const shrinkPath = path.join(targetDir, 'npm-shrinkwrap.json');
  if (fs.existsSync(shrinkPath)) {
    addLog(appName, 'Removing npm-shrinkwrap.json...');
    fs.rmSync(shrinkPath, { force: true });
  }

  // Build install env that fully bypasses any user/global .npmrc (the real source of bad registry)
  // NOTE: npm v9/v10 crashes if userconfig and globalconfig point to the SAME path (e.g. both /dev/null).
  // Workaround: create two DISTINCT empty .npmrc files and point each flag to its own.
  const os = require('os');
  const emptyUserRc = path.join(os.tmpdir(), `empty-user-${appName}-${Date.now()}.npmrc`);
  const emptyGlobalRc = path.join(os.tmpdir(), `empty-global-${appName}-${Date.now()}.npmrc`);
  try { fs.writeFileSync(emptyUserRc, ''); } catch (_) {}
  try { fs.writeFileSync(emptyGlobalRc, ''); } catch (_) {}

  const installEnv = {
    ...process.env,
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_userconfig: emptyUserRc,
    npm_config_globalconfig: emptyGlobalRc,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  const installCmd = `npm install --registry=https://registry.npmjs.org/ --userconfig=${emptyUserRc} --globalconfig=${emptyGlobalRc} --no-audit --no-fund --legacy-peer-deps`;

  // Helper: bump any radix package whose pinned version doesn't exist on the registry to "latest"
  async function autoFixUnresolvedRadix(errMsg) {
    const m = errMsg.match(/No matching version found for (@?[^@\s]+)@([^\s'"]+)/i);
    if (!m) return false;
    const badPkg = m[1];
    const pkgPath = path.join(targetDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return false;
    const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let changed = false;
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (pkgJson[section] && pkgJson[section][badPkg]) {
        addLog(appName, `Pinning ${badPkg} to "latest" (was ${pkgJson[section][badPkg]})`);
        pkgJson[section][badPkg] = 'latest';
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(pkgPath, JSON.stringify(pkgJson, null, 2));
    return changed;
  }

  addLog(appName, `Installing dependencies (${installCmd})...`);
  let attempts = 0;
  // Retry up to 5 times, each time auto-bumping the next unresolvable package
  while (true) {
    attempts++;
    try {
      await execPromise(installCmd, {
        cwd: targetDir,
        maxBuffer: 50 * 1024 * 1024,
        env: installEnv,
      });
      break;
    } catch (err) {
      const msg = String(err.stderr || err.message || '');
      if (attempts < 5 && /ETARGET|No matching version/i.test(msg)) {
        const fixed = await autoFixUnresolvedRadix(msg);
        if (fixed) {
          addLog(appName, `Retry ${attempts} after auto-fix...`);
          continue;
        }
      }
      addLog(appName, `npm install failed: ${msg.split('\n').slice(0, 5).join(' | ')}`);
      throw err;
    }
  }

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
    
    await cloneRepo(gitUrl, token, targetDir, appName);
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
