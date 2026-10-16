// node --test  (npm test) — the "📢 2-kanal" price: markup, then to the nearest thousand (half up).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ch2Item, ch2Settings, channel2Target, markupPrice, normOrderTarget, normPhone2 } from '../lib/channel2.js';
import { orderLink } from '../lib/orders.js';

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

test('2nd channel phone: +998XXXXXXXXX only', () => {
  assert.equal(normPhone2('+998 90 777-66-55'), '+998907776655');
  assert.equal(normPhone2('998907776655'), '+998907776655');
  assert.equal(normPhone2('(+998) 90 777 66 55'), '+998907776655');
  for (const bad of ['901234567', '+99890777665', '+9989077766550', '+79991234567', 'abc', '']) assert.equal(normPhone2(bad), null, bad);
});

test('2nd channel order button target', () => {
  assert.deepEqual(normOrderTarget('@shop_2kanal'), { url: 'https://t.me/shop_2kanal' });
  assert.deepEqual(normOrderTarget('shop_2kanal'), { url: 'https://t.me/shop_2kanal' });
  assert.deepEqual(normOrderTarget('t.me/shop_2kanal'), { url: 'https://t.me/shop_2kanal' });
  assert.deepEqual(normOrderTarget('https://t.me/shop_2kanal'), { url: 'https://t.me/shop_2kanal' });
  assert.deepEqual(normOrderTarget('https://t.me/bot2?start=x'), { url: 'https://t.me/bot2?start=x' });
  assert.deepEqual(normOrderTarget('+998 90 111 22 33'), { url: 'https://t.me/+998901112233' });
  assert.deepEqual(normOrderTarget('tel:+998901112233'), { url: 'https://t.me/+998901112233' });
  assert.deepEqual(normOrderTarget('https://shop.uz/zakaz'), { url: 'https://shop.uz/zakaz' });
  for (const bad of ['ab', '@abc', 'http://shop.uz', 'tel:123', 'https://t.me/a b', 'javascript:alert(1)', '']) assert.ok(normOrderTarget(bad).error, bad);
});

test("2nd channel contact: its own, or the main channel's when empty", () => {
  const base = { phone: '+998982000307', order_url: 'https://t.me/Mixpodarok0307', order_in_bot: true, bot_username: 'bito_bot' };
  const item = { product_id: 'P1' };
  const same = ch2Settings({ ...base, channel2: { id: '-1', enabled: true, phone: '', order_url: '' } });
  assert.equal(same.phone, '+998982000307');
  assert.equal(orderLink(same, item), 'https://t.me/bito_bot?start=o_P1');
  const own = ch2Settings({ ...base, channel2: { id: '-1', enabled: true, phone: '+998907776655', order_url: 'https://t.me/shop_2kanal' } });
  assert.equal(own.phone, '+998907776655');
  assert.equal(orderLink(own, item), 'https://t.me/shop_2kanal');
  assert.equal(base.phone, '+998982000307'); // the main channel's settings are not changed
});
