// UX-3 — the Dashboard's station block: litres by grade, shift progress,
// reconciled cash (server-saved variance, in full) and tank levels.
// Throwaway database, invented figures.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel } = require('./helpers/fixtures');

let app, staff, fuel, station;
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };

before(async () => {
  app = await startApp(); staff = await seedStaff(app);
  const T = staff.tokens.owner;
  fuel = await seedFuel(app, T);
  const open = (att, noz) => app.request('POST', '/api/attendant-shifts/open', { token: T, body: { attendant_user_id: staff.users[att].id, nozzle_ids: noz, shift_type: 'DAY' } });
  const close = async (shift, closings, cash) => {
    const d = ok(await app.request('GET', `/api/attendant-shifts/${shift.id}`, { token: T }), 'detail');
    ok(await app.request('POST', `/api/attendant-shifts/${shift.id}/close`, { token: T, body: {
      readings: d.readings.map((r) => ({ id: r.id, closing_reading: closings[r.nozzle_id] })), payment_cash: cash } }), 'close');
  };
  // shift A: 100 L petrol @25 = 2,500 — cash 2,500 (balanced)
  const a = ok(await open('att1', [fuel.n1.id]), 'open A');
  await close(a, { [fuel.n1.id]: 100100 }, 2500);
  // shift B: 50 L diesel @24 = 1,200 — cash 1,150 (short 50)
  const b = ok(await open('att2', [fuel.n2.id]), 'open B');
  await close(b, { [fuel.n2.id]: 50050 }, 1150);
  // shift C: still open
  ok(await open('att1', [fuel.n1.id]), 'open C');
  station = ok(await app.request('GET', '/api/dashboard', { token: T }), 'dashboard').station;
});
after(async () => { await app.close(); });

test('litres and takings by grade from the day\'s meters', () => {
  const by = Object.fromEntries(station.grades.map((g) => [g.name, g]));
  assert.equal(by.Petrol.litres, 100);
  assert.equal(by.Petrol.amount, 2500);
  assert.equal(by.Diesel.litres, 50);
  assert.equal(by.Diesel.amount, 1200);
  assert.equal(station.litres, 150);
});

test('shift progress for the day', () => {
  assert.deepEqual(station.shifts, { total: 3, open: 1, closed: 2, cash: 2, approved: 0 });
});

test('cash: the shortage is reported in full, with its sign', () => {
  assert.equal(station.cash.reconciled, 2);
  assert.equal(station.cash.balanced, 1);
  assert.equal(station.cash.variance_total, -50);
});

test('tanks with capacity, current volume and grade colour', () => {
  const t1 = station.tanks.find((t) => t.code === 'T1');
  assert.equal(t1.capacity, 30000);
  assert.equal(t1.volume, 10000 - 100);
  assert.equal(t1.grade, 'Petrol');
  assert.equal(station.tanks.length, 2);
});
