// "🎬 Reels": the video Instagram downloads for a Reel (lib/ig.js igVideoUrl), also the dashboard's
// "🎬 Namuna" preview. GET /api/igvid?d=<data>&s=<signature> -> MP4 (720x1280, 8 s, music).
// Only links the bot signed work.
import { createHash } from 'node:crypto';
import { igCheck, igDecodeVideo, igMusicGet } from '../lib/ig.js';
import * as db from '../lib/store.js';
import { buildReel, ffmpegCheck, sampleReel } from '../lib/igvideo.js';
import { errText } from '../lib/util.js';

export default async function handler(req, res) {
  if (req.query?.check === '1') return res.status(200).json(await ffmpegCheck());
  // a sample video (drawn product, no data of the shop): checks that the server can make Reels
  if (req.query?.check === 'reel') {
    try {
      const mp4 = await sampleReel();
      res.setHeader('Content-Type', 'video/mp4');
      return res.status(200).send(mp4);
    } catch (e) {
      return res.status(500).json({ ok: false, error: errText(e).slice(0, 300) });
    }
  }
  const d = String(req.query?.d || '');
  if (!igCheck(d, req.query?.s)) return res.status(403).send('Forbidden');
  const o = igDecodeVideo(d);
  if (!o) return res.status(400).send('Bad request');
  if (req.method === 'HEAD') {
    res.setHeader('Content-Type', 'video/mp4');
    return res.status(200).end();
  }
  try {
    // made once and kept for an hour: the bot asks for it first (?warm=1), so Instagram gets it at once
    const key = db.K.flag(`igvid:${createHash('sha1').update(d).digest('hex').slice(0, 20)}`);
    const cached = db.hasRedis() ? await db.redis().get(key).catch(() => null) : null;
    let mp4 = cached ? Buffer.from(String(cached), 'base64') : null;
    if (!mp4) {
      const music = o.m ? await igMusicGet(o.m).catch(() => null) : null;
      mp4 = await buildReel(
        { name: o.n, price: o.p, old_price: o.o, image_url: o.u, kind: o.t },
        { phone: o.ph, brand: o.b, price: o.sp !== false, music },
      );
      if (db.hasRedis()) await db.redis().set(key, mp4.toString('base64'), { ex: 3600 }).catch(() => {});
    }
    if (req.query?.warm === '1') return res.status(200).json({ ok: true, bytes: mp4.length, cached: Boolean(cached) });
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(mp4.length));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).send(mp4);
  } catch (e) {
    console.error(`igvid: ${errText(e)}`);
    return res.status(502).send('Video error');
  }
}
