// "🎬 Reels": an 8-second 720x1280 video of one product, made with ffmpeg: the photo slowly zooms in,
// the shop name, a "CHEGIRMA! / YANGI / YANA SOTUVDA" tag, the name, the price (old one struck out) and
// the phone fade in; background music (a track from "🎵 Musiqa", lib/ig.js) fades in and out.
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

const TAG = { discount: 'CHEGIRMA!', restock: 'YANA SOTUVDA', new: 'YANGI MAHSULOT' };
const PINK = '#E91E63';
const xml = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

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

// The texts in 3 layers (720x1280, transparent) that fade in one after another.
async function layers(item, { phone, brand, price }) {
  const sharp = (await import('sharp')).default;
  const center = (t, top) => ({ input: t.input, left: Math.max(0, Math.round((W - t.width) / 2)), top: Math.round(top) });
  const canvas = (parts) => sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(parts).png().toBuffer();
  // 1: shop name + tag
  const top = [];
  if (brand) top.push(center(await textPng(sharp, String(brand).toUpperCase().slice(0, 30), { size: 32, color: PINK }), 56));
  const tag = TAG[item.kind];
  if (tag) {
    const t = await textPng(sharp, tag, { size: 26, color: '#FFFFFF' });
    const bw = t.width + 36;
    const bh = t.height + 20;
    top.push({ input: await box(sharp, bw, bh, PINK), left: Math.round((W - bw) / 2), top: 132 });
    top.push({ input: t.input, left: Math.round((W - t.width) / 2), top: 142 });
  }
  // 2: name, old price (struck out), price
  const mid = [];
  let y = 870;
  for (const l of wrap(item.name, 24, 2)) {
    const t = await textPng(sharp, l, { size: 29, color: '#222222' });
    mid.push(center(t, y));
    y += t.height + 8;
  }
  y += 10;
  if (price && Number(item.price) > 0) {
    if (Number(item.old_price) > Number(item.price)) {
      const t = await textPng(sharp, `${formatPrice(item.old_price)} so'm`, { size: 25, color: '#888888', bold: false });
      mid.push(center(t, y));
      mid.push({ input: await box(sharp, t.width + 8, 3, '#888888'), left: Math.round((W - t.width - 8) / 2), top: Math.round(y + t.height / 2) });
      y += t.height + 8;
    }
    mid.push(center(await textPng(sharp, `${formatPrice(item.price)} so'm`, { size: 48, color: PINK }), y));
  } else {
    mid.push(center(await textPng(sharp, "Narxini Direct'da so'rang", { size: 29, color: PINK }), y));
  }
  // 3: phone on a dark bar
  const bot = [];
  if (phone) {
    const t = await textPng(sharp, `Buyurtma: ${phone}`, { size: 25, color: '#FFFFFF' });
    const bw = t.width + 40;
    const bh = t.height + 28;
    bot.push({ input: await box(sharp, bw, bh, '#222222'), left: Math.round((W - bw) / 2), top: 1190 });
    bot.push({ input: t.input, left: Math.round((W - t.width) / 2), top: 1204 });
  }
  return Promise.all([canvas(top), canvas(mid), canvas(bot)]);
}

// item: { name, price, old_price, image_url, kind: 'discount' | 'restock' | 'new' | 'other' }
// opts: { phone, brand, price (show the price), music (Buffer: wav / mp3 / m4a), image (Buffer instead of the URL) }
export async function buildReel(item, { phone = '', brand = 'MIX PODAROK', price = true, music = null, image = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'reel-'));
  try {
    const img = image || Buffer.from(await (await fetch(item.image_url, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
    await writeFile(join(dir, 'p.img'), img);
    const [l1, l2, l3] = await layers(item, { phone, brand, price });
    await writeFile(join(dir, 'l1.png'), l1);
    await writeFile(join(dir, 'l2.png'), l2);
    await writeFile(join(dir, 'l3.png'), l3);
    const frames = REEL_SEC * FPS;
    const loop = (f) => ['-loop', '1', '-framerate', String(FPS), '-t', String(REEL_SEC), '-i', join(dir, f)];
    const args = ['-y', '-loglevel', 'error', ...loop('p.img'), ...loop('l1.png'), ...loop('l2.png'), ...loop('l3.png')];
    // white page, the photo (up to 600x600) in the middle, a slow zoom; the text layers fade in on top
    const video =
      `color=c=white:s=${W}x${H}:r=${FPS}:d=${REEL_SEC}[bg];` +
      `[0:v]scale=600:600:force_original_aspect_ratio=decrease,format=rgba[p];` +
      `[bg][p]overlay=x=(W-w)/2:y=240+(600-h)/2:shortest=1,` +
      `scale=${W * 2}:${H * 2},zoompan=z='1+0.06*on/${frames}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS}[z];` +
      `[1:v]format=rgba,fade=t=in:st=0.1:d=0.4:alpha=1[t1];` +
      `[2:v]format=rgba,fade=t=in:st=0.8:d=0.5:alpha=1[t2];` +
      `[3:v]format=rgba,fade=t=in:st=1.8:d=0.5:alpha=1[t3];` +
      `[z][t1]overlay=0:0[a1];[a1][t2]overlay=0:0[a2];[a2][t3]overlay=0:0,format=yuv420p[v]`;
    let audio;
    if (music) {
      await writeFile(join(dir, 'm.audio'), music);
      args.push('-i', join(dir, 'm.audio'));
      audio = `[4:a]atrim=0:${REEL_SEC},asetpts=PTS-STARTPTS,afade=t=in:d=0.6,afade=t=out:st=${REEL_SEC - 1.5}:d=1.5,aresample=44100,apad=whole_dur=${REEL_SEC}[a]`;
    } else {
      args.push('-f', 'lavfi', '-t', String(REEL_SEC), '-i', 'anullsrc=r=44100:cl=stereo');
      audio = '[4:a]anull[a]';
    }
    args.push(
      '-filter_complex', `${video};${audio}`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-crf', '23', '-r', String(FPS),
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-t', String(REEL_SEC), '-movflags', '+faststart',
      join(dir, 'out.mp4'),
    );
    await run(await ffmpeg(), args, 90000);
    return await readFile(join(dir, 'out.mp4'));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// A sample Reel (a drawn "product", no music) — "/api/igvid?check=reel" shows that the server can make videos.
export async function sampleReel() {
  const sharp = (await import('sharp')).default;
  const image = await sharp({ create: { width: 600, height: 800, channels: 3, background: '#FF9900' } }).composite([{ input: await box(sharp, 400, 600, '#3366FF'), left: 100, top: 100 }]).png().toBuffer();
  return buildReel({ name: "Namuna: sovg'a uchun yumshoq o'yinchoq ayiqcha", price: 185000, old_price: 250000, kind: 'discount' }, { phone: '+998 00 000 00 00', image });
}

