// Profit Report — Shop | Fuel | Station arithmetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stationPL, stationMonth, monthRange, quickRanges, marginBar } from '../../src/ux/profitModel';

// Stored shop day: revenue 1,250 (incl. 250 credit fuel), cogs 600, damages 20,
// rebates 10, stock −15, cash −5 → gross 620; vouchers 300 + interest 20 → net 300.
const range = { revenue: 1250, cogs: 600, damages: 20, supplier_rebates: 10, diff_value: -15, cash_difference: -5, gross_profit: 620, net_profit: 300 };
const fuel = { totals: { revenue: 4700, cost: 3750, cash_variance: -10, gross_profit: 940 }, credit_in_shop: 250 };

test('credit fuel leaves the shop column and is counted once, in fuel', () => {
  const pl = stationPL(range, fuel);
  const row = (k) => pl.rows.find((r) => r.key === k);
  assert.deepEqual([row('sales').shop, row('sales').fuel, row('sales').station], [1000, 4700, 5700]);
  assert.deepEqual([row('gross').shop, row('gross').fuel, row('gross').station], [370, 940, 1310]);
  assert.equal(row('expenses').station, 320, 'vouchers + loan interest, taken once');
  assert.equal(pl.net, 990);
  assert.equal(row('cash').station, -15);
  assert.equal(row('damages').fuel, null);
});

test('the shop column ties back to its own stored figures', () => {
  const pl = stationPL(range, fuel);
  const s = (k) => pl.rows.find((r) => r.key === k).shop;
  assert.equal(s('sales') - s('cost') - s('damages') + s('rebates') + s('stock') + s('cash'), s('gross'));
});

test('station net = station gross − expenses, and = stored net − credit + fuel gross', () => {
  const pl = stationPL(range, fuel);
  assert.equal(pl.net, 300 - 250 + 940);
  assert.ok(Math.abs(pl.grossMargin - 1310 / 5700) < 1e-9);
});

test('no fuel: identical to the stored shop report', () => {
  const pl = stationPL(range, {});
  assert.equal(pl.rows[0].station, 1250);
  assert.equal(pl.net, 300);
  assert.equal(stationPL({}, {}).grossMargin, null);
});

test('month to date', () => {
  assert.deepEqual(
    stationMonth({ total_revenue: 9000, gross_profit: 3000, net_profit: 1000, total_difference: -40 }, { totals: { revenue: 50000, gross_profit: 6000, litres: 2000 }, credit_in_shop: 500 }),
    { sales: 58500, gross: 8500, net: 6500, litres: 2000, stockDifference: -40 });
});

test('month range is capped at today', () => {
  assert.deepEqual(monthRange('2026-11-05', '2026-11-20'), { from: '2026-11-01', to: '2026-11-20' });
  assert.deepEqual(monthRange('2026-10-05', '2026-11-20'), { from: '2026-10-01', to: '2026-10-31' });
  assert.deepEqual(monthRange('2024-02-10', '2026-11-20'), { from: '2024-02-01', to: '2024-02-29' });
});

test('quick ranges (Friday 20 Nov 2026)', () => {
  const q = Object.fromEntries(quickRanges('2026-11-20').map((r) => [r.key, [r.from, r.to]]));
  assert.deepEqual(q.today, ['2026-11-20', '2026-11-20']);
  assert.deepEqual(q.yesterday, ['2026-11-19', '2026-11-19']);
  assert.deepEqual(q.week, ['2026-11-16', '2026-11-20']);
  assert.deepEqual(q.month, ['2026-11-01', '2026-11-20']);
  assert.deepEqual(q.lastmonth, ['2026-10-01', '2026-10-31']);
  assert.deepEqual(Object.fromEntries(quickRanges('2026-01-04').map((r) => [r.key, [r.from, r.to]])).lastmonth, ['2025-12-01', '2025-12-31']);
});

test('margin bars', () => {
  assert.equal(marginBar(5, 5), 100);
  assert.equal(marginBar(2.5, 5), 50);
  assert.equal(marginBar(0.01, 5), 4);
  assert.equal(marginBar(-1, 5), 0);
  assert.equal(marginBar(3, 0), 0);
});
