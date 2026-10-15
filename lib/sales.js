// Sales numbers from BITO's "sales by item" report, and what is built on them:
// - "📉 Sotilmayotganlar": in stock, but not sold for N days (money lying on the shelf) -> discount idea
// - "🛒 Buyurtma qilish kerak": selling fast, stock lasts only a few days -> order before it runs out
// - "📈 Haftalik hisobot": top sellers, out / back this week, totals, a short AI summary
//
// The Integration API path of the report is not documented for us: a few likely forms are tried and the
// one that answers is remembered (Redis); BITO_SALES_PATH overrides them.

import { aiEnabled, callGemini } from './ai.js';
import { bitoPost, formatPrice } from './bito.js';
import * as db from './store.js';
import { notifyAdmins } from './report.js';
import { tg } from './telegram.js';
import { clock, errText } from './util.js';

const PATHS = ['/report/sales/by-item/pagin', '/report/sales/by-item/paging', '/report/sales-by-item/pagin', '/report/sales/item/pagin', '/report/sales/by_item/pagin'];
const PAGE = 200;
const MAX_PAGES = 30;
const DAY = 86400000;

const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tashkentDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });
const iso = (day, end) => `${day}T${end ? '23:59:59' : '00:00:00'}+05:00`;

async function salesPath() {
  if (process.env.BITO_SALES_PATH) return [process.env.BITO_SALES_PATH];
  const saved = db.hasRedis() ? await db.redis().get(db.K.salesPath).catch(() => null) : null;
  return saved ? [saved, ...PATHS.filter((p) => p !== saved)] : PATHS;
}

// One page; tries the path forms until one answers (then remembered).
async function reportPage(payload) {
  const tried = [];
  for (const path of await salesPath()) {
    try {
      const data = await bitoPost(path, payload);
      if (db.hasRedis()) await db.redis().set(db.K.salesPath, path).catch(() => {});
      return data;
    } catch (e) {
      tried.push(`${path}: ${e.details?.message || e.details?.http_status || errText(e)}`);
      // a known path that fails for another reason (not "not found") is not retried with other paths
      if (e.details?.http_status && e.details.http_status !== 404 && !/not found|route/i.test(String(e.details.message))) break;
    }
  }
  throw Object.assign(new Error(`BITO sotuv hisobotini olib bo'lmadi (${tried.join('; ')})`), { tried });
}

// Sales by product for the last `days` days: Map product_id -> { name, sold, net, category }, totals.
export async function salesByItem(days) {
  const to = Date.now();
  const key = `sales:${days}:${tashkentDay(to)}`;
  return db.cached(key, 60 * 60, async () => {
    const from = to - (days - 1) * DAY;
    const rows = [];
    let total = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await reportPage({ page, limit: PAGE, from_date: iso(tashkentDay(from)), to_date: iso(tashkentDay(to), true) });
      const list = Array.isArray(data?.data) ? data.data : [];
      total ||= data?.total_data || null;
      rows.push(...list.map((r) => ({ pid: String(r.product_id || r._id), name: r.product_name, sold: Number(r.items_sold) || 0, net: Number(r.net_sales) || 0, category: r.category_name || '' })));
      if (list.length < PAGE) break;
    }
    return { rows, total: total ? { sold: Number(total.items_sold) || 0, net: Number(total.net_sales) || 0, gross: Number(total.gross_sales) || 0 } : null };
  });
}

async function stockRecords() {
  const all = (await db.redis().hgetall(db.K.stock)) || {};
  return Object.entries(all).map(([pid, r]) => ({ ...r, pid }));
}

// "📉 Sotilmayotganlar": in stock, not sold in the last N days; most money first (stock × price).
export async function slowMovers(s, { limit = 30 } = {}) {
  const days = db.limit(s, 'unsold_days');
  const { rows } = await salesByItem(days);
  const sold = new Set(rows.filter((r) => r.sold > 0).map((r) => r.pid));
  const list = (await stockRecords())
    .filter((r) => r.stock > 0 && !sold.has(String(r.pid)) && (!r.seen_at || Date.now() - r.seen_at > 3 * DAY))
    .map((r) => ({ ...r, money: r.stock * (Number(r.price) || 0) }))
    .sort((a, b) => b.money - a.money || b.stock - a.stock);
  return { days, total: list.length, list: list.slice(0, limit), money: list.reduce((n, r) => n + r.money, 0) };
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

const num = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10).toString().replace('.', ',');

export function reorderLines(r) {
  if (!r.total) return [`🛒 Buyurtma qilish kerak: yo'q — tez sotilayotganlarning qoldig'i ${r.horizon} kundan ko'proqqa yetadi.`];
  return [
    `🛒 Buyurtma qilish kerak (qoldig'i ≤ ${r.horizon} kunga yetadi): ${r.total} ta`,
    '',
    ...r.list.map((x, i) => `${i + 1}. ${x.name} — SKU ${x.sku} — qoldiq ${x.stock} — kuniga ~${num(x.perDay)} — ~${num(x.daysLeft)} kunga`),
  ];
}

export function slowLines(r) {
  if (!r.total) return [`📉 Sotilmayotgan tovar yo'q: sotuvdagi hamma mahsulot oxirgi ${r.days} kunda sotilgan.`];
  return [
    `📉 Oxirgi ${r.days} kunda sotilmagan (sotuvda bor): ${r.total} ta${r.money ? `, ~${formatPrice(r.money)} so'mlik tovar` : ''}`,
    '',
    ...r.list.map((x, i) => `${i + 1}. ${x.name} — SKU ${x.sku} — qoldiq ${x.stock}${x.price > 0 ? ` — ${formatPrice(x.price)} so'm` : ''}`),
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
