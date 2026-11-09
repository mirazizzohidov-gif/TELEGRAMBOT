// "📈 Post → sotuv": which kinds of channel posts bring sales. Channel posts of the last N days come from
// the post registry (lib/postreg.js, kept while "❌ SOTILDI" or "💲 Narx yangilash" is on); BITO sales of
// the same N days come from lib/sales.js. A product counts as "sotildi" when it sold at least once in that
// window — an estimate (a sale may come from the shop, not the post), good for comparing kinds of posts.

import { allPosts } from './postreg.js';
import { salesByItem } from './sales.js';
import { formatPrice } from './bito.js';

const DAY = 86400000;

export function postKind(e) {
  const it = e.item || {};
  if (e.ch2) return '📢 2-kanal';
  if (e.kind === 'date') return "📅 Sana bo'yicha";
  if (e.kind === 'helper') return '👥 Yordamchi';
  if (it.type === 'discount' || Number(it.old_price) > Number(it.price)) return '🔥 Chegirma';
  if (it.type === 'restock') return '🔄 Qayta keldi';
  if (it.fresh) return '🆕 Yangi';
  return "🎲 Random / qo'lda";
}

export async function postSales({ days = 7, top = 10 } = {}) {
  const n = Math.min(30, Math.max(1, Math.round(Number(days) || 7)));
  const since = Date.now() - n * DAY;
  const [reg, sales] = await Promise.all([allPosts(), salesByItem(n)]);
  const sold = new Map((sales?.rows || []).map((r) => [String(r.pid), r]));
  const groups = new Map();
  const products = [];
  for (const [pid, list] of Object.entries(reg || {})) {
    const recent = (Array.isArray(list) ? list : []).filter((e) => Number(e.at) >= since);
    if (!recent.length) continue;
    const kinds = new Set(recent.map(postKind));
    const s = sold.get(String(pid));
    const units = Number(s?.sold) || 0;
    const sum = Number(s?.net) || 0;
    const it = recent[recent.length - 1].item || {};
    products.push({ pid, sku: it.sku || null, name: it.name || s?.name || pid, kinds: [...kinds], units, sum });
    for (const k of kinds) {
      const g = groups.get(k) || { kind: k, posted: 0, sold: 0, units: 0, sum: 0 };
      g.posted++;
      if (units > 0) g.sold++;
      g.units += units;
      g.sum += sum;
      groups.set(k, g);
    }
  }
  const list = [...groups.values()]
    .map((g) => ({ ...g, rate: g.posted ? Math.round((g.sold / g.posted) * 100) : 0, sum_text: formatPrice(g.sum) }))
    .sort((a, b) => b.rate - a.rate || b.sum - a.sum);
  const posted = products.length;
  const soldN = products.filter((p) => p.units > 0).length;
  return {
    days: n,
    posted,
    sold: soldN,
    rate: posted ? Math.round((soldN / posted) * 100) : 0,
    units: products.reduce((a, p) => a + p.units, 0),
    sum_text: formatPrice(products.reduce((a, p) => a + p.sum, 0)),
    groups: list,
    top: products
      .filter((p) => p.units > 0)
      .sort((a, b) => b.sum - a.sum)
      .slice(0, top)
      .map((p) => ({ sku: p.sku, name: p.name, kinds: p.kinds, units: p.units, sum_text: formatPrice(p.sum) })),
    note: "Taxminiy: mahsulot shu kunlar ichida postlangan va shu kunlar ichida kamida 1 marta sotilgan.",
  };
}

// Plain text for the admin panel.
export function postSalesText(r) {
  const lines = [`📈 Post → sotuv (oxirgi ${r.days} kun)`, ''];
  if (!r.posted) {
    lines.push("Bu davrda ro'yxatga olingan kanal postlari yo'q (❌ SOTILDI yoki 💲 Narx yangilash yoqilgan bo'lishi kerak).");
    return lines.join('\n');
  }
  lines.push(`Postlangan mahsulotlar: ${r.posted} ta, sotilgani: ${r.sold} ta (${r.rate}%)`);
  lines.push(`Sotuv: ${r.units} dona, ${r.sum_text}`);
  lines.push('');
  for (const g of r.groups) lines.push(`${g.kind}: ${g.sold}/${g.posted} sotildi (${g.rate}%) · ${g.units} dona · ${g.sum_text}`);
  if (r.top.length) {
    lines.push('', '🏆 Eng ko\'p sotilganlar:');
    r.top.slice(0, 8).forEach((p, i) => lines.push(`${i + 1}. ${p.sku || ''} ${p.name} — ${p.units} dona, ${p.sum_text}`));
  }
  lines.push('', `ℹ️ ${r.note}`);
  return lines.join('\n');
}
