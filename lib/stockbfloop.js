// «Tugadi» / «Kam qoldi» qayta yuborish tsikli: 15 daqiqalik tikni kutmaydi — /api/stockbf ~4 daqiqa uzluksiz yuboradi
// (Telegram limiti ~20 xabar/daqiqa), tugagach o'zini qayta chaqiradi. Navbat bo'sh bo'lsa to'xtaydi; tik uni qayta yoqadi.
import { lowBackfillTick, lowbfState } from './lowbackfill.js';
import { outBackfillTick, outbfState } from './outbackfill.js';
import * as db from './store.js';
import { errText } from './util.js';

const LOOP = 'stockbfloop';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = (st) => Boolean(st && !st.done && !st.stopped);

export async function bfActive() {
  const [o, l] = await Promise.all([outbfState().catch(() => null), lowbfState().catch(() => null)]);
  return { out: live(o), low: live(l), pause: Math.max(0, Number(o?.pause_until) || 0, Number(l?.pause_until) || 0) };
}

function bfUrl() {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '';
  return host ? `${/^https?:\/\//i.test(host) ? host : `https://${host}`}/api/stockbf` : '';
}

// ish bor bo'lsa tsiklni (qayta) ishga tushiradi; javob darrov keladi
export async function kickStockBf({ force = false } = {}) {
  if (!force) {
    const a = await bfActive();
    if (!a.out && !a.low) return { skipped: 'idle' };
  }
  const url = bfUrl();
  const headers = {};
  if (process.env.CRON_SECRET) headers.Authorization = `Bearer ${process.env.CRON_SECRET}`;
  if (process.env.SECRET) headers['x-secret'] = process.env.SECRET;
  if (!url || !Object.keys(headers).length) return { skipped: 'no kick' };
  const res = await fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(20000) });
  return { status: res.status };
}

export async function keepStockBf({ budget = 250000 } = {}) {
  if (!db.hasRedis()) return { skipped: 'no redis' };
  if (!(await db.lock(LOOP, 290))) return { skipped: 'running' };
  const start = Date.now();
  let again = false;
  let sent = 0;
  try {
    while (Date.now() - start < budget) {
      const a = await bfActive();
      if (!a.out && !a.low) break;
      const until = Math.min(start + budget, Date.now() + 60000);
      let n = 0;
      if (a.out) n += await outBackfillTick(until).catch((e) => (console.error(`stockbf out: ${errText(e)}`), 0));
      else if (a.low) n += await lowBackfillTick(until).catch((e) => (console.error(`stockbf low: ${errText(e)}`), 0));
      sent += n;
      if (!n) await sleep(Math.min(30000, Math.max(3000, a.pause - Date.now())));
    }
    again = (await bfActive().then((a) => a.out || a.low)) && Date.now() - start >= budget - 1000;
  } finally {
    await db.unlock(LOOP).catch(() => {});
  }
  const next = again ? await kickStockBf().catch((e) => ({ error: errText(e) })) : null;
  return { sent, next };
}
