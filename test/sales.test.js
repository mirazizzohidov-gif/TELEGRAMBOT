// node --test — BITO sales reports: "/reports/..." paths, the request body, both answer shapes,
// adding sold lines up per product, the unsold report (with the sales-report fallback).
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.BITO_API_KEY = 'test:key';
process.env.BITO_API_URL = 'https://bito.test/integration/api/v2';
const store = await import('../lib/store.js');
const sales = await import('../lib/sales.js');

// a tiny in-memory Redis for the stock records / remembered path
const mem = new Map();
store.setRedis({
  get: async (k) => (mem.has(k) ? mem.get(k) : null),
  set: async (k, v) => (mem.set(k, v), 'OK'),
  hgetall: async (k) => mem.get(k) || null,
  del: async (k) => (mem.delete(k) ? 1 : 0),
});

let calls = [];
let routes = {};
globalThis.fetch = async (url, opts) => {
  const path = url.replace('https://bito.test/integration/api/v2', '');
  const body = JSON.parse(opts.body || '{}');
  calls.push({ path, body });
  const h = routes[path];
  if (!h) return { ok: false, status: 404, text: async () => JSON.stringify({ code: 404, message: `Route POST:/integration/api/v2${path} not found` }) };
  return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: h(body) }) };
};
const reset = () => {
  calls = [];
  routes = {};
  mem.clear();
};

test('answer shapes: { list, total }, { data, total, total_amounts }, plain array', () => {
  assert.deepEqual(sales.reportList({ list: [1, 2], total: 2 }), { list: [1, 2], total: 2, totals: null });
  assert.deepEqual(sales.reportList({ data: [1], total: 5, total_amounts: { amount: 3 } }), { list: [1], total: 5, totals: { amount: 3 } });
  assert.deepEqual(sales.reportList({ data: [1], total_data: { items_sold: 1 } }).totals, { items_sold: 1 });
  assert.deepEqual(sales.reportList([7]).list, [7]);
  assert.deepEqual(sales.reportList(null).list, []);
});

test('row mapping: a sold line (by-product) and a product total (by-item)', () => {
  assert.deepEqual(sales.saleRow({ _id: 'LINE1', amount: 2, price: 30000, total_price: 60000, product: { _id: 'P1', name: 'Hamyon', category: { name: 'Hamyonlar' } } }), {
    pid: 'P1', name: 'Hamyon', sold: 2, net: 60000, category: 'Hamyonlar',
  });
  assert.deepEqual(sales.saleRow({ product_id: 'P2', product_name: 'Krujka', category_name: 'Sovg\'a', items_sold: 5, items_refunded: 1, gross_sales: 100, net_sales: 90 }), {
    pid: 'P2', name: 'Krujka', sold: 4, net: 90, category: "Sovg'a",
  });
  assert.equal(sales.saleRow({ _id: 'LINE2', amount: 1, price: 5 }).pid, null); // a line without its product is not a product
});

test('sales report: /reports/trade/by-product/pagin first, body per docs, lines added up per product', async () => {
  reset();
  const lines = [
    { _id: 'L1', amount: 2, total_price: 60000, state: 'done', product: { _id: 'P1', name: 'Hamyon' } },
    { _id: 'L2', amount: 1, total_price: 30000, state: 'done', product: { _id: 'P1', name: 'Hamyon' } },
    { _id: 'L3', amount: 1, total_price: 20000, state: 'cancelled', product: { _id: 'P1', name: 'Hamyon' } },
    { _id: 'L4', amount: 3, price: 5000, product: { _id: 'P2', name: 'Oyna' } },
  ];
  routes['/reports/trade/by-product/pagin'] = () => ({ data: lines, total: lines.length, total_amounts: { amount: 6, total_price: 105000 } });
  const r = await sales.salesByItem(7);
  assert.equal(calls[0].path, '/reports/trade/by-product/pagin');
  const b = calls[0].body;
  assert.equal(b.page, 1);
  assert.equal(b.limit, 200);
  assert.match(b.date_from, /^\d{4}-\d{2}-\d{2}T00:00:00\+05:00$/);
  assert.match(b.date_to, /T23:59:59\+05:00$/);
  assert.equal(b.from_date, b.date_from);
  assert.equal(b.to_date, b.date_to);
  const p1 = r.rows.find((x) => x.pid === 'P1');
  const p2 = r.rows.find((x) => x.pid === 'P2');
  assert.deepEqual([p1.sold, p1.net, p2.sold, p2.net], [3, 90000, 3, 15000]);
  assert.deepEqual(r.total, { sold: 6, net: 105000, gross: 105000 });
  assert.equal(mem.get(store.K.salesPath), '/reports/trade/by-product/pagin');
});

test('sales report: { list, total } pages; a product-total shape works too', async () => {
  reset();
  const all = Array.from({ length: 250 }, (_, i) => ({ product_id: `P${i % 2}`, product_name: 'x', items_sold: 1, net_sales: 10 }));
  routes['/reports/trade/by-product/pagin'] = (b) => ({ list: all.slice((b.page - 1) * 200, b.page * 200), total: all.length });
  const r = await sales.salesByItem(14);
  assert.equal(calls.length, 2);
  assert.deepEqual(r.rows.map((x) => x.sold).sort(), [125, 125]);
  assert.deepEqual(r.total, { sold: 250, net: 2500, gross: 0 });
});

test('BITO_SALES_PATH is tried first; the old "/report/..." guesses are gone', async () => {
  reset();
  process.env.BITO_SALES_PATH = '/reports/custom/sales';
  routes['/reports/trade/by-product/pagin'] = () => ({ data: [], total: 0 });
  await sales.salesByItem(30);
  assert.deepEqual(calls.map((c) => c.path), ['/reports/custom/sales', '/reports/trade/by-product/pagin']);
  delete process.env.BITO_SALES_PATH;
  assert.ok(sales.SALES_PATHS.every((p) => p.startsWith('/reports/')));
  reset();
  await assert.rejects(sales.salesByItem(60), (e) => e.message.includes("BITO sotuv hisobotini olib bo'lmadi") && e.message.includes('/reports/trade/by-product/pagin'));
});

test('unsold: /reports/sales/items/unsold-paging, sold rows dropped, SKU / price from the stock records', async () => {
  reset();
  mem.set(store.K.stock, { U1: { sku: '701', name: 'Vaza', stock: 4, price: 50000 }, U2: { sku: '702', name: 'Gul', stock: 2, price: 10000 } });
  routes['/reports/sales/items/unsold-paging'] = () => ({
    data: [
      { _id: 'U1', product_name: 'Vaza', quantity: 4, items_sold: 0, days_in_warehouse: 70 },
      { _id: 'U2', product_name: 'Gul', quantity: 2, items_sold: 0, days_in_warehouse: 65 },
      { _id: 'S1', product_name: 'Sotilgan', quantity: 9, items_sold: 3 },
      { _id: 'Z0', product_name: 'Tugagan', quantity: 0, items_sold: 0 },
    ],
    total: 4,
  });
  const r = await sales.slowMovers({ unsold_days: 60 });
  assert.equal(calls[0].path, '/reports/sales/items/unsold-paging');
  assert.equal(r.source, 'unsold');
  assert.deepEqual(r.list.map((x) => [x.pid, x.sku, x.money, x.days_in_warehouse]), [['U1', '701', 200000, 70], ['U2', '702', 20000, 65]]);
  assert.ok(sales.slowLines(r)[2].includes('Vaza — SKU 701 — qoldiq 4') && sales.slowLines(r)[2].includes('omborda 70 kun'));
});

test('unsold report missing or not filtering -> worked out from the sales report', async () => {
  reset();
  mem.set(store.K.stock, { A: { sku: '1', stock: 3, price: 1000, seen_at: 1 }, B: { sku: '2', stock: 5, price: 1000, seen_at: 1 } });
  routes['/reports/trade/by-product/pagin'] = () => ({ data: [{ amount: 1, total_price: 1000, product: { _id: 'A' } }], total: 1 });
  let r = await sales.slowMovers({ unsold_days: 30 });
  assert.equal(r.source, 'sales');
  assert.deepEqual(r.list.map((x) => x.pid), ['B']);
  reset();
  mem.set(store.K.stock, { A: { sku: '1', stock: 3, price: 1000, seen_at: 1 }, B: { sku: '2', stock: 5, price: 1000, seen_at: 1 } });
  routes['/reports/sales/items/unsold-paging'] = () => ({ data: [{ _id: 'A', quantity: 3, items_sold: 5 }], total: 1 });
  routes['/reports/trade/by-product/pagin'] = () => ({ data: [{ amount: 1, total_price: 1000, product: { _id: 'A' } }], total: 1 });
  r = await sales.slowMovers({ unsold_days: 30 });
  assert.equal(r.source, 'sales');
  assert.deepEqual(r.list.map((x) => x.pid), ['B']);
});
