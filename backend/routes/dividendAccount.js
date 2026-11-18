// Dividend Account — profit distribution to the owner(s).
//
// Always an outflow. Hits the Cash Book like a PV but is EXCLUDED from the
// Profit Report because dividends are paid out of retained earnings, not
// treated as an operating expense.

const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// Resolve a shareholder_id (from frontend) into its sync_id for cross-device safety.
function lookupShareholderSyncId(req, shareholder_id) {
  if (!shareholder_id) return null;
  if (req.body.shareholder_sync_id) return req.body.shareholder_sync_id;
  const sh = db.prepare('SELECT sync_id FROM shareholders WHERE id = ?').get(shareholder_id);
  return sh?.sync_id || null;
}

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to, shareholder_id } = req.query;
    let sql = `
      SELECT d.*, sh.name AS shareholder_name,
             (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM dividend_account d
      LEFT JOIN shareholders sh ON sh.sync_id = d.shareholder_sync_id
      LEFT JOIN users u ON u.id = d.created_by
      WHERE d.deleted_at IS NULL AND d.tenant_id = ?
    `;
    const params = [req.user.tenantId];
    if (from) { sql += ' AND d.date >= ?'; params.push(from); }
    if (to)   { sql += ' AND d.date <= ?'; params.push(to); }
    if (shareholder_id) { sql += ' AND d.shareholder_id = ?'; params.push(parseInt(shareholder_id)); }
    sql += ' ORDER BY d.date DESC, d.id DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ────────────────────────────────────────────────────────────────────
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const total      = db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM dividend_account WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId).s;
    const thisMonth  = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM dividend_account WHERE deleted_at IS NULL AND tenant_id = ? AND strftime('%Y-%m', date) = strftime('%Y-%m','now')").get(tenantId).s;
    const count      = db.prepare('SELECT COUNT(*) AS cnt FROM dividend_account WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId).cnt;
    res.json({
      totalPaid:      parseFloat(total),
      thisMonthPaid:  parseFloat(thisMonth),
      count,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single ───────────────────────────────────────────────────────────────────
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT d.*, (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM dividend_account d
      LEFT JOIN users u ON u.id = d.created_by
      WHERE d.id = ? AND d.tenant_id = ?
    `).get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Dividend entry not found.' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create ───────────────────────────────────────────────────────────────────
router.post('/', auth, (req, res) => {
  try {
    const { recipient, shareholder_id, date, description, invoice_attachment,
            cash_amount, bank_amount, momo_amount } = req.body || {};
    const cash = parseFloat(cash_amount) || 0;
    const bank = parseFloat(bank_amount) || 0;
    const momo = parseFloat(momo_amount) || 0;
    const total = cash + bank + momo;
    if (!(total > 0)) return res.status(400).json({ error: 'Total amount must be greater than zero.' });

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const entryNumber = syncConfig.generateNumber('DIV', 'dividend_account');
    const entryDate   = date || new Date().toISOString().split('T')[0];
    const shareholderSyncId = lookupShareholderSyncId(req, shareholder_id);

    const info = db.prepare(`
      INSERT INTO dividend_account (entry_number, date, recipient, shareholder_id, shareholder_sync_id, amount,
                                     cash_amount, bank_amount, momo_amount,
                                     description, invoice_attachment, created_by,
                                     sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(entryNumber, entryDate, recipient || null,
           shareholder_id ? parseInt(shareholder_id) : null, shareholderSyncId, total,
           cash, bank, momo,
           description || null, invoice_attachment || null, req.user.id,
           randomUUID(), tenantId, branchId, deviceId);
    res.status(201).json(db.prepare('SELECT * FROM dividend_account WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update ───────────────────────────────────────────────────────────────────
router.put('/:id', auth, (req, res) => {
  try {
    const { recipient, shareholder_id, date, description, invoice_attachment,
            cash_amount, bank_amount, momo_amount } = req.body || {};
    const cash = parseFloat(cash_amount) || 0;
    const bank = parseFloat(bank_amount) || 0;
    const momo = parseFloat(momo_amount) || 0;
    const total = cash + bank + momo;
    if (!(total > 0)) return res.status(400).json({ error: 'Total amount must be greater than zero.' });

    const shareholderSyncId = lookupShareholderSyncId(req, shareholder_id);
    const keepAttachment = invoice_attachment === undefined;
    const sql = keepAttachment
      ? `UPDATE dividend_account
            SET recipient=?, shareholder_id=?, shareholder_sync_id=?, date=?, amount=?,
                cash_amount=?, bank_amount=?, momo_amount=?,
                description=?, updated_at=datetime('now'), synced=0
          WHERE id=? AND tenant_id=?`
      : `UPDATE dividend_account
            SET recipient=?, shareholder_id=?, shareholder_sync_id=?, date=?, amount=?,
                cash_amount=?, bank_amount=?, momo_amount=?,
                description=?, invoice_attachment=?, updated_at=datetime('now'), synced=0
          WHERE id=? AND tenant_id=?`;
    const args = keepAttachment
      ? [recipient || null, shareholder_id ? parseInt(shareholder_id) : null, shareholderSyncId,
         date, total, cash, bank, momo, description || null,
         req.params.id, req.user.tenantId]
      : [recipient || null, shareholder_id ? parseInt(shareholder_id) : null, shareholderSyncId,
         date, total, cash, bank, momo, description || null,
         invoice_attachment || null, req.params.id, req.user.tenantId];
    const info = db.prepare(sql).run(...args);
    if (info.changes === 0) return res.status(404).json({ error: 'Dividend entry not found.' });
    res.json(db.prepare('SELECT * FROM dividend_account WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Delete (soft) ────────────────────────────────────────────────────────────
router.delete('/:id', auth, (req, res) => {
  try {
    const info = db.prepare("UPDATE dividend_account SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=? AND tenant_id=? AND deleted_at IS NULL").run(req.params.id, req.user.tenantId);
    if (info.changes === 0) return res.status(404).json({ error: 'Dividend entry not found.' });
    res.json({ message: 'Dividend entry deleted.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
