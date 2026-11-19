// UX-3 — the Dashboard's station block: litres by grade, shift progress,
// reconciled cash (server-saved variance, in full) and tank levels.
// Throwaway database, invented figures.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel } = require('./helpers/fixtures');

let app, staff, fuel, station;
const ok = (r, what) => { if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text}`); return r.body; };

before(async () => {
  app = await startApp(); staff = await seedStaff(app);
  const T = staff.tokens.owner;
  fuel = await seedFuel(app, T);
  const open = (att, noz) => app.request('POST', '/api/attendant-shifts/open', { token: T, body: { attendant_user_id: staff.users[att].id, nozzle_ids: noz, shift_type: 'DAY' } });
  const close = async (shift, closings, cash) => {
    const d = ok(await app.request('GET', `/api/attendant-shifts/${shift.id}`, { token: T }), 'detail');
    ok(await app.request('POST', `/api/attendant-shifts/${shift.id}/close`, { token: T, body: {
      readings: d.readings.map((r) => ({ id: r.id, closing_reading: closings[r.nozzle_id] })), payment_cash: cash } }), 'close');
  };
  // shift A: 100 L petrol @25 = 2,500 — cash 2,500 (balanced)
  const a = ok(await open('att1', [fuel.n1.id]), 'open A');
  await close(a, { [fuel.n1.id]: 100100 }, 2500);
  // shift B: 50 L diesel @24 = 1,200 — cash 1,150 (short 50)
  const b = ok(await open('att2', [fuel.n2.id]), 'open B');
  await close(b, { [fuel.n2.id]: 50050 }, 1150);
  // shift C: still open
  ok(await open('att1', [fuel.n1.id]), 'open C');
  station = ok(await app.request('GET', '/api/dashboard', { token: T }), 'dashboard').station;
});
after(async () => { await app.close(); });

test('litres and takings by grade from the day\'s meters', () => {
  const by = Object.fromEntries(station.grades.map((g) => [g.name, g]));
  assert.equal(by.Petrol.litres, 100);
  assert.equal(by.Petrol.amount, 2500);
  assert.equal(by.Diesel.litres, 50);
  assert.equal(by.Diesel.amount, 1200);
  assert.equal(station.litres, 150);
});

test('shift progress for the day', () => {
  assert.deepEqual(station.shifts, { total: 3, open: 1, closed: 2, cash: 2, approved: 0 });
});

test('cash: the shortage is reported in full, with its sign', () => {
  assert.equal(station.cash.reconciled, 2);
  assert.equal(station.cash.balanced, 1);
  assert.equal(station.cash.variance_total, -50);
});

test('tanks with capacity, current volume and grade colour', () => {
  const t1 = station.tanks.find((t) => t.code === 'T1');
  assert.equal(t1.capacity, 30000);
  assert.equal(t1.volume, 10000 - 100);
  assert.equal(t1.grade, 'Petrol');
  assert.equal(station.tanks.length, 2);
});

test('days of cover: none yet without last week\'s sales (no guessing)', () => {
  assert.ok(station.tanks.every((t) => t.days_cover === null && t.avg_daily_litres === 0));
});

test('days of cover from the 7 days before today', () => {
  const bt = require('../config/businessTime');
  const today = bt.businessDate();
  const ago = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  // move shift A (100 L petrol) to 3 days ago: 100 L / 7 days ≈ 14.3 L/day
  const a = app.db.prepare("SELECT s.id FROM attendant_shifts s JOIN shift_nozzle_readings r ON r.shift_id = s.id JOIN nozzles n ON n.id = r.nozzle_id WHERE n.code = 'P1-ULP' AND s.status = 'Closed'").get();
  app.db.prepare('UPDATE attendant_shifts SET shift_date = ? WHERE id = ?').run(ago(3), a.id);
  const st = require('../services/stationOverview').stationToday(app.db, today);
  const t1 = st.tanks.find((t) => t.code === 'T1');
  assert.equal(t1.avg_daily_litres, 14.3);
  assert.equal(t1.days_cover, Math.round((9900 / (100 / 7)) * 10) / 10);
  assert.equal(st.tanks.find((t) => t.code === 'T2').days_cover, null, 'diesel sold only today → no history yet');
});

test('takings: fuel credit tickets (FUEL- orders) count as fuel, not shop; shop & stock leave fuel out', async () => {
  const jwt = require('jsonwebtoken');
  const tenant = jwt.decode(staff.tokens.owner).tenantId;
  const bt = require('../config/businessTime');
  const today = bt.businessDate();
  const { randomUUID } = require('crypto');
  const order = (no, total) => {
    const sid = randomUUID();
    const id = app.db.prepare("INSERT INTO orders (order_number, total_amount, tenant_id, business_date, sync_id) VALUES (?, ?, ?, ?, ?)").run(no, total, tenant, today, sid).lastInsertRowid;
    return { sid, id };
  };
  const shopOrder = order('ORD-0000001', 300);
  order('FUEL-0000099', 250);
  app.db.prepare("INSERT INTO order_items (order_id, order_sync_id, product_name, quantity, unit_price, total_price, tenant_id) VALUES (?, ?, 'Engine Oil 1L', 2, 150, 300, ?)").run(shopOrder.id, shopOrder.sid, tenant);
  const prod = (code, name, stock, min) => app.db.prepare('INSERT INTO products (code, name, current_stock, min_stock, tenant_id, sync_id) VALUES (?, ?, ?, ?, ?, ?)').run(code, name, stock, min, tenant, randomUUID());
  prod('OIL1', 'Engine Oil 1L', 2, 6);
  prod('WATER', 'Water 500ml', 0, 10);
  prod('SNACK', 'Crisps', 40, 10);
  prod('FUEL-XX', 'Fuel product (credit tickets)', 0, 5);
  const d = (await app.request('GET', '/api/dashboard', { token: staff.tokens.owner })).body;
  assert.equal(d.takings.shop, 300);
  assert.equal(d.takings.fuel, 2500 + 1200 + 250 - 100 * 25, 'shift A moved to 3 days ago in the test above');
  assert.equal(d.takings.total, d.takings.fuel + d.takings.shop);
  assert.deepEqual(d.shop.today, { sales: 300, orders: 1, basket: 300 });
  assert.deepEqual(d.shop.top7.map((x) => x.name), ['Engine Oil 1L']);
  assert.deepEqual({ out: d.shop.stock.out, low: d.shop.stock.low, healthy: d.shop.stock.healthy }, { out: 1, low: 1, healthy: 1 });
  assert.deepEqual(d.shop.runningLow.map((x) => x.name), ['Water 500ml', 'Engine Oil 1L'], 'emptiest first; fuel products never listed');
});

test('HQ Overview branch day: fuel/shop split, week and forecourt (same rules as the Dashboard)', () => {
  const bt = require('../config/businessTime');
  const today = bt.businessDate();
  // The HQ sale-day expression from routes/hq.js.
  const HQ_SALE_DAY = "(CASE WHEN business_date IS NULL THEN substr(COALESCE(paid_at, created_at), 1, 10) ELSE COALESCE(DATE(paid_at, '+120 minutes'), business_date) END)";
  const b = require('../services/branchDay').branchDay(app.db, today, HQ_SALE_DAY);
  assert.deepEqual(b.takings, { fuel: 1200 + 250, shop: 300, total: 1750 }, 'shift B cash + FUEL- ticket; the shop order');
  assert.equal(b.week.length, 7);
  assert.equal(b.week[6].date, today);
  assert.deepEqual(b.week[6], { date: today, fuel: 1450, total: 1750 });
  const ago3 = b.week[3];
  assert.equal(ago3.fuel, 2500, 'shift A, moved to 3 days ago');
  assert.ok(b.mtd_takings.total >= b.takings.total);
  assert.equal(b.station.cash.variance_total, -50, 'variance in full, with its sign');
  assert.ok(b.station.tanks.every((t) => 'days_cover' in t && 'low_level' in t));
});
