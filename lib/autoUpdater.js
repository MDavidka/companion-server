const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const util = require('util');
const execP = util.promisify(exec);

const ROOT = path.join(__dirname, '..');
const REPO_URL = process.env.UPDATE_REPO_URL || 'https://github.com/MDavidka/companion-server';
const BRANCH = process.env.UPDATE_BRANCH || 'main';
const INTERVAL_MS = parseInt(process.env.UPDATE_INTERVAL_MS || '60000', 10);

const state = {
  enabled: true,
  repo: REPO_URL,
  branch: BRANCH,
  current: null,
  remote: null,
  updateAvailable: false,
  lastCheck: null,
  lastUpdate: null,
  lastError: null,
  checking: false,
  updating: false,
};

async function run(cmd, opts = {}) {
  return execP(cmd, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024, ...opts });
}

async function ensureRepo() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) {
    await run('git init');
    await run(`git remote add origin ${REPO_URL}`).catch(() => run(`git remote set-url origin ${REPO_URL}`));
    await run(`git fetch origin ${BRANCH}`);
    await run(`git checkout -f -B ${BRANCH} origin/${BRANCH}`);
  } else {
    // ensure remote points to repo
    try {
      const { stdout } = await run('git remote get-url origin');
      if (stdout.trim() !== REPO_URL) {
        await run(`git remote set-url origin ${REPO_URL}`);
      }
    } catch {
      await run(`git remote add origin ${REPO_URL}`);
    }
  }
}

async function getLocalHead() {
  const { stdout } = await run('git rev-parse HEAD');
  return stdout.trim();
}

async function getRemoteHead() {
  await run(`git fetch origin ${BRANCH} --prune --force`);
  const { stdout } = await run(`git rev-parse origin/${BRANCH}`);
  return stdout.trim();
}

async function forceSyncToRemote() {
  console.log(`[auto-updater] force-syncing ${REPO_URL}#${BRANCH}...`);
  await run(`git remote set-url origin ${REPO_URL}`).catch(() => run(`git remote add origin ${REPO_URL}`));
  await run(`git fetch origin ${BRANCH} --prune --tags --force`);
  await run(`git checkout -f -B ${BRANCH} origin/${BRANCH}`);
  await run(`git reset --hard origin/${BRANCH}`);
  await run('git clean -fd');
}

async function check() {
  if (state.checking || state.updating) return state;
  state.checking = true;
  try {
    await ensureRepo();
    state.current = await getLocalHead();
    state.remote = await getRemoteHead();
    state.updateAvailable = state.current !== state.remote;
    state.lastCheck = new Date().toISOString();
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message;
    console.error('[auto-updater] check failed:', err.message);
  } finally {
    state.checking = false;
  }
  return state;
}

function restartSelf() {
  console.log('[auto-updater] restarting process to load new version...');
  const child = spawn(process.argv[0], process.argv.slice(1), {
    cwd: ROOT,
    detached: true,
    stdio: 'inherit',
    env: process.env,
  });
  child.unref();
  setTimeout(() => process.exit(0), 500);
}

async function update({ restart = true } = {}) {
  if (state.updating) return { success: false, message: 'already updating' };
  state.updating = true;
  try {
    await ensureRepo();
    await forceSyncToRemote();
    // install deps if package.json changed
    if (fs.existsSync(path.join(ROOT, 'package.json'))) {
      console.log('[auto-updater] running npm install...');
      await run('npm install --omit=dev || npm install', { maxBuffer: 50 * 1024 * 1024 });
    }
    state.current = await getLocalHead();
    state.remote = state.current;
    state.updateAvailable = false;
    state.lastUpdate = new Date().toISOString();
    state.lastError = null;
    state.updating = false;
    if (restart) {
      setTimeout(restartSelf, 250);
    }
    return { success: true, commit: state.current };
  } catch (err) {
    state.lastError = err.message;
    state.updating = false;
    console.error('[auto-updater] update failed:', err.message);
    return { success: false, message: err.message };
  }
}

async function tick() {
  if (!state.enabled) return;
  await check();
  if (state.updateAvailable && !state.updating) {
    console.log(`[auto-updater] new version detected (${state.remote.slice(0,7)}), updating...`);
    await update({ restart: true });
  }
}

function start() {
  // Initial check shortly after boot
  setTimeout(() => { tick().catch(() => {}); }, 5000);
  setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
  console.log(`[auto-updater] watching ${REPO_URL}#${BRANCH} every ${INTERVAL_MS}ms`);
}

function getState() {
  return { ...state, intervalMs: INTERVAL_MS };
}

module.exports = { start, check, update, getState };
