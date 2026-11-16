// "💬 Mijoz fikri": 5⭐ izohdan Instagram kartochkasi (1080×1080 JPEG). Faqat bot imzolagan havolalar ishlaydi.
// GET /api/mfcard?d=<base64url {k:'mf',id}>&s=<imzo>
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { igCheck } from '../lib/ig.js';
import { mfRecord } from '../lib/feedback.js';
import { errText } from '../lib/util.js';

const FONT_DIR = fileURLToPath(new URL('../assets/fonts/', import.meta.url));
const BOLD = join(FONT_DIR, 'DejaVuSans-Bold.ttf');
const REG = join(FONT_DIR, 'DejaVuSans.ttf');
const xml = (t) => String(t ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[m]);

async function text(sharp, t, { size, color, bold = false, width, align = 'left' }) {
  const { data, info } = await sharp({
    text: { text: `<span foreground="${color}">${xml(t)}</span>`, fontfile: bold ? BOLD : REG, font: `DejaVu Sans${bold ? ' Bold' : ''} ${size}`, rgba: true, dpi: 96, width, align, wrap: 'word', spacing: Math.round(size * 0.45) },
  }).png().toBuffer({ resolveWithObject: true });
  return { input: data, width: info.width, height: info.height };
}

export default async function handler(req, res) {
  const d = String(req.query?.d || '');
  if (!igCheck(d, req.query?.s)) return res.status(403).send('Forbidden');
  let id = '';
  try { const o = JSON.parse(Buffer.from(d, 'base64url').toString('utf8')); if (o?.k === 'mf') id = String(o.id || ''); } catch {}
  const v = id ? await mfRecord(id).catch(() => null) : null;
  if (!v?.comment) return res.status(404).send('Not found');
  try {
    const sharp = (await import('sharp')).default;
    const W = 1080;
    const comment = String(v.comment).slice(0, 320);
    const size = comment.length > 200 ? 38 : comment.length > 110 ? 46 : 56;
    const name = String(v.name || '').split(/\s+/)[0] || 'Mijozimiz';
    const biz = String(v.biz || '').replace(/^🧪 sinov · /, '');
    const head = await text(sharp, 'Mijozlarimiz fikri', { size: 44, color: '#ffffff', bold: true });
    const starsP = await text(sharp, '★'.repeat(Math.max(1, Math.min(5, v.rating || 5))), { size: 64, color: '#FFC107', bold: true });
    const quote = await text(sharp, '“', { size: 200, color: '#E91E63', bold: true });
    const body = await text(sharp, comment, { size, color: '#222222', width: W - 240 });
    const who = await text(sharp, `— ${name}`, { size: 40, color: '#555555', bold: true });
    const foot = await text(sharp, biz, { size: 40, color: '#ffffff', bold: true });
    const card = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W - 120}" height="${W - 360}"><rect width="100%" height="100%" rx="36" fill="#ffffff"/></svg>`)).png().toBuffer();
    const top = 240;
    const parts = [
      { input: card, left: 60, top },
      { input: head.input, left: Math.round((W - head.width) / 2), top: 70 },
      { input: starsP.input, left: Math.round((W - starsP.width) / 2), top: 140 },
      { input: quote.input, left: 100, top: top - 40 },
      { input: body.input, left: 120, top: top + 170 },
      { input: who.input, left: W - 120 - who.width, top: Math.min(top + 190 + body.height, top + W - 360 - 90) },
      { input: foot.input, left: Math.round((W - foot.width) / 2), top: W - 90 },
    ];
    const out = await sharp({ create: { width: W, height: W, channels: 3, background: '#E91E63' } }).composite(parts).jpeg({ quality: 90 }).toBuffer();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(out);
  } catch (e) {
    console.error(`mfcard: ${errText(e)}`);
    return res.status(500).send('Error');
  }
}
