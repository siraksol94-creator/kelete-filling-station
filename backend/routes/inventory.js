const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { baseQtyExpr, conversionToBase } = require('../config/unitsHelper');
const { masterDb } = require('../config/masterDb');
const { getHostSlug } = require('../middleware/hqPush');

// Shared balance query â€” accepts tenantId for filtering
const balanceSQL = (tenantId) => ({
  text: `
  SELECT
    p.id, p.sync_id, p.code, p.name, p.unit, p.alt_unit, p.conversion_factor, p.alt_price, p.units_json,
    p.default_unit,
    p.cost_price, p.selling_price, p.min_stock, p.status, p.image_url,
    p.product_type,
    p.ub_number_start, p.ub_number_length, p.ub_quantity_start, p.ub_quantity_length, p.ub_decimal_start,
    c.name AS category_name, c.color AS category_color,
    COALESCE(store_agg.store_balance, 0) AS store_balance,
    COALESCE(sales_agg.sales_balance, 0) AS sales_balance,
    COALESCE(opening_agg.opening_balance, 0) AS opening_balance,
    COALESCE(grn_agg.total_in, 0) AS total_in,
    COALESCE(prod_out_agg.total_prod_out, 0) AS total_prod_out,
    COALESCE(prod_in_agg.total_prod_in, 0) AS total_prod_in,
    COALESCE(siv_agg.total_out, 0) AS total_out
  FROM products p
  LEFT JOIN categories c ON p.category_sync_id = c.sync_id
  LEFT JOIN (
    SELECT product_sync_id, SUM(quantity) AS store_balance
    FROM stock_movements WHERE location = 'store' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) store_agg ON store_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, SUM(quantity) AS sales_balance
    FROM stock_movements WHERE location = 'sales' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) sales_agg ON sales_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, SUM(quantity) AS opening_balance
    FROM stock_movements WHERE location = 'store' AND movement_type = 'opening' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) opening_agg ON opening_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, SUM(quantity) AS total_in
    FROM stock_movements WHERE location = 'store' AND movement_type = 'grn' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) grn_agg ON grn_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, SUM(quantity) AS total_prod_out
    FROM stock_movements WHERE location = 'store' AND movement_type = 'production_output' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) prod_out_agg ON prod_out_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, ABS(SUM(quantity)) AS total_prod_in
    FROM stock_movements WHERE location = 'store' AND movement_type = 'production_input' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) prod_in_agg ON prod_in_agg.product_sync_id = p.sync_id
  LEFT JOIN (
    SELECT product_sync_id, ABS(SUM(quantity)) AS total_out
    FROM stock_movements WHERE location = 'store' AND movement_type = 'siv' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
  ) siv_agg ON siv_agg.product_sync_id = p.sync_id
  WHERE p.deleted_at IS NULL AND p.tenant_id = ?
  ORDER BY p.name
`,
  params: [tenantId],
});

// GET /api/inventory
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const q = balanceSQL(req.user.tenantId);
    const rows = db.prepare(q.text).all(...q.params);

    // 2026-09-18 â€” stock already on a truck to another depot is NOT for sale
    // here. A transfer only leaves this depot's stock when the receiver
    // confirms it (v1.9.22), so sales_balance still counted it and POS offered
    // goods that had physically gone. Take the pending outgoing transfers off
    // what POS sees; transit_qty is returned too, so a screen can show it.
    // Same source as the Transit column on Stock Reconciliation and the Sales
    // Stock Card, so all three agree.
    try {
      const slug = getHostSlug(req);
      if (slug && masterDb) {
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
        for (const r of rows) {
          const transit = transitBySync.get(r.sync_id) || 0;
          r.transit_qty = transit;
          r.sales_balance_gross = parseFloat(r.sales_balance) || 0;
          r.sales_balance = r.sales_balance_gross - transit;
        }
      } else {
        for (const r of rows) r.transit_qty = 0;
      }
    } catch (_) {
      // On any error leave the figures as they are rather than lose the list.
      for (const r of rows) if (r.transit_qty === undefined) r.transit_qty = 0;
    }
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/store
// Optional ?location=store|sales â€” defaults to 'store'. The 'sales' variant
// powers the Sales Stock Card (same shape, same fields, same units rules,
// just filtered on the sales-counter side of the stock_movements ledger).
router.get('/store', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to } = req.query;
    const tenantId = req.user.tenantId;
    const loc = req.query.location === 'sales' ? 'sales' : 'store';

    // 2026-09-26 â€” what counts as a declared opening balance. TWO conventions
    // exist and this route knew only the older one:
    //
    //   current  movement_type='adjustment', reference_type='opening_balance'
    //   legacy   movement_type='opening'
    //
    // The Opening Balance page writes the first (routes/products.js:237) and
    // reads both. This route matched only 'opening', so on a Red Sea branch
    // -- where every declared balance uses the current shape -- the OPENING
    // BALANCE column read 0 for all 119 products while the Opening Balance
    // page plainly listed 36 of them. The quantity was never lost; it was
    // being counted as an incoming movement instead (see total_in below).
    //
    // COALESCE matters: reference_type is NULL on most rows, and a bare
    // `reference_type = 'x'` yields NULL there, which NOT() cannot negate --
    // every ordinary movement would fall out of total_in.
    const OPENING_ROW =
      `(COALESCE(reference_type, '') = 'opening_balance' OR COALESCE(movement_type, '') = 'opening')`;

    // Opening balance = all movements BEFORE `from` (if from set), else the
    // declared opening balance.
    const openingWhere = from
      ? `location = '${loc}' AND deleted_at IS NULL AND product_sync_id IS NOT NULL AND DATE(created_at) < '${from}'`
      : `location = '${loc}' AND ${OPENING_ROW} AND deleted_at IS NULL AND product_sync_id IS NOT NULL`;

    // In/out movements within the date range
    const rangeWhere = [
      `location = '${loc}'`, `deleted_at IS NULL`, `product_sync_id IS NOT NULL`,
      ...(from ? [`DATE(created_at) >= '${from}'`] : []),
      ...(to   ? [`DATE(created_at) <= '${to}'`]   : []),
    ].join(' AND ');

    // A row belongs in Total In unless the opening column already counted it,
    // so the two never double-count and Opening + In - Out still equals the
    // balance. With no `from` that means the declared opening rows. With a
    // `from`, opening is everything before that date -- which rangeWhere has
    // already excluded -- so nothing more needs taking out, and an opening
    // row dated INSIDE the range is a genuine movement in that window.
    const openingExcl = from ? '' : ` AND NOT ${OPENING_ROW}`;

    // Closing balance = all movements up to `to` (closing), or all-time if no `to`
    const balanceWhere = [
      `location = '${loc}'`, `deleted_at IS NULL`, `product_sync_id IS NOT NULL`,
      ...(to ? [`DATE(created_at) <= '${to}'`] : []),
    ].join(' AND ');

    const rows = db.prepare(`
      SELECT
        p.id, p.sync_id, p.code, p.name, p.unit, p.alt_unit, p.conversion_factor, p.alt_price, p.units_json, p.default_unit,
        p.cost_price, p.selling_price, p.min_stock, p.status, p.product_type,
        c.id AS category_id, c.name AS category_name, c.color AS category_color, c.main_category_id,
        COALESCE(store_agg.store_balance, 0) AS store_balance,
        COALESCE(opening_agg.opening_balance, 0) AS opening_balance,
        COALESCE(mvt_agg.total_in, 0) AS total_in,
        COALESCE(mvt_agg.total_out, 0) AS total_out,
        -- v1.13.83 â€” prefer the stored WAC (products.avg_cost_price)
        -- so Sales Stock Card / Item Details BALANCE VALUE agrees with
        -- Sales Report COGS. GRN aggregate is the fallback for pre-WAC
        -- rows, then the static cost_price hint as last resort. Matches
        -- the same chain products.js uses (routes/products.js:75-79).
        CASE
          WHEN COALESCE(p.avg_cost_price, 0) > 0 THEN p.avg_cost_price
          WHEN COALESCE(grn_cost.total_qty, 0) > 0
            THEN ROUND(COALESCE(grn_cost.total_cost, 0) / grn_cost.total_qty, 2)
          ELSE p.cost_price
        END AS avg_cost_price,
        CASE WHEN COALESCE(reprocess_agg.available_for_reprocessing, 0) < 0
          THEN 0
          ELSE COALESCE(reprocess_agg.available_for_reprocessing, 0)
        END AS available_for_reprocessing
      FROM products p
      LEFT JOIN categories c ON p.category_sync_id = c.sync_id
      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS store_balance
        FROM stock_movements WHERE ${balanceWhere} GROUP BY product_sync_id
      ) store_agg ON store_agg.product_sync_id = p.sync_id
      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS opening_balance
        FROM stock_movements WHERE ${openingWhere} GROUP BY product_sync_id
      ) opening_agg ON opening_agg.product_sync_id = p.sync_id
      LEFT JOIN (
        SELECT product_sync_id,
          SUM(CASE WHEN quantity > 0${openingExcl} THEN quantity ELSE 0 END) AS total_in,
          ABS(SUM(CASE WHEN quantity < 0 THEN quantity ELSE 0 END)) AS total_out
        FROM stock_movements WHERE ${rangeWhere} GROUP BY product_sync_id
      ) mvt_agg ON mvt_agg.product_sync_id = p.sync_id
      LEFT JOIN (
        -- Avg cost per BASE unit. Uses units_json so it works for N packagings (PCS + Pack + Box + â€¦).
        SELECT gi.product_sync_id,
               SUM(${baseQtyExpr('gip', 'gi')}) AS total_qty,
               SUM(gi.total_price) AS total_cost
        FROM grn_items gi
        LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
        WHERE gi.product_sync_id IS NOT NULL AND gi.deleted_at IS NULL
        GROUP BY gi.product_sync_id
      ) grn_cost ON grn_cost.product_sync_id = p.sync_id
      LEFT JOIN (
        SELECT product_sync_id,
          SUM(CASE WHEN movement_type = 'sales_return' THEN quantity ELSE 0 END) +
          SUM(CASE WHEN movement_type = 'production_input' THEN quantity ELSE 0 END)
          AS available_for_reprocessing
        FROM stock_movements WHERE location = '${loc}' AND deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id
      ) reprocess_agg ON reprocess_agg.product_sync_id = p.sync_id
      WHERE p.deleted_at IS NULL AND p.tenant_id = ?
      ORDER BY p.name
    `).all(tenantId);

    // v1.13.26 â€” attach transit_qty (base units) from PENDING outgoing
    // inter-branch transfers on the Sales Stock Card. Since v1.9.22
    // transfers don't deduct source stock until the receiver confirms, so
    // items on a truck to another branch still show as in-stock here.
    // Mirrors the pattern in stockReconciliation.js so the two pages
    // report the same transit numbers. Only relevant for location='sales'
    // (transfers post to the sales counter, not store).
    if (loc === 'sales') {
      try {
        const slug = getHostSlug(req);
        if (slug && masterDb) {
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
        for (const r of rows) r.transit_qty = 0;
      }
    } else {
      for (const r of rows) r.transit_qty = 0;
    }

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales
router.get('/sales', auth, readOnlyGuard, (req, res) => {
  try {
    const { date } = req.query;
    const selectedDate = date || new Date().toISOString().split('T')[0];

    const rows = db.prepare(`
      SELECT
        p.id, p.code, p.name, p.unit, p.alt_unit, p.conversion_factor, p.units_json, p.default_unit,
        p.cost_price, p.selling_price, p.min_stock, p.status,
        c.id AS category_id, c.name AS category_name, c.color AS category_color, c.main_category_id,

        COALESCE(prev_actual.actual_balance,
          COALESCE(opening_agg.opening_balance, 0)
        ) AS opening_balance,

        COALESCE(input_agg.input, 0) AS input,
        COALESCE(sales_day_agg.total_sales, 0) AS total_sales,
        COALESCE(returns_day_agg.total_returns, 0) AS total_returns,
        COALESCE(all_sales_agg.sales_balance, 0) AS sales_balance,

        CASE WHEN dcs.avg_cost_price IS NOT NULL THEN dcs.avg_cost_price
          WHEN COALESCE(grn_cost.total_qty, 0) + COALESCE(prod_cost.total_qty, 0) > 0
            THEN ROUND((COALESCE(grn_cost.total_cost, 0) + COALESCE(prod_cost.total_cost, 0)) /
                       (COALESCE(grn_cost.total_qty, 0) + COALESCE(prod_cost.total_qty, 0)), 2)
          ELSE p.cost_price
        END AS avg_cost_price,

        CASE WHEN dcs.selling_price IS NOT NULL THEN dcs.selling_price
          ELSE p.selling_price
        END AS selling_price,

        COALESCE(today_actual.actual_balance, NULL) AS saved_actual_balance,
        today_actual.reason AS saved_reason

      FROM products p
      LEFT JOIN categories c ON p.category_sync_id = c.sync_id

      LEFT JOIN daily_actual_balance prev_actual
        ON prev_actual.product_sync_id = p.sync_id AND prev_actual.date = date(@date, '-1 day')

      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS opening_balance
        FROM stock_movements WHERE location = 'sales' AND deleted_at IS NULL AND created_at < @date AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) opening_agg ON opening_agg.product_sync_id = p.sync_id

      LEFT JOIN (
        -- v1.9.24 â€” Kelete posts GRN directly at location='sales' (no store
        -- layer, no SIV), so the Input column has to include 'grn' (and
        -- 'transfer_in') alongside 'siv'. Date filter is on the stock_movement
        -- created_at (which carries the GRN/SIV business date, set explicitly
        -- in the writer), so the old JOIN to siv just to read siv.date is
        -- unnecessary.
        SELECT product_sync_id, SUM(quantity) AS input
        FROM stock_movements
        WHERE location = 'sales'
          AND movement_type IN ('siv', 'grn', 'transfer_in')
          AND date(created_at) = @date
          AND deleted_at IS NULL
          AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) input_agg ON input_agg.product_sync_id = p.sync_id

      LEFT JOIN (
        -- v1.8.15: include 'sale_reverse' (partial-reverse movement type
        -- introduced in v1.8.12). Without this, reversing 1 of 12 PUSHKIN
        -- sales still shows Total Sales=12 because the +1 sale_reverse
        -- movement was ignored. ABS(SUM(...)) gives NET sales after
        -- reverses (sale=-qty, sale_reverse=+qty).
        SELECT product_sync_id, ABS(SUM(quantity)) AS total_sales
        FROM stock_movements WHERE location = 'sales' AND movement_type IN ('sale', 'reverse', 'sale_reverse')
          AND created_at >= @date AND created_at < date(@date, '+1 day') AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) sales_day_agg ON sales_day_agg.product_sync_id = p.sync_id

      LEFT JOIN (
        SELECT sm.product_sync_id, ABS(SUM(sm.quantity)) AS total_returns
        FROM stock_movements sm
        JOIN sales_returns sr ON sr.sync_id = sm.reference_sync_id
        WHERE sm.location = 'sales' AND sm.movement_type = 'sales_return'
          AND sr.date = @date AND sm.deleted_at IS NULL AND sm.product_sync_id IS NOT NULL
        GROUP BY sm.product_sync_id
      ) returns_day_agg ON returns_day_agg.product_sync_id = p.sync_id

      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS sales_balance
        FROM stock_movements WHERE location = 'sales'
          AND deleted_at IS NULL AND created_at < date(@date, '+1 day') AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) all_sales_agg ON all_sales_agg.product_sync_id = p.sync_id

      LEFT JOIN (
        -- Avg cost per BASE unit. baseQtyExpr handles N packagings via units_json.
        SELECT gi.product_sync_id,
               SUM(${baseQtyExpr('gip', 'gi')}) AS total_qty,
               SUM(gi.total_price) AS total_cost
        FROM grn_items gi
        LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
        WHERE gi.product_sync_id IS NOT NULL AND gi.deleted_at IS NULL
        GROUP BY gi.product_sync_id
      ) grn_cost ON grn_cost.product_sync_id = p.sync_id

      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost
        FROM production_outputs WHERE product_sync_id IS NOT NULL AND deleted_at IS NULL GROUP BY product_sync_id
      ) prod_cost ON prod_cost.product_sync_id = p.sync_id

      LEFT JOIN daily_cost_snapshot dcs
        ON dcs.product_sync_id = p.sync_id AND dcs.date = @date AND dcs.deleted_at IS NULL

      LEFT JOIN daily_actual_balance today_actual
        ON today_actual.product_sync_id = p.sync_id AND today_actual.date = @date

      WHERE p.deleted_at IS NULL AND p.tenant_id = @tenantId AND (
        COALESCE(all_sales_agg.sales_balance, 0) != 0
        OR COALESCE(input_agg.input, 0) != 0
        OR COALESCE(sales_day_agg.total_sales, 0) != 0
        OR COALESCE(prev_actual.actual_balance, 0) != 0
        OR today_actual.actual_balance IS NOT NULL
      )

      ORDER BY p.name
    `).all({ date: selectedDate, tenantId: req.user.tenantId });
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales/profit-summary?date=YYYY-MM-DD
router.get('/sales/profit-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const { date } = req.query;
    const selectedDate = date || new Date().toISOString().split('T')[0];
    const tenantId = req.user.tenantId;

    // Revenue: actual cash from POS orders
    const revRow = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) AS revenue
      FROM orders
      WHERE DATE(created_at) = ? AND deleted_at IS NULL AND tenant_id = ?
        AND (status IS NULL OR status != 'Reversed')
    `).get(selectedDate, tenantId);

    // COGS: sale movements Ã— snapshot cost (fallback to GRN+production avg, then p.cost_price)
    const cogsRow = db.prepare(`
      SELECT COALESCE(SUM(ABS(sm.quantity) *
        COALESCE(dcs.avg_cost_price,
          CASE WHEN COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0) > 0
            THEN (COALESCE(grn_agg.total_cost,0)+COALESCE(prod_agg.total_cost,0)) /
                 (COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0))
            ELSE p.cost_price END)
      ), 0) AS cogs
      FROM stock_movements sm
      JOIN products p ON p.sync_id = sm.product_sync_id
      LEFT JOIN daily_cost_snapshot dcs ON dcs.product_sync_id = sm.product_sync_id AND dcs.date = ? AND dcs.deleted_at IS NULL
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_price) AS total_cost FROM grn_items WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) grn_agg ON grn_agg.product_sync_id = sm.product_sync_id
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) prod_agg ON prod_agg.product_sync_id = sm.product_sync_id
      WHERE sm.location = 'sales' AND sm.movement_type IN ('sale', 'reverse', 'sale_reverse')
        AND DATE(sm.created_at) = ? AND sm.deleted_at IS NULL AND sm.product_sync_id IS NOT NULL
        AND p.tenant_id = ?
    `).get(selectedDate, selectedDate, tenantId);

    // Difference value: reconciliation movements Ã— snapshot cost
    const diffRow = db.prepare(`
      SELECT COALESCE(SUM(sm.quantity *
        COALESCE(dcs.avg_cost_price,
          CASE WHEN COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0) > 0
            THEN (COALESCE(grn_agg.total_cost,0)+COALESCE(prod_agg.total_cost,0)) /
                 (COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0))
            ELSE p.cost_price END)
      ), 0) AS diff_value
      FROM stock_movements sm
      JOIN products p ON p.sync_id = sm.product_sync_id
      LEFT JOIN daily_cost_snapshot dcs ON dcs.product_sync_id = sm.product_sync_id AND dcs.date = ? AND dcs.deleted_at IS NULL
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_price) AS total_cost FROM grn_items WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) grn_agg ON grn_agg.product_sync_id = sm.product_sync_id
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) prod_agg ON prod_agg.product_sync_id = sm.product_sync_id
      WHERE sm.location = 'sales' AND sm.movement_type = 'reconciliation'
        AND DATE(sm.created_at) = ? AND sm.deleted_at IS NULL AND sm.product_sync_id IS NOT NULL
        AND p.tenant_id = ?
    `).get(selectedDate, selectedDate, tenantId);

    // Cash difference from saved cash report
    const cashRow = db.prepare(`
      SELECT COALESCE(difference, 0) AS cash_difference
      FROM cash_reports WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
    `).get(selectedDate, tenantId);

    // PV total for the date
    const pvRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS pv_total
      FROM payment_vouchers WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
    `).get(selectedDate, tenantId);

    // Stock adjustment value Ã— snapshot cost
    const adjRow = db.prepare(`
      SELECT COALESCE(SUM(sa.quantity *
        COALESCE(dcs.avg_cost_price,
          CASE WHEN COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0) > 0
            THEN (COALESCE(grn_agg.total_cost,0)+COALESCE(prod_agg.total_cost,0)) /
                 (COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0))
            ELSE p.cost_price END)
      ), 0) AS stock_adj
      FROM stock_adjustments sa
      JOIN products p ON p.sync_id = sa.product_sync_id
      LEFT JOIN daily_cost_snapshot dcs ON dcs.product_sync_id = sa.product_sync_id AND dcs.date = ? AND dcs.deleted_at IS NULL
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_price) AS total_cost FROM grn_items WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) grn_agg ON grn_agg.product_sync_id = sa.product_sync_id
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) prod_agg ON prod_agg.product_sync_id = sa.product_sync_id
      WHERE sa.date = ? AND sa.deleted_at IS NULL AND p.tenant_id = ?
    `).get(selectedDate, selectedDate, tenantId);

    const revenue       = parseFloat(revRow.revenue);
    const cogs          = parseFloat(cogsRow.cogs);
    const diffValue     = parseFloat(diffRow.diff_value);
    const cashDiff      = parseFloat(cashRow?.cash_difference ?? 0);
    const pvTotal       = parseFloat(pvRow.pv_total);
    const stockAdj      = parseFloat(adjRow.stock_adj);
    const grossProfit   = revenue - cogs + diffValue + cashDiff;
    const netProfit     = grossProfit - pvTotal + stockAdj;

    res.json({ revenue, cogs, diff_value: diffValue, cash_difference: cashDiff, gross_profit: grossProfit, pv_total: pvTotal, stock_adj: stockAdj, net_profit: netProfit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales/daily-summary?date=YYYY-MM-DD
router.get('/sales/daily-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const tenantId = req.user.tenantId;
    const row = db.prepare(`
      SELECT date, revenue, cogs, damages, supplier_rebates, diff_value, cash_difference, pv_total, stock_adj, gross_profit, net_profit
      FROM daily_profit_summary
      WHERE date = ? AND tenant_id = ?
    `).get(date, tenantId);
    if (!row) return res.json({ date, revenue: 0, cogs: 0, damages: 0, supplier_rebates: 0, diff_value: 0, cash_difference: 0, pv_total: 0, stock_adj: 0, gross_profit: 0, net_profit: 0 });
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales/range-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns the full profit breakdown aggregated over the range so the Profit
// Report can render the same set of cards/rows in either single-day or range mode.
router.get('/sales/range-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to } = req.query;
    const tenantId = req.user.tenantId;
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(revenue),         0) AS revenue,
        COALESCE(SUM(cogs),            0) AS cogs,
        COALESCE(SUM(damages),         0) AS damages,
        COALESCE(SUM(supplier_rebates),0) AS supplier_rebates,
        COALESCE(SUM(diff_value),      0) AS diff_value,
        COALESCE(SUM(cash_difference), 0) AS cash_difference,
        COALESCE(SUM(pv_total),        0) AS pv_total,
        COALESCE(SUM(stock_adj),       0) AS stock_adj,
        COALESCE(SUM(gross_profit),    0) AS gross_profit,
        COALESCE(SUM(net_profit),      0) AS net_profit,
        -- Legacy aliases (used by Dashboard widget â€” keep so we don't break anything)
        COALESCE(SUM(revenue),      0) AS total_revenue
      FROM daily_profit_summary
      WHERE tenant_id = ?
        AND (? IS NULL OR date >= ?)
        AND (? IS NULL OR date <= ?)
    `).get(tenantId, from || null, from || null, to || null, to || null);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales/monthly-summary?month=YYYY-MM
router.get('/sales/monthly-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const tenantId = req.user.tenantId;

    // Sum stored daily profit rows (only days where actual balances were saved)
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(revenue), 0)         AS total_revenue,
        COALESCE(SUM(cogs), 0)            AS total_cogs,
        COALESCE(SUM(diff_value), 0)      AS total_difference,
        COALESCE(SUM(cash_difference), 0) AS total_cash_difference,
        COALESCE(SUM(pv_total), 0)        AS total_pv,
        COALESCE(SUM(gross_profit), 0)    AS gross_profit,
        COALESCE(SUM(net_profit), 0)      AS net_profit
      FROM daily_profit_summary
      WHERE strftime('%Y-%m', date) = ? AND tenant_id = ?
    `).get(month, tenantId);

    res.json({
      total_revenue:         parseFloat(row.total_revenue),
      total_cogs:            parseFloat(row.total_cogs),
      total_difference:      parseFloat(row.total_difference),
      total_cash_difference: parseFloat(row.total_cash_difference),
      total_pv:              parseFloat(row.total_pv),
      gross_profit:          parseFloat(row.gross_profit),
      net_profit:            parseFloat(row.net_profit),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales/siv-breakdown?date=&product_id=
router.get('/sales/siv-breakdown', auth, readOnlyGuard, (req, res) => {
  try {
    const { date, product_id } = req.query;
    const rows = db.prepare(`
      SELECT s.siv_number, s.department, sm.quantity, sm.created_at
      FROM stock_movements sm
      JOIN siv s ON s.sync_id = sm.reference_sync_id
      WHERE sm.location = 'sales' AND sm.movement_type = 'siv'
        AND sm.product_sync_id = (SELECT sync_id FROM products WHERE id = ? AND tenant_id = ?) AND s.date = ? AND sm.deleted_at IS NULL
      ORDER BY sm.created_at ASC
    `).all(product_id, req.user.tenantId, date);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/inventory/sales/actual â€” save actual balances for a date
router.post('/sales/actual', auth, readOnlyGuard, (req, res) => {
  try {
    const { date, entries, created_by, diff_value } = req.body;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    db.transaction(() => {
      for (const entry of entries) {
        // Prefer client-sent product_sync_id to avoid writing the actual
        // balance against the wrong product on cross-device data.
        const entryProductSyncId = entry.product_sync_id
          || db.prepare('SELECT sync_id FROM products WHERE id = ?').get(entry.product_id)?.sync_id
          || null;

        // Save actual balance record
        db.prepare(`
          INSERT INTO daily_actual_balance (product_id, product_sync_id, date, actual_balance, reason, created_by, sync_id, tenant_id, branch_id, device_id, synced)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          ON CONFLICT (product_sync_id, date)
          DO UPDATE SET actual_balance = excluded.actual_balance,
                        reason = excluded.reason,
                        created_by = excluded.created_by,
                        created_at = datetime('now'),
                        synced = 0
        `).run(entry.product_id, entryProductSyncId, date, entry.actual_balance, entry.reason || null, created_by,
               randomUUID(), tenantId, branchId, deviceId);

        // Create reconciliation movement so POS "In Stock" reflects the actual balance
        // Step 1: delete ALL old reconciliations first (avoids stacking)
        // v1.10.23 â€” roll the old reconciliations' net effect off current_stock
        // before soft-deleting them. Otherwise a re-reconciliation double-counts.
        const oldRec = db.prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS net FROM stock_movements
            WHERE product_sync_id = ? AND location = 'sales'
              AND movement_type = 'reconciliation' AND deleted_at IS NULL`
        ).get(entryProductSyncId).net;
        if (oldRec && Math.abs(oldRec) > 0.0001) {
          db.prepare(
            `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(oldRec, entryProductSyncId);
        }
        db.prepare(
          `UPDATE stock_movements SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE product_sync_id = ? AND location = 'sales' AND movement_type = 'reconciliation' AND deleted_at IS NULL`
        ).run(entryProductSyncId);
        // Step 2: calculate diff against natural movements only (no reconciliations left)
        const currentSales = db.prepare(
          `SELECT COALESCE(SUM(quantity), 0) AS bal FROM stock_movements WHERE product_sync_id = ? AND location = 'sales' AND deleted_at IS NULL`
        ).get(entryProductSyncId);
        const diff = parseFloat(entry.actual_balance) - parseFloat(currentSales.bal);
        if (Math.abs(diff) > 0.0001) {
          db.prepare(`
            INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
            VALUES (?, ?, 'sales', 'reconciliation', ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))
          `).run(entry.product_id, entryProductSyncId, diff, `Reconciliation: actual balance set to ${entry.actual_balance}`, created_by,
                 randomUUID(), tenantId, branchId, deviceId, date);
          // v1.10.23 â€” apply the new reconciliation delta to current_stock.
          db.prepare(
            `UPDATE products SET current_stock = current_stock + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(diff, entryProductSyncId);
        }
      }
    })();

    // Snapshot avg_cost_price + selling_price for ALL active products for this date
    const allProducts = db.prepare(`
      SELECT p.id, p.sync_id, p.cost_price, p.selling_price,
        COALESCE(grn_agg.total_qty, 0) + COALESCE(prod_agg.total_qty, 0) AS combined_qty,
        COALESCE(grn_agg.total_cost, 0) + COALESCE(prod_agg.total_cost, 0) AS combined_cost
      FROM products p
      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_price) AS total_cost
        FROM grn_items WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) grn_agg ON grn_agg.product_sync_id = p.sync_id
      LEFT JOIN (
        SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost
        FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL
        GROUP BY product_sync_id
      ) prod_agg ON prod_agg.product_sync_id = p.sync_id
      WHERE p.deleted_at IS NULL AND p.tenant_id = ?
    `).all(tenantId);

    const upsertSnapshot = db.prepare(`
      INSERT INTO daily_cost_snapshot (product_id, product_sync_id, date, avg_cost_price, selling_price, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      ON CONFLICT (product_sync_id, date)
      DO UPDATE SET avg_cost_price = excluded.avg_cost_price,
                    selling_price  = excluded.selling_price,
                    updated_at     = datetime('now'),
                    synced         = 0
    `);

    db.transaction(() => {
      for (const p of allProducts) {
        const avgCost = (p.combined_qty > 0)
          ? parseFloat(p.combined_cost) / parseFloat(p.combined_qty)
          : parseFloat(p.cost_price);
        upsertSnapshot.run(p.id, p.sync_id, date, avgCost, parseFloat(p.selling_price),
          randomUUID(), tenantId, branchId, deviceId);
      }
    })();

    // Compute and store daily profit summary (use frontend-computed diff_value if provided)
    recalculateDailyProfit(db, date, tenantId);

    res.json({ message: 'Actual balances saved successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/stats
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const q = balanceSQL(req.user.tenantId);
    const products = db.prepare(q.text).all(...q.params);
    const totalProducts = products.length;
    const storeValue = products.reduce((sum, p) => sum + parseFloat(p.store_balance) * parseFloat(p.selling_price || 0), 0);
    const salesValue = products.reduce((sum, p) => sum + parseFloat(p.sales_balance) * parseFloat(p.selling_price || 0), 0);
    const lowStockSales = products.filter(p => parseFloat(p.sales_balance) <= parseFloat(p.min_stock || 0)).length;
    const lowStockStore = products.filter(p => parseFloat(p.store_balance) <= parseFloat(p.min_stock || 0)).length;
    res.json({ totalProducts, storeValue, salesValue, lowStockSales, lowStockStore });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/bin-card
router.get('/bin-card', auth, readOnlyGuard, (req, res) => {
  try {
    const { product_id, from, to } = req.query;
    if (!product_id) return res.status(400).json({ error: 'product_id is required.' });
    const pid = parseInt(product_id);

    const pidSyncRow = db.prepare('SELECT sync_id FROM products WHERE id = ? AND tenant_id = ?').get(pid, req.user.tenantId);
    const pidSync = pidSyncRow?.sync_id;

    // Opening balance: ALL opening movements (any date) + non-opening movements before 'from'
    let obSql, obParams;
    if (from) {
      obSql = `SELECT COALESCE(SUM(quantity), 0) AS opening_balance FROM stock_movements
        WHERE product_sync_id = ? AND location = 'store' AND deleted_at IS NULL
        AND (movement_type = 'opening' OR created_at < ?)`;
      obParams = [pidSync, from];
    } else {
      obSql = `SELECT COALESCE(SUM(quantity), 0) AS opening_balance FROM stock_movements
        WHERE product_sync_id = ? AND location = 'store' AND deleted_at IS NULL`;
      obParams = [pidSync];
    }
    const obRow = db.prepare(obSql).get(...obParams);
    const openingBalance = parseFloat(obRow.opening_balance);

    // Main bin-card query: exclude opening movements (already in opening balance)
    const namedParams = { product_sync_id: pidSync };
    let sql = `
      SELECT
        sm.id,
        date(sm.created_at)   AS date,
        sm.movement_type,
        sm.reference_type,
        COALESCE(g.grn_number, sv.siv_number, pr.production_number, sm.movement_type) AS reference,
        sm.quantity,
        SUM(sm.quantity) OVER (
          ORDER BY sm.created_at ASC, sm.id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS running_total
      FROM stock_movements sm
      LEFT JOIN grn g        ON g.sync_id  = sm.reference_sync_id AND sm.reference_type = 'grn'
      LEFT JOIN siv sv       ON sv.sync_id = sm.reference_sync_id AND sm.reference_type = 'siv'
      LEFT JOIN production pr ON pr.sync_id = sm.reference_sync_id AND sm.reference_type = 'production'
      WHERE sm.product_sync_id = @product_sync_id AND sm.location = 'store'
        AND sm.deleted_at IS NULL AND sm.movement_type != 'opening'
    `;
    if (from) { sql += ' AND sm.created_at >= @from'; namedParams.from = from; }
    if (to)   { sql += " AND sm.created_at < date(@to, '+1 day')"; namedParams.to = to; }
    sql += ' ORDER BY sm.created_at ASC, sm.id ASC';

    // Add opening balance offset to each row's balance in JS (not SQL) to avoid window function param binding issues
    const rawRows = db.prepare(sql).all(namedParams);
    const rows = rawRows.map(row => ({ ...row, balance: openingBalance + row.running_total }));
    res.json({ rows, opening_balance: openingBalance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/inventory/sales-bin-card
router.get('/sales-bin-card', auth, readOnlyGuard, (req, res) => {
  try {
    const { product_id, from, to } = req.query;
    if (!product_id) return res.status(400).json({ error: 'product_id is required.' });
    const pid = parseInt(product_id);

    const pidSyncRow = db.prepare('SELECT sync_id FROM products WHERE id = ? AND tenant_id = ?').get(pid, req.user.tenantId);
    const pidSync = pidSyncRow?.sync_id;

    // For sales_return movements, use the user-selected date (sr.date) not created_at
    const effectiveDate = `CASE WHEN sm.movement_type = 'sales_return' AND sr.date IS NOT NULL THEN sr.date ELSE date(sm.created_at) END`;

    // Opening balance: sum of all sales movements before 'from'
    let obSql, obParams;
    if (from) {
      obSql = `SELECT COALESCE(SUM(sm.quantity), 0) AS opening_balance
        FROM stock_movements sm
        LEFT JOIN sales_returns sr ON sr.sync_id = sm.reference_sync_id AND sm.reference_type = 'sales_return'
        WHERE sm.product_sync_id = ? AND sm.location = 'sales' AND sm.deleted_at IS NULL
          AND (CASE WHEN sm.movement_type = 'sales_return' AND sr.date IS NOT NULL THEN sr.date ELSE date(sm.created_at) END) < ?`;
      obParams = [pidSync, from];
    } else {
      obSql = `SELECT COALESCE(SUM(sm.quantity), 0) AS opening_balance
        FROM stock_movements sm
        LEFT JOIN sales_returns sr ON sr.sync_id = sm.reference_sync_id AND sm.reference_type = 'sales_return'
        WHERE sm.product_sync_id = ? AND sm.location = 'sales' AND sm.deleted_at IS NULL AND 1=0`;
      obParams = [pidSync];
    }
    const obRow = db.prepare(obSql).get(...obParams);
    const openingBalance = parseFloat(obRow.opening_balance);

    const namedParams = { product_sync_id: pidSync };
    let sql = `
      SELECT
        sm.id,
        (${effectiveDate}) AS date,
        sm.movement_type,
        sm.reference_type,
        -- 2026-08-30 â€” the frontend needs this to open the HQ GRN modal: an
        -- HQ-generated GRN has no row in the branch grn table, so it is
        -- looked up in master.db by sync_id instead.
        sm.reference_sync_id,
        -- v1.9.24 â€” include grn.grn_number so a GRN posted directly to
        -- sales (Kelete's drop-ship flow) shows "GRN-â€¦" in the reference
        -- column instead of the raw movement_type "grn".
        --
        -- Partial / full sale reversals: reference_type='order_reverse'
        -- points at the ORIGINAL order.sync_id. Instead of falling
        -- through to the bare movement_type ("sale_reverse"), surface the
        -- Credit Note identifier from the parent order â€” local_cn_number
        -- when set, otherwise a CN- derivative of the order number so the
        -- Bin Card matches Sales Report's CN-row labelling. If ZRA is on
        -- and signed the CN, the composite CRN{sdcSuffix}/{zra_cn_rcpt_no}
        -- lives on the receipt template; Bin Card sticks with the shorter
        -- CN-â€¦ form to stay narrow.
        COALESCE(
          o.order_number,
          sv.siv_number,
          sr.return_number,
          g.grn_number,
          CASE WHEN sm.reference_type = 'order_reverse' AND o_rev.order_number IS NOT NULL
               THEN COALESCE(o_rev.local_cn_number,
                             'CN-' || REPLACE(o_rev.order_number, 'ORD-', ''))
               ELSE NULL END,
          sm.movement_type
        ) AS reference,
        -- When the SIV was auto-generated from a GRN (single-location mode), surface the GRN
        -- number so the bin card row reads "SIV-â€¦0010 (from GRN-â€¦0009)".
        sv_grn.grn_number AS source_grn_number,
        sm.quantity,
        SUM(sm.quantity) OVER (
          ORDER BY (${effectiveDate}) ASC, sm.id ASC
          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS running_total
      FROM stock_movements sm
      LEFT JOIN orders o         ON o.sync_id  = sm.reference_sync_id AND sm.reference_type = 'order'
      LEFT JOIN orders o_rev     ON o_rev.sync_id = sm.reference_sync_id AND sm.reference_type = 'order_reverse'
      LEFT JOIN siv sv           ON sv.sync_id = sm.reference_sync_id AND sm.reference_type = 'siv'
      LEFT JOIN grn sv_grn       ON sv_grn.sync_id = sv.source_grn_sync_id
      LEFT JOIN grn g            ON g.sync_id  = sm.reference_sync_id AND sm.reference_type = 'grn'
      LEFT JOIN sales_returns sr ON sr.sync_id = sm.reference_sync_id AND sm.reference_type = 'sales_return'
      WHERE sm.product_sync_id = @product_sync_id AND sm.location = 'sales'
        AND sm.deleted_at IS NULL
    `;
    if (from) { sql += ` AND (${effectiveDate}) >= @from`; namedParams.from = from; }
    if (to)   { sql += ` AND (${effectiveDate}) <= @to`; namedParams.to = to; }
    sql += ` ORDER BY (${effectiveDate}) ASC, sm.id ASC`;

    const rawRows = db.prepare(sql).all(namedParams);

    // 2026-08-30 â€” resolve the references that are NOT in this database.
    //
    // Inter-branch transfers live in master.stock_transfers and HQ-generated
    // GRNs in master.hq_grns, so no LEFT JOIN above can reach them: this query
    // runs against the branch DB only. Those rows fell through the COALESCE to
    // the bare movement_type, so the bin card read "transfer" or "grn" where
    // the operator expected TRF-2026-... or GRN-2026-...
    //
    // reference_type is 'hq_grn' for a GRN raised by HQ's Generate GRN
    // (hqGrns.js) and 'grn' for a branch-confirmed one â€” which is why the
    // existing join, scoped to 'grn', never matched the HQ ones.
    const rows = rawRows.map(row => {
      let reference = row.reference;
      const unresolved = !reference || reference === row.movement_type;
      if (unresolved && row.reference_sync_id && masterDb) {
        try {
          if (row.reference_type === 'transfer' || row.reference_type === 'stock_transfer') {
            reference = masterDb.prepare(
              'SELECT transfer_number FROM stock_transfers WHERE sync_id = ?'
            ).get(row.reference_sync_id)?.transfer_number || reference;
          } else if (row.reference_type === 'hq_grn' || row.reference_type === 'grn') {
            reference = masterDb.prepare(
              'SELECT grn_number FROM hq_grns WHERE sync_id = ?'
            ).get(row.reference_sync_id)?.grn_number || reference;
          } else if (row.reference_type === 'credit_note') {
            // 2026-08-31 â€” supplier credit notes live in master too, so this
            // row read the bare word "credit_note" with no way to tell which
            // one took the stock. Falls back to the branch's own table for a
            // CN raised locally rather than through an HQ GRN.
            reference = masterDb.prepare(
              'SELECT credit_note_number FROM hq_supplier_credit_notes WHERE sync_id = ?'
            ).get(row.reference_sync_id)?.credit_note_number || reference;
          }
        } catch (_) { /* master.db absent on this device â€” keep the raw label */ }
      }
      // A credit note raised at the branch lives in the tenant DB.
      if ((!reference || reference === row.movement_type)
          && row.reference_type === 'credit_note' && row.reference_sync_id) {
        try {
          reference = db.prepare(
            'SELECT credit_note_number FROM supplier_credit_notes WHERE sync_id = ?'
          ).get(row.reference_sync_id)?.credit_note_number || reference;
        } catch (_) { /* older schema â€” keep the raw label */ }
      }
      return { ...row, reference, balance: openingBalance + row.running_total };
    });
    res.json({ rows, opening_balance: openingBalance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// 2026-08-30 â€” GET /api/inventory/hq-grn/:syncId  (ported from Kelete v1.10.323)
//
// Read-only HQ GRN lookup for branch users. Red Sea procurement is HQ-owned,
// so a GRN reference on a branch bin card (GRN-2026-...) does NOT exist in
// that branch's own `grn` table â€” it lives in master.hq_grns. Clicking it
// used to navigate to an empty branch GRN page. The frontend now opens a
// read-only modal fed by this endpoint instead.
//
// Header + items come from master; the supplier NAME is resolved from the
// tenant `suppliers` table, because master.db does not carry it. Kelete
// learned that the hard way: a JOIN that silently threw left every reference
// stuck showing the raw movement type instead of the GRN number.
router.get('/hq-grn/:syncId', auth, readOnlyGuard, (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'HQ archive unavailable on this device.' });
    const { syncId } = req.params;

    const grn = masterDb.prepare(
      `SELECT * FROM hq_grns WHERE sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')`
    ).get(syncId);
    if (!grn) return res.status(404).json({ error: 'HQ GRN not found.' });

    const items = masterDb.prepare(
      `SELECT * FROM hq_grn_items WHERE grn_sync_id = ? ORDER BY id ASC`
    ).all(syncId);

    let purchase = null;
    if (grn.po_sync_id) {
      try {
        purchase = masterDb.prepare(
          `SELECT purchase_number, date, created_by_name, created_at, notes
             FROM hq_purchases WHERE sync_id = ?`
        ).get(grn.po_sync_id) || null;
      } catch (_) { /* legacy PO â€” non-fatal, the modal just omits it */ }
    }

    let supplier_name = grn.supplier_name || null;
    if (!supplier_name && grn.supplier_sync_id) {
      try {
        const s = db.prepare(`SELECT name FROM suppliers WHERE sync_id = ?`).get(grn.supplier_sync_id);
        supplier_name = s?.name || null;
      } catch (_) { /* pre-migration branch â€” non-fatal */ }
    }

    // 2026-08-31 â€” the credit notes, with their lines.
    //
    // The modal showed a single "CREDIT NOTES -66,621.54" and nothing else, so
    // a bin card row that moved 3 boxes out could not be tied to the note that
    // moved them. Same breakdown the AP and archive screens now carry.
    let credit_notes = [];
    try {
      credit_notes = masterDb.prepare(
        `SELECT sync_id, credit_note_number, reason, amount, vat_amount, notes, date
           FROM hq_supplier_credit_notes
          WHERE grn_sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')
          ORDER BY id ASC`
      ).all(syncId);
      const cnItems = masterDb.prepare(
        `SELECT product_name, unit, quantity, unit_value, discount, total_price
           FROM hq_supplier_credit_note_items
          WHERE credit_note_sync_id = ? ORDER BY id ASC`
      );
      for (const cn of credit_notes) {
        try { cn.items = cnItems.all(cn.sync_id) || []; } catch (_) { cn.items = []; }
      }
    } catch (_) { /* pre-migration mirror â€” the modal just omits them */ }

    res.json({
      grn: {
        ...grn,
        supplier_name,
        // Explicit passthrough of the audit fields the modal renders, so a
        // schema rename shows up as a lint hit rather than a silent blank.
        confirmed_by_branch_name: grn.confirmed_by_branch_name || null,
        confirmed_at_branch:      grn.confirmed_at_branch || null,
        generated_by_hq_name:     grn.generated_by_hq_name || null,
        generated_at:             grn.generated_at || null,
      },
      items,
      purchase,
      credit_notes,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
