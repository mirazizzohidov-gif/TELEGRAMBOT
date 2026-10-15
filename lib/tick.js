import { checkActiveDiscounts } from './discount-watch.js';
import { processChannelQueue, processStoryQueue } from './poster.js';
import { processRestockQueue, restockQueueLength } from './restock.js';
import { stockTick } from './stock.js';
import * as db from './store.js';
import { checkDiscounts, detectNew } from './watch.js';

// One run of the 15-minute job: detect new products and discounts, then work the queues.
export async function runTick({ budgetMs = 280000 } = {}) {
  const start = Date.now();
  const deadline = start + budgetMs;
  if (!(await db.lock('tick', 300))) {
    return { skipped: 'another tick is running' };
  }
  try {
    const s = await db.getSettings();
    // Each check gets its own time slice, so a slow BITO in one step does not silently starve the
    // next one; the rest of the budget is for posting. Unfinished checks continue next tick.
    const at = (share) => start + budgetMs * share;
    const detected = await detectNew(s, { deadline: at(0.3) });
    // Products on an active BITO discount, also ones the bot never posted.
    const activeDiscounts = await checkActiveDiscounts(s, { deadline: Math.max(at(0.6), Date.now() + 30000) }).catch((e) => {
      console.error('active discount check failed:', e.message, e.details || '');
      return { error: e.message, active: 0, announced: 0, channel: 0, story: 0, skus: [], details: [] };
    });
    const discounts = await checkDiscounts(s, { deadline: Math.max(at(0.7), Date.now() + 10000) });
    // Posting comes before the long stock scan, so the queues (and every story profile) always get time.
    const channel = await processChannelQueue(s, Math.max(at(0.75), Date.now() + 30000));
    const stories = await processStoryQueue(s, Math.min(deadline, Math.max(at(0.85), Date.now() + 60000)));
    // Stock group: watch stock, daily catalog pass, out / back alerts, daily list.
    const stock = await stockTick(s, { deadline: Math.max(at(0.9), Date.now() + 20000) }).catch((e) => {
      console.error('stock tick failed:', e.message);
      return { error: e.message };
    });
    // "🔄 Qayta keldi": a few back-in-stock products per tick (held at night).
    const restock = await processRestockQueue(s, { deadline }).catch((e) => {
      console.error('restock auto-post failed:', e.message);
      return { error: e.message };
    });
    for (const e of [...channel.errors, ...stories.errors]) {
      await db.logError(e);
    }
    return {
      detected,
      discounts,
      active_discounts: activeDiscounts,
      stock,
      restock,
      restock_queue: await restockQueueLength(),
      channel,
      stories,
      queue: await db.queueLength(),
      story_queue: await db.storyQueueLength(),
    };
  } finally {
    await db.unlock('tick');
  }
}

// Admin "🔥 Chegirmalarni hozir tekshirish": active BITO discounts + price drops, then post the queues.
export async function runDiscountCheck({ budgetMs = 240000 } = {}) {
  const start = Date.now();
  const deadline = start + budgetMs;
  if (!(await db.lock('tick', 300))) {
    return { skipped: 'another tick is running' };
  }
  try {
    const s = await db.getSettings();
    const active = await checkActiveDiscounts(s, { deadline: start + budgetMs * 0.6 });
    const drops = await checkDiscounts(s, { deadline: Math.max(start + budgetMs * 0.7, Date.now() + 10000) });
    const channel = await processChannelQueue(s, deadline);
    const stories = await processStoryQueue(s, deadline);
    return { active, drops, channel, stories, queue: await db.queueLength(), story_queue: await db.storyQueueLength() };
  } finally {
    await db.unlock('tick');
  }
}
