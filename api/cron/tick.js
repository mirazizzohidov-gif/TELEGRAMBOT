import { pollBitoOrders } from '../../lib/bito-orders.js';
import { checkCron } from '../../lib/request.js';
import { hasRedis } from '../../lib/store.js';
import { runTick } from '../../lib/tick.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET or POST' });
  }
  if (!checkCron(req, res)) return;
  if (!process.env.BOT_TOKEN || !hasRedis()) {
    return res.status(500).json({ ok: false, error: 'Missing environment variables (BOT_TOKEN, Redis)' });
  }
  try {
    const result = await runTick();
    // Backup for the every-minute /api/bito-orders cron. Dedupe keeps one order from being sent twice.
    // Off until an admin turns it on, and a failure here does not change the tick result.
    const bito_orders = await pollBitoOrders().catch((err) => {
      console.error('bito order notify', err.message || err);
      return { error: err.message || String(err) };
    });
    return res.status(200).json({ ok: true, ...result, bito_orders });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
}
