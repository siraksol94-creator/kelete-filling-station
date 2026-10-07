import React from 'react';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';

/**
 * InvoiceNo — 2026-09-03
 *
 * Shows a sale's two identities in the right order of importance.
 *
 * The ZRA receipt (INV{sdc}/{rcptNo}) is the number a customer holds on their
 * paper receipt and the number ZRA's portal knows, so it leads whenever the
 * sale is signed. Our own order number drops to a subtitle — still there, so a
 * cashier can find the order, just not competing for the eye.
 *
 * When the sale is NOT signed, our number is genuinely all that exists. It
 * promotes itself rather than leaving a gap where the fiscal number would sit,
 * and the amber note says why — which doubles as an at-a-glance list of what
 * still needs to reach ZRA.
 *
 * The composite was previously rebuilt by hand in SalesReport (twice) and POS.
 * One place now, so the fallback behaves identically everywhere.
 */
const zraLabel = (order, prefix = 'INV') => {
  if (!order || !order.zra_rcpt_no) return null;
  const sdcSuffix = String(order.zra_sdc_id || '').replace(/^SDC/i, '');
  return `${prefix}${sdcSuffix}/${order.zra_rcpt_no}`;
};

// 2026-09-04 — `size` replaces the old compact flag. A dense twelve-column
// table and a dispatch card want different weights for the same number, and
// "compact" could only ever make it smaller — on the card the ZRA receipt is
// the thing a driver reads off the paper, so it needs to be bigger, not
// smaller. Default 13 keeps every existing table exactly as it was.
const InvoiceNo = ({ order, prefix = 'INV', size = 13, children }) => {
  const zra = zraLabel(order, prefix);
  const own = fmtInvoiceNo(order?.order_number);

  // Signed: ZRA number leads, ours becomes the subtitle.
  if (zra) {
    return (
      <div style={{ lineHeight: 1.25 }}>
        <div style={{ fontFamily: 'monospace', fontSize: size, fontWeight: 700, color: '#0e7490' }}>
          {zra}
        </div>
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 1 }}>
          {own}{children}
        </div>
      </div>
    );
  }

  // A row that never SELECTed zra_rcpt_no is not the same as a sale with no
  // receipt. Saying "awaiting ZRA" for a field we did not ask for is a claim
  // about fiscal state we cannot support — the Dispatch inbox did exactly
  // that on 2026-09-04, for invoices ZRA had already signed. When the field
  // is absent, show the number and assert nothing.
  if (order && !Object.prototype.hasOwnProperty.call(order, 'zra_rcpt_no')) {
    return (
      <div style={{ fontSize: size, fontWeight: 700, color: '#0f172a', lineHeight: 1.25 }}>
        {own}{children}
      </div>
    );
  }

  // Genuinely not signed: our number is the only one there is.
  return (
    <div style={{ lineHeight: 1.25 }}>
      <div style={{ fontSize: size, fontWeight: 700, color: '#0f172a' }}>
        {own}{children}
      </div>
      <div style={{ fontSize: 11, color: '#b45309', marginTop: 1 }}>
        ⏳ awaiting ZRA
      </div>
    </div>
  );
};

export { zraLabel };
export default InvoiceNo;
