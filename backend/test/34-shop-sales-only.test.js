// The Sales Report is the shop's: fuel credit tickets (orders numbered
// FUEL-…) stay in the Fuel Cash Report and Credit Sales (decision 2026-11-28).
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff } = require('./helpers/fixtures');

let app, staff, tok, tenant;
before(async () => {
  app = await startApp(); staff = await seedStaff(app); tok = staff.tokens.owner;
  tenant = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).tenantId;
  const today = new Date().toISOString().slice(0, 10);
  const ins = app.db.prepare(`INSERT INTO orders (order_number, customer_name, total_amount, tax_amount, amount_received, status, sync_id, tenant_id, business_date, created_at)
                              VALUES (?, 'Walk-in', ?, 0, ?, 'Completed', ?, ?, ?, datetime('now'))`);
  const item = app.db.prepare(`INSERT INTO order_items (order_id, order_sync_id, product_name, quantity, unit_price, total_price, sync_id, tenant_id, created_at)
                               VALUES (?, ?, ?, 1, ?, ?, ?, ?, datetime('now'))`);
  for (const [no, amt, name] of [['INV-0001', 150, 'Engine Oil'], ['FUEL-0000001', 1440, 'Diesel']]) {
    const id = ins.run(no, amt, amt, 'o-' + no, tenant, today).lastInsertRowid;
    item.run(id, 'o-' + no, name, amt, amt, 'i-' + no, tenant);
  }
});
after(async () => { await app.close(); });

const get = (url) => app.request('GET', url, { token: tok });

test('orders: ?shop=1 leaves fuel tickets out; without it nothing changes', async () => {
  const all = (await get('/api/orders')).body.map(o => o.order_number);
  assert.ok(all.includes('FUEL-0000001') && all.includes('INV-0001'));
  const shop = (await get('/api/orders?shop=1')).body.map(o => o.order_number);
  assert.deepEqual(shop, ['INV-0001']);
});

test('product summary and breakdown: ?shop=1 leaves fuel tickets out', async () => {
  const names = (await get('/api/orders/product-summary?shop=1')).body.map(r => r.product_name);
  assert.ok(names.includes('Engine Oil'));
  assert.ok(!names.includes('Diesel'));
  assert.equal((await get('/api/orders/product-breakdown?productName=Diesel&shop=1')).body.length, 0);
  assert.equal((await get('/api/orders/product-breakdown?productName=Diesel')).body.length, 1);
});

test("the shop's profit summary counts shop sales only", async () => {
  const r = await get('/api/inventory/sales/profit-summary');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.revenue, 150);
});
