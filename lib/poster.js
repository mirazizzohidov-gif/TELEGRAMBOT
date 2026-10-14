import { buildPostCaption } from './caption.js';
import * as db from './store.js';
import { postProductStory } from './story.js';
import { tg } from './telegram.js';
import { clock, errText } from './util.js';

const ITEM_DELAY_MS = 3000;
const protect = () => process.env.PROTECT_CONTENT !== 'false';

export const orderKeyboard = (url) => ({ inline_keyboard: [[{ text: '🛒 Buyurtma berish', url }]] });

// Sends items to channels. Returns { posted: Set<item>, leftover: item[] (to requeue), errors }.
export async function postToChannels(items, settings, channels, deadline) {
  const posted = new Set();
  const errors = [];
  let leftover = [];
  const kb = orderKeyboard(settings.order_url);

  if (settings.album && items.length >= 2) {
    const media = items.slice(0, 10).map((i) => ({
      type: 'photo',
      media: i.image_url,
      caption: buildPostCaption(i, settings.phone),
      parse_mode: 'HTML',
    }));
    let ok = false;
    let rateLimited = false;
    for (const ch of channels) {
      try {
        await tg('sendMediaGroup', { chat_id: ch.id, media, protect_content: protect() }, { deadline });
        await tg(
          'sendMessage',
          { chat_id: ch.id, text: '👇 Buyurtma berish uchun tugmani bosing', reply_markup: kb, protect_content: protect() },
          { deadline },
        );
        ok = true;
      } catch (e) {
        rateLimited ||= e.code === 429;
        errors.push(`${ch.id}: album: ${errText(e)}`);
      }
    }
    if (ok) {
      items.forEach((i) => posted.add(i));
      return { posted, leftover, errors };
    }
    if (rateLimited) {
      return { posted, leftover: items, errors };
    }
    // Album failed everywhere (e.g. one bad image) -> fall back to single photos.
  }

  for (let n = 0; n < items.length; n++) {
    if (Date.now() + 15000 > deadline) {
      leftover = leftover.concat(items.slice(n));
      break;
    }
    const item = items[n];
    let rateLimited = false;
    for (const ch of channels) {
      try {
        await tg(
          'sendPhoto',
          {
            chat_id: ch.id,
            photo: item.image_url,
            caption: buildPostCaption(item, settings.phone),
            parse_mode: 'HTML',
            reply_markup: kb,
            protect_content: protect(),
          },
          { deadline },
        );
        posted.add(item);
      } catch (e) {
        rateLimited ||= e.code === 429;
        errors.push(`${ch.id}: ${item.sku}: ${errText(e)}`);
      }
    }
    if (!posted.has(item) && rateLimited) {
      leftover.push(item);
    }
    if (n < items.length - 1) {
      await clock.sleep(ITEM_DELAY_MS);
    }
  }
  return { posted, leftover, errors };
}

const postedStat = (item) => (item.type === 'new' ? 'posted' : `${item.type}_posted`);

// Takes up to maxItems from the queue and publishes them (channels and/or story).
export async function runTick({ budgetMs = 280000, maxItems = 10 } = {}) {
  const deadline = Date.now() + budgetMs;
  const s = await db.getSettings();
  const channels = s.send_channel ? s.channels.filter((c) => c.active) : [];
  const bc = s.story ? db.storyConnectionId(s, await db.listBiz()) : null;
  const stats = await db.getStats();
  let storyLeft = bc ? Math.max(0, db.storyDailyLimit() - (stats.stories || 0)) : 0;
  const result = { processed: 0, posted: 0, stories: 0, failed: 0, requeued: 0, errors: [] };

  const take = channels.length ? maxItems : Math.min(maxItems, storyLeft);
  if (!take) {
    result.reason = channels.length || s.story ? 'story limit reached' : 'channel and story posting are off';
    return result;
  }
  const items = await db.popQueue(take);
  result.processed = items.length;
  if (!items.length) {
    return result;
  }

  let posted = new Set();
  let leftover = [];
  if (channels.length) {
    const r = await postToChannels(items, s, channels, deadline);
    posted = r.posted;
    leftover = r.leftover;
    result.errors.push(...r.errors);
  }

  const storied = new Set();
  const storyFailed = new Set();
  for (const item of items) {
    if (!storyLeft) {
      break;
    }
    if (leftover.includes(item) || (channels.length && !posted.has(item))) {
      continue;
    }
    if (Date.now() + 20000 > deadline) {
      break;
    }
    try {
      await postProductStory({
        businessConnectionId: bc,
        imageUrl: item.image_url,
        caption: buildPostCaption(item, s.phone),
        parseMode: 'HTML',
        deadline,
      });
      storied.add(item);
      storyLeft--;
      result.stories++;
      await db.incrStat('stories');
    } catch (e) {
      storyFailed.add(item);
      result.errors.push(`story ${item.sku}: ${errText(e)}`);
    }
  }

  const requeue = [];
  for (const item of items) {
    const ok = channels.length ? posted.has(item) : storied.has(item);
    if (ok) {
      await db.recordSent(item);
      await db.incrStat(postedStat(item));
      result.posted++;
    } else if (leftover.includes(item) || (!channels.length && !storyFailed.has(item))) {
      requeue.push(item);
    } else {
      await db.unmarkQueued(item.sku);
      await db.incrStat('failed');
      result.failed++;
    }
  }
  await db.requeueFront(requeue);
  result.requeued = requeue.length;
  for (const e of result.errors) {
    await db.logError(e);
  }
  return result;
}

// Posts one item right now to the active channels (admin "Kanalga joylash").
export async function postItemNow(item, settings) {
  const channels = settings.channels.filter((c) => c.active);
  if (!channels.length) {
    return { ok: false, channels: 0, errors: ['Faol kanal yo\'q'] };
  }
  const r = await postToChannels([item], { ...settings, album: false }, channels, Date.now() + 60000);
  if (r.posted.has(item)) {
    await db.recordSent(item);
    await db.incrStat(postedStat(item));
  }
  return { ok: r.posted.has(item), channels: channels.length, errors: r.errors };
}
