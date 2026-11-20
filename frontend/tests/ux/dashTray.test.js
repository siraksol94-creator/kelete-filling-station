// UX-12 — Dashboard shortcuts tray counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voucherSummary } from '../../src/ux/dashTrayModel';

test('only active slips with something left are counted', () => {
  assert.deepEqual(voucherSummary([
    { status: 'ACTIVE', qty_remaining: 12 },
    { status: 'active', qty_remaining: 3 },
    { status: 'ACTIVE', qty_remaining: 0 },
    { status: 'CLAIMED', qty_remaining: 5 },
    { status: 'VOID', qty_remaining: 9 },
    null,
  ]), { slips: 2, units: 15 });
});
test('nothing or bad data gives zero, not an error', () => {
  assert.deepEqual(voucherSummary(undefined), { slips: 0, units: 0 });
  assert.deepEqual(voucherSummary({ error: 'x' }), { slips: 0, units: 0 });
});
import { trayTiles } from '../../src/ux/dashTrayModel';

test('Point of Sale shows for till users, at branches and at head office', () => {
  assert.deepEqual(trayTiles({ hq: false, canPos: true, canVouchers: true }), ['pos', 'vouchers']);
  assert.deepEqual(trayTiles({ hq: true, canPos: true, canVouchers: true }), ['pos']);
  assert.deepEqual(trayTiles({ hq: false, canPos: false, canVouchers: true }), ['vouchers']);
  assert.deepEqual(trayTiles({ hq: true, canPos: false, canVouchers: true }), []);
  assert.deepEqual(trayTiles(), []);
});
