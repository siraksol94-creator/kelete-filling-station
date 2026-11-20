// HQ Consolidated Profit — Shop | Fuel | Station across branches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchLine, branchDays, groupGrades, hqGroup } from '../../src/ux/hqProfitModel';

const grade = (code, name, litres, revenue, cost, est = 0) => ({ code, name, color: '#111111', litres, revenue, cost, margin: revenue - cost, estimated_litres: est });
const lusaka = {
  slug: 'lusaka', name: 'Lusaka',
  // stored shop: revenue 1,250 incl. 250 credit fuel; gross 620; net 300 (expenses 320)
  totals: { revenue: 1250, cogs: 600, gross: 620, pv: 300, net: 300 },
  daily: [{ date: '2026-11-19', revenue: 0, cogs: 0, gross: 0, pv: 0, net: 0 }, { date: '2026-11-20', revenue: 1250, cogs: 600, gross: 620, pv: 300, net: 300 }],
  fuel: {
    totals: { litres: 180, revenue: 4700, cost: 3750, margin: 950, cash_variance: -10, gross_profit: 940, estimated_litres: 100 },
    credit_in_shop: 250,
    grades: [grade('ULP', 'Petrol', 140, 3500, 2800, 100), grade('DSL', 'Diesel', 40, 1200, 950)],
    daily: [{ date: '2026-11-20', litres: 180, revenue: 4700, cost: 3750, margin: 950, cash_variance: -10, gross_profit: 940, credit_in_shop: 250 }],
  },
};
const mansa = {
  slug: 'mansa', name: 'Mansa',
  totals: { revenue: 800, cogs: 500, gross: 300, pv: 100, net: 200 },
  daily: [{ date: '2026-11-20', revenue: 800, cogs: 500, gross: 300, pv: 100, net: 200 }],
  fuel: null,
};

test('a branch line: credit fuel out of Shop, counted once in Fuel', () => {
  const b = branchLine(lusaka);
  assert.deepEqual([b.shopSales, b.fuelSales, b.sales], [1000, 4700, 5700]);
  assert.deepEqual([b.shopGross, b.fuelGross, b.gross, b.expenses, b.net], [370, 940, 1310, 320, 990]);
  assert.equal(b.perLitre, 5.28);
  assert.equal(b.hasFuel, true);
});

test('a branch with no forecourt shows its shop figures exactly as stored', () => {
  const b = branchLine(mansa);
  assert.deepEqual([b.sales, b.gross, b.expenses, b.net, b.perLitre, b.hasFuel], [800, 300, 100, 200, null, false]);
});

test('days: empty days hidden, shop and fuel merged per date', () => {
  const d = branchDays(lusaka);
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].date, d[0].sales, d[0].net], ['2026-11-20', 5700, 990]);
  // a fuel-only day (no stored shop row) still shows
  const fuelOnly = { ...lusaka, daily: [], fuel: { ...lusaka.fuel, credit_in_shop: 0, daily: [{ date: '2026-11-18', litres: 10, revenue: 250, cost: 200, margin: 50, cash_variance: 0, gross_profit: 50, credit_in_shop: 0 }] } };
  assert.deepEqual(branchDays(fuelOnly).map((x) => [x.date, x.sales, x.net]), [['2026-11-18', 250, 50]]);
});

test('group: branches added, HQ overhead taken once', () => {
  const g = hqGroup({ branches: [lusaka, mansa], hq_overhead: { total: 400 } });
  assert.equal(g.sales, 6500);
  assert.equal(g.branchNet, 1190);
  assert.equal(g.groupNet, 790);
  assert.equal(g.credit, 250);
  assert.equal(g.litres, 180);
  assert.equal(g.estimatedLitres, 100);
  assert.deepEqual(g.noFuel, ['Mansa']);
  // the old shop-only group net would have been 300 + 200 − 400 = 100
});

test('grades are added across branches by code', () => {
  const other = { ...lusaka, slug: 'ndola', fuel: { ...lusaka.fuel, grades: [grade('ulp', 'Petrol 95', 60, 1500, 1200)] } };
  const g = groupGrades([lusaka, other]);
  const ulp = g.find((x) => x.key === 'ULP');
  assert.deepEqual([ulp.litres, ulp.revenue, ulp.cost, ulp.margin, ulp.margin_per_litre, ulp.branches], [200, 5000, 4000, 1000, 5, 2]);
  assert.equal(g[0].key, 'ULP', 'largest sales first');
});

test('nothing loaded yet', () => {
  const g = hqGroup({});
  assert.deepEqual([g.sales, g.groupNet, g.grossMargin, g.perLitre], [0, 0, null, null]);
});
