import { Redis } from '@upstash/redis';

const P = 'bito:';
const STATS_TTL = 60 * 60 * 24 * 40;
export const RECENT_LIMIT = 200;
const DEFAULT_ORDER_URL = 'https://t.me/Mixpodarok0307';
const DEFAULT_CONTACT_PHONE = '+998982000307';

export const K = {
  settings: `${P}settings`,
  sent: `${P}sent`, // hash sku -> { price, stock, date, ... }
  recent: `${P}sent:recent`, // list of skus, newest first
  queue: `${P}queue`, // list of items
  queued: `${P}queued`, // hash sku -> { type, day }
  biz: `${P}biz`, // hash business_connection_id -> connection
  errors: `${P}errors`,
  pending: (userId) => `${P}pending:${userId}`,
  stats: (day) => `${P}stats:${day}`,
  update: (id) => `${P}upd:${id}`,
  flag: (name) => `${P}flag:${name}`,
};

let client = null;

// Tests inject an in-memory client.
export function setRedis(c) {
  client = c;
}

const redisUrl = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const hasRedis = () => Boolean(client || (redisUrl() && redisToken()));

export function redis() {
  if (!client) {
    if (!redisUrl() || !redisToken()) {
      throw new Error('Redis is not configured (UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN)');
    }
    client = new Redis({ url: redisUrl(), token: redisToken() });
  }
  return client;
}

// YYYY-MM-DD in Asia/Tashkent.
export const today = (now = Date.now()) => new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Tashkent' });

// ---- settings ----

export function defaultSettings() {
  const { CONTACT_PHONE, CHANNEL_ID, BUSINESS_CONNECTION_ID, ORDER_URL } = process.env;
  return {
    phone: CONTACT_PHONE || DEFAULT_CONTACT_PHONE,
    channels: CHANNEL_ID ? [{ id: CHANNEL_ID, title: CHANNEL_ID, active: true }] : [],
    send_channel: true,
    story: false,
    story_bc: BUSINESS_CONNECTION_ID || '',
    album: false,
    random: false,
    order_url: ORDER_URL || DEFAULT_ORDER_URL,
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

export const storyDailyLimit = () =>
  process.env.STORY_DAILY_LIMIT !== undefined && process.env.STORY_DAILY_LIMIT !== ''
    ? Number(process.env.STORY_DAILY_LIMIT)
    : 3;

// Business connection used for stories: chosen in settings, else env, else first enabled one.
export function storyConnectionId(settings, connections = []) {
  return settings.story_bc || process.env.BUSINESS_CONNECTION_ID || connections.find((c) => c.is_enabled)?.id || null;
}

// ---- business connections ----

export async function saveBiz(c) {
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
}

export async function listBiz() {
  if (!hasRedis()) {
    return [];
  }
  const all = (await redis().hgetall(K.biz)) || {};
  return Object.values(all).sort((a, b) => (b.date || 0) - (a.date || 0));
}

// ---- sent products ----

export const getSent = (sku) => redis().hget(K.sent, String(sku));

export async function recentSkus(limit = RECENT_LIMIT) {
  const list = (await redis().lrange(K.recent, 0, limit - 1)) || [];
  return list.map(String);
}

export async function updateSent(sku, patch) {
  const rec = (await getSent(sku)) || {};
  await redis().hset(K.sent, { [String(sku)]: { ...rec, ...patch } });
}

export async function recordSent(item, day = today()) {
  const sku = String(item.sku);
  const prev = (await getSent(sku)) || {};
  await redis().hset(K.sent, {
    [sku]: {
      ...prev,
      sku,
      product_id: item.product_id,
      name: item.name,
      price: item.price,
      stock: item.stock,
      image_url: item.image_url,
      date: prev.date || day,
      last_type: item.type,
      sent_at: Date.now(),
    },
  });
  await redis().lrem(K.recent, 0, sku);
  await redis().lpush(K.recent, sku);
  await redis().ltrim(K.recent, 0, RECENT_LIMIT - 1);
  await redis().hdel(K.queued, sku);
}

// ---- queue ----

export const getQueued = (sku) => redis().hget(K.queued, String(sku));
export const unmarkQueued = (sku) => redis().hdel(K.queued, String(sku));

export async function enqueue(items, day = today()) {
  if (!items.length) {
    return;
  }
  await redis().rpush(K.queue, ...items);
  const marks = {};
  for (const i of items) {
    marks[i.sku] = { type: i.type, day };
  }
  await redis().hset(K.queued, marks);
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

// ---- stats ----

export async function getStats(day = today()) {
  const raw = (await redis().hgetall(K.stats(day))) || {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = Number(v) || 0;
  }
  return out;
}

export async function incrStat(field, n = 1, day = today()) {
  if (!n) {
    return;
  }
  await redis().hincrby(K.stats(day), field, n);
  await redis().expire(K.stats(day), STATS_TTL);
}

export async function setStats(fields, day = today()) {
  await redis().hset(K.stats(day), fields);
  await redis().expire(K.stats(day), STATS_TTL);
}

export async function logError(text) {
  await redis().lpush(K.errors, `${new Date().toISOString()} ${text}`);
  await redis().ltrim(K.errors, 0, 49);
}

// ---- misc ----

export const setPending = (userId, state) => redis().set(K.pending(userId), state, { ex: 600 });
export const getPending = (userId) => redis().get(K.pending(userId));
export const clearPending = (userId) => redis().del(K.pending(userId));

// true the first time a key is seen (within ttl).
export async function once(key, ttl = 60 * 60 * 24 * 2) {
  return (await redis().set(K.flag(key), 1, { nx: true, ex: ttl })) === 'OK';
}

export const firstUpdate = (updateId) => once(`upd:${updateId}`, 60 * 60 * 24);
