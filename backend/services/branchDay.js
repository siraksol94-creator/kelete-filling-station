// UX-4 — one branch's day for the HQ Overview: takings split into fuel and
// shop, the week, month to date, and the forecourt (tanks, shifts, cash).
// Read-only; it only adds figures beside the ones /api/hq/overview already
// sends, and leaves those unchanged.
//
// Counted the same way as the rest of the app:
//   fuel  = cash takings of CLOSED shifts by trading day (fuelRevenueByDay)
//           + fuel credit tickets (orders numbered FUEL-…)
//   shop  = every other completed order (the HQ rule: status empty, PAID or
//           DISPATCHED), dated by the HQ sale day
// A branch without fuel tables gets fuel 0 and station null.
const fa = require('./fuelAccounting');
const { stationToday } = require('./stationOverview');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(num(n) * 100) / 100;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function branchDay(db, today, saleDaySql) {
  const DONE = "deleted_at IS NULL AND (status IS NULL OR status IN ('PAID','DISPATCHED'))";
  const FUEL = "COALESCE(order_number, '') LIKE 'FUEL-%'";
  const weekFrom = addDays(today, -6);
  const monthFrom = `${today.slice(0, 7)}-01`;
  const from = weekFrom < monthFrom ? weekFrom : monthFrom;

  // Orders by day, split fuel credit / shop.
  const orderDays = db.prepare(`
    SELECT ${saleDaySql} AS day,
           COALESCE(SUM(CASE WHEN ${FUEL} THEN total_amount ELSE 0 END), 0) AS fuel,
           COALESCE(SUM(CASE WHEN ${FUEL} THEN 0 ELSE total_amount END), 0) AS shop
      FROM orders
     WHERE ${DONE} AND ${saleDaySql} >= ? AND ${saleDaySql} <= ?
     GROUP BY day`).all(from, today);
  const days = new Map();
  for (const r of orderDays) days.set(r.day, { fuel: num(r.fuel), shop: num(r.shop) });

  let station = null, fuelStock = 0;
  try {
    const shifts = fa.fuelRevenueByDay(db, from, today);
    for (const [day, amount] of Object.entries(shifts)) {
      const d = days.get(day) || { fuel: 0, shop: 0 };
      d.fuel += num(amount); days.set(day, d);
    }
    station = stationToday(db, today);
    fuelStock = fa.fuelStockValue(db).atCost;
  } catch (_) { /* shop-only branch: no fuel tables */ }

  const sum = (pred) => {
    const out = { fuel: 0, shop: 0 };
    for (const [day, d] of days) if (pred(day)) { out.fuel += d.fuel; out.shop += d.shop; }
    return { fuel: r2(out.fuel), shop: r2(out.shop), total: r2(out.fuel + out.shop) };
  };
  const week = [];
  for (let i = 6; i >= 0; i -= 1) {
    const date = addDays(today, -i);
    const d = days.get(date) || { fuel: 0, shop: 0 };
    week.push({ date, fuel: r2(d.fuel), total: r2(d.fuel + d.shop) });
  }

  return {
    takings: sum((d) => d === today),
    mtd_takings: sum((d) => d >= monthFrom && d <= today),
    week,
    fuel_stock_value: r2(fuelStock),
    station: station && {
      litres: station.litres,
      grades: station.grades.map((g) => ({ name: g.name, color: g.color, litres: g.litres, amount: g.amount })),
      shifts: station.shifts,
      cash: station.cash,
      tanks: station.tanks.map((t) => ({
        code: t.code, grade: t.grade, color: t.color, capacity: t.capacity, volume: t.volume, group_code: t.group_code || null,
        low_level: t.low_level, days_cover: t.days_cover,
      })),
    },
  };
}

module.exports = { branchDay };
