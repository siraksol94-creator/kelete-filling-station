const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit, reapplyReconciliation } = require('../config/profitHelper');
const { conversionToBase } = require('../config/unitsHelper');

router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM siv WHERE deleted_at IS NULL AND tenant_id = ? ORDER BY created_at DESC').all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM siv WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    const thisMonth = db.prepare("SELECT COUNT(*) AS cnt FROM siv WHERE deleted_at IS NULL AND tenant_id = ? AND date >= date('now', 'start of month')").get(tenantId);
    const totalValue = db.prepare('SELECT COALESCE(SUM(total_value), 0) AS total FROM siv WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    const pending = db.prepare("SELECT COUNT(*) AS cnt FROM siv WHERE deleted_at IS NULL AND tenant_id = ? AND status = 'Pending'").get(tenantId);
    res.json({
      totalSIVs: total.cnt,
      thisMonth: thisMonth.cnt,
      totalValue: parseFloat(totalValue.total),
      pending: pending.cnt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', auth, (req, res) => {
  try {
    const { department, items, notes, date, production_id, production_sync_id } = req.body;
    const siv = db.transaction(() => {
      const sivNum = syncConfig.generateNumber('SIV', 'siv');
      const sivDate = date || new Date().toISOString().split('T')[0];
      const totalValue = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();

      const sivSyncId = randomUUID();
      const info = db.prepare(
        `INSERT INTO siv (siv_number, date, department, total_items, total_value, notes, created_by, status, production_id, production_sync_id, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,'Issued',?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
      ).run(sivNum, sivDate, department, items.length, totalValue, notes, req.user.id,
            production_id || null, production_sync_id || null,
            sivSyncId, tenantId, branchId, deviceId);
      const sivId = info.lastInsertRowid;

      for (const item of items) {
        const prod = db.prepare('SELECT sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?').get(item.product_id);
        // Prefer client-sent product_sync_id (stable across PCs).
        const productSyncId = item.product_sync_id || prod?.sync_id || null;
        const lineUnit = (item.unit || '').trim() || prod?.unit || null;
        const baseQty = parseFloat(item.quantity) * conversionToBase(prod, lineUnit);
        db.prepare(
          "INSERT INTO siv_items (siv_id, siv_sync_id, product_id, product_sync_id, quantity, unit, unit_price, total_price, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))"
        ).run(sivId, sivSyncId, item.product_id, productSyncId, item.quantity, lineUnit, item.unit_price, item.quantity * item.unit_price,
              randomUUID(), tenantId, branchId, deviceId);
        db.prepare(
          `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)`
        ).run(item.product_id, productSyncId, 'store', 'siv', -baseQty, sivId, 'siv', req.user.id,
              randomUUID(), tenantId, branchId, deviceId, sivDate, sivSyncId);
        db.prepare(
          `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)`
        ).run(item.product_id, productSyncId, 'sales', 'siv', baseQty, sivId, 'siv', req.user.id,
              randomUUID(), tenantId, branchId, deviceId, sivDate, sivSyncId);
      }

      return db.prepare('SELECT * FROM siv WHERE id = ?').get(sivId);
    })();
    recalculateDailyProfit(db, siv.date, req.user.tenantId);
    // Re-apply reconciliation for affected products if actual balance was already saved
    const { branchId, deviceId } = syncConfig.getConfig();
    const productSyncIds = items.map(i => db.prepare('SELECT sync_id FROM products WHERE id = ?').get(i.product_id)?.sync_id).filter(Boolean);
    reapplyReconciliation(db, siv.date, productSyncIds, req.user.tenantId, branchId, deviceId, req.user.id);
    res.status(201).json(siv);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/items-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to } = req.query;
    let sql = `
      SELECT p.id AS product_id, p.name AS product_name, p.unit,
        p.category_id, c.name AS category_name, c.main_category_id,
        SUM(si.quantity) AS total_quantity,
        SUM(si.total_price) AS total_value
      FROM siv_items si
      JOIN siv s ON s.sync_id = si.siv_sync_id
      JOIN products p ON p.sync_id = si.product_sync_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE s.deleted_at IS NULL AND s.tenant_id = ?
    `;
    const params = [req.user.tenantId];
    if (from) { sql += ' AND s.date >= ?'; params.push(from); }
    if (to)   { sql += ' AND s.date <= ?'; params.push(to); }
    sql += ' GROUP BY p.sync_id, p.name, p.unit, p.category_id, c.name, c.main_category_id ORDER BY p.name ASC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/item-breakdown', auth, readOnlyGuard, (req, res) => {
  try {
    const { product_id, from, to } = req.query;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });
    let sql = `
      SELECT s.siv_number, s.date, s.created_at, si.quantity, si.unit_price, si.total_price
      FROM siv_items si
      JOIN siv s ON s.sync_id = si.siv_sync_id
      WHERE si.product_sync_id = (SELECT sync_id FROM products WHERE id = ?) AND s.deleted_at IS NULL AND s.tenant_id = ?
    `;
    const params = [product_id, req.user.tenantId];
    if (from) { sql += ' AND s.date >= ?'; params.push(from); }
    if (to)   { sql += ' AND s.date <= ?'; params.push(to); }
    sql += ' ORDER BY s.created_at DESC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /recent-products — return last used products in SIV for quick-add chips
router.get('/recent-products', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id AS product_id, p.name AS product_name, p.unit
      FROM siv_items si
      JOIN products p ON p.sync_id = si.product_sync_id
      JOIN siv s ON s.id = si.siv_id
      WHERE s.deleted_at IS NULL AND si.deleted_at IS NULL AND s.tenant_id = ?
      GROUP BY p.id
      ORDER BY MAX(s.created_at) DESC
      LIMIT 10
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /notes — return distinct past notes for autocomplete
router.get('/notes', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT notes, MAX(created_at) AS last_used FROM siv WHERE deleted_at IS NULL AND tenant_id = ? AND notes IS NOT NULL AND notes != '' GROUP BY notes ORDER BY last_used DESC LIMIT 50"
    ).all(req.user.tenantId);
    res.json(rows.map(r => r.notes));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const siv = db.prepare(`SELECT s.*, u.first_name || ' ' || u.last_name AS created_by_name FROM siv s LEFT JOIN users u ON s.created_by = u.id WHERE s.id = ? AND s.deleted_at IS NULL AND s.tenant_id = ?`).get(req.params.id, req.user.tenantId);
    // Aliasing p.unit → product_unit is critical: si.* already exposes si.unit
    // (the unit the SIV line was issued in, e.g. "Box"). Selecting p.unit unaliased
    // creates a duplicate-name collision; the second column wins and the frontend
    // ends up showing the product's base unit ("pcs") even when the line is in Box.
    const items = db.prepare(
      'SELECT si.*, p.name as product_name, p.unit AS product_unit FROM siv_items si LEFT JOIN products p ON si.product_sync_id = p.sync_id WHERE si.siv_sync_id = (SELECT sync_id FROM siv WHERE id = ? AND tenant_id = ?) AND si.deleted_at IS NULL'
    ).all(req.params.id, req.user.tenantId);
    res.json({ ...siv, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', auth, (req, res) => {
  try {
    const { department, date, notes, items } = req.body;
    const sivId = req.params.id;
    const existingSiv = db.prepare('SELECT sync_id, source_grn_sync_id, siv_number FROM siv WHERE id = ? AND deleted_at IS NULL').get(sivId);
    if (!existingSiv) return res.status(404).json({ error: 'SIV not found' });
    // Auto-SIVs are owned by their source GRN. We still allow a date/notes refresh
    // (so stock_movements can pick up the GRN's business date), but the items
    // array from the request is ignored — we re-use the existing siv_items.
    const isAutoSiv = !!existingSiv.source_grn_sync_id;
    const effectiveItems = isAutoSiv
      ? db.prepare('SELECT product_id, product_sync_id, quantity, unit, unit_price FROM siv_items WHERE siv_sync_id = ? AND deleted_at IS NULL').all(existingSiv.sync_id)
      : items;
    const sivDate = date || new Date().toISOString().split('T')[0];
    const totalValue = effectiveItems.reduce((sum, item) => sum + item.quantity * (item.unit_price || 0), 0);
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    // Tag re-inserted stock_movements with the SIV's business date.
    const movementCreatedAt = sivDate + ' ' + new Date().toTimeString().slice(0, 8);

    db.transaction(() => {
      db.prepare("UPDATE siv SET date=?, department=?, total_items=?, total_value=?, notes=?, updated_at=datetime('now'), synced=0 WHERE id=?").run(
        sivDate, department, effectiveItems.length, totalValue, notes, sivId
      );
      const sivRecord = db.prepare('SELECT sync_id FROM siv WHERE id=?').get(sivId);
      const sivSyncId = sivRecord?.sync_id;

      db.prepare("UPDATE siv_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE siv_sync_id=? AND deleted_at IS NULL").run(sivSyncId);
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='siv' AND deleted_at IS NULL").run(sivSyncId);

      for (const item of effectiveItems) {
        const prod = db.prepare('SELECT sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?').get(item.product_id);
        const productSyncId = item.product_sync_id || prod?.sync_id || null;
        const lineUnit = (item.unit || '').trim() || prod?.unit || null;
        const baseQty = parseFloat(item.quantity) * conversionToBase(prod, lineUnit);
        db.prepare("INSERT INTO siv_items (siv_id, siv_sync_id, product_id, product_sync_id, quantity, unit, unit_price, total_price, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))").run(
          sivId, sivSyncId, item.product_id, productSyncId, item.quantity, lineUnit, item.unit_price || 0, item.quantity * (item.unit_price || 0),
          randomUUID(), tenantId, branchId, deviceId
        );
        db.prepare(`INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id) VALUES (?,?,'store','siv',?,?,'siv',?,?,?,?,?,0,?,datetime('now'),?)`).run(
          item.product_id, productSyncId, -baseQty, sivId, req.user.id, randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, sivSyncId
        );
        db.prepare(`INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id) VALUES (?,?,'sales','siv',?,?,'siv',?,?,?,?,?,0,?,datetime('now'),?)`).run(
          item.product_id, productSyncId, baseQty, sivId, req.user.id, randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, sivSyncId
        );
      }
    })();

    const updated = db.prepare('SELECT * FROM siv WHERE id=?').get(sivId);
    recalculateDailyProfit(db, sivDate, req.user.tenantId);
    const { branchId: bId, deviceId: dId } = syncConfig.getConfig();
    const editSyncIds = effectiveItems.map(i => db.prepare('SELECT sync_id FROM products WHERE id = ?').get(i.product_id)?.sync_id).filter(Boolean);
    reapplyReconciliation(db, sivDate, editSyncIds, req.user.tenantId, bId, dId, req.user.id);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const siv = db.prepare('SELECT sync_id, date, tenant_id, source_grn_sync_id, siv_number FROM siv WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!siv) return res.status(404).json({ error: 'SIV not found' });
    // Auto-SIVs (those linked to a GRN) cannot be deleted directly — their lifecycle is
    // owned by the source GRN. Deleting one here would leave the GRN's stock in the store
    // location with no way to issue it. Delete the GRN instead and this SIV cascades with it.
    if (siv.source_grn_sync_id) {
      const grn = db.prepare('SELECT grn_number FROM grn WHERE sync_id = ?').get(siv.source_grn_sync_id);
      return res.status(400).json({
        error: `${siv.siv_number} was auto-generated from ${grn?.grn_number || 'a GRN'}. Delete the source GRN instead — this SIV will be removed with it.`,
      });
    }
    // Collect product sync IDs before deleting
    const sivItems = db.prepare('SELECT product_sync_id FROM siv_items WHERE siv_sync_id = ? AND deleted_at IS NULL').all(siv.sync_id);
    const delSyncIds = sivItems.map(i => i.product_sync_id).filter(Boolean);
    db.transaction(() => {
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='siv' AND deleted_at IS NULL").run(siv.sync_id);
      db.prepare("UPDATE siv_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE siv_sync_id=?").run(siv.sync_id);
      db.prepare("UPDATE siv SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    })();
    recalculateDailyProfit(db, siv.date, req.user.tenantId);
    const { branchId: dBranchId, deviceId: dDeviceId } = syncConfig.getConfig();
    reapplyReconciliation(db, siv.date, delSyncIds, req.user.tenantId, dBranchId, dDeviceId, req.user.id);
    res.json({ message: 'SIV deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
