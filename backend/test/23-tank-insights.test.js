// UX-7 — /api/tanks/insights: space left, last dip, last delivery (read-only).
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel } = require('./helpers/fixtures');

let app, staff, fuel;
before(async () => {
  app = await startApp(); staff = await seedStaff(app);
  fuel = await seedFuel(app, staff.tokens.owner, { opening: 10000 });
});
after(async () => { await app.close(); });

test('space left, newest dip and delivery per tank; nothing changes', async () => {
  const t1 = app.db.prepare("SELECT id FROM tanks WHERE code = 'T1'").get().id;
  const t2 = app.db.prepare("SELECT id FROM tanks WHERE code = 'T2'").get().id;
  app.db.prepare("INSERT INTO tank_dips (tank_id, dip_date, measured_litres, book_litres, variance) VALUES (?, '2026-11-01', 9990, 10000, -10)").run(t1);
  app.db.prepare("INSERT INTO tank_dips (tank_id, dip_date, measured_litres, book_litres, variance) VALUES (?, '2026-11-03', 9940, 10000, -60)").run(t1);
  const before = app.db.prepare('SELECT SUM(current_volume) AS v FROM tanks').get().v;
  const r = await app.request('GET', '/api/tanks/insights', { token: staff.tokens.owner });
  assert.equal(r.status, 200, r.text);
  const a = r.body.tanks[t1], b = r.body.tanks[t2];
  assert.equal(a.space_left, 20000);
  assert.deepEqual(a.last_dip, { date: '2026-11-03', measured: 9940, book: 10000, variance: -60, posted: false });
  assert.equal(b.last_dip, null);
  assert.equal(a.last_delivery, null);
  const gid = app.db.prepare('SELECT fuel_grade_id AS g FROM tanks WHERE id = ?').get(t2).g;
  app.db.prepare("INSERT INTO fuel_deliveries (delivery_number, tank_id, fuel_grade_id, delivery_date, litres_delivered, cost_per_litre, total_cost) VALUES ('FD-1', ?, ?, '2026-11-02', 15000, 19, 285000)").run(t2, gid);
  const r2 = (await app.request('GET', '/api/tanks/insights', { token: staff.tokens.owner })).body;
  assert.deepEqual(r2.tanks[t2].last_delivery, { date: '2026-11-02', litres: 15000, number: 'FD-1' });
  assert.ok('days_cover' in a && 'avg_daily_litres' in a);
  assert.equal(app.db.prepare('SELECT SUM(current_volume) AS v FROM tanks').get().v, before, 'read-only');
});
