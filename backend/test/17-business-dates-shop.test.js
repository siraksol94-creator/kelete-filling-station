// UTC dates fix (shop / accounting / customers) — orders, stock movements,
// reports and "today" defaults use the station's day (Zambia, UTC+2).
// Older rows keep the day they always showed. Throwaway database.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { startApp } = require('./helpers/app');
const { seedStaff, createCustomer } = require('./helpers/fixtures');
const bt = require('../config/businessTime');

let app, db, staff, customer, product;
const T = () => staff.tokens.owner;
const at = (iso) => { process.env.KELETE_TEST_NOW = iso; };
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };

// An order as a till or the VPS stores it: created_at in UTC.
function order({ createdAt, total, legacy = false, businessDate }) {
  const sync = randomUUID();
  db.prepare(`INSERT INTO orders (order_number, customer_name, customer_sync_id, total_amount, subtotal, amount_received,
                                  payment_method, sync_id, tenant_id, created_at, updated_at${businessDate ? ', business_date' : ''})
              VALUES (?, ?, ?, ?, ?, 0, 'Credit', ?, ?, ?, ?${businessDate ? ', ?' : ''})`)
    .run(`T-${sync.slice(0, 8)}`, customer.name, customer.sync_id, total, total, sync, tenant(), createdAt, createdAt, ...(businessDate ? [businessDate] : []));
  if (legacy) db.prepare('UPDATE orders SET business_date = NULL WHERE sync_id = ?').run(sync); // as before migration 10
  return db.prepare('SELECT * FROM orders WHERE sync_id = ?').get(sync);
}
const tenant = () => db.prepare("SELECT value FROM sync_config WHERE key = 'tenant_id'").get()?.value || 'local-only';

before(async () => {
  app = await startApp(); db = app.db; staff = await seedStaff(app);
  customer = await createCustomer(app, T(), 'Night Owl Traders');
  const pSync = randomUUID();
  db.prepare("INSERT INTO products (code, name, unit, cost_price, selling_price, current_stock, sync_id, tenant_id, units_json) VALUES ('BD1','Bottled Water','pcs',5,8,0,?,?,?)")
    .run(pSync, tenant(), JSON.stringify([{ name: 'pcs', conv: 1, price: 8, is_base: true }]));
  product = db.prepare('SELECT * FROM products WHERE sync_id = ?').get(pSync);
});
after(async () => { delete process.env.KELETE_TEST_NOW; await app.close(); });
afterEach(() => { delete process.env.KELETE_TEST_NOW; });

describe('helpers', () => {
  test('a chosen day at the station\'s current time becomes a real UTC moment on that day', () => {
    assert.equal(bt.businessStampUtc('2026-11-19', new Date('2026-11-18T22:30:00Z')), '2026-11-18 22:30:00'); // 00:30 Lusaka on the 19th
    assert.equal(bt.businessStampUtc('2026-11-10', new Date('2026-11-18T21:30:00Z')), '2026-11-10 21:30:00'); // back-dated, 23:30 Lusaka
    assert.equal(bt.businessDateOf('2026-11-18 22:30:00'), '2026-11-19');
  });
});

describe('orders: the business day is recorded, and older orders keep theirs', () => {
  test('an order at 00:30 Lusaka (22:30 UTC the day before) belongs to the new day', () => {
    assert.equal(order({ createdAt: '2026-11-18 22:30:00', total: 100 }).business_date, '2026-11-19');
    assert.equal(order({ createdAt: '2026-11-18 21:59:00', total: 1 }).business_date, '2026-11-18');
  });
  test('an order arriving by sync keeps the day its own device recorded', () => {
    assert.equal(order({ createdAt: '2026-11-18 22:30:00', total: 2, businessDate: '2026-11-18' }).business_date, '2026-11-18');
  });
  test('customer reports by period: the 00:30 sale is on the 19th; a legacy row keeps its old day', async () => {
    order({ createdAt: '2026-10-01 23:30:00', total: 40, legacy: true });
    const sold = async (d) => {
      const rows = ok(await app.request('GET', `/api/customers?from=${d}&to=${d}`, { token: T() }), `customers ${d}`);
      return Number((rows.find(r => r.sync_id === customer.sync_id) || {}).total_sold || 0);
    };
    assert.equal(await sold('2026-11-19'), 100, 'the 00:30 sale counts on the 19th');
    assert.equal(await sold('2026-11-18'), 1 + 2, 'the 23:59 sale and the synced one (its device said the 18th) — not the 00:30 sale');
    assert.equal(await sold('2026-10-01'), 40, 'a legacy order keeps the day it always had');
    assert.equal(await sold('2026-10-02'), 0);
  });
  test('the Dashboard counts an order made now in today\'s sales (station day)', async () => {
    const now = db.prepare("SELECT datetime('now') AS t").get().t;
    order({ createdAt: now, total: 123.45 });
    const d = ok(await app.request('GET', '/api/dashboard', { token: T() }), 'dashboard');
    assert.ok(Number(d.todaySales) >= 123.45, `todaySales ${d.todaySales}`);
    const today = bt.businessDate(new Date(now.replace(' ', 'T') + 'Z'));
    assert.ok((d.salesTrend || []).some(r => r.date === today), 'trend is keyed by the station day');
  });
});

describe('stock movements written for a chosen day', () => {
  test('a stock adjustment dated the 19th, entered at 00:30 Lusaka: stored as a real UTC time, reported on the 19th', async () => {
    at('2026-11-18T22:30:00Z');
    ok(await app.request('POST', '/api/stock-adjustments', { token: T(),
      body: { product_id: product.id, product_sync_id: product.sync_id, adjustment_type: 'increase', quantity: 7, reason: 'count', date: '2026-11-19' } }), 'adjustment');
    const mv = db.prepare("SELECT created_at, business_date FROM stock_movements WHERE product_sync_id = ? ORDER BY id DESC").get(product.sync_id);
    assert.equal(mv.created_at, '2026-11-18 22:30:00', 'a true UTC moment (was "2026-11-19 <server clock>")');
    assert.equal(mv.business_date, '2026-11-19');
    const loc = mv && db.prepare('SELECT location FROM stock_movements WHERE product_sync_id = ? ORDER BY id DESC').get(product.sync_id).location;
    const day = async (d) => ok(await app.request('GET', `/api/inventory/store?location=${loc}&from=${d}&to=${d}`, { token: T() }), `inventory ${d}`)
      .find(r => r.product_sync_id === product.sync_id || r.sync_id === product.sync_id);
    assert.equal(Number((await day('2026-11-19')).total_in), 7);
    assert.equal(Number((await day('2026-11-18')).total_in), 0);
  });
  test('stock reconciliation "as of" a day counts movements by their business day', () => {
    const bal = (d) => db.prepare(`SELECT COALESCE(SUM(quantity),0) AS q FROM stock_movements
                                    WHERE product_sync_id = ? AND COALESCE(business_date, DATE(created_at)) <= ?`).get(product.sync_id, d).q;
    assert.equal(bal('2026-11-18'), 0);
    assert.equal(bal('2026-11-19'), 7);
  });
  test('the inventory report refuses anything but real dates (was open to SQL injection)', async () => {
    const r = await app.request('GET', `/api/inventory/store?from=${encodeURIComponent("2026-01-01' OR '1'='1")}`, { token: T() });
    assert.equal(r.status, 400);
  });
});

describe('"today" defaults and this-month totals', () => {
  test('a payment voucher and a cash receipt entered at 00:30 Lusaka without a date are dated the new day', async () => {
    at('2026-11-18T22:30:00Z');
    const pv = ok(await app.request('POST', '/api/payment-vouchers', { token: T(), body: { paid_to: 'Night Supplier', description: 'ice', category: 'General', amount: 10, paid_from: 'Cash' } }), 'pv');
    const pvRow = db.prepare('SELECT date FROM payment_vouchers WHERE id = ?').get(pv.id || pv.voucher?.id || pv.data?.id);
    assert.equal(pvRow.date, '2026-11-19');
  });
  test('"today" in SQL is the station\'s day', () => {
    const r = db.prepare("SELECT DATE('now', '+120 minutes') AS d").get();
    const now = new Date(db.prepare("SELECT datetime('now') AS t").get().t.replace(' ', 'T') + 'Z');
    assert.equal(r.d, bt.businessDate(now));
  });
});
