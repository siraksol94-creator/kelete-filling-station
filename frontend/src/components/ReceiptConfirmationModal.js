// ReceiptConfirmationModal — v1.10.0 branch-side receipt confirmation.
//
// Replaces the v1.9.x "Accept & Generate GRN" full GRN modal at the
// branch. Now branch only:
//   • Confirms received qty per PO line (autofilled with expected)
//   • Adds items not on the PO ("+ Add Item")
//   • Records the supplier invoice # and uploads the invoice photo
//   • v1.13.35 — Attaches Credit Notes (Discount / Damaged / Short /
//     Crate Return / Bottle Return / Goods Return / Other). Moved here
//     from HQ Generate GRN — the branch is who sees the physical goods
//     and knows what was returned.
//   • Submits — HQ will generate the actual GRN downstream.
//
// No supplier dropdown. Branch never sees the GRN itself.

import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import { FiPlus, FiTrash2, FiX, FiInfo } from 'react-icons/fi';
import InvoiceAttachment from './InvoiceAttachment';
import { confirmBranchReceipt } from '../services/api';

// 2026-09-18 — this modal used to carry a Credit Notes block (v1.13.35, itself
// moved here from HQ Generate GRN). It is gone: credits are raised on
// Accounting → Credit Notes, against the invoice, so one page owns them.
//
// It matters beyond tidiness. A note written here stored its lines at the BASE
// price with the note's VAT on the header, while a note written on that page
// stores the value with VAT already in it — the same column meaning two
// different things, which is why the 34 notes raised here between 1 and 10
// Sept never appeared to add up.

const fmtMoney = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function ReceiptConfirmationModal({
  purchase,        // { purchase_number, sync_id, supplier_name, date }
  items,           // [{ sync_id, product_sync_id, product_name, unit, dispatched_qty, cost_price }]
  products,        // local branch products list for the "Add Item" picker (has .category_name)
  branchSlug,      // derived from the host on the parent page (mansa1, etc.)
  onClose,
  onConfirmed,
}) {
  // Per-line received qty (default to expected). Cost + unit come
  // straight from the HQ-authored PO line — read-only here (the branch
  // is a receiver, not a price-setter).
  const [lines, setLines] = useState(() =>
    items.map(it => ({
      sync_id:        it.sync_id,
      product_name:   it.product_name,
      unit:           it.unit,
      expected:       parseFloat(it.dispatched_qty) || 0,
      received:       String(parseFloat(it.dispatched_qty) || 0),
      cost_price:     parseFloat(it.cost_price) || 0,
      // 2026-08-30 — the supplier's own figures, so the branch can tick this
      // table off against the paper invoice, and so a Goods Return can derive
      // its price, discount and VAT instead of asking anyone to retype them.
      product_sync_id: it.product_sync_id,
      base_price:      parseFloat(it.base_price) || 0,
      vat_amount:      parseFloat(it.vat_amount) || 0,
      discount_amount: parseFloat(it.discount_amount) || 0,
      notes:          '',
    }))
  );

  // Extras = items branch received that weren't on the PO.
  const emptyExtra = () => ({
    product_sync_id: '',
    product_name:    '',
    unit:            'pcs',
    quantity:        '',
    cost_price:      '',
  });
  const [extras, setExtras] = useState([]);

  const [invoiceNumber,     setInvoiceNumber]     = useState('');
  const [invoiceAttachment, setInvoiceAttachment] = useState(null);
  const [error,  setError]  = useState('');
  const [saving, setSaving] = useState(false);


  const updateLine  = (i, field, val) => setLines(prev =>
    prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));

  const addExtra    = () => setExtras(prev => [...prev, emptyExtra()]);
  const removeExtra = (i) => setExtras(prev => prev.filter((_, idx) => idx !== i));
  const updateExtra = (i, field, val) => setExtras(prev =>
    prev.map((r, idx) => {
      if (idx !== i) return r;
      const next = { ...r, [field]: val };
      if (field === 'product_sync_id') {
        const m = products.find(p => p.sync_id === val);
        next.product_name = m ? m.name : '';
        if (m) {
          next.unit = m.default_unit || m.unit || 'pcs';
          if (!next.cost_price) next.cost_price = String(m.cost_price || m.avg_cost_price || 0);
        }
      }
      return next;
    }));

  const handleSubmit = async () => {
    setError('');
    if (!invoiceNumber.trim()) return setError('Supplier invoice number is required.');
    // 2026-09-06 — the attachment is no longer demanded here. A depot is
    // confirming on an offloading bay with a driver waiting; photographing
    // the invoice is a job for later, and HQ uploads it at AP confirmation
    // anyway. The number is enough to identify the delivery, and the backend
    // has always accepted a null attachment.

    setSaving(true);
    try {
      const payload = {
        branch_slug: branchSlug,
        lines: lines.map(l => ({
          purchase_item_sync_id: l.sync_id,
          received_qty: Math.max(0, parseFloat(l.received) || 0),
          reason: (parseFloat(l.received) || 0) === l.expected ? 'OK' : 'Short',
          notes:  l.notes || null,
        })),
        extras: extras
          .map(e => ({
            product_sync_id: e.product_sync_id || null,
            product_name:    e.product_name,
            unit:            e.unit || null,
            quantity:        Math.max(0, parseFloat(e.quantity) || 0),
            cost_price:      parseFloat(e.cost_price) || 0,
          }))
          .filter(e => e.product_sync_id && e.quantity > 0),
        supplier_invoice_number: invoiceNumber.trim(),
        invoice_attachment:      invoiceAttachment,
        // 2026-09-18 — always empty now: credits are raised on the Credit Notes
        // page, not here. The field is still sent, and the server still accepts
        // it, so nothing in the confirm chain had to change and an older screen
        // still mid-flight keeps working.
        credit_notes: [],
      };
      await confirmBranchReceipt(purchase.sync_id, payload);
      onConfirmed && onConfirmed();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to submit.');
    } finally {
      setSaving(false);
    }
  };

  return ReactDOM.createPortal((
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 960, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17 }}>Confirm Received from {purchase.purchase_number}</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              Supplier: {purchase.supplier_name || '—'} · PO date: {purchase.date}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}><FiX size={20} /></button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          {/* PO lines — v1.13.36 shows HQ-set cost + line total so the
              branch sees the money it's about to owe before submitting. */}
          {(() => {
            const poSubtotal = lines.reduce((s, l) => s + (parseFloat(l.received) || 0) * (parseFloat(l.cost_price) || 0), 0);
            return (
              <>
                <h4 style={{ margin: '0 0 10px', fontSize: 14 }}>From the PO</h4>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      <th style={{ padding: '8px 10px', textAlign: 'left',  fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Product</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Expected</th>
                      {/* 2026-08-30 — the supplier's own figures, so the branch
                          can tick this table off against the paper in front of
                          them instead of trusting a single derived number. */}
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Base Price</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Total Base</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>VAT</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Discount</th>
                      {/* COST is the only column NOT on the supplier's invoice —
                          it is what the system derived and what stock will be
                          valued at. Coloured so nobody hunts for it on the paper. */}
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#7c3aed', fontWeight: 700, textTransform: 'uppercase' }}>Cost</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Line Total</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, idx) => {
                      const recv = parseFloat(l.received) || 0;
                      const lineTotal = recv * (parseFloat(l.cost_price) || 0);
                      return (
                        <tr key={l.sync_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px 10px' }}>
                            {l.product_name} <span style={{ color: '#9ca3af', fontSize: 11 }}>{l.unit}</span>
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: '#475569' }}>{l.expected}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: '#475569' }}>{fmtMoney(l.base_price)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: '#475569' }}>{fmtMoney(l.expected * (l.base_price || 0))}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: '#475569' }}>{fmtMoney(l.vat_amount)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: '#475569' }}>{fmtMoney(l.discount_amount)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: '#7c3aed', fontWeight: 700, background: '#faf5ff' }}>{fmtMoney(l.cost_price)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#0f172a' }}>{fmtMoney(lineTotal)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                            <input type="number" min="0" step="any" value={l.received}
                              onChange={e => updateLine(idx, 'received', e.target.value)}
                              style={{ width: 100, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, textAlign: 'right' }} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f0f9ff', borderTop: '2px solid #bae6fd' }}>
                      <td colSpan={7} style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#0c4a6e', textTransform: 'uppercase', fontSize: 11, letterSpacing: 0.4 }}>PO subtotal (by received)</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 800, color: '#0c4a6e', fontSize: 14 }}>{fmtMoney(poSubtotal)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </>
            );
          })()}

          {/* Extras */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div>
              <h4 style={{ margin: 0, fontSize: 14 }}>Additional items received</h4>
              <p style={{ margin: '2px 0 0', fontSize: 11, color: '#9ca3af' }}>
                For products the supplier delivered that weren't on this PO. Pick from existing HQ items only.
              </p>
            </div>
            <button type="button" onClick={addExtra}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px dashed #93c5fd', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              <FiPlus size={12} /> Add Item
            </button>
          </div>
          {extras.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 18 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Product</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Qty</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Unit</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Cost</th>
                  <th style={{ padding: '8px 10px' }} />
                </tr>
              </thead>
              <tbody>
                {extras.map((r, idx) => (
                  <tr key={idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '6px 10px' }}>
                      <select value={r.product_sync_id}
                        onChange={e => updateExtra(idx, 'product_sync_id', e.target.value)}
                        style={{ width: '100%', padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box', background: '#fff' }}>
                        <option value="">— pick an HQ item —</option>
                        {products.map(p => (
                          <option key={p.id} value={p.sync_id}>{p.name}</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                      <input type="number" min="0" step="any" value={r.quantity}
                        onChange={e => updateExtra(idx, 'quantity', e.target.value)}
                        style={{ width: 90, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, textAlign: 'right' }} />
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      <input value={r.unit}
                        onChange={e => updateExtra(idx, 'unit', e.target.value)}
                        style={{ width: 70, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
                    </td>
                    <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                      <input type="number" min="0" step="0.01" value={r.cost_price}
                        onChange={e => updateExtra(idx, 'cost_price', e.target.value)}
                        style={{ width: 90, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, textAlign: 'right' }} />
                    </td>
                    <td style={{ padding: '6px 10px' }}>
                      <button onClick={() => removeExtra(idx)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer' }}>
                        <FiTrash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* 2026-09-18 — the Credit Notes block that used to sit here is
              gone. Credits are raised on Accounting -> Credit Notes now,
              against the invoice, so one page owns them and every note is
              written the same way. Notes raised here (1-10 Sept) stored
              their lines at the BASE price with the VAT on the header,
              which is why those 34 never added up on screen. */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start',
                        border: '1px solid #e5e7eb', borderLeft: '4px solid #C8102E',
                        borderRadius: 10, padding: '14px 16px', marginBottom: 18,
                        background: '#fafbfc' }}>
            <FiInfo size={18} style={{ color: '#C8102E', flex: '0 0 auto', marginTop: 1 }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
                Returning goods, or handing in empties?
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 3, lineHeight: 1.5 }}>
                Confirm what actually arrived here, then raise the credit note on
                <strong style={{ color: '#334155' }}> Accounting &rarr; Credit Notes</strong>,
                choosing this supplier invoice. It comes off the payable the same way.
              </div>
            </div>
          </div>

          {/* Supplier invoice */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18 }}>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                Supplier Invoice # <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <input value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)}
                placeholder="e.g. INV-12345"
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                Invoice Attachment <span style={{ color: '#94a3b8', fontWeight: 500 }}>· optional</span>
              </label>
              <InvoiceAttachment value={invoiceAttachment} onChange={setInvoiceAttachment} />
            </div>
          </div>

          {error && (
            <div style={{ background: '#fef2f2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose}
            style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>
            Cancel
          </button>
          <button onClick={handleSubmit} disabled={saving}
            style={{ padding: '10px 28px', background: saving ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
            {saving ? 'Submitting…' : 'Confirm Received'}
          </button>
        </div>
      </div>
    </div>
  ), document.body);
}
