// Business type (fuel station / shop): the first save of a new install keeps
// it, and only an Administrator can change it.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff } = require('./helpers/fixtures');

let app, staff;
before(async () => { app = await startApp(); staff = await seedStaff(app); });
after(async () => { await app.close(); });

const settings = async () => (await app.request('GET', '/api/settings', { token: staff.tokens.owner })).body.business;

test('the very first save keeps every field (it used to drop Business type)', async () => {
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM business_settings').get().n, 0);
  const r = await app.request('PUT', '/api/settings/business', { token: staff.tokens.owner,
    body: { business_name: 'Mansa Shop', business_type: 'grocery', currency_mode: 'K', payment_methods: 'cash_momo_bank' } });
  assert.equal(r.status, 200, r.text);
  const b = await settings();
  assert.equal(b.business_name, 'Mansa Shop');
  assert.equal(b.business_type, 'grocery');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM business_settings').get().n, 1);
});

test('only an Administrator can change it', async () => {
  await app.request('PUT', '/api/settings/business', { token: staff.tokens.supervisor, body: { business_type: 'fuel' } });
  assert.equal((await settings()).business_type, 'grocery');
  await app.request('PUT', '/api/settings/business', { token: staff.tokens.owner, body: { business_type: 'fuel' } });
  assert.equal((await settings()).business_type, 'fuel');
});
