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
