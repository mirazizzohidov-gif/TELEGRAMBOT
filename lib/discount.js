// BITO discount rules -> the price customers actually pay.
//
// Discount object (BITO): { _id, state, target_type, apply_type: 'percent' | 'cash', value, live_type,
//   is_all_categories, category_ids, nested_category_ids, item_added_ids, customer_ids, ... }

const ms = (v) => (v ? Date.parse(v) : NaN);

// First date-like field that exists (BITO field names for timed discounts may differ).
const pickDate = (d, names) => names.map((n) => d[n]).find((v) => v);

export function isDiscountActive(d, now = Date.now()) {
  if (!d || d.state !== 'active' || d.is_deleted || d.is_archived) {
    return false;
  }
  if (!d.live_type || d.live_type === 'forever') {
    return true;
  }
  const start = ms(pickDate(d, ['start_date', 'start_at', 'from_date', 'from', 'begin_date', 'started_at']));
  const end = ms(pickDate(d, ['end_date', 'end_at', 'to_date', 'to', 'finish_date', 'expired_at']));
  return (Number.isNaN(start) || now >= start) && (Number.isNaN(end) || now <= end);
}

// Does the rule apply to this product? Customer-specific rules are not public prices.
export function discountAppliesTo(d, product) {
  if (d.target_type && d.target_type !== 'product') {
    return false;
  }
  if ((d.customer_ids || []).length || (d.customer_category_ids || []).length) {
    return false;
  }
  const id = String(product._id);
  const categoryId = product.category?._id || product.category_id;
  return (
    (product.discount_ids || []).map(String).includes(String(d._id)) ||
    (d.item_added_ids || []).map(String).includes(id) ||
    d.is_all_categories === true ||
    (categoryId && [...(d.category_ids || []), ...(d.nested_category_ids || [])].map(String).includes(String(categoryId)))
  );
}

// New price after one rule. apply_type 'cash': DISCOUNT_CASH_MODE=subtract (default) -> price - value;
// =final -> value is the new price itself.
export function applyDiscount(price, d, mode = process.env.DISCOUNT_CASH_MODE || 'subtract') {
  const value = Number(d.value) || 0;
  let next = price;
  if (d.apply_type === 'percent') {
    next = price * (1 - value / 100);
  } else if (d.apply_type === 'cash') {
    next = mode === 'final' ? value : price - value;
  }
  return Math.max(0, Math.round(next));
}

// The best (lowest) price from all active rules that apply; null if none lowers the price.
export function bestDiscount(price, product, discounts, now = Date.now()) {
  let best = null;
  for (const d of discounts || []) {
    if (!isDiscountActive(d, now) || !discountAppliesTo(d, product)) {
      continue;
    }
    const next = applyDiscount(price, d);
    if (next < price && (!best || next < best.price)) {
      best = { price: next, discount: d };
    }
  }
  return best;
}
