// "📦 Ombor guruhi": stock history, out-of-stock / back-in-stock alerts, the daily list and the group
// commands (/tugagan, /kam, /sku, /bugun). Every message to the group carries the product photo.
import { categoryFields, findBySku, findPrice, formatPrice, getAllCategories, getProductsPage, imageUrl, productCategory, productImage, productStock } from './bito.js';
import { enqueueRestock } from './restock.js';
import { hasWaiters, notifyWaiters } from './waitlist.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { chunk, clock, errText, mapLimit } from './util.js';

const PAGE = 30; // BITO page size
const LIST_PAGE = 10; // one album per page in the group
const LOW_INDEX_MAX = 100; // products with 0 < stock <= this are indexed for /kam
const UPDATED_PAGES = 2; // newest products read every tick (BITO ignores sort by updated_at: these are the newest created)
const ALERTS_PER_TICK = 10;

export const GROUP_BUTTONS = {
  out: '❌ Tugaganlar',
  low: '⚠️ Kam qolganlar',
  today: '📅 Bugun tugaganlar',
  sku: '🔎 SKU qidirish',
  cats: '📂 Kategoriyalar',
  search: '🔎 Qidirish',
  stats: '📊 Kategoriya statistikasi',
};

export const GROUP_KEYBOARD = {
  keyboard: [
    [{ text: GROUP_BUTTONS.out }, { text: GROUP_BUTTONS.low }],
    [{ text: GROUP_BUTTONS.today }, { text: GROUP_BUTTONS.cats }],
    [{ text: GROUP_BUTTONS.stats }],
    [{ text: GROUP_BUTTONS.search }, { text: GROUP_BUTTONS.sku }],
  ],
  is_persistent: true,
  resize_keyboard: true,
};

export const GROUP_COMMANDS = [
  { command: 'tugagan', description: 'Tugagan mahsulotlar' },
  { command: 'kam', description: 'Kam qolgan mahsulotlar' },
  { command: 'bugun', description: 'Bugun tugagan va qayta kelganlar' },
  { command: 'sku', description: 'Mahsulotni SKU bo\'yicha topish: /sku 3147' },
  { command: 'kategoriya', description: 'Kategoriyalar' },
  { command: 'kategoriyalar', description: 'Kategoriya statistikasi' },
  { command: 'qidir', description: 'Qidirish: /qidir blaknot' },
];

const SKU_PROMPT = '🔎 SKU raqamini shu xabarga javob qilib yozing:';
const SEARCH_PROMPT = '🔎 Mahsulot nomi (qismi), SKU yoki shtrix-kodini shu xabarga javob qilib yozing:';

// Progress messages are edited at most this often (Telegram limits). Tests set 0.
export const stockConfig = { progressEveryMs: 3000 };

// ---- dates (Asia/Tashkent) ----

function parts(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Tashkent',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return p;
}

export const fmtDateTime = (ms) => {
  const p = parts(ms);
  return `${p.day}.${p.month}.${p.year} ${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
};
export const fmtDay = (ms) => {
  const p = parts(ms);
  return `${p.day}.${p.month}.${p.year}`;
};
const nowHHMM = (ms = Date.now()) => {
  const p = parts(ms);
  return `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
};

// "Tugagan sana": exact when the bot saw the drop, "~dd.mm.yyyy" (BITO updated_at) when it was
// already 0 before the bot started watching.
export function outDateText(r) {
  if (!r?.out_at) return "noma'lum";
  return r.out_approx ? `~${fmtDay(r.out_at)}` : fmtDateTime(r.out_at);
}

const priceText = (r) => (r.price > 0 ? `${formatPrice(r.price)} so'm` : "noma'lum");

// ---- captions ----

export const outAlertCaption = (r) =>
  ['❌ TUGADI', `🛍 ${r.name}`, `🔢 SKU: ${r.sku}`, `💰 Narxi: ${priceText(r)}`, '📦 Qoldiq: 0', `📅 Tugagan sana: ${outDateText(r)}`].join('\n');

export const backAlertCaption = (r) =>
  ['✅ QAYTA KELDI', `🛍 ${r.name}`, `🔢 SKU: ${r.sku}`, `💰 Narxi: ${priceText(r)}`, `📦 Qoldiq: ${r.stock}`, `📅 Sana: ${fmtDateTime(r.back_at || Date.now())}`].join('\n');

export const outListCaption = (r) =>
  [`🛍 ${r.name}`, `🔢 SKU: ${r.sku}`, `💰 Narxi: ${priceText(r)}`, '📦 Qoldiq: 0', `📅 Tugagan sana: ${outDateText(r)}`].join('\n');

export const lowListCaption = (r) => [`🛍 ${r.name}`, `🔢 SKU: ${r.sku}`, `💰 Narxi: ${priceText(r)}`, `⚠️ Qoldiq: ${r.stock}`].join('\n');

export function cardCaption(r) {
  const lines = [`🛍 ${r.name}`, `🔢 SKU: ${r.sku}`, `💰 Narxi: ${priceText(r)}`, `📦 Qoldiq: ${r.stock}`];
  if (r.stock <= 0) lines.push(`📅 Tugagan sana: ${outDateText(r)}`);
  return lines.join('\n');
}

// ---- stock history ----

const maxLine = (p, field) =>
  Math.max(0, ...(Array.isArray(p.organizations) ? p.organizations : []).map((o) => Number(o[field]) || 0));

async function updateIndexes(pid, r) {
  if (r.stock <= 0) {
    await db.redis().hset(db.K.stockOut, { [pid]: { at: r.out_at || null, approx: Boolean(r.out_approx) } });
    await db.redis().hdel(db.K.stockLow, pid);
  } else {
    await db.redis().hdel(db.K.stockOut, pid);
    if (r.stock <= LOW_INDEX_MAX) {
      await db.redis().hset(db.K.stockLow, { [pid]: { stock: r.stock, red: r.red || 0, yellow: r.yellow || 0 } });
    } else {
      await db.redis().hdel(db.K.stockLow, pid);
    }
  }
}

// Where each kind of stock message goes: its own group when the admin chose one ("📦 Ombor guruhi" →
// "❌ Tugadi xabarlari" / "✅ Qayta keldi xabarlari" / "📋 Hisobot"), otherwise the main stock group.
export const STOCK_ROUTES = { out: 'stock_out_group', back: 'stock_back_group', report: 'stock_report_group' };
export const routeGroup = (s, kind) => String(s[STOCK_ROUTES[kind]] || s.stock_group || '');
// Every group the bot works in for the stock: commands and list buttons work in all of them.
export const stockGroups = (s) => [...new Set([s.stock_group, ...Object.values(STOCK_ROUTES).map((f) => s[f])].filter(Boolean).map(String))];
const isStockGroup = (s, chatId) => stockGroups(s).includes(String(chatId));

async function recordEvent(type, pid, r, s, { autopost = false } = {}) {
  const day = db.today();
  await db.redis().rpush(db.K.stockDay(day), { type, pid, at: Date.now() });
  await db.redis().expire(db.K.stockDay(day), 60 * 60 * 24 * 3);
  if (routeGroup(s, type) && s.stock_alerts) {
    await db.redis().rpush(db.K.stockAlerts, { type, pid });
  }
  console.log(`stock ${type}: ${r.sku} ${r.name} (${pid})`);
  if (type === 'back' && autopost) await enqueueRestock(pid, r, s).catch((e) => console.error(`restock enqueue ${r.sku}: ${errText(e)}`));
  // Customers waiting for it ("🔔 Kelganda xabar ber"): told on every real return, whatever found it.
  if (type === 'back') await notifyWaiters(pid, s).catch((e) => console.error(`waitlist ${r.sku}: ${errText(e)}`));
}

// Only sellable products count (is_product, not archived / deleted).
export const isTradable = (p) => p && p.is_product !== false && !p.is_archived && !p.is_deleted && !p.completely_deleted;

async function dropFromIndexes(pid) {
  await db.redis().hdel(db.K.stockOut, pid);
  await db.redis().hdel(db.K.stockLow, pid);
}

// Remembers a product's stock. A drop >0 -> 0 ("out") or a rise 0 -> >0 ("back") is recorded once
// with the time; a product first seen at 0 gets BITO updated_at as an approximate out date.
// passId: the catalog pass that saw it (to drop products that disappeared from BITO).
// opts.autopost: a scanner run (not a search / SKU card / category refresh) after a full pass — a real
// "back" is then queued for the channel / story auto-post.
export async function observeProduct(p, s, passId = null, opts = {}) {
  const pid = String(p._id);
  if (!isTradable(p)) {
    await dropFromIndexes(pid);
    return null;
  }
  const stock = productStock(p);
  if (passId && stock <= LOW_INDEX_MAX) {
    await db.redis().hset(db.K.stockPassSeen, { [pid]: passId });
  }
  const base = {
    sku: String(p.sku ?? ''),
    name: p.name,
    img: imageUrl(productImage(p)),
    red: maxLine(p, 'red_line'),
    yellow: maxLine(p, 'yellow_line'),
    cat: productCategory(p)?.id || null,
    catn: productCategory(p)?.name || null,
  };
  const rec = await db.redis().hget(db.K.stock, pid);
  if (!rec) {
    const r = { ...base, stock, v: 0, seen_at: Date.now() };
    if (stock <= 0) {
      r.out_at = Date.parse(p.updated_at) || null;
      r.out_approx = true;
    }
    await db.redis().hset(db.K.stock, { [pid]: r });
    await updateIndexes(pid, r);
    return null;
  }
  let type = null;
  const r = { ...rec, ...base, stock };
  if (rec.stock > 0 && stock <= 0) {
    type = 'out';
    r.out_at = Date.now();
    r.out_approx = false;
  } else if (rec.stock <= 0 && stock > 0) {
    type = 'back';
    r.back_at = Date.now();
  }
  if (type) {
    r.v = (rec.v || 0) + 1;
    // Two jobs seeing the same change at once: only one records the event.
    if (!(await db.once(`stockev:${pid}:${r.v}:${type}`, 60 * 60 * 24 * 7))) type = null;
  }
  const changed = type || rec.stock !== stock || rec.name !== base.name || rec.img !== base.img || rec.sku !== base.sku || rec.red !== base.red || rec.yellow !== base.yellow || rec.cat !== base.cat || rec.catn !== base.catn;
  if (changed) {
    await db.redis().hset(db.K.stock, { [pid]: r });
    await updateIndexes(pid, r);
  }
  if (type) await recordEvent(type, pid, r, s, opts);
  return type;
}

export async function observeMany(products, s, passId = null, opts = {}) {
  const events = await mapLimit(products, 8, (p) =>
    observeProduct(p, s, passId, opts).catch((e) => {
      console.error(`stock observe ${p?._id}: ${errText(e)}`);
      return null;
    }),
  );
  return { seen: products.length, out: events.filter((e) => e === 'out').length, back: events.filter((e) => e === 'back').length };
}

// Price for a record (list price, cached by BITO layer); stored back for lists.
async function withPrice(pid, r) {
  if (r.price > 0) return r;
  const price = await findPrice(pid).catch(() => null);
  if (price > 0) {
    const next = { ...r, price };
    await db.redis().hset(db.K.stock, { [pid]: next });
    return next;
  }
  return r;
}

const getRecord = (pid) => db.redis().hget(db.K.stock, String(pid));

// ---- sending to the group (always with photos) ----

async function sendPhotoOrText(chatId, r, caption, extra = {}) {
  if (r.img) {
    try {
      return await tg('sendPhoto', { chat_id: chatId, photo: r.img, caption, ...extra });
    } catch (e) {
      console.error(`stock photo failed for ${r.sku}: ${errText(e)}`);
    }
  }
  return tg('sendMessage', { chat_id: chatId, text: `🖼 (rasm yo'q)\n${caption}`, ...extra });
}

// Albums of up to 10; products without a photo are listed in one text message.
async function sendAlbumList(chatId, records, captionFn) {
  const withImg = records.filter((r) => r.img);
  const noImg = records.filter((r) => !r.img);
  for (const group of chunk(withImg, 10)) {
    if (group.length === 1) {
      await sendPhotoOrText(chatId, group[0], captionFn(group[0]));
    } else {
      try {
        await tg('sendMediaGroup', {
          chat_id: chatId,
          media: group.map((r) => ({ type: 'photo', media: r.img, caption: captionFn(r) })),
        });
      } catch (e) {
        console.error(`stock album failed: ${errText(e)} — sending one by one`);
        for (const r of group) await sendPhotoOrText(chatId, r, captionFn(r));
      }
    }
  }
  if (noImg.length) {
    await tg('sendMessage', { chat_id: chatId, text: `🖼 Rasmsiz:\n\n${noImg.map(captionFn).join('\n\n')}` });
  }
}

export async function sendAlerts(s, { deadline = Date.now() + 60000 } = {}) {
  let sent = 0;
  if (!stockGroups(s).length) return sent;
  for (let i = 0; i < ALERTS_PER_TICK && Date.now() + 10000 < deadline; i++) {
    const ev = await db.redis().lpop(db.K.stockAlerts);
    if (!ev) break;
    const chat = routeGroup(s, ev.type); // "❌ TUGADI" and "✅ QAYTA KELDI" may go to different groups
    if (!chat) continue;
    const rec = await getRecord(ev.pid);
    if (!rec) continue;
    const r = await withPrice(ev.pid, rec);
    try {
      await sendPhotoOrText(chat, r, ev.type === 'out' ? outAlertCaption(r) : backAlertCaption(r));
      sent++;
    } catch (e) {
      console.error(`stock alert to group failed: ${errText(e)}`);
    }
    await clock.sleep(1000);
  }
  return sent;
}

// ---- lists ----

export async function outRecords() {
  const idx = (await db.redis().hgetall(db.K.stockOut)) || {};
  return Object.entries(idx)
    .map(([pid, v]) => ({ pid, at: Number(v?.at) || 0 }))
    .sort((a, b) => b.at - a.at);
}

export async function lowRecords(s) {
  const threshold = db.limit(s, 'low_stock_threshold');
  const idx = (await db.redis().hgetall(db.K.stockLow)) || {};
  return Object.entries(idx)
    .filter(([, v]) => v && v.stock > 0 && (v.stock <= threshold || (v.red > 0 && v.stock <= v.red) || (v.yellow > 0 && v.stock <= v.yellow)))
    .map(([pid, v]) => ({ pid, stock: v.stock }))
    .sort((a, b) => a.stock - b.stock);
}

async function loadRecords(entries) {
  const rows = await mapLimit(entries, 5, async (e) => {
    const r = await getRecord(e.pid);
    return r ? withPrice(e.pid, r) : null;
  });
  return rows.filter(Boolean);
}

const pager = (kind, page, pages) =>
  page + 1 < pages ? { reply_markup: { inline_keyboard: [[{ text: '➡️ Keyingi', callback_data: `st:${kind}:${page + 1}` }]] } } : {};

// ---- full out-of-stock list ----

const TEXT_LIMIT = 3900; // Telegram allows 4096 characters per message
const PHOTO_BATCH = 50; // photos per "➡️ Keyingi 50 ta rasm"
const ALBUM_PAUSE_MS = 2500;

// Splits lines into messages under the Telegram limit.
export function splitMessages(lines, limit = TEXT_LIMIT) {
  const out = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + 1 + line.length > limit) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line.slice(0, limit);
  }
  if (cur) out.push(cur);
  return out;
}

async function allOutRecords() {
  const idx = await outRecords();
  const rows = await mapLimit(idx, 8, async (e) => {
    const r = await getRecord(e.pid);
    return r ? { ...r, pid: e.pid } : null;
  });
  return rows.filter(Boolean);
}

// Photos (albums of 10, 2-3 s apart) of out-of-stock products from `offset`; 50 per call, then a
// "➡️ Keyingi 50 ta rasm" button. Products without a photo are only in the text list.
export async function sendOutPhotos(chatId, offset = 0, records = null) {
  const withImg = (records || (await allOutRecords())).filter((r) => r.img);
  const batch = withImg.slice(offset, offset + PHOTO_BATCH);
  if (!batch.length) return 0;
  const priced = await mapLimit(batch, 6, (r) => withPrice(r.pid, r));
  const groups = chunk(priced, 10);
  for (let n = 0; n < groups.length; n++) {
    if (n) await clock.sleep(ALBUM_PAUSE_MS);
    await sendAlbumList(chatId, groups[n], outListCaption);
  }
  const shown = offset + batch.length;
  if (shown < withImg.length) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `📸 Rasmlar: ${offset + 1}–${shown} / ${withImg.length}`,
      reply_markup: { inline_keyboard: [[{ text: `➡️ Keyingi ${Math.min(PHOTO_BATCH, withImg.length - shown)} ta rasm`, callback_data: `st:outp:${shown}` }]] },
    });
  }
  return batch.length;
}

// "📋 Tugagan mahsulotlar: N ta (yangilangan: …)", the full text list (split by the 4096 limit),
// then the photos.
// partial (scan state): the pass has not finished yet — text list only, marked "to'liq emas".
export async function sendFullOutList(chatId, { header, partial } = {}) {
  const scan = await getScan();
  const records = await allOutRecords();
  const when = partial ? partialMark(partial) : `yangilangan: ${scan.last_full_at ? fmtDateTime(scan.last_full_at) : fmtDateTime(Date.now())}`;
  if (header) await tg('sendMessage', { chat_id: chatId, text: header });
  if (!records.length) {
    if (partial) return null; // nothing found yet — the progress message tells the state
    return tg('sendMessage', { chat_id: chatId, text: `📋 Tugagan mahsulotlar: 0 ta (${when})\n✅ Tugagan mahsulot yo'q.` });
  }
  const lines = [`📋 Tugagan mahsulotlar: ${records.length} ta (${when})`, ''];
  records.forEach((r, i) => lines.push(`${i + 1}. ${r.name} — SKU ${r.sku} — ${outDateText(r)}${r.img ? '' : ' (rasmsiz)'}`));
  for (const text of splitMessages(lines)) {
    await tg('sendMessage', { chat_id: chatId, text });
  }
  if (!partial) await sendOutPhotos(chatId, 0, records);
  return records.length;
}

export async function sendLowList(chatId, s, page = 0) {
  const all = await lowRecords(s);
  const threshold = db.limit(s, 'low_stock_threshold');
  if (!all.length) return tg('sendMessage', { chat_id: chatId, text: `✅ Kam qolgan mahsulot yo'q (chegara: ${threshold} dona).` });
  const pages = Math.ceil(all.length / LIST_PAGE);
  const p = Math.min(page, pages - 1);
  const records = await loadRecords(all.slice(p * LIST_PAGE, (p + 1) * LIST_PAGE));
  await sendAlbumList(chatId, records, lowListCaption);
  return tg('sendMessage', {
    chat_id: chatId,
    text: `⚠️ Kam qolganlar (≤ ${threshold} dona yoki BITO chegarasi): ${all.length} ta · ${p + 1}/${pages}-sahifa`,
    ...pager('low', p, pages),
  });
}

export async function sendToday(chatId, page = 0) {
  const events = ((await db.redis().lrange(db.K.stockDay(db.today()), 0, -1)) || []).reverse();
  if (!events.length) return tg('sendMessage', { chat_id: chatId, text: "📅 Bugun tugagan yoki qayta kelgan mahsulot yo'q." });
  const pages = Math.ceil(events.length / LIST_PAGE);
  const p = Math.min(page, pages - 1);
  const slice = events.slice(p * LIST_PAGE, (p + 1) * LIST_PAGE);
  const rows = (
    await mapLimit(slice, 5, async (ev) => {
      const r = await getRecord(ev.pid);
      return r ? { ...(await withPrice(ev.pid, r)), _type: ev.type, _at: ev.at } : null;
    })
  ).filter(Boolean);
  await sendAlbumList(chatId, rows, (r) =>
    r._type === 'out' ? outAlertCaption({ ...r, out_at: r._at, out_approx: false }) : backAlertCaption({ ...r, back_at: r._at }),
  );
  const out = events.filter((e) => e.type === 'out').length;
  return tg('sendMessage', {
    chat_id: chatId,
    text: `📅 Bugun: tugagan ${out} ta, qayta kelgan ${events.length - out} ta · ${p + 1}/${pages}-sahifa`,
    ...pager('day', p, pages),
  });
}

export async function sendSkuCard(chatId, sku) {
  const p = await findBySku(String(sku), { fresh: true });
  if (!p) return tg('sendMessage', { chat_id: chatId, text: `❌ SKU ${sku} topilmadi.` });
  const s = await db.getSettings();
  await observeProduct(p, s);
  const r = await withPrice(String(p._id), await getRecord(p._id));
  await sendPhotoOrText(chatId, r, cardCaption(r));
  return tg('sendMessage', { chat_id: chatId, text: await categoryInfo(p, r, s) });
}

// "📂 Kategoriya: O'yinchoqlar › Mashinalar" — or why the product counts as "Kategoriyasiz".
async function categoryInfo(p, r, s) {
  if (!r.cat) return `📂 Kategoriya: yo'q (Kategoriyasiz)\nBITO maydonlari: ${categoryFields(p) || 'kategoriya maydoni yo\'q'}`;
  const stats = await categoryStats(s).catch(() => null);
  const n = stats?.nodes.get(r.cat);
  if (!n) return `📂 Kategoriya: ${r.catn || r.cat} — BITO kategoriyalari ro'yxatida topilmadi (Kategoriyasiz)\nBITO maydonlari: ${categoryFields(p)}`;
  const path = [];
  for (let q = n; q; q = q.parent && stats.nodes.get(q.parent)) path.unshift(q.name);
  return `📂 Kategoriya: ${path.join(' › ')}`;
}

// ---- catalog pass ----

const SCAN_PAGE = 200; // BITO maximum page size
// The whole catalog (~5600 products = ~29 pages) fits in one tick when BITO answers normally; the time
// slice (deadline) is the real limit, the rest continues next tick.
const scanPagesPerTick = () => Number(process.env.STOCK_SCAN_PAGES) || 40;

// Version of what a pass stores per product. A full pass made by an older version (e.g. before categories
// were read in every BITO format) does not count: the next request starts a new pass.
const RECORD_V = 2;
export async function getScan() {
  const st = (await db.redis().get(db.K.stockScan)) || {};
  if (st.last_full_at && st.rv !== RECORD_V) return { ...st, last_full_at: null, page: 0, done: false, seen: 0, cnt: { out: 0, low: 0, in: 0 } };
  return st;
}

export const isLowRecord = (r, threshold) =>
  r.stock > 0 && (r.stock <= threshold || (r.red > 0 && r.stock <= r.red) || (r.yellow > 0 && r.stock <= r.yellow));

function etaText(st) {
  if (st.done || !st.pages_done || !st.total) return null;
  const left = Math.ceil(Math.max(0, st.total - st.seen) / SCAN_PAGE) * (st.ms / st.pages_done);
  return left < 60000 ? '~1 daqiqadan kam' : `~${Math.ceil(left / 60000)} daqiqa`;
}

// Exact state of the current pass — never a bare "0".
export function scanStatusLines(st) {
  const c = st.cnt || { out: 0, low: 0, in: 0 };
  const lines = [
    `🔄 Tekshirildi: ${st.seen || 0} / ${st.total || '?'} mahsulot`,
    `❌ Hozircha tugagan topildi: ${c.out} ta`,
    `⚠️ Kam qolgan: ${c.low} ta`,
    `✅ Sotuvda: ${c.in} ta`,
  ];
  const eta = etaText(st);
  if (eta) lines.push(`⏳ Taxminiy qolgan vaqt: ${eta}`);
  return lines;
}

export const scanProgressText = (st) => ['🔄 Katalog tekshirilmoqda...', ...scanStatusLines(st)].join('\n');

const partialMark = (st) => `to'liq emas — ${st.seen || 0}/${st.total || '?'} tekshirildi`;

async function finalText(st, s) {
  const [out, low] = await Promise.all([outRecords(), lowRecords(s)]);
  return `✅ Tekshiruv tugadi: ${st.seen} ta mahsulot tekshirildi.\n❌ Tugagan: ${out.length} ta, ⚠️ Kam qolgan: ${low.length} ta`;
}

// After a full pass: products that were not seen (deleted / archived in BITO) leave the lists.
async function pruneIndexes(passId) {
  const seen = (await db.redis().hgetall(db.K.stockPassSeen)) || {};
  const [out, low] = await Promise.all([db.redis().hgetall(db.K.stockOut), db.redis().hgetall(db.K.stockLow)]);
  const stale = [...Object.keys(out || {}), ...Object.keys(low || {})].filter((pid) => Number(seen[pid]) !== passId);
  for (const pid of stale) await dropFromIndexes(pid);
  if (stale.length) console.log(`stock: ${stale.length} products no longer in BITO removed from lists`);
}

// Reads the catalog page by page (200 per page) and remembers every product's stock. The cursor is
// saved after each page, so a pass continues in the next tick / button press. A new pass starts each
// day (or when `restart`); with `continuous` (the 15-minute tick) right after the previous one is done —
// BITO cannot list products by updated_at, so going through the whole catalog again and again is the
// only way to see a stock change (out / back in stock) of any product within a tick or two.
// Only one pass runs at a time.
export async function scanCatalog(s, { deadline, maxPages = Infinity, restart = false, continuous = false, onProgress } = {}) {
  if (!(await db.lock('stockscan', 300))) {
    return { busy: true, state: await getScan() };
  }
  let pages = 0;
  try {
    let st = await getScan();
    const day = db.today();
    if (restart || !st.page || (st.done && (continuous || st.day !== day))) {
      st = {
        id: Date.now(),
        day,
        page: 1,
        done: false,
        seen: 0,
        total: st.total || 0,
        started_at: Date.now(),
        last_full_at: st.last_full_at || null,
        rv: RECORD_V,
        cnt: { out: 0, low: 0, in: 0 },
        ms: 0,
        pages_done: 0,
      };
      await db.redis().set(db.K.stockScan, st);
    }
    while (!st.done && pages < maxPages && Date.now() + 15000 < deadline) {
      const started = Date.now();
      const { list, total } = await getProductsPage({ page: st.page, limit: SCAN_PAGE });
      st.total = total || st.total;
      // No auto-posts in the first full pass (no history yet): everything would look "back".
      await observeMany(list, s, st.id, { autopost: Boolean(st.last_full_at) && s.restock_post !== false });
      const threshold = db.limit(s, 'low_stock_threshold');
      st.cnt ||= { out: 0, low: 0, in: 0 };
      for (const p of list.filter(isTradable)) {
        const stock = productStock(p);
        if (stock <= 0) st.cnt.out++;
        else {
          st.cnt.in++;
          if (isLowRecord({ stock, red: maxLine(p, 'red_line'), yellow: maxLine(p, 'yellow_line') }, threshold)) st.cnt.low++;
        }
      }
      st.ms = (st.ms || 0) + (Date.now() - started);
      st.pages_done = (st.pages_done || 0) + 1;
      st.seen += list.length;
      st.page++;
      pages++;
      if (list.length < SCAN_PAGE) {
        st.done = true;
        st.done_at = Date.now();
        st.last_full_at = st.done_at;
        await pruneIndexes(st.id);
        console.log(`stock: catalog pass done — ${st.seen} products`);
      }
      await db.redis().set(db.K.stockScan, st);
      if (onProgress) await onProgress(st).catch(() => {});
    }
    return { state: st, pages, finished: st.done && pages > 0 };
  } finally {
    await db.unlock('stockscan');
  }
}

// What to send to a chat when the pass is done: 'list' (out list), 'report' (daily report) or 'none'
// (only the final message).
async function addPending(chat, then) {
  const cur = (await db.redis().get(db.K.stockPendingSend)) || {};
  const list = Array.isArray(cur.items) ? cur.items : cur.chat ? [{ chat: cur.chat, then: cur.report ? 'report' : 'list' }] : [];
  if (!list.some((x) => String(x.chat) === String(chat) && x.then === then)) list.push({ chat, then });
  await db.redis().set(db.K.stockPendingSend, { items: list });
}

async function sendAfterPass(chat, then, st, s) {
  await tg('sendMessage', { chat_id: chat, text: await finalText(st, s) });
  if (then === 'list') await sendFullOutList(chat);
  else if (then === 'report') await sendStockReport(chat, s);
}

async function deliverPending(s) {
  const cur = await db.redis().get(db.K.stockPendingSend);
  if (!cur) return false;
  await db.redis().del(db.K.stockPendingSend);
  const st = await getScan();
  const list = Array.isArray(cur.items) ? cur.items : [{ chat: cur.chat, then: cur.report ? 'report' : 'list' }];
  for (const x of list) await sendAfterPass(x.chat, x.then, st, s).catch((e) => console.error(`stock pending send failed: ${errText(e)}`));
  return true;
}

// Runs / continues the catalog pass with a live progress message (edited at most every 3 s). When it
// finishes: "✅ Tekshiruv tugadi: …" and then (`then`) the list or the report. If time runs out or another
// pass is running, the result is sent when the pass is done.
export async function scanWithProgress(chatId, s, { deadline = Date.now() + 270000, then = 'list' } = {}) {
  const msg = await tg('sendMessage', { chat_id: chatId, text: scanProgressText(await getScan()) });
  let last = 0;
  const edit = async (text, force = false) => {
    if (!force && Date.now() - last < stockConfig.progressEveryMs) return;
    last = Date.now();
    await tg('editMessageText', { chat_id: chatId, message_id: msg?.message_id, text }).catch(() => {});
  };
  const r = await scanCatalog(s, { deadline, onProgress: (st) => edit(scanProgressText(st)) });
  if (r.busy) {
    await addPending(chatId, then);
    return edit(['🔄 Katalog hozir boshqa jarayonda tekshirilmoqda.', ...scanStatusLines(r.state), '', 'Tugagach natija shu yerga yuboriladi.'].join('\n'), true);
  }
  if (r.state.done) {
    await edit(await finalText(r.state, s), true);
    if (then === 'list') await sendFullOutList(chatId);
    else if (then === 'report') await sendStockReport(chatId, s);
    return { done: true };
  }
  await addPending(chatId, then);
  return edit(['⏳ Vaqt yetmadi — tekshiruv keyingi safar davom etadi, tugagach natija shu yerga yuboriladi.', ...scanStatusLines(r.state)].join('\n'), true);
}

// /tugagan, "❌ Tugaganlar": from the cache when a full pass exists. Otherwise what is known so far
// (marked "to'liq emas") and the pass is started / continued with progress; the full list follows.
export async function sendOutListOrScan(chatId, s, { deadline = Date.now() + 270000 } = {}) {
  const st = await getScan();
  if (st.last_full_at) return sendFullOutList(chatId);
  if (st.seen > 0) await sendFullOutList(chatId, { partial: st });
  return scanWithProgress(chatId, s, { deadline, then: 'list' });
}

// Daily report / "📤 Hisobotni hozir yuborish": "📋 Bugungi hisobot: …" and the full out list. Before the
// first full pass: the results so far (marked "to'liq emas") and the pass with progress; the report
// follows when it is done. Never a bare "0".
export async function sendStockReport(chatId, s, { deadline = Date.now() + 240000, scan = true } = {}) {
  const st = await getScan();
  const [out, low] = await Promise.all([outRecords(), lowRecords(s)]);
  if (st.last_full_at) {
    await sendFullOutList(chatId, { header: `📋 Bugungi hisobot: tugagan ${out.length} ta, kam qolgan ${low.length} ta` });
    return { out: out.length, low: low.length };
  }
  if (st.seen > 0) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: [`📋 Bugungi hisobot: tugagan ${out.length} ta, kam qolgan ${low.length} ta (${partialMark(st)})`, '', ...scanStatusLines(st)].join('\n'),
    });
    await sendFullOutList(chatId, { partial: st });
  }
  if (scan) await scanWithProgress(chatId, s, { deadline, then: 'report' });
  return { partial: true, seen: st.seen || 0, total: st.total || 0, out: out.length, low: low.length };
}

// ---- tick: watch stock, catalog pass, alerts, daily list ----

export async function stockTick(s, { deadline = Date.now() + 60000 } = {}) {
  const result = { updated: null, scan: null, alerts: 0, report: null };
  // The scanner also runs without a stock group: "🔄 Qayta keldi" posts and "🔔 Kelganda xabar ber" need it.
  if (!stockGroups(s).length && s.restock_post === false && !(await hasWaiters().catch(() => false))) return { ...result, reason: 'no stock group' };
  // 1) recently changed products
  try {
    const list = [];
    for (let page = 1; page <= UPDATED_PAGES && Date.now() < deadline; page++) {
      list.push(...(await getProductsPage({ page, limit: PAGE, sort: '-updated_at' })).list);
    }
    const hist = Boolean((await getScan()).last_full_at);
    result.updated = await observeMany(list, s, null, { autopost: hist && s.restock_post !== false });
  } catch (e) {
    console.error(`stock: recently updated products failed: ${errText(e)}`);
  }
  // 2) the whole catalog, 200-product pages as long as the time slice lasts, pass after pass
  try {
    const r = await scanCatalog(s, { deadline, maxPages: scanPagesPerTick(), continuous: true });
    result.scan = { day: r.state.day, page: r.state.page, done: r.state.done, seen: r.state.seen, total: r.state.total, busy: r.busy || false };
    if (r.finished) await deliverPending(s);
  } catch (e) {
    console.error(`stock: catalog pass failed: ${errText(e)}`);
  }
  // 3) alerts
  result.alerts = await sendAlerts(s, { deadline }).catch((e) => {
    console.error(`stock alerts failed: ${errText(e)}`);
    return 0;
  });
  // 4) daily list at the configured Tashkent time
  if (routeGroup(s, 'report') && s.stock_daily && nowHHMM() >= (s.stock_daily_time || '09:00') && (await db.once(`stockdaily:${db.today()}`, 60 * 60 * 30))) {
    result.report = await sendStockReport(routeGroup(s, 'report'), s, { deadline }).catch((e) => {
      console.error(`stock daily list failed: ${errText(e)}`);
      return { error: errText(e) };
    });
  }
  return result;
}

// ---- categories, search and the common list format ----

const FILTERS = { a: '📦 Hammasi', o: '❌ Tugaganlar', l: '⚠️ Kam qolganlar', i: '✅ Bor (sotuvda)' };
const CATS_PAGE = 10;
const LIST_TTL = 60 * 60 * 6;

async function allRecords() {
  const all = (await db.redis().hgetall(db.K.stock)) || {};
  return Object.entries(all).map(([pid, r]) => ({ ...r, pid }));
}

function counts(records, threshold) {
  const c = { total: records.length, o: 0, l: 0, i: 0 };
  for (const r of records) {
    if (r.stock <= 0) c.o++;
    else {
      c.i++;
      if (isLowRecord(r, threshold)) c.l++;
    }
  }
  return c;
}

function applyFilter(records, f, threshold) {
  if (f === 'o') return records.filter((r) => r.stock <= 0).sort((a, b) => (b.out_at || 0) - (a.out_at || 0));
  if (f === 'l') return records.filter((r) => isLowRecord(r, threshold)).sort((a, b) => a.stock - b.stock);
  if (f === 'i') return records.filter((r) => r.stock > 0).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return [...records].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

const countsLine = (c) => `jami ${c.total}, tugagan ${c.o}, kam ${c.l}, bor ${c.i}`;

// Category tree: the category list comes from BITO itself (all pages, parent_id / child_count /
// item_count), the stock counts from the catalog cache. Every category counts its own products plus
// those of all its sub-categories. "jami" = cached products when a full pass exists, otherwise
// max(BITO item_count of the subtree, cached). Empty = item_count 0, child_count 0 and nothing cached;
// those are hidden. Products without a (known) category are one "Kategoriyasiz" row.
export async function categoryStats(s) {
  const threshold = db.limit(s, 'low_stock_threshold');
  const [records, st] = await Promise.all([allRecords(), getScan()]);
  const full = Boolean(st.last_full_at);
  let bito = null;
  let error = null;
  let saved = false;
  const lastKey = `${db.K.stock}:cats_last`;
  try {
    bito = await getAllCategories();
    if ((await db.redis().get(`${lastKey}:at`)) !== db.today()) {
      await db.redis().set(lastKey, bito);
      await db.redis().set(`${lastKey}:at`, db.today());
    }
  } catch (e) {
    error = errText(e);
    console.error(`BITO categories could not be loaded: ${error}`);
    // The last list that was loaded (names and hierarchy) instead of bare ids from the cache.
    bito = await db.redis().get(lastKey).catch(() => null);
    saved = Boolean(bito);
  }
  const nodes = new Map();
  const add = (c) => nodes.set(c.id, { id: c.id, name: c.name || 'Nomsiz', parent: c.parent_id || null, item_count: c.item_count || 0, child_count: c.child_count || 0, children: [], own: [] });
  if (bito) bito.list.forEach(add);
  else for (const r of records) if (r.cat && (!nodes.has(r.cat) || (r.catn && nodes.get(r.cat).name === 'Nomsiz'))) add({ id: r.cat, name: r.catn });
  const loose = [];
  for (const r of records) (r.cat && nodes.has(r.cat) ? nodes.get(r.cat).own : loose).push(r);
  // Parent links; a missing parent or a cycle makes the category a root.
  for (const n of nodes.values()) {
    let p = n.parent && nodes.get(n.parent);
    const seen = new Set([n.id]);
    for (let q = p; q && q.parent; q = nodes.get(q.parent)) {
      if (seen.has(q.id)) { p = null; break; }
      seen.add(q.id);
    }
    if (p && p.id !== n.id) p.children.push(n);
    else n.parent = null;
  }
  const done = new Set();
  const aggregate = (n) => {
    if (done.has(n.id)) return n;
    done.add(n.id);
    let all = n.own;
    let items = n.item_count;
    for (const ch of n.children) {
      aggregate(ch);
      all = all.concat(ch.all);
      items += ch.items;
    }
    const k = counts(all, threshold);
    Object.assign(n, { all, items, total: full ? k.total : Math.max(items, k.total), o: k.o, l: k.l, i: k.i });
    n.empty = n.item_count === 0 && n.child_count === 0 && !n.children.length && n.all.length === 0;
    return n;
  };
  const roots = [...nodes.values()].filter((n) => !n.parent).map(aggregate);
  const visible = [...nodes.values()].filter((n) => !n.empty);
  const rows = roots.filter((n) => !n.empty);
  if (loose.length) {
    const none = { id: 'none', name: 'Kategoriyasiz', parent: null, children: [], all: loose, ...counts(loose, threshold) };
    nodes.set('none', none);
    rows.push(none);
  }
  const g = counts(records, threshold);
  return {
    nodes,
    rows,
    bitoTotal: bito ? bito.total : null,
    main: roots.filter((n) => !n.empty).length,
    sub: visible.filter((n) => n.parent).length,
    empty: nodes.size - (loose.length ? 1 : 0) - visible.length,
    error,
    saved,
    global: { total: full ? g.total : Math.max(st.total || 0, g.total), o: g.o, l: g.l, i: g.i },
    scan: st,
  };
}

const visibleChildren = (n) => (n.children || []).filter((c) => !c.empty);
// A category with sub-categories opens its node view, a leaf its out-of-stock list.
const catButton = (c, label) => [{ text: label, callback_data: (visibleChildren(c).length ? `st:kn:${c.id}:0` : `st:ko:${c.id}`).slice(0, 64) }];

const STATS_SORTS = {
  o: { label: "❌ ko'p tugagan", fn: (a, b) => b.o - a.o || b.total - a.total || a.name.localeCompare(b.name) },
  n: { label: '🔤 nom', fn: (a, b) => a.name.localeCompare(b.name) },
  t: { label: "📦 ko'p mahsulot", fn: (a, b) => b.total - a.total || b.o - a.o || a.name.localeCompare(b.name) },
};

function statsKeyboard(rows, sort, page) {
  const pages = Math.max(1, Math.ceil(rows.length / CATS_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const kb = [
    Object.entries(STATS_SORTS).map(([k, v]) => ({ text: `${k === sort ? '• ' : ''}${v.label}`, callback_data: `st:ks:${k}` })),
    ...rows.slice(p * CATS_PAGE, (p + 1) * CATS_PAGE).map((c) => catButton(c, `${c.name} (❌${c.o})`)),
  ];
  const nav = [];
  if (p > 0) nav.push({ text: '⬅️', callback_data: `st:kp:${sort}:${p - 1}` });
  if (p < pages - 1) nav.push({ text: '➡️', callback_data: `st:kp:${sort}:${p + 1}` });
  if (nav.length) kb.push(nav);
  return { kb: { inline_keyboard: kb }, text: `📂 Kategoriyani tanlang — ichki kategoriyalari yoki tugaganlari chiqadi · ${p + 1}/${pages}-sahifa`, page: p };
}

const statLine = (c) => `${c.name} — jami ${c.total} | ❌ ${c.o} | ⚠️ ${c.l} | ✅ ${c.i}`;

// "📊 Kategoriya statistikasi" / /kategoriyalar: header with totals, one line per main category (with
// its sub-categories counted in, split under 4096), then paged buttons. Sorting: most out of stock
// (default), name, most products.
export async function sendCategoryStats(chatId, s, { sort = 'o', page = 0, messageId = null, scan = true } = {}) {
  const stats = await categoryStats(s);
  const rows = [...stats.rows].sort(STATS_SORTS[sort]?.fn || STATS_SORTS.o.fn);
  if (messageId) {
    const v = statsKeyboard(rows, sort, page);
    return tg('editMessageText', { chat_id: chatId, message_id: messageId, text: v.text, reply_markup: v.kb }).catch(() => {});
  }
  const st = stats.scan;
  const g = stats.global;
  const head = [
    `📂 BITO'da jami ${stats.bitoTotal ?? '?'} ta kategoriya (asosiy: ${stats.main} ta, ichki: ${stats.sub} ta, bo'sh: ${stats.empty} ta) | 📦 jami mahsulot ${g.total} | ❌ tugagan ${g.o} | ⚠️ kam ${g.l} | ✅ bor ${g.i}`,
    st.last_full_at
      ? `🕘 Oxirgi to'liq tekshiruv: ${fmtDateTime(st.last_full_at)}${st.page && !st.done ? ` (yangi tekshiruv: ${st.seen || 0}/${st.total || '?'})` : ''}`
      : `⚠️ ${partialMark(st)} — sonlar hozircha to'liq emas`,
  ];
  if (stats.error) head.push(`⚠️ BITO kategoriyalarini olib bo'lmadi (${stats.error}) — ${stats.saved ? "oxirgi saqlangan kategoriyalar ro'yxati" : "keshdagi kategoriyalar"} ko'rsatildi`);
  head.push(`Saralash: ${STATS_SORTS[sort]?.label || STATS_SORTS.o.label} · asosiy kategoriyalar (ichkilari bilan birga)`, '');
  const lines = [...head, ...rows.map(statLine), '', `bo'sh: ${stats.empty} ta (mahsulotsiz va ichki kategoriyasiz — yashirildi)`];
  for (const text of splitMessages(lines)) await tg('sendMessage', { chat_id: chatId, text });
  const v = statsKeyboard(rows, sort, page);
  await tg('sendMessage', { chat_id: chatId, text: v.text, reply_markup: v.kb });
  if (scan) await continueScanIfNeeded(chatId, s);
  return rows.length;
}

// A category with sub-categories: summary, "📦 Hammasi" (the whole subtree), one button per non-empty
// sub-category (10 per page), "⬆️" back to the parent. Opened as a new message (st:kn), paging and
// "⬆️" edit it in place (st:kq).
export async function sendCategoryNode(chatId, s, id, page = 0, messageId = null) {
  const stats = await categoryStats(s);
  const n = stats.nodes.get(id);
  if (!n || n.empty) return tg('sendMessage', { chat_id: chatId, text: '📂 Kategoriya topilmadi.' });
  const kids = visibleChildren(n).sort(STATS_SORTS.o.fn);
  const pages = Math.max(1, Math.ceil(kids.length / CATS_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const kb = [
    [{ text: `📦 Hammasi (${n.total} | ❌${n.o})`, callback_data: `st:ko:${n.id}`.slice(0, 64) }],
    ...kids.slice(p * CATS_PAGE, (p + 1) * CATS_PAGE).map((c) => catButton(c, `${c.name} (${c.total} | ❌${c.o})`)),
  ];
  const nav = [];
  if (p > 0) nav.push({ text: '⬅️', callback_data: `st:kq:${n.id}:${p - 1}`.slice(0, 64) });
  if (p < pages - 1) nav.push({ text: '➡️', callback_data: `st:kq:${n.id}:${p + 1}`.slice(0, 64) });
  if (nav.length) kb.push(nav);
  const parent = n.parent && stats.nodes.get(n.parent);
  if (parent) kb.push([{ text: `⬆️ ${parent.name}`, callback_data: `st:kq:${parent.id}:0`.slice(0, 64) }]);
  const path = [];
  for (let q = n; q; q = q.parent && stats.nodes.get(q.parent)) path.unshift(q.name);
  const payload = {
    chat_id: chatId,
    text: `📂 ${path.join(' › ')}: ${countsLine(n)}${stats.scan.last_full_at ? '' : `\n(${partialMark(stats.scan)})`}\nIchki kategoriyalar: ${kids.length} ta · ${p + 1}/${pages}-sahifa`,
    reply_markup: { inline_keyboard: kb },
  };
  if (messageId) return tg('editMessageText', { ...payload, message_id: messageId }).catch(() => tg('sendMessage', payload));
  return tg('sendMessage', payload);
}

async function partialNote() {
  const st = await getScan();
  return st.last_full_at ? '' : `\n(${partialMark(st)})`;
}

// Starts / continues the pass in the background of this request when the cache is not complete yet.
async function continueScanIfNeeded(chatId, s) {
  const st = await getScan();
  if (st.last_full_at) return;
  await scanWithProgress(chatId, s, { then: 'none' });
}

const textLine = (r, i) =>
  `${i + 1}. ${r.name} — SKU ${r.sku} — ${r.stock > 0 ? r.stock : 0} dona${r.price > 0 ? ` — ${formatPrice(r.price)} so'm` : ''}${r.stock <= 0 ? ` — ${outDateText(r)}` : ''}${r.img ? '' : ' (rasmsiz)'}`;

// Photos of a saved list (session), 50 per call, albums of 10, then "➡️ Keyingi".
export async function sendListPhotos(chatId, sid, offset = 0) {
  const sess = await db.redis().get(`${db.K.stock}:list:${sid}`);
  if (!sess) return tg('sendMessage', { chat_id: chatId, text: "Bu ro'yxat eskirgan — qaytadan tanlang." });
  const records = (await mapLimit(sess.pids, 8, async (pid) => {
    const r = await getRecord(pid);
    return r ? { ...r, pid } : null;
  })).filter((r) => r && r.img);
  const batch = records.slice(offset, offset + PHOTO_BATCH);
  const priced = await mapLimit(batch, 6, (r) => withPrice(r.pid, r));
  const groups = chunk(priced, 10);
  for (let n = 0; n < groups.length; n++) {
    if (n) await clock.sleep(ALBUM_PAUSE_MS);
    await sendAlbumList(chatId, groups[n], cardCaption);
  }
  const shown = offset + batch.length;
  if (shown < records.length) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `📸 Rasmlar: ${offset + 1}–${shown} / ${records.length}`,
      reply_markup: { inline_keyboard: [[{ text: `➡️ Keyingi ${Math.min(PHOTO_BATCH, records.length - shown)} ta rasm`, callback_data: `st:lp:${sid}:${shown}` }]] },
    });
  }
  return batch.length;
}

// Common format: summary, numbered text list (split under 4096), then photos (50 per batch).
export async function sendRecordList(chatId, records, { summary, keyboard } = {}) {
  const sid = Math.random().toString(36).slice(2, 10);
  await db.redis().set(`${db.K.stock}:list:${sid}`, { pids: records.map((r) => r.pid) }, { ex: LIST_TTL });
  await tg('sendMessage', { chat_id: chatId, text: summary, ...(keyboard ? { reply_markup: keyboard } : {}) });
  if (!records.length) return 0;
  for (const text of splitMessages(records.map(textLine))) await tg('sendMessage', { chat_id: chatId, text });
  await sendListPhotos(chatId, sid, 0);
  return records.length;
}

const filterKeyboard = (prefix) => ({
  inline_keyboard: [
    [{ text: FILTERS.a, callback_data: `${prefix}:a` }, { text: FILTERS.o, callback_data: `${prefix}:o` }],
    [{ text: FILTERS.l, callback_data: `${prefix}:l` }, { text: FILTERS.i, callback_data: `${prefix}:i` }],
  ],
});

// "📂 Kategoriyalar": main categories that have products (sub-categories counted in).
export async function sendCategories(chatId, s, page = 0, messageId = null) {
  const cats = (await categoryStats(s)).rows.filter((c) => c.total > 0).sort((a, b) => a.name.localeCompare(b.name));
  if (!cats.length) {
    await tg('sendMessage', { chat_id: chatId, text: `📂 Kategoriyalar hali yo'q — katalog tekshirilmoqda.${await partialNote()}` });
    return continueScanIfNeeded(chatId, s);
  }
  const pages = Math.ceil(cats.length / CATS_PAGE);
  const p = Math.min(Math.max(0, page), pages - 1);
  const label = (c) => `${c.name} (${c.total} | ❌${c.o})`;
  const rows = cats
    .slice(p * CATS_PAGE, (p + 1) * CATS_PAGE)
    .map((c) => (visibleChildren(c).length ? catButton(c, label(c)) : [{ text: label(c), callback_data: `st:c:${c.id}`.slice(0, 64) }]));
  const nav = [];
  if (p > 0) nav.push({ text: '⬅️', callback_data: `st:cats:${p - 1}` });
  if (p < pages - 1) nav.push({ text: '➡️', callback_data: `st:cats:${p + 1}` });
  if (nav.length) rows.push(nav);
  const payload = { chat_id: chatId, text: `📂 Kategoriyalar: ${cats.length} ta · ${p + 1}/${pages}-sahifa${await partialNote()}`, reply_markup: { inline_keyboard: rows } };
  if (messageId) return tg('editMessageText', { ...payload, message_id: messageId }).catch(() => tg('sendMessage', payload));
  await tg('sendMessage', payload);
  if (page === 0 && !messageId) await continueScanIfNeeded(chatId, s);
}

// By id, else by name (exact, then part of it) among all non-empty categories, main ones first.
async function findCategory(s, idOrName) {
  const stats = await categoryStats(s);
  const roots = stats.rows;
  const byId = stats.nodes.get(idOrName);
  if (byId) return { cat: byId, cats: roots };
  const q = String(idOrName).toLowerCase();
  const all = [...roots, ...[...stats.nodes.values()].filter((n) => !n.empty && n.parent)];
  return { cat: all.find((c) => c.name.toLowerCase() === q) || all.find((c) => c.name.toLowerCase().includes(q)), cats: roots };
}

export async function sendCategoryMenu(chatId, s, catId) {
  const { cat } = await findCategory(s, catId);
  if (!cat) return tg('sendMessage', { chat_id: chatId, text: '📂 Kategoriya topilmadi.' });
  return tg('sendMessage', {
    chat_id: chatId,
    text: `📂 ${cat.name}: ${countsLine(cat)}${await partialNote()}\n\nNimani ko'rsatay?`,
    reply_markup: filterKeyboard(`st:cf:${cat.id}`),
  });
}

// Reads the products of a category subtree straight from BITO (category_id filter) into the cache, so a
// category is right even before the catalog pass reaches its products. Stops when BITO ignores the
// filter (a product of another category comes back) or after ~25 s.
const REFRESH_PAGES = 5;
async function refreshCategory(cat, s) {
  if (!cat || cat.id === 'none') return 0;
  const ids = [];
  const walk = (n) => {
    ids.push(n.id);
    (n.children || []).forEach(walk);
  };
  walk(cat);
  const deadline = Date.now() + 25000;
  let seen = 0;
  await mapLimit(ids.slice(0, 60), 4, async (id) => {
    for (let page = 1; page <= REFRESH_PAGES && Date.now() < deadline; page++) {
      const { list } = await getProductsPage({ page, limit: SCAN_PAGE, category_id: id });
      if (list.some((p) => productCategory(p)?.id !== id)) return; // filter not supported
      await observeMany(list, s);
      seen += list.length;
      if (list.length < SCAN_PAGE) return;
    }
  }).catch((e) => console.error(`category refresh ${cat.id}: ${errText(e)}`));
  return seen;
}

// Products of a category and all its sub-categories ("Kategoriyasiz": no category, or one that is not
// in BITO's category list).
export async function sendCategoryFilter(chatId, s, catIdOrName, f, { withFilters = false } = {}) {
  let { cat, cats } = await findCategory(s, catIdOrName);
  if (cat && cat.id !== 'none' && (await refreshCategory(cat, s))) ({ cat, cats } = await findCategory(s, cat.id));
  if (!cat) {
    return tg('sendMessage', {
      chat_id: chatId,
      text: `📂 «${catIdOrName}» kategoriyasi topilmadi.${cats.length ? `\nMavjudlari: ${cats.slice(0, 15).map((c) => c.name).join(', ')}` : ''}`,
    });
  }
  const threshold = db.limit(s, 'low_stock_threshold');
  const list = applyFilter(cat.all, f, threshold);
  return sendRecordList(chatId, list, {
    summary: `📂 ${cat.name}: ${countsLine(cat)} · ${FILTERS[f]}: ${list.length} ta${await partialNote()}`,
    ...(withFilters ? { keyboard: filterKeyboard(`st:cf:${cat.id}`) } : {}),
  });
}

// Search in BITO (name part, SKU, barcode); results go into the cache too.
export async function sendSearch(chatId, s, q) {
  const query = String(q).trim();
  if (query.length < 2) return tg('sendMessage', { chat_id: chatId, text: '🔎 Kamida 2 ta belgi yozing.' });
  const { list } = await getProductsPage({ page: 1, limit: 100, search: query });
  const products = list.filter(isTradable);
  await observeMany(products, s);
  const records = (await mapLimit(products, 8, async (p) => {
    const r = await getRecord(p._id);
    return r ? { ...r, pid: String(p._id) } : null;
  })).filter(Boolean);
  if (!records.length) return tg('sendMessage', { chat_id: chatId, text: `🔎 «${query}» bo'yicha hech narsa topilmadi.` });
  const sid = Math.random().toString(36).slice(2, 10);
  await db.redis().set(`${db.K.stock}:search:${sid}`, { q: query, pids: records.map((r) => r.pid) }, { ex: LIST_TTL });
  const c = counts(records, db.limit(s, 'low_stock_threshold'));
  return sendRecordList(chatId, applyFilter(records, 'a'), {
    summary: `🔎 «${query}»: ${countsLine(c)}\nHolat bo'yicha saralash:`,
    keyboard: filterKeyboard(`st:sf:${sid}`),
  });
}

async function sendSearchFilter(chatId, s, sid, f) {
  const sess = await db.redis().get(`${db.K.stock}:search:${sid}`);
  if (!sess) return tg('sendMessage', { chat_id: chatId, text: "Bu qidiruv eskirgan — qaytadan qidiring." });
  const records = (await mapLimit(sess.pids, 8, async (pid) => {
    const r = await getRecord(pid);
    return r ? { ...r, pid } : null;
  })).filter(Boolean);
  const list = applyFilter(records, f, db.limit(s, 'low_stock_threshold'));
  return sendRecordList(chatId, list, { summary: `🔎 «${sess.q}» · ${FILTERS[f]}: ${list.length} ta` });
}

// ---- group updates ----

let botUser = null;
async function botUsername() {
  if (!botUser) botUser = await tg('getMe').catch(() => null);
  return (botUser?.username || '').toLowerCase();
}

export async function handleGroupMessage(msg, s) {
  if (!isStockGroup(s, msg.chat.id) || !s.stock_commands) return;
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  const m = text.match(/^\/(\w+)(?:@(\w+))?(?:\s+(.*))?$/s);
  if (m?.[2] && m[2].toLowerCase() !== (await botUsername())) return; // command for another bot
  const cmd = m?.[1]?.toLowerCase();
  const arg = (m?.[3] || '').trim();
  try {
    if (cmd === 'tugagan' && arg) return await sendCategoryFilter(chatId, s, arg, 'o');
    if (cmd === 'kam' && arg) return await sendCategoryFilter(chatId, s, arg, 'l');
    if (cmd === 'tugagan' || text === GROUP_BUTTONS.out) return await sendOutListOrScan(chatId, s);
    if (cmd === 'kam' || text === GROUP_BUTTONS.low) return await sendLowList(chatId, s, 0);
    if (cmd === 'kategoriyalar' || text === GROUP_BUTTONS.stats) return await sendCategoryStats(chatId, s);
    if (cmd === 'kategoriya' || text === GROUP_BUTTONS.cats) return await sendCategories(chatId, s, 0);
    if (cmd === 'qidir' && arg) return await sendSearch(chatId, s, arg);
    if (cmd === 'qidir' || text === GROUP_BUTTONS.search) {
      return await tg('sendMessage', { chat_id: chatId, text: SEARCH_PROMPT, reply_markup: { force_reply: true, selective: true } });
    }
    if (msg.reply_to_message?.text === SEARCH_PROMPT && text) return await sendSearch(chatId, s, text);
    if (cmd === 'bugun' || text === GROUP_BUTTONS.today) return await sendToday(chatId, 0);
    if (cmd === 'sku' && /^\d[\d-]*$/.test(arg)) return await sendSkuCard(chatId, arg);
    if (cmd === 'sku' || text === GROUP_BUTTONS.sku) {
      // A reply to the bot reaches it even with privacy mode on.
      return await tg('sendMessage', { chat_id: chatId, text: SKU_PROMPT, reply_markup: { force_reply: true, selective: true } });
    }
    if (msg.reply_to_message?.text === SKU_PROMPT && /^\d[\d-]*$/.test(text)) return await sendSkuCard(chatId, text);
    if (cmd === 'start' || cmd === 'yordam' || cmd === 'help') {
      return await tg('sendMessage', {
        chat_id: chatId,
        text: "📦 Ombor bo'limi\n\n/tugagan — tugagan mahsulotlar (/tugagan blaknot — kategoriya bo'yicha)\n/kam — kam qolganlar (/kam blaknot)\n/bugun — bugun tugagan va qayta kelganlar\n/kategoriya — kategoriyalar\n/kategoriyalar — kategoriya statistikasi\n/qidir blaknot — nom, SKU yoki shtrix-kod bo'yicha\n/sku 3147 — mahsulot kartochkasi",
        reply_markup: GROUP_KEYBOARD,
      });
    }
  } catch (e) {
    console.error(`group command failed: ${errText(e)}`);
    await tg('sendMessage', { chat_id: chatId, text: `❌ Xato: ${errText(e)}` }).catch(() => {});
  }
}

// "➡️ Keyingi" buttons in the group (any member may press them).
export async function handleGroupCallback(cb, s) {
  const chatId = cb.message?.chat.id;
  await tg('answerCallbackQuery', { callback_query_id: cb.id, text: '⏳' }).catch(() => {});
  if (!isStockGroup(s, chatId)) return;
  const [, kind, page, extra] = (cb.data || '').split(':');
  if (kind === 'cats') return sendCategories(chatId, s, Number(page) || 0, cb.message.message_id);
  if (kind === 'ks') return sendCategoryStats(chatId, s, { sort: page, scan: false });
  if (kind === 'kp') return sendCategoryStats(chatId, s, { sort: page, page: Number(extra) || 0, messageId: cb.message.message_id });
  if (kind === 'kn') return sendCategoryNode(chatId, s, page, Number(extra) || 0);
  if (kind === 'kq') return sendCategoryNode(chatId, s, page, Number(extra) || 0, cb.message.message_id); // paging / ⬆️ edit in place
  if (kind === 'ko') return sendCategoryFilter(chatId, s, page, 'o', { withFilters: true });
  if (kind === 'c') return sendCategoryMenu(chatId, s, page);
  if (kind === 'cf') return sendCategoryFilter(chatId, s, page, extra);
  if (kind === 'sf') return sendSearchFilter(chatId, s, page, extra);
  // "➡️ Keyingi" buttons are used once.
  await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  if (kind === 'lp') return sendListPhotos(chatId, page, Number(extra) || 0);
  const n = Number(page) || 0;
  if (kind === 'out' || kind === 'outp') return sendOutPhotos(chatId, n);
  if (kind === 'low') return sendLowList(chatId, s, n);
  if (kind === 'day') return sendToday(chatId, n);
}

// The bot was added to / removed from a group.
export async function handleMyChatMember(upd, notifyAdmins) {
  const chat = upd.chat;
  if (!['group', 'supergroup'].includes(chat?.type)) return;
  const status = upd.new_chat_member?.status;
  const active = ['member', 'administrator'].includes(status);
  await db.saveGroup({ id: chat.id, title: chat.title || String(chat.id), type: chat.type, status, date: upd.date });
  await notifyAdmins({
    text: active
      ? `📦 Bot guruhga qo'shildi: ${chat.title}${status === 'administrator' ? ' (admin)' : ''}\nAdmin panel → "📦 Ombor guruhi" bo'limida tanlashingiz mumkin.`
      : `📦 Bot guruhdan chiqarildi: ${chat.title}`,
  });
}

// Selecting the stock group: group commands, the reply keyboard and whether the bot can read messages.
export async function connectGroup(chatId) {
  await tg('setMyCommands', { commands: GROUP_COMMANDS, scope: { type: 'chat', chat_id: chatId } }).catch((e) =>
    console.error(`setMyCommands for group failed: ${errText(e)}`),
  );
  const me = await tg('getMe').catch(() => null);
  const member = me ? await tg('getChatMember', { chat_id: chatId, user_id: me.id }).catch(() => null) : null;
  const canRead = Boolean(me?.can_read_all_group_messages) || member?.status === 'administrator';
  await db.saveGroup({ id: chatId, can_read: canRead, status: member?.status });
  await tg('sendMessage', {
    chat_id: chatId,
    text: "📦 Ombor bo'limi ulandi.\n\nPastdagi tugmalar yoki buyruqlar: /tugagan, /kam, /bugun, /sku 3147",
    reply_markup: GROUP_KEYBOARD,
  });
  return { canRead };
}
