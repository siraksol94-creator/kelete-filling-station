const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard, withTenantDb } = require('../middleware/auth');
const { isHqRequest, pushProductToBranches, pushCategoryToBranches, pushMainCategoryToBranches, mergeUnitsJsonPreservingBranchPrices, mirrorAllHqToBranches } = require('../middleware/hqPush');
const { listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { baseQtyExpr } = require('../config/unitsHelper');
const vsdc = require('../services/vsdcClient');

// ZRA-registration-relevant fields on products. Change any of these on
// PUT and we re-register the item with VSDC.
// v1.13.72 — zra_rrp added: needed at sale-time for MTV boost, not at
// saveItem, but listed here so PUT reserialises it as part of the ZRA
// patch section instead of the generic field loop.
const ZRA_ITEM_FIELDS = [
  'zra_item_cls_cd', 'zra_item_ty_cd', 'zra_orgn_nat_cd',
  'zra_pkg_unit_cd', 'zra_qty_unit_cd', 'zra_vat_cat_cd', 'zra_excise_ty_cd',
  'zra_rrp',
];

// v1.13.138 — Server-side saveItem/updateItem code validation. The
// frontend now uses dropdowns fed from zra_codes for these fields, but
// a stale offline UI or a raw API call could still submit a bogus value
// (e.g. 'BOX' for packaging when the real code is 'BX'). We reject the
// save here so the typo never reaches VSDC where it fails with 913 and
// leaves the operator without a fiscal receipt.
//
// SOFT MODE: if the codes cache is empty for a class (never synced), we
// skip validation for that field only — otherwise we'd break every
// product setup on a freshly-installed tenant before the first sync.
// Empty/null field values are always allowed (nullable per schema).
const ZRA_CODE_CHECKS = [
  { field: 'zra_vat_cat_cd',  cls: '04', label: 'VAT Category' },
  { field: 'zra_orgn_nat_cd', cls: '05', label: 'Origin Country' },
  { field: 'zra_qty_unit_cd', cls: '10', label: 'Quantity Unit' },
  { field: 'zra_pkg_unit_cd', cls: '17', label: 'Packaging Unit' },
  { field: 'zra_item_ty_cd',  cls: '24', label: 'Item Type' },
];
function validateZraCodes(fields) {
  for (const chk of ZRA_CODE_CHECKS) {
    const val = fields[chk.field];
    if (val == null || val === '') continue;                     // nullable — allowed
    const cached = db.prepare(
      `SELECT COUNT(*) AS n FROM zra_codes WHERE cd_cls = ?`
    ).get(chk.cls).n;
    if (cached === 0) continue;                                  // soft: never synced → skip
    const hit = db.prepare(
      `SELECT 1 FROM zra_codes WHERE cd_cls = ? AND cd = ? AND use_yn = 'Y' LIMIT 1`
    ).get(chk.cls, val);
    if (!hit) {
      return { ok: false, error: `Invalid ${chk.label} code "${val}" — not in ZRA's cached list. Pick from the dropdown.` };
    }
  }
  return { ok: true };
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../uploads/products');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `product_${req.params.id}_${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  }
});

// Get all products
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { category, search } = req.query;
    let query = `SELECT p.*, c.name as category_name, c.color as category_color, c.main_category_id,
                   COALESCE(store_agg.store_balance, 0) as store_balance,
                   CASE
                     WHEN actual_agg.actual_balance IS NOT NULL THEN
                       actual_agg.actual_balance + COALESCE((
                         SELECT SUM(sm2.quantity) FROM stock_movements sm2
                         WHERE sm2.product_sync_id = p.sync_id AND sm2.location = 'sales'
                           AND sm2.movement_type != 'reconciliation'
                           AND sm2.deleted_at IS NULL
                           AND sm2.created_at > actual_agg.date || ' 23:59:59'
                       ), 0)
                     ELSE COALESCE(sales_agg.sales_balance, 0)
                   END as sales_balance,
                   -- v1.13.51 — prefer the stored products.avg_cost_price
                   -- (written atomically by hqGrns.js /generate, transfers.js
                   -- /receive, hqPurchases.js /confirm — the v1.10.55 WAC
                   -- redesign). Fall back to the live grn_items aggregation
                   -- for older products where p.avg_cost_price was never set,
                   -- and finally to p.cost_price for products with no GRN
                   -- history at all. Same read-priority pattern profitHelper.js
                   -- and the cost_at_sale trigger use. Ported from Kelete
                   -- v1.10.176 — Kelete forked before the port existed, which
                   -- is why Item Details was showing the static hint even for
                   -- products that had a real WAC.
                   CASE
                     WHEN COALESCE(p.avg_cost_price, 0) > 0 THEN p.avg_cost_price
                     WHEN COALESCE(grn_qty.total_qty, 0) > 0
                       THEN ROUND(COALESCE(grn_qty.total_cost, 0) / grn_qty.total_qty, 2)
                     ELSE p.cost_price
                   END as avg_cost_price,
                   COALESCE(opening_agg.opening_balance_qty, 0) as opening_balance_qty
                 FROM products p
                 LEFT JOIN categories c ON p.category_sync_id = c.sync_id
                 LEFT JOIN (
                   -- v1.13.1 (from Kelete v1.10.124) — expose active opening-balance
                   -- stock movement quantity so ItemDetails modal seeds "Opening
                   -- Stock" with the actual OB (not current_stock, which was
                   -- silently rewriting the OB on every re-save).
                   SELECT product_sync_id, SUM(quantity) as opening_balance_qty
                   FROM stock_movements
                   WHERE reference_type = 'opening_balance' AND deleted_at IS NULL AND product_sync_id IS NOT NULL
                   GROUP BY product_sync_id
                 ) opening_agg ON opening_agg.product_sync_id = p.sync_id
                 LEFT JOIN (
                   SELECT product_sync_id, SUM(quantity) as store_balance
                   FROM stock_movements WHERE location = 'store' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
                 ) store_agg ON store_agg.product_sync_id = p.sync_id
                 LEFT JOIN (
                   SELECT product_sync_id, SUM(quantity) as sales_balance
                   FROM stock_movements WHERE location = 'sales' AND movement_type != 'reconciliation' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
                 ) sales_agg ON sales_agg.product_sync_id = p.sync_id
                 LEFT JOIN (
                   SELECT dab.product_sync_id, dab.actual_balance, dab.date
                   FROM daily_actual_balance dab
                   INNER JOIN (
                     SELECT product_sync_id, MAX(date) as max_date
                     FROM daily_actual_balance WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
                   ) latest ON latest.product_sync_id = dab.product_sync_id AND latest.max_date = dab.date
                   WHERE dab.deleted_at IS NULL
                 ) actual_agg ON actual_agg.product_sync_id = p.sync_id
                 LEFT JOIN (
                   -- Convert each GRN line's quantity to BASE units before summing so avg_cost
                   -- is always per base unit (regardless of whether the GRN was entered in pcs or box).
                   -- Uses baseQtyExpr → looks up conversion in units_json, so it works for N packagings.
                   SELECT gi.product_sync_id,
                          SUM(${baseQtyExpr('gip', 'gi')}) AS total_qty,
                          SUM(gi.total_price) AS total_cost
                   FROM grn_items gi
                   LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
                   WHERE gi.product_sync_id IS NOT NULL AND gi.deleted_at IS NULL
                   GROUP BY gi.product_sync_id
                 ) grn_qty ON grn_qty.product_sync_id = p.sync_id
                 WHERE p.deleted_at IS NULL AND p.tenant_id = ?`;
    const params = [req.user.tenantId];

    if (category && category !== 'All') {
      params.push(category);
      query += ` AND c.name = ?`;
    }
    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      query += ` AND (p.name LIKE ? OR p.code LIKE ?)`;
    }
    query += ' ORDER BY p.created_at DESC';

    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Quick Items ──────────────────────────────────────────────────────────────

// GET /api/products/quick-items — list quick items with product details
router.get('/quick-items', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT qi.id, qi.product_sync_id, qi.position,
             p.id as product_id, p.name, p.code, p.unit, p.selling_price, p.image_url,
             c.name as category_name
      FROM quick_items qi
      JOIN products p ON p.sync_id = qi.product_sync_id AND p.deleted_at IS NULL
      LEFT JOIN categories c ON c.sync_id = p.category_sync_id
      WHERE qi.tenant_id = ?
      ORDER BY qi.position ASC, qi.created_at ASC
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/products/quick-items — add a product to quick items
router.post('/quick-items', auth, (req, res) => {
  try {
    const { product_sync_id } = req.body;
    if (!product_sync_id) return res.status(400).json({ error: 'product_sync_id required' });
    const maxPos = db.prepare('SELECT MAX(position) as m FROM quick_items WHERE tenant_id = ?').get(req.user.tenantId);
    const position = (maxPos?.m ?? -1) + 1;
    db.prepare('INSERT OR IGNORE INTO quick_items (tenant_id, product_sync_id, position) VALUES (?, ?, ?)').run(req.user.tenantId, product_sync_id, position);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/products/quick-items/:productSyncId — remove from quick items
router.delete('/quick-items/:productSyncId', auth, (req, res) => {
  try {
    db.prepare('DELETE FROM quick_items WHERE tenant_id = ? AND product_sync_id = ?').run(req.user.tenantId, req.params.productSyncId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get product by ID
// -- Opening Balance page ---------------------------------------------------
// v1.13.153 -- branch-side opening balance + price entry, for standing a new
// depot up. Same shape as Quick Price, plus the two things Quick Price has no
// concept of: opening quantity and cost.
//
// GET returns what the branch holds NOW so the page opens pre-filled rather
// than blank -- typing over a real number is the difference between correcting
// a balance and accidentally re-declaring one.
router.get('/opening-balances', auth, (req, res) => {
  try {
    const tenantId = syncConfig.getTenantId(req);
    // WHICH ROWS COUNT AS AN OPENING BALANCE. Two conventions exist:
    //
    //   current  location='sales', movement_type='adjustment',
    //            reference_type='opening_balance'   <- the marker
    //   legacy   location='store', movement_type='opening'
    //
    // The Item Details PUT above writes the first and voids BOTH on save (see
    // its v1.10.7 comment: Kelete is no-store). Reading only the legacy shape
    // made this page report 0 for items that plainly had an opening balance --
    // AQUA CLEAR 500mls read 0 here while Item Details showed 1,000. Both are
    // counted so the page tells the truth on a branch that has some of each.
    //
    // SUM, not the single row: a product may still carry duplicates from
    // before either page existed, and reporting an arbitrary one of them would
    // understate what the branch holds.
    const rows = db.prepare(`
      SELECT product_sync_id,
             COALESCE(SUM(quantity), 0) AS opening_qty,
             COUNT(*)                   AS row_count
        FROM stock_movements
       WHERE deleted_at IS NULL
         AND product_sync_id IS NOT NULL
         AND tenant_id = ?
         AND (reference_type = 'opening_balance'
              OR (movement_type = 'opening' AND location = 'store'))
       GROUP BY product_sync_id
    `).all(tenantId);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/products/cost-prices — the C.P. list.
//
// 2026-09-21 — a depot may READ this. It asked to see what its own costs are,
// which is a fair question for the people selling the stock, and answering it
// needs nothing a depot cannot already see elsewhere.
//
// Writing stays HQ-only: both POSTs below still refuse a depot outright, so a
// depot that reaches this list has no route that would let it change one. The
// flag is for the screen, not the guard — the server does not trust it.
router.get('/cost-prices', auth, (req, res) => {
  const hq = isHqRequest(req);
  try {
    // At HQ the list is the head-office catalogue; at a depot `db` already
    // resolves to that depot's own book, the same way /opening-balances above
    // relies on it.
    res.json({ rows: costPriceRows(hq ? (db.defaultDb || db) : db), readOnly: !hq });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// ^ 2026-09-21 — and this one with it. /:id accepts "cost-prices" as an id
// just as happily as it accepts "opening-balances", so defined at the bottom
// of the file this returned a product lookup and the C.P. tab showed
// "No items" against a route that was plainly deployed.

// NOTE: this must stay ABOVE router.get('/:id') below. Express matches in
// declaration order, and /:id happily accepts "opening-balances" as an id,
// so a lower placement returns a product lookup instead of this list.
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(
      `SELECT p.*, c.name as category_name FROM products p
       LEFT JOIN categories c ON p.category_sync_id = c.sync_id WHERE p.id = ? AND p.deleted_at IS NULL AND p.tenant_id = ?`
    ).get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Product not found' });
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create product
// Normalise multi-unit input into a clean array. Accepts either:
//  - `units`: [{ name, conv, price, is_base }]   (new shape — multi-unit)
//  - legacy `unit` + `alt_unit` + `conversion_factor` + `alt_price`
// Returns { units, legacy } where legacy mirrors the first base + first non-base for the
// existing alt_unit columns so older code paths keep working.
function normaliseUnits(body) {
  let arr = Array.isArray(body.units) ? body.units : null;
  if (!arr || arr.length === 0) {
    const baseName = (body.unit || 'pcs').trim() || 'pcs';
    arr = [{ name: baseName, conv: 1, price: parseFloat(body.selling_price || 0), is_base: true }];
    const alt = (body.alt_unit || '').trim();
    if (alt && parseFloat(body.conversion_factor || 0) > 0) {
      arr.push({ name: alt, conv: parseFloat(body.conversion_factor), price: parseFloat(body.alt_price || 0), is_base: false });
    }
  }
  // Coerce, dedupe by name, ensure exactly one base row (conv=1, is_base=true).
  const seen = new Set();
  const cleaned = [];
  for (const u of arr) {
    const name = (u.name || '').toString().trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({
      name,
      conv: Math.max(0, parseFloat(u.conv) || 0),
      price: Math.max(0, parseFloat(u.price) || 0),
      is_base: !!u.is_base,
    });
  }
  if (cleaned.length === 0) cleaned.push({ name: 'pcs', conv: 1, price: 0, is_base: true });
  // Force a single base. Prefer flagged is_base; otherwise the row with conv=1; otherwise the first.
  let baseIdx = cleaned.findIndex(u => u.is_base);
  if (baseIdx === -1) baseIdx = cleaned.findIndex(u => u.conv === 1);
  if (baseIdx === -1) baseIdx = 0;
  cleaned.forEach((u, i) => { u.is_base = i === baseIdx; if (u.is_base) u.conv = 1; });
  // Non-base rows must have conv > 0.
  for (const u of cleaned) if (!u.is_base && !(u.conv > 0)) {
    throw Object.assign(new Error(`Conversion factor for "${u.name}" must be a positive number`), { status: 400 });
  }
  const base = cleaned[baseIdx];
  const firstAlt = cleaned.find(u => !u.is_base) || null;
  return {
    units: cleaned,
    legacy: {
      unit: base.name,
      selling_price: base.price,
      alt_unit: firstAlt?.name || null,
      conversion_factor: firstAlt?.conv || null,
      alt_price: firstAlt?.price ?? null,
    },
  };
}

// v1.5.0: product_type removed from the public API surface. Always inserted
// as 'finished' on the DB so legacy queries that filter on it keep working.
// Branches no longer create products via this endpoint in the new HQ-owned
// workflow, but the route stays for the legacy/local-only path so older
// installs (Electron, single-tenant) continue to work.
// v1.13.174 — every item code is RS + a four-digit number.
//
// The number continues from the highest NUMBER in any existing code, never the
// highest string: sorted as text "RS091" sorts AFTER "RS0099", because at the
// third character '9' beats '0'. Matching \d+ at any width means the legacy
// three-digit codes (RS088..RS094) still count toward the maximum, so RS091
// and RS0091 can never both be issued.
//
// Kept in step with nextRsCode() in frontend/src/pages/ItemDetails.js. The
// client shows the code before saving, so the two must agree; this copy is
// what CSV import uses and what the duplicate guard below falls back on.
const nextRsCode = (codes) => {
  const taken = new Set(Array.from(codes, c => String(c || '').trim().toUpperCase()));
  let max = 0;
  for (const c of taken) {
    const m = /^RS(\d+)$/.exec(c);
    if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
  }
  let n = max + 1, code;
  do { code = `RS${String(n).padStart(4, '0')}`; n++; } while (taken.has(code));
  return code;
};

router.post('/', auth, async (req, res) => {
  try {
    const { code, name, category_id, cost_price, current_stock, min_stock,
            container_product_sync_id, units_per_container, default_unit,
            image_url, ub_number_start, ub_number_length, ub_quantity_start,
            ub_quantity_length, ub_decimal_start,
            // ZRA VSDC fields (all optional — only used when ZRA is enabled).
            hs_code, tax_label,
            zra_item_cls_cd, zra_item_ty_cd, zra_orgn_nat_cd,
            zra_pkg_unit_cd, zra_qty_unit_cd, zra_vat_cat_cd, zra_excise_ty_cd,
            zra_rrp } = req.body;
    const { units, legacy } = normaliseUnits(req.body);
    // v1.13.138 — reject typos in ZRA codes before they can reach VSDC.
    const zraCheck = validateZraCodes({ zra_vat_cat_cd, zra_orgn_nat_cd, zra_qty_unit_cd, zra_pkg_unit_cd, zra_item_ty_cd });
    if (!zraCheck.ok) return res.status(400).json({ error: zraCheck.error });
    // v1.13.174 — codes are assigned now, not typed, so this route has to be
    // the thing that stops two of them colliding. There is no UNIQUE index on
    // products.code and this route never checked; the only guard was in the
    // browser, against whatever that tab had loaded. Two HQ tabs opening New
    // Item at the same moment both compute the same next code.
    if (code && String(code).trim()) {
      const clash = db.prepare(
        'SELECT name FROM products WHERE code = ? AND deleted_at IS NULL'
      ).get(String(code).trim());
      if (clash) {
        return res.status(409).json({
          error: `Code "${String(code).trim()}" was just taken by "${clash.name}". Reopen the form to get the next code.`,
        });
      }
    }
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const cat = category_id ? db.prepare('SELECT sync_id FROM categories WHERE id = ?').get(category_id) : null;
    const categorySyncId = cat?.sync_id || null;
    const productSyncId = randomUUID();
    const fromHq = isHqRequest(req);
    // v1.13.72 — parse zra_rrp for MTV items. Blank/undefined → NULL so
    // the boost never fires accidentally. Kept out of the SQL INSERT
    // string above so column order stays 1:1 with the existing schema —
    // set separately with an UPDATE after the row lands.
    const rrpVal = (zra_rrp === '' || zra_rrp == null) ? null : (parseFloat(zra_rrp) || null);
    const info = db.prepare(
      `INSERT INTO products (code, name, category_id, category_sync_id, unit, cost_price, selling_price, current_stock, min_stock, product_type,
       alt_unit, conversion_factor, alt_price, units_json,
       container_product_sync_id, units_per_container, default_unit, image_url,
       ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start,
       is_hq_owned,
       hs_code, tax_label,
       zra_item_cls_cd, zra_item_ty_cd, zra_orgn_nat_cd,
       zra_pkg_unit_cd, zra_qty_unit_cd, zra_vat_cat_cd, zra_excise_ty_cd,
       zra_rrp,
       sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,'finished',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    ).run(code, name, category_id, categorySyncId, legacy.unit, cost_price, legacy.selling_price, current_stock || 0, min_stock || 10,
          legacy.alt_unit, legacy.conversion_factor, legacy.alt_price,
          JSON.stringify(units),
          container_product_sync_id || null,
          units_per_container ? parseFloat(units_per_container) : null,
          default_unit || null,
          image_url || null,
          parseInt(ub_number_start) || 1,
          parseInt(ub_number_length) || 6,
          parseInt(ub_quantity_start) || 7,
          parseInt(ub_quantity_length) || 0,
          parseInt(ub_decimal_start) || 2,
          fromHq ? 1 : 0,
          hs_code || null, tax_label || null,
          zra_item_cls_cd || null, zra_item_ty_cd || null, zra_orgn_nat_cd || null,
          zra_pkg_unit_cd || null, zra_qty_unit_cd || null, zra_vat_cat_cd || null, zra_excise_ty_cd || null,
          rrpVal,
          productSyncId, tenantId, branchId, deviceId);
    const newProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
    if (parseFloat(current_stock) > 0) {
      db.prepare(
        `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, notes, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
      ).run(newProduct.id, productSyncId, 'store', 'opening', current_stock, 'Opening balance',
            randomUUID(), tenantId, branchId, deviceId);
    }
    if (fromHq) {
      try { pushProductToBranches(newProduct, { listTenants, getTenantDb }); } catch (_) { /* best-effort */ }
    }
    // Register with ZRA if enabled — non-blocking (errors land on
    // products.zra_last_error so admin can retry from the product form).
    const zra = await vsdc.saveItem(tenantId, newProduct, { isUpdate: false, actor: String(req.user?.id || 'system') });

    // 2026-08-26 — Declare the opening balance to ZRA as a MOVEMENT.
    //
    // saveItem registers the item (name, code, price, VAT category) but
    // carries no quantity field at all, and nothing else fired on create.
    // So a new product's opening stock existed only locally: ZRA's
    // computed stock ledger started it at zero, and the first sale drove
    // that ledger negative — visible on ZRA's Opening/Closing report as
    // negative closing stock while Stock Inventory looked fine (the
    // residual is pushed separately by saveStockMaster).
    //
    // This is the same defect the one-shot
    // backend/scripts/declareZraOpeningStock.js was written to repair for
    // the existing catalogue; firing it here stops it recurring for every
    // product created from now on.
    //
    // Ordering matters: it runs AFTER saveItem, because ZRA must know the
    // item before a stock movement can reference its itemCd. Best-effort
    // like the rest of the ZRA chain — a failure here never blocks
    // product creation, and the one-shot script can always backfill.
    let zraOpening = { skipped: true, reason: 'no opening stock' };
    const openingQty = parseFloat(current_stock) || 0;
    if (openingQty > 0 && !zra.skipped && zra.ok !== false) {
      try {
        zraOpening = await vsdc.saveNonSaleStockChain(
          tenantId,
          Date.now() % 2147483647,          // unique sarNo per movement record
          {
            customer_name: 'Opening Balance Declaration',
            remark: `Opening balance on item creation: ${newProduct.name}`,
          },
          [{ product_sync_id: productSyncId, quantity: openingQty, unit: null }],
          vsdc.SAR_TY_CD.ADJUSTMENT_IN
        );
      } catch (e) {
        zraOpening = { ok: false, error: e.message };
      }
    }

    const finalProduct = zra.skipped ? newProduct : db.prepare('SELECT * FROM products WHERE id = ?').get(newProduct.id);
    res.status(201).json({ ...finalProduct, zra, zraOpening });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Update product
// v1.5.0: when products.is_hq_owned=1, the request body's HQ-owned fields
// are ignored — branch can only change cost_price, selling_price,
// alt_price (within units_json), min_stock, status, current_stock, notes.
// HQ fields stay locked to whatever HQ pushed.
router.put('/:id', auth, async (req, res) => {
  try {
    const { code, name, category_id, cost_price, current_stock, min_stock,
            ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start, status,
            container_product_sync_id, units_per_container, default_unit,
            // ZRA VSDC fields — persisted separately so we don't have to
            // touch the already-large main UPDATE. HQ-owned products
            // still get these edited (ZRA identity is per-branch anyway).
            hs_code, tax_label,
            zra_item_cls_cd, zra_item_ty_cd, zra_orgn_nat_cd,
            zra_pkg_unit_cd, zra_qty_unit_cd, zra_vat_cat_cd, zra_excise_ty_cd,
            zra_rrp } = req.body;
    const existingProduct = db.prepare('SELECT sync_id, unit, is_hq_owned, code, name, category_id, category_sync_id, units_json, default_unit, image_url, container_product_sync_id, units_per_container, ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start FROM products WHERE id = ?').get(req.params.id);
    if (!existingProduct) return res.status(404).json({ error: 'Product not found' });
    const isHq = !!existingProduct.is_hq_owned;
    // v1.13.138 — validate ZRA codes on PUT too (same rules as POST).
    // Only when the branch is allowed to edit HQ-owned fields — otherwise
    // HQ-owned rows on branches keep whatever HQ pushed.
    if (!isHq || isHqRequest(req)) {
      const zraCheck = validateZraCodes({ zra_vat_cat_cd, zra_orgn_nat_cd, zra_qty_unit_cd, zra_pkg_unit_cd, zra_item_ty_cd });
      if (!zraCheck.ok) return res.status(400).json({ error: zraCheck.error });
    }
    let normalised;
    try { normalised = normaliseUnits(req.body); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const { units, legacy } = normalised;
    // Lock: base unit (legacy.unit) cannot change once stock movements exist for the product.
    if (!isHq && legacy.unit !== existingProduct.unit) {
      const hasMovements = db.prepare(
        `SELECT 1 FROM stock_movements sm
         WHERE sm.product_sync_id = ? AND sm.deleted_at IS NULL
           AND sm.movement_type != 'opening' LIMIT 1`
      ).get(existingProduct.sync_id);
      if (hasMovements) return res.status(400).json({ error: 'Base unit cannot change once stock movements exist. Edit prices/conversions only.' });
    }
    // 2026-08-26 — snapshot stock BEFORE the edit so the opening-balance
    // change can be reported to ZRA as a delta further down. See the
    // zraOpening block after the transaction for why this is needed.
    const stockBeforeEdit = Number(
      db.prepare('SELECT current_stock FROM products WHERE id = ?').get(req.params.id)?.current_stock
    ) || 0;
    db.transaction(() => {
      const cat = category_id ? db.prepare('SELECT sync_id FROM categories WHERE id = ?').get(category_id) : null;
      const categorySyncId = cat?.sync_id || null;
      // For HQ-owned products edited FROM A BRANCH, the HQ-owned columns are
      // forced back to whatever HQ pushed. Branch-owned columns (price/min/
      // status/stock) come from the request.
      // v1.7.3 — when the request comes from HQ itself, HQ must be able to
      // edit those columns (packagings, default unit, category, etc.) or
      // changes silently disappear on save. So lock only for non-HQ requests.
      const useHqFields = isHq && !isHqRequest(req);
      const finalCode      = useHqFields ? existingProduct.code      : code;
      const finalName      = useHqFields ? existingProduct.name      : name;
      const finalCategoryId       = useHqFields ? existingProduct.category_id      : category_id;
      const finalCategorySyncId   = useHqFields ? existingProduct.category_sync_id : categorySyncId;
      const finalUnit             = useHqFields ? existingProduct.unit             : legacy.unit;
      // v1.7.8: per-packaging selling `price` inside units_json is branch-owned
      // (same as legacy alt_price + top-level selling_price). When a branch
      // edits an HQ-owned product, keep HQ's structure (name/conv/is_base/
      // barcode) but accept the branch's typed prices. mergeUnitsJsonPreserving
      // BranchPrices treats the request's `units` as the branch's price source
      // and existingProduct.units_json as HQ's structure.
      const finalUnitsJson        = useHqFields
        ? mergeUnitsJsonPreservingBranchPrices(existingProduct.units_json, JSON.stringify(units))
        : JSON.stringify(units);
      const finalDefaultUnit      = useHqFields ? existingProduct.default_unit
                                                : (default_unit !== undefined ? (default_unit || null) : undefined);
      const finalContainerSync    = useHqFields ? existingProduct.container_product_sync_id
                                                : (container_product_sync_id !== undefined ? (container_product_sync_id || null) : undefined);
      const finalContainerUnits   = useHqFields ? existingProduct.units_per_container
                                                : (units_per_container !== undefined ? (units_per_container ? parseFloat(units_per_container) : null) : undefined);
      const finalUbNumStart   = useHqFields ? existingProduct.ub_number_start    : (ub_number_start    ?? existingProduct.ub_number_start    ?? 1);
      const finalUbNumLen     = useHqFields ? existingProduct.ub_number_length   : (ub_number_length   ?? existingProduct.ub_number_length   ?? 6);
      const finalUbQtyStart   = useHqFields ? existingProduct.ub_quantity_start  : (ub_quantity_start  ?? existingProduct.ub_quantity_start  ?? 7);
      const finalUbQtyLen     = useHqFields ? existingProduct.ub_quantity_length : (ub_quantity_length ?? existingProduct.ub_quantity_length ?? 0);
      const finalUbDecStart   = useHqFields ? existingProduct.ub_decimal_start   : (ub_decimal_start   ?? existingProduct.ub_decimal_start   ?? 2);
      const finalAltUnit      = useHqFields ? null : legacy.alt_unit;
      const finalConvFactor   = useHqFields ? null : legacy.conversion_factor;
      const finalAltPrice     = useHqFields ? null : legacy.alt_price;

      // Container / default_unit only update when explicitly provided OR
      // when HQ-locked (forced).
      const updateContainer   = useHqFields || container_product_sync_id !== undefined || units_per_container !== undefined;
      const containerSql      = updateContainer ? ', container_product_sync_id=?, units_per_container=?' : '';
      const containerArgs     = updateContainer ? [finalContainerSync ?? null, finalContainerUnits ?? null] : [];
      const updateDefaultUnit = useHqFields || default_unit !== undefined;
      const defaultUnitSql    = updateDefaultUnit ? ', default_unit=?' : '';
      const defaultUnitArgs   = updateDefaultUnit ? [finalDefaultUnit ?? null] : [];

      db.prepare(
        `UPDATE products SET code=?, name=?, category_id=?, category_sync_id=?, unit=?, cost_price=?, selling_price=?,
         current_stock=?, min_stock=?,
         ub_number_start=?, ub_number_length=?, ub_quantity_start=?, ub_quantity_length=?, ub_decimal_start=?,
         alt_unit=?, conversion_factor=?, alt_price=?, units_json=?${containerSql}${defaultUnitSql},
         status=?,
         updated_at=datetime('now'), synced=0 WHERE id=?`
      ).run(finalCode, finalName, finalCategoryId, finalCategorySyncId, finalUnit,
            cost_price, legacy.selling_price, current_stock, min_stock,
            finalUbNumStart, finalUbNumLen, finalUbQtyStart, finalUbQtyLen, finalUbDecStart,
            finalAltUnit, finalConvFactor, finalAltPrice, finalUnitsJson,
            ...containerArgs,
            ...defaultUnitArgs,
            (status === 'Inactive' ? 'Inactive' : 'Active'),
            req.params.id);
      // v1.10.7 — Kelete is no-store: opening balance writes to 'sales' as an
      // adjustment (reference_type='opening_balance' so re-saves can find and
      // void it). Voids ALL prior opening rows for this product regardless of
      // location/movement_type so legacy 'store'/'opening' rows get cleaned up
      // on the first edit.
      const product = db.prepare('SELECT sync_id FROM products WHERE id = ?').get(req.params.id);
      db.prepare(`
        UPDATE stock_movements
           SET deleted_at=datetime('now'),
               updated_at=datetime('now'),
               synced=0
         WHERE product_sync_id = ?
           AND deleted_at IS NULL
           AND (
             (movement_type = 'opening' AND location = 'store')
             OR reference_type = 'opening_balance'
           )
      `).run(product?.sync_id);
      if (parseFloat(current_stock) > 0) {
        const tenantId = syncConfig.getTenantId(req);
        const { branchId, deviceId } = syncConfig.getConfig();
        // v1.13.2 (from Kelete v1.10.125) — backdate opening_balance rows to
        // 2026-06-29 so they land in the blue "Opening Balance" pill on Bin
        // Card instead of a mid-timeline "Adjustment" row.
        db.prepare(
          `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_type, notes, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'2026-06-29 00:00:00',datetime('now'))`
        ).run(req.params.id, product?.sync_id, 'sales', 'adjustment', parseFloat(current_stock), 'opening_balance', 'Opening balance',
              randomUUID(), tenantId, branchId, deviceId);
      }
      // v1.13.21 — the main UPDATE above set current_stock to the raw
      // request value (i.e. just the new opening balance). Non-opening
      // movements (sales/GRNs/adjustments) still live in the ledger, so
      // cache and SUM(stock_movements) would disagree by exactly the
      // sum of those other movements. Recompute for THIS product only
      // so the cache stays consistent without waiting for the boot heal.
      if (product?.sync_id) {
        db.prepare(`
          UPDATE products SET current_stock = COALESCE((
            SELECT SUM(sm.quantity) FROM stock_movements sm
             WHERE sm.product_sync_id = ? AND sm.deleted_at IS NULL
          ), 0), updated_at = datetime('now'), synced = 0
           WHERE id = ?
        `).run(product.sync_id, req.params.id);
      }
    })();
    // Second, dedicated UPDATE for the ZRA fields — only patches columns
    // the caller actually sent.
    //
    // v1.13.86 — HQ-write-only. Every ZRA classification field (VAT cat,
    // RRP, UNSPSC, packaging, item type, excise, HS code) must be
    // consistent across all branches for the same SKU — otherwise Buseko
    // and Garden could declare different MTV bases or VAT categories to
    // ZRA for the identical bottle. Branches never gate this from the
    // main product UI (see ItemDetails.js:hqLocked disables the inputs),
    // but we still enforce here in case a branch client is out of date
    // or an operator crafts a request manually. HQ requests come through
    // isHqRequest() — same helper that already gates the code/name/units
    // fields at the top of this handler.
    const zraSets = [];
    const zraVals = [];
    const canWriteZra = isHqRequest(req);
    const patchZra = (col, val) => {
      if (!canWriteZra) return;
      if (val !== undefined) { zraSets.push(`${col}=?`); zraVals.push(val ?? null); }
    };
    patchZra('hs_code',           hs_code);
    patchZra('tax_label',         tax_label);
    patchZra('zra_item_cls_cd',   zra_item_cls_cd);
    patchZra('zra_item_ty_cd',    zra_item_ty_cd);
    patchZra('zra_orgn_nat_cd',   zra_orgn_nat_cd);
    patchZra('zra_pkg_unit_cd',   zra_pkg_unit_cd);
    patchZra('zra_qty_unit_cd',   zra_qty_unit_cd);
    patchZra('zra_vat_cat_cd',    zra_vat_cat_cd);
    patchZra('zra_excise_ty_cd',  zra_excise_ty_cd);
    // v1.13.72 — MTV RRP. Blank string = "clear it" so operator can
    // remove an RRP by wiping the input. Numeric string → parseFloat.
    patchZra('zra_rrp',
      zra_rrp === undefined ? undefined
      : zra_rrp === '' || zra_rrp === null ? null
      : (parseFloat(zra_rrp) || null));
    if (zraSets.length) {
      db.prepare(`UPDATE products SET ${zraSets.join(', ')}, updated_at=datetime('now'), synced=0 WHERE id=?`)
        .run(...zraVals, req.params.id);
    }
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    if (isHqRequest(req)) {
      // Fix A — when the HQ operator ticks "Also apply this price to all
      // branches" on the edit modal, forward the flag so pushProductToBranches
      // overwrites each branch's cost/selling/alt + units_json prices instead
      // of preserving the branch overrides. Default remains false (routine
      // HQ edits leave branch prices alone).
      const pushPrices = !!req.body?.push_price_to_all;
      try { pushProductToBranches(row, { listTenants, getTenantDb, pushPrices }); } catch (_) {}
    }
    // Re-register with VSDC when name/price or any ZRA field changed.
    // We always call updateItem — cheaper than diffing every field, and
    // if nothing changed VSDC still responds 000. If the item was never
    // registered before, VSDC treats updateItem as an insert.
    const zra = await vsdc.saveItem(req.user.tenantId, row, { isUpdate: true, actor: String(req.user?.id || 'system') });

    // 2026-08-26 — Report an opening-balance change to ZRA as a movement.
    //
    // This is the path that actually matters for Red Sea's HQ→branch
    // flow. HQ owns code/name/units and pushes each item to branches with
    // current_stock = 0 (see hqProducts.js header); the BRANCH then sets
    // its own opening balance by EDITING the pushed item — i.e. here, in
    // PUT, not in POST. The POST-side declaration only covers the rarer
    // branch-direct create.
    //
    // The edit is a REPLACE: the block above voids every prior
    // opening_balance movement, inserts the new one, then recomputes
    // current_stock from the whole ledger. So the figure ZRA needs is the
    // DELTA, not the new opening — anything else would double-count the
    // sales/GRNs already reported. Positive delta -> Adjustment In,
    // negative -> Adjustment Out.
    //
    // Fires only when the delta is non-zero, so ordinary edits (price,
    // min stock, ZRA classification) never emit a stock movement.
    // Best-effort: a failure never fails the edit, and
    // backend/scripts/declareZraOpeningStock.js can always backfill.
    let zraOpening = { skipped: true, reason: 'stock unchanged' };
    const stockAfterEdit = Number(row?.current_stock) || 0;
    const openingDelta = stockAfterEdit - stockBeforeEdit;
    if (Math.abs(openingDelta) > 0.0001 && !zra.skipped && zra.ok !== false && row?.sync_id) {
      try {
        zraOpening = await vsdc.saveNonSaleStockChain(
          req.user.tenantId,
          Date.now() % 2147483647,          // unique sarNo per movement record
          {
            customer_name: 'Opening Balance Declaration',
            remark: `Opening balance change on ${row.name}: ${stockBeforeEdit} -> ${stockAfterEdit}`,
          },
          [{ product_sync_id: row.sync_id, quantity: openingDelta, unit: null }],
          openingDelta > 0 ? vsdc.SAR_TY_CD.ADJUSTMENT_IN : vsdc.SAR_TY_CD.ADJUSTMENT_OUT
        );
      } catch (e) {
        zraOpening = { ok: false, error: e.message };
      }
    }

    const finalRow = zra.skipped ? row : db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json({ ...finalRow, zra, zraOpening });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update barcode settings only
router.patch('/:id/barcode', auth, (req, res) => {
  try {
    const { ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start } = req.body;
    const pInt = (val, def) => { const n = parseInt(val); return isNaN(n) ? def : n; };
    const info = db.prepare(
      `UPDATE products SET
         ub_number_start=?, ub_number_length=?, ub_quantity_start=?,
         ub_quantity_length=?, ub_decimal_start=?,
         updated_at=datetime('now'), synced=0
       WHERE id=?`
    ).run(
      pInt(ub_number_start, 1), pInt(ub_number_length, 6), pInt(ub_quantity_start, 7),
      pInt(ub_quantity_length, 0), pInt(ub_decimal_start, 2), req.params.id
    );
    if (info.changes === 0) return res.status(404).json({ error: 'Product not found' });
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload product image
router.post('/:id/image', auth, upload.single('image'), withTenantDb, (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    const imageUrl = `/uploads/products/${req.file.filename}`;

    const old = db.prepare('SELECT image_url FROM products WHERE id = ?').get(req.params.id);
    if (old?.image_url) {
      const oldPath = path.join(__dirname, '..', old.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    db.prepare("UPDATE products SET image_url = ?, updated_at = datetime('now'), synced=0 WHERE id = ?").run(imageUrl, req.params.id);
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete product image
router.delete('/:id/image', auth, (req, res) => {
  try {
    const old = db.prepare('SELECT image_url FROM products WHERE id = ?').get(req.params.id);
    if (old?.image_url) {
      const oldPath = path.join(__dirname, '..', old.image_url);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }
    db.prepare("UPDATE products SET image_url = NULL, updated_at = datetime('now'), synced=0 WHERE id = ?").run(req.params.id);
    res.json({ message: 'Image removed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete all products — only deletes those NOT referenced by GRN/SIV/orders
router.delete('/all', auth, (req, res) => {
  try {
    const info = db.prepare(`
      UPDATE products
      SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
      WHERE deleted_at IS NULL
        AND sync_id NOT IN (
          SELECT product_sync_id FROM grn_items   WHERE product_sync_id IS NOT NULL AND deleted_at IS NULL
          UNION SELECT product_sync_id FROM siv_items   WHERE product_sync_id IS NOT NULL AND deleted_at IS NULL
          UNION SELECT product_sync_id FROM order_items WHERE product_sync_id IS NOT NULL AND deleted_at IS NULL
        )
    `).run();
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM products WHERE deleted_at IS NULL").get();
    res.json({
      message: `Deleted ${info.changes} product(s). ${remaining.c > 0 ? `${remaining.c} kept because they are referenced by GRN, SIV, or sales orders.` : ''}`.trim(),
      deleted: info.changes,
      kept: remaining.c
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Import products from CSV
const csvUploadMem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function parseCSV(text) {
  const lines = text.trim().split('\n').map(l => l.replace(/\r$/, ''));
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] !== undefined ? vals[j] : ''; });
    rows.push(row);
  }
  return rows;
}

router.post('/import', auth, csvUploadMem.single('file'), withTenantDb, (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const text = req.file.buffer.toString('utf8');
    const rows = parseCSV(text);
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const fromHq = isHqRequest(req);
    const importedRows = [];
    const skippedRows  = [];
    // Newly inserted rows we'll push to branches at the end (HQ only).
    const pushQueue    = [];
    // v1.6.8: also track auto-created reference data so we can push it
    // alongside products. Without these pushes, branches receive products
    // whose category_sync_id / main_category_sync_id point to rows that
    // don't exist on the branch — yields "no category" display + units
    // dropdown gaps.
    const pushCatIds       = new Set();
    const pushMainCatIds   = new Set();

    // Auto-generate codes for rows that have a name but no code.
    const existingCodes = new Set(
      db.prepare("SELECT code FROM products WHERE deleted_at IS NULL").all().map(r => r.code)
    );
    // v1.13.174 — import follows the same RS numbering as the New Item form.
    // It used to mint IT001-style codes, which would have reintroduced exactly
    // the drift the form now prevents. existingCodes grows as rows are taken,
    // so a single file cannot issue the same code twice.
    const nextAutoCode = () => {
      const code = nextRsCode(existingCodes);
      existingCodes.add(code);
      return code;
    };

    // v1.6.2 — INSERT now stores HQ-owned + branch-owned columns in one
    // shot. On HQ import we force branch-owned to 0 / null (set
    // is_hq_owned=1) so branches receive a clean record they can price
    // themselves. On branch import (legacy) branch fields come from the
    // CSV as before.
    // 28 columns total = 25 bound (?) + 3 literals.
    const insertStmt = db.prepare(
      `INSERT INTO products (code, name, category_id, category_sync_id, unit,
       cost_price, selling_price, current_stock, min_stock,
       ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start,
       alt_unit, conversion_factor, alt_price,
       default_unit, units_per_container, is_hq_owned,
       sync_id, tenant_id, branch_id, device_id, status,
       synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    );
    const checkCodeStmt = db.prepare("SELECT id FROM products WHERE code = ? AND deleted_at IS NULL");
    const getCatStmt = db.prepare("SELECT id, sync_id, main_category_id FROM categories WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL");
    const getMainCatStmt = db.prepare("SELECT id, sync_id FROM main_categories WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL");
    const insertCatStmt = db.prepare(
      "INSERT INTO categories (name, color, main_category_id, main_category_sync_id, is_hq_owned, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))"
    );
    const insertMainCatStmt = db.prepare(
      "INSERT INTO main_categories (name, color, is_hq_owned, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))"
    );
    const stockStmt = db.prepare(
      `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, notes, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    );

    db.transaction(() => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const rowNum = i + 1;
        let code = row.code?.trim();
        const name = row.name?.trim();
        if (!name) {
          skippedRows.push({ row: rowNum, code: code || '', name: '', reason: 'Missing name' });
          continue;
        }
        // v1.13.174 — category is mandatory here too. Leaving import loose
        // while the form is strict would just move the gap: a CSV was how
        // uncategorised items got in before.
        if (!row.category?.trim()) {
          skippedRows.push({ row: rowNum, code: code || '', name, reason: 'Missing category' });
          continue;
        }
        if (!code) code = nextAutoCode();
        if (checkCodeStmt.get(code)) {
          skippedRows.push({ row: rowNum, code, name, reason: `Duplicate code "${code}" — already exists` });
          continue;
        }

        // Auto-create main_category / category on HQ if the CSV references
        // a name that doesn't exist yet. Track ids so we push them after
        // the transaction commits (v1.6.8).
        let mainCatId = null, mainCatSyncId = null;
        const mainName = row.main_category?.trim();
        if (mainName) {
          let mc = getMainCatStmt.get(mainName);
          if (!mc && fromHq) {
            const mcSync = randomUUID();
            const r = insertMainCatStmt.run(mainName, '#6B7280', 1, mcSync, tenantId, branchId, deviceId);
            mc = getMainCatStmt.get(mainName);
            if (mc?.id) pushMainCatIds.add(mc.id);
          }
          mainCatId = mc?.id || null;
          mainCatSyncId = mc?.sync_id || null;
        }
        let category_id = null, categorySyncId = null;
        const catName = row.category?.trim();
        if (catName) {
          let c = getCatStmt.get(catName);
          if (!c && fromHq) {
            const cSync = randomUUID();
            insertCatStmt.run(catName, '#6b7280', mainCatId, mainCatSyncId, 1, cSync, tenantId, branchId, deviceId);
            c = getCatStmt.get(catName);
            if (c?.id) pushCatIds.add(c.id);
          }
          category_id = c?.id || null;
          categorySyncId = c?.sync_id || null;
        }

        const unit         = row.unit?.trim() || 'pcs';
        const defaultUnit  = row.default_unit?.trim() || null;
        const altUnit      = row.alt_unit?.trim() || null;
        const convFactor   = altUnit && row.conversion_factor ? parseFloat(row.conversion_factor) : null;
        const upc          = row.units_per_container ? parseFloat(row.units_per_container) : null;
        // Branch-owned fields — IGNORED when importing on HQ.
        const cost_price    = fromHq ? 0 : (parseFloat(row.cost_price) || 0);
        const selling_price = fromHq ? 0 : (parseFloat(row.selling_price) || 0);
        const altPrice      = fromHq ? null : (altUnit && row.alt_price ? parseFloat(row.alt_price) : null);
        const current_stock = fromHq ? 0 : (parseFloat(row.current_stock) || 0);
        const min_stock     = fromHq ? 0 : (parseFloat(row.min_stock) || 10);
        const ub_number_start    = parseInt(row.ub_number_start)    || 1;
        const ub_number_length   = parseInt(row.ub_number_length)   || 6;
        const ub_quantity_start  = parseInt(row.ub_quantity_start)  || 7;
        const ub_quantity_length = parseInt(row.ub_quantity_length) || 0;
        const ub_decimal_start   = parseInt(row.ub_decimal_start)   || 2;
        const productSyncId = randomUUID();

        const info = insertStmt.run(
          code, name, category_id, categorySyncId, unit,
          cost_price, selling_price, current_stock, min_stock,
          ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length, ub_decimal_start,
          altUnit, convFactor, altPrice,
          defaultUnit, upc, fromHq ? 1 : 0,
          productSyncId, tenantId, branchId, deviceId, 'Active'
        );
        if (current_stock > 0) {
          stockStmt.run(info.lastInsertRowid, productSyncId, 'store', 'opening', current_stock, 'Opening balance (import)',
            randomUUID(), tenantId, branchId, deviceId);
        }
        importedRows.push({ row: rowNum, code, name });
        if (fromHq) pushQueue.push(info.lastInsertRowid);
      }
    })();

    // On HQ: push each newly-inserted product to every branch. Best-effort
    // (errors per branch surface in the response but don't roll back the
    // HQ-side insert).
    const pushErrors = [];
    if (fromHq) {
      // v1.6.8: order matters. Push main_categories first (categories
      // FK reference them), then categories (products reference them by
      // sync_id), then products. Without this order, the branch product
      // INSERT can't find its category_sync_id at the branch.
      for (const mcId of pushMainCatIds) {
        const row = db.prepare('SELECT * FROM main_categories WHERE id = ?').get(mcId);
        if (!row) continue;
        try { pushMainCategoryToBranches(row, { listTenants, getTenantDb }); }
        catch (e) { pushErrors.push({ main_category: row.name, error: e.message }); }
      }
      for (const cId of pushCatIds) {
        const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(cId);
        if (!row) continue;
        try { pushCategoryToBranches(row, { listTenants, getTenantDb }); }
        catch (e) { pushErrors.push({ category: row.name, error: e.message }); }
      }
      for (const newId of pushQueue) {
        const row = db.prepare('SELECT * FROM products WHERE id = ?').get(newId);
        try {
          const r = pushProductToBranches(row, { listTenants, getTenantDb });
          if (r.errors?.length) pushErrors.push(...r.errors.map(e => ({ ...e, product: row.name })));
        } catch (e) { pushErrors.push({ product: row.name, error: e.message }); }
      }
    }

    const imported = importedRows.length;
    const skipped  = skippedRows.length;
    res.json({
      imported, skipped,
      imported_rows: importedRows,
      skipped_rows:  skippedRows,
      push_errors:   pushErrors,
      message: `Imported ${imported} products. Skipped ${skipped} (duplicates or missing name).${fromHq ? ` Pushed to all branches.` : ''}`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete product — blocked if referenced by GRN or SIV. v1.6.1: branches
// can't delete HQ-owned items; HQ deletes propagate the soft-delete to
// every branch.
router.delete('/:id', auth, (req, res) => {
  try {
    const prod = db.prepare('SELECT sync_id, name, is_hq_owned FROM products WHERE id = ?').get(req.params.id);
    if (!prod) return res.status(404).json({ error: 'Product not found' });
    const fromHq = isHqRequest(req);
    if (prod.is_hq_owned && !fromHq) {
      return res.status(403).json({ error: 'This item is managed by HQ and cannot be deleted at the branch.' });
    }

    const grnCount = db.prepare('SELECT COUNT(*) AS c FROM grn_items WHERE product_sync_id = ? AND deleted_at IS NULL').get(prod.sync_id);
    const sivCount = db.prepare('SELECT COUNT(*) AS c FROM siv_items WHERE product_sync_id = ? AND deleted_at IS NULL').get(prod.sync_id);
    const orderCount = db.prepare('SELECT COUNT(*) AS c FROM order_items WHERE product_sync_id = ? AND deleted_at IS NULL').get(prod.sync_id);

    if (grnCount.c > 0 || sivCount.c > 0 || orderCount.c > 0) {
      const parts = [];
      if (grnCount.c   > 0) parts.push(`${grnCount.c} GRN line(s)`);
      if (sivCount.c   > 0) parts.push(`${sivCount.c} SIV line(s)`);
      if (orderCount.c > 0) parts.push(`${orderCount.c} sales order line(s)`);
      return res.status(400).json({ error: `Cannot delete "${prod.name}" — it is used in ${parts.join(', ')}. Remove those records first or mark the product inactive.` });
    }

    db.prepare("UPDATE products SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    if (fromHq) {
      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
      try { pushProductToBranches(row, { listTenants, getTenantDb }); } catch (_) {}
    }
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fix A — HQ-only bulk "Push Prices to All Branches". Force-pushes
// cost_price + selling_price + alt_price + units_json (prices included)
// from HQ to every registered branch, wiping any branch-set overrides.
// Delegates to mirrorAllHqToBranches with pushPrices=true so the same
// per-column rules used elsewhere apply. Confirmation lives on the
// frontend (see ItemDetails.js) — the endpoint itself doesn't prompt.
router.post('/bulk-push-prices', auth, async (req, res) => {
  if (!isHqRequest(req)) return res.status(403).json({ error: 'HQ only' });
  try {
    const result = mirrorAllHqToBranches(db.defaultDb || db, { listTenants, getTenantDb, pushPrices: true });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v1.8.1 — Transfer all store stock to sales floor as one SIV.
// Password-gated (passed in body). Returns siv number + line count.
router.post('/bulk-siv-store-to-sales', auth, (req, res) => {
  const PASSWORD = '108120';
  if (String(req.body?.password || '') !== PASSWORD) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  try {
    const items = db.prepare(`
      SELECT * FROM (
        SELECT p.id, p.sync_id, p.name, p.unit AS base_unit, p.default_unit, p.selling_price, p.units_json,
               (SELECT COALESCE(SUM(quantity),0) FROM stock_movements
                  WHERE product_sync_id = p.sync_id AND location = 'store' AND deleted_at IS NULL) AS store_qty
        FROM products p
        WHERE p.deleted_at IS NULL
      ) WHERE store_qty > 0
      ORDER BY name
    `).all();

    if (items.length === 0) {
      return res.status(400).json({ error: 'No items have store stock to transfer.' });
    }

    const tenantId = syncConfig.getTenantId(req);
    const cfg = syncConfig.getConfig() || {};
    const sivNumber = syncConfig.generateNumber('SIV', 'siv');
    const sivSyncId = randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    const stamp = today + ' ' + new Date().toTimeString().slice(0, 8);

    // Compute per-line qty in the product's default unit + per-default-unit price.
    const lines = items.map(p => {
      let units = [];
      try { units = JSON.parse(p.units_json || '[]'); } catch {}
      const dfltName = (p.default_unit || '').trim() || p.base_unit;
      const dfltU = units.find(u => (u.name || '').trim() === dfltName);
      const conv = dfltU ? (parseFloat(dfltU.conv) || 1) : 1;
      const baseQty = p.store_qty;
      const lineQty = baseQty / conv;
      const dfltUnitPrice = dfltU && parseFloat(dfltU.price) > 0
        ? parseFloat(dfltU.price)
        : (parseFloat(p.selling_price) || 0) * conv;
      return { p, lineUnit: dfltName, baseQty, lineQty, unitPrice: dfltUnitPrice, total: lineQty * dfltUnitPrice };
    });
    const totalValue = lines.reduce((s, l) => s + l.total, 0);

    db.transaction(() => {
      db.prepare(`INSERT INTO siv (siv_number, date, department, total_items, total_value, notes,
                                   created_by, status, sync_id, tenant_id, branch_id, device_id,
                                   synced, created_at, updated_at)
                  VALUES (?,?,?,?,?,?,?,'Issued',?,?,?,?,0,datetime('now'),datetime('now'))`)
        .run(sivNumber, today, 'Bulk transfer', lines.length, totalValue,
             'Transfer all store stock to sales floor',
             req.user.id, sivSyncId, tenantId, cfg.branchId || null, cfg.deviceId || null);

      const sId = db.prepare('SELECT id FROM siv WHERE sync_id = ?').get(sivSyncId).id;

      const insItem = db.prepare(`INSERT INTO siv_items
        (siv_id, siv_sync_id, product_id, product_sync_id, quantity, unit, unit_price, total_price,
         sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`);
      const insMv = db.prepare(`INSERT INTO stock_movements
        (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type,
         created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`);

      for (const l of lines) {
        insItem.run(sId, sivSyncId, l.p.id, l.p.sync_id, l.lineQty, l.lineUnit, l.unitPrice, l.total,
                    randomUUID(), tenantId, cfg.branchId || null, cfg.deviceId || null);
        insMv.run(l.p.id, l.p.sync_id, 'store', 'siv', -l.baseQty, sId, 'siv', req.user.id,
                  randomUUID(), tenantId, cfg.branchId || null, cfg.deviceId || null, stamp, stamp, sivSyncId);
        insMv.run(l.p.id, l.p.sync_id, 'sales', 'siv',  l.baseQty, sId, 'siv', req.user.id,
                  randomUUID(), tenantId, cfg.branchId || null, cfg.deviceId || null, stamp, stamp, sivSyncId);
      }
    })();

    res.json({ success: true, siv_number: sivNumber, lines: lines.length, total_value: totalValue });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /api/products/bulk-update-prices ──────────────────────────────────
// v1.8.34 — Quick Price Update page. Accepts a list of products with a single
// "base price" (price for the base unit, e.g. price per Bottle). For each
// product, updates units_json so every packaging's price = base_price × conv,
// and updates the legacy selling_price column = base_price. Single transaction.
//
// v1.10.26 — Optional per-unit overrides. Non-default units may carry a
// distinct price without disturbing base or siblings, mirroring Item
// Details behaviour. After deriving base × conv for every unit, any
// packaging listed in unit_prices is overwritten with that value.
//
// Body: { updates: [
//   { id: 123, base_price: 1.10 },                                    // simple cascade
//   { id: 456, base_price: 1.10, unit_prices: { "Six Pack": 8.50 } }, // + override
// ] }
router.post('/bulk-update-prices', auth, (req, res) => {
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (updates.length === 0) return res.status(400).json({ error: 'No updates provided.' });

    const select = db.prepare('SELECT id, units_json, is_hq_owned FROM products WHERE id = ? AND tenant_id = ?');
    const update = db.prepare(`UPDATE products SET units_json = ?, selling_price = ?, alt_price = ?,
                                 updated_at = datetime('now'), synced = 0 WHERE id = ?`);

    const tx = db.transaction(() => {
      let count = 0;
      for (const u of updates) {
        const id = parseInt(u.id, 10);
        const basePrice = parseFloat(u.base_price);
        if (!id || !(basePrice >= 0)) continue;
        const row = select.get(id, req.user.tenantId);
        if (!row) continue;
        let units = [];
        try { units = JSON.parse(row.units_json || '[]'); } catch {}
        if (!Array.isArray(units) || units.length === 0) continue;
        const overrides = (u.unit_prices && typeof u.unit_prices === 'object') ? u.unit_prices : {};
        const updatedUnits = units.map(unit => {
          const derived = parseFloat((basePrice * (parseFloat(unit.conv) || 1)).toFixed(4));
          const key = (unit.name || '').trim();
          const override = overrides[key];
          const finalPrice = (!unit.is_base && override !== undefined && override !== null && parseFloat(override) > 0)
            ? parseFloat(parseFloat(override).toFixed(4))
            : derived;
          return { ...unit, price: finalPrice };
        });
        const nonBase = updatedUnits.filter(x => !x.is_base);
        const altPrice = nonBase.length > 0
          ? nonBase.sort((a, b) => parseFloat(b.conv) - parseFloat(a.conv))[0].price
          : basePrice;
        update.run(JSON.stringify(updatedUnits), basePrice, altPrice, id);
        count++;
      }
      return count;
    });

    const updated = tx();
    res.json({ updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Save opening balances. Body:
//   { password, updates: [ { id, opening_qty, cost_price, base_price, unit_prices? } ] }
//
// REPLACE, NOT ADD. The opening row is edited in place; entering 500 twice
// leaves 500, not 1000. Getting this wrong would be silent -- stock doubles and
// nothing in the app complains, because there is no stock guard anywhere in
// routes/orders.js -- so the write is an explicit "set to", never a delta.
//
// Prices go through the SAME units_json cascade as bulk-update-prices. Writing
// selling_price alone is not enough and looks like it worked: POS.js reads the
// unit's price out of units_json first and only falls back to selling_price
// when the unit is missing, so a raw write leaves the till charging the old
// price. That exact mistake is what scripts/repair_units_json_prices.js exists
// to clean up.
router.post('/opening-balances', auth, readOnlyGuard, (req, res) => {
  const PASSWORD = '108120';
  if (String(req.body?.password || '') !== PASSWORD) {
    return res.status(403).json({ error: 'Wrong password' });
  }
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (updates.length === 0) return res.status(400).json({ error: 'No updates provided.' });

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const userId = req.user?.id || null;

    const select = db.prepare(
      'SELECT id, sync_id, units_json, cost_price, selling_price FROM products WHERE id = ? AND tenant_id = ?');
    // Void-then-write, exactly as the Item Details PUT does. Editing a row in
    // place would leave any row of the OTHER convention alive beside it and
    // the two would sum together -- the doubling this page exists to prevent.
    // Voiding every opening row of either shape first makes "set to" true
    // whichever way the balance was originally entered.
    const voidOpenings = db.prepare(`
      UPDATE stock_movements
         SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
       WHERE product_sync_id = ?
         AND deleted_at IS NULL
         AND tenant_id = ?
         AND (reference_type = 'opening_balance'
              OR (movement_type = 'opening' AND location = 'store'))`);
    // created_at is backdated to 2026-06-29 for the same reason products.js
    // does it: the Bin Card renders anything older than the report window in
    // the blue Opening Balance pill, so a row stamped today would show up
    // mid-timeline as a stray Adjustment instead.
    const insOpening = db.prepare(`
      INSERT INTO stock_movements
        (product_id, product_sync_id, location, movement_type, quantity, reference_type,
         notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,'sales','adjustment',?,'opening_balance',?,?,?,?,?,?,0,'2026-06-29 00:00:00',datetime('now'))`);
    const updProduct = db.prepare(`
      UPDATE products
         SET units_json = ?, selling_price = ?, alt_price = ?, cost_price = ?,
             updated_at = datetime('now'), synced = 0
       WHERE id = ?`);
    // current_stock is a cache; migrations rebuild it from stock_movements on
    // every boot. Recomputing here too means the page is right straight away
    // instead of after the next restart.
    const healStock = db.prepare(`
      UPDATE products
         SET current_stock = COALESCE((SELECT SUM(sm.quantity) FROM stock_movements sm
               WHERE sm.product_sync_id = products.sync_id AND sm.deleted_at IS NULL), 0),
             synced = 0, updated_at = datetime('now')
       WHERE id = ?`);

    const tx = db.transaction(() => {
      let count = 0;
      for (const u of updates) {
        const id = parseInt(u.id, 10);
        if (!id) continue;
        const row = select.get(id, tenantId);
        if (!row || !row.sync_id) continue;

        // -- price: identical cascade to bulk-update-prices ---------------
        const basePrice = parseFloat(u.base_price);
        if (basePrice >= 0) {
          let units = [];
          try { units = JSON.parse(row.units_json || '[]'); } catch (_) {}
          if (Array.isArray(units) && units.length > 0) {
            const overrides = (u.unit_prices && typeof u.unit_prices === 'object') ? u.unit_prices : {};
            const updatedUnits = units.map(unit => {
              const derived = parseFloat((basePrice * (parseFloat(unit.conv) || 1)).toFixed(4));
              const key = (unit.name || '').trim();
              const override = overrides[key];
              const finalPrice = (!unit.is_base && override !== undefined && override !== null && parseFloat(override) > 0)
                ? parseFloat(parseFloat(override).toFixed(4))
                : derived;
              return { ...unit, price: finalPrice };
            });
            const nonBase = updatedUnits.filter(x => !x.is_base);
            const altPrice = nonBase.length > 0
              ? nonBase.sort((a, b) => parseFloat(b.conv) - parseFloat(a.conv))[0].price
              : basePrice;
            const cost = (u.cost_price === undefined || u.cost_price === null || u.cost_price === '')
              ? row.cost_price
              : (parseFloat(u.cost_price) || 0);
            updProduct.run(JSON.stringify(updatedUnits), basePrice, altPrice, cost, id);
          }
        }

        // -- opening quantity: set to, never add --------------------------
        if (u.opening_qty !== undefined && u.opening_qty !== null && u.opening_qty !== '') {
          const qty = parseFloat(u.opening_qty) || 0;
          voidOpenings.run(row.sync_id, tenantId);
          // A cleared box means "this branch holds none", which is a real
          // statement. The void above already stands for it, so zero writes
          // no replacement row.
          if (qty !== 0) {
            insOpening.run(row.id, row.sync_id, qty, 'Opening balance', userId,
                           randomUUID(), tenantId, branchId, deviceId);
          }
          healStock.run(id);
        }
        count++;
      }
      return count;
    });

    const updated = tx();
    res.json({ updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Branch Prices — HQ sets one branch's selling price ──────────────────────
// v1.13.154
//
// Until now HQ had two levers and both were all-or-nothing: ticking "push
// price to all" on Item Details sent one product's price to EVERY branch, and
// bulk-push-prices sent every product to every branch. Neither could say
// "Chipata sells Flying Fish at 350, leave the others alone" — which is
// exactly what the depots needed, since Chipata was the only one to send a
// price list and its figures differ from HQ's on thirteen items.
//
// Prices are already branch-owned: mirrorAllHqToBranches takes pushPrices =
// false and deliberately leaves each branch's cost/selling/alt untouched. So
// the storage was right and only the control was missing. This writes into
// the branch's own products row, which is the same place Quick Price writes.
//
// NOT product_branch_prices. That table exists with exactly the right shape
// and is dead code — nothing reads it, and the POS prices from units_json.
// Reviving it would mean changing every price reader in the system.
//
// KEYED ON sync_id, NOT id. Product ids are per-database autoincrements and a
// given product has different ids at HQ and at each branch, so an id-keyed
// write would silently reprice the wrong item.
function branchPriceRows(branchDb, hqDb) {
  const base = (db) => {
    try {
      return db.prepare(
        `SELECT sync_id, code, name, unit, default_unit, selling_price, units_json, category_id
           FROM products WHERE deleted_at IS NULL AND sync_id IS NOT NULL`
      ).all();
    } catch { return []; }
  };
  // The price a till actually charges is the base unit's entry in units_json;
  // selling_price is the fallback for rows that predate it. Reading only
  // selling_price would show a figure the customer never pays — the exact gap
  // that let a direct SQL price update look applied while the POS charged the
  // old amount.
  const effective = (p) => {
    let units = [];
    try { units = JSON.parse(p.units_json || '[]'); } catch (_) {}
    if (Array.isArray(units) && units.length) {
      const b = units.find(u => u && u.is_base) || units[units.length - 1];
      const v = parseFloat(b?.price);
      if (!isNaN(v) && v > 0) return v;
    }
    return parseFloat(p.selling_price) || 0;
  };

  const hqBySync = new Map();
  for (const p of base(hqDb)) hqBySync.set(p.sync_id, p);

  return base(branchDb).map(p => {
    const hq = hqBySync.get(p.sync_id) || null;
    const branch_price = effective(p);
    const hq_price = hq ? effective(hq) : null;
    return {
      sync_id: p.sync_id,
      code: p.code,
      name: p.name,
      unit: p.default_unit || p.unit,
      category_id: p.category_id,
      hq_price,
      branch_price,
      // Null when HQ has no such product — a branch-only row. Shown as "—"
      // rather than 0, because 0 would read as "HQ sells it free".
      diff: hq_price === null ? null : Number((branch_price - hq_price).toFixed(2)),
    };
  }).sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
}

// 2026-09-04 — 'hq' is a valid target here now. The screen used to show HQ's
// price as a read-only column beside a branch, so changing HQ meant leaving
// for Item Details. Treating it as one more entry in the dropdown makes this
// the single place every price is set.
const HQ_SLUG = 'hq';
const dbForSlug = (slug) =>
  slug === HQ_SLUG ? (db.defaultDb || db) : getTenantDb(slug);
const validTarget = (slug) =>
  slug === HQ_SLUG || listTenants().some(t => t.slug === slug);

// Write a base price into one database, cascading through units_json exactly
// as the single-branch save does — writing selling_price alone looks applied
// while the till keeps charging the old amount, because POS reads the unit's
// price out of units_json first. Extracted so the save and the multi-push
// cannot drift apart.
function applyBasePrices(targetDb, updates) {
  const select = targetDb.prepare(
    'SELECT id, sync_id, units_json, selling_price FROM products WHERE sync_id = ? AND deleted_at IS NULL');
  const update = targetDb.prepare(
    `UPDATE products SET units_json = ?, selling_price = ?, alt_price = ?,
            updated_at = datetime('now'), synced = 0
      WHERE id = ?`);
  const skipped = [];
  const tx = targetDb.transaction(() => {
    let count = 0;
    for (const u of updates) {
      const syncId = String(u.sync_id || '').trim();
      const basePrice = parseFloat(u.base_price);
      if (!syncId || !(basePrice >= 0)) { skipped.push({ sync_id: syncId, why: 'bad price' }); continue; }
      const row = select.get(syncId);
      if (!row) { skipped.push({ sync_id: syncId, why: 'not at this branch' }); continue; }
      let units = [];
      try { units = JSON.parse(row.units_json || '[]'); } catch (_) {}
      if (!Array.isArray(units) || units.length === 0) {
        skipped.push({ sync_id: syncId, why: 'no units_json' });
        continue;
      }
      const updated = units.map(unit => ({
        ...unit,
        price: parseFloat((basePrice * (parseFloat(unit.conv) || 1)).toFixed(4)),
      }));
      const nonBase = updated.filter(x => !x.is_base);
      const altPrice = nonBase.length
        ? nonBase.sort((a, b) => parseFloat(b.conv) - parseFloat(a.conv))[0].price
        : basePrice;
      update.run(JSON.stringify(updated), basePrice, altPrice, row.id);
      count++;
    }
    return count;
  });
  return { updated: tx(), skipped };
}

// GET /api/products/branch-prices/:slug
router.get('/branch-prices/:slug', auth, (req, res) => {
  if (!isHqRequest(req)) return res.status(403).json({ error: 'HQ only' });
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(slug)) return res.status(400).json({ error: 'Bad branch' });
    if (!validTarget(slug)) {
      return res.status(404).json({ error: `No such branch: ${slug}` });
    }
    // With HQ on both sides the Diff column is always zero, which is right —
    // HQ cannot differ from itself, and the column keeps its meaning.
    res.json({ branch: slug, rows: branchPriceRows(dbForSlug(slug), db.defaultDb || db) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/products/branch-prices/:slug
// Body: { updates: [ { sync_id, base_price } ] }
//
// Writes the SAME units_json cascade as bulk-update-prices: every packaging's
// price becomes base x conv, and selling_price / alt_price follow. Writing
// selling_price alone is not enough and looks like it worked — POS.js reads
// the unit's price out of units_json first and only falls back to
// selling_price when the unit is missing, so a raw write leaves the till
// charging the old price.
//
// Cost price is deliberately untouched. Cost is driven by WAC from GRNs, and
// letting HQ type over it would corrupt COGS and every profit figure built on
// it.
router.post('/branch-prices/:slug', auth, readOnlyGuard, (req, res) => {
  if (!isHqRequest(req)) return res.status(403).json({ error: 'HQ only' });
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(slug)) return res.status(400).json({ error: 'Bad branch' });
    if (!validTarget(slug)) {
      return res.status(404).json({ error: `No such branch: ${slug}` });
    }
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (updates.length === 0) return res.status(400).json({ error: 'No updates provided.' });

    const { updated, skipped } = applyBasePrices(dbForSlug(slug), updates);
    return res.json({ ok: true, branch: slug, updated, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/products/branch-prices/multi-push
// Body: { updates: [ { sync_id, base_price } ], slugs: ['buseko','katete'] }
//
// 2026-09-04 — the deliberate replacement for "Push Prices to All Branches",
// which was hidden because it sent EVERY price to EVERY branch on one click
// with no undo. This sends only the items the operator just changed, only to
// the depots they ticked. Same cascade, a fraction of the blast radius.
//
// The prices come from the request rather than being re-read from HQ, so what
// is pushed is exactly what the operator saw on screen and confirmed — no
// window in which a concurrent edit changes what travels.
router.post('/branch-prices-multi-push', auth, readOnlyGuard, (req, res) => {
  if (!isHqRequest(req)) return res.status(403).json({ error: 'HQ only' });
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs : [];
    if (updates.length === 0) return res.status(400).json({ error: 'No prices to push.' });
    if (slugs.length === 0) return res.status(400).json({ error: 'No branches selected.' });

    const results = [];
    for (const raw of slugs) {
      const slug = String(raw || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(slug) || !validTarget(slug)) {
        results.push({ slug, error: 'unknown branch' });
        continue;
      }
      try {
        const { updated, skipped } = applyBasePrices(dbForSlug(slug), updates);
        results.push({ slug, updated, skipped: skipped.length });
      } catch (e) {
        // One unreachable branch must not lose the rest of the push.
        results.push({ slug, error: e.message });
      }
    }
    const total = results.reduce((n, r) => n + (r.updated || 0), 0);
    res.json({ ok: true, items: updates.length, branches: results.length, updated: total, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cost price (C.P.) ────────────────────────────────────────────────────────
//
// 2026-09-21. This is the OPENING cost — what an item was worth when the
// system started — not the weighted average. The two are different things and
// this deliberately never touches the WAC.
//
// Why it is needed: cost_price is set on 2 items out of 119 at every depot,
// because it was skipped when opening balances were loaded. The cost chain is
// avg_cost_price → the average of this item's GRNs → cost_price (see the
// SELECT at the top of this file), so an item that has never been delivered to
// a depot has no cost at all and its sales read as 100% profit. Filling
// cost_price in gives those items a floor until a real delivery sets a WAC,
// and from that moment the WAC takes over on its own.
//
// Entered once at HQ and pushed to the depots chosen, the same shape as
// branch-prices-multi-push: only the items just edited, only to the depots
// ticked. Nothing here writes avg_cost_price — that belongs to deliveries, and
// typing over it would rewrite COGS and every profit figure built on it.
function costPriceRows(book) {
  try {
    return book.prepare(
      `SELECT sync_id, code, name, unit,
              COALESCE(cost_price, 0)     AS cost_price,
              COALESCE(avg_cost_price, 0) AS avg_cost_price
         FROM products
        WHERE deleted_at IS NULL AND sync_id IS NOT NULL`
    ).all();
  } catch { return []; }
}

function applyCostPrices(book, updates) {
  const skipped = [];
  const select = book.prepare('SELECT id FROM products WHERE sync_id = ?');
  const update = book.prepare(
    `UPDATE products SET cost_price = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?`);
  const tx = book.transaction(() => {
    let count = 0;
    for (const u of updates) {
      const syncId = String(u?.sync_id || '').trim();
      const cost = parseFloat(u?.cost_price);
      if (!syncId || !(cost >= 0) || isNaN(cost)) { skipped.push({ sync_id: syncId, why: 'bad cost' }); continue; }
      const row = select.get(syncId);
      if (!row) { skipped.push({ sync_id: syncId, why: 'not at this branch' }); continue; }
      update.run(cost, row.id);
      count++;
    }
    return count;
  });
  return { updated: tx(), skipped };
}

// POST /api/products/cost-prices — save HQ's own C.P.
// Body: { updates: [ { sync_id, cost_price } ] }
router.post('/cost-prices', auth, readOnlyGuard, (req, res) => {
  if (!isHqRequest(req)) return res.status(403).json({ error: 'HQ only' });
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (updates.length === 0) return res.status(400).json({ error: 'No updates provided.' });
    const { updated, skipped } = applyCostPrices(db.defaultDb || db, updates);
    res.json({ ok: true, updated, skipped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/products/cost-prices-push — send those costs to the depots ticked.
// Body: { updates: [ { sync_id, cost_price } ], slugs: ['katete', …] }
//
// The costs come from the request, not re-read from HQ, so what lands is
// exactly what was confirmed on screen. One unreachable depot does not lose
// the rest of the push.
router.post('/cost-prices-push', auth, readOnlyGuard, (req, res) => {
  if (!isHqRequest(req)) return res.status(403).json({ error: 'HQ only' });
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs : [];
    if (updates.length === 0) return res.status(400).json({ error: 'No costs to push.' });
    if (slugs.length === 0) return res.status(400).json({ error: 'No depots selected.' });

    const results = [];
    for (const raw of slugs) {
      const slug = String(raw || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]+$/.test(slug) || !validTarget(slug) || slug === HQ_SLUG) {
        results.push({ slug, error: 'unknown depot' });
        continue;
      }
      try {
        const { updated, skipped } = applyCostPrices(dbForSlug(slug), updates);
        results.push({ slug, updated, skipped: skipped.length });
      } catch (e) {
        results.push({ slug, error: e.message });
      }
    }
    const total = results.reduce((n, r) => n + (r.updated || 0), 0);
    res.json({ ok: true, items: updates.length, depots: results.length, updated: total, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
