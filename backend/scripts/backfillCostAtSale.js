/**
 * backfillCostAtSale.js â€” v1.13.49
 * One-shot: fill stock_movements.cost_at_sale for historical rows that
 * predate the trg_stamp_cost_at_sale trigger. Only touches the movement
 * types profitHelper actually reads (sale, sale_reverse, sales_return,
 * transit_writeoff) and only rows where cost_at_sale IS NULL.
 *
 * Priority order (highest confidence first):
 *   1. daily_cost_snapshot row for that (product, date)  â† truth-locked
 *   2. GRN + production aggregate DATED to that day       â† historical avg
 *   3. products.cost_price                                â† static hint
 *
 * Idempotent â€” running it twice does nothing new (only NULL rows update).
 *
 * Usage on VPS:
 *   node /var/www/kelete-pos-tenant/backend/scripts/backfillCostAtSale.js buseko
 *   node /var/www/kelete-pos-tenant/backend/scripts/backfillCostAtSale.js all
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { getTenantDb } = require('../config/tenantDb');
const { listTenants } = require('../config/masterDb');

const TARGET_TYPES = ['sale', 'sale_reverse', 'sales_return', 'transit_writeoff'];

function backfillForSlug(slug) {
  const db = getTenantDb(slug);
  if (!db) {
    console.error(`[backfill] tenant "${slug}" not registered â€” skipping`);
    return;
  }

  const before = db.prepare(`
    SELECT COUNT(*) AS n FROM stock_movements
    WHERE cost_at_sale IS NULL
      AND product_sync_id IS NOT NULL
      AND movement_type IN (${TARGET_TYPES.map(() => '?').join(',')})
      AND deleted_at IS NULL
  `).get(...TARGET_TYPES).n;

  if (before === 0) {
    console.log(`[backfill] ${slug}: no rows need cost_at_sale (already backfilled or empty)`);
    return;
  }

  // Single UPDATE using the fallback chain in SQL. Aggregates are dated to
  // the movement's own date so historical rows get history-appropriate WAC.
  const t0 = Date.now();
  const result = db.prepare(`
    UPDATE stock_movements
       SET cost_at_sale = (
         SELECT COALESCE(
           -- 1. Locked dcs snapshot for that (product, date)
           (SELECT dcs.avg_cost_price
              FROM daily_cost_snapshot dcs
             WHERE dcs.product_sync_id = stock_movements.product_sync_id
               AND dcs.date = DATE(stock_movements.created_at)
               AND dcs.deleted_at IS NULL
             LIMIT 1),
           -- 2. Dated GRN + production aggregate (up to and including the movement date)
           (SELECT CASE
             WHEN COALESCE(g.total_qty,0) + COALESCE(pr.total_qty,0) > 0
               THEN (COALESCE(g.total_cost,0) + COALESCE(pr.total_cost,0)) /
                    (COALESCE(g.total_qty,0) + COALESCE(pr.total_qty,0))
             ELSE NULL END
             FROM (SELECT
                     SUM(quantity)    AS total_qty,
                     SUM(total_price) AS total_cost
                   FROM grn_items
                   WHERE product_sync_id = stock_movements.product_sync_id
                     AND date(created_at) <= DATE(stock_movements.created_at)
                     AND deleted_at IS NULL) g,
                  (SELECT
                     SUM(quantity)              AS total_qty,
                     SUM(total_allocated_cost)  AS total_cost
                   FROM production_outputs
                   WHERE product_sync_id = stock_movements.product_sync_id
                     AND date(created_at) <= DATE(stock_movements.created_at)
                     AND deleted_at IS NULL) pr
             LIMIT 1),
           -- 3. Live static cost_price
           (SELECT cost_price FROM products
             WHERE sync_id = stock_movements.product_sync_id LIMIT 1),
           0
         )
       )
     WHERE cost_at_sale IS NULL
       AND product_sync_id IS NOT NULL
       AND movement_type IN (${TARGET_TYPES.map(() => '?').join(',')})
       AND deleted_at IS NULL
  `).run(...TARGET_TYPES);

  const after = db.prepare(`
    SELECT COUNT(*) AS n FROM stock_movements
    WHERE cost_at_sale IS NULL
      AND product_sync_id IS NOT NULL
      AND movement_type IN (${TARGET_TYPES.map(() => '?').join(',')})
      AND deleted_at IS NULL
  `).get(...TARGET_TYPES).n;

  const elapsed = Date.now() - t0;
  console.log(
    `[backfill] ${slug}: cost_at_sale stamped on ${result.changes} row(s), ` +
    `NULL remaining ${after} (was ${before}), ${elapsed}ms`
  );
}

const target = (process.argv[2] || '').toLowerCase();
if (!target) {
  console.error('Usage: node scripts/backfillCostAtSale.js <slug> | all');
  process.exit(1);
}

if (target === 'all') {
  const tenants = listTenants();
  console.log(`[backfill] running on ${tenants.length} tenant(s): ${tenants.map(t => t.slug).join(', ')}`);
  for (const t of tenants) backfillForSlug(t.slug);
} else {
  backfillForSlug(target);
}

console.log('[backfill] done.');
