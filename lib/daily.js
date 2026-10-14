import { findPrice, getProductsPage, productImage, productStock, toItem } from './bito.js';
import { postStoriesNow, postToChannels } from './poster.js';
import { sendReportToAdmins } from './report.js';
import * as db from './store.js';
import { shuffle } from './util.js';

// Random products with image, price > 0 and stock > 0 that were not in a random album in the last
// `repeatDays` days (and not in `exclude`).
export async function pickRandomProducts(n, { repeatDays = 7, exclude = [] } = {}) {
  const hist = await db.getRandomHist();
  const cutoff = Date.now() - repeatDays * 24 * 60 * 60 * 1000;
  await db.dropRandomHist(Object.keys(hist).filter((sku) => Number(hist[sku]) < cutoff));
  const recent = new Set(Object.keys(hist).filter((sku) => Number(hist[sku]) >= cutoff));

  const { total } = await getProductsPage({ page: 1, limit: 1 });
  const pages = Math.max(1, Math.ceil(total / 50));
  const tried = new Set();
  const seen = new Set(exclude.map(String));
  const picked = [];
  while (picked.length < n && tried.size < Math.min(pages, 15)) {
    let page;
    do {
      page = 1 + Math.floor(Math.random() * pages);
    } while (tried.has(page));
    tried.add(page);
    const { list } = await getProductsPage({ page, limit: 50 });
    for (const p of shuffle(list)) {
      if (picked.length >= n) {
        break;
      }
      const sku = String(p.sku);
      if (seen.has(sku) || recent.has(sku) || !productImage(p) || productStock(p) <= 0) {
        continue;
      }
      seen.add(sku);
      const amount = await findPrice(p._id);
      if (amount > 0) {
        picked.push(toItem(p, amount, 'new', { random: true }));
      }
    }
  }
  return picked;
}

// Sends one album (sendMediaGroup) to every active channel, followed by the order button message,
// and (if "Random → story" is on) a story for each product.
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
  const r = await postToChannels(items, { ...s, album: true }, channels, deadline);
  const posted = items.filter((i) => r.posted.has(i));
  for (const item of posted) {
    await db.upsertProduct(item, { posted_at: Date.now() });
  }
  await db.addRandomHist(posted.map((i) => i.sku));
  await db.incrStat('random_album', posted.length);
  const result = { posted: posted.length, errors: r.errors };
  if (s.random_story && posted.length) {
    // Each album product also as a story (within the daily story limit; the rest waits for tomorrow).
    const st = await postStoriesNow(posted, s, { deadline, notify: true });
    Object.assign(result, { stories: st.posted.length, stories_queued: st.queued, story_reason: st.reason });
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
