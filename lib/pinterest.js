// "📌 Pinterest": products the bot posts on Instagram (photo posts, Reels, carousels) also become Pins
// on a Pinterest board — the product photo, name, price and a link to the shop.
// Pinterest developer app (developers.pinterest.com): App ID / secret are entered on the dashboard (admin),
// the redirect URI is https://<host>/api/pinauth.
// Trial access: Pinterest allows Pins only through api-sandbox.pinterest.com (visible only to you) until the
// app gets Standard access — the dashboard has a switch for that ("Sinov (sandbox)").
// A queue (Redis), one Pin per tick, within the daily limit / gap / hours; a product is pinned once in 30 days.
import { randomBytes } from 'node:crypto';
import { formatPrice } from './bito.js';
import { igImageUrl } from './ig.js';
import * as db from './store.js';
import { errText, fetchWithTimeout } from './util.js';
import { shopUrl } from './waitlist.js';

const F = (x) => db.K.flag(`pin:${x}`);
const KEYS = () => F('keys'); // { id, secret }
const TOK = () => F('tok'); // { refresh_token, refresh_until, name, scope, at }
const ACC = () => F('acc'); // cached access token
const ST = () => F('st'); // { ok_at, last_at, last_name, last_pin, error, error_at, paused_until }
const Q = () => F('q'); // list of { id, item, at, tries }
const NONCE = (n) => F(`nonce:${n}`);
const Q_MAX = 300;
const SCOPES = ['boards:read', 'boards:write', 'pins:read', 'pins:write', 'user_accounts:read'];
export const PIN_DEFAULTS = { on: true, source: 'a', sandbox: false, board_id: '', board_name: 'Mixpodarok', max_per_day: 10, gap_min: 30, hours_from: '09:00', hours_to: '22:00', tags: '' };
const r = () => db.redis();
const hhmm = () => new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false });
const host = () => process.env.PIN_HOST || process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
export const pinRedirect = () => `https://${host()}/api/pinauth`;
export const pinCfg = (s) => ({ ...PIN_DEFAULTS, ...(s?.pin || {}) });
const apiBase = (cfg) => `https://${cfg?.sandbox ? 'api-sandbox' : 'api'}.pinterest.com/v5`;

async function creds() {
  if (process.env.PIN_APP_ID && process.env.PIN_APP_SECRET) return { id: process.env.PIN_APP_ID, secret: process.env.PIN_APP_SECRET, from: 'env' };
  const k = db.hasRedis() ? await r().get(KEYS()).catch(() => null) : null;
  return k?.id && k?.secret ? { id: k.id, secret: k.secret, from: 'dashboard' } : null;
}

export async function pinSetKeys(body = {}) {
  const id = String(body.id || '').trim();
  const secret = String(body.secret || '').trim();
  if (!/^\d{5,25}$/.test(id)) return { ok: false, message: "App ID noto'g'ri (faqat raqamlar)" };
  if (secret.length < 10) return { ok: false, message: 'App secret kiriting' };
  await r().set(KEYS(), { id, secret, at: Date.now() });
  return { ok: true, message: '🔑 Kalitlar saqlandi — endi «🔗 Pinterest ulash» ni bosing' };
}
export async function pinDisconnect() {
  await r().del(TOK());
  await r().del(ACC());
  return { ok: true, message: '🗑 Pinterest uzildi' };
}
export async function pinRemoveKeys() {
  await r().del(KEYS());
  return pinDisconnect();
}

// ---- OAuth ----

export async function pinAuthUrl() {
  const c = await creds();
  if (!c) throw new Error('Avval dashboardda Pinterest App ID va App secret kiriting');
  const state = randomBytes(16).toString('hex');
  await r().set(NONCE(state), 1, { ex: 900 });
  const q = new URLSearchParams({ client_id: c.id, redirect_uri: pinRedirect(), response_type: 'code', scope: SCOPES.join(','), state });
  return `https://www.pinterest.com/oauth/?${q}`;
}

async function tokenCall(params) {
  const c = await creds();
  if (!c) throw new Error("Pinterest App ID / secret yo'q");
  const res = await fetchWithTimeout('https://api.pinterest.com/v5/oauth/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${c.id}:${c.secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  }, 20000);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Pinterest: ${j.message || j.error_description || j.error || res.status}`);
  return j;
}

async function call(method, path, token, body, cfg) {
  const res = await fetchWithTimeout(`${apiBase(cfg)}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }, 40000);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Pinterest: ${res.status}${j.code != null ? ` (${j.code})` : ''} ${j.message || ''}`.trim());
  return j;
}

const saveAccess = (t) => r().set(ACC(), t.access_token, { ex: Math.max(60, (Number(t.expires_in) || 30 * 86400) - 3600) });

export async function pinFinishAuth(code, state) {
  if (!state || !(await r().get(NONCE(state)))) throw new Error('Havola eskirgan — dashboarddan qaytadan «Ulash» bosing');
  await r().del(NONCE(state));
  const t = await tokenCall({ grant_type: 'authorization_code', code, redirect_uri: pinRedirect() });
  let name = '';
  try {
    const u = await call('GET', '/user_account', t.access_token, null, { sandbox: false });
    name = u.username || u.business_name || '';
  } catch {}
  await r().set(TOK(), { refresh_token: t.refresh_token, refresh_until: Date.now() + (Number(t.refresh_token_expires_in) || 365 * 86400) * 1000, name, scope: t.scope || '', at: Date.now() });
  await saveAccess(t);
  return { name: name || 'Pinterest' };
}

async function accessToken() {
  const cached = await r().get(ACC());
  if (cached) return String(cached);
  const tok = await r().get(TOK());
  if (!tok?.refresh_token) throw new Error('Pinterest ulanmagan');
  const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: tok.refresh_token });
  await r().set(TOK(), { ...tok, refresh_token: t.refresh_token || tok.refresh_token, ...(t.refresh_token_expires_in ? { refresh_until: Date.now() + Number(t.refresh_token_expires_in) * 1000 } : {}) });
  await saveAccess(t);
  return t.access_token;
}

// ---- boards / pins ----

async function boards(token, cfg) {
  const j = await call('GET', '/boards?page_size=100', token, null, cfg);
  return (j.items || []).map((b) => ({ id: String(b.id), name: b.name }));
}

// the chosen board, or the one named like cfg.board_name (created when missing)
async function boardId(token, cfg) {
  if (cfg.board_id && !cfg.sandbox) return cfg.board_id;
  const name = (cfg.board_name || 'Mixpodarok').trim();
  const cacheKey = F(`board:${cfg.sandbox ? 'sb' : 'live'}:${name.toLowerCase()}`);
  const cached = await r().get(cacheKey);
  if (cached) return String(cached);
  const list = await boards(token, cfg);
  let b = list.find((x) => x.name.trim().toLowerCase() === name.toLowerCase());
  if (!b) b = await call('POST', '/boards', token, { name, description: "Sovg'alar va aksessuarlar — Mixpodarok", privacy: 'PUBLIC' }, cfg);
  await r().set(cacheKey, String(b.id), { ex: 30 * 86400 });
  return String(b.id);
}

const clean = (t) => String(t || '').replace(/[<>]/g, '').trim();
export function pinText(item, s, cfg) {
  const title = clean(item.name).slice(0, 100);
  const price = Number(item.price) > 0 ? (Number(item.old_price) > Number(item.price) ? `🔥 ${formatPrice(item.old_price)} → ${formatPrice(item.price)} so'm` : `💰 ${formatPrice(item.price)} so'm`) : '';
  const tags = [...new Set(([item.tags, cfg.tags].filter(Boolean).join(' ').match(/#[\p{L}\p{N}_]+/gu) || []))].slice(0, 8).join(' ');
  const description = [clean(item.desc), price, s?.phone ? `📞 ${s.phone}` : '', `🛍 ${shopUrl(s)}`, tags].filter(Boolean).join('\n').slice(0, 800);
  return { title, description };
}

export async function pinCreate(item, s, cfg) {
  const token = await accessToken();
  const board_id = await boardId(token, cfg);
  const { title, description } = pinText(item, s, cfg);
  return call('POST', '/pins', token, {
    board_id,
    title,
    description,
    link: shopUrl(s),
    alt_text: title.slice(0, 500),
    media_source: { source_type: 'image_url', url: igImageUrl(item.image_url, 'post') },
  }, cfg);
}

// ---- queue ----

// lib/ig.js: after a post / Reel / carousel went out on Instagram
export async function pinMirror(job, s) {
  if (!db.hasRedis() || !job || job.kind === 'story') return;
  const cfg = pinCfg(s);
  if (!cfg.on || (cfg.source !== 'any' && job.slot !== cfg.source)) return;
  if (!(await r().get(TOK()))) return;
  const items = (job.item ? [job.item] : job.items || []).filter((it) => it?.image_url);
  for (const item of items) {
    if (!(await db.once(`pin:${item.sku || item.product_id}`, 30 * 86400))) continue;
    await r().rpush(Q(), { id: randomBytes(4).toString('hex'), item, at: Date.now(), tries: 0 });
  }
  if (items.length) await r().ltrim(Q(), -Q_MAX, -1);
}

const setStatus = async (patch) => r().set(ST(), { ...((await r().get(ST())) || {}), ...patch });

export async function pinTick(s, { deadline = Date.now() + 60000 } = {}) {
  const cfg = pinCfg(s);
  const out = { pinned: 0 };
  if (!db.hasRedis() || !cfg.on) return out;
  const n = Number(await r().llen(Q())) || 0;
  out.waiting = n;
  if (!n || !(await r().get(TOK()))) return out;
  const now = hhmm();
  if (now < cfg.hours_from || now >= cfg.hours_to) return { ...out, reason: "vaqt oralig'idan tashqari" };
  const st = (await r().get(ST())) || {};
  if (st.paused_until && st.paused_until > Date.now()) return { ...out, reason: 'dam' };
  if (st.last_at && Date.now() - st.last_at < cfg.gap_min * 60000) return { ...out, reason: 'oraliq' };
  if ((Number((await db.getStats()).pin_created) || 0) >= cfg.max_per_day) return { ...out, reason: 'kunlik limit' };
  if (Date.now() + 45000 > deadline) return { ...out, reason: 'vaqt yetmadi' };
  const soldOut = (await r().hgetall(db.K.stockOut).catch(() => null)) || {};
  let job = null;
  while (!job) {
    const [j] = (await r().lrange(Q(), 0, 0)) || [];
    if (!j) return out;
    await r().ltrim(Q(), 1, -1);
    if (j.item?.product_id && soldOut[String(j.item.product_id)]) continue; // sold out: dropped
    job = j;
  }
  try {
    const p = await pinCreate(job.item, s, cfg);
    await db.incrStat('pin_created');
    await setStatus({ ok_at: Date.now(), last_at: Date.now(), last_name: job.item?.name || '', last_pin: p.id || null, error: null });
    out.pinned = 1;
    out.id = p.id;
    console.log(`pin: ${p.id} sku=${job.item?.sku}${cfg.sandbox ? ' (sandbox)' : ''}`);
  } catch (e) {
    let msg = errText(e);
    if (/\b403\b|trial|not permitted/i.test(msg) && !cfg.sandbox) msg += " — ilova hali «Trial» bo'lsa, «Sinov (sandbox)» ni yoqing yoki Standard access so'rang";
    console.error(`pin: ${msg}`);
    const limit = /\b429\b|rate limit/i.test(msg);
    const fatal = /\b401\b|\b403\b|ulanmagan/i.test(msg);
    await setStatus({ error: msg.slice(0, 300), error_at: Date.now(), last_at: Date.now(), ...(limit ? { paused_until: Date.now() + 3 * 3600000 } : {}) });
    if (limit || (!fatal && (job.tries || 0) + 1 < 3)) await r().lpush(Q(), { ...job, tries: (job.tries || 0) + (limit ? 0 : 1) });
    out.error = msg;
  }
  return out;
}

// ---- dashboard ----

export async function pinView(s) {
  const cfg = pinCfg(s);
  const [tok, st, n, stats, c] = await Promise.all([r().get(TOK()), r().get(ST()), r().llen(Q()), db.getStats(), creds()]);
  const next = ((await r().lrange(Q(), 0, 9)) || []).map((j) => ({ id: j.id, name: j.item?.name, sku: j.item?.sku }));
  let boardList = [];
  if (tok?.refresh_token) {
    try {
      boardList = await boards(await accessToken(), { sandbox: false });
    } catch {}
  }
  return {
    ok: true,
    configured: Boolean(c),
    keys_from: c?.from || null,
    client_hint: c?.id ? `${c.id.slice(0, 4)}…` : '',
    redirect: pinRedirect(),
    connected: Boolean(tok?.refresh_token),
    account: tok?.name || null,
    refresh_until: tok?.refresh_until || null,
    boards: boardList,
    cfg,
    status: st || {},
    today: Number(stats.pin_created) || 0,
    queue: Number(n) || 0,
    next,
  };
}

export async function pinSetCfg(body = {}) {
  const s = await db.getSettings();
  const cur = pinCfg(s);
  const n = (v, lo, hi, d) => (v === '' || v == null || !Number.isFinite(Number(v)) ? d : Math.min(hi, Math.max(lo, Math.round(Number(v)))));
  const hm = (v, d) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : d);
  const next = {
    on: 'on' in body ? Boolean(body.on) : cur.on,
    source: ['a', 'b', 'any'].includes(body.source) ? body.source : cur.source,
    sandbox: 'sandbox' in body ? Boolean(body.sandbox) : cur.sandbox,
    board_id: 'board_id' in body ? String(body.board_id || '').replace(/\D/g, '').slice(0, 30) : cur.board_id,
    board_name: 'board_name' in body ? String(body.board_name || '').trim().slice(0, 50) || 'Mixpodarok' : cur.board_name,
    max_per_day: n(body.max_per_day, 0, 50, cur.max_per_day),
    gap_min: n(body.gap_min, 0, 600, cur.gap_min),
    hours_from: hm(body.hours_from, cur.hours_from),
    hours_to: hm(body.hours_to, cur.hours_to),
    tags: String(body.tags ?? cur.tags).slice(0, 300),
  };
  await db.updateSettings({ pin: next });
  return { ok: true, message: '💾 Saqlandi', cfg: next };
}

export async function pinClear() {
  await r().del(Q());
  return { ok: true, message: '🧹 Pinterest navbati tozalandi' };
}
