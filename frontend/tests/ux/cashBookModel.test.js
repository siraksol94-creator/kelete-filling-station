// Cash Book (Kelete K-only) helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, moneyOf, periodTotals, matches, groupDays, accounts, exportRows, isFuelReceipt } from '../../src/ux/cashBookModel';

const E = (date, type, reference, description, k_in, k_out, bal, extra = {}) => ({ date, type, reference, description, usd_in: 0, fra_in: 0, k_in, usd_out: 0, fra_out: 0, k_out, balance_usd: 0, balance_fra: 0, balance_k: bal, ...extra });
const rows = [
  E('2026-11-19', 'CR', 'CR-1', 'Fuel sales — 2026-11-19', 1000, 0, 1100),
  E('2026-11-19', 'PV', 'PV-1', 'Cleaning', 0, 50, 1050),
  E('2026-11-20', 'CR', 'CR-2', 'Shop sales', 300, 0, 1350),
  // TRF rows carry the amount in usd_in / usd_out on K branches
  E('2026-11-20', 'TRF', 'TRF-1', 'Cash → Bank', 0, 0, 1350, { usd_in: 900, usd_out: 900 }),
  E('2026-11-20', 'DEP-OUT', 'DEP-1', 'Deposit', 0, 200, 1150),
];

test('plain names; fuel day receipts recognised', () => {
  assert.equal(kindOf(rows[0]).label, 'Fuel takings');
  assert.ok(isFuelReceipt(rows[0]));
  assert.equal(kindOf(rows[2]).label, 'Receipt');
  assert.equal(kindOf(rows[4], 'Lusaka depot').label, 'Deposit to Lusaka depot');
  assert.equal(kindOf({ type: 'LOAN-INT' }).label, 'Loan interest');
  assert.equal(kindOf({ type: 'ODD' }).label, 'ODD');
});

test('a transfer is shown once as moved, never as money in and out', () => {
  assert.deepEqual(moneyOf(rows[3]), { in: 0, out: 0, moved: 900, balance: 1350 });
  assert.deepEqual(moneyOf(rows[1]), { in: 0, out: 50, moved: 0, balance: 1050 });
});

test('period totals', () => {
  assert.deepEqual(periodTotals(rows), { in: 1300, out: 250, moved: 900, fuel: 1000, net: 1050, count: 5 });
});

test('filters and search', () => {
  assert.deepEqual(rows.filter((e) => matches(e, 'in')).map((e) => e.reference), ['CR-1', 'CR-2']);
  assert.deepEqual(rows.filter((e) => matches(e, 'out')).map((e) => e.reference), ['PV-1', 'DEP-1']);
  assert.deepEqual(rows.filter((e) => matches(e, 'fuel')).map((e) => e.reference), ['CR-1']);
  assert.deepEqual(rows.filter((e) => matches(e, 'move')).map((e) => e.reference), ['TRF-1']);
  assert.deepEqual(rows.filter((e) => matches(e, 'dep')).map((e) => e.reference), ['DEP-1']);
  assert.deepEqual(rows.filter((e) => matches(e, 'all', 'clean')).map((e) => e.reference), ['PV-1']);
  assert.deepEqual(rows.filter((e) => matches(e, 'all', 'fuel tak')).map((e) => e.reference), ['CR-1']);
});

test('days: newest day first, rows in time order, closing = last row balance', () => {
  const d = groupDays(rows);
  assert.deepEqual(d.map((x) => [x.date, x.rows.map((r) => r.reference), x.in, x.out, x.moved, x.closing]), [
    ['2026-11-20', ['CR-2', 'TRF-1', 'DEP-1'], 300, 200, 900, 1150],
    ['2026-11-19', ['CR-1', 'PV-1'], 1000, 50, 0, 1050],
  ]);
});

test('accounts: opening → now; hidden empty methods left out', () => {
  const a = accounts({ openingByMethod: { cash: 100, momo: 0, bank: 500 }, currentByMethod: { cash: 400, momo: 0, bank: 750 } }, (k) => k !== 'momo');
  assert.deepEqual(a.list.map((x) => [x.key, x.open, x.now, x.change]), [['cash', 100, 400, 300], ['bank', 500, 750, 250]]);
  assert.deepEqual([a.open, a.now, a.change], [600, 1150, 550]);
  assert.ok(Math.abs(a.shares[0].share - 400 / 1150) < 1e-9);
});

test('export rows carry the figures the screen shows (the old export had empty K columns)', () => {
  const x = exportRows(rows);
  assert.deepEqual(x.map((r) => [r.type, r.money_in, r.money_out, r.balance]), [
    ['Fuel takings', 1000, 0, 1100], ['Payment voucher', 0, 50, 1050], ['Receipt', 300, 0, 1350],
    ['Moved between accounts', 900, 900, 1350], ['Deposit to HQ', 0, 200, 1150]]);
});
