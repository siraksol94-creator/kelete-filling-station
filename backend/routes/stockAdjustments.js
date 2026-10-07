const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const vsdc = require('../services/vsdcClient');

// GET all adjustments
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT sa.*, p.name AS product_name, p.unit,
             u.first_name || ' ' || u.last_name AS created_by_name
      FROM stock_adjustments sa
      LEFT JOIN products p ON sa.product_sync_id = p.sync_id
      LEFT JOIN users u ON sa.created_by = u.id
      WHERE sa.deleted_at IS NULL AND sa.tenant_id = ?
      ORDER BY sa.created_at DESC
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET stats
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM stock_adjustments WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    const increases = db.prepare("SELECT COUNT(*) AS cnt FROM stock_adjustments WHERE deleted_at IS NULL AND tenant_id = ? AND adjustment_type = 'increase'").get(tenantId);
    const decreases = db.prepare("SELECT COUNT(*) AS cnt FROM stock_adjustments WHERE deleted_at IS NULL AND tenant_id = ? AND adjustment_type = 'decrease'").get(tenantId);
    const thisMonth = db.prepare(
      "SELECT COUNT(*) AS cnt FROM stock_adjustments WHERE deleted_at IS NULL AND tenant_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')"
    ).get(tenantId);
    res.json({
      total: total.cnt,
      increases: increases.cnt,
      decreases: decreases.cnt,
      thisMonth: thisMonth.cnt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST create adjustment
router.post('/', auth, async (req, res) => {
  try {
    const { product_id, product_sync_id: bodyProductSyncId, adjustment_type, quantity, reason, notes, date } = req.body;

    if (!product_id || !adjustment_type || !quantity) {
      return res.status(400).json({ error: 'product_id, adjustment_type, and quantity are required.' });
    }

    const result = db.transaction(() => {
      const adjNum = syncConfig.generateNumber('ADJ', 'stock_adjustments');
      const adjDate = date || new Date().toISOString().split('T')[0];
      const movementCreatedAt = adjDate + ' ' + new Date().toTimeString().slice(0, 8);
      const qty = parseFloat(quantity);
      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();

      const adjSyncId = randomUUID();
      // Prefer client-sent product_sync_id (stable across PCs).
      const adjProductSyncId = bodyProductSyncId
        || db.prepare('SELECT sync_id FROM products WHERE id = ?').get(product_id)?.sync_id
        || null;
      const info = db.prepare(
        `INSERT INTO stock_adjustments (adjustment_number, date, product_id, product_sync_id, adjustment_type, quantity, reason, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
      ).run(adjNum, adjDate, product_id, adjProductSyncId, adjustment_type, qty, reason || null, notes || null, req.user.id,
            adjSyncId, tenantId, branchId, deviceId);

      const stockDelta = adjustment_type === 'increase' ? qty : -qty;
      db.prepare(
        `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
         VALUES (?, ?, 'store', 'adjustment', ?, ?, 'adjustment', ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'), ?)`
      ).run(product_id, adjProductSyncId, stockDelta, info.lastInsertRowid, reason || null, req.user.id,
            randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, adjSyncId);

      db.prepare(
        "UPDATE products SET current_stock = current_stock + ?, updated_at = datetime('now'), synced=0 WHERE sync_id = ?"
      ).run(stockDelta, adjProductSyncId);

      return db.prepare('SELECT * FROM stock_adjustments WHERE id = ?').get(info.lastInsertRowid);
    })();

    // v1.13.78 — ZRA stock chain (checklist #27-29). Fire saveStockItems
    // + saveStockMaster with sarTyCd=06 (Adjustment In) for increases
    // and 16 (Adjustment Out) for decreases. Earlier revisions passed a
    // single '14' which mapped to Processing-Outgoing on ZRA's side.
    // The current_stock snapshot the helper reads is already the POST-
    // adjustment value because we ran it inside the transaction above.
    // Runs outside the transaction so a VSDC error doesn't unwind the
    // local write.
    let zra = { skipped: true, reason: 'not-attempted' };
    try {
      const sarTyCd = result.adjustment_type === 'increase'
        ? vsdc.SAR_TY_CD.ADJUSTMENT_IN
        : vsdc.SAR_TY_CD.ADJUSTMENT_OUT;
      zra = await vsdc.saveNonSaleStockChain(
        req.user.tenantId,
        result.id,
        { customer_name: 'Stock Adjustment', remark: result.reason || null },
        [{ product_sync_id: result.product_sync_id, quantity: result.quantity, unit: null }],
        sarTyCd
      );
    } catch (_) { /* stock-chain failure doesn't undo the adjustment */ }

    res.status(201).json({ ...result, zra });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', auth, (req, res) => {
  try {
    const { adjustment_type, quantity, reason, notes, date } = req.body;
    const adj = db.prepare('SELECT * FROM stock_adjustments WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?').get(req.params.id, req.user.tenantId);
    if (!adj) return res.status(404).json({ error: 'Adjustment not found.' });

    db.transaction(() => {
      // Reverse old stock movement. WHERE sync_id (not id) so cross-device
      // adjustments hit the right product on this PC.
      const oldDelta = adj.adjustment_type === 'increase' ? -adj.quantity : adj.quantity;
      db.prepare("UPDATE products SET current_stock = current_stock + ?, updated_at=datetime('now'), synced=0 WHERE sync_id=?").run(oldDelta, adj.product_sync_id);

      // Apply new values
      const newQty = parseFloat(quantity);
      const newDelta = adjustment_type === 'increase' ? newQty : -newQty;
      db.prepare("UPDATE products SET current_stock = current_stock + ?, updated_at=datetime('now'), synced=0 WHERE sync_id=?").run(newDelta, adj.product_sync_id);

      // Update movement record
      db.prepare("UPDATE stock_movements SET quantity=?, notes=?, updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='adjustment' AND deleted_at IS NULL").run(newDelta, reason || null, adj.sync_id);

      // Update adjustment
      db.prepare("UPDATE stock_adjustments SET adjustment_type=?, quantity=?, reason=?, notes=?, date=?, updated_at=datetime('now'), synced=0 WHERE id=?")
        .run(adjustment_type, newQty, reason || null, notes || null, date || adj.date, adj.id);
    })();

    const updated = db.prepare('SELECT * FROM stock_adjustments WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', auth, (req, res) => {
  try {
    db.transaction(() => {
      const adj = db.prepare('SELECT * FROM stock_adjustments WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
      if (!adj) throw Object.assign(new Error('Adjustment not found.'), { status: 404 });

      const stockDelta = adj.adjustment_type === 'increase' ? -adj.quantity : adj.quantity;
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='adjustment' AND deleted_at IS NULL").run(adj.sync_id);
      // WHERE sync_id (not id) — cross-device safe.
      db.prepare("UPDATE products SET current_stock = current_stock + ?, updated_at=datetime('now'), synced=0 WHERE sync_id=?").run(stockDelta, adj.product_sync_id);
      db.prepare("UPDATE stock_adjustments SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(adj.id);
    })();
    res.json({ message: 'Adjustment deleted.' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
