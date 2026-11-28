// Supplier ledger (services/supplierLedger.js): fuel deliveries are purchases,
// 1Card tickets offset what we owe without moving money, and Account Payables
// and Suppliers show the same balance. Throwaway databases, invented data.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel } = require('./helpers/fixtures');
const businessTime = require('../config/businessTime');

let app, staff, fuel, engen, shift, ticket;
const today = () => businessTime.businessDate();
const T = () => staff.tokens.owner;
const ok = (r, what) => { assert.ok(r.status < 300, `${what}: ${r.status} ${r.text}`); return r.body; };
const get = async (p) => ok(await app.request('GET', p, { token: T() }), p);

before(async () => {
  app = await startApp(); staff = await seedStaff(app); fuel = await seedFuel(app, T());
  engen = ok(await app.request('POST', '/api/suppliers', { token: T(), body: { name: 'Engen Zambia', type: 'Fuel', phone: '', email: '', address: '', contact_person: '' } }), 'supplier');
});
after(async () => { await app.close(); });

test('a new database has grn.cost_currency (migration 16), so Account Payables opens', async () => {
  const cols = app.db.prepare('PRAGMA table_info(grn)').all().map((c) => c.name);
  assert.ok(cols.includes('cost_currency'));
  const r = await app.request('GET', '/api/account-payables', { token: T() });
  assert.equal(r.status, 200, r.text);
});

test('a fuel delivery is a purchase from its supplier', async () => {
  ok(await app.request('POST', '/api/fuel-deliveries', { token: T(), body: {
    supplier_id: engen.id, tank_id: fuel.t1.id, delivery_date: today(), litres_delivered: 10000, cost_per_litre: 20, invoice_number: 'ENG-1' } }), 'delivery');
  const row = (await get('/api/account-payables')).find((r) => r.id === engen.id);
  assert.equal(row.fuel_purchases, 200000);
  assert.equal(row.total_purchases, 200000);
  assert.equal(row.balance, 200000);
  assert.equal(row.status, 'Unpaid');
  const br = await get(`/api/account-payables/breakdown/${engen.id}`);
  assert.equal(br.deliveries.length, 1);
  assert.equal(br.deliveries[0].total_cost, 200000);
});

test('a 1Card ticket offsets what we owe, and is not money in the Cash Book', async () => {
  shift = ok(await app.request('POST', '/api/attendant-shifts/open', { token: T(),
    body: { attendant_user_id: staff.users.att1.id, nozzle_ids: [fuel.n1.id], shift_type: 'DAY' } }), 'shift');
  ticket = ok(await app.request('POST', `/api/attendant-shifts/${shift.id}/credit-sales`, { token: T(),
    body: { payment_method: '1Card', supplier_id: engen.id, customer_name: 'Truck BAD 1234', card_number: '7788', fuel_grade_id: fuel.petrol.id, litres: 100, price_per_litre: 25 } }), '1Card');

  const row = (await get('/api/account-payables')).find((r) => r.id === engen.id);
  assert.equal(row.total_paid, 2500);
  assert.equal(row.offset_1card, 2500);
  assert.equal(row.balance, 197500);
  assert.equal(row.status, 'Partial');

  const d = today();
  const cb = await get(`/api/cash-book?from=${d}&to=${d}`);
  const rows = Array.isArray(cb) ? cb : (cb.rows || cb.entries || cb.ledger || []);
  assert.equal(rows.filter((r) => r.type === 'AP').length, 0, 'no AP row for a 1Card offset');
  const stats = await get(`/api/cash-book/stats?from=${d}&to=${d}`);
  assert.equal(stats.totalAP, 0);
  assert.equal(stats.currentBalance, 0);
});

test('Suppliers shows the same balance as Account Payables (credit notes included)', async () => {
  const sup = (await get('/api/suppliers')).find((s) => s.id === engen.id);
  assert.equal(sup.outstanding, 197500);
  assert.equal(sup.fuel_purchases, 200000);
  assert.equal(sup.offset_1card, 2500);
  const st = await get('/api/suppliers/stats');
  assert.equal(st.outstanding, 197500);
  assert.equal(st.owed, 197500);
  const ap = await get('/api/account-payables/stats');
  assert.equal(ap.outstanding, 197500);
  assert.equal(ap.offset1Card, 2500);
  assert.equal(ap.unpaidCount, 1);
});

test('a 1Card offset cannot be edited or deleted from Account Payables', async () => {
  const pay = (await get('/api/ap-payments')).find((p) => p.paid_from === '1Card');
  const del = await app.request('DELETE', `/api/ap-payments/${pay.id}`, { token: T() });
  assert.equal(del.status, 409);
  assert.equal(del.body.code, 'ONECARD_LOCKED');
  const put = await app.request('PUT', `/api/ap-payments/${pay.id}`, { token: T(), body: { amount: 1 } });
  assert.equal(put.status, 409);
});

test('deleting the 1Card ticket brings the balance back', async () => {
  ok(await app.request('DELETE', `/api/attendant-shifts/credit-sales/${ticket.id}`, { token: T() }), 'delete ticket');
  const row = (await get('/api/account-payables')).find((r) => r.id === engen.id);
  assert.equal(row.balance, 200000);
});

test('a real supplier payment still goes through the Cash Book', async () => {
  ok(await app.request('POST', '/api/ap-payments', { token: T(), body: { supplier_id: engen.id, supplier_name: 'Engen Zambia', bank_amount: 50000, date: today() } }), 'payment');
  const d = today();
  const cb = await get(`/api/cash-book?from=${d}&to=${d}`);
  const rows = Array.isArray(cb) ? cb : (cb.rows || cb.entries || cb.ledger || []);
  assert.equal(rows.filter((r) => r.type === 'AP').length, 1);
  const row = (await get('/api/account-payables')).find((r) => r.id === engen.id);
  assert.equal(row.balance, 150000);
});
