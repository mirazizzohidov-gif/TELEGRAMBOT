import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numbersAllowed, scrub } from '../lib/chatai.js';

test('scrub removes phones, handles and links', () => {
  const t = scrub('Salom +998 90 123 45 67 @ali_bek https://t.me/x narxi qancha?');
  assert.ok(!/998|ali_bek|http/.test(t));
  assert.match(t, /narxi qancha/);
});

test('numbersAllowed accepts context numbers only', () => {
  const ctx = "Ayiq: 150 000 so'm; Telefon: +998 71 200 00 00";
  assert.equal(numbersAllowed("Narxi 150 000 so'm", ctx), true);
  assert.equal(numbersAllowed("Narxi 120 000 so'm", ctx), false);
  assert.equal(numbersAllowed('Ertaga 9:00 da', ctx), false);
  assert.equal(numbersAllowed('Salom!', ctx), true);
});

test('time in default info is allowed', () => {
  assert.equal(numbersAllowed("9:00 dan ochiladi", "Ish vaqti: soat 9:00 dan ochiladi."), true);
});

test('phone formats and 09:00 vs 9:00 are equivalent', () => {
  const ctx = 'Ish vaqti: 09:00 dan 21:00 gacha. Telefon: +998981270307. Manzil: Hamkor 30A';
  assert.equal(numbersAllowed('Telefon: +998 98 127 03 07, soat 9:00 dan 21:00 gacha', ctx), true);
  assert.equal(numbersAllowed('Telefon: +998 98 127 03 08', ctx), false);
  assert.equal(numbersAllowed('Soat 10:00 da', ctx), false);
  assert.equal(numbersAllowed('30A manzil', ctx), true);
  assert.equal(numbersAllowed("Narxi 1 500 000 so'm", "Narxi: 1 500 000 so'm"), true);
});
