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

knownDefect('F4', 'a nozzle already in an open shift can be given to a second attendant', async () => {
  const r = await app.request('POST', '/api/attendant-shifts/open', { token: T(),
    body: { attendant_user_id: staff.users.att2.id, nozzle_ids: [fuel.n1.id], shift_type: 'DAY' } });
  assert.equal(r.status, 201, 'TODAY: accepted — both attendants would be credited the same litres');
  const del = await app.request('POST', `/api/attendant-shifts/${r.body.id}/delete`, { token: T(), body: { password: PASSWORD } });
  assert.equal(del.status, 200);
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

knownDefect('F2', 'the credit order line is written without order_sync_id, so reports cannot join it', () => {
  assert.ok(unlinkedOrderLines(db) >= 1);
});

knownDefect('F2', 'a Credit ticket without a customer creates NO receivable but still counts as credit', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const r = await app.request('POST', `/api/attendant-shifts/${shift.id}/credit-sales`, { token: T(),
    body: { payment_method: 'Credit', customer_name: 'Walk-in on account', fuel_grade_id: fuel.petrol.id, litres: 10, price_per_litre: 25 } });
  assert.equal(r.status, 201);
  assert.equal(r.body.linked_order_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before, 'TODAY: no order, so the K250 is in no receivable');
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
  // gross 37,125 − (mobile 2,000 + swipes 1,000 + credit 1,250 + 1Card 480) = 32,395 expected cash
  assert.equal(r.body.expected_cash, 32395);
  assert.equal(r.body.variance, 30000 - 32395);
  assert.equal(vol(fuel.t1.id), 10000 - 995, 'testing litres go back to the tank');
  assert.equal(vol(fuel.t2.id), 10000 - 500);
  assert.equal(meter(fuel.n1.id), 101000);
  assertLedger();
});

knownDefect('F4', 'the "other" payment typed at close is discarded and that column holds the credit total', () => {
  const s = db.prepare('SELECT payment_other, payment_1card FROM attendant_shifts WHERE id = ?').get(shift.id);
  assert.equal(s.payment_other, 1250, 'TODAY: credit total, not the 77 typed');
  assert.equal(s.payment_1card, 480);
});

test('a shift dip for the day is recorded against the book volume', async () => {
  const r = await app.request('POST', '/api/tank-dips', { token: T(),
    body: { tank_id: fuel.t1.id, shift_type: 'DAY', dip_date: approvalDate, measured_litres: 9000 } });
  assert.ok(r.status < 300, r.text);
  const dip = db.prepare('SELECT * FROM tank_dips WHERE tank_id = ? AND dip_date = ?').get(fuel.t1.id, approvalDate);
  assert.equal(dip.variance, 9000 - (10000 - 995));
});

test('only an Administrator may attempt a shift approval', async () => {
  const no = await app.request('POST', `/api/fuel-shift-approvals/${approvalDate}/DAY/approve`, { token: staff.tokens.supervisor });
  assert.equal(no.status, 403);
});

knownDefect('F4 (Phase 2a E3)', 'shift approval always fails: fuel_shift_approvals.shift_id is NOT NULL but approval never sets it', async () => {
  const r = await app.request('POST', `/api/fuel-shift-approvals/${approvalDate}/DAY/approve`, { token: T() });
  assert.equal(r.status, 400, 'TODAY: approval cannot be saved on a database built from this schema');
  assert.match(r.body.error, /NOT NULL constraint failed: fuel_shift_approvals\.shift_id/);
  assert.equal(vol(fuel.t1.id), 10000 - 995, 'so the dip variance is never posted');
});

test('an Administrator can post a dip adjustment directly; the ledger stays consistent', async () => {
  const dip = db.prepare('SELECT id FROM tank_dips WHERE tank_id = ? AND dip_date = ?').get(fuel.t1.id, approvalDate);
  assert.equal((await app.request('POST', `/api/tank-dips/${dip.id}/post-adjustment`, { token: staff.tokens.supervisor })).status, 403);
  const r = await app.request('POST', `/api/tank-dips/${dip.id}/post-adjustment`, { token: T() });
  assert.equal(r.status, 200, r.text);
  assert.equal(vol(fuel.t1.id), 9000, 'book moved to the measured dip');
  assertLedger();
});

// The checks below need an approval to exist. Approval cannot be saved through
// the API (defect above), so the row is inserted directly — as it would be on a
// database where approval works — to characterise what the lock does and misses.
test('with an approval in place, cash figures cannot be re-finalized', async () => {
  db.prepare('INSERT INTO fuel_shift_approvals (shift_id, approval_date, shift_type, approved_by) VALUES (?, ?, ?, ?)')
    .run(shift.id, approvalDate, 'DAY', staff.users.owner.id);
  const r = await app.request('POST', `/api/attendant-shifts/${shift.id}/finalize`, { token: T(), body: { payment_cash: 1 } });
  assert.equal(r.status, 400);
});

knownDefect('F4', 'an APPROVED shift can still be reopened and closed again with different readings', async () => {
  const re = await app.request('POST', `/api/attendant-shifts/${shift.id}/reopen`, { token: staff.tokens.cashier });
  assert.equal(re.status, 200, 'TODAY: reopen is allowed after approval, by any logged-in user');
  const detail = (await app.request('GET', `/api/attendant-shifts/${shift.id}`, { token: T() })).body;
  const r1 = detail.readings.find(x => x.nozzle_id === fuel.n1.id);
  const r2 = detail.readings.find(x => x.nozzle_id === fuel.n2.id);
  const c = await app.request('POST', `/api/attendant-shifts/${shift.id}/close`, { token: T(),
    body: { readings: [{ id: r1.id, closing_reading: 100500 }, { id: r2.id, closing_reading: 50500 }], payment_cash: 1 } });
  assert.equal(c.status, 200, 'TODAY: the approved figures were changed');
  assertLedger();
});

test('deleting a shift: refused for non-admins and wrong passwords; reverses tank, meters and receivable', async () => {
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
