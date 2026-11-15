// Dashboard "❌ Tugaganlar" → "⚙️ Ogohlantirishlar": tugagan / qayta keldi / hisobot / kam qolgan xabarlari qaysi
// guruh yoki kanalga borishi (bot a'zo bo'lgan guruhlar va kanallar ro'yxatidan), kam qolgan chegarasi va
// kam qolgan mahsulotlar katalog (kategoriya) bo'yicha.
import { categoryStats } from './stock.js';
import { soldItems } from './soldweb.js';
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
  return {
    ok: true,
    routes: { main: String(s.stock_group || ''), out: String(s.stock_out_group || ''), back: String(s.stock_back_group || ''), report: String(s.stock_report_group || ''), low: String(s.stock_low_group || '') },
    low_on: s.stock_low_on !== false,
    threshold: db.limit(s, 'low_stock_threshold'),
    targets: await targets(),
  };
}

// «⚠️ Ogohlantirishlar» ro'yxati: kam qolgan va tugagan mahsulotlar (rasm, SKU, qoldiq, asosiy kategoriya)
export async function warnListView(s) {
  const threshold = db.limit(s, 'low_stock_threshold');
  const all = (await db.redis().hgetall(db.K.stock)) || {};
  let nodes = null;
  let error = null;
  try {
    nodes = (await categoryStats(s)).nodes;
  } catch (e) {
    error = errText(e);
  }
  const rootOf = (r) => {
    let n = r.cat && nodes ? nodes.get(r.cat) : null;
    for (let i = 0; n && n.parent && nodes.get(n.parent) && i < 10; i++) n = nodes.get(n.parent);
    return n?.name || r.catn || 'Kategoriyasiz';
  };
  const items = [];
  // ❌ Tugadi — «Tugaganlar» tabidagi «Do'kon» ro'yxati bilan bir xil manba (bir xil son)
  try {
    for (const x of (await soldItems('shop')).items) {
      const r = all[x.pid] || {};
      items.push({ pid: x.pid, n: x.name || '—', s: x.sku ?? '', img: x.image || r.img || '', q: 0, p: Number(r.price) || 0, root: x.category || 'Kategoriyasiz', leaf: x.leaf || '', o: x.out_at || 0, out: true });
    }
  } catch (e) {
    error = errText(e);
    for (const [pid, r] of Object.entries(all)) if (!(r.stock > 0)) items.push({ pid, n: r.name || '—', s: r.sku ?? '', img: r.img || '', q: 0, p: Number(r.price) || 0, root: rootOf(r), leaf: r.catn || '', o: r.out_at || 0, out: true });
  }
  // ⚠️ Kam qoldi — oddiy chegara: 1 dan «chegara» donagacha (qizil/sariq chiziqlar hisobga olinmaydi)
  for (const [pid, r] of Object.entries(all)) {
    if (!(r.stock > 0 && r.stock <= threshold)) continue;
    items.push({ pid, n: r.name || '—', s: r.sku ?? '', img: r.img || '', q: Number(r.stock) || 0, p: Number(r.price) || 0, root: rootOf(r), leaf: r.catn || '', o: 0, out: false });
  }
  return { ok: true, items, threshold, error };
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
