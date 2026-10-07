-- Which ZRA-approved purchases predate the base/VAT/discount fields?
-- 2026-08-31 â€” READ ONLY. Nothing is written.
--
-- Purchases approved from the ZRA Purchase Queue before this change stored
-- only prc, so their lines carry base_price = 0 and were costed at BASE
-- rather than base + VAT - discount. That means two things for those rows:
-- the new columns read K0.00 on the GRN and AP screens, and AP is short by
-- the VAT that was never read off the pulled line.
--
-- Run:
--   cd /var/www/kelete-pos-tenant
--   sqlite3 master.db < backend/scripts/check_zra_purchase_invoice_fields.sql
--
-- If it reports nothing, there is nothing to fix and the forward change
-- covers you. If it reports rows, send the output back â€” the figures can be
-- recovered from zra_pending_purchases.raw_json, but the line matching has to
-- be checked case by case: a MAPPED line stores OUR item code, not the
-- supplier's, so it cannot be joined back on itemCd blindly.

SELECT '--- ZRA-approved purchase lines missing the invoice figures ---';
SELECT p.purchase_number,
       p.date,
       p.supplier_name,
       COUNT(i.id)                        AS lines_affected,
       ROUND(SUM(i.line_total), 2)        AS booked_total,
       p.zra_pending_purchase_id          AS pulled_row
  FROM hq_purchase_items i
  JOIN hq_purchases p ON p.sync_id = i.purchase_sync_id
 WHERE p.zra_pending_purchase_id IS NOT NULL
   AND COALESCE(i.base_price, 0) = 0
   AND COALESCE(i.dispatched_qty, 0) > 0
 GROUP BY p.id
 ORDER BY p.date DESC;

SELECT '--- totals ---';
SELECT COUNT(*) AS purchases_affected FROM (
  SELECT p.id
    FROM hq_purchase_items i
    JOIN hq_purchases p ON p.sync_id = i.purchase_sync_id
   WHERE p.zra_pending_purchase_id IS NOT NULL
     AND COALESCE(i.base_price, 0) = 0
     AND COALESCE(i.dispatched_qty, 0) > 0
   GROUP BY p.id
);

-- For contrast: ZRA purchases that already carry the figures (i.e. approved
-- after this change). Both lists empty means the queue has never been used
-- to approve anything.
SELECT '--- ZRA-approved purchases that DO carry them ---';
SELECT p.purchase_number, p.date, COUNT(i.id) AS lines
  FROM hq_purchase_items i
  JOIN hq_purchases p ON p.sync_id = i.purchase_sync_id
 WHERE p.zra_pending_purchase_id IS NOT NULL
   AND COALESCE(i.base_price, 0) > 0
 GROUP BY p.id
 ORDER BY p.date DESC;
