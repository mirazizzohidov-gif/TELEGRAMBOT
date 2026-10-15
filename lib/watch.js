import {
  findBySku,
  loadDiscounts,
  priceFor,
  findProductsSince,
  productDiscountKey,
  productImage,
  productStock,
  toItem,
} from './bito.js';
import { claimRestock } from './restock.js';
import { observeMany } from './stock.js';
import * as db from './store.js';
import { mapLimit } from './util.js';

const FIRST_RUN_WINDOW_MS = 15 * 60 * 1000;
// Products often get their price/photo/stock a bit after creation, so recent ones are re-checked.
const LOOKBACK_MS = 2 * 60 * 60 * 1000;
export const CHECK_BATCH = 50;

const idsDiscountKey = (idsKey) => `ids:${idsKey}`;

// Finds products added to BITO since the last check, filters them and queues them for channel/story.
export async function detectNew(settings, { now = Date.now(), deadline = now + 120000 } = {}) {
  const day = db.today(now);
  const watch = (await db.getWatch()) || { floor: now - FIRST_RUN_WINDOW_MS };
  const from = Math.max(watch.floor, (watch.last_checked_at ?? now) - LOOKBACK_MS);
  const products = await findProductsSince(from);
  if (settings.stock_group) await observeMany(products, settings); // stock history for the stock group
  const discounts = products.length ? await loadDiscounts() : [];
  const skipped = { noimage: 0, noprice: 0, nostock: 0, dup: 0 };
  const items = [];
  let complete = true;

  await mapLimit(products, 5, async (p) => {
    if (Date.now() > deadline) {
      complete = false;
      return;
    }
    const rec = await db.getSent(p.sku);
    if (rec && rec.product_id === p._id) {
      return; // already handled
    }
    let reason = null;
    let amount = null;
    if (!productImage(p)) {
      reason = 'noimage';
    } else if (rec) {
      reason = 'dup'; // same SKU was already sent for another product
    } else if (productStock(p) <= 0) {
      reason = 'nostock';
    } else {
      amount = await priceFor(p, discounts);
      if (!(amount.price > 0)) {
        reason = 'noprice';
      }
    }
    if (reason) {
      skipped[reason]++;
      await db.markSeen(p.sku, reason, day);
      return;
    }
    items.push(toItem(p, amount));
  });

  items.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  for (const item of items) {
    const key = item.discount_ids_key;
    // A discount the product already had when it appeared is not a "new" discount.
    await db.upsertProduct(item, { discount_keys: key ? [idsDiscountKey(key)] : [] }, day);
    await db.markSeen(item.sku, 'ok', day);
  }
  const forChannel = settings.new_channel ? items : [];
  const forStory = settings.new_story ? items : [];
  await db.enqueue(forChannel);
  await db.enqueueStories(forStory);
  await db.setWatch({ floor: watch.floor, last_checked_at: complete ? now : watch.last_checked_at });
  return {
    found: items.length,
    skus: items.map((i) => i.sku),
    skipped,
    channel: forChannel.length,
    story: forStory.length,
    complete,
    previous_check: watch.last_checked_at || null,
  };
}

// Checks the next batch of tracked products for a discount (price drop or new discount_ids) and back-in-stock.
export async function checkDiscounts(settings, { deadline = Date.now() + 120000, batch = CHECK_BATCH } = {}) {
  const skus = await db.recentSkus();
  const result = { checked: 0, discount: 0, restock: 0 };
  if (!skus.length) {
    return result;
  }
  const cursor = (await db.getCursor()) % skus.length;
  const slice = Array.from({ length: Math.min(batch, skus.length) }, (_, i) => skus[(cursor + i) % skus.length]);
  const channelItems = [];
  const storyItems = [];
  const discounts = await loadDiscounts();

  await mapLimit(slice, 5, async (sku) => {
    if (Date.now() > deadline) {
      return;
    }
    const rec = await db.getSent(sku);
    const p = rec && (await findBySku(sku));
    if (!p || (rec.product_id && rec.product_id !== p._id)) {
      return;
    }
    result.checked++;
    if (settings.stock_group) await observeMany([p], settings); // products the bot posted
    // Price customers pay now (BITO discounts applied); listPrice = before the discount.
    const pr = await priceFor(p, discounts);
    const amount = Number(pr.price) || 0;
    const listPrice = Number(pr.old_price) || amount;
    const stock = productStock(p);
    const idsKey = productDiscountKey(p);
    const patch = { price: amount > 0 ? amount : rec.price, stock, discount_ids_key: idsKey };
    const postable = amount > 0 && stock > 0 && productImage(p);
    const priceDrop = rec.price > 0 && amount > 0 && amount < rec.price;
    const newIds = Boolean(idsKey) && idsKey !== rec.discount_ids_key;

    if (postable && (priceDrop || newIds)) {
      const key = newIds ? idsDiscountKey(idsKey) : `price:${amount}`;
      const keys = rec.discount_keys || [];
      if (!keys.includes(key)) {
        // Old price struck through: what we posted before, or the BITO list price.
        const oldPrice = priceDrop ? rec.price : listPrice > amount ? listPrice : null;
        const item = toItem(p, { price: amount, old_price: oldPrice }, 'discount', { discount_key: key });
        result.discount++;
        if (settings.discount_channel) channelItems.push(item);
        if (settings.discount_story) storyItems.push(item);
        patch.discount_keys = [...keys, key].slice(-20);
      }
    } else if (postable && rec.stock !== undefined && rec.stock <= 0) {
      result.restock++;
      // Same once-per-N-days rule as the "🔄 Qayta keldi" auto-post, so a product is not posted twice.
      if (settings.discount_channel && (await claimRestock(p._id, settings))) channelItems.push(toItem(p, pr, 'restock'));
    }
    await db.updateSent(sku, patch);
  });

  await db.setCursor((cursor + slice.length) % skus.length);
  await db.enqueue(channelItems);
  await db.enqueueStories(storyItems);
  await db.incrStat('discount', result.discount);
  await db.incrStat('restock', result.restock);
  return result;
}
