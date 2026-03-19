#!/usr/bin/env bash
set -euo pipefail

# Install pm2 globally if missing
if ! command -v pm2 &>/dev/null; then
  echo "Installing pm2 globally..."
  npm install -g pm2
fi

# Stop existing process (idempotent)
pm2 stop github-status 2>/dev/null || true
pm2 delete github-status 2>/dev/null || true

# Start the service
pm2 start server.js --name github-status

# Setup pm2 to survive reboots
startup_cmd=$(pm2 startup 2>/dev/null | grep -o 'sudo .*$') || true
if [[ -n "$startup_cmd" ]]; then
  echo "Running: $startup_cmd"
  eval "$startup_cmd"
fi

pm2 save

echo ""
echo "github-status is running at http://localhost:7777 and will survive reboots"
