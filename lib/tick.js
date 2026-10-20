import { backfillDescriptions } from './ai.js';
import { ensureBotUsername } from './orders.js';
import { salesTick } from './sales.js';
import { checkActiveDiscounts } from './discount-watch.js';
import { runDateJob } from './datesend.js';
import { backupTick } from './backup.js';
import { afterTick, beforeTick, dailyHealth } from './health.js';
import { checkPrices, processEdits } from './postreg.js';
import { processChannel2Queue, processChannelQueue, processStoryQueue } from './poster.js';
import { restockQueueLength } from './restock.js';
import { movePaced, pacedLength, processPaced } from './pace.js';
import { routeGroup, stockTick } from './stock.js';
import * as db from './store.js';
import { checkDiscounts, detectNew } from './watch.js';

// One run of the 15-minute job: detect new products and discounts, then work the queues.
export async function runTick({ budgetMs = 280000 } = {}) {
  const start = Date.now();
  const deadline = start + budgetMs;
  if (!(await db.lock('tick', 300))) {
    return { skipped: 'another tick is running' };
  }
  let s = null;
  try {
    s = await db.getSettings();
    // "🩺 Holat": a 45+ minute gap since the last tick -> "⚠️"; BITO counters from zero
    await beforeTick(s).catch((e) => console.error(`health: ${e.message}`));
    // the bot's @username for the "🛒 Buyurtma berish" links into the bot (once)
    if (!s.bot_username) s.bot_username = (await ensureBotUsername(s).catch(() => null)) || '';
    // Each check gets its own time slice, so a slow BITO in one step does not silently starve the
    // next one; the rest of the budget is for posting. Unfinished checks continue next tick.
    const at = (share) => start + budgetMs * share;
    const detected = await detectNew(s, { deadline: at(0.3) });
    // "📋 Navbat": new / back-in-stock products go out one per slot (09:00–23:00, every 15 min). Right after
    // the new-product check, with its own time, so the slow discount / AI steps can never eat its slot.
    // They are moved out of the channel queue first, so processChannelQueue below posts only the others.
    await movePaced().catch((e) => console.error('paced move failed:', e.message));
    const paced = await processPaced(s, { deadline: Math.min(deadline, Date.now() + 120000) }).catch((e) => {
      console.error('paced post failed:', e.message);
      return { error: e.message, errors: [], posted: 0, skus: [] };
    });
    // Products on an active BITO discount, also ones the bot never posted.
    const activeDiscounts = await checkActiveDiscounts(s, { deadline: Math.max(at(0.6), Date.now() + 30000) }).catch((e) => {
      console.error('active discount check failed:', e.message, e.details || '');
      return { error: e.message, active: 0, announced: 0, channel: 0, story: 0, skus: [], details: [] };
    });
    const discounts = await checkDiscounts(s, { deadline: Math.max(at(0.7), Date.now() + 10000) });
    // "📝" for posts that went out without it (Gemini busy): written now, the posts are edited.
    const aiBackfill = await backfillDescriptions(s, { deadline: Math.min(deadline, Date.now() + 100000) }).catch((e) => {
      console.error('ai backfill failed:', e.message);
      return { error: e.message };
    });
    // Posting comes before the long stock scan, so the queues (and every story profile) always get time.
    const channel = await processChannelQueue(s, Math.max(at(0.75), Date.now() + 30000));
    // "📢 2-kanal": posts that failed only there are tried again (a few per tick)
    const channel2 = await processChannel2Queue(s, Math.max(at(0.77), Date.now() + 20000)).catch((e) => ({ error: e.message }));
    const stories = await processStoryQueue(s, Math.min(deadline, Math.max(at(0.85), Date.now() + 60000)));
    // Stock group: watch stock, daily catalog pass, out / back alerts, daily list.
    // the stock scan stops at 80 %: "🔄 Qayta keldi" posts (with AI descriptions) need the rest
    const stock = await stockTick(s, { deadline: Math.max(at(0.8), Date.now() + 20000) }).catch((e) => {
      console.error('stock tick failed:', e.message);
      return { error: e.message };
    });
    // "🔄 Qayta keldi": posted by "📋 Navbat" above (one per slot, oldest first with the new products).
    const restock = paced.restock || { paced: true };
    // "📅 Sana bo'yicha yuborish": what did not fit in the admin's run goes on here
    const dateSend = await runDateJob(s, { deadline }).catch((e) => ({ error: e.message }));
    // "💲 Narx yangilash" (a few posted products per tick) and the "❌ SOTILDI" / price edits (30 per tick)
    const prices = await checkPrices(s, { deadline }).catch((e) => ({ error: e.message }));
    const postEdits = await processEdits(s, { deadline }).catch((e) => ({ error: e.message }));
    // "🛒 Buyurtma qilish kerak" (daily) and "📈 Haftalik hisobot" (Mondays)
    const sales = await salesTick(s, { reportChat: routeGroup(s, 'report') || null }).catch((e) => ({ error: e.message }));
    for (const e of [...channel.errors, ...stories.errors, ...(paced.errors || [])]) {
      await db.logError(e);
    }
    await afterTick(s, { ok: true }).catch((e) => console.error(`health: ${e.message}`));
    // "🩺 Kunlik holat" after 08:55 (once a day)
    const health = await dailyHealth(s).catch((e) => ({ error: e.message }));
    // "💾 Zaxira" after 03:00 (once a day)
    const backup = await backupTick(s).catch((e) => ({ error: e.message }));
    return {
      detected,
      discounts,
      active_discounts: activeDiscounts,
      stock,
      restock,
      restock_queue: await restockQueueLength(),
      paced,
      paced_queue: await pacedLength(),
      ai_backfill: aiBackfill,
      sales,
      channel,
      channel2,
      date_send: dateSend,
      prices,
      post_edits: postEdits,
      health,
      backup,
      stories,
      queue: await db.queueLength(),
      story_queue: await db.storyQueueLength(),
    };
  } catch (e) {
    if (s) await afterTick(s, { ok: false, error: e.message }).catch(() => {});
    throw e;
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
    await movePaced().catch(() => {}); // new products wait for their "📋 Navbat" slot
    const channel = await processChannelQueue(s, deadline);
    const stories = await processStoryQueue(s, deadline);
    return { active, drops, channel, stories, queue: await db.queueLength(), story_queue: await db.storyQueueLength() };
  } finally {
    await db.unlock('tick');
  }
}
