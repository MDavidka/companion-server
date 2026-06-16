# Sycord Runner + Workspace Daemon

A self-hosted deployment runner **and** a real-time WebSocket workspace
daemon (SWD) designed for autonomous AI software engineers (Syra, etc.).

## What it does

1. Clones any GitHub repo, detects the framework, installs deps, builds,
   and runs it on a free port behind a subdomain proxy.
2. Optionally exposes the app via a Cloudflare Tunnel.
3. Hosts the **Sycord Workspace Daemon (SWD)** — a WebSocket API that lets
   an AI agent stream shell output, read/write files, run diagnostics, and
   deploy, all over a single persistent connection.

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

> Use a Cloudflare **API Token** (Account → Cloudflare Pages: Edit,
> Zone → DNS: Edit, Account Settings: Read). The legacy Global API Key
> is not reliably accepted by Wrangler/Pages.

## Running

```bash
npm install
npm start
# Runner listening on port 4500
# Sycord Workspace Daemon: ws://0.0.0.0:4500/api/v1/workspace
```

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

### `/run vps`

Provisions (or reuses) an isolated workspace directory and returns the
WebSocket URL an AI agent should connect to.

```bash
curl -X POST http://localhost:4500/api/run/vps \
  -H 'content-type: application/json' \
  -d '{ "workspace": "syra-session-1", "repo": "owner/repo" }'
```

```json
{
  "success": true,
  "command": "/run vps",
  "workspace": "syra-session-1",
  "dir": "/app/workspaces/syra-session-1",
  "wsUrl": "ws://host/api/v1/workspace?workspace=syra-session-1&token=...",
  "api": {
    "shell": "shell:run",
    "fs": ["fs:write", "fs:read", "fs:delete", "fs:tree", "fs:search"],
    "diagnostics": "workspace:diagnostics",
    "deploy": "workspace:deploy"
  }
}
```

## Sycord Workspace Daemon (SWD)

```
┌──────────────────┐    WebSocket     ┌───────────────────────┐
│ AI Agent (Syra)  │ <==============> │ Workspace Daemon      │ → bash, fs, tsc
│ / Host Platform  │  /api/v1/workspace                       │
└──────────────────┘                  └───────────────────────┘
```

**Connect:** `ws(s)://<host>/api/v1/workspace?workspace=<name>&token=<jwt>`

Auth enforced when `WORKSPACE_TOKEN` is set. On connect the daemon emits
`workspace:ready` with the workspace directory.

Every request: `{ "action": "...", "id": "req-N", "payload": {...} }`
Every response: `{ "event": "...", "id": "req-N", "payload": {...} }`

### Actions

| Action                  | Description                                                       |
| ----------------------- | ----------------------------------------------------------------- |
| `shell:run`             | Run bash; streams `shell:stdout` / `shell:stderr` → `shell:exit`  |
| `shell:cancel`          | Cancel a running command by id                                    |
| `fs:write`              | Write/overwrite file (`{ path, content }`)                        |
| `fs:read`               | Read file → `fs:data`                                             |
| `fs:delete`             | Recursive delete                                                  |
| `fs:tree`               | Project tree (skips `node_modules`, `.git`, `.next`)              |
| `fs:search`             | ripgrep across the workspace                                      |
| `workspace:diagnostics` | Runs `tsc --noEmit`, returns structured errors                    |
| `workspace:deploy`      | Hands off to the runner pipeline (`{ appName, gitUrl, token? }`)  |
| `ping` / `pong`         | Keepalive                                                         |

### Example — shell

```json
→ { "action": "shell:run", "id": "1",
    "payload": { "command": "pnpm install && pnpm build", "cwd": "." } }

← { "event": "shell:stdout", "id": "1", "payload": { "chunk": "Lockfile up to date\n" } }
← { "event": "shell:exit",   "id": "1", "payload": { "exitCode": 0, "durationMs": 4210 } }
```

### Example — diagnostics

```json
→ { "action": "workspace:diagnostics", "id": "2" }

← { "event": "workspace:diagnostics_result", "id": "2",
    "payload": { "errors": [
      { "file": "app/page.tsx", "line": 4, "column": 12,
        "severity": "error", "source": "typescript",
        "message": "Type 'string' is not assignable to type 'number'." }
    ] } }
```

### Example — deploy

```json
→ { "action": "workspace:deploy", "id": "3",
    "payload": { "appName": "demo", "gitUrl": "https://github.com/owner/repo" } }

← { "event": "workspace:deploy_result", "id": "3",
    "payload": { "status": "success", "url": "https://demo.sycord.site" } }
```

## Why this matters for AI agents

- **One persistent socket** — no HTTP timeouts or aborted fetches.
- **Real-time stdout** — see build output live, cancel hung commands.
- **Sub-100 ms diagnostics** — direct `tsc` runs, structured JSON errors.
- **Isolated workspaces** — each session gets its own dir under `workspaces/`.
- **Multi-package-manager ready** — `pnpm`, `yarn`, `npm` all installed.

## Notes

- The runner's per-repo deploy pipeline (`/api/deploy/:repo_id`) is
  unchanged. SWD is additive.
- For OverlayFS pre-cached `node_modules`, mount
  `/opt/sycord/package-cache/node_modules` (lower) over each workspace's
  `node_modules` (upper) at container start — infra concern, not daemon.
- Workspace isolation here is path-based. Run the daemon inside a
  container with its own network/FS namespace for true isolation.
