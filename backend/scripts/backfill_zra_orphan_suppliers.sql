-- Backfill: link ZRA-pulled purchases to local suppliers
-- 2026-08-30
--
-- WHY THESE ROWS ARE ORPHANS
--   A purchase pulled from ZRA carried only the supplier's TPIN and their
--   registered name; routes/zra.js wrote supplier_id as NULL. hqGrns.js links
--   a GRN's supplier by exact name match against the local suppliers table,
--   found nothing, and the row reached AP Approvals showing a supplier name
--   with no ledger link behind it.
--
--   Approvals from now on resolve the supplier automatically. This script is
--   only for rows created BEFORE that change.
--
-- HOW TO RUN (on the VPS)
--   cd /var/www/kelete-pos-tenant          # confirm the path first
--   sqlite3 backend/kelete.db < backend/scripts/backfill_zra_orphan_suppliers.sql
--
--   suppliers live in backend/kelete.db (HQ's list â€” the one hqGrns.js reads
--   via defaultDb), while hq_* live in master.db, so the script ATTACHes the
--   second database. Adjust the ATTACH path if MASTER_DB_PATH is set.
--
--   ALWAYS back up first:
--     cp backend/kelete.db backend/kelete.db.bak-$(date +%F)
--     cp master.db master.db.bak-$(date +%F)
--
-- SAFETY
--   Only touches rows whose supplier link is MISSING. Re-running changes
--   nothing. Nothing is deleted. Amounts are never modified.

ATTACH DATABASE 'master.db' AS m;

-- â”€â”€ STEP 1 â€” see what is actually orphaned â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Run the script once with the UPDATEs commented out if you want to look
-- before touching anything. This SELECT prints regardless.
SELECT '--- orphaned AP rows, by supplier ---';
SELECT supplier_name         AS supplier,
       COUNT(*)              AS rows_affected,
       ROUND(SUM(final_payable), 2) AS total_payable
  FROM m.hq_confirmed_grn_totals
 WHERE (supplier_sync_id IS NULL OR supplier_sync_id = '')
 GROUP BY supplier_name
 ORDER BY total_payable DESC;

-- â”€â”€ STEP 2 â€” make sure the two suppliers exist locally â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Inserted only if absent, matched case-insensitively so a differently-cased
-- existing row is reused rather than duplicated. sync_id is a proper UUID v4;
-- synced = 0 so the row travels to the branches on the next sync.
INSERT INTO suppliers (name, type, status, sync_id, synced, created_at, updated_at)
SELECT 'RED SEA IMPORT AND EXPORT ZAMBIA LIMITED', 'Supplier', 'Active',
       lower(substr(hex(randomblob(4)),1,8) || '-' || substr(hex(randomblob(2)),1,4) || '-4' ||
             substr(hex(randomblob(2)),2,3) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
             substr(hex(randomblob(2)),2,3) || '-' || substr(hex(randomblob(6)),1,12)),
       0, datetime('now'), datetime('now')
 WHERE NOT EXISTS (
   SELECT 1 FROM suppliers
    WHERE LOWER(name) = LOWER('RED SEA IMPORT AND EXPORT ZAMBIA LIMITED')
      AND (deleted_at IS NULL OR deleted_at = ''));

INSERT INTO suppliers (name, type, status, sync_id, synced, created_at, updated_at)
SELECT 'CHAMBISHI METALS PLC', 'Supplier', 'Active',
       lower(substr(hex(randomblob(4)),1,8) || '-' || substr(hex(randomblob(2)),1,4) || '-4' ||
             substr(hex(randomblob(2)),2,3) || '-' || substr('89ab', abs(random()) % 4 + 1, 1) ||
             substr(hex(randomblob(2)),2,3) || '-' || substr(hex(randomblob(6)),1,12)),
       0, datetime('now'), datetime('now')
 WHERE NOT EXISTS (
   SELECT 1 FROM suppliers
    WHERE LOWER(name) = LOWER('CHAMBISHI METALS PLC')
      AND (deleted_at IS NULL OR deleted_at = ''));

-- â”€â”€ STEP 3 â€” link the AP snapshot rows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- This is the table AP Approvals and the supplier ledger read, so it is the
-- one that clears the orphan.
UPDATE m.hq_confirmed_grn_totals
   SET supplier_sync_id = (SELECT s.sync_id FROM main.suppliers s
                            WHERE LOWER(s.name) = LOWER(m.hq_confirmed_grn_totals.supplier_name)
                              AND (s.deleted_at IS NULL OR s.deleted_at = '') LIMIT 1),
       supplier_id      = (SELECT s.id      FROM main.suppliers s
                            WHERE LOWER(s.name) = LOWER(m.hq_confirmed_grn_totals.supplier_name)
                              AND (s.deleted_at IS NULL OR s.deleted_at = '') LIMIT 1)
 WHERE (supplier_sync_id IS NULL OR supplier_sync_id = '')
   AND supplier_name IS NOT NULL
   AND EXISTS (SELECT 1 FROM main.suppliers s
                WHERE LOWER(s.name) = LOWER(m.hq_confirmed_grn_totals.supplier_name)
                  AND (s.deleted_at IS NULL OR s.deleted_at = ''));

-- â”€â”€ STEP 3b â€” link the GRN rows themselves â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- 2026-08-30, added after the first live run.
--
-- Step 3 cleared AP Approvals, but Account Payables still showed these
-- suppliers with 0 GRNs and K0. The two pages read DIFFERENT tables:
-- AP Approvals reads m.hq_confirmed_grn_totals, while Account Payables sums
-- the local `grn` table grouped by supplier_sync_id (routes/accountPayables.js).
-- The pulled GRNs sat there with a supplier_name and a NULL supplier_sync_id,
-- so they grouped under nothing and the supplier looked like it had never
-- traded. This is the table that puts the balance on the ledger.
UPDATE grn
   SET supplier_sync_id = (SELECT s.sync_id FROM suppliers s
                            WHERE LOWER(s.name) = LOWER(grn.supplier_name)
                              AND (s.deleted_at IS NULL OR s.deleted_at = '') LIMIT 1),
       supplier_id      = COALESCE(supplier_id,
                          (SELECT s.id FROM suppliers s
                            WHERE LOWER(s.name) = LOWER(grn.supplier_name)
                              AND (s.deleted_at IS NULL OR s.deleted_at = '') LIMIT 1))
 WHERE (supplier_sync_id IS NULL OR supplier_sync_id = '')
   AND (deleted_at IS NULL OR deleted_at = '')
   AND supplier_name IS NOT NULL
   AND EXISTS (SELECT 1 FROM suppliers s
                WHERE LOWER(s.name) = LOWER(grn.supplier_name)
                  AND (s.deleted_at IS NULL OR s.deleted_at = ''));

-- â”€â”€ STEP 3c â€” link the PAYMENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- 2026-08-30, added after the second live run.
--
-- HQ Suppliers showed CHAMBISHI as fully paid while Account Payables showed
-- K0 paid against the same supplier. Neither is buggy â€” they match
-- differently. HQ Suppliers falls back to the name:
--     WHERE supplier_id = ? OR LOWER(supplier_name) = LOWER(?)
-- while Account Payables joins strictly on supplier_sync_id. The payments
-- were recorded with a name and no sync_id, so one page found them and the
-- other did not. Linking them makes the two agree.
UPDATE ap_payments
   SET supplier_sync_id = (SELECT s.sync_id FROM suppliers s
                            WHERE LOWER(s.name) = LOWER(ap_payments.supplier_name)
                              AND (s.deleted_at IS NULL OR s.deleted_at = '') LIMIT 1),
       supplier_id      = COALESCE(supplier_id,
                          (SELECT s.id FROM suppliers s
                            WHERE LOWER(s.name) = LOWER(ap_payments.supplier_name)
                              AND (s.deleted_at IS NULL OR s.deleted_at = '') LIMIT 1))
 WHERE (supplier_sync_id IS NULL OR supplier_sync_id = '')
   AND (deleted_at IS NULL OR deleted_at = '')
   AND supplier_name IS NOT NULL
   AND EXISTS (SELECT 1 FROM suppliers s
                WHERE LOWER(s.name) = LOWER(ap_payments.supplier_name)
                  AND (s.deleted_at IS NULL OR s.deleted_at = ''));

-- Credit notes are joined the same way by Account Payables. They carry no
-- supplier_name column, so they can only be recovered through supplier_id.
UPDATE supplier_credit_notes
   SET supplier_sync_id = (SELECT s.sync_id FROM suppliers s
                            WHERE s.id = supplier_credit_notes.supplier_id
                              AND (s.deleted_at IS NULL OR s.deleted_at = '') LIMIT 1)
 WHERE (supplier_sync_id IS NULL OR supplier_sync_id = '')
   AND (deleted_at IS NULL OR deleted_at = '')
   AND supplier_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM suppliers s WHERE s.id = supplier_credit_notes.supplier_id);

-- â”€â”€ STEP 4 â€” link the GRN archive rows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- hq_grns has supplier_id but no supplier_sync_id (see hqGrns.js:1099).
UPDATE m.hq_grns
   SET supplier_id = (SELECT s.id FROM main.suppliers s
                       WHERE LOWER(s.name) = LOWER(m.hq_grns.supplier_name)
                         AND (s.deleted_at IS NULL OR s.deleted_at = '') LIMIT 1)
 WHERE (supplier_id IS NULL OR supplier_id = 0)
   AND supplier_name IS NOT NULL
   AND EXISTS (SELECT 1 FROM main.suppliers s
                WHERE LOWER(s.name) = LOWER(m.hq_grns.supplier_name)
                  AND (s.deleted_at IS NULL OR s.deleted_at = ''));

-- â”€â”€ STEP 5 â€” link the purchases themselves â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- So a re-generated GRN inherits the supplier instead of orphaning again.
UPDATE m.hq_purchases
   SET supplier_id = (SELECT s.id FROM main.suppliers s
                       WHERE LOWER(s.name) = LOWER(m.hq_purchases.supplier_name)
                         AND (s.deleted_at IS NULL OR s.deleted_at = '') LIMIT 1)
 WHERE (supplier_id IS NULL OR supplier_id = 0)
   AND supplier_name IS NOT NULL
   AND EXISTS (SELECT 1 FROM main.suppliers s
                WHERE LOWER(s.name) = LOWER(m.hq_purchases.supplier_name)
                  AND (s.deleted_at IS NULL OR s.deleted_at = ''));

-- â”€â”€ STEP 6 â€” remember the mapping, so future pulls skip all of this â”€â”€â”€â”€â”€â”€
-- Keyed on the TPIN carried by the pulled purchase. Only fills TPINs that are
-- actually present on a pulled row, and never overwrites an existing mapping.
INSERT OR IGNORE INTO zra_supplier_map (spplr_tpin, spplr_nm, action, supplier_id, supplier_sync_id, supplier_name)
SELECT DISTINCT p.zra_spplr_tpin, p.supplier_name, 'MAP', s.id, s.sync_id, s.name
  FROM m.hq_purchases p
  JOIN main.suppliers s
    ON LOWER(s.name) = LOWER(p.supplier_name)
   AND (s.deleted_at IS NULL OR s.deleted_at = '')
 WHERE p.zra_spplr_tpin IS NOT NULL AND p.zra_spplr_tpin <> '';

-- Stamp the TPIN onto the supplier record too, so the stronger TPIN match
-- wins later even if the supplier renames itself at ZRA.
UPDATE suppliers
   SET tpin = (SELECT p.zra_spplr_tpin FROM m.hq_purchases p
                WHERE LOWER(p.supplier_name) = LOWER(suppliers.name)
                  AND p.zra_spplr_tpin IS NOT NULL AND p.zra_spplr_tpin <> ''
                LIMIT 1)
 WHERE (tpin IS NULL OR tpin = '')
   AND EXISTS (SELECT 1 FROM m.hq_purchases p
                WHERE LOWER(p.supplier_name) = LOWER(suppliers.name)
                  AND p.zra_spplr_tpin IS NOT NULL AND p.zra_spplr_tpin <> '');

-- â”€â”€ STEP 7 â€” confirm â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
SELECT '--- remaining orphans (should be empty, or only names with no supplier) ---';
SELECT supplier_name, COUNT(*) AS still_orphaned
  FROM m.hq_confirmed_grn_totals
 WHERE (supplier_sync_id IS NULL OR supplier_sync_id = '')
 GROUP BY supplier_name;

SELECT '--- GRN rows still unlinked (drives Account Payables) ---';
SELECT supplier_name, COUNT(*) AS still_unlinked
  FROM grn
 WHERE (supplier_sync_id IS NULL OR supplier_sync_id = '')
   AND (deleted_at IS NULL OR deleted_at = '')
 GROUP BY supplier_name;

SELECT '--- every supplier, as now linked ---';
SELECT s.id, s.name, s.tpin,
       (SELECT COUNT(*) FROM m.hq_confirmed_grn_totals t WHERE t.supplier_sync_id = s.sync_id) AS ap_rows,
       (SELECT COUNT(*) FROM grn g WHERE g.supplier_sync_id = s.sync_id
         AND (g.deleted_at IS NULL OR g.deleted_at = '')) AS grn_rows,
       (SELECT ROUND(COALESCE(SUM(g.total_amount), 0), 2) FROM grn g WHERE g.supplier_sync_id = s.sync_id
         AND (g.deleted_at IS NULL OR g.deleted_at = '')) AS grn_value,
       (SELECT ROUND(COALESCE(SUM(a.amount), 0), 2) FROM ap_payments a WHERE a.supplier_sync_id = s.sync_id
         AND (a.deleted_at IS NULL OR a.deleted_at = '')) AS paid
  FROM suppliers s
 WHERE (s.deleted_at IS NULL OR s.deleted_at = '')
 ORDER BY grn_value DESC;

DETACH DATABASE m;
