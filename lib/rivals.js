// "🏷 Raqobatchilar narxi": the owner adds links to the same product in other shops (Uzum Market, other
// web shops) next to our SKU. Once a day (after 11:00 Tashkent) the bot reads each page's price
// (schema.org JSON-LD "offers.price", product meta tags or the Uzum "sellPrice" field) and compares it
// with our BITO price (with discounts). Cheaper than us -> a message to the owner. Up to 40 links.
import { channel2Owner } from './channel2.js';
import { findBySku, formatPrice, loadDiscounts, priceFor } from './bito.js';
import * as db from './store.js';
import { tg } from './telegram.js';
import { errText, fetchWithTimeout } from './util.js';

const LIST = () => db.K.flag('rivals:list'); // [{ id, sku, url, label }]
const RES = () => db.K.flag('rivals:res'); // hash id -> { price, ours, at, error, name }
const MAX = 40;
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r = () => db.redis();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.,]/g, '').replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

// The lowest offer price found on a product page, or null.
export function extractPrice(html) {
  const found = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (o) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        for (const k of ['price', 'lowPrice']) if (o[k] != null && /offer/i.test(String(o['@type'] || ''))) found.push(num(o[k]));
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(m[1].trim()));
    } catch {}
  }
  for (const m of html.matchAll(/<meta[^>]+(?:property|name|itemprop)=["'](?:product:price:amount|og:price:amount|price)["'][^>]*content=["']([^"']+)["']/gi)) found.push(num(m[1]));
  for (const m of html.matchAll(/"sellPrice"\s*:\s*"?(\d+(?:\.\d+)?)/g)) found.push(num(m[1]));
  const ok = found.filter((x) => x && x >= 100 && x < 1e9);
  return ok.length ? Math.min(...ok) : null;
}

async function pagePrice(url) {
  const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ru,uz;q=0.9' } }, 20000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = (await res.text()).slice(0, 3_000_000);
  const price = extractPrice(html);
  if (!price) throw new Error("sahifada narx topilmadi");
  return price;
}

async function ourPrice(sku, discounts) {
  const p = await findBySku(String(sku)).catch(() => null);
  if (!p) return null;
  const pr = await priceFor(p, discounts);
  return pr.price > 0 ? { price: pr.price, name: p.name } : null;
}

export async function rivalsCheck({ notify = true, deadline = Date.now() + 50000 } = {}) {
  const list = (await r().get(LIST())) || [];
  if (!list.length) return { checked: 0, cheaper: [] };
  const discounts = await loadDiscounts().catch(() => []);
  const cheaper = [];
  let checked = 0;
  for (const x of list) {
    if (Date.now() > deadline) break;
    const prev = (await r().hget(RES(), x.id)) || {};
    try {
      const [price, ours] = await Promise.all([pagePrice(x.url), ourPrice(x.sku, discounts)]);
      const rec = { price, ours: ours?.price || null, name: ours?.name || prev.name || '', at: Date.now(), error: null };
      await r().hset(RES(), { [x.id]: rec });
      if (rec.ours && price < rec.ours) cheaper.push({ ...x, ...rec });
    } catch (e) {
      await r().hset(RES(), { [x.id]: { ...prev, at: Date.now(), error: errText(e).slice(0, 120) } });
    }
    checked++;
  }
  if (notify && cheaper.length) {
    const lines = ['🏷 <b>Raqobatchilar arzonroq sotyapti</b>', ''];
    for (const c of cheaper) lines.push(`• <b>${esc(c.name || c.sku)}</b> (SKU ${esc(c.sku)})\n   Biz: ${formatPrice(c.ours)} so'm → ${esc(c.label || new URL(c.url).hostname)}: <a href="${esc(c.url)}">${formatPrice(c.price)} so'm</a> (−${Math.round((1 - c.price / c.ours) * 100)}%)`);
    await tg('sendMessage', { chat_id: channel2Owner(), text: lines.join('\n').slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true }).catch((e) => console.error(`rivals notify: ${errText(e)}`));
  }
  return { checked, cheaper };
}

export async function rivalsTick(s, now = Date.now()) {
  if (!db.hasRedis() || s?.rivals_on === false) return null;
  const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  if (local.getHours() < 11) return null;
  if (!(await db.once(`rivals:${db.today(now)}`, 60 * 60 * 26))) return null;
  return rivalsCheck();
}

export async function rivalsView() {
  const [list, res] = await Promise.all([r().get(LIST()).catch(() => null), r().hgetall(RES()).catch(() => null)]);
  return { ok: true, items: (list || []).map((x) => ({ ...x, ...((res || {})[x.id] || {}) })) };
}

export async function rivalsAdd({ sku, url, label } = {}) {
  sku = String(sku || '').trim();
  url = String(url || '').trim();
  if (!sku) return { ok: false, message: 'SKU kiriting' };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, message: "Havola noto'g'ri" };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, message: "Havola noto'g'ri" };
  const list = (await r().get(LIST())) || [];
  if (list.length >= MAX) return { ok: false, message: `Ko'pi bilan ${MAX} ta havola` };
  if (list.some((x) => x.url === u.href)) return { ok: false, message: "Bu havola allaqachon bor" };
  const p = await findBySku(sku).catch(() => null);
  if (!p) return { ok: false, message: `BITO'da SKU ${sku} topilmadi` };
  const id = Date.now().toString(36);
  list.push({ id, sku, url: u.href, label: String(label || u.hostname.replace(/^www\./, '')).slice(0, 40) });
  await r().set(LIST(), list);
  // the first price at once
  try {
    const discounts = await loadDiscounts().catch(() => []);
    const [price, ours] = await Promise.all([pagePrice(u.href), ourPrice(sku, discounts)]);
    await r().hset(RES(), { [id]: { price, ours: ours?.price || null, name: ours?.name || p.name, at: Date.now(), error: null } });
    return { ok: true, message: `✅ Qo'shildi: ${p.name} — ular ${formatPrice(price)} so'm, biz ${ours ? formatPrice(ours.price) : '—'} so'm` };
  } catch (e) {
    await r().hset(RES(), { [id]: { name: p.name, at: Date.now(), error: errText(e).slice(0, 120) } });
    return { ok: true, message: `✅ Qo'shildi (${p.name}), lekin narx o'qilmadi: ${errText(e).slice(0, 100)}` };
  }
}

export async function rivalsDel(id) {
  const list = ((await r().get(LIST())) || []).filter((x) => x.id !== String(id));
  await r().set(LIST(), list);
  await r().hdel(RES(), String(id)).catch(() => {});
  return { ok: true, message: "🗑 O'chirildi" };
}
