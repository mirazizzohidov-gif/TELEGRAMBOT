export const clock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function adminIds() {
  return (process.env.ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const isAdmin = (userId) => userId != null && adminIds().includes(String(userId));

// Runs fn over items with at most `limit` in flight.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const errText = (e) => (e && e.message) || String(e);

export const chunk = (list, size) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

// fetch with a timeout (AbortSignal); the error says which URL timed out.
export async function fetchWithTimeout(url, init = {}, ms = 10000) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      throw Object.assign(new Error(`Timeout after ${ms} ms: ${String(url).split('?')[0].replace(/bot[^/]+/, 'bot***')}`), { code: 'ETIMEDOUT' });
    }
    throw e;
  }
}
