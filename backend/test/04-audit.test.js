// D5 Suite 3 — D2 audit trail.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel, PASSWORD } = require('./helpers/fixtures');
const { auditIntact } = require('./helpers/invariants');

let app, staff, db, fuel;
const last = (action) => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action);
const lastReq = (path) => db.prepare("SELECT * FROM audit_log WHERE source='request' AND path = ? ORDER BY id DESC LIMIT 1").get(path);
const count = (action) => db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action).n;

before(async () => {
  app = await startApp(); db = app.db; staff = await seedStaff(app);
  fuel = await seedFuel(app, staff.tokens.owner);
});
after(async () => { await app.close(); });

describe('database triggers record WHAT changed', () => {
  test('product price change: before and after values', () => {
    db.prepare("INSERT INTO products (name, selling_price, cost_price, sync_id, tenant_id) VALUES ('Oil 1L', 100, 70, 'p-1', 't1')").run();
    db.prepare("UPDATE products SET selling_price = 120 WHERE sync_id = 'p-1'").run();
    const a = last('product.price_change');
    assert.equal(JSON.parse(a.before_json).selling_price, 100);
    assert.equal(JSON.parse(a.after_json).selling_price, 120);
    assert.equal(a.source, 'db-trigger');
  });
  test('non-price edits and same-value writes are not logged', () => {
    const n = count('product.price_change');
    db.prepare("UPDATE products SET name = 'Oil 1 L', current_stock = 5 WHERE sync_id = 'p-1'").run();
    db.prepare("UPDATE products SET selling_price = 120 WHERE sync_id = 'p-1'").run();
    assert.equal(count('product.price_change'), n);
  });
  test('nozzle meter change records the difference', () => {
    db.prepare('UPDATE nozzles SET current_meter_reading = current_meter_reading + 37 WHERE id = ?').run(fuel.n1.id);
    assert.equal(JSON.parse(last('nozzle.meter_change').details_json).delta, 37);
  });
  test('user creation and role/password changes never store the password hash', () => {
    const u = staff.users.att2;
    db.prepare("UPDATE users SET role = 'Administrator', password = 'NEW-HASH-VALUE' WHERE id = ?").run(u.id);
    const a = last('user.security_change');
    assert.equal(JSON.parse(a.after_json).role, 'Administrator');
    assert.equal(JSON.parse(a.details_json).password_changed, 1);
    assert.ok(!JSON.stringify(a).includes('NEW-HASH-VALUE'));
    const created = db.prepare("SELECT after_json FROM audit_log WHERE action='user.create'").all();
    assert.ok(created.length >= 5 && created.every(r => !('password' in JSON.parse(r.after_json))));
    db.prepare("UPDATE users SET role = 'Cashier' WHERE id = ?").run(u.id);
  });
  test('routine login timestamps are not logged as security changes', async () => {
    const n = count('user.security_change');
    await app.request('POST', '/api/auth/login', { body: { email: 'cashier', password: PASSWORD } });
    assert.equal(count('user.security_change'), n);
  });
  test('voided payment voucher is preserved in full', () => {
    db.prepare("INSERT INTO payment_vouchers (voucher_number, amount, date, sync_id) VALUES ('PV-T1', 500, '2026-11-18', 'pv-t1')").run();
    db.prepare("UPDATE payment_vouchers SET deleted_at = datetime('now') WHERE sync_id = 'pv-t1'").run();
    assert.equal(JSON.parse(last('payment_vouchers.soft_delete').before_json).amount, 500);
  });
  test('the audit log refuses UPDATE and DELETE', () => {
    assert.throws(() => db.prepare("UPDATE audit_log SET action = 'x'").run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM audit_log').run(), /append-only/);
    assert.deepEqual(auditIntact(db), []);
  });
});

describe('request log records WHO did it', () => {
  test('fuel price change via the API: who, what request, result — with a matching trigger row', async () => {
    const r = await app.request('PUT', `/api/fuel-grades/${fuel.petrol.id}`, { token: staff.tokens.owner, body: { selling_price: 26.5 } });
    assert.equal(r.status, 200);
    const req = lastReq(`/api/fuel-grades/${fuel.petrol.id}`);
    assert.equal(req.actor_email, 'owner'); assert.equal(req.actor_role, 'Administrator'); assert.equal(req.status_code, 200);
    const trg = last('fuel_grade.price_change');
    assert.equal(JSON.parse(trg.after_json).selling_price, 26.5);
  });
  test('a refused attempt is recorded too (cashier editing a user)', async () => {
    const r = await app.request('PUT', `/api/users/${staff.users.owner.id}`, { token: staff.tokens.cashier, body: { role: 'Cashier', password: 'hunter2' } });
    assert.equal(r.status, 403);
    const a = lastReq(`/api/users/${staff.users.owner.id}`);
    assert.equal(a.actor_email, 'cashier'); assert.equal(a.status_code, 403);
    assert.ok(!a.after_json.includes('hunter2') && a.after_json.includes('[redacted]'));
  });
  test('failed logins are recorded with the username, never the password; successes are not', async () => {
    await app.request('POST', '/api/auth/login', { body: { email: 'cashier', password: 'wrong-pass' } });
    const a = last('auth.login_failed');
    assert.equal(JSON.parse(a.details_json).attempted_username, 'cashier');
    assert.ok(!JSON.stringify(a).includes('wrong-pass'));
    const n = count('auth.login_failed');
    await app.request('POST', '/api/auth/login', { body: { email: 'cashier', password: PASSWORD } });
    assert.equal(count('auth.login_failed'), n);
  });
  test('deletes are recorded', async () => {
    const r = await app.request('DELETE', `/api/pumps/nozzles/${fuel.n2.id}`, { token: staff.tokens.owner });
    assert.ok(r.status < 500);
    assert.ok(lastReq(`/api/pumps/nozzles/${fuel.n2.id}`));
  });
  test('reads and ordinary traffic are not recorded', async () => {
    const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE source='request'").get().n;
    await app.request('GET', '/api/users', { token: staff.tokens.owner });
    await app.request('GET', '/api/tanks', { token: staff.tokens.owner });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE source='request'").get().n, before);
  });
});

describe('read-only admin endpoints', () => {
  test('audit-log and schema-status are administrator-only', async () => {
    for (const p of ['/api/system/audit-log', '/api/system/schema-status']) {
      assert.equal((await app.request('GET', p, { token: staff.tokens.cashier })).status, 403);
      assert.equal((await app.request('GET', p, { token: staff.tokens.owner })).status, 200);
    }
  });
  test('audit-log filters by action prefix', async () => {
    const r = await app.request('GET', '/api/system/audit-log?action=fuel_grade.&limit=5', { token: staff.tokens.owner });
    assert.ok(r.body.rows.length >= 1 && r.body.rows.every(x => x.action.startsWith('fuel_grade.')));
  });
  test('schema-status shows all migrations applied', async () => {
    const r = await app.request('GET', '/api/system/schema-status', { token: staff.tokens.owner });
    assert.equal(r.body.pending.length, 0);
    assert.equal(r.body.current_version, r.body.latest_version);
  });
});
