// Empty Returns — sending crates/bottles back to a supplier in exchange for a deposit credit.
//
// Each return:
//   1. Posts a NEGATIVE stock_movement for each empty product at the 'store' location.
//   2. Creates a matching ap_payment row (the supplier "pays us back" by reducing what
//      we owe them). The ap_payment is linked via empty_returns.ap_payment_sync_id so
//      edits/deletes cascade cleanly.
//
// No goods are received — this is purely a deposit settlement document.

const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { recalculateDailyProfit } = require('../config/profitHelper');
const vsdc = require('../services/vsdcClient');
const { isSingleLocationMode, returnLocation } = require('../config/autoSivHelper');
const { randomUUID } = require('crypto');

// Single-location mode collapses 'store' out of the picture (every GRN is
// auto-SIV'd to 'sales'), so empties leaving the building must come off the
// 'sales' counter instead. Dual-location flow keeps 'store' since empties
// physically live in the warehouse there.
// 2026-09-07 — kept for reference; the movement inserts now use
// returnLocation(), which reads where the stock actually is rather than
// trusting a setting the HQ GRN path ignores. See autoSivHelper.
function stockLocation(db, tenantId) {
  return isSingleLocationMode(db, tenantId) ? 'sales' : 'store';
}

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT er.*, s.name AS supplier_name,
             (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM empty_returns er
      LEFT JOIN suppliers s ON s.sync_id = er.supplier_sync_id
      LEFT JOIN users u ON u.id = er.created_by
      WHERE er.deleted_at IS NULL AND er.tenant_id = ?
      ORDER BY er.date DESC, er.id DESC
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ────────────────────────────────────────────────────────────────────
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const total      = db.prepare("SELECT COUNT(*) AS cnt FROM empty_returns WHERE deleted_at IS NULL AND tenant_id = ?").get(tenantId);
    const thisMonth  = db.prepare("SELECT COUNT(*) AS cnt FROM empty_returns WHERE deleted_at IS NULL AND tenant_id = ? AND strftime('%Y-%m', date) = strftime('%Y-%m','now')").get(tenantId);
    const totalValue = db.prepare("SELECT COALESCE(SUM(total_amount),0) AS sum FROM empty_returns WHERE deleted_at IS NULL AND tenant_id = ?").get(tenantId);
    const suppliers  = db.prepare("SELECT COUNT(DISTINCT supplier_id) AS cnt FROM empty_returns WHERE deleted_at IS NULL AND tenant_id = ? AND supplier_id IS NOT NULL").get(tenantId);
    res.json({
      totalReturns: total.cnt,
      thisMonth:    thisMonth.cnt,
      totalValue:   totalValue.sum,
      suppliers:    suppliers.cnt,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single (with items) ──────────────────────────────────────────────────────
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT er.*, s.name AS supplier_name,
             (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM empty_returns er
      LEFT JOIN suppliers s ON s.sync_id = er.supplier_sync_id
      LEFT JOIN users u ON u.id = er.created_by
      WHERE er.id = ? AND er.tenant_id = ?
    `).get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Empty return not found.' });
    const items = db.prepare(`
      SELECT eri.*, p.name AS product_name, p.unit AS product_unit
      FROM empty_return_items eri
      LEFT JOIN products p ON p.sync_id = eri.product_sync_id
      WHERE eri.empty_return_sync_id = ? AND eri.deleted_at IS NULL
    `).all(row.sync_id);
    res.json({ ...row, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create ───────────────────────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const { supplier_id, items, notes, date } = req.body;
    if (!supplier_id) return res.status(400).json({ error: 'Supplier is required.' });
    const validItems = (items || []).filter(i => i.product_id && parseFloat(i.quantity) > 0);
    if (validItems.length === 0) return res.status(400).json({ error: 'At least one valid item is required.' });

    const result = db.transaction(() => {
      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();
      const returnNum  = syncConfig.generateNumber('ER',  'empty_returns');
      const cnNumber   = syncConfig.generateNumber('CN',  'supplier_credit_notes');
      const erSyncId   = randomUUID();
      const cnSyncId   = randomUUID();
      const retDate    = date || new Date().toISOString().split('T')[0];
      const movementCreatedAt = retDate + ' ' + new Date().toTimeString().slice(0, 8);

      // Prefer client-sent supplier_sync_id (stable across PCs).
      const supplier = db.prepare('SELECT sync_id, name FROM suppliers WHERE id = ?').get(supplier_id);
      const supplierSyncId = req.body.supplier_sync_id || supplier?.sync_id || null;

      const totalAmount = validItems.reduce(
        (s, i) => s + parseFloat(i.quantity) * parseFloat(i.deposit || 0), 0
      );

      // Parent return record. Phase 4A: link to supplier_credit_notes.sync_id
      // instead of ap_payments.sync_id. ap_payment_sync_id stays NULL for new rows.
      const info = db.prepare(`
        INSERT INTO empty_returns (return_number, date, supplier_id, supplier_sync_id, total_items, total_amount,
                                    notes, created_by, status, credit_note_sync_id,
                                    sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?, 'Completed', ?, ?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(returnNum, retDate, supplier_id, supplierSyncId, validItems.length, totalAmount,
             notes || null, req.user.id, cnSyncId,
             erSyncId, tenantId, branchId, deviceId);
      const erId = info.lastInsertRowid;

      // Per-line items + negative stock movements (kept on the empty_return reference
      // so existing Bin Card queries / sync paths don't need to change).
      for (const i of validItems) {
        const prod = db.prepare('SELECT sync_id FROM products WHERE id = ?').get(i.product_id);
        const productSyncId = i.product_sync_id || prod?.sync_id || null;
        const qty = parseFloat(i.quantity);
        const dep = parseFloat(i.deposit || 0);
        const linePrice = qty * dep;

        db.prepare(`
          INSERT INTO empty_return_items (empty_return_id, empty_return_sync_id, product_id, product_sync_id,
                                          quantity, deposit, total_price,
                                          sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(erId, erSyncId, i.product_id, productSyncId, qty, dep, linePrice,
               randomUUID(), tenantId, branchId, deviceId);

        // Stock leaves the yard. movement_type stays 'empty_return' for backward compat.
        db.prepare(`
          INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity,
                                       reference_id, reference_type, notes, created_by,
                                       sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)
        `).run(i.product_id, productSyncId, returnLocation(db, tenantId, productSyncId, qty), 'empty_return', -qty,
               erId, 'empty_return', `Empties returned via ${returnNum}`, req.user.id,
               randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, erSyncId);
        // v1.10.24 — decrement products.current_stock alongside the movement.
        if (productSyncId) {
          db.prepare(
            `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(qty, productSyncId);
        }
      }

      // Phase 4A: mint a Credit Note (reason='Crate Return') instead of an
      // ap_payment. Profit Report ignores Crate Return CNs — same outcome as
      // ap_payments tagged 'Empty Return' had — but AP balance now flows
      // through cn_totals consistently.
      db.prepare(`
        INSERT INTO supplier_credit_notes (credit_note_number, date, supplier_id, supplier_sync_id,
                                            reason, reference, amount, notes, created_by,
                                            sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(cnNumber, retDate, supplier_id, supplierSyncId,
             'Crate Return', returnNum, totalAmount,
             `Empty container deposit credit (${returnNum})`, req.user.id,
             cnSyncId, tenantId, branchId, deviceId);

      const saved = db.prepare('SELECT * FROM empty_returns WHERE id = ?').get(erId);
      // Crate Return CNs don't affect Gross Profit, but recalc keeps the
      // daily_profit_summary row fresh in case anything else changed today.
      recalculateDailyProfit(db, retDate, tenantId);
      return saved;
    })();

    // v1.13.84 — ZRA stock chain (sarTyCd=03 RETURN — goods leaving our
    // inventory back to the supplier for deposit credit). Fired outside
    // the transaction so a VSDC error doesn't unwind the local write.
    let zra = { skipped: true, reason: 'not-attempted' };
    try {
      const lines = validItems.map(i => ({
        product_sync_id: i.product_sync_id
          || db.prepare('SELECT sync_id FROM products WHERE id = ?').get(i.product_id)?.sync_id,
        quantity:        parseFloat(i.quantity) || 0,
        unit:            null,
      })).filter(l => l.product_sync_id);
      if (lines.length) {
        const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(supplier_id);
        zra = await vsdc.saveNonSaleStockChain(
          req.user.tenantId,
          result.id,
          { customer_name: supplier?.name || 'Empty Return', remark: `Empty Return ${result.return_number || ''}` },
          lines,
          vsdc.SAR_TY_CD.RETURN
        );
      }
    } catch (_) { /* stock-chain failure doesn't undo the return */ }

    res.status(201).json({ ...result, zra });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update ───────────────────────────────────────────────────────────────────
// Strategy: hard-delete the existing items + their stock movements, then re-insert
// from the new payload. The parent row keeps its number/sync_id/ap_payment link.
router.put('/:id', auth, (req, res) => {
  try {
    const { supplier_id, date, notes, items } = req.body;
    const id = parseInt(req.params.id);
    const validItems = (items || []).filter(i => i.product_id && parseFloat(i.quantity) > 0);
    if (validItems.length === 0) return res.status(400).json({ error: 'At least one valid item is required.' });

    const result = db.transaction(() => {
      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();
      const er = db.prepare('SELECT * FROM empty_returns WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(id, tenantId);
      if (!er) throw Object.assign(new Error('Empty return not found.'), { status: 404 });

      const totalAmount = validItems.reduce((s, i) => s + parseFloat(i.quantity) * parseFloat(i.deposit || 0), 0);
      const supplier = db.prepare('SELECT sync_id, name FROM suppliers WHERE id = ?').get(supplier_id);
      const supplierSyncId = req.body.supplier_sync_id || supplier?.sync_id || null;
      const supplierName   = supplier?.name || null;
      const editDate = date || er.date;
      const movementCreatedAt = editDate + ' ' + new Date().toTimeString().slice(0, 8);

      // v1.10.24 — roll old empty_return movements off current_stock before soft-deleting.
      const oldMoves = db.prepare(
        `SELECT product_sync_id, SUM(quantity) AS net FROM stock_movements
          WHERE reference_sync_id = ? AND reference_type = 'empty_return' AND deleted_at IS NULL
          GROUP BY product_sync_id`
      ).all(er.sync_id);
      for (const r of oldMoves) {
        if (r.product_sync_id) {
          db.prepare(
            `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(r.net, r.product_sync_id);
        }
      }
      // Wipe previous items + stock movements (cascade reverse).
      db.prepare("UPDATE empty_return_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE empty_return_sync_id=? AND deleted_at IS NULL").run(er.sync_id);
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='empty_return' AND deleted_at IS NULL").run(er.sync_id);

      // Update the parent.
      db.prepare(`
        UPDATE empty_returns SET supplier_id=?, supplier_sync_id=?, date=?, notes=?,
          total_items=?, total_amount=?, synced=0, updated_at=datetime('now')
        WHERE id=?
      `).run(supplier_id, supplierSyncId, date || er.date, notes || null,
             validItems.length, totalAmount, id);

      // Re-insert items + movements.
      for (const i of validItems) {
        const prod = db.prepare('SELECT sync_id FROM products WHERE id = ?').get(i.product_id);
        const productSyncId = i.product_sync_id || prod?.sync_id || null;
        const qty = parseFloat(i.quantity);
        const dep = parseFloat(i.deposit || 0);
        const linePrice = qty * dep;

        db.prepare(`
          INSERT INTO empty_return_items (empty_return_id, empty_return_sync_id, product_id, product_sync_id,
                                          quantity, deposit, total_price,
                                          sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(id, er.sync_id, i.product_id, productSyncId, qty, dep, linePrice,
               randomUUID(), tenantId, branchId, deviceId);

        db.prepare(`
          INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity,
                                       reference_id, reference_type, notes, created_by,
                                       sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)
        `).run(i.product_id, productSyncId, returnLocation(db, tenantId, productSyncId, qty), 'empty_return', -qty,
               id, 'empty_return', `Empties returned via ${er.return_number}`, req.user.id,
               randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, er.sync_id);
        // v1.10.24 — decrement products.current_stock alongside the movement.
        if (productSyncId) {
          db.prepare(
            `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(qty, productSyncId);
        }
      }

      // Keep the linked AP credit in sync. New rows (Phase 4A) point to a
      // supplier_credit_notes row via credit_note_sync_id; older rows still
      // point to an ap_payments row via ap_payment_sync_id. Handle both.
      if (er.credit_note_sync_id) {
        db.prepare(`
          UPDATE supplier_credit_notes
          SET supplier_id=?, supplier_sync_id=?, amount=?, date=?,
              synced=0, updated_at=datetime('now')
          WHERE sync_id=? AND deleted_at IS NULL
        `).run(supplier_id, supplierSyncId, totalAmount, editDate, er.credit_note_sync_id);
      } else if (er.ap_payment_sync_id) {
        db.prepare(`
          UPDATE ap_payments SET supplier_id=?, supplier_sync_id=?, supplier_name=?,
            amount=?, date=?, synced=0, updated_at=datetime('now')
          WHERE sync_id=? AND deleted_at IS NULL
        `).run(supplier_id, supplierSyncId, supplierName, totalAmount, editDate, er.ap_payment_sync_id);
      }

      const updated = db.prepare('SELECT * FROM empty_returns WHERE id = ?').get(id);
      recalculateDailyProfit(db, editDate, tenantId);
      if (editDate !== er.date) recalculateDailyProfit(db, er.date, tenantId);
      return updated;
    })();
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Delete (soft-delete + cascade) ───────────────────────────────────────────
router.delete('/:id', auth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    db.transaction(() => {
      const er = db.prepare('SELECT sync_id, ap_payment_sync_id, credit_note_sync_id, date, tenant_id FROM empty_returns WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!er) throw Object.assign(new Error('Empty return not found.'), { status: 404 });

      // v1.10.24 — roll deleted movements off current_stock.
      const oldDelMoves = db.prepare(
        `SELECT product_sync_id, SUM(quantity) AS net FROM stock_movements
          WHERE reference_sync_id = ? AND reference_type = 'empty_return' AND deleted_at IS NULL
          GROUP BY product_sync_id`
      ).all(er.sync_id);
      for (const r of oldDelMoves) {
        if (r.product_sync_id) {
          db.prepare(
            `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(r.net, r.product_sync_id);
        }
      }
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='empty_return' AND deleted_at IS NULL").run(er.sync_id);
      db.prepare("UPDATE empty_return_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE empty_return_sync_id=? AND deleted_at IS NULL").run(er.sync_id);
      db.prepare("UPDATE empty_returns SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(id);
      // Dual path — legacy ap_payment link, or new credit note link.
      if (er.credit_note_sync_id) {
        db.prepare("UPDATE supplier_credit_notes SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE sync_id=? AND deleted_at IS NULL").run(er.credit_note_sync_id);
      }
      if (er.ap_payment_sync_id) {
        db.prepare("UPDATE ap_payments SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE sync_id=? AND deleted_at IS NULL").run(er.ap_payment_sync_id);
      }
      recalculateDailyProfit(db, er.date, er.tenant_id);
    })();
    res.json({ message: 'Empty return deleted.' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
