// O'z serverimizdagi fayllar (Vercel Blob o'rniga): videolar /opt/mixbot/data/media da turadi va
// https://<PUBLIC_HOST>/media/<yo'l> orqali beriladi (server.js). SELF_HOSTED bo'lmasa ishlatilmaydi.
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';

export const selfHosted = () => process.env.SELF_HOSTED === '1' && Boolean(process.env.PUBLIC_HOST);
export const MEDIA_DIR = process.env.MEDIA_DIR || join(process.cwd(), 'data', 'media');

const clean = (rel) => String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');

export function mediaFile(rel) {
  const p = normalize(join(MEDIA_DIR, clean(rel)));
  if (!p.startsWith(MEDIA_DIR + sep)) throw new Error('bad media path');
  return p;
}

export const mediaUrl = (rel) => `https://${process.env.PUBLIC_HOST}/media/${clean(rel).split('/').map(encodeURIComponent).join('/')}`;

// our own /media/ URL -> relative path (or null)
export function mediaRel(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.hostname !== process.env.PUBLIC_HOST || !u.pathname.startsWith('/media/')) return null;
    return decodeURIComponent(u.pathname.slice('/media/'.length));
  } catch {
    return null;
  }
}
export const isMediaUrl = (url) => selfHosted() && mediaRel(url) !== null;

export function putMedia(rel, buf) {
  const p = mediaFile(rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, buf);
  return mediaUrl(rel);
}

export function readMedia(rel) {
  const p = mediaFile(rel);
  return existsSync(p) ? readFileSync(p) : null;
}

export function delMediaUrl(url) {
  const rel = mediaRel(url);
  if (rel === null) return false;
  const p = mediaFile(rel);
  if (existsSync(p)) unlinkSync(p);
  return true;
}

// stream an upload (req body) into a file; rejects if larger than max
export function streamToMedia(req, rel, max) {
  const p = mediaFile(rel);
  mkdirSync(dirname(p), { recursive: true });
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = createWriteStream(p);
    const fail = (e) => {
      out.destroy();
      try {
        unlinkSync(p);
      } catch {}
      reject(e);
    };
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        req.destroy();
        fail(new Error('too large'));
      }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => resolve({ url: mediaUrl(rel), size }));
    req.pipe(out);
  });
}

// remove files under a folder older than ms
export function cleanMedia(prefix, ms) {
  const dir = mediaFile(prefix);
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    try {
      const st = statSync(p);
      if (st.isFile() && Date.now() - st.mtimeMs > ms) {
        unlinkSync(p);
        n++;
      }
    } catch {}
  }
  return n;
}

// Navbatdagi eski havolalar (Vercel davrida yozilgan: telegrambot-cic8.vercel.app/api/igvid…) —
// o'z serverimizga yo'naltiriladi (imzo o'sha SECRET bilan, shuning uchun ishlaydi).
export function ownUrl(url) {
  if (!selfHosted()) return url;
  try {
    const u = new URL(url);
    if (u.hostname !== process.env.PUBLIC_HOST && /^\/(api\/igvid|api\/igimg|media\/)/.test(u.pathname) && /vercel\.app$/.test(u.hostname)) {
      u.protocol = 'https:';
      u.host = process.env.PUBLIC_HOST;
      return u.toString();
    }
  } catch {}
  return url;
}
