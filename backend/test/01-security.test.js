// D5 Suite 1 — security regressions for S1–S3.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { startApp } = require('./helpers/app');
const { createUser, login, seedStaff, PASSWORD } = require('./helpers/fixtures');

let app, staff;
before(async () => { app = await startApp(); staff = await seedStaff(app); });
after(async () => { await app.close(); });

describe('S1 — nginx block for destructive sync endpoints', () => {
  const conf = fs.readFileSync(path.join(__dirname, '../../vps/nginx-snippets/kelete-block-sync-admin.conf'), 'utf8');
  const m = conf.match(/location\s+~\*\s+(\S+)\s*\{/);
  const re = new RegExp(m[1], 'i');
  const blocked = ['wipe-tenant', 'factory-reset', 'clear-pending', 'force-resync', 'reset', 'configure', 'run-now', 'lan-config', 'lan-status'];
  test('rule is case-insensitive (~*)', () => assert.ok(m, 'location ~* rule present'));
  for (const p of blocked) {
    test(`blocks /api/sync/${p} in any letter case`, () => {
      assert.ok(re.test(`/api/sync/${p}`));
      assert.ok(re.test(`/api/sync/${p.toUpperCase()}`));
      assert.ok(re.test(`/api/sync/${p}/`));
    });
  }
  for (const p of ['push', 'pull', 'master/pull', 'master/push', 'register', 'status', 'current-status', 'resetx']) {
    test(`does NOT block /api/sync/${p} (tills depend on it)`, () => assert.ok(!re.test(`/api/sync/${p}`)));
  }
});

describe('S2 — login', () => {
  test('correct password logs in', async () => {
    const r = await app.request('POST', '/api/auth/login', { body: { email: 'cashier', password: PASSWORD } });
    assert.equal(r.status, 200);
    assert.ok(r.body.token);
  });
  test('wrong password is refused', async () => {
    const r = await app.request('POST', '/api/auth/login', { body: { email: 'cashier', password: 'nope' } });
    assert.equal(r.status, 401);
  });
  test('inactive account is refused even with the right password', async () => {
    await createUser(app.db, { email: 'gone', status: 'Inactive' });
    const r = await app.request('POST', '/api/auth/login', { body: { email: 'gone', password: PASSWORD } });
    assert.equal(r.status, 403);
  });
  test('inactive account with WRONG password gets the generic error (no hint the user exists)', async () => {
    const r = await app.request('POST', '/api/auth/login', { body: { email: 'gone', password: 'nope' } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, 'Invalid credentials');
  });
  test('10 failures lock the account; the right password is then refused until the lock expires', async () => {
    await createUser(app.db, { email: 'target' });
    for (let i = 0; i < 10; i++) await app.request('POST', '/api/auth/login', { body: { email: 'target', password: 'x' } });
    const r = await app.request('POST', '/api/auth/login', { body: { email: 'target', password: PASSWORD } });
    assert.equal(r.status, 429);
  });
  test('lockout is per account — other users unaffected', async () => {
    const r = await app.request('POST', '/api/auth/login', { body: { email: 'supervisor', password: PASSWORD } });
    assert.equal(r.status, 200);
  });
});

describe('S2 — user management is administrator-only', () => {
  test('a cashier cannot promote themselves to Administrator', async () => {
    const me = staff.users.cashier;
    const r = await app.request('PUT', `/api/users/${me.id}`, { token: staff.tokens.cashier,
      body: { firstName: 'x', lastName: 'y', email: me.email, phone: '', role: 'Administrator', status: 'Active' } });
    assert.equal(r.status, 403);
    assert.equal(app.db.prepare('SELECT role FROM users WHERE id = ?').get(me.id).role, 'Cashier');
  });
  test("a cashier cannot change another user's password", async () => {
    const r = await app.request('PUT', `/api/users/${staff.users.owner.id}`, { token: staff.tokens.cashier,
      body: { firstName: 'O', lastName: 'W', email: 'owner', role: 'Administrator', status: 'Active', password: 'hijack' } });
    assert.equal(r.status, 403);
    assert.ok(await login(app, 'owner')); // original password still works
  });
  test('an administrator can edit a user', async () => {
    const u = staff.users.supervisor;
    const r = await app.request('PUT', `/api/users/${u.id}`, { token: staff.tokens.owner,
      body: { firstName: 'Super', lastName: 'Visor', email: u.email, phone: '0977', role: 'Manager', status: 'Active' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.first_name, 'Super');
  });
  test('the last active Administrator cannot be demoted', async () => {
    const o = staff.users.owner;
    const r = await app.request('PUT', `/api/users/${o.id}`, { token: staff.tokens.owner,
      body: { firstName: 'O', lastName: 'W', email: 'owner', role: 'Cashier', status: 'Active' } });
    assert.equal(r.status, 409);
  });
  test('the last active Administrator cannot be deactivated or deleted', async () => {
    const o = staff.users.owner;
    let r = await app.request('PUT', `/api/users/${o.id}`, { token: staff.tokens.owner,
      body: { firstName: 'O', lastName: 'W', email: 'owner', role: 'Administrator', status: 'Inactive' } });
    assert.equal(r.status, 409);
    r = await app.request('DELETE', `/api/users/${o.id}`, { token: staff.tokens.owner });
    assert.equal(r.status, 409);
  });
  test('a demoted admin loses admin rights immediately, even with an unexpired token', async () => {
    const second = await createUser(app.db, { email: 'admin2', role: 'Administrator' });
    const t2 = await login(app, 'admin2');
    app.db.prepare("UPDATE users SET role = 'Cashier' WHERE id = ?").run(second.id);
    const r = await app.request('DELETE', `/api/users/${staff.users.att2.id}`, { token: t2 });
    assert.equal(r.status, 403);
  });
});

describe('S2 — inline admin-password check', () => {
  test('refused without a login', async () => {
    const r = await app.request('POST', '/api/auth/verify-admin', { body: { password: PASSWORD } });
    assert.equal(r.status, 401);
  });
  test('accepts an active administrator password for a logged-in caller', async () => {
    const r = await app.request('POST', '/api/auth/verify-admin', { token: staff.tokens.cashier, body: { password: PASSWORD } });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
  });
  test('locks the caller after 10 wrong passwords', async () => {
    for (let i = 0; i < 10; i++) await app.request('POST', '/api/auth/verify-admin', { token: staff.tokens.att1, body: { password: 'guess' + i } });
    const r = await app.request('POST', '/api/auth/verify-admin', { token: staff.tokens.att1, body: { password: PASSWORD } });
    assert.equal(r.status, 429);
  });
});

describe('Security fix — /api/auth/register needs an Administrator', () => {
  const body = (email, role) => ({ firstName: 'X', lastName: 'Y', email, password: 'Intruder-Pass-1', phone: '', role });
  test('without a login: refused, no account created, nothing to log in with', async () => {
    const r = await app.request('POST', '/api/auth/register', { body: body('anon-admin', 'Administrator') });
    assert.equal(r.status, 401);
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'anon-admin'").get().n, 0);
    assert.equal((await app.request('POST', '/api/auth/login', { body: { email: 'anon-admin', password: 'Intruder-Pass-1' } })).status, 401);
  });
  test('a cashier or supervisor cannot use it either', async () => {
    for (const who of ['cashier', 'supervisor']) {
      const r = await app.request('POST', '/api/auth/register', { token: staff.tokens[who], body: body(`via-${who}`, 'Administrator') });
      assert.equal(r.status, 403, who);
    }
    assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE 'via-%'").get().n, 0);
  });
  test('an Administrator still can', async () => {
    const r = await app.request('POST', '/api/auth/register', { token: staff.tokens.owner, body: body('added-by-admin', 'Cashier') });
    assert.equal(r.status, 201, r.text);
  });
});

describe('S2 — first-time registration', () => {
  test('refused when accounts exist, and deletes nothing', async () => {
    app.db.prepare(`INSERT INTO users (first_name,last_name,email,password,role) VALUES ('d','a','admin','x','Administrator')`).run();
    const r = await app.request('POST', '/api/auth/register-first', { body: { firstName: 'a', lastName: 'b', email: 'evil', password: 'x' } });
    assert.equal(r.status, 403);
    assert.ok(app.db.prepare("SELECT 1 FROM users WHERE email = 'admin' AND deleted_at IS NULL").get(), 'default admin row still present');
  });
});

describe('S3 — signing secret', () => {
  test('a token forged with the old public fallback secret is rejected', async () => {
    const forged = jwt.sign({ id: staff.users.owner.id, email: 'owner', role: 'Administrator', tenantId: 'local-only' }, 'kelete-pro-secret-key-2026', { expiresIn: '1h' });
    const r = await app.request('GET', '/api/users', { token: forged });
    assert.equal(r.status, 401);
  });
  test('the HQ routes reject the forged token too', async () => {
    const forged = jwt.sign({ id: 1, role: 'Administrator' }, 'kelete-pro-secret-key-2026', { expiresIn: '1h' });
    const r = await app.request('GET', '/api/hq/purchases', { token: forged });
    assert.equal(r.status, 401);
  });
  test('secrets module: refuses public placeholder, refuses missing secret off-till', () => {
    const modPath = require.resolve('../config/secrets');
    const saved = { JWT_SECRET: process.env.JWT_SECRET, ELECTRON_USER_DATA: process.env.ELECTRON_USER_DATA };
    try {
      delete require.cache[modPath];
      process.env.JWT_SECRET = 'kelete-pro-secret-key-2026';
      assert.throws(() => require(modPath).getJwtSecret(), /placeholder/);
      delete require.cache[modPath];
      delete process.env.JWT_SECRET; delete process.env.ELECTRON_USER_DATA;
      assert.throws(() => require(modPath).getJwtSecret(), /not set/);
    } finally {
      Object.assign(process.env, saved);
      delete require.cache[modPath];
    }
  });
  test('licence admin panel: wrong password refused, correct accepted', async () => {
    let r = await app.request('POST', '/admin/login', { body: { password: 'admin-change-me' } });
    assert.equal(r.status, 401);
    r = await app.request('POST', '/admin/login', { body: { password: process.env.ADMIN_PASSWORD } });
    assert.equal(r.status, 200);
  });
});

describe('S7 — database backups are Administrator-only', () => {
  // A fake nightly backup folder inside this test's own temporary folder.
  before(() => {
    const d = path.join(process.env.KELETE_BACKUP_DIR, '2026-11-18');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'kelete.db'), 'not a real database');
  });
  for (const who of ['cashier', 'supervisor', 'att1']) {
    test(`${who} cannot list, create or download backups`, async () => {
      const t = staff.tokens[who];
      assert.equal((await app.request('GET', '/api/system/backups', { token: t })).status, 403);
      assert.equal((await app.request('POST', '/api/system/backup', { token: t })).status, 403);
      assert.equal((await app.request('GET', '/api/system/backups/2026-11-18/download', { token: t })).status, 403);
    });
  }
  test('without a login, backups are refused', async () => {
    assert.equal((await app.request('GET', '/api/system/backups/2026-11-18/download')).status, 401);
  });
  test('an Administrator can list and download a backup', async () => {
    const list = await app.request('GET', '/api/system/backups', { token: staff.tokens.owner });
    assert.equal(list.status, 200);
    assert.ok(list.body.backups.some(b => b.name === '2026-11-18'));
    const res = await fetch(`${app.base}/api/system/backups/2026-11-18/download`, { headers: { Authorization: `Bearer ${staff.tokens.owner}` } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/gzip');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(bytes[0], 0x1f); assert.equal(bytes[1], 0x8b); // gzip signature
  });
  test('a demoted Administrator loses backup access immediately', async () => {
    await createUser(app.db, { email: 'exadmin', role: 'Administrator' });
    const t = await login(app, 'exadmin');
    app.db.prepare("UPDATE users SET role = 'Cashier' WHERE email = 'exadmin'").run();
    assert.equal((await app.request('GET', '/api/system/backups', { token: t })).status, 403);
  });
});
