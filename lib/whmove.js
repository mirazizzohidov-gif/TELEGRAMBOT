// "📦 Skladdan olib chiqish": what to bring from the sklad to the shop — 0 in do'kon but some in sklad (❌),
// and 1-2 left in do'kon with some in sklad (⚠️). Every morning (cfg.time, default 09:00 Tashkent) it goes
// to the chosen group / topic, split by the main categories (the BITO category; products without one are
// sorted by AI from the photo). A category may have its own topic. Every line has a "✅ n" button: staff
// tick what they brought; at 21:00 the owner gets how much was brought.
// Sending is paced (Telegram: ~20 messages a minute in a group): what does not fit goes on next tick.
import { callGemini, imagePart, parseJson, aiConfigured } from './ai.js';
import { getAllCategories } from './bito.js';
import { channel2Owner } from './channel2.js';
import { soldItems } from './soldweb.js';
import { routeGroup } from './stock.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { clock } from './util.js';
import { whState } from './whstock.js';

const F = (x) => `${db.K.flag('whmove')}:${x}`;
const CFG = () => F('cfg'); // { on, chat, thread, time, topics: { category: thread } }
const AICAT = () => F('aicat'); // hash pid -> category (AI)
const PENDING = () => F('pending'); // list of parts still to send
const RUN = (day) => F(`run:${day}`); // hash `${chat}:${mid}` -> { cat, items: [{ t, line }], done: [i] }
const PER_MSG = 30;
const OTHER = 'Boshqa';
const r = () => db.redis();
const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const hhmm = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false });
const dayText = () => new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Tashkent' }).replace(/\//g, '.');

// ---- settings ----

// "https://t.me/c/1234567890/45/120" (a message in a topic) -> { chat: '-1001234567890', thread: 45 };
// "https://t.me/c/1234567890/45" -> thread 45; a plain number -> thread.
export function parseTopic(v) {
  const t = String(v ?? '').trim();
  if (!t) return { thread: null };
  if (/^\d+$/.test(t)) return { thread: Number(t) };
  const m = t.match(/t\.me\/c\/(\d+)\/(\d+)(?:\/(\d+))?/);
  if (m) return { chat: `-100${m[1]}`, thread: Number(m[2]) || null };
  return { error: `Tema tushunilmadi: ${t.slice(0, 60)}` };
}

export async function whMoveCfg(s) {
  const c = (await r().get(CFG())) || {};
  return { on: c.on !== false, chat: c.chat || routeGroup(s || {}, 'report') || '', thread: c.thread || null, time: c.time || (s && s.stock_daily_time) || '09:00', topics: c.topics || {} };
}

export async function mainCategories() {
  const raw = await getAllCategories().catch(() => null);
  const list = Array.isArray(raw?.list) ? raw.list : [];
  return list.filter((c) => !c.parent_id).map((c) => c.name).sort((a, b) => a.localeCompare(b));
}

export async function whMoveView(s) {
  return { ok: true, cfg: await whMoveCfg(s), categories: await mainCategories() };
}

export async function whMoveSetCfg(body = {}) {
  const cur = (await r().get(CFG())) || {};
  const next = { ...cur };
  if ('on' in body) next.on = Boolean(body.on);
  if ('time' in body) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(body.time))) return { ok: false, message: 'Vaqt HH:MM bo\'lsin, masalan 09:00' };
    next.time = String(body.time);
  }
  if ('chat' in body) {
    const c = String(body.chat || '').trim();
    const p = c.includes('t.me/') ? parseTopic(c) : null;
    if (c && !p && !/^-?\d+$/.test(c)) return { ok: false, message: "Guruh ID raqam bo'lsin (masalan -1001234567890) yoki temadagi xabar havolasi" };
    next.chat = p?.chat || c || null;
    if (p?.thread) next.thread = p.thread;
  }
  if ('thread' in body) {
    const p = parseTopic(body.thread);
    if (p.error) return { ok: false, message: p.error };
    if (p.chat) next.chat = p.chat;
    next.thread = p.thread;
  }
  if (body.topics && typeof body.topics === 'object') {
    const topics = {};
    for (const [cat, v] of Object.entries(body.topics)) {
      const p = parseTopic(v);
      if (p.error) return { ok: false, message: `${cat}: ${p.error}` };
      if (p.thread) topics[String(cat).slice(0, 60)] = p.thread;
    }
    next.topics = topics;
  }
  await r().set(CFG(), next);
  return { ok: true, message: '💾 Saqlandi' };
}

// ---- categories (AI for products without a main category) ----

async function aiCategory(item, cats) {
  const photo = item.image_full ? await imagePart(item.image_full, 384).catch(() => null) : null;
  const prompt = `Do'kon mahsuloti: "${item.name}". Quyidagi asosiy kategoriyalardan bittasini tanla: ${cats.map((c) => `"${c}"`).join(', ')}. Faqat JSON qaytar: {"c":"kategoriya nomi"}.`;
  const text = await callGemini([{ text: prompt }, ...(photo ? [photo] : [])], { json: true });
  const c = parseJson(text)?.c;
  return cats.find((x) => x.toLowerCase() === String(c || '').toLowerCase().trim()) || null;
}

async function categorize(items, cats, deadline) {
  const known = (await r().hgetall(AICAT())) || {};
  const set = new Set(cats);
  let asked = 0;
  for (const x of items) {
    if (x.category && set.has(x.category)) x.mcat = x.category;
    else if (known[x.pid]) x.mcat = known[x.pid];
    else if (aiConfigured() && asked < 25 && Date.now() < deadline - 8000) {
      asked++;
      const c = await aiCategory(x, cats).catch(() => null);
      if (c) {
        x.mcat = c;
        await r().hset(AICAT(), { [x.pid]: c });
      }
    }
    x.mcat ||= OTHER;
  }
}

// ---- building and sending ----

const skladOf = (x) => x.elsewhere.reduce((n, e) => n + e.amount, 0);
const lineOf = (x) => `${x.kind === 'low' ? '⚠️' : '❌'} ${esc(x.name)}${x.sku ? ` · SKU ${esc(x.sku)}` : ''} — skladda <b>${skladOf(x)}</b>${x.kind === 'low' ? `, do'konda ${x.shop}` : ''}`;

function partText(p, done = []) {
  const head = `📦 <b>${esc(p.cat)}</b> — skladdan olib chiqish · ${p.day}${p.of > 1 ? ` (${p.n}/${p.of})` : ''}`;
  const rows = p.items.map((it, i) => (done.includes(i) ? `✅ <s>${i + 1}. ${it.line.replace(/^[❌⚠️]+\s*/u, '')}</s>` : `${i + 1}. ${it.line}`));
  return [head, '', ...rows].join('\n');
}
function partKb(p, done = []) {
  const btn = p.items.map((_, i) => ({ text: done.includes(i) ? `↩️ ${i + 1}` : `✅ ${i + 1}`, callback_data: `wm:${i}` }));
  const rows = [];
  for (let i = 0; i < btn.length; i += 5) rows.push(btn.slice(i, i + 5));
  return { inline_keyboard: rows };
}

// Prepare today's parts (queued), then send as many as fit now.
export async function startWhMove(s, { deadline = Date.now() + 50000 } = {}) {
  const cfg = await whMoveCfg(s);
  if (!cfg.chat) return { ok: false, message: 'Guruh tanlanmagan' };
  const [a, b, cats] = [await soldItems('sklad'), await soldItems('low'), await mainCategories()];
  const items = [...a.items.map((x) => ({ ...x, kind: 'none' })), ...b.items.map((x) => ({ ...x, kind: 'low' }))];
  await categorize(items, cats, deadline - 20000);
  const by = new Map();
  for (const x of items) (by.get(x.mcat) || by.set(x.mcat, []).get(x.mcat)).push(x);
  const day = dayText();
  const parts = [];
  for (const cat of [...by.keys()].sort((x, y) => (x === OTHER) - (y === OTHER) || x.localeCompare(y))) {
    const list = by.get(cat).sort((x, y) => (x.kind === 'none' ? 0 : 1) - (y.kind === 'none' ? 0 : 1) || String(x.name).localeCompare(String(y.name)));
    const of = Math.ceil(list.length / PER_MSG);
    for (let i = 0; i < of; i++) {
      parts.push({ chat: cfg.chat, thread: cfg.topics[cat] || cfg.thread || null, cat, day, n: i + 1, of, d: db.today(), items: list.slice(i * PER_MSG, (i + 1) * PER_MSG).map((x) => ({ t: x.kind, line: lineOf(x) })) });
    }
  }
  if (!parts.length) {
    await tg('sendMessage', { chat_id: cfg.chat, ...(cfg.thread ? { message_thread_id: cfg.thread } : {}), text: `📦 Skladdan olib chiqish · ${day}\n\nBugun olib chiqiladigan mahsulot yo'q ✅` });
    return { ok: true, message: "Olib chiqiladigan mahsulot yo'q — guruhga yozildi", none: 0, low: 0, parts: 0 };
  }
  await r().del(PENDING());
  await r().rpush(PENDING(), ...parts);
  const sent = await sendPending(deadline);
  return { ok: true, none: a.items.length, low: b.items.length, parts: parts.length, sent, message: `📨 ${parts.length} ta xabar: do'konda yo'q ${a.items.length}, kam qolgan ${b.items.length}${sent < parts.length ? ` (qolgani ${parts.length - sent} ta — keyingi daqiqalarda)` : ''}` };
}

export async function sendPending(deadline = Date.now() + 40000) {
  let sent = 0;
  while (Date.now() < deadline - 5000) {
    const list = (await r().lrange(PENDING(), 0, 0)) || [];
    const p = list[0];
    if (!p) break;
    const msg = await tg('sendMessage', { chat_id: p.chat, ...(p.thread ? { message_thread_id: p.thread } : {}), text: partText(p), parse_mode: 'HTML', reply_markup: partKb(p) }).catch((e) => {
      console.error(`whmove send: ${e.message}`);
      return null;
    });
    await r().ltrim(PENDING(), 1, -1); // a part that failed is dropped (wrong topic etc.), not retried forever
    if (msg?.message_id) {
      await r().hset(RUN(p.d), { [`${p.chat}:${msg.message_id}`]: { ...p, done: [] } });
      await r().expire(RUN(p.d), 60 * 60 * 24 * 3);
      sent++;
    }
    await clock.sleep(3200);
  }
  return sent;
}

// ---- ✅ buttons ----

export async function handleWhMoveCallback(cb) {
  const chat = cb.message?.chat?.id;
  const mid = cb.message?.message_id;
  const i = Number(String(cb.data || '').split(':')[1]);
  const answer = (text) => tg('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  let day = db.today();
  let p = await r().hget(RUN(day), `${chat}:${mid}`);
  if (!p) {
    day = db.today(Date.now() - 86400000); // yesterday's list
    p = await r().hget(RUN(day), `${chat}:${mid}`);
  }
  if (!p || !Number.isInteger(i) || !p.items[i]) return answer('Bu ro\'yxat eskirgan');
  const done = new Set(p.done || []);
  const was = done.has(i);
  if (was) done.delete(i);
  else done.add(i);
  p.done = [...done].sort((x, y) => x - y);
  p.by = { ...(p.by || {}), [i]: was ? undefined : cb.from?.first_name || '' };
  await r().hset(RUN(day), { [`${chat}:${mid}`]: p });
  await tg('editMessageText', { chat_id: chat, message_id: mid, text: partText(p, p.done), parse_mode: 'HTML', reply_markup: partKb(p, p.done) }).catch(() => {});
  return answer(was ? `↩️ ${i + 1} qaytarildi` : `✅ ${i + 1} olib chiqildi`);
}

// ---- tick: morning list, pending parts, 21:00 summary to the owner ----

export async function whMoveSummary(day = db.today()) {
  const runs = Object.values((await r().hgetall(RUN(day))) || {});
  if (!runs.length) return null;
  const by = new Map();
  for (const p of runs) {
    const c = by.get(p.cat) || { all: 0, done: 0 };
    c.all += p.items.length;
    c.done += (p.done || []).length;
    by.set(p.cat, c);
  }
  const all = [...by.values()].reduce((n, c) => n + c.all, 0);
  const done = [...by.values()].reduce((n, c) => n + c.done, 0);
  return [`📦 <b>Skladdan olib chiqish — ${dayText()}</b>`, `Olib chiqildi: <b>${done}/${all}</b>, qoldi ${all - done}`, '', ...[...by.entries()].map(([c, x]) => `${x.done === x.all ? '✅' : '▫️'} ${esc(c)}: ${x.done}/${x.all}`)].join('\n');
}

export async function whMoveTick(s, { deadline = Date.now() + 40000 } = {}) {
  const cfg = await whMoveCfg(s);
  const out = {};
  if (cfg.on && cfg.chat && hhmm() >= cfg.time && (await whState()).last_full_at && (await db.once(`whmove:${db.today()}`, 60 * 60 * 30))) {
    out.start = await startWhMove(s, { deadline }).catch((e) => ({ error: e.message }));
  } else if ((await r().llen(PENDING())) > 0) {
    out.sent = await sendPending(deadline);
  }
  if (hhmm() >= '21:00' && (await db.once(`whmovesum:${db.today()}`, 60 * 60 * 30))) {
    const text = await whMoveSummary();
    if (text) await tg('sendMessage', { chat_id: channel2Owner(), text, parse_mode: 'HTML' }).catch((e) => console.error(`whmove summary: ${e.message}`));
    out.summary = Boolean(text);
  }
  return out;
}
