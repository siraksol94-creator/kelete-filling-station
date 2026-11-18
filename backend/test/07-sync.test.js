// D5 Suite 6 — sync round-trips between a real till process and a real VPS
// process, each with its own throwaway databases, over loopback only.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startPair } = require('./helpers/syncPair');
const { knownDefect } = require('./helpers/knownDefect');

let pair, vps, till;
before(async () => { pair = await startPair(); ({ vps, till } = pair); await pair.syncNow(); });
after(async () => { if (pair) await pair.stop(); });

const customer = (who, name) => who.api('POST', '/api/customers', { body: { name, type: 'Credit', phone: '', email: '', address: '', tpin: '', credit_limit: 0, payment_terms_days: 0, credit_status: 'Active' } });
const findBy = async (who, table, syncId) => (await who.sql(`SELECT * FROM ${table} WHERE sync_id = ?`, [syncId]))[0];

test('till → VPS: a record created on the till arrives on the VPS with the same identity', async () => {
  const c = (await customer(till, 'Till Customer')).body;
  await pair.syncNow();
  const onVps = await findBy(vps, 'customers', c.sync_id);
  assert.ok(onVps, 'customer reached the VPS');
  assert.equal(onVps.name, 'Till Customer');
  assert.equal(onVps.tenant_id, pair.tenant);
});

test('VPS → till: a record created on the VPS arrives on the till', async () => {
  const c = (await customer(vps, 'Head Office Customer')).body;
  await pair.syncNow();
  assert.ok(await findBy(till, 'customers', c.sync_id));
});

test('a deletion on the till reaches the VPS', async () => {
  const c = (await customer(till, 'To Be Removed')).body;
  await pair.syncNow();
  await new Promise((r) => setTimeout(r, 1100)); // see the same-second defect below
  const d = await till.api('DELETE', `/api/customers/${c.id}`);
  assert.ok(d.status < 300, d.text);
  await pair.syncNow();
  assert.ok((await findBy(vps, 'customers', c.sync_id)).deleted_at, 'soft-deleted on the VPS too');
});

knownDefect('Sync (new)', 'a change made within the same second as the last sync is rejected by the VPS AND marked synced on the till — lost for good', async () => {
  const c = (await customer(till, 'Quick Change')).body;
  await pair.syncNow();
  await till.api('DELETE', `/api/customers/${c.id}`);      // same second as the synced version
  await pair.syncNow(); await pair.syncNow();
  const t = (await till.sql('SELECT deleted_at, synced FROM customers WHERE id = ?', [c.id]))[0];
  const v = await findBy(vps, 'customers', c.sync_id);
  if (v.deleted_at) return; // the clock crossed a second boundary in between — not reproducible this run
  assert.ok(t.deleted_at, 'deleted on the till');
  assert.equal(t.synced, 1, 'TODAY: the till believes the deletion was delivered');
  assert.equal(v.deleted_at, null, 'TODAY: the VPS still has the customer as active, and nothing will retry');
});

test('document numbers created on both sides never collide, and both copies end up on both sides', async () => {
  const body = { paid_to: 'Supplier', description: 'test', category: 'General', amount: 10, date: '2026-11-18', paid_from: 'Main cashier', cash_amount: 10, bank_amount: 0, momo_amount: 0 };
  const a = (await till.api('POST', '/api/payment-vouchers', { body })).body;
  const b = (await vps.api('POST', '/api/payment-vouchers', { body })).body;
  assert.ok(a.voucher_number && b.voucher_number, 'both created');
  assert.notEqual(a.voucher_number, b.voucher_number, 'numbers carry the device code');
  await pair.syncNow();
  for (const side of [till, vps]) {
    const nums = (await side.sql('SELECT voucher_number FROM payment_vouchers')).map(r => r.voucher_number);
    assert.ok(nums.includes(a.voucher_number) && nums.includes(b.voucher_number), `${side.role} has both vouchers`);
  }
});

test('current behaviour: when both sides edit the same record, the later edit wins everywhere (whole row)', async () => {
  const c = (await customer(till, 'Shared Customer')).body;
  await pair.syncNow();
  const onVps = await findBy(vps, 'customers', c.sync_id);
  await vps.sql("UPDATE customers SET phone = 'VPS-EDIT', updated_at = '2030-01-01 00:00:01', synced = 0 WHERE id = ?", [onVps.id]);
  await till.sql("UPDATE customers SET address = 'TILL-EDIT', updated_at = '2030-01-01 00:00:00', synced = 0 WHERE id = ?", [c.id]);
  await pair.syncNow();
  const t = await findBy(till, 'customers', c.sync_id);
  const v = await findBy(vps, 'customers', c.sync_id);
  assert.equal(v.phone, 'VPS-EDIT', 'the newer VPS edit is kept on the VPS');
  assert.equal(t.phone, 'VPS-EDIT', 'and reaches the till');
  assert.notEqual(v.address, 'TILL-EDIT', 'the older till edit to a DIFFERENT field is lost (whole-row last-writer-wins)');
});

knownDefect('F1', 'fuel data entered on a till never reaches the VPS', async () => {
  const g = await till.api('POST', '/api/fuel-grades', { body: { code: 'ULP', name: 'Petrol', selling_price: 25, cost_price: 20 } });
  assert.equal(g.status, 201, g.text);
  await pair.syncNow();
  const onVps = await vps.sql("SELECT COUNT(*) AS n FROM fuel_grades WHERE code = 'ULP'");
  assert.equal(onVps[0].n, 0, 'TODAY: fuel tables are in no sync list');
});

knownDefect('S1 stage 2', 'GET /api/sync/pull needs no login and returns users with their password hashes', async () => {
  const r = await fetch(`${vps.base}/api/sync/pull?tenantId=${encodeURIComponent(pair.tenant)}&since=1970-01-01T00:00:00.000Z`);
  assert.equal(r.status, 200, 'TODAY: no authentication (nginx S1 stage 1 does not cover pull — tills need it)');
  const body = await r.json();
  const users = (body.records || body).users || [];
  assert.ok(users.length > 0 && users.every(u => 'password' in u), 'password hashes are included');
});
