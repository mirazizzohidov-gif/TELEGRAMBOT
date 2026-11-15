// "⏳ Oxirgi dona" story: products with only 1–2 left in stock get a story "Oxirgi 2 dona qoldi!" on the
// business profiles (through the "📋 Istoriya navbati" pace queue), so the last units sell faster.
// Once a day after 12:00 (Tashkent), up to `per_day` products; one product at most once in `gap_days`.
// settings.lastunits = { on, max_left, per_day, gap_days } (dashboard "📸 Istoriya navbati").
import { getProductById, loadDiscounts, priceFor, productImage, productStock, toItem } from './bito.js';
import { lowRecords } from './stock.js';
import * as db from './store.js';
import { errText } from './util.js';

export const LAST_DEFAULTS = { on: false, max_left: 2, per_day: 3, gap_days: 14 };
export const lastCfg = (s) => ({ ...LAST_DEFAULTS, ...(s?.lastunits || {}) });
const ST = () => db.K.flag('lastunits:st');

export async function lastUnitsTick(s, now = Date.now(), { force = false } = {}) {
  const cfg = lastCfg(s);
  if (!db.hasRedis() || (!cfg.on && !force)) return null;
  const local = new Date(new Date(now).toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  if (!force && local.getHours() < 12) return null;
  if (!force && !(await db.once(`lastunits:${db.today(now)}`, 60 * 60 * 26))) return null;
  const low = (await lowRecords({ ...s, low_stock_threshold: cfg.max_left }).catch(() => [])).filter((x) => x.stock > 0 && x.stock <= cfg.max_left);
  const discounts = await loadDiscounts().catch(() => []);
  const items = [];
  for (const { pid } of low) {
    if (items.length >= cfg.per_day) break;
    if (await db.redis().get(db.K.flag(`lastunits:p:${pid}`))) continue;
    try {
      const p = await getProductById(pid);
      const left = productStock(p);
      if (!p || left <= 0 || left > cfg.max_left || !productImage(p)) continue;
      const pr = await priceFor(p, discounts);
      if (!(pr.price > 0)) continue;
      items.push(toItem(p, pr, 'last', { force: true }));
      await db.redis().set(db.K.flag(`lastunits:p:${pid}`), 1, { ex: cfg.gap_days * 86400 });
    } catch (e) {
      console.error(`lastunits ${pid}: ${errText(e)}`);
    }
  }
  if (items.length) await db.enqueueStories(items);
  await db.incrStat('lastunits', items.length).catch(() => {});
  await db.redis().set(ST(), { at: now, n: items.length, names: items.map((i) => i.name).slice(0, 5) }, { ex: 30 * 86400 }).catch(() => {});
  return { queued: items.length };
}

export async function lastView(s) {
  return { ok: true, cfg: lastCfg(s), last: await db.redis().get(ST()).catch(() => null) };
}

export async function lastSetCfg(body = {}) {
  const cur = lastCfg(await db.getSettings());
  const n = (v, d, lo, hi) => (v == null || v === '' ? d : Math.min(hi, Math.max(lo, Math.round(Number(v) || d))));
  const next = { on: 'on' in body ? Boolean(body.on) : cur.on, max_left: n(body.max_left, cur.max_left, 1, 5), per_day: n(body.per_day, cur.per_day, 1, 10), gap_days: n(body.gap_days, cur.gap_days, 1, 60) };
  await db.updateSettings({ lastunits: next });
  return { ok: true, cfg: next, message: next.on ? `✅ Har kuni 12:00 dan keyin ${next.per_day} tagacha «Oxirgi dona» istoriyasi` : "⏸ «Oxirgi dona» o'chirildi" };
}

// "🚀 Hozir" button
export async function lastNow() {
  const r = await lastUnitsTick(await db.getSettings(), Date.now(), { force: true });
  return { ok: true, message: r?.queued ? `✅ ${r.queued} ta mahsulot istoriya navbatiga qo'yildi` : "Hozir 1–2 dona qolgan (rasmli, narxli) yangi mahsulot topilmadi" };
}
