// "📋 Navbat": channel posts of new ("🆕") and back-in-stock ("🔄 Qayta keldi") products go out one per
// slot — by default every 15 minutes from 09:00 to 23:00 Tashkent (57 a day). Whatever does not fit
// today waits for the next days, oldest first. At its slot a product is checked in BITO again: stock 0,
// deleted, no photo or no price -> skipped (the next one goes); the price is the current one.
//
// Only these channel posts are paced. Discount posts, the 16:00 random album, posts by SKU, the 2nd
// channel's retry queue, the group posts and the story queue work as before.

import { findBySku, getProductById, loadDiscounts, priceFor, productImage, productStock, toItem } from './bito.js';
import { channel2Target } from './channel2.js';
import { postToChannels } from './poster.js';
import { processRestockQueue } from './restock.js';
import * as db from './store.js';
import { clock, errText } from './util.js';
import { currentSlot, etaOf, paceWindow, slotsPerDay } from './pacetime.js';

export { fmtHHMM, parseHHMM, PACE_FROM, PACE_TO } from './pacetime.js';

// new products found by the 15-minute check and "♻️ yana sotuvda" posts (not the admin's posts:
// item.force, nor what the 16:00 random album left over: item.random)
export const isPaced = (item) => Boolean(item) && !item.force && !item.random && (item.type === 'new' || item.type === 'restock');
const allowed = (s, item) => (item.type === 'new' ? s.new_channel : s.discount_channel);
const postedStat = (item) => (item.type === 'new' ? 'posted' : `${item.type}_posted`);

export const paceOn = (s) => s.pace_on !== false;
export const windowOf = (s) => paceWindow(s, db.limit(s, 'pace_every'));
export const perDay = (s) => slotsPerDay(windowOf(s));
const slotFlag = (slot) => `pace:${slot.key}`;

// ---- the paced list ----

const readPaced = async () => (await db.redis().lrange(db.K.pqueue, 0, -1)) || [];

async function popPaced() {
  const items = await db.redis().lpop(db.K.pqueue, 1);
  return (Array.isArray(items) ? items : items ? [items] : [])[0] || null;
}

const pushFrontPaced = (item) => db.redis().lpush(db.K.pqueue, item);

export const pacedLength = async () => (db.hasRedis() ? Number(await db.redis().llen(db.K.pqueue)) || 0 : 0);

const restockEntries = async () =>
  Object.values((await db.redis().hgetall(db.K.restockQueue)) || {}).sort((a, b) => (a.at || 0) - (b.at || 0));

// Moves the paced items from the channel queue to the paced list (order kept, one product only once).
// Only called while holding the tick lock. Returns how many were moved.
export async function movePaced() {
  if (!db.hasRedis()) return 0;
  const all = (await db.redis().lrange(db.K.queue, 0, -1)) || [];
  const move = all.filter(isPaced);
  if (!move.length) return 0;
  const keep = all.filter((i) => !isPaced(i));
  const have = new Set((await readPaced()).map((i) => String(i.product_id)));
  const add = [];
  for (const i of move) {
    const pid = String(i.product_id);
    if (have.has(pid)) continue;
    have.add(pid);
    add.push({ ...i, queued_at: i.queued_at || Date.now() });
  }
  await db.redis().del(db.K.queue);
  if (keep.length) await db.redis().rpush(db.K.queue, ...keep);
  if (add.length) await db.redis().rpush(db.K.pqueue, ...add);
  return add.length;
}

// Every waiting post, oldest first: [{ kind: 'new' | 'restock', sku, name, at }].
export async function pacedList() {
  if (!db.hasRedis()) return [];
  const [paced, restock] = await Promise.all([readPaced(), restockEntries()]);
  return [
    ...paced.map((i) => ({ kind: i.type === 'restock' ? 'restock' : 'new', sku: i.sku, name: i.name, at: i.queued_at || 0 })),
    ...restock.map((e) => ({ kind: 'restock', sku: e.sku, name: e.name, at: e.at || 0 })),
  ].sort((a, b) => a.at - b.at);
}

// Admin "📋 Navbat" numbers: { total, new, restock, perDay, next: [5], eta }.
export async function pacedSummary(s, now = clock.now()) {
  const list = await pacedList();
  const w = windowOf(s);
  const slot = currentSlot(w, now);
  const free = slot ? !(await db.redis().get(db.K.flag(slotFlag(slot)))) : true;
  return {
    total: list.length,
    new: list.filter((x) => x.kind === 'new').length,
    restock: list.filter((x) => x.kind === 'restock').length,
    perDay: slotsPerDay(w),
    next: list.slice(0, 5),
    eta: list.length ? etaOf(w, list.length, now, free) : null,
  };
}

// "🗑 Navbatni tozalash": both lists. Returns how many were removed.
export async function clearPaced() {
  const n = (await pacedLength()) + (await restockEntries()).length;
  await db.redis().del(db.K.pqueue);
  await db.redis().del(db.K.restockQueue);
  return n;
}

// ---- posting ----

// The product as BITO has it now. undefined = BITO trouble (try again later), null = gone.
async function freshProduct(item) {
  let p;
  try {
    p = await findBySku(String(item.sku), { fresh: true });
  } catch {
    return undefined;
  }
  if (p && String(p._id) === String(item.product_id)) return p;
  return getProductById(item.product_id).catch(() => null);
}

// One "🆕" / "♻️" post from the paced list. Returns { posted, sku?, skipped, error?, wait? }.
async function postNextNew(s, deadline, discounts) {
  const r = { posted: 0, skipped: [], errors: [] };
  const channels = s.channels.filter((c) => c.active);
  while (Date.now() + 30000 < deadline) {
    const item = await popPaced();
    if (!item) return r;
    if (!allowed(s, item)) {
      r.skipped.push(`${item.sku} (kanalga avtopost o'chiq)`);
      continue;
    }
    const p = await freshProduct(item);
    if (p === undefined) {
      await pushFrontPaced(item); // BITO did not answer: the same product next slot
      r.wait = true;
      return r;
    }
    if (!p || productStock(p) <= 0) {
      r.skipped.push(`${item.sku} (qoldiq 0)`);
      continue;
    }
    if (!productImage(p)) {
      r.skipped.push(`${item.sku} (rasmsiz)`);
      continue;
    }
    const pr = await priceFor(p, discounts).catch(() => null);
    if (!pr) {
      await pushFrontPaced(item);
      r.wait = true;
      return r;
    }
    if (!(pr.price > 0)) {
      r.skipped.push(`${item.sku} (narxsiz)`);
      continue;
    }
    const base = { ...item };
    delete base.old_price;
    const fresh = { ...base, ...toItem(p, pr, item.type), fresh: item.fresh, queued_at: item.queued_at };
    if (!channels.length && !channel2Target(s)) {
      await pushFrontPaced(item);
      r.reason = "faol kanal yo'q";
      return r;
    }
    const res = await postToChannels([fresh], s, channels, deadline);
    r.errors.push(...res.errors);
    r.ch2 = res.ch2;
    if (res.leftover.length) {
      await pushFrontPaced(item); // 429 / out of time
      r.wait = true;
      return r;
    }
    if (res.posted.has(fresh)) {
      await db.upsertProduct(fresh, { posted_at: Date.now() });
      await db.incrStat(postedStat(fresh));
      r.posted = 1;
      r.sku = fresh.sku;
    } else {
      await db.incrStat('failed');
    }
    return r;
  }
  r.wait = true;
  return r;
}

// One slot: the oldest waiting product (🆕 or 🔄) is posted. force: "⏭ Hozir keyingisini chiqar" (no
// window, no slot). Only called while holding the tick lock.
export async function processPaced(s, { deadline = Date.now() + 120000, force = false, now = clock.now() } = {}) {
  const result = { moved: 0, posted: 0, skus: [], skipped: [], errors: [] };
  if (!db.hasRedis()) return result;
  result.moved = await movePaced().catch((e) => {
    result.errors.push(`navbat: ${errText(e)}`);
    return 0;
  });
  if (!force && !paceOn(s)) {
    result.reason = "to'xtatilgan";
    return result;
  }
  let slot = null;
  if (!force) {
    slot = currentSlot(windowOf(s), now);
    if (!slot) {
      result.reason = 'jadvaldan tashqari';
      return result;
    }
    if (await db.redis().get(db.K.flag(slotFlag(slot)))) {
      result.reason = 'bu slot band';
      return result;
    }
  }
  const [head] = await readPaced().then((l) => l.slice(0, 1));
  const [rHead] = await restockEntries();
  if (!head && !rHead) {
    result.reason = "navbat bo'sh";
    return result;
  }
  // the slot is claimed before posting, so two runs at once never both post
  if (slot && !(await db.once(slotFlag(slot), 60 * 60 * 26))) {
    result.reason = 'bu slot band';
    return result;
  }
  const order = rHead && (!head || (rHead.at || 0) < (head.queued_at || 0)) ? ['restock', 'new'] : ['new', 'restock'];
  const discounts = await loadDiscounts().catch(() => undefined);
  for (const kind of order) {
    if (result.posted || Date.now() + 30000 > deadline) break;
    if (kind === 'new') {
      if (!head) continue;
      const r = await postNextNew(s, deadline, discounts);
      result.skipped.push(...r.skipped);
      result.errors.push(...r.errors);
      if (r.ch2) result.ch2 = r.ch2;
      if (r.reason) result.reason = r.reason;
      if (r.posted) {
        result.posted = 1;
        result.skus.push(r.sku);
        result.kind = 'new';
      }
      if (r.wait) break;
    } else {
      if (!rHead) continue;
      const r = await processRestockQueue(s, { deadline, max: 1 }).catch((e) => ({ error: errText(e) }));
      result.restock = r;
      if (r.error) result.errors.push(`restock: ${r.error}`);
      if (r.posted) {
        result.posted = 1;
        result.skus.push(...(r.skus || []));
        result.kind = 'restock';
      }
    }
  }
  // nothing went out (all skipped, BITO trouble, 429): the slot stays free for the next tick
  if (slot && !result.posted) await db.clearFlag(slotFlag(slot));
  result.waiting = (await pacedLength()) + (await restockEntries()).length;
  return result;
}
