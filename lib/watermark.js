// "🖼 Logo": a semi-transparent watermark in a corner of the photos that go to channels (and, with its
// own switch, to stories). The default is "MIX PODAROK" (lib/watermark-default.js); the admin can upload
// a PNG logo ("🖼 Logo yuklash", up to 500 KB, kept in Redis as base64).
//
// settings: wm_on (channel / group posts), wm_story (stories), wm_pos 'br' | 'bl' | 'tr' | 'tl',
// wm_opacity 30-80 (%). Any error while downloading / drawing -> the original photo is sent.

import * as db from './store.js';
import { downloadImage } from './story.js';
import { tg } from './telegram.js';
import { errText } from './util.js';
import { DEFAULT_WATERMARK_PNG } from './watermark-default.js';

export const LOGO_MAX_BYTES = 500 * 1024;
export const POSITIONS = ['br', 'bl', 'tl', 'tr'];
export const POS_LABEL = { br: '↘️ pastki o\'ng', bl: '↙️ pastki chap', tl: '↖️ yuqori chap', tr: '↗️ yuqori o\'ng' };
export const OPACITIES = [30, 40, 50, 60, 70, 80];
const WIDTH_SHARE = 0.18; // the mark's width: ~18% of the photo
const MARGIN_SHARE = 0.03;
const MAX_SIDE = 2560;
const LOGO_KEY = () => `${db.K.flag('wm')}:logo`;

let sharpLib = null;
const loadSharp = async () => (sharpLib ||= (await import('sharp')).default);

export const opacityOf = (s) => {
  const v = Math.round(Number(s?.wm_opacity));
  return Number.isFinite(v) ? Math.min(80, Math.max(30, v)) : 50;
};
export const positionOf = (s) => (POSITIONS.includes(s?.wm_pos) ? s.wm_pos : 'br');

// ---- the logo ----

export async function getLogo() {
  if (!db.hasRedis()) return null;
  const b64 = await db.redis().get(LOGO_KEY()).catch(() => null);
  return b64 ? Buffer.from(String(b64), 'base64') : null;
}

// Checks and keeps an uploaded logo (PNG / JPEG / WebP, at most 500 KB). Returns an error text or null.
export async function saveLogo(bytes) {
  if (!bytes?.length) return "Fayl bo'sh.";
  if (bytes.length > LOGO_MAX_BYTES) return `Logo juda katta (${Math.round(bytes.length / 1024)} KB) — ko'pi bilan 500 KB.`;
  try {
    const meta = await (await loadSharp())(bytes).metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format)) return 'PNG (shaffof fonli) rasm yuboring.';
  } catch {
    return "Rasmni o'qib bo'lmadi — PNG yuboring.";
  }
  await db.redis().set(LOGO_KEY(), bytes.toString('base64'));
  return null;
}

export const dropLogo = () => db.redis().del(LOGO_KEY());

// ---- drawing ----

// The photo with the mark, as JPEG. Throws on any problem (the caller sends the original).
export async function applyWatermark(input, s) {
  const sharp = await loadSharp();
  const img = sharp(input).rotate().resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true });
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const logo = (await getLogo()) || Buffer.from(DEFAULT_WATERMARK_PNG, 'base64');
  const markW = Math.max(40, Math.round(W * WIDTH_SHARE));
  const alpha = Math.round((255 * opacityOf(s)) / 100);
  // scale, then multiply the logo's own alpha by the chosen opacity
  let mark = await sharp(logo)
    .resize({ width: markW, withoutEnlargement: false })
    .ensureAlpha()
    .composite([{ input: Buffer.from([255, 255, 255, alpha]), raw: { width: 1, height: 1, channels: 4 }, tile: true, blend: 'dest-in' }])
    .png()
    .toBuffer();
  let meta = await sharp(mark).metadata();
  if (meta.height > H * 0.5) {
    mark = await sharp(mark).resize({ height: Math.round(H * 0.5) }).png().toBuffer();
    meta = await sharp(mark).metadata();
  }
  const m = Math.round(Math.min(W, H) * MARGIN_SHARE);
  const pos = positionOf(s);
  const left = pos.endsWith('r') ? W - meta.width - m : m;
  const top = pos.startsWith('b') ? H - meta.height - m : m;
  return sharp(data)
    .composite([{ input: mark, left: Math.max(0, left), top: Math.max(0, top) }])
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

// The bytes of a photo given as a URL or a Telegram file_id.
async function photoBytes(photo) {
  if (/^https?:\/\//.test(String(photo))) return downloadImage(photo);
  const f = await tg('getFile', { file_id: photo });
  return downloadImage(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${f.file_path}`);
}

// Marked photos already uploaded in this run (the same photo to several channels is drawn once).
const uploaded = new Map();
const markKey = (photo, s) => `${photo}|${positionOf(s)}|${opacityOf(s)}`;

// sendPhoto with the watermark when "🖼 Logo" is on (payload: the usual sendPhoto fields; photo = URL
// or file_id). Drawing fails -> the original photo. Returns the sent message.
export async function sendPhotoMarked(payload, s, { deadline } = {}) {
  if (!s?.wm_on || !payload.photo) return tg('sendPhoto', payload, { deadline });
  const key = markKey(payload.photo, s);
  const known = uploaded.get(key);
  if (known) return tg('sendPhoto', { ...payload, photo: known }, { deadline });
  let jpeg = null;
  try {
    jpeg = await applyWatermark(await photoBytes(payload.photo), s);
  } catch (e) {
    console.error(`watermark: ${errText(e)} — sending the original photo`);
    return tg('sendPhoto', payload, { deadline });
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(payload)) {
    if (k === 'photo' || v === undefined || v === null) continue;
    form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  form.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'photo.jpg');
  const msg = await tg('sendPhoto', form, { deadline });
  const id = msg?.photo?.length ? msg.photo[msg.photo.length - 1].file_id : null;
  if (id) {
    if (uploaded.size > 200) uploaded.clear();
    uploaded.set(key, id);
  }
  return msg;
}

// Story photos (bytes): marked when "🖼 Logo → istoriya" is on; on error the original.
export async function markStoryBytes(bytes, s) {
  if (!s?.wm_story) return bytes;
  try {
    return await applyWatermark(bytes, s);
  } catch (e) {
    console.error(`story watermark: ${errText(e)} — original photo`);
    return bytes;
  }
}
