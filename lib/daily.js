import { CATALOG_PAGE_SIZE, loadDiscounts, priceFor, productImage, productPage, productStock, productTotal, toItem } from './bito.js';
import { postItemsNow, postStoriesNow, randomAlbum } from './poster.js';
import { sendReportToAdmins } from './report.js';
import * as db from './store.js';
import { mapLimit, shuffle } from './util.js';

const PRICE_PARALLEL = 8;

// Random products with image, price > 0 and stock > 0 that were not in a random album in the last
// `repeatDays` days, are not in the random blacklist and not in `exclude`.
// Reads 1-2 random catalog pages (3 at most if too few pass the filters) instead of the whole
// catalog; pages and prices are cached and prices are fetched in parallel.
const RANDOM_MAX_PAGES = 3;

export async function pickRandomProducts(n, { repeatDays = 7, exclude = [] } = {}) {
  const [hist, blacklist, total, discounts] = await Promise.all([
    db.getRandomHist(),
    db.getRandomBlacklist(),
    productTotal(),
    loadDiscounts(),
  ]);
  const price = (p) => priceFor(p, discounts);
  const cutoff = Date.now() - repeatDays * 24 * 60 * 60 * 1000;
  await db.dropRandomHist(Object.keys(hist).filter((sku) => Number(hist[sku]) < cutoff));
  const recent = new Set(Object.keys(hist).filter((sku) => Number(hist[sku]) >= cutoff));
  const seen = new Set([...exclude.map(String), ...blacklist.map((b) => String(b.sku))]);

  const pages = Math.max(1, Math.ceil(total / CATALOG_PAGE_SIZE));
  const order = shuffle(Array.from({ length: pages }, (_, i) => i + 1)).slice(0, RANDOM_MAX_PAGES);
  const picked = [];
  // Start with 2 pages in parallel (1 when n is small); add the third only if still short.
  const batches = [order.slice(0, n <= 10 ? 1 : 2), order.slice(n <= 10 ? 1 : 2)];
  for (const batch of batches) {
    if (picked.length >= n || !batch.length) {
      continue;
    }
    const lists = await Promise.all(batch.map((page) => productPage(page)));
    const candidates = [];
    for (const p of shuffle(lists.flat())) {
      const sku = String(p.sku);
      if (seen.has(sku) || recent.has(sku) || !productImage(p) || productStock(p) <= 0) {
        continue;
      }
      seen.add(sku);
      candidates.push(p);
    }
    // Look up prices in parallel, a little more than needed (some have no price).
    const need = n - picked.length;
    const prices = await mapLimit(candidates.slice(0, Math.ceil(need * 1.5) + 2), PRICE_PARALLEL, price);
    candidates.slice(0, prices.length).forEach((p, i) => {
      if (picked.length < n && prices[i].price > 0) {
        picked.push(toItem(p, prices[i], 'new', { random: true }));
      }
    });
    // Not enough with a price: check the rest of these pages too.
    if (picked.length < n && candidates.length > prices.length) {
      const rest = candidates.slice(prices.length);
      const restPrices = await mapLimit(rest, PRICE_PARALLEL, price);
      rest.forEach((p, i) => {
        if (picked.length < n && restPrices[i].price > 0) {
          picked.push(toItem(p, restPrices[i], 'new', { random: true }));
        }
      });
    }
  }
  return picked;
}

// Daily random: separate posts with the order button, 3 s apart (or one album, per "Random ko'rinishi")
// to every active channel; what does not fit in time goes to the channel queue. If "Random → story"
// is on, also a story for each product.
export async function sendRandomAlbum(s, deadline) {
  const channels = s.channels.filter((c) => c.active);
  if (!channels.length) {
    return { posted: 0, reason: 'no active channels' };
  }
  const items = await pickRandomProducts(db.limit(s, 'random_album_size'), {
    repeatDays: db.limit(s, 'random_repeat_days'),
  });
  if (!items.length) {
    return { posted: 0, reason: 'no eligible products' };
  }
  const r = await postItemsNow(items, s, { deadline, album: randomAlbum(s), stat: 'random_album' });
  await db.addRandomHist(items.map((i) => i.sku));
  const result = { posted: r.posted.length, queued: r.queued.length, errors: r.errors };
  if (s.random_story) {
    // Each product also as a story (within the daily story limit; the rest waits for tomorrow).
    const st = await postStoriesNow(items, s, { deadline, notify: true });
    Object.assign(result, {
      stories: st.posted,
      stories_queued: st.queued,
      story_reason: st.reason,
      story_profiles: st.profiles.map((p) => ({ profile: p.label, posted: p.posted, queued: p.queued, errors: p.errors })),
    });
  }
  return result;
}

// Daily job (16:00 Tashkent): random album (if enabled) and the daily report.
export async function runDaily({ budgetMs = 280000 } = {}) {
  const deadline = Date.now() + budgetMs;
  const s = await db.getSettings();
  const day = db.today();
  let random = { enabled: Boolean(s.random_album) };
  if (s.random_album) {
    if (await db.once(`random_album:${day}`)) {
      try {
        random = { ...random, ...(await sendRandomAlbum(s, deadline - 30000)) };
      } catch (e) {
        await db.clearFlag(`random_album:${day}`);
        throw e;
      }
    } else {
      random.skipped = 'already sent today';
    }
  }
  await sendReportToAdmins(day);
  return { day, random };
}
