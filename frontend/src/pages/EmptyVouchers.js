// EmptyVouchers — v1.13.67
//
// Controller station: record how many empties a person handed in and issue
// a bearer voucher (physical slip) they redeem at POS later. Anyone can
// return — no customer registration required. Sales Report + Cash Book
// stay untouched (empties are stock, not money).
//
// Voucher lifecycle:
//   ACTIVE → CLAIMED (fully redeemed at POS)
//   ACTIVE → VOID    (admin void, e.g. lost slip)
// Partial redemption is supported: qty_remaining drops per claim; status
// flips to CLAIMED only when it hits 0.

import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiPackage, FiPlus, FiX, FiSearch, FiPrinter } from 'react-icons/fi';
import { getProducts } from '../services/api';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';
import { useAuth } from '../context/AuthContext';
import {
  listEmptyVouchers, getEmptyVoucher, createEmptyVoucher, voidEmptyVoucher,
} from '../services/api';

const STATUS_META = {
  ACTIVE:  { label: 'Active',  bg: '#dcfce7', color: '#166534', border: '#86efac' },
  CLAIMED: { label: 'Claimed', bg: '#dbeafe', color: '#1d4ed8', border: '#93c5fd' },
  VOID:    { label: 'Void',    bg: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
};

const fmtDate = (s) => s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

export default function EmptyVouchers() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Administrator' || user?.role === 'Admin';

  const [statusFilter, setStatusFilter] = useState('ACTIVE');
  const [query, setQuery]     = useState('');
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast]     = useState(null);
  const [issueModal, setIssueModal] = useState(null);  // { qty, name, phone, notes, saving, error, slipText, voucher }
  const [detail, setDetail]         = useState(null);  // { voucher, claims }
  const [voidModal, setVoidModal]   = useState(null);  // { voucher, reason, saving, error }
  // 2026-08-30 — the empties you can hand in. Same Crates category the GRN
  // credit-note picker uses, so the two agree on what counts as an empty.
  const [crateProducts, setCrateProducts] = useState([]);
  useEffect(() => {
    let alive = true;
    getProducts()
      .then(({ data }) => {
        const all = Array.isArray(data) ? data : (data?.products || []);
        if (alive) setCrateProducts(all.filter(p => (p.category_name || '').toLowerCase() === 'crates'));
      })
      .catch(() => { /* picker just stays empty; the form explains why */ });
    return () => { alive = false; };
  }, []);

  const flash = (text, type = 'ok') => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'err' ? 5000 : 2800);
  };

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await listEmptyVouchers({
        status: statusFilter || undefined,
        q: query.trim() || undefined,
        limit: 300,
      });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      flash(e?.response?.data?.error || e.message, 'err');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter]);
  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line
  }, [query]);

  // ── Issue ──────────────────────────────────────────────────────
  const openIssue = () => setIssueModal({ qty: '', product_sync_id: '', name: '', phone: '', notes: '', saving: false, error: null, slipText: null, voucher: null });

  const submitIssue = async () => {
    const q = parseInt(issueModal.qty, 10) || 0;
    if (!(q > 0)) { setIssueModal(m => ({ ...m, error: 'Qty must be > 0.' })); return; }
    if (!issueModal.product_sync_id) {
      setIssueModal(m => ({ ...m, error: 'Pick which empty was returned.' })); return;
    }
    setIssueModal(m => ({ ...m, saving: true, error: null }));
    try {
      const { data } = await createEmptyVoucher({
        qty: q,
        product_sync_id: issueModal.product_sync_id,
        issued_to_name: issueModal.name || null,
        issued_to_phone: issueModal.phone || null,
        notes: issueModal.notes || null,
      });
      setIssueModal(m => ({ ...m, saving: false, voucher: data.voucher, slipText: data.slip_text }));
      flash(`Voucher ${data.voucher.voucher_number} issued.`);
      load();
    } catch (e) {
      setIssueModal(m => ({ ...m, saving: false, error: e?.response?.data?.error || e.message }));
    }
  };

  const printSlip = (text) => {
    const w = window.open('', '', 'width=400,height=600');
    if (!w) return;
    w.document.write(`<pre style="font-family: 'Courier New', monospace; font-size: 12px; padding: 8px;">${text.replace(/</g, '&lt;')}</pre>`);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 100);
  };

  // ── Detail ────────────────────────────────────────────────────
  const openDetail = async (row) => {
    try {
      const { data } = await getEmptyVoucher(row.voucher_number);
      setDetail(data);
    } catch (e) {
      flash(e?.response?.data?.error || e.message, 'err');
    }
  };

  // ── Void ──────────────────────────────────────────────────────
  const openVoid = (voucher) => setVoidModal({ voucher, reason: '', saving: false, error: null });

  const submitVoid = async () => {
    const reason = voidModal.reason.trim();
    if (!reason) { setVoidModal(m => ({ ...m, error: 'Reason is required.' })); return; }
    setVoidModal(m => ({ ...m, saving: true, error: null }));
    try {
      await voidEmptyVoucher(voidModal.voucher.id, reason);
      flash(`Voucher ${voidModal.voucher.voucher_number} voided.`);
      setVoidModal(null);
      setDetail(null);
      load();
    } catch (e) {
      setVoidModal(m => ({ ...m, saving: false, error: e?.response?.data?.error || e.message }));
    }
  };

  // ── Stats ─────────────────────────────────────────────────────
  const activeCount     = rows.filter(r => r.status === 'ACTIVE').length;
  const activeRemaining = rows.filter(r => r.status === 'ACTIVE')
                              .reduce((s, r) => s + (parseInt(r.qty_remaining, 10) || 0), 0);

  return (
    <div style={{ padding: 24, background: '#f8fafc', height: '100vh', overflowY: 'auto', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>Empty Vouchers</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Controller station — record empties returned and issue bearer slips redeemable at POS.
            Physical stock only, doesn't hit Sales Report or Cash Book.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <FiRefreshCw size={14} /> Refresh
          </button>
          <button onClick={openIssue}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 18px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
            <FiPlus size={14} /> Issue Voucher
          </button>
        </div>
      </div>

      {toast && (
        <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, fontSize: 13,
                       background: toast.type === 'ok' ? '#f0fdf4' : '#fef2f2',
                       color:      toast.type === 'ok' ? '#166534' : '#b91c1c',
                       border: `1px solid ${toast.type === 'ok' ? '#86efac' : '#fecaca'}` }}>
          {toast.text}
        </div>
      )}

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 }}>
        <div style={{ padding: 14, borderRadius: 10, background: '#fff', border: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>Active vouchers</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: '#166534' }}>{activeCount.toLocaleString()}</div>
        </div>
        <div style={{ padding: 14, borderRadius: 10, background: '#fff', border: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>Total empties held</div>
          <div style={{ fontSize: 24, fontWeight: 800, color: '#0e7490' }}>{activeRemaining.toLocaleString()}</div>
          {/* Broken down per empty: a single total across EMPTY ZB, EMPTY
              500ML and crates is not a number anyone can act on. */}
          {(() => {
            const byProduct = {};
            rows.filter(r => r.status === 'ACTIVE').forEach(r => {
              const k = r.product_name || 'Unspecified';
              byProduct[k] = (byProduct[k] || 0) + (parseInt(r.qty_remaining, 10) || 0);
            });
            const entries = Object.entries(byProduct).filter(([, n]) => n > 0)
              .sort((a, b) => b[1] - a[1]);
            if (entries.length === 0) return null;
            return (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {entries.map(([name, n]) => (
                  <div key={name} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#475569' }}>
                    <span>{name}</span><strong>{n.toLocaleString()}</strong>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        {['ACTIVE', 'CLAIMED', 'VOID', ''].map(s => {
          const label = s ? STATUS_META[s].label : 'All';
          const active = statusFilter === s;
          return (
            <button key={s || 'all'}
              onClick={() => setStatusFilter(s)}
              style={{ padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                       border: active ? '1.5px solid #111827' : '1.5px solid #e5e7eb',
                       background: active ? '#111827' : '#fff',
                       color: active ? '#fff' : '#374151',
                       cursor: 'pointer' }}>
              {label}
            </button>
          );
        })}
        <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
          <FiSearch size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input type="text" value={query} onChange={e => setQuery(e.target.value)}
                 placeholder="Search by voucher #, name, or phone…"
                 style={{ width: '100%', padding: '9px 12px 9px 32px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
        </div>
      </div>

      {/* List */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No vouchers.</div>
        ) : (
          <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb', color: '#374151', fontSize: 11, textTransform: 'uppercase' }}>
                <th style={th}>Voucher #</th>
                <th style={th}>Issued to</th>
                <th style={{ ...th, textAlign: 'right' }}>Original</th>
                <th style={{ ...th, textAlign: 'right' }}>Remaining</th>
                <th style={th}>Status</th>
                <th style={th}>Issued</th>
                <th style={{ ...th, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const meta = STATUS_META[r.status] || STATUS_META.ACTIVE;
                return (
                  <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ ...td, fontFamily: 'monospace', fontWeight: 700 }}>{r.voucher_number}</td>
                    <td style={td}>
                      {r.issued_to_name || <span style={{ color: '#9ca3af' }}>—</span>}
                      {r.issued_to_phone && <div style={{ fontSize: 11, color: '#6b7280' }}>{r.issued_to_phone}</div>}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{r.qty_original}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 800, color: r.qty_remaining > 0 ? '#0e7490' : '#94a3b8' }}>{r.qty_remaining}</td>
                    <td style={td}>
                      <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
                        {meta.label}
                      </span>
                    </td>
                    <td style={{ ...td, color: '#6b7280', fontSize: 12 }}>
                      {fmtDate(r.issued_at)}
                      {r.issued_by_name && <div style={{ fontSize: 11 }}>by {r.issued_by_name}</div>}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button onClick={() => openDetail(r)}
                        style={{ padding: '5px 12px', borderRadius: 6, border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                        View
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Issue modal */}
      {issueModal && (
        <div style={overlay} onClick={() => !issueModal.saving && setIssueModal(null)}>
          <div style={{ ...modal, maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <ModalHeader title={issueModal.voucher ? `Voucher ${issueModal.voucher.voucher_number}` : 'Issue Empty Voucher'}
                         subtitle={issueModal.voucher ? 'Hand this slip to the customer.' : 'Record how many empties the person handed in.'}
                         onClose={() => setIssueModal(null)} />
            <div style={{ padding: '18px 22px' }}>
              {issueModal.voucher ? (
                <>
                  <pre style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: 14, fontFamily: '"Courier New", monospace', fontSize: 12, whiteSpace: 'pre', overflowX: 'auto' }}>
                    {issueModal.slipText}
                  </pre>
                  <button onClick={() => printSlip(issueModal.slipText)}
                    style={{ marginTop: 12, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', border: '1.5px solid #0ea5e9', borderRadius: 6, background: '#fff', color: '#0369a1', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                    <FiPrinter size={14} /> Print slip
                  </button>
                </>
              ) : (
                <>
                  {/* Which empty. Asked BEFORE the quantity, because "12"
                      means nothing until you know 12 of what. */}
                  <Field label="Which empty *">
                    <select value={issueModal.product_sync_id} autoFocus
                            onChange={e => setIssueModal(m => ({ ...m, product_sync_id: e.target.value }))}
                            style={inp}>
                      <option value="">— pick the empty —</option>
                      {crateProducts.map(p => (
                        <option key={p.sync_id} value={p.sync_id}>{p.name}</option>
                      ))}
                    </select>
                    {crateProducts.length === 0 && (
                      <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>
                        No products in the <strong>Crates</strong> category yet — ask HQ to add one under Item Details.
                      </div>
                    )}
                  </Field>
                  <Field label="Empties returned *">
                    <input type="number" min="1" step="1" value={issueModal.qty}
                           onChange={e => setIssueModal(m => ({ ...m, qty: e.target.value }))}
                           placeholder="e.g. 12" style={inp} />
                  </Field>
                  <Field label="Issued to (name — optional)">
                    <input type="text" value={issueModal.name}
                           onChange={e => setIssueModal(m => ({ ...m, name: e.target.value }))}
                           placeholder="e.g. Sirak Solomon" style={inp} />
                  </Field>
                  <Field label="Phone (optional)">
                    <input type="text" value={issueModal.phone}
                           onChange={e => setIssueModal(m => ({ ...m, phone: e.target.value }))}
                           placeholder="e.g. 097XXX" style={inp} />
                  </Field>
                  <Field label="Notes (optional)">
                    <input type="text" value={issueModal.notes}
                           onChange={e => setIssueModal(m => ({ ...m, notes: e.target.value }))}
                           placeholder="e.g. Truck delivery" style={inp} />
                  </Field>
                  {issueModal.error && (
                    <div style={{ padding: '10px 12px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, marginTop: 10 }}>
                      {issueModal.error}
                    </div>
                  )}
                </>
              )}
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => !issueModal.saving && setIssueModal(null)}
                      style={btnSecondary}>
                {issueModal.voucher ? 'Close' : 'Cancel'}
              </button>
              {!issueModal.voucher && (
                <button onClick={submitIssue} disabled={issueModal.saving} style={btnPrimary(issueModal.saving)}>
                  {issueModal.saving ? 'Issuing…' : 'Issue Voucher'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Detail modal */}
      {detail && (
        <div style={overlay} onClick={() => setDetail(null)}>
          <div style={{ ...modal, maxWidth: 640, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <ModalHeader title={detail.voucher.voucher_number}
                         subtitle={`${detail.voucher.qty_original} original · ${detail.voucher.qty_remaining} remaining · ${STATUS_META[detail.voucher.status]?.label}`}
                         onClose={() => setDetail(null)} />
            <div style={{ padding: '18px 22px', overflowY: 'auto', flex: 1 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14, fontSize: 12 }}>
                <ProvField label="Issued to">{detail.voucher.issued_to_name || <span style={{ color: '#9ca3af' }}>—</span>}</ProvField>
                <ProvField label="Phone">{detail.voucher.issued_to_phone || <span style={{ color: '#9ca3af' }}>—</span>}</ProvField>
                <ProvField label="Issued at">{fmtDate(detail.voucher.issued_at)}</ProvField>
                <ProvField label="Issued by">{detail.voucher.issued_by_name || '—'}</ProvField>
                {detail.voucher.notes && <ProvField label="Notes" span>{detail.voucher.notes}</ProvField>}
                {detail.voucher.status === 'VOID' && (
                  <ProvField label="Void reason" span>
                    <span style={{ color: '#b91c1c' }}>{detail.voucher.void_reason}</span>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                      {fmtDate(detail.voucher.void_at)} · by {detail.voucher.void_by_name || '—'}
                    </div>
                  </ProvField>
                )}
              </div>
              <h4 style={{ margin: '18px 0 8px', fontSize: 13, fontWeight: 700, color: '#111827' }}>Claim history ({detail.claims.length})</h4>
              {detail.claims.length === 0 ? (
                <div style={{ padding: 16, textAlign: 'center', color: '#9ca3af', fontSize: 12, border: '1px dashed #e5e7eb', borderRadius: 8 }}>No claims yet.</div>
              ) : (
                <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb', color: '#374151', fontSize: 11, textTransform: 'uppercase' }}>
                      <th style={th}>When</th>
                      <th style={th}>Order</th>
                      <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                      <th style={th}>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.claims.map(c => (
                      <tr key={c.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={td}>{fmtDate(c.claimed_at)}</td>
                        <td style={{ ...td, fontFamily: 'monospace' }}>{c.order_number ? fmtInvoiceNo(c.order_number) : '—'}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#0e7490' }}>{c.qty_claimed}</td>
                        <td style={{ ...td, color: '#6b7280' }}>{c.claimed_by_name || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <div>
                {detail.voucher.status === 'ACTIVE' && isAdmin && (
                  <button onClick={() => openVoid(detail.voucher)}
                          style={{ ...btnSecondary, color: '#b91c1c', borderColor: '#fecaca' }}>
                    Void voucher
                  </button>
                )}
              </div>
              <button onClick={() => setDetail(null)} style={btnSecondary}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Void modal */}
      {voidModal && (
        <div style={overlay} onClick={() => !voidModal.saving && setVoidModal(null)}>
          <div style={{ ...modal, maxWidth: 440 }} onClick={e => e.stopPropagation()}>
            <ModalHeader title={`Void ${voidModal.voucher.voucher_number}`}
                         subtitle="This blocks further claims. Existing claims are preserved."
                         onClose={() => setVoidModal(null)} />
            <div style={{ padding: '18px 22px' }}>
              <Field label="Reason *">
                <input type="text" autoFocus value={voidModal.reason}
                       onChange={e => setVoidModal(m => ({ ...m, reason: e.target.value }))}
                       placeholder="e.g. Slip reported lost by customer" style={inp} />
              </Field>
              {voidModal.error && (
                <div style={{ padding: '10px 12px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12 }}>
                  {voidModal.error}
                </div>
              )}
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => !voidModal.saving && setVoidModal(null)} style={btnSecondary}>Cancel</button>
              <button onClick={submitVoid} disabled={voidModal.saving}
                      style={{ ...btnPrimary(voidModal.saving), background: voidModal.saving ? '#9ca3af' : '#dc2626' }}>
                {voidModal.saving ? 'Voiding…' : 'Confirm Void'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Style helpers ─────────────────────────────────────────────────
const th = { padding: '11px 14px', textAlign: 'left', fontWeight: 700 };
const td = { padding: '10px 14px', color: '#111827' };
const inp = { width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box', background: '#fff' };
const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 };
const modal = { background: '#fff', borderRadius: 14, width: '100%' };
const btnSecondary = { padding: '9px 16px', border: '1.5px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: '#374151' };
const btnPrimary = (busy) => ({ padding: '9px 20px', border: 'none', borderRadius: 8, background: busy ? '#9ca3af' : '#16a34a', color: '#fff', cursor: busy ? 'wait' : 'pointer', fontSize: 13, fontWeight: 700 });

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</label>
      {children}
    </div>
  );
}

function ProvField({ label, span, children }) {
  return (
    <div style={{ gridColumn: span ? '1 / -1' : undefined }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#64748b', fontWeight: 700, letterSpacing: 0.4, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#111827', fontWeight: 600 }}>{children}</div>
    </div>
  );
}

function ModalHeader({ title, subtitle, onClose }) {
  return (
    <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>{title}</h3>
        {subtitle && <p style={{ margin: '3px 0 0', fontSize: 12, color: '#6b7280' }}>{subtitle}</p>}
      </div>
      <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>
        <FiX size={18} />
      </button>
    </div>
  );
}
