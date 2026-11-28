// Suppliers rebuild (decision 2026-11-28).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suppliesOf, fuelSuppliers, supplierFilter, balanceWords } from '../../src/ux/supplierRules';

const list = [
  { id: 1, name: 'Puma Energy', supplies: 'fuel', outstanding: 0 },
  { id: 2, name: "Mama's Bakery", supplies: 'shop', outstanding: 960 },
  { id: 3, name: 'Engen Zambia', supplies: 'fuel', outstanding: 197500 },
  { id: 4, name: 'Varun Beverages', outstanding: -50 },
  { id: 5, name: 'Old Oil Co', supplies: 'fuel', status: 'Inactive', outstanding: 0 },
];

test('supplies: unset reads as both', () => {
  assert.equal(suppliesOf({}), 'both');
  assert.equal(suppliesOf({ supplies: 'FUEL' }), 'fuel');
});

test('fuel pickers: fuel suppliers first, no shop-only, no inactive', () => {
  assert.deepEqual(fuelSuppliers(list).map((s) => s.id), [3, 1, 4]);
});

test('Suppliers filters', () => {
  assert.deepEqual(supplierFilter(list, 'all').map((s) => s.id), [1, 2, 3, 4]);
  assert.deepEqual(supplierFilter(list, 'shop').map((s) => s.id), [2, 4]);
  assert.deepEqual(supplierFilter(list, 'owe').map((s) => s.id), [2, 3]);
  assert.deepEqual(supplierFilter(list, 'inactive').map((s) => s.id), [5]);
});

test('balance in words, never a bare minus', () => {
  assert.deepEqual(balanceWords(960), { tone: 'owe', label: 'We owe', amount: 'K960.00' });
  assert.equal(balanceWords(-2500).label, 'In credit');
  assert.equal(balanceWords(-2500).amount.includes('-'), false);
  assert.equal(balanceWords(0).label, 'Settled');
});
