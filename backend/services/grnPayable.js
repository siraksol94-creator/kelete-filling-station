// Recompute a GRN's credit total and what is still payable on it.
//
// 2026-08-31. hq_confirmed_grn_totals.cn_total was written ONCE, when the
// branch confirmed receipt, and nothing ever revisited it. That was fine while
// credits could only be raised at Generate GRN — they existed before the
// snapshot did. It stopped being fine the moment a credit could arrive later.
//
// Three paths change what is credited against a GRN, and every one of them has
// to land here or the GRN keeps a payable that disagrees with the ledger:
//
//   attach  — a free credit note applied at check time (routes/hqGrns.js)
//   edit    — the amount changed  (routes/supplierCreditNotes.js)
//   delete  — the credit removed (routes/supplierCreditNotes.js)
//
// The last two were never wired to anything: deleting a K66,322 credit
// corrected the supplier ledger while leaving that GRN still showing a payable
// K66,322 too low, and the GRN would then be underpaid with nothing to flag it.
//
// Recomputes from the credit notes themselves rather than adjusting by a
// delta, so it is correct no matter how it was reached and safe to call twice.
function recomputeGrnPayable(tenantDb, masterDb, grnSyncId) {
  if (!masterDb || !tenantDb || !grnSyncId) return null;
  try {
    const snap = masterDb.prepare(
      'SELECT items_subtotal FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?'
    ).get(grnSyncId);
    if (!snap) return null;                       // not an HQ-tracked GRN

    const cnTotal = tenantDb.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM supplier_credit_notes
        WHERE grn_sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')`
    ).get(grnSyncId)?.t || 0;

    const subtotal = parseFloat(snap.items_subtotal) || 0;
    // Never below zero: a credit worth more than the GRN would otherwise make
    // the supplier look like they owe US on that invoice.
    const payable = Math.max(0, subtotal - (parseFloat(cnTotal) || 0));

    masterDb.prepare(
      'UPDATE hq_confirmed_grn_totals SET cn_total = ?, final_payable = ? WHERE grn_sync_id = ?'
    ).run(cnTotal, payable, grnSyncId);

    return { cn_total: cnTotal, final_payable: payable };
  } catch (e) {
    // Never fail the caller's own write over this — the figure is recomputed
    // again on the next change, and AP reads recompute paid/remaining anyway.
    console.warn('[grnPayable] recompute skipped for', grnSyncId, '-', e.message);
    return null;
  }
}

module.exports = { recomputeGrnPayable };
