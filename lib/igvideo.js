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

// item: { name, price, old_price, image_url, kind: 'discount' | 'restock' | 'new' | 'other' }
// opts: { phone, brand, price (show the price), music (Buffer: wav / mp3 / m4a) }
export async function buildReel(item, { phone = '', brand = 'MIX PODAROK', price = true, music = null, image = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'reel-'));
  try {
    const img = image || Buffer.from(await (await fetch(item.image_url, { signal: AbortSignal.timeout(15000) })).arrayBuffer());
    await writeFile(join(dir, 'p.img'), img);
    const texts = [];
    const add = (name, t) => {
      texts.push(name);
      return writeFile(join(dir, `${name}.txt`), t);
    };
    const fade = (start) => `alpha='if(lt(t,${start}),0,min(1,(t-${start})/0.4))'`;
    const draw = [];
    // shop name at the top
    await add('brand', String(brand || '').toUpperCase().slice(0, 30));
    draw.push(`drawtext=fontfile='${BOLD}':textfile='${join(dir, 'brand.txt')}':fontsize=44:fontcolor=0xE91E63:x=(w-text_w)/2:y=64:${fade(0.1)}`);
    const tag = TAG[item.kind];
    if (tag) {
      await add('tag', tag);
      draw.push(`drawtext=fontfile='${BOLD}':textfile='${join(dir, 'tag.txt')}':fontsize=36:fontcolor=white:box=1:boxcolor=0xE91E63:boxborderw=16:x=(w-text_w)/2:y=140:${fade(0.3)}`);
    }
    // name: up to 2 lines
    const lines = wrap(item.name, 24, 2);
    let y = 880;
    for (const [i, l] of lines.entries()) {
      await add(`n${i}`, l);
      draw.push(`drawtext=fontfile='${BOLD}':textfile='${join(dir, `n${i}.txt`)}':fontsize=40:fontcolor=0x222222:x=(w-text_w)/2:y=${y}:${fade(0.8)}`);
      y += 52;
    }
    y += 12;
    if (price && Number(item.price) > 0) {
      const now = `${formatPrice(item.price)} so'm`;
      if (Number(item.old_price) > Number(item.price)) {
        const old = `${formatPrice(item.old_price)} so'm`;
        await add('old', old);
        draw.push(`drawtext=fontfile='${REG}':textfile='${join(dir, 'old.txt')}':fontsize=34:fontcolor=0x888888:x=(w-text_w)/2:y=${y}:${fade(1.2)}`);
        const sw = Math.round(old.length * 34 * 0.6);
        draw.push(`drawbox=x=${Math.round((W - sw) / 2)}:y=${y + 19}:w=${sw}:h=3:color=0x888888:t=fill:enable='gte(t,1.2)'`);
        y += 48;
      }
      await add('price', now);
      draw.push(`drawtext=fontfile='${BOLD}':textfile='${join(dir, 'price.txt')}':fontsize=66:fontcolor=0xE91E63:x=(w-text_w)/2:y=${y}:${fade(1.4)}`);
    } else {
      await add('price', "Narxini Direct'da so'rang");
      draw.push(`drawtext=fontfile='${BOLD}':textfile='${join(dir, 'price.txt')}':fontsize=40:fontcolor=0xE91E63:x=(w-text_w)/2:y=${y}:${fade(1.4)}`);
    }
    if (phone) {
      await add('phone', `Buyurtma: ${phone}`);
      draw.push(`drawtext=fontfile='${BOLD}':textfile='${join(dir, 'phone.txt')}':fontsize=34:fontcolor=white:box=1:boxcolor=0x222222:boxborderw=18:x=(w-text_w)/2:y=1196:${fade(2.0)}`);
    }
    const frames = REEL_SEC * FPS;
    // white page, the photo (up to 660x660) in the middle, a slow zoom, then the texts
    const video =
      `color=c=white:s=${W}x${H}:r=${FPS}:d=${REEL_SEC}[bg];` +
      `[0:v]scale=600:600:force_original_aspect_ratio=decrease,format=rgba[p];` +
      `[bg][p]overlay=x=(W-w)/2:y=240+(600-h)/2:shortest=1,` +
      `scale=${W * 2}:${H * 2},zoompan=z='1+0.06*on/${frames}':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS},` +
      `${draw.join(',')},format=yuv420p[v]`;
    const args = ['-y', '-loglevel', 'error', '-loop', '1', '-framerate', String(FPS), '-t', String(REEL_SEC), '-i', join(dir, 'p.img')];
    let audio;
    if (music) {
      await writeFile(join(dir, 'm.audio'), music);
      args.push('-i', join(dir, 'm.audio'));
      audio = `[1:a]atrim=0:${REEL_SEC},asetpts=PTS-STARTPTS,afade=t=in:d=0.6,afade=t=out:st=${REEL_SEC - 1.5}:d=1.5,aresample=44100,apad=whole_dur=${REEL_SEC}[a]`;
    } else {
      args.push('-f', 'lavfi', '-t', String(REEL_SEC), '-i', 'anullsrc=r=44100:cl=stereo');
      audio = '[1:a]anull[a]';
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
