#!/usr/bin/env bash
set -euo pipefail

# Preflight: verify gh CLI version >= 2.83
echo "Checking gh CLI..."
gh_ver=$(gh --version | sed -n 's/.*version \([0-9]*\.[0-9]*\).*/\1/p' | head -1)
gh_major=${gh_ver%%.*}
gh_minor=${gh_ver#*.}
if (( gh_major < 2 || (gh_major == 2 && gh_minor < 83) )); then
  echo "ERROR: gh CLI version $gh_ver is too old. Version >= 2.83 is required." >&2
  exit 1
fi

# Verify gh CLI is authenticated
if ! gh auth status &>/dev/null; then
  echo "ERROR: 'gh auth status' failed. Run 'gh auth login' first." >&2
  exit 1
fi
echo "gh CLI OK (v$gh_ver)"

# Preflight: verify claude CLI works (catches wrong node version, missing auth, etc.)
echo "Checking claude CLI..."
claude_ver=$(claude --version 2>/dev/null || echo "unknown")
if ! claude -p "say hello" &>/dev/null; then
  echo "ERROR: claude v$claude_ver — 'claude -p \"say hello\"' failed. Fix claude CLI before installing the service." >&2
  exit 1
fi
echo "claude CLI OK (v$claude_ver)"

# Install pm2 globally if missing
if ! command -v pm2 &>/dev/null; then
  echo "Installing pm2 globally..."
  npm install -g pm2
fi

# Stop existing process (idempotent)
pm2 stop github-status 2>/dev/null || true
pm2 delete github-status 2>/dev/null || true

# Start the service
PORT="${PORT:-7777}"
pm2 start server.js --name github-status --env PORT="$PORT"

# Setup pm2 to survive reboots
startup_cmd=$(pm2 startup 2>/dev/null | grep -o 'sudo .*$') || true
if [[ -n "$startup_cmd" ]]; then
  echo "Running: $startup_cmd"
  eval "$startup_cmd"
fi

pm2 save

echo ""
echo "github-status is running at http://localhost:$PORT and will survive reboots"
