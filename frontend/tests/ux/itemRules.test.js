// Item and category rules (decision 2026-11-28): every category says where
// it is sold; fuel credit-ticket products stay out of Item Details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soldAtOf, soldAtFits, isFuelSystemItem, shopItems, uncategorised, purchaseKind, purchaseLineProblem, destinationsFor, soldAtBadge } from '../../src/ux/itemRules';
import { kindOfBranch } from '../../src/ux/branchType';

test('sold at: blank and unknown read as both', () => {
  assert.equal(soldAtOf(null), 'both');
  assert.equal(soldAtOf(''), 'both');
  assert.equal(soldAtOf('x'), 'both');
  assert.equal(soldAtOf('FUEL'), 'fuel');
  assert.equal(soldAtOf(' shop '), 'shop');
});

test('sold at: fits only the matching kind, both fits either', () => {
  assert.equal(soldAtFits('fuel', 'fuel'), true);
  assert.equal(soldAtFits('fuel', 'shop'), false);
  assert.equal(soldAtFits('shop', 'fuel'), false);
  assert.equal(soldAtFits(null, 'shop'), true);
});

test('fuel system items are hidden; a FUEL- code someone filed under a category is kept', () => {
  assert.equal(isFuelSystemItem({ code: 'FUEL-DSL' }), true);
  assert.equal(isFuelSystemItem({ code: 'FUEL-DSL', category_id: 4 }), false);
  assert.equal(isFuelSystemItem({ code: 'LUB001' }), false);
  assert.equal(shopItems([{ code: 'FUEL-ULP' }, { code: 'BK001', category_id: 1 }]).length, 1);
});

test('uncategorised lists the items with no category', () => {
  assert.deepEqual(uncategorised([{ id: 1 }, { id: 2, category_id: 3 }]).map(i => i.id), [1]);
});

const bread = { product_sync_id: 'b', name: 'Bread loaf', has_category: true, sold_at: 'shop' };
const oil   = { product_sync_id: 'o', name: 'Engine Oil', has_category: true, sold_at: 'fuel' };
const coke  = { product_sync_id: 'c', name: 'Coca-Cola', has_category: true, sold_at: null };
const chips = { product_sync_id: 's', name: 'Simba chips', has_category: false };

test('HQ purchase: the first fuel-only or shop-only item decides; both-items decide nothing', () => {
  assert.equal(purchaseKind([coke, bread, oil]), 'shop');
  assert.equal(purchaseKind([oil, bread]), 'fuel');
  assert.equal(purchaseKind([coke]), 'both');
  assert.equal(purchaseKind([]), 'both');
});

test('HQ purchase: mixing is refused with the reason; both fits; no category refused', () => {
  assert.equal(purchaseLineProblem(bread, 'shop', null), null);
  assert.match(purchaseLineProblem(oil, 'shop', null), /sold at fuel stations.*for shops/);
  assert.equal(purchaseLineProblem(coke, 'shop', 'shop'), null);
  assert.match(purchaseLineProblem(chips, 'both', null), /no category/);
  assert.match(purchaseLineProblem(bread, 'shop', 'fuel'), /branch picked is a fuel station/);
  assert.equal(purchaseLineProblem({ product_sync_id: '' }, 'shop', 'fuel'), null);
});

test('HQ purchase: destinations follow the kind', () => {
  const bs = [{ slug: 'bankers', business_type: 'fuel' }, { slug: 'mansa', business_type: 'grocery' }, { slug: 'ger' }];
  assert.deepEqual(destinationsFor(bs, 'shop', kindOfBranch).map(b => b.slug), ['mansa']);
  assert.deepEqual(destinationsFor(bs, 'fuel', kindOfBranch).map(b => b.slug), ['bankers', 'ger']);
  assert.equal(destinationsFor(bs, 'both', kindOfBranch).length, 3);
});

test('picker badge says where an item is sold', () => {
  assert.equal(soldAtBadge({ category_id: 1, category_sold_at: 'fuel' }).label, 'Fuel stations');
  assert.equal(soldAtBadge({ category_id: 1 }).label, 'Both');
  assert.equal(soldAtBadge({}).label, 'No category');
});
