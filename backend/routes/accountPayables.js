const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');

// Supplier ledger — derived from GRN (owed) and AP Payments (paid).
// Optional from/to params restrict the GRN + payment activity to a date range so
// the page shows a period view (totals = period activity, not all-time).
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to } = req.query;
    const grnDateClause = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const apDateClause  = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const cnDateClause  = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const grnParams = [...(from ? [from] : []), ...(to ? [to] : [])];
    const apParams  = [...(from ? [from] : []), ...(to ? [to] : [])];
    const cnParams  = [...(from ? [from] : []), ...(to ? [to] : [])];
    const rows = db.prepare(`
      SELECT
        s.id,
        s.sync_id,
        s.name AS supplier_name,
        s.phone,
        -- 2026-09-05 — purchases are shown GROSS, the way GRN Archive shows them:
        --     Total Purchases  12,049,571.63
        --     Credit Notes       -150,181.78
        --     Payable         11,899,389.85
        --
        -- grn.total_amount holds final_payable - the invoice ALREADY less its
        -- credit notes - so this page printed 11,899,389.85 as "Total
        -- Purchases" and then had nothing left to put in the Credits column.
        -- Adding the attached credits back gives the invoice total, and every
        -- credit note is then deducted once, in the open, where it can be
        -- checked against the supplier's own statement. The balance is
        -- identical either way.
        (COALESCE(grn_totals.total_amount, 0) + COALESCE(cn_totals.attached_credits, 0)) AS total_purchases,
        COALESCE(grn_totals.grn_count, 0)    AS grn_count,
        grn_totals.last_grn_date,
        -- v1.10.79 — currency of the supplier's most-used cost_currency.
        -- NULL rows count as 'K' (default from the v1.10.79 backfill).
        COALESCE(grn_totals.currency, 'K')   AS currency,
        COALESCE(ap_totals.total_paid, 0)    AS total_paid,
        COALESCE(ap_totals.ap_count, 0)      AS pv_count,
        COALESCE(cn_totals.total_credits, 0) AS total_credits,
        COALESCE(cn_totals.cn_count, 0)      AS credit_count,
        (COALESCE(grn_totals.total_amount, 0) + COALESCE(cn_totals.attached_credits, 0))
          - COALESCE(ap_totals.total_paid, 0)
          - COALESCE(cn_totals.total_credits, 0) AS balance,
        CASE
          WHEN (COALESCE(grn_totals.total_amount, 0) + COALESCE(cn_totals.attached_credits, 0)) = 0 THEN 'No Purchases'
          WHEN (COALESCE(grn_totals.total_amount, 0) + COALESCE(cn_totals.attached_credits, 0)) - COALESCE(ap_totals.total_paid, 0) - COALESCE(cn_totals.total_credits, 0) <= 0 THEN 'Paid'
          WHEN COALESCE(ap_totals.total_paid, 0) > 0 OR COALESCE(cn_totals.total_credits, 0) > 0                  THEN 'Partial'
          ELSE 'Unpaid'
        END AS status
      FROM suppliers s
      LEFT JOIN (
        SELECT supplier_sync_id,
          SUM(total_amount) AS total_amount,
          COUNT(*) AS grn_count,
          MAX(date) AS last_grn_date,
          -- v1.10.79 — majority currency across the supplier's GRNs.
          -- NULL / empty rows normalise to 'K'.
          (SELECT COALESCE(NULLIF(UPPER(g2.cost_currency), ''), 'K')
             FROM grn g2
            WHERE g2.supplier_sync_id = grn.supplier_sync_id
              AND g2.deleted_at IS NULL
            GROUP BY COALESCE(NULLIF(UPPER(g2.cost_currency), ''), 'K')
            ORDER BY COUNT(*) DESC LIMIT 1) AS currency
        FROM grn
        WHERE deleted_at IS NULL${grnDateClause}
        GROUP BY supplier_sync_id
      ) grn_totals ON s.sync_id = grn_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id,
          SUM(amount) AS total_paid,
          COUNT(*) AS ap_count
        FROM ap_payments
        WHERE deleted_at IS NULL${apDateClause}
        GROUP BY supplier_sync_id
      ) ap_totals ON s.sync_id = ap_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id,
          SUM(amount) AS total_credits,
          -- the part already taken off grn.total_amount, added back above
          SUM(CASE WHEN grn_sync_id IS NOT NULL THEN amount ELSE 0 END) AS attached_credits,
          COUNT(*) AS cn_count
        FROM supplier_credit_notes
        -- 2026-09-06 — a depot's credit counts only once HQ has confirmed it.
        -- Until then it is a claim: the goods have left the shelf, but what
        -- the supplier owes has not been agreed. HQ's own credits are
        -- immediate - raised_by_branch is NULL on those.
        WHERE deleted_at IS NULL AND (raised_by_branch IS NULL OR branch_confirmed_at IS NOT NULL)${cnDateClause}
        GROUP BY supplier_sync_id
      ) cn_totals ON s.sync_id = cn_totals.supplier_sync_id
      WHERE s.status = 'Active' AND s.deleted_at IS NULL AND s.tenant_id = ?
      ORDER BY balance DESC
    `).all(...grnParams, ...apParams, ...cnParams, req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats derived from supplier ledger. from/to filter GRN/payment activity to a period.
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const { from, to } = req.query;
    const grnDateClause = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const apDateClause  = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const cnDateClause  = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const grnParams = [...(from ? [from] : []), ...(to ? [to] : [])];
    const apParams  = [...(from ? [from] : []), ...(to ? [to] : [])];
    const cnParams  = [...(from ? [from] : []), ...(to ? [to] : [])];

    const row = db.prepare(`
      SELECT
        COALESCE(SUM(grn_totals.total_amount), 0)
          + COALESCE(SUM(cn_totals.attached_credits), 0) AS total_purchases,
        COALESCE(SUM(ap_totals.total_paid), 0)     AS total_paid,
        COALESCE(SUM(cn_totals.total_credits), 0)  AS total_credits,
        COALESCE(SUM(grn_totals.total_amount), 0)
          + COALESCE(SUM(cn_totals.attached_credits), 0)
          - COALESCE(SUM(ap_totals.total_paid), 0)
          - COALESCE(SUM(cn_totals.total_credits), 0) AS outstanding
      FROM suppliers s
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(total_amount) AS total_amount
        FROM grn WHERE deleted_at IS NULL${grnDateClause} GROUP BY supplier_sync_id
      ) grn_totals ON s.sync_id = grn_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(amount) AS total_paid
        FROM ap_payments WHERE deleted_at IS NULL${apDateClause}
        GROUP BY supplier_sync_id
      ) ap_totals ON s.sync_id = ap_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(amount) AS total_credits,
               SUM(CASE WHEN grn_sync_id IS NOT NULL THEN amount ELSE 0 END) AS attached_credits
        FROM supplier_credit_notes
        -- 2026-09-06 — a depot's credit counts only once HQ has confirmed it.
        -- Until then it is a claim: the goods have left the shelf, but what
        -- the supplier owes has not been agreed. HQ's own credits are
        -- immediate - raised_by_branch is NULL on those.
        WHERE deleted_at IS NULL AND (raised_by_branch IS NULL OR branch_confirmed_at IS NOT NULL)${cnDateClause}
        GROUP BY supplier_sync_id
      ) cn_totals ON s.sync_id = cn_totals.supplier_sync_id
      WHERE s.status = 'Active' AND s.deleted_at IS NULL AND s.tenant_id = ?
    `).get(...grnParams, ...apParams, ...cnParams, tenantId);

    const supplierCount = db.prepare("SELECT COUNT(*) AS cnt FROM suppliers WHERE status = 'Active' AND deleted_at IS NULL AND tenant_id = ?").get(tenantId);
    const unpaid = db.prepare(`
      SELECT COUNT(*) AS cnt FROM suppliers s
      INNER JOIN (
        SELECT supplier_sync_id, SUM(total_amount) AS total_amount
        FROM grn WHERE deleted_at IS NULL${grnDateClause} GROUP BY supplier_sync_id
      ) grn_totals ON s.sync_id = grn_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(amount) AS total_paid
        FROM ap_payments WHERE deleted_at IS NULL${apDateClause}
        GROUP BY supplier_sync_id
      ) ap_totals ON s.sync_id = ap_totals.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(amount) AS total_credits,
               SUM(CASE WHEN grn_sync_id IS NOT NULL THEN amount ELSE 0 END) AS attached_credits
        FROM supplier_credit_notes
        -- 2026-09-06 — a depot's credit counts only once HQ has confirmed it.
        -- Until then it is a claim: the goods have left the shelf, but what
        -- the supplier owes has not been agreed. HQ's own credits are
        -- immediate - raised_by_branch is NULL on those.
        WHERE deleted_at IS NULL AND (raised_by_branch IS NULL OR branch_confirmed_at IS NOT NULL)${cnDateClause}
        GROUP BY supplier_sync_id
      ) cn_totals ON s.sync_id = cn_totals.supplier_sync_id
      WHERE s.status = 'Active' AND s.deleted_at IS NULL AND s.tenant_id = ?
        AND grn_totals.total_amount + COALESCE(cn_totals.attached_credits, 0)
            - COALESCE(ap_totals.total_paid, 0) - COALESCE(cn_totals.total_credits, 0) > 0
    `).get(...grnParams, ...apParams, ...cnParams, tenantId);

    res.json({
      totalPurchases: parseFloat(row.total_purchases),
      totalPaid: parseFloat(row.total_paid),
      totalCredits: parseFloat(row.total_credits),
      outstanding: parseFloat(row.outstanding),
      suppliers: supplierCount.cnt,
      unpaidCount: unpaid.cnt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Supplier breakdown — GRNs + AP payments
router.get('/breakdown/:supplierId', auth, readOnlyGuard, (req, res) => {
  try {
    const supplierId = parseInt(req.params.supplierId);
    const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ? AND tenant_id = ?').get(supplierId, req.user.tenantId);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });

    // total_amount is final_payable; cn_amount is what was taken off it, so
    // the statement can print the invoice total and deduct the credit notes
    // itself, exactly as the supplier's own statement does.
    const grns = db.prepare(`
      SELECT g.id, g.grn_number, g.date, g.total_amount, g.notes,
             COALESCE((SELECT SUM(c.amount) FROM supplier_credit_notes c
                        WHERE c.grn_sync_id = g.sync_id AND c.deleted_at IS NULL
                          AND (c.raised_by_branch IS NULL OR c.branch_confirmed_at IS NOT NULL)), 0) AS cn_amount
      FROM grn g WHERE g.supplier_sync_id = ? AND g.deleted_at IS NULL AND g.tenant_id = ?
      ORDER BY g.date ASC
    `).all(supplier.sync_id, req.user.tenantId);

    const payments = db.prepare(`
      SELECT id, payment_number, date, amount, description, paid_from
      FROM ap_payments WHERE supplier_id = ? AND deleted_at IS NULL AND tenant_id = ? ORDER BY date ASC
    `).all(supplierId, req.user.tenantId);

    // Every credit note, attached to a GRN or not. The Purchases list above
    // is gross, so each one is deducted here exactly once.
    const credits = db.prepare(`
      SELECT id, credit_note_number, date, amount, reason, reference, notes, grn_sync_id
      FROM supplier_credit_notes
      WHERE supplier_sync_id = ? AND deleted_at IS NULL AND tenant_id = ?
        AND (raised_by_branch IS NULL OR branch_confirmed_at IS NOT NULL)
      ORDER BY date ASC
    `).all(supplier.sync_id, req.user.tenantId);

    res.json({ supplier, grns, payments, credits });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
