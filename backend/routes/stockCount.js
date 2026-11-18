const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// GET /api/stock-count/sessions — list all sessions
router.get('/sessions', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT s.*, u.first_name || ' ' || u.last_name AS created_by_name,
        (SELECT COUNT(*) FROM stock_count_items WHERE session_id = s.id) AS item_count
       FROM stock_count_sessions s
       LEFT JOIN users u ON s.created_by = u.id
       WHERE s.tenant_id = ?
       ORDER BY s.created_at DESC`
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/stock-count/sessions — create new session
router.post('/sessions', auth, (req, res) => {
  try {
    const tenantId = syncConfig.getTenantId(req);
    const active = db.prepare(
      `SELECT id FROM stock_count_sessions WHERE tenant_id = ? AND status = 'Active'`
    ).get(tenantId);
    if (active) return res.status(400).json({ error: 'An active stock count session already exists.' });

    const { name } = req.body;
    const info = db.prepare(
      `INSERT INTO stock_count_sessions (name, status, created_by, tenant_id, created_at, updated_at)
       VALUES (?, 'Active', ?, ?, datetime('now'), datetime('now'))`
    ).run(name || `Stock Count ${new Date().toISOString().split('T')[0]}`, req.user.id, tenantId);
    const row = db.prepare('SELECT * FROM stock_count_sessions WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/stock-count/sessions/:id/items — get items for a session with product comparison
router.get('/sessions/:id/items', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;

    // All products for this tenant
    const products = db.prepare(
      `SELECT id, name, sync_id FROM products WHERE deleted_at IS NULL AND tenant_id = ? ORDER BY name`
    ).all(tenantId);

    // Store opening balance for each product (from stock_movements)
    const openingBalances = db.prepare(
      `SELECT product_sync_id, SUM(quantity) AS opening_balance
       FROM stock_movements
       WHERE location = 'store' AND movement_type = 'opening' AND deleted_at IS NULL AND tenant_id = ?
       GROUP BY product_sync_id`
    ).all(tenantId);
    const openingMap = {};
    openingBalances.forEach(o => { openingMap[o.product_sync_id] = o.opening_balance; });

    // Counted items for this session (aggregated)
    const counted = db.prepare(
      `SELECT product_id, SUM(quantity) AS counted_qty FROM stock_count_items WHERE session_id = ? GROUP BY product_id`
    ).all(req.params.id);
    const countedMap = {};
    counted.forEach(c => { countedMap[c.product_id] = c.counted_qty; });

    const result = products.map(p => {
      const opening = parseFloat(openingMap[p.sync_id] ?? 0);
      const counted_qty = countedMap[p.id] !== undefined ? parseFloat(countedMap[p.id]) : null;
      return {
        product_id: p.id,
        product_name: p.name,
        opening_balance: opening,
        counted_qty,
        difference: counted_qty !== null ? counted_qty - opening : null,
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/stock-count/sessions/:id/items — add item to session (accumulates)
router.post('/sessions/:id/items', auth, (req, res) => {
  try {
    const { product_id, quantity } = req.body;
    if (!product_id || !quantity) return res.status(400).json({ error: 'product_id and quantity required' });

    const session = db.prepare('SELECT * FROM stock_count_sessions WHERE id = ?').get(req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'Active') return res.status(400).json({ error: 'Session is not active' });

    db.prepare(
      `INSERT INTO stock_count_items (session_id, product_id, quantity, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run(req.params.id, product_id, parseFloat(quantity));

    // Return updated totals for this product
    const total = db.prepare(
      `SELECT SUM(quantity) AS counted_qty FROM stock_count_items WHERE session_id = ? AND product_id = ?`
    ).get(req.params.id, product_id);

    res.status(201).json({ product_id, counted_qty: total.counted_qty });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/stock-count/sessions/:id/apply — apply as store opening balance
router.post('/sessions/:id/apply', auth, (req, res) => {
  try {
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();

    const session = db.prepare('SELECT * FROM stock_count_sessions WHERE id = ? AND tenant_id = ?').get(req.params.id, tenantId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'Active') return res.status(400).json({ error: 'Session already applied' });

    // Get aggregated counts
    const counts = db.prepare(
      `SELECT product_id, SUM(quantity) AS counted_qty FROM stock_count_items WHERE session_id = ? GROUP BY product_id`
    ).all(req.params.id);

    db.transaction(() => {
      for (const c of counts) {
        const prod = db.prepare('SELECT sync_id FROM products WHERE id = ? AND tenant_id = ?').get(c.product_id, tenantId);
        if (!prod) continue;

        // Check if opening_balance movement already exists for this product in store
        // v1.10.23 — also fetch quantity so we can apply the delta to current_stock.
        const existing = db.prepare(
          `SELECT sync_id, quantity FROM stock_movements
           WHERE product_sync_id = ? AND location = 'store' AND movement_type = 'opening' AND deleted_at IS NULL
           LIMIT 1`
        ).get(prod.sync_id);

        if (existing) {
          // v1.10.23 — apply the delta between old and new counted qty to current_stock.
          const oldQty = parseFloat(existing.quantity || 0);
          const newQty = parseFloat(c.counted_qty || 0);
          const delta = newQty - oldQty;
          // Update existing opening balance movement
          db.prepare(
            `UPDATE stock_movements SET quantity = ?, updated_at = datetime('now'), synced = 0
             WHERE sync_id = ?`
          ).run(c.counted_qty, existing.sync_id);
          if (Math.abs(delta) > 0.0001 && prod.sync_id) {
            db.prepare(
              `UPDATE products SET current_stock = current_stock + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
            ).run(delta, prod.sync_id);
          }
        } else {
          // Insert new opening balance movement
          db.prepare(
            `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
             VALUES (?,?,'store','opening',?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
          ).run(c.product_id, prod.sync_id, c.counted_qty, parseInt(req.params.id), 'stock_count',
                req.user.id, randomUUID(), tenantId, branchId, deviceId);
          // v1.10.23 — apply the counted qty to current_stock.
          if (prod.sync_id) {
            db.prepare(
              `UPDATE products SET current_stock = current_stock + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
            ).run(parseFloat(c.counted_qty || 0), prod.sync_id);
          }
        }
      }

      db.prepare(`UPDATE stock_count_sessions SET status = 'Applied', updated_at = datetime('now') WHERE id = ?`)
        .run(req.params.id);
    })();

    res.json({ success: true, applied: counts.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
