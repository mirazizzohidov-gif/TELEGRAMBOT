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

let calls = [];
let orders = [];
let details = {};
let failChats = new Set();
globalThis.fetch = async (url, opts = {}) => {
  if (String(url).includes('api.telegram.org')) {
    const body = JSON.parse(opts.body || '{}');
    calls.push({ method: url.split('/').pop(), body });
    if (failChats.has(String(body.chat_id))) {
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

const { acceptBitoOrder, formatBitoOrder, keepBitoOrdersFresh, notifyBitoOrder, pollBitoOrders } = await import('../lib/bito-orders.js');

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
