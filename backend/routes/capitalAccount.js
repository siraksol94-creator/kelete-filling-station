// Capital Account — owner equity ledger.
//
// Two flows in one table:
//   'Injection' : owner adds money to the business → cash inflow, +equity
//   'Drawing'   : owner withdraws money            → cash outflow, -equity
//
// Hits the Cash Book like a CR (injection) or PV (drawing), but does NOT
// appear on the Profit Report — these are equity transactions, not P&L.

const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

const VALID_TYPES = ['Injection', 'Drawing'];

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to, type, shareholder_id } = req.query;
    let sql = `
      SELECT ca.*, sh.name AS shareholder_name,
             (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM capital_account ca
      LEFT JOIN shareholders sh ON sh.sync_id = ca.shareholder_sync_id
      LEFT JOIN users u ON u.id = ca.created_by
      WHERE ca.deleted_at IS NULL AND ca.tenant_id = ?
    `;
    const params = [req.user.tenantId];
    if (from) { sql += ' AND ca.date >= ?'; params.push(from); }
    if (to)   { sql += ' AND ca.date <= ?'; params.push(to); }
    if (type && VALID_TYPES.includes(type)) { sql += ' AND ca.type = ?'; params.push(type); }
    if (shareholder_id) { sql += ' AND ca.shareholder_id = ?'; params.push(parseInt(shareholder_id)); }
    sql += ' ORDER BY ca.date DESC, ca.id DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ────────────────────────────────────────────────────────────────────
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const totalInjection = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM capital_account WHERE deleted_at IS NULL AND tenant_id = ? AND type = 'Injection'").get(tenantId).s;
    const totalDrawing   = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM capital_account WHERE deleted_at IS NULL AND tenant_id = ? AND type = 'Drawing'").get(tenantId).s;
    const count          = db.prepare('SELECT COUNT(*) AS cnt FROM capital_account WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId).cnt;
    const thisMonth      = db.prepare("SELECT COUNT(*) AS cnt FROM capital_account WHERE deleted_at IS NULL AND tenant_id = ? AND strftime('%Y-%m', date) = strftime('%Y-%m','now')").get(tenantId).cnt;
    res.json({
      totalInjection: parseFloat(totalInjection),
      totalDrawing:   parseFloat(totalDrawing),
      netCapital:     parseFloat(totalInjection) - parseFloat(totalDrawing),
      count,
      thisMonth,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single ───────────────────────────────────────────────────────────────────
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT ca.*, (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM capital_account ca
      LEFT JOIN users u ON u.id = ca.created_by
      WHERE ca.id = ? AND ca.tenant_id = ?
    `).get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Capital entry not found.' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resolve a shareholder_id (from frontend) into its sync_id for cross-device safety.
function lookupShareholderSyncId(req, shareholder_id) {
  if (!shareholder_id) return null;
  if (req.body.shareholder_sync_id) return req.body.shareholder_sync_id;
  const sh = db.prepare('SELECT sync_id FROM shareholders WHERE id = ?').get(shareholder_id);
  return sh?.sync_id || null;
}

// ── Create ───────────────────────────────────────────────────────────────────
router.post('/', auth, (req, res) => {
  try {
    const { type, owner_name, shareholder_id, date, description, invoice_attachment,
            cash_amount, bank_amount, momo_amount } = req.body || {};
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: "Type must be 'Injection' or 'Drawing'." });
    const cash = parseFloat(cash_amount) || 0;
    const bank = parseFloat(bank_amount) || 0;
    const momo = parseFloat(momo_amount) || 0;
    const total = cash + bank + momo;
    if (!(total > 0)) return res.status(400).json({ error: 'Total amount must be greater than zero.' });

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const entryNumber = syncConfig.generateNumber('CAP', 'capital_account');
    const entryDate   = date || new Date().toISOString().split('T')[0];
    const shareholderSyncId = lookupShareholderSyncId(req, shareholder_id);

    const info = db.prepare(`
      INSERT INTO capital_account (entry_number, date, type, owner_name, shareholder_id, shareholder_sync_id, amount,
                                    cash_amount, bank_amount, momo_amount,
                                    description, invoice_attachment, created_by,
                                    sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(entryNumber, entryDate, type, owner_name || null,
           shareholder_id ? parseInt(shareholder_id) : null, shareholderSyncId, total,
           cash, bank, momo,
           description || null, invoice_attachment || null, req.user.id,
           randomUUID(), tenantId, branchId, deviceId);
    res.status(201).json(db.prepare('SELECT * FROM capital_account WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update ───────────────────────────────────────────────────────────────────
router.put('/:id', auth, (req, res) => {
  try {
    const { type, owner_name, shareholder_id, date, description, invoice_attachment,
            cash_amount, bank_amount, momo_amount } = req.body || {};
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: "Type must be 'Injection' or 'Drawing'." });
    const cash = parseFloat(cash_amount) || 0;
    const bank = parseFloat(bank_amount) || 0;
    const momo = parseFloat(momo_amount) || 0;
    const total = cash + bank + momo;
    if (!(total > 0)) return res.status(400).json({ error: 'Total amount must be greater than zero.' });

    const shareholderSyncId = lookupShareholderSyncId(req, shareholder_id);
    const keepAttachment = invoice_attachment === undefined;
    const sql = keepAttachment
      ? `UPDATE capital_account
            SET type=?, owner_name=?, shareholder_id=?, shareholder_sync_id=?, date=?, amount=?,
                cash_amount=?, bank_amount=?, momo_amount=?,
                description=?, updated_at=datetime('now'), synced=0
          WHERE id=? AND tenant_id=?`
      : `UPDATE capital_account
            SET type=?, owner_name=?, shareholder_id=?, shareholder_sync_id=?, date=?, amount=?,
                cash_amount=?, bank_amount=?, momo_amount=?,
                description=?, invoice_attachment=?, updated_at=datetime('now'), synced=0
          WHERE id=? AND tenant_id=?`;
    const args = keepAttachment
      ? [type, owner_name || null, shareholder_id ? parseInt(shareholder_id) : null, shareholderSyncId,
         date, total, cash, bank, momo, description || null,
         req.params.id, req.user.tenantId]
      : [type, owner_name || null, shareholder_id ? parseInt(shareholder_id) : null, shareholderSyncId,
         date, total, cash, bank, momo, description || null,
         invoice_attachment || null, req.params.id, req.user.tenantId];
    const info = db.prepare(sql).run(...args);
    if (info.changes === 0) return res.status(404).json({ error: 'Capital entry not found.' });
    res.json(db.prepare('SELECT * FROM capital_account WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Delete (soft) ────────────────────────────────────────────────────────────
router.delete('/:id', auth, (req, res) => {
  try {
    const info = db.prepare("UPDATE capital_account SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=? AND tenant_id=? AND deleted_at IS NULL").run(req.params.id, req.user.tenantId);
    if (info.changes === 0) return res.status(404).json({ error: 'Capital entry not found.' });
    res.json({ message: 'Capital entry deleted.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
