// Shareholders — master list of equity holders. Used as the source for the
// dropdown on Capital Account and Dividend Account entries so per-shareholder
// reporting is consistent ("How much has Sirak invested? How much dividend
// has Nahom received?"). Doesn't touch Cash Book or Profit Report directly.

const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.*, (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM shareholders s
      LEFT JOIN users u ON u.id = s.created_by
      WHERE s.deleted_at IS NULL AND s.tenant_id = ?
      ORDER BY s.name COLLATE NOCASE
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats (per-shareholder roll-up across capital + dividend) ────────────────
// One row per shareholder with: total injected, total drawn, total dividends,
// net capital position. Drives the Shareholders page summary.
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const rows = db.prepare(`
      SELECT s.id, s.name, s.share_percentage,
        COALESCE((SELECT SUM(amount) FROM capital_account ca WHERE ca.shareholder_sync_id = s.sync_id AND ca.tenant_id = s.tenant_id AND ca.deleted_at IS NULL AND ca.type = 'Injection'), 0) AS total_injected,
        COALESCE((SELECT SUM(amount) FROM capital_account ca WHERE ca.shareholder_sync_id = s.sync_id AND ca.tenant_id = s.tenant_id AND ca.deleted_at IS NULL AND ca.type = 'Drawing'),   0) AS total_drawn,
        COALESCE((SELECT SUM(amount) FROM dividend_account d WHERE d.shareholder_sync_id  = s.sync_id AND d.tenant_id  = s.tenant_id AND d.deleted_at IS NULL),                              0) AS total_dividends
      FROM shareholders s
      WHERE s.deleted_at IS NULL AND s.tenant_id = ?
      ORDER BY s.name COLLATE NOCASE
    `).all(tenantId);
    res.json(rows.map(r => ({
      ...r,
      net_capital: parseFloat(r.total_injected) - parseFloat(r.total_drawn),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single ───────────────────────────────────────────────────────────────────
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT s.*, (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM shareholders s
      LEFT JOIN users u ON u.id = s.created_by
      WHERE s.id = ? AND s.tenant_id = ?
    `).get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Shareholder not found.' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create ───────────────────────────────────────────────────────────────────
router.post('/', auth, (req, res) => {
  try {
    const { name, email, phone, share_percentage, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const info = db.prepare(`
      INSERT INTO shareholders (name, email, phone, share_percentage, notes, created_by,
                                 sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(name.trim(), email || null, phone || null, parseFloat(share_percentage) || 0,
           notes || null, req.user.id,
           randomUUID(), tenantId, branchId, deviceId);
    res.status(201).json(db.prepare('SELECT * FROM shareholders WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update ───────────────────────────────────────────────────────────────────
router.put('/:id', auth, (req, res) => {
  try {
    const { name, email, phone, share_percentage, notes } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required.' });
    const info = db.prepare(`
      UPDATE shareholders
         SET name=?, email=?, phone=?, share_percentage=?, notes=?,
             updated_at=datetime('now'), synced=0
       WHERE id=? AND tenant_id=?
    `).run(name.trim(), email || null, phone || null, parseFloat(share_percentage) || 0,
           notes || null, req.params.id, req.user.tenantId);
    if (info.changes === 0) return res.status(404).json({ error: 'Shareholder not found.' });
    res.json(db.prepare('SELECT * FROM shareholders WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Delete (soft) ────────────────────────────────────────────────────────────
router.delete('/:id', auth, (req, res) => {
  try {
    const info = db.prepare("UPDATE shareholders SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=? AND tenant_id=? AND deleted_at IS NULL").run(req.params.id, req.user.tenantId);
    if (info.changes === 0) return res.status(404).json({ error: 'Shareholder not found.' });
    res.json({ message: 'Shareholder deleted.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
