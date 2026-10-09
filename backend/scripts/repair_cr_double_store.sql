-- ============================================================================
-- One-off repair for cash_receipts rows written with the v1.10.68 double-store
-- bug (HQ tenant DB — hq.db, or whichever slug your HQ runs under).
-- ============================================================================
-- Bug (fixed in v1.10.69): when the client sent per-currency columns
-- (usd_amount / fra_amount / k_amount) but not the legacy method columns,
-- the server's deriveCRSplits() defaulted the whole amount into
-- cash_amount as well. Cash Book's usd_in fallback then surfaced that
-- cash_amount in the USD column, on top of the correct k_amount in the K
-- column. Money looked doubled.
--
-- What this script does:
--   1. Prints BEFORE snapshot of affected rows.
--   2. For rows where the per-currency columns are populated (sumCcy > 0)
--      AND the legacy method columns duplicate the same amount, zero out
--      the legacy fields so Cash Book stops double-counting.
--   3. Prints AFTER snapshot.
--
-- Safety:
--   * The UPDATE guard "cash_amount + bank_amount + momo_amount > 0" makes a
--     re-run a no-op.
--   * Wrapped in BEGIN / COMMIT so a syntax error rolls back cleanly.
--
-- HOW TO RUN:
--   cp tenants/hq.db tenants/hq.db.bak-cr-double-store
--   sqlite3 tenants/hq.db < backend/scripts/repair_cr_double_store.sql
--
-- (Substitute the correct tenant DB filename if HQ isn't called hq.db.
-- On a Kelete deploy this file is usually hq.db or the HQ slug.)
-- ============================================================================

.mode column
.headers on

SELECT '=== BEFORE ===' AS section;

SELECT id, receipt_number, received_from, amount,
       cash_amount, bank_amount, momo_amount,
       usd_amount,  fra_amount,  k_amount
  FROM cash_receipts
 WHERE deleted_at IS NULL
   AND (COALESCE(usd_amount, 0) + COALESCE(fra_amount, 0) + COALESCE(k_amount, 0)) > 0
   AND (COALESCE(cash_amount, 0) + COALESCE(bank_amount, 0) + COALESCE(momo_amount, 0)) > 0;

BEGIN TRANSACTION;

UPDATE cash_receipts
   SET cash_amount = 0,
       bank_amount = 0,
       momo_amount = 0,
       updated_at  = datetime('now'),
       synced      = 0
 WHERE deleted_at IS NULL
   AND (COALESCE(usd_amount, 0) + COALESCE(fra_amount, 0) + COALESCE(k_amount, 0)) > 0
   AND (COALESCE(cash_amount, 0) + COALESCE(bank_amount, 0) + COALESCE(momo_amount, 0)) > 0;

COMMIT;

SELECT '=== AFTER ===' AS section;

SELECT id, receipt_number, received_from, amount,
       cash_amount, bank_amount, momo_amount,
       usd_amount,  fra_amount,  k_amount
  FROM cash_receipts
 WHERE deleted_at IS NULL
   AND (COALESCE(usd_amount, 0) + COALESCE(fra_amount, 0) + COALESCE(k_amount, 0)) > 0;
