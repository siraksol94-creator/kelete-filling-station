// services/vatReport.js — the VAT Transaction Report's line builder.
//
// 2026-09-12 — moved here unchanged from routes/orders.js so the depot report
// (GET /orders/vat-report) and HQ's consolidated report (GET /hq/vat-report)
// read the same lines with the same VAT reasoning. Only difference: the
// tenant filter is optional, because HQ opens each depot's own database file
// and every row in it is that depot's.
//
// v1.13.115 — ZRA Ref 9 VAT Transaction Report.
// One row per active (non-reversed) order in [from,to] range, with the 6
// fields ZRA Ref 9 requires: invoice #, date, customer, description of
// goods, value (net of VAT), VAT amount. VAT uses the same MTV-boost
// logic as the receipt (cat B + RRP>0 → max(net_inc, RRP*qty) × 16/116;
// else net_inc × 16/116).

function buildVatLines(db, { tenantId = null, from = null, to = null } = {}) {
  // Fetch orders in date range with their items joined with product ZRA fields.
  // v1.13.128j — Invoice immutability. Prefer the frozen fiscal
  // snapshot on order_items (zra_vat_taxbl_amt, zra_vat_amt) so this
  // report always reflects what the customer received at the time of
  // sale, regardless of later product-master edits or formula changes.
  // Fall back to a live recompute only when the snapshot is NULL
  // (pre-migration rows the backfill couldn't populate).
  let sql = `
    SELECT o.id, o.order_number, o.created_at, o.customer_name,
           oi.product_name, oi.quantity, oi.unit_price, oi.discount,
           oi.zra_rrp_snap, oi.zra_vat_cat_snap, oi.zra_vat_rate,
           oi.zra_vat_taxbl_amt, oi.zra_vat_amt,
           p.zra_vat_cat_cd, p.zra_rrp
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_sync_id = o.sync_id
      LEFT JOIN products p ON p.sync_id = oi.product_sync_id
     WHERE o.deleted_at IS NULL
       AND (o.status IS NULL OR o.status != 'Reversed')
       AND (oi.deleted_at IS NULL)
       AND (oi.reversed IS NULL OR oi.reversed = 0)
  `;
  const params = [];
  if (tenantId != null) { sql += ' AND o.tenant_id = ?'; params.push(tenantId); }
  if (from) { sql += ' AND o.created_at >= ?'; params.push(from); }
  if (to)   { sql += ' AND o.created_at <= ?'; params.push(to); }
  sql += ' ORDER BY o.created_at ASC, o.id ASC';
  const rows = db.prepare(sql).all(...params);

  // v1.13.128k — Emit ONE ROW PER LINE ITEM, not per invoice.
  // Rationale: an invoice with mixed VAT categories (e.g. BEER BOX
  // Cat D + BLACK LABEL Cat B) aggregated to a single row hides the
  // per-line VAT reasoning ZRA auditors want to verify. Line-by-line
  // matches VSDC's saveSales payload structure — one entry per item.
  const zeroRatedCats = new Set(['D', 'C1', 'C2', 'C3', 'E']);
  return rows.map(r => {
    const qty    = parseFloat(r.quantity || 0);
    const prc    = parseFloat(r.unit_price || 0);
    const dcU    = parseFloat(r.discount || 0);
    const netInc = qty * (prc - dcU);

    // Prefer the frozen snapshot on order_items (matches VSDC record
    // for the vat amount). Fall back to live recompute only when
    // snapshot is NULL — that only happens for very old rows the
    // migration backfill couldn't populate.
    //
    // v1.13.143 — VAT Excl now reconciled to Sale Price − VAT to
    // match the customer receipt convention shipped after the ZRA
    // meeting 2026-08-21. VAT amount itself stays RRP-based so it
    // aligns with ZRA's fiscal record.
    let net, vat, cat, rate;
    if (r.zra_vat_taxbl_amt != null && r.zra_vat_amt != null) {
      vat  = parseFloat(r.zra_vat_amt) || 0;
      cat  = String(r.zra_vat_cat_snap || r.zra_vat_cat_cd || 'A').toUpperCase();
      rate = r.zra_vat_rate != null ? Number(r.zra_vat_rate) : (zeroRatedCats.has(cat) ? 0 : 16);
    } else {
      cat  = String(r.zra_vat_cat_cd || 'A').toUpperCase();
      rate = zeroRatedCats.has(cat) ? 0 : 16;
      const rrpU  = parseFloat(r.zra_rrp || 0);
      const boost = (cat === 'B' && rrpU > 0) ? Math.max(netInc, rrpU * qty) : netInc;
      vat = rate > 0 ? boost - boost / (1 + rate / 100) : 0;
    }
    // v1.13.143 — Excl reconciles to receipt: Sale − VAT (uniform
    // across all VAT categories).
    net = netInc - vat;

    return {
      invoice_number: r.order_number,
      date:           r.created_at,
      customer_name:  r.customer_name || 'Walk-in',
      description:    `${r.product_name} × ${qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2)}`,
      vat_category:   cat,
      vat_rate:       rate,
      vat_excl:       Number(net.toFixed(2)),
      vat_amount:     Number(vat.toFixed(2)),
      total_inc:      Number(netInc.toFixed(2)),
    };
  });
}

module.exports = { buildVatLines };
