// "🔄 Qayta keldi" auto-post: the stock scanner saw a product go from 0 to >0 -> a channel post (with the
// order button) and a story on every selected business profile.
//
// Only real transitions are queued (the product had a record with stock 0, and a full catalog pass had
// already been made — see stock.js). The queue is worked a few products per tick, held at night
// (23:00–08:00 Tashkent), and one product is posted at most once per `restock_days` days.

import { findBySku, getProductById, loadDiscounts, priceFor, productImage, productStock, toItem } from './bito.js';
import { postStoriesNow, postToChannels } from './poster.js';
import { notifyAdmins } from './report.js';
import * as db from './store.js';
import { clock, errText } from './util.js';

const NIGHT_FROM = 23;
const NIGHT_TO = 8;

const dedupeKey = (pid) => `restock:${pid}`;
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const tashkentHour = (ms = clock.now()) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(new Date(ms))) % 24;

export const isNight = (ms = clock.now()) => {
  const h = tashkentHour(ms);
  return h >= NIGHT_FROM || h < NIGHT_TO;
};

// Posted within the last restock_days days?
export const recentlyPosted = async (pid) => Boolean(await db.redis().get(db.K.flag(dedupeKey(pid))));

// Claims the product for restock_days days; false when it was already posted in that time.
export const claimRestock = (pid, s) => db.once(dedupeKey(pid), db.limit(s, 'restock_days') * 86400);

// Called by the stock scanner on a real 0 -> >0 transition.
export async function enqueueRestock(pid, r, s) {
  if (s.restock_post === false) return false;
  if (await recentlyPosted(pid)) return false;
  await db.redis().hset(db.K.restockQueue, { [pid]: { pid, sku: r.sku, name: r.name, at: Date.now() } });
  await db.incrStat('restock_auto');
  return true;
}

export const restockQueueLength = async () => (db.hasRedis() ? Object.keys((await db.redis().hgetall(db.K.restockQueue)) || {}).length : 0);

// The product as BITO has it now (stock may have dropped again meanwhile).
async function freshProduct(entry) {
  if (entry.sku) {
    const p = await findBySku(String(entry.sku), { fresh: true }).catch(() => null);
    if (p && String(p._id) === String(entry.pid)) return p;
  }
  return getProductById(entry.pid);
}

function reportLine(sku, ch, st) {
  const parts = [ch];
  if (st) parts.push(st);
  return `🔄 Qayta keldi: ${esc(sku)} — ${parts.join(', ')}`;
}

function storyPart(r, profilesTotal) {
  if (r.reason) return 'istoriya ❌ (profil yo\'q)';
  const ok = r.posted === profilesTotal;
  let t = `istoriya ${r.posted}/${profilesTotal} ${ok ? '✅' : r.posted ? '⚠️' : '❌'}`;
  if (r.queued) t += ` (${r.queued} tasi navbatda)`;
  const err = r.profiles.flatMap((p) => p.errors)[0];
  if (err) t += ` — ${esc(err).slice(0, 120)}`;
  return t;
}

// Works the queue: up to restock_per_tick products, oldest first. Returns a summary for the tick result.
export async function processRestockQueue(s, { deadline = Date.now() + 120000, now = clock.now() } = {}) {
  const result = { posted: 0, skipped: 0, waiting: 0, skus: [], lines: [] };
  if (!db.hasRedis()) return result;
  const all = Object.values((await db.redis().hgetall(db.K.restockQueue)) || {}).sort((a, b) => a.at - b.at);
  if (!all.length) return result;
  if (s.restock_post === false) {
    // Switched off: nothing is kept for later (it would all come out at once when switched on again).
    await db.redis().del(db.K.restockQueue);
    result.dropped = all.length;
    return result;
  }
  if (isNight(now)) {
    result.waiting = all.length;
    result.night = true;
    return result;
  }
  const channels = s.channels.filter((c) => c.active);
  const discounts = await loadDiscounts();
  const take = all.slice(0, db.limit(s, 'restock_per_tick'));
  for (const entry of take) {
    if (Date.now() + 30000 > deadline) break;
    const done = () => db.redis().hdel(db.K.restockQueue, entry.pid);
    let p;
    try {
      p = await freshProduct(entry);
    } catch (e) {
      console.error(`restock ${entry.sku}: ${errText(e)}`);
      continue; // BITO trouble: stays in the queue for the next tick
    }
    const skip = async (why) => {
      await done();
      result.skipped++;
      result.lines.push(reportLine(entry.sku, `o'tkazib yuborildi (${why})`));
    };
    if (!p || productStock(p) <= 0) {
      await skip('qoldiq yana 0');
      continue;
    }
    if (!productImage(p)) {
      await skip('rasmsiz');
      continue;
    }
    const pr = await priceFor(p, discounts);
    if (!(pr.price > 0)) {
      await skip('narxsiz');
      continue;
    }
    if (!(await claimRestock(entry.pid, s))) {
      await done(); // posted within restock_days days
      continue;
    }
    // force: posted for this feature's own toggle, not for the new / discount toggles.
    const item = toItem(p, pr, 'restock', { force: true });
    let ch;
    if (!channels.length) {
      ch = "kanal — (faol kanal yo'q)";
    } else {
      const r = await postToChannels([item], { ...s, album: false }, channels, deadline);
      if (r.leftover.length) {
        await db.clearFlag(dedupeKey(entry.pid)); // 429 / out of time: next tick
        break;
      }
      if (r.posted.size) {
        await db.upsertProduct(item, { posted_at: Date.now() });
        await db.incrStat('restock_auto_posted');
        ch = 'kanal ✅';
      } else {
        await db.incrStat('failed');
        ch = `kanal ❌ (${esc(r.errors[0] || 'xato').slice(0, 120)})`;
      }
    }
    const profiles = db.storyProfiles(s, await db.listBiz());
    const st = await postStoriesNow([item], s, { deadline, notify: true });
    await done();
    result.posted++;
    result.skus.push(item.sku);
    result.lines.push(reportLine(item.sku, ch, storyPart(st, profiles.length)));
  }
  result.waiting = await restockQueueLength();
  if (result.lines.length) {
    await notifyAdmins({ text: result.lines.join('\n'), parse_mode: 'HTML' });
  }
  return result;
}
