#!/usr/bin/env bash
set -euo pipefail

pm2 stop github-status 2>/dev/null || true
pm2 start github-status
