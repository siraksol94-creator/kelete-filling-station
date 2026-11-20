// Cash receipt totals by method on a Kwacha book: every kind of receipt is
// counted once, under the method it was received by.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { startApp } = require('./helpers/app');
const { seedStaff } = require('./helpers/fixtures');

let app, T;
before(async () => {
  app = await startApp(); const s = await seedStaff(app); T = s.tokens.owner;
  const today = app.db.prepare("SELECT DATE('now', '+120 minutes') AS d").get().d;   // the stats' own "today"
  const tenantId = 'local-only';                                                       // as the test login
  const ins = app.db.prepare(`INSERT INTO cash_receipts (receipt_number, received_from, description, payment_method, amount,
      cash_amount, bank_amount, momo_amount, usd_amount, fra_amount, k_amount, date, sync_id, tenant_id, created_at, updated_at)
    VALUES (?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?, datetime('now'), datetime('now'))`);
  // [number, from, amount, cash, bank, momo, usd, fra, k]
  const rows = [
    ['FUEL-1', 'Fuel sales', 1000, 600, 300, 100, 0, 0, 1000],      // fuel day receipt: methods + total in k
    ['CR-AR-1', 'Customer', 500, 0, 500, 0, 0, 0, 0],                // customer payment by bank: methods only (slots default 0)
    ['CR-MAN-1', 'Sales', 250, 200, 0, 50, 200, 50, 0],              // Cash Receipt form: methods = slots
    ['CR-HQ-1', 'HQ', 80, 0, 0, 0, 0, 0, 80],                        // slots only (k = Bank)
  ];
  for (const r of rows) ins.run(r[0], r[1], '', 'Mixed', r[2], r[3], r[4], r[5], r[6], r[7], r[8], today, randomUUID(), tenantId);
});
after(async () => { await app.close(); });

test('receipt totals: Cash, MoMo and Bank each once', async () => {
  const r = await app.request('GET', '/api/cash-receipts/stats', { token: T });
  assert.equal(r.status, 200, r.text);
  // usd = Cash, fra = Mobile Money, k = Bank on a Kwacha book
  const expectCash = 600 + 0 + 200 + 0, expectMomo = 100 + 0 + 50 + 0, expectBank = 300 + 500 + 0 + 80;
  assert.deepEqual([r.body.today.usd, r.body.today.fra, r.body.today.k], [expectCash, expectMomo, expectBank]);
  assert.equal(r.body.today.usd + r.body.today.fra + r.body.today.k, 1830, 'adds up to the receipts (1000 + 500 + 250 + 80)');
});
