/**
 * fuelProfit.js — the forecourt's side of the Profit Report.
 *
 * Decisions 2026-11-20:
 *   • The Profit Report shows Shop | Fuel | Station total.
 *   • Fuel cost per litre is frozen on each shift's nozzle readings when the
 *     shift closes (migration 13, shift_nozzle_readings.cost_per_litre).
 *     Readings closed before that have no frozen cost: they use the grade's
 *     average cost today and are counted as "estimated" litres.
 *
 * Fuel sales come from CLOSED shifts (the same rule as the fuel cash-book
 * receipt, services/fuelAccounting.js), dated by the shift's trading day.
 * They cover every tender — cash, card, MoMo, Credit, 1Card, Other — because
 * a sale is a sale whoever pays later. Testing litres are already excluded
 * from litres_sold. Revenue is the metered value (litres × the price frozen
 * on the reading), i.e. the shift's gross sales.
 *
 * Credit fuel tickets are also customer orders (F2). The shop's stored daily
 * profit counts every order as revenue, so that fuel is inside the shop's
 * revenue with no cost behind it. `credit_in_shop` returns the part of it the
 * stored shop figures really contain (same date rule as config/profitHelper.js,
 * and only tickets that existed when the day was last calculated) so the report
 * can move it out of the shop column. Nothing stored is changed.
 *
 * Shift cash short/over (attendant_shifts.variance) is the forecourt's cash
 * variance, the counterpart of the shop's cash-report difference.
 *
 * Read-only.
 */
const bt = require('../config/businessTime');

const SHIFT_DAY = bt.shiftDateSql('s');
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function hasCol(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); } catch (_) { return false; }
}

// Stamp the grade's current average cost on a shift's readings that have
// none yet. Called inside the close transaction; a reading keeps the first
// cost it was given. Does nothing before migration 13 has run.
function freezeShiftCost(db, shiftId) {
  if (!hasCol(db, 'shift_nozzle_readings', 'cost_per_litre')) return 0;
  return db.prepare(`
    UPDATE shift_nozzle_readings
       SET cost_per_litre = (
             SELECT g.cost_price FROM nozzles n
               JOIN tanks t ON t.id = n.tank_id
               JOIN fuel_grades g ON g.id = t.fuel_grade_id
              WHERE n.id = shift_nozzle_readings.nozzle_id)
     WHERE shift_id = ? AND cost_per_litre IS NULL
  `).run(shiftId).changes;
}

// opts.daily: also return the same figures per trading day (HQ Consolidated
// Profit's drill-down).
function fuelProfit(db, { from, to, daily = false } = {}) {
  const frozen = hasCol(db, 'shift_nozzle_readings', 'cost_per_litre');
  const range = [];
  let where = "s.status = 'Closed'";
  if (from) { where += ` AND ${SHIFT_DAY} >= ?`; range.push(from); }
  if (to) { where += ` AND ${SHIFT_DAY} <= ?`; range.push(to); }

  const rows = db.prepare(`
    SELECT g.id AS grade_id, g.code, g.name, g.color, g.cost_price AS cost_today,
           ${SHIFT_DAY} AS day,
           r.litres_sold AS litres, r.expected_cash AS revenue, r.price_per_litre AS price,
           ${frozen ? 'r.cost_per_litre' : 'NULL'} AS cost_frozen
      FROM shift_nozzle_readings r
      JOIN attendant_shifts s ON s.id = r.shift_id
      JOIN nozzles n ON n.id = r.nozzle_id
      JOIN tanks t ON t.id = n.tank_id
      JOIN fuel_grades g ON g.id = t.fuel_grade_id
     WHERE ${where} AND COALESCE(r.litres_sold, 0) > 0
  `).all(...range);

  const byGrade = new Map();
  const byDay = new Map();
  const dayOf = (d) => {
    let v = byDay.get(d);
    if (!v) { v = { date: d, litres: 0, revenue: 0, cost: 0, cash_variance: 0, credit_in_shop: 0 }; byDay.set(d, v); }
    return v;
  };
  for (const x of rows) {
    let g = byGrade.get(x.grade_id);
    if (!g) {
      g = { grade_id: x.grade_id, code: x.code, name: x.name, color: x.color || null,
            litres: 0, revenue: 0, cost: 0, estimated_litres: 0 };
      byGrade.set(x.grade_id, g);
    }
    const litres = Number(x.litres) || 0;
    const estimated = x.cost_frozen == null;
    const cpl = estimated ? Number(x.cost_today) || 0 : Number(x.cost_frozen) || 0;
    g.litres += litres;
    g.revenue += Number(x.revenue) || 0;
    g.cost += litres * cpl;
    if (estimated) g.estimated_litres += litres;
    if (daily) {
      const dd = dayOf(x.day);
      dd.litres += litres; dd.revenue += Number(x.revenue) || 0; dd.cost += litres * cpl;
    }
  }

  const grades = [...byGrade.values()].map((g) => {
    const litres = Math.round(g.litres * 1000) / 1000;
    const revenue = r2(g.revenue), cost = r2(g.cost), margin = r2(g.revenue - g.cost);
    return {
      grade_id: g.grade_id, code: g.code, name: g.name, color: g.color,
      litres, revenue, cost, margin,
      price_per_litre: litres > 0 ? r2(g.revenue / litres) : 0,
      cost_per_litre: litres > 0 ? r2(g.cost / litres) : 0,
      margin_per_litre: litres > 0 ? r2((g.revenue - g.cost) / litres) : 0,
      estimated_litres: Math.round(g.estimated_litres * 1000) / 1000,
    };
  }).sort((a, b) => b.revenue - a.revenue || String(a.code).localeCompare(String(b.code)));

  const cash = db.prepare(`
    SELECT COUNT(*) AS shifts, COALESCE(SUM(s.variance), 0) AS variance
      FROM attendant_shifts s WHERE ${where}
  `).get(...range);
  if (daily) {
    for (const c of db.prepare(`
      SELECT ${SHIFT_DAY} AS day, COALESCE(SUM(s.variance), 0) AS variance
        FROM attendant_shifts s WHERE ${where} GROUP BY ${SHIFT_DAY}
    `).all(...range)) dayOf(c.day).cash_variance += Number(c.variance) || 0;
  }

  // Credit fuel tickets inside the shop's stored revenue (profitHelper's
  // revenue rule: COALESCE(business_date, DATE(created_at)), not Reversed).
  const ordDay = 'COALESCE(o.business_date, DATE(o.created_at))';
  const oRange = [];
  let oWhere = "o.deleted_at IS NULL AND (o.status IS NULL OR o.status != 'Reversed')";
  if (from) { oWhere += ` AND ${ordDay} >= ?`; oRange.push(from); }
  if (to) { oWhere += ` AND ${ordDay} <= ?`; oRange.push(to); }
  const hasLink = hasCol(db, 'shift_credit_sales', 'linked_order_id');
  // Only tickets the stored day already contains: the day has a stored row
  // and the ticket existed when it was last calculated. (A ticket does not
  // recalculate the day itself; a later shop sale or the startup backfill
  // does.) So the shop column can never go below what is really in it.
  const creditRows = hasLink ? db.prepare(`
    SELECT ${ordDay} AS day, COALESCE(SUM(o.total_amount), 0) AS amount
      FROM orders o
      JOIN daily_profit_summary d
        ON d.date = ${ordDay} AND d.tenant_id = o.tenant_id
     WHERE ${oWhere}
       AND o.created_at <= d.updated_at
       AND o.id IN (SELECT linked_order_id FROM shift_credit_sales
                     WHERE payment_method = 'Credit' AND linked_order_id IS NOT NULL)
     GROUP BY ${ordDay}
  `).all(...oRange) : [];
  const credit = { amount: creditRows.reduce((a, c) => a + (Number(c.amount) || 0), 0) };
  if (daily) for (const c of creditRows) dayOf(c.day).credit_in_shop += Number(c.amount) || 0;

  const litres = grades.reduce((a, g) => a + g.litres, 0);
  const revenue = r2(grades.reduce((a, g) => a + g.revenue, 0));
  const cost = r2(grades.reduce((a, g) => a + g.cost, 0));
  const margin = r2(revenue - cost);
  const cashVariance = r2(cash.variance);
  const estimatedLitres = grades.reduce((a, g) => a + g.estimated_litres, 0);

  return {
    from: from || null, to: to || null,
    shifts: Number(cash.shifts) || 0,
    grades,
    totals: {
      litres: Math.round(litres * 1000) / 1000,
      revenue, cost, margin,
      margin_per_litre: litres > 0 ? r2(margin / litres) : 0,
      cash_variance: cashVariance,
      gross_profit: r2(margin + cashVariance),
      estimated_litres: Math.round(estimatedLitres * 1000) / 1000,
    },
    credit_in_shop: r2(credit.amount),
    cost_frozen_available: frozen,
    ...(daily ? {
      daily: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((d) => ({
        date: d.date,
        litres: Math.round(d.litres * 1000) / 1000,
        revenue: r2(d.revenue), cost: r2(d.cost), margin: r2(d.revenue - d.cost),
        cash_variance: r2(d.cash_variance),
        gross_profit: r2(d.revenue - d.cost + d.cash_variance),
        credit_in_shop: r2(d.credit_in_shop),
      })),
    } : {}),
  };
}

module.exports = { fuelProfit, freezeShiftCost };
