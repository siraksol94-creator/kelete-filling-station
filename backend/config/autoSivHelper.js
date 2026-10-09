// Auto-SIV helper — when single-location mode is on, every GRN immediately spawns
// a matching SIV that issues the full receipt from store → sales. This keeps the
// stock_movements ledger consistent with the existing dual-location flow, so
// reports/POS/reconciliation don't need any conditional logic.
//
// The auto-SIV gets a normal sequential SIV number AND a source_grn_sync_id link
// pointing back to the GRN. The Bin Card uses that link to render "from GRN-…0009"
// next to the SIV reference, so users always know where the stock came from.
//
// Toggle: business_settings.single_location_mode (0/1). Default 0 — no auto-SIV.
const { randomUUID } = require('crypto');

// Is single-location mode enabled for this tenant?
function isSingleLocationMode(db, tenantId) {
  try {
    const row = db.prepare(
      `SELECT single_location_mode FROM business_settings WHERE tenant_id = ? OR tenant_id IS NULL LIMIT 1`
    ).get(tenantId);
    return !!(row && row.single_location_mode);
  } catch { return false; }
}

// Create the auto-SIV inside the caller's transaction. Caller passes the GRN row
// (with sync_id), the items as received, and the request context.
//
// `grnItems` is an array of { product_id, quantity, unit }. Quantity is in the
// unit the line was entered in — we convert to base for stock movements using the
// product's units_json / alt_unit (same helper GRN uses).
function createAutoSiv(db, grn, grnItems, req, syncConfig, { conversionToBase }) {
  const tenantId = syncConfig.getTenantId(req);
  const { branchId, deviceId } = syncConfig.getConfig();

  const sivNumber = syncConfig.generateNumber('SIV', 'siv');
  const sivSyncId = randomUUID();

  // Stamp stock_movements with the GRN's business date (matches the SIV header),
  // not today — otherwise the Bin Card reorders rows to today and reports break.
  const movementCreatedAt = grn.date + ' ' + new Date().toTimeString().slice(0, 8);

  // Pre-compute selling price per line unit, so totals + per-line values match
  // the manual SIV behaviour (which uses selling_price × conversion). Stock value
  // on an SIV represents retail value of what hit the sales counter, not cost.
  const pricedLines = grnItems.map(item => {
    const prod = db.prepare(
      'SELECT sync_id, unit, alt_unit, conversion_factor, units_json, selling_price FROM products WHERE id = ?'
    ).get(item.product_id);
    const productSyncId = prod?.sync_id || null;
    const lineUnit = (item.unit || '').trim() || prod?.unit || null;
    const qty = parseFloat(item.quantity);
    const conv = conversionToBase(prod, lineUnit);
    const baseQty = qty * conv;
    const sellPerLineUnit = parseFloat(prod?.selling_price || 0) * conv;
    return { item, prod, productSyncId, lineUnit, qty, baseQty, unitPrice: sellPerLineUnit };
  });

  const totalValue = pricedLines.reduce((s, l) => s + l.qty * l.unitPrice, 0);

  db.prepare(
    `INSERT INTO siv (siv_number, date, department, total_items, total_value, notes, created_by, status,
                       source_grn_sync_id,
                       sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,'Issued',?,?,?,?,?,0,datetime('now'),datetime('now'))`
  ).run(
    sivNumber,
    grn.date,
    'Auto-issue',
    grnItems.length,
    totalValue,
    `Auto-issued from ${grn.grn_number}`,
    req.user.id,
    grn.sync_id,                       // source_grn_sync_id — links SIV back to GRN
    sivSyncId, tenantId, branchId, deviceId
  );
  const sivId = db.prepare('SELECT id FROM siv WHERE sync_id = ?').get(sivSyncId).id;

  for (const { item, productSyncId, lineUnit, qty, baseQty, unitPrice } of pricedLines) {
    db.prepare(
      `INSERT INTO siv_items (siv_id, siv_sync_id, product_id, product_sync_id, quantity, unit, unit_price, total_price,
                              sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    ).run(sivId, sivSyncId, item.product_id, productSyncId, qty, lineUnit, unitPrice, qty * unitPrice,
          randomUUID(), tenantId, branchId, deviceId);

    // store −qty (issued out)  and  sales +qty (received at counter)
    db.prepare(
      `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by,
                                    sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
       VALUES (?,?,'store','siv',?,?,'siv',?,?,?,?,?,0,?,datetime('now'),?)`
    ).run(item.product_id, productSyncId, -baseQty, sivId, req.user.id,
          randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, sivSyncId);
    db.prepare(
      `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by,
                                    sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
       VALUES (?,?,'sales','siv',?,?,'siv',?,?,?,?,?,0,?,datetime('now'),?)`
    ).run(item.product_id, productSyncId, baseQty, sivId, req.user.id,
          randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, sivSyncId);

    // ── Container side-issue ────────────────────────────────────────────────
    // The GRN may also have brought in empty crates (recv > ret). In single-location
    // mode those should also be moved to the sales counter so reconciliation/POS see
    // the same stock state the user sees. Skip when delta ≤ 0 (no new crates landed).
    const containerSyncId = item.container_product_sync_id || null;
    const containerDelta  = parseFloat(item.containers_received || 0) - parseFloat(item.containers_returned || 0);
    if (containerSyncId && containerDelta > 0.001) {
      const containerProd = db.prepare(
        'SELECT id, unit FROM products WHERE sync_id = ?'
      ).get(containerSyncId);
      if (containerProd) {
        const dep = parseFloat(item.container_deposit || 0);
        db.prepare(
          `INSERT INTO siv_items (siv_id, siv_sync_id, product_id, product_sync_id, quantity, unit, unit_price, total_price,
                                  sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
        ).run(sivId, sivSyncId, containerProd.id, containerSyncId, containerDelta, containerProd.unit || 'pcs',
              dep, containerDelta * dep,
              randomUUID(), tenantId, branchId, deviceId);
        db.prepare(
          `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, notes, created_by,
                                        sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
           VALUES (?,?,'store','siv',?,?,'siv',?,?,?,?,?,?,0,?,datetime('now'),?)`
        ).run(containerProd.id, containerSyncId, -containerDelta, sivId, `Container auto-issue from ${grn.grn_number}`, req.user.id,
              randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, sivSyncId);
        db.prepare(
          `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, notes, created_by,
                                        sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
           VALUES (?,?,'sales','siv',?,?,'siv',?,?,?,?,?,?,0,?,datetime('now'),?)`
        ).run(containerProd.id, containerSyncId, containerDelta, sivId, `Container auto-issue from ${grn.grn_number}`, req.user.id,
              randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, sivSyncId);
      }
    }
  }

  return { sivId, sivSyncId, sivNumber };
}

// Soft-delete the auto-SIV linked to a GRN (and its items + stock movements).
// Called when the GRN itself is edited (re-create after) or deleted.
function deleteAutoSivForGrn(db, grnSyncId) {
  const siv = db.prepare(
    `SELECT id, sync_id FROM siv WHERE source_grn_sync_id = ? AND deleted_at IS NULL`
  ).get(grnSyncId);
  if (!siv) return false;
  db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id = ? AND deleted_at IS NULL").run(siv.sync_id);
  db.prepare("UPDATE siv_items       SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE siv_sync_id      = ? AND deleted_at IS NULL").run(siv.sync_id);
  db.prepare("UPDATE siv             SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id               = ?").run(siv.id);
  return true;
}

// 2026-09-07 — take the goods off the shelf they are actually on.
//
// stockLocation() above answers from a setting. HQ-generated GRNs ignore that
// setting and always post to 'sales' (hardcoded in routes/hqGrns.js — the
// no-store model), so at a Kelete depot the stock arrives in 'sales' while a
// return was being deducted from 'store'. Nothing stopped it: Kabwe ended up
// with store = -1 on LAYS 105 X 20 and its sales counter overstated by the
// same box, and every future return would have added another.
//
// So ask the movements rather than a flag: whichever location actually holds
// this product is the one it leaves from. Falls back to the setting when the
// product has no history at all, which is the only case with nothing to read.
function returnLocation(db, tenantId, productSyncId, neededQty) {
  const fallback = isSingleLocationMode(db, tenantId) ? 'sales' : 'store';
  if (!productSyncId) return fallback;
  try {
    const rows = db.prepare(
      `SELECT location, COALESCE(SUM(quantity), 0) AS qty
         FROM stock_movements
        WHERE product_sync_id = ? AND deleted_at IS NULL
        GROUP BY location`
    ).all(productSyncId);
    if (rows.length === 0) return fallback;
    const at = (loc) => rows.find(r => r.location === loc)?.qty || 0;
    const need = parseFloat(neededQty) || 0;
    // A depot that really does keep a warehouse ships returns out of it, so
    // 'store' still wins when the goods are sitting there.
    if (at('store') >= need && at('store') > 0) return 'store';
    if (at('sales') >= need && at('sales') > 0) return 'sales';
    // Neither can cover it — go where most of it is rather than inventing a
    // negative somewhere empty.
    const best = rows.slice().sort((a, b) => b.qty - a.qty)[0];
    return best && best.qty > 0 ? best.location : fallback;
  } catch (_) {
    return fallback;
  }
}

module.exports = { isSingleLocationMode, returnLocation, createAutoSiv, deleteAutoSivForGrn };
