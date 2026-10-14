import { checkActiveDiscounts } from './discount-watch.js';
import { processChannelQueue, processStoryQueue } from './poster.js';
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
    // Leave most of the budget for posting; unfinished checks continue next tick.
    const checkDeadline = start + Math.min(budgetMs * 0.4, 110000);
    const detected = await detectNew(s, { deadline: checkDeadline });
    const discounts = await checkDiscounts(s, { deadline: checkDeadline });
    // Products on an active BITO discount, also ones the bot never posted.
    const activeDiscounts = await checkActiveDiscounts(s, { deadline: checkDeadline }).catch((e) => {
      console.error('active discount check failed:', e.message, e.details || '');
      return { error: e.message, active: 0, announced: 0, channel: 0, story: 0, skus: [] };
    });
    const channel = await processChannelQueue(s, deadline);
    const stories = await processStoryQueue(s, deadline);
    for (const e of [...channel.errors, ...stories.errors]) {
      await db.logError(e);
    }
    return {
      detected,
      discounts,
      active_discounts: activeDiscounts,
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
    const checkDeadline = start + Math.min(budgetMs * 0.5, 120000);
    const active = await checkActiveDiscounts(s, { deadline: checkDeadline });
    const drops = await checkDiscounts(s, { deadline: checkDeadline });
    const channel = await processChannelQueue(s, deadline);
    const stories = await processStoryQueue(s, deadline);
    return { active, drops, channel, stories, queue: await db.queueLength(), story_queue: await db.storyQueueLength() };
  } finally {
    await db.unlock('tick');
  }
}
