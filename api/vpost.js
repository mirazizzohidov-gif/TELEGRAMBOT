// "🎬 Video joylash" background run (lib/vpost.js): started by the dashboard / the tick, posts the
// uploaded video to each chosen network and asks itself to continue when time runs out.
import { waitUntil } from '@vercel/functions';
import { checkCron } from '../lib/request.js';
import { hasRedis } from '../lib/store.js';
import { vpostRun } from '../lib/vpost.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use GET or POST' });
  if (!checkCron(req, res)) return;
  if (!hasRedis()) return res.status(500).json({ ok: false, error: 'Redis yo\'q' });
  waitUntil(vpostRun().catch((err) => console.error('vpost run', err?.message || err)));
  return res.status(200).json({ ok: true, run: true });
}
