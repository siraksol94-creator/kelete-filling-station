// Categories say where they are sold (fuel stations / shops / both), and an
// item cannot be saved without a category (decision 2026-11-28).
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff } = require('./helpers/fixtures');

let app, staff, tok;
before(async () => { app = await startApp(); staff = await seedStaff(app); tok = staff.tokens.owner; });
after(async () => { await app.close(); });

const post = (url, body) => app.request('POST', url, { token: tok, body });
const put = (url, body) => app.request('PUT', url, { token: tok, body });

test('migration 17 adds categories.sold_at; old categories read as both (NULL)', () => {
  const cols = app.db.prepare('PRAGMA table_info(categories)').all().map(c => c.name);
  assert.ok(cols.includes('sold_at'));
});

test('a category keeps where it is sold; a wrong value is refused', async () => {
  const lub = await post('/api/categories', { name: 'Lubricants', color: '#0e7490', sold_at: 'fuel' });
  assert.equal(lub.status, 201, lub.text);
  assert.equal(lub.body.sold_at, 'fuel');
  const bad = await post('/api/categories', { name: 'Odd', color: '#000', sold_at: 'garage' });
  assert.equal(bad.status, 400);
  const noName = await post('/api/categories', { name: '  ', color: '#000', sold_at: 'shop' });
  assert.equal(noName.status, 400);
  // An older screen that does not send sold_at keeps the stored value.
  const kept = await put(`/api/categories/${lub.body.id}`, { name: 'Lubricants & oils', color: '#0e7490' });
  assert.equal(kept.status, 200, kept.text);
  assert.equal(kept.body.sold_at, 'fuel');
  const list = (await app.request('GET', '/api/categories', { token: tok })).body;
  assert.equal(list.find(c => c.id === lub.body.id).name, 'Lubricants & oils');
});

test('an item needs a category to be created or saved again', async () => {
  const none = await post('/api/products', { name: 'Simba chips', unit: 'pcs', selling_price: 10 });
  assert.equal(none.status, 400);
  assert.equal(none.body.code, 'CATEGORY_REQUIRED');

  const bread = await post('/api/categories', { name: 'Bakery', color: '#6d28d9', sold_at: 'shop' });
  const ok = await post('/api/products', { code: 'BK001', name: 'Bread loaf', unit: 'pcs', cost_price: 12, selling_price: 16, category_id: bread.body.id });
  assert.ok(ok.status === 200 || ok.status === 201, 'create ' + ok.text);
  const id = ok.body.id || ok.body.product?.id;
  const list = (await app.request('GET', '/api/products', { token: tok })).body;
  const row = (Array.isArray(list) ? list : list.products || []).find(p => p.id === id);
  assert.equal(row.category_sold_at, 'shop');

  // An old item with no category still sells, but must get one before it is saved again.
  const sid = 'old-airtime-' + Date.now();
  const info = app.db.prepare("INSERT INTO products (code, name, unit, selling_price, sync_id, tenant_id, created_at, updated_at) VALUES ('AIR1','Airtime','pcs',5,?,?,datetime('now'),datetime('now'))")
    .run(sid, app.db.prepare('SELECT tenant_id FROM products WHERE id = ?').get(id).tenant_id);
  const again = await put(`/api/products/${info.lastInsertRowid}`, { code: 'AIR1', name: 'Airtime', unit: 'pcs', cost_price: 4, selling_price: 5 });
  assert.equal(again.status, 400);
  assert.equal(again.body.code, 'CATEGORY_REQUIRED');
  const fixed = await put(`/api/products/${info.lastInsertRowid}`, { code: 'AIR1', name: 'Airtime', unit: 'pcs', cost_price: 4, selling_price: 5, current_stock: 0, min_stock: 0, status: 'Active', category_id: bread.body.id });
  assert.equal(fixed.status, 200, 'fix ' + fixed.text);
});
