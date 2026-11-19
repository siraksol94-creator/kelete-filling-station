// UX-12 — Pay box "customer gave" amounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quickCash } from '../../src/ux/posModel';

test('quick cash: exact first, then round notes above the total', () => {
  assert.deepEqual(quickCash(498), [498, 500, 600]);
  assert.deepEqual(quickCash(36), [36, 40, 50, 100]);
  assert.deepEqual(quickCash(20), [20, 50, 100, 200]);
  assert.deepEqual(quickCash(12.5), [12.5, 20, 50, 100]);
  assert.deepEqual(quickCash(309), [309, 310, 320, 350]);
  assert.deepEqual(quickCash(0), []);
  assert.deepEqual(quickCash(-5), []);
  for (const t of [7, 99.99, 1234.5]) quickCash(t).forEach((v) => assert.ok(v >= t));
});
