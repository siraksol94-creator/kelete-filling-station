// Drawer expenses by method: a MoMo or Bank payment voucher is counted once,
// under its own method (it was counted under both MoMo and Bank).
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { startApp } = require('./helpers/app');
const { seedStaff } = require('./helpers/fixtures');

let app, T;
const today = require('../config/businessTime').businessDate();
before(async () => {
  app = await startApp(); const s = await seedStaff(app); T = s.tokens.owner;
  const pv = async (label, body) => {
    const r = await app.request('POST', '/api/payment-vouchers', { token: T, body: {
      paid_to: 'Supplier', description: label, category: 'Other', amount: Object.values(body)[0],
      date: today, paid_from: 'Cash Drawer', cashier_id: 0, ...body } });
    if (r.status !== 201) throw new Error(`${label}: ${r.status} ${r.text}`);
  };
  await pv('cash', { usd_amount: 50 });
  await pv('momo', { fra_amount: 200 });
  await pv('bank', { k_amount: 300 });
  // A voucher saved before the three slots existed: only the old columns.
  const tenantId = app.db.prepare('SELECT tenant_id FROM payment_vouchers ORDER BY id DESC LIMIT 1').get().tenant_id;
  app.db.prepare(`INSERT INTO payment_vouchers (voucher_number, paid_to, description, category, amount,
                    cash_amount, bank_amount, momo_amount, usd_amount, fra_amount, k_amount,
                    date, paid_from, cashier_id, sync_id, tenant_id, created_at, updated_at)
                  VALUES ('PV-OLD-1','Old','legacy','Other',7, 7,0,0, 0,0,0, ?, 'Cash Drawer', 0, ?, ?, datetime('now'), datetime('now'))`)
    .run(today, randomUUID(), tenantId);
});
after(async () => { await app.close(); });

test('Cash Report daily figures: each method once', async () => {
  const d = await app.request('GET', `/api/cash-reports/daily?date=${today}&cashier_id=0`, { token: T });
  assert.equal(d.status, 200, d.text);
  // usd slot = Cash, fra = Mobile Money, k = Bank on a Kwacha book
  assert.deepEqual([d.body.usd_expenses, d.body.fra_expenses, d.body.k_expenses], [57, 200, 300]);
  assert.equal(d.body.expenses, 557, 'the total was always right');
});

test('payment voucher totals: each method once', async () => {
  const r = await app.request('GET', '/api/payment-vouchers/stats', { token: T });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.today.usd, r.body.today.fra, r.body.today.k], [57, 200, 300]);
});
