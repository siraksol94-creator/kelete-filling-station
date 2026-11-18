const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.*,
        COALESCE(g.total_purchases, 0) AS total_purchases,
        COALESCE(a.total_paid, 0) AS total_paid,
        COALESCE(g.total_purchases, 0) - COALESCE(a.total_paid, 0) AS outstanding
      FROM suppliers s
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(total_amount) AS total_purchases
        FROM grn WHERE deleted_at IS NULL GROUP BY supplier_sync_id
      ) g ON s.sync_id = g.supplier_sync_id
      LEFT JOIN (
        SELECT supplier_sync_id, SUM(amount) AS total_paid
        FROM ap_payments WHERE deleted_at IS NULL GROUP BY supplier_sync_id
      ) a ON s.sync_id = a.supplier_sync_id
      WHERE s.deleted_at IS NULL AND s.tenant_id = ? ORDER BY s.name
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM suppliers WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    const active = db.prepare("SELECT COUNT(*) AS cnt FROM suppliers WHERE deleted_at IS NULL AND tenant_id = ? AND status = 'Active'").get(tenantId);
    const outstanding = db.prepare(`
      SELECT COALESCE(SUM(COALESCE(g.total_purchases,0) - COALESCE(a.total_paid,0)), 0) AS total
      FROM suppliers s
      LEFT JOIN (SELECT supplier_sync_id, SUM(total_amount) AS total_purchases FROM grn WHERE deleted_at IS NULL GROUP BY supplier_sync_id) g ON s.sync_id = g.supplier_sync_id
      LEFT JOIN (SELECT supplier_sync_id, SUM(amount) AS total_paid FROM ap_payments WHERE deleted_at IS NULL GROUP BY supplier_sync_id) a ON s.sync_id = a.supplier_sync_id
      WHERE s.deleted_at IS NULL AND s.tenant_id = ?
    `).get(tenantId);
    res.json({
      totalSuppliers: total.cnt,
      activeAccounts: active.cnt,
      outstanding: parseFloat(outstanding.total)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', auth, (req, res) => {
  try {
    const { name, type, phone, email, address, contact_person } = req.body;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const info = db.prepare(
      "INSERT INTO suppliers (name, type, phone, email, address, contact_person, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))"
    ).run(name, type, phone, email, address, contact_person, randomUUID(), tenantId, branchId, deviceId);
    const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', auth, (req, res) => {
  try {
    const { name, type, phone, email, address, contact_person } = req.body;
    db.prepare(
      "UPDATE suppliers SET name=?, type=?, phone=?, email=?, address=?, contact_person=?, updated_at=datetime('now'), synced=0 WHERE id=?"
    ).run(name, type, phone, email, address, contact_person, req.params.id);
    const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const supplier = db.prepare('SELECT sync_id FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found.' });

    const grnCount = db.prepare('SELECT COUNT(*) AS cnt FROM grn WHERE supplier_sync_id = ? AND deleted_at IS NULL').get(supplier.sync_id);
    const apCount  = db.prepare('SELECT COUNT(*) AS cnt FROM ap_payments WHERE supplier_sync_id = ? AND deleted_at IS NULL').get(supplier.sync_id);

    if (grnCount.cnt > 0 || apCount.cnt > 0) {
      return res.status(400).json({ error: 'Cannot delete this supplier. They have existing GRN or payment records.' });
    }

    db.prepare("UPDATE suppliers SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    res.json({ message: 'Supplier deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
