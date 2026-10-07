/**
 * hqPush.js â€” helpers for pushing HQ-owned rows to every registered branch.
 *
 * v1.6.0 extends the HQ-owned set beyond Products: Categories, Main
 * Categories and Units are now also HQ-managed. When a write hits one of
 * these routes ON the HQ host (keletezm.com), the row is INSERT/UPDATE/
 * soft-deleted at every branch with is_hq_owned=1 so branches can read
 * but can't edit.
 *
 * Detection: SKIP_SLUGS / HQ_SLUGS mirror what middleware/tenant.js
 * uses. Default DB (backend/kelete.db) is HQ's source of truth, so any
 * insert on it triggers a push.
 */
const HQ_SLUGS  = new Set(['keletedistributionzm']);
const SKIP_SLUGS = new Set(['www', 'kelete', 'keletedistributionzm', 'localhost', 'api', '127', 'sidanitsolutions']);

function getHostSlug(req) {
  const host = (req.headers['x-tenant'] || req.hostname || '').toLowerCase();
  return host.split('.')[0];
}

function isHqRequest(req) {
  const slug = getHostSlug(req);
  return HQ_SLUGS.has(slug);
}

// v1.7.8: merge HQ's units_json (structure: name, conv, is_base, barcode,
// extra_barcodes) with the branch's units_json (price field). Branch owns
// the per-packaging selling price the same way it owns the top-level
// selling_price column. HQ re-pushes never wipe local prices.
//
// Returns a JSON string (matches the column shape). When the branch has no
// existing row for a given unit name, falls back to HQ's price (initial
// state on first push â€” usually 0, branch sets the real number locally).
function mergeUnitsJsonPreservingBranchPrices(hqJson, branchJson) {
  let hqUnits = [];
  let branchUnits = [];
  try { hqUnits = JSON.parse(hqJson || '[]'); } catch { hqUnits = []; }
  try { branchUnits = JSON.parse(branchJson || '[]'); } catch { branchUnits = []; }
  if (!Array.isArray(hqUnits) || hqUnits.length === 0) return hqJson || null;
  const branchByName = new Map(
    (Array.isArray(branchUnits) ? branchUnits : [])
      .map(u => [String(u?.name || '').trim().toLowerCase(), u])
  );
  const merged = hqUnits.map(hu => {
    const key = String(hu?.name || '').trim().toLowerCase();
    const bu = branchByName.get(key);
    const branchPrice = bu && bu.price !== undefined && bu.price !== null && bu.price !== ''
      ? parseFloat(bu.price)
      : null;
    return {
      ...hu,
      price: (branchPrice !== null && !isNaN(branchPrice))
        ? branchPrice
        : (parseFloat(hu?.price) || 0),
    };
  });
  return JSON.stringify(merged);
}

// SKIP_SLUGS only routes â€” true HQ, not a per-branch tenant. We push on
// these because middleware/tenant.js routes them to the default DB.
function isHqOrSkip(req) {
  const slug = getHostSlug(req);
  return !slug || HQ_SLUGS.has(slug) || SKIP_SLUGS.has(slug);
}

// Push a category row to every registered branch. Matches on sync_id;
// updates the name / color / main_category_sync_id / is_hq_owned on
// existing rows, inserts new ones. Soft-deleted on HQ â†’ soft-deleted at
// every branch.
function pushCategoryToBranches(catRow, { listTenants, getTenantDb }) {
  const out = { pushed: 0, updated: 0, errors: [] };
  for (const t of listTenants()) {
    try {
      const db = getTenantDb(t.slug);
      const branchTenantId = t.tenant_id || readSyncTenantId(db, t.slug);
      if (!branchTenantId) { out.errors.push({ slug: t.slug, error: 'No tenant_id discoverable' }); continue; }

      if (catRow.deleted_at) {
        const info = db.prepare(`
          UPDATE categories
             SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
           WHERE sync_id = ? AND deleted_at IS NULL
        `).run(catRow.sync_id);
        if (info.changes > 0) out.updated += 1;
        continue;
      }

      // v1.10.22 â€” resolve main_category_id (local FK) from the incoming
      // main_category_sync_id so UPDATE re-links Crates â†’ Beverage when HQ
      // reassigns the parent. Previously UPDATE only refreshed the sync_id
      // pointer, leaving the FK stale and items grouped under Uncategorized.
      let mainCatId = null;
      if (catRow.main_category_sync_id) {
        const mc = db.prepare('SELECT id FROM main_categories WHERE sync_id = ? AND deleted_at IS NULL').get(catRow.main_category_sync_id);
        mainCatId = mc?.id || null;
      }
      const existing = db.prepare('SELECT id FROM categories WHERE sync_id = ? AND deleted_at IS NULL').get(catRow.sync_id);
      if (existing) {
        db.prepare(`
          UPDATE categories
             SET name = ?, color = ?,
                 main_category_id = ?,
                 main_category_sync_id = ?,
                 tenant_id = COALESCE(NULLIF(tenant_id, ''), ?),
                 is_hq_owned = 1,
                 updated_at = datetime('now'), synced = 0
           WHERE id = ?
        `).run(
          catRow.name, catRow.color || null,
          mainCatId, catRow.main_category_sync_id || null,
          branchTenantId,
          existing.id
        );
        out.updated += 1;
      } else {
        db.prepare(`
          INSERT INTO categories
            (name, color, main_category_id, main_category_sync_id, is_hq_owned,
             sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,?,?,1,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(
          catRow.name, catRow.color || null, mainCatId, catRow.main_category_sync_id || null,
          catRow.sync_id, branchTenantId, null, null
        );
        out.pushed += 1;
      }
    } catch (e) {
      out.errors.push({ slug: t.slug, error: e.message });
    }
  }
  return out;
}

function pushMainCategoryToBranches(mcRow, { listTenants, getTenantDb }) {
  const out = { pushed: 0, updated: 0, errors: [] };
  for (const t of listTenants()) {
    try {
      const db = getTenantDb(t.slug);
      const branchTenantId = t.tenant_id || readSyncTenantId(db, t.slug);
      if (!branchTenantId) { out.errors.push({ slug: t.slug, error: 'No tenant_id discoverable' }); continue; }

      if (mcRow.deleted_at) {
        const info = db.prepare(`
          UPDATE main_categories
             SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
           WHERE sync_id = ? AND deleted_at IS NULL
        `).run(mcRow.sync_id);
        if (info.changes > 0) out.updated += 1;
        continue;
      }

      const existing = db.prepare('SELECT id FROM main_categories WHERE sync_id = ? AND deleted_at IS NULL').get(mcRow.sync_id);
      if (existing) {
        db.prepare(`
          UPDATE main_categories
             SET name = ?, color = ?,
                 tenant_id = COALESCE(NULLIF(tenant_id, ''), ?),
                 is_hq_owned = 1,
                 updated_at = datetime('now'), synced = 0
           WHERE id = ?
        `).run(mcRow.name, mcRow.color || null, branchTenantId, existing.id);
        out.updated += 1;
      } else {
        db.prepare(`
          INSERT INTO main_categories (name, color, is_hq_owned, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,1,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(mcRow.name, mcRow.color || null, mcRow.sync_id, branchTenantId, null, null);
        out.pushed += 1;
      }
    } catch (e) {
      out.errors.push({ slug: t.slug, error: e.message });
    }
  }
  return out;
}

function pushUnitToBranches(unitRow, { listTenants, getTenantDb }) {
  const out = { pushed: 0, updated: 0, errors: [] };
  for (const t of listTenants()) {
    try {
      const db = getTenantDb(t.slug);
      const branchTenantId = t.tenant_id || readSyncTenantId(db, t.slug);
      if (!branchTenantId) { out.errors.push({ slug: t.slug, error: 'No tenant_id discoverable' }); continue; }

      if (unitRow.deleted_at) {
        const info = db.prepare(`
          UPDATE units
             SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
           WHERE sync_id = ? AND deleted_at IS NULL
        `).run(unitRow.sync_id);
        if (info.changes > 0) out.updated += 1;
        continue;
      }

      const existing = db.prepare('SELECT id FROM units WHERE sync_id = ? AND deleted_at IS NULL').get(unitRow.sync_id);
      if (existing) {
        db.prepare(`
          UPDATE units
             SET name = ?, abbreviation = ?,
                 tenant_id = COALESCE(NULLIF(tenant_id, ''), ?),
                 is_hq_owned = 1,
                 updated_at = datetime('now'), synced = 0
           WHERE id = ?
        `).run(unitRow.name, unitRow.abbreviation || null, branchTenantId, existing.id);
        out.updated += 1;
      } else {
        db.prepare(`
          INSERT INTO units (name, abbreviation, is_hq_owned, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,1,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(unitRow.name, unitRow.abbreviation || null, unitRow.sync_id, branchTenantId, null, null);
        out.pushed += 1;
      }
    } catch (e) {
      out.errors.push({ slug: t.slug, error: e.message });
    }
  }
  return out;
}

// v1.6.5: also checks the slug-prefixed key (`tenant:<slug>`) that HQ-
// activated branches use, and falls back to any existing products row's
// tenant_id. listTenants() in masterDb already JOINs branches.tenant_id
// so callers pass t.tenant_id first; this helper is the fallback when
// that's null (fresh branch never logged into).
function readSyncTenantId(db, slug = null) {
  try {
    const sql = slug
      ? "SELECT value FROM sync_config WHERE key = 'tenant_id' OR key = ? ORDER BY (key = 'tenant_id') DESC LIMIT 1"
      : "SELECT value FROM sync_config WHERE key = 'tenant_id' LIMIT 1";
    const row = slug ? db.prepare(sql).get(`tenant:${slug}`) : db.prepare(sql).get();
    if (row?.value) return row.value;
  } catch (_) {}
  try {
    const r = db.prepare("SELECT tenant_id FROM products WHERE tenant_id IS NOT NULL AND tenant_id != '' LIMIT 1").get();
    return r?.tenant_id || null;
  } catch { return null; }
}

// v1.6.1: Products now follow the same flow as Categories/Units. HQ uses
// the standard Item Details page; saves auto-push to every branch with
// is_hq_owned=1. Branches lock the HQ-owned columns via the tab UI.
//
// HQ-owned columns (pushed/overwritten on UPDATE):
//   code, name, unit, units_json, default_unit, image_url,
//   container_product_sync_id, units_per_container,
//   ub_number_start/length, ub_quantity_start/length, ub_decimal_start,
//   category (resolved by sync_id, same lookup as branches receive),
//   ZRA classification (v1.13.73):
//     hs_code, tax_label, zra_item_cls_cd, zra_item_ty_cd,
//     zra_orgn_nat_cd, zra_pkg_unit_cd, zra_qty_unit_cd,
//     zra_vat_cat_cd, zra_excise_ty_cd, zra_rrp.
//   Rationale: ZRA classification is per-SKU (an item is MTV or not,
//   regardless of which branch sells it). HQ owns the master truth so
//   the same UNSPSC/VAT-cat/RRP flows to every branch.
// Branch-owned columns (never touched after first INSERT):
//   cost_price, selling_price, alt_price, min_stock, status,
//   current_stock, notes.
//
// NEW â€” Fix A (UAT-2 gap): HQ now owns the INITIAL cost/selling price on
// create. First-time branch INSERT inherits prodRow.cost_price /
// selling_price / alt_price / current_stock instead of hard-zeroing.
// Routine UPDATEs still leave prices alone (branch-owned) UNLESS the
// caller passes pushPrices=true, in which case cost/selling/alt +
// units_json are force-overwritten (used by the "push price to all"
// checkbox on the HQ edit modal and the bulk push button).
//
// ZRA cascade: after INSERT/UPDATE, if the branch has ZRA enabled + a
// SDC device configured and its local product row was never registered
// with VSDC, fire vsdcClient.saveItem in the branch's DB context via
// setImmediate. Fire-and-forget so the HTTP push response is never
// blocked by VSDC's round-trip. saveItem() writes zra_registered_at /
// zra_last_error itself (using the ALS-scoped db proxy), so we just
// need to run it inside runWithDb(branchDb, â€¦).
function pushProductToBranches(prodRow, { listTenants, getTenantDb, pushPrices = false }) {
  const out = { pushed: 0, updated: 0, errors: [] };
  for (const t of listTenants()) {
    try {
      const db = getTenantDb(t.slug);
      const branchTenantId = t.tenant_id || readSyncTenantId(db, t.slug);
      if (!branchTenantId) { out.errors.push({ slug: t.slug, error: 'No tenant_id discoverable' }); continue; }

      if (prodRow.deleted_at) {
        const info = db.prepare(`
          UPDATE products
             SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
           WHERE sync_id = ? AND deleted_at IS NULL
        `).run(prodRow.sync_id);
        if (info.changes > 0) out.updated += 1;

        // v1.13.144 â€” Fix A part 3: cascade the soft-delete to ZRA via
        // updateItem with useYn='N'. ZRA has no dedicated deleteItem
        // endpoint per spec Â§5.7 â€” deactivation is done by re-sending
        // the item with useYn='N'. Skip if branch is ZRA-off or the
        // branch mirror was never registered (nothing to deactivate).
        try {
          const bs = db.prepare(
            "SELECT zra_enabled, zra_sdc_id FROM business_settings WHERE tenant_id = ? LIMIT 1"
          ).get(branchTenantId);
          const isZraOn = (bs?.zra_enabled === 1 || bs?.zra_enabled === '1') && !!bs?.zra_sdc_id;
          if (isZraOn) {
            const branchProduct = db.prepare(
              'SELECT * FROM products WHERE sync_id = ?'
            ).get(prodRow.sync_id);
            if (branchProduct?.zra_registered_at) {
              const dbProxy = require('../config/database');
              const vsdc    = require('../services/vsdcClient');
              setImmediate(() => {
                dbProxy.runWithDb(db, async () => {
                  try {
                    // Override useYn to 'N' by decorating the product
                    // object â€” vsdcClient reads product.zra_use_yn || 'Y'
                    // when building the saveItem/updateItem body.
                    await vsdc.saveItem(
                      branchTenantId,
                      { ...branchProduct, zra_use_yn: 'N' },
                      { isUpdate: true, actor: 'hq-cascade-delete' }
                    );
                  } catch (e) {
                    try {
                      db.prepare(
                        "UPDATE products SET zra_last_error = ? WHERE id = ?"
                      ).run(String(e.message || e).slice(0, 250), branchProduct.id);
                    } catch (_) {}
                  }
                });
              });
            }
          }
        } catch (_) { /* best-effort â€” never break soft-delete on ZRA plumbing */ }

        continue;
      }

      // Resolve category_id at the branch by sync_id (HQ category was
      // pushed earlier via pushCategoryToBranches so the row exists).
      let branchCategoryId = null;
      if (prodRow.category_sync_id) {
        const c = db.prepare('SELECT id FROM categories WHERE sync_id = ? AND deleted_at IS NULL').get(prodRow.category_sync_id);
        branchCategoryId = c?.id || null;
      }

      // v1.6.8: alt_unit / conversion_factor are HQ-owned (they describe
      // the packaging structure HQ defines). alt_price is NOT â€” that's
      // the branch's per-packaging selling price. So we push the structural
      // alt_unit + conversion_factor but leave alt_price alone (only set
      // it on the initial INSERT when the row doesn't exist yet).
      const existing = db.prepare('SELECT id, units_json FROM products WHERE sync_id = ? AND deleted_at IS NULL').get(prodRow.sync_id);
      // v1.13.144 â€” Snapshot the branch's ZRA-relevant fields BEFORE we
      // overwrite them, so the post-UPDATE cascade can decide whether
      // to fire vsdc.saveItem (isUpdate:true). If any of these changed
      // we push updateItem; if nothing changed we skip (saves API calls
      // and avoids ZRA churn on every price-only edit).
      const preUpdateZraSnap = existing
        ? db.prepare(
            'SELECT name, zra_item_cls_cd, zra_vat_cat_cd, zra_pkg_unit_cd, zra_qty_unit_cd, zra_orgn_nat_cd, zra_item_ty_cd, zra_rrp, selling_price FROM products WHERE id = ?'
          ).get(existing.id)
        : null;
      if (existing) {
        // v1.7.8: per-packaging selling `price` inside units_json is BRANCH-
        // owned (same rule as legacy alt_price + the top-level selling_price
        // column). HQ owns structure (name, conv, is_base, barcode); branch
        // owns price. Merge so re-pushes from HQ don't wipe local prices.
        //
        // Fix A: when pushPrices=true, HQ's units_json (prices included)
        // wins outright â€” no merge. Also extend the SET list with
        // cost_price/selling_price/alt_price so branch overrides get wiped.
        const mergedUnitsJson = pushPrices
          ? (prodRow.units_json || null)
          : mergeUnitsJsonPreservingBranchPrices(prodRow.units_json, existing.units_json);
        const priceSetSql = pushPrices
          ? ', cost_price = ?, selling_price = ?, alt_price = ?'
          : '';
        const priceArgs = pushPrices
          ? [
              prodRow.cost_price    == null ? 0    : prodRow.cost_price,
              prodRow.selling_price == null ? 0    : prodRow.selling_price,
              prodRow.alt_price     == null ? null : prodRow.alt_price,
            ]
          : [];
        db.prepare(`
          UPDATE products
             SET code = ?, name = ?, category_id = ?, category_sync_id = ?,
                 unit = ?, units_json = ?, default_unit = ?, image_url = ?,
                 container_product_sync_id = ?, units_per_container = ?,
                 ub_number_start = ?, ub_number_length = ?,
                 ub_quantity_start = ?, ub_quantity_length = ?,
                 ub_decimal_start = ?,
                 alt_unit = ?, conversion_factor = ?,
                 hs_code = ?, tax_label = ?,
                 zra_item_cls_cd = ?, zra_item_ty_cd = ?, zra_orgn_nat_cd = ?,
                 zra_pkg_unit_cd = ?, zra_qty_unit_cd = ?, zra_vat_cat_cd = ?,
                 zra_excise_ty_cd = ?, zra_rrp = ?${priceSetSql},
                 is_hq_owned = 1,
                 updated_at = datetime('now'), synced = 0
           WHERE id = ?
        `).run(
          prodRow.code || null, prodRow.name,
          branchCategoryId, prodRow.category_sync_id || null,
          prodRow.unit || 'pcs', mergedUnitsJson,
          prodRow.default_unit || null, prodRow.image_url || null,
          prodRow.container_product_sync_id || null,
          prodRow.units_per_container || null,
          prodRow.ub_number_start ?? 1, prodRow.ub_number_length ?? 6,
          prodRow.ub_quantity_start ?? 7, prodRow.ub_quantity_length ?? 0,
          prodRow.ub_decimal_start ?? 2,
          prodRow.alt_unit || null, prodRow.conversion_factor || null,
          // v1.13.73 â€” ZRA classification pushed as HQ-owned. Any of these
          // being NULL on HQ side wipes them on the branch too â€” that's
          // intended: HQ is the master of truth for ZRA metadata.
          prodRow.hs_code           || null,
          prodRow.tax_label         || null,
          prodRow.zra_item_cls_cd   || null,
          prodRow.zra_item_ty_cd    || null,
          prodRow.zra_orgn_nat_cd   || null,
          prodRow.zra_pkg_unit_cd   || null,
          prodRow.zra_qty_unit_cd   || null,
          prodRow.zra_vat_cat_cd    || null,
          prodRow.zra_excise_ty_cd  || null,
          prodRow.zra_rrp           == null ? null : prodRow.zra_rrp,
          ...priceArgs,
          existing.id
        );
        out.updated += 1;
      } else {
        // Fix A: inherit HQ's cost/selling/alt/current_stock on first insert
        // so branches don't start at 0 and force the operator to type prices
        // into every branch manually. Routine UPDATE still leaves prices
        // alone unless pushPrices is set.
        db.prepare(`
          INSERT INTO products
            (code, name, category_id, category_sync_id, unit, cost_price, selling_price,
             current_stock, min_stock, units_json, default_unit, image_url,
             container_product_sync_id, units_per_container,
             ub_number_start, ub_number_length, ub_quantity_start,
             ub_quantity_length, ub_decimal_start,
             alt_unit, conversion_factor, alt_price,
             hs_code, tax_label,
             zra_item_cls_cd, zra_item_ty_cd, zra_orgn_nat_cd,
             zra_pkg_unit_cd, zra_qty_unit_cd, zra_vat_cat_cd,
             zra_excise_ty_cd, zra_rrp,
             status, is_hq_owned, product_type,
             sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'Active',1,'finished',?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(
          prodRow.code || null, prodRow.name,
          branchCategoryId, prodRow.category_sync_id || null,
          prodRow.unit || 'pcs',
          prodRow.cost_price    || 0,
          prodRow.selling_price || 0,
          prodRow.current_stock || 0,
          prodRow.units_json || null, prodRow.default_unit || null, prodRow.image_url || null,
          prodRow.container_product_sync_id || null,
          prodRow.units_per_container || null,
          prodRow.ub_number_start ?? 1, prodRow.ub_number_length ?? 6,
          prodRow.ub_quantity_start ?? 7, prodRow.ub_quantity_length ?? 0,
          prodRow.ub_decimal_start ?? 2,
          prodRow.alt_unit || null, prodRow.conversion_factor || null,
          prodRow.alt_price     == null ? null : prodRow.alt_price,
          // v1.13.73 â€” same ZRA field push as UPDATE branch above; seeds
          // brand-new branch rows with HQ's classification so first sale
          // there doesn't blow up saveSales for missing tax category.
          prodRow.hs_code           || null,
          prodRow.tax_label         || null,
          prodRow.zra_item_cls_cd   || null,
          prodRow.zra_item_ty_cd    || null,
          prodRow.zra_orgn_nat_cd   || null,
          prodRow.zra_pkg_unit_cd   || null,
          prodRow.zra_qty_unit_cd   || null,
          prodRow.zra_vat_cat_cd    || null,
          prodRow.zra_excise_ty_cd  || null,
          prodRow.zra_rrp           == null ? null : prodRow.zra_rrp,
          prodRow.sync_id, branchTenantId, null, null
        );
        out.pushed += 1;
      }

      // Fix A â€” ZRA cascade. HQ has no VSDC device, so saveItem() at HQ
      // returns { skipped: true } and the branch mirror stays unregistered
      // forever. Fire saveItem in the branch's DB context now, so the item
      // lands in ZRA under the branch's SDC. Skip when branch ZRA is off or
      // the mirror row is already registered.
      //
      // Fire-and-forget via setImmediate â€” VSDC round-trip must not block
      // the HTTP push response. saveItem() writes zra_registered_at /
      // zra_last_error itself via the ALS-scoped `db` proxy; we run it
      // inside runWithDb(branchDb, â€¦) so those writes hit the branch DB.
      try {
        const bs = db.prepare(
          "SELECT zra_enabled, zra_sdc_id FROM business_settings WHERE tenant_id = ? LIMIT 1"
        ).get(branchTenantId);
        const isZraOn = (bs?.zra_enabled === 1 || bs?.zra_enabled === '1') && !!bs?.zra_sdc_id;
        if (isZraOn) {
          const branchProduct = db.prepare(
            'SELECT * FROM products WHERE sync_id = ? AND deleted_at IS NULL'
          ).get(prodRow.sync_id);
          if (branchProduct && !branchProduct.zra_registered_at) {
            const dbProxy = require('../config/database');
            const vsdc    = require('../services/vsdcClient');
            setImmediate(() => {
              dbProxy.runWithDb(db, async () => {
                try {
                  await vsdc.saveItem(branchTenantId, branchProduct, {
                    isUpdate: false,
                    actor:    'hq-cascade',
                  });
                  // vsdc.saveItem writes zra_registered_at + zra_last_error
                  // itself on success/failure â€” no extra UPDATE needed here.
                } catch (e) {
                  try {
                    db.prepare(
                      "UPDATE products SET zra_last_error = ? WHERE id = ?"
                    ).run(String(e.message || e).slice(0, 250), branchProduct.id);
                  } catch (_) {}
                }
              });
            });
          } else if (branchProduct?.zra_registered_at && preUpdateZraSnap) {
            // v1.13.144 â€” Fix A part 2: product is ALREADY registered with
            // ZRA. If HQ changed any ZRA-relevant field (name, UNSPSC, VAT
            // cat, packaging, quantity unit, origin, item type, RRP), fire
            // vsdc.saveItem with isUpdate:true so ZRA's copy stays in sync
            // with HQ's. Skip when only price changed â€” price isn't sent
            // to ZRA as an updatable field. Curl-verified 2026-08-14 that
            // /items/updateItem needs vatCatCd non-null; saveItem already
            // sends it, so isUpdate:true reuses the same payload.
            const norm = v => (v == null || v === '') ? null : String(v);
            // Price check compares the branch's OLD price vs the branch's
            // POST-UPDATE price (branchProduct.selling_price), NOT vs HQ's
            // prodRow.selling_price â€” because the sticky-branch rule means
            // HQ's price only lands on the branch when pushPrices=true. If
            // HQ raised its own price with the checkbox unticked, branch
            // stays put â†’ no ZRA update needed. Only when the branch's
            // ACTUAL price changed (checkbox tick / bulk push) do we push.
            const priceChanged =
              Number(preUpdateZraSnap.selling_price || 0) !== Number(branchProduct.selling_price || 0);
            const zraFieldsChanged =
              norm(preUpdateZraSnap.name)             !== norm(prodRow.name) ||
              norm(preUpdateZraSnap.zra_item_cls_cd)  !== norm(prodRow.zra_item_cls_cd) ||
              norm(preUpdateZraSnap.zra_vat_cat_cd)   !== norm(prodRow.zra_vat_cat_cd) ||
              norm(preUpdateZraSnap.zra_pkg_unit_cd)  !== norm(prodRow.zra_pkg_unit_cd) ||
              norm(preUpdateZraSnap.zra_qty_unit_cd)  !== norm(prodRow.zra_qty_unit_cd) ||
              norm(preUpdateZraSnap.zra_orgn_nat_cd)  !== norm(prodRow.zra_orgn_nat_cd) ||
              norm(preUpdateZraSnap.zra_item_ty_cd)   !== norm(prodRow.zra_item_ty_cd) ||
              Number(preUpdateZraSnap.zra_rrp || 0)   !== Number(prodRow.zra_rrp || 0) ||
              priceChanged;
            if (zraFieldsChanged) {
              const dbProxy = require('../config/database');
              const vsdc    = require('../services/vsdcClient');
              setImmediate(() => {
                dbProxy.runWithDb(db, async () => {
                  try {
                    await vsdc.saveItem(branchTenantId, branchProduct, {
                      isUpdate: true,
                      actor:    'hq-cascade-update',
                    });
                  } catch (e) {
                    try {
                      db.prepare(
                        "UPDATE products SET zra_last_error = ? WHERE id = ?"
                      ).run(String(e.message || e).slice(0, 250), branchProduct.id);
                    } catch (_) {}
                  }
                });
              });
            }
          }
        }
      } catch (_) { /* best-effort â€” never break push on ZRA plumbing */ }
    } catch (e) {
      out.errors.push({ slug: t.slug, error: e.message });
    }
  }
  return out;
}

// v1.9.0 â€” bulk sweep helper. Reads every HQ-owned row (main categories,
// categories, units, products) from the default DB and pushes each one to
// every branch via the per-row helpers above. Branch-owned columns
// (selling_price, cost_price, current_stock, min_stock, status, notes,
// alt_price, units_json.price) stay untouched â€” see pushProductToBranches
// for the per-column rules.
//
// Use cases (the "3 layers"):
//   Layer 1 â€” boot heal:     called once at server start, targetSlug=null
//   Layer 2 â€” on-register:   called once when a tenant DB is created,
//                            targetSlug=<that slug>
//   Layer 3 â€” manual refresh: called from HQ admin button, targetSlug=null
//
// Returns: { entities: {â€¦counts}, per_branch: { slug: { products: {â€¦} â€¦ } } }
function mirrorAllHqToBranches(defaultDb, { listTenants, getTenantDb, targetSlug = null, pushPrices = false, itemClassesIfMissing = false } = {}) {
  if (!defaultDb || typeof defaultDb.prepare !== 'function') {
    throw new Error('mirrorAllHqToBranches: defaultDb is required');
  }
  const allTenants = listTenants();
  const tenants = targetSlug
    ? allTenants.filter(t => t.slug === targetSlug)
    : allTenants;

  // Pre-read HQ source rows. deleted_at IS NULL: only push live entities.
  // Soft-deletes are handled inline by the per-row helpers (each branch
  // sets deleted_at on its mirror), but a sweep only re-pushes living rows
  // because we have no easy way to know what the branch should forget
  // without a cross-DB scan.
  const safeAll = (sql) => {
    try { return defaultDb.prepare(sql).all(); }
    catch { return []; }
  };
  const mainCats   = safeAll(`SELECT * FROM main_categories WHERE deleted_at IS NULL`);
  const categories = safeAll(`SELECT * FROM categories       WHERE deleted_at IS NULL`);
  const units      = safeAll(`SELECT * FROM units            WHERE deleted_at IS NULL`);
  const products   = safeAll(`SELECT * FROM products         WHERE deleted_at IS NULL`);
  // v1.13.147 â€” HQ's zra_item_classes (UNSPSC catalog) gets mirrored to
  // every branch too. HQ bulk-imports the full ~40k-158k row official
  // ZRA UNSPSC-Classification-Codes.xlsx (T03A spec explicitly allows
  // Excel upload as an alternative to the VSDC pull); branches otherwise
  // only accumulate whatever their own /itemClass/selectItemsClass VSDC
  // sync has pulled, which can lag far behind (observed: Garden had 1,000
  // rows vs HQ's 158,448 â€” real product codes existed at HQ but showed
  // "(loading nameâ€¦)" at the branch because the LOCAL cache, not the
  // fiscal record, was incomplete). Bulk INSERT OR REPLACE per branch â€”
  // this is reference data, not per-branch fiscal state, so a full
  // overwrite is always safe and idempotent.
  //
  // 2026-09-13 â€” itemClassesIfMissing (the boot sweep passes it). The catalogue
  // is ~158k rows, and upserting it into every branch on every restart held
  // the whole server â€” every till and every report â€” for minutes after each
  // deploy. It is reference data that only changes when HQ imports a new list,
  // so the boot sweep copies it only into a branch holding fewer rows than HQ,
  // and reads HQ's rows only if one does. Sync Products to All and a new
  // branch still copy it in full.
  const classSql = `SELECT item_cls_cd, item_cls_nm, item_cls_lvl, tax_ty_cd, mjr_tg_yn, use_yn, updated_at FROM zra_item_classes`;
  let zraItemClasses = itemClassesIfMissing ? null : safeAll(classSql);
  let hqClassCount = 0;
  if (itemClassesIfMissing) {
    try { hqClassCount = defaultDb.prepare('SELECT COUNT(*) AS n FROM zra_item_classes').get().n || 0; }
    catch { hqClassCount = 0; }
  } else {
    hqClassCount = zraItemClasses.length;
  }

  const per_branch = {};
  for (const t of tenants) {
    // Re-target the per-row helpers at a single branch by wrapping
    // listTenants so they only iterate this one t.
    const singleCtx = { listTenants: () => [t], getTenantDb };
    const acc = {
      main_categories:   { pushed: 0, updated: 0, errors: [] },
      categories:        { pushed: 0, updated: 0, errors: [] },
      units:             { pushed: 0, updated: 0, errors: [] },
      products:          { pushed: 0, updated: 0, errors: [] },
      zra_item_classes:  { pushed: 0, updated: 0, errors: [] },
    };
    const merge = (key, r) => {
      acc[key].pushed  += r.pushed  || 0;
      acc[key].updated += r.updated || 0;
      if (r.errors && r.errors.length) acc[key].errors.push(...r.errors);
    };
    // Order matters: main_categories â†’ categories â†’ units â†’ products
    // (products resolve category_id by sync_id; that sync_id must already
    //  exist at the branch when the product push runs).
    for (const mc of mainCats)   merge('main_categories', pushMainCategoryToBranches(mc, singleCtx));
    for (const c  of categories) merge('categories',      pushCategoryToBranches(c,    singleCtx));
    for (const u  of units)      merge('units',           pushUnitToBranches(u,        singleCtx));
    for (const p  of products)   merge('products',        pushProductToBranches(p,     { ...singleCtx, pushPrices }));

    if (hqClassCount) {
      try {
        const branchDb = getTenantDb(t.slug);
        let needed = true;
        if (itemClassesIfMissing) {
          let have = 0;
          try { have = branchDb.prepare('SELECT COUNT(*) AS n FROM zra_item_classes').get().n || 0; }
          catch { have = 0; }
          needed = have < hqClassCount;
        }
        if (needed) {
          if (zraItemClasses === null) zraItemClasses = safeAll(classSql);
          const upsert = branchDb.prepare(`
            INSERT INTO zra_item_classes (item_cls_cd, item_cls_nm, item_cls_lvl, tax_ty_cd, mjr_tg_yn, use_yn, updated_at)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(item_cls_cd) DO UPDATE SET
              item_cls_nm=excluded.item_cls_nm, item_cls_lvl=excluded.item_cls_lvl,
              tax_ty_cd=excluded.tax_ty_cd, mjr_tg_yn=excluded.mjr_tg_yn,
              use_yn=excluded.use_yn, updated_at=excluded.updated_at`);
          const tx = branchDb.transaction((rows) => {
            for (const r of rows) upsert.run(r.item_cls_cd, r.item_cls_nm, r.item_cls_lvl, r.tax_ty_cd, r.mjr_tg_yn, r.use_yn, r.updated_at);
          });
          tx(zraItemClasses);
          acc.zra_item_classes.pushed = zraItemClasses.length;
        }
      } catch (e) {
        acc.zra_item_classes.errors.push(`${t.slug}: ${e.message}`);
      }
    }
    per_branch[t.slug] = acc;
  }

  return {
    entities: {
      main_categories:  mainCats.length,
      categories:       categories.length,
      units:            units.length,
      products:         products.length,
      zra_item_classes: hqClassCount,
    },
    target_slug: targetSlug || null,
    branch_count: tenants.length,
    per_branch,
  };
}

module.exports = {
  isHqRequest, isHqOrSkip, getHostSlug,
  pushCategoryToBranches, pushMainCategoryToBranches, pushUnitToBranches,
  pushProductToBranches,
  mergeUnitsJsonPreservingBranchPrices,
  mirrorAllHqToBranches,
};
