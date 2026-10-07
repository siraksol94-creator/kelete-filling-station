const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { conversionToBase } = require('../config/unitsHelper');
const { isSingleLocationMode, createAutoSiv, deleteAutoSivForGrn } = require('../config/autoSivHelper');
const vsdc = require('../services/vsdcClient');

// FIFO payment-status SQL (SQLite version â€” uses CASE instead of GREATEST/LEAST)
// Soft-deleted GRNs and suppliers are excluded in the CTEs
const FIFO_SQL = (extraWhere = '', params = [], tenantId = null) => ({
  text: `
    WITH supplier_paid AS (
      SELECT s.sync_id AS supplier_sync_id,
             COALESCE(SUM(ap.amount), 0) AS total_paid
      FROM   suppliers s
      LEFT JOIN ap_payments ap
             ON ap.supplier_sync_id = s.sync_id
            AND ap.deleted_at IS NULL
      WHERE s.deleted_at IS NULL${tenantId ? ' AND s.tenant_id = ?' : ''}
      GROUP BY s.sync_id
    ),
    grn_cumulative AS (
      SELECT g.*,
             SUM(g.total_amount) OVER (
               PARTITION BY g.supplier_sync_id
               ORDER BY g.date ASC, g.id ASC
               ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
             ) AS cumulative_amount
      FROM grn g
      WHERE g.deleted_at IS NULL${tenantId ? ' AND g.tenant_id = ?' : ''}
    ),
    grn_with_avail AS (
      SELECT
        gc.*,
        COALESCE(s.name, gc.supplier_name) AS supplier_name,
        COALESCE(sp.total_paid, 0)    AS supplier_total_paid,
        COALESCE(sp.total_paid, 0) - (gc.cumulative_amount - gc.total_amount) AS available_for_grn
      FROM grn_cumulative gc
      LEFT JOIN suppliers     s  ON s.sync_id           = gc.supplier_sync_id
      LEFT JOIN supplier_paid sp ON sp.supplier_sync_id = gc.supplier_sync_id
    )
    SELECT
      gwa.*,
      CASE
        WHEN gwa.available_for_grn <= 0             THEN 0
        WHEN gwa.available_for_grn >= gwa.total_amount THEN gwa.total_amount
        ELSE gwa.available_for_grn
      END AS amount_paid_on_grn,
      gwa.total_amount - CASE
        WHEN gwa.available_for_grn <= 0             THEN 0
        WHEN gwa.available_for_grn >= gwa.total_amount THEN gwa.total_amount
        ELSE gwa.available_for_grn
      END AS balance_on_grn,
      CASE
        WHEN gwa.supplier_total_paid >= gwa.cumulative_amount                          THEN 'Paid'
        WHEN gwa.supplier_total_paid >  gwa.cumulative_amount - gwa.total_amount       THEN 'Partially Paid'
        ELSE 'Not Paid'
      END AS payment_status
    FROM grn_with_avail gwa
    ${extraWhere}
    ORDER BY gwa.date DESC, gwa.id DESC
  `,
  values: tenantId ? [tenantId, tenantId, ...params] : params,
});

// Get all GRNs
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const q = FIFO_SQL('', [], req.user.tenantId);
    const rows = db.prepare(q.text).all(...q.values);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GRN stats
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM grn WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    const thisMonth = db.prepare("SELECT COUNT(*) AS cnt FROM grn WHERE deleted_at IS NULL AND tenant_id = ? AND date >= date('now', 'start of month')").get(tenantId);
    const suppliers = db.prepare('SELECT COUNT(DISTINCT supplier_sync_id) AS cnt FROM grn WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    const unpaid = db.prepare(`
      WITH supplier_paid AS (
        SELECT s.sync_id AS supplier_sync_id, COALESCE(SUM(ap.amount), 0) AS total_paid
        FROM suppliers s
        LEFT JOIN ap_payments ap ON ap.supplier_sync_id = s.sync_id AND ap.deleted_at IS NULL
        WHERE s.deleted_at IS NULL AND s.tenant_id = ?
        GROUP BY s.sync_id
      ),
      grn_cumulative AS (
        SELECT g.*,
               SUM(g.total_amount) OVER (
                 PARTITION BY g.supplier_sync_id
                 ORDER BY g.date ASC, g.id ASC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS cumulative_amount
        FROM grn g
        WHERE g.deleted_at IS NULL AND g.tenant_id = ?
      )
      SELECT COUNT(*) AS cnt
      FROM grn_cumulative gc
      LEFT JOIN supplier_paid sp ON sp.supplier_sync_id = gc.supplier_sync_id
      WHERE COALESCE(sp.total_paid, 0) < gc.cumulative_amount
    `).get(tenantId, tenantId);

    res.json({
      totalGRNs: total.cnt,
      thisMonth: thisMonth.cnt,
      suppliers: suppliers.cnt,
      pending: unpaid.cnt,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create GRN
router.post('/', auth, async (req, res) => {
  try {
    const {
      supplier_id, items, notes, date, invoice_attachment,
      // v1.9.7 â€” HQ-PO-linked GRN flow. When the branch user clicks
      // "Accept & Generate GRN" on an incoming PO line, the frontend
      // passes the parent PO's sync_id + number so this GRN can be
      // tied back to it. The presence of linked_purchase_sync_id
      // switches the GRN into the "pending HQ confirm" mode: NO stock
      // movement happens here â€” that's deferred to /api/hq/grns/:syncId
      // /confirm. AP also stays uncommitted until HQ confirms.
      linked_purchase_sync_id,
      linked_purchase_number,
      // v1.9.12 â€” supplier's invoice number (mandatory at the branch
      // GRN form when linked to a HQ PO). Stored on the grn row so HQ
      // can cross-reference paper invoice â†’ GRN â†’ AP.
      supplier_invoice_number,
      // v1.9.20 â€” supplier name carried in from the HQ PO. Branches no
      // longer maintain a supplier list (no AP at branch), so we just
      // copy the name as text. supplier_id is allowed to be null.
      supplier_name,
      // v1.9.13 â€” inline credit notes for this GRN. Each entry shape:
      //   { reason, amount, notes }
      //   reason âˆˆ Discount|Damaged|Short|Crate Return|Bottle Return|Other
      // amount is always a positive number; it is SUBTRACTED from the
      // GRN total to give the final payable to HQ. Persisted to
      // supplier_credit_notes with grn_sync_id linking back to this GRN.
      credit_notes,
    } = req.body;
    const isHqLinked = !!linked_purchase_sync_id;
    if (isHqLinked && !(supplier_invoice_number || '').toString().trim()) {
      return res.status(400).json({ error: 'Supplier invoice number is required for HQ-linked GRNs.' });
    }
    const grn = db.transaction(() => {
      const grnNum = syncConfig.generateNumber('GRN', 'grn');
      // Total = beverage subtotal + net container settlement (received âˆ’ returned) Ã— deposit.
      // Container net is positive (we owe) when we bought more crates than we returned, and
      // negative (supplier refund / credit) when we returned more than we received.
      const beverageTotal = items.reduce((sum, i) => sum + parseFloat(i.quantity || 0) * parseFloat(i.unit_price || 0), 0);
      const containerTotal = items.reduce((sum, i) => {
        const recv = parseFloat(i.containers_received || 0);
        const ret  = parseFloat(i.containers_returned || 0);
        const dep  = parseFloat(i.container_deposit   || 0);
        return sum + (recv - ret) * dep;
      }, 0);
      const totalAmount = beverageTotal + containerTotal;
      const grnDate = date || new Date().toISOString().split('T')[0];
      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();

      // Tag stock_movements with GRN's business date for Bin Card correctness.
      const movementCreatedAt = grnDate + ' ' + new Date().toTimeString().slice(0, 8);
      const grnSyncId = randomUUID();
      // Prefer client-sent supplier_sync_id over local-id lookup to avoid
      // silent supplier swap on cross-device edits.
      const supplierSyncId = req.body.supplier_sync_id
        || db.prepare('SELECT sync_id FROM suppliers WHERE id = ?').get(supplier_id)?.sync_id
        || null;
      // v1.9.7 â€” for HQ-linked GRNs, leave hq_status='PENDING_HQ_CONFIRM'
      // so the row is visible at HQ's "Confirm GRN" queue but no stock
      // moves yet. Legacy / manual GRNs keep hq_status NULL.
      const hqStatus = isHqLinked ? 'PENDING_HQ_CONFIRM' : null;
      const info = db.prepare(
        `INSERT INTO grn (grn_number, date, supplier_id, supplier_sync_id, supplier_name, total_items, total_amount, notes, invoice_attachment, supplier_invoice_number, created_by, status, linked_purchase_sync_id, linked_purchase_number, hq_status, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,'Completed',?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
      ).run(grnNum, grnDate, supplier_id || null, supplierSyncId, (supplier_name || null), items.length, totalAmount, notes, invoice_attachment || null,
            (supplier_invoice_number || null), req.user.id,
            linked_purchase_sync_id || null, linked_purchase_number || null, hqStatus,
            grnSyncId, tenantId, branchId, deviceId);
      const grnId = info.lastInsertRowid;

      for (const item of items) {
        const prod = db.prepare('SELECT sync_id, unit, alt_unit, conversion_factor, units_json, container_product_sync_id FROM products WHERE id = ?').get(item.product_id);
        // Prefer client-sent product_sync_id over local-id resolution.
        const productSyncId = item.product_sync_id || prod?.sync_id || null;
        const lineUnit = (item.unit || '').trim() || prod?.unit || null;
        const baseQty = parseFloat(item.quantity) * conversionToBase(prod, lineUnit);

        // Container settlement on this line (may be 0/0/0 for non-beverage products).
        const recv = parseFloat(item.containers_received || 0);
        const ret  = parseFloat(item.containers_returned || 0);
        const dep  = parseFloat(item.container_deposit   || 0);
        const containerSyncId = item.container_product_sync_id || prod?.container_product_sync_id || null;

        db.prepare(
          `INSERT INTO grn_items (grn_id, grn_sync_id, product_id, product_sync_id, quantity, unit, unit_price, total_price, expiry_date,
                                  containers_received, containers_returned, container_deposit, container_product_sync_id,
                                  sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
        ).run(grnId, grnSyncId, item.product_id, productSyncId, item.quantity, lineUnit, item.unit_price, item.quantity * item.unit_price,
              item.expiry_date || null,
              recv, ret, dep, containerSyncId,
              randomUUID(), tenantId, branchId, deviceId);

        // v1.9.7 â€” only post stock movements when the GRN is NOT awaiting
        // HQ confirmation. Linked GRNs (Kelete procurement flow) defer the
        // posting to /api/hq/grns/:syncId/confirm so stock and supplier AP
        // both crystallise at the same moment, under HQ control.
        // location='sales' (no store layer â€” confirmed by user: Kelete has
        // no warehouse, every GRN goes straight to the branch sales floor).
        if (!isHqLinked) {
          // Beverage stock movement.
          db.prepare(
            `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)`
          ).run(item.product_id, productSyncId, 'sales', 'grn', baseQty, grnId, 'grn', req.user.id,
                randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, grnSyncId);
          // v1.13.21 â€” pair the movement with a cache bump so
          // products.current_stock doesn't drift from SUM(stock_movements)
          // between boot-time rebuilds. Fixes Category-B drift path #1.
          if (productSyncId) {
            db.prepare(
              `UPDATE products SET current_stock = COALESCE(current_stock, 0) + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
            ).run(baseQty, productSyncId);
          }

          // Container stock movement â€” net (received âˆ’ returned). Skipped when no net change.
          const containerDelta = recv - ret;
          if (containerSyncId && Math.abs(containerDelta) > 0.001) {
            const containerProd = db.prepare('SELECT id FROM products WHERE sync_id = ?').get(containerSyncId);
            db.prepare(
              `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, notes, created_by,
                                            sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)`
            ).run(containerProd?.id || null, containerSyncId, 'sales', 'grn', containerDelta, grnId, 'grn',
                  `Container settlement via ${grnNum}`, req.user.id,
                  randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, grnSyncId);
            // v1.13.21 â€” pair container movement with cache bump too.
            db.prepare(
              `UPDATE products SET current_stock = COALESCE(current_stock, 0) + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
            ).run(containerDelta, containerSyncId);
          }
        }
      }

      // v1.9.7 â€” auto-SIV removed. Kelete has no store layer, so GRN stock
      // movements now post directly at location='sales'. The legacy
      // single_location_mode setting becomes a no-op (UI-hidden in Phase 3
      // cleanup). HQ-linked GRNs likewise defer posting to HQ confirm,
      // which also writes at location='sales'.
      const grnRow = db.prepare('SELECT * FROM grn WHERE id = ?').get(grnId);

      // v1.9.13 â€” inline credit notes attached to the GRN. Each entry
      // becomes a supplier_credit_notes row with grn_sync_id linking
      // back. CN reduces what HQ owes the supplier; HQ will see them on
      // Confirm GRN and the running AP totals.
      // v1.9.17 â€” Crate Return / Goods Return CNs now carry an items[]
      // array; persist into supplier_credit_note_items and (for the
      // returned products) post negative stock_movements at location='sales'
      // so the floor count drops. Mirrors supplierCreditNotes POST exactly.
      if (Array.isArray(credit_notes) && credit_notes.length > 0) {
        const supplierSyncIdForCn = supplierSyncId; // resolved above when inserting grn
        const movementCreatedAt = grnDate + ' ' + new Date().toTimeString().slice(0, 8);
        for (const cn of credit_notes) {
          const reason = (cn?.reason || 'Other').toString();
          const reasonHasStock = reason === 'Crate Return' || reason === 'Bottle Return' || reason === 'Goods Return';
          const validItems = reasonHasStock
            ? (Array.isArray(cn.items) ? cn.items.filter(i => i.product_id && parseFloat(i.quantity) > 0) : [])
            : [];
          const amt = reasonHasStock
            ? validItems.reduce((s, i) => s + parseFloat(i.quantity) * parseFloat(i.unit_value || 0), 0)
            : (Math.abs(parseFloat(cn?.amount || 0)) || 0);
          if (amt < 0.001) continue;
          if (reasonHasStock && validItems.length === 0) continue;

          const noteTxt = (cn?.notes || '').toString();
          const cnNum = syncConfig.generateNumber('SCN', 'supplier_credit_notes');
          const cnSyncId = randomUUID();
          const cnInfo = db.prepare(`
            INSERT INTO supplier_credit_notes (
              credit_note_number, date, supplier_id, supplier_sync_id, reason,
              reference, amount, notes, grn_sync_id, created_by,
              sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
          `).run(
            cnNum, grnDate, supplier_id, supplierSyncIdForCn, reason,
            grnNum, amt, noteTxt, grnSyncId, req.user.id,
            cnSyncId, tenantId, branchId, deviceId
          );
          const cnId = cnInfo.lastInsertRowid;

          if (reasonHasStock) {
            for (const i of validItems) {
              const prod = db.prepare('SELECT sync_id FROM products WHERE id = ?').get(i.product_id);
              const productSyncId = i.product_sync_id || prod?.sync_id || null;
              const qty = parseFloat(i.quantity);
              const unitVal = parseFloat(i.unit_value || 0);
              const linePrice = qty * unitVal;
              const unitName = i.unit || null;
              const unitConv = parseFloat(i.unit_conv) > 0 ? parseFloat(i.unit_conv) : 1;
              const baseQty = qty * unitConv;

              db.prepare(`
                INSERT INTO supplier_credit_note_items (credit_note_id, credit_note_sync_id, product_id, product_sync_id,
                                                         quantity, unit_value, total_price, unit, unit_conv,
                                                         sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
              `).run(cnId, cnSyncId, i.product_id, productSyncId, qty, unitVal, linePrice, unitName, unitConv,
                     randomUUID(), tenantId, branchId, deviceId);

              db.prepare(`
                INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity,
                                             reference_id, reference_type, notes, created_by,
                                             sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)
              `).run(i.product_id, productSyncId, 'sales', 'credit_note', -baseQty,
                     cnId, 'credit_note', `${reason} via ${cnNum}`, req.user.id,
                     randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, cnSyncId);
            }
          }
        }
      }

      return grnRow;
    })();

    // v1.9.7 â€” for HQ-linked GRNs, flip the parent PO line(s) at HQ from
    // AWAITING_GRN â†’ GRN_SUBMITTED so HQ's Confirm GRN queue picks it up.
    // The actual stock + AP commit happens later via /api/hq/grns/:syncId
    // /confirm. We call out to master.db here because the PO lives there;
    // failure is non-fatal (logged) so a flaky master link doesn't lose
    // the GRN the branch just saved.
    if (isHqLinked) {
      try {
        const { masterDb } = require('../config/masterDb');
        if (masterDb) {
          masterDb.prepare(`
            UPDATE hq_purchase_items
               SET status              = 'GRN_SUBMITTED',
                   linked_grn_sync_id  = ?,
                   linked_grn_number   = ?,
                   received_by         = ?,
                   received_by_name    = ?,
                   received_at         = datetime('now')
             WHERE purchase_sync_id = ?
               AND status = 'AWAITING_GRN'
          `).run(grn.sync_id, grn.grn_number, req.user.id || null, req.user.firstName || req.user.email || 'branch', linked_purchase_sync_id);
        }
      } catch (err) {
        console.error('[grn] failed to flag parent PO lines as GRN_SUBMITTED:', err.message);
      }
    }
    // ZRA savePurchase â€” for non-HQ-linked GRNs (direct branch receipts).
    // HQ-linked GRNs upload once HQ confirms them (a follow-up hook in
    // the HQ Confirm route). Skips cleanly when ZRA is off or the GRN
    // is still awaiting HQ confirmation.
    let zra = { skipped: true, reason: 'hq-linked or zra off' };
    if (!isHqLinked) {
      const zraItems = db.prepare(
        `SELECT gi.*, p.name AS product_name, p.code AS product_code,
                p.zra_item_cd, p.zra_item_cls_cd, p.zra_pkg_unit_cd,
                p.zra_qty_unit_cd, p.zra_vat_cat_cd, p.zra_excise_ty_cd, p.zra_rrp
           FROM grn_items gi
           LEFT JOIN products p ON p.id = gi.product_id
          WHERE gi.grn_id = ? AND gi.deleted_at IS NULL`
      ).all(grn.id);
      // Fetch supplier tpin/name if available on the row.
      const supplier = grn.supplier_id ? db.prepare('SELECT name, tpin FROM suppliers WHERE id = ?').get(grn.supplier_id) : null;
      const grnForVsdc = {
        ...grn,
        supplier_name: supplier?.name || null,
        supplier_tpin: supplier?.tpin || null,
      };
      // v1.13.142 â€” BUG A GUARD. Skip savePurchase when this GRN's parent
      // purchase was already registered with ZRA earlier in the flow
      // (grn.zra_pchs_invc_no is stamped by the Phase 2 approve endpoint
      // in routes/zra.js when a ZRA-pulled invoice is converted into an
      // hq_purchase). Without this guard, the legacy /api/grn path fires
      // savePurchase again for the same physical delivery, and ZRA sees
      // the beer counted twice â€” the seller's books over-report inventory
      // and the VAT return is wrong. When the guard skips, we STILL fire
      // the stock chain below (ZRA needs the sarTyCd=02 movement record)
      // and mark zra.status=SKIPPED_ALREADY_REGISTERED for audit clarity.
      if (grn.zra_pchs_invc_no) {
        zra = { skipped: true, reason: 'purchase already registered via HQ approve flow', pchsInvcNo: grn.zra_pchs_invc_no };
      } else {
        zra = await vsdc.savePurchase(req.user.tenantId, grnForVsdc, zraItems, {
          actor: String(req.user?.id || 'system'),
        });
      }
      // Stock chain (SAR 02 = Purchase). Not fatal on failure. Fires
      // whether savePurchase ran or was skipped-because-already-registered â€”
      // ZRA needs the stock movement either way.
      if (zra.ok || zra.skipped) {
        const snapshots = zraItems.map(it => ({
          itemCd: it.zra_item_cd || it.product_code || String(it.product_id),
          rsdQty: parseFloat(db.prepare('SELECT current_stock FROM products WHERE id = ?').get(it.product_id)?.current_stock || 0) || 0,
        }));
        try {
          // v1.13.142 â€” BUG B FIX. Compute per-line tax properly so ZRA sees
          // the real taxable base and VAT for stock arriving, not zeros.
          // Same math as saveNonSaleStockChain / savePurchase itemList:
          //   - splyAmt = qty Ã— cost (VAT-inclusive per Kelete convention)
          //   - taxblAmt = splyAmt / (1 + rate/100)  (exclusive base)
          //   - vatAmt  = splyAmt âˆ’ taxblAmt
          //   - totAmt  = splyAmt
          //   - Zero-rated cats (D, C1, C2, C3, E) â†’ rate 0, vatAmt 0, base = totAmt
          const VAT_RATES = { A: 16, B: 16, C1: 0, C2: 0, C3: 0, D: 0, E: 0, F: 10, RVAT: 16 };
          const items = zraItems.map((it, idx) => {
            const qty     = parseFloat(it.quantity)   || 0;
            const prcInc  = parseFloat(it.cost_price) || 0;
            const grossInc = qty * prcInc;
            const cat     = (it.zra_vat_cat_cd || 'A').toUpperCase();
            const rate    = VAT_RATES[cat] ?? 16;
            const taxbl   = rate > 0 ? grossInc / (1 + rate / 100) : grossInc;
            const vat     = grossInc - taxbl;
            return {
              itemSeq:      idx + 1,
              itemCd:       it.zra_item_cd || it.product_code || String(it.product_id),
              itemClsCd:    it.zra_item_cls_cd || null,
              itemNm:       it.product_name,
              pkgUnitCd:    it.zra_pkg_unit_cd || 'NT',
              pkg:          1,
              qtyUnitCd:    it.zra_qty_unit_cd || 'U',
              qty:          Number(qty.toFixed(2)),
              prc:          Number(prcInc.toFixed(4)),
              splyAmt:      Number(grossInc.toFixed(4)),
              dcAmt:        0,
              taxblAmt:     Number(taxbl.toFixed(4)),
              vatCatCd:     cat,
              exciseTxCatCd: it.zra_excise_ty_cd || null,
              vatAmt:       Number(vat.toFixed(4)),
              taxAmt:       Number(vat.toFixed(4)), // per Â§5.11 taxAmt=vat+ipl+tl+excise; Kelete = vat only
              totAmt:       Number(grossInc.toFixed(4)),
            };
          });
          zra.stockChain = {
            stock:  await vsdc.saveStockItems(req.user.tenantId, grn, items, vsdc.SAR_TY_CD.PURCHASE),
            master: await vsdc.saveStockMaster(req.user.tenantId, snapshots),
          };
        } catch (_) { /* non-fatal */ }
      }
    }
    const finalGrn = zra.skipped ? grn : db.prepare('SELECT * FROM grn WHERE id = ?').get(grn.id);
    res.status(201).json({ ...finalGrn, zra });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Product Received Report
router.get('/product-report', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to, product_id } = req.query;
    const params = [req.user.tenantId];
    const conditions = ['g.deleted_at IS NULL', 'gi.deleted_at IS NULL', 'g.tenant_id = ?'];

    if (from) { params.push(from); conditions.push('g.date >= ?'); }
    if (to)   { params.push(to);   conditions.push('g.date <= ?'); }
    if (product_id) { params.push(parseInt(product_id)); conditions.push('gi.product_sync_id = (SELECT sync_id FROM products WHERE id = ?)'); }

    const where = 'WHERE ' + conditions.join(' AND ');

    const rows = db.prepare(`
      SELECT
        p.id                      AS product_id,
        p.name                    AS product_name,
        p.unit,
        SUM(gi.quantity)          AS total_quantity,
        COUNT(DISTINCT gi.grn_id) AS grn_count,
        SUM(gi.total_price)       AS total_cost,
        MIN(g.date)               AS first_received,
        MAX(g.date)               AS last_received
      FROM grn_items gi
      JOIN grn      g  ON gi.grn_sync_id  = g.sync_id
      JOIN products p  ON gi.product_sync_id = p.sync_id
      ${where}
      GROUP BY p.sync_id, p.name, p.unit
      ORDER BY p.name
    `).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Per-GRN breakdown for a specific product
router.get('/product-breakdown', auth, readOnlyGuard, (req, res) => {
  try {
    const { product_id, from, to } = req.query;
    if (!product_id) return res.status(400).json({ error: 'product_id is required' });
    const params = [req.user.tenantId, parseInt(product_id), req.user.tenantId];
    const conditions = ['g.deleted_at IS NULL', 'gi.deleted_at IS NULL', 'g.tenant_id = ?',
      'gi.product_sync_id = (SELECT sync_id FROM products WHERE id = ? AND tenant_id = ?)'];
    if (from) { params.push(from); conditions.push('g.date >= ?'); }
    if (to)   { params.push(to);   conditions.push('g.date <= ?'); }
    const rows = db.prepare(`
      SELECT g.grn_number, g.date, COALESCE(s.name, g.supplier_name) AS supplier_name,
             gi.quantity, gi.unit_price, gi.total_price
      FROM grn_items gi
      JOIN grn g ON gi.grn_sync_id = g.sync_id
      LEFT JOIN suppliers s ON s.sync_id = g.supplier_sync_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY g.date ASC, g.id ASC
    `).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Expiry Report
router.get('/expiry-report', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const rows = db.prepare(`
      SELECT
        p.id AS product_id,
        p.name AS product_name,
        p.unit,
        g.grn_number,
        g.date AS grn_date,
        gi.quantity,
        gi.unit_price,
        gi.expiry_date,
        CAST(julianday(gi.expiry_date) - julianday('now') AS INTEGER) AS days_remaining
      FROM grn_items gi
      JOIN grn g ON g.sync_id = gi.grn_sync_id
      JOIN products p ON p.sync_id = gi.product_sync_id
      WHERE gi.expiry_date IS NOT NULL
        AND gi.deleted_at IS NULL
        AND g.deleted_at IS NULL
        AND g.tenant_id = ?
      ORDER BY gi.expiry_date ASC
    `).all(tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update GRN
router.put('/:id', auth, (req, res) => {
  try {
    const { supplier_id, date, notes, items, invoice_attachment } = req.body;
    const id = parseInt(req.params.id);
    const validItems = (items || []).filter(i => i.product_id && parseFloat(i.quantity) > 0);
    if (validItems.length === 0) return res.status(400).json({ error: 'At least one valid item is required.' });

    // Beverage + container net = full GRN total (same formula as POST).
    const beverageTotal  = validItems.reduce((s, i) => s + parseFloat(i.quantity) * parseFloat(i.unit_price), 0);
    const containerTotal = validItems.reduce((s, i) => s + (parseFloat(i.containers_received || 0) - parseFloat(i.containers_returned || 0)) * parseFloat(i.container_deposit || 0), 0);
    const totalAmount    = beverageTotal + containerTotal;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    // Stock movements keep the GRN's business date even on edit.
    const movementCreatedAt = date + ' ' + new Date().toTimeString().slice(0, 8);

    db.transaction(() => {
      // Prefer client-sent supplier_sync_id (stable across PCs).
      const updSupplierSyncId = req.body.supplier_sync_id
        || db.prepare('SELECT sync_id FROM suppliers WHERE id = ?').get(supplier_id)?.sync_id
        || null;
      // invoice_attachment: pass null to clear, omit to keep existing
      const keepAttachment = invoice_attachment === undefined;
      const sql = keepAttachment
        ? "UPDATE grn SET supplier_id=?, supplier_sync_id=?, date=?, notes=?, total_items=?, total_amount=?, updated_at=datetime('now'), synced=0 WHERE id=?"
        : "UPDATE grn SET supplier_id=?, supplier_sync_id=?, date=?, notes=?, total_items=?, total_amount=?, invoice_attachment=?, updated_at=datetime('now'), synced=0 WHERE id=?";
      const args = keepAttachment
        ? [supplier_id, updSupplierSyncId, date, notes, validItems.length, totalAmount, id]
        : [supplier_id, updSupplierSyncId, date, notes, validItems.length, totalAmount, invoice_attachment || null, id];
      db.prepare(sql).run(...args);

      const grnRecord = db.prepare('SELECT sync_id FROM grn WHERE id=?').get(id);
      const grnSyncId = grnRecord?.sync_id;

      // v1.13.21 â€” before soft-deleting the old movements, roll their net
      // qty off products.current_stock so the cache stays in sync. Otherwise
      // the edit would leave the cache holding the OLD movement totals PLUS
      // the fresh ones about to be inserted (double count).
      const soonRemoved = db.prepare(
        `SELECT product_sync_id, SUM(quantity) AS net
           FROM stock_movements
          WHERE reference_sync_id = ? AND reference_type = 'grn' AND deleted_at IS NULL
          GROUP BY product_sync_id`
      ).all(grnSyncId);
      const stockDeltaStmt = db.prepare(
        `UPDATE products SET current_stock = COALESCE(current_stock, 0) + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
      );
      for (const r of soonRemoved) {
        if (r.product_sync_id) stockDeltaStmt.run(-r.net, r.product_sync_id);
      }
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='grn' AND deleted_at IS NULL").run(grnSyncId);
      db.prepare("UPDATE grn_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE grn_sync_id=? AND deleted_at IS NULL").run(grnSyncId);

      for (const item of validItems) {
        const qty = parseFloat(item.quantity);
        const price = parseFloat(item.unit_price);
        const prod = db.prepare('SELECT sync_id, unit, alt_unit, conversion_factor, units_json, container_product_sync_id FROM products WHERE id = ?').get(item.product_id);
        // Prefer client-sent product_sync_id (stable across PCs).
        const productSyncId = item.product_sync_id || prod?.sync_id || null;
        const lineUnit = (item.unit || '').trim() || prod?.unit || null;
        const baseQty = qty * conversionToBase(prod, lineUnit);

        const recv = parseFloat(item.containers_received || 0);
        const ret  = parseFloat(item.containers_returned || 0);
        const dep  = parseFloat(item.container_deposit   || 0);
        const containerSyncId = item.container_product_sync_id || prod?.container_product_sync_id || null;

        db.prepare(`INSERT INTO grn_items (grn_id, grn_sync_id, product_id, product_sync_id, quantity, unit, unit_price, total_price, expiry_date,
                                            containers_received, containers_returned, container_deposit, container_product_sync_id,
                                            sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`).run(
          id, grnSyncId, item.product_id, productSyncId, qty, lineUnit, price, qty * price, item.expiry_date || null,
          recv, ret, dep, containerSyncId,
          randomUUID(), tenantId, branchId, deviceId
        );
        db.prepare(`INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id) VALUES (?,?,'store','grn',?,?,?,?,?,?,?,?,0,?,datetime('now'),?)`).run(
          item.product_id, productSyncId, baseQty, id, 'grn', req.user.id, randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, grnSyncId
        );
        // v1.13.21 â€” pair with cache bump (fresh movement on the re-inserted row).
        if (productSyncId) stockDeltaStmt.run(baseQty, productSyncId);

        const containerDelta = recv - ret;
        if (containerSyncId && Math.abs(containerDelta) > 0.001) {
          const containerProd = db.prepare('SELECT id FROM products WHERE sync_id = ?').get(containerSyncId);
          db.prepare(`INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, notes, created_by,
                                                    sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
                      VALUES (?,?,'store','grn',?,?,'grn',?,?,?,?,?,?,0,?,datetime('now'),?)`).run(
            containerProd?.id || null, containerSyncId, containerDelta, id, 'Container settlement (GRN edit)', req.user.id,
            randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, grnSyncId
          );
          stockDeltaStmt.run(containerDelta, containerSyncId);
        }
      }

      // Single-location mode â†’ rebuild the matching auto-SIV from the updated GRN.
      // Soft-delete the previous auto-SIV (and its movements) first so quantities stay consistent.
      deleteAutoSivForGrn(db, grnSyncId);
      if (isSingleLocationMode(db, tenantId)) {
        const grnRow = db.prepare('SELECT * FROM grn WHERE id = ?').get(id);
        createAutoSiv(db, grnRow, validItems, req, syncConfig, { conversionToBase });
      }
    })();

    const q = FIFO_SQL('WHERE gwa.id = ?', [id]);
    const updated = db.prepare(q.text).get(...q.values);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /recent-products â€” return last used products in GRN for quick-add chips
router.get('/recent-products', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.id AS product_id, p.name AS product_name, p.unit,
             gi.unit_price AS last_price
      FROM grn_items gi
      JOIN products p ON p.sync_id = gi.product_sync_id
      JOIN grn g ON g.id = gi.grn_id
      WHERE g.deleted_at IS NULL AND gi.deleted_at IS NULL AND g.tenant_id = ?
      GROUP BY p.id
      ORDER BY MAX(g.created_at) DESC
      LIMIT 10
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /notes â€” return distinct past notes for autocomplete
router.get('/notes', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      "SELECT notes, MAX(created_at) AS last_used FROM grn WHERE deleted_at IS NULL AND tenant_id = ? AND notes IS NOT NULL AND notes != '' GROUP BY notes ORDER BY last_used DESC LIMIT 50"
    ).all(req.user.tenantId);
    res.json(rows.map(r => r.notes));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get GRN by ID
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const q = FIFO_SQL('WHERE gwa.id = ?', [req.params.id], req.user.tenantId);
    const grn = db.prepare(q.text).get(...q.values);
    if (grn) {
      const creator = db.prepare(`SELECT first_name || ' ' || last_name AS name FROM users WHERE id = ?`).get(grn.created_by);
      grn.created_by_name = creator?.name || 'â€”';
    }
    const items = db.prepare(
      `SELECT gi.*, p.name AS product_name, p.unit AS product_unit, p.alt_unit, p.conversion_factor, p.units_json
       FROM grn_items gi
       LEFT JOIN products p ON gi.product_sync_id = p.sync_id
       WHERE gi.grn_sync_id = (SELECT sync_id FROM grn WHERE id = ? AND tenant_id = ?)
         AND gi.deleted_at IS NULL`
    ).all(req.params.id, req.user.tenantId);
    res.json({ ...grn, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete GRN (soft-delete parent; hard-delete sub-records to reverse stock)
router.delete('/:id', auth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const result = db.transaction(() => {
      const grn = db.prepare('SELECT * FROM grn WHERE id = ? AND deleted_at IS NULL').get(id);
      if (!grn) throw Object.assign(new Error('GRN not found.'), { status: 404 });

      // If this GRN spawned an auto-SIV (single-location mode), the stock now lives at
      // location='sales'. Deleting the GRN cascades the auto-SIV first, which would
      // remove the sales stock â€” so the constraint is "enough stock at SALES to absorb the reversal".
      // Otherwise the dual-location flow puts the stock in `store`, and the constraint stays there.
      const autoSiv = db.prepare("SELECT 1 FROM siv WHERE source_grn_sync_id = ? AND deleted_at IS NULL").get(grn.sync_id);
      const checkLocation = autoSiv ? 'sales' : 'store';

      const itemsRows = db.prepare(`
        SELECT
          gi.product_id,
          gi.quantity                       AS grn_qty_line,
          gi.unit                           AS line_unit,
          p.name                            AS product_name,
          p.unit                            AS base_unit,
          p.alt_unit, p.conversion_factor, p.units_json,
          COALESCE(sm_agg.current_stock, 0) AS current_stock
        FROM grn_items gi
        JOIN products p ON p.sync_id = gi.product_sync_id
        LEFT JOIN (
          SELECT product_sync_id, SUM(quantity) AS current_stock
          FROM stock_movements WHERE location = ? AND deleted_at IS NULL
          GROUP BY product_sync_id
        ) sm_agg ON sm_agg.product_sync_id = gi.product_sync_id
        WHERE gi.grn_sync_id = ? AND gi.deleted_at IS NULL
      `).all(checkLocation, grn.sync_id);

      // Convert each line's qty to base units (so we compare apples to apples with current_stock).
      const enriched = itemsRows.map(r => {
        const grnQtyBase = parseFloat(r.grn_qty_line) * conversionToBase({
          unit: r.base_unit, alt_unit: r.alt_unit,
          conversion_factor: r.conversion_factor, units_json: r.units_json,
        }, r.line_unit);
        return {
          product_name: r.product_name,
          unit: r.base_unit,
          line_unit: r.line_unit,
          grn_qty_line: parseFloat(r.grn_qty_line),
          grn_qty: grnQtyBase,                      // in base units
          current_stock: parseFloat(r.current_stock), // in base units
        };
      });

      const violations = enriched.filter(r => r.current_stock - r.grn_qty < 0);
      if (violations.length > 0) {
        const where = autoSiv ? 'sales counter' : 'store';
        throw Object.assign(new Error(`Cannot delete: ${where} stock would go negative â€” some of this GRN's stock has already been ${autoSiv ? 'sold' : 'issued'}.`), {
          status: 400,
          violations: violations.map(v => ({
            product_name: v.product_name, unit: v.unit,
            grn_qty: v.grn_qty,
            current_stock: v.current_stock,
            shortfall: v.grn_qty - v.current_stock,
          })),
        });
      }

      // Soft-delete the auto-SIV first (if any) â€” it'll cascade its own stock movements too.
      deleteAutoSivForGrn(db, grn.sync_id);
      // v1.13.21 â€” roll the GRN's net stock movement off products.current_stock
      // BEFORE soft-deleting the rows, so the cache stays in sync. Without
      // this, the cache would still hold the "+baseQty" from the original
      // GRN even after the movement is soft-deleted â†’ drift.
      const soonRemoved = db.prepare(
        `SELECT product_sync_id, SUM(quantity) AS net
           FROM stock_movements
          WHERE reference_sync_id = ? AND reference_type = 'grn' AND deleted_at IS NULL
          GROUP BY product_sync_id`
      ).all(grn.sync_id);
      const stockDeltaStmt = db.prepare(
        `UPDATE products SET current_stock = COALESCE(current_stock, 0) + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
      );
      for (const r of soonRemoved) {
        if (r.product_sync_id) stockDeltaStmt.run(-r.net, r.product_sync_id);
      }
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='grn' AND deleted_at IS NULL").run(grn.sync_id);
      db.prepare("UPDATE grn_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE grn_sync_id=? AND deleted_at IS NULL").run(grn.sync_id);
      db.prepare("UPDATE grn SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(id);
      return null;
    })();

    res.json({ message: 'GRN deleted successfully.' });
  } catch (error) {
    if (error.violations) {
      return res.status(error.status || 400).json({ error: error.message, violations: error.violations });
    }
    res.status(error.status || 500).json({ error: error.message });
  }
});

module.exports = router;
