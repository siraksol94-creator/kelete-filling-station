-- What an "opening balance" actually looks like in this database.
-- 2026-08-31
--
-- Written because the Opening Balance page read 0 for AQUA CLEAR 500mls while
-- Item Details showed 1,000. Two different conventions exist in the codebase
-- and the page was reading the wrong one:
--
--   legacy  location='store'  movement_type='opening'
--   current location='sales'  movement_type='adjustment'
--                             reference_type='opening_balance'   <- the marker
--
-- routes/products.js (the Item Details PUT) writes the second and voids BOTH
-- on every save, backdating to 2026-06-29 so the Bin Card shows it in the
-- Opening Balance pill rather than mid-timeline.
--
-- Run against the BRANCH database, not HQ's:
--   cd /var/www/kelete-pos-tenant
--   sqlite3 tenants/buseko.db < backend/scripts/inspect_opening_rows.sql

SELECT '--- AQUA CLEAR 500mls (RS041): every movement ---';
SELECT sm.id, sm.created_at, sm.location, sm.movement_type,
       sm.reference_type, sm.quantity, sm.notes,
       CASE WHEN sm.deleted_at IS NULL THEN 'live' ELSE 'voided' END AS state
  FROM stock_movements sm
  JOIN products p ON p.sync_id = sm.product_sync_id
 WHERE p.code = 'RS041'
 ORDER BY sm.id;

SELECT '--- what each convention would report for RS041 ---';
SELECT 'store/opening (what the page read)' AS convention,
       COALESCE(SUM(sm.quantity), 0) AS qty
  FROM stock_movements sm JOIN products p ON p.sync_id = sm.product_sync_id
 WHERE p.code = 'RS041' AND sm.deleted_at IS NULL
   AND sm.movement_type = 'opening' AND sm.location = 'store'
UNION ALL
SELECT 'reference_type=opening_balance (the real one)',
       COALESCE(SUM(sm.quantity), 0)
  FROM stock_movements sm JOIN products p ON p.sync_id = sm.product_sync_id
 WHERE p.code = 'RS041' AND sm.deleted_at IS NULL
   AND sm.reference_type = 'opening_balance'
UNION ALL
SELECT 'products.current_stock cache',
       COALESCE(current_stock, 0) FROM products WHERE code = 'RS041';

SELECT '--- how the whole branch splits between the two conventions ---';
SELECT CASE
         WHEN reference_type = 'opening_balance' THEN 'sales/adjustment + opening_balance'
         ELSE 'store/opening (legacy)'
       END AS convention,
       COUNT(*) AS rows_, COUNT(DISTINCT product_sync_id) AS products
  FROM stock_movements
 WHERE deleted_at IS NULL
   AND (reference_type = 'opening_balance'
        OR (movement_type = 'opening' AND location = 'store'))
 GROUP BY 1;

SELECT '--- tenant_id on those rows must match the products tenant_id ---';
SELECT DISTINCT 'movement' AS src, tenant_id FROM stock_movements
 WHERE deleted_at IS NULL AND reference_type = 'opening_balance'
UNION ALL
SELECT DISTINCT 'product', tenant_id FROM products WHERE deleted_at IS NULL;
