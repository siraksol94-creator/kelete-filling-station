// F1 — fuel data travels between a till and the VPS (two real processes,
// throwaway databases, invented data). The VPS is given rows of its own first,
// so row numbers differ on the two sides and every link must be re-pointed.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { startPair } = require('./helpers/syncPair');

let pair, vps, till;
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };
const one = async (node, sql, params = []) => (await node.sql(sql, params))[0];

// What the till's fuel setup looks like, by sync_id, on a given side.
async function linkView(node) {
  return {
    nozzle: await one(node, `SELECT n.code, t.sync_id AS tank, p.sync_id AS pump FROM nozzles n JOIN tanks t ON t.id = n.tank_id JOIN pumps p ON p.id = n.pump_id WHERE n.code = 'TP1-ULP'`),
    tank: await one(node, `SELECT t.code, g.sync_id AS grade, t.current_volume FROM tanks t JOIN fuel_grades g ON g.id = t.fuel_grade_id WHERE t.code = 'TT1'`),
  };
}

let fuel, shift, attendant, customer;
before(async () => {
  pair = await startPair({ tenant: 'T-FUEL' });
  ({ vps, till } = pair);
  // The VPS's own fuel setup (different codes) — pushes its row ids ahead.
  ok(await vps.api('POST', '/api/fuel-grades', { body: { code: 'VPS1', name: 'HQ grade', selling_price: 1, cost_price: 1 } }), 'vps grade');
  ok(await vps.api('POST', '/api/fuel-grades', { body: { code: 'VPS2', name: 'HQ grade 2', selling_price: 1, cost_price: 1 } }), 'vps grade 2');

  // The station's setup and one trading shift, all on the till.
  const g = ok(await till.api('POST', '/api/fuel-grades', { body: { code: 'TULP', name: 'Petrol', selling_price: 25, cost_price: 20 } }), 'grade');
  const t = ok(await till.api('POST', '/api/tanks', { body: { code: 'TT1', name: 'Tank 1', fuel_grade_id: g.id, capacity_litres: 30000, current_volume: 10000 } }), 'tank');
  const p = ok(await till.api('POST', '/api/pumps', { body: { code: 'TP1', name: 'Pump 1' } }), 'pump');
  const spare = ok(await till.api('POST', '/api/pumps', { body: { code: 'TP9', name: 'Spare pump' } }), 'spare pump');
  const n = ok(await till.api('POST', '/api/pumps/nozzles', { body: { pump_id: p.id, tank_id: t.id, code: 'TP1-ULP', current_meter_reading: 100000 } }), 'nozzle');
  fuel = { g, t, p, n, spare };
  const { createUser } = require('./helpers/fixtures');
  // users are created through the till's own API so they sync like real ones
  const u = ok(await till.api('POST', '/api/users', { body: { firstName: 'Att', lastName: 'One', email: 'att-f1', password: 'Test-Pass-123', phone: '', role: 'Cashier', permissions: ['POS'], isRouteSeller: false } }), 'attendant');
  attendant = u.user || u;
  customer = ok(await till.api('POST', '/api/customers', { body: { name: 'F1 Haulage', type: 'Credit', phone: '', email: '', address: '', tpin: '', credit_limit: 100000, payment_terms_days: 30, credit_status: 'Active' } }), 'customer');
  shift = ok(await till.api('POST', '/api/attendant-shifts/open', { body: { attendant_user_id: attendant.id, nozzle_ids: [n.id], shift_type: 'DAY' } }), 'shift');
  ok(await till.api('POST', `/api/attendant-shifts/${shift.id}/credit-sales`, { body: { payment_method: 'Credit', customer_id: customer.id, customer_name: customer.name, fuel_grade_id: g.id, litres: 40, price_per_litre: 25 } }), 'credit');
  const reading = ok(await till.api('GET', `/api/attendant-shifts/${shift.id}`), 'shift detail').readings[0];
  ok(await till.api('POST', `/api/attendant-shifts/${shift.id}/close`, { body: { readings: [{ id: reading.id, closing_reading: 100500 }], payment_cash: 11500 } }), 'close');
  void createUser;
});
after(async () => { if (pair) await pair.stop(); });

describe('till → VPS', () => {
  test('the station setup arrives with every link pointing at the right VPS row', async () => {
    await pair.syncNow();
    const onTill = await linkView(till);
    const onVps = await linkView(vps);
    assert.deepEqual(onVps.nozzle, onTill.nozzle);
    assert.equal(onVps.tank.grade, onTill.tank.grade);
    const ids = { till: await one(till, "SELECT id FROM fuel_grades WHERE code='TULP'"), vps: await one(vps, "SELECT id FROM fuel_grades WHERE code='TULP'") };
    assert.notEqual(ids.till.id, ids.vps.id, 'row numbers differ — the links were re-pointed, not copied');
  });

  test('the shift, its readings, credit ticket and tank ledger arrive linked; the VPS tank equals its own ledger', async () => {
    const s = await one(vps, `SELECT s.status, u.email FROM attendant_shifts s JOIN users u ON u.id = s.attendant_user_id`);
    assert.equal(s.email, 'att-f1');
    const r = await one(vps, `SELECT r.litres_sold, n.code FROM shift_nozzle_readings r JOIN nozzles n ON n.id = r.nozzle_id JOIN attendant_shifts s ON s.id = r.shift_id`);
    assert.equal(r.code, 'TP1-ULP');
    assert.equal(Number(r.litres_sold), 500);
    const c = await one(vps, `SELECT c.amount, cu.name FROM shift_credit_sales c JOIN customers cu ON cu.id = c.customer_id JOIN attendant_shifts s ON s.id = c.shift_id`);
    assert.equal(c.name, 'F1 Haulage');
    assert.equal(Number(c.amount), 1000);
    const m = await vps.sql(`SELECT m.type, m.litres, m.ref_table, (SELECT COUNT(*) FROM attendant_shifts s WHERE s.id = m.ref_id) AS ref_ok
                               FROM tank_movements m JOIN tanks t ON t.id = m.tank_id WHERE t.code = 'TT1' ORDER BY m.litres DESC`);
    assert.deepEqual(m.map(x => [x.type, Number(x.litres)]), [['opening', 10000], ['sale', -500]]);
    assert.equal(m.find(x => x.ref_table === 'attendant_shifts').ref_ok, 1, 'the sale movement points at the VPS copy of the shift');
    const tank = await one(vps, "SELECT current_volume FROM tanks WHERE code = 'TT1'");
    assert.equal(Number(tank.current_volume), 9500);
    const check = await vps.api('GET', '/api/tanks/ledger-check');
    assert.equal(check.status, 200, check.text);
    assert.deepEqual((check.body.mismatches || check.body.problems || []), []);
  });

  test('nothing is re-sent: after the sync every fuel row on the till is marked sent', async () => {
    await pair.syncNow();
    for (const t of ['fuel_grades', 'tanks', 'pumps', 'nozzles', 'attendant_shifts', 'shift_nozzle_readings', 'shift_credit_sales', 'tank_movements']) {
      const n = await one(till, `SELECT COUNT(*) AS n FROM ${t} WHERE synced = 0`);
      assert.equal(n.n, 0, `${t} still pending`);
    }
  });
});

describe('VPS → till, deletions, conflicts', () => {
  test('a price change made on the VPS reaches the till (and is not echoed back)', async () => {
    const g = await one(vps, "SELECT id FROM fuel_grades WHERE code = 'TULP'");
    ok(await vps.api('PUT', `/api/fuel-grades/${g.id}`, { body: { selling_price: 26.5 } }), 'price change');
    await pair.syncNow();
    const t = await one(till, "SELECT selling_price, synced FROM fuel_grades WHERE code = 'TULP'");
    assert.equal(Number(t.selling_price), 26.5);
    assert.equal(t.synced, 1);
  });

  test('a deletion on the till is replayed on the VPS', async () => {
    assert.ok(await one(vps, "SELECT id FROM pumps WHERE code = 'TP9'"));
    ok(await till.api('DELETE', `/api/pumps/${fuel.spare.id}`), 'delete spare pump');
    await pair.syncNow();
    assert.equal(await one(vps, "SELECT id FROM pumps WHERE code = 'TP9'"), undefined);
  });

  test('the same grade code created on both sides is reported, kept pending on the till, never silently dropped or merged', async () => {
    ok(await vps.api('POST', '/api/fuel-grades', { body: { code: 'DSL', name: 'Diesel (HQ)', selling_price: 24, cost_price: 19 } }), 'vps DSL');
    ok(await till.api('POST', '/api/fuel-grades', { body: { code: 'DSL', name: 'Diesel (till)', selling_price: 24, cost_price: 19 } }), 'till DSL');
    await pair.syncNow(); // no sync error
    assert.equal((await one(vps, "SELECT name FROM fuel_grades WHERE code = 'DSL'")).name, 'Diesel (HQ)');
    assert.equal((await one(till, "SELECT synced FROM fuel_grades WHERE code = 'DSL'")).synced, 0, 'still pending — needs a person');
  });
});

describe('upgrade: existing fuel records get their sync identity and links', () => {
  test('migration 6 on a database built by the original code: nothing lost, links filled, queued once', () => {
    const { initTenantDb } = require('../config/migrations');
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'f1-upgrade-'));
    try {
      const db = new Database(path.join(dir, 'legacy.db'));
      db.exec(fs.readFileSync(path.join(__dirname, 'fixtures/legacy-baseline-schema.sql'), 'utf8'));
      db.prepare("INSERT OR REPLACE INTO sync_config (key, value) VALUES ('tenant_id', 't-legacy')").run();
      db.prepare("INSERT INTO fuel_grades (code, name, selling_price, cost_price) VALUES ('ULP', 'Petrol', 25, 20)").run();
      db.prepare("INSERT INTO tanks (code, name, fuel_grade_id, capacity_litres, current_volume) VALUES ('T1', 'Tank 1', 1, 1000, 100)").run();
      db.prepare("INSERT INTO tank_movements (tank_id, movement_date, type, litres) VALUES (1, '2026-01-01', 'opening', 100)").run();
      const r = initTenantDb(db);
      assert.equal(r.failed, null);
      const tank = db.prepare('SELECT * FROM tanks').get();
      const grade = db.prepare('SELECT * FROM fuel_grades').get();
      const mv = db.prepare('SELECT * FROM tank_movements').get();
      assert.ok(grade.sync_id && tank.sync_id && mv.sync_id);
      assert.equal(tank.fuel_grade_sync_id, grade.sync_id);
      assert.equal(mv.tank_sync_id, tank.sync_id);
      assert.equal(tank.tenant_id, 't-legacy');
      assert.equal(tank.synced, 0);
      assert.equal(Number(tank.current_volume), 100);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tank_movements').get().n, 1);
      db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('KELETE_FUEL_SYNC=off leaves the fuel tables out of sync on that machine', () => {
    const fuelSync = require('../config/fuelSync');
    try { process.env.KELETE_FUEL_SYNC = 'off'; assert.deepEqual(fuelSync.syncTables(), []); }
    finally { delete process.env.KELETE_FUEL_SYNC; }
    assert.ok(fuelSync.syncTables().includes('tank_movements'));
  });
});
