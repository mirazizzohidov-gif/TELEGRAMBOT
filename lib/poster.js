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
const channelAllowed = (s, item) => (item.type === 'new' ? s.new_channel : s.discount_channel);
const storyAllowed = (s, item) => (item.type === 'discount' ? s.discount_story : s.new_story);

// Posts up to maxItems from the channel queue to all active channels.
export async function processChannelQueue(s, deadline, maxItems = 10) {
  const result = { posted: 0, failed: 0, requeued: 0, dropped: 0, errors: [] };
  const channels = s.channels.filter((c) => c.active);
  if (!channels.length) {
    result.reason = 'no active channels';
    return result;
  }
  const popped = await db.popQueue(maxItems);
  const items = popped.filter((i) => channelAllowed(s, i));
  result.dropped = popped.length - items.length; // switched off in the admin panel meanwhile
  if (!items.length) {
    return result;
  }
  const r = await postToChannels(items, s, channels, deadline);
  result.errors.push(...r.errors);
  for (const item of items) {
    if (r.posted.has(item)) {
      await db.upsertProduct(item, { posted_at: Date.now() });
      await db.incrStat(postedStat(item));
      result.posted++;
    } else if (!r.leftover.includes(item)) {
      await db.incrStat('failed');
      result.failed++;
    }
  }
  await db.requeueFront(r.leftover);
  result.requeued = r.leftover.length;
  return result;
}

// Posts stories from the story queue within the daily limits; the rest waits for the next tick/day.
export async function processStoryQueue(s, deadline) {
  const result = { new: 0, discount: 0, waiting: 0, failed: 0, dropped: 0, errors: [] };
  const all = await db.readStoryQueue();
  if (!all.length) {
    return result;
  }
  const bc = db.storyConnectionId(s, await db.listBiz());
  if (!bc) {
    result.reason = 'no business connection';
    result.waiting = all.length;
    return result;
  }
  const st = await db.getStats();
  let leftNew = Math.max(0, db.storyDailyLimit(s) - (st.stories || 0));
  let leftDiscount = Math.max(0, db.discountStoryLimit() - (st.discount_stories || 0));
  const keep = [];
  for (const item of all) {
    if (!storyAllowed(s, item)) {
      result.dropped++;
      continue;
    }
    const isDiscount = item.type === 'discount';
    if ((isDiscount ? leftDiscount : leftNew) <= 0 || Date.now() + 20000 > deadline) {
      keep.push(item);
      continue;
    }
    try {
      await postProductStory({
        businessConnectionId: bc,
        imageUrl: item.image_url,
        caption: buildPostCaption(item, s.phone),
        parseMode: 'HTML',
        deadline,
      });
      if (isDiscount) {
        leftDiscount--;
        result.discount++;
        await db.incrStat('discount_stories');
      } else {
        leftNew--;
        result.new++;
        await db.incrStat('stories');
      }
    } catch (e) {
      result.errors.push(`story ${item.sku}: ${errText(e)}`);
      if (e.code === 429) {
        keep.push(item);
      } else {
        result.failed++;
        await db.incrStat('failed');
      }
    }
  }
  await db.writeStoryQueue(keep);
  result.waiting = keep.length;
  return result;
}

// Posts one item right now to the active channels (admin "Kanalga joylash").
export async function postItemNow(item, settings) {
  const channels = settings.channels.filter((c) => c.active);
  if (!channels.length) {
    return { ok: false, channels: 0, errors: ["Faol kanal yo'q"] };
  }
  const r = await postToChannels([item], { ...settings, album: false }, channels, Date.now() + 60000);
  if (r.posted.has(item)) {
    await db.upsertProduct(item, { posted_at: Date.now() });
    await db.incrStat(postedStat(item));
  }
  return { ok: r.posted.has(item), channels: channels.length, errors: r.errors };
}
