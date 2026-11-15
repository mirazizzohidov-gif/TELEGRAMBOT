// "📈 Statistika → 💰 Post → sotuv (tarmoqlar)": which network's posts are followed by BITO sales.
// Every successful publish (Instagram, Facebook, Threads, Pinterest, YouTube, TikTok) logs the products
// it showed; the products sold in the same days (lib/sales.js) are matched by product id. An estimate:
// the sale may have come from the shop, not the post — good for comparing networks with each other.
import { formatPrice } from './bito.js';
import { salesByItem } from './sales.js';
import * as db from './store.js';

const LOG = () => db.K.flag('socpost:log');
const MAX = 4000;
const DAY = 86400000;
export const SOC_NETS = { ig: '📸 Instagram', fb: '📘 Facebook', th: '🧵 Threads', pin: '📌 Pinterest', yt: '▶️ YouTube', tt: '🎵 TikTok' };

// net: ig | fb | th | pin | yt | tt; items: product objects ({ product_id | pid, name, sku })
export async function socLog(net, items) {
  if (!db.hasRedis()) return;
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  const p = [...new Set(list.map((it) => String(it.product_id || it.pid || '')).filter(Boolean))].slice(0, 10);
  if (!p.length) return;
  const n = list.map((it) => String(it.name || '').slice(0, 60));
  await db.redis().lpush(LOG(), { n: net, p, names: n, at: Date.now() });
  await db.redis().ltrim(LOG(), 0, MAX - 1);
}

export async function socSales({ days = 7, top = 10 } = {}) {
  const d = Math.min(30, Math.max(1, Math.round(Number(days) || 7)));
  const since = Date.now() - d * DAY;
  const [log, sales] = await Promise.all([db.redis().lrange(LOG(), 0, MAX - 1).catch(() => []), salesByItem(d)]);
  const sold = new Map((sales?.rows || []).map((r) => [String(r.pid), r]));
  const byNet = new Map();
  const prod = new Map();
  for (const e of log || []) {
    if (!e || Number(e.at) < since || !SOC_NETS[e.n]) continue;
    const g = byNet.get(e.n) || { net: e.n, label: SOC_NETS[e.n], posts: 0, pids: new Set() };
    g.posts++;
    e.p.forEach((pid, i) => {
      g.pids.add(pid);
      const x = prod.get(pid) || { pid, name: e.names?.[i] || pid, nets: new Set() };
      x.nets.add(e.n);
      prod.set(pid, x);
    });
    byNet.set(e.n, g);
  }
  const nets = [...byNet.values()].map((g) => {
    let soldN = 0;
    let units = 0;
    let sum = 0;
    for (const pid of g.pids) {
      const s = sold.get(pid);
      if (Number(s?.sold) > 0) {
        soldN++;
        units += Number(s.sold) || 0;
        sum += Number(s.net) || 0;
      }
    }
    return { net: g.net, label: g.label, posts: g.posts, products: g.pids.size, sold: soldN, rate: g.pids.size ? Math.round((soldN / g.pids.size) * 100) : 0, units, sum, sum_text: formatPrice(sum) };
  }).sort((a, b) => b.rate - a.rate || b.sum - a.sum);
  const all = [...prod.values()].map((x) => {
    const s = sold.get(x.pid);
    return { name: s?.name || x.name, nets: [...x.nets], units: Number(s?.sold) || 0, sum: Number(s?.net) || 0 };
  });
  const soldAll = all.filter((x) => x.units > 0);
  return {
    ok: true,
    days: d,
    products: all.length,
    sold: soldAll.length,
    rate: all.length ? Math.round((soldAll.length / all.length) * 100) : 0,
    sum_text: formatPrice(soldAll.reduce((a, x) => a + x.sum, 0)),
    nets,
    top: soldAll.sort((a, b) => b.sum - a.sum).slice(0, top).map((x) => ({ ...x, sum_text: formatPrice(x.sum) })),
    note: 'Taxminiy: mahsulot shu kunlarda tarmoqqa chiqqan va shu kunlarda kamida 1 marta sotilgan.',
  };
}
