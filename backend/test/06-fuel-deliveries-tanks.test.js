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

knownDefect('F4', 'editing a tank opening balance rewrites history instead of posting an adjustment', async () => {
  const opening = () => db.prepare("SELECT litres FROM tank_movements WHERE tank_id = ? AND type = 'opening'").get(fuel.t2.id).litres;
  const rows = () => db.prepare('SELECT COUNT(*) AS n FROM tank_movements WHERE tank_id = ?').get(fuel.t2.id).n;
  const n = rows();
  const r = await app.request('PUT', `/api/tanks/${fuel.t2.id}`, { token: T(), body: { opening_litres: 12345 } });
  assert.equal(r.status, 200);
  assert.equal(opening(), 12345, 'TODAY: the original opening figure is overwritten');
  assert.equal(rows(), n, 'TODAY: no adjustment row is added');
  assert.deepEqual(tankLedger(db), []);
});

knownDefect('F4', 'the legacy /api/fuel-sales endpoint changes the tank without a ledger entry', async () => {
  const r = await app.request('POST', '/api/fuel-sales', { token: T(), body: { nozzle_id: fuel.n1.id, litres: 50 } });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(tankLedger(db).length, 1, 'TODAY: tank cache and ledger now disagree by 50 L');
});

knownDefect('F4/S7', 'any logged-in user can overwrite a nozzle meter (recorded only by the audit trail)', async () => {
  const r = await app.request('PUT', `/api/pumps/nozzles/${fuel.n2.id}`, { token: staff.tokens.cashier, body: { current_meter_reading: 1 } });
  assert.equal(r.status, 200, 'TODAY: no permission check');
  const a = db.prepare("SELECT * FROM audit_log WHERE action = 'nozzle.meter_change' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(a.after_json).current_meter_reading, 1);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE source='request' AND actor_email='cashier' AND path = ?").get(`/api/pumps/nozzles/${fuel.n2.id}`));
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
