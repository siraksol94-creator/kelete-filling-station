// supplierLedger.js — what each supplier is owed, in ONE place.
//
// Account Payables (routes/accountPayables.js) and Suppliers (routes/suppliers.js)
// used to compute this separately and disagreed (Suppliers ignored credit notes),
// and neither counted fuel. Both now read these rows.
//
//   bought   = GRNs (gross: final payable + the credit notes attached to them)
//            + fuel deliveries from this supplier (fuel_deliveries.supplier_id)
//   paid     = supplier payments (ap_payments), of which `offset_1card` are 1Card
//              tickets: fuel a card-holder drew against the supplier's card, which
//              reduces what we owe without any money moving (never in the Cash Book)
//   credits  = supplier credit notes (a depot's only once HQ confirmed it)
//   balance  = bought - paid - credits      (> 0: we owe them; < 0: we are in credit)
//
// from / to (YYYY-MM-DD) limit every part to that period, as the AP page always did.
function hasTable(db, name) {
  try { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name); }
  catch (_) { return false; }
}
function hasColumn(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col); }
  catch (_) { return false; }
}

function ledgerRows(db, tenantId, { from, to, activeOnly = true } = {}) {
  const range = (col) => (from ? ` AND ${col} >= ?` : '') + (to ? ` AND ${col} <= ?` : '');
  const rp = [...(from ? [from] : []), ...(to ? [to] : [])];
  // grn.cost_currency exists on databases that ran the old v1.10.79 backfill
  // (and on every database from migration 16); older ones count as Kwacha.
  const ccy = hasColumn(db, 'grn', 'cost_currency')
    ? `(SELECT COALESCE(NULLIF(UPPER(g2.cost_currency), ''), 'K') FROM grn g2
         WHERE g2.supplier_sync_id = grn.supplier_sync_id AND g2.deleted_at IS NULL
         GROUP BY COALESCE(NULLIF(UPPER(g2.cost_currency), ''), 'K') ORDER BY COUNT(*) DESC LIMIT 1)`
    : "'K'";
  const fuel = hasTable(db, 'fuel_deliveries')
    ? `SELECT supplier_id, SUM(total_cost) AS amount, COUNT(*) AS n, MAX(delivery_date) AS last_date
         FROM fuel_deliveries
        WHERE supplier_id IS NOT NULL AND COALESCE(status, 'Received') NOT IN ('Cancelled', 'Void')${range('delivery_date')}
        GROUP BY supplier_id`
    : 'SELECT NULL AS supplier_id, 0 AS amount, 0 AS n, NULL AS last_date WHERE 0';
  const params = [...rp, ...(hasTable(db, 'fuel_deliveries') ? rp : []), ...rp, ...rp, tenantId];
  const rows = db.prepare(`
    SELECT s.id, s.sync_id, s.name AS supplier_name, s.phone, s.status AS supplier_status,
      COALESCE(g.amount, 0) + COALESCE(c.attached, 0) AS grn_purchases,
      COALESCE(g.n, 0)          AS grn_count,
      g.last_date               AS last_grn_date,
      COALESCE(g.currency, 'K') AS currency,
      COALESCE(f.amount, 0)     AS fuel_purchases,
      COALESCE(f.n, 0)          AS fuel_count,
      f.last_date               AS last_fuel_date,
      COALESCE(a.paid, 0)       AS total_paid,
      COALESCE(a.offset_1card, 0) AS offset_1card,
      COALESCE(a.n, 0)          AS pv_count,
      COALESCE(c.credits, 0)    AS total_credits,
      COALESCE(c.n, 0)          AS credit_count
    FROM suppliers s
    LEFT JOIN (
      SELECT supplier_sync_id, SUM(total_amount) AS amount, COUNT(*) AS n, MAX(date) AS last_date, ${ccy} AS currency
        FROM grn WHERE deleted_at IS NULL${range('date')} GROUP BY supplier_sync_id
    ) g ON g.supplier_sync_id = s.sync_id
    LEFT JOIN (${fuel}) f ON f.supplier_id = s.id
    LEFT JOIN (
      SELECT supplier_sync_id, SUM(amount) AS paid, COUNT(*) AS n,
             SUM(CASE WHEN COALESCE(paid_from, '') = '1Card' THEN amount ELSE 0 END) AS offset_1card
        FROM ap_payments WHERE deleted_at IS NULL${range('date')} GROUP BY supplier_sync_id
    ) a ON a.supplier_sync_id = s.sync_id
    LEFT JOIN (
      SELECT supplier_sync_id, SUM(amount) AS credits, COUNT(*) AS n,
             SUM(CASE WHEN grn_sync_id IS NOT NULL THEN amount ELSE 0 END) AS attached
        FROM supplier_credit_notes
       -- a depot's credit counts only once HQ has confirmed it (2026-09-06)
       WHERE deleted_at IS NULL AND (raised_by_branch IS NULL OR branch_confirmed_at IS NOT NULL)${range('date')}
       GROUP BY supplier_sync_id
    ) c ON c.supplier_sync_id = s.sync_id
    WHERE s.deleted_at IS NULL AND s.tenant_id = ?${activeOnly ? " AND s.status = 'Active'" : ''}
  `).all(...params);
  return rows.map((r) => {
    const total_purchases = r.grn_purchases + r.fuel_purchases;
    const balance = Math.round((total_purchases - r.total_paid - r.total_credits) * 100) / 100;
    let status = 'Unpaid';
    if (total_purchases === 0) status = 'No Purchases';
    else if (balance <= 0) status = 'Paid';
    else if (r.total_paid > 0 || r.total_credits > 0) status = 'Partial';
    const last = [r.last_grn_date, r.last_fuel_date].filter(Boolean).sort().pop() || null;
    return { ...r, total_purchases, balance, status, last_purchase_date: last };
  }).sort((x, y) => y.balance - x.balance || x.supplier_name.localeCompare(y.supplier_name));
}

function ledgerTotals(rows) {
  const sum = (k) => Math.round(rows.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100;
  return {
    totalPurchases: sum('total_purchases'),
    fuelPurchases: sum('fuel_purchases'),
    totalPaid: sum('total_paid'),
    offset1Card: sum('offset_1card'),
    totalCredits: sum('total_credits'),
    outstanding: sum('balance'),
    owed: Math.round(rows.filter((r) => r.balance > 0).reduce((s, r) => s + r.balance, 0) * 100) / 100,
    inCredit: Math.round(rows.filter((r) => r.balance < 0).reduce((s, r) => s - r.balance, 0) * 100) / 100,
    suppliers: rows.length,
    unpaidCount: rows.filter((r) => r.total_purchases > 0 && r.balance > 0.005).length,
  };
}

module.exports = { ledgerRows, ledgerTotals, hasTable, hasColumn };
