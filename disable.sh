#!/usr/bin/env bash
set -euo pipefail

pm2 stop github-status
pm2 delete github-status
pm2 save

echo ""
echo "github-status service removed"
