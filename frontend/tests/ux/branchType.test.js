// Branch kind (decision 2026-11-28): head office never has fuel; a fuel
// station has the forecourt and its shop; a shop has no fuel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { branchKind, hasForecourt, kindOfBranch, groupBranches } from '../../src/ux/branchType';
import { trayTiles } from '../../src/ux/dashTrayModel';

test('kind: HQ wins over any stored type; grocery is a shop; default is a fuel station', () => {
  assert.equal(branchKind({ hq: true, businessType: 'fuel' }), 'hq');
  assert.equal(branchKind({ hq: false, businessType: 'grocery' }), 'shop');
  assert.equal(branchKind({ hq: false, businessType: 'FUEL' }), 'fuel');
  assert.equal(branchKind({}), 'fuel');
  assert.equal(hasForecourt('fuel'), true);
  assert.equal(hasForecourt('shop'), false);
  assert.equal(hasForecourt('hq'), false);
});

test('shortcuts: a fuel station shows Fuel and POS (fuel first), a shop only POS, HQ never Fuel', () => {
  assert.deepEqual(trayTiles({ kind: 'fuel', canPos: true, canVouchers: true }), ['fuel', 'pos', 'vouchers']);
  assert.deepEqual(trayTiles({ kind: 'shop', canPos: true, canVouchers: true }), ['pos', 'vouchers']);
  assert.deepEqual(trayTiles({ kind: 'hq', hq: true, canPos: true, canVouchers: true }), ['pos']);
});

test('HQ groups: fuel stations first, then shops, A to Z, totals in full', () => {
  const g = groupBranches([
    { slug: 'mansa', name: 'Mansa Shop', business_type: 'grocery', takings: { total: 9480, fuel: 0, shop: 9480 } },
    { slug: 'ger', name: 'Great East Road', business_type: 'fuel', takings: { total: 84210.5, fuel: 71900, shop: 12310.5 } },
    { slug: 'bankers', name: 'Bankers', takings: { total: 54370, fuel: 48250, shop: 6120 } },
    { slug: 'ndola', name: 'Ndola', business_type: 'grocery', error: 'busy' },
  ]);
  assert.deepEqual(g.map((x) => x.kind), ['fuel', 'shop']);
  assert.deepEqual(g[0].branches.map((b) => b.slug), ['bankers', 'ger']);
  assert.equal(g[0].total, 138580.5);
  assert.equal(g[0].fuel, 120150);
  assert.equal(g[0].shop, 18430.5);
  assert.deepEqual(g[1].branches.map((b) => b.slug), ['mansa', 'ndola']);
  assert.equal(g[1].total, 9480, 'an unreachable branch adds nothing');
  assert.equal(kindOfBranch({}), 'fuel');
  assert.deepEqual(groupBranches([]), []);
});
