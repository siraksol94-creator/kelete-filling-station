/**
 * fuelAccounting.js — F5: forecourt fuel in the accounts.
 * Business decisions 2026-11-18:
 *   • fuel revenue from CLOSED shifts feeds the Dashboard and the cash book as
 *     daily receipts;
 *   • fuel stock is valued at weighted-average cost (the grade's cost_price,
 *     which every delivery re-averages).
 *
 * Before this, the Dashboard showed only shop sales and fuel credit tickets
 * (e.g. K1,300 on a day the forecourt took K25,000+), no cash-book source held
 * the forecourt's takings, and the stock value ignored the tanks entirely.
 *
 * Daily receipt — one cash_receipts row per trading day ("Fuel sales —
 * <date>"), recalculated whenever a shift of that day is closed, finalised,
 * reopened or deleted:
 *     cash  = cash counted (payment_cash)      bank = swipes (payment_swipes)
 *     momo  = mobile money (payment_mobile)    k_amount = their total
 *   Credit and 1Card are not money received (they are owed to the station:
 *   credit tickets are customer orders since F2) and "Other" (vouchers) is not
 *   money in hand, so none of them is in the receipt. Being a real receipt, it
 *   appears in every cash-book view, balance, statistic and HQ roll-up, and
 *   syncs like any other. Its sync_id is derived from the account and the
 *   date, so the till and the VPS update the SAME receipt — never two.
 *   If a day has no closed shift any more, its receipt is voided (soft delete).
 */
const crypto = require('crypto');
const bt = require('../config/businessTime');

const SHIFT_DAY = bt.shiftDateSql('s');

// A stable UUID for "fuel receipt of <tenant> on <date>".
function receiptSyncId(tenantId, date) {
  const h = crypto.createHash('sha1').update(`kelete-fuel-day|${tenantId}|${date}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function dayTakings(db, date) {
  return db.prepare(`
    SELECT COUNT(*) AS shifts,
           COALESCE(SUM(s.payment_cash), 0)   AS cash,
           COALESCE(SUM(s.payment_mobile), 0) AS momo,
           COALESCE(SUM(s.payment_swipes), 0) AS bank
      FROM attendant_shifts s
     WHERE s.status = 'Closed' AND ${SHIFT_DAY} = ?
  `).get(date);
}

// Create, update or void the fuel receipt for one trading day.
function syncFuelDayReceipt(db, { date, tenantId, userId = null, branchId = null, deviceId = null }) {
  if (!date || !tenantId) return null;
  const t = dayTakings(db, date);
  const cash = Number(t.cash) || 0, momo = Number(t.momo) || 0, bank = Number(t.bank) || 0;
  const total = Number((cash + momo + bank).toFixed(2));
  const sid = receiptSyncId(tenantId, date);
  const existing = db.prepare('SELECT * FROM cash_receipts WHERE sync_id = ?').get(sid);

  if (!t.shifts || total === 0) {
    if (existing && !existing.deleted_at) {
      db.prepare("UPDATE cash_receipts SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?").run(existing.id);
    }
    return existing ? db.prepare('SELECT * FROM cash_receipts WHERE id = ?').get(existing.id) : null;
  }
  const description = `Forecourt takings from ${t.shifts} closed shift(s) — cash ${cash.toFixed(2)}, mobile money ${momo.toFixed(2)}, swipes ${bank.toFixed(2)}. Automatic: recalculated when a shift of this day changes.`;
  if (existing) {
    db.prepare(`UPDATE cash_receipts
                   SET amount = ?, cash_amount = ?, bank_amount = ?, momo_amount = ?, usd_amount = 0, fra_amount = 0, k_amount = ?,
                       description = ?, deleted_at = NULL, updated_at = datetime('now'), synced = 0
                 WHERE id = ?`).run(total, cash, bank, momo, total, description, existing.id);
    return db.prepare('SELECT * FROM cash_receipts WHERE id = ?').get(existing.id);
  }
  const info = db.prepare(`
    INSERT INTO cash_receipts (receipt_number, received_from, description, payment_method, amount,
                               cash_amount, bank_amount, momo_amount, usd_amount, fra_amount, k_amount,
                               date, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
    VALUES (?, 'Fuel sales', ?, 'Mixed', ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(`FUEL-${date}`, description, total, cash, bank, momo, total, date, userId, sid, tenantId, branchId, deviceId);
  return db.prepare('SELECT * FROM cash_receipts WHERE id = ?').get(info.lastInsertRowid);
}

// Fuel revenue by trading day for the Dashboard: what the closed shifts sold
// (litres × price at the nozzles) minus credit tickets, which are already
// customer orders (F2) and so already in the order totals.
function fuelRevenueByDay(db, fromDate, toDate) {
  const rows = db.prepare(`
    SELECT ${SHIFT_DAY} AS day,
           COALESCE(SUM((SELECT COALESCE(SUM(r.expected_cash), 0) FROM shift_nozzle_readings r WHERE r.shift_id = s.id)), 0)
         - COALESCE(SUM((SELECT COALESCE(SUM(c.amount), 0) FROM shift_credit_sales c
                          WHERE c.shift_id = s.id AND COALESCE(c.payment_method, 'Credit') = 'Credit')), 0) AS revenue
      FROM attendant_shifts s
     WHERE s.status = 'Closed' AND ${SHIFT_DAY} >= ? AND ${SHIFT_DAY} <= ?
     GROUP BY day
  `).all(fromDate, toDate);
  const out = {};
  for (const r of rows) out[r.day] = Number(r.revenue) || 0;
  return out;
}

// Fuel in the tanks at weighted-average cost (and at the selling price).
function fuelStockValue(db) {
  const r = db.prepare(`
    SELECT COALESCE(SUM(MAX(COALESCE(t.current_volume, 0), 0) * COALESCE(g.cost_price, 0)), 0)    AS at_cost,
           COALESCE(SUM(MAX(COALESCE(t.current_volume, 0), 0) * COALESCE(g.selling_price, 0)), 0) AS at_retail,
           COALESCE(SUM(MAX(COALESCE(t.current_volume, 0), 0)), 0)                                AS litres,
           SUM(CASE WHEN COALESCE(t.current_volume, 0) > 0 AND COALESCE(g.cost_price, 0) = 0 THEN 1 ELSE 0 END) AS tanks_without_cost
      FROM tanks t LEFT JOIN fuel_grades g ON g.id = t.fuel_grade_id
     WHERE COALESCE(t.status, 'Active') != 'Inactive'
  `).get();
  return { atCost: Number(r.at_cost) || 0, atRetail: Number(r.at_retail) || 0, litres: Number(r.litres) || 0, tanksWithoutCost: Number(r.tanks_without_cost) || 0 };
}

module.exports = { receiptSyncId, syncFuelDayReceipt, fuelRevenueByDay, fuelStockValue, dayTakings };
