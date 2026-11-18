// D5 Suite 4 — fuel shift lifecycle (characterization of current behaviour).
// Steps run in order and share state, like a real day at the station.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel, createCustomer, PASSWORD } = require('./helpers/fixtures');
const { tankLedger, unlinkedOrderLines } = require('./helpers/invariants');
const { knownDefect } = require('./helpers/knownDefect');

let app, db, staff, fuel, customer, shift, approvalDate;
const T = () => staff.tokens.owner;
const vol = (tankId) => db.prepare('SELECT current_volume AS v FROM tanks WHERE id = ?').get(tankId).v;
const meter = (nozzleId) => db.prepare('SELECT current_meter_reading AS m FROM nozzles WHERE id = ?').get(nozzleId).m;
const assertLedger = () => assert.deepEqual(tankLedger(db), [], 'tank cache must equal its ledger');

before(async () => {
  app = await startApp(); db = app.db; staff = await seedStaff(app);
  fuel = await seedFuel(app, T(), { petrolPrice: 25, dieselPrice: 24, opening: 10000 });
  customer = await createCustomer(app, T());
});
after(async () => { await app.close(); });

test('setup: tanks open with their ledger opening balance', () => {
  assert.equal(vol(fuel.t1.id), 10000);
  assertLedger();
});

test('the shop POS refuses a sale when the cashier has no open shift', async () => {
  const r = await app.request('POST', '/api/orders', { token: staff.tokens.cashier, body: { items: [], payment_method: 'Cash', total_amount: 0 } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'NO_OPEN_SHIFT');
});

test('open a DAY shift: opening readings are snapshotted from the nozzle meters', async () => {
  const r = await app.request('POST', '/api/attendant-shifts/open', { token: T(),
    body: { attendant_user_id: staff.users.att1.id, nozzle_ids: [fuel.n1.id, fuel.n2.id], shift_type: 'DAY' } });
  assert.equal(r.status, 201, r.text);
  shift = r.body;
  approvalDate = String(shift.opened_at).slice(0, 10);
  const detail = (await app.request('GET', `/api/attendant-shifts/${shift.id}`, { token: T() })).body;
  assert.deepEqual(detail.readings.map(x => x.opening_reading).sort(), [100000, 50000].sort());
});

test('the same attendant cannot open a second shift', async () => {
  const r = await app.request('POST', '/api/attendant-shifts/open', { token: T(),
    body: { attendant_user_id: staff.users.att1.id, nozzle_ids: [fuel.n1.id], shift_type: 'DAY' } });
  assert.equal(r.status, 400);
});

test('F4: a nozzle already in an open shift cannot be given to a second attendant', async () => {
  const r = await app.request('POST', '/api/attendant-shifts/open', { token: T(),
    body: { attendant_user_id: staff.users.att2.id, nozzle_ids: [fuel.n1.id], shift_type: 'DAY' } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already in an open shift/);
});

test('F4: the same nozzle cannot be listed twice when opening a shift', async () => {
  const r = await app.request('POST', '/api/attendant-shifts/open', { token: T(),
    body: { attendant_user_id: staff.users.att2.id, nozzle_ids: [fuel.n2.id, fuel.n2.id], shift_type: 'DAY' } });
  assert.equal(r.status, 400);
});

let creditOrderId;
test('a Credit ticket for a customer creates a receivable order', async () => {
  const r = await app.request('POST', `/api/attendant-shifts/${shift.id}/credit-sales`, { token: T(),
    body: { payment_method: 'Credit', customer_id: customer.id, customer_name: customer.name, fuel_grade_id: fuel.petrol.id, litres: 40, price_per_litre: 25, vehicle_registration: 'ABC 1234' } });
  assert.equal(r.status, 201, r.text);
  creditOrderId = r.body.linked_order_id;
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(creditOrderId);
  assert.equal(order.total_amount, 1000);
  assert.match(order.order_number, /^FUEL-/);
  assert.equal(order.shift_id, shift.id);
});

test('F2: the credit order line carries the links reports and sync need', () => {
  assert.equal(unlinkedOrderLines(db), 0);
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(creditOrderId);
  const line = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(creditOrderId);
  const product = db.prepare("SELECT sync_id FROM products WHERE code = 'FUEL-ULP'").get();
  assert.equal(line.order_sync_id, order.sync_id);
  assert.equal(line.product_sync_id, product.sync_id);
  assert.ok(line.sync_id && line.tenant_id, 'line has its own sync identity');
  assert.equal(line.unit, 'L');
  const ticket = db.prepare('SELECT linked_order_sync_id FROM shift_credit_sales WHERE linked_order_id = ?').get(creditOrderId);
  assert.equal(ticket.linked_order_sync_id, order.sync_id);
});

test('F2: a Credit ticket without a customer account is refused', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM shift_credit_sales').get().n;
  const r = await app.request('POST', `/api/attendant-shifts/${shift.id}/credit-sales`, { token: T(),
    body: { payment_method: 'Credit', customer_name: 'Walk-in on account', fuel_grade_id: fuel.petrol.id, litres: 10, price_per_litre: 25 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /must be linked to a customer account/);
  const gone = await app.request('POST', `/api/attendant-shifts/${shift.id}/credit-sales`, { token: T(),
    body: { payment_method: 'Credit', customer_id: 999999, customer_name: 'Ghost', fuel_grade_id: fuel.petrol.id, litres: 10, price_per_litre: 25 } });
  assert.equal(gone.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shift_credit_sales').get().n, before);
});

test('a 1Card ticket is recorded on the shift only (no receivable order)', async () => {
  const r = await app.request('POST', `/api/attendant-shifts/${shift.id}/credit-sales`, { token: T(),
    body: { payment_method: '1Card', customer_name: 'Engen card', card_number: '7001', fuel_grade_id: fuel.diesel.id, litres: 20, price_per_litre: 24 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.linked_order_id, null);
});

test('current behaviour (business decision pending): a price change re-prices the open shift', async () => {
  const r = await app.request('PUT', `/api/fuel-grades/${fuel.diesel.id}`, { token: T(), body: { selling_price: 24.5 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.synced_open_shift_readings, 1);
  const rd = db.prepare('SELECT price_per_litre FROM shift_nozzle_readings WHERE shift_id = ? AND nozzle_id = ?').get(shift.id, fuel.n2.id);
  assert.equal(rd.price_per_litre, 24.5);
});

test('F2: credit rows sent with the shift close must have an account; the whole close is refused and nothing changes', async () => {
  const detail = (await app.request('GET', `/api/attendant-shifts/${shift.id}`, { token: T() })).body;
  const r1 = detail.readings.find(x => x.nozzle_id === fuel.n1.id);
  const r2 = detail.readings.find(x => x.nozzle_id === fuel.n2.id);
  const volBefore = vol(fuel.t1.id);
  const r = await app.request('POST', `/api/attendant-shifts/${shift.id}/close`, { token: T(), body: {
    readings: [{ id: r1.id, closing_reading: 101000 }, { id: r2.id, closing_reading: 50500 }],
    credit_sales_batch: [{ customer_name: 'Unknown Hauler', litres: 5, price_per_litre: 25 }], payment_cash: 1 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no customer account/);
  assert.equal(db.prepare('SELECT status FROM attendant_shifts WHERE id = ?').get(shift.id).status, 'Open');
  assert.equal(vol(fuel.t1.id), volBefore, 'readings were not applied');
  assertLedger();
});

test('close: litres sold, tank ledger, meters, expected cash and variance', async () => {
  const detail = (await app.request('GET', `/api/attendant-shifts/${shift.id}`, { token: T() })).body;
  const r1 = detail.readings.find(x => x.nozzle_id === fuel.n1.id);
  const r2 = detail.readings.find(x => x.nozzle_id === fuel.n2.id);
  const r = await app.request('POST', `/api/attendant-shifts/${shift.id}/close`, { token: T(), body: {
    readings: [
      { id: r1.id, closing_reading: 101000, testing_litres: 5 },   // 995 L petrol @25   = 24,875
      { id: r2.id, closing_reading: 50500 },                       // 500 L diesel @24.5 = 12,250
    ],
    payment_cash: 30000, payment_mobile: 2000, payment_swipes: 1000, payment_other: 77,
    dips: [{ tank_id: fuel.t1.id, dip_litres: 9000 }],
  } });
  assert.equal(r.status, 200, r.text);
  // gross 37,125 − (mobile 2,000 + swipes 1,000 + credit 1,000 + 1Card 480) = 32,645 expected cash
  // (F2: the K250 "credit" with no customer is now refused, so it no longer reduces expected cash)
  assert.equal(r.body.expected_cash, 32645);
  assert.equal(r.body.variance, 30000 - 32645);
  assert.equal(vol(fuel.t1.id), 10000 - 995, 'testing litres go back to the tank');
  assert.equal(vol(fuel.t2.id), 10000 - 500);
  assert.equal(meter(fuel.n1.id), 101000);
  assertLedger();
});

test('the "other" payment sent at close is kept; the credit total has its own column', () => {
  const s = db.prepare('SELECT payment_other, payment_credit, payment_1card FROM attendant_shifts WHERE id = ?').get(shift.id);
  assert.equal(s.payment_other, 77, 'what was sent as Other');
  assert.equal(s.payment_credit, 1000, 'credit tickets total');
  assert.equal(s.payment_1card, 480);
});

test('a shift dip for the day is recorded against the book volume', async () => {
  const r = await app.request('POST', '/api/tank-dips', { token: T(),
    body: { tank_id: fuel.t1.id, shift_type: 'DAY', dip_date: approvalDate, measured_litres: 9000 } });
  assert.ok(r.status < 300, r.text);
  const dip = db.prepare('SELECT * FROM tank_dips WHERE tank_id = ? AND dip_date = ?').get(fuel.t1.id, approvalDate);
  assert.equal(dip.variance, 9000 - (10000 - 995));
});

test('decision 2026-11-18: only a supervisor (Manager) or Administrator can reopen a shift', async () => {
  const r1 = await app.request('POST', `/api/attendant-shifts/${shift.id}/reopen`, { token: staff.tokens.cashier });
  assert.equal(r1.status, 403);
  const r2 = await app.request('POST', `/api/attendant-shifts/${shift.id}/reopen`, { token: staff.tokens.att1 });
  assert.equal(r2.status, 403, 'not even the attendant who owns the shift');
  const ok = await app.request('POST', `/api/attendant-shifts/${shift.id}/reopen`, { token: staff.tokens.supervisor });
  assert.equal(ok.status, 200, ok.text);
});

test('reopen → close again with the same figures does not drain the tank twice', async () => {
  const detail = (await app.request('GET', `/api/attendant-shifts/${shift.id}`, { token: T() })).body;
  const r1 = detail.readings.find(x => x.nozzle_id === fuel.n1.id);
  const r2 = detail.readings.find(x => x.nozzle_id === fuel.n2.id);
  const before = vol(fuel.t1.id);
  const r = await app.request('POST', `/api/attendant-shifts/${shift.id}/close`, { token: staff.tokens.supervisor, body: {
    readings: [{ id: r1.id, closing_reading: 101000, testing_litres: 5 }, { id: r2.id, closing_reading: 50500 }],
    payment_cash: 30000, payment_mobile: 2000, payment_swipes: 1000 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.expected_cash, 32645);
  assert.equal(vol(fuel.t1.id), before);
  assertLedger();
});

test('only an Administrator may approve a shift', async () => {
  const no = await app.request('POST', `/api/fuel-shift-approvals/${approvalDate}/DAY/approve`, { token: staff.tokens.supervisor });
  assert.equal(no.status, 403);
});

test('F4: approval now saves, and posts the day\'s dip variance to the ledger', async () => {
  const r = await app.request('POST', `/api/fuel-shift-approvals/${approvalDate}/DAY/approve`, { token: T() });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.dips_posted, 1);
  assert.equal(vol(fuel.t1.id), 9000, 'book moved to the measured dip');
  assert.equal(db.prepare('SELECT shift_id FROM fuel_shift_approvals WHERE approval_date = ?').get(approvalDate).shift_id, shift.id);
  assertLedger();
});

test('F4: approving an empty window is refused', async () => {
  const r = await app.request('POST', '/api/fuel-shift-approvals/2001-01-01/NIGHT/approve', { token: T() });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /no NIGHT shifts/);
});

test('after approval, cash figures cannot be re-finalized', async () => {
  const r = await app.request('POST', `/api/attendant-shifts/${shift.id}/finalize`, { token: T(), body: { payment_cash: 1 } });
  assert.equal(r.status, 400);
});

test('F4: an approved shift cannot be reopened, its tickets cannot be changed, and it cannot be deleted', async () => {
  // a supervisor MAY reopen shifts in general — the approval lock still stops them
  const re = await app.request('POST', `/api/attendant-shifts/${shift.id}/reopen`, { token: staff.tokens.supervisor });
  assert.equal(re.status, 409);
  const ticket = db.prepare('SELECT id FROM shift_credit_sales WHERE shift_id = ? LIMIT 1').get(shift.id);
  assert.equal((await app.request('DELETE', `/api/attendant-shifts/credit-sales/${ticket.id}`, { token: T() })).status, 409);
  assert.equal((await app.request('POST', `/api/attendant-shifts/${shift.id}/delete`, { token: T(), body: { password: PASSWORD } })).status, 409);
  assert.equal(db.prepare("SELECT status FROM attendant_shifts WHERE id = ?").get(shift.id).status, 'Closed');
});

test('F4: a dip posted to the ledger cannot be deleted', async () => {
  const dip = db.prepare('SELECT id FROM tank_dips WHERE tank_id = ? AND dip_date = ?').get(fuel.t1.id, approvalDate);
  const r = await app.request('DELETE', `/api/tank-dips/${dip.id}`, { token: T() });
  assert.equal(r.status, 400);
  assert.throws(() => db.prepare('DELETE FROM tank_dips WHERE id = ?').run(dip.id), /posted to the tank ledger/);
});

let shift2;
test('after un-approval, reopening is refused while a newer shift holds the nozzle', async () => {
  const un = await app.request('POST', `/api/fuel-shift-approvals/${approvalDate}/DAY/un-approve`, { token: T() });
  assert.equal(un.status, 200);
  shift2 = (await app.request('POST', '/api/attendant-shifts/open', { token: T(),
    body: { attendant_user_id: staff.users.att2.id, nozzle_ids: [fuel.n1.id], shift_type: 'DAY' } })).body;
  assert.ok(shift2.id);
  const re = await app.request('POST', `/api/attendant-shifts/${shift.id}/reopen`, { token: T() });
  assert.equal(re.status, 409);
  assert.match(re.body.error, /open shift/);
});

test('F4: a shift cannot be deleted while a later shift used the same nozzle', async () => {
  const r = await app.request('POST', `/api/attendant-shifts/${shift.id}/delete`, { token: T(), body: { password: PASSWORD } });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /Later shift/);
});

test('deleting a shift: refused for non-admins and wrong passwords; reverses tank, meters and receivable', async () => {
  // remove the newer shift first (newest first), as the error message instructs
  assert.equal((await app.request('POST', `/api/attendant-shifts/${shift2.id}/delete`, { token: T(), body: { password: PASSWORD } })).status, 200);
  assert.equal((await app.request('POST', `/api/attendant-shifts/${shift.id}/delete`, { token: staff.tokens.cashier, body: { password: PASSWORD } })).status, 403);
  assert.equal((await app.request('POST', `/api/attendant-shifts/${shift.id}/delete`, { token: T(), body: { password: 'wrong' } })).status, 401);
  const volBefore = vol(fuel.t1.id);
  const sold = db.prepare('SELECT litres_sold FROM shift_nozzle_readings WHERE shift_id = ? AND nozzle_id = ?').get(shift.id, fuel.n1.id).litres_sold;
  const r = await app.request('POST', `/api/attendant-shifts/${shift.id}/delete`, { token: T(), body: { password: PASSWORD } });
  assert.equal(r.status, 200, r.text);
  assert.equal(vol(fuel.t1.id), volBefore + sold);
  assert.equal(meter(fuel.n1.id), 100000);
  assert.ok(db.prepare('SELECT deleted_at FROM orders WHERE id = ?').get(creditOrderId).deleted_at);
  assertLedger();
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'attendant_shifts.delete'").get(), 'deleted shift preserved in the audit log');
});

test('upgrade (migration 9): shifts closed by the old code get their credit total moved out of "Other"; any other value is left alone', () => {
  const m9 = require('../config/versionedMigrations').find(m => m.version === 9);
  const closedShift = (other) => {
    const id = db.prepare(`INSERT INTO attendant_shifts (attendant_user_id, opened_by, shift_type, status, payment_other)
                           VALUES (?, ?, 'DAY', 'Closed', ?)`).run(staff.users.att2.id, staff.users.owner.id, other).lastInsertRowid;
    db.prepare('UPDATE attendant_shifts SET payment_credit = NULL WHERE id = ?').run(id);
    db.prepare(`INSERT INTO shift_credit_sales (shift_id, payment_method, customer_name, litres, price_per_litre, amount)
                VALUES (?, 'Credit', 'Old Fleet', 16, 25, 400)`).run(id);
    return id;
  };
  const old = closedShift(400);   // as the old code left it: the credit total in "Other"
  const real = closedShift(55);   // a different value: not the credit total
  m9.up(db.defaultDb);
  const a = db.prepare('SELECT payment_other, payment_credit FROM attendant_shifts WHERE id = ?').get(old);
  assert.deepEqual([a.payment_other, a.payment_credit], [0, 400]);
  const b = db.prepare('SELECT payment_other, payment_credit FROM attendant_shifts WHERE id = ?').get(real);
  assert.deepEqual([b.payment_other, b.payment_credit], [55, 400]);
});
