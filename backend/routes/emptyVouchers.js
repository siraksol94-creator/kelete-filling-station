// emptyVouchers.js — v1.13.67
//
// Bearer-voucher deposit system for empty containers.
//
//   Controller station:  POST /                 issue a new voucher
//                        GET  /                 list vouchers (filter by status)
//                        GET  /:codeOrId        look up one voucher by number or id
//                        PUT  /:id/void         admin: mark VOID (lost slip / dispute)
//   POS side:            claims are attached to orders (see routes/orders.js POST)
//
// Sales Report + Cash Book never see any of this — empties are physical
// stock, not money. Uploading returned empties to EMPTY ZB stock is
// handled at issue time here (positive stock_movement + products.current_stock).
//
// v1.13.62's customers.empty_balance is now dormant but not dropped —
// nothing writes to it anymore. Kept in schema for backwards compat.

const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// ─── helpers ────────────────────────────────────────────────────────
function actorName(req) {
  return `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim()
       || req.user?.email
       || 'staff';
}

function resolveEmptyProduct() {
  // The EMPTY ZB product is picked once by admin in System Settings and
  // stored as business_settings.empty_container_product_sync_id. When
  // unset the voucher still works — just no stock movement is posted.
  const bs = db.prepare(
    "SELECT empty_container_product_sync_id FROM business_settings LIMIT 1"
  ).get();
  const syncId = bs?.empty_container_product_sync_id;
  if (!syncId) return null;
  return db.prepare(
    'SELECT id, sync_id FROM products WHERE sync_id = ? AND deleted_at IS NULL'
  ).get(syncId) || null;
}

// ─── GET /api/empty-vouchers ────────────────────────────────────────
// Filters:
//   status=ACTIVE|CLAIMED|VOID (default: all)
//   q=free-text — split by whitespace; each token must match ANY of
//     voucher_number / issued_to_name / issued_to_phone (tokenised AND).
//   active_only=1 — force ACTIVE + qty_remaining > 0. POS uses this so
//     claimed / voided vouchers never surface in the voucher picker.
//   limit — cap results (default 200, max 1000).
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const status = String(req.query.status || '').toUpperCase();
    const q      = String(req.query.q || '').trim();
    const limit  = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    const activeOnly = ['1', 'true', 'yes'].includes(String(req.query.active_only || '').toLowerCase());
    const clauses = ['deleted_at IS NULL'];
    const params  = [];
    // active_only wins over an explicit status filter — it's the safer
    // default for POS lookups. Otherwise honour whatever status was passed.
    if (activeOnly) {
      clauses.push("status = 'ACTIVE'");
      clauses.push('qty_remaining > 0');
    } else if (['ACTIVE', 'CLAIMED', 'VOID'].includes(status)) {
      clauses.push('status = ?');
      params.push(status);
    }
    if (q) {
      // v1.13.69 — tokenised search: whitespace-split the query and
      // require every token to match at least one of the three columns.
      // Lets cashier type "sirak 097" or "EMP 0001" and land on the
      // right voucher without needing the exact number.
      const tokens = q.split(/\s+/).filter(Boolean).slice(0, 6);
      for (const tok of tokens) {
        clauses.push('(voucher_number LIKE ? OR issued_to_name LIKE ? OR issued_to_phone LIKE ?)');
        const like = `%${tok}%`;
        params.push(like, like, like);
      }
    }
    const rows = db.prepare(`
      SELECT id, sync_id, voucher_number, qty_original, qty_remaining,
             issued_to_name, issued_to_phone, notes, status,
             product_sync_id, product_name,
             issued_at, issued_by_name,
             void_reason, void_at, void_by_name
        FROM empty_vouchers
       WHERE ${clauses.join(' AND ')}
       ORDER BY id DESC
       LIMIT ?
    `).all(...params, limit);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /api/empty-vouchers/:codeOrId ──────────────────────────────
// Accepts either the numeric id or the voucher_number. Returns the voucher
// header + its claim history. Powers the POS lookup + the balance page detail.
router.get('/:codeOrId', auth, readOnlyGuard, (req, res) => {
  try {
    const key = String(req.params.codeOrId || '').trim();
    if (!key) return res.status(400).json({ error: 'code or id required' });
    // Try id first, then voucher_number.
    let voucher = null;
    if (/^\d+$/.test(key)) {
      voucher = db.prepare(
        'SELECT * FROM empty_vouchers WHERE id = ? AND deleted_at IS NULL'
      ).get(parseInt(key, 10));
    }
    if (!voucher) {
      voucher = db.prepare(
        'SELECT * FROM empty_vouchers WHERE voucher_number = ? AND deleted_at IS NULL'
      ).get(key);
    }
    if (!voucher) return res.status(404).json({ error: 'Voucher not found' });
    const claims = db.prepare(`
      SELECT id, sync_id, order_number, qty_claimed, notes,
             claimed_at, claimed_by_name
        FROM empty_voucher_claims
       WHERE voucher_id = ?
       ORDER BY id DESC
    `).all(voucher.id);
    res.json({ voucher, claims });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /api/empty-vouchers ───────────────────────────────────────
// Controller station: record N empties returned + issue voucher.
// Body: { qty, issued_to_name?, issued_to_phone?, notes? }
// Response: { voucher, slip_text }
router.post('/', auth, (req, res) => {
  try {
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const { qty, issued_to_name, issued_to_phone, notes, product_sync_id } = req.body || {};
    const q = Math.max(0, parseInt(qty, 10) || 0);
    if (!(q > 0)) return res.status(400).json({ error: 'qty must be > 0.' });

    const voucherNumber = syncConfig.generateNumber('EMP', 'empty_vouchers');
    const syncId  = randomUUID();

    // 2026-08-30 — the voucher says WHICH empty was handed in.
    //
    // This used to call resolveEmptyProduct(), which read a single product
    // named in business_settings. That setting has no UI and was never set, so
    // every voucher silently posted no stock at all — slips printed while
    // "Total empties held" stayed at zero. And even set, one product cannot
    // represent EMPTY ZB, EMPTY 500ML and an empty crate at once.
    //
    // The chosen product wins; the old setting remains a fallback so an
    // installation that did configure one keeps working.
    let emptyProd = null;
    if (product_sync_id) {
      emptyProd = db.prepare(
        'SELECT id, sync_id, name FROM products WHERE sync_id = ? AND deleted_at IS NULL'
      ).get(product_sync_id) || null;
      if (!emptyProd) return res.status(400).json({ error: 'That product could not be found.' });
    } else {
      emptyProd = resolveEmptyProduct();
    }
    if (!emptyProd) {
      return res.status(400).json({
        error: 'Pick which empty is being returned — no empty product was selected.',
      });
    }
    const name = actorName(req);

    const info = db.transaction(() => {
      const ins = db.prepare(`
        INSERT INTO empty_vouchers
          (voucher_number, sync_id, qty_original, qty_remaining,
           issued_to_name, issued_to_phone, notes,
           product_sync_id, product_name,
           status, issued_by, issued_by_name,
           tenant_id, branch_id, device_id, synced)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, 0)
      `).run(
        voucherNumber, syncId, q, q,
        issued_to_name?.trim() || null,
        issued_to_phone?.trim() || null,
        notes?.trim() || null,
        emptyProd.sync_id, emptyProd.name || null,
        req.user.id, name,
        tenantId, branchId || null, deviceId || null,
      );
      // +q to the chosen empty's stock (physical inbound). No longer
      // conditional: a product is guaranteed by the check above, so a voucher
      // can no longer be issued that quietly moves nothing.
      {
        db.prepare(`
          INSERT INTO stock_movements
            (product_id, product_sync_id, location, movement_type, quantity,
             reference_id, reference_type, created_by, sync_id,
             tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
          VALUES (?, ?, 'sales', 'empty_voucher_issued', ?, ?, 'empty_voucher',
                  ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'), ?)
        `).run(
          emptyProd.id, emptyProd.sync_id, q,
          ins.lastInsertRowid, req.user.id, randomUUID(),
          tenantId, branchId || null, deviceId || null, syncId,
        );
        db.prepare(
          "UPDATE products SET current_stock = current_stock + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?"
        ).run(q, emptyProd.sync_id);
      }
      return ins;
    })();

    const voucher = db.prepare('SELECT * FROM empty_vouchers WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({
      voucher,
      slip_text: renderSlip(voucher, name),
      stock_updated: !!emptyProd,
    });
  } catch (e) {
    console.error('[emptyVouchers.POST]', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /api/empty-vouchers/:id/void ───────────────────────────────
// Admin-only: mark a voucher VOID. Existing claims are preserved (audit
// trail). qty_remaining is not touched — but status=VOID blocks further
// claims. Requires a reason (lost slip, dispute, cashier error, etc.).
router.put('/:id/void', auth, (req, res) => {
  try {
    if (req.user?.role !== 'Administrator' && req.user?.role !== 'Admin') {
      return res.status(403).json({ error: 'Administrator only.' });
    }
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason is required.' });
    const voucher = db.prepare('SELECT * FROM empty_vouchers WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!voucher) return res.status(404).json({ error: 'Voucher not found.' });
    if (voucher.status === 'VOID') return res.status(400).json({ error: 'Already void.' });
    db.prepare(`
      UPDATE empty_vouchers
         SET status='VOID', void_reason=?, void_at=datetime('now'),
             void_by=?, void_by_name=?, updated_at=datetime('now'), synced=0
       WHERE id = ?
    `).run(reason, req.user.id, actorName(req), req.params.id);
    res.json(db.prepare('SELECT * FROM empty_vouchers WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── helpers ────────────────────────────────────────────────────────
function renderSlip(voucher, issuedByName) {
  const dt = new Date(voucher.issued_at + 'Z').toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const lines = [
    '=========================================',
    '          EMPTY CONTAINER SLIP',
    '=========================================',
    `Voucher #: ${voucher.voucher_number}`,
    // 2026-08-30 — name the empty. A slip reading "12 empties" was fine while
    // there was only ever one kind; now that a voucher is per-product, the
    // person redeeming it at POS has to be able to see 12 of WHAT.
    voucher.product_name ? `Item:      ${voucher.product_name}` : null,
    `Qty:       ${voucher.qty_original} empties`,
    voucher.issued_to_name ? `Issued to: ${voucher.issued_to_name}` : null,
    voucher.issued_to_phone ? `Phone:     ${voucher.issued_to_phone}` : null,
    `Date:      ${dt}`,
    `By:        ${issuedByName}`,
    voucher.notes ? `Notes:     ${voucher.notes}` : null,
    '=========================================',
    '  Bring this slip to POS to redeem',
    '=========================================',
  ].filter(Boolean).join('\n');
  return lines;
}

module.exports = router;
