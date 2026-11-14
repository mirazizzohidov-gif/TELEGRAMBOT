// "📘 Facebook sahifa": what goes to Instagram (account 1 by default) also goes to the shop's Facebook Page —
// photo posts, Reels (the same video) and stories, each kind switchable, with its own daily limits.
// Connection: the Meta app's App ID + App Secret entered on the dashboard (admin), then "🔗 Facebook ulash"
// (Facebook Login; redirect URI https://<host>/api/fbauth) -> a never-expiring Page token is stored.
import { randomBytes } from 'node:crypto';
import { igCaption, igCfg, igImageUrl, igMusicPick, igVideoUrl } from './ig.js';
import * as db from './store.js';
import { errText, fetchWithTimeout } from './util.js';

const V = 'v23.0';
const G = `https://graph.facebook.com/${V}`;
const F = (x) => db.K.flag(`fb:${x}`);
const KEYS = () => F('keys'); // { id, secret }
const TOK = () => F('tok'); // { user_token, pages: [{ id, name, token }], page_id, at }
const ST = () => F('st');
const Q = () => F('q'); // list of { id, kind: 'post' | 'reel' | 'story', item, at, tries }
const NONCE = (n) => F(`nonce:${n}`);
const Q_MAX = 300;
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'business_management'];
// "Facebook Login for Business" asks for a configuration (its permissions) instead of scopes
const CONFIG_ID = () => process.env.FB_CONFIG_ID || '3933387433469802';
export const FB_DEFAULTS = { on: true, source: 'a', kinds: { post: true, reel: true, story: false }, max_posts: 10, max_reels: 10, max_stories: 10, gap_min: 20, hours_from: '09:00', hours_to: '22:00' };
const r = () => db.redis();
const hhmm = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false });
const host = () => process.env.FB_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
export const fbRedirect = () => `https://${host()}/api/fbauth`;
export const fbCfg = (s) => {
  const c = s?.fb || {};
  return { ...FB_DEFAULTS, ...c, kinds: { ...FB_DEFAULTS.kinds, ...(c.kinds || {}) } };
};

async function keys() {
  if (process.env.FB_APP_ID && process.env.FB_APP_SECRET) return { id: process.env.FB_APP_ID, secret: process.env.FB_APP_SECRET, from: 'env' };
  const k = db.hasRedis() ? await r().get(KEYS()).catch(() => null) : null;
  return k?.id && k?.secret ? { ...k, from: 'dashboard' } : null;
}

async function call(method, path, params = {}, ms = 30000) {
  const url = new URL(path.startsWith('http') ? path : `${G}${path}`);
  let init = { method };
  if (method === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  else init = { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) };
  const res = await fetchWithTimeout(url, init, ms);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Facebook: ${j.error?.error_user_msg || j.error?.message || res.status}`);
  return j;
}

// ---- keys + OAuth ----

export async function fbSetKeys(body = {}) {
  const id = String(body.id || '').trim();
  const secret = String(body.secret || '').trim();
  if (!/^\d{6,20}$/.test(id)) return { ok: false, message: "App ID faqat raqamlardan iborat bo'ladi" };
  if (!/^[0-9a-f]{20,64}$/i.test(secret)) return { ok: false, message: "App Secret noto'g'ri" };
  const config_id = /^\d{6,20}$/.test(String(body.config_id || '').trim()) ? String(body.config_id).trim() : null;
  await r().set(KEYS(), { id, secret, ...(config_id ? { config_id } : {}), at: Date.now() });
  return { ok: true, message: '🔑 Saqlandi — endi «🔗 Facebook ulash» ni bosing' };
}
export async function fbRemoveKeys() {
  await r().del(KEYS());
  return fbDisconnect();
}
export async function fbDisconnect() {
  await r().del(TOK());
  return { ok: true, message: '🗑 Facebook uzildi' };
}

export async function fbAuthUrl() {
  const k = await keys();
  if (!k) throw new Error('Avval dashboardda Meta App ID va App Secret kiriting');
  const state = randomBytes(16).toString('hex');
  await r().set(NONCE(state), 1, { ex: 900 });
  const cfgId = k.config_id || CONFIG_ID();
  const q = new URLSearchParams({ client_id: k.id, redirect_uri: fbRedirect(), state, response_type: 'code', ...(cfgId ? { config_id: cfgId, override_default_response_type: 'true' } : { scope: SCOPES.join(',') }) });
  return `https://www.facebook.com/${V}/dialog/oauth?${q}`;
}

export async function fbFinishAuth(code, state) {
  if (!state || !(await r().get(NONCE(state)))) throw new Error('Havola eskirgan — dashboarddan qaytadan «Ulash» bosing');
  await r().del(NONCE(state));
  const k = await keys();
  const short = await call('GET', '/oauth/access_token', { client_id: k.id, client_secret: k.secret, redirect_uri: fbRedirect(), code });
  // a long-lived user token -> the Page tokens made from it do not expire
  const long = await call('GET', '/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: k.id, client_secret: k.secret, fb_exchange_token: short.access_token });
  const acc = await call('GET', '/me/accounts', { fields: 'id,name,access_token', limit: 100, access_token: long.access_token }).catch(() => ({ data: [] }));
  let pages = (acc.data || []).filter((p) => p.access_token).map((p) => ({ id: p.id, name: p.name, token: p.access_token }));
  if (!pages.length) {
    // Login for Business / pages in a business portfolio: /me/accounts can be empty — the pages the user
    // ticked are in the token's granular scopes; each one's own token is asked for directly
    const dbg = await call('GET', '/debug_token', { input_token: long.access_token, access_token: `${k.id}|${k.secret}` }).catch(() => null);
    const ids = new Set();
    for (const g of dbg?.data?.granular_scopes || []) if (/^pages_/.test(g.scope)) for (const id of g.target_ids || []) ids.add(String(id));
    for (const id of ids) {
      const pg = await call('GET', `/${id}`, { fields: 'id,name,access_token', access_token: long.access_token }).catch(() => null);
      if (pg?.access_token) pages.push({ id: pg.id, name: pg.name, token: pg.access_token });
    }
  }
  if (!pages.length) throw new Error("Bu Facebook akkauntda boshqaradigan sahifa topilmadi (yoki sahifaga ruxsat berilmadi)");
  const prev = (await r().get(TOK())) || {};
  const page_id = pages.some((p) => p.id === prev.page_id) ? prev.page_id : (pages.find((p) => /mix/i.test(p.name)) || pages[0]).id;
  await r().set(TOK(), { pages, page_id, at: Date.now() });
  return { pages: pages.map((p) => p.name), page: pages.find((p) => p.id === page_id).name };
}

async function page() {
  const t = await r().get(TOK());
  const p = t?.pages?.find((x) => x.id === t.page_id);
  if (!p) throw new Error('Facebook sahifa ulanmagan');
  return p;
}

// ---- publishing ----

async function postPhoto(p, item, s, cfg) {
  return call('POST', `/${p.id}/photos`, { url: igImageUrl(item.image_url, 'post'), caption: igCaption(item, s, igCfg(s, cfg.source)), access_token: p.token }, 60000);
}
async function postStory(p, item) {
  const ph = await call('POST', `/${p.id}/photos`, { url: igImageUrl(item.image_url, 'story'), published: false, access_token: p.token }, 60000);
  return call('POST', `/${p.id}/photo_stories`, { photo_id: ph.id, access_token: p.token }, 60000);
}
async function postReel(p, item, s, cfg) {
  const icfg = igCfg(s, cfg.source);
  const videoUrl = igVideoUrl(item, icfg, s, icfg.music ? await igMusicPick().catch(() => null) : null);
  // the video is made first (and kept), so Facebook does not wait for it
  const warm = await fetchWithTimeout(`${videoUrl}&warm=1`, {}, 100000);
  if (!warm.ok) throw new Error(`Video tayyorlanmadi: HTTP ${warm.status}`);
  const st = await call('POST', `/${p.id}/video_reels`, { upload_phase: 'start', access_token: p.token });
  const up = await fetchWithTimeout(st.upload_url || `https://rupload.facebook.com/video-upload/${V}/${st.video_id}`, { method: 'POST', headers: { Authorization: `OAuth ${p.token}`, file_url: videoUrl } }, 60000);
  if (!up.ok) throw new Error(`Facebook video yuklash: HTTP ${up.status}`);
  return call('POST', `/${p.id}/video_reels`, { upload_phase: 'finish', video_id: st.video_id, video_state: 'PUBLISHED', description: igCaption(item, s, icfg), access_token: p.token }, 60000);
}

// lib/ig.js: after a job went out on Instagram
export async function fbMirror(job, s) {
  if (!db.hasRedis() || !job?.item?.image_url) return;
  const cfg = fbCfg(s);
  if (!cfg.on || job.slot !== cfg.source || !cfg.kinds[job.kind]) return;
  if (!(await r().get(TOK()))) return;
  if (!(await db.once(`fb:${job.kind}:${job.item.sku || job.item.product_id}:${db.today()}`, 60 * 60 * 26))) return;
  await r().rpush(Q(), { id: randomBytes(4).toString('hex'), kind: job.kind, item: job.item, at: Date.now(), tries: 0 });
  await r().ltrim(Q(), -Q_MAX, -1);
}

const setStatus = async (patch) => r().set(ST(), { ...((await r().get(ST())) || {}), ...patch });

export async function fbTick(s, { deadline = Date.now() + 60000 } = {}) {
  const cfg = fbCfg(s);
  const out = { posted: 0 };
  if (!db.hasRedis() || !cfg.on) return out;
  const all = (await r().lrange(Q(), 0, -1)) || [];
  out.waiting = all.length;
  if (!all.length || !(await r().get(TOK()))) return out;
  const now = hhmm();
  if (now < cfg.hours_from || now >= cfg.hours_to) return { ...out, reason: 'vaqt oralig\'idan tashqari' };
  const st = (await r().get(ST())) || {};
  if (st.paused_until > Date.now()) return { ...out, reason: 'dam' };
  if (st.last_at && Date.now() - st.last_at < cfg.gap_min * 60000) return { ...out, reason: 'oraliq' };
  const stats = await db.getStats();
  const max = { post: cfg.max_posts, reel: cfg.max_reels, story: cfg.max_stories };
  const soldOut = (await r().hgetall(db.K.stockOut).catch(() => null)) || {};
  const keep = [];
  let done = false;
  let p = null;
  for (const job of all) {
    if (job.item?.product_id && soldOut[String(job.item.product_id)]) continue; // sold out: dropped
    if (!cfg.kinds[job.kind]) continue;
    const need = job.kind === 'reel' ? 120000 : 40000;
    if (done || (Number(stats[`fb_${job.kind}`]) || 0) >= max[job.kind] || Date.now() + need > deadline) {
      keep.push(job);
      continue;
    }
    try {
      p ||= await page();
      if (job.kind === 'reel') await postReel(p, job.item, s, cfg);
      else if (job.kind === 'story') await postStory(p, job.item);
      else await postPhoto(p, job.item, s, cfg);
      await db.incrStat(`fb_${job.kind}`);
      await setStatus({ ok_at: Date.now(), last_at: Date.now(), error: null });
      out.posted++;
      done = true; // one per tick (the gap does the rest)
      console.log(`fb: ${job.kind} ok sku=${job.item?.sku}`);
    } catch (e) {
      const msg = errText(e);
      console.error(`fb: ${job.kind} sku=${job.item?.sku}: ${msg}`);
      const limit = /limit|too many|rate/i.test(msg);
      await setStatus({ error: msg.slice(0, 300), error_at: Date.now(), ...(limit ? { paused_until: Date.now() + 3600000 } : {}) });
      if (limit || (job.tries || 0) + 1 < 3) keep.push({ ...job, tries: (job.tries || 0) + (limit ? 0 : 1) });
      done = true;
    }
  }
  // jobs added meanwhile are kept
  const now2 = (await r().lrange(Q(), 0, -1)) || [];
  keep.push(...now2.slice(all.length));
  await r().del(Q());
  if (keep.length) await r().rpush(Q(), ...keep);
  out.waiting = keep.length;
  return out;
}

// ---- dashboard ----

export async function fbView(s) {
  const [k, t, st, n, stats] = await Promise.all([keys(), r().get(TOK()), r().get(ST()), r().llen(Q()), db.getStats()]);
  return {
    ok: true,
    configured: Boolean(k),
    keys_from: k?.from || null,
    app_hint: k?.id ? `${String(k.id).slice(0, 6)}…` : '',
    redirect: fbRedirect(),
    connected: Boolean(t?.pages?.length),
    pages: (t?.pages || []).map((p) => ({ id: p.id, name: p.name })),
    page_id: t?.page_id || null,
    cfg: fbCfg(s),
    status: st || {},
    today: { post: Number(stats.fb_post) || 0, reel: Number(stats.fb_reel) || 0, story: Number(stats.fb_story) || 0 },
    queue: Number(n) || 0,
  };
}

export async function fbSetCfg(body = {}) {
  const s = await db.getSettings();
  const cur = fbCfg(s);
  const n = (v, lo, hi, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Math.min(hi, Math.max(lo, Math.round(Number(v)))));
  const hm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);
  const next = {
    on: 'on' in body ? Boolean(body.on) : cur.on,
    source: ['a', 'b'].includes(body.source) ? body.source : cur.source,
    kinds: { post: Boolean(body.kinds?.post ?? cur.kinds.post), reel: Boolean(body.kinds?.reel ?? cur.kinds.reel), story: Boolean(body.kinds?.story ?? cur.kinds.story) },
    max_posts: n(body.max_posts, 0, 50, cur.max_posts),
    max_reels: n(body.max_reels, 0, 50, cur.max_reels),
    max_stories: n(body.max_stories, 0, 50, cur.max_stories),
    gap_min: n(body.gap_min, 0, 600, cur.gap_min),
    hours_from: hm(body.hours_from, cur.hours_from),
    hours_to: hm(body.hours_to, cur.hours_to),
  };
  await db.updateSettings({ fb: next });
  if (body.page_id) {
    const t = await r().get(TOK());
    if (t?.pages?.some((p) => p.id === String(body.page_id))) await r().set(TOK(), { ...t, page_id: String(body.page_id) });
  }
  return { ok: true, message: '💾 Saqlandi', cfg: next };
}

export async function fbClear() {
  await r().del(Q());
  return { ok: true, message: '🧹 Facebook navbati tozalandi' };
}
