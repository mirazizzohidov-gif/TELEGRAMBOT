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

// Category of a product. BITO sends it in different shapes (an object, a bare id, category_id, an array
// of categories / ids); the last array element is taken (the deepest one when it is a path).
export function productCategory(p) {
  const pick = (v) => {
    if (v == null || v === '') return null;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) {
        const r = pick(v[i]);
        if (r) return r;
      }
      return null;
    }
    if (typeof v === 'object') {
      const id = v._id ?? v.id ?? v.category_id;
      return id ? { id: String(id), name: v.name || null } : null;
    }
    return { id: String(v), name: null };
  };
  const named = (r) => (r && !r.name && p.category_name ? { ...r, name: p.category_name } : r);
  return named(pick(p.category) || pick(p.category_id) || pick(p.categoryId) || pick(p.categories) || pick(p.category_ids) || pick(p.main_category));
}

// Category-related fields of a raw product (for the SKU card, to check BITO's format).
export const categoryFields = (p) =>
  Object.entries(p || {})
    .filter(([k]) => /categ/i.test(k))
    .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 120)}`)
    .join(', ');
