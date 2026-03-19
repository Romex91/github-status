#!/usr/bin/env bash
set -euo pipefail

pm2 stop github-status
pm2 delete github-status
pm2 save

unstartup_cmd=$(pm2 unstartup 2>/dev/null | grep -o 'sudo .*$') || true
if [[ -n "$unstartup_cmd" ]]; then
  echo "Running: $unstartup_cmd"
  eval "$unstartup_cmd"
fi

echo ""
echo "github-status service removed"
