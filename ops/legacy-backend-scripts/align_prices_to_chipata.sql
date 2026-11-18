-- Align HQ selling prices to Chipata's, for the 13 that disagreed.
-- 2026-08-31
--
-- Chipata is the ONLY depot of the ten that sent prices. Confirmed with the
-- user that Chipata's figure wins. That makes Chipata's price the group
-- standard for every branch, so if another depot has been selling FLYING FISH
-- NRB at 470 they are now K120 under until they say otherwise.
--
-- THE GUARD, and why it is here: the HQ column below was read off a catalogue
-- dump pasted into chat, not out of this database at the time of writing. So
-- every UPDATE is conditional on the row still holding the price I recorded.
-- If it does not, the row is SKIPPED and printed under "NOT CHANGED" instead
-- of being silently overwritten with a figure derived from a stale reading.
-- Check that section: an entry there means my note disagreed with reality and
-- that item needs deciding by hand.
--
-- Run:
--   cd /var/www/kelete-pos-tenant
--   cp backend/kelete.db backend/kelete.db.bak-$(date +%F-prices)
--   sqlite3 backend/kelete.db < backend/scripts/align_prices_to_chipata.sql
--
-- Safe to re-run: once a row holds the new price it no longer matches the old
-- one, so a second run changes nothing and reports it as already done.
-- Sets synced = 0 so the branches pick the prices up on the next sync.

CREATE TEMP TABLE _px (code TEXT, was REAL, now_ REAL);
INSERT INTO _px (code, was, now_) VALUES
  ('RS018', 470.00, 350.00),   -- FLYING FISH NRB
  ('RS007', 490.00, 370.00),   -- BLACK LABEL NRB 340mls
  ('RS024', 665.00, 770.00),   -- CORONA
  ('RS013', 480.00, 520.00),   -- CASTLE LITE NRB
  ('RS004', 240.00, 280.00),   -- MOSI LIGHT
  ('RS045', 780.00, 768.00),   -- SIMBA 120g
  ('RS028',  70.00,  80.00),   -- SCOLL X6
  ('RS050', 172.00, 177.00),   -- CB UHT MILK PLUS 500mls X12
  ('RS052', 240.00, 242.00),   -- CB MILK POUCH 225mls X 40
  ('RS051', 236.00, 238.00),   -- CB MILK POUCH 475mls X 20
  ('RS060', 115.00, 117.00),   -- CB MILK MAHUE 500
  ('RS026', 125.00, 126.00),   -- SOFT DRINK 500mls
  ('RS055', 115.50, 116.00);   -- COKE RGB 300mls

SELECT '--- BEFORE: what HQ actually holds right now ---';
SELECT p.code, p.name, p.selling_price AS hq_now, x.was AS i_expected, x.now_ AS chipata,
       CASE WHEN ABS(COALESCE(p.selling_price,0) - x.was) < 0.005 THEN 'ok'
            WHEN ABS(COALESCE(p.selling_price,0) - x.now_) < 0.005 THEN 'already done'
            ELSE '*** DISAGREES ***' END AS note
  FROM _px x LEFT JOIN products p ON p.code = x.code AND p.deleted_at IS NULL
 ORDER BY x.code;

UPDATE products
   SET selling_price = (SELECT now_ FROM _px WHERE _px.code = products.code),
       updated_at = datetime('now'), synced = 0
 WHERE deleted_at IS NULL
   AND code IN (SELECT code FROM _px)
   AND ABS(COALESCE(selling_price, 0) -
           (SELECT was FROM _px WHERE _px.code = products.code)) < 0.005;

SELECT '--- CHANGED ---';
SELECT p.code, p.name, x.was AS from_, p.selling_price AS to_
  FROM _px x JOIN products p ON p.code = x.code AND p.deleted_at IS NULL
 WHERE ABS(COALESCE(p.selling_price,0) - x.now_) < 0.005
 ORDER BY x.code;

SELECT '--- NOT CHANGED — decide these by hand ---';
SELECT x.code, COALESCE(p.name,'(no such live item)') AS name,
       p.selling_price AS hq_now, x.was AS i_expected, x.now_ AS chipata
  FROM _px x LEFT JOIN products p ON p.code = x.code AND p.deleted_at IS NULL
 WHERE p.code IS NULL OR ABS(COALESCE(p.selling_price,0) - x.now_) >= 0.005
 ORDER BY x.code;

SELECT '--- still at zero: a till will sell these FREE ---';
SELECT code, name, selling_price FROM products
 WHERE deleted_at IS NULL AND COALESCE(selling_price, 0) = 0 ORDER BY code;

DROP TABLE _px;
