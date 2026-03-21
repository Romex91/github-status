#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

pm2 stop github-status || true
git pull origin HEAD
pm2 start github-status