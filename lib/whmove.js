// "📦 Skladdan olib chiqish": every morning (stock report time, default 09:00 Tashkent) the stock report
// group gets the list of what to bring from the sklad to the shop: 0 in do'kon but some in sklad, and
// 1-2 left in do'kon with some in sklad. Off with settings wh_move_daily = false.
import { soldItems } from './soldweb.js';
import { routeGroup } from './stock.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { whState } from './whstock.js';

const MAX_LINES = 120; // per list; the rest is on the dashboard
const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const hhmm = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false });

const skladOf = (x) => x.elsewhere.reduce((n, e) => n + e.amount, 0);

export function whMoveText(none, low, day) {
  const lines = (list, f) => list.slice(0, MAX_LINES).map((x, i) => `${i + 1}. ${esc(x.name)}${x.sku ? ` — SKU ${esc(x.sku)}` : ''} — ${f(x)}`).concat(list.length > MAX_LINES ? [`… yana ${list.length - MAX_LINES} ta — dashboard: ❌ Tugaganlar`] : []);
  const out = [`📦 <b>Skladdan do'konga olib chiqish</b> — ${day}`];
  out.push('', `❌ <b>Do'konda yo'q, skladda bor: ${none.length} ta</b>`, ...(none.length ? lines(none, (x) => `skladda ${skladOf(x)} ta`) : ["— yo'q"]));
  out.push('', `⚠️ <b>Do'konda kam qoldi, skladda bor: ${low.length} ta</b>`, ...(low.length ? lines(low, (x) => `do'konda ${x.shop}, skladda ${skladOf(x)} ta`) : ["— yo'q"]));
  return out;
}

// Telegram: 4096 chars per message
function chunks(lines, max = 3900) {
  const out = [];
  let cur = '';
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > max) {
      out.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur) out.push(cur);
  return out;
}

export async function sendWhMove(chat) {
  const [a, b] = [await soldItems('sklad'), await soldItems('low')];
  const byName = (x, y) => String(x.category || '').localeCompare(String(y.category || '')) || String(x.name).localeCompare(String(y.name));
  const day = new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Tashkent' }).replace(/\//g, '.');
  const parts = chunks(whMoveText([...a.items].sort(byName), [...b.items].sort(byName), day));
  for (const text of parts) await tg('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true });
  return { none: a.items.length, low: b.items.length, messages: parts.length };
}

export async function whMoveTick(s) {
  const chat = routeGroup(s, 'report');
  if (!chat || s.wh_move_daily === false) return null;
  if (hhmm() < (s.wh_move_time || s.stock_daily_time || '09:00')) return null;
  if (!(await whState()).last_full_at) return { reason: 'ombor jadvali hali o\'qilmagan' };
  if (!(await db.once(`whmove:${db.today()}`, 60 * 60 * 30))) return null;
  return sendWhMove(chat).catch((e) => ({ error: e.message }));
}
