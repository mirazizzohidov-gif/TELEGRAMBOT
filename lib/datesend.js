// "📅 Sana bo'yicha yuborish" (admin, owner only): the products of one day — created in BITO that day
// ("🆕 Yangi") and / or back in stock that day by the stock scanner's history ("🔄 Qayta kelgan") — sent
// to ONE chosen channel / group, each as its own post (photo + caption + "🛒 Buyurtma berish").
//
// Long lists go in parts: the admin's button press sends as much as fits (~4 min), the 15-minute tick
// continues the rest. A progress message shows "📤 Yuborildi 12/40"; at the end a report (sent /
// skipped and why). What was sent is remembered per day + destination + product, so pressing again
// asks before sending the same products twice.

import { findProductsSince, formatPrice, getProductById, loadDiscounts, priceFor, productImage, productStock, toItem } from './bito.js';
import { contactPhone } from './caption.js';
import { ch2Item, ch2Label, ch2Settings, markupOf } from './channel2.js';
import { addTags, withTags } from './hashtags.js';
import { orderKb } from './orders.js';
import { recordPost } from './postreg.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { clock, errText, mapLimit } from './util.js';
import { sendPhotoMarked } from './watermark.js';

const DAY_MS = 86400000;
const POST_DELAY_MS = 3000; // a channel / group takes ~20 posts a minute
const SENT_TTL = 60 * 60 * 24 * 90;
const JOB_KEY = () => `${db.K.flag('datesend')}:job`;
const sentKey = (dest, day) => `${db.K.flag('datesend')}:sent:${dest}:${day}`;
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ---- dates (Asia/Tashkent) ----

export const dayStart = (day) => Date.parse(`${day}T00:00:00+05:00`);
export const showDay = (day) => day.split('-').reverse().join('.');

// "15.10.2026" (also "5.1.2026") -> "2026-10-15"; null when not a real date or in the future.
export function parseDay(text, now = clock.now()) {
  const m = String(text || '').trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (!m) return null;
  const day = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) return null;
  if (day > db.today(now)) return null;
  return day;
}

export const daysAgo = (n, now = clock.now()) => db.today(now - n * DAY_MS);

// ---- destinations: channels and groups where the bot is an admin ----

// [{ id, label, kind: 'ch1' | 'ch2' | 'group' | 'channel' }] — the main channels, the 2nd channel, the
// groups (stock group etc.) and channels the bot was made admin of (my_chat_member).
export async function dateTargets(s) {
  const out = [];
  const seen = new Set();
  const add = (id, label, kind) => {
    const k = String(id);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push({ id: k, label: String(label).slice(0, 40), kind });
  };
  for (const c of s.channels || []) add(c.id, `📢 ${c.title || c.id}`, 'ch1');
  if (s.channel2?.id) add(s.channel2.id, `📢 2-kanal: ${ch2Label(s.channel2)}`, 'ch2');
  for (const c of await db.listKnownChannels()) if (['administrator', 'creator'].includes(c.status)) add(c.id, `📢 ${c.title || c.id}`, 'channel');
  for (const g of await db.listGroups()) if (['administrator', 'creator'].includes(g.status)) add(g.id, `👥 ${g.title || g.id}`, 'group');
  return out;
}

// The bot may post there: an admin (channels: with "post messages"). Returns an error text or null.
export async function checkTarget(t) {
  try {
    const me = await tg('getMe');
    const m = await tg('getChatMember', { chat_id: t.id, user_id: me.id });
    if (m?.status === 'creator') return null;
    if (m?.status !== 'administrator') return `Bot ${t.label} da admin emas.`;
    if (m.can_post_messages === false) return `Bot ${t.label} da post yozish huquqi yo'q.`;
    return null;
  } catch (e) {
    return `Bot ${t.label} ga yoza olmaydi (${errText(e)}).`;
  }
}

// ---- products of the day ----

// { items, skipped: [{ sku, name, why }], counts: { new, back } } — items in stock now, with a photo
// and a price; a product both new and back that day counts as new.
export async function collectDay(day, kind, { maxPages = 30, s = null } = {}) {
  const from = dayStart(day);
  const to = from + DAY_MS;
  const found = new Map(); // product_id -> { p, kind }
  if (kind === 'new' || kind === 'both') {
    for (const p of await findProductsSince(from, maxPages)) {
      const at = Date.parse(p.created_at);
      if (at >= from && at < to) found.set(String(p._id), { p, kind: 'new' });
    }
  }
  if (kind === 'back' || kind === 'both') {
    const events = (await db.redis().lrange(db.K.stockDay(day), 0, -1).catch(() => [])) || [];
    const pids = [...new Set(events.filter((e) => e?.type === 'back').map((e) => String(e.pid)))].filter((pid) => !found.has(pid));
    const loaded = await mapLimit(pids, 4, (pid) => getProductById(pid).catch(() => null));
    pids.forEach((pid, i) => {
      if (loaded[i]) found.set(pid, { p: loaded[i], kind: 'back' });
    });
  }
  const discounts = await loadDiscounts();
  const items = [];
  const skipped = [];
  const counts = { new: 0, back: 0 };
  const list = [...found.values()].sort((a, b) => Date.parse(a.p.created_at) - Date.parse(b.p.created_at));
  const prices = await mapLimit(list, 4, ({ p }) => (productStock(p) > 0 && productImage(p) ? priceFor(p, discounts).catch(() => ({ price: 0 })) : null));
  list.forEach(({ p, kind: k }, i) => {
    const miss = (why) => skipped.push({ sku: String(p.sku), name: p.name, why });
    if (productStock(p) <= 0) return miss('qoldiq 0');
    if (!productImage(p)) return miss('rasmsiz');
    if (!(Number(prices[i]?.price) > 0)) return miss('narxsiz');
    items.push(toItem(p, prices[i], k === 'new' ? 'new' : 'restock', { ds_kind: k }));
    counts[k]++;
  });
  if (s) await addTags(items, s); // "#️⃣ Heshteglar"
  return { items, skipped, counts };
}

// ---- the post ----

// Format A: "🆕 YANGI MAHSULOT" / "🔄 YANA SOTUVDA!", name, SKU, price (<s>old</s> new), contact.
export function dateCaption(item, phone) {
  const discounted = Number(item.old_price) > Number(item.price);
  const price = discounted ? `<s>${formatPrice(item.old_price)}</s> ${formatPrice(item.price)}` : formatPrice(item.price);
  return (
    `${item.ds_kind === 'back' ? '🔄 <b>YANA SOTUVDA!</b>' : '🆕 <b>YANGI MAHSULOT</b>'}\n\n` +
    `🛍 Mahsulot nomi: ${esc(item.name)}\n` +
    `🔢 SKU: ${esc(item.sku)}\n` +
    `💰 Narxi: ${price} so'm\n\n` +
    `📞 Buyurtma uchun murojaat qiling: ${esc(contactPhone(phone))}`
  );
}

// The post for a destination: the 2nd channel gets the marked-up price and its own phone / button,
// every other one the BITO price and the main phone / button.
export function datePost(item, target, s) {
  const isCh2 = target.kind === 'ch2' || (s.channel2?.id && String(s.channel2.id) === String(target.id));
  const st = isCh2 ? ch2Settings(s) : s;
  const it = isCh2 ? ch2Item(item, markupOf(s)) : item;
  return { photo: it.image_url, caption: withTags(dateCaption(it, st.phone), item.tags), parse_mode: 'HTML', reply_markup: orderKb(st, it) };
}

// ---- "already sent" (day + destination + product) ----

export async function sentAlready(dest, day, items) {
  const h = (await db.redis().hgetall(sentKey(dest, day)).catch(() => null)) || {};
  return items.filter((i) => h[String(i.product_id)]);
}

async function markSent(dest, day, item) {
  await db.redis().hset(sentKey(dest, day), { [String(item.product_id)]: Date.now() });
  await db.redis().expire(sentKey(dest, day), SENT_TTL).catch(() => {});
}

// ---- the job ----

export const getJob = () => db.redis().get(JOB_KEY());
const saveJob = (j) => db.redis().set(JOB_KEY(), j, { ex: 60 * 60 * 24 * 2 });

// job: { chat, msg (progress message id), day, kind, target, items, skipped, i, sent, failed: [] }
export async function startJob(job) {
  await saveJob({ ...job, i: 0, sent: 0, failed: [], started: Date.now() });
}

const progressText = (j, done = false) =>
  `📤 ${showDay(j.day)} → ${esc(j.target.label)}\nYuborildi ${j.sent}/${j.items.length}` +
  (j.failed.length ? `, xato ${j.failed.length}` : '') +
  (done ? '' : `\n⏳ Davom etmoqda…${j.parts > 1 ? ' (vaqt tugasa keyingi tekshiruvda davom etadi)' : ''}`);

async function editProgress(j, done = false) {
  if (!j.msg) return;
  await tg('editMessageText', { chat_id: j.chat, message_id: j.msg, text: progressText(j, done), parse_mode: 'HTML' }).catch(() => {});
}

function finalReport(j) {
  const skipped = [...j.skipped, ...j.failed];
  const lines = [
    `✅ <b>Sana bo'yicha yuborish tugadi</b>`,
    `📅 ${showDay(j.day)} · ${j.kind === 'new' ? '🆕 Yangi' : j.kind === 'back' ? '🔄 Qayta kelgan' : '🆕+🔄 Ikkalasi'} → ${esc(j.target.label)}`,
    '',
    `📤 Yuborildi: ${j.sent}`,
    `⏭ O'tkazildi: ${skipped.length}`,
  ];
  const by = {};
  for (const x of skipped) (by[x.why] ||= []).push(x.sku);
  for (const [why, skus] of Object.entries(by)) lines.push(`   • ${esc(why)}: ${skus.length} (${esc(skus.slice(0, 15).join(', '))}${skus.length > 15 ? ', …' : ''})`);
  return lines.join('\n');
}

// Sends what fits before the deadline; returns { done, sent, left } or { busy } / { none }.
export async function runDateJob(s, { deadline = Date.now() + 240000 } = {}) {
  if (!db.hasRedis()) return { none: true };
  const job = await getJob();
  if (!job) return { none: true };
  if (!(await db.lock('datesend', 300))) return { busy: true };
  try {
    job.parts = (job.parts || 0) + 1;
    await editProgress(job);
    let stopped = false;
    while (job.i < job.items.length) {
      if (Date.now() + 20000 > deadline) {
        stopped = true;
        break;
      }
      const item = job.items[job.i];
      try {
        const m = await sendPhotoMarked({ chat_id: job.target.id, ...datePost(item, job.target, s) }, s, { deadline });
        await markSent(job.target.id, job.day, item);
        if (m?.message_id) await recordPost(item.product_id, { chat: job.target.id, mid: m.message_id, kind: 'date', dest: job.target, item }, s);
        job.sent++;
      } catch (e) {
        if (e.code === 429) {
          stopped = true; // Telegram asks to wait longer than this run has: the next run goes on
          break;
        }
        job.failed.push({ sku: item.sku, why: `xato: ${String(e.data?.description || errText(e)).slice(0, 80)}` });
      }
      job.i++;
      await saveJob(job);
      if (job.i % 3 === 0 || job.i === job.items.length) await editProgress(job);
      if (job.i < job.items.length) await clock.sleep(POST_DELAY_MS);
    }
    if (stopped) {
      await saveJob(job);
      await editProgress(job);
      return { done: false, sent: job.sent, left: job.items.length - job.i };
    }
    await db.redis().del(JOB_KEY());
    await editProgress(job, true);
    await tg('sendMessage', { chat_id: job.chat, text: finalReport(job), parse_mode: 'HTML' }).catch(() => {});
    await db.incrStat('date_sent', job.sent).catch(() => {});
    return { done: true, sent: job.sent, left: 0 };
  } finally {
    await db.unlock('datesend');
  }
}
