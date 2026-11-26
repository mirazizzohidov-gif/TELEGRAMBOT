// Telegram'ga kelgan baza zaxirasini (mixbot-baza-*.jsonl.gz) serverdagi Redis'ga tiklash.
//   systemctl stop mixbot
//   node scripts/redis-restore.mjs /root/mixbot-baza-2026-11-27_03-00.jsonl.gz
//   systemctl start mixbot
// Faylni serverga yuklash (kompyuterdan): scp mixbot-baza-....jsonl.gz root@188.245.91.98:/root/
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createClient } from 'redis';

const file = process.argv[2];
if (!file) {
  console.log('Foydalanish: node scripts/redis-restore.mjs <zaxira.jsonl.gz> [--flush]');
  process.exit(1);
}
const lines = gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean);
const c = createClient({ url: 'redis://127.0.0.1:6379' });
await c.connect();
if (process.argv.includes('--flush')) await c.flushDb();
let n = 0;
for (const line of lines) {
  const { k, t, ttl, v } = JSON.parse(line);
  const m = c.multi().del(k);
  if (t === 'string') m.set(k, v);
  else if (t === 'hash' && Object.keys(v).length) m.hSet(k, v);
  else if (t === 'list' && v.length) m.rPush(k, v);
  else if (t === 'set' && v.length) m.sAdd(k, v);
  else if (t === 'zset' && v.length) m.zAdd(k, v.map((x) => ({ value: String(x.value), score: Number(x.score) })));
  else continue;
  if (ttl > 0) m.pExpire(k, ttl);
  await m.exec();
  n++;
}
console.log(`TAYYOR: ${n} ta kalit tiklandi. Redis'da: ${await c.dbSize()}`);
await c.quit();
