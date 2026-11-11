// "📸 Instagram": the photo Instagram downloads for a post / story (lib/ig.js igImageUrl).
// GET /api/igimg?d=<data>&s=<signature> -> JPEG: feed 1080x1080 (whole photo on white), story 1080x1920;
// kind 'thumb': 320px WebP for the dashboard cards;
// with the logo when "🖼 Logo" (feed) / "🖼 Logo → istoriya" (story) is on. Only links the bot signed work.
import { igCheck, igDecode } from '../lib/ig.js';
import { getSettingsSafe } from '../lib/store.js';
import { downloadImage, toStoryJpeg } from '../lib/story.js';
import { applyWatermark, markStoryBytes } from '../lib/watermark.js';
import { errText } from '../lib/util.js';

export default async function handler(req, res) {
  const d = String(req.query?.d || '');
  if (!igCheck(d, req.query?.s)) return res.status(403).send('Forbidden');
  const o = igDecode(d);
  if (!o) return res.status(400).send('Bad request');
  try {
    if (o.k === 'thumb') {
      // dashboard cards: small WebP, cached by the CDN for a month
      const sharp = (await import('sharp')).default;
      const small = await sharp(await downloadImage(o.u)).rotate().resize(320, 320, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=2592000, immutable');
      return res.status(200).send(small);
    }
    const s = await getSettingsSafe();
    const raw = await downloadImage(o.u);
    let out;
    if (o.k === 'story') {
      out = await toStoryJpeg(await markStoryBytes(raw, s));
    } else {
      let img = raw;
      if (s.wm_on) img = await applyWatermark(raw, s).catch(() => raw);
      const sharp = (await import('sharp')).default;
      out = await sharp(img).rotate().resize(1080, 1080, { fit: 'contain', background: '#ffffff' }).flatten({ background: '#ffffff' }).jpeg({ quality: 88 }).toBuffer();
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(out);
  } catch (e) {
    console.error(`igimg: ${errText(e)}`);
    return res.status(502).send('Image error');
  }
}
