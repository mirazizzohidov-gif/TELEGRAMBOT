// "🧾 Kunlik savdo hisoboti": a day's BITO sales — revenue, refunds, discounts, cost (tannarx), profit,
// items, best sellers and categories, compared with the day before. Sent to the owner every night when
// the day is over (the first 15-minute tick after 23:55, normally 00:00 — so the whole day is in it), and
// on demand from the admin panel. settings.day_report (on by default).
//
// Profit is only as good as the cost prices in BITO: products sold without a cost price count their whole
// price as profit, so the report says how much of the day's sales had no cost price.

import { formatPrice } from './bito.js';
import { channel2Owner } from './channel2.js';
import { tg } from './telegram.js';
import { salesDay } from './sales.js';
import * as db from './store.js';

const DAY = 86400000;
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const change = (now, before) => {
  if (!before) return '';
  const c = Math.round(((now - before) / before) * 100);
  return c === 0 ? ' (kechagidek)' : ` (${c > 0 ? '▲' : '▼'} ${Math.abs(c)}%)`;
};
const showDay = (day) => day.split('-').reverse().join('.');

export const dayReportOn = (s) => s.day_report !== false;

export const tashkentHHMM = (ms = Date.now()) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

// Totals of one day: { gross, refund, discount, net, cost, profit, items, rows }
export async function dayTotals(day) {
  const r = await salesDay(day);
  const t = r.totals || {};
  const rows = r.rows || [];
  const sum = (f) => rows.reduce((a, x) => a + n(x[f]), 0);
  const net = t.net_sales != null ? n(t.net_sales) : sum('net');
  const cost = t.cost != null ? n(t.cost) : sum('cost');
  return {
    day,
    gross: t.gross_sales != null ? n(t.gross_sales) : net,
    refund: n(t.refund),
    discount: n(t.discount),
    net,
    cost,
    profit: t.profit != null ? n(t.profit) : net - cost,
    items: t.items_sold != null ? n(t.items_sold) : sum('sold'),
    refunded: n(t.items_refunded),
    rows,
  };
}

export async function buildDayReport(day = db.today()) {
  const prevDay = db.today(Date.parse(`${day}T12:00:00+05:00`) - DAY);
  const [d, p] = await Promise.all([dayTotals(day), dayTotals(prevDay).catch(() => null)]);
  const lines = [`🧾 <b>Kunlik savdo hisoboti — ${showDay(day)}</b>`, ''];
  if (!d.net && !d.items) {
    lines.push('Bugun sotuv bo\'lmadi.');
    return lines.join('\n');
  }
  lines.push(`💰 Sotuv: <b>${formatPrice(d.gross)}</b>${change(d.gross, p?.gross)}`);
  if (d.refund) lines.push(`↩️ Qaytarildi: ${formatPrice(d.refund)} (${d.refunded} dona)`);
  if (d.discount) lines.push(`🏷 Chegirma: ${formatPrice(d.discount)}`);
  lines.push(`💵 Sof sotuv: <b>${formatPrice(d.net)}</b>`);
  lines.push(`📦 Tannarx: ${formatPrice(d.cost)}`);
  lines.push(`📈 Foyda: <b>${formatPrice(d.profit)}</b> (marja ${pct(d.profit, d.net)}%)${change(d.profit, p?.profit)}`);
  lines.push(`🛍 Sotilgan: ${d.items} dona, ${d.rows.length} xil mahsulot${change(d.items, p?.items)}`);

  // cost prices missing in BITO -> profit is overstated
  const noCost = d.rows.filter((x) => n(x.net) > 0 && n(x.cost) <= 0);
  const withCost = d.rows.filter((x) => n(x.cost) > 0);
  if (noCost.length) {
    const noCostNet = noCost.reduce((a, x) => a + n(x.net), 0);
    lines.push('');
    lines.push(`⚠️ ${noCost.length} ta mahsulotning tannarxi BITO'da kiritilmagan (${formatPrice(noCostNet)} sotuv, ${pct(noCostNet, d.net)}%) — ularning butun narxi foyda bo'lib hisoblandi.`);
    if (withCost.length) {
      const wNet = withCost.reduce((a, x) => a + n(x.net), 0);
      const wProfit = withCost.reduce((a, x) => a + n(x.profit), 0);
      lines.push(`✅ Tannarxi bor mahsulotlar bo'yicha haqiqiy marja: ${pct(wProfit, wNet)}% (${formatPrice(wProfit)} foyda / ${formatPrice(wNet)} sotuv)`);
    }
  }

  const top = [...d.rows].sort((a, b) => n(b.net) - n(a.net)).slice(0, 5);
  lines.push('', '🏆 <b>Eng ko\'p sotilganlar</b>');
  top.forEach((x, i) => lines.push(`${i + 1}. ${esc(x.name)} — ${n(x.sold)} dona, ${formatPrice(x.net)}${n(x.cost) > 0 ? `, foyda ${formatPrice(x.profit)}` : ''}`));

  const cats = new Map();
  for (const x of d.rows) {
    const k = x.category || 'Boshqa';
    const c = cats.get(k) || { net: 0, profit: 0, sold: 0 };
    c.net += n(x.net);
    c.profit += n(x.profit);
    c.sold += n(x.sold);
    cats.set(k, c);
  }
  const topCats = [...cats.entries()].sort((a, b) => b[1].net - a[1].net).slice(0, 5);
  if (topCats.length > 1) {
    lines.push('', '🗂 <b>Kategoriyalar</b>');
    for (const [k, c] of topCats) lines.push(`• ${esc(k)}: ${formatPrice(c.net)} (${c.sold} dona)`);
  }
  if (p?.net) lines.push('', `📅 Kecha (${showDay(prevDay)}): sotuv ${formatPrice(p.gross)}, foyda ${formatPrice(p.profit)}`);
  return lines.join('\n');
}

// Called by the 15-minute job. The report of a day goes out once, when that day is over: at the first tick
// after 23:55 (that day) or before 06:00 (the day before) — normally at 00:00.
export async function dayReportTick(s, now = Date.now()) {
  if (!dayReportOn(s)) return { skipped: 'off' };
  const hhmm = tashkentHHMM(now);
  let day;
  if (hhmm >= '23:55') day = db.today(now);
  else if (hhmm < '06:00') day = db.today(now - DAY);
  else return { skipped: 'not yet' };
  if (!(await db.once(`dayreport:${day}`, 60 * 60 * 24 * 3))) return { skipped: 'sent' };
  try {
    await tg('sendMessage', { chat_id: channel2Owner(), text: (await buildDayReport(day)).slice(0, 4000), parse_mode: 'HTML' });
    return { sent: day };
  } catch (e) {
    await db.clearFlag(`dayreport:${day}`); // BITO trouble: the next tick tries again
    throw e;
  }
}
