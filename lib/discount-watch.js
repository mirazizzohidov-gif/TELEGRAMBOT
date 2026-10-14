import { getProductById, getProductsPage, loadDiscounts, priceFor, productDiscountKey, productImage, productStock, toItem } from './bito.js';
import { isDiscountActive } from './discount.js';
import * as db from './store.js';
import { mapLimit } from './util.js';

const ITEM_IDS_MAX = 200;

const scanLimit = () => Number(process.env.DISCOUNT_SCAN_LIMIT) || 30;

// A discount is announced again when its value / type / last update changes.
export const discountSignature = (d) => `${d.apply_type}|${d.value}|${d.updated_at || ''}`;

// Products a discount covers: item_added_ids one by one (cached); for category / all-category
// discounts only the first DISCOUNT_SCAN_LIMIT products, to keep BITO calls low.
async function discountProducts(d) {
  const ids = (d.item_added_ids || []).slice(0, ITEM_IDS_MAX);
  const byId = (await mapLimit(ids, 5, (id) => getProductById(id).catch((e) => {
    console.error(`discount ${d._id}: product ${id} could not be loaded: ${e.message}`);
    return null;
  }))).filter(Boolean);
  const limit = scanLimit();
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
  const seen = new Set();
  return [...byId, ...broad.slice(0, limit)].filter((p) => p && !seen.has(String(p._id)) && seen.add(String(p._id)));
}

// Announces products that are on an active BITO discount, even if the bot never posted them before.
// Each (discount, product) pair is announced once; again if the discount changes; marks of ended
// discounts are removed.
export async function checkActiveDiscounts(settings, { deadline = Date.now() + 120000 } = {}) {
  const result = { active: 0, products: 0, announced: 0, channel: 0, story: 0, already: 0, skus: [], skipped: { noimage: 0, noprice: 0, nostock: 0 } };
  const all = await loadDiscounts();
  const active = all.filter((d) => isDiscountActive(d) && (!d.target_type || d.target_type === 'product'));
  result.active = active.length;
  await db.setStats({ active_discounts: active.length });

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
    if (Date.now() > deadline) break;
    const sig = discountSignature(d);
    const products = await discountProducts(d);
    result.products += products.length;
    await mapLimit(products, 5, async (p) => {
      if (Date.now() > deadline) return;
      const key = `${d._id}:${p._id}`;
      if (announced[key]?.sig === sig) {
        result.already++;
        return;
      }
      if (!productImage(p)) return void result.skipped.noimage++;
      if (productStock(p) <= 0) return void result.skipped.nostock++;
      const pr = await priceFor(p, all);
      if (!(pr.price > 0)) return void result.skipped.noprice++;
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
      result.announced++;
      result.skus.push(item.sku);
    });
  }
  await db.enqueue(channelItems);
  await db.enqueueStories(storyItems);
  result.channel = channelItems.length;
  result.story = storyItems.length;
  await db.incrStat('discount', result.announced);
  return result;
}
