// "💬 Avto-javob" loop: Instagram Direct and comments checked about once a minute (lib/igdm.js).
// Started by the tick (api/cron/tick.js); answers at once and keeps polling in the background.
import { waitUntil } from '@vercel/functions';
import { keepIgdmFresh } from '../lib/igdm.js';
import { checkCron } from '../lib/request.js';
import { hasRedis } from '../lib/store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use GET or POST' });
  if (!checkCron(req, res)) return;
  if (!hasRedis()) return res.status(500).json({ ok: false, error: 'Redis yo\'q' });
  waitUntil(keepIgdmFresh().catch((err) => console.error('igdm loop', err?.message || err)));
  return res.status(200).json({ ok: true, loop: true });
}
