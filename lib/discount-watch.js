import { getProductById, getProductsPage, loadDiscounts, priceFor, productDiscountKey, productImage, productStock, toItem } from './bito.js';
import { isCustomerSpecific, isDiscountActive } from './discount.js';
import * as db from './store.js';
import { errText, mapLimit } from './util.js';

const ITEM_IDS_MAX = 200;

const scanLimit = () => Number(process.env.DISCOUNT_SCAN_LIMIT) || 30;

// A discount is announced again when its value / type / last update changes.
export const discountSignature = (d) => `${d.apply_type}|${d.value}|${d.updated_at || ''}`;

const SKIP_TEXT = { noimage: 'rasmsiz', noprice: 'narxsiz', nostock: 'qoldiq 0', already: "avval e'lon qilingan" };

// Products of a discount: [{ id, product } | { id, error }]. item_added_ids one by one (each in its own
// try/catch); category / all-category discounts only the first DISCOUNT_SCAN_LIMIT products.
async function discountProducts(d) {
  const ids = [...new Set((d.item_added_ids || []).map(String))].slice(0, ITEM_IDS_MAX);
  const entries = await mapLimit(ids, 5, async (id) => {
    try {
      return { id, product: await getProductById(id) };
    } catch (e) {
      return { id, error: errText(e) };
    }
  });
  const limit = scanLimit();
  try {
    const broad = [];
    if (d.is_all_categories) {
      broad.push(...(await getProductsPage({ page: 1, limit, sort: '-created_at' })).list);
    } else {
      const categories = [...new Set([...(d.category_ids || []), ...(d.nested_category_ids || [])].map(String))];
      for (const category_id of categories) {
        if (broad.length >= limit) break;
        broad.push(...(await getProductsPage({ page: 1, limit: limit - broad.length, category_id })).list);
      }
    }
    const known = new Set(ids);
    for (const p of broad.slice(0, limit)) {
      if (!known.has(String(p._id))) {
        known.add(String(p._id));
        entries.push({ id: String(p._id), product: p });
      }
    }
  } catch (e) {
    entries.push({ id: 'kategoriya', error: errText(e) });
  }
  return entries;
}

// Announces products on an active BITO discount — also ones the bot never posted. Each (discount, product)
// pair once; again if the discount changes; marks of ended discounts are removed. Every discount and
// product is handled on its own and logged; result.details has a line for each.
export async function checkActiveDiscounts(settings, { deadline = Date.now() + 120000 } = {}) {
  const result = {
    active: 0,
    products: 0,
    announced: 0,
    channel: 0,
    story: 0,
    already: 0,
    errors: 0,
    skus: [],
    skipped: { noimage: 0, noprice: 0, nostock: 0 },
    details: [],
  };
  const all = await loadDiscounts();
  const active = all.filter((d) => isDiscountActive(d) && (!d.target_type || d.target_type === 'product'));
  result.active = active.length;
  await db.setStats({ active_discounts: active.length });
  console.log(`active discounts: ${active.length} of ${all.length}`);

  const announced = await db.getAnnounced();
  const activeIds = new Set(active.map((d) => String(d._id)));
  await db.dropAnnounced(Object.keys(announced).filter((k) => !activeIds.has(k.split(':')[0])));

  // Nothing would be posted: do not mark, so switching a toggle on later still announces them.
  if (!settings.discount_channel && !settings.discount_story) {
    result.reason = 'discount channel and story are off';
    return result;
  }

  const channelItems = [];
  const storyItems = [];
  for (const d of active) {
    const detail = { id: String(d._id), name: d.name || '', products: [] };
    result.details.push(detail);
    const log = (pid, status) => {
      console.log(`discount ${d._id} product ${pid}: ${status}`);
    };
    if (Date.now() > deadline) {
      detail.note = "vaqt tugadi — keyingi tekshiruvda";
      console.log(`discount ${d._id}: not checked (time budget used up)`);
      continue;
    }
    if (isCustomerSpecific(d)) {
      detail.note = "faqat ma'lum mijozlar uchun — e'lon qilinmaydi";
      console.log(`discount ${d._id}: customer-specific, skipped`);
      continue;
    }
    try {
      const sig = discountSignature(d);
      const entries = await discountProducts(d);
      result.products += entries.filter((e) => e.product).length;
      if (!entries.length) {
        detail.note = "tegishli mahsulot topilmadi";
        console.log(`discount ${d._id}: no products`);
      }
      await mapLimit(entries, 5, async ({ id, product: p, error }) => {
        const row = { id, sku: p?.sku ? String(p.sku) : '' };
        detail.products.push(row);
        try {
          if (error) {
            row.status = 'error';
            row.reason = error;
            result.errors++;
            return log(id, `error: ${error}`);
          }
          if (Date.now() > deadline) {
            row.status = 'later';
            return log(id, 'later (time budget used up)');
          }
          const key = `${d._id}:${p._id}`;
          if (announced[key]?.sig === sig) {
            row.status = 'skipped';
            row.reason = 'already';
            result.already++;
            return log(id, 'skipped(already announced)');
          }
          let reason = null;
          let pr = null;
          if (!productImage(p)) reason = 'noimage';
          else if (productStock(p) <= 0) reason = 'nostock';
          else {
            pr = await priceFor(p, all);
            if (!(pr.price > 0)) reason = 'noprice';
          }
          if (reason) {
            row.status = 'skipped';
            row.reason = reason;
            result.skipped[reason]++;
            return log(id, `skipped(${reason})`);
          }
          const item = toItem(p, pr, 'discount', { discount_key: `bd:${d._id}:${sig}` });
          if (settings.discount_channel) channelItems.push(item);
          if (settings.discount_story) storyItems.push(item);
          // Track the product so the "price dropped" check does not announce the same discount again.
          const idsKey = productDiscountKey(p);
          await db.upsertProduct(item, {
            discount_ids_key: idsKey,
            discount_keys: [...(idsKey ? [`ids:${idsKey}`] : []), `price:${item.price}`],
          });
          await db.markAnnounced(key, { sig, sku: item.sku, at: Date.now() });
          row.status = 'posted';
          row.price = item.price;
          row.old_price = item.old_price;
          result.announced++;
          result.skus.push(item.sku);
          return log(id, `posted (sku ${item.sku}, ${item.old_price || item.price} -> ${item.price})`);
        } catch (e) {
          row.status = 'error';
          row.reason = errText(e);
          result.errors++;
          return log(id, `error: ${errText(e)}`);
        }
      });
    } catch (e) {
      detail.note = `xato: ${errText(e)}`;
      result.errors++;
      console.error(`discount ${d._id}: error: ${errText(e)}`, e.details || '');
    }
  }
  await db.enqueue(channelItems);
  await db.enqueueStories(storyItems);
  result.channel = channelItems.length;
  result.story = storyItems.length;
  await db.incrStat('discount', result.announced);
  return result;
}

// Admin text: one block per discount with the state of each product.
export function discountDetailsText(result, esc = (t) => t) {
  const lines = [];
  for (const d of result.details) {
    lines.push(`• <b>${esc(d.name || 'chegirma')}</b> (${d.id.slice(-6)})${d.note ? ` — ${esc(d.note)}` : ''}`);
    for (const p of d.products) {
      const who = p.sku ? `SKU ${esc(p.sku)}` : `ID ${esc(p.id)}`;
      if (p.status === 'posted') lines.push(`   ✅ ${who}: e'lon qilindi`);
      else if (p.status === 'skipped') lines.push(`   ⏭ ${who}: o'tkazildi — ${SKIP_TEXT[p.reason] || p.reason}`);
      else if (p.status === 'later') lines.push(`   ⏳ ${who}: keyingi tekshiruvda`);
      else lines.push(`   ❌ ${who}: ${esc(String(p.reason).slice(0, 200))}`);
    }
  }
  return lines;
}
