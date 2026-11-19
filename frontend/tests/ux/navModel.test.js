// UX-6 — side menu: groups, finding a screen, recently used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupForPath, matches, pushRecent, loadRecent, saveRecent } from '../../src/ux/navModel';

test('every page opens the right menu group, HQ pages included', () => {
  assert.equal(groupForPath('/fuel/tanks'), 'fuel');
  assert.equal(groupForPath('/pos/cash-report'), 'pos');
  assert.equal(groupForPath('/hq/sales-report'), 'pos');
  assert.equal(groupForPath('/hq/grn-archive'), 'stock');
  assert.equal(groupForPath('/hq/cash-position'), 'accounting');
  assert.equal(groupForPath('/hq/suppliers'), 'suppliersCustomers');
  assert.equal(groupForPath('/setup'), 'settings');
  assert.equal(groupForPath('/hq/overview'), null);
  assert.equal(groupForPath('/dashboard'), null);
});

test('find a screen by its name, its group, or everyday words', () => {
  assert.ok(matches('Tanks', 'Fuel Station', 'tan'));
  assert.ok(matches('Tanks', 'Fuel Station', 'dips'), 'dips → Tanks');
  assert.ok(matches('Account Receivables', 'Accounting', 'debtors'));
  assert.ok(matches('Fuel Grades', 'Fuel Station', 'diesel price'));
  assert.ok(matches('Pumps &amp; Nozzles', 'Fuel Station', 'nozzle'));
  assert.ok(matches('GRN', 'Store', 'receive'));
  assert.ok(matches('Cash Book', 'Accounting', 'acc'), 'group name counts');
  assert.ok(!matches('Tanks', 'Fuel Station', 'payment'));
  assert.ok(matches('Anything', '', '   '), 'empty search shows everything');
});

test('recently used: newest first, no repeats, four at most', () => {
  let r = [];
  for (const p of ['a', 'b', 'c', 'd', 'e']) r = pushRecent(r, { path: `/${p}`, label: p });
  assert.deepEqual(r.map((x) => x.label), ['e', 'd', 'c', 'b']);
  r = pushRecent(r, { path: '/c', label: 'c' });
  assert.deepEqual(r.map((x) => x.label), ['c', 'e', 'd', 'b']);
  assert.deepEqual(pushRecent(r, { path: '/x' }), r, 'needs a label');
});

test('recent list survives bad storage', () => {
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) || null, setItem: (k, v) => mem.set(k, v) };
  saveRecent(store, 7, [{ path: '/fuel/tanks', label: 'Tanks' }]);
  assert.deepEqual(loadRecent(store, 7), [{ path: '/fuel/tanks', label: 'Tanks' }]);
  assert.deepEqual(loadRecent(store, 8), []);
  mem.set('kelete.menu.recent.9', '{oops');
  assert.deepEqual(loadRecent(store, 9), []);
  assert.deepEqual(loadRecent({ getItem: () => { throw new Error('blocked'); } }, 1), []);
});
