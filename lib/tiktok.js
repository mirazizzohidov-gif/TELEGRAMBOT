// "🎵 TikTok": every Reel the bot publishes on Instagram also goes to TikTok (the same video: /api/igvid).
// TikTok developer app (developers.tiktok.com): Login Kit + Content Posting API; the Client key / secret
// are entered on the dashboard (admin), the redirect URI is https://<host>/api/ttauth.
// Two modes:
//   draft  — the video lands in the TikTok app's inbox (notification), you post it yourself (no audit needed)
//   direct — posted straight to the profile; until TikTok audits the app such posts are "only me" (private)
// Uploads: a queue (Redis), one video per tick, within the daily limit and the hours window.
import { randomBytes } from 'node:crypto';
import * as db from './store.js';
import { errText, fetchWithTimeout } from './util.js';

const TOK = () => db.K.flag('tt:tok'); // { refresh_token, open_id, name, scope, at }
const ACC = () => db.K.flag('tt:acc'); // cached access token
const ST = () => db.K.flag('tt:st'); // { ok_at, error, error_at, last_at, last_id, paused_until }
const Q = () => db.K.flag('ttq'); // list of { id, url, item, at, tries }
const NONCE = (n) => db.K.flag(`tt:nonce:${n}`);
const KEYS = () => db.K.flag('tt:keys'); // { id, secret }
const Q_MAX = 300;
const API = 'https://open.tiktokapis.com/v2';
export const TT_DEFAULTS = { on: true, mode: 'draft', max_per_day: 3, hours_from: '09:00', hours_to: '22:00', gap_min: 90, tags: '' };
const r = () => db.redis();
const hhmm = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false });

async function creds() {
  if (process.env.TT_CLIENT_KEY && process.env.TT_CLIENT_SECRET) return { id: process.env.TT_CLIENT_KEY, secret: process.env.TT_CLIENT_SECRET, from: 'env' };
  const k = db.hasRedis() ? await r().get(KEYS()).catch(() => null) : null;
  return k?.id && k?.secret ? { id: k.id, secret: k.secret, from: 'dashboard' } : null;
}
export const ttConfigured = async () => Boolean(await creds());
export const ttCfg = (s) => ({ ...TT_DEFAULTS, ...(s?.tt || {}) });
const host = () => process.env.TT_HOST || process.env.YT_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
export const ttRedirect = () => `https://${host()}/api/ttauth`;
const scopesFor = (mode) => (mode === 'direct' ? ['user.info.basic', 'video.publish', 'video.upload'] : ['user.info.basic', 'video.upload']);

export async function ttSetKeys(body = {}) {
  const id = String(body.id || '').trim();
  const secret = String(body.secret || '').trim();
  if (!/^[\w-]{8,64}$/.test(id)) return { ok: false, message: "Client key noto'g'ri" };
  if (secret.length < 10) return { ok: false, message: 'Client secret kiriting' };
  await r().set(KEYS(), { id, secret, at: Date.now() });
  return { ok: true, message: '🔑 Kalitlar saqlandi — endi «🔗 TikTok ulash» ni bosing' };
}

// ---- OAuth ----

export async function ttAuthUrl() {
  const c = await creds();
  if (!c) throw new Error('Avval dashboardda TikTok Client key va Client secret kiriting');
  const cfg = ttCfg(await db.getSettings());
  const state = randomBytes(16).toString('hex');
  await r().set(NONCE(state), 1, { ex: 900 });
  const q = new URLSearchParams({ client_key: c.id, scope: scopesFor(cfg.mode).join(','), response_type: 'code', redirect_uri: ttRedirect(), state });
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
}

async function tokenCall(params) {
  const c = await creds();
  if (!c) throw new Error("TikTok Client key / secret yo'q");
  const res = await fetchWithTimeout(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body: new URLSearchParams({ client_key: c.id, client_secret: c.secret, ...params }),
  }, 20000);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`TikTok: ${j.error_description || j.error || res.status}`);
  return j;
}

async function call(path, token, body, method = 'POST') {
  const res = await fetchWithTimeout(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, 30000);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || (j.error?.code && j.error.code !== 'ok')) throw new Error(`TikTok: ${j.error?.code || res.status}${j.error?.message ? ` — ${j.error.message}` : ''}`);
  return j.data || {};
}

export async function ttFinishAuth(code, state) {
  if (!state || !(await r().get(NONCE(state)))) throw new Error('Havola eskirgan — dashboarddan qaytadan «Ulash» bosing');
  await r().del(NONCE(state));
  const t = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: ttRedirect() });
  let name = t.open_id;
  try {
    const u = await call('/user/info/?fields=open_id,display_name', t.access_token, null, 'GET');
    name = u.user?.display_name || name;
  } catch {}
  await r().set(TOK(), { refresh_token: t.refresh_token, open_id: t.open_id, name, scope: t.scope || '', refresh_until: Date.now() + (Number(t.refresh_expires_in) || 365 * 86400) * 1000, at: Date.now() });
  await r().set(ACC(), t.access_token, { ex: Math.max(60, (Number(t.expires_in) || 86400) - 600) });
  return { name };
}

async function accessToken() {
  const cached = await r().get(ACC());
  if (cached) return String(cached);
  const tok = await r().get(TOK());
  if (!tok?.refresh_token) throw new Error('TikTok ulanmagan');
  const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: tok.refresh_token });
  await r().set(TOK(), { ...tok, refresh_token: t.refresh_token || tok.refresh_token, ...(t.refresh_expires_in ? { refresh_until: Date.now() + Number(t.refresh_expires_in) * 1000 } : {}) });
  await r().set(ACC(), t.access_token, { ex: Math.max(60, (Number(t.expires_in) || 86400) - 600) });
  return t.access_token;
}

export async function ttDisconnect() {
  await r().del(TOK());
  await r().del(ACC());
  return { ok: true, message: '🗑 TikTok uzildi' };
}
export async function ttRemoveKeys() {
  await r().del(KEYS());
  return ttDisconnect();
}

// ---- upload ----

const strip = (t) => String(t || '').replace(/[<>]/g, '');
export function ttCaption(item, s, cfg) {
  const fmt = (n) => Number(n).toLocaleString('ru-RU').replace(/,/g, ' ');
  const price = Number(item.price) > 0 ? `${fmt(item.price)} so'm` : '';
  const sale = Number(item.old_price) > Number(item.price) && Number(item.price) > 0 ? `🔥 ${fmt(item.old_price)} → ${price}` : price ? `💰 ${price}` : '';
  const tags = [item.tags, cfg.tags].filter(Boolean).join(' ').match(/#[\p{L}\p{N}_]+/gu) || [];
  return [strip(item.name), sale, s?.phone ? `📞 ${s.phone}` : '', [...new Set(tags)].slice(0, 10).join(' ')].filter(Boolean).join('\n').slice(0, 2000);
}

export async function ttUpload(mp4, { mode, caption }) {
  const token = await accessToken();
  const size = mp4.length;
  if (size > 64 * 1024 * 1024) throw new Error('video juda katta');
  const source_info = { source: 'FILE_UPLOAD', video_size: size, chunk_size: size, total_chunk_count: 1 };
  let init;
  if (mode === 'direct') {
    const ci = await call('/post/publish/creator_info/query/', token, {});
    const opts = ci.privacy_level_options || [];
    const privacy = opts.includes('PUBLIC_TO_EVERYONE') ? 'PUBLIC_TO_EVERYONE' : opts.includes('SELF_ONLY') ? 'SELF_ONLY' : opts[0] || 'SELF_ONLY';
    init = await call('/post/publish/video/init/', token, {
      post_info: { title: caption, privacy_level: privacy, disable_duet: false, disable_comment: false, disable_stitch: false, video_cover_timestamp_ms: 1000 },
      source_info,
    }).catch(async (e) => {
      // not audited yet: TikTok allows only "only me"
      if (!/unaudited|privacy_level/i.test(e.message) || privacy === 'SELF_ONLY') throw e;
      return call('/post/publish/video/init/', token, { post_info: { title: caption, privacy_level: 'SELF_ONLY', video_cover_timestamp_ms: 1000 }, source_info });
    });
  } else {
    init = await call('/post/publish/inbox/video/init/', token, { source_info });
  }
  if (!init.upload_url || !init.publish_id) throw new Error('TikTok: yuklash manzili kelmadi');
  const put = await fetchWithTimeout(init.upload_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size), 'Content-Range': `bytes 0-${size - 1}/${size}` },
    body: mp4,
  }, 90000);
  if (!put.ok) throw new Error(`TikTok upload: HTTP ${put.status} ${(await put.text().catch(() => '')).slice(0, 200)}`);
  return init.publish_id;
}

async function ttStatus(publishId) {
  const token = await accessToken();
  return call('/post/publish/status/fetch/', token, { publish_id: publishId });
}

// ---- queue ----

// after a Reel went to Instagram (lib/ig.js): the same video for TikTok (once a day per product)
export async function ttEnqueue(item, videoUrl, s) {
  if (!db.hasRedis() || !videoUrl) return;
  const cfg = ttCfg(s);
  if (!cfg.on || !(await r().get(TOK()))) return;
  if (!(await db.once(`tt:${item.sku || item.product_id}:${db.today()}`, 60 * 60 * 26))) return;
  await r().rpush(Q(), { id: randomBytes(4).toString('hex'), url: videoUrl, item, at: Date.now(), tries: 0 });
  await r().ltrim(Q(), -Q_MAX, -1);
}

const setStatus = async (patch) => r().set(ST(), { ...((await r().get(ST())) || {}), ...patch });

export async function ttTick(s, { deadline = Date.now() + 60000 } = {}) {
  const cfg = ttCfg(s);
  const out = { uploaded: 0 };
  if (!db.hasRedis() || !cfg.on || !(await ttConfigured())) return out;
  const st = (await r().get(ST())) || {};
  // the last upload: final state (published / failed) for the dashboard
  if (st.last_id && !st.last_final && Date.now() - (st.last_at || 0) > 60000) {
    try {
      const x = await ttStatus(st.last_id);
      if (['PUBLISH_COMPLETE', 'SEND_TO_USER_INBOX', 'FAILED'].includes(x.status)) {
        await setStatus({ last_final: x.status, ...(x.status === 'FAILED' ? { error: `TikTok: ${x.fail_reason || 'failed'}`, error_at: Date.now() } : {}) });
      }
    } catch {}
  }
  const n = Number(await r().llen(Q())) || 0;
  out.waiting = n;
  if (!n || !(await r().get(TOK()))) return out;
  const now = hhmm();
  if (now < cfg.hours_from || now >= cfg.hours_to) return { ...out, reason: "vaqt oralig'idan tashqari" };
  if (st.last_at && Date.now() - st.last_at < cfg.gap_min * 60000) return { ...out, reason: 'oraliq' };
  if (st.paused_until && st.paused_until > Date.now()) return { ...out, reason: 'limit — dam' };
  const used = Number((await db.getStats())['tt_uploaded']) || 0;
  if (used >= cfg.max_per_day) return { ...out, reason: 'kunlik limit' };
  if (Date.now() + 100000 > deadline) return { ...out, reason: 'vaqt yetmadi' };
  const soldOut = (await r().hgetall(db.K.stockOut).catch(() => null)) || {};
  let job = null;
  while (!job) {
    const [j] = (await r().lrange(Q(), 0, 0)) || [];
    if (!j) return out;
    await r().ltrim(Q(), 1, -1);
    if (j.item?.product_id && soldOut[String(j.item.product_id)]) continue;
    job = j;
  }
  try {
    const res = await fetchWithTimeout(job.url, {}, 100000);
    if (!res.ok) throw new Error(`video: HTTP ${res.status}`);
    const mp4 = Buffer.from(await res.arrayBuffer());
    const id = await ttUpload(mp4, { mode: cfg.mode, caption: ttCaption(job.item, s, cfg) });
    await db.incrStat('tt_uploaded');
    await setStatus({ ok_at: Date.now(), last_at: Date.now(), last_id: id, last_mode: cfg.mode, last_name: job.item?.name || '', last_final: null, error: null });
    out.uploaded = 1;
    out.id = id;
    console.log(`tt: uploaded ${id} sku=${job.item?.sku} mode=${cfg.mode}`);
  } catch (e) {
    const msg = errText(e);
    console.error(`tt: ${msg}`);
    const limit = /rate_limit|spam_risk|too_many|exceed/i.test(msg);
    const fatal = /access_token_invalid|scope_not_authorized|unaudited_client_can_only_post_to_private_accounts|url_ownership/i.test(msg);
    await setStatus({ error: msg.slice(0, 300), error_at: Date.now(), last_at: Date.now(), ...(limit ? { paused_until: Date.now() + 6 * 3600000 } : {}) });
    if (limit || (!fatal && (job.tries || 0) + 1 < 3)) await r().lpush(Q(), { ...job, tries: (job.tries || 0) + (limit ? 0 : 1) });
    out.error = msg;
  }
  return out;
}

// ---- dashboard ----

export async function ttView(s) {
  const [tok, st, n, stats, c] = await Promise.all([r().get(TOK()), r().get(ST()), r().llen(Q()), db.getStats(), creds()]);
  const next = ((await r().lrange(Q(), 0, 9)) || []).map((j) => ({ id: j.id, name: j.item?.name, sku: j.item?.sku, at: j.at }));
  return {
    ok: true,
    configured: Boolean(c),
    keys_from: c?.from || null,
    client_hint: c?.id ? `${c.id.slice(0, 6)}…` : '',
    redirect: ttRedirect(),
    connected: Boolean(tok?.refresh_token),
    account: tok?.name || null,
    scope: tok?.scope || '',
    refresh_until: tok?.refresh_until || null,
    cfg: ttCfg(s),
    status: st || {},
    today: Number(stats.tt_uploaded) || 0,
    queue: Number(n) || 0,
    next,
  };
}

export async function ttSetCfg(body = {}) {
  const s = await db.getSettings();
  const cur = ttCfg(s);
  const n = (v, lo, hi, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Math.min(hi, Math.max(lo, Math.round(Number(v)))));
  const hm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);
  const next = {
    on: 'on' in body ? Boolean(body.on) : cur.on,
    mode: ['draft', 'direct'].includes(body.mode) ? body.mode : cur.mode,
    max_per_day: n(body.max_per_day, 0, 15, cur.max_per_day),
    hours_from: hm(body.hours_from, cur.hours_from),
    hours_to: hm(body.hours_to, cur.hours_to),
    gap_min: n(body.gap_min, 0, 600, cur.gap_min),
    tags: String(body.tags ?? cur.tags).slice(0, 300),
  };
  await db.updateSettings({ tt: next });
  const relink = next.mode !== cur.mode && (await r().get(TOK()));
  return { ok: true, message: relink ? "💾 Saqlandi — rejim o'zgardi, «🔗 TikTok ulash» ni qayta bosing" : '💾 Saqlandi', cfg: next };
}

export async function ttClear() {
  await r().del(Q());
  return { ok: true, message: '🧹 TikTok navbati tozalandi' };
}
