// Cash receipts read once per method (same cases as backend test 30).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptSplit } from '../../src/ux/receiptModel';

const R = (cash, bank, momo, usd, fra, k) => ({ cash_amount: cash, bank_amount: bank, momo_amount: momo, usd_amount: usd, fra_amount: fra, k_amount: k });

test('Kwacha book: every kind of receipt once, under its method', () => {
  assert.deepEqual(receiptSplit(R(600, 300, 100, 0, 0, 1000)), { u: 600, f: 100, k: 300 }, 'fuel day receipt');
  assert.deepEqual(receiptSplit(R(0, 500, 0, 0, 0, 0)), { u: 0, f: 0, k: 500 }, 'customer payment by bank');
  assert.deepEqual(receiptSplit(R(200, 0, 50, 200, 50, 0)), { u: 200, f: 50, k: 0 }, 'Cash Receipt form');
  assert.deepEqual(receiptSplit(R(0, 0, 0, 0, 0, 80)), { u: 0, f: 0, k: 80 }, 'slots only');
  assert.deepEqual(receiptSplit({}), { u: 0, f: 0, k: 0 });
});

test('multi-currency book: unchanged reading', () => {
  assert.deepEqual(receiptSplit(R(10, 0, 0, 0, 0, 0), false), { u: 10, f: 0, k: 0 });
  assert.deepEqual(receiptSplit(R(0, 7, 0, 0, 0, 0), false), { u: 0, f: 7, k: 0 }, 'old bank column = FRA');
  assert.deepEqual(receiptSplit(R(5, 0, 0, 25, 3, 0), false), { u: 25, f: 3, k: 0 });
});
