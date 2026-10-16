// node --test — "📅 Sana bo'yicha yuborish": dates, the post format, per-destination price / phone / button.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dateCaption, datePost, parseDay, showDay } from '../lib/datesend.js';

const NOW = Date.parse('2026-10-16T12:00:00+05:00');

test('DD.MM.YYYY (Tashkent), real dates only, not in the future', () => {
  assert.equal(parseDay('15.10.2026', NOW), '2026-10-15');
  assert.equal(parseDay('5.1.2026', NOW), '2026-01-05');
  assert.equal(parseDay('16.10.2026', NOW), '2026-10-16');
  for (const bad of ['17.10.2026', '31.02.2026', '32.10.2026', '15/10', '2026-10-15', 'kecha', '']) assert.equal(parseDay(bad, NOW), null, bad);
  assert.equal(showDay('2026-10-15'), '15.10.2026');
});

const item = { product_id: 'P1', sku: '8001', name: 'Krujka <A>', price: 12000, old_price: 15000, image_url: 'https://x/1.jpg', ds_kind: 'new' };

test('format A: header, name, SKU, price, empty line, contact', () => {
  assert.equal(
    dateCaption(item, '+998982000307'),
    "🆕 <b>YANGI MAHSULOT</b>\n\n🛍 Mahsulot nomi: Krujka &lt;A&gt;\n🔢 SKU: 8001\n💰 Narxi: <s>15 000</s> 12 000 so'm\n\n📞 Buyurtma uchun murojaat qiling: +998982000307",
  );
  const back = dateCaption({ ...item, ds_kind: 'back', old_price: undefined }, '+998982000307');
  assert.ok(back.startsWith('🔄 <b>YANA SOTUVDA!</b>\n\n') && back.includes("💰 Narxi: 12 000 so'm\n\n"));
});

test('2nd channel: marked-up prices, its own phone and button; elsewhere the BITO price', () => {
  const s = {
    phone: '+998982000307',
    order_url: 'https://t.me/Mixpodarok0307',
    order_in_bot: true,
    bot_username: 'bito_bot',
    channel2: { id: '-1002222', enabled: false, markup_percent: 30, phone: '+998907776655', order_url: 'https://t.me/shop_2kanal' },
  };
  const p2 = datePost(item, { id: '-1002222', kind: 'ch2' }, s);
  assert.ok(p2.caption.includes("<s>20 000</s> 16 000 so'm") && p2.caption.includes('+998907776655'));
  assert.equal(p2.reply_markup.inline_keyboard[0][0].url, 'https://t.me/shop_2kanal');
  const p1 = datePost(item, { id: '@ch', kind: 'ch1' }, s);
  assert.ok(p1.caption.includes("<s>15 000</s> 12 000 so'm") && p1.caption.includes('+998982000307'));
  assert.equal(p1.reply_markup.inline_keyboard[0][0].url, 'https://t.me/bito_bot?start=o_P1');
  const g = datePost(item, { id: '-100500', kind: 'group' }, s);
  assert.ok(g.caption.includes('12 000') && g.caption.includes('+998982000307'));
});
