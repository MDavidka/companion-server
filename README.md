# Sycord Runner + Workspace Daemon (SWD)

A self-hosted deployment runner **and** a real-time WebSocket workspace
daemon designed for autonomous AI software engineers (Syra, etc.).

## What it does

1. Clones any GitHub repo, detects the framework, installs deps, builds,
   and runs it on a free port behind a subdomain proxy.
2. Optionally exposes the app via a Cloudflare Tunnel.
3. Hosts the **Sycord Workspace Daemon (SWD)** — a WebSocket API that lets
   an AI agent stream shell output, read/write files, run diagnostics, and
   deploy, all over a single persistent connection.

## Quick start (one-line bootstrap)

The repo ships a `bootstrap.sh` that clones (or updates) this repo, installs
dependencies with whichever package manager is available (`pnpm` → `npm`),
copies `.env.example` → `.env` if missing, and starts the runner.

```bash
curl -fsSL https://raw.githubusercontent.com/<your-org>/sycord-runner/main/bootstrap.sh | bash
# or, if the repo is already on disk:
./bootstrap.sh
```

Environment overrides:

| Var          | Default                                          | Purpose                       |
| ------------ | ------------------------------------------------ | ----------------------------- |
| `REPO_URL`   | `https://github.com/sycord/runner.git`           | Repo to clone                 |
| `REPO_DIR`   | `sycord-runner`                                  | Local clone directory         |
| `BRANCH`     | `main`                                           | Branch to check out           |
| `PORT`       | `4500`                                           | HTTP + WS port                |
| `NO_START`   | unset                                            | Set to `1` to skip `npm start`|

## Environment

| Variable                | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `CLOUDFLARE_API_KEY`    | Cloudflare **API Token** (Pages:Edit + Zone:Edit)      |
| `CLOUDFLARE_ZONE_ID`    | Zone ID for your domain                                |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID                                  |
| `CLOUDFLARE_DOMAIN`     | Apex domain (e.g. `sycord.site`)                       |
| `CLOUDFLARED_TUNNEL_ID` | Pre-created tunnel ID (optional)                       |
| `GITHUB_API_TOKEN`      | Token used to clone private repos                      |
| `MONGO_URI`             | MongoDB connection string for repo registry           |
| `PORT`                  | HTTP port for the runner (default `4500`)              |
| `AUTO_UPDATE`           | `false` to disable self-update                         |
| `WORKSPACE_TOKEN`       | Bearer token required by the SWD WebSocket (optional)  |

The Dockerfile installs Node 20, `pnpm`, `yarn`, `ripgrep`, and `git`.

## HTTP Endpoints

| Method | Path                   | Purpose                                |
| ------ | ---------------------- | -------------------------------------- |
| POST   | `/api/deploy/:repo_id` | Clone, build, run a registered repo    |
| POST   | `/api/redeploy/:name`  | Re-run an existing deployment          |
| DELETE | `/api/delete/:name`    | Stop and remove a deployment           |
| GET    | `/api/status`          | List running deployments               |
| GET    | `/api/logs/:name`      | Tail deployment logs (SSE)             |
| GET    | `/api/repos`           | Repos from Mongo registry              |
| GET    | `/api/health`          | Liveness                               |
| GET    | `/api/system`          | Host info                              |
| POST   | **`/api/run/vps`**     | **`/run vps`** — provision a workspace |
| GET    | `/api/run/vps`         | List active workspaces                 |

---

## `/run vps` — Provision a workspace

`POST /api/run/vps` provisions (or reuses) an isolated workspace directory
under `workspaces/<name>/` and returns the WebSocket URL the AI agent should
connect to.

**Request**

```http
POST /api/run/vps HTTP/1.1
Content-Type: application/json

{
  "workspace": "syra-session-1",   // optional, generated if omitted
  "repo": "owner/repo"             // optional, informational
}
```

**Response**

```json
{
  "success": true,
  "command": "/run vps",
  "workspace": "syra-session-1",
  "dir": "/app/workspaces/syra-session-1",
  "repo": "owner/repo",
  "wsUrl": "ws://host:4500/api/v1/workspace?workspace=syra-session-1&token=...",
  "api": {
    "shell": "shell:run",
    "fs": ["fs:write", "fs:read", "fs:delete", "fs:tree", "fs:search"],
    "diagnostics": "workspace:diagnostics",
    "deploy": "workspace:deploy"
  }
}
```

---

## Sycord Workspace Daemon (SWD)

```
┌──────────────────┐    WebSocket       ┌───────────────────────┐
│ AI Agent (Syra)  │ <================> │ Workspace Daemon      │ → bash, fs, tsc, deploy
│ / Host Platform  │  /api/v1/workspace                         │
└──────────────────┘                    └───────────────────────┘
```

### Handshake

1. Client opens a WebSocket to:

   ```
   ws(s)://<host>/api/v1/workspace?workspace=<name>&token=<WORKSPACE_TOKEN>
   ```

   `token` may instead be sent as `Authorization: Bearer <token>` on the
   upgrade request. When `WORKSPACE_TOKEN` is unset, the daemon runs in
   open mode (any caller accepted — local/dev only).

2. Server validates the token. On failure it returns
   `HTTP/1.1 401 Unauthorized` and closes the socket. On success the
   upgrade completes (HTTP 101) and the daemon immediately pushes:

   ```json
   { "event": "workspace:ready", "id": null,
     "payload": { "workspace": "syra-session-1",
                  "dir": "/app/workspaces/syra-session-1" } }
   ```

3. From here on, every frame is JSON. Request frames carry an `id`
   chosen by the client; every response echoes the same `id` so multiple
   in-flight requests can be correlated on a single socket.

### Frame envelope

**Request (client → daemon)**

```ts
{ action: string, id: string, payload?: object }
```

**Response (daemon → client)**

```ts
{ event: string, id: string | null, payload: object }
```

All paths in payloads are **relative to the workspace dir**; absolute paths
or `..` segments that escape the workspace are rejected with
`{ event: "error", payload: { message: "Path escapes workspace: ..." } }`.

### Action schemas

#### `shell:run`
Run a bash command. Streams stdout/stderr, then exits.

```ts
// request payload
{ command: string, cwd?: string, env?: Record<string,string> }

// events emitted (all share the request id)
"shell:stdout"   { chunk: string }
"shell:stderr"   { chunk: string }
"shell:exit"     { exitCode: number, durationMs: number }
"shell:error"    { message: string }   // spawn-level error
```

#### `shell:cancel`
Cancels a running command (SIGTERM).

```ts
// request
{ targetId?: string }   // defaults to the cancel request's own id
// response
"shell:cancelled" { ok: boolean, message?: string }
```

#### `fs:write`
```ts
// request
{ path: string, content: string }
// response
"fs:success" { path: string, bytesWritten: number }
```

#### `fs:read`
```ts
// request
{ path: string }
// response
"fs:data" { path: string, content: string }   // utf-8
```

#### `fs:delete`
```ts
// request
{ path: string }   // recursive, force
// response
"fs:success" { path: string, deleted: true }
```

#### `fs:tree`
```ts
// request
{}   // no payload
// response
"fs:tree_result" {
  root: string,
  tree: Array<{ path: string, type: "file" | "dir", children?: any[] }>
}
// skips node_modules, .git, .next; max depth 6
```

#### `fs:search` (ripgrep)
```ts
// request
{ query: string, exclude?: string[] }   // exclude defaults to node_modules/.git/.next
// response (capped at 500)
"fs:search_results" { matches: Array<{ path: string, line: number, text: string }> }
```

#### `workspace:diagnostics`
Runs `tsc --noEmit` when `tsconfig.json` is present.

```ts
// request
{}
// response
"workspace:diagnostics_result" {
  errors: Array<{
    file: string, line: number, column: number,
    severity: "error" | "warning",
    message: string, source: "typescript"
  }>
}
```

#### `workspace:deploy`
Hands off to the existing deploy pipeline.

```ts
// request
{ appName: string, gitUrl: string, token?: string }
// responses
"workspace:deploy_started" { workspaceDir: string }
"workspace:deploy_result"  { status: "success" | "error", url?: string, message?: string }
```

#### `ping` / `pong`
```ts
→ { action: "ping",  id: "kp-1" }
← { event:  "pong",  id: "kp-1", payload: { t: 1718553600123 } }
```

#### Generic error frame
```ts
{ event: "error", id: "<request id or null>", payload: { message: string } }
```

---

## End-to-end example — `/run vps` + WebSocket session

```bash
# 1) Provision a workspace
RESP=$(curl -sX POST http://localhost:4500/api/run/vps \
  -H 'content-type: application/json' \
  -d '{ "workspace": "demo", "repo": "owner/repo" }')
echo "$RESP"
# { "success": true, "wsUrl": "ws://localhost:4500/api/v1/workspace?workspace=demo&token=...", ... }
```

```js
// 2) Connect from a Node client
import WebSocket from 'ws';
const ws = new WebSocket(JSON.parse(RESP).wsUrl);

ws.on('message', (raw) => console.log('<', raw.toString()));

ws.once('open', () => {
  // Wait for workspace:ready, then clone + install + build
  ws.send(JSON.stringify({
    action: 'shell:run', id: 'r1',
    payload: { command: 'git clone https://github.com/owner/repo . && pnpm install && pnpm build' }
  }));
});
```

**Frames you will see (abridged):**

```json
< { "event": "workspace:ready", "id": null,
    "payload": { "workspace": "demo", "dir": "/app/workspaces/demo" } }

> { "action": "shell:run", "id": "r1",
    "payload": { "command": "git clone https://github.com/owner/repo . && pnpm install && pnpm build" } }

< { "event": "shell:stdout", "id": "r1", "payload": { "chunk": "Cloning into '.'...\n" } }
< { "event": "shell:stdout", "id": "r1", "payload": { "chunk": "Lockfile up to date, resolution step is skipped\n" } }
< { "event": "shell:stderr", "id": "r1", "payload": { "chunk": "warn ..." } }
< { "event": "shell:exit",   "id": "r1", "payload": { "exitCode": 0, "durationMs": 18432 } }

> { "action": "workspace:diagnostics", "id": "r2" }

< { "event": "workspace:diagnostics_result", "id": "r2",
    "payload": { "errors": [
      { "file": "src/app.tsx", "line": 12, "column": 8,
        "severity": "error", "source": "typescript",
        "message": "Type 'string' is not assignable to type 'number'." }
    ] } }

> { "action": "fs:write", "id": "r3",
    "payload": { "path": "src/app.tsx", "content": "...fixed source..." } }

< { "event": "fs:success", "id": "r3", "payload": { "path": "src/app.tsx", "bytesWritten": 1284 } }

> { "action": "workspace:deploy", "id": "r4",
    "payload": { "appName": "demo", "gitUrl": "https://github.com/owner/repo" } }

< { "event": "workspace:deploy_started", "id": "r4", "payload": { "workspaceDir": "/app/workspaces/demo" } }
< { "event": "workspace:deploy_result",  "id": "r4",
    "payload": { "status": "success", "url": "https://demo.sycord.site" } }
```

---

## Why this matters for AI agents

- **One persistent socket** — no HTTP timeouts or aborted fetches.
- **Real-time stdout** — see build output live, cancel hung commands.
- **Sub-100 ms diagnostics** — direct `tsc` runs, structured JSON errors.
- **Isolated workspaces** — each session gets its own dir under `workspaces/`.
- **Multi-package-manager ready** — `pnpm`, `yarn`, `npm` all installed.

## Notes

- The runner's per-repo deploy pipeline (`/api/deploy/:repo_id`) is
  unchanged. SWD is additive.
- Workspace isolation here is path-based. Run the daemon inside a
  container with its own network/FS namespace for true isolation.
