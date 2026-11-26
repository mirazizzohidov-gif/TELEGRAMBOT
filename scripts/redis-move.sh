#!/usr/bin/env bash
# Bir martalik: serverga Redis o'rnatish va bot bazasini unga ko'chirish.
#   bash /opt/mixbot/scripts/redis-move.sh
set -euo pipefail
cd /opt/mixbot
if ! command -v redis-server >/dev/null; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y redis-server
fi
C=/etc/redis/redis.conf
grep -q '^maxmemory 512mb' $C || echo 'maxmemory 512mb' >> $C
grep -q '^appendonly yes' $C || sed -i 's/^appendonly no/appendonly yes/' $C
grep -q '^bind 127.0.0.1' $C || sed -i 's/^# *bind 127.0.0.1 -::1/bind 127.0.0.1 -::1/' $C
systemctl enable redis-server >/dev/null 2>&1
systemctl restart redis-server
sleep 1
redis-cli ping
echo "Bot to'xtatilmoqda (1-2 daqiqa)..."
systemctl stop mixbot
if node scripts/redis-migrate.mjs --switch; then
  echo "OK"
else
  echo "Ko'chirishda muammo — bot eski Redis bilan qayta yoqiladi."
fi
systemctl start mixbot
sleep 3
systemctl is-active mixbot
curl -s localhost:3000/health; echo
echo "Redis kalitlari: $(redis-cli dbsize)"
