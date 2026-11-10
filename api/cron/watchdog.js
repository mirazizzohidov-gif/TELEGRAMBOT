// "🐕 Zaxira tekshiruvchi": GitHub Actions (.github/workflows/watchdog.yml) calls this every 10 minutes.
// While the 15-minute tick (cron-job.org) works it only answers { late: false }. With no tick for 30+
// minutes it warns the admins and runs the tick here, so the bot keeps working until the cron is fixed.
// No secret is needed: it does nothing unless the bot is already stalled, and the tick has its own lock.
import { kickBitoOrderLoop, pollBitoOrders } from '../../lib/bito-orders.js';
import { watchdog } from '../../lib/health.js';
import { getSettingsSafe, hasRedis } from '../../lib/store.js';
import { runTick } from '../../lib/tick.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET or POST' });
  }
  if (!process.env.BOT_TOKEN || !hasRedis()) {
    return res.status(500).json({ ok: false, error: 'Missing environment variables (BOT_TOKEN, Redis)' });
  }
  try {
    const s = await getSettingsSafe().catch(() => ({}));
    const w = await watchdog(s);
    if (!w.late) return res.status(200).json({ ok: true, late: false, minutes: w.minutes });
    console.error(`watchdog: no tick for ${w.minutes} min — running it`);
    const tick = await runTick().catch((e) => ({ error: e.message || String(e) }));
    const bito_orders = await pollBitoOrders().catch((e) => ({ error: e.message || String(e) }));
    const bito_loop = await kickBitoOrderLoop().catch((e) => ({ error: e.message || String(e) }));
    return res.status(200).json({ ok: true, late: true, minutes: w.minutes, tick, bito_orders, bito_loop });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
