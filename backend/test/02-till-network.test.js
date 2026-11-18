// D5 Suite 1 (continued) — S3 behaviour when running as an Electron till.
// Separate file = separate process, because "till mode" is fixed at load time.
const { setupEnv, localAddresses } = require('./helpers/harness');
setupEnv({ till: true });

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startApp, request } = require('./helpers/app');

// A non-loopback IPv4 address of this machine, to act as "another PC on the LAN".
const lanIp = [...localAddresses()].find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a) && !a.startsWith('127.'));

let app;
before(async () => { app = await startApp({ host: '0.0.0.0' }); });
after(async () => { await app.close(); });

test('a till generates its own signing secret on first start (never the public fallback)', () => {
  const file = path.join(process.env.ELECTRON_USER_DATA, 'jwt-secret');
  const secret = fs.readFileSync(file, 'utf8').trim();
  assert.ok(secret.length >= 64);
  assert.notEqual(secret, 'kelete-pro-secret-key-2026');
});

test('this computer (loopback) can use the API normally', async () => {
  const r = await request(`http://127.0.0.1:${app.port}`, 'GET', '/api/users');
  assert.equal(r.status, 401, 'reaches the route and asks for a login');
});

test('another machine is refused on ordinary API routes', { skip: !lanIp && 'no non-loopback interface on this machine' }, async () => {
  const r = await request(`http://${lanIp}:${app.port}`, 'GET', '/api/users');
  assert.equal(r.status, 403);
  assert.match(r.body.error, /only accepts requests from this computer/);
});

test('another machine cannot read the LAN sync key', { skip: !lanIp && 'no non-loopback interface on this machine' }, async () => {
  const r = await request(`http://${lanIp}:${app.port}`, 'GET', '/api/sync/lan-config');
  assert.equal(r.status, 403);
});

test('another machine can still reach the sync endpoints (LAN children)', { skip: !lanIp && 'no non-loopback interface on this machine' }, async () => {
  const r = await request(`http://${lanIp}:${app.port}`, 'GET', '/api/health');
  assert.equal(r.status, 200);
  const p = await request(`http://${lanIp}:${app.port}`, 'GET', '/api/sync/pull');
  assert.notEqual(p.status, 403, 'pull is not blocked by the till filter (it answers 400: tenantId required)');
});

test('the remote filter matches paths case-insensitively', { skip: !lanIp && 'no non-loopback interface on this machine' }, async () => {
  const r = await request(`http://${lanIp}:${app.port}`, 'GET', '/API/USERS');
  assert.equal(r.status, 403);
});
