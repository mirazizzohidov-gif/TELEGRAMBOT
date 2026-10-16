// Sales numbers from BITO's Integration API reports (docs.bito.uz/api/report-sales.html — "/reports/...",
// plural), and what is built on them:
// - "📉 Sotilmayotganlar": in stock, but not sold for N days (money lying on the shelf) -> discount idea
// - "🛒 Buyurtma qilish kerak": selling fast, stock lasts only a few days -> order before it runs out
// - "📈 Haftalik hisobot": top sellers, out / back this week, totals, a short AI summary
//
// Sales: POST /reports/trade/by-product/pagin — one row per sold line ({ amount, total_price, product })
// or per product ({ product_id, items_sold, net_sales }); rows are added up per product either way.
// Unsold: POST /reports/sales/items/unsold-paging. BITO_SALES_PATH / BITO_UNSOLD_PATH (optional) are
// tried first; the path that answers is remembered.

import { aiEnabled, callGemini } from './ai.js';
import { bitoPost, formatPrice } from './bito.js';
import * as db from './store.js';
import { notifyAdmins } from './report.js';
import { tg } from './telegram.js';
import { clock, errText } from './util.js';

export const SALES_PATHS = ['/reports/trade/by-product/pagin', '/reports/trade/items/pagin'];
export const UNSOLD_PATHS = ['/reports/sales/items/unsold-paging'];
const PAGE = 200;
const MAX_PAGES = 60;
const DAY = 86400000;

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tashkentDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
const iso = (day, end) => `${day}T${end ? '23:59:59' : '00:00:00'}+05:00`;

const REPORTS = {
  sales: { env: 'BITO_SALES_PATH', paths: SALES_PATHS, key: () => db.K.salesPath },
  unsold: { env: 'BITO_UNSOLD_PATH', paths: UNSOLD_PATHS, key: () => `${db.K.salesPath}:unsold` },
};

async function reportPaths(kind) {
  const r = REPORTS[kind];
  const env = process.env[r.env];
  const saved = db.hasRedis() ? await db.redis().get(r.key()).catch(() => null) : null;
  return [...new Set([env, saved, ...r.paths].filter(Boolean))];
}

// One page; tries the paths until one answers (then remembered). Throws with what every path said.
async function reportPage(kind, payload) {
  const tried = [];
  for (const path of await reportPaths(kind)) {
    try {
      const data = await bitoPost(path, payload);
      if (db.hasRedis()) await db.redis().set(REPORTS[kind].key(), path).catch(() => {});
      return data;
    } catch (e) {
      tried.push(`${path}: ${e.details?.message || e.details?.http_status || errText(e)}`);
      // a path that exists but refuses (rights, bad request) is not "try the next form"
      if (e.details?.http_status && e.details.http_status !== 404 && !/not found|route/i.test(String(e.details.message))) break;
    }
  }
  throw Object.assign(new Error(`BITO ${kind === 'unsold' ? 'sotilmayotganlar' : 'sotuv'} hisobotini olib bo'lmadi (${tried.join('; ')})`), { tried });
}

// The body per docs (date_from / date_to) plus from_date / to_date to be safe.
const reportBody = (page, from, to) => ({ page, limit: PAGE, date_from: iso(from), date_to: iso(to, true), from_date: iso(from), to_date: iso(to, true) });

// { data: { list, total } } | { data: { data, total, total_amounts } } | { data: [...] } -> { list, total, totals }
export function reportList(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : Array.isArray(data?.data) ? data.data : [];
  return { list, total: Number(data?.total) || 0, totals: data?.total_data || data?.total_amounts || null };
}

const num = (...v) => {
  for (const x of v) if (x !== undefined && x !== null && x !== '' && Number.isFinite(Number(x))) return Number(x);
  return 0;
};

// One report row -> { pid, name, sold, net, category } (a sold line or a product total).
export function saleRow(r) {
  const p = r.product && typeof r.product === 'object' ? r.product : null;
  const pid = r.product_id || p?._id || (p || r.amount !== undefined ? null : r._id);
  return {
    pid: pid ? String(pid) : null,
    name: r.product_name || p?.name || r.name || '',
    sold: num(r.items_sold, r.amount, r.quantity) - num(r.items_refunded),
    net: num(r.net_sales, r.total_price, r.gross_sales, num(r.price) * num(r.amount)),
    category: r.category_name || r.category?.name || p?.category?.name || '',
  };
}

const cancelled = (r) => /cancel|refund|return|delete/i.test(String(r.state || ''));

// Sales by product for the last `days` days: { rows: [{ pid, name, sold, net, category }], total }.
export async function salesByItem(days) {
  const to = Date.now();
  const key = `sales2:${days}:${tashkentDay(to)}`;
  return db.cached(key, 60 * 60, async () => {
    const from = tashkentDay(to - (days - 1) * DAY);
    const till = tashkentDay(to);
    const by = new Map();
    let totals = null;
    let seen = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { list, total, totals: t } = reportList(await reportPage('sales', reportBody(page, from, till)));
      totals ||= t;
      for (const raw of list) {
        if (cancelled(raw)) continue;
        const r = saleRow(raw);
        if (!r.pid) continue;
        const cur = by.get(r.pid) || { pid: r.pid, name: r.name, sold: 0, net: 0, category: r.category };
        cur.sold += r.sold;
        cur.net += r.net;
        by.set(r.pid, cur);
      }
      seen += list.length;
      if (list.length < PAGE || (total && seen >= total)) break;
    }
    const rows = [...by.values()];
    const sum = (f) => rows.reduce((n, r) => n + r[f], 0);
    return {
      rows,
      total: {
        sold: num(totals?.items_sold, totals?.amount, sum('sold')),
        net: num(totals?.net_sales, totals?.total_price, sum('net')),
        gross: num(totals?.gross_sales, totals?.total_price),
      },
    };
  });
}

async function stockRecords() {
  const all = (await db.redis().hgetall(db.K.stock)) || {};
  return Object.entries(all).map(([pid, r]) => ({ ...r, pid }));
}

// BITO's "unsold" report: products with stock and no sale in the period ({ _id, product_name,
// quantity (stock), items_sold, days_in_warehouse }). Rows that did sell are dropped; if the report did
// not filter at all (every row sold), null — the caller works it out from the sales report instead.
async function unsoldFromReport(days) {
  const to = Date.now();
  const from = tashkentDay(to - (days - 1) * DAY);
  const till = tashkentDay(to);
  const out = [];
  let rows = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { list, total } = reportList(await reportPage('unsold', reportBody(page, from, till)));
    rows += list.length;
    for (const r of list) {
      const pid = String(r.product_id || r.product?._id || r._id || '');
      if (!pid || num(r.items_sold) > 0) continue;
      out.push({ pid, name: r.product_name || r.product?.name || r.name || '', stock: num(r.quantity, r.stock), days: num(r.days_in_warehouse) });
    }
    if (list.length < PAGE || (total && rows >= total)) break;
  }
  return rows && !out.length ? null : out;
}

// "📉 Sotilmayotganlar": in stock, not sold in the last N days; most money first (stock × price).
// From BITO's unsold report (enriched with SKU / price from the stock records); if that report fails
// or does not filter, from the sales report (in stock and not in it).
export async function slowMovers(s, { limit = 30 } = {}) {
  const days = db.limit(s, 'unsold_days');
  const records = await stockRecords();
  const byPid = new Map(records.map((r) => [String(r.pid), r]));
  let source = 'unsold';
  let base = null;
  try {
    const rows = await unsoldFromReport(days);
    if (rows) {
      base = rows
        .map((r) => ({ ...(byPid.get(r.pid) || {}), pid: r.pid, name: byPid.get(r.pid)?.name || r.name, stock: r.stock || byPid.get(r.pid)?.stock || 0, days_in_warehouse: r.days }))
        .filter((r) => r.stock > 0);
    }
  } catch (e) {
    console.error(`unsold report: ${errText(e)} — using the sales report`);
  }
  if (!base) {
    source = 'sales';
    const { rows } = await salesByItem(days);
    const sold = new Set(rows.filter((r) => r.sold > 0).map((r) => r.pid));
    base = records.filter((r) => r.stock > 0 && !sold.has(String(r.pid)) && (!r.seen_at || Date.now() - r.seen_at > 3 * DAY));
  }
  const list = base.map((r) => ({ ...r, money: r.stock * (Number(r.price) || 0) })).sort((a, b) => b.money - a.money || b.stock - a.stock);
  return { days, source, total: list.length, list: list.slice(0, limit), money: list.reduce((n, r) => n + r.money, 0) };
}

// "🛒 Buyurtma qilish kerak": sold in the last 14 days, the stock lasts <= N days at that speed.
export async function reorderList(s, { limit = 40 } = {}) {
  const horizon = db.limit(s, 'reorder_days');
  const { rows } = await salesByItem(14);
  const speed = new Map(rows.filter((r) => r.sold >= 2).map((r) => [r.pid, r.sold / 14]));
  const list = (await stockRecords())
    .filter((r) => r.stock > 0 && speed.has(String(r.pid)))
    .map((r) => ({ ...r, perDay: speed.get(String(r.pid)), daysLeft: r.stock / speed.get(String(r.pid)) }))
    .filter((r) => r.daysLeft <= horizon)
    .sort((a, b) => a.daysLeft - b.daysLeft || b.perDay - a.perDay);
  return { horizon, total: list.length, list: list.slice(0, limit) };
}

const fmtNum = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toString().replace('.', ',');

export function reorderLines(r) {
  if (!r.total) return [`🛒 Buyurtma qilish kerak: yo'q — tez sotilayotganlarning qoldig'i ${r.horizon} kundan ko'proqqa yetadi.`];
  return [
    `🛒 Buyurtma qilish kerak (qoldig'i ≤ ${r.horizon} kunga yetadi): ${r.total} ta`,
    '',
    ...r.list.map((x, i) => `${i + 1}. ${x.name} — SKU ${x.sku} — qoldiq ${x.stock} — kuniga ~${fmtNum(x.perDay)} — ~${fmtNum(x.daysLeft)} kunga`),
  ];
}

export function slowLines(r) {
  if (!r.total) return [`📉 Sotilmayotgan tovar yo'q: sotuvdagi hamma mahsulot oxirgi ${r.days} kunda sotilgan.`];
  return [
    `📉 Oxirgi ${r.days} kunda sotilmagan (sotuvda bor): ${r.total} ta${r.money ? `, ~${formatPrice(r.money)} so'mlik tovar` : ''}`,
    '',
    ...r.list.map((x, i) => `${i + 1}. ${x.name}${x.sku ? ` — SKU ${x.sku}` : ''} — qoldiq ${x.stock}${x.price > 0 ? ` — ${formatPrice(x.price)} so'm` : ''}${x.days_in_warehouse ? ` — omborda ${x.days_in_warehouse} kun` : ''}`),
  ];
}

// "📈 Haftalik hisobot"
export async function weeklyReport(s) {
  const lines = [];
  let week = null;
  try {
    week = await salesByItem(7);
  } catch (e) {
    lines.push(`⚠️ ${esc(errText(e))}`);
  }
  const days = Array.from({ length: 7 }, (_, i) => tashkentDay(Date.now() - i * DAY));
  const events = (await Promise.all(days.map((d) => db.redis().lrange(db.K.stockDay(d), 0, -1).catch(() => [])))).flat().filter(Boolean);
  const outN = new Set(events.filter((e) => e.type === 'out').map((e) => e.pid)).size;
  const backN = new Set(events.filter((e) => e.type === 'back').map((e) => e.pid)).size;
  const head = [`📈 <b>Haftalik hisobot</b> (${days[6]} — ${days[0]})`, ''];
  const top = week ? [...week.rows].sort((a, b) => b.sold - a.sold).slice(0, 10) : [];
  if (week?.total) head.push(`💰 Sotuv: ${formatPrice(week.total.net)} so'm, ${week.total.sold} dona`);
  head.push(`❌ Tugagan: ${outN} ta mahsulot, ✅ qayta kelgan: ${backN} ta`);
  let reorder = null;
  let slow = null;
  if (week) {
    reorder = await reorderList(s).catch(() => null);
    slow = await slowMovers(s).catch(() => null);
    if (reorder) head.push(`🛒 Buyurtma qilish kerak: ${reorder.total} ta`);
    if (slow) head.push(`📉 ${slow.days} kunda sotilmagan: ${slow.total} ta`);
  }
  if (top.length) head.push('', '🏆 Eng ko\'p sotilganlar:', ...top.map((r, i) => `${i + 1}. ${esc(r.name)} — ${r.sold} dona`));
  // a short AI summary of the numbers above
  if (aiEnabled(s) && top.length) {
    try {
      const text = await callGemini(
        [
          {
            text:
              "Sen do'kon egasiga haftalik savdo bo'yicha 2-3 gaplik qisqa xulosa va bitta amaliy maslahat yozasan. Faqat o'zbek tilida (lotin), oddiy matn, raqamlarni o'ylab topma.\n\n" +
              [...head, ...lines].join('\n'),
          },
        ],
        { temperature: 0.4 },
      );
      head.push('', `🤖 ${esc(text.replace(/[*_#`]/g, '').trim().replace(/^["«“]+|["»”]+$/g, ''))}`);
    } catch (e) {
      console.error(`weekly AI summary: ${errText(e)}`);
    }
  }
  return [...head, ...(lines.length ? ['', ...lines] : [])].join('\n');
}

// ---- the 15-minute tick ----
// Daily (at the stock list time): "🛒 Buyurtma qilish kerak" to the report group (or the admins);
// Mondays at that time: "📈 Haftalik hisobot" to the admins. A failed send is tried again next tick.
const tashkentParts = (ms) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );

export async function salesTick(s, { now = clock.now(), reportChat = null } = {}) {
  const result = {};
  const p = tashkentParts(now);
  const hhmm = `${p.hour === '24' ? '00' : p.hour}:${p.minute}`;
  if (hhmm < (s.stock_daily_time || '09:00')) return result;
  const day = tashkentDay(now);
  const send = async (text, html = false) => {
    if (reportChat) {
      for (const part of splitText(text)) await tg('sendMessage', { chat_id: reportChat, text: part, ...(html ? { parse_mode: 'HTML' } : {}) });
    } else {
      for (const part of splitText(text)) await notifyAdmins({ text: part, ...(html ? { parse_mode: 'HTML' } : {}) });
    }
  };
  if (s.reorder_daily !== false && (await db.once(`reorder:${day}`, 60 * 60 * 30))) {
    try {
      const r = await reorderList(s);
      await send(reorderLines(r).join('\n'));
      result.reorder = r.total;
    } catch (e) {
      await db.clearFlag(`reorder:${day}`);
      result.reorder_error = errText(e);
      console.error(`reorder list: ${errText(e)}`);
    }
  }
  if (s.weekly_report !== false && p.weekday === 'Mon' && (await db.once(`weekly:${day}`, 60 * 60 * 30))) {
    try {
      const text = await weeklyReport(s);
      for (const part of splitText(text)) await notifyAdmins({ text: part, parse_mode: 'HTML' });
      result.weekly = true;
    } catch (e) {
      await db.clearFlag(`weekly:${day}`);
      result.weekly_error = errText(e);
      console.error(`weekly report: ${errText(e)}`);
    }
  }
  return result;
}

function splitText(text, limit = 3900) {
  const out = [];
  let cur = '';
  for (const l of String(text).split('\n')) {
    if (cur && cur.length + l.length + 1 > limit) {
      out.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${l}` : l;
  }
  if (cur) out.push(cur);
  return out;
}
