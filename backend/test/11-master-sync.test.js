// Sync fix (master) — /api/sync/master/push and equal timestamps.
// Throwaway master.db in this test's temporary folder.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { startApp } = require('./helpers/app');

let app, master;
const SLUG = 'branch-a';
const T0 = '2026-11-18 10:00:00.123';

function deposit(over = {}) {
  return { deposit_number: 'DEP-1', from_slug: SLUG, from_name: 'Branch A', currency: 'K', amount: 500, amount_usd: 0, status: 'PENDING', ...over };
}
async function push(row) {
  const r = await app.request('POST', '/api/sync/master/push', { body: { slug: SLUG, records: { cash_deposits: [row] } } });
  assert.equal(r.status, 200, r.text);
  return r.body.rejected;
}
const current = (syncId) => master.prepare('SELECT amount, notes, updated_at FROM cash_deposits WHERE sync_id = ?').get(syncId);

let syncId;
before(async () => {
  app = await startApp();
  master = require('../config/masterDb').masterDb;
  syncId = randomUUID();
  const d = deposit();
  master.prepare(`INSERT INTO cash_deposits (deposit_number, sync_id, from_slug, from_name, currency, amount, amount_usd, status, updated_at, synced)
                  VALUES (?,?,?,?,?,?,?,?,?,1)`).run(d.deposit_number, syncId, d.from_slug, d.from_name, d.currency, d.amount, d.amount_usd, d.status, T0);
});
after(async () => { await app.close(); });

test('an older change is rejected as stale and says what the server has', async () => {
  const rej = await push({ ...deposit({ amount: 1 }), sync_id: syncId, updated_at: '2026-11-18 09:59:59.000' });
  assert.equal(rej.length, 1);
  assert.equal(rej[0].reason, 'stale-timestamp');
  assert.equal(rej[0].server_updated_at, T0);
  assert.equal(current(syncId).amount, 500);
});

test('the same version again (equal timestamp, same content) is a quiet no-op', async () => {
  const rej = await push({ ...deposit(), sync_id: syncId, updated_at: T0 });
  assert.deepEqual(rej, []);
  assert.equal(current(syncId).amount, 500);
});

test('a DIFFERENT change with the same timestamp is no longer silently dropped: reported as same_second', async () => {
  const rej = await push({ ...deposit({ notes: 'counted twice' }), sync_id: syncId, updated_at: T0 });
  assert.equal(rej.length, 1);
  assert.equal(rej[0].reason, 'same_second');
  assert.equal(rej[0].server_updated_at, T0);
  assert.equal(current(syncId).notes, null, 'not applied blindly');
});

test('re-sent with a later timestamp, the change is applied', async () => {
  const rej = await push({ ...deposit({ notes: 'counted twice' }), sync_id: syncId, updated_at: '2026-11-18 10:00:00.124' });
  assert.deepEqual(rej, []);
  assert.equal(current(syncId).notes, 'counted twice');
});

test('another branch still cannot write this branch\'s deposit', async () => {
  const r = await app.request('POST', '/api/sync/master/push', { body: { slug: 'branch-b', records: { cash_deposits: [{ ...deposit({ amount: 9 }), sync_id: syncId, updated_at: '2026-11-19 00:00:00.000' }] } } });
  assert.equal(r.body.rejected[0].reason, 'scope-mismatch');
  assert.equal(current(syncId).amount, 500);
});

// A real till and VPS (two processes): the till's master push and pull.
const { startPair } = require('./helpers/syncPair');
describe('till ↔ VPS: a same-timestamp change made on the till is not lost', () => {
  let pair;
  const S = randomUUID();
  const TS = '2026-11-18 10:00:00.500';
  before(async () => {
    pair = await startPair({ tenant: 'T-MASTER-TIE' });
    await pair.vps.sql("INSERT INTO branches (tenant_id, branch_id, branch_name, slug) VALUES ('T-MASTER-TIE', 'B-TILL', 'Till branch', 'till-branch')", [], 'master');
    const ins = `INSERT INTO cash_deposits (deposit_number, sync_id, from_slug, currency, amount, amount_usd, status, notes, updated_at, synced)
                 VALUES ('DEP-T', ?, 'till-branch', 'K', 100, 0, 'PENDING', ?, ?, ?)`;
    await pair.vps.sql(ins, [S, 'edited at HQ', TS, 1], 'master');
    await pair.till.sql(ins, [S, 'edited on the till', TS, 0], 'master');
  });
  after(async () => { if (pair) await pair.stop(); });
  const row = async (node) => (await node.sql('SELECT notes, updated_at, synced FROM cash_deposits WHERE sync_id = ?', [S], 'master'))[0];

  test('first cycle: no sync error; the till keeps its change pending with a timestamp just after the server\'s', async () => {
    await pair.syncNow(); // the old till code threw "server refused" here every cycle
    const t = await row(pair.till);
    assert.equal(t.notes, 'edited on the till', 'not overwritten by the pull');
    assert.equal(t.synced, 0);
    assert.equal(t.updated_at, '2026-11-18 10:00:00.501');
    assert.equal((await row(pair.vps)).notes, 'edited at HQ');
  });
  test('next cycle: the till\'s change reaches the VPS and both sides agree', async () => {
    await pair.syncNow();
    const v = await row(pair.vps);
    const t = await row(pair.till);
    assert.equal(v.notes, 'edited on the till');
    assert.equal(t.synced, 1);
    assert.equal(v.updated_at, t.updated_at);
  });
});
