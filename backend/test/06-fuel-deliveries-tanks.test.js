// D5 Suite 5 — fuel deliveries, tanks and the legacy fuel-sales endpoint.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel } = require('./helpers/fixtures');
const { tankLedger } = require('./helpers/invariants');
const { knownDefect } = require('./helpers/knownDefect');

let app, db, staff, fuel;
const T = () => staff.tokens.owner;
const vol = (id) => db.prepare('SELECT current_volume AS v FROM tanks WHERE id = ?').get(id).v;
const cost = (id) => db.prepare('SELECT cost_price AS c FROM fuel_grades WHERE id = ?').get(id).c;
const deliver = (litres, cpl, extra = {}) => app.request('POST', '/api/fuel-deliveries', { token: T(),
  body: { tank_id: fuel.t1.id, litres_delivered: litres, cost_per_litre: cpl, invoice_number: 'INV-' + litres, ...extra } });

before(async () => {
  app = await startApp(); db = app.db; staff = await seedStaff(app);
  fuel = await seedFuel(app, T(), { opening: 10000 });   // petrol cost 20/L
});
after(async () => { await app.close(); });

test('a delivery adds litres through the ledger and re-weights the average cost', async () => {
  const r = await deliver(10000, 22);
  assert.equal(r.status, 201, r.text);
  assert.match(r.body.delivery_number, /^FD-/);
  assert.equal(vol(fuel.t1.id), 20000);
  assert.equal(cost(fuel.petrol.id), 21, '(10,000 × 20 + 10,000 × 22) / 20,000');
  assert.deepEqual(tankLedger(db), []);
});

knownDefect('F5', 'a fuel delivery creates no supplier payable and no cash-book entry', async () => {
  const before = db.prepare('SELECT (SELECT COUNT(*) FROM grn) + (SELECT COUNT(*) FROM ap_payments) + (SELECT COUNT(*) FROM payment_vouchers) AS n').get().n;
  await deliver(1000, 22);
  const after = db.prepare('SELECT (SELECT COUNT(*) FROM grn) + (SELECT COUNT(*) FROM ap_payments) + (SELECT COUNT(*) FROM payment_vouchers) AS n').get().n;
  assert.equal(after, before);
});

knownDefect('F4', 'deleting a delivery reverses the litres but not the average cost', async () => {
  const r0 = await deliver(5000, 40);
  const costWith = cost(fuel.petrol.id);
  const volWith = vol(fuel.t1.id);
  const d = await app.request('DELETE', `/api/fuel-deliveries/${r0.body.id}`, { token: T() });
  assert.equal(d.status, 200);
  assert.equal(vol(fuel.t1.id), volWith - 5000);
  assert.equal(cost(fuel.petrol.id), costWith, 'TODAY: the K40/L delivery still inflates the cost after it was deleted');
  assert.deepEqual(tankLedger(db), []);
});

knownDefect('D1 numbering', 'after a delivery is deleted, the next delivery number collides and the save fails', async () => {
  const x = await deliver(100, 22);   // e.g. FD-000004
  const y = await deliver(200, 22);   // e.g. FD-000005
  assert.equal((await app.request('DELETE', `/api/fuel-deliveries/${x.body.id}`, { token: T() })).status, 200);
  const z = await deliver(300, 22);   // count + 1 = FD-000005 again
  assert.equal(z.status, 400, `TODAY: FD- numbers are "count + 1"; deleting ${x.body.delivery_number} makes the next number repeat ${y.body.delivery_number}`);
  assert.match(z.body.error, /UNIQUE/);
});

test('F4: correcting a tank opening balance posts an adjustment and keeps the original', async () => {
  const firstOpening = () => db.prepare("SELECT litres FROM tank_movements WHERE tank_id = ? AND type = 'opening' ORDER BY id LIMIT 1").get(fuel.t2.id).litres;
  const rows = () => db.prepare('SELECT COUNT(*) AS n FROM tank_movements WHERE tank_id = ?').get(fuel.t2.id).n;
  const n = rows();
  const r = await app.request('PUT', `/api/tanks/${fuel.t2.id}`, { token: T(), body: { opening_litres: 12345 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(firstOpening(), 10000, 'original opening row untouched');
  assert.equal(rows(), n + 1, 'one correction row added');
  const adj = db.prepare("SELECT litres, notes FROM tank_movements WHERE tank_id = ? ORDER BY id DESC LIMIT 1").get(fuel.t2.id);
  assert.equal(adj.litres, 2345);
  assert.match(adj.notes, /corrected from 10000 L to 12345 L/);
  const listed = (await app.request('GET', '/api/tanks', { token: T() })).body.find(t => t.id === fuel.t2.id);
  assert.equal(listed.opening_litres, 12345, 'the list shows the effective (corrected) opening');
  assert.deepEqual(tankLedger(db), []);
});

test('F4: a non-admin can still save tank details (the form re-sends the unchanged opening)', async () => {
  const listed = (await app.request('GET', '/api/tanks', { token: T() })).body.find(t => t.id === fuel.t2.id);
  const r = await app.request('PUT', `/api/tanks/${fuel.t2.id}`, { token: staff.tokens.supervisor, body: { ...listed, name: 'Diesel Tank' } });
  assert.equal(r.status, 200, r.text);
});

test('F4: only an Administrator can change an opening balance', async () => {
  const r = await app.request('PUT', `/api/tanks/${fuel.t2.id}`, { token: staff.tokens.supervisor, body: { opening_litres: 1 } });
  assert.equal(r.status, 403);
});

test('F4: a tank holding fuel cannot be relabelled as another grade', async () => {
  const r = await app.request('PUT', `/api/tanks/${fuel.t2.id}`, { token: T(), body: { fuel_grade_id: fuel.petrol.id } });
  assert.equal(r.status, 409);
});

test('F4: the legacy /api/fuel-sales endpoint now goes through the tank ledger', async () => {
  const before = vol(fuel.t1.id);
  const r = await app.request('POST', '/api/fuel-sales', { token: T(), body: { nozzle_id: fuel.n1.id, litres: 50 } });
  assert.equal(r.status, 201, r.text);
  assert.equal(vol(fuel.t1.id), before - 50);
  assert.deepEqual(tankLedger(db), []);
  const d = await app.request('DELETE', `/api/fuel-sales/${r.body.id}`, { token: T() });
  assert.equal(d.status, 200);
  assert.equal(vol(fuel.t1.id), before);
  assert.deepEqual(tankLedger(db), []);
});

test('F4: only an Administrator can change a nozzle meter; an unchanged meter does not need one', async () => {
  const cur = db.prepare('SELECT * FROM nozzles WHERE id = ?').get(fuel.n2.id);
  assert.equal((await app.request('PUT', `/api/pumps/nozzles/${fuel.n2.id}`, { token: staff.tokens.cashier, body: { current_meter_reading: 1 } })).status, 403);
  assert.equal((await app.request('PUT', `/api/pumps/nozzles/${fuel.n2.id}`, { token: staff.tokens.cashier, body: { ...cur, code: 'P1-DIESEL' } })).status, 200);
  assert.equal((await app.request('PUT', `/api/pumps/nozzles/${fuel.n2.id}`, { token: T(), body: { current_meter_reading: cur.current_meter_reading + 10 } })).status, 200);
  const a = db.prepare("SELECT * FROM audit_log WHERE action = 'nozzle.meter_change' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(a.details_json).delta, 10);
});

test('F4: while a nozzle is in an open shift, its meter and tank cannot change and legacy sales are refused', async () => {
  const sh = await app.request('POST', '/api/attendant-shifts/open', { token: T(), body: { attendant_user_id: staff.users.att1.id, nozzle_ids: [fuel.n1.id], shift_type: 'DAY' } });
  assert.equal(sh.status, 201, sh.text);
  assert.equal((await app.request('PUT', `/api/pumps/nozzles/${fuel.n1.id}`, { token: T(), body: { current_meter_reading: 5 } })).status, 409);
  assert.equal((await app.request('PUT', `/api/pumps/nozzles/${fuel.n1.id}`, { token: T(), body: { tank_id: fuel.t2.id } })).status, 409);
  assert.equal((await app.request('POST', '/api/fuel-sales', { token: T(), body: { nozzle_id: fuel.n1.id, litres: 5 } })).status, 409);
  assert.equal((await app.request('POST', `/api/attendant-shifts/${sh.body.id}/delete`, { token: T(), body: { password: require('./helpers/fixtures').PASSWORD } })).status, 200);
});

test('F4: a nozzle with shift history cannot be deleted', async () => {
  const sh = (await app.request('POST', '/api/attendant-shifts/open', { token: T(), body: { attendant_user_id: staff.users.att2.id, nozzle_ids: [fuel.n2.id], shift_type: 'DAY' } })).body;
  const rd = (await app.request('GET', `/api/attendant-shifts/${sh.id}`, { token: T() })).body.readings[0];
  const c = await app.request('POST', `/api/attendant-shifts/${sh.id}/close`, { token: T(), body: { readings: [{ id: rd.id, closing_reading: rd.opening_reading + 20 }], payment_cash: 490 } });
  assert.equal(c.status, 200, c.text);
  const r = await app.request('DELETE', `/api/pumps/nozzles/${fuel.n2.id}`, { token: T() });
  assert.equal(r.status, 409);
  assert.deepEqual(tankLedger(db), []);
});

test('a tank with nozzles attached cannot be deleted', async () => {
  const r = await app.request('DELETE', `/api/tanks/${fuel.t1.id}`, { token: T() });
  assert.equal(r.status, 400);
});

test('dip post-adjustment is Administrator-only and keeps the ledger consistent', async () => {
  const d = await app.request('POST', '/api/tank-dips', { token: T(), body: { tank_id: fuel.t2.id, measured_litres: 12000 } });
  assert.ok(d.status < 300, d.text);
  const dip = db.prepare('SELECT id FROM tank_dips WHERE tank_id = ? ORDER BY id DESC LIMIT 1').get(fuel.t2.id);
  assert.equal((await app.request('POST', `/api/tank-dips/${dip.id}/post-adjustment`, { token: staff.tokens.cashier })).status, 403);
  assert.equal((await app.request('POST', `/api/tank-dips/${dip.id}/post-adjustment`, { token: T() })).status, 200);
  assert.equal(vol(fuel.t2.id), 12000);
  const bad = tankLedger(db).filter(x => x.startsWith('tank T2'));
  assert.deepEqual(bad, []);
});

test('F4: a tank with ledger history cannot be deleted; an unused one can', async () => {
  const withHistory = (await app.request('POST', '/api/tanks', { token: T(), body: { code: 'T3', name: 'Spare', fuel_grade_id: fuel.petrol.id, capacity_litres: 5000, current_volume: 100 } })).body;
  const unused = (await app.request('POST', '/api/tanks', { token: T(), body: { code: 'T4', name: 'Never used', fuel_grade_id: fuel.petrol.id, capacity_litres: 5000 } })).body;
  assert.equal((await app.request('DELETE', `/api/tanks/${withHistory.id}`, { token: T() })).status, 409);
  assert.equal((await app.request('DELETE', `/api/tanks/${unused.id}`, { token: T() })).status, 200);
});

test('F4: the database itself refuses to delete or rewrite ledger rows', () => {
  const row = db.prepare('SELECT id FROM tank_movements LIMIT 1').get();
  assert.throws(() => db.prepare('DELETE FROM tank_movements WHERE id = ?').run(row.id), /cannot be deleted/);
  assert.throws(() => db.prepare('UPDATE tank_movements SET litres = 0 WHERE id = ?').run(row.id), /cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM tanks WHERE id = ?').run(fuel.t1.id), /ledger history|FOREIGN KEY/);
  db.prepare("UPDATE tank_movements SET notes = 'annotated' WHERE id = ?").run(row.id); // notes stay editable
});

test('F4: ledger check — Administrator only, and the books balance', async () => {
  assert.equal((await app.request('GET', '/api/tanks/ledger-check', { token: staff.tokens.cashier })).status, 403);
  const r = await app.request('GET', '/api/tanks/ledger-check', { token: T() });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, JSON.stringify(r.body.problems));
});
