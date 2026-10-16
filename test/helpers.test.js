// node --test — "👥 Yordamchi adminlar": input parsing and the post template.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helperPost, parseHelperRef, parseName, parsePrice, parseSku } from '../lib/helpers.js';

test('price: 185000, 185 000, "185 000 so\'m" accepted; others refused', () => {
  for (const ok of ['185000', '185 000', "185 000 so'm", '185 000 som', '185.000', '185,000', '185 000 сум', ' 185000 ']) assert.equal(parsePrice(ok), 185000, ok);
  for (const bad of ['', '0', '-5', 'abc', '185k', '1e5', '18 5o0']) assert.equal(parsePrice(bad), null, bad);
});

test('name: trimmed, at most 200 characters', () => {
  assert.equal(parseName('  Krujka   "Sevgi"  ').value, 'Krujka "Sevgi"');
  assert.equal(parseName('a'.repeat(200)).value.length, 200);
  assert.ok(parseName('a'.repeat(201)).error.includes('200'));
  assert.ok(parseName('   ').error);
});

test('SKU: letters, digits, "-", no spaces', () => {
  assert.equal(parseSku(' 670899 ').value, '670899');
  assert.equal(parseSku('KR-12/A').value, 'KR-12/A');
  for (const bad of ['', '12 34', '<b>', '-12', 'x'.repeat(41)]) assert.ok(parseSku(bad).error, bad);
});

test('helper reference: ID (+ name) or a forwarded message', () => {
  assert.deepEqual(parseHelperRef({ text: '123456789' }), { id: '123456789', name: '' });
  assert.deepEqual(parseHelperRef({ text: '123456789 Ali Valiyev' }), { id: '123456789', name: 'Ali Valiyev' });
  assert.deepEqual(parseHelperRef({ text: 'x', forward_origin: { type: 'user', sender_user: { id: 555666777, first_name: 'Vali', last_name: 'Aliyev' } } }), { id: '555666777', name: 'Vali Aliyev' });
  assert.deepEqual(parseHelperRef({ forward_from: { id: 555666778, first_name: 'Olim' } }), { id: '555666778', name: 'Olim' });
  assert.ok(parseHelperRef({ forward_origin: { type: 'hidden_user', sender_user_name: 'X' } }).error.includes('yashirgan'));
  assert.ok(parseHelperRef({ text: 'salom' }).error);
});

const s = {
  phone: '+998982000307',
  order_url: 'https://t.me/Mixpodarok0307',
  order_in_bot: true,
  bot_username: 'bito_bot',
  channel2: { id: '-1002222', enabled: true, markup_percent: 30, phone: '+998907776655', order_url: 'https://t.me/shop_2kanal' },
};
const d = { photo: 'PHOTO_ID', name: 'Krujka <b>"Sevgi"</b> & co', sku: '670899', price: 185000 };

test('template exactly; the name is HTML-escaped', () => {
  const p = helperPost(d, { id: '-100500', label: '👥 Ombor', kind: 'group' }, s);
  assert.equal(
    p.caption,
    "🆕 YANGI MAHSULOT\n\n🛍 Mahsulot nomi: Krujka &lt;b&gt;\"Sevgi\"&lt;/b&gt; &amp; co\n🔖 SKU: 670899\n💰 Narxi: 185 000 so'm\n\n📞 Buyurtma uchun murojaat qiling: +998982000307",
  );
  assert.equal(p.photo, 'PHOTO_ID');
  assert.equal(p.parse_mode, 'HTML');
  assert.deepEqual(p.reply_markup, { inline_keyboard: [[{ text: '🛒 Buyurtma berish', url: 'https://t.me/bito_bot?start=o' }]] });
});

test('2nd channel: marked-up price, its own phone and button', () => {
  const p = helperPost(d, { id: '-1002222', label: '📢 2-kanal', kind: 'ch2' }, s);
  assert.ok(p.caption.includes("💰 Narxi: 241 000 so'm") && p.caption.includes('+998907776655')); // 240 500 -> 241 000
  assert.equal(p.reply_markup.inline_keyboard[0][0].url, 'https://t.me/shop_2kanal');
  const p1 = helperPost(d, { id: '@ch', label: '📢 ch', kind: 'ch1' }, s);
  assert.ok(p1.caption.includes("185 000 so'm") && p1.caption.includes('+998982000307'));
});
