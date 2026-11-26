// "🛡 Server" (o'z serverimiz): holat (server, baza, tick), muammo bo'lsa Telegram xabari va bazaning
// kundalik to'liq zaxirasi — fayl egasining (CHANNEL2_OWNER_ID) Telegram'iga yuboriladi.
// server.js har 5 daqiqada srvTick() ni chaqiradi. Tiklash: node scripts/redis-restore.mjs <fayl>.
import { readFileSync, statfsSync } from 'node:fs';
import { freemem, totalmem, uptime as osUptime, loadavg } from 'node:os';
import { gzipSync } from 'node:zlib';
import { channel2Owner } from './channel2.js';
import { alert } from './health.js';
import * as db from './store.js';
import { errText } from './util.js';

const TZ = 5 * 3600000; // Toshkent
const LAST = () => `${db.K.flag('srv')}:backup_last`;
export const SRV_DEFAULTS = { backup_on: true, backup_at: '03:00', alerts_on: true, disk_pct: 85, mem_mb: 250, tick_min: 40 };

export const srvCfg = (s) => ({ ...SRV_DEFAULTS, ...(s?.srv || {}) });
const selfHosted = () => process.env.SELF_HOSTED === '1';

function memAvailable() {
  try {
    const m = readFileSync('/proc/meminfo', 'utf8').match(/MemAvailable:\s+(\d+)/);
    if (m) return Number(m[1]) * 1024;
  } catch {}
  return freemem();
}

function disk() {
  try {
    const st = statfsSync('/');
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { total, used: total - free, pct: total ? Math.round(((total - free) / total) * 100) : 0 };
  } catch {
    return null;
  }
}

async function raw(fn) {
  const r = db.redis();
  if (typeof r.run !== 'function') throw new Error("faqat serverdagi Redis (REDIS_URL) uchun");
  return r.run(fn);
}

async function redisInfo() {
  try {
    return await raw(async (c) => {
      const [keys, info] = await Promise.all([c.dbSize(), c.info('memory')]);
      const used = Number(String(info).match(/used_memory:(\d+)/)?.[1]) || null;
      const max = Number(String(info).match(/maxmemory:(\d+)/)?.[1]) || null;
      return { ok: true, keys, used, max, local: /127\.0\.0\.1|localhost/.test(process.env.REDIS_URL || '') };
    });
  } catch (e) {
    return { ok: false, error: errText(e) };
  }
}

export async function srvView(s) {
  const cfg = srvCfg(s);
  const [redis, health, last] = await Promise.all([
    redisInfo(),
    db.redis().hgetall(`${db.K.flag('health')}:state`).catch(() => ({})),
    db.redis().get(LAST()).catch(() => null),
  ]);
  const lastTick = Number(health?.last_tick_at) || null;
  return {
    ok: true,
    self_hosted: selfHosted(),
    cfg,
    owner: channel2Owner(),
    server: {
      uptime_s: Math.round(osUptime()),
      bot_uptime_s: Math.round(process.uptime()),
      mem_total: totalmem(),
      mem_avail: memAvailable(),
      load: loadavg().map((x) => Math.round(x * 100) / 100),
      disk: disk(),
      node: process.version,
    },
    redis,
    tick: { last_at: lastTick, last_ok_at: Number(health?.last_ok_at) || null, last_error: health?.last_error || null },
    backup: last || null,
  };
}

export async function srvSetCfg(body) {
  const s = await db.getSettings();
  const cur = srvCfg(s);
  const at = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.backup_at || '')) ? String(body.backup_at) : cur.backup_at;
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Math.round(Number(v)) : d);
  const next = {
    backup_on: body.backup_on === undefined ? cur.backup_on : Boolean(body.backup_on),
    backup_at: at,
    alerts_on: body.alerts_on === undefined ? cur.alerts_on : Boolean(body.alerts_on),
    disk_pct: num(body.disk_pct, 50, 98, cur.disk_pct),
    mem_mb: num(body.mem_mb, 50, 2000, cur.mem_mb),
    tick_min: num(body.tick_min, 20, 240, cur.tick_min),
  };
  await db.updateSettings({ srv: next });
  return { ok: true, message: '✅ Saqlandi', cfg: next };
}

// ---- zaxira ----

// barcha kalitlar -> JSON qatorlar (gzip). Qiymatlar o'zgarishsiz (string), TTL saqlanadi.
async function dumpAll() {
  return raw(async (c) => {
    const lines = [];
    let n = 0;
    const one = async (k) => {
      const [t, ttl] = await Promise.all([c.type(k), c.pTTL(k)]);
      let v;
      if (t === 'string') v = await c.get(k);
      else if (t === 'hash') v = await c.hGetAll(k);
      else if (t === 'list') v = await c.lRange(k, 0, -1);
      else if (t === 'set') v = await c.sMembers(k);
      else if (t === 'zset') v = await c.zRangeWithScores(k, 0, -1);
      else return;
      if (v === null || v === undefined) return;
      lines.push(JSON.stringify({ k, t, ttl: ttl > 0 ? ttl : -1, v }));
      n++;
    };
    for await (const batch of c.scanIterator({ COUNT: 500 })) {
      const keys = Array.isArray(batch) ? batch : [batch];
      for (let i = 0; i < keys.length; i += 100) await Promise.all(keys.slice(i, i + 100).map(one));
    }
    return { gz: gzipSync(Buffer.from(lines.join('\n'), 'utf8'), { level: 9 }), keys: n };
  });
}

async function sendDocument(chatId, buf, filename, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  form.append('parse_mode', 'HTML');
  form.append('document', new Blob([buf], { type: 'application/gzip' }), filename);
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(j.description || `HTTP ${r.status}`);
  return j.result;
}

export async function makeBackup(reason = 'auto') {
  const started = Date.now();
  const rec = { at: started, reason, ok: false };
  try {
    const { gz, keys } = await dumpAll();
    if (gz.length > 49 * 1024 * 1024) throw new Error(`fayl juda katta (${Math.round(gz.length / 1048576)} MB) — Telegram 50 MB gacha qabul qiladi`);
    const d = new Date(started + TZ).toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    const name = `mixbot-baza-${d}.jsonl.gz`;
    const cap =
      `🛡 <b>Baza zaxirasi</b> — ${keys} ta kalit, ${(gz.length / 1048576).toFixed(1)} MB\n` +
      `Navbatlar, sozlamalar, ulangan akkauntlar tokenlari.\n⚠️ Maxfiy fayl — hech kimga yubormang.\n` +
      `Tiklash: serverda <code>node scripts/redis-restore.mjs ${name}</code>`;
    await sendDocument(channel2Owner(), gz, name, cap);
    Object.assign(rec, { ok: true, keys, size: gz.length, ms: Date.now() - started });
    console.log(`srv backup: ${keys} kalit, ${Math.round(gz.length / 1024)} KB`);
  } catch (e) {
    rec.error = errText(e).slice(0, 300);
    console.error(`srv backup: ${rec.error}`);
  }
  await db.redis().set(LAST(), rec).catch(() => {});
  return rec;
}

export async function srvBackupNow() {
  if (!selfHosted()) return { ok: false, message: "Faqat o'z serverda ishlaydi" };
  if (!(await db.lock('srvbackup', 300))) return { ok: false, message: 'Zaxira allaqachon olinmoqda' };
  try {
    const r = await makeBackup('qo\'lda');
    return r.ok ? { ok: true, message: `✅ Yuborildi: ${r.keys} ta kalit, ${(r.size / 1048576).toFixed(1)} MB` } : { ok: false, message: `❌ ${r.error}` };
  } finally {
    await db.unlock('srvbackup');
  }
}

// ---- har 5 daqiqada (server.js) ----

export async function srvTick() {
  if (!selfHosted() || !db.hasRedis()) return;
  let s;
  try {
    s = await db.getSettings();
  } catch (e) {
    console.error(`srv: sozlamalar o'qilmadi: ${errText(e)}`);
    return;
  }
  const cfg = srvCfg(s);
  const now = Date.now();
  // kundalik zaxira: belgilangan vaqtdan keyin, kuniga bir marta
  if (cfg.backup_on) {
    const local = new Date(now + TZ);
    const [h, m] = cfg.backup_at.split(':').map(Number);
    const day = local.toISOString().slice(0, 10);
    if (local.getUTCHours() * 60 + local.getUTCMinutes() >= h * 60 + m && (await db.once(`srvbackup:${day}`, 2 * 86400).catch(() => false))) {
      const r = await makeBackup('auto');
      if (!r.ok && cfg.alerts_on) await alert('srvbackup', `Kundalik baza zaxirasi yuborilmadi: ${r.error}`, s).catch(() => {});
    }
  }
  if (!cfg.alerts_on) return;
  const dk = disk();
  if (dk && dk.pct >= cfg.disk_pct) await alert('srvdisk', `Server diski ${dk.pct}% to'ldi (${Math.round(dk.used / 1e9)} / ${Math.round(dk.total / 1e9)} GB).`, s).catch(() => {});
  const avail = memAvailable() / 1048576;
  if (avail < cfg.mem_mb) await alert('srvmem', `Serverda bo'sh xotira kam: ${Math.round(avail)} MB qoldi.`, s).catch(() => {});
  const ri = await redisInfo();
  if (ri.ok && ri.max && ri.used / ri.max > 0.85) await alert('srvredis', `Baza (Redis) ${Math.round((ri.used / ri.max) * 100)}% to'ldi.`, s).catch(() => {});
  const st = await db.redis().hgetall(`${db.K.flag('health')}:state`).catch(() => ({}));
  const last = Number(st?.last_tick_at) || 0;
  if (last && now - last > cfg.tick_min * 60000) await alert('srvtick', `${Math.round((now - last) / 60000)} daqiqadan beri tekshiruv (tick) ishlamadi.`, s).catch(() => {});
}
