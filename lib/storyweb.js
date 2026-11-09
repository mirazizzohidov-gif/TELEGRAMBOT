// "📋 Istoriya navbati" on the dashboard: every waiting story with its photo, in the order the bot will post
// them, and "🚀 Hozir chiqarish" — posts one chosen story right now, before its slot (api/dashboard.js).

import { createHash } from 'node:crypto';
import { processStoryQueue } from './poster.js';
import * as db from './store.js';

const MAX = 1000;
const POST_BUDGET_MS = 100000;

export const storyId = (e) => createHash('sha1').update(JSON.stringify(e)).digest('hex').slice(0, 16);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// the order processStoryQueue uses: discounts, then low stock, then the rest — oldest first in each
function sorted(s, all) {
  const lowAt = db.limit(s, 'low_stock_threshold');
  const prio = (e) => (e.type === 'discount' || Number(e.old_price) > Number(e.price) ? 0 : Number(e.stock) > 0 && Number(e.stock) <= lowAt ? 1 : 2);
  return [...all].sort((a, b) => prio(a) - prio(b));
}

const kindOf = (s, e) => {
  if (e.type === 'discount' || Number(e.old_price) > Number(e.price)) return 'discount';
  if (e.type === 'restock') return 'restock';
  const st = Number(e.stock);
  if (st > 0 && st <= db.limit(s, 'low_stock_threshold')) return 'low';
  return 'new';
};

export async function storyQueueItems() {
  const s = await db.getSettings();
  const all = sorted(s, (await db.readStoryQueue()) || []).filter((e) => e && typeof e === 'object');
  const profiles = db.storyProfiles(s, await db.listBiz().catch(() => []));
  const label = Object.fromEntries(profiles.map((p) => [p.id, p.label]));
  return {
    total: all.length,
    profiles: profiles.map((p) => p.label),
    items: all.slice(0, MAX).map((e, i) => ({
      id: storyId(e),
      pos: i + 1,
      sku: e.sku ?? null,
      name: e.name ?? '',
      image: e.image_url || null,
      price: num(e.price),
      old_price: num(e.old_price),
      stock: num(e.stock),
      kind: kindOf(s, e),
      profile: e.bc ? label[e.bc] || e.bc : null,
    })),
  };
}

// Posts one story now. { ok, message }
export async function storyNow(id) {
  if (!/^[0-9a-f]{16}$/.test(String(id || ''))) return { ok: false, message: "Noto'g'ri mahsulot" };
  if (!(await db.lock('tick', 300))) {
    return { ok: false, busy: true, message: "Bot hozir navbatni ishlayapti — 1 daqiqadan keyin qayta bosing" };
  }
  try {
    const s = await db.getSettings();
    const r = await processStoryQueue(s, Date.now() + POST_BUDGET_MS, { maxItems: 1, pick: (e) => storyId(e) === id });
    if (r.reason === 'not found') return { ok: false, gone: true, message: "Bu mahsulot navbatda yo'q (allaqachon chiqqan bo'lishi mumkin)" };
    if (r.reason === 'no business profile') return { ok: false, message: "Istoriya profili ulanmagan" };
    const posted = (r.new || 0) + (r.discount || 0);
    if (posted > 0) return { ok: true, posted, waiting: r.waiting, message: `✅ Istoriyaga chiqdi (${posted} ta profil)` };
    const why = (r.lines || []).join(' · ').replace(/<[^>]+>/g, '') || (r.dropped ? "Istoriya sozlamasi o'chirilgan — navbatdan olib tashlandi" : 'Hozir chiqmadi (kunlik limit yoki vaqt) — navbatda qoldi');
    return { ok: false, waiting: r.waiting, message: why };
  } finally {
    await db.unlock('tick');
  }
}
