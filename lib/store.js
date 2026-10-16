import { Redis } from '@upstash/redis';
import { NodeRedis } from './redis-node.js';

const P = 'bito:';
const DAY_TTL = 60 * 60 * 24 * 40;
export const RECENT_LIMIT = 200;
const STORY_QUEUE_LIMIT = 300;
const DEFAULT_ORDER_URL = 'https://t.me/Mixpodarok0307';
const DEFAULT_CONTACT_PHONE = '+998982000307';

export const K = {
  settings: `${P}settings`,
  sent: `${P}sent`, // hash sku -> tracked product { price, stock, date, discount_keys, ... }
  recent: `${P}sent:recent`, // list of tracked skus, newest first
  queue: `${P}queue`, // channel post queue
  squeue: `${P}squeue`, // story queue
  biz: `${P}biz`, // hash business_connection_id -> connection
  errors: `${P}errors`,
  watch: `${P}watch`, // { floor, last_checked_at } for new-product detection
  cursor: `${P}check_cursor`, // position in `recent` for discount checks
  randomHist: `${P}random_hist`, // hash sku -> ms when shown in a random album
  randomBlacklist: `${P}random_blacklist`, // hash sku -> { sku, name, at }: never pick in random
  discountAnnounced: `${P}disc_announced`, // hash `${discountId}:${productId}` -> { sig, sku, at }
  helpers: `${P}helpers`, // hash user_id -> { id, name, dest, active, posts } — "👥 Yordamchi adminlar" (lib/helpers.js)
  knownChannels: `${P}channels:known`, // hash chat_id -> { id, title, username, status, date } — channels the bot was added to (my_chat_member)
  groups: `${P}groups`, // hash chat_id -> { id, title, type, status, can_read, date }
  stock: `${P}stock`, // hash product_id -> stock record (see lib/stock.js)
  stockOut: `${P}stock:out`, // hash product_id -> { at, approx } — products with stock 0
  stockLow: `${P}stock:low`, // hash product_id -> { stock, red, yellow } — 0 < stock <= LOW_INDEX_MAX
  stockAlerts: `${P}stock:alerts`, // list of pending group alerts
  stockScan: `${P}stock:scan`, // { id, day, page, done, seen, total, last_full_at } — catalog pass
  stockPassSeen: `${P}stock:passseen`, // hash product_id -> pass id (indexed products seen in a pass)
  stockPendingSend: `${P}stock:pending`, // { chat, report } — send the out list when the pass is done
  ch2Queue: `${P}ch2:queue`, // items whose "📢 2-kanal" post failed — retried by the tick (lib/channel2.js)
  orders: `${P}orders`, // hash id -> order ("🛒 Buyurtma" in the bot); field "seq" = last id
  salesPath: `${P}sales:path`, // the BITO report path that answered (lib/sales.js)
  aiBackfill: `${P}ai:backfill`, // list of { chat, mid, kb, at, item } — posts that still need their "📝"
  aiLast: `${P}ai:last`, // { at, sku, ok, text | error } — the last AI description attempt
  aiModel: `${P}ai:model`, // the model Google pointed to when the configured one was retired
  aiDesc: `${P}ai:desc`, // hash product_id -> { text, by: 'ai' | 'admin', sku, at } — "🤖 AI tavsif"
  storyLast: `${P}story:last`, // hash business_connection_id -> { at, sku, ok, queued, error } — last story result
  restockQueue: `${P}restock:queue`,
  wait: (pid) => `${P}wait:${pid}`, // hash user_id -> { chat, at, sku, name } — "🔔 Kelganda xabar ber"
  waitIndex: `${P}wait:index`, // hash product_id -> number of waiters
  waitUser: (uid) => `${P}waituser:${uid}`, // hash product_id -> { sku, name, at } // hash product_id -> { pid, sku, name, at } — "🔄 Qayta keldi" auto-posts
  reportMsgs: `${P}stock:report:msgs`, // list of { chat, mid } — every message of the current out-of-stock report
  reportPid: `${P}stock:report:pid`, // hash product_id -> [{ chat, mid, photo }] — its photos / "❌ TUGADI" alerts
  reportLists: `${P}stock:report:lists`, // hash `${chat}:${mid}` -> { chat, mid, lines: [[pid|null, text]] }
  stockDay: (day) => `${P}stock:day:${day}`, // list of { type, pid, at } (out / back) for /bugun
  pending: (userId) => `${P}pending:${userId}`,
  stats: (day) => `${P}stats:${day}`,
  seen: (day) => `${P}seen:${day}`, // hash sku -> 'ok' | skip reason
  flag: (name) => `${P}flag:${name}`,
};

// Cached at module level so warm serverless invocations reuse it.
let client = null;

// Tests inject an in-memory client.
export function setRedis(c) {
  client = c;
}

const restUrl = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const restToken = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

// 'upstash' (REST env) takes priority, otherwise 'redis' (REDIS_URL, TCP via node-redis).
export function redisBackend() {
  if (restUrl() && restToken()) {
    return 'upstash';
  }
  return process.env.REDIS_URL ? 'redis' : null;
}

export const hasRedis = () => Boolean(client || redisBackend());

export function redis() {
  if (!client) {
    const backend = redisBackend();
    if (backend === 'upstash') {
      client = new Redis({ url: restUrl(), token: restToken() });
    } else if (backend === 'redis') {
      client = new NodeRedis(process.env.REDIS_URL);
    } else {
      throw new Error('Redis is not configured (REDIS_URL, or UPSTASH_REDIS_REST_URL/TOKEN, or KV_REST_API_URL/TOKEN)');
    }
  }
  return client;
}

// YYYY-MM-DD in Asia/Tashkent.
export const today = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });

const envNumber = (name, fallback) => {
  const v = process.env[name];
  return v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : fallback;
};

// ---- settings ----

// Numeric limits editable in the admin panel; env only sets the default.
export const LIMITS = {
  story_limit: { env: 'STORY_DAILY_LIMIT', def: 20, min: 0, max: 100 },
  discount_story_limit: { env: 'DISCOUNT_STORY_DAILY_LIMIT', def: 5, min: 0, max: 100 },
  random_album_size: { env: 'RANDOM_ALBUM_SIZE', def: 8, min: 2, max: 10 },
  tick_max_posts: { env: 'TICK_MAX_POSTS', def: 10, min: 1, max: 50 },
  random_repeat_days: { env: 'RANDOM_REPEAT_DAYS', def: 7, min: 0, max: 60 },
  low_stock_threshold: { env: 'LOW_STOCK_THRESHOLD', def: 3, min: 0, max: 1000 },
  restock_days: { env: 'RESTOCK_DEDUP_DAYS', def: 7, min: 1, max: 60 },
  restock_per_tick: { env: 'RESTOCK_PER_TICK', def: 5, min: 1, max: 50 },
  restock_min_stock: { env: 'RESTOCK_MIN_STOCK', def: 1, min: 1, max: 1000 },
  unsold_days: { env: 'UNSOLD_DAYS', def: 60, min: 7, max: 365 },
  reorder_days: { env: 'REORDER_DAYS', def: 7, min: 1, max: 60 },
};

export function limit(settings, field) {
  const l = LIMITS[field];
  const v = Number(settings[field]);
  return Number.isFinite(v) ? Math.min(l.max, Math.max(l.min, Math.round(v))) : l.def;
}

export function defaultSettings() {
  const { CONTACT_PHONE, CHANNEL_ID, BUSINESS_CONNECTION_ID, ORDER_URL } = process.env;
  return {
    phone: CONTACT_PHONE || DEFAULT_CONTACT_PHONE,
    channels: CHANNEL_ID ? [{ id: CHANNEL_ID, title: CHANNEL_ID, active: true }] : [],
    order_url: ORDER_URL || DEFAULT_ORDER_URL,
    story_bc: BUSINESS_CONNECTION_ID || '',
    new_channel: true,
    new_story: false,
    discount_channel: true,
    discount_story: false,
    random_album: false,
    random_story: false,
    random_view: 'single', // 'single' (separate posts) | 'album'
    // Stock group ("📦 Ombor guruhi")
    stock_group: process.env.STOCK_GROUP_ID || '',
    stock_alerts: true,
    stock_commands: true,
    stock_daily: true,
    stock_daily_time: process.env.STOCK_DAILY_TIME || '09:00',
    // Separate groups for "❌ TUGADI", "✅ QAYTA KELDI" and the out-of-stock report ('' = the stock group).
    stock_out_group: '',
    new_group: '', // "🆕 Yangi mahsulot → guruh" ('' = off)
    ai_desc: process.env.AI_DESC !== 'false', // "🤖 AI tavsif" (works only with GEMINI_API_KEY)
    ai_channel: true, // ... shown in channel posts
    ai_group: true, // ... in group posts ("✅ Qayta keldi", "🆕 Yangi mahsulot → guruh")
    ai_story: true, // ... in stories
    photo_search: true,
    channel2: null, // "📢 2-kanal": { id, title, username, enabled, markup_percent } (lib/channel2.js)
    order_in_bot: true, // "🛒 Buyurtma berish" opens the order in the bot (false: the manager link)
    order_group: '', // where orders go ('' = the admins)
    order_bito: false, // also create a sale order in BITO (test mode)
    bot_username: '',
    weekly_report: true, // "📈 Haftalik hisobot" on Mondays
    reorder_daily: true, // "🛒 Buyurtma qilish kerak" with the daily list // "📷 Rasm bo'yicha qidirish" (Gemini; customers, admins, stock groups)
    stock_back_group: '',
    stock_report_group: '',
    album: false,
    restock_post: process.env.RESTOCK_POST !== 'false', // "🔄 Qayta keldi" -> channel + stories
    restock_night: process.env.RESTOCK_NIGHT !== 'false', // also 23:00-08:00 (false: held till morning)
    ...Object.fromEntries(Object.entries(LIMITS).map(([field, l]) => [field, envNumber(l.env, l.def)])),
  };
}

// Saved values override env defaults; a field missing in the DB falls back to env.
export async function getSettings() {
  const saved = hasRedis() ? await redis().get(K.settings) : null;
  const merged = { ...defaultSettings() };
  for (const [k, v] of Object.entries(saved || {})) {
    if (v !== null && v !== undefined && v !== '') {
      merged[k] = v;
    }
  }
  return merged;
}

export async function getSettingsSafe() {
  try {
    return await getSettings();
  } catch {
    return defaultSettings();
  }
}

export async function updateSettings(patch) {
  const saved = (await redis().get(K.settings)) || {};
  await redis().set(K.settings, { ...saved, ...patch });
  return getSettings();
}

export const storyDailyLimit = (settings) => limit(settings, 'story_limit');
export const discountStoryLimit = (settings) => limit(settings, 'discount_story_limit');

export const bizLabel = (b) =>
  b ? (b.user?.username ? `@${b.user.username}` : b.user?.first_name || b.id) : '';

// Why a stored connection does (not) get stories: 'ok' | 'disabled' (is_enabled false) | 'no_rights'
// (can_manage_stories false) | 'off' (unticked in "📸 Istoriya profillari": settings.story_bcs[id] === false).
export function storyState(settings, c) {
  if (c.is_enabled === false) return 'disabled';
  if (c.rights && c.rights.can_manage_stories === false) return 'no_rights';
  if ((settings.story_bcs || {})[c.id] === false) return 'off';
  return 'ok';
}

// Business profiles stories go to: every enabled connection with story rights that the admin did not
// untick. Without any stored connection, BUSINESS_CONNECTION_ID is used.
export function storyProfiles(settings, connections = []) {
  if (!connections.length) {
    const env = process.env.BUSINESS_CONNECTION_ID || settings.story_bc;
    return env ? [{ id: env, label: 'env' }] : [];
  }
  return connections.filter((c) => storyState(settings, c) === 'ok').map((c) => ({ id: c.id, label: bizLabel(c) }));
}

// Last story result per profile (shown in "📸 Istoriya profillari" and /api/business-id).
export async function setStoryLast(id, rec) {
  if (hasRedis()) await redis().hset(K.storyLast, { [id]: { at: Date.now(), ...rec } });
}
export const getStoryLast = async () => (hasRedis() ? (await redis().hgetall(K.storyLast)) || {} : {});

// ---- business connections ----

// Saves a business connection; returns the previously stored one (null if new).
export async function saveBiz(c) {
  const prev = await redis().hget(K.biz, c.id);
  await redis().hset(K.biz, {
    [c.id]: {
      id: c.id,
      user: c.user ? { id: c.user.id, first_name: c.user.first_name, username: c.user.username } : null,
      user_chat_id: c.user_chat_id,
      rights: c.rights ?? null,
      is_enabled: c.is_enabled,
      date: c.date,
    },
  });
  return prev;
}

export async function listBiz() {
  if (!hasRedis()) {
    return [];
  }
  const all = (await redis().hgetall(K.biz)) || {};
  return Object.values(all).sort((a, b) => (b.date || 0) - (a.date || 0));
}

// ---- tracked products ----

export const getSent = (sku) => redis().hget(K.sent, String(sku));

export async function recentSkus(limit = RECENT_LIMIT) {
  const list = (await redis().lrange(K.recent, 0, limit - 1)) || [];
  return list.map(String);
}

export async function updateSent(sku, patch) {
  const rec = (await getSent(sku)) || {};
  await redis().hset(K.sent, { [String(sku)]: { ...rec, ...patch } });
}

// Creates or updates a tracked product (used for duplicate and discount checks).
export async function upsertProduct(item, patch = {}, day = today()) {
  const sku = String(item.sku);
  const prev = await getSent(sku);
  await redis().hset(K.sent, {
    [sku]: {
      ...(prev || {}),
      sku,
      product_id: item.product_id,
      name: item.name,
      price: item.price,
      stock: item.stock,
      image_url: item.image_url,
      date: prev?.date || day,
      ...patch,
    },
  });
  if (!prev) {
    await redis().lpush(K.recent, sku);
    await redis().ltrim(K.recent, 0, RECENT_LIMIT - 1);
  }
}

export async function getCursor() {
  return Number(await redis().get(K.cursor)) || 0;
}

export const setCursor = (n) => redis().set(K.cursor, n);

export const getWatch = () => redis().get(K.watch);
export const setWatch = (w) => redis().set(K.watch, w);

// ---- queues ----

export async function enqueue(items) {
  if (items.length) {
    await redis().rpush(K.queue, ...items);
  }
}

export async function popQueue(n) {
  const items = await redis().lpop(K.queue, n);
  return Array.isArray(items) ? items : items ? [items] : [];
}

// Puts items back at the front, preserving their order.
export async function requeueFront(items) {
  if (items.length) {
    await redis().lpush(K.queue, ...[...items].reverse());
  }
}

export const queueLength = async () => (hasRedis() ? Number(await redis().llen(K.queue)) || 0 : 0);

export async function enqueueStories(items) {
  if (items.length) {
    await redis().rpush(K.squeue, ...items);
    await redis().ltrim(K.squeue, -STORY_QUEUE_LIMIT, -1);
  }
}

export const readStoryQueue = async () => (await redis().lrange(K.squeue, 0, -1)) || [];

// Replaces the story queue (only called while holding the tick lock).
export async function writeStoryQueue(items) {
  await redis().del(K.squeue);
  if (items.length) {
    await redis().rpush(K.squeue, ...items);
  }
}

export const storyQueueLength = async () => (hasRedis() ? Number(await redis().llen(K.squeue)) || 0 : 0);

// ---- random album history ----

export const getRandomHist = async () => (await redis().hgetall(K.randomHist)) || {};

export async function addRandomHist(skus, at = Date.now()) {
  if (skus.length) {
    await redis().hset(K.randomHist, Object.fromEntries(skus.map((s) => [String(s), at])));
  }
}

export async function dropRandomHist(skus) {
  if (skus.length) {
    await redis().hdel(K.randomHist, ...skus);
  }
}

// ---- announced BITO discounts ----

export const getAnnounced = async () => (await redis().hgetall(K.discountAnnounced)) || {};

export async function markAnnounced(key, value) {
  await redis().hset(K.discountAnnounced, { [key]: value });
}

export async function dropAnnounced(keys) {
  if (keys.length) {
    await redis().hdel(K.discountAnnounced, ...keys);
  }
}

// ---- groups the bot is in ----

export async function saveGroup(g) {
  const prev = (await redis().hget(K.groups, String(g.id))) || {};
  await redis().hset(K.groups, { [String(g.id)]: { ...prev, ...g, id: String(g.id) } });
}

export async function listGroups() {
  if (!hasRedis()) return [];
  const all = (await redis().hgetall(K.groups)) || {};
  return Object.values(all).sort((a, b) => (b.date || 0) - (a.date || 0));
}

export const getGroup = (id) => redis().hget(K.groups, String(id));

// Channels the bot was added to / made admin of (my_chat_member) — "📅 Sana bo'yicha yuborish" targets.
export async function saveKnownChannel(c) {
  const prev = (await redis().hget(K.knownChannels, String(c.id))) || {};
  await redis().hset(K.knownChannels, { [String(c.id)]: { ...prev, ...c, id: String(c.id) } });
}

export async function listKnownChannels() {
  if (!hasRedis()) return [];
  const all = (await redis().hgetall(K.knownChannels)) || {};
  return Object.values(all).sort((a, b) => (b.date || 0) - (a.date || 0));
}

// ---- random blacklist ----

export async function addRandomBlacklist(item) {
  await redis().hset(K.randomBlacklist, { [String(item.sku)]: { sku: String(item.sku), name: item.name, at: Date.now() } });
}

export const removeRandomBlacklist = (sku) => redis().hdel(K.randomBlacklist, String(sku));

// Newest first.
export async function getRandomBlacklist() {
  const all = (await redis().hgetall(K.randomBlacklist)) || {};
  return Object.values(all).sort((a, b) => (b.at || 0) - (a.at || 0));
}

// ---- stats ----

export async function getStats(day = today()) {
  const raw = (await redis().hgetall(K.stats(day))) || {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = Number(v) || 0;
  }
  return out;
}

// Sets stat fields to absolute values (e.g. the current number of active discounts).
export async function setStats(fields, day = today()) {
  await redis().hset(K.stats(day), fields);
  await redis().expire(K.stats(day), DAY_TTL);
}

export async function incrStat(field, n = 1, day = today()) {
  if (!n) {
    return;
  }
  await redis().hincrby(K.stats(day), field, n);
  await redis().expire(K.stats(day), DAY_TTL);
}

export async function markSeen(sku, status, day = today()) {
  await redis().hset(K.seen(day), { [String(sku)]: status });
  await redis().expire(K.seen(day), DAY_TTL);
}

export const getSeen = async (day = today()) => (await redis().hgetall(K.seen(day))) || {};

export async function logError(text) {
  await redis().lpush(K.errors, `${new Date().toISOString()} ${text}`);
  await redis().ltrim(K.errors, 0, 49);
}

// ---- cache ----

// Returns the cached value or loads, caches (ttl seconds) and returns it. Without Redis, just loads.
// keep(value) decides what is cached (default: anything but null/undefined).
export async function cached(key, ttl, load, { keep = (v) => v !== null && v !== undefined } = {}) {
  if (!hasRedis() || !(ttl > 0)) {
    return load();
  }
  const k = `${P}cache:${key}`;
  const hit = await redis().get(k).catch(() => null);
  if (hit !== null && hit !== undefined) {
    return hit.v;
  }
  const value = await load();
  if (keep(value)) {
    await redis().set(k, { v: value }, { ex: ttl }).catch(() => {});
  }
  return value;
}

// ---- misc ----

// Admin's manual selection (SKU or random) waiting for a button press.
export const saveSelection = (id, data) => redis().set(`${P}sel:${id}`, data, { ex: 60 * 60 * 6 });
export const getSelection = (id) => redis().get(`${P}sel:${id}`);
export const deleteSelection = (id) => redis().del(`${P}sel:${id}`);

export const setPending = (userId, state) => redis().set(K.pending(userId), state, { ex: 600 });
export const getPending = (userId) => redis().get(K.pending(userId));
export const clearPending = (userId) => redis().del(K.pending(userId));

// true the first time a key is seen (within ttl).
export async function once(key, ttl = 60 * 60 * 24 * 2) {
  return (await redis().set(K.flag(key), 1, { nx: true, ex: ttl })) === 'OK';
}

export const clearFlag = (key) => redis().del(K.flag(key));
// Telegram re-sends an update it did not get a quick 200 for; each update_id is handled once (10 min).
export const firstUpdate = (updateId) => once(`upd:${updateId}`, 10 * 60);
export const lock = (name, ttl) => once(`lock:${name}`, ttl);
export const unlock = (name) => clearFlag(`lock:${name}`);
