// node --test — BITO sale-order announcement: message text and who receives it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemRedis } from './_mem.js';

process.env.BOT_TOKEN = 'T';
process.env.BITO_API_KEY = 'k';
process.env.ADMIN_IDS = '1';

const store = await import('../lib/store.js');
const redis = new MemRedis();
store.setRedis(redis);

const sharp = (await import('sharp')).default;
const jpegOf = (color) => sharp({ create: { width: 30, height: 20, channels: 3, background: color } }).jpeg().toBuffer();
const photos = {
  'https://img.test/1.jpg': await jpegOf('#c04040'),
  'https://img.test/2.jpg': await jpegOf('#4080c0'),
  'https://img.test/3.jpg': await jpegOf('#40a060'),
};

let calls = [];
let orders = [];
let details = {};
let failChats = new Set();
let failPhoto = new Set();
globalThis.fetch = async (url, opts = {}) => {
  if (photos[url]) {
    const jpeg = photos[url];
    return { ok: true, status: 200, arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.byteLength) };
  }
  if (String(url).includes('api.telegram.org')) {
    const method = url.split('/').pop();
    const body = opts.body instanceof FormData
      ? { form: true, chat_id: opts.body.get('chat_id'), caption: opts.body.get('caption'), photo: opts.body.get('photo') }
      : JSON.parse(opts.body || '{}');
    calls.push({ method, body });
    const chatId = String(body.chat_id);
    if (failChats.has(chatId) || (method === 'sendPhoto' && failPhoto.has(chatId))) {
      return { json: async () => ({ ok: false, error_code: 403, description: 'bot is not a member of the chat' }) };
    }
    return { json: async () => ({ ok: true, result: { message_id: calls.length } }) };
  }
  const path = String(url).replace(/^.*\/v2/, '');
  calls.push({ method: 'BITO ' + path });
  const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data }) });
  if (path === '/sale-order/get-paging') return ok({ total: orders.length, data: orders });
  if (path.startsWith('/sale-order/get-by-id/')) return ok(details[decodeURIComponent(path.split('/').pop())] || null);
  return { ok: false, status: 404, text: async () => JSON.stringify({ code: 404, message: 'no' }) };
};

const { COLLAGE_MAX, acceptBitoOrder, buildOrderCollage, formatBitoOrder, keepBitoOrdersFresh, notifyBitoOrder, orderPhotoChoice, pollBitoOrders } = await import('../lib/bito-orders.js');

const sentTo = () => calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.body.chat_id));

test('format: Uzbek message keeps id, customer, items, sum, time, phone and link', () => {
  const text = formatBitoOrder({
    _id: 'ord-1',
    number: '1042',
    customer: { name: 'Ali <Valiyev>', phone_number: '+998901112233' },
    url: 'https://pay.example/o/1042',
    products: [
      { product: { name: 'Krujka' }, amount: 2 },
      { name: 'Stiker', quantity: 1 },
    ],
    total_to_pay: 45000,
    created_at: '2026-10-23T11:46:00Z',
    api_key: 'super-secret-key',
    token: 'bot-token',
    note: 'secret=do-not-copy',
    customer_custom: { secret: 'nope' },
  });
  assert.match(text, /Yangi BITO buyurtma #ord-1/);
  assert.match(text, /Mijoz: Ali &lt;Valiyev&gt;/);
  assert.match(text, /Krujka — 2 dona/);
  assert.match(text, /Stiker — 1 dona/);
  assert.match(text, /45 000 so'm/);
  assert.match(text, /23\.10\.2026 16:46/);
  assert.match(text, /\+998901112233/);
  assert.match(text, /https:\/\/pay\.example\/o\/1042/);
  assert.equal(text.includes('super-secret-key'), false);
  assert.equal(text.includes('bot-token'), false);
  assert.equal(text.includes('do-not-copy'), false);
});

test('format: absent fields are left out', () => {
  const text = formatBitoOrder({ number: '7' });
  assert.match(text, /#7/);
  assert.equal(text.includes('Mijoz'), false);
  assert.equal(text.includes('Mahsulotlar'), false);
  assert.equal(text.includes('Jami'), false);
  assert.equal(text.includes('Vaqt'), false);
  assert.equal(text.includes('📞'), false);
  assert.equal(text.includes('🔗'), false);
});

test('notify: every configured group and admin id is targeted, one failure does not stop the rest', async () => {
  calls = [];
  failChats = new Set(['-100222']);
  const settings = {
    bito_order_notify: true,
    bito_order_chats: ['-100111', '-100222'],
    bito_order_admins: ['42', '77'],
  };
  const result = await notifyBitoOrder({ _id: 'ord-9', number: '9', customer: { name: 'Dilnoza' }, total_price: 1000 }, settings);
  assert.deepEqual(sentTo(), ['-100111', '-100222', '42', '77']);
  assert.deepEqual(result.sent, ['-100111', '42', '77']);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].chat_id, '-100222');
  assert.match(calls.find((c) => c.body?.chat_id === '42').body.text, /Dilnoza/);
});

test('poll: first sight is silent, the next new order goes to each group and admin', async () => {
  calls = [];
  failChats = new Set();
  orders = [{ _id: 'old', number: '1', customer: { name: 'Eski' }, created_at: '2026-10-01T00:00:00Z' }];
  details = {};
  await store.updateSettings({ bito_order_notify: true, bito_order_chats: ['-100111'], bito_order_admins: ['42'] });
  const first = await pollBitoOrders();
  assert.equal(first.primed, true);
  assert.equal(sentTo().length, 0);

  orders = [
    ...orders,
    { _id: 'new', number: '2', customer: { name: 'Yangi', phone_number: '+998909998877' }, total_to_pay: 15000, created_at: '2026-10-23T12:00:00Z' },
  ];
  details.new = {
    _id: 'new',
    products: [{ product: { name: 'Album' }, amount: 3 }],
    total_to_pay: 15000,
  };
  calls = [];
  const second = await pollBitoOrders();
  assert.equal(second.notified, 1);
  assert.deepEqual(sentTo(), ['-100111', '42']);
  const text = calls.find((c) => c.method === 'sendMessage').body.text;
  assert.match(text, /Album — 3 dona/);
  assert.match(text, /15 000 so'm/);
  assert.match(text, /\+998909998877/);

  calls = [];
  const third = await pollBitoOrders();
  assert.equal(third.notified, 0);
  assert.equal(sentTo().length, 0);
});

test('collage choice: none, one photo, or one grid of up to 4', async () => {
  assert.deepEqual(orderPhotoChoice({ number: '1', products: [{ name: 'Krujka', amount: 1 }] }), { choice: 'none', urls: [] });
  const one = orderPhotoChoice({ products: [{ product: { name: 'Krujka', image: '/files/krujka.jpg' }, amount: 1 }] });
  assert.equal(one.choice, 'one');
  assert.equal(one.urls.length, 1);
  assert.match(one.urls[0], /^https:\/\/api\.bito\.uz\/upload-api\/public\/files\/krujka\.jpg$/);
  const many = orderPhotoChoice({
    products: [
      { image: 'https://img.test/1.jpg' },
      { product: { image_url: 'https://img.test/2.jpg' } },
      { images: ['https://img.test/1.jpg'] },
      { image: 'https://cdn.example/a.jpg?token=secret' },
      { image_url: 'https://img.test/3.jpg' },
      { image: 'https://img.test/4.jpg' },
      { image: 'https://img.test/5.jpg' },
    ],
  });
  assert.equal(many.choice, 'many');
  assert.equal(many.urls.length, COLLAGE_MAX);
  assert.deepEqual(many.urls, ['https://img.test/1.jpg', 'https://img.test/2.jpg', 'https://img.test/3.jpg', 'https://img.test/4.jpg']);
  assert.equal(many.urls.some((u) => u.includes('secret')), false);

  const colors = ['#c04040', '#4080c0', '#40a060', '#e0c040'];
  const bufs = await Promise.all(colors.map((c) => jpegOf(c)));
  const grid = await buildOrderCollage(bufs);
  const meta = await sharp(grid).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 480 * 2 + 8);
  assert.equal(meta.height, 480 * 2 + 8);
});

test('notify photo: one image is that photo, many is one collage, a failed photo falls back to text', async () => {
  const settings = { bito_order_notify: true, bito_order_chats: ['-100111', '-100222'], bito_order_admins: [] };
  calls = [];
  failChats = new Set();
  failPhoto = new Set();
  await notifyBitoOrder({ _id: 'p1', customer: { name: 'Ali' }, products: [{ product: { name: 'Krujka', image: 'https://img.test/1.jpg' }, amount: 1 }] }, settings);
  const one = calls.filter((c) => c.method === 'sendPhoto');
  assert.equal(one.length, 2);
  assert.equal(calls.some((c) => c.method === 'sendMediaGroup'), false);
  assert.equal(calls.some((c) => c.method === 'sendMessage'), false);
  assert.equal(one[0].body.photo, 'https://img.test/1.jpg');
  assert.match(one[0].body.caption, /Ali/);
  assert.match(one[0].body.caption, /Krujka — 1 dona/);

  calls = [];
  await notifyBitoOrder({
    _id: 'p2',
    customer: { name: 'Vali' },
    products: [
      { name: 'A', image: 'https://img.test/1.jpg', amount: 1 },
      { name: 'B', image: 'https://img.test/2.jpg', amount: 2 },
    ],
  }, settings);
  const many = calls.filter((c) => c.method === 'sendPhoto');
  assert.equal(many.length, 2);
  assert.equal(many[0].body.form, true);
  assert.equal(typeof many[0].body.photo, 'object');
  assert.match(many[0].body.caption, /Vali/);
  assert.equal(calls.some((c) => c.method === 'sendMediaGroup'), false);

  calls = [];
  failPhoto = new Set(['-100222']);
  const result = await notifyBitoOrder({ _id: 'p3', customer: { name: 'Sora' }, products: [{ image: 'https://img.test/1.jpg', amount: 1 }] }, settings);
  assert.deepEqual(result.sent, ['-100111', '-100222']);
  assert.equal(result.failed.length, 0);
  assert.equal(calls.filter((c) => c.method === 'sendPhoto' && c.body.chat_id === '-100111').length, 1);
  assert.equal(calls.filter((c) => c.method === 'sendPhoto' && c.body.chat_id === '-100222').length, 1);
  assert.equal(calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === '-100222').length, 1);
  assert.match(calls.find((c) => c.method === 'sendMessage').body.text, /Sora/);
  failPhoto = new Set();
});

test('dedupe: the tick and GET /api/bito-orders send one order once', async () => {
  calls = [];
  failChats = new Set();
  const settings = { bito_order_notify: true, bito_order_chats: ['-100111'], bito_order_admins: ['42'] };
  const order = { _id: 'race-1', number: '8', customer: { name: 'Race' }, total_price: 1000 };
  const [a, b] = await Promise.all([acceptBitoOrder(order, settings), acceptBitoOrder(order, settings)]);
  assert.deepEqual(sentTo(), ['-100111', '42']);
  assert.equal([a, b].filter((r) => r.sent?.length).length, 1);
  assert.equal([a, b].filter((r) => r.skipped === 'duplicate').length, 1);
});

test('loop: polls once a minute, then hands off, and a second copy stays out', async () => {
  await store.updateSettings({ bito_order_notify: true, bito_order_chats: ['-100111'], bito_order_admins: ['42'] });
  let t = 0;
  const sleeps = [];
  const kicks = [];
  const result = await keepBitoOrdersFresh({
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    kick: async () => {
      kicks.push(1);
      return { status: 200 };
    },
    interval: 60_000,
    budget: 150_000,
  });
  assert.equal(result.polls, 3);
  assert.deepEqual(sleeps, [60_000, 60_000]);
  assert.equal(kicks.length, 1);

  await store.lock('bito-order-loop', 150);
  const busy = await keepBitoOrdersFresh({
    now: () => 0,
    sleep: async () => {},
    kick: async () => ({ status: 200 }),
    budget: 1,
  });
  assert.equal(busy.skipped, 'running');
  assert.equal(busy.polls, 0);
  await store.unlock('bito-order-loop');
});
