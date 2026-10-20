import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentSlot, etaOf, paceWindow, parseHHMM, slotsPerDay } from '../lib/pacetime.js';

// Tashkent is UTC+5 all year.
const at = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:00`);
const W = paceWindow({}, 15);

test('57 slots a day from 09:00 to 23:00', () => {
  assert.equal(slotsPerDay(W), 57);
  assert.equal(slotsPerDay(paceWindow({ pace_from: '10:00', pace_to: '12:00' }, 30)), 5);
});

test('slot of the moment, nothing at night', () => {
  assert.equal(currentSlot(W, at('2026-10-20', '08:59')), null);
  assert.equal(currentSlot(W, at('2026-10-20', '09:00')).index, 0);
  assert.equal(currentSlot(W, at('2026-10-20', '09:14')).index, 0);
  assert.equal(currentSlot(W, at('2026-10-20', '09:15')).index, 1);
  assert.equal(currentSlot(W, at('2026-10-20', '23:00')).index, 56);
  assert.equal(currentSlot(W, at('2026-10-20', '23:04')).index, 56);
  assert.equal(currentSlot(W, at('2026-10-20', '23:05')), null);
  assert.equal(currentSlot(W, at('2026-10-20', '03:00')), null);
  assert.notEqual(currentSlot(W, at('2026-10-20', '10:00')).key, currentSlot(W, at('2026-10-21', '10:00')).key);
});

test('eta: 450 posts last 8 days', () => {
  const e = etaOf(W, 450, at('2026-10-20', '08:00'));
  // 450 = 7 * 57 + 51 -> the 8th day (offset 7), 51st slot = 09:00 + 50 * 15 min = 21:30
  assert.deepEqual(e, { day: '2026-10-27', time: '21:30', days: 7 });
  assert.deepEqual(etaOf(W, 1, at('2026-10-20', '10:07')), { day: '2026-10-20', time: '10:00', days: 0 });
  assert.deepEqual(etaOf(W, 1, at('2026-10-20', '10:07'), false), { day: '2026-10-20', time: '10:15', days: 0 });
  assert.deepEqual(etaOf(W, 2, at('2026-10-20', '23:30')), { day: '2026-10-21', time: '09:15', days: 1 });
});

test('parseHHMM', () => {
  assert.equal(parseHHMM('9:05'), 545);
  assert.equal(parseHHMM('24:00'), null);
  assert.equal(parseHHMM('abc'), null);
});
