// Central helper — converts the internal order-number prefix (ORD-) to
// the tax-invoice prefix (INV-) for any user-facing display or export.
//
// Rationale (v1.13.128d — post-UAT-1 request from Anthony Kabamba, ZRA
// Large Taxpayer Office): the DB continues to store `ORD-...` on
// orders.order_number so no data migration is needed; every display
// site just routes the string through fmtInvoiceNo() at render time.
// Once VSDC signs an invoice, the receipt template already switches to
// the `INV<sdcSuffix>/<rcptNo>` fiscal format — this helper is only for
// pre-VSDC and non-signed display paths (list rows, cross-references,
// modals, exports).
//
// Null-safe: fmtInvoiceNo(null) / undefined / '' return empty string.
export const fmtInvoiceNo = (n) => String(n == null ? '' : n).replace(/^ORD-/, 'INV-');

export default fmtInvoiceNo;
