// UX-11 — Account Receivables helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageingTotals, oldestBucket, creditBar } from '../../src/ux/arModel';

const rows = [
  { id: 1, current: 1500, '1_30': 0, '31_60': 2500, '61_90': 0, '90_plus': 0 },
  { id: 2, current: 0, '1_30': 0, '31_60': 0, '61_90': 750, '90_plus': 0 },
  { id: 3, current: 200, '1_30': 100, '31_60': 0, '61_90': 0, '90_plus': 4000 },
];
test('ageing totals add up; customers counted per bucket', () => {
  const t = ageingTotals(rows);
  assert.equal(t.total, 9050);
  assert.deepEqual(t.buckets.map((b) => [b.key, b.amount, b.customers]), [['current', 1700, 2], ['1_30', 100, 1], ['31_60', 2500, 1], ['61_90', 750, 1], ['90_plus', 4000, 1]]);
  assert.equal(ageingTotals([]).total, 0);
});
test('oldest debt per customer', () => {
  assert.equal(oldestBucket(rows[0]).key, '31_60');
  assert.equal(oldestBucket(rows[2]).key, '90_plus');
  assert.equal(oldestBucket({ current: 0 }), null);
  assert.equal(oldestBucket(undefined), null);
});
test('credit used', () => {
  assert.deepEqual(creditBar(50000, 30000), { pct: 0.6, shown: 0.6, over: 0, level: 'ok' });
  assert.equal(creditBar(50000, 42000).level, 'near');
  const o = creditBar(50000, 50508); assert.equal(o.level, 'over'); assert.equal(o.over, 508); assert.equal(o.shown, 1);
  assert.equal(creditBar(0, 100), null);
});
