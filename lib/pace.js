// "📋 Istoriya navbati": stories go out one product per slot — by default every 15 minutes from 09:00 to
// 23:00 Tashkent (57 a day). The rest waits in the story queue for the next days, oldest first.
// Channel posts are not paced: they go out at once, as before. (An earlier version also paced channel
// posts in K.pqueue; flushPaced() hands whatever is still there back to the channel queue.)

import { processStoryQueue } from './poster.js';
import * as db from './store.js';
import { clock } from './util.js';
import { currentSlot, etaOf, paceWindow, slotsPerDay } from './pacetime.js';

export { fmtHHMM, parseHHMM, PACE_FROM, PACE_TO } from './pacetime.js';

export const paceOn = (s) => s.pace_on !== false;
export const windowOf = (s) => paceWindow(s, db.limit(s, 'pace_every'));
export const perDay = (s) => slotsPerDay(windowOf(s));
// the same flag the tick claims for its story slot (lib/tick.js)
export const storySlotFlag = (slot) => `pace:story:${slot.key}`;

export const pacedLength = () => db.storyQueueLength();

// Channel posts left in the old paced list go back to the channel queue (posted as before).
export async function flushPaced() {
  if (!db.hasRedis()) return 0;
  const items = (await db.redis().lrange(db.K.pqueue, 0, -1)) || [];
  if (!items.length) return 0;
  await db.redis().del(db.K.pqueue);
  await db.redis().rpush(db.K.queue, ...items);
  return items.length;
}

// Waiting stories, oldest first: [{ kind: 'new' | 'restock', sku, name }].
export async function pacedList() {
  if (!db.hasRedis()) return [];
  const q = await db.readStoryQueue();
  return q.map((e) => ({ kind: e.type === 'restock' ? 'restock' : 'new', sku: e.sku, name: e.name }));
}

// Admin "📋 Istoriya navbati" numbers: { total, new, restock, perDay, next: [5], eta }.
export async function pacedSummary(s, now = clock.now()) {
  const list = await pacedList();
  const w = windowOf(s);
  const slot = currentSlot(w, now);
  const free = slot ? !(await db.redis().get(db.K.flag(storySlotFlag(slot)))) : true;
  return {
    total: list.length,
    new: list.filter((x) => x.kind === 'new').length,
    restock: list.filter((x) => x.kind === 'restock').length,
    perDay: slotsPerDay(w),
    next: list.slice(0, 5),
    eta: list.length ? etaOf(w, list.length, now, free) : null,
  };
}

// "🗑 Navbatni tozalash": the story queue. Returns how many were removed.
export async function clearPaced() {
  const n = await pacedLength();
  await db.writeStoryQueue([]);
  return n;
}

// "⏭ Hozir keyingisini chiqar": the next story right now (no window, no slot).
export async function processPaced(s, { deadline = Date.now() + 120000 } = {}) {
  const first = (await pacedList())[0];
  const r = await processStoryQueue(s, deadline, { maxItems: 1 });
  const posted = r.new + r.discount > 0 ? 1 : 0;
  return {
    posted,
    kind: first?.kind || 'new',
    skus: r.skus,
    skipped: [],
    errors: r.errors,
    reason: posted ? undefined : r.reason || (first ? 'istoriya chiqmadi (limit yoki xato)' : "navbat bo'sh"),
    waiting: r.waiting,
  };
}
