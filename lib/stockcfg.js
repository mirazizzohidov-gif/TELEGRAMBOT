// Dashboard "❌ Tugaganlar" → "⚙️ Ogohlantirishlar": tugagan / qayta keldi / hisobot / kam qolgan xabarlari qaysi
// guruh yoki kanalga borishi (bot a'zo bo'lgan guruhlar va kanallar ro'yxatidan), kam qolgan chegarasi va
// kam qolgan mahsulotlar katalog (kategoriya) bo'yicha.
import { categoryStats, isLowRecord } from './stock.js';
import * as db from './store.js';
import { errText } from './util.js';

const FIELDS = { out: 'stock_out_group', back: 'stock_back_group', report: 'stock_report_group', low: 'stock_low_group' };

async function targets() {
  const [groups, channels] = await Promise.all([db.listGroups().catch(() => []), db.listKnownChannels().catch(() => [])]);
  const seen = new Set();
  const out = [];
  for (const g of [...groups, ...channels]) {
    const id = String(g.id);
    if (seen.has(id) || g.status === 'left' || g.status === 'kicked') continue;
    seen.add(id);
    out.push({ id, title: g.title || (g.username ? `@${g.username}` : id), type: g.type === 'channel' || channels.includes(g) ? 'kanal' : 'guruh' });
  }
  return out;
}

export async function stockCfgView(s) {
  const threshold = db.limit(s, 'low_stock_threshold');
  let cats = [];
  let error = null;
  try {
    const st = await categoryStats(s);
    cats = st.rows
      .filter((n) => n.l > 0 || n.o > 0)
      .sort((a, b) => b.l - a.l || b.o - a.o)
      .slice(0, 40)
      .map((n) => ({
        name: n.name,
        total: n.total,
        o: n.o,
        l: n.l,
        items: (n.all || []).filter((r) => isLowRecord(r, threshold)).sort((a, b) => a.stock - b.stock).slice(0, 40).map((r) => ({ n: r.name, s: r.sku, q: r.stock })),
      }));
  } catch (e) {
    error = errText(e);
  }
  return {
    ok: true,
    routes: { main: String(s.stock_group || ''), out: String(s.stock_out_group || ''), back: String(s.stock_back_group || ''), report: String(s.stock_report_group || ''), low: String(s.stock_low_group || '') },
    low_on: s.stock_low_on !== false,
    threshold,
    targets: await targets(),
    cats,
    error,
  };
}

// body: { out, back, report, low (chat id yoki '' = asosiy / o'chiq), low_on, threshold }
export async function stockCfgSet(body = {}) {
  const known = new Set((await targets()).map((t) => t.id));
  const patch = {};
  for (const [k, field] of Object.entries(FIELDS)) {
    if (!(k in body)) continue;
    const v = String(body[k] ?? '').trim();
    if (v && !known.has(v)) return { ok: false, message: `❌ «${k}»: bu guruh/kanal ro'yxatda yo'q (bot unga qo'shilgan bo'lishi kerak)` };
    patch[field] = v;
  }
  if ('low_on' in body) patch.stock_low_on = Boolean(body.low_on);
  if (body.threshold != null && body.threshold !== '') {
    const n = Math.round(Number(body.threshold));
    if (!Number.isFinite(n) || n < 0 || n > 1000) return { ok: false, message: '❌ Chegara 0–1000 oralig\'ida bo\'lsin' };
    patch.low_stock_threshold = n;
  }
  const s = await db.updateSettings(patch);
  return { ok: true, message: s.stock_low_group && s.stock_low_on !== false ? '✅ Saqlandi. «Kam qoldi» xabarlari yoqilgan' : '✅ Saqlandi' };
}
