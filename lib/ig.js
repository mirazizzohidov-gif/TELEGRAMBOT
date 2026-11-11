// "📸 Instagram": the channel posts and the stories also go to up to 2 Instagram professional accounts
// (slots "a" and "b"), each with its own settings from the dashboard (tab "📸 Instagram"):
// - which posts: 🆕 new, 🔄 back in stock, 🔥 discount, other (random / manual posts)
// - with or without the price, own hashtags, a daily limit for posts and for stories
// - stories: from the "📋 Istoriya navbati" (when Telegram posts the story) and / or with every post
// Instagram API with Instagram Login (graph.instagram.com): the admin pastes a long-lived access token
// in the dashboard; it is refreshed by itself every few days (it lives 60 days).
// Posting: the tick works the Instagram queue a few items at a time. Instagram downloads the photo
// from /api/igimg (a signed link: square JPEG for the feed, 1080x1920 for stories, with the logo).
// Instagram stories cannot carry text over the API, so a story is the product photo only.
// Formats per account: 📷 photo post, 🎬 Reels (an 8 s video made by lib/igvideo.js, Instagram downloads
// it from /api/igvid, with a track from "🎵 Musiqa"), 🖼 carousel (2–10 products in one post: collected
// until there are enough, or after a few hours).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { formatPrice, getProductById, getProductsPage, imageUrl, priceFor, productImage, productStock, toItem } from './bito.js';
import { contactPhone } from './caption.js';
import { notifyAdmins } from './report.js';
import * as db from './store.js';
import { clock, errText, fetchWithTimeout } from './util.js';

export const SLOTS = ['a', 'b'];
// "IGAA…" tokens (Instagram login) -> graph.instagram.com; "EAA…" tokens (Facebook / unified login, new
// Meta apps) -> graph.facebook.com. The publishing endpoints are the same on both.
const VER = () => process.env.IG_API_VERSION || 'v23.0';
const hostOf = (token) => (/^EA/.test(String(token || '')) ? 'fb' : 'ig');
const API = (host = 'ig') => `https://graph.${host === 'fb' ? 'facebook' : 'instagram'}.com/${VER()}`;
const TOK = () => db.K.flag('ig:tok'); // hash slot -> { token, user_id, username, at, refreshed_at, expires_at }
const ST = () => db.K.flag('ig:st'); // hash slot -> { ok_at, error, error_at, paused_until }
const QUEUE = () => db.K.flag('igq'); // list of { slot, kind: 'post' | 'story' | 'reel', item, at, tries }
const CAR = (slot) => db.K.flag(`igcar:${slot}`); // list of { item, at }: products waiting for a carousel
const MUSIC = () => db.K.flag('ig:music'); // hash id -> base64 audio
const MUSIC_META = () => db.K.flag('ig:musicmeta'); // hash id -> { name, at, bytes }
const MUSIC_MAX = 8;
const REEL_MS = 170000; // a Reel: Instagram downloads the video and processes it (up to ~2 min)
const QUEUE_MAX = 300;
const QUEUE_DAYS = 3;
const MAX_TRIES = 3;
const PER_TICK = 6;
const JOB_MS = 40000; // one publish: container + Instagram downloading the photo + publish
const REFRESH_AFTER = 5 * 86400000;

const FMT = { formats: { photo: true, reels: false, carousel: false }, carousel_size: 5, carousel_hours: 3, music: true, reels_feed: true, max_reels: 5, brand: 'MIX PODAROK', hours_from: '09:00', hours_to: '22:00', gap_min: 30, story_gap_min: 30 };
export const DEFAULTS = {
  a: { on: true, label: 'Instagram 1', types: { new: true, restock: true, discount: true, other: true }, price: true, stories_queue: true, stories_posts: true, max_posts: 25, max_stories: 25, tags: '', ...FMT },
  b: { on: false, label: 'Instagram 2', types: { new: true, restock: true, discount: true, other: false }, price: true, stories_queue: false, stories_posts: false, max_posts: 15, max_stories: 15, tags: '', ...FMT },
};
const TYPES = ['new', 'restock', 'discount', 'other'];

export function igCfg(s, slot) {
  const d = DEFAULTS[slot];
  const c = s?.ig?.[slot] || {};
  return { ...d, ...c, types: { ...d.types, ...(c.types || {}) }, formats: { ...d.formats, ...(c.formats || {}) } };
}

// ---- tokens ----

async function tokenOf(slot) {
  return (await db.redis().hget(TOK(), slot).catch(() => null)) || null;
}

class IgError extends Error {
  constructor(message, data = {}) {
    super(message);
    this.code = data.code;
    this.subcode = data.error_subcode;
    this.data = data;
  }
}
// token expired / revoked / wrong
const isTokenError = (e) => e?.code === 190 || e?.code === 102 || /access token|session has (expired|been invalidated)/i.test(e?.message || '');
// Instagram / Meta "too many calls" or the account's own 24-hour publishing limit
const isLimitError = (e) => [4, 9, 17, 32, 613].includes(e?.code) || /request limit|publishing limit|rate limit|too many/i.test(e?.message || '');

async function igCall(method, path, params = {}, ms = 25000) {
  const host = hostOf(params.access_token);
  const body = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]));
  const url = method === 'GET' ? `${API(host)}${path}?${body}` : `${API(host)}${path}`;
  const r = await fetchWithTimeout(url, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, ms);
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const err = data.error || {};
    throw new IgError(`Instagram ${r.status}: ${err.error_user_msg || err.message || 'xato'}`, err);
  }
  return data;
}

// The admin pasted a token: checked with Instagram (which account?) and saved.
export async function igSetToken(slot, token, igId = '') {
  if (!SLOTS.includes(slot)) return { ok: false, message: "Noto'g'ri akkaunt" };
  token = String(token || '').trim().replace(/^["']|["']$/g, '').replace(/^access_token=/, '').replace(/\s+/g, '');
  if (!token) return { ok: false, message: 'Token bo\'sh' };
  if (!/^(IG|EA)[A-Za-z0-9_-]{40,}$/.test(token)) {
    return { ok: false, message: "Bu token emas: token IGAA… yoki EAA… bilan boshlanadi va juda uzun bo'ladi (App ID / App Secret emas)" };
  }
  let me;
  try {
    igId = String(igId || '').replace(/\D/g, '').slice(0, 30);
    me = await findAccount(token, igId);
  } catch (e) {
    return { ok: false, message: `Token ishlamadi: ${errText(e)}` };
  }
  if (!me?.user_id) {
    return { ok: false, message: "Token ishladi, lekin Instagram akkaunt topilmadi. Meta sahifasida akkaunt nomi ostidagi raqamni (Instagram ID, 1784… bilan boshlanadi) \"Instagram ID\" maydoniga yozib, qayta 🔗 Ulash bosing." };
  }
  const now = Date.now();
  await db.redis().hset(TOK(), { [slot]: { token, host: hostOf(token), ig_id: igId || undefined, user_id: String(me.user_id), username: me.username || '', type: me.type || '', at: now, refreshed_at: now } });
  await db.redis().hdel(ST(), slot).catch(() => {});
  return { ok: true, message: `✅ @${me.username} ulandi`, username: me.username };
}

// Which Instagram account the token publishes to: { user_id, username, type }.
async function findAccount(token, igId = '') {
  if (hostOf(token) === 'ig') {
    const me = await igCall('GET', '/me', { fields: 'user_id,username,account_type', access_token: token });
    return { user_id: me.user_id || me.id, username: me.username, type: me.account_type };
  }
  const seen = [];
  const note = (step, v) => seen.push(`${step}: ${JSON.stringify(v).slice(0, 200)}`);
  const get = (path, params) => igCall('GET', path, { ...params, access_token: token }).catch((e) => ({ error: errText(e) }));
  // the account ID the admin gave (Meta app page -> "2. Generate access tokens", under the username)
  if (igId) {
    const a = await get(`/${igId}`, { fields: 'id,username' });
    note('id', a);
    if (a?.username) return { user_id: a.id, username: a.username, type: 'business' };
  }
  // an Instagram-scoped token answers /me with the account itself
  const me = await get('/me', { fields: 'id,username,name' });
  note('me', me);
  if (me?.username) return { user_id: me.id, username: me.username, type: 'business' };
  // a Facebook user token: the Instagram account linked to one of its pages
  const pages = await get('/me/accounts', { fields: 'name,instagram_business_account{id,username},connected_instagram_account{id,username}', limit: 50 });
  note('pages', pages);
  for (const p of pages?.data || []) {
    const ig = p.instagram_business_account || p.connected_instagram_account;
    if (ig?.id) return { user_id: ig.id, username: ig.username, type: 'business' };
  }
  // business portfolio accounts
  const biz = await get('/me/businesses', { fields: 'name,owned_instagram_accounts{id,username},instagram_business_accounts{id,username}', limit: 20 });
  note('biz', biz);
  for (const b of biz?.data || []) {
    const ig = b.instagram_business_accounts?.data?.[0] || b.owned_instagram_accounts?.data?.[0];
    if (ig?.id) return { user_id: ig.id, username: ig.username, type: 'business' };
  }
  console.error(`ig: no Instagram account for the token — ${seen.join(' | ')}`);
  return null;
}

export async function igRemoveToken(slot) {
  if (!SLOTS.includes(slot)) return { ok: false, message: "Noto'g'ri akkaunt" };
  await db.redis().hdel(TOK(), slot);
  await db.redis().hdel(ST(), slot).catch(() => {});
  return { ok: true, message: '🗑 Akkaunt uzildi' };
}

// Long-lived tokens live 60 days; refreshed every 5 days (Instagram allows it after 24 h).
async function refreshTokens() {
  for (const slot of SLOTS) {
    const t = await tokenOf(slot);
    if (!t?.token || hostOf(t.token) !== 'ig' || Date.now() - (t.refreshed_at || 0) < REFRESH_AFTER) continue; // Facebook tokens: no refresh here
    try {
      const r = await fetchWithTimeout(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(t.token)}`, {}, 15000);
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.access_token) throw new IgError(d.error?.message || `HTTP ${r.status}`, d.error || {});
      await db.redis().hset(TOK(), { [slot]: { ...t, token: d.access_token, refreshed_at: Date.now(), expires_at: d.expires_in ? Date.now() + d.expires_in * 1000 : null } });
      console.log(`ig ${slot}: token refreshed`);
    } catch (e) {
      console.error(`ig ${slot}: token refresh failed: ${errText(e)}`);
      await setStatus(slot, { error: `Token yangilanmadi: ${errText(e)}`, error_at: Date.now() });
    }
  }
}

async function setStatus(slot, patch) {
  const cur = (await db.redis().hget(ST(), slot).catch(() => null)) || {};
  await db.redis().hset(ST(), { [slot]: { ...cur, ...patch } });
}

// ---- photo links (/api/igimg) ----

const signKey = () => process.env.IG_IMG_SECRET || process.env.SECRET || process.env.BOT_TOKEN || 'ig';
const b64u = (s) => Buffer.from(s).toString('base64url');
export const igSign = (d) => createHmac('sha256', signKey()).update(d).digest('base64url').slice(0, 32);
export function igCheck(d, sig) {
  const want = Buffer.from(igSign(String(d || '')));
  const got = Buffer.from(String(sig || ''));
  return want.length === got.length && timingSafeEqual(want, got);
}
const baseUrl = () => `https://${process.env.IG_IMG_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL}`;
export function igImageUrl(url, kind) {
  const d = b64u(JSON.stringify({ u: url, k: kind }));
  return `${baseUrl()}/api/igimg?d=${d}&s=${igSign(d)}`;
}
// "🎬 Reels": the video link (/api/igvid) carries what the video shows; the track is picked now.
export function igVideoUrl(item, cfg, s, music = null) {
  const d = b64u(JSON.stringify({ k: 'reel', u: item.image_url, n: String(item.name || '').slice(0, 120), p: Number(item.price) || 0, o: Number(item.old_price) || 0, t: igKind(item), sp: cfg.price !== false, b: String(cfg.brand ?? 'MIX PODAROK').slice(0, 30), ph: contactPhone(s.phone), m: music || '' }));
  return `${baseUrl()}/api/igvid?d=${d}&s=${igSign(d)}`;
}
export function igDecodeVideo(d) {
  try {
    const o = JSON.parse(Buffer.from(String(d), 'base64url').toString('utf8'));
    return o?.k === 'reel' && /^https?:\/\//.test(o?.u) ? o : null;
  } catch {
    return null;
  }
}
export function igDecode(d) {
  try {
    const o = JSON.parse(Buffer.from(String(d), 'base64url').toString('utf8'));
    return /^https?:\/\//.test(o?.u) && ['post', 'story', 'thumb'].includes(o?.k) ? o : null;
  } catch {
    return null;
  }
}

// ---- caption ----

// "1 200 000" -> "1̶ ̶2̶0̶0̶ ̶0̶0̶0̶" (Instagram has no formatting; a combining stroke shows the old price struck out)
const strike = (t) => [...String(t)].map((c) => `${c}̶`).join('');
export const igKind = (item) =>
  item.type === 'restock' ? 'restock' : item.type === 'discount' || Number(item.old_price) > Number(item.price) ? 'discount' : item.fresh ? 'new' : 'other';

export function igCaption(item, s, cfg) {
  const kind = igKind(item);
  const head = { restock: '🔄 Yana sotuvda!', discount: '🔥 CHEGIRMA!', new: '🆕 Yangi mahsulot!', other: '' }[kind];
  const lines = [];
  if (head) lines.push(head, '');
  lines.push(`🛍 ${item.name}`);
  if (item.desc) lines.push(`📝 ${item.desc}`);
  if (cfg.price && Number(item.price) > 0) {
    lines.push(Number(item.old_price) > Number(item.price) ? `💰 ${strike(formatPrice(item.old_price))} → ${formatPrice(item.price)} so'm` : `💰 Narxi: ${formatPrice(item.price)} so'm`);
  } else {
    lines.push("💰 Narxini bilish uchun Direct'ga yozing");
  }
  const lowAt = db.limit(s, 'low_stock_threshold');
  if (lowAt > 0 && Number(item.stock) > 0 && Number(item.stock) <= lowAt) lines.push('⏳ Cheklangan miqdorda');
  if (item.sku) lines.push(`🔖 Kod: ${item.sku}`);
  lines.push('', `📞 Buyurtma: ${contactPhone(s.phone)}`, "✉️ yoki Direct'ga yozing");
  const tags = [item.tags, cfg.tags].filter(Boolean).join(' ').trim();
  if (tags) lines.push('', tags);
  return lines.join('\n').slice(0, 2200);
}

// One post with several products: a list with prices.
export function igCarouselCaption(items, s, cfg) {
  const kinds = items.map(igKind);
  const head = kinds.every((k) => k === 'discount') ? '🔥 CHEGIRMADAGI MAHSULOTLAR' : kinds.every((k) => k === 'restock') ? '🔄 YANA SOTUVDA' : '🆕 YANGI KELGAN MAHSULOTLAR';
  const lines = [head, ''];
  items.forEach((it, i) => {
    const price = cfg.price && Number(it.price) > 0 ? (Number(it.old_price) > Number(it.price) ? ` — ${strike(formatPrice(it.old_price))} → ${formatPrice(it.price)} so'm` : ` — ${formatPrice(it.price)} so'm`) : '';
    lines.push(`${i + 1}. ${it.name}${price}${it.sku ? ` (kod ${it.sku})` : ''}`);
  });
  if (!cfg.price) lines.push('', "💰 Narxini bilish uchun Direct'ga yozing");
  lines.push('', "👉 Varaqlab ko'ring", `📞 Buyurtma: ${contactPhone(s.phone)}`, "✉️ yoki Direct'ga yozing");
  const tags = [...new Set([...items.flatMap((i) => String(i.tags || '').split(/\s+/)), ...String(cfg.tags || '').split(/\s+/)].filter((t) => t.startsWith('#')))].slice(0, 25).join(' ');
  if (tags) lines.push('', tags);
  return lines.join('\n').slice(0, 2200);
}

// ---- the queue ----

const pick = (i) => ({ product_id: i.product_id, sku: i.sku, name: i.name, image_url: i.image_url, price: i.price, old_price: i.old_price, type: i.type, fresh: i.fresh, stock: i.stock, desc: i.desc, tags: i.tags });

async function enqueue(jobs) {
  if (!jobs.length) return;
  await db.redis().rpush(QUEUE(), ...jobs);
  await db.redis().ltrim(QUEUE(), -QUEUE_MAX, -1);
}

async function connected(slot) {
  return Boolean((await tokenOf(slot))?.token);
}

// Straight from BITO (lib/watch.js new products / discounts / back in stock, lib/discount-watch.js,
// lib/restock.js) — not tied to Telegram: each account gets what its settings ask for, once a day per product.
export async function igFromSource(items, s) {
  if (!db.hasRedis() || !items?.length) return;
  const slots = [];
  for (const slot of SLOTS) if (igCfg(s, slot).on && (await connected(slot))) slots.push(slot);
  if (!slots.length) return;
  try {
    const { addTags } = await import('./hashtags.js');
    await addTags(items.filter((i) => !i.tags), s);
  } catch {}
  for (const item of items) await igAfterPost(item, s, slots);
}

export async function igAfterPost(item, s, only = SLOTS) {
  if (!db.hasRedis() || !item?.image_url) return;
  const kind = igKind(item);
  const jobs = [];
  for (const slot of only) {
    const cfg = igCfg(s, slot);
    if (!cfg.on || !cfg.types[kind] || !(await connected(slot))) continue;
    const key = `igpost:${slot}:${item.sku || item.product_id}:${kind}:${db.today()}`;
    if (!(await db.once(key, 60 * 60 * 26))) continue; // the same product once a day per account
    const id = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (cfg.formats.photo) jobs.push({ id: id(), slot, kind: 'post', item: pick(item), at: Date.now(), tries: 0 });
    if (cfg.formats.reels) jobs.push({ id: id(), slot, kind: 'reel', item: pick(item), at: Date.now(), tries: 0 });
    if (cfg.formats.carousel) {
      await db.redis().rpush(CAR(slot), { item: pick(item), at: Date.now() });
      await db.redis().ltrim(CAR(slot), -50, -1);
    }
    if (cfg.stories_posts && (await db.once(`igstory:${slot}:${item.sku || item.product_id}:${db.today()}`, 60 * 60 * 26))) {
      jobs.push({ id: id(), slot, kind: 'story', item: pick(item), at: Date.now(), tries: 0 });
    }
  }
  await enqueue(jobs);
}

// After a Telegram story from the "📋 Istoriya navbati" (lib/poster.js processStoryQueue).
export async function igAfterStory(item, s) {
  if (!db.hasRedis() || !item?.image_url) return;
  const jobs = [];
  for (const slot of SLOTS) {
    const cfg = igCfg(s, slot);
    if (!cfg.on || !cfg.stories_queue || !(await connected(slot))) continue;
    if (!(await db.once(`igstory:${slot}:${item.sku || item.product_id}:${db.today()}`, 60 * 60 * 26))) continue;
    jobs.push({ slot, kind: 'story', item: pick(item), at: Date.now(), tries: 0 });
  }
  await enqueue(jobs);
}

// Waits until Instagram has processed a container (photos: seconds, videos: up to ~2 min).
async function waitReady(id, token, { tries = 8, every = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const st = await igCall('GET', `/${id}`, { fields: 'status_code,status', access_token: token }).catch(() => null);
    if (st?.status_code === 'FINISHED' || (!st && i > 2)) return;
    if (st?.status_code === 'ERROR' || st?.status_code === 'EXPIRED') throw new IgError(`Instagram faylni qabul qilmadi: ${st.status || st.status_code}`);
    await clock.sleep(every);
  }
  throw new IgError('Instagram faylni tayyorlab ulgurmadi (vaqt tugadi)');
}

// One publish: container(s) -> wait until Instagram has the photo / video -> publish. Returns the media id.
async function publish(slot, job, s) {
  const t = await tokenOf(slot);
  if (!t?.token) throw new IgError('Akkaunt ulanmagan');
  const cfg = igCfg(s, slot);
  const tok = t.token;
  let c;
  if (job.kind === 'reel') {
    const music = cfg.music ? await igMusicPick() : null;
    const videoUrl = igVideoUrl(job.item, cfg, s, music);
    // the video is made now (and kept), so Instagram does not wait for it — a slow answer fails the upload
    const warm = await fetchWithTimeout(`${videoUrl}&warm=1`, {}, 100000);
    if (!warm.ok) throw new IgError(`Video tayyorlanmadi: HTTP ${warm.status}`);
    c = await igCall('POST', `/${t.user_id}/media`, { media_type: 'REELS', video_url: videoUrl, caption: igCaption(job.item, s, cfg), share_to_feed: cfg.reels_feed !== false, access_token: tok }, 60000);
    await waitReady(c.id, tok, { tries: 24, every: 5000 });
  } else if (job.kind === 'carousel') {
    const ids = [];
    for (const it of job.items.slice(0, 10)) {
      const ch = await igCall('POST', `/${t.user_id}/media`, { image_url: igImageUrl(it.image_url, 'post'), is_carousel_item: true, access_token: tok }, 40000);
      ids.push(ch.id);
    }
    for (const id of ids) await waitReady(id, tok);
    c = await igCall('POST', `/${t.user_id}/media`, { media_type: 'CAROUSEL', children: ids.join(','), caption: igCarouselCaption(job.items, s, cfg), access_token: tok }, 40000);
    await waitReady(c.id, tok);
  } else {
    const story = job.kind === 'story';
    c = await igCall('POST', `/${t.user_id}/media`, { image_url: igImageUrl(job.item.image_url, job.kind), ...(story ? { media_type: 'STORIES' } : { caption: igCaption(job.item, s, cfg) }), access_token: tok }, 40000);
    await waitReady(c.id, tok).catch((e) => {
      if (/vaqt tugadi/.test(e.message)) return; // photos: try to publish anyway
      throw e;
    });
  }
  const p = await igCall('POST', `/${t.user_id}/media_publish`, { creation_id: c.id, access_token: tok }, 40000);
  return p.id;
}

// Carousels ready to go: enough products collected, or the oldest waited long enough (2+ products);
// a single product left alone for twice that long goes out as a photo post.
async function carouselJobs(s) {
  const jobs = [];
  for (const slot of SLOTS) {
    const cfg = igCfg(s, slot);
    if (!cfg.on || !cfg.formats.carousel) continue;
    const buf = ((await db.redis().lrange(CAR(slot), 0, -1).catch(() => [])) || []).filter((x) => x?.item);
    if (!buf.length) continue;
    const size = Math.min(10, Math.max(2, cfg.carousel_size || 5));
    const age = Date.now() - (buf[0].at || 0);
    const wait = (cfg.carousel_hours || 3) * 3600000;
    if (buf.length >= size || (buf.length >= 2 && age >= wait)) jobs.push({ slot, kind: 'carousel', items: buf.slice(0, size).map((x) => x.item), take: Math.min(size, buf.length), at: Date.now(), tries: 0 });
    else if (buf.length === 1 && age >= wait * 2) jobs.push({ slot, kind: 'post', item: buf[0].item, take: 1, at: Date.now(), tries: 0, fromCar: true });
  }
  return jobs;
}
async function dropFromCarousel(slot, n) {
  const buf = (await db.redis().lrange(CAR(slot), 0, -1).catch(() => [])) || [];
  await db.redis().del(CAR(slot));
  const rest = buf.slice(n);
  if (rest.length) await db.redis().rpush(CAR(slot), ...rest);
}

// "⏰ Jadval": posts only between hours_from and hours_to (Tashkent), at least gap_min minutes apart
// (stories: story_gap_min).
const hhmmNow = (now = Date.now()) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(now));
export function inWindow(cfg, now = Date.now()) {
  const t = hhmmNow(now);
  const from = cfg.hours_from || '00:00';
  const to = cfg.hours_to || '23:59';
  return from <= to ? t >= from && t < to : t >= from || t < to;
}
function gapOk(cfg, status, kind, now = Date.now()) {
  const story = kind === 'story';
  const last = Number(story ? status.last_story_at : status.last_post_at) || 0;
  const gap = (Number(story ? cfg.story_gap_min : cfg.gap_min) || 0) * 60000;
  return !last || now - last >= gap - 60000; // a minute of slack: ticks are not exactly 15 min apart
}

// "📝" for a post that was queued straight from BITO (before Telegram wrote it): the saved one, else
// written now when there is time (never blocks the post).
async function withDesc(item, s, deadline) {
  if (item.desc) return;
  try {
    const { describe, getDesc } = await import('./ai.js');
    const saved = await getDesc(item).catch(() => null);
    if (saved?.text) item.desc = saved.text;
    else if (Date.now() + 60000 < deadline) item.desc = (await describe(item, s).catch(() => null)) || undefined;
  } catch {}
}

// The 15-minute tick: refresh tokens, then a few queued posts / stories within each account's limits.
export async function igTick(s, { deadline = Date.now() + 60000 } = {}) {
  const result = { posted: 0, stories: 0, failed: 0, waiting: 0 };
  if (!db.hasRedis()) return result;
  if (!(await Promise.all(SLOTS.map(connected))).some(Boolean)) return result;
  await refreshTokens().catch((e) => console.error(`ig refresh: ${errText(e)}`));
  const all = (await db.redis().lrange(QUEUE(), 0, -1)) || [];
  const cars = await carouselJobs(s).catch(() => []);
  if (!all.length && !cars.length) return result;
  const st = await db.getStats();
  const stopped = new Set(); // accounts that hit a token / limit error in this run
  const keep = [];
  let done = 0;
  for (const job of [...cars, ...all]) {
    const temp = Boolean(job.take); // a carousel (or its lone product) lives in its own list, not the queue
    if (!job?.slot || Date.now() - (job.at || 0) > QUEUE_DAYS * 86400000) continue; // too old: dropped
    const cfg = igCfg(s, job.slot);
    if (!cfg.on) continue; // switched off: its queue is dropped
    const statKey = `ig_${job.kind === 'carousel' ? 'post' : job.kind}:${job.slot}`;
    const max = job.kind === 'story' ? cfg.max_stories : job.kind === 'reel' ? cfg.max_reels : cfg.max_posts;
    const need = job.kind === 'reel' ? REEL_MS : job.kind === 'carousel' ? JOB_MS + 8000 * (job.items?.length || 1) : JOB_MS;
    const status = (await db.redis().hget(ST(), job.slot).catch(() => null)) || {};
    if (stopped.has(job.slot) || !inWindow(cfg) || !gapOk(cfg, status, job.kind) || (status.paused_until && status.paused_until > Date.now()) || (st[statKey] || 0) >= max || done >= PER_TICK || Date.now() + need > deadline) {
      if (!temp) keep.push(job);
      continue;
    }
    try {
      if (job.item && job.kind !== 'story') await withDesc(job.item, s, deadline - need);
      await publish(job.slot, job, s);
      await setStatus(job.slot, job.kind === 'story' ? { last_story_at: Date.now() } : { last_post_at: Date.now() });
      if (temp) {
        await dropFromCarousel(job.slot, job.take);
        await db.redis().hset(ST(), { [`_carfail:${job.slot}`]: 0 }).catch(() => {});
      }
      done++;
      st[statKey] = (st[statKey] || 0) + 1;
      await db.incrStat(statKey);
      result[job.kind === 'story' ? 'stories' : job.kind === 'reel' ? 'reels' : 'posted'] = (result[job.kind === 'story' ? 'stories' : job.kind === 'reel' ? 'reels' : 'posted'] || 0) + 1;
      await setStatus(job.slot, { ok_at: Date.now(), error: null });
      console.log(`ig ${job.slot}: ${job.kind} ok sku=${job.item?.sku}`);
    } catch (e) {
      const msg = errText(e);
      console.error(`ig ${job.slot}: ${job.kind} sku=${job.item?.sku}: ${msg}`);
      await setStatus(job.slot, { error: msg.slice(0, 300), error_at: Date.now() });
      if (isTokenError(e)) {
        stopped.add(job.slot);
        if (!temp) keep.push(job);
        if (await db.once(`igtokalert:${job.slot}`, 6 * 60 * 60)) {
          await notifyAdmins({ text: `⚠️ Instagram (${cfg.label}): token ishlamayapti — ${msg}\n\nDashboard → 📸 Instagram bo'limida yangi token kiriting.` }).catch(() => {});
        }
      } else if (isLimitError(e)) {
        stopped.add(job.slot);
        if (!temp) keep.push(job);
        await setStatus(job.slot, { paused_until: Date.now() + 60 * 60 * 1000 }); // an hour's rest
      } else {
        result.failed++;
        await db.incrStat(`ig_failed:${job.slot}`).catch(() => {});
        if (temp) {
          // a carousel failing again and again: its oldest product is dropped so the rest can go
          const n = Number(await db.redis().hincrby(ST(), `_carfail:${job.slot}`, 1).catch(() => 0)) || 0;
          if (n >= MAX_TRIES) {
            await dropFromCarousel(job.slot, 1);
            await db.redis().hset(ST(), { [`_carfail:${job.slot}`]: 0 }).catch(() => {});
          }
        }
        else if ((job.tries || 0) + 1 < MAX_TRIES) keep.push({ ...job, tries: (job.tries || 0) + 1 });
      }
    }
  }
  // jobs added while this run worked (a new post, the dashboard) are kept too
  const now = (await db.redis().lrange(QUEUE(), 0, -1)) || [];
  keep.push(...now.slice(all.length));
  await db.redis().del(QUEUE());
  if (keep.length) await db.redis().rpush(QUEUE(), ...keep);
  result.waiting = keep.length;
  return result;
}

// ---- dashboard ----

export async function igView() {
  const s = await db.getSettings();
  const [toks, sts, queue, stats, carA, carB, music] = await Promise.all([
    db.redis().hgetall(TOK()).catch(() => ({})),
    db.redis().hgetall(ST()).catch(() => ({})),
    db.redis().lrange(QUEUE(), 0, -1).catch(() => []),
    db.getStats(),
    db.redis().llen(CAR('a')).catch(() => 0),
    db.redis().llen(CAR('b')).catch(() => 0),
    igMusicList().catch(() => []),
  ]);
  const car = { a: Number(carA) || 0, b: Number(carB) || 0 };
  const accounts = SLOTS.map((slot) => {
    const t = toks?.[slot];
    const q = (queue || []).filter((j) => j?.slot === slot);
    return {
      slot,
      cfg: igCfg(s, slot),
      connected: Boolean(t?.token),
      username: t?.username || '',
      type: t?.type || '',
      token_hint: t?.token ? `…${String(t.token).slice(-4)}` : '',
      expires_at: t?.expires_at || (t?.refreshed_at && t.host !== 'fb' ? t.refreshed_at + 60 * 86400000 : null),
      status: sts?.[slot] || {},
      today: { posts: Number(stats[`ig_post:${slot}`]) || 0, stories: Number(stats[`ig_story:${slot}`]) || 0, reels: Number(stats[`ig_reel:${slot}`]) || 0, failed: Number(stats[`ig_failed:${slot}`]) || 0 },
      queue: { posts: q.filter((j) => j.kind === 'post').length, stories: q.filter((j) => j.kind === 'story').length, reels: q.filter((j) => j.kind === 'reel').length, carousel: car[slot] },
    };
  });
  return { accounts, music };
}

export async function igSetCfg(slot, cfg = {}) {
  if (!SLOTS.includes(slot)) return { ok: false, message: "Noto'g'ri akkaunt" };
  const s = await db.getSettings();
  // an empty field keeps the default (Number('') would be 0: "0 a day" by mistake)
  const n = (v, min, max, d) => (v !== '' && v != null && Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : d);
  const d = DEFAULTS[slot];
  const tags = String(cfg.tags ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t}`).replace(/[^#\p{L}\p{N}_]/gu, ''))
    .filter((t) => t.length > 1)
    .slice(0, 20)
    .join(' ');
  const next = {
    on: Boolean(cfg.on),
    label: String(cfg.label || d.label).slice(0, 30),
    types: Object.fromEntries(TYPES.map((t) => [t, Boolean(cfg.types?.[t])])),
    price: cfg.price !== false,
    stories_queue: Boolean(cfg.stories_queue),
    stories_posts: Boolean(cfg.stories_posts),
    max_posts: n(cfg.max_posts, 0, 50, d.max_posts),
    max_stories: n(cfg.max_stories, 0, 50, d.max_stories),
    tags,
    formats: { photo: Boolean(cfg.formats?.photo), reels: Boolean(cfg.formats?.reels), carousel: Boolean(cfg.formats?.carousel) },
    carousel_size: n(cfg.carousel_size, 2, 10, d.carousel_size),
    carousel_hours: n(cfg.carousel_hours, 1, 24, d.carousel_hours),
    music: cfg.music !== false,
    reels_feed: cfg.reels_feed !== false,
    max_reels: n(cfg.max_reels, 0, 30, d.max_reels),
    brand: String(cfg.brand ?? d.brand).replace(/[\r\n]+/g, ' ').slice(0, 30),
    hours_from: /^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.hours_from) ? cfg.hours_from : d.hours_from,
    hours_to: /^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.hours_to) ? cfg.hours_to : d.hours_to,
    gap_min: n(cfg.gap_min, 0, 240, d.gap_min),
    story_gap_min: n(cfg.story_gap_min, 0, 240, d.story_gap_min),
  };
  await db.updateSettings({ ig: { ...(s.ig || {}), [slot]: next } });
  return { ok: true, message: '✅ Saqlandi', cfg: next };
}

// "🔍 Tekshirish": the token still works, and how much of the 24-hour publishing limit is used.
export async function igCheckAccount(slot) {
  const t = await tokenOf(slot);
  if (!t?.token) return { ok: false, message: 'Akkaunt ulanmagan' };
  try {
    const me = await findAccount(t.token, t.ig_id || t.user_id);
    if (!me?.user_id) throw new Error('Instagram akkaunt topilmadi');
    const lim = await igCall('GET', `/${t.user_id}/content_publishing_limit`, { fields: 'quota_usage,config', access_token: t.token }).catch(() => null);
    const row = lim?.data?.[0];
    const used = row ? ` · 24 soatda ${row.quota_usage ?? 0}/${row.config?.quota_total ?? '?'} ta post` : '';
    await setStatus(slot, { error: null, paused_until: null });
    return { ok: true, message: `✅ @${me.username} ishlayapti${used}` };
  } catch (e) {
    return { ok: false, message: `❌ ${errText(e)}` };
  }
}

export async function igClearQueue(slot) {
  const all = (await db.redis().lrange(QUEUE(), 0, -1)) || [];
  const keep = all.filter((j) => j?.slot !== slot);
  await db.redis().del(QUEUE());
  if (keep.length) await db.redis().rpush(QUEUE(), ...keep);
  const car = Number(await db.redis().llen(CAR(slot)).catch(() => 0)) || 0;
  await db.redis().del(CAR(slot)).catch(() => {});
  return { ok: true, message: `🧹 Navbat tozalandi (${all.length - keep.length + car} ta)` };
}

// ---- "🚀 Qo'lda chiqarish": one product by SKU / name, right now ----

const KIND_UZ = { post: 'post', story: 'istoriya', reel: 'Reels' };

// Products for a SKU or a name (with a photo), with the price customers pay.
export async function igSearch(q) {
  q = String(q || '').trim().slice(0, 80);
  if (q.length < 2) return { ok: false, message: 'Kamida 2 ta belgi yozing' };
  const { list } = await getProductsPage({ page: 1, limit: 30, search: q });
  const exact = list.filter((p) => String(p.sku) === q);
  const rows = [...exact, ...list.filter((p) => !exact.includes(p))].filter((p) => productImage(p)).slice(0, 12);
  const items = [];
  for (const p of rows) {
    const pr = await priceFor(p).catch(() => ({ price: null }));
    items.push({ pid: p._id, sku: String(p.sku ?? ''), name: p.name, image: imageUrl(productImage(p)), stock: productStock(p), price: pr.price, old_price: pr.old_price || null });
  }
  return { ok: true, items, message: items.length ? '' : "Rasmli mahsulot topilmadi" };
}

// Posts one product now to the chosen accounts (post and / or story), whatever their filters say;
// what does not fit in this request waits at the front of the queue. Counts toward the daily numbers.
export async function igManual({ pid, slots = [], post = true, story = true, reel = false } = {}, { deadline = Date.now() + 110000 } = {}) {
  if (!/^[0-9a-f]{24}$/i.test(String(pid || ''))) return { ok: false, message: 'Mahsulot tanlanmagan' };
  slots = SLOTS.filter((x) => slots.includes(x));
  if (!slots.length) return { ok: false, message: 'Akkaunt tanlang' };
  if (!post && !story && !reel) return { ok: false, message: 'Post, Reels yoki istoriyani tanlang' };
  const s = await db.getSettings();
  const product = await getProductById(pid);
  if (!product) return { ok: false, message: 'Mahsulot BITO\'da topilmadi' };
  const pr = await priceFor(product);
  const item = toItem(product, pr, pr.old_price > pr.price ? 'discount' : 'new');
  if (!item.image_url) return { ok: false, message: 'Mahsulotda rasm yo\'q' };
  // "📝" AI description and the category hashtags, as in the channel posts (never blocks the post)
  try {
    const { withDescriptions, getDesc } = await import('./ai.js');
    const saved = await getDesc(item).catch(() => null);
    if (saved?.text) item.desc = saved.text;
    else await withDescriptions([item], s, { deadline: Date.now() + 52000 }); // Gemini may need up to 45 s
  } catch {}
  try {
    const { addTags } = await import('./hashtags.js');
    await addTags([item], s);
  } catch {}
  const lines = [];
  const later = [];
  for (const slot of slots) {
    const cfg = igCfg(s, slot);
    if (!(await connected(slot))) {
      lines.push(`${cfg.label}: ulanmagan`);
      continue;
    }
    for (const kind of [post && 'post', story && 'story', reel && 'reel'].filter(Boolean)) {
      const job = { slot, kind, item: pick(item), at: Date.now(), tries: 0 };
      // a Reel takes up to ~2 min at Instagram: it always goes through the queue (next tick)
      if (kind === 'reel' || Date.now() + JOB_MS > deadline) {
        later.push(job);
        lines.push(`${cfg.label}: ${KIND_UZ[kind]} navbatga qo'yildi${kind === 'reel' ? ' (15 daqiqa ichida chiqadi)' : ''}`);
        continue;
      }
      try {
        await publish(slot, job, s);
        await db.incrStat(`ig_${kind}:${slot}`);
        await setStatus(slot, { ok_at: Date.now(), error: null });
        lines.push(`${cfg.label}: ✅ ${KIND_UZ[kind]}`);
      } catch (e) {
        await setStatus(slot, { error: errText(e).slice(0, 300), error_at: Date.now() });
        lines.push(`${cfg.label}: ❌ ${KIND_UZ[kind]} — ${errText(e)}`);
        if (!isTokenError(e)) later.push({ ...job, tries: 1 });
      }
    }
  }
  if (later.length) {
    const rest = (await db.redis().lrange(QUEUE(), 0, -1)) || [];
    await db.redis().del(QUEUE());
    await db.redis().rpush(QUEUE(), ...later, ...rest);
  }
  const ok = lines.some((l) => l.includes('✅') || l.includes('navbat'));
  return { ok, message: `${item.name} (SKU ${item.sku}):\n${lines.join('\n')}` };
}

// "🎬 Namuna": the Reel video of one product, to watch before it goes out (the account's settings).
export async function igPreview({ pid, slot = 'a' } = {}) {
  if (!/^[0-9a-f]{24}$/i.test(String(pid || ''))) return { ok: false, message: 'Mahsulot tanlanmagan' };
  const s = await db.getSettings();
  const product = await getProductById(pid);
  if (!product) return { ok: false, message: 'Mahsulot BITO\'da topilmadi' };
  const pr = await priceFor(product);
  const item = toItem(product, pr, pr.old_price > pr.price ? 'discount' : 'new');
  const cfg = igCfg(s, SLOTS.includes(slot) ? slot : 'a');
  const music = cfg.music ? await igMusicPick() : null;
  return { ok: true, url: igVideoUrl(item, cfg, s, music), message: '🎬 Video ochilmoqda (5–15 soniya)…' };
}

// "🖼 Karuselni hozir chiqarish": the collected products now (at least 2).
export async function igCarouselNow(slot) {
  if (!SLOTS.includes(slot)) return { ok: false, message: "Noto'g'ri akkaunt" };
  const s = await db.getSettings();
  const cfg = igCfg(s, slot);
  const buf = ((await db.redis().lrange(CAR(slot), 0, -1).catch(() => [])) || []).filter((x) => x?.item);
  if (buf.length < 2) return { ok: false, message: "Karusel uchun kamida 2 ta mahsulot kerak" };
  const take = Math.min(10, buf.length);
  const job = { slot, kind: 'carousel', items: buf.slice(0, take).map((x) => x.item) };
  try {
    await publish(slot, job, s);
    await dropFromCarousel(slot, take);
    await db.incrStat(`ig_post:${slot}`);
    await setStatus(slot, { ok_at: Date.now(), error: null });
    return { ok: true, message: `✅ Karusel chiqdi: ${take} ta mahsulot (${cfg.label})` };
  } catch (e) {
    await setStatus(slot, { error: errText(e).slice(0, 300), error_at: Date.now() });
    return { ok: false, message: `❌ ${errText(e)}` };
  }
}

// ---- "🎵 Musiqa": tracks for the Reels (the dashboard sends a ~12 s WAV cut from the chosen file) ----

export async function igMusicList() {
  const all = (await db.redis().hgetall(MUSIC_META()).catch(() => null)) || {};
  return Object.entries(all).map(([id, m]) => ({ id, ...m })).sort((a, b) => (a.at || 0) - (b.at || 0));
}

export async function igMusicAdd(name, b64) {
  const list = await igMusicList();
  if (list.length >= MUSIC_MAX) return { ok: false, message: `Ko'pi bilan ${MUSIC_MAX} ta trek. Avval bittasini o'chiring.` };
  const data = String(b64 || '').replace(/^data:[^,]*,/, '');
  const bytes = Math.floor((data.length * 3) / 4);
  if (bytes < 10000) return { ok: false, message: "Fayl juda kichik yoki bo'sh" };
  if (bytes > 1200000) return { ok: false, message: "Fayl juda katta (1,2 MB dan oshmasin)" };
  const head = Buffer.from(data.slice(0, 16), 'base64');
  const known = head.slice(0, 4).toString() === 'RIFF' || head.slice(0, 3).toString() === 'ID3' || head[0] === 0xff || head.slice(4, 8).toString() === 'ftyp' || head.slice(0, 4).toString() === 'OggS';
  if (!known) return { ok: false, message: 'Bu audio fayl emas' };
  const id = Date.now().toString(36);
  await db.redis().hset(MUSIC(), { [id]: data });
  await db.redis().hset(MUSIC_META(), { [id]: { name: String(name || 'Trek').replace(/[\r\n]+/g, ' ').slice(0, 60), at: Date.now(), bytes } });
  return { ok: true, message: '🎵 Trek qo\'shildi', id };
}

export async function igMusicDel(id) {
  await db.redis().hdel(MUSIC(), String(id));
  await db.redis().hdel(MUSIC_META(), String(id));
  return { ok: true, message: "🗑 Trek o'chirildi" };
}

export async function igMusicGet(id) {
  if (!id) return null;
  const b64 = await db.redis().hget(MUSIC(), String(id)).catch(() => null);
  return b64 ? Buffer.from(String(b64), 'base64') : null;
}

// the next track in turn (null: no tracks)
export async function igMusicPick() {
  const list = await igMusicList().catch(() => []);
  if (!list.length) return null;
  const n = Number(await db.redis().hincrby(ST(), '_music', 1).catch(() => 0)) || 0;
  return list[n % list.length].id;
}

// ---- "📋 Instagram navbati" (dashboard): what waits, in order; remove / move to the front / post now ----

const jobId = (j) => j.id || `${j.at}-${j.slot}-${j.kind}-${j.item?.sku || ''}`;

export async function igQueue() {
  const s = await db.getSettings();
  const all = ((await db.redis().lrange(QUEUE(), 0, -1)) || []).filter((j) => j?.slot);
  // up to 60 per account (the dashboard shows each account's queue on its own)
  const seen = { a: 0, b: 0 };
  const items = all.filter((j) => (seen[j.slot] = (seen[j.slot] || 0) + 1) <= 60).map((j) => ({
    id: jobId(j),
    slot: j.slot,
    label: igCfg(s, j.slot).label,
    kind: j.kind,
    sku: j.item?.sku || '',
    name: j.item?.name || '',
    image: j.item?.image_url || '',
    price: j.item?.price || null,
    at: j.at,
    tries: j.tries || 0,
  }));
  const next = {};
  const stats = await db.getStats();
  for (const slot of SLOTS) {
    const cfg = igCfg(s, slot);
    const st = (await db.redis().hget(ST(), slot).catch(() => null)) || {};
    const used = { post: Number(stats[`ig_post:${slot}`]) || 0, story: Number(stats[`ig_story:${slot}`]) || 0, reel: Number(stats[`ig_reel:${slot}`]) || 0 };
    const limit = { post: cfg.max_posts, story: cfg.max_stories, reel: cfg.max_reels };
    // why the queue waits (shown under the account's name)
    const why = [];
    if (!cfg.on) why.push("akkaunt o'chirilgan");
    if (!inWindow(cfg)) why.push('jadval vaqti emas');
    for (const k of ['post', 'story', 'reel']) if (all.some((j) => j.slot === slot && j.kind === k) && used[k] >= limit[k]) why.push(`${k === 'story' ? 'istoriya' : k === 'reel' ? 'Reels' : 'post'} kunlik limiti tugagan (${used[k]}/${limit[k]})`);
    if (st.paused_until && st.paused_until > Date.now()) why.push('Instagram limiti: dam olyapti');
    if (st.error) why.push(`oxirgi xato: ${String(st.error).slice(0, 120)}`);
    next[slot] = { window: `${cfg.hours_from}–${cfg.hours_to}`, open: inWindow(cfg), last_post_at: st.last_post_at || null, last_story_at: st.last_story_at || null, gap_min: cfg.gap_min, story_gap_min: cfg.story_gap_min, used, limit, why };
  }
  const totals = Object.fromEntries(SLOTS.map((x) => [x, all.filter((j) => j.slot === x).length]));
  return { ok: true, total: all.length, totals, items, next };
}

export async function igQueueAction(id, op) {
  const all = (await db.redis().lrange(QUEUE(), 0, -1)) || [];
  const i = all.findIndex((j) => j && jobId(j) === String(id));
  if (i < 0) return { ok: false, message: 'Navbatda topilmadi (chiqib ketgan bo\'lishi mumkin)' };
  const job = all[i];
  const rest = all.filter((_, k) => k !== i);
  if (op === 'now') {
    const s = await db.getSettings();
    try {
      if (job.kind !== 'story') await withDesc(job.item, s, Date.now() + 100000);
      await publish(job.slot, job, s);
      await db.incrStat(`ig_${job.kind}:${job.slot}`);
      await setStatus(job.slot, { ok_at: Date.now(), error: null, ...(job.kind === 'story' ? { last_story_at: Date.now() } : { last_post_at: Date.now() }) });
    } catch (e) {
      return { ok: false, message: `❌ ${errText(e)}` };
    }
  }
  const next = op === 'top' ? [job, ...rest] : rest;
  // the queue may have grown meanwhile: what was added after our read is kept
  const now = (await db.redis().lrange(QUEUE(), 0, -1)) || [];
  await db.redis().del(QUEUE());
  const out = [...next, ...now.slice(all.length)];
  if (out.length) await db.redis().rpush(QUEUE(), ...out);
  return { ok: true, message: op === 'now' ? `✅ Chiqdi: ${job.item?.name || ''}` : op === 'top' ? '⬆️ Navbat boshiga qo\'yildi' : "🗑 Navbatdan olib tashlandi" };
}

// ---- "📊 Instagram statistikasi" ----
// Followers (and the change since yesterday), the last 30 posts: likes, comments, reach (when the token
// may read insights), the best posts of the week and the hours that work best. Daily to the owner.

const tashHour = (iso) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(new Date(iso))) % 24;

export async function igStats(slot) {
  const t = await tokenOf(slot);
  if (!t?.token) return { ok: false, message: 'Akkaunt ulanmagan' };
  const tok = t.token;
  const s = await db.getSettings();
  const cfg = igCfg(s, slot);
  const me = await igCall('GET', `/${t.user_id}`, { fields: 'username,followers_count,media_count', access_token: tok });
  const media = (await igCall('GET', `/${t.user_id}/media`, { fields: 'id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink', limit: 30, access_token: tok }).catch(() => ({ data: [] }))).data || [];
  // reach / views per post: only when the token may read insights (one failure -> no more tries)
  let insights = true;
  for (const m of media.slice(0, 20)) {
    if (!insights) break;
    const r = await igCall('GET', `/${m.id}/insights`, { metric: m.media_product_type === 'STORY' ? 'reach' : 'reach,views', access_token: tok }).catch(() => null);
    if (!r) {
      insights = false;
      break;
    }
    for (const row of r.data || []) m[row.name] = row.values?.[0]?.value ?? row.total_value?.value ?? 0;
  }
  const score = (m) => (insights && m.reach ? Number(m.reach) : 0) + (Number(m.like_count) || 0) * 10 + (Number(m.comments_count) || 0) * 20;
  // followers today vs the day before (kept per day)
  const day = db.today();
  const yday = db.today(Date.now() - 86400000);
  await db.redis().hset(ST(), { [`_fol:${slot}:${day}`]: me.followers_count || 0 }).catch(() => {});
  const before = Number(await db.redis().hget(ST(), `_fol:${slot}:${yday}`).catch(() => null)) || null;
  const week = media.filter((m) => Date.now() - Date.parse(m.timestamp) <= 7 * 86400000);
  const top = [...week].sort((a, b) => score(b) - score(a)).slice(0, 3);
  // best hours: average score of the posts made at each hour (2+ posts)
  const hours = new Map();
  for (const m of media) {
    const h = tashHour(m.timestamp);
    const v = hours.get(h) || { n: 0, sum: 0 };
    v.n++;
    v.sum += score(m);
    hours.set(h, v);
  }
  const best = [...hours.entries()].filter(([, v]) => v.n >= 2).sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n).slice(0, 3).map(([h]) => `${String(h).padStart(2, '0')}:00`);
  const likes = week.reduce((a, m) => a + (Number(m.like_count) || 0), 0);
  const comments = week.reduce((a, m) => a + (Number(m.comments_count) || 0), 0);
  const reach = insights ? week.reduce((a, m) => a + (Number(m.reach) || 0), 0) : null;
  const delta = before != null ? me.followers_count - before : null;
  const lines = [
    `📊 <b>Instagram — @${me.username}</b> (${cfg.label})`,
    `👥 Obunachilar: <b>${me.followers_count ?? '?'}</b>${delta != null ? ` (${delta >= 0 ? '+' : ''}${delta} kechagiga nisbatan)` : ''}`,
    `🖼 7 kunda: ${week.length} ta post, ❤️ ${likes}, 💬 ${comments}${reach != null ? `, 👁 qamrov ${reach}` : ''}`,
  ];
  if (top.length) {
    lines.push('', '🏆 <b>Haftaning eng yaxshi postlari</b>');
    top.forEach((m, i) => lines.push(`${i + 1}. <a href="${m.permalink}">${String(m.caption || m.media_type).split('\n').find((l) => /🛍/.test(l))?.replace('🛍', '').trim().slice(0, 50) || m.media_type}</a> — ❤️ ${m.like_count || 0}, 💬 ${m.comments_count || 0}${m.reach ? `, 👁 ${m.reach}` : ''}`));
  }
  if (best.length) lines.push('', `⏰ Eng yaxshi soatlar: ${best.join(', ')} (oxirgi ${media.length} post bo'yicha)`);
  if (!insights) lines.push('', "ℹ️ Qamrov (reach) ko'rinmayapti: tokenda statistika ruxsati yo'q. Like va izohlar bo'yicha hisoblandi.");
  return { ok: true, message: lines.join('\n'), best };
}

// The daily report to the owner, once a day after 21:30 (Tashkent).
export async function igStatsTick(s, now = Date.now()) {
  if (!db.hasRedis() || hhmmNow(now) < '21:30') return null;
  const day = db.today(now);
  if (!(await db.once(`igstats:${day}`, 60 * 60 * 30))) return null;
  const { channel2Owner } = await import('./channel2.js');
  const { tg } = await import('./telegram.js');
  for (const slot of SLOTS) {
    if (!igCfg(s, slot).on || !(await connected(slot))) continue;
    const r = await igStats(slot).catch((e) => ({ ok: false, message: errText(e) }));
    if (r.ok) await tg('sendMessage', { chat_id: channel2Owner(), text: r.message.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }).catch((e) => console.error(`ig stats: ${errText(e)}`));
    else console.error(`ig stats ${slot}: ${r.message}`);
  }
  return true;
}
