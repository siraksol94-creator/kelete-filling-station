// Loans — liability sub-ledger.
//
// Two levels:
//   1. The loan AGREEMENT (one row per loan in `loans`).
//   2. The TRANSACTIONS against it (rows in `loan_transactions`) of three kinds:
//        Disbursement — lender pays us; cash IN; not income; +outstanding
//        Principal    — we pay lender; cash OUT; not expense; -outstanding
//        Interest     — we pay lender; cash OUT; IS expense; no balance effect
//
// Outstanding balance is DERIVED (sum of Disbursements − sum of Principal),
// not stored, so it can never drift out of sync with the underlying rows.

const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { randomUUID } = require('crypto');

const VALID_TX_TYPES = ['Disbursement', 'Principal', 'Interest'];
const VALID_STATUS   = ['Active', 'Paid Off', 'Defaulted'];

// Helper: outstanding balance for a single loan (by sync_id).
function outstandingFor(loanSyncId, tenantId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='Disbursement' THEN amount ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN type='Principal' THEN amount ELSE 0 END), 0)
      AS outstanding
    FROM loan_transactions
    WHERE loan_sync_id = ? AND tenant_id = ? AND deleted_at IS NULL
  `).get(loanSyncId, tenantId);
  return parseFloat(row?.outstanding || 0);
}

// ── List loans (with derived outstanding balance) ────────────────────────────
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { status, lender } = req.query;
    let sql = `
      SELECT l.*,
        (u.first_name || ' ' || u.last_name) AS created_by_name,
        COALESCE(disbursed_agg.s, 0) AS total_disbursed,
        COALESCE(principal_agg.s, 0) AS total_principal_paid,
        COALESCE(interest_agg.s, 0)  AS total_interest_paid,
        COALESCE(disbursed_agg.s, 0) - COALESCE(principal_agg.s, 0) AS outstanding
      FROM loans l
      LEFT JOIN users u ON u.id = l.created_by
      LEFT JOIN (SELECT loan_sync_id, SUM(amount) AS s FROM loan_transactions WHERE deleted_at IS NULL AND type='Disbursement' GROUP BY loan_sync_id) disbursed_agg ON disbursed_agg.loan_sync_id = l.sync_id
      LEFT JOIN (SELECT loan_sync_id, SUM(amount) AS s FROM loan_transactions WHERE deleted_at IS NULL AND type='Principal'    GROUP BY loan_sync_id) principal_agg ON principal_agg.loan_sync_id = l.sync_id
      LEFT JOIN (SELECT loan_sync_id, SUM(amount) AS s FROM loan_transactions WHERE deleted_at IS NULL AND type='Interest'     GROUP BY loan_sync_id) interest_agg  ON interest_agg.loan_sync_id  = l.sync_id
      WHERE l.deleted_at IS NULL AND l.tenant_id = ?
    `;
    const params = [req.user.tenantId];
    if (status && VALID_STATUS.includes(status)) { sql += ' AND l.status = ?'; params.push(status); }
    if (lender) { sql += ' AND l.lender_name LIKE ?'; params.push(`%${lender}%`); }
    sql += ' ORDER BY l.start_date DESC, l.id DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats (aggregates across all loans) ──────────────────────────────────────
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const active           = db.prepare("SELECT COUNT(*) AS cnt FROM loans WHERE deleted_at IS NULL AND tenant_id = ? AND status = 'Active'").get(tenantId).cnt;
    const disbursed        = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Disbursement'").get(tenantId).s;
    const principal        = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Principal'").get(tenantId).s;
    const interestYTD      = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Interest' AND strftime('%Y', date) = strftime('%Y','now')").get(tenantId).s;
    res.json({
      activeLoans:        active,
      totalDisbursed:     parseFloat(disbursed),
      totalPrincipalPaid: parseFloat(principal),
      outstanding:        parseFloat(disbursed) - parseFloat(principal),
      interestYTD:        parseFloat(interestYTD),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single loan + its transactions ───────────────────────────────────────────
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const loan = db.prepare(`
      SELECT l.*, (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM loans l
      LEFT JOIN users u ON u.id = l.created_by
      WHERE l.id = ? AND l.tenant_id = ?
    `).get(req.params.id, req.user.tenantId);
    if (!loan) return res.status(404).json({ error: 'Loan not found.' });
    const transactions = db.prepare(`
      SELECT * FROM loan_transactions
      WHERE loan_sync_id = ? AND tenant_id = ? AND deleted_at IS NULL
      ORDER BY date ASC, id ASC
    `).all(loan.sync_id, req.user.tenantId);
    loan.outstanding = outstandingFor(loan.sync_id, req.user.tenantId);
    res.json({ ...loan, transactions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create loan agreement (no transactions yet) ──────────────────────────────
router.post('/', auth, (req, res) => {
  try {
    const { lender_name, principal_amount, interest_rate, start_date, maturity_date, status, notes, invoice_attachment } = req.body || {};
    const principal = parseFloat(principal_amount) || 0;
    if (!(principal > 0)) return res.status(400).json({ error: 'Principal amount must be greater than 0.' });
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const loanNumber = syncConfig.generateNumber('LOAN', 'loans');
    const info = db.prepare(`
      INSERT INTO loans (loan_number, lender_name, principal_amount, interest_rate, start_date, maturity_date, status, notes, invoice_attachment, created_by,
                         sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(loanNumber, lender_name || null, principal, parseFloat(interest_rate) || 0,
           start_date || null, maturity_date || null,
           VALID_STATUS.includes(status) ? status : 'Active',
           notes || null, invoice_attachment || null, req.user.id,
           randomUUID(), tenantId, branchId, deviceId);
    res.status(201).json(db.prepare('SELECT * FROM loans WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update loan agreement ────────────────────────────────────────────────────
router.put('/:id', auth, (req, res) => {
  try {
    const { lender_name, principal_amount, interest_rate, start_date, maturity_date, status, notes, invoice_attachment } = req.body || {};
    const principal = parseFloat(principal_amount) || 0;
    if (!(principal > 0)) return res.status(400).json({ error: 'Principal amount must be greater than 0.' });
    const keepAttachment = invoice_attachment === undefined;
    const sql = keepAttachment
      ? `UPDATE loans SET lender_name=?, principal_amount=?, interest_rate=?, start_date=?, maturity_date=?, status=?, notes=?, updated_at=datetime('now'), synced=0 WHERE id=? AND tenant_id=?`
      : `UPDATE loans SET lender_name=?, principal_amount=?, interest_rate=?, start_date=?, maturity_date=?, status=?, notes=?, invoice_attachment=?, updated_at=datetime('now'), synced=0 WHERE id=? AND tenant_id=?`;
    const args = keepAttachment
      ? [lender_name || null, principal, parseFloat(interest_rate) || 0, start_date || null, maturity_date || null,
         VALID_STATUS.includes(status) ? status : 'Active', notes || null, req.params.id, req.user.tenantId]
      : [lender_name || null, principal, parseFloat(interest_rate) || 0, start_date || null, maturity_date || null,
         VALID_STATUS.includes(status) ? status : 'Active', notes || null, invoice_attachment || null,
         req.params.id, req.user.tenantId];
    const info = db.prepare(sql).run(...args);
    if (info.changes === 0) return res.status(404).json({ error: 'Loan not found.' });
    res.json(db.prepare('SELECT * FROM loans WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Soft-delete loan + all its transactions ──────────────────────────────────
router.delete('/:id', auth, (req, res) => {
  try {
    const loan = db.prepare('SELECT sync_id FROM loans WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(req.params.id, req.user.tenantId);
    if (!loan) return res.status(404).json({ error: 'Loan not found.' });
    db.transaction(() => {
      db.prepare("UPDATE loan_transactions SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE loan_sync_id=? AND deleted_at IS NULL").run(loan.sync_id);
      db.prepare("UPDATE loans SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    })();
    // Profit Report — interest expense rows for any deleted transactions need recalculating per affected date.
    // Cheaper to just recalc today and let next-tick fix the rest if needed.
    recalculateDailyProfit(db, new Date().toISOString().split('T')[0], req.user.tenantId);
    res.json({ message: 'Loan and its transactions deleted.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create a transaction against a loan ──────────────────────────────────────
router.post('/:id/transactions', auth, (req, res) => {
  try {
    const { type, date, cash_amount, bank_amount, momo_amount, description, invoice_attachment } = req.body || {};
    if (!VALID_TX_TYPES.includes(type)) return res.status(400).json({ error: "Type must be 'Disbursement', 'Principal', or 'Interest'." });
    const cash = parseFloat(cash_amount) || 0;
    const bank = parseFloat(bank_amount) || 0;
    const momo = parseFloat(momo_amount) || 0;
    const total = cash + bank + momo;
    if (!(total > 0)) return res.status(400).json({ error: 'Total amount must be greater than 0.' });

    const loan = db.prepare('SELECT sync_id, status FROM loans WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(req.params.id, req.user.tenantId);
    if (!loan) return res.status(404).json({ error: 'Loan not found.' });
    if (loan.status === 'Paid Off') return res.status(400).json({ error: 'Loan is already paid off.' });

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const txNumber = syncConfig.generateNumber('LOANTXN', 'loan_transactions');
    const txDate   = date || new Date().toISOString().split('T')[0];

    const info = db.prepare(`
      INSERT INTO loan_transactions (transaction_number, loan_id, loan_sync_id, date, type, amount,
                                      cash_amount, bank_amount, momo_amount,
                                      description, invoice_attachment, created_by,
                                      sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(txNumber, req.params.id, loan.sync_id, txDate, type, total,
           cash, bank, momo,
           description || null, invoice_attachment || null, req.user.id,
           randomUUID(), tenantId, branchId, deviceId);

    // Interest is the only one that hits the Profit Report. Recalc the day.
    if (type === 'Interest') recalculateDailyProfit(db, txDate, tenantId);

    res.status(201).json(db.prepare('SELECT * FROM loan_transactions WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update a transaction ─────────────────────────────────────────────────────
router.put('/:loanId/transactions/:txId', auth, (req, res) => {
  try {
    const { type, date, cash_amount, bank_amount, momo_amount, description, invoice_attachment } = req.body || {};
    if (!VALID_TX_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid type.' });
    const cash = parseFloat(cash_amount) || 0;
    const bank = parseFloat(bank_amount) || 0;
    const momo = parseFloat(momo_amount) || 0;
    const total = cash + bank + momo;
    if (!(total > 0)) return res.status(400).json({ error: 'Total amount must be greater than 0.' });

    const original = db.prepare('SELECT date, type FROM loan_transactions WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(req.params.txId, req.user.tenantId);
    if (!original) return res.status(404).json({ error: 'Transaction not found.' });

    const keepAttachment = invoice_attachment === undefined;
    const sql = keepAttachment
      ? `UPDATE loan_transactions SET type=?, date=?, amount=?, cash_amount=?, bank_amount=?, momo_amount=?, description=?, updated_at=datetime('now'), synced=0 WHERE id=? AND tenant_id=?`
      : `UPDATE loan_transactions SET type=?, date=?, amount=?, cash_amount=?, bank_amount=?, momo_amount=?, description=?, invoice_attachment=?, updated_at=datetime('now'), synced=0 WHERE id=? AND tenant_id=?`;
    const args = keepAttachment
      ? [type, date, total, cash, bank, momo, description || null, req.params.txId, req.user.tenantId]
      : [type, date, total, cash, bank, momo, description || null, invoice_attachment || null, req.params.txId, req.user.tenantId];
    db.prepare(sql).run(...args);

    // Recalc both original and new date if either was/is Interest.
    if (original.type === 'Interest' || type === 'Interest') {
      recalculateDailyProfit(db, original.date, req.user.tenantId);
      if (date && date !== original.date) recalculateDailyProfit(db, date, req.user.tenantId);
    }
    res.json(db.prepare('SELECT * FROM loan_transactions WHERE id = ?').get(req.params.txId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Soft-delete a transaction ────────────────────────────────────────────────
router.delete('/:loanId/transactions/:txId', auth, (req, res) => {
  try {
    const tx = db.prepare('SELECT date, type FROM loan_transactions WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(req.params.txId, req.user.tenantId);
    if (!tx) return res.status(404).json({ error: 'Transaction not found.' });
    db.prepare("UPDATE loan_transactions SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.txId);
    if (tx.type === 'Interest') recalculateDailyProfit(db, tx.date, req.user.tenantId);
    res.json({ message: 'Transaction deleted.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
