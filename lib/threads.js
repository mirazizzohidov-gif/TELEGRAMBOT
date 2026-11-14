// "🧵 Threads": the bot's Instagram photo posts and Reels go to Threads too (same picture / same video).
// Meta app with the "Access the Threads API" use case: Threads App ID / secret are entered on the dashboard
// (admin), the redirect URI is https://<host>/api/thauth. While the app is in development, the Threads
// account must be a "Threads Tester" (App roles) and accept the invite in Threads (Settings → Account →
// Website permissions → Invites).
// Queue (Redis), one post per tick, within the daily limits / gap / hours; sold-out products are dropped.
import { randomBytes } from 'node:crypto';
import { igCaption, igCfg, igImageUrl, igMusicPick, igVideoUrl } from './ig.js';
import * as db from './store.js';
import { errText, fetchWithTimeout } from './util.js';

const G = 'https://graph.threads.net';
const V = 'v1.0';
const F = (x) => db.K.flag(`th:${x}`);
const KEYS = () => F('keys'); // { id, secret }
const TOK = () => F('tok'); // { token, user_id, username, expires_at, at }
const ST = () => F('st');
const Q = () => F('q'); // list of { id, kind: 'post' | 'reel', item, at, tries }
const NONCE = (n) => F(`nonce:${n}`);
const Q_MAX = 300;
const SCOPES = ['threads_basic', 'threads_content_publish', 'threads_manage_insights'];
export const TH_DEFAULTS = { on: true, source: 'a', kinds: { post: true, reel: true }, max_posts: 10, max_reels: 10, gap_min: 20, hours_from: '09:00', hours_to: '22:00' };
const r = () => db.redis();
const hhmm = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false });
const host = () => process.env.TH_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
export const thRedirect = () => `https://${host()}/api/thauth`;
export const thCfg = (s) => {
  const c = { ...TH_DEFAULTS, ...(s?.th || {}) };
  c.kinds = { ...TH_DEFAULTS.kinds, ...(s?.th?.kinds || {}) };
  return c;
};

async function keys() {
  if (process.env.TH_APP_ID && process.env.TH_APP_SECRET) return { id: process.env.TH_APP_ID, secret: process.env.TH_APP_SECRET, from: 'env' };
  const k = db.hasRedis() ? await r().get(KEYS()).catch(() => null) : null;
  return k?.id && k?.secret ? { ...k, from: 'dashboard' } : null;
}

async function call(method, path, params = {}, ms = 30000) {
  const url = new URL(path.startsWith('http') ? path : `${G}/${V}${path}`);
  let init = { method };
  if (method === 'GET') for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  else init = { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) };
  const res = await fetchWithTimeout(url, init, ms);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`Threads: ${j.error?.error_user_msg || j.error?.message || res.status}`);
  return j;
}

// ---- keys + OAuth ----

export async function thSetKeys(body = {}) {
  const id = String(body.id || '').trim();
  const secret = String(body.secret || '').trim();
  if (!/^\d{8,25}$/.test(id)) return { ok: false, message: "Threads App ID noto'g'ri (faqat raqamlar)" };
  if (!/^[a-f0-9]{20,64}$/i.test(secret)) return { ok: false, message: "Threads App secret noto'g'ri" };
  await r().set(KEYS(), { id, secret, at: Date.now() });
  return { ok: true, message: '🔑 Kalitlar saqlandi — endi «🔗 Threads ulash» ni bosing' };
}
export async function thDisconnect() {
  await r().del(TOK());
  return { ok: true, message: '🗑 Threads uzildi' };
}
export async function thRemoveKeys() {
  await r().del(KEYS());
  return thDisconnect();
}

export async function thAuthUrl() {
  const k = await keys();
  if (!k) throw new Error('Avval dashboardda Threads App ID va App secret kiriting');
  const state = randomBytes(16).toString('hex');
  await r().set(NONCE(state), 1, { ex: 900 });
  const q = new URLSearchParams({ client_id: k.id, redirect_uri: thRedirect(), scope: SCOPES.join(','), response_type: 'code', state });
  return `https://threads.net/oauth/authorize?${q}`;
}

export async function thFinishAuth(code, state) {
  if (!state || !(await r().get(NONCE(state)))) throw new Error('Havola eskirgan — dashboarddan qaytadan «Ulash» bosing');
  await r().del(NONCE(state));
  const k = await keys();
  if (!k) throw new Error("Threads kalitlari yo'q");
  const short = await call('POST', `${G}/oauth/access_token`, { client_id: k.id, client_secret: k.secret, grant_type: 'authorization_code', redirect_uri: thRedirect(), code: String(code).replace(/#_$/, '') });
  const long = await call('GET', `${G}/access_token`, { grant_type: 'th_exchange_token', client_secret: k.secret, access_token: short.access_token });
  const me = await call('GET', '/me', { fields: 'id,username', access_token: long.access_token });
  await r().set(TOK(), { token: long.access_token, user_id: me.id || short.user_id, username: me.username || '', expires_at: Date.now() + (Number(long.expires_in) || 60 * 86400) * 1000, at: Date.now() });
  return { name: me.username ? `@${me.username}` : 'Threads' };
}

// long-lived tokens live 60 days: refreshed when older than a day and less than ~50 days left
async function token() {
  const t = await r().get(TOK());
  if (!t?.token) throw new Error('Threads ulanmagan');
  if (t.expires_at && t.expires_at - Date.now() < 50 * 86400000 && Date.now() - (t.refreshed_at || t.at || 0) > 86400000) {
    try {
      const n = await call('GET', `${G}/refresh_access_token`, { grant_type: 'th_refresh_token', access_token: t.token });
      const next = { ...t, token: n.access_token, expires_at: Date.now() + (Number(n.expires_in) || 60 * 86400) * 1000, refreshed_at: Date.now() };
      await r().set(TOK(), next);
      return next;
    } catch (e) {
      console.error(`threads refresh: ${errText(e)}`);
    }
  }
  return t;
}

// ---- publishing ----

// Threads text: at most 500 characters — whole lines are dropped from the end (hashtags first)
export function thText(item, s, icfg) {
  let lines = igCaption(item, s, icfg).split('\n');
  const len = () => lines.join('\n').length;
  while (len() > 500 && lines.length > 1 && /^\s*#/.test(lines[lines.length - 1])) lines.pop();
  if (len() > 500) lines = lines.map((l) => (l.length > 220 ? l.slice(0, 218).trimEnd() + '…' : l));
  while (len() > 500 && lines.length > 1) lines.pop();
  return lines.join('\n').slice(0, 500);
}

async function waitFinished(id, tok, { tries = 20, every = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const st = await call('GET', `/${id}`, { fields: 'status,error_message', access_token: tok }).catch(() => null);
    if (st?.status === 'FINISHED') return;
    if (st?.status === 'ERROR' || st?.status === 'EXPIRED') throw new Error(`Threads: ${st.error_message || st.status}`);
    await new Promise((res) => setTimeout(res, every));
  }
  throw new Error('Threads: media tayyorlanishi uzoq davom etdi');
}

async function publish(job, s, cfg) {
  const t = await token();
  const icfg = igCfg(s, cfg.source);
  const text = thText(job.item, s, icfg);
  let params;
  if (job.kind === 'reel') {
    const videoUrl = igVideoUrl(job.item, icfg, s, icfg.music ? await igMusicPick().catch(() => null) : null);
    const warm = await fetchWithTimeout(`${videoUrl}&warm=1`, {}, 100000);
    if (!warm.ok) throw new Error(`Video tayyorlanmadi: HTTP ${warm.status}`);
    params = { media_type: 'VIDEO', video_url: videoUrl, text };
  } else {
    params = { media_type: 'IMAGE', image_url: igImageUrl(job.item.image_url, 'post'), text };
  }
  const c = await call('POST', `/${t.user_id}/threads`, { ...params, access_token: t.token }, 60000);
  await waitFinished(c.id, t.token, job.kind === 'reel' ? { tries: 25, every: 4000 } : { tries: 10, every: 2000 });
  return call('POST', `/${t.user_id}/threads_publish`, { creation_id: c.id, access_token: t.token }, 60000);
}

// lib/ig.js: after a photo post / Reel went out on Instagram
export async function thMirror(job, s) {
  if (!db.hasRedis() || !job?.item?.image_url || !['post', 'reel'].includes(job.kind)) return;
  const cfg = thCfg(s);
  if (!cfg.on || job.slot !== cfg.source || !cfg.kinds[job.kind]) return;
  if (!(await r().get(TOK()))) return;
  if (!(await db.once(`th:${job.kind}:${job.item.sku || job.item.product_id}:${db.today()}`, 60 * 60 * 26))) return;
  await r().rpush(Q(), { id: randomBytes(4).toString('hex'), kind: job.kind, item: job.item, at: Date.now(), tries: 0 });
  await r().ltrim(Q(), -Q_MAX, -1);
}

const setStatus = async (patch) => r().set(ST(), { ...((await r().get(ST())) || {}), ...patch });

export async function thTick(s, { deadline = Date.now() + 60000 } = {}) {
  const cfg = thCfg(s);
  const out = { posted: 0 };
  if (!db.hasRedis() || !cfg.on) return out;
  const all = (await r().lrange(Q(), 0, -1)) || [];
  out.waiting = all.length;
  if (!all.length || !(await r().get(TOK()))) return out;
  const now = hhmm();
  if (now < cfg.hours_from || now >= cfg.hours_to) return { ...out, reason: "vaqt oralig'idan tashqari" };
  const st = (await r().get(ST())) || {};
  if (st.paused_until > Date.now()) return { ...out, reason: 'dam' };
  if (st.last_at && Date.now() - st.last_at < cfg.gap_min * 60000) return { ...out, reason: 'oraliq' };
  const stats = await db.getStats();
  const max = { post: cfg.max_posts, reel: cfg.max_reels };
  const soldOut = (await r().hgetall(db.K.stockOut).catch(() => null)) || {};
  const keep = [];
  let done = false;
  for (const job of all) {
    if (job.item?.product_id && soldOut[String(job.item.product_id)]) continue; // sold out: dropped
    if (!cfg.kinds[job.kind]) continue;
    const need = job.kind === 'reel' ? 150000 : 50000;
    if (done || (Number(stats[`th_${job.kind}`]) || 0) >= max[job.kind] || Date.now() + need > deadline) {
      keep.push(job);
      continue;
    }
    try {
      await publish(job, s, cfg);
      await db.incrStat(`th_${job.kind}`);
      await setStatus({ ok_at: Date.now(), last_at: Date.now(), last_name: job.item?.name || '', error: null });
      out.posted++;
      console.log(`threads: ${job.kind} ok sku=${job.item?.sku}`);
    } catch (e) {
      const msg = errText(e);
      console.error(`threads: ${job.kind} sku=${job.item?.sku}: ${msg}`);
      const limit = /limit|too many|rate/i.test(msg);
      await setStatus({ error: msg.slice(0, 300), error_at: Date.now(), last_at: Date.now(), ...(limit ? { paused_until: Date.now() + 3600000 } : {}) });
      if (limit || (job.tries || 0) + 1 < 3) keep.push({ ...job, tries: (job.tries || 0) + (limit ? 0 : 1) });
    }
    done = true; // one per tick (the gap does the rest)
  }
  const now2 = (await r().lrange(Q(), 0, -1)) || [];
  keep.push(...now2.slice(all.length));
  await r().del(Q());
  if (keep.length) await r().rpush(Q(), ...keep);
  out.waiting = keep.length;
  return out;
}

// ---- dashboard ----

export async function thView(s) {
  const [k, t, st, n, stats] = await Promise.all([keys(), r().get(TOK()), r().get(ST()), r().llen(Q()), db.getStats()]);
  const next = ((await r().lrange(Q(), 0, 9)) || []).map((j) => ({ kind: j.kind, name: j.item?.name }));
  return {
    ok: true,
    configured: Boolean(k),
    keys_from: k?.from || null,
    app_hint: k?.id ? `${String(k.id).slice(0, 6)}…` : '',
    redirect: thRedirect(),
    connected: Boolean(t?.token),
    account: t?.username ? `@${t.username}` : null,
    expires_at: t?.expires_at || null,
    cfg: thCfg(s),
    status: st || {},
    today: { post: Number(stats.th_post) || 0, reel: Number(stats.th_reel) || 0 },
    queue: Number(n) || 0,
    next,
  };
}

export async function thSetCfg(body = {}) {
  const s = await db.getSettings();
  const cur = thCfg(s);
  const n = (v, lo, hi, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Math.min(hi, Math.max(lo, Math.round(Number(v)))));
  const hm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);
  const next = {
    on: 'on' in body ? Boolean(body.on) : cur.on,
    source: ['a', 'b'].includes(body.source) ? body.source : cur.source,
    kinds: { post: Boolean(body.kinds?.post ?? cur.kinds.post), reel: Boolean(body.kinds?.reel ?? cur.kinds.reel) },
    max_posts: n(body.max_posts, 0, 100, cur.max_posts),
    max_reels: n(body.max_reels, 0, 100, cur.max_reels),
    gap_min: n(body.gap_min, 0, 600, cur.gap_min),
    hours_from: hm(body.hours_from, cur.hours_from),
    hours_to: hm(body.hours_to, cur.hours_to),
  };
  await db.updateSettings({ th: next });
  return { ok: true, message: '💾 Saqlandi', cfg: next };
}

export async function thClear() {
  await r().del(Q());
  return { ok: true, message: '🧹 Threads navbati tozalandi' };
}

// "📈 Statistika": followers + the latest posts (views, likes, replies, reposts)
export async function thStatsData() {
  const t0 = await r().get(TOK());
  if (!t0?.token) return null;
  const t = await token();
  const posts = ((await call('GET', `/${t.user_id}/threads`, { fields: 'id,text,timestamp,permalink', limit: 20, access_token: t.token }).catch(() => ({ data: [] }))).data || []);
  let followers = null;
  try {
    const fi = await call('GET', `/${t.user_id}/threads_insights`, { metric: 'followers_count', access_token: t.token });
    followers = fi.data?.[0]?.total_value?.value ?? null;
  } catch {}
  const items = [];
  for (const p of posts) {
    const m = {};
    try {
      const ins = await call('GET', `/${p.id}/insights`, { metric: 'views,likes,replies,reposts', access_token: t.token });
      for (const row of ins.data || []) m[row.name] = row.values?.[0]?.value ?? row.total_value?.value ?? 0;
    } catch {}
    const line = String(p.text || '').split('\n').find((l) => /🛍/.test(l)) || String(p.text || '').split('\n').find((l) => l.trim()) || 'Post';
    items.push({ title: line.replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 80), at: Date.parse(p.timestamp) || 0, url: p.permalink, views: m.views ?? null, likes: m.likes || 0, comments: m.replies || 0, shares: m.reposts || 0 });
  }
  return { name: t.username ? `@${t.username}` : 'Threads', followers, items };
}
