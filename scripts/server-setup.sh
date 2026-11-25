#!/usr/bin/env bash
# Hetzner (Ubuntu 24.04) serverni bir marta sozlash: Node 22, Caddy (HTTPS), bot xizmati, avto-yangilanish.
#   bash server-setup.sh
set -euo pipefail
APP=/opt/mixbot
REPO=https://github.com/mirazizzohidov-gif/TELEGRAMBOT.git
IP=$(curl -4 -s https://api.ipify.org)
HOST="${HOST:-${IP//./-}.sslip.io}"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates gnupg ufw fontconfig fonts-dejavu-core debian-keyring debian-archive-keyring apt-transport-https

# swap 2 GB (video paytida xotira yetmay qolmasin)
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# Node 22
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Caddy
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# kod
if [ ! -d "$APP/.git" ]; then git clone "$REPO" "$APP"; fi
cd "$APP"
git fetch -q origin main && git reset -q --hard origin/main
npm ci --no-audit --no-fund --omit=dev || npm install --no-audit --no-fund
node node_modules/ffmpeg-static/install.js || true

# .env (kalitlar keyin qo'lda kiritiladi)
if [ ! -f "$APP/.env" ]; then
  printf 'PUBLIC_HOST=%s\nPORT=3000\nCRON_ON=0\n' "$HOST" > "$APP/.env"
  chmod 600 "$APP/.env"
fi

# bot xizmati
cat > /etc/systemd/system/mixbot.service <<UNIT
[Unit]
Description=Mixpodarok bot
After=network-online.target
[Service]
WorkingDirectory=$APP
ExecStart=/usr/bin/node --max-old-space-size=2048 server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
UNIT

# avto-yangilanish: har 2 daqiqada GitHub'ni tekshiradi
cat > /etc/systemd/system/mixbot-update.service <<UNIT
[Unit]
Description=Mixpodarok bot update
[Service]
Type=oneshot
ExecStart=/bin/bash $APP/scripts/autodeploy.sh
UNIT
cat > /etc/systemd/system/mixbot-update.timer <<UNIT
[Unit]
Description=Mixpodarok bot update every 2 min
[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
[Install]
WantedBy=timers.target
UNIT

# HTTPS
cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
  encode gzip
  request_body {
    max_size 60MB
  }
  reverse_proxy 127.0.0.1:3000 {
    transport http {
      read_timeout 330s
      write_timeout 330s
    }
  }
}
CADDY

ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null

systemctl daemon-reload
systemctl enable --now mixbot mixbot-update.timer
systemctl restart caddy
sleep 3
echo
echo "TAYYOR. Manzil: https://$HOST"
curl -s "http://127.0.0.1:3000/health" && echo
