// UX-8 — read-only extras for the Pumps and Deliveries screens.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel } = require('./helpers/fixtures');

let app, staff, fuel;
before(async () => {
  app = await startApp(); staff = await seedStaff(app);
  fuel = await seedFuel(app, staff.tokens.owner);
});
after(async () => { await app.close(); });

test('pumps list who is on shift at each pump (open shifts only)', async () => {
  const T = staff.tokens.owner;
  let pumps = (await app.request('GET', '/api/pumps', { token: T })).body;
  assert.deepEqual(pumps[0].on_shift, [], 'nobody yet');
  const r = await app.request('POST', '/api/attendant-shifts/open', { token: T, body: { attendant_user_id: staff.users.att1.id, nozzle_ids: [fuel.n1.id], shift_type: 'DAY' } });
  assert.ok(r.status < 300, r.text);
  pumps = (await app.request('GET', '/api/pumps', { token: T })).body;
  assert.equal(pumps[0].on_shift.length, 1);
  assert.equal(pumps[0].on_shift[0].attendant_name, 'Attendant One');
  assert.equal(pumps[0].on_shift[0].attendant_user_id, staff.users.att1.id);
  assert.ok(Array.isArray(pumps[0].nozzles) && pumps[0].nozzles.length >= 1, 'nozzles unchanged');
});

test('deliveries carry the grade colour and the tank capacity', async () => {
  const T = staff.tokens.owner;
  const c = await app.request('POST', '/api/fuel-deliveries', { token: T, body: { tank_id: fuel.t1.id, litres_delivered: 5000, cost_per_litre: 20, dip_before: 10000, dip_after: 14980, litres_ordered: 5000 } });
  assert.ok(c.status < 300, c.text);
  const rows = (await app.request('GET', '/api/fuel-deliveries', { token: T })).body;
  assert.equal(rows[0].tank_capacity, 30000);
  assert.ok(rows[0].grade_color, 'grade colour present');
  assert.equal(rows[0].dip_after, 14980);
});
