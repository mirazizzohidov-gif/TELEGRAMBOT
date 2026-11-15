// AI avto-javob uchun ALOHIDA BITO ulanishi: API kalit va narx ro'yxati ID dashboard'dan kiritiladi
// (Redis'da saqlanadi), Vercel env'dan o'qilmaydi. Barcha AI javoblari (bot va Business profillar) shuni ishlatadi.
// Sozlanmagan bo'lsa AI BITO ma'lumotisiz javob beradi (narx va qoldiq aytilmaydi).
import { bestDiscount } from './discount.js';
import { formatPrice, imageUrl, productImage, productStock } from './bito.js';
import * as db from './store.js';
import { fetchWithTimeout } from './util.js';

const API_URL = 'https://api.bito.uz/integration-api/integration/api/v2';
const KEY = () => db.K.flag('ai:bito');
const TIMEOUT = 15000;
let discCache = { at: 0, list: [] };

export async function bitoCfg() {
  return db.hasRedis() ? (await db.redis().get(KEY()).catch(() => null)) || {} : {};
}

export async function bitoView() {
  const c = await bitoCfg();
  return { key: c.key ? `••••${String(c.key).slice(-4)}` : '', price_id: c.price_id || '', ready: Boolean(c.key && c.price_id) };
}

// body: { key, price_id } — bo'sh: o'zgarmaydi; key "-": o'chirish
export async function bitoSet(body = {}) {
  const c = { ...(await bitoCfg()) };
  const key = body.key == null ? '' : String(body.key).trim();
  if (key === '-') delete c.key;
  else if (key) {
    if (key.length < 10 || key.length > 300 || /\s/.test(key)) return { ok: false, message: "❌ BITO kaliti noto'g'ri ko'rinadi" };
    c.key = key;
  }
  if (body.price_id != null && String(body.price_id).trim() !== '') c.price_id = String(body.price_id).trim().slice(0, 100);
  await db.redis().set(KEY(), c);
  discCache = { at: 0, list: [] };
  return { ok: true, message: '💾 BITO sozlamasi saqlandi', bito: await bitoView() };
}

async function call(cfg, path, payload) {
  const r = await fetchWithTimeout(`${API_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'api-key': cfg.key }, body: JSON.stringify(payload) }, TIMEOUT);
  const text = await r.text().catch(() => '');
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {}
  if (!j || String(j.code) !== '0') {
    const why = j ? `kod ${j.code ?? '—'}${j.message ? `: ${typeof j.message === 'string' ? j.message : JSON.stringify(j.message)}` : ''}` : text.replace(/\s+/g, ' ').slice(0, 160) || 'bo\'sh javob';
    throw new Error(`BITO ${path}: HTTP ${r.status}, ${why}`);
  }
  return j.data;
}
const listOf = (d) => (Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : []);

async function discounts(cfg) {
  if (Date.now() - discCache.at < 10 * 60 * 1000) return discCache.list;
  const list = await call(cfg, '/discount/get-all', {}).then(listOf).catch(() => call(cfg, '/discount/get-paging', { page: 1, limit: 200 }).then(listOf).catch(() => []));
  discCache = { at: Date.now(), list };
  return list;
}

// "🧪 Tekshirish": kalit ishlaydimi, narx ro'yxati topiladimi
export async function bitoCheck() {
  const cfg = await bitoCfg();
  if (!cfg.key || !cfg.price_id) return { ok: false, message: '❌ BITO kaliti va narx ro\'yxati ID kiritilmagan' };
  try {
    const d = await call(cfg, '/product/get-paging', { page: 1, limit: 1 });
    const p = listOf(d)[0];
    const price = p ? listOf(await call(cfg, '/price/items/get-paging', { page: 1, limit: 5, price_id: cfg.price_id, product_id: p._id })) : [];
    return { ok: true, message: `✅ BITO ishlayapti: ${Number(d?.total) || 0} ta mahsulot${p ? `; «${p.name}» narxi ${price[0] ? formatPrice(Number(price[0].amount)) + " so'm" : "narx ro'yxatida topilmadi — price_id'ni tekshiring"}` : ''}` };
  } catch (e) {
    return { ok: false, message: `❌ ${e.message}` };
  }
}

// AI uchun mahsulot faktlari (matn). Sozlanmagan yoki xato: ''.
export async function productFacts(question, meta = null) {
  const cfg = await bitoCfg();
  if (!cfg.key || !cfg.price_id) return '';
  try {
    const STOP = new Set(['bormi','bor','narxi','narx','qancha','necha','nechpul','nech','pul','qoldi','qoldiq','kerak','menga','iltimos','salom','qanaqa','nima','qaysi','bo\'lsa','boladimi','mavjud','sotuvda','цена','сколько','есть','почем','стоит','нужен','нужна']);
    const words = [...new Set(String(question || '').toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, ' ').split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
    let found = [];
    for (const q of [words.join(' '), ...words].filter(Boolean)) {
      found = listOf(await call(cfg, '/product/get-paging', { page: 1, limit: 20, search: q })).filter((p) => p.name).slice(0, 3);
      if (found.length) break;
    }
    if (!found.length) return '';
    if (meta) meta.image = imageUrl(productImage(found[0]));
    const disc = await discounts(cfg);
    const lines = [];
    for (const p of found) {
      const item = listOf(await call(cfg, '/price/items/get-paging', { page: 1, limit: 30, price_id: cfg.price_id, product_id: p._id }).catch(() => null)).find((i) => (i.product?._id || i.product_id) === p._id);
      const amount = item ? Number(item.amount) : 0;
      const best = amount > 0 ? bestDiscount(amount, p, disc) : null;
      const price = amount > 0 ? (best ? `${formatPrice(best.price)} so'm (chegirma bilan; avval ${formatPrice(amount)} so'm)` : `${formatPrice(amount)} so'm`) : 'narxi operatorda';
      lines.push(`- ${p.name}: ${price}; ${productStock(p) > 0 ? 'sotuvda bor' : 'hozir tugagan'}`);
    }
    return lines.join('\n');
  } catch (e) {
    console.error(`chatbito: ${e.message}`);
    return '';
  }
}
