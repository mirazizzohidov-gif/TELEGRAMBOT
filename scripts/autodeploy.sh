#!/usr/bin/env bash
# GitHub'da yangi kod bo'lsa: yuklab oladi va botni qayta ishga tushiradi.
set -euo pipefail
cd /opt/mixbot
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && exit 0
OLD_LOCK=$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)
git reset -q --hard origin/main
if [ "$OLD_LOCK" != "$(git rev-parse HEAD:package-lock.json 2>/dev/null || echo none)" ]; then
  npm ci --no-audit --no-fund --omit=dev || npm install --no-audit --no-fund
  node node_modules/ffmpeg-static/install.js || true
fi
systemctl restart mixbot
echo "deploy: $(git log --oneline -1)"
