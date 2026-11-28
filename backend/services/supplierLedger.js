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

// 2026-11-28 — one supplier's statement: every purchase (GRN, fuel delivery)
// and every reduction (payment, 1Card offset, credit note), oldest first,
// with a running balance. Same rules as ledgerRows, so the closing balance
// is the figure Account Payables and Suppliers show. GRNs are listed gross
// (with any credit note attached to them added back) and every credit note
// is deducted once, as the supplier's own statement does.
// balance > 0: we owe them; < 0: they hold our money (in credit).
function supplierStatement(db, tenantId, supplierId, { from, to } = {}) {
  const s = db.prepare('SELECT * FROM suppliers WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(supplierId, tenantId);
  if (!s) return null;
  const confirmed = '(c.raised_by_branch IS NULL OR c.branch_confirmed_at IS NOT NULL)';
  const e = [];
  for (const g of db.prepare(`
      SELECT g.grn_number, g.date, g.total_amount,
             ${hasColumn(db, 'grn', 'supplier_invoice_number') ? 'g.supplier_invoice_number' : 'NULL'} AS invoice,
             COALESCE((SELECT SUM(c.amount) FROM supplier_credit_notes c
                        WHERE c.grn_sync_id = g.sync_id AND c.deleted_at IS NULL AND ${confirmed}), 0) AS cn
        FROM grn g WHERE g.supplier_sync_id = ? AND g.deleted_at IS NULL`).all(s.sync_id)) {
    e.push({ date: g.date, kind: 'grn', ref: g.grn_number, what: `GRN${g.invoice ? ` · inv ${g.invoice}` : ''}`, owed: (g.total_amount || 0) + (g.cn || 0), paid: 0 });
  }
  if (hasTable(db, 'fuel_deliveries')) {
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT d.delivery_number, d.delivery_date AS date, d.litres_delivered, d.total_cost, d.invoice_number, fg.name AS grade
          FROM fuel_deliveries d LEFT JOIN fuel_grades fg ON fg.id = d.fuel_grade_id
         WHERE d.supplier_id = ? AND COALESCE(d.status, 'Received') NOT IN ('Cancelled', 'Void')`).all(s.id);
    } catch (_) { rows = []; }
    for (const d of rows) {
      const litres = Number(d.litres_delivered || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
      e.push({ date: d.date, kind: 'fuel', ref: d.delivery_number, what: `Fuel delivery · ${litres} L${d.grade ? ` ${d.grade}` : ''}${d.invoice_number ? ` · inv ${d.invoice_number}` : ''}`, owed: d.total_cost || 0, paid: 0 });
    }
  }
  for (const a of db.prepare(`SELECT payment_number, date, amount, description, paid_from FROM ap_payments
                               WHERE supplier_sync_id = ? AND deleted_at IS NULL`).all(s.sync_id)) {
    const oneCard = String(a.paid_from || '') === '1Card';
    e.push({ date: a.date, kind: oneCard ? 'offset' : 'payment', ref: a.payment_number,
             what: oneCard ? `1Card offset${a.description ? ` · ${String(a.description).replace(/^1Card Sale\s*[—-]\s*/i, '')}` : ''}` : `Payment${a.paid_from ? ` · ${a.paid_from}` : ''}${a.description ? ` · ${a.description}` : ''}`,
             owed: 0, paid: a.amount || 0 });
  }
  for (const c of db.prepare(`SELECT c.credit_note_number, c.date, c.amount, c.reason FROM supplier_credit_notes c
                               WHERE c.supplier_sync_id = ? AND c.deleted_at IS NULL AND ${confirmed}`).all(s.sync_id)) {
    e.push({ date: c.date, kind: 'credit', ref: c.credit_note_number, what: `Credit note${c.reason ? ` · ${c.reason}` : ''}`, owed: 0, paid: c.amount || 0 });
  }
  const order = { grn: 0, fuel: 0, payment: 1, offset: 1, credit: 2 };
  e.sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')) || order[x.kind] - order[y.kind] || String(x.ref || '').localeCompare(String(y.ref || '')));
  const r2 = (n) => Math.round(n * 100) / 100;
  let bal = 0, opening = 0;
  const lines = [];
  for (const x of e) {
    bal = r2(bal + x.owed - x.paid);
    const d = String(x.date || '').slice(0, 10);
    if (from && d < from) { opening = bal; continue; }
    if (to && d > to) continue;
    lines.push({ ...x, balance: bal });
  }
  const closing = lines.length ? lines[lines.length - 1].balance : opening;
  const sum = (k) => r2(lines.reduce((t, l) => t + l[k], 0));
  return { supplier: { id: s.id, name: s.name, phone: s.phone, tpin: s.tpin || null, payment_terms: s.payment_terms || null },
           from: from || null, to: to || null, opening, owed: sum('owed'), paid: sum('paid'), closing, lines };
}

module.exports = { ledgerRows, ledgerTotals, supplierStatement, hasTable, hasColumn };
