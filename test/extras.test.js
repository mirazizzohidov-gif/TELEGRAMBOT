// node --test — "❌ SOTILDI", "💲 Narx yangilash", "#️⃣ Heshteglar", "🖼 Logo", "🩺 Holat".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { MemRedis } from './_mem.js';

process.env.BOT_TOKEN = 'T';
process.env.ADMIN_IDS = '111';
process.env.BITO_API_KEY = 'k';
process.env.BITO_PRICE_ID = 'P1';
const sharp = createRequire(import.meta.url)('sharp');
const store = await import('../lib/store.js');
const redis = new MemRedis();
store.setRedis(redis);
const { hashtag, tagsFor, addTags } = await import('../lib/hashtags.js');
const reg = await import('../lib/postreg.js');
const wm = await import('../lib/watermark.js');
const health = await import('../lib/health.js');
const { bitoStats } = await import('../lib/bito.js');

// Telegram / BITO / image fake
let calls = [];
let tgFail = {};
const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#2050a0' } }).jpeg().toBuffer();
let imageOk = true;
globalThis.fetch = async (url, opts = {}) => {
  if (url.startsWith('https://img.test/') || url.includes('/file/bot')) {
    if (!imageOk) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => photo.buffer.slice(photo.byteOffset, photo.byteOffset + photo.length) };
  }
  if (url.includes('api.telegram.org')) {
    const method = url.split('/').pop();
    const body = opts.body instanceof FormData ? opts.body : JSON.parse(opts.body || '{}');
    calls.push({ method, body });
    const f = tgFail[method];
    if (f) return { json: async () => ({ ok: false, error_code: f.code || 400, description: f.text }) };
    if (method === 'getFile') return { json: async () => ({ ok: true, result: { file_path: 'x.jpg' } }) };
    if (method === 'sendPhoto') return { json: async () => ({ ok: true, result: { message_id: 500 + calls.length, photo: [{ file_id: 'S' }, { file_id: 'MARKED_ID' }] } }) };
    return { json: async () => ({ ok: true, result: true }) };
  }
  // BITO
  const path = url.replace(/^.*\/v2/, '');
  const body = JSON.parse(opts.body || '{}');
  calls.push({ method: 'BITO ' + path, body });
  const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) });
  if (path === '/category/get-paging') return ok({ data: CATS, total: CATS.length });
  if (path === '/product/get-by-id') return ok(PRODUCTS[body.id || body._id] || null);
  if (path === '/price/items/get-paging') return ok({ data: PRICES[body.product_id] ? [{ amount: PRICES[body.product_id], product: { _id: body.product_id } }] : [] });
  if (path.startsWith('/discount/')) return ok([]);
  return { ok: false, status: 404, text: async () => JSON.stringify({ code: 404, message: 'Route not found' }) };
};
const CATS = [
  { _id: 'C1', name: 'Sumkalar', parent_id: null },
  { _id: 'C2', name: 'Ayollar sumkasi', parent_id: 'C1' },
  { _id: 'C3', name: "O‘yinchoq-lar (bolalar)", parent_id: null },
  { _id: 'C4', name: 'Kategoriyasiz', parent_id: null },
];
const PRODUCTS = {};
const PRICES = {};
const tgc = (m) => calls.filter((c) => c.method === m);
const S = {
  phone: '+998982000307',
  order_url: 'https://t.me/Mixpodarok0307',
  order_in_bot: true,
  bot_username: 'bito_bot',
  channels: [{ id: '@ch', active: true }],
  channel2: { id: '-1002222', enabled: true, markup_percent: 30, phone: '+998907776655', order_url: 'https://t.me/shop_2kanal' },
  low_stock_threshold: 0,
  ai_channel: false,
};

// ---- #️⃣ Heshteglar ----
test('hashtag rule: spaces / dashes -> _, signs removed, Latin / Cyrillic / digits, max 30', () => {
  assert.equal(hashtag('Ayollar sumkasi'), '#Ayollar_sumkasi');
  assert.equal(hashtag("O‘yinchoq-lar (bolalar)"), '#Oyinchoq_lar_bolalar');
  assert.equal(hashtag("Bolalar o'yinchoqlari 3+"), '#Bolalar_oyinchoqlari_3');
  assert.equal(hashtag('Игрушки для детей'), '#Игрушки_для_детей');
  assert.equal(hashtag('a'.repeat(40)).length, 31);
  assert.equal(hashtag('!!! ---'), '');
  assert.equal(hashtag('2024'), '');
});

test('tags: own category and its main one (max 2); "Kategoriyasiz" / none -> nothing', () => {
  const list = CATS.map((c) => ({ id: c._id, name: c.name, parent_id: c.parent_id }));
  assert.equal(tagsFor('C2', list), '#Ayollar_sumkasi #Sumkalar');
  assert.equal(tagsFor('C1', list), '#Sumkalar');
  assert.equal(tagsFor('C4', list), '');
  assert.equal(tagsFor('none', list), '');
  assert.equal(tagsFor(null, list), '');
  assert.equal(tagsFor('UNKNOWN', list), '');
});

test('addTags: on items from BITO categories; off -> untouched', async () => {
  const items = [{ category_id: 'C2' }, { category_id: 'C4' }, {}];
  await addTags(items, { hashtags: true });
  assert.deepEqual(items.map((i) => i.tags), ['#Ayollar_sumkasi #Sumkalar', '', '']);
  const off = [{ category_id: 'C2' }];
  await addTags(off, { hashtags: false });
  assert.equal(off[0].tags, undefined);
});

// ---- ❌ SOTILDI / 💲 Narx yangilash ----
const item = { product_id: 'P1', sku: '1001', name: 'Hamyon', price: 30000, image_url: 'https://img.test/1.jpg', type: 'new', tags: '#Sumkalar' };

test('rendering: channel post, 2nd channel (markup, own phone / button), sold mark removes the button', () => {
  const e1 = { kind: 'post', item, chat: '@ch', mid: 1 };
  const v1 = reg.renderPost(e1, S);
  assert.equal(v1.caption, "🛍 Mahsulot nomi: Hamyon\n💰 Narxi: 30 000 so'm\n\n📞 Buyurtma uchun murojaat qiling: +998982000307\n\n#Sumkalar");
  assert.equal(v1.reply_markup.inline_keyboard[0][0].url, 'https://t.me/bito_bot?start=o_P1');
  const v2 = reg.renderPost({ ...e1, ch2: true }, S);
  assert.ok(v2.caption.includes("39 000 so'm") && v2.caption.includes('+998907776655') && v2.caption.endsWith('#Sumkalar'));
  assert.equal(v2.reply_markup.inline_keyboard[0][0].url, 'https://t.me/shop_2kanal');
  const sold = reg.renderPost({ ...e1, sold: true }, S);
  assert.ok(sold.caption.startsWith('❌ SOTILDI\n\n🛍 Mahsulot nomi: Hamyon'));
  assert.deepEqual(sold.reply_markup, { inline_keyboard: [] });
  const d = reg.renderPost({ kind: 'date', item: { ...item, ds_kind: 'back' }, dest: { id: '-1002222', kind: 'ch2' } }, S);
  assert.ok(d.caption.startsWith('🔄 <b>YANA SOTUVDA!</b>') && d.caption.includes("39 000 so'm") && d.caption.endsWith('#Sumkalar'));
  const h = reg.renderPost({ kind: 'helper', item: { name: 'Vaza', sku: '1001', price: 50000 }, dest: { id: '@ch', kind: 'ch1' }, fields: ['name', 'price'], tags: '#Sumkalar' }, S);
  assert.equal(h.caption, "🆕 YANGI MAHSULOT\n\n🛍 Mahsulot nomi: Vaza\n💰 Narxi: 50 000 so'm\n\n📞 Buyurtma uchun murojaat qiling: +998982000307\n\n#Sumkalar");
});

test('sold -> back: queued edits, caption + button changed, restored; "not modified" / "not found" quiet', async () => {
  calls = [];
  await reg.recordPost('P1', { chat: '@ch', mid: 11, kind: 'post', item }, S);
  await reg.recordPost('P1', { chat: '-1002222', mid: 12, kind: 'post', ch2: true, item }, S);
  await reg.recordPost('P1', { chat: '@ch', mid: 13, kind: 'post', item }, { ...S, mark_sold: false, price_update: false });
  assert.equal((await reg.getPosts('P1')).length, 2, 'nothing recorded when both features are off');
  assert.equal(await reg.markProduct('P1', true, S), 2);
  assert.equal(await reg.markProduct('P1', true, S), 0, 'already marked');
  let r = await reg.processEdits(S);
  assert.equal(r.edited, 2);
  const ed = tgc('editMessageCaption');
  assert.ok(ed.every((c) => c.body.caption.startsWith('❌ SOTILDI') && c.body.reply_markup.inline_keyboard.length === 0));
  assert.deepEqual(ed.map((c) => [c.body.chat_id, c.body.message_id]), [['@ch', 11], ['-1002222', 12]]);
  calls = [];
  await reg.markProduct('P1', false, S);
  tgFail.editMessageCaption = { text: 'Bad Request: message is not modified' };
  r = await reg.processEdits(S);
  assert.equal(r.edited, 2, '"not modified" counts as done');
  delete tgFail.editMessageCaption;
  assert.ok((await reg.getPosts('P1')).every((e) => !e.sold));
  await reg.markProduct('P1', true, S);
  tgFail.editMessageCaption = { text: 'Bad Request: message to edit not found' };
  r = await reg.processEdits(S);
  delete tgFail.editMessageCaption;
  assert.equal(r.failed, 0);
  assert.equal((await reg.getPosts('P1')).length, 0, 'deleted posts are forgotten quietly');
  assert.equal(await reg.markProduct('P1', false, { ...S, mark_sold: false }), 0, 'switched off: nothing');
});

test('at most 30 edits per tick, the rest wait', async () => {
  for (let i = 0; i < 35; i++) await reg.recordPost(`Q${i}`, { chat: '@ch', mid: 1000 + i, kind: 'post', item: { ...item, product_id: `Q${i}` } }, S);
  for (let i = 0; i < 35; i++) await reg.markProduct(`Q${i}`, true, S);
  calls = [];
  let r = await reg.processEdits(S);
  assert.equal(r.edited, 30);
  assert.equal(r.waiting, 5);
  r = await reg.processEdits(S);
  assert.equal(r.edited, 5);
  assert.equal(r.waiting, 0);
});

test('price change: rewritten (2nd channel recalculated, discount format), at most once an hour; helper price kept', async () => {
  await reg.recordPost('P2', { chat: '@ch', mid: 21, kind: 'post', item: { ...item, product_id: 'P2' } }, S);
  await reg.recordPost('P2', { chat: '-1002222', mid: 22, kind: 'post', ch2: true, item: { ...item, product_id: 'P2' } }, S);
  await reg.recordPost('P2', { chat: '@ch', mid: 23, kind: 'helper', item: { name: 'H', sku: '1', price: 30000 }, dest: { id: '@ch' }, fields: ['name', 'price'] }, S);
  assert.equal(await reg.updatePrice('P2', { price: 30000, old_price: null }, S), 0, 'same price: nothing');
  assert.equal(await reg.updatePrice('P2', { price: 24000, old_price: 30000 }, S), 2);
  calls = [];
  let r = await reg.processEdits(S);
  assert.equal(r.price, 2);
  const [c1, c2] = tgc('editMessageCaption');
  assert.ok(c1.body.caption.includes("<s>30 000</s> → 24 000 so'm"), c1.body.caption);
  assert.ok(c2.body.caption.includes("<s>39 000</s> → 31 000 so'm"), c2.body.caption);
  assert.equal(c1.body.reply_markup.inline_keyboard[0][0].text, '🛒 Buyurtma berish');
  // a second change within the hour waits
  assert.equal(await reg.updatePrice('P2', { price: 25000 }, S), 2);
  calls = [];
  r = await reg.processEdits(S);
  assert.equal(r.edited, 0);
  assert.equal(r.waiting, 2);
  const list = await reg.getPosts('P2');
  for (const e of list) if (e.price_edited_at) e.price_edited_at -= 61 * 60 * 1000;
  await redis.hset(`bito:flag:posts:reg`, { P2: list });
  r = await reg.processEdits(S);
  assert.equal(r.price, 2);
  assert.ok(tgc('editMessageCaption')[0].body.caption.includes("💰 Narxi: 25 000 so'm"));
  assert.equal((await reg.getPosts('P2')).find((e) => e.kind === 'helper').item.price, 30000);
});

test('price check: posted products in turn, BITO price list compared', async () => {
  PRODUCTS.P2 = { _id: 'P2', sku: '1002', name: 'x', discount_ids: [] };
  PRICES.P2 = 27000;
  const r = await reg.checkPrices(S);
  assert.ok(r.checked >= 1);
  assert.ok(r.changed >= 1);
  assert.equal((await reg.getPosts('P2')).find((e) => e.kind === 'post').item.price, 27000);
  assert.deepEqual(await reg.checkPrices({ ...S, price_update: false }), { checked: 0, changed: 0 });
});

// ---- 🖼 Logo ----
const corner = async (buf, x, y) => {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

test('watermark: default "MIX PODAROK" in the chosen corner, size and opacity', async () => {
  const out = await wm.applyWatermark(photo, { wm_pos: 'br', wm_opacity: 80 });
  const meta = await sharp(out).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [800, 600, 'jpeg']);
  // the mark is near the bottom right, ~18% wide: some pixel there got lighter, the top left did not
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  let light = 0;
  for (let y = 540; y < 590; y++) for (let x = 640; x < 790; x++) if (data[(y * info.width + x) * 3] > 150) light++;
  assert.ok(light > 50, `mark pixels: ${light}`);
  assert.deepEqual(await corner(out, 5, 5), await corner(photo, 5, 5));
  const tl = await wm.applyWatermark(photo, { wm_pos: 'tl', wm_opacity: 80 });
  const { data: d2 } = await sharp(tl).raw().toBuffer({ resolveWithObject: true });
  let light2 = 0;
  for (let y = 10; y < 60; y++) for (let x = 10; x < 160; x++) if (d2[(y * 800 + x) * 3] > 150) light2++;
  assert.ok(light2 > 50);
  assert.equal(wm.opacityOf({ wm_opacity: 95 }), 80);
  assert.equal(wm.opacityOf({ wm_opacity: 5 }), 30);
  assert.equal(wm.positionOf({ wm_pos: 'x' }), 'br');
});

test('own logo: PNG up to 500 KB, then used; too big / not an image refused', async () => {
  const logo = await sharp({ create: { width: 200, height: 80, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  assert.equal(await wm.saveLogo(logo), null);
  const out = await wm.applyWatermark(photo, { wm_pos: 'br', wm_opacity: 80 });
  const [r, g] = await corner(out, 760, 570);
  assert.ok(r > 150 && g < 120, `red logo there: ${r},${g}`);
  assert.match(await wm.saveLogo(Buffer.alloc(600 * 1024)), /500 KB/);
  assert.ok(await wm.saveLogo(Buffer.from('hello')));
  await wm.dropLogo();
  assert.equal(await wm.getLogo(), null);
});

test('sendPhotoMarked: off -> URL as is; on -> uploaded once, then the file_id; error -> the original', async () => {
  calls = [];
  await wm.sendPhotoMarked({ chat_id: '@ch', photo: 'https://img.test/a.jpg', caption: 'x' }, { wm_on: false });
  assert.equal(tgc('sendPhoto')[0].body.photo, 'https://img.test/a.jpg');
  calls = [];
  await wm.sendPhotoMarked({ chat_id: '@ch', photo: 'https://img.test/b.jpg', caption: 'c', parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: 'B', url: 'https://t.me/x' }]] } }, { wm_on: true });
  const f = tgc('sendPhoto')[0].body;
  assert.ok(f instanceof FormData && f.get('photo') instanceof Blob && f.get('caption') === 'c' && JSON.parse(f.get('reply_markup')).inline_keyboard[0][0].text === 'B');
  await wm.sendPhotoMarked({ chat_id: '-1002222', photo: 'https://img.test/b.jpg', caption: 'c2' }, { wm_on: true });
  assert.equal(tgc('sendPhoto')[1].body.photo, 'MARKED_ID', 'the same photo to the next channel: the uploaded file_id');
  calls = [];
  imageOk = false;
  await wm.sendPhotoMarked({ chat_id: '@ch', photo: 'https://img.test/c.jpg', caption: 'c' }, { wm_on: true });
  imageOk = true;
  assert.equal(tgc('sendPhoto')[0].body.photo, 'https://img.test/c.jpg', 'drawing failed: the original photo');
  // a Telegram file_id (helper posts)
  calls = [];
  await wm.sendPhotoMarked({ chat_id: '@ch', photo: 'AgACfileid', caption: 'h' }, { wm_on: true });
  assert.ok(tgc('getFile').length === 1 && tgc('sendPhoto')[0].body instanceof FormData);
  assert.equal((await wm.markStoryBytes(photo, { wm_story: false })).length, photo.length);
  assert.notEqual((await wm.markStoryBytes(photo, { wm_story: true })).length, photo.length);
});

// ---- 🩺 Holat ----
test('warnings: no tick for 45 min, BITO 3 ticks in a row, story 3 times in a row; once an hour', async () => {
  calls = [];
  await redis.hset('bito:flag:health:state', { last_tick_at: Date.now() - 50 * 60000 });
  await health.beforeTick({});
  let w = tgc('sendMessage').filter((c) => c.body.text.startsWith('⚠️'));
  assert.ok(w.length === 1 && w[0].body.text.includes('daqiqa davomida tekshiruv (tick) bo\'lmadi'));
  await health.beforeTick({});
  assert.equal(tgc('sendMessage').length, 1, 'the same warning: once an hour');
  calls = [];
  for (let i = 0; i < 3; i++) {
    await health.beforeTick({});
    bitoStats.down = 1;
    bitoStats.calls = 2;
    bitoStats.last_error = '/product/get-paging: HTTP 503';
    await health.afterTick({});
  }
  w = tgc('sendMessage').filter((c) => c.body.text.includes('BITO 3 ta tekshiruvda'));
  assert.equal(w.length, 1);
  calls = [];
  const p = { id: 'BIZ1', label: '@ali_shop' };
  await health.recordStoryResult(p, false, 'Bad Request: X', {});
  await health.recordStoryResult(p, false, 'Bad Request: X', {});
  assert.equal(tgc('sendMessage').length, 0);
  await health.recordStoryResult(p, false, 'Bad Request: X', {});
  assert.ok(tgc('sendMessage')[0].body.text.includes('Istoriya @ali_shop ga ketma-ket 3 marta yuborilmadi'));
  await health.recordStoryResult(p, true, null, {});
  calls = [];
  await health.recordStoryResult({ id: 'B2', label: '@b' }, false, 'e', { health: false });
  await health.recordStoryResult({ id: 'B2', label: '@b' }, false, 'e', { health: false });
  await health.recordStoryResult({ id: 'B2', label: '@b' }, false, 'e', { health: false });
  assert.equal(tgc('sendMessage').length, 0, 'switched off: no warnings');
});

test('daily report after 08:55 Tashkent, once a day; "🩺 Holat" content', async () => {
  const day = store.today(Date.now() - 86400000);
  for (const [k, v] of Object.entries({ posted: 3, discount_posted: 1, restock_auto_posted: 2, ch2_posted: 6, sold_marked: 4, price_updated: 5, failed: 1, bito_calls: 10, bito_ms: 4200 })) await redis.hincrby(store.K.stats(day), k, v);
  await store.logError('BITO 503 at /product/get-paging');
  const at = (hhmm) => Date.parse(`${store.today()}T${hhmm}:00+05:00`);
  calls = [];
  assert.equal(await health.dailyHealth({ channel2: { id: '-1' } }, { now: at('08:40') }), false);
  assert.equal(await health.dailyHealth({ channel2: { id: '-1' } }, { now: at('09:00') }), true);
  assert.equal(await health.dailyHealth({ channel2: { id: '-1' } }, { now: at('09:15') }), false);
  const t = tgc('sendMessage')[0].body.text;
  for (const want of ['🩺 <b>Kunlik holat</b>', '📢 Postlar: 1-kanal 6, 2-kanal 6', '🆕 Yangi mahsulot: 3', '🔥 Chegirma: 1', '🔄 Qayta keldi: 2', '❌ Sotildi belgisi: 4', '💲 Narx yangilandi: 5 post', '❗ Xatolar: 1', 'BITO 503 at /product/get-paging', "🌐 BITO javobi: o'rtacha 420 ms", '⏱ Oxirgi muvaffaqiyatli tekshiruv:']) {
    assert.ok(t.includes(want), `${want} in:\n${t}`);
  }
  assert.equal(await health.dailyHealth({ health: false }, { now: at('09:00') + 86400000 }), false);
});
