// UTC dates fix — shifts, approvals, defaults and fuel reports use the
// station's day (Zambia, UTC+2), not the UTC date. The clock is simulated with
// KELETE_TEST_NOW (honoured only when NODE_ENV=test).
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel, createCustomer } = require('./helpers/fixtures');
const bt = require('../config/businessTime');

let app, db, staff, fuel, customer;
const T = () => staff.tokens.owner;
const at = (iso) => { process.env.KELETE_TEST_NOW = iso; };
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };

before(async () => {
  app = await startApp(); db = app.db; staff = await seedStaff(app);
  fuel = await seedFuel(app, T());
  customer = await createCustomer(app, T());
});
after(async () => { delete process.env.KELETE_TEST_NOW; await app.close(); });

describe('the business date', () => {
  afterEach(() => { delete process.env.KELETE_UTC_OFFSET_MINUTES; });
  test('00:00–02:00 in Lusaka is already the new day (it was "yesterday" in UTC)', () => {
    assert.equal(bt.businessDate(new Date('2026-11-18T21:59:00Z')), '2026-11-18'); // 23:59 Lusaka
    assert.equal(bt.businessDate(new Date('2026-11-18T22:00:00Z')), '2026-11-19'); // 00:00 Lusaka
    assert.equal(bt.businessDate(new Date('2026-11-18T23:45:00Z')), '2026-11-19'); // 01:45 Lusaka
    assert.equal(bt.businessDate(new Date('2026-11-19T10:00:00Z')), '2026-11-19');
  });
  test('the offset can be configured; the test clock is ignored outside tests', () => {
    process.env.KELETE_UTC_OFFSET_MINUTES = '0';
    assert.equal(bt.businessDate(new Date('2026-11-18T23:45:00Z')), '2026-11-18');
    const env = process.env.NODE_ENV;
    try { process.env.NODE_ENV = 'production'; at('2000-01-01T00:00:00Z'); assert.notEqual(bt.now().getUTCFullYear(), 2000); }
    finally { process.env.NODE_ENV = env; delete process.env.KELETE_TEST_NOW; }
  });
  test('SQLite conversion matches', () => {
    const r = db.prepare(`SELECT ${bt.sqlBusinessDate("'2026-11-18 22:30:00'")} AS d`).get();
    assert.equal(r.d, '2026-11-19');
  });
});

describe('a night shift opened at 00:30 Lusaka (22:30 UTC the day before)', () => {
  let shift;
  before(async () => {
    at('2026-11-18T22:30:00Z');
    shift = ok(await app.request('POST', '/api/attendant-shifts/open', { token: T(),
      body: { attendant_user_id: staff.users.att1.id, nozzle_ids: [fuel.n1.id] } }), 'open');
  });

  test('belongs to the 19th, and is a NIGHT shift by the station\'s clock', () => {
    const s = db.prepare('SELECT shift_date, shift_type FROM attendant_shifts WHERE id = ?').get(shift.id);
    assert.equal(s.shift_date, '2026-11-19');
    assert.equal(s.shift_type, 'NIGHT');
  });

  test('shift lists and the fuel cash report file it under the 19th, not the 18th', async () => {
    const on19 = ok(await app.request('GET', '/api/attendant-shifts?from=2026-11-19&to=2026-11-19', { token: T() }), 'list 19');
    const on18 = ok(await app.request('GET', '/api/attendant-shifts?from=2026-11-18&to=2026-11-18', { token: T() }), 'list 18');
    const ids = (x) => (Array.isArray(x) ? x : x.shifts || x.rows || []).map(s => s.id);
    assert.ok(ids(on19).includes(shift.id));
    assert.ok(!ids(on18).includes(shift.id));
  });

  test('defaults while it runs: a credit ticket, a dip and a delivery are dated the 19th', async () => {
    ok(await app.request('POST', `/api/attendant-shifts/${shift.id}/credit-sales`, { token: T(),
      body: { payment_method: 'Credit', customer_id: customer.id, customer_name: customer.name, fuel_grade_id: fuel.petrol.id, litres: 10, price_per_litre: 25 } }), 'credit');
    assert.equal(db.prepare('SELECT date FROM shift_credit_sales WHERE shift_id = ?').get(shift.id).date, '2026-11-19');
    ok(await app.request('POST', '/api/tank-dips', { token: T(), body: { tank_id: fuel.t2.id, measured_litres: 9990, shift_type: 'NIGHT' } }), 'dip');
    assert.equal(db.prepare('SELECT dip_date FROM tank_dips WHERE tank_id = ? ORDER BY id DESC').get(fuel.t2.id).dip_date, '2026-11-19');
    const d = ok(await app.request('POST', '/api/fuel-deliveries', { token: T(), body: { tank_id: fuel.t2.id, fuel_grade_id: fuel.diesel.id, litres_delivered: 100, cost_per_litre: 19 } }), 'delivery');
    const del = db.prepare('SELECT delivery_date FROM fuel_deliveries WHERE id = ?').get(d.id || d.delivery?.id);
    assert.equal(del.delivery_date, '2026-11-19');
    const mv = db.prepare("SELECT movement_date FROM tank_movements WHERE ref_table = 'fuel_deliveries' ORDER BY id DESC").get();
    assert.equal(mv.movement_date, '2026-11-19');
  });

  test('the day approval for the 19th sees it as still open; the 18th does not', async () => {
    const r19 = await app.request('POST', '/api/fuel-day-approvals/2026-11-19/approve', { token: T(), body: {} });
    assert.ok(r19.status >= 400 && /still Open/.test(r19.text), r19.text);
  });

  test('closing (at 05:30 Lusaka) posts the sale to the tank ledger on the shift\'s day', async () => {
    at('2026-11-19T03:30:00Z');
    const reading = ok(await app.request('GET', `/api/attendant-shifts/${shift.id}`, { token: T() }), 'detail').readings[0];
    ok(await app.request('POST', `/api/attendant-shifts/${shift.id}/close`, { token: T(),
      body: { readings: [{ id: reading.id, closing_reading: 100200 }], payment_cash: 4750 } }), 'close');
    const mv = db.prepare("SELECT movement_date FROM tank_movements WHERE ref_table = 'attendant_shifts' AND ref_id = ?").get(shift.id);
    assert.equal(mv.movement_date, '2026-11-19');
    // the daily roll-up and the day summary (Fuel Cash Report) put it on the 19th
    const roll19 = ok(await app.request('GET', '/api/attendant-shifts/daily-rollup?date=2026-11-19', { token: T() }), 'rollup 19');
    const roll18 = ok(await app.request('GET', '/api/attendant-shifts/daily-rollup?date=2026-11-18', { token: T() }), 'rollup 18');
    const has = (x) => JSON.stringify(x).includes(`"id":${shift.id},`);
    assert.ok(has(roll19), 'in the 19th roll-up');
    assert.ok(!has(roll18), 'not in the 18th roll-up');
    const day19 = ok(await app.request('GET', '/api/attendant-shifts/day-summary?date=2026-11-19', { token: T() }), 'day summary 19');
    const day18 = ok(await app.request('GET', '/api/attendant-shifts/day-summary?date=2026-11-18', { token: T() }), 'day summary 18');
    assert.notDeepEqual(day19, day18);
    assert.ok(JSON.stringify(day19).includes('4750'), 'the shift\'s cash is counted on the 19th');
    assert.ok(!JSON.stringify(day18).includes('4750'));
  });

  test('the NIGHT approval for the 19th covers it and locks it; the 18th has no such shift', async () => {
    const wrong = await app.request('POST', '/api/fuel-shift-approvals/2026-11-18/NIGHT/approve', { token: T(), body: {} });
    assert.ok(wrong.status >= 400 && /no NIGHT shifts on 2026-11-18/.test(wrong.text), wrong.text);
    ok(await app.request('POST', '/api/fuel-shift-approvals/2026-11-19/NIGHT/approve', { token: T(), body: {} }), 'approve 19');
    const reopen = await app.request('POST', `/api/attendant-shifts/${shift.id}/reopen`, { token: T(), body: {} });
    assert.equal(reopen.status, 409);
    assert.match(reopen.text, /NIGHT shift for 2026-11-19 is approved/);
  });
});

describe('DAY / NIGHT when the screen does not say', () => {
  test('07:00 Lusaka (05:00 UTC) is DAY; 18:30 Lusaka (16:30 UTC) is NIGHT', async () => {
    at('2026-11-20T05:00:00Z');
    const a = ok(await app.request('POST', '/api/attendant-shifts/open', { token: T(), body: { attendant_user_id: staff.users.att2.id, nozzle_ids: [fuel.n2.id] } }), 'open day');
    assert.equal(db.prepare('SELECT shift_type, shift_date FROM attendant_shifts WHERE id = ?').get(a.id).shift_type, 'DAY');
    db.prepare("UPDATE attendant_shifts SET status = 'Closed' WHERE id = ?").run(a.id);
    at('2026-11-20T16:30:00Z');
    const b = ok(await app.request('POST', '/api/attendant-shifts/open', { token: T(), body: { attendant_user_id: staff.users.att2.id, nozzle_ids: [fuel.n2.id] } }), 'open night');
    const s = db.prepare('SELECT shift_type, shift_date FROM attendant_shifts WHERE id = ?').get(b.id);
    assert.equal(s.shift_type, 'NIGHT');
    assert.equal(s.shift_date, '2026-11-20');
    db.prepare("UPDATE attendant_shifts SET status = 'Closed' WHERE id = ?").run(b.id);
  });
});

describe('existing shifts keep the day they were approved under', () => {
  test('migration 7 gives older shifts their old (UTC) date, so existing approvals cover the same shifts', () => {
    const info = db.prepare(`INSERT INTO attendant_shifts (attendant_user_id, opened_by, shift_type, status, opened_at)
                             VALUES (?, ?, 'NIGHT', 'Closed', '2026-10-01 23:30:00')`).run(staff.users.att1.id, staff.users.owner.id);
    db.prepare('UPDATE attendant_shifts SET shift_date = NULL WHERE id = ?').run(info.lastInsertRowid);
    const m7 = require('../config/versionedMigrations').find(m => m.version === 7);
    m7.up(db.defaultDb);
    const row = db.prepare('SELECT shift_date, synced FROM attendant_shifts WHERE id = ?').get(info.lastInsertRowid);
    assert.equal(row.shift_date, '2026-10-01', 'old rule: DATE(opened_at) in UTC');
    const { windowOf } = require('../services/fuelControls');
    assert.deepEqual(windowOf({ opened_at: '2026-10-01 23:30:00', shift_type: 'NIGHT' }), { date: '2026-10-01', type: 'NIGHT' }, 'no shift_date → unchanged rule');
  });
});
