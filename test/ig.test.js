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
    if (/warm=1/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true }) };
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

test('token: junk refused; EAA (Facebook) token -> graph.facebook.com, account found via its page', async () => {
  mem.clear();
  assert.match((await ig.igSetToken('a', '1598037721635354')).message, /Bu token emas/);
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url).replace(/\?.*/, ''));
    if (/facebook\.com\/v[\d.]+\/me\?/.test(url)) return { ok: true, status: 200, json: async () => ({ id: '999' }) };
    if (/\/me\/accounts/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ name: 'Page', instagram_business_account: { id: '1784', username: 'mixpodarok' } }] }) };
    return { ok: false, status: 400, json: async () => ({ error: { message: 'x' } }) };
  };
  const r = await ig.igSetToken('a', ' "EAA' + 'x'.repeat(60) + '" ');
  assert.equal(r.ok, true, r.message);
  assert.ok(urls.every((u) => u.startsWith('https://graph.facebook.com/')));
  const t = await store.redis().hget(store.K.flag('ig:tok'), 'a');
  assert.deepEqual([t.user_id, t.username, t.host], ['1784', 'mixpodarok', 'fb']);
});

test('formats: Reels job + carousel collected and published when full; music in turn', async () => {
  mem.clear();
  const s = { ig: { a: { on: true, types: { new: true }, formats: { photo: false, reels: true, carousel: true }, carousel_size: 2, max_reels: 5, stories_posts: false }, b: { on: false } } };
  await store.redis().hset(store.K.flag('ig:tok'), { a: { token: 'TA', user_id: '11', refreshed_at: Date.now() } });
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(20000)]).toString('base64');
  assert.equal((await ig.igMusicAdd('Trek 1', wav)).ok, true);
  assert.match((await ig.igMusicAdd('bad', Buffer.alloc(20000).toString('base64'))).message, /audio/);
  for (const n of [1, 2]) await ig.igAfterPost({ ...item, type: 'new', fresh: true, old_price: null, sku: `20${n}`, product_id: `Q${n}` }, s);
  const q = await store.redis().lrange(store.K.flag('igq'));
  assert.deepEqual(q.map((j) => j.kind), ['reel', 'reel']);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ url: String(url).replace(/\?.*/, ''), body });
    if (/warm=1/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (/\/media$/.test(url)) return { ok: true, status: 200, json: async () => ({ id: 'C' + calls.length }) };
    if (/\/media_publish$/.test(url)) return { ok: true, status: 200, json: async () => ({ id: 'M' }) };
    return { ok: true, status: 200, json: async () => ({ status_code: 'FINISHED' }) };
  };
  const r = await ig.igTick(s, { deadline: Date.now() + 900000 });
  assert.equal(r.reels, 2);
  assert.equal(r.posted, 1); // the carousel
  const media = calls.filter((c) => /\/media$/.test(c.url)).map((c) => c.body);
  assert.equal(media.filter((b) => b.media_type === 'REELS').length, 2);
  const v = new URL(media.find((b) => b.media_type === 'REELS').video_url);
  assert.equal(v.pathname, '/api/igvid');
  assert.ok(ig.igCheck(v.searchParams.get('d'), v.searchParams.get('s')));
  assert.ok(ig.igDecodeVideo(v.searchParams.get('d')).m); // a track was picked
  assert.equal(media.filter((b) => b.is_carousel_item === 'true').length, 2);
  const parent = media.find((b) => b.media_type === 'CAROUSEL');
  assert.equal(parent.children.split(',').length, 2);
  assert.match(parent.caption, /1\. Hamyon.*\n2\. Hamyon/);
  assert.equal(Number(await store.redis().llen(store.K.flag('igcar:a'))), 0);
});
