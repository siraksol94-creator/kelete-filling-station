const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');

// Supplier ledger — what each supplier is owed (services/supplierLedger.js):
// GRNs and fuel deliveries (bought), supplier payments incl. 1Card offsets
// (paid) and credit notes. Optional from/to give a period view.
const { ledgerRows, ledgerTotals } = require('../services/supplierLedger');

router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(ledgerRows(db, req.user.tenantId, { from, to }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats from the same rows, so the cards always add up to the table.
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to } = req.query;
    res.json(ledgerTotals(ledgerRows(db, req.user.tenantId, { from, to })));
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

    // 2026-11-28 — fuel deliveries are purchases from their supplier too.
    let deliveries = [];
    try {
      deliveries = db.prepare(`
        SELECT d.id, d.delivery_number, d.delivery_date AS date, d.litres_delivered, d.cost_per_litre,
               d.total_cost, d.invoice_number, g.name AS grade_name, t.code AS tank_code
          FROM fuel_deliveries d
          LEFT JOIN fuel_grades g ON g.id = d.fuel_grade_id
          LEFT JOIN tanks t ON t.id = d.tank_id
         WHERE d.supplier_id = ? AND COALESCE(d.status, 'Received') NOT IN ('Cancelled', 'Void')
         ORDER BY d.delivery_date ASC, d.id ASC
      `).all(supplierId);
    } catch (_) { /* no fuel tables on this database */ }

    res.json({ supplier, grns, deliveries, payments, credits });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
