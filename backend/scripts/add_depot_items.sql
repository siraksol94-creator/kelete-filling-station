-- Add the items depots hold that HQ never had.
-- 2026-08-31
--
-- Found by comparing ten depot stock sheets against HQ's 70-item catalogue.
-- All 26 are created. 20 carry confirmed prices; the last six are at 0.00 on
-- the user's instruction. A zero-price item is one a till can sell for
-- nothing â€” no guard exists anywhere â€” so those six need pricing before the
-- tills go live. They are listed again at the end of this script's output.
--
-- Run:
--   cd /var/www/kelete-pos-tenant
--   cp backend/kelete.db backend/kelete.db.bak-$(date +%F-items)
--   sqlite3 backend/kelete.db < backend/scripts/add_depot_items.sql
--
-- tenant_id, branch_id, device_id and is_hq_owned are COPIED from an existing
-- product rather than hard-coded: guessing them would create items that look
-- right but sit outside the tenant, and they would sync to nowhere.
--
-- cost_price is 0.00 to match the other 67 items â€” being handled separately.
-- sync_id is a proper UUID v4 so each row syncs to the branches like any other.
-- Re-running is safe: every insert is skipped if the code already exists.

SELECT '--- before ---';
SELECT COUNT(*) AS live_items FROM products WHERE deleted_at IS NULL;

-- One template row, so the new items inherit the same tenancy as the rest.
-- CASTLE 375mls (RS009) is used because it is an ordinary HQ-created item.
CREATE TEMP TABLE _tpl AS
  SELECT tenant_id, branch_id, device_id,
         COALESCE(is_hq_owned, 1) AS is_hq_owned,
         COALESCE(product_type, 'finished') AS product_type,
         COALESCE(min_stock, 10) AS min_stock
    FROM products
   WHERE code = 'RS009' AND deleted_at IS NULL
   LIMIT 1;

-- Fallback if RS009 has gone: take any live product.
INSERT INTO _tpl
  SELECT tenant_id, branch_id, device_id, COALESCE(is_hq_owned,1),
         COALESCE(product_type,'finished'), COALESCE(min_stock,10)
    FROM products WHERE deleted_at IS NULL LIMIT 1;

CREATE TEMP TABLE _new (code TEXT, name TEXT, price REAL);
INSERT INTO _new (code, name, price) VALUES
  ('RS068', 'CB TETRA 500mls X24',        327),
  ('RS069', 'DORITOS 145G',               720),
  ('RS070', 'DORITOS 30G',                240),
  ('RS071', 'KREMA BISCUIT 100G',          96),
  ('RS072', 'BICKIES 100G',                94),
  ('RS073', 'CREAM FEAST 100G',           154),
  ('RS074', 'VANILLA SWIRL',              106),
  ('RS075', 'JOLLY JUICE',                161),
  ('RS076', 'CAPPY PUNCH 300mls CAN',     502),
  ('RS077', 'COKE 1 LTR',                  91),
  ('RS078', 'COKE CAN 500mls',            288),
  ('RS079', 'COKE PET 2 LTRS',            150),
  ('RS080', 'SD 330 CAN',                 383),
  ('RS081', '200MLS DRINK',               383),
  ('RS082', 'MAHEU 250G',                  70),
  ('RS083', 'SIMBA 25G',                  240),
  ('RS084', 'PEPSI PET 750mls X12',       125),
  ('RS085', 'PEPSI PET 750mls X24',       240),
  ('RS086', 'BRUTAL FRUIT LITCHI CANNED', 300),
  ('RS087', 'COKE PET 500mls',            125),
  -- 2026-08-31 â€” the last six, added at 0.00 on the user's instruction after
  -- the risk was raised. NOTHING blocks a zero-price sale: neither routes/
  -- orders.js nor the POS screen checks it, so a till will ring these up FREE
  -- until a price is set. Price them before the tills go live.
  ('RS088', 'PREDATOR 500mls',                0),
  ('RS089', 'ZAM DROP WATER 600mls',          0),
  ('RS090', 'MAZOE RASPBERRY',                0),
  ('RS091', 'GOOD LUCK',                      0),
  ('RS092', 'BIG BOSS',                       0),
  ('RS093', 'FIRST CHOICE',                   0);

INSERT INTO products (
  code, name, unit, default_unit, cost_price, selling_price,
  current_stock, min_stock, product_type, status, is_hq_owned,
  sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
SELECT n.code, n.name, 'Box', 'Box', 0, n.price,
       0, t.min_stock, t.product_type, 'Active', t.is_hq_owned,
       lower(substr(hex(randomblob(4)),1,8) || '-' || substr(hex(randomblob(2)),1,4) || '-4' ||
             substr(hex(randomblob(2)),2,3) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
             substr(hex(randomblob(2)),2,3) || '-' || substr(hex(randomblob(6)),1,12)),
       t.tenant_id, t.branch_id, t.device_id, 0, datetime('now'), datetime('now')
  FROM _new n, (SELECT * FROM _tpl LIMIT 1) t
 WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.code = n.code AND p.deleted_at IS NULL);

SELECT '--- created ---';
SELECT code, name, unit, cost_price AS cost, selling_price AS sell, status
  FROM products WHERE code IN (SELECT code FROM _new) AND deleted_at IS NULL
 ORDER BY code;

SELECT '--- âš  PRICED AT ZERO â€” a till will sell these FREE until priced ---';
SELECT code, name, selling_price FROM products
 WHERE deleted_at IS NULL AND COALESCE(selling_price, 0) = 0 ORDER BY code;

SELECT '--- after ---';
SELECT COUNT(*) AS live_items FROM products WHERE deleted_at IS NULL;

DROP TABLE _new;
DROP TABLE _tpl;
