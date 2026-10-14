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
    const channel = await processChannelQueue(s, deadline);
    const stories = await processStoryQueue(s, deadline);
    for (const e of [...channel.errors, ...stories.errors]) {
      await db.logError(e);
    }
    return {
      detected,
      discounts,
      channel,
      stories,
      queue: await db.queueLength(),
      story_queue: await db.storyQueueLength(),
    };
  } finally {
    await db.unlock('tick');
  }
}
