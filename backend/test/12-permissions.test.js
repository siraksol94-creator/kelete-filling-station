// S7 (full matrix) — the server applies the screens' permissions.
// Throwaway database; invented users.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { startApp } = require('./helpers/app');
const { seedStaff, createUser, login } = require('./helpers/fixtures');
const matrix = require('../config/permissionMatrix.json');

let app, staff;
const tok = {};
const denied = (r) => r.status === 403 && r.body && r.body.code === 'PERMISSION_DENIED';

before(async () => {
  app = await startApp();
  staff = await seedStaff(app);
  const users = {
    accounts:   ['Accounting'],                       // legacy one-word permission
    vouchers:   ['PaymentVoucher:View'],              // one granular screen
    storeman:   ['Stock'],                            // legacy: Items, Inventory, Categories…
    fullaccess: ['All'],
    nothing:    [],
  };
  for (const [email, permissions] of Object.entries(users)) {
    await createUser(app.db, { email, role: 'Staff', permissions });
    tok[email] = await login(app, email);
  }
});
after(async () => { await app.close(); });

describe('a cashier (POS only) can do the POS work and nothing else', () => {
  test('POS calls are allowed', async () => {
    const t = staff.tokens.cashier;
    assert.equal((await app.request('GET', '/api/products', { token: t })).status, 200);
    assert.equal((await app.request('GET', '/api/settings', { token: t })).status, 200);
    const sale = await app.request('POST', '/api/orders', { token: t, body: { items: [], payment_method: 'Cash', total_amount: 0 } });
    assert.ok(!denied(sale), 'reaches the POS sale route (which applies its own rules)');
  });
  test('accounting, user and stock-management calls are refused', async () => {
    const t = staff.tokens.cashier;
    for (const [m, p, body] of [
      ['GET', '/api/payment-vouchers'], ['POST', '/api/payment-vouchers', { amount: 1 }],
      ['GET', '/api/cash-book'], ['DELETE', '/api/products/1'], ['PUT', '/api/products/1', { name: 'x' }],
      ['GET', '/api/users/stats'], ['GET', '/api/dashboard'],
    ]) {
      const r = await app.request(m, p, { token: t, body });
      assert.ok(denied(r), `${m} ${p} → ${r.status}`);
    }
  });
  test('calls no screen makes are for administrators only', async () => {
    const r = await app.request('POST', '/api/fuel-day-approvals/2026-11-18/approve', { token: staff.tokens.cashier, body: {} });
    assert.ok(denied(r));
    assert.ok(!denied(await app.request('POST', '/api/fuel-day-approvals/2026-11-18/approve', { token: staff.tokens.owner, body: {} })));
  });
});

describe('permissions work exactly as on the screens', () => {
  test('a legacy one-word permission covers its screens (Accounting → payment vouchers, cash book)', async () => {
    assert.equal((await app.request('GET', '/api/payment-vouchers', { token: tok.accounts })).status, 200);
    assert.equal((await app.request('GET', '/api/cash-book', { token: tok.accounts })).status, 200);
    assert.ok(denied(await app.request('GET', '/api/users/stats', { token: tok.accounts })));
  });
  test('one granular screen permission opens that screen\'s calls only', async () => {
    assert.equal((await app.request('GET', '/api/payment-vouchers', { token: tok.vouchers })).status, 200);
    assert.ok(denied(await app.request('GET', '/api/capital-account', { token: tok.vouchers })));
  });
  test('Stock (legacy) reaches the Items screen calls', async () => {
    assert.ok(!denied(await app.request('PUT', '/api/products/999999', { token: tok.storeman, body: { name: 'x' } })));
    assert.ok(denied(await app.request('GET', '/api/payment-vouchers', { token: tok.storeman })));
  });
  test('a user with no permissions keeps what every logged-in user sees (menu bar, messages, fuel screens)', async () => {
    assert.equal((await app.request('GET', '/api/notifications/badges', { token: tok.nothing })).status === 403, false);
    assert.equal((await app.request('GET', '/api/fuel-grades', { token: tok.nothing })).status, 200);
    assert.ok(denied(await app.request('GET', '/api/payment-vouchers', { token: tok.nothing })));
  });
  test('Administrators and "All" users are not limited', async () => {
    for (const t of [staff.tokens.owner, tok.fullaccess]) {
      assert.equal((await app.request('GET', '/api/payment-vouchers', { token: t })).status, 200);
      assert.equal((await app.request('GET', '/api/cash-book', { token: t })).status, 200);
    }
  });
});

describe('changes take effect immediately; nothing else is disturbed', () => {
  test('removing a permission applies to a token issued before the change', async () => {
    await createUser(app.db, { email: 'temp', role: 'Staff', permissions: ['Accounting'] });
    const t = await login(app, 'temp');
    assert.equal((await app.request('GET', '/api/cash-book', { token: t })).status, 200);
    app.db.prepare("UPDATE users SET permissions = '[]' WHERE email = 'temp'").run();
    assert.ok(denied(await app.request('GET', '/api/cash-book', { token: t })));
  });
  test('a deactivated account\'s still-valid token is refused', async () => {
    await createUser(app.db, { email: 'leaver', role: 'Cashier', permissions: ['POS'] });
    const t = await login(app, 'leaver');
    assert.equal((await app.request('GET', '/api/products', { token: t })).status, 200);
    app.db.prepare("UPDATE users SET status = 'Inactive' WHERE email = 'leaver'").run();
    assert.ok(denied(await app.request('GET', '/api/products', { token: t })));
  });
  test('no login → the route\'s own 401 (unchanged); login and sync are not gated', async () => {
    assert.equal((await app.request('GET', '/api/payment-vouchers')).status, 401);
    assert.equal((await app.request('POST', '/api/auth/login', { body: { email: 'cashier', password: 'Test-Pass-123' } })).status, 200);
    assert.ok(!denied(await app.request('GET', '/api/sync/status', { token: tok.nothing })));
  });
  test('a refusal is recorded in the audit log with who asked', async () => {
    await app.request('GET', '/api/cash-book', { token: staff.tokens.cashier });
    const row = app.db.prepare("SELECT action, actor_email, status_code FROM audit_log WHERE path = '/api/cash-book' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row && row.action, 'permission.denied');
    assert.ok(row, 'audit row written');
    assert.equal(row.actor_email, 'cashier');
    assert.equal(row.status_code, 403);
  });
  test('KELETE_PERMISSIONS=log lets the request through (for a first live week) and =off disables the gate', async () => {
    try {
      process.env.KELETE_PERMISSIONS = 'log';
      assert.equal((await app.request('GET', '/api/payment-vouchers', { token: staff.tokens.cashier })).status, 200);
      process.env.KELETE_PERMISSIONS = 'off';
      assert.equal((await app.request('GET', '/api/payment-vouchers', { token: staff.tokens.cashier })).status, 200);
    } finally { delete process.env.KELETE_PERMISSIONS; }
    assert.ok(denied(await app.request('GET', '/api/payment-vouchers', { token: staff.tokens.cashier })));
  });
});

describe('the matrix', () => {
  test('is generated from the current screens (re-run ops/permissions/build-matrix.js after changing them)', () => {
    const r = spawnSync(process.execPath, [path.resolve(__dirname, '../../ops/permissions/build-matrix.js'), '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr || r.stdout);
  });
  test('maps every API call the screens make to a real server route', () => {
    assert.ok(matrix.endpoints.length > 300);
    assert.ok(Object.keys(matrix.legacy_map).length > 20);
  });
});
