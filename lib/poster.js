import { buildPostCaption } from './caption.js';
import { notifyAdmins } from './report.js';
import * as db from './store.js';
import { postProductStory } from './story.js';
import { tg } from './telegram.js';
import { chunk, clock, errText } from './util.js';

const ITEM_DELAY_MS = 3000;
const protect = () => process.env.PROTECT_CONTENT !== 'false';

export const orderKeyboard = (url) => ({ inline_keyboard: [[{ text: '🛒 Buyurtma berish', url }]] });

const ALBUM_MAX = 10;


// Sends 2..10 items as one album to every channel, each followed by the order-button message.
// Returns { ok, rateLimited, errors }.
async function sendAlbum(items, settings, channels, deadline) {
  const media = items.map((i) => ({
    type: 'photo',
    media: i.image_url,
    caption: buildPostCaption(i, settings.phone),
    parse_mode: 'HTML',
  }));
  const kb = orderKeyboard(settings.order_url);
  const errors = [];
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
  return { ok, rateLimited, errors };
}

// Sends one photo post (with the order button) to every channel. Returns { ok, rateLimited, errors }.
async function sendSingle(item, settings, channels, deadline) {
  const errors = [];
  let ok = false;
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
          reply_markup: orderKeyboard(settings.order_url),
          protect_content: protect(),
        },
        { deadline },
      );
      ok = true;
    } catch (e) {
      rateLimited ||= e.code === 429;
      errors.push(`${ch.id}: ${item.sku}: ${errText(e)}`);
    }
  }
  return { ok, rateLimited, errors };
}

// Sends items to channels: albums of up to 10 when settings.album and 2+ items, otherwise one by one
// (3 s apart). Returns { posted: Set<item>, leftover: item[] (to requeue), errors }.
export async function postToChannels(items, settings, channels, deadline) {
  const posted = new Set();
  const errors = [];
  const leftover = [];
  const groups = settings.album && items.length >= 2 ? chunk(items, ALBUM_MAX) : items.map((i) => [i]);

  for (let n = 0; n < groups.length; n++) {
    const group = groups[n];
    if (Date.now() + 15000 > deadline) {
      leftover.push(...groups.slice(n).flat());
      break;
    }
    if (group.length >= 2) {
      const r = await sendAlbum(group, settings, channels, deadline);
      errors.push(...r.errors);
      if (r.ok) {
        group.forEach((i) => posted.add(i));
      } else if (r.rateLimited) {
        leftover.push(...group);
      } else {
        // Album failed everywhere (e.g. one bad image) -> fall back to single photos.
        for (const item of group) {
          const s = await sendSingle(item, settings, channels, deadline);
          errors.push(...s.errors);
          if (s.ok) posted.add(item);
          else if (s.rateLimited) leftover.push(item);
          await clock.sleep(ITEM_DELAY_MS);
        }
      }
    } else {
      const r = await sendSingle(group[0], settings, channels, deadline);
      errors.push(...r.errors);
      if (r.ok) posted.add(group[0]);
      else if (r.rateLimited) leftover.push(group[0]);
    }
    if (n < groups.length - 1) {
      await clock.sleep(ITEM_DELAY_MS);
    }
  }
  return { posted, leftover, errors };
}

const postedStat = (item) => (item.type === 'new' ? 'posted' : `${item.type}_posted`);
// item.force: queued by the admin / random job — not tied to the auto-post toggles.
const channelAllowed = (s, item) => item.force || (item.type === 'new' ? s.new_channel : s.discount_channel);

// Random posts: separate photo posts (default) or albums.
export const randomAlbum = (s) => s.random_view === 'album';
// item.force: story the admin asked for (manual / random) — not tied to the auto-story toggles.
const storyAllowed = (s, item) => item.force || (item.type === 'discount' ? s.discount_story : s.new_story);

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Telegram's own error text (e.g. "Bad Request: BUSINESS_CONNECTION_INVALID").
const tgDescription = (e) => e?.data?.description || e?.message || String(e);

export function storyErrorHint(e) {
  const t = tgDescription(e);
  if (/STORIES_TOO_MUCH|too many stories/i.test(t)) return "Telegram akkauntidagi story limiti tugagan — keyinroq davom etadi.";
  if (/PREMIUM/i.test(t)) return "Story uchun biznes akkauntda Telegram Premium kerak bo'lishi mumkin.";
  if (/BUSINESS_CONNECTION|connection.*(not found|invalid)/i.test(t))
    return "Biznes ulanish topilmadi yoki o'chirilgan — botni Telegram Business → Chatbots'ga qayta ulang.";
  if (/right|not enough|forbidden|not allowed|BOT_BUSINESS|can_manage_stories/i.test(t))
    return "Botda story ruxsati yo'q — Telegram Business → Chatbots → bot ruxsatlarida story'larni boshqarishni yoqing.";
  return '';
}

// Errors that will hit every following story too (rights, connection, account limit): stop and keep the rest.
const isBlockingStoryError = (e) =>
  e?.code === 429 || /STORIES_TOO_MUCH|too many|PREMIUM|BUSINESS|right|not enough|forbidden|not allowed/i.test(tgDescription(e));

export const storyErrorText = (item, e) => {
  const hint = storyErrorHint(e);
  return `❗ Story yuborilmadi (SKU ${esc(item.sku)})\nTelegram: <code>${esc(tgDescription(e))}</code>${hint ? `\n💡 ${hint}` : ''}`;
};

// Tells admins about a story error from an automatic job; the same Telegram error at most once per hour.
async function notifyStoryError(item, e) {
  if (await db.once(`storyerr:${tgDescription(e).slice(0, 120)}`, 60 * 60)) {
    await notifyAdmins({ text: storyErrorText(item, e), parse_mode: 'HTML' });
  }
}

// Posts stories now within today's story limit; the rest is queued (force) for the next day.
// Returns { posted: item[], queued, stopped (by a Telegram error), errors: [html], reason }.
export async function postStoriesNow(items, s, { deadline = Date.now() + 120000, notify = false } = {}) {
  const result = { posted: [], queued: 0, errors: [] };
  const bc = db.storyConnectionId(s, await db.listBiz());
  if (!bc) {
    result.reason = "Biznes ulanish yo'q — avval botni Telegram Business'ga ulang.";
    return result;
  }
  const st = await db.getStats();
  let left = Math.max(0, db.storyDailyLimit(s) - (st.stories || 0));
  const later = [];
  let stopped = false;
  for (const item of items) {
    if (stopped || left <= 0 || Date.now() + 20000 > deadline) {
      later.push(item);
      continue;
    }
    try {
      await postProductStory({ businessConnectionId: bc, imageUrl: item.image_url, caption: buildPostCaption(item, s.phone), parseMode: 'HTML', deadline });
      await db.incrStat('stories');
      result.posted.push(item);
      left--;
    } catch (e) {
      result.errors.push(storyErrorText(item, e));
      if (notify) await notifyStoryError(item, e);
      if (isBlockingStoryError(e)) {
        stopped = true;
        later.push(item);
      } else {
        await db.incrStat('failed');
      }
    }
  }
  await db.enqueueStories(later.map((i) => ({ ...i, force: true })));
  result.queued = later.length;
  result.stopped = stopped;
  return result;
}

// Posts up to maxItems from the channel queue to all active channels.
export async function processChannelQueue(s, deadline, maxItems = db.limit(s, 'tick_max_posts')) {
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
  let leftDiscount = Math.max(0, db.discountStoryLimit(s) - (st.discount_stories || 0));
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
      await notifyStoryError(item, e);
      if (isBlockingStoryError(e)) {
        // Same error would repeat for the rest: keep them all for a later tick.
        keep.push(...all.slice(all.indexOf(item)).filter((i) => storyAllowed(s, i)));
        break;
      }
      result.failed++;
      await db.incrStat('failed');
    }
  }
  await db.writeStoryQueue(keep);
  result.waiting = keep.length;
  return result;
}

// Admin manual posting: posts items right now to the active channels, bypassing toggles and the
// duplicate check. album: send 2+ items as albums (default) or as separate posts.
// Items that did not fit before the deadline (or hit 429) are queued and returned in `queued`.
export async function postItemsNow(items, settings, { deadline = Date.now() + 120000, album = true, stat } = {}) {
  const channels = settings.channels.filter((c) => c.active);
  if (!channels.length) {
    return { posted: [], queued: [], channels: 0, errors: ["Faol kanal yo'q"] };
  }
  const r = await postToChannels(items, { ...settings, album: album && items.length >= 2 }, channels, deadline);
  const posted = items.filter((i) => r.posted.has(i));
  for (const item of posted) {
    await db.upsertProduct(item, { posted_at: Date.now() });
    await db.incrStat(stat || postedStat(item));
  }
  const queued = r.leftover.map((i) => ({ ...i, force: true }));
  await db.enqueue(queued);
  return { posted, queued, channels: channels.length, errors: r.errors };
}

// "🧪 Test": the same posts as in the channel, sent only to the admin's chat. Nothing is recorded.
export async function postItemsTest(items, settings, chatId, { album = true } = {}) {
  const r = await postToChannels(items, { ...settings, album: album && items.length >= 2 }, [{ id: chatId }], Date.now() + 120000);
  return { posted: items.filter((i) => r.posted.has(i)).length, errors: r.errors };
}
