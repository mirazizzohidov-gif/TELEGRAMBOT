// node --test  (npm test) — the "📢 2-kanal" price: markup, then to the nearest thousand (half up).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ch2Item, channel2Target, markupPrice } from '../lib/channel2.js';

test('rounding only (0%): floor(x / 1000 + 0.5) × 1000', () => {
  assert.equal(markupPrice(16049, 0), 16000);
  assert.equal(markupPrice(15600, 0), 16000);
  assert.equal(markupPrice(15470, 0), 15000);
  assert.equal(markupPrice(999, 0), 1000);
  assert.equal(markupPrice(1500, 0), 2000); // half goes up
  assert.equal(markupPrice(1499, 0), 1000);
});

test('30% markup', () => {
  assert.equal(markupPrice(12345, 30), 16000); // 16 048.5 -> 16 000
  assert.equal(markupPrice(22000, 30), 29000); // 28 600 -> 29 000
  assert.equal(markupPrice(1250, 20), 2000); // exactly 1 500 (integer math) -> 2 000
});

test('no price stays no price; a small price never becomes 0', () => {
  assert.equal(markupPrice(0, 30), 0);
  assert.equal(markupPrice(-500, 30), 0);
  assert.equal(markupPrice(undefined, 30), 0);
  assert.equal(markupPrice('abc', 30), 0);
  assert.equal(markupPrice(300, 0), 1000);
});

test('a bad percent counts as 0', () => {
  assert.equal(markupPrice(15600, -10), 16000);
  assert.equal(markupPrice(15600, 501), 16000);
  assert.equal(markupPrice(15600, 2.5), 16000);
  assert.equal(markupPrice(10000, 500), 60000);
});

test('discount post: old and new price both marked up, then rounded', () => {
  const item = { sku: '1', price: 12000, old_price: 15000, type: 'discount' };
  const m = ch2Item(item, 30);
  assert.equal(m.price, 16000); // 15 600
  assert.equal(m.old_price, 20000); // 19 500
  assert.equal(item.price, 12000); // the original item is not changed
  assert.equal(ch2Item({ price: 12000, old_price: 0 }, 30).old_price, 0);
});

test('target only when connected and switched on', () => {
  assert.equal(channel2Target({}), null);
  assert.equal(channel2Target({ channel2: { id: '-1001', enabled: false, markup_percent: 30 } }), null);
  assert.deepEqual(channel2Target({ channel2: { id: '-1001', title: 'K2', enabled: true, markup_percent: 30 } }), { id: '-1001', title: 'K2', markup: 30, ch2: true });
});
