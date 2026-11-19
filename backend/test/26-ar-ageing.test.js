// UX-11 — debt ageing counts the opening balance (oldest debt), so its total
// matches the Balance column; payments clear the oldest debt first.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, createCustomer } = require('./helpers/fixtures');

let app, staff;
const iso = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
before(async () => { app = await startApp(); staff = await seedStaff(app); });
after(async () => { await app.close(); });

test('opening balance aged as the oldest debt; buckets add up to the balance', async () => {
  const T = staff.tokens.owner;
  const c = await createCustomer(app, T, 'Copperbelt Haulage');   // 30-day terms
  const row = app.db.prepare('SELECT sync_id, tenant_id FROM customers WHERE id = ?').get(c.id);
  app.db.prepare('UPDATE customers SET opening_balance = 1000, created_at = ? WHERE id = ?').run(`${iso(200)} 08:00:00`, c.id);
  const order = (no, total, received, daysAgo) => app.db.prepare("INSERT INTO orders (order_number, total_amount, amount_received, tenant_id, business_date, sync_id, customer_sync_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(no, total, received, row.tenant_id, iso(daysAgo), `s-${no}`, row.sync_id, `${iso(daysAgo)} 09:00:00`);
  order('A1', 3000, 0, 75);     // due 45 days ago → 31–60
  order('A2', 2000, 500, 10);   // credit 1,500, not yet due → current
  app.db.prepare("INSERT INTO customer_payments (customer_id, customer_sync_id, amount, payment_date) VALUES (?, ?, 1500, ?)").run(c.id, row.sync_id, iso(5));

  const list = (await app.request('GET', '/api/customers', { token: T })).body.find((x) => x.id === c.id);
  const aging = (await app.request('GET', '/api/customers/aging', { token: T })).body.find((x) => x.id === c.id);
  assert.ok(aging, 'listed');
  assert.equal(aging.outstanding, list.outstanding, 'same balance as the list');
  assert.equal(aging.outstanding, 1000 + 3000 + 1500 - 1500);
  assert.equal(aging.opening_balance, 1000);
  assert.equal(aging.opening_unpaid, 0, 'the 1,500 payment cleared the opening balance first');
  const sum = aging.current + aging['1_30'] + aging['31_60'] + aging['61_90'] + aging['90_plus'];
  assert.ok(Math.abs(sum - aging.outstanding) < 0.01, `buckets ${sum} = balance ${aging.outstanding}`);
  assert.equal(aging['31_60'], 2500, 'A1 less the 500 left after the opening balance');
  assert.equal(aging.current, 1500);
});

test('a customer who owes only an opening balance now appears', async () => {
  const T = staff.tokens.owner;
  const c = await createCustomer(app, T, 'Old Account Ltd');
  app.db.prepare('UPDATE customers SET opening_balance = 750, created_at = ? WHERE id = ?').run(`${iso(120)} 08:00:00`, c.id);
  const aging = (await app.request('GET', '/api/customers/aging', { token: T })).body.find((x) => x.id === c.id);
  assert.ok(aging);
  assert.equal(aging.opening_unpaid, 750);
  assert.equal(aging['61_90'], 750, '120 days old, 30-day terms → 90 days over');
});
