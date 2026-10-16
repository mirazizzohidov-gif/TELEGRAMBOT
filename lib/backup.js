// "💾 Zaxira" (owner only): the bot's settings as a JSON file, and restoring them.
//
// IN the file: settings (channels, 2nd channel, limits, switches, phone / buttons, logo settings, story
// profile choice, templates …), helpers ("👥 Yordamchi adminlar"), known groups and channels, business
// connections (story profiles), the random blacklist, descriptions written by the admin, the own logo.
// NOT in it: queues, dedupe flags, caches, stats, history, post registry, stock data — and no tokens /
// secrets (env only; any settings key that looks like one is dropped).
//
// Daily at 03:00 Tashkent (backup_auto, default on): a backup is kept in Redis (last 7) and sent to the
// owner. Restoring: the owner sends a file -> a short diff -> "✅ Tiklash" -> the current state is backed
// up first, then the file is written.

import { channel2Owner } from './channel2.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { clock, errText } from './util.js';
import { getLogo } from './watermark.js';

export const FORMAT = 'bito-telegram-bot-backup';
export const VERSION = 1;
const KEEP = 7;
const MAX_FILE = 5 * 1024 * 1024;
const LIST = () => `${db.K.flag('backup')}:list`;
const LOGO_KEY = () => `${db.K.flag('wm')}:logo`;
const SECRET_LIKE = /token|secret|password|passwd|api[_-]?key|private/i;
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const HASHES = {
  helpers: () => db.K.helpers,
  groups: () => db.K.groups,
  known_channels: () => db.K.knownChannels,
  biz: () => db.K.biz,
  random_blacklist: () => db.K.randomBlacklist,
};
const LABEL = {
  settings: '⚙️ Sozlamalar',
  helpers: '👥 Yordamchilar',
  groups: '👥 Guruhlar',
  known_channels: '📢 Kanallar (bot admin)',
  biz: '📸 Istoriya profillari',
  random_blacklist: "🚫 Random qora ro'yxat",
  ai_desc_admin: "📝 O'zingiz yozgan tavsiflar",
  logo: '🖼 Logo',
};

const cleanSettings = (s) => Object.fromEntries(Object.entries(s || {}).filter(([k]) => !SECRET_LIKE.test(k)));

// The current state as a backup object.
export async function buildBackup({ reason = 'manual', now = clock.now() } = {}) {
  const r = db.redis();
  const data = { settings: cleanSettings((await r.get(db.K.settings)) || {}) };
  for (const [name, key] of Object.entries(HASHES)) data[name] = (await r.hgetall(key())) || {};
  const desc = (await r.hgetall(db.K.aiDesc)) || {};
  data.ai_desc_admin = Object.fromEntries(Object.entries(desc).filter(([, v]) => v?.by === 'admin'));
  const logo = await getLogo().catch(() => null);
  data.logo = logo ? logo.toString('base64') : null;
  return { format: FORMAT, version: VERSION, created_at: new Date(now).toISOString(), reason, data };
}

// Kept in Redis (newest first, the last 7).
export async function storeBackup(b) {
  await db.redis().lpush(LIST(), b);
  await db.redis().ltrim(LIST(), 0, KEEP - 1);
}

export async function listBackups() {
  return (await db.redis().lrange(LIST(), 0, KEEP - 1).catch(() => [])) || [];
}

const tashkentStamp = (iso) =>
  new Date(iso).toLocaleString('sv-SE', { timeZone: 'Asia/Tashkent', hour12: false }).slice(0, 16).replace(' ', '_').replace(':', '');

export const backupFileName = (b) => `bot-zaxira-${tashkentStamp(b.created_at)}.json`;

// The backup as a JSON document in a chat.
export async function sendBackup(chatId, b, caption, extra = {}) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('caption', caption);
  for (const [k, v] of Object.entries(extra)) form.append(k, String(v));
  form.append('document', new Blob([JSON.stringify(b, null, 2)], { type: 'application/json' }), backupFileName(b));
  return tg('sendDocument', form);
}

// A file from the admin -> { ok, backup } or { ok: false, error }.
export function parseBackup(text) {
  if (!text || text.length > MAX_FILE) return { ok: false, error: 'Fayl juda katta yoki bo\'sh.' };
  let b;
  try {
    b = JSON.parse(text);
  } catch {
    return { ok: false, error: "Bu JSON fayl emas — bot yuborgan zaxira faylini yuboring." };
  }
  if (b?.format !== FORMAT) return { ok: false, error: 'Bu bot zaxirasi emas (format boshqa).' };
  if (b.version !== VERSION) return { ok: false, error: `Zaxira versiyasi ${b.version} — bu bot faqat ${VERSION}-versiyani tiklaydi.` };
  const d = b.data;
  if (!d || typeof d !== 'object' || !d.settings || typeof d.settings !== 'object' || Array.isArray(d.settings)) {
    return { ok: false, error: "Zaxirada sozlamalar yo'q yoki buzilgan." };
  }
  for (const name of [...Object.keys(HASHES), 'ai_desc_admin']) {
    if (d[name] !== undefined && (typeof d[name] !== 'object' || d[name] === null || Array.isArray(d[name]))) {
      return { ok: false, error: `Zaxiradagi "${name}" bo'limi buzilgan.` };
    }
  }
  if (d.logo !== undefined && d.logo !== null && typeof d.logo !== 'string') return { ok: false, error: 'Zaxiradagi logo buzilgan.' };
  return { ok: true, backup: { ...b, data: { ...d, settings: cleanSettings(d.settings) } } };
}

const short = (v) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t === undefined ? '—' : t.length > 40 ? `${t.slice(0, 37)}…` : t;
};

// What restoring would change: short lines.
export function diffBackup(current, next) {
  const lines = [];
  const a = current.data.settings;
  const b = next.data.settings;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const changed = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (changed.length) {
    lines.push(`${LABEL.settings}: ${changed.length} ta o'zgaradi`);
    for (const k of changed.slice(0, 15)) lines.push(`   • ${k}: ${short(a[k])} → ${short(b[k])}`);
    if (changed.length > 15) lines.push(`   • … yana ${changed.length - 15} ta`);
  }
  for (const name of [...Object.keys(HASHES), 'ai_desc_admin']) {
    const x = current.data[name] || {};
    const y = next.data[name] || {};
    const add = Object.keys(y).filter((k) => !(k in x)).length;
    const del = Object.keys(x).filter((k) => !(k in y)).length;
    const mod = Object.keys(y).filter((k) => k in x && JSON.stringify(x[k]) !== JSON.stringify(y[k])).length;
    if (add || del || mod) lines.push(`${LABEL[name]}: ${[add && `+${add}`, del && `−${del}`, mod && `~${mod}`].filter(Boolean).join(', ')} (jami ${Object.keys(y).length})`);
  }
  if ((current.data.logo || null) !== (next.data.logo || null)) lines.push(`${LABEL.logo}: ${next.data.logo ? 'zaxiradagi logo' : 'standart "MIX PODAROK"'}`);
  return lines;
}

// Writes a (checked) backup: each part is replaced as a whole.
export async function applyBackup(b) {
  const r = db.redis();
  const d = b.data;
  await r.set(db.K.settings, cleanSettings(d.settings));
  for (const [name, key] of Object.entries(HASHES)) {
    if (d[name] === undefined) continue;
    await r.del(key());
    if (Object.keys(d[name]).length) await r.hset(key(), d[name]);
  }
  if (d.ai_desc_admin !== undefined) {
    // the admin's own descriptions come back; the AI's stay as they are
    const cur = (await r.hgetall(db.K.aiDesc)) || {};
    for (const [k, v] of Object.entries(cur)) if (v?.by === 'admin' && !(k in d.ai_desc_admin)) await r.hdel(db.K.aiDesc, k);
    if (Object.keys(d.ai_desc_admin).length) await r.hset(db.K.aiDesc, d.ai_desc_admin);
  }
  if (d.logo !== undefined) {
    if (d.logo) await r.set(LOGO_KEY(), d.logo);
    else await r.del(LOGO_KEY());
  }
}

const tashkentHHMM = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/^24/, '00');

// The tick: after 03:00 Tashkent, once a day — kept in Redis and sent to the owner (quietly).
export async function backupTick(s, { now = clock.now() } = {}) {
  if (s?.backup_auto === false || !db.hasRedis() || tashkentHHMM(now) < '03:00') return null;
  const day = db.today(now);
  if (!(await db.once(`backupday:${day}`, 60 * 60 * 30))) return null;
  try {
    const b = await buildBackup({ reason: 'daily', now });
    await storeBackup(b);
    await sendBackup(channel2Owner(), b, `💾 Kunlik zaxira — ${day}`, { disable_notification: true }).catch((e) =>
      console.error(`daily backup to the owner: ${errText(e)}`),
    );
    return { saved: true };
  } catch (e) {
    await db.clearFlag(`backupday:${day}`);
    console.error(`daily backup: ${errText(e)}`);
    return { error: errText(e) };
  }
}
