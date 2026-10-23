// "📥 BITO buyurtma xabari": a new BITO sale order is sent to the Telegram chats an admin picked.
// Destinations live in settings (bito_order_chats / bito_order_admins), the same store as the rest of
// the admin panel. This does not touch the in-bot "🛒 Buyurtma" flow.

import { bitoGet, bitoPost, formatPrice } from './bito.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const SECRET_RE = /token|secret|password|api[_-]?key|private/i;

export function parseBitoChatId(text) {
  const t = String(text || '').trim();
  if (/^@[A-Za-z0-9_]{4,}$/.test(t)) return t;
  if (/^-\d{5,}$/.test(t)) return t;
  return '';
}

export function parseBitoAdminId(text) {
  const t = String(text || '').trim();
  return /^\d{4,15}$/.test(t) ? t : '';
}

const asList = (v) => (Array.isArray(v) ? v : []);

export function bitoOrderChats(s) {
  return [...new Set(asList(s?.bito_order_chats).map((x) => String(x?.id || x || '').trim()).filter(Boolean))];
}

export function bitoOrderAdmins(s) {
  return [...new Set(asList(s?.bito_order_admins).map((x) => String(x || '').trim()).filter(Boolean))];
}

export function bitoOrderId(order) {
  const id = order?._id || order?.id || order?.number || order?.uuid || order?.code;
  return id === undefined || id === null || id === '' ? '' : String(id);
}

function customerName(order) {
  const c = order?.customer;
  if (c && typeof c === 'object') {
    return String(c.name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '').trim();
  }
  if (typeof c === 'string') return c.trim();
  return String(order?.customer_name || '').trim();
}

function phoneOf(order) {
  const c = order?.customer && typeof order.customer === 'object' ? order.customer : {};
  const raw = c.phone_number || asList(c.phone_numbers).find(Boolean) || order?.phone || order?.phone_number || '';
  const s = String(raw || '').trim();
  if (!s || SECRET_RE.test(s)) return '';
  return s;
}

function linkOf(order) {
  const c = order?.customer && typeof order.customer === 'object' ? order.customer : {};
  for (const v of [order?.url, order?.link, order?.order_url, c.url, c.link]) {
    const s = String(v || '').trim();
    if (!s || SECRET_RE.test(s)) continue;
    if (/^https?:\/\/\S+$/i.test(s)) return s;
    if (/^t\.me\/\S+$/i.test(s)) return `https://${s}`;
  }
  return '';
}

function sumOf(order) {
  for (const k of ['total_to_pay', 'total_price', 'total_sale', 'total']) {
    const v = order?.[k];
    if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function fmtTime(ms) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(ms);
  const g = (t) => p.find((x) => x.type === t)?.value || '';
  return `${g('day')}.${g('month')}.${g('year')} ${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}`;
}

function timeOf(order) {
  const ms = Date.parse(order?.date || order?.created_at || '');
  return Number.isFinite(ms) ? fmtTime(ms) : '';
}

function itemRows(order) {
  const list = asList(order?.products).length ? order.products : asList(order?.items);
  const rows = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const name = String(it.product?.name || it.name || it.product_name || '').trim();
    const qty = it.amount ?? it.quantity ?? it.qty;
    const hasQty = qty !== undefined && qty !== null && qty !== '' && Number.isFinite(Number(qty));
    if (!name && !hasQty) continue;
    rows.push([name, hasQty ? Number(qty) : null]);
  }
  return rows;
}

// Uzbek HTML message. Missing fields are left out. Only the fields below are read, so tokens and
// other secrets on the payload are never copied in.
export function formatBitoOrder(order) {
  const id = bitoOrderId(order);
  const lines = [`🛒 <b>Yangi BITO buyurtma${id ? ` #${esc(id)}` : ''}</b>`];
  const name = customerName(order);
  const phone = phoneOf(order);
  const link = linkOf(order);
  if (name) lines.push('', `👤 Mijoz: ${esc(name)}`);
  else if (phone || link) lines.push('');
  if (phone) lines.push(`📞 ${esc(phone)}`);
  if (link) lines.push(`🔗 ${esc(link)}`);
  const items = itemRows(order);
  if (items.length) {
    lines.push('', '📦 Mahsulotlar:');
    for (const [name, qty] of items) {
      const bit = [name ? esc(name) : '', qty !== null ? `${qty} dona` : ''].filter(Boolean).join(' — ');
      lines.push(`• ${bit}`);
    }
  }
  const sum = sumOf(order);
  const time = timeOf(order);
  if (sum !== null || time) lines.push('');
  if (sum !== null) lines.push(`💰 Jami: ${formatPrice(sum)} so'm`);
  if (time) lines.push(`🕘 Vaqt: ${time}`);
  return lines.join('\n');
}

export function bitoOrderTargets(s) {
  return [...bitoOrderChats(s), ...bitoOrderAdmins(s)];
}

// Sends one message to every configured chat. One failure is logged and the rest still go out.
export async function notifyBitoOrder(order, settings) {
  const s = settings || (await db.getSettings());
  const text = formatBitoOrder(order);
  const id = bitoOrderId(order);
  const sent = [];
  const failed = [];
  if (s?.bito_order_notify !== true) return { id, text, sent, failed, skipped: 'off' };
  for (const chatId of bitoOrderTargets(s)) {
    try {
      await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
      sent.push(String(chatId));
    } catch (e) {
      const error = errText(e);
      console.error(`BITO order ${id || '?'} -> ${chatId}: ${error}`);
      failed.push({ chat_id: String(chatId), error });
      await db.logError(`BITO buyurtma ${id || '?'} -> ${chatId}: ${error}`).catch(() => {});
    }
  }
  return { id, text, sent, failed };
}

async function remember(id, value) {
  if (!id || !db.hasRedis()) return;
  await db.redis().hset(db.K.bitoOrderSeen, { [id]: value });
}

const claimKey = (id) => db.K.flag(`bito-order:${id}`);

// One claim per order, shared by the 15-minute tick and GET /api/bito-orders.
async function claimOrder(id) {
  if (!id || !db.hasRedis()) return true;
  return (await db.redis().set(claimKey(id), 1, { nx: true, ex: 60 * 60 * 24 * 7 })) === 'OK';
}

async function releaseOrder(id) {
  if (!id || !db.hasRedis()) return;
  await db.redis().del(claimKey(id));
}

// Notify unless this order was already delivered. A failed send is not marked, so a later poll retries.
export async function acceptBitoOrder(order, settings) {
  const s = settings || (await db.getSettings());
  const id = bitoOrderId(order);
  if (s?.bito_order_notify !== true) return { id, sent: [], failed: [], skipped: 'off' };
  let tries = 0;
  if (id && db.hasRedis()) {
    const prev = await db.redis().hget(db.K.bitoOrderSeen, id);
    tries = Number(prev?.tries) || 0;
    if (prev?.sent || prev?.silent || tries >= 3) return { id, sent: [], failed: [], skipped: prev?.sent ? 'duplicate' : 'seen' };
  }
  if (!(await claimOrder(id))) return { id, sent: [], failed: [], skipped: 'duplicate' };
  const result = await notifyBitoOrder(order, s);
  if (id && result.sent.length) await remember(id, { at: Date.now(), sent: true });
  else if (id && result.failed.length) {
    await remember(id, { at: Date.now(), sent: false, tries: tries + 1 });
    await releaseOrder(id);
  } else if (id) await releaseOrder(id);
  return result;
}

const pageList = (data) => (Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : []);

async function orderDetail(row) {
  if (itemRows(row).length) return row;
  const id = row?._id || row?.id;
  if (!id) return row;
  try {
    const full = await bitoGet(`/sale-order/get-by-id/${encodeURIComponent(id)}`);
    if (full && typeof full === 'object') return { ...row, ...full };
  } catch (e) {
    console.error(`BITO order detail ${bitoOrderId(row) || id}: ${errText(e)}`);
  }
  return row;
}

// First look only remembers the orders already in BITO, so old ones are not announced.
export async function pollBitoOrders(settings) {
  const s = settings || (await db.getSettings());
  if (s?.bito_order_notify !== true) return { skipped: 'off' };
  if (!bitoOrderTargets(s).length) return { skipped: 'no destinations' };
  if (!db.hasRedis()) return { skipped: 'no redis' };
  const seen = (await db.redis().hgetall(db.K.bitoOrderSeen)) || {};
  const data = await bitoPost('/sale-order/get-paging', { page: 1, limit: 30 });
  const list = pageList(data).filter((o) => o && typeof o === 'object');
  if (!seen.__primed) {
    const mark = { __primed: { at: Date.now() } };
    for (const row of list) {
      const id = bitoOrderId(row);
      if (id && !seen[id]) mark[id] = { at: Date.now(), sent: false, silent: true };
    }
    await db.redis().hset(db.K.bitoOrderSeen, mark);
    return { primed: true, seen: Object.keys(mark).length - 1, notified: 0 };
  }
  const fresh = list
    .filter((row) => {
      const id = bitoOrderId(row);
      return id && !seen[id]?.sent && !seen[id]?.silent;
    })
    .sort((a, b) => (Date.parse(a.created_at || a.date || 0) || 0) - (Date.parse(b.created_at || b.date || 0) || 0))
    .slice(0, 8);
  const results = [];
  for (const row of fresh) {
    results.push(await acceptBitoOrder(await orderDetail(row), s));
  }
  return { notified: results.filter((r) => r.sent?.length).length, failed: results.reduce((n, r) => n + (r.failed?.length || 0), 0), results };
}
