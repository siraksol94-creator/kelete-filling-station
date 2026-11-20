// Sales Report loading fix — GET /api/orders with ?from=&to= and ?q=.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('crypto');
const { startApp } = require('./helpers/app');
const { seedStaff } = require('./helpers/fixtures');

let app, staff, T;
before(async () => {
  app = await startApp(); staff = await seedStaff(app);
  T = staff.tokens.owner;
  const tenantId = app.db.prepare("SELECT value FROM sync_config WHERE key = 'tenant_id'").get()?.value || 'local-only';  // as the login does
  const ins = app.db.prepare(`INSERT INTO orders (order_number, subtotal, total_amount, status, sync_id, tenant_id, created_at,
                                                   zra_rcpt_no, zra_sdc_id, zra_cn_rcpt_no, zra_cn_sdc_id)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const sale = (num, created, extra = {}) => ins.run(num, 100, 100, extra.status || 'Completed', randomUUID(), tenantId, created,
    extra.rcpt ?? null, extra.sdc ?? null, extra.cn ?? null, extra.cnSdc ?? null);
  sale('INV-OLD-1', '2026-01-05 09:00:00');
  sale('INV-1001', '2026-11-18 21:30:00');                       // 23:30 Lusaka on the 18th
  sale('INV-1002', '2026-11-19 22:30:00');                       // 00:30 Lusaka on the 20th
  sale('INV-1003', '2026-11-20 08:00:00', { rcpt: 2755, sdc: 'SDC0060003843' });
  sale('INV-1004', '2026-11-20 09:00:00', { status: 'Reversed', rcpt: 2756, sdc: 'SDC0060003843', cn: 41, cnSdc: '' });
  sale('INV-50%_X', '2026-11-21 06:00:00');
  sale('INV-2001', '2026-11-25 10:00:00');
});
after(async () => { await app.close(); });

const list = async (qs = '') => {
  const r = await app.request('GET', `/api/orders${qs}`, { token: T });
  assert.equal(r.status, 200, r.text);
  return r.body.map((o) => o.order_number);
};

test('no filter: every order, newest first (unchanged for other callers)', async () => {
  const all = await list();
  assert.equal(all.length, 7);
  assert.equal(all[0], 'INV-2001');
  assert.equal(all[all.length - 1], 'INV-OLD-1');
});

test('one day: a day wider each side, so the screen can still pick by local date', async () => {
  const day = await list('?from=2026-11-20&to=2026-11-20');
  // window = [2026-11-19, 2026-11-22) UTC
  assert.deepEqual(day.sort(), ['INV-1002', 'INV-1003', 'INV-1004', 'INV-50%_X'].sort());
  assert.ok(!day.includes('INV-OLD-1') && !day.includes('INV-2001'));
  // the 00:30 Lusaka sale on the 20th (22:30 UTC on the 19th) is included
  assert.ok(day.includes('INV-1002'));
});

test('a range', async () => {
  const r = await list('?from=2026-11-18&to=2026-11-25');
  assert.equal(r.length, 6);
  assert.ok(!r.includes('INV-OLD-1'));
});

test('search: all dates, our number and ZRA\'s composite numbers', async () => {
  assert.deepEqual(await list('?q=1003&from=2026-01-01&to=2026-01-01'), ['INV-1003'], 'dates are ignored while searching');
  assert.deepEqual(await list('?q=INV0060003843/2755'), ['INV-1003']);
  assert.deepEqual(await list('?q=inv0060003843/2755'), ['INV-1003'], 'case-insensitive');
  assert.deepEqual(await list('?q=CRN0060003843/41'), ['INV-1004'], 'credit note number, SDC from the sale when the CN has none');
  assert.deepEqual(await list('?q=2756'), ['INV-1004']);
  assert.deepEqual(await list('?q=old'), ['INV-OLD-1']);
  assert.deepEqual(await list('?q=nothing-like-this'), []);
});

test('search treats % and _ as plain characters', async () => {
  assert.deepEqual(await list('?q=50%25_x'), ['INV-50%_X']);
  assert.deepEqual(await list('?q=%25'), ['INV-50%_X']);
  assert.deepEqual(await list('?q=_'), ['INV-50%_X']);
});

test('bad dates are ignored, not an error', async () => {
  assert.equal((await list('?from=yesterday&to=2026-13-99x')).length, 7);
});

test('cost and partial-refund columns are still attached', async () => {
  const r = await app.request('GET', '/api/orders?from=2026-11-20&to=2026-11-20', { token: T });
  for (const o of r.body) {
    assert.ok('cogs' in o && 'partial_refund_amount' in o && 'partial_refund_at' in o);
  }
});
