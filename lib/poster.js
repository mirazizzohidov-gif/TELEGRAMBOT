import { rememberForDesc, withDescriptions } from './ai.js';
import { buildPostCaption } from './caption.js';
import { CH2_MAX_TRIES, ch2AlreadySent, ch2Item, ch2MarkSent, ch2Settings, channel2Target, enqueueCh2, popCh2Queue } from './channel2.js';
import { orderKb } from './orders.js';
import { notifyAdmins } from './report.js';
import * as db from './store.js';
import { downloadImage, postStory, toStoryJpeg } from './story.js';
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
    caption: buildPostCaption(i, settings.phone, { lowAt: db.limit(settings, 'low_stock_threshold'), desc: settings.ai_channel !== false }),
    parse_mode: 'HTML',
  }));
  const kb = orderKb(settings);
  const errors = [];
  let ok = false;
  let rateLimited = false;
  for (const ch of channels) {
    try {
      const msgs = await tg('sendMediaGroup', { chat_id: ch.id, media, protect_content: protect() }, { deadline });
      for (let n = 0; n < items.length; n++) await rememberForDesc(settings, items[n], msgs?.[n], ch.id, { kb: false, show: settings.ai_channel !== false }).catch(() => {});
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
      const msg = await tg(
        'sendPhoto',
        {
          chat_id: ch.id,
          photo: item.image_url,
          caption: buildPostCaption(item, settings.phone, { lowAt: db.limit(settings, 'low_stock_threshold'), desc: settings.ai_channel !== false }),
          parse_mode: 'HTML',
          reply_markup: orderKb(settings, item),
          protect_content: protect(),
        },
        { deadline },
      );
      await rememberForDesc(settings, item, msg, ch.id, { show: settings.ai_channel !== false }).catch(() => {});
      ok = true;
    } catch (e) {
      rateLimited ||= e.code === 429;
      errors.push(`${ch.id}: ${item.sku}: ${errText(e)}`);
    }
  }
  return { ok, rateLimited, errors };
}

// "📢 2-kanal": the same posts with the marked-up price (channel2.js). Items already there (item.ch2_done,
// or the same automatic post within 12 h) are skipped; failures are collected in c2 for the retry queue.
// Never throws — the main channels and the stories do not depend on it.
async function sendToChannel2(items, settings, t, deadline, c2, opts) {
  const todo = [];
  for (const i of items) {
    if (i.ch2_done) continue;
    // random posts repeat on purpose (the 1st channel posts them again too): no 12 h dedupe for them
    if (!opts.manual && !opts.test && !i.random && (await ch2AlreadySent(t, i))) {
      i.ch2_done = true;
      c2.skipped++;
      continue;
    }
    todo.push(i);
  }
  if (!todo.length) return;
  const chan = [{ id: t.id }];
  settings = ch2Settings(settings); // its own phone and order button (or the main channel's)
  const done = async (i) => {
    i.ch2_done = true;
    c2.posted++;
    c2.ok.add(i);
    if (!opts.test) {
      if (!i.random) await ch2MarkSent(t, i);
      if (db.hasRedis()) await db.incrStat('ch2_posted').catch(() => {});
    }
  };
  const fail = (i, err) => {
    c2.failed.push(i);
    c2.errors.push(err);
  };
  try {
    if (settings.album && todo.length >= 2) {
      const r = await sendAlbum(todo.map((i) => ch2Item(i, t.markup)), settings, chan, deadline);
      if (r.ok) {
        for (const i of todo) await done(i);
        return;
      }
      c2.errors.push(...r.errors.map(stripChat));
    }
    for (const i of todo) {
      if (Date.now() + 5000 > deadline) {
        fail(i, 'vaqt yetmadi');
        continue;
      }
      const r = await sendSingle(ch2Item(i, t.markup), settings, chan, deadline);
      if (r.ok) await done(i);
      else fail(i, stripChat(r.errors[0] || 'xato'));
    }
  } catch (e) {
    for (const i of todo.filter((x) => !x.ch2_done)) fail(i, errText(e));
  }
}

// "-100123: 1001: Bad Request: ..." -> "Bad Request: ..." (the 2nd channel report names the channel itself)
const stripChat = (e) => String(e).replace(/^-?\w+: (?:album: |\d[\d-]*: )?/, '');

// Sends items to channels: albums of up to 10 when settings.album and 2+ items, otherwise one by one
// (3 s apart). After each post the same goes to the "📢 2-kanal" (when switched on) with the marked-up
// price; its errors only go to result.ch2 (and its retry queue).
// opts: ch2 (target; undefined = from the settings, null = none), manual (admin asked: no 12 h dedupe,
// no admin notice — the caller reports), test (to the admin's chat: nothing recorded or queued).
// Returns { posted: Set<item>, leftover: item[] (to requeue), errors, ch2: { target, posted, skipped, queued, dropped, errors } }.
export async function postToChannels(items, settings, channels, deadline, opts = {}) {
  if (settings.ai_channel !== false) await withDescriptions(items, settings, { deadline }); // "📝" AI description (same objects, filled in)
  const posted = new Set();
  const errors = [];
  const leftover = [];
  const ch2 = opts.ch2 === undefined ? channel2Target(settings) : opts.ch2;
  const c2 = { target: ch2, posted: 0, skipped: 0, queued: 0, dropped: 0, errors: [], failed: [], ok: new Set() };
  const groups = settings.album && items.length >= 2 ? chunk(items, ALBUM_MAX) : items.map((i) => [i]);

  for (let n = 0; n < groups.length; n++) {
    const group = groups[n];
    if (Date.now() + 15000 > deadline) {
      leftover.push(...groups.slice(n).flat());
      break;
    }
    if (!channels.length) {
      // only the 2nd channel (no active main channel)
    } else if (group.length >= 2) {
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
    // Items going back to the main queue (429) get their 2nd-channel post with that retry.
    if (ch2) await sendToChannel2(group.filter((i) => !leftover.includes(i)), settings, ch2, deadline, c2, opts);
    if (n < groups.length - 1) {
      await clock.sleep(ITEM_DELAY_MS);
    }
  }
  if (!channels.length) for (const i of c2.ok) posted.add(i); // the 2nd channel is the only one
  if (ch2 && c2.failed.length && !opts.test) {
    const again = c2.failed.filter((i) => !leftover.includes(i) && (i.ch2_tries || 0) + 1 < CH2_MAX_TRIES);
    c2.dropped = c2.failed.length - again.length - c2.failed.filter((i) => leftover.includes(i)).length;
    await enqueueCh2(again).catch(() => {});
    c2.queued = again.length;
    if (db.hasRedis()) await db.incrStat('ch2_failed').catch(() => {});
    if (!opts.manual && opts.notify !== false) await notifyCh2Error(ch2, c2);
  }
  const { failed, ok, ...ch2Result } = c2;
  return { posted, leftover, errors, ch2: ch2Result };
}

// Automatic posts: admins hear about a 2nd-channel error (the same one at most once an hour).
async function notifyCh2Error(t, c2) {
  const why = String(c2.errors[0] || 'xato').slice(0, 200);
  if (!(await db.once(`ch2err:${t.id}:${why.slice(0, 100)}`, 60 * 60).catch(() => true))) return;
  const skus = c2.failed.map((i) => i.sku).join(', ');
  await notifyAdmins({
    text: `📢 2-kanal (${esc(t.title)}) ❌ ${esc(why)}
SKU: ${esc(skus)}${c2.queued ? `
⏳ ${c2.queued} tasi keyingi tekshiruvda qayta yuboriladi.` : ''}
1-kanal va istoriyalar bunga bog'liq emas.`,
    parse_mode: 'HTML',
  }).catch(() => {});
}

// The 2nd channel's retry queue (posts that failed only there): every tick, a few at a time.
export async function processChannel2Queue(s, deadline, max = 5) {
  const t = channel2Target(s);
  const result = { posted: 0, waiting: 0, dropped: 0, errors: [] };
  const items = await popCh2Queue(max);
  if (!items.length) return result;
  if (!t) {
    result.dropped = items.length; // switched off or disconnected meanwhile
    return result;
  }
  const r = await postToChannels(items, { ...s, album: false, ai_channel: false }, [], deadline, { ch2: t, retry: true });
  result.posted = r.ch2.posted;
  result.dropped = r.ch2.dropped;
  result.errors = r.ch2.errors;
  result.waiting = r.ch2.queued;
  return result;
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

// Tells admins about a story error from an automatic job; the same error for the same profile at most
// once per hour (the job runs every 15 minutes).
async function notifyStoryError(item, e, profile) {
  if (await db.once(`storyerr:${profile.id}:${tgDescription(e).slice(0, 120)}`, 60 * 60)) {
    await notifyAdmins({ text: storyErrorText(item, e, profile), parse_mode: 'HTML' });
  }
}

const NO_PROFILE = "Istoriya uchun profil yo'q — botni Telegram Business'ga ulang yoki \"📸 Istoriya profillari\"da profilni belgilang.";

const RETRY_PAUSE_MS = 2000;
const STORY_TIME_MS = 15000; // a story is not started with less time left before the deadline

// The one place every story goes through (new product, discount, random, SKU, "🔄 Qayta keldi", test,
// /api/story): the item is posted to EVERY selected profile (enabled, story rights, not unticked), each
// in its own try/catch with one retry, each result logged as "story -> @label: ok / xato <description>".
// A profile over its daily limit, out of time, or with an error that will repeat (rights, connection,
// account limit, 429) gets the item back as `later` ({ ...item, bc }) — the caller queues it.
// opts: kind 'new' | 'discount' (which daily limit), only (one profile id), profiles, stats (shared
// counters for a batch), stopped (Set of profile ids that already hit a repeating error), caption,
// activePeriod, ignoreLimit, notify (send admins the error with a hint).
// Returns { profiles: [{ id, label, ok, queued, error, story_id }], posted, later }.
export async function postStoryToAll(item, s, opts = {}) {
  const deadline = opts.deadline ?? Date.now() + 120000;
  const kind = opts.kind || (item.type === 'discount' ? 'discount' : 'new');
  const all = opts.profiles || db.storyProfiles(s, await db.listBiz());
  const targets = opts.only ? all.filter((p) => p.id === opts.only) : all;
  const redisOn = db.hasRedis(); // /api/story also works without Redis (no counters then)
  const st = opts.stats || (redisOn ? await db.getStats() : {});
  const stopped = opts.stopped || new Set();
  const statBase = kind === 'discount' ? 'discount_stories' : 'stories';
  const dayLimit = kind === 'discount' ? db.discountStoryLimit(s) : db.storyDailyLimit(s);
  if (!opts.caption && s.ai_story !== false) await withDescriptions([item], s, { deadline });
  const caption = opts.caption ?? buildPostCaption(item, s.phone, { lowAt: db.limit(s, 'low_stock_threshold'), desc: s.ai_story !== false });
  const out = [];
  const later = [];
  let photo = null;
  for (const p of targets) {
    const r = { id: p.id, label: p.label, ok: false, queued: false, error: null };
    out.push(r);
    const requeue = (why) => {
      r.queued = true;
      r.error = why;
      later.push({ ...item, bc: p.id });
      console.log(`story -> ${p.label}: navbatda (${why}) sku=${item.sku}`);
      return db.setStoryLast(p.id, { sku: item.sku, ok: false, queued: true, error: why }).catch(() => {});
    };
    if (stopped.has(p.id)) {
      await requeue(stopped.reason?.get(p.id) || 'oldingi xato');
      continue;
    }
    if (!opts.ignoreLimit && (st[`${statBase}:${p.id}`] || 0) >= dayLimit) {
      await requeue(`kunlik limit ${dayLimit}`);
      continue;
    }
    if (Date.now() + STORY_TIME_MS > deadline) {
      await requeue('vaqt yetmadi');
      continue;
    }
    let err = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        photo ||= await toStoryJpeg(await downloadImage(item.image_url));
        const story = await postStory({
          businessConnectionId: p.id,
          photo,
          caption,
          parseMode: 'HTML',
          activePeriod: opts.activePeriod,
          deadline,
        });
        r.story_id = story?.id;
        err = null;
        break;
      } catch (e) {
        err = e;
        console.error(`story -> ${p.label}: xato ${tgDescription(e)} (urinish ${attempt}/2, sku=${item.sku}, id=${p.id})`);
        if (attempt === 1 && Date.now() + STORY_TIME_MS + RETRY_PAUSE_MS < deadline) await clock.sleep(RETRY_PAUSE_MS);
        else break;
      }
    }
    if (!err) {
      r.ok = true;
      st[`${statBase}:${p.id}`] = (st[`${statBase}:${p.id}`] || 0) + 1;
      if (redisOn) {
        await db.incrStat(statBase);
        await db.incrStat(`${statBase}:${p.id}`);
      }
      console.log(`story -> ${p.label}: ok sku=${item.sku}`);
      await db.setStoryLast(p.id, { sku: item.sku, ok: true }).catch(() => {});
      continue;
    }
    r.error = tgDescription(err);
    await db.setStoryLast(p.id, { sku: item.sku, ok: false, error: r.error }).catch(() => {});
    if (opts.notify) await notifyStoryError(item, err, p);
    if (isBlockingStoryError(err) && !opts.noQueue) {
      // The same error would hit this profile's next stories too: keep them for later.
      stopped.add(p.id);
      (stopped.reason ||= new Map()).set(p.id, r.error);
      r.queued = true;
      r.blocked = true;
      later.push({ ...item, bc: p.id });
    } else if (redisOn) {
      await db.incrStat('failed');
    }
  }
  return { profiles: out, posted: out.filter((r) => r.ok).length, later };
}

// "📸 Istoriya: @Mixpodarok0307 ✅, @Shtabfoto ❌ BUSINESS_PEER_INVALID" (one item).
export function storyLine(r) {
  if (!r.profiles.length) return `📸 Istoriya: ❌ ${NO_PROFILE}`;
  return `📸 Istoriya: ${r.profiles
    .map((p) => `${esc(p.label)} ${p.ok ? '✅' : p.blocked ? `❌ ${esc(p.error)} (navbatda, keyinroq qayta)` : p.queued ? `⏳ ${esc(p.error || 'navbatda')}` : `❌ ${esc(p.error || '')}`}`)
    .join(', ')}`;
}

// Posts each item as a story to EVERY selected business profile (postStoryToAll); what does not go
// now (limit, time, repeating error) is queued per profile for later.
// Returns { profiles: [{ id, label, posted, queued, stopped, errors: [description] }], posted, queued, reason, items }.
export async function postStoriesNow(items, s, { deadline = Date.now() + 120000, notify = false } = {}) {
  const profiles = db.storyProfiles(s, await db.listBiz());
  if (!profiles.length) {
    return { profiles: [], posted: 0, queued: 0, reason: NO_PROFILE, items: [] };
  }
  const st = await db.getStats();
  const stopped = new Set();
  const later = [];
  const per = new Map(profiles.map((p) => [p.id, { ...p, posted: 0, queued: 0, stopped: false, errors: [] }]));
  const each = [];
  for (const item of items) {
    const r = await postStoryToAll(item, s, { deadline, notify, profiles, stats: st, stopped, kind: 'new' });
    each.push({ sku: item.sku, ...r });
    later.push(...r.later.map((x) => ({ ...x, force: true })));
    for (const x of r.profiles) {
      const agg = per.get(x.id);
      if (x.ok) agg.posted++;
      else if (x.queued) agg.queued++;
      if (!x.ok && x.error && !(x.queued && /^kunlik limit|^vaqt yetmadi/.test(x.error))) agg.errors.push(x.error);
      if (stopped.has(x.id)) agg.stopped = true;
    }
  }
  await db.enqueueStories(later);
  const out = [...per.values()];
  return { profiles: out, posted: out.reduce((n, p) => n + p.posted, 0), queued: later.length, items: each };
}

// Admin summary, e.g. "📸 Istoriya: @a ✅, @b ❌ Bad Request: ..." plus what is waiting per profile.
export function storySummary(r, total, s) {
  if (r.reason) {
    return [`📸 Istoriya: ❌ ${r.reason}`];
  }
  const count = (p) => (total > 1 ? ` ${p.posted}/${total}` : '');
  const parts = r.profiles.map((p) => {
    const ok = p.posted > 0 || (!p.errors.length && !p.queued);
    const err = p.errors.length ? ` ${esc(p.errors[0])}` : '';
    return `${esc(p.label)} ${ok ? '✅' : '❌'}${count(p)}${err}`;
  });
  const lines = [`📸 Istoriya: ${parts.join(', ')}`];
  for (const p of r.profiles.filter((x) => x.queued)) {
    lines.push(
      p.stopped
        ? `⏳ ${esc(p.label)}: ${p.queued} tasi xato tufayli navbatda — keyinroq qayta uriniladi.`
        : `⏳ ${esc(p.label)}: ${p.queued} tasi kunlik limit (${db.storyDailyLimit(s)}) yoki vaqt tufayli navbatda — keyinroq chiqadi.`,
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
  if (!channels.length && !channel2Target(s)) {
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
  result.ch2 = r.ch2;
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

// Posts stories from the story queue (automatic new-product / discount stories and leftovers) to every
// selected profile through postStoryToAll — all profiles of one item together, so a short time budget
// cannot post it on one profile and silently leave the others. What does not go now stays queued per
// profile. Admins get one "📸 Istoriya: @a ✅, @b ❌ sabab" line per item.
export async function processStoryQueue(s, deadline) {
  const result = { new: 0, discount: 0, skus: [], waiting: 0, failed: 0, dropped: 0, errors: [], lines: [] };
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
  const stopped = new Set();
  const stoppedBefore = new Set(); // profiles stopped by an earlier item of this run
  const hints = new Set();
  const keep = [];
  for (const entry of all) {
    if (!storyAllowed(s, entry)) {
      result.dropped++;
      continue;
    }
    if (entry.bc && !profiles.some((p) => p.id === entry.bc)) {
      result.dropped++; // that profile was unticked or disconnected
      continue;
    }
    // Not enough time for every profile of this item: the whole item waits for the next tick.
    const need = (entry.bc ? 1 : profiles.length) * STORY_TIME_MS;
    if (Date.now() + need > deadline) {
      keep.push(entry);
      continue;
    }
    const kind = entry.type === 'discount' ? 'discount' : 'new';
    const r = await postStoryToAll(entry, s, { deadline, kind, only: entry.bc, profiles, stats: st, stopped });
    keep.push(...r.later);
    if (r.posted) {
      result[kind] += r.posted;
      if (!result.skus.includes(entry.sku)) result.skus.push(entry.sku);
    }
    for (const x of r.profiles.filter((x) => !x.ok && !x.queued)) {
      result.failed++;
      result.errors.push(`story ${x.label} ${entry.sku}: ${x.error}`);
    }
    // Reported: every success; an error only the first time per profile + error within an hour
    // (a broken profile is retried every tick); waiting for the limit / time is not news.
    const tried = r.profiles.filter((x) => x.ok || (x.error && !/^kunlik limit|^vaqt yetmadi/.test(x.error) && !stoppedBefore.has(x.id)));
    let news = tried.some((x) => x.ok);
    // A profile left waiting (limit / time) is told once per item, so nothing waits silently.
    for (const x of r.profiles.filter((y) => y.queued && !y.blocked)) {
      if (await db.once(`storywait:${x.id}:${entry.sku}`, 60 * 60 * 24)) news = true;
    }
    for (const x of tried.filter((y) => !y.ok)) {
      if (await db.once(`storyrep:${x.id}:${String(x.error).slice(0, 120)}`, 60 * 60)) {
        news = true;
        const hint = storyErrorHint(x.error);
        if (hint) hints.add(`💡 ${esc(x.label)}: ${hint}`);
      }
    }
    if (news) result.lines.push(`SKU ${esc(entry.sku)} — ${storyLine(r)}`);
    for (const id of stopped) stoppedBefore.add(id);
  }
  await db.writeStoryQueue(keep);
  result.waiting = keep.length;
  if (result.lines.length) {
    await notifyAdmins({ text: [...result.lines, ...hints].join('\n'), parse_mode: 'HTML' });
  }
  return result;
}

// Admin manual posting: posts items right now to the active channels, bypassing toggles and the
// duplicate check. album: send 2+ items as albums (default) or as separate posts.
// Items that did not fit before the deadline (or hit 429) are queued and returned in `queued`.
// manual: the admin asked (no 12 h 2nd-channel dedupe; the caller shows the "📢 2-kanal" line).
export async function postItemsNow(items, settings, { deadline = Date.now() + 120000, album = true, stat, manual = false } = {}) {
  const channels = settings.channels.filter((c) => c.active);
  if (!channels.length && !channel2Target(settings)) {
    return { posted: [], queued: [], channels: 0, errors: ["Faol kanal yo'q"] };
  }
  const r = await postToChannels(items, { ...settings, album: album && items.length >= 2 }, channels, deadline, { manual });
  const posted = items.filter((i) => r.posted.has(i));
  for (const item of posted) {
    await db.upsertProduct(item, { posted_at: Date.now() });
    await db.incrStat(stat || postedStat(item));
  }
  const queued = r.leftover.map((i) => ({ ...i, force: true }));
  await db.enqueue(queued);
  return { posted, queued, channels: channels.length, errors: r.errors, ch2: r.ch2 };
}

// "🧪 Test": the same posts as in the channel, sent only to the admin's chat. Nothing is recorded.
// With the "📢 2-kanal" on, the same posts follow with its marked-up price.
export async function postItemsTest(items, settings, chatId, { album = true } = {}) {
  const s = { ...settings, album: album && items.length >= 2 };
  const r = await postToChannels(items, s, [{ id: chatId }], Date.now() + 120000, { ch2: null, test: true });
  const out = { posted: items.filter((i) => r.posted.has(i)).length, errors: r.errors };
  const t = channel2Target(settings);
  if (t) {
    await tg('sendMessage', { chat_id: chatId, text: `👇 2-kanal (${t.title}) ko'rinishi — narx +${t.markup}%:` }).catch(() => {});
    const copies = items.map((i) => ({ ...i, ch2_done: false }));
    const r2 = await postToChannels(copies, s, [], Date.now() + 120000, { ch2: { ...t, id: String(chatId) }, test: true, manual: true });
    out.ch2 = { ...r2.ch2, target: t };
  }
  return out;
}
