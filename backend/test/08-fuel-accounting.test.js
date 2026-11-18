// D5 Suite 7 — fuel vs accounting (characterization of finding G).
// One trading day: forecourt fuel sales on a shift + a shop sale. Compares what
// the financial screens report with what the forecourt actually took.
// Priority 2 (F2, F5) must turn these known defects into passing correct tests.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel, createCustomer } = require('./helpers/fixtures');
const { knownDefect } = require('./helpers/knownDefect');

let app, db, staff, fuel, closed, posOrder, forecourtGross, shopTotal;
const T = () => staff.tokens.owner;

before(async () => {
  app = await startApp(); db = app.db; staff = await seedStaff(app);
  fuel = await seedFuel(app, T(), { petrolPrice: 25, dieselPrice: 24, opening: 10000 });
  const customer = await createCustomer(app, T());

  // Forecourt: attendant shift on the petrol nozzle.
  const shift = (await app.request('POST', '/api/attendant-shifts/open', { token: T(),
    body: { attendant_user_id: staff.users.att1.id, nozzle_ids: [fuel.n1.id], shift_type: 'DAY' } })).body;
  await app.request('POST', `/api/attendant-shifts/${shift.id}/credit-sales`, { token: T(),
    body: { payment_method: 'Credit', customer_id: customer.id, customer_name: customer.name, fuel_grade_id: fuel.petrol.id, litres: 40, price_per_litre: 25 } });
  const reading = (await app.request('GET', `/api/attendant-shifts/${shift.id}`, { token: T() })).body.readings[0];
  closed = (await app.request('POST', `/api/attendant-shifts/${shift.id}/close`, { token: T(),
    body: { readings: [{ id: reading.id, closing_reading: 101000 }], payment_cash: 24000, payment_mobile: 0, payment_swipes: 0 } })).body;
  forecourtGross = 1000 * 25; // 1,000 L petrol @ K25

  // Shop: the cashier needs their own open shift (POS gate), then sells 2 × oil @ K150.
  await app.request('POST', '/api/attendant-shifts/open', { token: T(),
    body: { attendant_user_id: staff.users.cashier.id, nozzle_ids: [fuel.n2.id], shift_type: 'DAY' } });
  const pSync = randomUUID();
  const tenantId = 'local-only';
  db.prepare("INSERT INTO products (code, name, unit, cost_price, selling_price, current_stock, sync_id, tenant_id, units_json) VALUES ('OIL1','Engine Oil 1L','pcs',100,150,0,?,?, ?)")
    .run(pSync, tenantId, JSON.stringify([{ name: 'pcs', conv: 1, price: 150, is_base: true }]));
  const pid = db.prepare('SELECT id FROM products WHERE sync_id = ?').get(pSync).id;
  db.prepare("INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, sync_id, tenant_id) VALUES (?,?,'sales','opening',10,?,?)").run(pid, pSync, randomUUID(), tenantId);
  db.prepare('UPDATE products SET current_stock = 10 WHERE id = ?').run(pid);
  shopTotal = 300;
  const r = await app.request('POST', '/api/orders', { token: staff.tokens.cashier, body: {
    customer_name: 'Walk-in', payment_method: 'Cash',
    items: [{ product_id: pid, product_sync_id: pSync, product_name: 'Engine Oil 1L', quantity: 2, unit: 'pcs', unit_price: 150, total_price: 300 }],
    subtotal: 300, tax_amount: 0, total_amount: 300, discount: 0, amount_received: 300, change_amount: 0,
    cash_received: 300, momo_received: 0, bank_received: 0 } });
  if (r.status >= 300) throw new Error(`POS sale failed: ${r.status} ${r.text}`);
  posOrder = r.body;
});
after(async () => { await app.close(); });

test('the forecourt shift itself is right: 1,000 L, K25,000 gross, credit deducted from expected cash', () => {
  assert.equal(closed.expected_cash, forecourtGross - 1000);
  assert.equal(closed.variance, 24000 - (forecourtGross - 1000));
});

test('the shop sale is tied to the cashier’s open shift and moves stock', () => {
  const o = db.prepare('SELECT shift_id FROM orders WHERE order_number = ?').get(posOrder.order_number || posOrder.orderNumber);
  assert.ok(o && o.shift_id, 'POS order carries a shift_id');
  assert.equal(db.prepare("SELECT current_stock FROM products WHERE code = 'OIL1'").get().current_stock, 8);
});

test("F5: the Dashboard's sales for today include the forecourt (closed shifts; credit counted once)", async () => {
  const d = (await app.request('GET', '/api/dashboard', { token: T() })).body;
  // shop K300 + credit ticket K1,000 (an order) + fuel K25,000 − that same K1,000 credit = K25,300
  assert.equal(d.todaySales, shopTotal + forecourtGross);
  assert.equal(d.todayFuelSales, forecourtGross - 1000);
  const todayRow = (d.salesTrend || []).find(r => r.date === require('../config/businessTime').businessDate());
  assert.ok(todayRow && todayRow.total >= shopTotal + forecourtGross && todayRow.fuel === forecourtGross - 1000, JSON.stringify(d.salesTrend));
});

test('F5: the forecourt takings are a daily receipt in the cash book (cash / mobile / swipes; not credit or 1Card)', async () => {
  const day = db.prepare('SELECT shift_date FROM attendant_shifts ORDER BY id LIMIT 1').get().shift_date;
  const cr = db.prepare("SELECT * FROM cash_receipts WHERE received_from = 'Fuel sales' AND deleted_at IS NULL").all();
  assert.equal(cr.length, 1);
  assert.equal(cr[0].date, day);
  assert.equal(cr[0].receipt_number, `FUEL-${day}`);
  assert.equal(cr[0].cash_amount, 24000);
  assert.equal(cr[0].k_amount, 24000);
  const fa = require('../services/fuelAccounting');
  const tenant = db.prepare("SELECT tenant_id FROM cash_receipts WHERE id = ?").get(cr[0].id).tenant_id;
  assert.equal(cr[0].sync_id, fa.receiptSyncId(tenant, day), 'same id on every device for that day');
  const book = (await app.request('GET', `/api/cash-book?from=${day}&to=${day}`, { token: T() })).body;
  const entries = book.entries || book.rows || book;
  assert.ok(JSON.stringify(entries).includes(`FUEL-${day}`), 'listed in the cash book');
});

test("F2: fuel credit sales now appear in the Dashboard's top products", async () => {
  const d = (await app.request('GET', '/api/dashboard', { token: T() })).body;
  const names = (d.topProducts || []).map(p => p.product_name);
  assert.ok(names.includes('Engine Oil 1L'));
  const petrol = (d.topProducts || []).find(p => p.product_name === 'Petrol');
  assert.ok(petrol, 'the credit line joins now that it has order_sync_id');
  assert.equal(petrol.revenue, 1000);
});

test('F5: fuel in the tanks is valued at weighted-average cost', async () => {
  const d = (await app.request('GET', '/api/dashboard', { token: T() })).body;
  // petrol 9,000 L × K20 + diesel 10,000 L × K19 + shop oil 8 × K100
  assert.equal(Math.round(d.stockValue.fuel.atCost), 9000 * 20 + 10000 * 19);
  assert.equal(Math.round(d.stockValue.atCost), 9000 * 20 + 10000 * 19 + 8 * 100);
  assert.equal(d.stockValue.fuel.litres, 19000);
});

test('F5: reopening the shift takes its takings back out; closing it again puts the same receipt back', async () => {
  const sh = db.prepare('SELECT * FROM attendant_shifts ORDER BY id LIMIT 1').get();
  const before = db.prepare("SELECT id, sync_id FROM cash_receipts WHERE received_from = 'Fuel sales'").get();
  const re = await app.request('POST', `/api/attendant-shifts/${sh.id}/reopen`, { token: staff.tokens.supervisor });
  assert.equal(re.status, 200, re.text);
  assert.ok(db.prepare('SELECT deleted_at FROM cash_receipts WHERE id = ?').get(before.id).deleted_at, 'voided while the shift is open');
  assert.equal((await app.request('GET', '/api/dashboard', { token: T() })).body.todayFuelSales, 0);
  const reading = (await app.request('GET', `/api/attendant-shifts/${sh.id}`, { token: T() })).body.readings[0];
  const c = await app.request('POST', `/api/attendant-shifts/${sh.id}/close`, { token: T(),
    body: { readings: [{ id: reading.id, closing_reading: 101000 }], payment_cash: 23500, payment_mobile: 500 } });
  assert.equal(c.status, 200, c.text);
  const after = db.prepare("SELECT * FROM cash_receipts WHERE received_from = 'Fuel sales'").all();
  assert.equal(after.length, 1, 'one receipt per day, never two');
  assert.equal(after[0].sync_id, before.sync_id);
  assert.equal(after[0].deleted_at, null);
  assert.deepEqual([after[0].cash_amount, after[0].momo_amount, after[0].k_amount], [23500, 500, 24000]);
});
