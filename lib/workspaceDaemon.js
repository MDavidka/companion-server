// Sycord Workspace Daemon (SWD)
// WebSocket API at /api/v1/workspace
// Implements: shell:run, fs:write, fs:read, fs:search, fs:tree,
//             workspace:diagnostics, workspace:deploy
//
// Auth: ?token=<WORKSPACE_TOKEN> (env) — falls back to allowing all if unset.

const { WebSocketServer } = require('ws');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const WORKSPACES_ROOT = path.resolve(__dirname, '..', 'workspaces');
if (!fs.existsSync(WORKSPACES_ROOT)) fs.mkdirSync(WORKSPACES_ROOT, { recursive: true });

const activeShells = new Map(); // id -> child process

function safeResolve(workspaceDir, p) {
  const abs = path.resolve(workspaceDir, p || '.');
  if (!abs.startsWith(workspaceDir)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return abs;
}

function send(ws, event, id, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ event, id, payload }));
}

function getWorkspaceDir(req) {
  // workspace id comes from query string ?workspace=<name>
  const url = new URL(req.url, 'http://localhost');
  const wsName = (url.searchParams.get('workspace') || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const dir = path.join(WORKSPACES_ROOT, wsName || 'default');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return { dir, name: wsName || 'default' };
}

function checkAuth(req) {
  const expected = process.env.WORKSPACE_TOKEN;
  if (!expected) return true; // open mode
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token') || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return token === expected;
}

async function buildFsTree(dir, base = dir, depth = 0) {
  if (depth > 6) return null;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === '.next') continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs);
    if (e.isDirectory()) {
      out.push({ path: rel, type: 'dir', children: await buildFsTree(abs, base, depth + 1) });
    } else {
      out.push({ path: rel, type: 'file' });
    }
  }
  return out;
}

function attachHandlers(ws, workspaceDir) {
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return send(ws, 'error', null, { message: 'invalid JSON' }); }

    const { action, id, payload = {} } = msg;
    try {
      switch (action) {
        case 'shell:run': {
          const cmd = payload.command;
          const cwd = payload.cwd ? safeResolve(workspaceDir, payload.cwd) : workspaceDir;
          const env = { ...process.env, ...(payload.env || {}) };
          const start = Date.now();
          const child = spawn('bash', ['-lc', cmd], { cwd, env });
          activeShells.set(id, child);
          child.stdout.on('data', (c) => send(ws, 'shell:stdout', id, { chunk: c.toString() }));
          child.stderr.on('data', (c) => send(ws, 'shell:stderr', id, { chunk: c.toString() }));
          child.on('close', (code) => {
            activeShells.delete(id);
            send(ws, 'shell:exit', id, { exitCode: code, durationMs: Date.now() - start });
          });
          child.on('error', (err) => send(ws, 'shell:error', id, { message: err.message }));
          break;
        }
        case 'shell:cancel': {
          const child = activeShells.get(payload.targetId || id);
          if (child) { child.kill('SIGTERM'); send(ws, 'shell:cancelled', id, { ok: true }); }
          else send(ws, 'shell:cancelled', id, { ok: false, message: 'no such shell' });
          break;
        }
        case 'fs:write': {
          const abs = safeResolve(workspaceDir, payload.path);
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, payload.content ?? '', 'utf8');
          const st = await fsp.stat(abs);
          send(ws, 'fs:success', id, { path: payload.path, bytesWritten: st.size });
          break;
        }
        case 'fs:read': {
          const abs = safeResolve(workspaceDir, payload.path);
          const content = await fsp.readFile(abs, 'utf8');
          send(ws, 'fs:data', id, { path: payload.path, content });
          break;
        }
        case 'fs:delete': {
          const abs = safeResolve(workspaceDir, payload.path);
          await fsp.rm(abs, { recursive: true, force: true });
          send(ws, 'fs:success', id, { path: payload.path, deleted: true });
          break;
        }
        case 'fs:tree': {
          const tree = await buildFsTree(workspaceDir);
          send(ws, 'fs:tree_result', id, { root: workspaceDir, tree });
          break;
        }
        case 'fs:search': {
          const query = payload.query || '';
          const excludes = (payload.exclude || ['node_modules', '.git', '.next']).map(e => `--glob=!${e}`).join(' ');
          const cmd = `rg --line-number --no-heading --color=never ${excludes} -- ${JSON.stringify(query)} . || true`;
          exec(cmd, { cwd: workspaceDir, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
            const matches = stdout.split('\n').filter(Boolean).slice(0, 500).map(line => {
              const [file, lineNo, ...rest] = line.split(':');
              return { path: file, line: Number(lineNo), text: rest.join(':') };
            });
            send(ws, 'fs:search_results', id, { matches });
          });
          break;
        }
        case 'workspace:diagnostics': {
          // tsc --noEmit if tsconfig exists, plus eslint if config exists
          const errors = [];
          const hasTs = fs.existsSync(path.join(workspaceDir, 'tsconfig.json'));
          if (hasTs) {
            await new Promise((resolve) => {
              exec('npx --no-install tsc --noEmit --pretty false', { cwd: workspaceDir, maxBuffer: 8 * 1024 * 1024 }, (_e, stdout) => {
                stdout.split('\n').forEach((l) => {
                  const m = l.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/);
                  if (m) errors.push({ file: m[1], line: +m[2], column: +m[3], severity: m[4], message: m[5], source: 'typescript' });
                });
                resolve();
              });
            });
          }
          send(ws, 'workspace:diagnostics_result', id, { errors });
          break;
        }
        case 'workspace:deploy': {
          send(ws, 'workspace:deploy_started', id, { workspaceDir });
          // Hand off to existing pipeline if a git URL/app name was provided
          const { deployApp } = require('./pipeline');
          if (payload.appName && payload.gitUrl) {
            try {
              const result = await deployApp(payload.appName, payload.gitUrl, payload.token || process.env.GITHUB_API_TOKEN);
              send(ws, 'workspace:deploy_result', id, { status: 'success', ...result });
            } catch (err) {
              send(ws, 'workspace:deploy_result', id, { status: 'error', message: err.message });
            }
          } else {
            send(ws, 'workspace:deploy_result', id, { status: 'error', message: 'appName and gitUrl required' });
          }
          break;
        }
        case 'ping':
          send(ws, 'pong', id, { t: Date.now() });
          break;
        default:
          send(ws, 'error', id, { message: `unknown action: ${action}` });
      }
    } catch (err) {
      send(ws, 'error', id, { message: err.message });
    }
  });

  ws.on('close', () => {
    // kill any shells spawned by this connection? activeShells is global;
    // for simplicity we leave them. Production: track per-connection.
  });
}

function attach(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/api/v1/workspace')) {
      socket.destroy();
      return;
    }
    if (!checkAuth(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const { dir, name } = getWorkspaceDir(req);
      send(ws, 'workspace:ready', null, { workspace: name, dir });
      attachHandlers(ws, dir);
    });
  });

  return wss;
}

module.exports = { attach, WORKSPACES_ROOT };
