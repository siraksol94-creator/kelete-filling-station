const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { conversionToBase, baseQtyExpr } = require('../config/unitsHelper');
const { masterDb } = require('../config/masterDb');
const { getHostSlug } = require('../middleware/hqPush');
const vsdc = require('../services/vsdcClient');

// ── Build a SQL fragment that computes system stock per product for a given
//    location ('sales' or 'store'). Stock movements are stored in base units.
//    When `asOf` is a YYYY-MM-DD date, the balance is computed as of that date
//    (inclusive) so back-dated reconciliations compare apples-to-apples.
function balanceSQL(location, tenantId, asOf = null) {
  const asOfClause = asOf ? ` AND created_at <= ?` : '';
  const balParams = asOf ? [location, `${asOf} 23:59:59`] : [location];
  return {
    text: `
      SELECT
        p.id, p.sync_id, p.code, p.name, p.unit, p.alt_unit, p.conversion_factor, p.units_json,
        p.cost_price, p.selling_price,
        COALESCE(bal.balance, 0) AS system_qty,
        CASE WHEN COALESCE(grn_cost.total_qty, 0) > 0
          THEN ROUND(COALESCE(grn_cost.total_cost, 0) / grn_cost.total_qty, 4)
          ELSE p.cost_price
        END AS avg_cost
      FROM products p
      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS balance
        FROM stock_movements
        WHERE location = ? AND deleted_at IS NULL AND product_sync_id IS NOT NULL${asOfClause}
        GROUP BY product_sync_id
      ) bal ON bal.product_sync_id = p.sync_id
      LEFT JOIN (
        -- Avg cost per BASE unit. baseQtyExpr handles N packagings via units_json.
        SELECT gi.product_sync_id,
               SUM(${baseQtyExpr('gp', 'gi')}) AS total_qty,
               SUM(gi.total_price) AS total_cost
        FROM grn_items gi
        LEFT JOIN products gp ON gp.sync_id = gi.product_sync_id
        WHERE gi.product_sync_id IS NOT NULL AND gi.deleted_at IS NULL
        GROUP BY gi.product_sync_id
      ) grn_cost ON grn_cost.product_sync_id = p.sync_id
      WHERE p.deleted_at IS NULL AND p.tenant_id = ?
      ORDER BY p.name
    `,
    params: [...balParams, tenantId],
  };
}

// GET /api/stock-reconciliation/products?location=sales&count_date=YYYY-MM-DD
// Returns all products with system stock at the chosen location, as of count_date
// (inclusive). When count_date is omitted, returns current stock.
router.get('/products', auth, readOnlyGuard, (req, res) => {
  try {
    const location = req.query.location === 'store' ? 'store' : 'sales';
    const rawDate = req.query.count_date;
    const asOf = (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) ? rawDate : null;
    const q = balanceSQL(location, req.user.tenantId, asOf);
    const rows = db.prepare(q.text).all(...q.params);

    // v1.13.6 — attach transit_qty (base units) from PENDING outgoing
    // transfers. Since v1.9.22, transfers don't deduct source stock until
    // the destination confirms receipt, so system_qty on 'sales' still
    // includes items already dispatched but in flight. Exposing this as
    // a column lets the counter reconcile without treating in-transit
    // stock as a shrinkage variance. Only relevant to 'sales' location
    // (transfers post to sales only) so we skip the lookup for store.
    if (location === 'sales') {
      try {
        const slug = getHostSlug(req);
        if (slug) {
          const pending = masterDb.prepare(
            `SELECT items_json FROM stock_transfers WHERE from_slug = ? AND status = 'PENDING'`
          ).all(slug);
          const transitBySync = new Map();
          for (const t of pending) {
            let items = [];
            try { items = JSON.parse(t.items_json || '[]'); } catch { /* skip */ }
            for (const it of items) {
              const psid = it.product_sync_id;
              if (!psid) continue;
              const prod = db.prepare(
                'SELECT unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?'
              ).get(psid);
              const baseQty = parseFloat(it.quantity || 0) * conversionToBase(prod || {}, it.unit);
              transitBySync.set(psid, (transitBySync.get(psid) || 0) + baseQty);
            }
          }
          for (const r of rows) r.transit_qty = transitBySync.get(r.sync_id) || 0;
        } else {
          for (const r of rows) r.transit_qty = 0;
        }
      } catch (_) {
        // On any error keep transit_qty=0 so reconciliation still loads.
        for (const r of rows) r.transit_qty = 0;
      }
    } else {
      for (const r of rows) r.transit_qty = 0;
    }

    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stock-reconciliation?location=sales
// Returns history list of past reconciliations for the tenant
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const location = req.query.location;
    let sql = `
      SELECT sr.id, sr.count_date, sr.location, sr.notes, sr.created_at,
             u.first_name || ' ' || u.last_name AS created_by_name,
             COUNT(sri.id) AS item_count,
             -- Net signed variance: positive = surplus (stock found), negative = shrinkage (loss)
             SUM(sri.variance_base * sri.cost_at_count) AS variance_value
      FROM stock_reconciliations sr
      LEFT JOIN users u ON u.id = sr.created_by
      LEFT JOIN stock_reconciliation_items sri
        ON sri.reconciliation_id = sr.id AND sri.deleted_at IS NULL
      WHERE sr.deleted_at IS NULL AND sr.tenant_id = ?
    `;
    const params = [req.user.tenantId];
    if (location) { sql += ' AND sr.location = ?'; params.push(location); }
    sql += ' GROUP BY sr.id ORDER BY sr.count_date DESC, sr.created_at DESC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/stock-reconciliation/:id  — drill into one reconciliation
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const head = db.prepare(`
      SELECT sr.*, u.first_name || ' ' || u.last_name AS created_by_name
      FROM stock_reconciliations sr
      LEFT JOIN users u ON u.id = sr.created_by
      WHERE sr.id = ? AND sr.tenant_id = ? AND sr.deleted_at IS NULL
    `).get(req.params.id, req.user.tenantId);
    if (!head) return res.status(404).json({ error: 'Reconciliation not found' });
    const items = db.prepare(`
      SELECT sri.*, p.name AS product_name, p.unit AS product_unit, p.alt_unit, p.conversion_factor
      FROM stock_reconciliation_items sri
      LEFT JOIN products p ON p.sync_id = sri.product_sync_id
      WHERE sri.reconciliation_id = ? AND sri.deleted_at IS NULL
      ORDER BY sri.id
    `).all(req.params.id);
    res.json({ ...head, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/stock-reconciliation
// Body: { count_date, location, notes, items: [{ product_id, physical_qty, unit, reason }] }
// SKIP rules: items with physical_qty blank/null/empty are ignored (no row, no variance, no movement)
router.post('/', auth, async (req, res) => {
  try {
    const { count_date, location, notes, items } = req.body;
    // v1.13.84 — collected inside the tx, fired to VSDC after commit.
    const zraVarianceLines = [];
    const loc = location === 'store' ? 'store' : 'sales';
    const countDate = count_date || new Date().toISOString().slice(0, 10);
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();

    // Only keep items that have a non-blank physical_qty
    const validItems = (items || []).filter(it =>
      it.product_id != null && it.physical_qty !== '' && it.physical_qty != null && !isNaN(parseFloat(it.physical_qty))
    );
    if (validItems.length === 0) {
      return res.status(400).json({ error: 'No items with physical count entered.' });
    }

    const result = db.transaction(() => {
      const reconciliationSyncId = randomUUID();
      const info = db.prepare(`
        INSERT INTO stock_reconciliations (count_date, location, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(countDate, loc, notes || null, req.user.id, reconciliationSyncId, tenantId, branchId, deviceId);
      const reconciliationId = info.lastInsertRowid;

      // Build a quick lookup of product info
      const productById = new Map();
      const prodIds = validItems.map(it => it.product_id);
      const products = db.prepare(`
        SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json, cost_price
        FROM products WHERE id IN (${prodIds.map(() => '?').join(',')})
      `).all(...prodIds);
      products.forEach(p => productById.set(p.id, p));

      for (const it of validItems) {
        const prod = productById.get(it.product_id);
        if (!prod) continue;
        const lineUnit = (it.unit || '').trim() || prod.unit;
        const physicalQty = parseFloat(it.physical_qty);
        const physicalBase = physicalQty * conversionToBase(prod, lineUnit);

        // System qty in BASE units at this location, as of the count_date.
        // Must match what the UI showed in the System Qty column when the user
        // entered the physical count — otherwise a back-dated post would write
        // a fake variance based on today's stock instead of the count date's.
        const balRow = db.prepare(`
          SELECT COALESCE(SUM(quantity), 0) AS bal FROM stock_movements
          WHERE product_sync_id = ? AND location = ? AND deleted_at IS NULL
            AND created_at <= ?
        `).get(prod.sync_id, loc, `${countDate} 23:59:59`);
        const systemBase = parseFloat(balRow.bal || 0);
        const varianceBase = physicalBase - systemBase;

        // Cost used for valuing variance — avg cost PER BASE UNIT, with alt-unit GRN lines converted.
        // Without the CASE conversion, total_qty would mix pcs and boxes giving a per-box cost
        // that then gets multiplied by a per-pcs variance below = wrong.
        const costRow = db.prepare(`
          SELECT CASE WHEN COALESCE(SUM(${baseQtyExpr('gp', 'gi')}), 0) > 0
                 THEN ROUND(SUM(gi.total_price) / SUM(${baseQtyExpr('gp', 'gi')}), 4)
                 ELSE 0 END AS avg_cost
          FROM grn_items gi
          LEFT JOIN products gp ON gp.sync_id = gi.product_sync_id
          WHERE gi.product_sync_id = ? AND gi.deleted_at IS NULL
        `).get(prod.sync_id);
        const avgCost = parseFloat(costRow.avg_cost || prod.cost_price || 0);

        db.prepare(`
          INSERT INTO stock_reconciliation_items
            (reconciliation_id, reconciliation_sync_id, product_id, product_sync_id,
             system_qty, physical_qty, unit, variance_base, cost_at_count, reason,
             sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(
          reconciliationId, reconciliationSyncId, prod.id, prod.sync_id,
          systemBase, physicalQty, lineUnit, varianceBase, avgCost, (it.reason || null),
          randomUUID(), tenantId, branchId, deviceId
        );

        // If there's a variance, write an adjustment stock_movement so system matches physical
        if (Math.abs(varianceBase) > 0.0001) {
          db.prepare(`
            INSERT INTO stock_movements
              (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, notes, created_by,
               sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)
          `).run(
            prod.id, prod.sync_id, loc, 'reconciliation', varianceBase,
            reconciliationId, 'stock_reconciliation', `Stock reconciliation variance`,
            req.user.id, randomUUID(), tenantId, branchId, deviceId, countDate, reconciliationSyncId
          );
          // v1.10.23 — apply variance to products.current_stock.
          if (prod.sync_id) {
            db.prepare(
              `UPDATE products SET current_stock = current_stock + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
            ).run(varianceBase, prod.sync_id);
          }
          // v1.13.84 — capture the varianced line for the ZRA chain call
          // after commit. Base units are what ZRA sees; the helper takes
          // Math.abs internally so sign is fine.
          zraVarianceLines.push({
            product_sync_id: prod.sync_id,
            quantity:        varianceBase,
            unit:            null,
          });
        }
      }

      return db.prepare('SELECT * FROM stock_reconciliations WHERE id = ?').get(reconciliationId);
    })();

    // Refresh profit for that date — variance × cost feeds into stock_adjustment-style P&L
    try { recalculateDailyProfit(db, countDate, req.user.tenantId); } catch (_) {}

    // v1.13.84 — ZRA stock chain for every varianced line captured
    // above. Split by sign: positive variances (found more than book)
    // go out as Adjustment-In (06), negative variances (short) go out
    // as Adjustment-Out (16). Two calls with distinct sarNos so the
    // ZRA portal sees them as separate movement records. Fired outside
    // the transaction so a VSDC error never rolls back the
    // reconciliation.
    let zra = { skipped: true, reason: 'no variance' };
    if (zraVarianceLines.length) {
      const linesIn  = zraVarianceLines.filter(l => (parseFloat(l.quantity) || 0) > 0);
      const linesOut = zraVarianceLines.filter(l => (parseFloat(l.quantity) || 0) < 0);
      try {
        const zraIn = linesIn.length ? await vsdc.saveNonSaleStockChain(
          req.user.tenantId,
          result.id * 10 + 1,
          { customer_name: 'Stock Reconciliation (found)', remark: notes || null },
          linesIn,
          vsdc.SAR_TY_CD.ADJUSTMENT_IN
        ) : { skipped: true, reason: 'no positive variance' };
        const zraOut = linesOut.length ? await vsdc.saveNonSaleStockChain(
          req.user.tenantId,
          result.id * 10 + 2,
          { customer_name: 'Stock Reconciliation (short)', remark: notes || null },
          linesOut,
          vsdc.SAR_TY_CD.ADJUSTMENT_OUT
        ) : { skipped: true, reason: 'no negative variance' };
        zra = { in: zraIn, out: zraOut };
      } catch (_) { /* stock-chain failure never unwinds the reconciliation */ }
    }

    res.status(201).json({ ...result, zra });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/stock-reconciliation/:id — soft delete (also soft-deletes the variance stock_movements)
router.delete('/:id', auth, (req, res) => {
  try {
    db.transaction(() => {
      const sr = db.prepare('SELECT sync_id, count_date FROM stock_reconciliations WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenantId);
      if (!sr) throw Object.assign(new Error('Reconciliation not found'), { status: 404 });
      // v1.10.34 — roll back products.current_stock by the NET of the variance
      // movements about to be soft-deleted. POST applied varianceBase to
      // current_stock (v1.10.23); deleting the reconciliation must reverse
      // that or products stay at their post-reconciled values (e.g. Four
      // Cousins 1.5L went from -9 → 0 on reconcile, then delete left it at 0
      // instead of restoring -9). Must run BEFORE the soft-delete so we can
      // still see the movement rows.
      const movementsToRollback = db.prepare(`
        SELECT product_sync_id, COALESCE(SUM(quantity), 0) AS net
          FROM stock_movements
         WHERE reference_sync_id = ?
           AND reference_type = 'stock_reconciliation'
           AND deleted_at IS NULL
           AND product_sync_id IS NOT NULL
         GROUP BY product_sync_id
      `).all(sr.sync_id);
      const rollbackStmt = db.prepare(
        `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
      );
      for (const m of movementsToRollback) {
        if (Math.abs(m.net) > 0.0001) rollbackStmt.run(m.net, m.product_sync_id);
      }
      db.prepare("UPDATE stock_reconciliations SET deleted_at = datetime('now'), updated_at=datetime('now'), synced=0 WHERE id = ?").run(req.params.id);
      db.prepare("UPDATE stock_reconciliation_items SET deleted_at = datetime('now'), updated_at=datetime('now'), synced=0 WHERE reconciliation_id = ?").run(req.params.id);
      db.prepare(`UPDATE stock_movements SET deleted_at = datetime('now'), updated_at=datetime('now'), synced=0
                  WHERE reference_sync_id = ? AND reference_type = 'stock_reconciliation' AND deleted_at IS NULL`).run(sr.sync_id);
      try { recalculateDailyProfit(db, sr.count_date, req.user.tenantId); } catch (_) {}
    })();
    res.json({ message: 'Reconciliation deleted' });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
