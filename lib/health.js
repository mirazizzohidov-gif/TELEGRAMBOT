// "🩺 Holat": is the bot working?
// - Every day after 08:55 (Tashkent) the admins get "🩺 Kunlik holat" for yesterday: posts (1st / 2nd
//   channel), stories per profile (✅ / ❌), new / discount / back in stock, "❌ SOTILDI" marks, price
//   updates, errors (count + the last 3), the last good tick, BITO's answer time.
// - "⚠️" at once (the same warning at most once an hour): no tick for 45 minutes (seen by the next one),
//   3 story failures in a row on one profile, BITO failing 3 ticks in a row.
// - Admin panel "🩺 Holat" shows the same for today, now.
// settings.health === false switches the daily message and the warnings off.

import { bitoStats, resetBitoStats } from './bito.js';
import { notifyAdmins } from './report.js';
import * as db from './store.js';
import { clock, errText } from './util.js';

const TICK_GAP_MS = 45 * 60 * 1000;
const STREAK = 3;
const KEY = () => `${db.K.flag('health')}:state`; // hash: last_tick_at, last_ok_at, bito_ms, bito_streak, story:<id>
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const hhmm = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }) : '—');
const showDay = (day) => day.split('-').reverse().join('.');

async function state() {
  return (await db.redis().hgetall(KEY()).catch(() => null)) || {};
}
const setState = (o) => db.redis().hset(KEY(), o);

// A warning to the admins, the same one at most once an hour.
export async function alert(key, text, s) {
  if (s?.health === false || !db.hasRedis()) return false;
  if (!(await db.once(`alert:${key}`, 60 * 60).catch(() => false))) return false;
  await db.logError(`⚠️ ${text}`).catch(() => {});
  await notifyAdmins({ text: `⚠️ ${text}` });
  return true;
}

// Story result per profile: 3 failures in a row -> "⚠️".
export async function recordStoryResult(p, ok, error, s) {
  const field = `story:${p.id}`;
  if (ok) return setState({ [field]: 0 });
  const n = await db.redis().hincrby(KEY(), field, 1);
  if (n >= STREAK) await alert(`story:${p.id}`, `Istoriya ${p.label} ga ketma-ket ${n} marta yuborilmadi: ${error}`, s);
  return n;
}

// Start of a tick: a gap of 45+ minutes since the last one -> "⚠️"; BITO counters from zero.
export async function beforeTick(s, now = Date.now()) {
  resetBitoStats();
  if (!db.hasRedis()) return;
  const st = await state();
  const last = Number(st.last_tick_at) || 0;
  if (last && now - last > TICK_GAP_MS) {
    await alert('tickgap', `${Math.round((now - last) / 60000)} daqiqa davomida tekshiruv (tick) bo'lmadi — oxirgisi ${hhmm(last)}. Hozir qayta ishladi; cron (har 15 daqiqa) ni tekshiring.`, s);
  }
}

// End of a tick: when it ran, BITO's answer time, BITO failing 3 ticks in a row -> "⚠️".
export async function afterTick(s, { ok = true, error = null, now = Date.now() } = {}) {
  if (!db.hasRedis()) return;
  const st = await state();
  const ms = bitoStats.calls ? Math.round(bitoStats.ms / bitoStats.calls) : null;
  const bitoBad = bitoStats.down > 0;
  const streak = bitoBad ? (Number(st.bito_streak) || 0) + 1 : bitoStats.calls ? 0 : Number(st.bito_streak) || 0;
  await setState({
    last_tick_at: now,
    ...(ok ? { last_ok_at: now } : { last_error: String(error || '').slice(0, 300) }),
    ...(ms !== null ? { bito_ms: ms } : {}),
    bito_streak: streak,
  });
  if (bitoStats.calls) {
    await db.incrStat('bito_calls', bitoStats.calls).catch(() => {});
    await db.incrStat('bito_ms', bitoStats.ms).catch(() => {});
  }
  if (bitoStats.down) await db.incrStat('bito_down', bitoStats.down).catch(() => {});
  if (!ok) await db.logError(`tick: ${error}`).catch(() => {});
  if (streak >= STREAK) await alert('bito', `BITO ${streak} ta tekshiruvda ketma-ket xato qaytardi: ${bitoStats.last_error || 'javob yo\'q'}`, s);
}

// The report (yesterday for the daily message, today for "🩺 Holat").
export async function healthReport(s, { day = db.today(), title = '🩺 <b>Kunlik holat</b>', now = Date.now() } = {}) {
  const [st, h, biz, errs] = await Promise.all([db.getStats(day), state(), db.listBiz(), db.redis().lrange(db.K.errors, 0, 2).catch(() => [])]);
  const n = (k) => Number(st[k]) || 0;
  const profiles = db.storyProfiles(s, biz);
  const ch1 = n('posted') + n('discount_posted') + n('restock_posted') + n('restock_auto_posted') + n('random_album');
  const avg = n('bito_calls') ? Math.round(n('bito_ms') / n('bito_calls')) : null;
  const lastOk = Number(h.last_ok_at) || 0;
  const lines = [
    `${title} — ${showDay(day)}`,
    '',
    `📢 Postlar: 1-kanal ${ch1}${s.channel2?.id ? `, 2-kanal ${n('ch2_posted')}` : ''}${n('helper_posts') ? `, yordamchilar ${n('helper_posts')}` : ''}${n('date_sent') ? `, sana bo'yicha ${n('date_sent')}` : ''}`,
    `📸 Istoriya: ${profiles.length ? profiles.map((p) => `${esc(p.label)} ✅ ${n(`stories:${p.id}`) + n(`discount_stories:${p.id}`)} / ❌ ${n(`stories_failed:${p.id}`) + n(`discount_stories_failed:${p.id}`)}`).join(', ') : "profil yo'q"}`,
    `🆕 Yangi mahsulot: ${n('posted')} · 🔥 Chegirma: ${n('discount_posted')} · 🔄 Qayta keldi: ${n('restock_auto_posted') + n('restock_posted')}`,
    `❌ Sotildi belgisi: ${n('sold_marked')}${n('sold_unmarked') ? ` (qaytarildi ${n('sold_unmarked')})` : ''} · 💲 Narx yangilandi: ${n('price_updated')} post`,
    `❗ Xatolar: ${n('failed') + n('ch2_failed')}`,
    ...errs.map((e) => `   • ${esc(String(e).replace(/^\S+Z /, '').slice(0, 160))}`),
    `⏱ Oxirgi muvaffaqiyatli tekshiruv: ${hhmm(lastOk)}${lastOk ? ` (${Math.round((now - lastOk) / 60000)} daqiqa oldin)` : ''}${Number(h.last_tick_at) > lastOk ? ` — oxirgisi xato: ${esc(h.last_error || '')}` : ''}`,
    `🌐 BITO javobi: ${avg !== null ? `o'rtacha ${avg} ms` : "ma'lumot yo'q"}${h.bito_ms ? `, oxirgi tekshiruvda ${h.bito_ms} ms` : ''}${n('bito_down') ? `, xato ${n('bito_down')}` : ''}${Number(h.bito_streak) ? ` · ketma-ket xato: ${h.bito_streak}` : ''}`,
  ];
  return lines.join('\n');
}

const tashkentHHMM = (ms) =>
  new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/^24/, '00');

// After 08:55 Tashkent, once a day: yesterday's "🩺 Kunlik holat" to the admins.
export async function dailyHealth(s, { now = clock.now() } = {}) {
  if (s?.health === false || !db.hasRedis() || tashkentHHMM(now) < '08:55') return false;
  const today = db.today(now);
  if (!(await db.once(`healthday:${today}`, 60 * 60 * 30))) return false;
  try {
    const text = await healthReport(s, { day: db.today(now - 86400000), now });
    await notifyAdmins({ text, parse_mode: 'HTML' });
    return true;
  } catch (e) {
    await db.clearFlag(`healthday:${today}`);
    console.error(`daily health: ${errText(e)}`);
    return false;
  }
}
