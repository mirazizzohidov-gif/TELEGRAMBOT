// «❌ Tugadi» / «⚠️ Kam qoldi» qayta yuborish tsikli (lib/stockbfloop.js). Tik yoki dashboard tugmasi ishga tushiradi.
import { waitUntil } from '@vercel/functions';
import { checkCron } from '../lib/request.js';
import { hasRedis } from '../lib/store.js';
import { keepStockBf } from '../lib/stockbfloop.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Use GET or POST' });
  if (!checkCron(req, res)) return;
  if (!hasRedis()) return res.status(500).json({ ok: false, error: 'Redis yo\'q' });
  waitUntil(keepStockBf().catch((err) => console.error('stockbf loop', err?.message || err)));
  return res.status(200).json({ ok: true, loop: true });
}
