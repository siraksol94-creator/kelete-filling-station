// UX-10 — the station day (work done, never money) and the dip streak.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel } = require('./helpers/fixtures');

let app, staff, fuel, T;
const today = require('../config/businessTime').businessDate();
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };
before(async () => {
  app = await startApp(); staff = await seedStaff(app);
  T = staff.tokens.owner;
  fuel = await seedFuel(app, T);
});
after(async () => { await app.close(); });

const day = async () => ok(await app.request('GET', `/api/station-day?date=${today}`, { token: staff.tokens.owner }), 'station-day');
const step = (d, k) => d.steps.find((s) => s.key === k);

test('a quiet day: nothing to do, not sealed', async () => {
  const d = await day();
  assert.equal(d.sealed, false);
  assert.deepEqual(d.steps.map((s) => [s.key, s.done, s.total]), [['closed', 0, 0], ['cash', 0, 0], ['dips', 0, 0], ['approved', 0, 0]]);
});

test('the ring fills as the work is done, and the day seals', async () => {
  const shift = ok(await app.request('POST', '/api/attendant-shifts/open', { token: T, body: { attendant_user_id: staff.users.att1.id, nozzle_ids: [fuel.n1.id], shift_type: 'DAY' } }), 'open');
  let d = await day();
  assert.deepEqual([step(d, 'closed').done, step(d, 'closed').total], [0, 1]);
  assert.equal(step(d, 'dips').total, 2, 'two standalone tanks × one shift type');

  const det = ok(await app.request('GET', `/api/attendant-shifts/${shift.id}`, { token: T }), 'detail');
  ok(await app.request('POST', `/api/attendant-shifts/${shift.id}/close`, { token: T, body: {
    readings: det.readings.map((r) => ({ id: r.id, closing_reading: Number(r.opening_reading) + 100 })), payment_cash: 2500 } }), 'close');
  d = await day();
  assert.equal(step(d, 'closed').done, 1);
  assert.equal(step(d, 'cash').done, 1);

  for (const t of [fuel.t1, fuel.t2]) ok(await app.request('POST', '/api/tank-dips', { token: T, body: { tank_id: t.id, shift_type: 'DAY', dip_date: today, measured_litres: 9900 } }), 'dip');
  d = await day();
  assert.equal(step(d, 'dips').done, 2);
  assert.equal(d.dip_streak, 1, 'today complete → counts');
  assert.equal(d.sealed, false, 'not approved yet');

  ok(await app.request('POST', `/api/fuel-shift-approvals/${today}/DAY/approve`, { token: T, body: {} }), 'approve');
  d = await day();
  assert.equal(step(d, 'approved').done, 1);
  assert.equal(d.sealed, true);
});

test('read-only and open to any signed-in user', async () => {
  const before = app.db.prepare('SELECT COUNT(*) AS n FROM tank_movements').get().n;
  const r = await app.request('GET', `/api/station-day?date=${today}`, { token: staff.tokens.att1 });
  assert.equal(r.status, 200, r.text);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM tank_movements').get().n, before);
});
