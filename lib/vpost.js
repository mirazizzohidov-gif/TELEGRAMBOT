// "🎬 Video joylash": the owner uploads one video on the dashboard (straight to Vercel Blob, original
// file, no re-encoding) and it goes to every network switched on: Instagram Reels (a / b), Facebook Reels,
// YouTube Shorts, TikTok, Threads and the Telegram channel(s). Runs in the background (api/vpost.js),
// one network after another, each with its own status; the file is removed from Blob afterwards.
import { fbPostVideo, fbView } from './facebook.js';
import { igCall, SLOTS, tokenOf } from './ig.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { thPostVideo, thView } from './threads.js';
import { ttCfg, ttUpload, ttView } from './tiktok.js';
import { errText, fetchWithTimeout } from './util.js';
import { ytCfg, ytUpload, ytView } from './youtube.js';

const F = (x) => db.K.flag(`vpost:${x}`);
const LIST = () => F('list'); // newest first, job ids
const JOB = (id) => F(`job:${id}`);
const LOOP = 'vpost';
const KEEP = 30 * 86400; // job record
const KEEP_FAILED_BLOB = 6 * 3600; // a failed network can be retried for 6 h, then the file is removed
const MB = 1024 * 1024;
export const VPOST_MAX = 500 * MB;

const r = () => db.redis();
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

export const VPOST_NETS = {
  ig_a: '📸 Instagram Reels (1-akkaunt)',
  ig_b: '📸 Instagram Reels (2-akkaunt)',
  fb: '📘 Facebook Reels',
  yt: '▶️ YouTube Shorts',
  tt: '🎵 TikTok',
  th: '🧵 Threads',
  tg: '✈️ Telegram kanal',
};

const blobOk = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /\.blob\.vercel-storage\.com$/.test(u.hostname);
  } catch {
    return false;
  }
};

async function blobDel(url) {
  if (!url || !blobOk(url)) return;
  const { del } = await import('@vercel/blob');
  await del(url);
}

// which networks can take a video now
export async function vpostNets(s) {
  const out = [];
  for (const slot of SLOTS) {
    const t = await tokenOf(slot).catch(() => null);
    out.push({ id: `ig_${slot}`, label: t?.username ? `📸 Instagram Reels — @${t.username}` : VPOST_NETS[`ig_${slot}`], connected: Boolean(t?.token), note: '15 daqiqagacha · 9:16 tavsiya' });
  }
  const [fb, yt, tt, th] = await Promise.all([fbView(s).catch(() => null), ytView(s).catch(() => null), ttView(s).catch(() => null), thView(s).catch(() => null)]);
  out.push({ id: 'fb', label: VPOST_NETS.fb, connected: Boolean(fb?.connected), note: '3–90 soniya Reels' });
  out.push({ id: 'yt', label: VPOST_NETS.yt, connected: Boolean(yt?.connected), note: `${ytCfg(s).privacy === 'public' ? 'ochiq' : ytCfg(s).privacy} · 3 daqiqagacha Shorts` });
  out.push({ id: 'tt', label: VPOST_NETS.tt, connected: Boolean(tt?.connected), note: ttCfg(s).mode === 'direct' ? "to'g'ridan-to'g'ri" : 'qoralama (TikTok ilovasida tasdiqlanadi)' });
  out.push({ id: 'th', label: VPOST_NETS.th, connected: Boolean(th?.connected), note: '5 daqiqagacha' });
  const ch = (s?.channels || []).filter((c) => c.active);
  out.push({ id: 'tg', label: VPOST_NETS.tg, connected: ch.length > 0, note: '50 MB gacha (Telegram bot cheklovi)' });
  return out;
}

// ---- jobs ----

const getJob = (id) => r().get(JOB(id));
const saveJob = (j) => r().set(JOB(j.id), j, { ex: KEEP });

async function setTarget(j, k, patch) {
  j.targets[k] = { ...j.targets[k], ...patch, at: Date.now() };
  await saveJob(j);
}

export async function vpostStart(body = {}, s) {
  const url = String(body.url || '');
  if (!blobOk(url)) return { ok: false, message: 'Video yuklanmadi (manzil noto\'g\'ri)' };
  const size = Number(body.size) || 0;
  if (size > VPOST_MAX) return { ok: false, message: 'Video 500 MB dan katta' };
  const nets = await vpostNets(s);
  const want = [...new Set((Array.isArray(body.targets) ? body.targets : []).map(String))].filter((k) => VPOST_NETS[k]);
  const targets = {};
  for (const k of want) {
    const n = nets.find((x) => x.id === k);
    if (!n?.connected) targets[k] = { st: 'skip', msg: 'ulanmagan' };
    else if (k === 'tg' && size > 50 * MB) targets[k] = { st: 'skip', msg: 'Telegram: 50 MB dan katta' };
    else targets[k] = { st: 'wait' };
  }
  if (!Object.values(targets).some((t) => t.st === 'wait')) {
    await blobDel(url).catch(() => {});
    return { ok: false, message: 'Hech bir tarmoq tanlanmagan yoki ulanmagan' };
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const j = {
    id,
    url,
    size,
    name: String(body.name || 'video.mp4').slice(0, 120),
    caption: String(body.caption || '').slice(0, 2200),
    title: String(body.title || '').trim().slice(0, 100),
    targets,
    created: Date.now(),
    done: false,
  };
  await saveJob(j);
  await r().lpush(LIST(), id);
  await r().ltrim(LIST(), 0, 19);
  await kickVpost().catch((e) => console.error(`vpost kick: ${errText(e)}`));
  return { ok: true, id, message: '🚀 Joylash boshlandi — har tarmoq holati quyida' };
}

export async function vpostCancel(id) {
  const j = await getJob(String(id || ''));
  if (!j) return { ok: false, message: 'Topilmadi' };
  for (const [k, t] of Object.entries(j.targets)) if (t.st === 'wait') j.targets[k] = { st: 'skip', msg: 'bekor qilindi', at: Date.now() };
  if (finished(j) && !j.done) await finish(j);
  else await saveJob(j);
  return { ok: true, message: '⏹ Qolganlari bekor qilindi' };
}

export async function vpostRetry(id, k) {
  const j = await getJob(String(id || ''));
  if (!j?.targets?.[k]) return { ok: false, message: 'Topilmadi' };
  if (j.deleted) return { ok: false, message: "Video allaqachon o'chirilgan — qaytadan yuklang" };
  if (j.targets[k].st !== 'err') return { ok: false, message: 'Faqat xato bo\'lganini qayta urinish mumkin' };
  j.targets[k] = { st: 'wait', tries: j.targets[k].tries || 0, at: Date.now() };
  j.done = false;
  await saveJob(j);
  await kickVpost().catch(() => {});
  return { ok: true, message: '🔁 Qayta urinilmoqda' };
}

export async function vpostView(s, { nets = true } = {}) {
  const ids = (await r().lrange(LIST(), 0, 9).catch(() => [])) || [];
  const jobs = (await Promise.all(ids.map((id) => getJob(id).catch(() => null)))).filter(Boolean).map((j) => ({ ...j, url: undefined }));
  return { ok: true, max_mb: VPOST_MAX / MB, labels: VPOST_NETS, nets: nets ? await vpostNets(s) : undefined, jobs };
}

// ---- publishing ----

function caption(j) {
  return j.caption || j.title || '';
}

async function postIg(j, slot) {
  const t = await tokenOf(slot);
  if (!t?.token) throw new Error('Akkaunt ulanmagan');
  const c = await igCall('POST', `/${t.user_id}/media`, { media_type: 'REELS', video_url: j.url, caption: caption(j).slice(0, 2200), share_to_feed: true, access_token: t.token }, 60000);
  for (let i = 0; ; i++) {
    await sleep(6000);
    const st = await igCall('GET', `/${c.id}`, { fields: 'status_code,status', access_token: t.token }).catch(() => null);
    if (st?.status_code === 'FINISHED') break;
    if (st?.status_code === 'ERROR' || st?.status_code === 'EXPIRED') throw new Error(`Instagram videoni qabul qilmadi: ${st.status || st.status_code}`);
    if (i > 40) throw new Error('Instagram videoni tayyorlab ulgurmadi');
  }
  const p = await igCall('POST', `/${t.user_id}/media_publish`, { creation_id: c.id, access_token: t.token }, 40000);
  await db.incrStat(`ig_reel:${slot}`).catch(() => {});
  const m = await igCall('GET', `/${p.id}`, { fields: 'permalink', access_token: t.token }).catch(() => null);
  return { id: p.id, link: m?.permalink || '' };
}

let buf = null; // the file, downloaded once per run (YouTube / TikTok / big Telegram)
async function file(j) {
  if (buf?.id === j.id) return buf.data;
  const res = await fetchWithTimeout(j.url, {}, 180000);
  if (!res.ok) throw new Error(`Video o'qilmadi: HTTP ${res.status}`);
  buf = { id: j.id, data: Buffer.from(await res.arrayBuffer()) };
  return buf.data;
}

async function postTg(j, s) {
  const ch = (s?.channels || []).filter((c) => c.active);
  if (!ch.length) throw new Error('Kanal yo\'q');
  const cap = caption(j).slice(0, 1024);
  let ok = 0;
  let last = null;
  for (const c of ch) {
    try {
      if (j.size && j.size <= 20 * MB) {
        await tg('sendVideo', { chat_id: c.id, video: j.url, caption: cap, supports_streaming: true });
      } else {
        const form = new FormData();
        form.append('chat_id', String(c.id));
        form.append('caption', cap);
        form.append('supports_streaming', 'true');
        form.append('video', new Blob([await file(j)], { type: 'video/mp4' }), j.name.replace(/[^\w.-]+/g, '_') || 'video.mp4');
        await tg('sendVideo', form);
      }
      ok++;
    } catch (e) {
      last = e;
    }
  }
  if (!ok) throw last || new Error('Telegram xato');
  await db.incrStat('posted').catch(() => {});
  return { link: '' };
}

async function runTarget(j, k, s) {
  if (k.startsWith('ig_')) return postIg(j, k.slice(3));
  if (k === 'fb') {
    const id = await fbPostVideo(j.url, caption(j));
    return { id, link: id ? `https://www.facebook.com/reel/${id}` : '' };
  }
  if (k === 'th') return { id: await thPostVideo(j.url, caption(j)), link: '' };
  if (k === 'yt') {
    const cap = caption(j);
    const tags = (cap.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1)).slice(0, 15);
    const title = (j.title || cap.split('\n').find((l) => l.trim()) || j.name.replace(/\.\w+$/, '')).replace(/[<>]/g, '').slice(0, 95);
    const id = await ytUpload(await file(j), { title: /#shorts/i.test(title) ? title : `${title.slice(0, 87)} #Shorts`, description: cap.replace(/[<>]/g, '').slice(0, 4900), tags, privacy: ytCfg(s).privacy });
    await db.incrStat('yt_uploaded').catch(() => {});
    return { id, link: `https://youtube.com/shorts/${id}` };
  }
  if (k === 'tt') {
    const id = await ttUpload(await file(j), { mode: ttCfg(s).mode, caption: caption(j).slice(0, 2000) });
    await db.incrStat('tt_uploaded').catch(() => {});
    return { id, link: '' };
  }
  if (k === 'tg') return postTg(j, s);
  throw new Error("Noma'lum tarmoq");
}

const finished = (j) => Object.values(j.targets).every((t) => t.st !== 'wait' && t.st !== 'run');

async function finish(j) {
  j.done = true;
  j.finished = Date.now();
  const failed = Object.values(j.targets).some((t) => t.st === 'err');
  if (!failed) {
    await blobDel(j.url).catch((e) => console.error(`vpost del: ${errText(e)}`));
    j.deleted = true;
  } else {
    j.delete_at = Date.now() + KEEP_FAILED_BLOB * 1000;
  }
  await saveJob(j);
}

// one background pass: every waiting network of every job, until the budget runs out
export async function vpostRun({ budget = 250000 } = {}) {
  if (!db.hasRedis()) return { skipped: 'no redis' };
  if (!(await db.lock(LOOP, 320))) return { skipped: 'running' };
  const start = Date.now();
  let more = false;
  let done = 0;
  try {
    const s = await db.getSettings();
    const ids = (await r().lrange(LIST(), 0, 19).catch(() => [])) || [];
    for (const id of [...ids].reverse()) {
      const j = await getJob(id);
      if (!j || j.done) continue;
      for (const [k, t] of Object.entries(j.targets)) {
        // a run that died half-way (timeout): try once more, then give up
        if (t.st === 'run' && Date.now() - (t.at || 0) > 6 * 60000) {
          if ((t.tries || 0) >= 2) await setTarget(j, k, { st: 'err', msg: 'vaqt tugadi' });
          else await setTarget(j, k, { st: 'wait' });
        }
        if (j.targets[k].st !== 'wait') continue;
        if (Date.now() - start > budget - 100000) {
          more = true;
          break;
        }
        await setTarget(j, k, { st: 'run', tries: (t.tries || 0) + 1, msg: '' });
        try {
          const out = await runTarget(j, k, s);
          await setTarget(j, k, { st: 'ok', msg: '', id: out?.id || '', link: out?.link || '' });
          done++;
        } catch (e) {
          console.error(`vpost ${k}: ${errText(e)}`);
          await setTarget(j, k, { st: 'err', msg: errText(e).slice(0, 300) });
        }
      }
      if (finished(j) && !j.done) await finish(j);
      if (more) break;
    }
  } finally {
    buf = null;
    await db.unlock(LOOP).catch(() => {});
  }
  if (more) await kickVpost().catch(() => {});
  return { done, more };
}

export function vpostUrl() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
  return host ? `${/^https?:\/\//i.test(host) ? host : `https://${host}`}/api/vpost` : '';
}

export async function kickVpost() {
  const url = vpostUrl();
  const headers = {};
  if (process.env.CRON_SECRET) headers.Authorization = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.SECRET) headers['x-secret'] = process.env.SECRET;
  if (!url || !Object.keys(headers).length) return { skipped: 'no kick' };
  const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(20000) });
  return { status: res.status };
}

// from the tick: restart a lost run, remove files of finished jobs after the retry window
export async function vpostTick() {
  if (!db.hasRedis()) return null;
  const ids = (await r().lrange(LIST(), 0, 19).catch(() => [])) || [];
  let pending = false;
  for (const id of ids) {
    const j = await getJob(id).catch(() => null);
    if (!j) continue;
    if (!j.done) pending = true;
    if (j.done && !j.deleted && j.delete_at && Date.now() > j.delete_at) {
      await blobDel(j.url).catch(() => {});
      j.deleted = true;
      await saveJob(j);
    }
  }
  if (pending) await kickVpost().catch(() => {});
  return { pending };
}
