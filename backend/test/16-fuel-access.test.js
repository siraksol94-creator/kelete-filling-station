// Fuel Station access — business decisions 2026-11-18:
//   • fuel prices (grades), pumps and tanks: set up / changed by Administrators only
//   • fuel deliveries: Managers / Supervisors (and Administrators) only
//   • cashiers: none of the above (they still READ prices, nozzles and tanks
//     for their shift and credit-ticket screens)
//   • nozzle meter corrections: supervisors too (decision S7), meter only
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel } = require('./helpers/fixtures');

let app, db, staff, fuel;
const tok = (who) => staff.tokens[who];
const req = (who, method, path, body) => app.request(method, path, { token: tok(who), body });

before(async () => {
  app = await startApp(); db = app.db; staff = await seedStaff(app);
  fuel = await seedFuel(app, tok('owner'));
});
after(async () => { await app.close(); });

describe('prices, pumps and tanks: Administrators only', () => {
  const writes = () => [
    ['POST', '/api/fuel-grades', { code: 'X1', name: 'X', selling_price: 1, cost_price: 1 }],
    ['PUT', `/api/fuel-grades/${fuel.petrol.id}`, { selling_price: 99 }],
    ['DELETE', `/api/fuel-grades/${fuel.diesel.id}`],
    ['POST', '/api/pumps', { code: 'PX', name: 'X' }],
    ['PUT', `/api/pumps/${fuel.pump.id}`, { code: 'P1', name: 'Renamed' }],
    ['DELETE', `/api/pumps/${fuel.pump.id}`],
    ['POST', '/api/pumps/nozzles', { pump_id: fuel.pump.id, tank_id: fuel.t1.id, code: 'NX' }],
    ['DELETE', `/api/pumps/nozzles/${fuel.n1.id}`],
    ['POST', '/api/tanks', { code: 'TX', name: 'X', fuel_grade_id: fuel.petrol.id, capacity_litres: 1 }],
    ['PUT', `/api/tanks/${fuel.t1.id}`, { name: 'Renamed' }],
    ['DELETE', `/api/tanks/${fuel.t2.id}`],
  ];
  for (const who of ['cashier', 'supervisor', 'att1']) {
    test(`${who} cannot create, change or delete grades, pumps, nozzles or tanks`, async () => {
      for (const [m, p, b] of writes()) {
        const r = await req(who, m, p, b);
        assert.equal(r.status, 403, `${who} ${m} ${p} → ${r.status}`);
      }
      assert.equal(Number(db.prepare('SELECT selling_price FROM fuel_grades WHERE id = ?').get(fuel.petrol.id).selling_price), 25, 'price unchanged');
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pumps").get().n, 1);
    });
  }
  test('an Administrator can', async () => {
    assert.equal((await req('owner', 'PUT', `/api/fuel-grades/${fuel.petrol.id}`, { selling_price: 26 })).status, 200);
    assert.equal((await req('owner', 'POST', '/api/pumps', { code: 'P2', name: 'Pump 2' })).status, 201);
    assert.equal((await req('owner', 'POST', '/api/tanks', { code: 'T3', name: 'Tank 3', fuel_grade_id: fuel.petrol.id, capacity_litres: 1000 })).status, 201);
  });
  test('cashiers still READ prices, nozzles and tanks (shift and credit-ticket screens)', async () => {
    for (const p of ['/api/fuel-grades', '/api/pumps/nozzles/list', '/api/tanks']) {
      assert.equal((await req('cashier', 'GET', p)).status, 200, p);
    }
  });
});

describe('nozzle meter corrections: supervisors may change the meter, nothing else', () => {
  test('supervisor: meter yes; code / tank / status no; cashier: nothing', async () => {
    const cur = db.prepare('SELECT * FROM nozzles WHERE id = ?').get(fuel.n2.id);
    assert.equal((await req('supervisor', 'PUT', `/api/pumps/nozzles/${fuel.n2.id}`, { ...cur, current_meter_reading: cur.current_meter_reading + 1 })).status, 200);
    assert.equal((await req('supervisor', 'PUT', `/api/pumps/nozzles/${fuel.n2.id}`, { status: 'Inactive' })).status, 403);
    assert.equal((await req('supervisor', 'PUT', `/api/pumps/nozzles/${fuel.n2.id}`, { tank_id: fuel.t1.id })).status, 403);
    assert.equal((await req('cashier', 'PUT', `/api/pumps/nozzles/${fuel.n2.id}`, { current_meter_reading: 1 })).status, 403);
    assert.equal(db.prepare('SELECT status FROM nozzles WHERE id = ?').get(fuel.n2.id).status, cur.status);
  });
});

describe('fuel deliveries: Managers / Supervisors / Administrators only', () => {
  const delivery = () => ({ tank_id: fuel.t1.id, fuel_grade_id: fuel.petrol.id, litres_delivered: 500, cost_per_litre: 20 });
  test('a cashier or attendant cannot see, record or delete deliveries', async () => {
    for (const who of ['cashier', 'att1']) {
      assert.equal((await req(who, 'GET', '/api/fuel-deliveries')).status, 403);
      assert.equal((await req(who, 'POST', '/api/fuel-deliveries', delivery())).status, 403);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM fuel_deliveries').get().n, 0);
  });
  test('a supervisor (Manager) and an Administrator can', async () => {
    const r = await req('supervisor', 'POST', '/api/fuel-deliveries', delivery());
    assert.ok(r.status < 300, r.text);
    assert.equal((await req('supervisor', 'GET', '/api/fuel-deliveries')).status, 200);
    assert.equal((await req('owner', 'GET', '/api/fuel-deliveries')).status, 200);
    const id = r.body.id || (r.body.delivery && r.body.delivery.id);
    assert.equal((await req('cashier', 'DELETE', `/api/fuel-deliveries/${id}`)).status, 403);
  });
  test('an account demoted from Manager loses delivery access at once', async () => {
    const { createUser, login } = require('./helpers/fixtures');
    await createUser(db, { email: 'mgr2', role: 'Manager' });
    const t = await login(app, 'mgr2');
    assert.equal((await app.request('GET', '/api/fuel-deliveries', { token: t })).status, 200);
    db.prepare("UPDATE users SET role = 'Cashier' WHERE email = 'mgr2'").run();
    assert.equal((await app.request('GET', '/api/fuel-deliveries', { token: t })).status, 403);
  });
});
