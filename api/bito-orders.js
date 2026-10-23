// New ingress for BITO sale orders. GET (or POST without an order) polls /sale-order/get-paging.
// POST with an order object announces that order. Same secret as the cron routes. A destination
// that rejects the message does not fail the request.

import { waitUntil } from '@vercel/functions';
import { acceptBitoOrder, keepBitoOrdersFresh } from '../lib/bito-orders.js';
import { checkCron, readBody } from '../lib/request.js';
import { hasRedis } from '../lib/store.js';

const looksLikeOrder = (b) => b && typeof b === 'object' && (b._id || b.id || b.number || b.uuid || b.products || b.items || b.customer);

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use GET or POST' });
  }
  if (!checkCron(req, res)) return;
  if (!process.env.BOT_TOKEN || !hasRedis()) {
    return res.status(500).json({ ok: false, error: 'Missing environment variables (BOT_TOKEN, Redis)' });
  }
  try {
    if (req.method === 'POST') {
      const body = readBody(req, res);
      if (body === undefined) return;
      const order = looksLikeOrder(body?.order) ? body.order : looksLikeOrder(body) ? body : null;
      if (order) {
        const result = await acceptBitoOrder(order);
        return res.status(200).json({ ok: true, id: result.id || null, sent: result.sent || [], failed: result.failed || [], skipped: result.skipped || null });
      }
    }
    const job = keepBitoOrdersFresh().catch((err) => {
      console.error('bito order loop', err);
      return { error: err.message || String(err) };
    });
    waitUntil(job);
    return res.status(200).json({ ok: true, loop: true });
  } catch (err) {
    console.error('bito-orders', err);
    return res.status(err.status || 500).json({ ok: false, error: err.message });
  }
}
