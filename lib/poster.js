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

export const storyErrorText = (item, e, profile) => {
  const hint = storyErrorHint(e);
  return (
    `❗ Story yuborilmadi${profile ? ` — ${esc(profile.label)}` : ''} (SKU ${esc(item.sku)})\n` +
    `Telegram: <code>${esc(tgDescription(e))}</code>${hint ? `\n💡 ${hint}` : ''}`
  );
};

function logStoryError(profile, item, e) {
  console.error(`story failed: profile=${profile.label} (${profile.id}) sku=${item.sku}: ${tgDescription(e)}`);
}

// Tells admins about a story error from an automatic job; the same error for the same profile at most
// once per hour (the job runs every 15 minutes).
async function notifyStoryError(item, e, profile) {
  if (await db.once(`storyerr:${profile.id}:${tgDescription(e).slice(0, 120)}`, 60 * 60)) {
    await notifyAdmins({ text: storyErrorText(item, e, profile), parse_mode: 'HTML' });
  }
}

const NO_PROFILE = "Story uchun profil yo'q — botni Telegram Business'ga ulang yoki \"📱 Story profillari\"da profilni belgilang.";

// Posts each item as a story to EVERY selected business profile, within each profile's daily limit;
// the rest is queued (force, per profile) for later. Every Telegram error is logged and returned.
// Returns { profiles: [{ id, label, posted, queued, stopped, errors: [description] }], posted, queued, reason }.
export async function postStoriesNow(items, s, { deadline = Date.now() + 120000, notify = false } = {}) {
  const profiles = db.storyProfiles(s, await db.listBiz());
  if (!profiles.length) {
    return { profiles: [], posted: 0, queued: 0, reason: NO_PROFILE };
  }
  const st = await db.getStats();
  const later = [];
  const out = [];
  for (const p of profiles) {
    let left = Math.max(0, db.storyDailyLimit(s) - (st[`stories:${p.id}`] || 0));
    const r = { ...p, posted: 0, queued: 0, stopped: false, errors: [] };
    for (const item of items) {
      if (r.stopped || left <= 0 || Date.now() + 20000 > deadline) {
        later.push({ ...item, force: true, bc: p.id });
        r.queued++;
        continue;
      }
      try {
        await postProductStory({ businessConnectionId: p.id, imageUrl: item.image_url, caption: buildPostCaption(item, s.phone), parseMode: 'HTML', deadline });
        await db.incrStat('stories');
        await db.incrStat(`stories:${p.id}`);
        r.posted++;
        left--;
      } catch (e) {
        logStoryError(p, item, e);
        r.errors.push(tgDescription(e));
        if (notify) await notifyStoryError(item, e, p);
        if (isBlockingStoryError(e)) {
          r.stopped = true;
          later.push({ ...item, force: true, bc: p.id });
          r.queued++;
        } else {
          await db.incrStat('failed');
        }
      }
    }
    out.push(r);
  }
  await db.enqueueStories(later);
  return {
    profiles: out,
    posted: out.reduce((n, p) => n + p.posted, 0),
    queued: later.length,
  };
}

// Admin summary, e.g. "📱 Story: @a ✅, @b ❌ (Bad Request: ...)" plus what is waiting per profile.
export function storySummary(r, total, s) {
  if (r.reason) {
    return [`📱 Story: ❌ ${r.reason}`];
  }
  const count = (p) => (total > 1 ? ` ${p.posted}/${total}` : '');
  const parts = r.profiles.map((p) => {
    const ok = p.posted > 0 || (!p.errors.length && !p.queued);
    const err = p.errors.length ? ` (${esc(p.errors[0])})` : '';
    return `${esc(p.label)} ${ok ? '✅' : '❌'}${count(p)}${err}`;
  });
  const lines = [`📱 Story: ${parts.join(', ')}`];
  for (const p of r.profiles.filter((x) => x.queued)) {
    lines.push(
      p.stopped
        ? `⏳ ${esc(p.label)}: ${p.queued} tasi xato tufayli navbatda — keyinroq qayta uriniladi.`
        : `⏳ ${esc(p.label)}: ${p.queued} tasi kunlik limit (${db.storyDailyLimit(s)}) tufayli navbatda — keyingi kun(lar)da chiqadi.`,
    );
  }
  for (const p of r.profiles) {
    for (const e of p.errors.slice(1, 4)) lines.push(`❗ ${esc(p.label)}: ${esc(e)}`);
    const hint = p.errors.length && storyErrorHint(p.errors[0]);
    if (hint) lines.push(`💡 ${esc(p.label)}: ${hint}`);
  }
  return lines;
}

// Posts up to maxItems from the channel queue to all active channels.
export async function processChannelQueue(s, deadline, maxItems = db.limit(s, 'tick_max_posts')) {
  const result = { posted: 0, skus: [], failed: 0, requeued: 0, dropped: 0, errors: [] };
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
      result.skus.push(item.sku);
    } else if (!r.leftover.includes(item)) {
      await db.incrStat('failed');
      result.failed++;
    }
  }
  await db.requeueFront(r.leftover);
  result.requeued = r.leftover.length;
  return result;
}

// Posts stories from the story queue to every selected profile within each profile's daily limits;
// the rest waits for the next tick/day. Entries without `bc` go to all selected profiles.
export async function processStoryQueue(s, deadline) {
  const result = { new: 0, discount: 0, skus: [], waiting: 0, failed: 0, dropped: 0, errors: [] };
  const all = await db.readStoryQueue();
  if (!all.length) {
    return result;
  }
  const profiles = db.storyProfiles(s, await db.listBiz());
  if (!profiles.length) {
    result.reason = 'no business profile';
    result.waiting = all.length;
    return result;
  }
  const st = await db.getStats();
  const left = Object.fromEntries(
    profiles.map((p) => [
      p.id,
      {
        new: Math.max(0, db.storyDailyLimit(s) - (st[`stories:${p.id}`] || 0)),
        discount: Math.max(0, db.discountStoryLimit(s) - (st[`discount_stories:${p.id}`] || 0)),
      },
    ]),
  );
  const stopped = new Set();
  const keep = [];
  for (const entry of all) {
    if (!storyAllowed(s, entry)) {
      result.dropped++;
      continue;
    }
    const targets = entry.bc ? profiles.filter((p) => p.id === entry.bc) : profiles;
    if (!targets.length) {
      result.dropped++; // that profile was unticked or disconnected
      continue;
    }
    const kind = entry.type === 'discount' ? 'discount' : 'new';
    const statBase = kind === 'discount' ? 'discount_stories' : 'stories';
    for (const p of targets) {
      if (stopped.has(p.id) || left[p.id][kind] <= 0 || Date.now() + 20000 > deadline) {
        keep.push({ ...entry, bc: p.id });
        continue;
      }
      try {
        await postProductStory({
          businessConnectionId: p.id,
          imageUrl: entry.image_url,
          caption: buildPostCaption(entry, s.phone),
          parseMode: 'HTML',
          deadline,
        });
        left[p.id][kind]--;
        result[kind]++;
        if (!result.skus.includes(entry.sku)) result.skus.push(entry.sku);
        await db.incrStat(statBase);
        await db.incrStat(`${statBase}:${p.id}`);
      } catch (e) {
        logStoryError(p, entry, e);
        result.errors.push(`story ${p.label} ${entry.sku}: ${tgDescription(e)}`);
        await notifyStoryError(entry, e, p);
        if (isBlockingStoryError(e)) {
          stopped.add(p.id); // the same error would repeat for this profile: keep its stories
          keep.push({ ...entry, bc: p.id });
        } else {
          result.failed++;
          await db.incrStat('failed');
        }
      }
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
