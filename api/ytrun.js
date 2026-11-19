// ▶️ YouTube Shorts yuklash alohida funksiyada: tikdagi boshqa ishlar vaqtni yeb qo'ymasin («vaqt yetmadi» bo'lmasin).
// Tik har 15 daqiqada chaqiradi (lib/tick.js -> kickYt).
import { waitUntil } from '@vercel/functions';
import { checkCron } from '../lib/request.js';
import * as db from '../lib/store.js';
import { ytTick } from '../lib/youtube.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!checkCron(req, res)) return;
  if (!db.hasRedis()) return res.status(500).json({ ok: false, error: "Redis yo'q" });
  waitUntil(
    (async () => {
      if (!(await db.lock('ytrun', 280))) return;
      try {
        const s = await db.getSettings();
        const r = await ytTick(s, { deadline: Date.now() + 250000 });
        if (r.uploaded || r.error) console.log(`ytrun: ${JSON.stringify(r)}`);
      } finally {
        await db.unlock('ytrun').catch(() => {});
      }
    })().catch((e) => console.error('ytrun', e?.message || e)),
  );
  return res.status(200).json({ ok: true });
}
