import { checkSecret } from '../lib/request.js';
import { hasRedis, listBiz } from '../lib/store.js';
import { tg } from '../lib/telegram.js';

// Business connections are saved by the webhook. Without Redis, falls back to getUpdates
// (works only while no webhook is set).
export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET or POST' });
  }
  const { BOT_TOKEN, SECRET } = process.env;
  if (!BOT_TOKEN || !SECRET) {
    return res.status(500).json({ ok: false, error: 'Missing environment variables' });
  }
  if (!checkSecret(req, res)) return;
  try {
    if (hasRedis()) {
      return res.status(200).json({ ok: true, source: 'database', connections: await listBiz() });
    }
    const updates = await tg('getUpdates', { allowed_updates: ['business_connection'] });
    const connections = updates
      .filter((u) => u.business_connection)
      .map(({ business_connection: c }) => ({
        id: c.id,
        user: c.user,
        rights: c.rights ?? null,
        is_enabled: c.is_enabled,
        date: c.date,
      }));
    return res.status(200).json({ ok: true, source: 'getUpdates', connections });
  } catch (err) {
    if (err.data) {
      return res.status(502).json({ ok: false, error: 'Telegram error', details: err.data });
    }
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
