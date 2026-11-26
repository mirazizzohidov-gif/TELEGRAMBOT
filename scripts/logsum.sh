#!/usr/bin/env bash
# Log xulosasi:  bash /opt/mixbot/scripts/logsum.sh [soat]   (default 24)
H="${1:-24}"
L=$(journalctl -u mixbot --since "-$H hours" --no-pager -o cat)
echo "== Oxirgi $H soat"
echo "== TICK: $(grep -c 'cron /api/cron/tick: 200' <<<"$L") ta OK, $(grep 'cron /api/cron/tick' <<<"$L" | grep -vc ': 200') ta xato"
echo "== DAILY: $(grep -c 'cron /api/cron/daily' <<<"$L")"
echo "== RESTART: $(journalctl -u mixbot --since "-$H hours" --no-pager | grep -c 'Started mixbot')"
echo "== DEPLOY: $(journalctl -u mixbot-update --since "-$H hours" --no-pager -o cat | grep -c 'deploy:')"
echo "== XATOLAR (soni, turi):"
grep -iE "error|xato|fail|timeout|uncaught|unhandled|invalid|expired|denied|forbidden" <<<"$L" | grep -v "not found in BITO" \
  | sed -E 's/[0-9a-f]{24}/ID/g; s/[0-9]+/N/g' | cut -c1-150 | sort | uniq -c | sort -rn | head -30
echo "== JOYLANGANLAR:"
grep -iE "posted|uploaded|story ok|story -> .*: ok|published|sent story|yt:|ig .* ok|tt:|reel" <<<"$L" | grep -viE "error|fail" \
  | sed -E 's/[0-9a-f]{24}/ID/g; s/[0-9]+/N/g' | cut -c1-90 | sort | uniq -c | sort -rn | head -20
echo "== REDIS: $(grep -q '^REDIS_URL="redis://127.0.0.1' /opt/mixbot/.env && echo server || echo TASHQI) · kalitlar $(redis-cli dbsize 2>/dev/null) · xotira $(redis-cli info memory 2>/dev/null | grep -m1 used_memory_human | cut -d: -f2 | tr -d '\r')"
echo "== RESURS:"
free -m | head -2; df -h / | tail -1; uptime
