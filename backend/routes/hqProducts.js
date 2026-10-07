/**
 * hqProducts.js â€” HQ-owned product master + auto-push to branches.
 *
 * Design (v1.5.0 â€” per user spec on 2026-06-23):
 *   HQ owns: code, name, category, base unit, packagings (units_json),
 *            default_unit, photo (image_url), container link + units
 *            per container, UB barcode settings.
 *   Branch owns: cost_price, selling_price, alt_price, min_stock,
 *                status, current_stock (opening), notes.
 *
 * On push:
 *   - Every registered branch gets a COPY in its own products table
 *     using the SAME sync_id; is_hq_owned=1 marks the row as HQ-managed.
 *   - INSERT writes only HQ-owned columns; branch fields start blank
 *     (cost/selling=0, status='Active', current_stock=0) so the branch
 *     can fill them in. Item stays hidden from POS until they do.
 *   - UPDATE always OVERWRITES the HQ-owned columns at every branch
 *     (per user: "yes overwrite"). Never touches branch-owned columns
 *     so a price the branch set survives every HQ tweak.
 *
 * Auto-pushing is synchronous-best-effort: a branch DB that won't open
 * is logged + skipped; the master row is still saved so HQ can re-push
 * later via /api/hq/products/:id/push.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { masterDb, listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');

function hqAuth(req, res, next) {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Access denied' });
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'kelete-pro-secret-key-2026');
    next();
  } catch (_) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Push an HQ master product into every registered branch's products
// table. Idempotent: matches on sync_id.
//
// HQ-owned columns (always pushed/overwritten on UPDATE):
//   code, name, unit, units_json, default_unit, image_url,
//   container_product_sync_id, units_per_container,
//   ub_number_start, ub_number_length, ub_quantity_start,
//   ub_quantity_length, ub_decimal_start, is_hq_owned=1
//
// Branch-owned columns (NEVER touched after first INSERT):
//   cost_price, selling_price, alt_price, min_stock, status,
//   current_stock, notes
//
// On INSERT these start blank (cost/selling=0, current_stock=0,
// status='Active') so POS keeps the item hidden until the branch sets
// a real selling_price.
function pushToBranches(hqRow) {
  const out = { pushed: 0, updated: 0, skipped: 0, errors: [] };
  for (const t of listTenants()) {
    try {
      const db = getTenantDb(t.slug);
      // CRITICAL â€” branch's GET /api/products filters
      //   WHERE p.tenant_id = req.user.tenantId
      // so a row inserted with tenant_id NULL is invisible to the branch's
      // Item Details page. Read the branch's own tenant_id from its
      // sync_config so the row is visible + scoped correctly. branch_id
      // similarly read so the device_filter on later reports doesn't drop
      // these rows. v1.3.4 hotfix for v1.3.3.
      // Discover the branch's tenant_id in order of reliability:
      //   1. master.branches.tenant_id    (AUTHORITATIVE â€” joined into
      //                                     listTenants as t.tenant_id;
      //                                     populated by registerBranch
      //                                     during initial activation)
      //   2. sync_config['tenant_id']     (per-branch DB store, often
      //                                     empty on freshly-activated
      //                                     branches that haven't been
      //                                     logged into yet)
      //   3. Any existing products row's non-empty tenant_id
      //   4. business_settings.tenant_id
      // None of the four? Skip the INSERT and report the error in the
      // push response so the operator sees it.
      let branchTenantId = t.tenant_id || null;
      let branchBranchId = null;
      if (!branchTenantId) {
        try {
          const tRow = db.prepare("SELECT value FROM sync_config WHERE key = 'tenant_id'").get();
          if (tRow?.value) branchTenantId = tRow.value;
        } catch (_) {}
      }
      if (!branchTenantId) {
        try {
          const r = db.prepare("SELECT tenant_id FROM products WHERE tenant_id IS NOT NULL AND tenant_id != '' LIMIT 1").get();
          if (r?.tenant_id) branchTenantId = r.tenant_id;
        } catch (_) {}
      }
      if (!branchTenantId) {
        try {
          const r = db.prepare("SELECT tenant_id FROM business_settings WHERE tenant_id IS NOT NULL AND tenant_id != '' LIMIT 1").get();
          if (r?.tenant_id) branchTenantId = r.tenant_id;
        } catch (_) {}
      }
      try {
        const bRow = db.prepare("SELECT value FROM sync_config WHERE key = 'branch_id'").get();
        if (bRow?.value) branchBranchId = bRow.value;
      } catch (_) {}
      if (!branchBranchId) {
        try {
          const r = db.prepare("SELECT branch_id FROM products WHERE branch_id IS NOT NULL AND branch_id != '' LIMIT 1").get();
          if (r?.branch_id) branchBranchId = r.branch_id;
        } catch (_) {}
      }
      if (!branchTenantId) {
        out.errors.push({ slug: t.slug, error: 'No tenant_id discoverable (not in master.branches, sync_config, products, or business_settings). Activate the branch by logging into it once to bootstrap, or run UPDATE manually.' });
        continue;
      }

      // Backfill any orphan v1.3.3 row first (tenant_id NULL from the
      // bug) so it becomes visible to the branch's GET /api/products
      // immediately on the next push â€” no DB surgery needed.
      if (branchTenantId) {
        try {
          db.prepare(`UPDATE products SET tenant_id = ?, branch_id = COALESCE(branch_id, ?) WHERE sync_id = ? AND (tenant_id IS NULL OR tenant_id = '')`)
            .run(branchTenantId, branchBranchId, hqRow.sync_id);
        } catch (_) {}
      }

      // HQ-side Deleted â†’ soft-delete the matching branch row so it
      // disappears from Item Details / POS / pickers (their GETs all
      // filter `deleted_at IS NULL`). Historical orders + GRN lines
      // reference sync_id, not the row, so they keep rendering fine.
      if (hqRow.status === 'Deleted') {
        try {
          const info = db.prepare(`
            UPDATE products
               SET deleted_at = datetime('now'),
                   updated_at = datetime('now'),
                   synced = 0
             WHERE sync_id = ? AND deleted_at IS NULL
          `).run(hqRow.sync_id);
          if (info.changes > 0) out.updated += 1;
          else out.skipped += 1;
        } catch (e) {
          out.errors.push({ slug: t.slug, error: e.message });
        }
        continue;
      }

      const existing = db.prepare(
        'SELECT id FROM products WHERE sync_id = ? AND deleted_at IS NULL'
      ).get(hqRow.sync_id);
      if (existing) {
        // UPDATE: only HQ-owned columns. Branch-owned (cost_price,
        // selling_price, min_stock, status, current_stock) are not
        // touched even if HQ has values for them.
        db.prepare(`
          UPDATE products
             SET code = ?, name = ?, unit = ?,
                 units_json = ?, default_unit = ?, image_url = ?,
                 container_product_sync_id = ?, units_per_container = ?,
                 ub_number_start = ?, ub_number_length = ?,
                 ub_quantity_start = ?, ub_quantity_length = ?,
                 ub_decimal_start = ?,
                 is_hq_owned = 1,
                 updated_at = datetime('now'), synced = 0
           WHERE id = ?
        `).run(
          hqRow.code || null, hqRow.name, hqRow.unit || 'pcs',
          hqRow.units_json || null, hqRow.default_unit || null, hqRow.image_url || null,
          hqRow.container_product_sync_id || null,
          hqRow.units_per_container || null,
          hqRow.ub_number_start    ?? 1,
          hqRow.ub_number_length   ?? 6,
          hqRow.ub_quantity_start  ?? 7,
          hqRow.ub_quantity_length ?? 0,
          hqRow.ub_decimal_start   ?? 2,
          existing.id
        );
        out.updated += 1;
      } else {
        // INSERT: HQ-owned fields filled, branch-owned start blank.
        // status='Active' so the row isn't dead on arrival; cost+price=0
        // so POS keeps it hidden until the branch sets a real price.
        db.prepare(`
          INSERT INTO products (code, name, unit, cost_price, selling_price,
                                current_stock, min_stock, units_json,
                                default_unit, image_url,
                                container_product_sync_id, units_per_container,
                                ub_number_start, ub_number_length,
                                ub_quantity_start, ub_quantity_length, ub_decimal_start,
                                status, is_hq_owned,
                                sync_id, tenant_id, branch_id, device_id,
                                synced, created_at, updated_at)
          VALUES (?,?,?,0,0,0,0,?,?,?,?,?,?,?,?,?,?,'Active',1,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(
          hqRow.code || null, hqRow.name, hqRow.unit || 'pcs',
          hqRow.units_json || null, hqRow.default_unit || null, hqRow.image_url || null,
          hqRow.container_product_sync_id || null,
          hqRow.units_per_container || null,
          hqRow.ub_number_start    ?? 1,
          hqRow.ub_number_length   ?? 6,
          hqRow.ub_quantity_start  ?? 7,
          hqRow.ub_quantity_length ?? 0,
          hqRow.ub_decimal_start   ?? 2,
          hqRow.sync_id, branchTenantId, branchBranchId, null
        );
        out.pushed += 1;
      }
    } catch (e) {
      out.errors.push({ slug: t.slug, error: e.message });
    }
  }
  return out;
}

// GET /api/hq/products?status=Active|Inactive|&q=
// Deleted rows are excluded by default so the HQ list + branch picker
// don't show ghost products. Pass ?status=Deleted explicitly to surface
// them (e.g. for an admin "trash" view later).
router.get('/', hqAuth, (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const q      = String(req.query.q || '').trim().toLowerCase();
    let sql = `SELECT * FROM hq_products WHERE 1=1`;
    const params = [];
    if (status) {
      sql += ' AND status = ?'; params.push(status);
    } else {
      sql += " AND status != 'Deleted'";
    }
    if (q) { sql += ' AND LOWER(name) LIKE ?'; params.push(`%${q}%`); }
    sql += ' ORDER BY name COLLATE NOCASE ASC';
    res.json({ products: masterDb.prepare(sql).all(...params) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/products/:id â€” header + per-branch override snapshot so HQ
// can see which branches deviated from the default cost/selling.
router.get('/:id', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Product not found' });
    const branches = [];
    for (const t of listTenants()) {
      try {
        const db = getTenantDb(t.slug);
        const p = db.prepare(
          'SELECT id, cost_price, selling_price, current_stock, min_stock FROM products WHERE sync_id = ?'
        ).get(row.sync_id);
        branches.push({ slug: t.slug, name: t.business_name || t.slug, found: !!p, ...p });
      } catch (e) {
        branches.push({ slug: t.slug, name: t.business_name || t.slug, error: e.message });
      }
    }
    res.json({ product: row, branches });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/products
// v1.5.0: prices/min_stock/notes removed (branch-owned). Adds default_unit,
// container, UB barcode. product_type field is gone â€” branch products
// always default to 'finished'.
router.post('/', hqAuth, (req, res) => {
  try {
    const { code, name, category_name, main_category_name, unit,
            units_json, status, image_url,
            default_unit, container_product_sync_id, units_per_container,
            ub_number_start, ub_number_length, ub_quantity_start,
            ub_quantity_length, ub_decimal_start } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const dup = masterDb.prepare(`SELECT id FROM hq_products WHERE LOWER(name) = LOWER(?) AND status != 'Deleted'`).get(name.trim());
    if (dup) return res.status(400).json({ error: 'A product with this name already exists in the HQ master' });

    const syncId = randomUUID();
    const createdBy     = req.user.id || null;
    const createdByName = req.user.firstName || req.user.email || 'HQ';
    const info = masterDb.prepare(`
      INSERT INTO hq_products (sync_id, code, name, category_name, main_category_name,
                               unit, units_json, status, image_url,
                               default_unit, container_product_sync_id, units_per_container,
                               ub_number_start, ub_number_length, ub_quantity_start,
                               ub_quantity_length, ub_decimal_start,
                               created_by, created_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      syncId, code || null, name.trim(),
      category_name || null, main_category_name || null,
      unit || 'pcs',
      units_json || null,
      (status === 'Inactive' ? 'Inactive' : 'Active'),
      image_url || null,
      default_unit || null,
      container_product_sync_id || null,
      units_per_container ? parseFloat(units_per_container) : null,
      parseInt(ub_number_start)    || 1,
      parseInt(ub_number_length)   || 6,
      parseInt(ub_quantity_start)  || 7,
      parseInt(ub_quantity_length) || 0,
      parseInt(ub_decimal_start)   || 2,
      createdBy, createdByName
    );
    const row = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(info.lastInsertRowid);
    const pushReport = pushToBranches(row);
    res.status(201).json({ product: row, push: pushReport });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/products/:id
// v1.5.0: every HQ edit always overwrites the HQ-owned fields on every
// branch (per user spec). Branch-owned columns (cost, price, min stock,
// status) are never touched.
router.put('/:id', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Product not found' });
    const { code, name, category_name, main_category_name, unit,
            units_json, status, image_url,
            default_unit, container_product_sync_id, units_per_container,
            ub_number_start, ub_number_length, ub_quantity_start,
            ub_quantity_length, ub_decimal_start } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (name.trim().toLowerCase() !== row.name.toLowerCase()) {
      const dup = masterDb.prepare(`SELECT id FROM hq_products WHERE LOWER(name) = LOWER(?) AND id != ?`).get(name.trim(), req.params.id);
      if (dup) return res.status(400).json({ error: 'Another HQ product already uses this name' });
    }
    masterDb.prepare(`
      UPDATE hq_products
         SET code = ?, name = ?, category_name = ?, main_category_name = ?,
             unit = ?, units_json = ?, status = ?, image_url = ?,
             default_unit = ?, container_product_sync_id = ?, units_per_container = ?,
             ub_number_start = ?, ub_number_length = ?, ub_quantity_start = ?,
             ub_quantity_length = ?, ub_decimal_start = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(
      code || null, name.trim(),
      category_name || null, main_category_name || null,
      unit || 'pcs', units_json || null,
      (status === 'Inactive' ? 'Inactive' : 'Active'),
      image_url || null,
      default_unit || null,
      container_product_sync_id || null,
      units_per_container ? parseFloat(units_per_container) : null,
      parseInt(ub_number_start)    || 1,
      parseInt(ub_number_length)   || 6,
      parseInt(ub_quantity_start)  || 7,
      parseInt(ub_quantity_length) || 0,
      parseInt(ub_decimal_start)   || 2,
      req.params.id
    );
    const updated = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    const pushReport = pushToBranches(updated);
    res.json({ product: updated, push: pushReport });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/hq/products/:id â€” soft-delete with full history guard,
// matching the per-branch products DELETE behaviour (products.js:502).
// Blocks if ANY of the following reference the product's sync_id:
//   - GRN / SIV / order lines at any branch
//   - sales_return (damages) lines at any branch
//   - HQ purchase lines (master.db) â€” any non-cancelled status counts
// When clear: status='Deleted' on hq_products (frees the name for
// re-use), pushToBranches sees Deleted and soft-deletes the matching
// branch row (deleted_at = now). Historical rows that pre-dated all
// of this are unaffected â€” they reference the snapshot, not the live
// row.
router.delete('/:id', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Product not found' });

    // Walk every registered branch and count references. Errors per
    // branch don't block the delete attempt â€” they get reported so HQ
    // sees which branch DB couldn't be checked and can re-try.
    const blockers = [];
    const branchErrors = [];
    for (const t of listTenants()) {
      try {
        const db = getTenantDb(t.slug);
        const counts = {
          grn:     db.prepare('SELECT COUNT(*) AS c FROM grn_items           WHERE product_sync_id = ? AND deleted_at IS NULL').get(row.sync_id).c,
          siv:     db.prepare('SELECT COUNT(*) AS c FROM siv_items           WHERE product_sync_id = ? AND deleted_at IS NULL').get(row.sync_id).c,
          orders:  db.prepare('SELECT COUNT(*) AS c FROM order_items         WHERE product_sync_id = ? AND deleted_at IS NULL').get(row.sync_id).c,
          damages: db.prepare('SELECT COUNT(*) AS c FROM sales_return_items  WHERE product_sync_id = ? AND deleted_at IS NULL').get(row.sync_id).c,
        };
        const branchLabel = t.business_name || t.slug;
        if (counts.grn)     blockers.push(`${counts.grn} GRN line(s) at ${branchLabel}`);
        if (counts.siv)     blockers.push(`${counts.siv} SIV line(s) at ${branchLabel}`);
        if (counts.orders)  blockers.push(`${counts.orders} sales line(s) at ${branchLabel}`);
        if (counts.damages) blockers.push(`${counts.damages} damages line(s) at ${branchLabel}`);
      } catch (e) {
        branchErrors.push(`${t.slug}: ${e.message}`);
      }
    }
    // HQ-side check: any non-cancelled HQ Purchase line that targets
    // this product (regardless of branch). Cancelled lines don't count
    // since they never created any real history.
    const hqRefs = masterDb.prepare(`
      SELECT COUNT(*) AS c FROM hq_purchase_items
       WHERE product_sync_id = ? AND status != 'CANCELLED'
    `).get(row.sync_id).c;
    if (hqRefs > 0) blockers.push(`${hqRefs} HQ purchase line(s)`);

    if (blockers.length > 0) {
      return res.status(400).json({
        error: `Cannot delete "${row.name}" â€” it is used in ${blockers.join(', ')}. Remove or cancel those records first, or mark the product inactive instead.`,
      });
    }
    if (branchErrors.length > 0) {
      return res.status(503).json({
        error: `Could not verify history at every branch (${branchErrors.join('; ')}). Retry once those branches are reachable.`,
      });
    }

    masterDb.prepare(`UPDATE hq_products SET status = 'Deleted', updated_at = datetime('now') WHERE id = ?`).run(req.params.id);
    const updated = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    pushToBranches(updated);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/products/:id/push â€” manual re-push (handy for newly-added
// branches that joined after the product was created, or to recover
// after a transient branch DB failure).
router.post('/:id/push', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare(`SELECT * FROM hq_products WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Product not found' });
    res.json(pushToBranches(row));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
