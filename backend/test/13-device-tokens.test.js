// S1 stages 2/3 — per-till sync tokens. A real till and VPS in two processes,
// throwaway databases, invented tenant and licence.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startPair } = require('./helpers/syncPair');

let pair, vps, till;
const tillToken = async () => (await till.sql("SELECT value FROM sync_config WHERE key = 'device_token'"))[0]?.value || '';
const tillDevice = async () => (await till.sql("SELECT value FROM sync_config WHERE key = 'device_id'"))[0].value;
const devices = async () => (await vps.api('GET', '/api/system/sync-devices')).body.devices;
const rawPull = (tenantId, token) => fetch(`${vps.base}/api/sync/pull?tenantId=${encodeURIComponent(tenantId)}&since=1970-01-01T00:00:00.000Z`,
  { headers: token ? { 'X-Device-Token': token } : {} });

before(async () => {
  pair = await startPair({ tenant: 'T-DEVICE' });
  ({ vps, till } = pair);
});
after(async () => { if (pair) await pair.stop(); });

describe('stage 2 (default): tills link themselves; nothing stops working', () => {
  test('a till installed before tokens existed gets its own token on its next sync', async () => {
    assert.equal(await tillToken(), '');
    await pair.syncNow();
    const t = await tillToken();
    assert.match(t, /^kdt_/);
    const d = (await devices())[0];
    assert.equal(d.tenant_id, 'T-DEVICE');
    assert.equal(d.device_id, await tillDevice());
    assert.equal(d.issued_via, 'auto-enrol');
    const stored = await vps.sql('SELECT token_hash FROM sync_device_tokens');
    assert.ok(stored.every(r => r.token_hash !== t && r.token_hash.length === 64), 'only a hash is stored');
  });
  test('later syncs carry the token (last seen is recorded)', async () => {
    await pair.syncNow();
    const d = (await devices())[0];
    assert.ok(d.last_seen_at, 'last_seen_at set');
  });
  test('the same till id cannot be enrolled a second time (no impersonation of a linked till)', async () => {
    const r = await fetch(`${vps.base}/api/sync/device-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'T-DEVICE', branchId: 'B-TILL', deviceId: await tillDevice() }) });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).code, 'ALREADY_ENROLLED');
  });
  test('an account this server does not serve cannot enrol', async () => {
    const r = await fetch(`${vps.base}/api/sync/device-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'SOMEONE-ELSE', deviceId: 'x' }) });
    assert.equal(r.status, 403);
  });
  test('a valid token only opens its own account', async () => {
    const r = await rawPull('ANOTHER-TENANT', await tillToken());
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'DEVICE_WRONG_TENANT');
    assert.equal((await rawPull('T-DEVICE', await tillToken())).status, 200);
  });
  test('a made-up token is refused by require mode and makes a till re-link in stage 2', async () => {
    const r = await rawPull('T-DEVICE', 'kdt_made-up');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-device-token-status'), 'unknown');
  });
  test('if the server forgets the till (e.g. database restored), the till links itself again', async () => {
    await vps.sql('DELETE FROM sync_device_tokens');
    await pair.syncNow();                 // told "unknown" → forgets its token
    assert.equal(await tillToken(), '');
    await pair.syncNow();                 // enrols again
    assert.match(await tillToken(), /^kdt_/);
    assert.equal((await devices()).length, 1);
  });
});

describe('stage 3 (KELETE_SYNC_AUTH=require)', () => {
  before(async () => { await vps.env({ KELETE_SYNC_AUTH: 'require' }); });
  after(async () => { await vps.env({ KELETE_SYNC_AUTH: null }); });

  test('without a token, push and pull are refused — no data, no password hashes', async () => {
    const r = await rawPull('T-DEVICE');
    assert.equal(r.status, 401);
    assert.equal((await r.json()).code, 'DEVICE_TOKEN_REQUIRED');
    const p = await fetch(`${vps.base}/api/sync/push`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'T-DEVICE', records: { customers: [] } }) });
    assert.equal(p.status, 401);
    assert.equal((await rawPull('T-DEVICE', 'kdt_made-up')).status, 401);
  });
  test('the linked till keeps syncing normally', async () => {
    const c = await till.api('POST', '/api/customers', { body: { name: 'Stage3 Haulage', type: 'Credit', phone: '', email: '', address: '', tpin: '', credit_limit: 0, payment_terms_days: 30, credit_status: 'Active' } });
    assert.ok(c.status < 300, c.text);
    await pair.syncNow();
    assert.equal((await vps.sql("SELECT COUNT(*) AS n FROM customers WHERE name = 'Stage3 Haulage'"))[0].n, 1);
  });
  test('automatic enrolment is closed; linking needs the licence key (register / join-branch)', async () => {
    const r = await fetch(`${vps.base}/api/sync/device-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId: 'T-DEVICE', deviceId: 'new-pc' }) });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'ENROLMENT_CLOSED');
  });
  test('register (licence key checked) issues a working token', async () => {
    await vps.sql("INSERT INTO tenants (slug, business_name, email) VALUES ('acme', 'Acme Fuels', 'acme@example.test')", [], 'master');
    await vps.sql("INSERT INTO licenses (key, max_branches, expires_at, is_active) VALUES ('KELETE-TEST-0001', 5, '2099-01-01', 1)", [], 'master');
    const r = await fetch(`${vps.base}/api/sync/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant': 'acme' },
      body: JSON.stringify({ branchName: 'Acme North', licenseKey: 'KELETE-TEST-0001', deviceId: 'acme-till-1' }) });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.match(body.deviceToken, /^kdt_/);
    assert.equal((await rawPull(body.tenantId, body.deviceToken)).status, 200);
    assert.equal((await rawPull('T-DEVICE', body.deviceToken)).status, 403, 'not valid for another account');
    const bad = await fetch(`${vps.base}/api/sync/register`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tenant': 'acme' },
      body: JSON.stringify({ branchName: 'X', licenseKey: 'KELETE-WRONG' }) });
    assert.equal(bad.status, 403);
  });
  test('an administrator revokes one till: it is cut off at once', async () => {
    const mine = (await devices()).find(d => d.tenant_id === 'T-DEVICE' && !d.revoked_at);
    const rv = await vps.api('POST', `/api/system/sync-devices/${mine.id}/revoke`);
    assert.equal(rv.status, 200);
    await assert.rejects(pair.syncNow(), /revoked/i);
    assert.equal((await rawPull('T-DEVICE', await tillToken())).status, 401);
  });
});

describe('device list is for administrators only', () => {
  test('the till list and revoke are Administrator-only', async () => {
    const r = await fetch(`${vps.base}/api/system/sync-devices`);
    assert.equal(r.status, 401);
  });
});
