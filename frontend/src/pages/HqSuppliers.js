// HqSuppliers — HQ supplier master + Accounts Payable. AP balance per
// supplier is recomputed live (purchases − payments). Renaming a
// supplier here AFTER you already have purchases doesn't auto-fix the
// fallback name-match; new purchases pick from the dropdown so the
// supplier_id linkage stays clean going forward.
import React, { useEffect, useMemo, useState } from 'react';
import {
  FiRefreshCw, FiPlus, FiEdit2, FiTrash2, FiEye, FiDollarSign,
  FiUsers, FiTrendingUp, FiTrendingDown, FiX,
} from 'react-icons/fi';
import {
  getHqSuppliers, getHqSupplier, createHqSupplier, updateHqSupplier,
  deleteHqSupplier, recordHqSupplierPayment, deleteHqSupplierPayment,
} from '../services/api';

const fmtMoney = (n) => {
  const v = parseFloat(n || 0);
  const s = `K${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return v < 0 ? `-${s}` : s;
};
const fmtInt = (n) => parseFloat(n || 0).toLocaleString();
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function HqSuppliers() {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(null); // null | 'new' | row
  const [viewing, setViewing] = useState(null);
  const [toast, setToast]     = useState(null);

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getHqSuppliers();
      setRows(r.data?.suppliers || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  const totals = useMemo(() => rows.reduce((acc, r) => {
    acc.purchases += r.purchases_total || 0;
    acc.payments  += r.payments_total  || 0;
    acc.balance   += r.balance         || 0;
    return acc;
  }, { purchases: 0, payments: 0, balance: 0 }), [rows]);

  const openDetail = async (id) => {
    try {
      const r = await getHqSupplier(id);
      setViewing(r.data);
    } catch (err) { flash('Failed to load detail', 'error'); }
  };

  // 2026-09-05 — deleting a supplier now asks for an Administrator password
  // and the server refuses outright if anything is on record against them.
  // A window.confirm only stops an accidental click; the real check lives in
  // the route, so this modal is a prompt, not the guard.
  const [deleting, setDeleting] = useState(null);   // { supplier, password, busy, error }

  const removeSupplier = (s) => setDeleting({ supplier: s, password: '', busy: false, error: '' });

  const confirmDelete = async () => {
    if (!deleting || !deleting.password) return;
    setDeleting(d => ({ ...d, busy: true, error: '' }));
    try {
      await deleteHqSupplier(deleting.supplier.id, deleting.password);
      setDeleting(null);
      flash('Supplier removed.', 'success');
      refresh();
    } catch (err) {
      setDeleting(d => ({ ...d, busy: false, error: err?.response?.data?.error || 'Delete failed' }));
    }
  };

  const DeleteModal = () => !deleting ? null : (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
         onClick={() => { if (!deleting.busy) setDeleting(null); }}>
      <div onClick={e => e.stopPropagation()}
           style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 440, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 17, color: '#b91c1c' }}>Delete {deleting.supplier.name}?</h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b' }}>
          This removes the supplier permanently. It is refused if any GRN, payment,
          credit note or purchase exists against them.
        </p>
        <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 5 }}>
          Administrator password
        </label>
        <input
          type="password"
          autoFocus
          value={deleting.password}
          disabled={deleting.busy}
          onChange={e => setDeleting(d => ({ ...d, password: e.target.value, error: '' }))}
          onKeyDown={e => { if (e.key === 'Enter') confirmDelete(); }}
          style={{ width: '100%', padding: '9px 11px', border: '1.5px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
        />
        {deleting.error && (
          <div style={{ marginTop: 10, padding: '9px 11px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', fontSize: 12.5 }}>
            {deleting.error}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={() => setDeleting(null)} disabled={deleting.busy}
            style={{ padding: '9px 16px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={confirmDelete} disabled={deleting.busy || !deleting.password}
            style={{ padding: '9px 16px', background: (deleting.busy || !deleting.password) ? '#9ca3af' : '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: (deleting.busy || !deleting.password) ? 'not-allowed' : 'pointer', fontWeight: 700 }}>
            {deleting.busy ? 'Deleting…' : 'Delete supplier'}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="page-content">
      <DeleteModal />
      <div className="page-header">
        <div>
          <h1>HQ Suppliers</h1>
          <p>Supplier master + Accounts Payable</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={refresh}
            style={{ padding: '8px 14px', background: '#f1f5f9', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
          <button onClick={() => setShowForm('new')}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <FiPlus /> New Supplier
          </button>
        </div>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 20, zIndex: 999,
          padding: '12px 18px', borderRadius: 8, color: '#fff', fontWeight: 600,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
        }}>{toast.text}</div>
      )}

      {/* Rollup */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 14 }}>
        <RollupCard icon={<FiUsers />} label="Suppliers" value={fmtInt(rows.length)} color="#0f172a" />
        <RollupCard icon={<FiTrendingUp />} label="Total Purchases" value={fmtMoney(totals.purchases)} color="#0ea5e9" />
        <RollupCard icon={<FiTrendingDown />} label="Total Paid"     value={fmtMoney(totals.payments)} color="#047857" />
        <RollupCard icon={<FiDollarSign />} label="AP Outstanding"   value={fmtMoney(totals.balance)} color={totals.balance > 0.01 ? '#b91c1c' : '#0f172a'} highlight />
      </div>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {loading && rows.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>No suppliers yet. Click <strong>New Supplier</strong> to add one.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Supplier</th>
                  <th style={th}>Contact</th>
                  <th style={{ ...th, textAlign: 'right' }}>Purchases</th>
                  <th style={{ ...th, textAlign: 'right' }}>Payments</th>
                  <th style={{ ...th, textAlign: 'right' }}>Balance</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(s => (
                  <tr key={s.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>
                      <strong>{s.name}</strong>
                      {/* TPIN under the name — it is how ZRA identifies this
                          supplier and how a pulled purchase finds them, so it
                          belongs on the row rather than only inside the form. */}
                      {s.tpin && (
                        <div style={{ fontSize: 11, color: '#475569', fontFamily: 'monospace' }}>
                          TPIN {s.tpin}
                        </div>
                      )}
                      {s.phone && <div style={{ fontSize: 11, color: '#64748b' }}>{s.phone}</div>}
                    </td>
                    <td style={td}>
                      {s.contact_person && <div>{s.contact_person}</div>}
                      {s.email && <div style={{ fontSize: 11, color: '#64748b' }}>{s.email}</div>}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <div>{fmtMoney(s.purchases_total)}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{fmtInt(s.purchase_count)} purchase{s.purchase_count === 1 ? '' : 's'}</div>
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <div>{fmtMoney(s.payments_total)}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{fmtInt(s.payment_count)} payment{s.payment_count === 1 ? '' : 's'}</div>
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 800, fontSize: 14,
                                 color: s.balance > 0.01 ? '#b91c1c' : s.balance < -0.01 ? '#047857' : '#0f172a' }}>
                      {fmtMoney(s.balance)}
                    </td>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>
                      <button onClick={() => openDetail(s.id)}
                        style={btnIcon('#0ea5e9')}>
                        <FiEye size={12} /> View
                      </button>
                      <button onClick={() => setShowForm(s)} style={btnIcon('#64748b')}>
                        <FiEdit2 size={12} /> Edit
                      </button>
                      <button onClick={() => removeSupplier(s)} style={btnIcon('#dc2626')}>
                        <FiTrash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <SupplierForm
          existing={showForm === 'new' ? null : showForm}
          onClose={() => setShowForm(null)}
          onSaved={() => { setShowForm(null); refresh(); flash('Saved.', 'success'); }}
          onError={(m) => flash(m, 'error')}
        />
      )}

      {viewing && (
        <SupplierDetail
          data={viewing}
          onClose={() => setViewing(null)}
          onRefresh={async () => {
            const r = await getHqSupplier(viewing.supplier.id);
            setViewing(r.data);
            refresh();
          }}
          flash={flash}
        />
      )}
    </div>
  );
}

function RollupCard({ icon, label, value, color, highlight }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${highlight ? color : '#e5e7eb'}`, borderRadius: 10, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color, fontSize: 12, fontWeight: 600 }}>
        {icon} <span>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: highlight ? color : '#0f172a', marginTop: 4 }}>{value}</div>
    </div>
  );
}

function SupplierForm({ existing, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    name:           existing?.name           || '',
    phone:          existing?.phone          || '',
    email:          existing?.email          || '',
    address:        existing?.address        || '',
    contact_person: existing?.contact_person || '',
    tpin:           existing?.tpin           || '',
    notes:          existing?.notes          || '',
    status:         existing?.status         || 'Active',
  });
  const [submitting, setSubmitting] = useState(false);
  const update = (field, v) => setForm(f => ({ ...f, [field]: v }));

  const submit = async () => {
    if (!form.name.trim()) return onError('Name is required');
    setSubmitting(true);
    try {
      if (existing) await updateHqSupplier(existing.id, form);
      else          await createHqSupplier(form);
      onSaved();
    } catch (err) {
      onError(err?.response?.data?.error || 'Save failed');
    }
    setSubmitting(false);
  };

  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(560px, 96vw)', padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ margin: 0 }}>{existing ? 'Edit Supplier' : 'New Supplier'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>
        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="Name *"><input type="text" value={form.name} onChange={e => update('name', e.target.value.toUpperCase())} style={inp} autoFocus /></Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Phone"><input type="text" value={form.phone} onChange={e => update('phone', e.target.value)} style={inp} /></Field>
            <Field label="Email"><input type="email" value={form.email} onChange={e => update('email', e.target.value)} style={inp} /></Field>
          </div>
          <Field label="Contact person"><input type="text" value={form.contact_person} onChange={e => update('contact_person', e.target.value)} style={inp} /></Field>
          {/* 2026-08-30 — TPIN. The column existed and the ZRA purchase pull
              was already filling it, but there was no field for it, so it
              could not be seen or corrected. Digits only: a ZRA TPIN is 10.
              Deliberately NO "Verify" button like Customers has — that lookup
              only finds parties we have pushed ourselves, so it would report
              a perfectly valid supplier TPIN as unknown. */}
          <Field label="TPIN">
            <input type="text" inputMode="numeric" maxLength={10}
                   value={form.tpin}
                   onChange={e => update('tpin', e.target.value.replace(/[^0-9]/g, ''))}
                   placeholder="10 digits"
                   style={{ ...inp, fontFamily: 'monospace' }} />
            {form.tpin && form.tpin.length !== 10 && (
              <div style={{ fontSize: 11, color: '#b45309', marginTop: 3 }}>
                A ZRA TPIN is 10 digits — this has {form.tpin.length}.
              </div>
            )}
          </Field>
          <Field label="Address"><input type="text" value={form.address} onChange={e => update('address', e.target.value)} style={inp} /></Field>
          <Field label="Notes"><input type="text" value={form.notes} onChange={e => update('notes', e.target.value)} style={inp} /></Field>
          {existing && (
            <Field label="Status">
              <select value={form.status} onChange={e => update('status', e.target.value)} style={inp}>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </Field>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onClose}
            style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={submit} disabled={submitting}
            style={{ flex: 1, padding: '12px',
                     background: submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                     color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function SupplierDetail({ data, onClose, onRefresh, flash }) {
  const [payOpen, setPayOpen] = useState(false);
  const s = data.supplier;

  const removePayment = async (pid) => {
    if (!window.confirm('Delete this payment? AP balance will increase.')) return;
    try {
      await deleteHqSupplierPayment(pid);
      flash('Payment deleted.', 'success');
      await onRefresh();
    } catch (err) {
      flash(err?.response?.data?.error || 'Delete failed', 'error');
    }
  };

  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(920px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: 0 }}>{s.name}</h3>
            <div style={{ fontSize: 12, color: '#64748b' }}>
              {s.phone || '—'} · {s.email || 'no email'} · contact: {s.contact_person || '—'}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>
        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {/* v1.10.57 — 4 stats row: Purchases | Payments | Credits | Balance.
              credits_total / credit_count come from the AP rewrite (GET /:id
              now returns them). Record Payment button drops to its own row. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 10 }}>
            <Stat label="Purchases" value={fmtMoney(s.purchases_total)} sub={`${fmtInt(s.purchase_count)} rows`} />
            <Stat label="Payments"  value={fmtMoney(s.payments_total)}  sub={`${fmtInt(s.payment_count)} rows`} />
            <Stat label="Credits"   value={fmtMoney(s.credits_total || 0)} sub={`${fmtInt(s.credit_count || 0)} rows`} />
            <Stat label="Balance"   value={fmtMoney(s.balance)} highlight={s.balance > 0.01} />
          </div>
          <div style={{ marginBottom: 16 }}>
            <button onClick={() => setPayOpen(true)}
              style={{ width: '100%', padding: '12px', background: 'linear-gradient(135deg,#0ea5e9,#0369a1)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
              <FiPlus /> Record Payment
            </button>
          </div>

          <h4 style={{ margin: '14px 0 8px 0', fontSize: 13, color: '#0f172a' }}>Purchases</h4>
          {data.purchases.length === 0 ? (
            <p style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: 12 }}>No purchases yet.</p>
          ) : (
            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginBottom: 16 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr><th style={th}>Purchase #</th><th style={th}>Date</th><th style={th}>Invoice</th><th style={th}>Status</th><th style={{ ...th, textAlign: 'right' }}>Amount</th></tr>
              </thead>
              <tbody>
                {data.purchases.map(p => (
                  <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ ...td, fontFamily: 'monospace' }}>{p.purchase_number}</td>
                    <td style={td}>{p.date}</td>
                    <td style={td}>{p.invoice_number || '—'}</td>
                    <td style={td}>{p.status}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(p.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4 style={{ margin: '14px 0 8px 0', fontSize: 13, color: '#0f172a' }}>Payments</h4>
          {data.payments.length === 0 ? (
            <p style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: 12 }}>No payments recorded.</p>
          ) : (
            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr><th style={th}>Payment #</th><th style={th}>Date</th><th style={th}>Method</th><th style={th}>Reference</th><th style={{ ...th, textAlign: 'right' }}>Amount</th><th style={th}></th></tr>
              </thead>
              <tbody>
                {data.payments.map(p => (
                  <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ ...td, fontFamily: 'monospace' }}>{p.payment_number}</td>
                    <td style={td}>{p.payment_date}</td>
                    <td style={td}>{p.payment_method}</td>
                    <td style={td}>{p.reference || '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#047857' }}>{fmtMoney(p.amount)}</td>
                    <td style={td}>
                      <button onClick={() => removePayment(p.id)}
                        style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 2 }}>
                        <FiX size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* v1.10.57 — Credit Notes section. Rows carrying grn_sync_id were
              netted into that GRN's final_payable at GRN-generate time; rows
              without grn_sync_id are the standalone CNs that also reduce the
              AP balance. We flag which is which so operators can tell them
              apart. */}
          <h4 style={{ margin: '14px 0 8px 0', fontSize: 13, color: '#0f172a' }}>Credit Notes</h4>
          {(!data.credits || data.credits.length === 0) ? (
            <p style={{ color: '#94a3b8', fontStyle: 'italic', fontSize: 12 }}>No credit notes.</p>
          ) : (
            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>CN #</th>
                  <th style={th}>Date</th>
                  <th style={th}>Reason</th>
                  <th style={th}>Reference</th>
                  <th style={th}>Linked GRN</th>
                  <th style={{ ...th, textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.credits.map(cn => (
                  <tr key={cn.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ ...td, fontFamily: 'monospace' }}>{cn.credit_note_number}</td>
                    <td style={td}>{cn.date}</td>
                    <td style={td}>{cn.reason}</td>
                    <td style={td}>{cn.reference || '—'}</td>
                    <td style={td}>
                      {cn.grn_sync_id ? (
                        <span style={{ display: 'inline-block', padding: '2px 6px', background: '#dbeafe', color: '#1e40af', borderRadius: 4, fontSize: 10.5, fontWeight: 700 }}>netted in GRN</span>
                      ) : (
                        <span style={{ display: 'inline-block', padding: '2px 6px', background: '#fef3c7', color: '#92400e', borderRadius: 4, fontSize: 10.5, fontWeight: 700 }}>standalone</span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#b45309' }}>{fmtMoney(cn.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {payOpen && (
        <PaymentForm
          supplier={s}
          onClose={() => setPayOpen(false)}
          onSaved={async () => { setPayOpen(false); flash('Payment recorded.', 'success'); await onRefresh(); }}
          onError={(m) => flash(m, 'error')}
        />
      )}
    </div>
  );
}

function PaymentForm({ supplier, onClose, onSaved, onError }) {
  const [form, setForm] = useState({
    amount:         '',
    payment_date:   todayISO(),
    payment_method: 'Bank',
    reference:      '',
    notes:          '',
  });
  const [submitting, setSubmitting] = useState(false);
  const update = (field, v) => setForm(f => ({ ...f, [field]: v }));

  const submit = async () => {
    const amt = parseFloat(form.amount);
    if (!(amt > 0)) return onError('Amount must be greater than 0');
    setSubmitting(true);
    try {
      await recordHqSupplierPayment(supplier.id, { ...form, amount: amt });
      onSaved();
    } catch (err) {
      onError(err?.response?.data?.error || 'Failed to save');
    }
    setSubmitting(false);
  };

  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(440px, 92vw)', padding: 22 }}>
        <h3 style={{ margin: '0 0 6px 0' }}>Record Payment</h3>
        <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
          To <strong>{supplier.name}</strong> · Current balance: <strong style={{ color: supplier.balance > 0.01 ? '#b91c1c' : '#0f172a' }}>{fmtMoney(supplier.balance)}</strong>
        </p>
        <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
          <Field label="Amount *">
            <input type="number" min="0" step="0.01" value={form.amount} onChange={e => update('amount', e.target.value)}
              style={{ ...inp, fontSize: 18, fontWeight: 700 }} autoFocus />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Date"><input type="date" value={form.payment_date} onChange={e => update('payment_date', e.target.value)} style={inp} /></Field>
            <Field label="Method">
              <select value={form.payment_method} onChange={e => update('payment_method', e.target.value)} style={inp}>
                <option value="Bank">Bank</option>
                <option value="Cash">Cash</option>
                <option value="Mobile Money">Mobile Money</option>
              </select>
            </Field>
          </div>
          <Field label="Reference"><input type="text" value={form.reference} onChange={e => update('reference', e.target.value)} placeholder="Cheque #, transaction ID, etc." style={inp} /></Field>
          <Field label="Notes"><input type="text" value={form.notes} onChange={e => update('notes', e.target.value)} style={inp} /></Field>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onClose}
            style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={submit} disabled={submitting}
            style={{ flex: 1, padding: '12px',
                     background: submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                     color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
            {submitting ? 'Saving…' : 'Save Payment'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}
function Stat({ label, value, sub, highlight }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #f1f5f9', borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: highlight ? '#b91c1c' : '#0f172a', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#94a3b8' }}>{sub}</div>}
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '8px 10px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '6px 10px', color: '#0f172a' };
const btnIcon = (color) => ({
  padding: '4px 8px', background: 'transparent', color, border: `1px solid ${color}33`, borderRadius: 4,
  cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3,
  marginRight: 4,
});
