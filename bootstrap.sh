#!/usr/bin/env bash
# Sycord Runner bootstrap — clone (or update) the repo, install deps, start.
#
# Usage:
#   curl -fsSL <raw-url>/bootstrap.sh | bash
#   ./bootstrap.sh
#
# Env overrides:
#   REPO_URL   git URL to clone           (default: https://github.com/sycord/runner.git)
#   REPO_DIR   target directory           (default: sycord-runner)
#   BRANCH     branch to check out        (default: main)
#   PORT       runner HTTP+WS port        (default: 4500)
#   NO_START=1 skip `npm start` at the end
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/MDavidka/companion-server}"
REPO_DIR="${REPO_DIR:-sycord-runner}"
BRANCH="${BRANCH:-main}"
PORT="${PORT:-4500}"

c_blue='\033[0;34m'; c_green='\033[0;32m'; c_yellow='\033[1;33m'; c_red='\033[0;31m'; c_nc='\033[0m'
log()  { printf "${c_blue}[bootstrap]${c_nc} %s\n" "$*"; }
ok()   { printf "${c_green}[ok]${c_nc} %s\n" "$*"; }
warn() { printf "${c_yellow}[warn]${c_nc} %s\n" "$*"; }
die()  { printf "${c_red}[err]${c_nc} %s\n" "$*" >&2; exit 1; }

command -v git  >/dev/null || die "git is required"
command -v node >/dev/null || die "node is required (>=18)"
command -v npm  >/dev/null || die "npm is required"

# Pick a package manager: prefer pnpm if present, else npm
if command -v pnpm >/dev/null; then PM=pnpm; INSTALL="pnpm install"
else PM=npm; INSTALL="npm install --no-audit --no-fund --legacy-peer-deps"
fi
log "using package manager: $PM"

# Clone or update
if [ -d "$REPO_DIR/.git" ]; then
  log "updating existing checkout in $REPO_DIR"
  git -C "$REPO_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$REPO_DIR" reset --hard "origin/$BRANCH"
elif [ -d "$REPO_DIR" ] && [ -n "$(ls -A "$REPO_DIR" 2>/dev/null)" ]; then
  warn "$REPO_DIR exists and is not a git repo — using it in place"
else
  log "cloning $REPO_URL ($BRANCH) → $REPO_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"

# .env
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    warn ".env created from .env.example — edit it before exposing publicly"
  else
    warn "no .env or .env.example found — continuing with process env only"
  fi
fi

log "installing dependencies..."
$INSTALL
ok "dependencies installed"

# workspaces dir for SWD
mkdir -p workspaces

if [ "${NO_START:-0}" = "1" ]; then
  ok "setup complete (NO_START=1) — run 'npm start' to launch"
  exit 0
fi

log "starting runner on port $PORT"
log "  HTTP:      http://0.0.0.0:$PORT"
log "  SWD (ws):  ws://0.0.0.0:$PORT/api/v1/workspace"
PORT="$PORT" exec npm start
