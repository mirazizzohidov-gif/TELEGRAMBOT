import { kickBitoOrderLoop, pollBitoOrders } from '../../lib/bito-orders.js';
import { checkCron } from '../../lib/request.js';
import { hasRedis } from '../../lib/store.js';
import { runTick } from '../../lib/tick.js';
import { kickIgdmLoop } from '../../lib/igdm.js';
import { getSettings } from '../../lib/store.js';

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
    // BITO sale-order poll. Hobby allows only the daily cron, so this rides the existing 15-minute tick.
    // GET /api/bito-orders runs the same poll. Dedupe keeps one order from being sent twice.
    // Off until an admin turns it on, and a failure here does not change the tick result.
    const bito_orders = await pollBitoOrders().catch((err) => {
      console.error('bito order notify', err.message || err);
      return { error: err.message || String(err) };
    });
    // If the minute loop has stopped, this starts it again. The route answers at once.
    const bito_loop = await kickBitoOrderLoop().catch((err) => {
      console.error('bito order loop kick', err.message || err);
      return { error: err.message || String(err) };
    });
    // "💬 Avto-javob": the Instagram Direct / comments minute-loop (lib/igdm.js) — restarted if it stopped
    const igdm_loop = await kickIgdmLoop(await getSettings().catch(() => ({}))).catch((err) => ({ error: err.message || String(err) }));
    return res.status(200).json({ ok: true, ...result, bito_orders, bito_loop, igdm_loop });
  } catch (err) {
    return res.status(err.status || 500).json({ ok: false, error: err.message, details: err.details });
  }
}
