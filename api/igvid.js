// "🎬 Reels": the video Instagram downloads for a Reel (lib/ig.js igVideoUrl), also the dashboard's
// "🎬 Namuna" preview. GET /api/igvid?d=<data>&s=<signature> -> MP4 (720x1280, 8 s, music).
// Only links the bot signed work.
import { igCheck, igDecodeVideo, igMusicGet } from '../lib/ig.js';
import { buildReel } from '../lib/igvideo.js';
import { errText } from '../lib/util.js';

export default async function handler(req, res) {
  const d = String(req.query?.d || '');
  if (!igCheck(d, req.query?.s)) return res.status(403).send('Forbidden');
  const o = igDecodeVideo(d);
  if (!o) return res.status(400).send('Bad request');
  if (req.method === 'HEAD') {
    res.setHeader('Content-Type', 'video/mp4');
    return res.status(200).end();
  }
  try {
    const music = o.m ? await igMusicGet(o.m).catch(() => null) : null;
    const mp4 = await buildReel(
      { name: o.n, price: o.p, old_price: o.o, image_url: o.u, kind: o.t },
      { phone: o.ph, brand: o.b, price: o.sp !== false, music },
    );
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(mp4.length));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(mp4);
  } catch (e) {
    console.error(`igvid: ${errText(e)}`);
    return res.status(502).send('Video error');
  }
}
