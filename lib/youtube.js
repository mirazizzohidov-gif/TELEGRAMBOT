// "▶️ YouTube Shorts": every Reel the bot publishes on Instagram also goes to the YouTube channel as a Short
// (the same video: /api/igvid). Google OAuth: Vercel env YT_CLIENT_ID + YT_CLIENT_SECRET (a Google Cloud
// "Web application" OAuth client with the redirect URI https://<host>/api/ytauth); the dashboard's
// "🔗 YouTube ulash" (admin) opens Google's consent page, /api/ytauth stores the refresh token.
// Uploads: a queue (Redis), one video per tick, within the daily limit and the hours window.
// Note: Google keeps uploads of an unverified API project "private" until its API audit is approved.
import { randomBytes } from 'node:crypto';
import * as db from './store.js';
import { errText, fetchWithTimeout } from './util.js';

const TOK = () => db.K.flag('yt:tok'); // { refresh_token, channel_id, channel_title, at }
const ACC = () => db.K.flag('yt:acc'); // cached access token
const ST = () => db.K.flag('yt:st'); // { ok_at, error, error_at, last_at, last_id }
const Q = () => db.K.flag('ytq'); // list of { id, url, item, at, tries }
const NONCE = (n) => db.K.flag(`yt:nonce:${n}`);
const KEYS = () => db.K.flag('yt:keys'); // { id, secret } — entered on the dashboard (admin) when not in Vercel env
const Q_MAX = 300;
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];
export const YT_DEFAULTS = { on: true, privacy: 'public', max_per_day: 6, hours_from: '09:00', hours_to: '22:00', gap_min: 60, tags: '' };
const r = () => db.redis();
const hhmm = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false });

// Google OAuth client: Vercel env (YT_CLIENT_ID / YT_CLIENT_SECRET) or the keys saved on the dashboard
async function creds() {
  if (process.env.YT_CLIENT_ID && process.env.YT_CLIENT_SECRET) return { id: process.env.YT_CLIENT_ID, secret: process.env.YT_CLIENT_SECRET, from: 'env' };
  const k = db.hasRedis() ? await r().get(KEYS()).catch(() => null) : null;
  return k?.id && k?.secret ? { id: k.id, secret: k.secret, from: 'dashboard' } : null;
}
export const ytConfigured = async () => Boolean(await creds());

export async function ytSetKeys(body = {}) {
  const id = String(body.id || '').trim();
  const secret = String(body.secret || '').trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) return { ok: false, message: "Client ID noto'g'ri (…apps.googleusercontent.com bilan tugaydi)" };
  if (secret.length < 10) return { ok: false, message: 'Client secret kiriting' };
  await r().set(KEYS(), { id, secret, at: Date.now() });
  return { ok: true, message: "🔑 Kalitlar saqlandi — endi «🔗 YouTube ulash» ni bosing" };
}
export const ytCfg = (s) => ({ ...YT_DEFAULTS, ...(s?.yt || {}) });
const host = () => process.env.YT_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
export const ytRedirect = () => `https://${host()}/api/ytauth`;

// ---- OAuth ----

export async function ytAuthUrl() {
  const c = await creds();
  if (!c) throw new Error("Avval dashboardda Google Client ID va Client secret kiriting");
  const state = randomBytes(16).toString('hex');
  await r().set(NONCE(state), 1, { ex: 900 });
  const q = new URLSearchParams({ client_id: c.id, redirect_uri: ytRedirect(), response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenCall(params) {
  const c = await creds();
  if (!c) throw new Error("Google Client ID / secret yo'q");
  const res = await fetchWithTimeout('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...params }) }, 20000);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Google: ${j.error_description || j.error || res.status}`);
  return j;
}

async function api(method, path, token, body) {
  const res = await fetchWithTimeout(`https://www.googleapis.com/youtube/v3${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }, 30000);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YouTube: ${j.error?.message || res.status}`);
  return j;
}

// /api/ytauth?code=…&state=… -> refresh token + channel
export async function ytFinishAuth(code, state) {
  if (!state || !(await r().get(NONCE(state)))) throw new Error('Havola eskirgan — dashboarddan qaytadan «Ulash» bosing');
  await r().del(NONCE(state));
  const t = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: ytRedirect() });
  if (!t.refresh_token) throw new Error("Google refresh token bermadi — myaccount.google.com/permissions'da ilovani o'chirib, qayta ulang");
  const ch = await api('GET', '/channels?part=snippet&mine=true', t.access_token);
  const c = ch.items?.[0];
  if (!c) throw new Error("Bu Google akkauntda YouTube kanal yo'q");
  await r().set(TOK(), { refresh_token: t.refresh_token, channel_id: c.id, channel_title: c.snippet?.title || c.id, at: Date.now() });
  await r().set(ACC(), t.access_token, { ex: Math.max(60, (Number(t.expires_in) || 3600) - 300) });
  return { channel: c.snippet?.title || c.id };
}

async function accessToken() {
  const cached = await r().get(ACC());
  if (cached) return String(cached);
  const tok = await r().get(TOK());
  if (!tok?.refresh_token) throw new Error('YouTube ulanmagan');
  const t = await tokenCall({ refresh_token: tok.refresh_token, grant_type: 'refresh_token' });
  await r().set(ACC(), t.access_token, { ex: Math.max(60, (Number(t.expires_in) || 3600) - 300) });
  return t.access_token;
}

export async function ytRemoveKeys() {
  await r().del(KEYS());
  return ytDisconnect();
}

export async function ytDisconnect() {
  await r().del(TOK());
  await r().del(ACC());
  return { ok: true, message: '🗑 YouTube uzildi' };
}

// ---- upload ----

const strip = (t) => String(t || '').replace(/[<>]/g, '');
export function ytMeta(item, s, cfg) {
  const price = Number(item.price) > 0 ? ` — ${Number(item.price).toLocaleString('ru-RU').replace(/,/g, ' ')} so'm` : '';
  const title = `${strip(item.name).slice(0, 80)}${price}`.slice(0, 92) + ' #shorts';
  const tags = [item.tags, cfg.tags].filter(Boolean).join(' ').match(/#[\p{L}\p{N}_]+/gu) || [];
  const description = [
    strip(item.name),
    item.desc ? strip(item.desc) : '',
    Number(item.old_price) > Number(item.price) && Number(item.price) > 0 ? `Chegirma: ${Number(item.old_price).toLocaleString('ru-RU')} → ${Number(item.price).toLocaleString('ru-RU')} so'm` : price ? `Narxi:${price.replace(' —', '')}` : '',
    item.sku ? `Kod: ${item.sku}` : '',
    '',
    s?.phone ? `Buyurtma: ${s.phone}` : '',
    s?.order_url ? `Telegram: ${s.order_url}` : '',
    '',
    [...new Set(['#shorts', ...tags])].slice(0, 15).join(' '),
  ]
    .filter((l, i, a) => l || (a[i - 1] && i < a.length - 1))
    .join('\n')
    .slice(0, 4900);
  return { title, description, tags: tags.map((t) => t.slice(1)).slice(0, 15) };
}

export async function ytUpload(mp4, { title, description, tags, privacy }) {
  const token = await accessToken();
  const meta = { snippet: { title, description, tags, categoryId: '22' }, status: { privacyStatus: privacy || 'public', selfDeclaredMadeForKids: false } };
  const start = await fetchWithTimeout('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(mp4.length) },
    body: JSON.stringify(meta),
  }, 30000);
  if (!start.ok) {
    const j = await start.json().catch(() => ({}));
    throw new Error(`YouTube: ${j.error?.message || start.status}`);
  }
  const loc = start.headers.get('location');
  if (!loc) throw new Error('YouTube: yuklash manzili kelmadi');
  const put = await fetchWithTimeout(loc, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(mp4.length) }, body: mp4 }, 90000);
  const j = await put.json().catch(() => ({}));
  if (!put.ok || !j.id) throw new Error(`YouTube: ${j.error?.message || put.status}`);
  return j.id;
}

// ---- queue ----

// after a Reel went to Instagram (lib/ig.js): the same video for YouTube (once a day per product)
export async function ytEnqueue(item, videoUrl, s) {
  if (!db.hasRedis() || !videoUrl) return;
  const cfg = ytCfg(s);
  if (!cfg.on || !(await r().get(TOK()))) return;
  if (!(await db.once(`yt:${item.sku || item.product_id}:${db.today()}`, 60 * 60 * 26))) return;
  await r().rpush(Q(), { id: randomBytes(4).toString('hex'), url: videoUrl, item, at: Date.now(), tries: 0 });
  await r().ltrim(Q(), -Q_MAX, -1);
}

const setStatus = async (patch) => r().set(ST(), { ...((await r().get(ST())) || {}), ...patch });

export async function ytTick(s, { deadline = Date.now() + 60000 } = {}) {
  const cfg = ytCfg(s);
  const out = { uploaded: 0 };
  if (!db.hasRedis() || !cfg.on || !(await ytConfigured())) return out;
  const n = Number(await r().llen(Q())) || 0;
  out.waiting = n;
  if (!n || !(await r().get(TOK()))) return out;
  const now = hhmm();
  if (now < cfg.hours_from || now >= cfg.hours_to) return { ...out, reason: 'vaqt oralig\'idan tashqari' };
  const st = (await r().get(ST())) || {};
  if (st.last_at && Date.now() - st.last_at < cfg.gap_min * 60000) return { ...out, reason: 'oraliq' };
  if (st.paused_until && st.paused_until > Date.now()) return { ...out, reason: 'limit — dam' };
  const used = Number((await db.getStats())['yt_uploaded']) || 0;
  if (used >= cfg.max_per_day) return { ...out, reason: 'kunlik limit' };
  if (Date.now() + 100000 > deadline) return { ...out, reason: 'vaqt yetmadi' };
  // sold out meanwhile: skipped
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
    const id = await ytUpload(mp4, { ...ytMeta(job.item, s, cfg), privacy: cfg.privacy });
    await db.incrStat('yt_uploaded');
    await setStatus({ ok_at: Date.now(), last_at: Date.now(), last_id: id, error: null });
    out.uploaded = 1;
    out.id = id;
    console.log(`yt: uploaded ${id} sku=${job.item?.sku}`);
  } catch (e) {
    const msg = errText(e);
    console.error(`yt: ${msg}`);
    const quota = /quota|uploadLimitExceeded|rateLimit/i.test(msg);
    await setStatus({ error: msg.slice(0, 300), error_at: Date.now(), ...(quota ? { paused_until: Date.now() + 6 * 3600000 } : {}) });
    if (quota || (job.tries || 0) + 1 < 3) await r().lpush(Q(), { ...job, tries: (job.tries || 0) + (quota ? 0 : 1) });
    out.error = msg;
  }
  return out;
}

// ---- dashboard ----

export async function ytView(s) {
  const [tok, st, n, stats, c] = await Promise.all([r().get(TOK()), r().get(ST()), r().llen(Q()), db.getStats(), creds()]);
  const next = ((await r().lrange(Q(), 0, 9)) || []).map((j) => ({ id: j.id, name: j.item?.name, sku: j.item?.sku, at: j.at }));
  return {
    ok: true,
    configured: Boolean(c),
    keys_from: c?.from || null,
    client_hint: c?.id ? `${c.id.slice(0, 8)}…` : '',
    redirect: ytRedirect(),
    connected: Boolean(tok?.refresh_token),
    channel: tok?.channel_title || null,
    cfg: ytCfg(s),
    status: st || {},
    today: Number(stats.yt_uploaded) || 0,
    queue: Number(n) || 0,
    next,
  };
}

export async function ytSetCfg(body = {}) {
  const s = await db.getSettings();
  const cur = ytCfg(s);
  const n = (v, lo, hi, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Math.min(hi, Math.max(lo, Math.round(Number(v)))));
  const hm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);
  const next = {
    on: 'on' in body ? Boolean(body.on) : cur.on,
    privacy: ['public', 'unlisted', 'private'].includes(body.privacy) ? body.privacy : cur.privacy,
    max_per_day: n(body.max_per_day, 0, 50, cur.max_per_day),
    hours_from: hm(body.hours_from, cur.hours_from),
    hours_to: hm(body.hours_to, cur.hours_to),
    gap_min: n(body.gap_min, 0, 600, cur.gap_min),
    tags: String(body.tags ?? cur.tags).slice(0, 300),
  };
  await db.updateSettings({ yt: next });
  return { ok: true, message: '💾 Saqlandi', cfg: next };
}

export async function ytClear() {
  await r().del(Q());
  return { ok: true, message: '🧹 YouTube navbati tozalandi' };
}

// "📈 Statistika": channel totals + the latest uploads (uploads playlist: cheap on quota)
export async function ytStatsData() {
  if (!(await r().get(TOK()))) return null;
  const token = await accessToken();
  const ch = (await api('GET', '/channels?part=statistics,contentDetails,snippet&mine=true', token)).items?.[0];
  if (!ch) return null;
  const up = ch.contentDetails?.relatedPlaylists?.uploads;
  const ids = up ? ((await api('GET', `/playlistItems?part=contentDetails&maxResults=25&playlistId=${up}`, token)).items || []).map((x) => x.contentDetails?.videoId).filter(Boolean) : [];
  const vids = ids.length ? (await api('GET', `/videos?part=statistics,snippet,status&id=${ids.join(',')}`, token)).items || [] : [];
  const n = (v) => Number(v) || 0;
  return {
    name: ch.snippet?.title || '',
    subscribers: n(ch.statistics?.subscriberCount),
    views: n(ch.statistics?.viewCount),
    videos: n(ch.statistics?.videoCount),
    items: vids.map((v) => ({ title: v.snippet?.title || '', at: Date.parse(v.snippet?.publishedAt) || 0, url: `https://youtube.com/shorts/${v.id}`, privacy: v.status?.privacyStatus, views: n(v.statistics?.viewCount), likes: n(v.statistics?.likeCount), comments: n(v.statistics?.commentCount) })),
  };
}

