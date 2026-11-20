// Sales Report helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localHour, salesByHour, hourLabel, payMix, paidBy } from '../../src/ux/salesModel';

// Build a UTC created_at for a given LOCAL hour, whatever zone the test runs in.
const at = (h, m = 0) => {
  const d = new Date(2026, 10, 20, h, m, 0);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00`;
};

test('local hour from the UTC timestamp', () => {
  assert.equal(localHour(at(7, 30)), 7);
  assert.equal(localHour('nonsense'), null);
});

test('sales through the day: gaps kept, reversed left out, busiest hour', () => {
  const r = salesByHour([
    { created_at: at(7, 5), total_amount: 36 },
    { created_at: at(7, 50), total_amount: 124.5 },
    { created_at: at(10, 0), total_amount: 1300 },
    { created_at: at(10, 20), total_amount: 500, status: 'Reversed' },
    { created_at: at(9, 15), total_amount: 48 },
  ]);
  assert.deepEqual(r.hours.map((h) => [h.hour, h.count, h.total]), [[7, 2, 160.5], [8, 0, 0], [9, 1, 48], [10, 1, 1300]]);
  assert.equal(r.busiest.hour, 10);
  assert.equal(r.max, 1300);
  assert.deepEqual(salesByHour([]), { hours: [], busiest: null, max: 0 });
});

test('hour labels', () => {
  assert.deepEqual([0, 7, 12, 13, 23].map(hourLabel), ['12am', '7am', '12pm', '1pm', '11pm']);
});

test('payment mix: largest first, empty parts dropped', () => {
  const m = payMix([{ key: 'cash', label: 'Cash', amount: 600 }, { key: 'momo', label: 'MoMo', amount: 0 }, { key: 'bank', label: 'Bank', amount: 400 }]);
  assert.equal(m.total, 1000);
  assert.deepEqual(m.parts.map((p) => [p.key, p.share]), [['cash', 0.6], ['bank', 0.4]]);
});

test('paid by', () => {
  assert.deepEqual(['Cash', 'MoMo', 'Bank', 'Credit', 'Partial-Credit', '', 'Voucher'].map((x) => paidBy({ payment_method: x }).label),
    ['Cash', 'MoMo', 'Bank', 'Credit', 'Part credit', '—', 'Voucher']);
});
