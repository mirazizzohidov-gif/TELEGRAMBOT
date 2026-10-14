import { waitUntil } from '@vercel/functions';

// Work that continues after the HTTP response (webhook answers Telegram fast, the job keeps running).
// On Vercel, waitUntil keeps the function alive until the promise settles.
const pending = new Set();

export function runInBackground(promise) {
  const p = Promise.resolve(promise).catch((e) => console.error('background task failed:', e));
  pending.add(p);
  p.finally(() => pending.delete(p));
  waitUntil(p);
  return p;
}

// Tests / local runs: wait for all background work.
export async function drainBackground() {
  while (pending.size) {
    await Promise.all([...pending]);
  }
}
