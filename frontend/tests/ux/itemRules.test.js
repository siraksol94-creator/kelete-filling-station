// Item and category rules (decision 2026-11-28): every category says where
// it is sold; fuel credit-ticket products stay out of Item Details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soldAtOf, soldAtFits, isFuelSystemItem, shopItems, uncategorised } from '../../src/ux/itemRules';

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
