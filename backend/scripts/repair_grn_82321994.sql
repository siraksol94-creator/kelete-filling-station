-- ============================================================================
-- One-off repair for GRN GRN-2026-82321994 (Lusaka branch — lusaka1.db)
-- ============================================================================
-- Context: v1.10.55–v1.10.65 had a bug in hqGrns.js /generate that posted
-- the raw line qty into stock_movements as base units, ignoring the unit
-- conversion. Fixed in v1.10.66. This script repairs the ONE bad row on
-- BLACK LABEL 375ML at Lusaka.
--
-- Confirmed facts (2026-07-03):
--   * conversion:   1 crate = 24 bottles
--   * line qty:     100 crates delivered
--   * line cost:    $320 / crate (total $32,000)
--   * total spend:  $32,000 for 2400 bottles → $13.3333 / bottle base cost
--   * only this one GRN is affected
--
-- What this script does, in one transaction:
--   1. Bump the stock_movement quantity from 100 → 2400 (base units).
--   2. Rebuild products.current_stock from the sum of stock_movements.
--   3. Reset products.avg_cost_price to $13.3333 (correct per-base cost).
--
-- HOW TO RUN:
--   cp tenants/lusaka1.db tenants/lusaka1.db.bak-before-repair
--   sqlite3 tenants/lusaka1.db < backend/scripts/repair_grn_82321994.sql
--
-- The script prints the before/after values so you can eyeball the change.
-- If the guard fails (wrong_qty != 100) the whole transaction rolls back
-- and nothing is written.
-- ============================================================================

.mode column
.headers on

-- ---------- BEFORE snapshot ----------
SELECT '=== BEFORE ===' AS section;

SELECT sm.id, sm.product_sync_id, sm.quantity AS current_qty, sm.notes
  FROM stock_movements sm
 WHERE sm.reference_type = 'hq_grn'
   AND sm.notes LIKE '%GRN-2026-82321994%'
   AND sm.deleted_at IS NULL;

SELECT p.sync_id, p.name, p.current_stock, p.avg_cost_price
  FROM products p
 WHERE p.sync_id = (SELECT product_sync_id FROM stock_movements
                     WHERE reference_type = 'hq_grn'
                       AND notes LIKE '%GRN-2026-82321994%'
                       AND deleted_at IS NULL
                     LIMIT 1);

-- ---------- Apply repair ----------
BEGIN TRANSACTION;

-- Safety guard: if any row's qty is NOT 100 the update becomes a no-op.
-- (A second run of this script therefore does nothing.)
UPDATE stock_movements
   SET quantity   = 2400,
       notes      = COALESCE(notes, '') || ' [repaired v1.10.66: was 100 bottles, now 2400 = 100 crates × 24]',
       updated_at = datetime('now'),
       synced     = 0
 WHERE reference_type = 'hq_grn'
   AND notes LIKE '%GRN-2026-82321994%'
   AND deleted_at IS NULL
   AND quantity = 100;

-- Rebuild current_stock from ALL non-deleted movements for this product.
UPDATE products
   SET current_stock = COALESCE((
         SELECT SUM(sm.quantity)
           FROM stock_movements sm
          WHERE sm.product_sync_id = products.sync_id
            AND sm.deleted_at IS NULL
       ), 0),
       updated_at = datetime('now'),
       synced     = 0
 WHERE sync_id = (SELECT product_sync_id FROM stock_movements
                   WHERE reference_type = 'hq_grn'
                     AND notes LIKE '%GRN-2026-82321994%'
                     AND deleted_at IS NULL
                   LIMIT 1);

-- Reset avg_cost_price to the correct per-base-unit WAC.
-- $32,000 total spend / 2400 bottles = $13.3333/bottle.
UPDATE products
   SET avg_cost_price = 13.3333,
       updated_at     = datetime('now'),
       synced         = 0
 WHERE sync_id = (SELECT product_sync_id FROM stock_movements
                   WHERE reference_type = 'hq_grn'
                     AND notes LIKE '%GRN-2026-82321994%'
                     AND deleted_at IS NULL
                   LIMIT 1);

COMMIT;

-- ---------- AFTER snapshot ----------
SELECT '=== AFTER ===' AS section;

SELECT sm.id, sm.product_sync_id, sm.quantity AS new_qty, sm.notes
  FROM stock_movements sm
 WHERE sm.reference_type = 'hq_grn'
   AND sm.notes LIKE '%GRN-2026-82321994%'
   AND sm.deleted_at IS NULL;

SELECT p.sync_id, p.name, p.current_stock, p.avg_cost_price
  FROM products p
 WHERE p.sync_id = (SELECT product_sync_id FROM stock_movements
                     WHERE reference_type = 'hq_grn'
                       AND notes LIKE '%GRN-2026-82321994%'
                       AND deleted_at IS NULL
                     LIMIT 1);
