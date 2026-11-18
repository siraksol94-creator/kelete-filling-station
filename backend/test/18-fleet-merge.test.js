// F3 — fleet accounts merged into Customers (decision 2026-11-18).
// Throwaway database; invented accounts.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel } = require('./helpers/fixtures');

let app, db, staff, fuel;
const T = () => staff.tokens.owner;
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };
const customer = async (name, phone, opening = 0) => {
  const c = ok(await app.request('POST', '/api/customers', { token: T(), body: { name, type: 'Credit', phone, email: '', address: '', tpin: '', credit_limit: 0, payment_terms_days: 30, credit_status: 'Active' } }), `customer ${name}`);
  if (opening) db.prepare('UPDATE customers SET opening_balance = ? WHERE id = ?').run(opening, c.id);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id);
};
// A fleet account as the legacy fuel module left it (balance included).
const fleet = (name, phone, balance = 0) => {
  const id = db.prepare('INSERT INTO fleet_customers (name, phone, credit_limit, current_balance) VALUES (?, ?, 5000, ?)').run(name, phone, balance).lastInsertRowid;
  return db.prepare('SELECT * FROM fleet_customers WHERE id = ?').get(id);
};

let C = {}, F = {}, legacyTicket;
before(async () => {
  app = await startApp(); db = app.db; staff = await seedStaff(app);
  fuel = await seedFuel(app, T());
  C.copper = await customer('Copperbelt Haulage', '0977123456', 200);
  C.movers = await customer('Lusaka Movers', '0966000111');
  C.abc1 = await customer('ABC Transport', '0970000001');
  C.abc2 = await customer('ABC  transport.', '0970000002');
  C.zed = await customer('Zed Freight', '0950000009');
  C.kitwe = await customer('Kitwe Tankers', '0950000010');
  F.copper = fleet('COPPERBELT HAULAGE ', '+260 977 123 456', 1500);  // phone + name
  F.kafue = fleet('Kafue Logistics', '0955 111 222', 800);            // no match → new customer
  F.movers = fleet('Lusaka Movers Ltd', '0966-000-111', 0);           // phone only
  F.abc = fleet('ABC Transport', '', 300);                            // two customers by name → ambiguous
  F.mixed = fleet('Kitwe Tankers', '0950000009', 50);                 // phone → Zed, name → Kitwe → ambiguous
  // a legacy credit ticket that named only the fleet account
  const sh = db.prepare("INSERT INTO attendant_shifts (attendant_user_id, opened_by, shift_type, status) VALUES (?, ?, 'DAY', 'Closed')").run(staff.users.att1.id, staff.users.owner.id).lastInsertRowid;
  legacyTicket = db.prepare(`INSERT INTO shift_credit_sales (shift_id, payment_method, fleet_customer_id, customer_name, litres, price_per_litre, amount)
                             VALUES (?, 'Credit', ?, 'COPPERBELT HAULAGE', 60, 25, 1500)`).run(sh, F.copper.id).lastInsertRowid;
});
after(async () => { await app.close(); });

describe('review (read-only)', () => {
  let plan;
  test('shows matches, new customers and doubtful cases — and changes nothing', async () => {
    const custBefore = db.prepare('SELECT COUNT(*) AS n, SUM(opening_balance) AS ob FROM customers').get();
    plan = ok(await app.request('GET', '/api/fleet-customers/merge/plan', { token: T() }), 'plan');
    const byFleet = (list, f) => list.find(x => x.fleet_id === f.id);
    assert.equal(byFleet(plan.matched, F.copper).customer.id, C.copper.id);
    assert.equal(byFleet(plan.matched, F.copper).by, 'phone+name');
    assert.equal(byFleet(plan.matched, F.copper).tickets, 1);
    assert.equal(byFleet(plan.matched, F.movers).customer.id, C.movers.id);
    assert.equal(byFleet(plan.matched, F.movers).by, 'phone');
    assert.ok(byFleet(plan.create, F.kafue));
    assert.deepEqual(byFleet(plan.ambiguous, F.abc).candidates.map(c => c.id).sort(), [C.abc1.id, C.abc2.id].sort());
    assert.deepEqual(byFleet(plan.ambiguous, F.mixed).candidates.map(c => c.id).sort(), [C.zed.id, C.kitwe.id].sort());
    assert.equal(plan.summary.balance_to_carry, 1500 + 800 + 0);
    assert.deepEqual(db.prepare('SELECT COUNT(*) AS n, SUM(opening_balance) AS ob FROM customers').get(), custBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fleet_customers WHERE merged_at IS NOT NULL').get().n, 0);
  });
  test('Administrators only; applying needs an explicit confirmation', async () => {
    for (const who of ['cashier', 'supervisor']) {
      assert.equal((await app.request('GET', '/api/fleet-customers/merge/plan', { token: staff.tokens[who] })).status, 403);
      assert.equal((await app.request('POST', '/api/fleet-customers/merge/apply', { token: staff.tokens[who], body: { confirm: true } })).status, 403);
    }
    assert.equal((await app.request('POST', '/api/fleet-customers/merge/apply', { token: T(), body: {} })).status, 400);
  });
});

describe('apply', () => {
  let result;
  before(async () => {
    result = ok(await app.request('POST', '/api/fleet-customers/merge/apply', { token: T(), body: { confirm: true, resolve: { [F.abc.id]: C.abc2.id } } }), 'apply');
  });
  test('merges the clear cases and the chosen one; leaves the undecided one alone', () => {
    assert.equal(result.merged.length, 4);
    assert.deepEqual(result.skipped.map(s => s.fleet_id), [F.mixed.id]);
    assert.equal(db.prepare('SELECT merged_at FROM fleet_customers WHERE id = ?').get(F.mixed.id).merged_at, null);
  });
  test('balances move into Accounts Receivable: one figure per customer', async () => {
    assert.equal(db.prepare('SELECT opening_balance FROM customers WHERE id = ?').get(C.copper.id).opening_balance, 200 + 1500);
    assert.equal(db.prepare('SELECT opening_balance FROM customers WHERE id = ?').get(C.abc2.id).opening_balance, 300);
    const kafue = db.prepare("SELECT * FROM customers WHERE name = 'Kafue Logistics' AND deleted_at IS NULL").get();
    assert.ok(kafue);
    assert.equal(kafue.type, 'Credit');
    assert.equal(kafue.opening_balance, 800);
    assert.equal(kafue.credit_limit, 5000);
    const ar = ok(await app.request('GET', '/api/customers', { token: T() }), 'AR');
    assert.equal(Number(ar.find(c => c.id === C.copper.id).outstanding), 1700);
  });
  test('the fleet account keeps its row, vehicles and history, linked to its Customer; old tickets point at the Customer', () => {
    const f = db.prepare('SELECT * FROM fleet_customers WHERE id = ?').get(F.copper.id);
    assert.equal(f.customer_id, C.copper.id);
    assert.equal(f.customer_sync_id, C.copper.sync_id);
    assert.ok(f.merged_at);
    const t = db.prepare('SELECT customer_id, customer_sync_id FROM shift_credit_sales WHERE id = ?').get(legacyTicket);
    assert.deepEqual([t.customer_id, t.customer_sync_id], [C.copper.id, C.copper.sync_id]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_sync_id = ?').get(C.copper.sync_id).n, 0, 'no new orders: the amount is in the carried balance');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fleet_merge_log WHERE undone_at IS NULL').get().n, 4);
  });
  test('running it again changes nothing (already merged)', async () => {
    const again = ok(await app.request('POST', '/api/fleet-customers/merge/apply', { token: T(), body: { confirm: true } }), 'again');
    assert.equal(again.merged.length, 0);
    assert.equal(db.prepare('SELECT opening_balance FROM customers WHERE id = ?').get(C.copper.id).opening_balance, 1700);
  });
  test('a merged fleet account can no longer build a separate balance (legacy fleet sale refused)', async () => {
    const r = await app.request('POST', '/api/fuel-sales', { token: T(),
      body: { nozzle_id: fuel.n2.id, litres: 10, payment_method: 'Fleet', fleet_customer_id: F.copper.id } });
    assert.equal(r.status, 400);
    assert.match(r.text, /Customer account/);
  });
  test('a new fleet account is a Customer from the start', async () => {
    const f = ok(await app.request('POST', '/api/fleet-customers', { token: T(), body: { name: 'Ndola Couriers', phone: '0960 123 999', credit_limit: 1000 } }), 'new fleet');
    const row = db.prepare('SELECT * FROM fleet_customers WHERE id = ?').get(f.id);
    assert.ok(row.customer_id, 'linked');
    assert.equal(db.prepare('SELECT name FROM customers WHERE id = ?').get(row.customer_id).name, 'Ndola Couriers');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fleet_customers WHERE merged_at IS NULL').get().n, 1, 'still only the undecided legacy account waits');
  });
});

describe('undo', () => {
  test('reverses every logged merge: balances back, tickets and fleet accounts unlinked, unused new customers voided', async () => {
    const r = ok(await app.request('POST', '/api/fleet-customers/merge/undo', { token: T(), body: { confirm: true } }), 'undo');
    assert.equal(r.undone.length, 5);
    assert.equal(db.prepare('SELECT opening_balance FROM customers WHERE id = ?').get(C.copper.id).opening_balance, 200);
    assert.equal(db.prepare('SELECT opening_balance FROM customers WHERE id = ?').get(C.abc2.id).opening_balance, 0);
    assert.ok(db.prepare("SELECT deleted_at FROM customers WHERE name = 'Kafue Logistics'").get().deleted_at, 'created by the merge, unused → voided');
    assert.equal(db.prepare('SELECT customer_id FROM shift_credit_sales WHERE id = ?').get(legacyTicket).customer_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fleet_customers WHERE merged_at IS NOT NULL').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fleet_merge_log WHERE undone_at IS NULL').get().n, 0);
  });
});
