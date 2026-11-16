// "♻️ Qayta keldi" — omborga qaytgan (va «❌ Tugadi» guruhidan olingan) mahsulotlar ro'yxati dashboardda.
// Eski ishlarga tegmaydi: stock.js recordEvent('back') faqat logBack() ni qo'shimcha chaqiradi.
// Ro'yxatda `days` kun (standart 1) turadi; 30 kunlik qaytish tarixi «⚠️ tez tugaydi» belgisi uchun saqlanadi.
// settings.backlog = { days, daily_on, daily_at, freq_n }
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

export const BL_DEFAULTS = { days: 1, daily_on: true, daily_at: '20:00', freq_n: 3 };
export const blCfg = (s) => ({ ...BL_DEFAULTS, ...(s?.backlog || {}) });

const r = () => db.redis();
const LOG = () => db.K.flag('backlog'); // hash pid -> oxirgi qaytish yozuvi
const HIST = () => db.K.flag('backlog:hist'); // hash pid -> [qaytish vaqtlari, 30 kun]
const esc = (t) => String(t ?? '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]);
const DAY = 86400000;

// stock.js: mahsulot 0 -> >0 bo'ldi. Guruhdagi xabarlar o'chirilishidan OLDIN chaqiriladi (nechtasi borligini bilish uchun).
export async function logBack(pid, rec) {
  if (!db.hasRedis()) return;
  const msgs = (await r().hget(db.K.reportPid, String(pid)).catch(() => null)) || [];
  const now = Date.now();
  const hist = ((await r().hget(HIST(), String(pid)).catch(() => null)) || []).filter((t) => now - t < 30 * DAY);
  hist.push(now);
  await r().hset(HIST(), { [String(pid)]: hist.slice(-50) });
  await r().hset(LOG(), {
    [String(pid)]: {
      pid: String(pid),
      sku: rec.sku || '',
      name: rec.name || '',
      img: rec.img || '',
      cat: rec.catn || '',
      price: Number(rec.price) || 0,
      stock: Number(rec.stock) || 0,
      out_at: rec.out_at || null,
      out_approx: Boolean(rec.out_approx),
      back_at: rec.back_at || now,
      msgs: msgs.length, // guruhdagi «❌ TUGADI» xabarlari (o'chiriladi yoki «✅ QAYTA KELDI» bo'ladi)
    },
  });
}

async function current(s) {
  const c = blCfg(s);
  const now = Date.now();
  const all = (await r().hgetall(LOG()).catch(() => null)) || {};
  const hist = (await r().hgetall(HIST()).catch(() => null)) || {};
  const keep = [];
  for (const [pid, v] of Object.entries(all)) {
    if (!v || typeof v !== 'object') continue;
    if (now - Number(v.back_at || 0) > c.days * DAY) {
      await r().hdel(LOG(), pid).catch(() => {});
      continue;
    }
    const n30 = ((hist[pid] || []).filter((t) => now - t < 30 * DAY)).length;
    keep.push({ ...v, n30, freq: n30 >= c.freq_n });
  }
  // eski tarixni tozalash
  for (const [pid, h] of Object.entries(hist)) if (!(h || []).some((t) => now - t < 30 * DAY)) await r().hdel(HIST(), pid).catch(() => {});
  return keep.sort((a, b) => b.back_at - a.back_at);
}

// stock yozuvidan hozirgi qoldiq / narx (ro'yxat ko'rilayotgan paytdagi)
async function fresh(items) {
  if (!items.length) return items;
  const recs = await Promise.all(items.map((x) => r().hget(db.K.stock, x.pid).catch(() => null)));
  return items.map((x, i) => ({ ...x, stock: recs[i]?.stock ?? x.stock, price: recs[i]?.price || x.price }));
}

export async function blView(s) {
  const c = blCfg(s);
  const items = await fresh(await current(s));
  return { ok: true, cfg: c, items };
}

export async function blSetCfg(body = {}) {
  const s = await db.getSettings();
  const cur = blCfg(s);
  const days = [1, 3, 7].includes(Number(body.days)) ? Number(body.days) : cur.days;
  const at = /^\d{1,2}:\d{2}$/.test(String(body.daily_at || '')) ? String(body.daily_at).padStart(5, '0') : cur.daily_at;
  const next = { days, daily_on: body.daily_on === undefined ? cur.daily_on : Boolean(body.daily_on), daily_at: at, freq_n: Math.max(2, Math.min(10, Number(body.freq_n) || cur.freq_n)) };
  await db.updateSettings({ backlog: next });
  return { ok: true, message: `💾 Saqlandi · ro'yxatda ${days} kun` };
}

// «📢 Kanalga post»: mavjud «🔄 Qayta keldi» avto-post navbatiga qo'shadi (o'sha qoidalar bilan)
export async function blPost(pid, s) {
  const rec = await r().hget(db.K.stock, String(pid)).catch(() => null);
  if (!rec) return { ok: false, message: '❌ Mahsulot topilmadi' };
  if (!(rec.stock > 0)) return { ok: false, message: '❌ Hozir omborda yo\'q' };
  const { enqueueRestock, recentlyPosted } = await import('./restock.js');
  if (await recentlyPosted(pid).catch(() => false)) return { ok: false, message: "ℹ️ Bu mahsulot yaqinda «Yana sotuvda» bo'lib chiqqan" };
  await enqueueRestock(String(pid), rec, s);
  await r().hset(LOG(), { [String(pid)]: { ...((await r().hget(LOG(), String(pid))) || {}), posted_at: Date.now() } }).catch(() => {});
  return { ok: true, message: '📢 Navbatga qo\'shildi — kanalga «🔄 Yana sotuvda!» bo\'lib chiqadi (tunda emas)' };
}

// cron: kunlik xulosa hisobot guruhiga (daily_at dan keyin, kuniga 1 marta)
export async function blTick(s, now = Date.now()) {
  const c = blCfg(s);
  if (!c.daily_on || !db.hasRedis()) return null;
  const [hh, mm] = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now)).split(':').map(Number);
  const [ah, am] = c.daily_at.split(':').map(Number);
  if ((hh % 24) * 60 + mm < ah * 60 + am) return null;
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent' }).format(new Date(now));
  const chat = String(s.stock_report_group || s.stock_group || '');
  if (!chat) return null;
  const items = (await current(s)).filter((x) => now - x.back_at < DAY);
  if (!(await db.once(`backlog:daily:${ymd}`, 2 * DAY))) return null;
  if (!items.length) return null;
  const lines = items.slice(0, 40).map((x) => `• ${esc(x.name)} (SKU ${esc(x.sku)})${x.freq ? ` — ⚠️ 30 kunda ${x.n30} marta tugadi` : ''}`);
  const freq = items.filter((x) => x.freq).length;
  const text = `♻️ <b>Bugun qayta keldi: ${items.length} ta mahsulot</b>\n\n${lines.join('\n')}${items.length > 40 ? `\n… va yana ${items.length - 40} ta` : ''}${freq ? `\n\n⚠️ ${freq} tasi tez-tez tugaydi — ko'proq olib kelish kerak.` : ''}`;
  await tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML' }).catch((e) => console.error(`backlog daily: ${errText(e)}`));
  return { sent: items.length };
}
