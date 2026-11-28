// Suppliers rebuild (decision 2026-11-28): unique names, what they supply,
// TPIN/bank/terms, Active/Inactive, and a statement whose closing balance is
// the Account Payables figure.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel } = require('./helpers/fixtures');
const businessTime = require('../config/businessTime');

let app, staff, fuel, engen;
const T = () => staff.tokens.owner;
const today = () => businessTime.businessDate();
const req = (m, url, body) => app.request(m, url, { token: T(), body });
const ok = (r, what) => { assert.ok(r.status < 300, `${what}: ${r.status} ${r.text}`); return r.body; };

before(async () => {
  app = await startApp(); staff = await seedStaff(app); fuel = await seedFuel(app, T());
});
after(async () => { await app.close(); });

test('migration 18 adds supplies, bank and terms', () => {
  const cols = app.db.prepare('PRAGMA table_info(suppliers)').all().map((c) => c.name);
  for (const c of ['supplies', 'tpin', 'bank_name', 'bank_account', 'payment_terms']) assert.ok(cols.includes(c), c);
});

test('a supplier keeps what it supplies, TPIN, bank and terms; names are unique', async () => {
  engen = ok(await req('POST', '/api/suppliers', { name: 'Engen Zambia', supplies: 'fuel', tpin: '1001234567', bank_name: 'Zanaco', bank_account: '0123', payment_terms: '30 days' }), 'create');
  assert.equal(engen.supplies, 'fuel');
  assert.equal(engen.payment_terms, '30 days');
  assert.equal(engen.status, 'Active');
  const dup = await req('POST', '/api/suppliers', { name: '  engen zambia ' });
  assert.equal(dup.status, 409);
  assert.equal((await req('POST', '/api/suppliers', { name: '' })).status, 400);
  assert.equal((await req('POST', '/api/suppliers', { name: 'Odd', supplies: 'cars' })).status, 400);
  assert.equal((await req('POST', '/api/suppliers', { name: 'Odd', tpin: '12' })).status, 400);
});

test('an edit that leaves fields out keeps them; status can go Inactive', async () => {
  const r = ok(await req('PUT', `/api/suppliers/${engen.id}`, { status: 'Inactive' }), 'deactivate');
  assert.equal(r.status, 'Inactive');
  assert.equal(r.name, 'Engen Zambia');
  assert.equal(r.tpin, '1001234567');
  assert.equal(r.supplies, 'fuel');
  ok(await req('PUT', `/api/suppliers/${engen.id}`, { status: 'Active' }), 'reactivate');
});

test('statement: delivery owed, 1Card offset paid, running balance = Account Payables', async () => {
  ok(await req('POST', '/api/fuel-deliveries', { supplier_id: engen.id, tank_id: fuel.t1.id, delivery_date: today(), litres_delivered: 10000, cost_per_litre: 20, invoice_number: 'ENG-1' }), 'delivery');
  const shift = ok(await req('POST', '/api/attendant-shifts/open', { attendant_user_id: staff.users.att1.id, nozzle_ids: [fuel.n1.id], shift_type: 'DAY' }), 'shift');
  ok(await req('POST', `/api/attendant-shifts/${shift.id}/credit-sales`, { payment_method: '1Card', supplier_id: engen.id, customer_name: 'Truck BAD 1234', card_number: '7788', fuel_grade_id: fuel.petrol.id, litres: 100, price_per_litre: 25 }), '1Card');

  const st = ok(await req('GET', `/api/suppliers/${engen.id}/statement`), 'statement');
  assert.deepEqual(st.lines.map((l) => l.kind), ['fuel', 'offset']);
  assert.equal(st.lines[0].owed, 200000);
  assert.equal(st.lines[0].balance, 200000);
  assert.equal(st.lines[1].paid, 2500);
  assert.equal(st.closing, 197500);
  const ap = ok(await req('GET', '/api/account-payables'), 'ap').find((r) => r.id === engen.id);
  assert.equal(st.closing, ap.balance);

  // A range after today has the whole history as its opening balance.
  const later = ok(await req('GET', `/api/suppliers/${engen.id}/statement?from=2999-01-01`), 'later');
  assert.equal(later.opening, 197500);
  assert.equal(later.lines.length, 0);
  assert.equal(later.closing, 197500);
});

test('a supplier with fuel deliveries cannot be deleted (mark it inactive instead)', async () => {
  const r = await req('DELETE', `/api/suppliers/${engen.id}`);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Inactive/);
});
