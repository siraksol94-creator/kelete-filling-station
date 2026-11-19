// F1 — a till on the new version syncing with a VPS that does not take fuel
// rows (an older VPS after a rollback, or KELETE_FUEL_SYNC=off there). Such a
// VPS skips the fuel tables without saying so; the till must keep its fuel
// records pending instead of marking them sent. Two processes, throwaway data.
const { setupEnv, makeTempDir } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startPair } = require('./helpers/syncPair');

let pair, vps, till;
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };
const one = async (node, sql, params = []) => (await node.sql(sql, params))[0];
const syncLog = async () => (await till.api('GET', '/__test/synclog')).text;

before(async () => {
  // the till gets its own temp folder, so its sync log holds only its own lines
  pair = await startPair({ tenant: 'T-OLDVPS', vpsEnv: { KELETE_FUEL_SYNC: 'off' }, tillEnv: { TMPDIR: makeTempDir('kelete-oldvps-till') } });
  ({ vps, till } = pair);
  ok(await till.api('POST', '/api/fuel-grades', { body: { code: 'OULP', name: 'Petrol', selling_price: 25, cost_price: 20 } }), 'grade');
  ok(await till.api('POST', '/api/customers', { body: { name: 'Old VPS Haulage', type: 'Credit', phone: '', email: '', address: '', tpin: '', credit_limit: 0, payment_terms_days: 30, credit_status: 'Active' } }), 'customer');
  await pair.syncNow();
});
after(async () => { if (pair) await pair.stop(); });

test('the VPS did not store the fuel row, and the till keeps it pending (not marked sent)', async () => {
  assert.equal((await one(vps, "SELECT COUNT(*) AS n FROM fuel_grades WHERE code = 'OULP'")).n, 0);
  assert.equal((await one(till, "SELECT synced FROM fuel_grades WHERE code = 'OULP'")).synced, 0);
});

test('everything else syncs as normal', async () => {
  assert.equal((await one(vps, "SELECT COUNT(*) AS n FROM customers WHERE name = 'Old VPS Haulage'")).n, 1);
  assert.equal((await one(till, "SELECT synced FROM customers WHERE name = 'Old VPS Haulage'")).synced, 1);
});

test('the till says why, and does not re-send its fuel history every cycle', async () => {
  const log1 = await syncLog();
  assert.match(log1, /did not take fuel rows/);
  const sendsBefore = (log1.match(/push: sending .*fuel_grades/g) || []).length;
  assert.equal(sendsBefore, 1, 'sent once');
  ok(await till.api('POST', '/api/customers', { body: { name: 'Second Customer', type: 'Credit', phone: '', email: '', address: '', tpin: '', credit_limit: 0, payment_terms_days: 30, credit_status: 'Active' } }), 'customer 2');
  await pair.syncNow();
  const log2 = await syncLog();
  assert.ok((log2.match(/push: sending /g) || []).length > (log1.match(/push: sending /g) || []).length, 'a second push happened');
  assert.equal((log2.match(/push: sending .*fuel_grades/g) || []).length, sendsBefore, 'fuel not re-sent within the hour');
  assert.equal((await one(vps, "SELECT COUNT(*) AS n FROM customers WHERE name = 'Second Customer'")).n, 1);
  assert.equal((await one(till, "SELECT synced FROM fuel_grades WHERE code = 'OULP'")).synced, 0, 'still pending for when the VPS takes fuel again');
});
