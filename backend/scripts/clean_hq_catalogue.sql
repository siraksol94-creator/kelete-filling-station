-- Tidy HQ's catalogue before depot data entry.
-- 2026-08-31
--
-- Four fixes, all confirmed with the user. Cost prices are NOT touched â€”
-- 67 of 70 items sit at 0.00 and that is being dealt with separately.
--
-- WHY BEFORE THE DEPOT LISTS: every one of these breaks name matching. A
-- depot writing "PEPSI 500" will not match "PESI PET 500mls", and I would be
-- guessing which item they meant â€” which is exactly how one product becomes
-- two.
--
-- Run:
--   cd /var/www/kelete-pos-tenant
--   cp backend/kelete.db backend/kelete.db.bak-$(date +%F-catalogue)
--   sqlite3 backend/kelete.db < backend/scripts/clean_hq_catalogue.sql
--
-- Every change sets synced = 0, so the branches pick it up on the next sync.

SELECT '--- BEFORE ---';
SELECT code, name FROM products
 WHERE deleted_at IS NULL
   AND (name LIKE 'PESI%' OR name LIKE 'AQUACLEAR%' OR name LIKE '%NRB 34mls'
        OR name LIKE 'WATER 18.9%' OR code IN ('T04A-TEST-01','UAT7-002'))
 ORDER BY name;

-- â”€â”€ 1. PESI -> PEPSI (three items) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Six Pepsi products exist; three are misspelled. Fixing the spelling rather
-- than the code, because the code is what everything else joins on.
UPDATE products
   SET name = REPLACE(name, 'PESI ', 'PEPSI '),
       updated_at = datetime('now'), synced = 0
 WHERE deleted_at IS NULL AND name LIKE 'PESI %';

-- Also the stray double space in "PESI PET 2000 mls" -> "2000mls", so the
-- three PET sizes read the same way.
UPDATE products
   SET name = REPLACE(name, '2000 mls', '2000mls'),
       updated_at = datetime('now'), synced = 0
 WHERE deleted_at IS NULL AND name LIKE '%2000 mls%';

-- â”€â”€ 2. AQUACLEAR -> AQUA CLEAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Two spellings of one brand: AQUA CLEAR 500/1000mls, but AQUACLEAR PET 750ML.
UPDATE products
   SET name = REPLACE(name, 'AQUACLEAR', 'AQUA CLEAR'),
       updated_at = datetime('now'), synced = 0
 WHERE deleted_at IS NULL AND name LIKE 'AQUACLEAR%';

-- â”€â”€ 3. Two sizes that cannot be right â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- 34ml is a thimble; the NRB is a 340ml bottle.
UPDATE products
   SET name = REPLACE(name, 'NRB 34mls', 'NRB 340mls'),
       updated_at = datetime('now'), synced = 0
 WHERE deleted_at IS NULL AND name LIKE '%NRB 34mls%';

-- 18.9 mls would be a teaspoon; it is the 18.9 LITRE water bottle, matching
-- CONTAINER 18.9.
UPDATE products
   SET name = 'WATER 18.9 L',
       updated_at = datetime('now'), synced = 0
 WHERE deleted_at IS NULL AND name = 'WATER 18.9 mls';

-- â”€â”€ 4. Retire the two UAT test items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Soft delete, exactly as routes/products.js does: the row stays so any
-- history that references it still resolves, it just stops being sellable and
-- stops appearing in pickers. A hard delete would orphan those references.
-- 2026-08-31 â€” SFT001 FANTA joins them: confirmed a test item. Its K400 price
-- sat oddly beside COKE RGB 300mls at K115.50, and depots count Fanta inside
-- the combined Coke/Fanta/Sprite line rather than on its own.
UPDATE products
   SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
 WHERE deleted_at IS NULL AND code IN ('T04A-TEST-01', 'UAT7-002', 'SFT001');

SELECT '--- AFTER ---';
SELECT code, name FROM products
 WHERE deleted_at IS NULL
   AND (name LIKE 'PEPSI%' OR name LIKE 'AQUA CLEAR%' OR name LIKE '%NRB 340mls'
        OR name LIKE 'WATER 18.9%')
 ORDER BY name;

SELECT '--- retired (should list the three test items) ---';
SELECT code, name, deleted_at FROM products WHERE code IN ('T04A-TEST-01','UAT7-002','SFT001');

SELECT '--- live item count ---';
SELECT COUNT(*) AS live_items FROM products WHERE deleted_at IS NULL;
