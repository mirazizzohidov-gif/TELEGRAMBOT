// "📦 Ombor guruhi": stock history, out-of-stock / back-in-stock alerts, the daily list and the group
// commands (/tugagan, /kam, /sku, /bugun). Every message to the group carries the product photo.
import { findBySku, findPrice, formatPrice, getProductsPage, imageUrl, productImage, productStock } from './bito.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { chunk, clock, errText, mapLimit } from './util.js';

const PAGE = 30; // BITO page size
const LIST_PAGE = 10; // one album per page in the group
const LOW_INDEX_MAX = 100; // products with 0 < stock <= this are indexed for /kam
const UPDATED_PAGES = 2; // "-updated_at" pages read every tick
const ALERTS_PER_TICK = 10;
const REPORT_MAX = 30;
const scanPagesPerTick = () => Number(process.env.STOCK_SCAN_PAGES) || 8;

export const GROUP_BUTTONS = {
  out: '❌ Tugaganlar',
  low: '⚠️ Kam qolganlar',
  today: '📅 Bugun tugaganlar',
  sku: '🔎 SKU qidirish',
};

export const GROUP_KEYBOARD = {
  keyboard: [
    [{ text: GROUP_BUTTONS.out }, { text: GROUP_BUTTONS.low }],
    [{ text: GROUP_BUTTONS.today }, { text: GROUP_BUTTONS.sku }],
  ],
  is_persistent: true,
  resize_keyboard: true,
};

export const GROUP_COMMANDS = [
  { command: 'tugagan', description: 'Tugagan mahsulotlar' },
  { command: 'kam', description: 'Kam qolgan mahsulotlar' },
  { command: 'bugun', description: 'Bugun tugagan va qayta kelganlar' },
  { command: 'sku', description: 'Mahsulotni SKU bo\'yicha topish: /sku 3147' },
];

const SKU_PROMPT = '🔎 SKU raqamini shu xabarga javob qilib yozing:';

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

async function recordEvent(type, pid, r, s) {
  const day = db.today();
  await db.redis().rpush(db.K.stockDay(day), { type, pid, at: Date.now() });
  await db.redis().expire(db.K.stockDay(day), 60 * 60 * 24 * 3);
  if (s.stock_group && s.stock_alerts) {
    await db.redis().rpush(db.K.stockAlerts, { type, pid });
  }
  console.log(`stock ${type}: ${r.sku} ${r.name} (${pid})`);
}

// Remembers a product's stock. A drop >0 -> 0 ("out") or a rise 0 -> >0 ("back") is recorded once
// with the time; a product first seen at 0 gets BITO updated_at as an approximate out date.
export async function observeProduct(p, s) {
  const pid = String(p._id);
  const stock = productStock(p);
  const base = {
    sku: String(p.sku ?? ''),
    name: p.name,
    img: imageUrl(productImage(p)),
    red: maxLine(p, 'red_line'),
    yellow: maxLine(p, 'yellow_line'),
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
  const changed = type || rec.stock !== stock || rec.name !== base.name || rec.img !== base.img || rec.sku !== base.sku || rec.red !== base.red || rec.yellow !== base.yellow;
  if (changed) {
    await db.redis().hset(db.K.stock, { [pid]: r });
    await updateIndexes(pid, r);
  }
  if (type) await recordEvent(type, pid, r, s);
  return type;
}

export async function observeMany(products, s) {
  const events = await mapLimit(products, 5, (p) =>
    observeProduct(p, s).catch((e) => {
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
  if (!s.stock_group) return sent;
  for (let i = 0; i < ALERTS_PER_TICK && Date.now() + 10000 < deadline; i++) {
    const ev = await db.redis().lpop(db.K.stockAlerts);
    if (!ev) break;
    const rec = await getRecord(ev.pid);
    if (!rec) continue;
    const r = await withPrice(ev.pid, rec);
    try {
      await sendPhotoOrText(s.stock_group, r, ev.type === 'out' ? outAlertCaption(r) : backAlertCaption(r));
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

export async function sendOutList(chatId, page = 0) {
  const all = await outRecords();
  if (!all.length) return tg('sendMessage', { chat_id: chatId, text: "✅ Tugagan mahsulot yo'q." });
  const pages = Math.ceil(all.length / LIST_PAGE);
  const p = Math.min(page, pages - 1);
  const records = await loadRecords(all.slice(p * LIST_PAGE, (p + 1) * LIST_PAGE));
  await sendAlbumList(chatId, records, outListCaption);
  return tg('sendMessage', { chat_id: chatId, text: `❌ Tugaganlar: ${all.length} ta · ${p + 1}/${pages}-sahifa`, ...pager('out', p, pages) });
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
  return sendPhotoOrText(chatId, r, cardCaption(r));
}

// Daily list: summary line + out-of-stock products as albums (photos with the out date).
export async function sendStockReport(chatId, s) {
  const out = await outRecords();
  const low = await lowRecords(s);
  await tg('sendMessage', { chat_id: chatId, text: `📋 Bugungi hisobot: tugagan ${out.length} ta, kam qolgan ${low.length} ta` });
  if (out.length) {
    const records = await loadRecords(out.slice(0, REPORT_MAX));
    await sendAlbumList(chatId, records, outListCaption);
    if (out.length > REPORT_MAX) {
      await tg('sendMessage', { chat_id: chatId, text: `… va yana ${out.length - REPORT_MAX} ta. To'liq ro'yxat: /tugagan`, ...pager('out', 0, 2) });
    }
  }
  return { out: out.length, low: low.length };
}

// ---- tick: watch stock, pass the catalog once a day, alerts, daily list ----

export async function stockTick(s, { deadline = Date.now() + 60000 } = {}) {
  const result = { updated: null, scan: null, alerts: 0, report: null };
  if (!s.stock_group) return { ...result, reason: 'no stock group' };
  // 1) recently changed products
  try {
    const list = [];
    for (let page = 1; page <= UPDATED_PAGES && Date.now() < deadline; page++) {
      list.push(...(await getProductsPage({ page, limit: PAGE, sort: '-updated_at' })).list);
    }
    result.updated = await observeMany(list, s);
  } catch (e) {
    console.error(`stock: recently updated products failed: ${errText(e)}`);
  }
  // 2) the whole catalog, a few pages per tick, once a day
  try {
    const day = db.today();
    let scan = (await db.redis().get(db.K.stockScan)) || {};
    if (scan.day !== day) scan = { day, page: 1, done: false, seen: 0 };
    let pages = 0;
    while (!scan.done && pages < scanPagesPerTick() && Date.now() + 15000 < deadline) {
      const { list } = await getProductsPage({ page: scan.page, limit: PAGE });
      await observeMany(list, s);
      scan.seen += list.length;
      scan.page++;
      pages++;
      if (list.length < PAGE) {
        scan.done = true;
        scan.done_at = Date.now();
        console.log(`stock: catalog pass done (${scan.seen} products)`);
      }
      await db.redis().set(db.K.stockScan, scan);
    }
    result.scan = { day: scan.day, page: scan.page, done: scan.done, seen: scan.seen };
  } catch (e) {
    console.error(`stock: catalog pass failed: ${errText(e)}`);
  }
  // 3) alerts
  result.alerts = await sendAlerts(s, { deadline }).catch((e) => {
    console.error(`stock alerts failed: ${errText(e)}`);
    return 0;
  });
  // 4) daily list at the configured Tashkent time
  if (s.stock_daily && nowHHMM() >= (s.stock_daily_time || '09:00') && (await db.once(`stockdaily:${db.today()}`, 60 * 60 * 30))) {
    result.report = await sendStockReport(s.stock_group, s).catch((e) => {
      console.error(`stock daily list failed: ${errText(e)}`);
      return { error: errText(e) };
    });
  }
  return result;
}

// ---- group updates ----

let botUser = null;
async function botUsername() {
  if (!botUser) botUser = await tg('getMe').catch(() => null);
  return (botUser?.username || '').toLowerCase();
}

export async function handleGroupMessage(msg, s) {
  if (String(msg.chat.id) !== String(s.stock_group) || !s.stock_commands) return;
  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;
  const m = text.match(/^\/(\w+)(?:@(\w+))?(?:\s+(.*))?$/s);
  if (m?.[2] && m[2].toLowerCase() !== (await botUsername())) return; // command for another bot
  const cmd = m?.[1]?.toLowerCase();
  const arg = (m?.[3] || '').trim();
  try {
    if (cmd === 'tugagan' || text === GROUP_BUTTONS.out) return await sendOutList(chatId, 0);
    if (cmd === 'kam' || text === GROUP_BUTTONS.low) return await sendLowList(chatId, s, 0);
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
        text: "📦 Ombor bo'limi\n\n/tugagan — tugagan mahsulotlar\n/kam — kam qolganlar\n/bugun — bugun tugagan va qayta kelganlar\n/sku 3147 — mahsulot kartochkasi",
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
  if (String(chatId) !== String(s.stock_group)) return;
  const [, kind, page] = (cb.data || '').split(':');
  await tg('editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  const n = Number(page) || 0;
  if (kind === 'out') return sendOutList(chatId, n);
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
