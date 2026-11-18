// How much has actually been paid against a GRN.
//
// 2026-08-30. A payment is now ONE ap_payments row plus one
// ap_payment_allocations row per GRN it settles, so that paying several
// invoices at once appears as a single payment in the AP list and the Cash
// Book ledger (both list ap_payments row by row).
//
// The sum has to cover two shapes at once:
//
//   1. Allocated payments — every payment written since the change, plus all
//      history, which the migration backfilled into one allocation each.
//   2. Legacy payments with NO allocation row — a row whose sync_id was null
//      so the backfill could not key it, or an install still running an older
//      build and syncing rows in. Counted straight off ap_payments.grn_sync_id.
//
// The second term explicitly excludes any payment that HAS allocations, so a
// backfilled payment is never counted twice. Getting this wrong in either
// direction is a real bug: over-count marks an unpaid GRN settled, under-count
// resurrects a paid one.
//
// Deleted payments are excluded on both sides — allocations have no
// deleted_at of their own and inherit the payment's.
const PAID_FOR_GRN_SQL = `
  SELECT
    (SELECT COALESCE(SUM(a.amount), 0)
       FROM ap_payment_allocations a
       JOIN ap_payments p ON p.sync_id = a.payment_sync_id
      WHERE a.grn_sync_id = ?
        AND (p.deleted_at IS NULL OR p.deleted_at = ''))
    +
    (SELECT COALESCE(SUM(p2.amount), 0)
       FROM ap_payments p2
      WHERE p2.grn_sync_id = ?
        AND (p2.deleted_at IS NULL OR p2.deleted_at = '')
        AND NOT EXISTS (
          SELECT 1 FROM ap_payment_allocations a2
           WHERE a2.payment_sync_id = p2.sync_id))
    AS t
`;

// Prepare once per database handle. Falls back to the pre-allocation query if
// the table is missing, so a branch that has not run the migration yet still
// reports paid amounts instead of showing every GRN as unpaid.
function makePaidStmt(db) {
  try {
    const stmt = db.prepare(PAID_FOR_GRN_SQL);
    return (grnSyncId) => {
      try { return parseFloat(stmt.get(grnSyncId, grnSyncId)?.t || 0) || 0; }
      catch (_) { return 0; }
    };
  } catch (_) {
    const legacy = db.prepare(
      "SELECT COALESCE(SUM(amount), 0) AS t FROM ap_payments " +
      " WHERE grn_sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')"
    );
    return (grnSyncId) => {
      try { return parseFloat(legacy.get(grnSyncId)?.t || 0) || 0; }
      catch (_) { return 0; }
    };
  }
}

module.exports = { PAID_FOR_GRN_SQL, makePaidStmt };
