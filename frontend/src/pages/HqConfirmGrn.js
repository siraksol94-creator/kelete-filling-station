// HqConfirmGrn → v1.10.0 Generate GRN queue (file kept for route stability).
//
// HQ queue of branch-confirmed receipts that are waiting for HQ to generate
// the GRN. Replaces the v1.9.7 "Confirm GRN" review-and-approve flow.
//
// Lifecycle:
//   1. HQ creates PO. Branch sees in Incoming Stock.
//   2. Branch clicks "Confirm Received" → fills qty + invoice + photo →
//      submits via /api/branch/po-receipts/:syncId/confirm.
//   3. PO appears here. HQ clicks "Generate GRN" → reviews + saves →
//      stock posts to branch sales floor, hq_grns row created.

import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiInbox, FiFileText, FiPaperclip } from 'react-icons/fi';
import {
  getAwaitingGeneration, getHqReceipt, generateHqGrn,
} from '../services/api';

const fmtMoney = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// v1.10.2 — invoices are uploaded at the branch subdomain (mansa1.keletezm.com)
// and served from that tenant's uploads dir. HQ (keletezm.com) can't just link
// to the raw path — it has to point back at the branch host. Build the full
// URL from the current hostname + the branch slug so this works in dev too.
function branchUploadUrl(branchSlug, path) {
  if (!path || !branchSlug) return null;
  const currentHost = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
  // If we're already on the branch host (dev), just link locally.
  if (currentHost.startsWith(`${branchSlug}.`)) return `/uploads/${path}`;
  // Strip a leading subdomain off the current host to find the apex, then
  // prepend the branch slug. keletezm.com → mansa1.keletezm.com.
  const parts = currentHost.split('.');
  const apex = parts.length > 2 ? parts.slice(1).join('.') : currentHost;
  const proto = (typeof window !== 'undefined' && window.location.protocol) || 'https:';
  return `${proto}//${branchSlug}.${apex}/uploads/${path}`;
}

export default function HqConfirmGrn() {
  const [purchases, setPurchases] = useState([]);
  const [loading, setLoading]     = useState(false);
  const [toast, setToast]         = useState(null);
  const [generating, setGenerating] = useState(null); // { purchase, items, extras }

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getAwaitingGeneration();
      setPurchases(r.data?.purchases || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, []);

  const openGenerate = async (p) => {
    try {
      const r = await getHqReceipt(p.sync_id);
      setGenerating({
        purchase:      r.data?.purchase       || p,
        items:         r.data?.items          || [],
        extras:        r.data?.extras         || [],
        // v1.13.35 — CN drafts authored by the branch. Read-only at HQ.
        credit_notes:  r.data?.credit_notes   || [],
      });
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load receipt', 'error');
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Generate GRN</h1>
          <p>Branch-submitted receipts waiting for HQ to generate the GRN. Generate → stock posts to branch sales floor + supplier AP locks in.</p>
        </div>
        <button onClick={refresh}
          style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> Refresh
        </button>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 20, zIndex: 999,
          padding: '12px 18px', borderRadius: 8, color: '#fff', fontWeight: 600,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
        }}>{toast.text}</div>
      )}

      {loading && purchases.length === 0 ? (
        <p style={{ color: '#64748b' }}>Loading…</p>
      ) : purchases.length === 0 ? (
        <p style={{ color: '#94a3b8', fontStyle: 'italic' }}><FiInbox /> Nothing waiting for generation.</p>
      ) : (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
          <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: '#f8fafc' }}>
              <tr>
                <th style={th}>PO #</th>
                <th style={th}>Branch</th>
                <th style={th}>Supplier</th>
                <th style={th}>Invoice #</th>
                <th style={th}>Confirmed by Branch</th>
                <th style={{ ...th, textAlign: 'right' }}>Items</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {purchases.map(p => (
                <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={{ ...td, fontFamily: 'monospace' }}>{p.purchase_number}</td>
                  <td style={td}>{p.confirmed_branch_slug || '—'}</td>
                  <td style={td}>{p.supplier_name || '—'}</td>
                  <td style={td}>
                    {p.supplier_invoice_number || '—'}
                    {p.invoice_attachment && (
                      <a href={branchUploadUrl(p.confirmed_branch_slug, p.invoice_attachment)} target="_blank" rel="noopener noreferrer"
                        style={{ marginLeft: 8, color: '#1d4ed8', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                        <FiPaperclip size={11} /> view
                      </a>
                    )}
                  </td>
                  <td style={td}>
                    {p.confirmed_by_branch_name || '—'}
                    {p.confirmed_at_branch && (
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{new Date(p.confirmed_at_branch).toLocaleString()}</div>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {p.reported_count}/{p.items_count}
                    {p.extras_count > 0 && <span style={{ color: '#d97706', marginLeft: 6 }}>+{p.extras_count} extra</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <button onClick={() => openGenerate(p)}
                      style={{ padding: '6px 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <FiFileText size={12} /> Generate GRN
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {generating && (
        <GenerateGrnModal
          purchase={generating.purchase}
          items={generating.items}
          extras={generating.extras}
          creditNotes={generating.credit_notes}
          onClose={() => setGenerating(null)}
          onGenerated={() => {
            setGenerating(null);
            flash('GRN generated. Stock posted to branch sales floor.', 'success');
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ── GRN generation modal (HQ side, minimal v1.10.0) ─────────────────────────
// v1.13.35 — CN authoring lives at the branch. HQ sees the branch-authored
// CN drafts read-only here; they're folded into Final Payable and the
// backend materialises them into hq_supplier_credit_notes on generate.
function GenerateGrnModal({ purchase, items, extras, creditNotes, onClose, onGenerated }) {
  // Pre-fill GRN lines from branch-confirmed PO items + extras. HQ can
  // tweak qty / price; CN tabs are deferred to v1.10.1.
  const [grnLines, setGrnLines] = useState(() => [
    ...items.map(it => ({
      product_sync_id: it.product_sync_id,
      product_name:    it.product_name,
      unit:            it.unit,
      quantity:        String(it.received_qty != null ? it.received_qty : it.dispatched_qty || 0),
      unit_price:      String(it.cost_price || 0),
      // 2026-08-30 — carry the supplier's own figures onto the GRN line, so
      // AP Approvals and the GRN Archive can show WHY the cost is K574.01
      // when the invoice says K504.56. Scaled to what was actually received:
      // VAT and discount are line totals for the full ordered quantity, so a
      // short delivery must carry a proportional share, exactly as a partial
      // return does on a credit note.
      base_price:      it.base_price || 0,
      vat_amount:      (it.dispatched_qty > 0
                        ? (it.vat_amount || 0) / it.dispatched_qty
                          * (it.received_qty != null ? it.received_qty : it.dispatched_qty)
                        : 0),
      discount_amount: (it.dispatched_qty > 0
                        ? (it.discount_amount || 0) / it.dispatched_qty
                          * (it.received_qty != null ? it.received_qty : it.dispatched_qty)
                        : 0),
      expiry_date:     '',
      is_extra:        false,
      po_expected_qty: it.dispatched_qty,
    })),
    ...extras.map(e => ({
      product_sync_id: e.product_sync_id,
      product_name:    e.product_name,
      unit:            e.unit,
      quantity:        String(e.quantity || 0),
      unit_price:      String(e.cost_price || 0),
      // An extra was never on the invoice, so it has no base/VAT/discount.
      base_price:      e.cost_price || 0,
      vat_amount:      0,
      discount_amount: 0,
      expiry_date:     '',
      is_extra:        true,
      po_expected_qty: null,
    })),
  ]);
  const [notes, setNotes]   = useState('');
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);

  // v1.13.35 — CNs are branch-authored (see ReceiptConfirmationModal).
  // The `creditNotes` prop is read-only here; total flows straight into
  // Final Payable. Backend re-reads the drafts on /generate so the
  // client can't tamper with amounts.
  const isStockCn = (reason) => reason === 'Crate Return' || reason === 'Bottle Return' || reason === 'Goods Return';
  const cnAmount = (c) => isStockCn(c.reason)
    // 2026-08-30 — net of each line's discount, plus the note's VAT. This
    // preview used to recompute as qty x unit_value alone, so it showed
    // K66,322.83 for a note the branch had entered as K66,621.54 and the
    // server would book as K66,621.54: HQ approved one figure and got another.
    ? (Array.isArray(c.items)
        ? c.items.reduce((s, it) =>
            s + ((parseFloat(it.quantity) || 0) * (parseFloat(it.unit_value) || 0))
              - (parseFloat(it.discount) || 0), 0) + (Math.abs(parseFloat(c.vat_amount || 0)) || 0)
        : (parseFloat(c.amount) || 0))
    : (Math.abs(parseFloat(c.amount || 0)) || 0);
  const cnList = Array.isArray(creditNotes) ? creditNotes : [];
  const cnTotal = cnList.reduce((s, c) => s + cnAmount(c), 0);

  const updateLine = (i, field, val) => setGrnLines(prev =>
    prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r));

  const total = grnLines.reduce((s, r) =>
    s + (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_price) || 0), 0);
  const finalPayable = Math.max(0, total - cnTotal);

  const handleSave = async () => {
    setError('');
    const valid = grnLines.filter(r => (parseFloat(r.quantity) || 0) > 0);
    if (valid.length === 0) return setError('At least one line must have a quantity.');
    setSaving(true);
    try {
      // v1.13.35 — CNs no longer sent from HQ. The backend loads them
      // from the branch-authored drafts on hq_receipt_credit_notes and
      // materialises them into hq_supplier_credit_notes at generate time.
      await generateHqGrn({
        purchase_sync_id: purchase.sync_id,
        date: new Date().toISOString().slice(0, 10),
        notes: notes || null,
        items: valid.map(r => ({
          product_sync_id: r.product_sync_id,
          product_name:    r.product_name,
          unit:            r.unit,
          quantity:        parseFloat(r.quantity) || 0,
          unit_price:      parseFloat(r.unit_price) || 0,
          expiry_date:     r.expiry_date || null,
          is_extra:        r.is_extra,
          po_expected_qty: r.po_expected_qty,
        })),
      });
      onGenerated && onGenerated();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to generate.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 1000, maxHeight: '92vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 17 }}>Generate GRN from {purchase.purchase_number}</h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
              Supplier: {purchase.supplier_name || '—'} · Invoice #: {purchase.supplier_invoice_number || '—'}
              {purchase.invoice_attachment && (
                <> · <a href={branchUploadUrl(purchase.confirmed_branch_slug, purchase.invoice_attachment)} target="_blank" rel="noopener noreferrer" style={{ color: '#1d4ed8' }}>view invoice</a></>
              )}
            </p>
            <p style={{ margin: '2px 0 0', fontSize: 11, color: '#94a3b8' }}>
              Confirmed by {purchase.confirmed_by_branch_name || '—'} · {purchase.confirmed_at_branch ? new Date(purchase.confirmed_at_branch).toLocaleString() : ''}
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4, fontSize: 20 }}>×</button>
        </div>

        <div style={{ padding: '20px 24px' }}>
          <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                <th style={th}>Product</th>
                <th style={{ ...th, textAlign: 'right' }}>PO Expected</th>
                <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                <th style={th}>Unit</th>
                <th style={{ ...th, textAlign: 'right' }}>Unit Cost</th>
                <th style={{ ...th, textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {grnLines.map((r, idx) => {
                const line = (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_price) || 0);
                return (
                  <tr key={idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      {r.product_name}
                      {r.is_extra && <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e', fontSize: 10, fontWeight: 700 }}>EXTRA</span>}
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: '#94a3b8' }}>{r.po_expected_qty != null ? fmtQty(r.po_expected_qty) : '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <input type="number" min="0" step="any" value={r.quantity}
                        onChange={e => updateLine(idx, 'quantity', e.target.value)}
                        style={{ width: 90, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 5, fontSize: 12, textAlign: 'right' }} />
                    </td>
                    <td style={{ ...td, color: '#475569' }}>{r.unit || '—'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <input type="number" min="0" step="0.01" value={r.unit_price}
                        onChange={e => updateLine(idx, 'unit_price', e.target.value)}
                        style={{ width: 90, padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 5, fontSize: 12, textAlign: 'right' }} />
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>{fmtMoney(line)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f9fafb' }}>
                <td colSpan={5} style={{ ...td, textAlign: 'right', fontWeight: 700 }}>Items subtotal</td>
                <td style={{ ...td, textAlign: 'right', fontWeight: 800, color: '#16a34a' }}>{fmtMoney(total)}</td>
              </tr>
            </tfoot>
          </table>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Notes (optional)</label>
            <input value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Truck #, driver, additional context…"
              style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }} />
          </div>

          {/* v1.13.35 — Credit Notes are branch-authored (in the Receipt
              Confirmation modal at the branch). HQ sees them read-only
              here; the backend re-reads the drafts on /generate. */}
          <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px', marginBottom: 16, background: '#fafbfc' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>Credit Notes (from branch)</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                  Authored by the branch on the Confirm Received screen. Read-only here.
                </div>
              </div>
              {cnList.length > 0 && (
                <div style={{ fontSize: 13, color: '#b45309', fontWeight: 700 }}>
                  Total: −{fmtMoney(cnTotal)}
                </div>
              )}
            </div>
            {cnList.length === 0 ? (
              <div style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic', padding: '6px 0' }}>
                No credit notes attached by the branch.
              </div>
            ) : cnList.map((c, ci) => {
              const stock = isStockCn(c.reason);
              const derivedAmt = cnAmount(c);
              const cnItems = Array.isArray(c.items) ? c.items : [];
              return (
                <div key={ci} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 14px', marginBottom: 8 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
                      <span style={{ padding: '2px 10px', borderRadius: 12, background: '#dbeafe', color: '#1d4ed8', fontSize: 11, fontWeight: 700 }}>{c.reason}</span>
                      {c.notes && <span style={{ fontSize: 12, color: '#475569' }}>{c.notes}</span>}
                      {c.created_by_name && <span style={{ fontSize: 11, color: '#94a3b8' }}>· by {c.created_by_name}</span>}
                    </div>
                    <strong style={{ color: '#b45309', fontSize: 13 }}>−{fmtMoney(derivedAmt)}</strong>
                  </div>
                  {stock && cnItems.length > 0 && (
                    <div style={{ marginTop: 8, padding: '6px 8px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12 }}>
                      {cnItems.map((it, ii) => (
                        <div key={ii} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                          <span>{it.product_name} <span style={{ color: '#94a3b8' }}>· {it.unit || '—'}</span></span>
                          <span>
                            {parseFloat(it.quantity).toLocaleString()} × {fmtMoney(it.unit_value)}
                            {parseFloat(it.discount) > 0 && <> − {fmtMoney(it.discount)}</>} =
                            <strong style={{ marginLeft: 6 }}>
                              {fmtMoney(((parseFloat(it.quantity) || 0) * (parseFloat(it.unit_value) || 0)) - (parseFloat(it.discount) || 0))}
                            </strong>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Final payable summary — highlighted so HQ sees the true net. */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 32, alignItems: 'baseline', marginBottom: 12, padding: '10px 14px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8 }}>
            <div style={{ fontSize: 12, color: '#065f46' }}>
              Items subtotal <strong>{fmtMoney(total)}</strong>
              {cnTotal > 0.001 && <> · CNs <strong>−{fmtMoney(cnTotal)}</strong></>}
            </div>
            <div style={{ fontSize: 15, fontWeight: 800, color: '#065f46' }}>
              Final Payable: {fmtMoney(finalPayable)}
            </div>
          </div>

          {error && (
            <div style={{ background: '#fef2f2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>
              {error}
            </div>
          )}

          <div style={{ fontSize: 11, color: '#065f46', background: '#ecfdf5', border: '1px solid #a7f3d0', padding: '8px 12px', borderRadius: 8, marginBottom: 12 }}>
            On Save: stock posts immediately to <strong>{purchase.confirmed_branch_slug}</strong>'s sales floor. Stock-affecting CNs (Crate/Bottle/Goods Return) also deduct from stock. Supplier AP locks in at the Final Payable amount.
          </div>
        </div>

        <div style={{ padding: '0 24px 20px', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose}
            style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            style={{ padding: '10px 28px', background: saving ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
            {saving ? 'Generating…' : 'Generate GRN'}
          </button>
        </div>
      </div>
    </div>
  );
}

const th = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td = { padding: '8px 12px', color: '#0f172a' };
