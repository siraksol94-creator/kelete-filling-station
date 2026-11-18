const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const { isHqRequest, pushUnitToBranches } = require('../middleware/hqPush');
const { listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// GET /api/units — list all units for this tenant.
// On first call (when tenant has zero units ever), auto-imports distinct unit
// values from products so the existing data isn't lost.
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    // Check if any units record exists for this tenant (including soft-deleted).
    // This ensures auto-import only runs once per tenant — once they have units
    // (even deleted ones), we don't re-import.
    const everExisted = db.prepare('SELECT COUNT(*) AS cnt FROM units WHERE tenant_id = ?').get(tenantId);

    if (everExisted.cnt === 0) {
      // First-time auto-import: scan products for distinct unit values
      const productUnits = db.prepare(`
        SELECT DISTINCT unit FROM products
        WHERE tenant_id = ? AND deleted_at IS NULL AND unit IS NOT NULL AND TRIM(unit) != ''
      `).all(tenantId);

      if (productUnits.length > 0) {
        const cfg = syncConfig.getConfig();
        const branchId = cfg.branchId;
        const deviceId = cfg.deviceId;
        const insertStmt = db.prepare(
          "INSERT INTO units (name, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))"
        );
        db.transaction(() => {
          for (const { unit } of productUnits) {
            insertStmt.run(unit.trim(), randomUUID(), tenantId, branchId, deviceId);
          }
        })();
      }
    }

    const rows = db.prepare(
      'SELECT * FROM units WHERE deleted_at IS NULL AND tenant_id = ? ORDER BY name'
    ).all(tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/units — create. On HQ host, also pushes to every branch.
router.post('/', auth, (req, res) => {
  try {
    const { name, abbreviation } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const fromHq = isHqRequest(req);
    const info = db.prepare(
      "INSERT INTO units (name, abbreviation, is_hq_owned, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))"
    ).run(name.trim(), (abbreviation || '').trim() || null, fromHq ? 1 : 0, randomUUID(), tenantId, branchId, deviceId);
    const row = db.prepare('SELECT * FROM units WHERE id = ?').get(info.lastInsertRowid);
    if (fromHq) {
      try { pushUnitToBranches(row, { listTenants, getTenantDb }); } catch (_) {}
    }
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/units/:id — edit. HQ-owned rows reject branch edits.
router.put('/:id', auth, (req, res) => {
  try {
    const { name, abbreviation } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const existing = db.prepare('SELECT id, is_hq_owned FROM units WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Unit not found' });
    const fromHq = isHqRequest(req);
    if (existing.is_hq_owned && !fromHq) {
      return res.status(403).json({ error: 'This unit is managed by HQ and cannot be edited at the branch.' });
    }
    db.prepare(
      "UPDATE units SET name=?, abbreviation=?, updated_at=datetime('now'), synced=0 WHERE id=?"
    ).run(name.trim(), (abbreviation || '').trim() || null, req.params.id);
    const row = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
    if (fromHq) {
      try { pushUnitToBranches(row, { listTenants, getTenantDb }); } catch (_) {}
    }
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/units/:id — blocked if any product uses this unit (base or alt)
router.delete('/:id', auth, (req, res) => {
  try {
    const u = db.prepare('SELECT id, name, is_hq_owned, sync_id FROM units WHERE id = ?').get(req.params.id);
    if (!u) return res.status(404).json({ error: 'Unit not found' });
    const fromHq = isHqRequest(req);
    if (u.is_hq_owned && !fromHq) {
      return res.status(403).json({ error: 'This unit is managed by HQ and cannot be deleted at the branch.' });
    }

    const usingProducts = db.prepare(
      "SELECT name FROM products WHERE (unit = ? OR alt_unit = ?) AND deleted_at IS NULL AND tenant_id = ? ORDER BY name LIMIT 10"
    ).all(u.name, u.name, req.user.tenantId);

    if (usingProducts.length > 0) {
      const totalCount = db.prepare(
        "SELECT COUNT(*) AS c FROM products WHERE (unit = ? OR alt_unit = ?) AND deleted_at IS NULL AND tenant_id = ?"
      ).get(u.name, u.name, req.user.tenantId).c;
      const names = usingProducts.map(p => p.name).join(', ');
      const more = totalCount > usingProducts.length ? ` and ${totalCount - usingProducts.length} more` : '';
      return res.status(400).json({
        error: `Cannot delete unit "${u.name}" — it is used by ${totalCount} product(s): ${names}${more}. Change those products' units first.`
      });
    }

    db.prepare(
      "UPDATE units SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?"
    ).run(req.params.id);
    if (fromHq) {
      const row = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
      try { pushUnitToBranches(row, { listTenants, getTenantDb }); } catch (_) {}
    }
    res.json({ message: 'Unit deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
