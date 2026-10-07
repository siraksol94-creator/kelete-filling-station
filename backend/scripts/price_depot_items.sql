-- Prices for the items created at 0.00.
-- 2026-08-31
--
-- A zero-priced item is one a till rings up FREE â€” nothing in orders.js or the
-- POS screen blocks it â€” so each of these closes a real hole.
--
-- Run:
--   cd /var/www/kelete-pos-tenant
--   sqlite3 backend/kelete.db < backend/scripts/price_depot_items.sql
--
-- Safe to re-run: each update only touches a row still at 0.00, so a price
-- corrected by hand afterwards is never overwritten.

SELECT '--- before ---';
SELECT code, name, selling_price FROM products
 WHERE deleted_at IS NULL AND COALESCE(selling_price,0) = 0 ORDER BY code;

-- Predator: 391 is the CANNED one on Chipata's sheet (the 350ml is 45), so the
-- name follows the price rather than leaving a mismatch between them.
UPDATE products
   SET selling_price = 391, name = 'PREDATOR CANNED',
       updated_at = datetime('now'), synced = 0
 WHERE code = 'RS088' AND deleted_at IS NULL AND COALESCE(selling_price,0) = 0;

-- Zam Drop: created as 600mls from Petauke's sheet, corrected to 500mls.
UPDATE products
   SET selling_price = 45, name = 'ZAM DROP WATER 500mls',
       updated_at = datetime('now'), synced = 0
 WHERE code = 'RS089' AND deleted_at IS NULL AND COALESCE(selling_price,0) = 0;

UPDATE products
   SET selling_price = 205, updated_at = datetime('now'), synced = 0
 WHERE code = 'RS090' AND deleted_at IS NULL AND COALESCE(selling_price,0) = 0;

SELECT '--- priced now ---';
SELECT code, name, selling_price FROM products
 WHERE code IN ('RS088','RS089','RS090') AND deleted_at IS NULL ORDER BY code;

SELECT '--- still at zero: a till will sell these FREE ---';
SELECT code, name FROM products
 WHERE deleted_at IS NULL AND COALESCE(selling_price,0) = 0 ORDER BY code;
