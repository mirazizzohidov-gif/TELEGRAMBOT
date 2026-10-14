import { findBySku, findPrice, findProductsSince, getProductsPage, productImage, productStock, toItem } from './bito.js';
import { runTick } from './poster.js';
import { notifyAdmins, sendReportToAdmins } from './report.js';
import * as db from './store.js';
import { mapLimit, shuffle } from './util.js';

// Start of a Tashkent day (UTC+5, no DST) in ms.
export const dayStart = (day) => Date.parse(`${day}T00:00:00+05:00`);

// Cheap checks before the price lookup. Returns a skip reason, 'today' (already handled today) or null.
async function precheck(p, day) {
  if (!productImage(p)) {
    return 'noimage';
  }
  const sent = await db.getSent(p.sku);
  const queued = await db.getQueued(p.sku);
  if (sent || queued) {
    return sent?.date === day || queued?.day === day ? 'today' : 'dup';
  }
  if (productStock(p) <= 0) {
    return 'nostock';
  }
  return null;
}

// Finds today's new products, filters them and queues the rest.
export async function collectToday({ now = Date.now() } = {}) {
  const day = db.today(now);
  const products = await findProductsSince(dayStart(day));
  const skipped = { noimage: 0, noprice: 0, nostock: 0, dup: 0 };
  const items = [];
  await mapLimit(products, 5, async (p) => {
    const reason = await precheck(p, day);
    if (reason === 'today') {
      return;
    }
    if (reason) {
      skipped[reason]++;
      return;
    }
    const amount = await findPrice(p._id);
    if (!(amount > 0)) {
      skipped.noprice++;
      return;
    }
    items.push(toItem(p, amount));
  });
  items.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  await db.enqueue(items, day);
  await db.setStats(
    {
      found: products.length,
      skip_noimage: skipped.noimage,
      skip_noprice: skipped.noprice,
      skip_nostock: skipped.nostock,
      skip_dup: skipped.dup,
    },
    day,
  );
  await db.incrStat('queued', items.length, day);
  return { day, found: products.length, queued: items.length, skipped };
}

// Picks up to n random products that pass all filters and queues them.
export async function queueRandom(n = 10) {
  const day = db.today();
  const { total } = await getProductsPage({ page: 1, limit: 1 });
  const pages = Math.max(1, Math.ceil(total / 50));
  const tried = new Set();
  const seen = new Set();
  const picked = [];
  while (picked.length < n && tried.size < Math.min(pages, 12)) {
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
      if (seen.has(p.sku) || (await precheck(p, day))) {
        continue;
      }
      seen.add(p.sku);
      const amount = await findPrice(p._id);
      if (amount > 0) {
        picked.push(toItem(p, amount, 'new', { random: true }));
      }
    }
  }
  await db.enqueue(picked, day);
  await db.incrStat('random_queued', picked.length, day);
  return picked.length;
}

// For recently sent products: queue "discount" if the price dropped, "restock" if stock went 0 -> >0.
export async function checkPriceChanges({ deadline = Date.now() + 150000 } = {}) {
  const skus = await db.recentSkus();
  const items = [];
  let checked = 0;
  await mapLimit(skus, 5, async (sku) => {
    if (Date.now() > deadline) {
      return;
    }
    const rec = await db.getSent(sku);
    const p = rec && (await findBySku(sku));
    if (!p) {
      return;
    }
    checked++;
    const amount = Number(await findPrice(p._id)) || 0;
    const stock = productStock(p);
    const canPost = amount > 0 && stock > 0 && productImage(p) && !(await db.getQueued(sku));
    if (canPost && rec.price > 0 && amount < rec.price) {
      items.push(toItem(p, amount, 'discount', { old_price: rec.price }));
    } else if (canPost && rec.stock !== undefined && rec.stock <= 0) {
      items.push(toItem(p, amount, 'restock'));
    }
    await db.updateSent(sku, { price: amount > 0 ? amount : rec.price, stock });
  });
  await db.enqueue(items);
  const discount = items.filter((i) => i.type === 'discount').length;
  await db.incrStat('discount', discount);
  await db.incrStat('restock', items.length - discount);
  return { checked, discount, restock: items.length - discount };
}

export async function askRandom() {
  await notifyAdmins({
    text: "Bugun yangi mahsulot yo'q. 10 ta tasodifiy mahsulot joylaymi?",
    reply_markup: {
      inline_keyboard: [[{ text: '✅ Ha, joyla', callback_data: 'rnd:y' }, { text: "❌ Yo'q", callback_data: 'rnd:n' }]],
    },
  });
}

export async function runDaily({ budgetMs = 280000 } = {}) {
  const started = Date.now();
  const deadline = started + budgetMs;
  const s = await db.getSettings();
  const collected = await collectToday();
  const day = collected.day;
  let randomAsked = false;
  if (collected.queued === 0) {
    if (s.random) {
      if (await db.once(`random_asked:${day}`)) {
        await askRandom();
        await db.setStats({ random_asked: 1 }, day);
        randomAsked = true;
      }
    } else {
      await db.setStats({ no_new: 1 }, day);
    }
  }
  const changes = await checkPriceChanges({ deadline: Math.min(started + 150000, deadline - 60000) });
  const tick = await runTick({ budgetMs: Math.max(0, deadline - Date.now() - 15000) });
  await sendReportToAdmins(day);
  return { day, collected, randomAsked, changes, tick };
}
