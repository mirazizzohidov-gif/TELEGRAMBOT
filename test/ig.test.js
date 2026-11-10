// node --test — "📸 Instagram": caption, which accounts get a post / story, the publish steps, limits.
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.VERCEL_PROJECT_PRODUCTION_URL = 'bot.test';
process.env.SECRET = 's3';
const store = await import('../lib/store.js');
const ig = await import('../lib/ig.js');

const mem = new Map();
const H = (k) => (mem.has(k) ? mem.get(k) : (mem.set(k, {}), mem.get(k)));
const L = (k) => (mem.has(k) ? mem.get(k) : (mem.set(k, []), mem.get(k)));
store.setRedis({
  get: async (k) => (mem.has(k) ? mem.get(k) : null),
  set: async (k, v, o) => (o?.nx && mem.has(k) ? null : (mem.set(k, v), 'OK')),
  del: async (k) => (mem.delete(k) ? 1 : 0),
  hget: async (k, f) => H(k)[f] ?? null,
  hset: async (k, o) => (Object.assign(H(k), o), 1),
  hgetall: async (k) => (mem.has(k) ? { ...mem.get(k) } : null),
  hdel: async (k, ...f) => (f.forEach((x) => delete H(k)[x]), 1),
  hincrby: async (k, f, n) => (H(k)[f] = (Number(H(k)[f]) || 0) + n),
  rpush: async (k, ...v) => L(k).push(...v),
  lrange: async (k) => [...L(k)],
  ltrim: async () => 'OK',
  llen: async (k) => L(k).length,
  expire: async () => 1,
});

const item = { product_id: 'P1', sku: '1001', name: 'Hamyon', image_url: 'https://img.test/1.png', price: 90000, old_price: 120000, type: 'discount', stock: 2, desc: 'Charm hamyon', tags: '#hamyon' };

test('caption: discount struck out, price off -> Direct, own hashtags', () => {
  const s = { phone: '+998900000000', low_stock_threshold: 3 };
  const c = ig.igCaption(item, s, { price: true, tags: '#mixpodarok' });
  assert.match(c, /🔥 CHEGIRMA!/);
  assert.match(c, /1̶2̶0̶.*→ 90 000 so'm/);
  assert.match(c, /🔖 Kod: 1001/);
  assert.match(c, /#hamyon #mixpodarok$/);
  assert.match(ig.igCaption(item, s, { price: false, tags: '' }), /Narxini bilish uchun Direct'ga yozing/);
  assert.doesNotMatch(ig.igCaption(item, s, { price: false, tags: '' }), /90 000/);
});

test('signed photo links: only the bot\'s own signature works', () => {
  const u = new URL(ig.igImageUrl('https://img.test/1.png', 'story'));
  assert.equal(u.host, 'bot.test');
  assert.ok(ig.igCheck(u.searchParams.get('d'), u.searchParams.get('s')));
  assert.ok(!ig.igCheck(u.searchParams.get('d'), 'x'.repeat(32)));
  assert.deepEqual(ig.igDecode(u.searchParams.get('d')), { u: 'https://img.test/1.png', k: 'story' });
});

test('enqueue per account settings, publish steps, daily limit', async () => {
  mem.clear();
  let s = { ig: { a: { on: true, types: { discount: true }, stories_posts: true, max_posts: 1, max_stories: 5 }, b: { on: true, types: { discount: false }, stories_queue: true } } };
  await store.redis().hset(store.K.flag('ig:tok'), { a: { token: 'TA', user_id: '11', refreshed_at: Date.now() }, b: { token: 'TB', user_id: '22', refreshed_at: Date.now() } });
  await ig.igAfterPost(item, s);
  await ig.igAfterPost(item, s); // the same product the same day: not again
  await ig.igAfterStory(item, s);
  let q = await store.redis().lrange(store.K.flag('igq'));
  assert.deepEqual(q.map((j) => `${j.slot}:${j.kind}`), ['a:post', 'a:story', 'b:story']);

  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ url: String(url).replace(/\?.*/, ''), body });
    if (/\/media$/.test(url)) return { ok: true, status: 200, json: async () => ({ id: 'C' + calls.length }) };
    if (/\/media_publish$/.test(url)) return { ok: true, status: 200, json: async () => ({ id: 'M1' }) };
    return { ok: true, status: 200, json: async () => ({ status_code: 'FINISHED' }) };
  };
  const r = await ig.igTick(s, { deadline: Date.now() + 300000 });
  assert.deepEqual(r, { posted: 1, stories: 2, failed: 0, waiting: 0 });
  const created = calls.filter((c) => /\/media$/.test(c.url));
  assert.equal(created[0].body.access_token, 'TA');
  assert.match(created[0].body.caption, /CHEGIRMA/);
  assert.equal(created[1].body.media_type, 'STORIES');
  assert.equal(created[2].body.access_token, 'TB');

  // limit 1 post a day for "a": a second product waits
  await ig.igAfterPost({ ...item, sku: '1002', product_id: 'P2' }, s);
  const r2 = await ig.igTick(s, { deadline: Date.now() + 300000 });
  assert.equal(r2.posted, 0); // the post waits for tomorrow (limit 1)
  assert.equal(r2.stories, 1); // its story still goes (limit 5)
  assert.equal(r2.waiting, 1);
});
