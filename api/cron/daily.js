import { runDaily } from '../../lib/daily.js';
import { checkCron } from '../../lib/request.js';
import { hasRedis } from '../../lib/store.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET or POST' });
  }
  if (!checkCron(req, res)) return;
  if (!process.env.BOT_TOKEN || !hasRedis()) {
    return res.status(500).json({ ok: false, error: 'Missing environment variables (BOT_TOKEN, Redis)' });
  }
  try {
    return res.status(200).json({ ok: true, ...(await runDaily()) });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
}
