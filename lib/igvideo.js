// "🎬 Reels": an 8-10 second 720x1280 video of one product, made with ffmpeg, in one of 5 styles (STYLES
// below, chosen at random for every Reel): the photo moves (zoom / slide / blur background / card), the
// shop name, a "CHEGIRMA! / YANGI / YANA SOTUVDA" tag, the name, the price (old one struck out) and the
// phone fade in; background music (a track from "🎵 Musiqa", lib/ig.js) fades in and out.
// ffmpeg: FFMPEG_PATH, else the ffmpeg-static package, else "ffmpeg" on the PATH. Fonts: assets/fonts
// (DejaVu, free licence) — the server has no fonts of its own.

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatPrice } from './bito.js';

const W = 720;
const H = 1280;
const FPS = 25;
export const REEL_SEC = 8;
const FONT_DIR = fileURLToPath(new URL('../assets/fonts/', import.meta.url));
const BOLD = join(FONT_DIR, 'DejaVuSans-Bold.ttf');
const REG = join(FONT_DIR, 'DejaVuSans.ttf');

let ffmpegPath = null;
async function ffmpeg() {
  if (ffmpegPath) return ffmpegPath;
  if (process.env.FFMPEG_PATH) return (ffmpegPath = process.env.FFMPEG_PATH);
  try {
    const m = await import('ffmpeg-static');
    if (m.default) {
      // the bundled binary may lose its "executable" bit: a copy in /tmp is made runnable
      try {
        await access(m.default, constants.X_OK);
        return (ffmpegPath = m.default);
      } catch {
        const tmp = join(tmpdir(), 'ffmpeg-bin');
        await copyFile(m.default, tmp).catch(() => {});
        await chmod(tmp, 0o755);
        return (ffmpegPath = tmp);
      }
    }
  } catch {}
  return (ffmpegPath = 'ffmpeg');
}

function run(bin, args, ms = 60000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-3000);
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), ms);
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg ${code}: ${err.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
    });
  });
}

// "/api/igvid?check=1": is ffmpeg there? (no secrets: the version line and whether a test frame renders)
export async function ffmpegCheck() {
  const bin = await ffmpeg();
  const out = { bin: bin.replace(/^.*\/node_modules\//, 'node_modules/') };
  const dir = await mkdtemp(join(tmpdir(), 'ffchk-'));
  try {
    const filters = await new Promise((resolve) => {
      const p = spawn(bin, ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let t = '';
      p.stdout.on('data', (d) => (t += d));
      p.on('close', () => resolve(t));
      p.on('error', () => resolve(''));
    });
    out.filters = ['drawtext', 'subtitles', 'ass', 'zoompan', 'overlay', 'fade', 'afade', 'scale'].filter((f) => new RegExp(`\\s${f}\\s`).test(filters));
    await run(bin, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=white:s=64x64:d=0.2', '-c:v', 'libx264', join(dir, 'c.mp4')], 20000);
    out.x264 = true;
  } catch (e) {
    out.error = String(e.message || e).slice(0, 200);
  }
  try {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ text: { text: '<span foreground="#E91E63">Oʻzbek 185 000 soʻm</span>', fontfile: BOLD, font: 'DejaVu Sans Bold 40', rgba: true, dpi: 72 } }).png().toBuffer({ resolveWithObject: true });
    out.sharpText = `${png.info.width}x${png.info.height}`;
  } catch (e) {
    out.sharpText = `error: ${String(e.message || e).slice(0, 160)}`;
  }
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  out.ok = Boolean(out.x264);
  return out;
}

// "Juda uzun mahsulot nomi ..." -> at most `max` lines of about `width` characters
export function wrap(text, width = 24, max = 2) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= width) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > max) {
    const keep = lines.slice(0, max);
    keep[max - 1] = keep[max - 1].length > width - 1 ? `${keep[max - 1].slice(0, width - 1)}…` : `${keep[max - 1]}…`;
    return keep;
  }
  return lines.map((l) => (l.length > width + 6 ? `${l.slice(0, width + 5)}…` : l));
}

// ---- styles: every Reel looks different ----
// 5 layouts × colour palettes × opening ("hook") phrases × 8-10 s length. The style is chosen when the
// video link is made (lib/ig.js igVideoUrl: `st`, `pl`, `hk`, `sec`), so the warm-up and Instagram's
// download get the same video. What helps reach: a big hook in the first second, motion all the time,
// short (8-10 s, watched to the end and looped), music, the text inside the safe zone (not under the
// buttons on the right / caption at the bottom).
export const STYLES = ['classic', 'blur', 'card', 'pan', 'hook'];
const PALETTES = [
  { bg: '#E91E63', accent: '#FFD54F', fg: '#FFFFFF' },
  { bg: '#1F1B2E', accent: '#FF4F9A', fg: '#FFFFFF' },
  { bg: '#FFF1F5', accent: '#E91E63', fg: '#222222' },
  { bg: '#0E7C66', accent: '#FFE082', fg: '#FFFFFF' },
  { bg: '#5B2BC8', accent: '#FFD1EC', fg: '#FFFFFF' },
  { bg: '#FF7A00', accent: '#FFFFFF', fg: '#FFFFFF' },
];
const HOOKS = {
  discount: ['CHEGIRMA!', 'NARX TUSHDI!', 'SHOSHILING!', 'ARZONLASHDI!'],
  restock: ['YANA SOTUVDA!', 'QAYTA KELDI!', 'KUTGANLAR UCHUN!'],
  new: ['YANGI KELDI!', 'YANGI MAHSULOT', 'BUNI KO‘RDINGIZMI?'],
  other: ['SOVG‘A G‘OYASI', 'ENG ZO‘R SOVG‘A', 'BUNI KO‘RDINGIZMI?', 'SOVG‘A QIDIRYAPSIZMI?'],
};
const TAG = { discount: 'CHEGIRMA!', restock: 'YANA SOTUVDA', new: 'YANGI MAHSULOT' };
const PINK = '#E91E63';
const xml = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// a random look for one Reel (lib/ig.js puts it into the video link)
export function pickLook() {
  const r = (n) => Math.floor(Math.random() * n);
  return { st: STYLES[r(STYLES.length)], pl: r(PALETTES.length), hk: r(4), sec: 8 + r(3) };
}

// One line of text as a transparent PNG (sharp + Pango with the bundled font: no system fonts needed).
async function textPng(sharp, text, { size = 40, color = '#222222', bold = true } = {}) {
  const { data, info } = await sharp({
    text: { text: `<span foreground="${color}">${xml(text)}</span>`, fontfile: bold ? BOLD : REG, font: `DejaVu Sans${bold ? ' Bold' : ''} ${size}`, rgba: true, dpi: 96 },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}
const box = (sharp, w, h, color) => sharp({ create: { width: Math.max(1, w), height: Math.max(1, h), channels: 4, background: color } }).png().toBuffer();
const rounded = (sharp, w, h, r, color) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${color}"/></svg>`)).png().toBuffer();
// a vertical shade: transparent at the top -> dark at the bottom (text on photos stays readable)
const shade = (sharp, w, h, from = 0, to = 0.85) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="${from}"/><stop offset="1" stop-color="#000" stop-opacity="${to}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`)).png().toBuffer();
const canvasOf = (sharp, parts) => sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(parts).png().toBuffer();

// texts: top (brand + tag), middle (name + price), bottom (phone) — positions / colours by style
async function textLayers(item, { phone, brand, price, look }) {
  const sharp = (await import('sharp')).default;
  const pal = PALETTES[look.pl % PALETTES.length];
  const light = look.st === 'classic' || (look.st === 'card' && pal.fg !== '#FFFFFF');
  const ink = light ? '#222222' : '#FFFFFF';
  const accent = light ? PINK : pal.accent;
  const center = (t, top) => ({ input: t.input, left: Math.max(0, Math.round((W - t.width) / 2)), top: Math.round(top) });
  // 1: brand + tag
  const top = [];
  if (brand) top.push(center(await textPng(sharp, String(brand).toUpperCase().slice(0, 30), { size: 30, color: accent }), 70));
  const tag = TAG[item.kind];
  if (tag) {
    const t = await textPng(sharp, tag, { size: 25, color: light ? '#FFFFFF' : '#222222' });
    const bw = t.width + 40;
    const bh = t.height + 20;
    top.push({ input: await rounded(sharp, bw, bh, Math.round(bh / 2), light ? PINK : accent), left: Math.round((W - bw) / 2), top: 140 });
    top.push({ input: t.input, left: Math.round((W - t.width) / 2), top: 150 });
  }
  // 2: name, old price (struck out), price — above the bottom 250 px (Instagram's caption area)
  const lines = wrap(item.name, 24, 2);
  const nameTs = [];
  for (const l of lines) nameTs.push(await textPng(sharp, l, { size: 30, color: ink }));
  const priceOn = price && Number(item.price) > 0;
  const oldOn = priceOn && Number(item.old_price) > Number(item.price);
  const oldT = oldOn ? await textPng(sharp, `${formatPrice(item.old_price)} so'm`, { size: 25, color: light ? '#888888' : '#DDDDDD', bold: false }) : null;
  const priceT = priceOn ? await textPng(sharp, `${formatPrice(item.price)} so'm`, { size: 52, color: accent }) : await textPng(sharp, "Narxini Direct'da so'rang", { size: 29, color: accent });
  const blockH = nameTs.reduce((n, t) => n + t.height + 8, 0) + 14 + (oldT ? oldT.height + 8 : 0) + priceT.height;
  let y = look.st === 'classic' ? 870 : look.st === 'card' ? 830 : 1010 - blockH;
  const mid = [];
  if (!light && look.st !== 'card') {
    // a soft dark plate behind the texts on a photo
    const pw = Math.max(...nameTs.map((t) => t.width), priceT.width, oldT?.width || 0) + 70;
    mid.push({ input: await rounded(sharp, Math.min(W - 40, pw), blockH + 50, 28, 'rgba(0,0,0,0.45)'), left: Math.round((W - Math.min(W - 40, pw)) / 2), top: Math.round(y - 25) });
  }
  for (const t of nameTs) {
    mid.push(center(t, y));
    y += t.height + 8;
  }
  y += 14;
  if (oldT) {
    mid.push(center(oldT, y));
    mid.push({ input: await box(sharp, oldT.width + 8, 3, light ? '#888888' : '#DDDDDD'), left: Math.round((W - oldT.width - 8) / 2), top: Math.round(y + oldT.height / 2) });
    y += oldT.height + 8;
  }
  mid.push(center(priceT, y));
  // 3: phone on a bar
  const bot = [];
  if (phone) {
    const t = await textPng(sharp, `Buyurtma: ${phone}`, { size: 25, color: '#FFFFFF' });
    const bw = t.width + 44;
    const bh = t.height + 28;
    bot.push({ input: await rounded(sharp, bw, bh, Math.round(bh / 2), light || look.st === 'card' ? '#222222' : PINK), left: Math.round((W - bw) / 2), top: 1080 });
    bot.push({ input: t.input, left: Math.round((W - t.width) / 2), top: 1094 });
  }
  return Promise.all([canvasOf(sharp, top), canvasOf(sharp, mid), canvasOf(sharp, bot)]);
}

// style-only pictures: the card frame, the shade, the opening "hook" screen
async function styleLayers(item, look, img) {
  const sharp = (await import('sharp')).default;
  const pal = PALETTES[look.pl % PALETTES.length];
  const out = {};
  if (look.st === 'card') {
    // the photo on a white rounded card (it slides up from below)
    const ph = await sharp(img).rotate().resize(500, 540, { fit: 'contain', background: '#FFFFFF' }).flatten({ background: '#FFFFFF' }).png().toBuffer();
    const card = await sharp(await rounded(sharp, 560, 600, 40, '#FFFFFF')).composite([{ input: ph, left: 30, top: 30 }]).png().toBuffer();
    out.card = card;
    out.bg = pal.bg;
  }
  if (look.st === 'pan' || look.st === 'blur' || look.st === 'hook') out.shade = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: await shade(sharp, W, 640, 0, 0.75), left: 0, top: H - 640 }, { input: await shade(sharp, W, 260, 0.45, 0), left: 0, top: 0 }]).png().toBuffer();
  if (look.st === 'hook') {
    const pool = HOOKS[item.kind] || HOOKS.other;
    const text = pool[look.hk % pool.length];
    const parts = [];
    let y = 520;
    for (const l of wrap(text, 14, 2)) {
      const t = await textPng(sharp, l, { size: 66, color: pal.fg });
      parts.push({ input: t.input, left: Math.round((W - t.width) / 2), top: y });
      y += t.height + 12;
    }
    const sub = await textPng(sharp, item.kind === 'discount' && Number(item.old_price) > Number(item.price) ? `-${Math.round((1 - Number(item.price) / Number(item.old_price)) * 100)}%` : '▼', { size: 44, color: pal.accent });
    parts.push({ input: sub.input, left: Math.round((W - sub.width) / 2), top: y + 20 });
    out.hook = await sharp({ create: { width: W, height: H, channels: 4, background: pal.bg } }).composite(parts).png().toBuffer();
  }
  return out;
}

// item: { name, price, old_price, image_url, kind: 'discount' | 'restock' | 'new' | 'other' }
// opts: { phone, brand, price (show the price), music (Buffer), image (Buffer instead of the URL),
//         look: { st, pl, hk, sec } (lib/ig.js; missing -> chosen now) }
export async function buildReel(item, { phone = '', brand = 'MIX PODAROK', price = true, music = null, image = null, look = null } = {}) {
  const lk = { ...pickLook(), ...(look || {}) };
  if (!STYLES.includes(lk.st)) lk.st = 'classic';
  const SEC = Math.min(12, Math.max(6, Number(lk.sec) || REEL_SEC));
  const dir = await mkdtemp(join(tmpdir(), 'reel-'));
  try {
    const img = image || Buffer.from(await (await fetch(item.image_url, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
    await writeFile(join(dir, 'p.img'), img);
    const [l1, l2, l3] = await textLayers(item, { phone, brand, price, look: lk });
    const sty = await styleLayers(item, lk, img);
    const files = { l1, l2, l3, ...Object.fromEntries(Object.entries(sty).filter(([, v]) => Buffer.isBuffer(v))) };
    for (const [k, v] of Object.entries(files)) await writeFile(join(dir, `${k}.png`), v);
    const frames = SEC * FPS;
    const inputs = ['p.img', 'l1.png', 'l2.png', 'l3.png', ...Object.keys(files).filter((k) => !/^l\d$/.test(k)).map((k) => `${k}.png`)];
    const ix = Object.fromEntries(inputs.map((f, i) => [f.replace(/\.\w+$/, ''), i]));
    const args = ['-y', '-loglevel', 'error'];
    for (const f of inputs) args.push('-loop', '1', '-framerate', String(FPS), '-t', String(SEC), '-i', join(dir, f));
    const zoom = (src, dst, amount = 0.08) =>
      `${src}scale=${W * 2}:${H * 2},zoompan=z='1+${amount}*on/${frames}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}${dst}`;
    let base;
    const hookEnd = lk.st === 'hook' ? 1.3 : 0;
    if (lk.st === 'classic') {
      base =
        `color=c=white:s=${W}x${H}:r=${FPS}:d=${SEC}[bg];[0:v]scale=600:600:force_original_aspect_ratio=decrease,format=rgba[p];` +
        `[bg][p]overlay=x=(W-w)/2:y=240+(600-h)/2:shortest=1[b0];` + zoom('[b0]', '[z]', 0.06);
    } else if (lk.st === 'blur' || lk.st === 'hook') {
      base =
        `[0:v]split=2[s1][s2];[s1]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:3[bg];` +
        `[s2]scale=640:720:force_original_aspect_ratio=decrease,format=rgba[p];[bg][p]overlay=x=(W-w)/2:y=(H-h)/2-80:shortest=1[b0];` +
        zoom('[b0]', '[b1]', 0.08) + `;[b1][${ix.shade}:v]overlay=0:0[z]`;
    } else if (lk.st === 'pan') {
      // the photo fills the screen and slowly slides sideways (or up), with a dark shade for the texts
      base =
        `[0:v]scale=${Math.round(W * 1.35)}:${Math.round(H * 1.12)}:force_original_aspect_ratio=increase,` +
        `crop=${W}:${H}:x='(iw-${W})*t/${SEC}':y='(ih-${H})/2',setsar=1[b0];[b0][${ix.shade}:v]overlay=0:0[z]`;
    } else {
      // card: colour page, the photo card slides up and then zooms a little
      base =
        `color=c=${PALETTES[lk.pl % PALETTES.length].bg}:s=${W}x${H}:r=${FPS}:d=${SEC}[bg];` +
        `[bg][${ix.card}:v]overlay=x=(W-w)/2:y='if(lt(t,0.7),H-(H-200)*t/0.7,200)':eval=frame:shortest=1[b0];` + zoom('[b0]', '[z]', 0.05);
    }
    const t0 = hookEnd;
    let video =
      `${base};` +
      `[1:v]format=rgba,fade=t=in:st=${(t0 + 0.1).toFixed(2)}:d=0.4:alpha=1[t1];` +
      `[2:v]format=rgba,fade=t=in:st=${(t0 + 0.7).toFixed(2)}:d=0.5:alpha=1[t2];` +
      `[3:v]format=rgba,fade=t=in:st=${(t0 + 1.6).toFixed(2)}:d=0.5:alpha=1[t3];` +
      `[z][t1]overlay=0:0[a1];[a1][t2]overlay=0:0[a2];[a2][t3]overlay=0:0`;
    if (lk.st === 'hook') video += `[a3];[${ix.hook}:v]format=rgba,fade=t=out:st=1.0:d=0.35:alpha=1[h];[a3][h]overlay=0:0,format=yuv420p[v]`;
    else video += `,format=yuv420p[v]`;
    const ai = inputs.length;
    let audio;
    if (music) {
      await writeFile(join(dir, 'm.audio'), music);
      args.push('-i', join(dir, 'm.audio'));
      audio = `[${ai}:a]atrim=0:${SEC},asetpts=PTS-STARTPTS,afade=t=in:d=0.4,afade=t=out:st=${SEC - 1.5}:d=1.5,aresample=44100,apad=whole_dur=${SEC}[a]`;
    } else {
      args.push('-f', 'lavfi', '-t', String(SEC), '-i', 'anullsrc=r=44100:cl=stereo');
      audio = `[${ai}:a]anull[a]`;
    }
    args.push(
      '-filter_complex', `${video};${audio}`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-crf', '22', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-t', String(SEC), '-movflags', '+faststart',
      join(dir, 'out.mp4'),
    );
    await run(await ffmpeg(), args, 100000);
    return await readFile(join(dir, 'out.mp4'));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// A sample Reel (a drawn "product", no music) — "/api/igvid?check=reel" shows that the server can make videos.
export async function sampleReel(look = null) {
  const sharp = (await import('sharp')).default;
  const image = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#FF9900' } }).composite([{ input: await box(sharp, 400, 600, '#3366FF'), left: 100, top: 100 }]).png().toBuffer();
  return buildReel({ name: "Namuna: sovg'a uchun yumshoq o'yinchoq ayiqcha", price: 185000, old_price: 250000, kind: 'discount' }, { phone: '+998 00 000 00 00', image, look });
}

