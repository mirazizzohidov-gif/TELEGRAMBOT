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

// qulf bo'shashini kutadi (oldingi tsikl tugayotganda yangisi uni o'rnini oladi)
async function acquire(maxWaitMs) {
  const t = Date.now();
  for (;;) {
    if (await db.lock(LOOP, 290)) return true;
    if (Date.now() - t > maxWaitMs) return false;
    await sleep(3000);
  }
}

export async function keepStockBf({ budget: maxBudget = 240000 } = {}) {
  if (!db.hasRedis()) return { skipped: 'no redis' };
  const reqStart = Date.now();
  // Vercel rekursiya himoyasi (508): o'zini qayta chaqirish zanjiri ~4 bo'g'indan keyin uziladi. Tik (yangi zanjir) kelganda
  // u ishlayotgan tsikl tugashini kutadi va uning o'rnini oladi — shunda uzilish bo'lmaydi
  if (!(await acquire(200000))) return { skipped: 'running' };
  const start = Date.now();
  const budget = Math.min(maxBudget, 285000 - (start - reqStart));
  if (budget < 45000) {
    await db.unlock(LOOP).catch(() => {});
    return { skipped: 'no time' };
  }
  console.log('stockbf: loop start');
  let sent = 0;
  let kicked = false;
  const kickNext = async () => {
    kicked = true;
    const r = await kickStockBf().catch((e) => ({ error: errText(e) }));
    console.log(`stockbf: next loop kick ${JSON.stringify(r)}`);
  };
  // keyingi tsiklni taymer chaqiradi: iteratsiya cho'zilib ketsa ham zanjir uzilmaydi
  const timer = setTimeout(() => { if (!kicked) kickNext().catch(() => {}); }, Math.max(1000, budget - 50000));
  try {
    while (Date.now() - start < budget) {
      const a = await bfActive();
      if (!a.out && !a.low) break;
      // oxirgi ~40 soniya qolganda keyingi tsikl oldindan chaqiriladi (u qulfni kutadi) — tsikllar orasida uzilish bo'lmasin
      if (!kicked && Date.now() - start > budget - 40000) await kickNext();
      const until = Math.min(start + budget, Date.now() + 25000);
      // ikki guruh bir vaqtda (Telegram limiti har guruh uchun alohida)
      const [no, nl] = await Promise.all([
        a.out ? outBackfillTick(until).catch((e) => (console.error(`stockbf out: ${errText(e)}`), 0)) : 0,
        a.low ? lowBackfillTick(until).catch((e) => (console.error(`stockbf low: ${errText(e)}`), 0)) : 0,
      ]);
      const n = no + nl;
      sent += n;
      if (!n) await sleep(Math.min(30000, Math.max(3000, a.pause - Date.now())));
    }
    if (!kicked && (await bfActive().then((a) => a.out || a.low))) {
      await db.unlock(LOOP).catch(() => {});
      await kickNext();
    }
  } finally {
    clearTimeout(timer);
    await db.unlock(LOOP).catch(() => {});
  }
  console.log(`stockbf: loop end, sent ${sent}, kicked ${kicked}`);
  return { sent, kicked };
}
