// Profit Report — fuel side: litres, sales, cost, margin per litre by grade;
// cost frozen at shift close; credit tickets already inside the shop revenue.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel, createCustomer } = require('./helpers/fixtures');
const { recalculateDailyProfit } = require('../config/profitHelper');

let app, staff, fuel, T, customer;
const today = require('../config/businessTime').businessDate();
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };
before(async () => {
  app = await startApp(); staff = await seedStaff(app);
  T = staff.tokens.owner;
  fuel = await seedFuel(app, T);          // Petrol K25/L cost K20, Diesel K24/L cost K19
  customer = await createCustomer(app, T);
});
after(async () => { await app.close(); });

const profit = async (token = T) => ok(await app.request('GET', `/api/fuel-profit?from=${today}&to=${today}`, { token }), 'fuel-profit');
const grade = (p, code) => p.grades.find((g) => g.code === code);

async function runShift({ petrol, diesel, cash, credit }) {
  const shift = ok(await app.request('POST', '/api/attendant-shifts/open', { token: T, body: { attendant_user_id: staff.users.att1.id, nozzle_ids: [fuel.n1.id, fuel.n2.id], shift_type: 'DAY' } }), 'open');
  if (credit) {
    ok(await app.request('POST', `/api/attendant-shifts/${shift.id}/credit-sales`, { token: T, body: {
      payment_method: 'Credit', customer_id: customer.id, customer_name: customer.name,
      fuel_grade_id: fuel.petrol.id, litres: credit, price_per_litre: 25 } }), 'credit ticket');
  }
  const det = ok(await app.request('GET', `/api/attendant-shifts/${shift.id}`, { token: T }), 'detail');
  const add = (r) => (r.nozzle_id === fuel.n1.id ? petrol : diesel);
  ok(await app.request('POST', `/api/attendant-shifts/${shift.id}/close`, { token: T, body: {
    readings: det.readings.map((r) => ({ id: r.id, closing_reading: Number(r.opening_reading) + add(r) })), payment_cash: cash } }), 'close');
  return shift;
}

test('migration 13 adds the frozen cost column', () => {
  const cols = app.db.prepare('PRAGMA table_info(shift_nozzle_readings)').all().map((c) => c.name);
  assert.ok(cols.includes('cost_per_litre'));
});

test('a quiet day is all zeros', async () => {
  const p = await profit();
  assert.deepEqual(p.grades, []);
  assert.equal(p.totals.revenue, 0);
  assert.equal(p.credit_in_shop, 0);
});

let first;
test('closed shift: sales, cost, margin and margin per litre by grade', async () => {
  // 100 L petrol (K2,500) + 50 L diesel (K1,200) = K3,700; cash K3,690 → K10 short
  first = await runShift({ petrol: 100, diesel: 50, cash: 3690 });
  const p = await profit();
  assert.deepEqual(
    p.grades.map((g) => [g.code, g.litres, g.revenue, g.cost, g.margin, g.margin_per_litre, g.estimated_litres]),
    [['ULP', 100, 2500, 2000, 500, 5, 0], ['DSL', 50, 1200, 950, 250, 5, 0]]);
  assert.equal(p.totals.revenue, 3700);
  assert.equal(p.totals.margin, 750);
  assert.equal(p.totals.margin_per_litre, 5);
  assert.equal(p.totals.cash_variance, -10);
  assert.equal(p.totals.gross_profit, 740);
  assert.equal(p.shifts, 1);
  const frozen = app.db.prepare('SELECT cost_per_litre FROM shift_nozzle_readings WHERE shift_id = ? ORDER BY nozzle_id').all(first.id).map((r) => r.cost_per_litre);
  assert.deepEqual(frozen, [20, 19]);
});

test('a later cost change does not move a closed shift\'s margin', async () => {
  ok(await app.request('PUT', `/api/fuel-grades/${fuel.petrol.id}`, { token: T, body: { ...fuel.petrol, cost_price: 22 } }), 'cost up');
  const g = grade(await profit(), 'ULP');
  assert.equal(g.cost, 2000);
  assert.equal(g.margin_per_litre, 5);
});

test('a reading closed before the frozen cost existed uses today\'s cost and is marked estimated', async () => {
  app.db.prepare('UPDATE shift_nozzle_readings SET cost_per_litre = NULL WHERE shift_id = ? AND nozzle_id = ?').run(first.id, fuel.n1.id);
  const g = grade(await profit(), 'ULP');
  assert.equal(g.cost, 2200, '100 L × today\'s K22');
  assert.equal(g.estimated_litres, 100);
  assert.equal((await profit()).totals.estimated_litres, 100);
  app.db.prepare('UPDATE shift_nozzle_readings SET cost_per_litre = 20 WHERE shift_id = ? AND nozzle_id = ?').run(first.id, fuel.n1.id);
});

test('credit fuel is counted once: in Fuel, and only moved out of Shop once the stored day contains it', async () => {
  // 40 L petrol of which 10 L on a Credit ticket (K250); cash expected = 40×25 + 0 − 250 = 750
  await runShift({ petrol: 40, diesel: 0, cash: 750, credit: 10 });
  let p = await profit();
  assert.equal(grade(p, 'ULP').litres, 140, 'credit litres are metered litres');
  assert.equal(p.totals.revenue, 4700);
  assert.equal(p.credit_in_shop, 0, 'no stored day yet, so nothing to move out of Shop');

  const order = app.db.prepare("SELECT tenant_id FROM orders WHERE order_number LIKE 'FUEL-%' ORDER BY id DESC LIMIT 1").get();
  recalculateDailyProfit(app.db, today, order.tenant_id);
  const stored = app.db.prepare('SELECT revenue FROM daily_profit_summary WHERE date = ? AND tenant_id = ?').get(today, order.tenant_id);
  assert.equal(stored.revenue, 250, 'the shop\'s stored revenue holds the credit ticket');
  p = await profit();
  assert.equal(p.credit_in_shop, 250);
});

test('open shifts are not counted', async () => {
  const before = (await profit()).totals.revenue;
  ok(await app.request('POST', '/api/attendant-shifts/open', { token: T, body: { attendant_user_id: staff.users.att2.id, nozzle_ids: [fuel.n1.id], shift_type: 'NIGHT' } }), 'open');
  assert.equal((await profit()).totals.revenue, before);
});

test('bad range is refused; read-only', async () => {
  const r = await app.request('GET', '/api/fuel-profit?from=2026-11-20&to=2026-11-01', { token: T });
  assert.equal(r.status, 400);
  const n = app.db.prepare('SELECT COUNT(*) AS n FROM tank_movements').get().n;
  await profit();
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM tank_movements').get().n, n);
});

test('only people who can open the Profit Report may read it', async () => {
  const r = await app.request('GET', `/api/fuel-profit?from=${today}&to=${today}`, { token: staff.tokens.att1 });
  assert.equal(r.status, 403, r.text);
});
