// Redis'ni (Vercel/Redis Cloud yoki Upstash) serverdagi o'z Redis'imizga ko'chirish.
//   node scripts/redis-migrate.mjs            — faqat nusxalaydi va solishtiradi
//   node scripts/redis-migrate.mjs --switch   — nusxalab, .env ni yangi Redis'ga o'tkazadi
// Qiymatlar ekranga chiqarilmaydi, faqat sonlar.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from 'redis';
import { Redis as Upstash } from '@upstash/redis';

const ROOT = process.cwd();
const ENV = join(ROOT, '.env');
const DST_URL = 'redis://127.0.0.1:6379';
const env = {};
for (const line of readFileSync(ENV, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  let v = m[2];
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[m[1]] = v;
}
const restUrl = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
const restTok = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
const srcUrl = env.REDIS_URL_OLD || env.REDIS_URL;
if (!restUrl && (!srcUrl || srcUrl.includes('127.0.0.1'))) {
  console.log('Manba Redis topilmadi yoki allaqachon ko\'chirilgan.');
  process.exit(1);
}

// manba: bir xil interfeys
let src;
let srcName;
if (restUrl && restTok) {
  srcName = 'Upstash (REST)';
  const u = new Upstash({ url: restUrl, token: restTok, automaticDeserialization: false });
  src = {
    async *keys() {
      let c = '0';
      do {
        const [next, ks] = await u.scan(c, { count: 500 });
        c = String(next);
        yield ks;
      } while (c !== '0');
    },
    type: (k) => u.type(k),
    pttl: (k) => u.pttl(k),
    get: (k) => u.get(k),
    hgetall: async (k) => (await u.hgetall(k)) || {},
    lrange: (k) => u.lrange(k, 0, -1),
    smembers: (k) => u.smembers(k),
    zrange: async (k) => {
      const a = await u.zrange(k, 0, -1, { withScores: true });
      const out = [];
      for (let i = 0; i < a.length; i += 2) out.push({ value: String(a[i]), score: Number(a[i + 1]) });
      return out;
    },
    close: async () => {},
  };
} else {
  srcName = 'REDIS_URL';
  const c = createClient({ url: srcUrl, socket: { connectTimeout: 15000 } });
  c.on('error', (e) => console.error('manba:', e.message));
  await c.connect();
  src = {
    async *keys() {
      for await (const k of c.scanIterator({ COUNT: 500 })) yield Array.isArray(k) ? k : [k];
    },
    type: (k) => c.type(k),
    pttl: (k) => c.pTTL(k),
    get: (k) => c.get(k),
    hgetall: (k) => c.hGetAll(k),
    lrange: (k) => c.lRange(k, 0, -1),
    smembers: (k) => c.sMembers(k),
    zrange: (k) => c.zRangeWithScores(k, 0, -1),
    close: () => c.quit(),
  };
}

const dst = createClient({ url: DST_URL });
dst.on('error', (e) => console.error('server redis:', e.message));
await dst.connect();

console.log(`Manba: ${srcName} → ${DST_URL}`);
const stat = {};
let n = 0;
let fail = 0;
for await (const batch of src.keys()) {
  for (const k of batch) {
    try {
      const t = String(await src.type(k));
      const ttl = Number(await src.pttl(k));
      if (t === 'none' || ttl === -2) continue;
      await dst.del(k);
      if (t === 'string') {
        const v = await src.get(k);
        if (v === null || v === undefined) continue;
        await dst.set(k, typeof v === 'string' ? v : JSON.stringify(v));
      } else if (t === 'hash') {
        const h = await src.hgetall(k);
        const flat = Object.fromEntries(Object.entries(h).map(([f, v]) => [f, typeof v === 'string' ? v : JSON.stringify(v)]));
        if (Object.keys(flat).length) await dst.hSet(k, flat);
      } else if (t === 'list') {
        const l = (await src.lrange(k)).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
        if (l.length) await dst.rPush(k, l);
      } else if (t === 'set') {
        const s = (await src.smembers(k)).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
        if (s.length) await dst.sAdd(k, s);
      } else if (t === 'zset') {
        const z = await src.zrange(k);
        if (z.length) await dst.zAdd(k, z.map((x) => ({ value: String(x.value), score: Number(x.score) })));
      } else {
        console.log(`o'tkazildi (turi ${t}): 1 kalit`);
        continue;
      }
      if (ttl > 0) await dst.pExpire(k, ttl);
      stat[t] = (stat[t] || 0) + 1;
      n++;
      if (n % 500 === 0) console.log(`  ${n} ta kalit...`);
    } catch (e) {
      fail++;
      if (fail <= 5) console.error(`xato: ${e.message}`);
    }
  }
}
await src.close();
const size = await dst.dbSize();
console.log(`TAYYOR: ${n} ta kalit ko'chirildi (${JSON.stringify(stat)}), xato: ${fail}. Serverdagi Redis'da: ${size} ta kalit.`);
await dst.quit();

if (process.argv.includes('--switch')) {
  if (fail > 0) {
    console.log("Xatolar bor — .env o'zgartirilmadi.");
    process.exit(2);
  }
  copyFileSync(ENV, `${ENV}.bak-redis`);
  let lines = readFileSync(ENV, 'utf8').split(/\r?\n/);
  const old = lines.find((l) => /^REDIS_URL=/.test(l));
  lines = lines
    .filter((l) => !/^REDIS_URL=/.test(l) && !/^REDIS_URL_OLD=/.test(l))
    .map((l) => (/^(UPSTASH_REDIS_REST_URL|UPSTASH_REDIS_REST_TOKEN|KV_REST_API_URL|KV_REST_API_TOKEN)=/.test(l) ? `# ${l}` : l));
  if (old) lines.push(old.replace(/^REDIS_URL=/, 'REDIS_URL_OLD='));
  lines.push(`REDIS_URL="${DST_URL}"`);
  writeFileSync(ENV, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  console.log(".env yangilandi: bot endi serverdagi Redis'ni ishlatadi (eski nusxa: .env.bak-redis).");
}
