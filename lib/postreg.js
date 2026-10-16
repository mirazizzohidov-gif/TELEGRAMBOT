// Channel posts linked to a BITO product, so they can be changed later:
// - "❌ SOTILDI" (mark_sold): the stock scanner sees >0 -> 0 -> the caption gets "❌ SOTILDI" on top and
//   the "🛒 Buyurtma berish" button goes; back in stock -> the original caption and button return.
// - "💲 Narx yangilash" (price_update): the price (price list + discounts) changed -> the price line is
//   rewritten (the 2nd channel's markup recalculated, the discount format kept); a post at most once an hour.
//
// Registry: hash product_id -> [{ chat, mid, kind: 'post' | 'date' | 'helper', ch2, item, dest, fields,
// tags, at, sold }] (90 days). Edits wait in a queue (hash `${chat}:${mid}` -> { pid, why }) and at most
// 30 are made per tick. Captions are rebuilt from the stored item with the same builders as the post.

import { getProductById, loadDiscounts, priceFor } from './bito.js';
import { buildPostCaption } from './caption.js';
import { ch2Item, ch2Settings, markupOf } from './channel2.js';
import { datePost } from './datesend.js';
import { withTags } from './hashtags.js';
import { helperPost } from './helpers.js';
import { orderKb } from './orders.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText } from './util.js';

const KEEP_MS = 90 * 86400000;
const PER_PRODUCT = 20;
export const EDITS_PER_TICK = 30;
const PRICE_EDIT_GAP_MS = 60 * 60 * 1000;
const SOLD = '❌ SOTILDI';
const POSTS = () => `${db.K.flag('posts')}:reg`; // hash pid -> [entry]
const INDEX = () => `${db.K.flag('posts')}:index`; // hash pid -> last post ms (which products to check)
const EDITS = () => `${db.K.flag('posts')}:edits`; // hash `${chat}:${mid}` -> { pid, why }
const CURSOR = () => `${db.K.flag('posts')}:cursor`;

const pick = (i) => ({
  product_id: i.product_id,
  sku: i.sku,
  name: i.name,
  price: i.price,
  old_price: i.old_price,
  type: i.type,
  fresh: i.fresh,
  stock: i.stock,
  desc: i.desc,
  ds_kind: i.ds_kind,
  tags: i.tags,
  image_url: i.image_url,
});

const tracking = (s) => s?.mark_sold !== false || s?.price_update !== false;

export async function getPosts(pid) {
  if (!db.hasRedis() || !pid) return [];
  return (await db.redis().hget(POSTS(), String(pid)).catch(() => null)) || [];
}

async function savePosts(pid, list) {
  const keep = list.filter((e) => Date.now() - (e.at || 0) < KEEP_MS).slice(-PER_PRODUCT);
  if (keep.length) {
    await db.redis().hset(POSTS(), { [String(pid)]: keep });
    await db.redis().hset(INDEX(), { [String(pid)]: Math.max(...keep.map((e) => e.at || 0)) });
  } else {
    await db.redis().hdel(POSTS(), String(pid));
    await db.redis().hdel(INDEX(), String(pid));
  }
}

// Remembers a sent post. entry: { chat, mid, kind, ch2?, item, dest?, fields?, tags? }. Never throws.
export async function recordPost(pid, entry, s) {
  if (!db.hasRedis() || !pid || !entry?.mid || !tracking(s)) return;
  try {
    const list = (await getPosts(pid)).filter((e) => !(String(e.chat) === String(entry.chat) && e.mid === entry.mid));
    list.push({ ...entry, chat: String(entry.chat), item: entry.item ? pick(entry.item) : null, at: Date.now(), sold: false });
    await savePosts(pid, list);
  } catch (e) {
    console.error(`post registry ${pid}: ${errText(e)}`);
  }
}

// The caption and buttons of a post as it should look now.
export function renderPost(e, s) {
  let caption;
  let kb;
  if (e.kind === 'date') {
    const p = datePost(e.item, e.dest, s);
    caption = p.caption;
    kb = p.reply_markup;
  } else if (e.kind === 'helper') {
    const p = helperPost(e.item, e.dest, s, e.fields);
    caption = withTags(p.caption, e.tags);
    kb = p.reply_markup;
  } else {
    const st = e.ch2 ? ch2Settings(s) : s;
    const it = e.ch2 ? ch2Item(e.item, markupOf(s)) : e.item;
    caption = withTags(buildPostCaption(it, st.phone, { lowAt: db.limit(s, 'low_stock_threshold'), desc: s.ai_channel !== false }), it.tags);
    kb = orderKb(st, it);
  }
  if (e.sold) return { caption: `${SOLD}\n\n${caption}`, reply_markup: { inline_keyboard: [] } };
  return { caption, reply_markup: kb };
}

// The "📝" AI description written later (lib/ai.js backfill): kept on the post so later edits keep it.
// Returns the post's entry (or null).
export async function setPostDesc(pid, chat, mid, desc) {
  const list = await getPosts(pid).catch(() => []);
  const e = list.find((x) => String(x.chat) === String(chat) && x.mid === mid);
  if (!e?.item) return e || null;
  e.item.desc = desc;
  await savePosts(pid, list);
  return e;
}

const queueEdit = (e, pid, why) => db.redis().hset(EDITS(), { [`${e.chat}:${e.mid}`]: { pid: String(pid), why } });

// The stock scanner saw >0 -> 0 (sold = true) or 0 -> >0 (sold = false). Returns how many posts change.
export async function markProduct(pid, sold, s) {
  if (!db.hasRedis() || s?.mark_sold === false) return 0;
  const list = await getPosts(pid);
  let n = 0;
  for (const e of list) {
    if (Boolean(e.sold) === sold) continue;
    e.sold = sold;
    await queueEdit(e, pid, sold ? 'sold' : 'back');
    n++;
  }
  if (n) await savePosts(pid, list);
  return n;
}

// A new price for a product ({ price, old_price }): posts showing another price get rewritten.
// The helpers' own typed price is theirs — not changed.
export async function updatePrice(pid, pr, s) {
  if (!db.hasRedis() || s?.price_update === false || !(Number(pr?.price) > 0)) return 0;
  const price = Number(pr.price);
  const old = Number(pr.old_price) > price ? Number(pr.old_price) : 0;
  const list = await getPosts(pid);
  let n = 0;
  for (const e of list) {
    if (e.kind === 'helper' || !e.item) continue;
    if (Number(e.item.price) === price && (Number(e.item.old_price) > Number(e.item.price) ? Number(e.item.old_price) : 0) === old) continue;
    e.item.price = price;
    if (old) e.item.old_price = old;
    else delete e.item.old_price;
    if (!old && e.item.type === 'discount') e.item.type = 'post'; // the discount ended: no "🔥 CHEGIRMA!" header
    await queueEdit(e, pid, 'price');
    n++;
  }
  if (n) await savePosts(pid, list);
  return n;
}

const GONE = /message to edit not found|message_id_invalid|message can't be edited|chat not found|not enough rights|have no rights/i;

// Makes up to `max` queued edits. Returns { edited, sold, back, price, waiting, failed }.
export async function processEdits(s, { max = EDITS_PER_TICK, deadline = Date.now() + 60000 } = {}) {
  const result = { edited: 0, sold: 0, back: 0, price: 0, waiting: 0, failed: 0 };
  if (!db.hasRedis()) return result;
  const jobs = Object.entries((await db.redis().hgetall(EDITS())) || {});
  let done = 0;
  for (const [key, job] of jobs) {
    if (done >= max || Date.now() + 5000 > deadline) break;
    const list = await getPosts(job.pid);
    const e = list.find((x) => `${x.chat}:${x.mid}` === key);
    if (!e) {
      await db.redis().hdel(EDITS(), key);
      continue;
    }
    if (job.why === 'price' && e.price_edited_at && Date.now() - e.price_edited_at < PRICE_EDIT_GAP_MS) continue; // once an hour
    done++;
    const view = renderPost(e, s);
    try {
      await tg('editMessageCaption', { chat_id: e.chat, message_id: e.mid, caption: view.caption.slice(0, 1024), parse_mode: 'HTML', reply_markup: view.reply_markup });
    } catch (err) {
      const why = err.data?.description || errText(err);
      if (err.code === 429) break; // Telegram asks to wait: the rest next tick
      if (!/not modified/i.test(why)) {
        if (GONE.test(why)) {
          // the post was deleted (or the bot cannot edit there): forget it, quietly
          await savePosts(job.pid, list.filter((x) => x !== e));
        } else {
          console.error(`post edit ${key}: ${why}`);
          result.failed++;
        }
        await db.redis().hdel(EDITS(), key);
        continue;
      }
    }
    e.edited_at = Date.now();
    if (job.why === 'price') e.price_edited_at = Date.now();
    await savePosts(job.pid, list);
    await db.redis().hdel(EDITS(), key);
    result.edited++;
    result[job.why] = (result[job.why] || 0) + 1;
    await db.incrStat(job.why === 'price' ? 'price_updated' : job.why === 'sold' ? 'sold_marked' : 'sold_unmarked').catch(() => {});
  }
  result.waiting = Object.keys((await db.redis().hgetall(EDITS())) || {}).length;
  return result;
}

// "💲 Narx yangilash": a few posted products per tick (in turn) get their price checked.
export async function checkPrices(s, { max = 10, deadline = Date.now() + 60000 } = {}) {
  const result = { checked: 0, changed: 0 };
  if (!db.hasRedis() || s?.price_update === false) return result;
  const index = (await db.redis().hgetall(INDEX())) || {};
  const pids = Object.keys(index)
    .filter((pid) => Date.now() - Number(index[pid]) < KEEP_MS)
    .sort();
  if (!pids.length) return result;
  let at = Number(await db.redis().get(CURSOR())) || 0;
  if (at >= pids.length) at = 0;
  const discounts = await loadDiscounts().catch(() => []);
  let i = 0;
  for (; i < Math.min(max, pids.length) && Date.now() + 5000 < deadline; i++) {
    const pid = pids[(at + i) % pids.length];
    try {
      const p = await getProductById(pid);
      const pr = await priceFor(p, discounts);
      result.checked++;
      if (await updatePrice(pid, pr, s)) result.changed++;
    } catch (e) {
      console.error(`price check ${pid}: ${errText(e)}`);
    }
  }
  await db.redis().set(CURSOR(), (at + i) % pids.length);
  return result;
}
