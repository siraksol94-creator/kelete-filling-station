// CustomerEmptyBalances — v1.13.62
//
// Shows every registered customer holding a non-zero empty-container
// balance (i.e. Kelete is holding empties on their behalf). Read-only
// list + a "Record Empty Return" button that opens a modal for the
// Case 4 pure-return flow (customer walks in with empties, no beer
// sale attached).
//
// Sales Report / Cash Book are NOT affected by any activity on this
// page — empties are physical stock, not money.

import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiPackage, FiPlus, FiX, FiUsers } from 'react-icons/fi';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';
import {
  getCustomerEmptyBalances, getCustomerEmptyBalance,
  createCustomerEmptyReturn, getCustomers,
} from '../services/api';

export default function CustomerEmptyBalances() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [returnModal, setReturnModal] = useState(null); // { customer_id, customer_name, qty, notes }
  const [ledgerModal, setLedgerModal] = useState(null); // { customer, ledger, empty_balance }
  const [allCustomers, setAllCustomers] = useState([]);

  const flash = (text, type = 'ok') => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'err' ? 4500 : 2500);
  };

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await getCustomerEmptyBalances();
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      flash(e?.response?.data?.error || e.message, 'err');
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // Prefetch all customers for the "New Return" picker.
    getCustomers().then(r => setAllCustomers(r.data || [])).catch(() => {});
  }, []);

  const openReturnFor = (cust) => setReturnModal({
    customer_id: cust?.id || '',
    customer_name: cust?.name || '',
    qty: '',
    notes: '',
    saving: false,
    error: null,
  });

  const openLedgerFor = async (cust) => {
    try {
      const { data } = await getCustomerEmptyBalance(cust.id);
      setLedgerModal(data);
    } catch (e) {
      flash(e?.response?.data?.error || e.message, 'err');
    }
  };

  const submitReturn = async () => {
    if (!returnModal.customer_id) {
      setReturnModal(m => ({ ...m, error: 'Pick a customer.' }));
      return;
    }
    const qty = parseInt(returnModal.qty, 10) || 0;
    if (!(qty > 0)) {
      setReturnModal(m => ({ ...m, error: 'Quantity must be > 0.' }));
      return;
    }
    setReturnModal(m => ({ ...m, saving: true, error: null }));
    try {
      const { data } = await createCustomerEmptyReturn({
        customer_id: returnModal.customer_id,
        qty,
        notes: returnModal.notes || null,
      });
      flash(`Recorded — ${data.customer_name} balance ${data.old_balance} → ${data.new_balance}.`);
      setReturnModal(null);
      load();
    } catch (e) {
      setReturnModal(m => ({ ...m, saving: false, error: e?.response?.data?.error || e.message }));
    }
  };

  const totalBalance = rows.reduce((s, r) => s + (parseInt(r.empty_balance, 10) || 0), 0);

  return (
    <div style={{ padding: 24, background: '#f8fafc', height: '100vh', overflowY: 'auto', boxSizing: 'border-box' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>Customer Empty Balances</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Empties Kelete is holding on customers' behalf. Physical stock only — nothing hits Sales Report or Cash Book.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={load}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <FiRefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => openReturnFor(null)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 18px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
            <FiPlus size={14} /> Record Empty Return
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

      {/* Summary tile */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 }}>
        <div style={{ padding: 14, borderRadius: 10, background: '#fff', border: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, fontWeight: 700, color: '#374151' }}>
            <FiUsers size={14} /> Customers with balance
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, color: '#111827' }}>{rows.length.toLocaleString()}</div>
        </div>
        <div style={{ padding: 14, borderRadius: 10, background: '#fff', border: '1px solid #e5e7eb' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, fontWeight: 700, color: '#374151' }}>
            <FiPackage size={14} /> Total empties held
          </div>
          <div style={{ fontSize: 24, fontWeight: 800, color: '#0e7490' }}>{totalBalance.toLocaleString()}</div>
        </div>
      </div>

      {/* Table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
            No customer has an outstanding empty balance.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f9fafb', color: '#374151', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                <th style={{ padding: '11px 14px', textAlign: 'left', fontWeight: 700 }}>Customer</th>
                <th style={{ padding: '11px 14px', textAlign: 'left', fontWeight: 700 }}>Phone</th>
                <th style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 700 }}>Empty Balance</th>
                <th style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 700 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>{r.name}</td>
                  <td style={{ padding: '10px 14px', color: '#6b7280' }}>{r.phone || '—'}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 800, color: '#0e7490', fontSize: 15 }}>
                    {parseInt(r.empty_balance, 10).toLocaleString()}
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                    <button onClick={() => openLedgerFor(r)}
                      style={{ padding: '5px 12px', border: '1.5px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 12, fontWeight: 600, marginRight: 6 }}>
                      History
                    </button>
                    <button onClick={() => openReturnFor(r)}
                      style={{ padding: '5px 12px', border: 'none', borderRadius: 6, background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                      + Return
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Empty Return modal */}
      {returnModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
             onClick={() => !returnModal.saving && setReturnModal(null)}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460 }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>Record Empty Return</h3>
                <p style={{ margin: '3px 0 0', fontSize: 12, color: '#6b7280' }}>Case 4: customer walked in with empties, no beer sale.</p>
              </div>
              <button onClick={() => !returnModal.saving && setReturnModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>
                <FiX size={18} />
              </button>
            </div>
            <div style={{ padding: '18px 22px' }}>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>Customer</label>
                <select value={returnModal.customer_id}
                        onChange={e => {
                          const c = allCustomers.find(x => String(x.id) === e.target.value);
                          setReturnModal(m => ({ ...m, customer_id: e.target.value, customer_name: c?.name || '' }));
                        }}
                        style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, background: '#fff', boxSizing: 'border-box' }}>
                  <option value="">— pick a customer —</option>
                  {allCustomers.map(c => (
                    <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>
                  ))}
                </select>
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>Empties returned</label>
                <input type="number" min="1" step="1" value={returnModal.qty}
                       onChange={e => setReturnModal(m => ({ ...m, qty: e.target.value }))}
                       autoFocus
                       placeholder="e.g. 12"
                       style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 16, fontWeight: 700, boxSizing: 'border-box' }} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>Notes (optional)</label>
                <input type="text" value={returnModal.notes}
                       onChange={e => setReturnModal(m => ({ ...m, notes: e.target.value }))}
                       placeholder="e.g. Driver delivered before Monday pickup"
                       style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              {returnModal.error && (
                <div style={{ padding: '10px 12px', background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12 }}>
                  {returnModal.error}
                </div>
              )}
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => !returnModal.saving && setReturnModal(null)}
                      style={{ padding: '9px 16px', border: '1.5px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                Cancel
              </button>
              <button onClick={submitReturn} disabled={returnModal.saving}
                      style={{ padding: '9px 20px', border: 'none', borderRadius: 8, background: returnModal.saving ? '#9ca3af' : '#16a34a', color: '#fff', cursor: returnModal.saving ? 'wait' : 'pointer', fontSize: 13, fontWeight: 700 }}>
                {returnModal.saving ? 'Saving…' : 'Save Return'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Ledger modal */}
      {ledgerModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
             onClick={() => setLedgerModal(null)}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 640, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>{ledgerModal.customer.name} · Empty History</h3>
                <p style={{ margin: '3px 0 0', fontSize: 13, color: '#0e7490', fontWeight: 700 }}>
                  Current balance: {parseInt(ledgerModal.empty_balance, 10).toLocaleString()} empties
                </p>
              </div>
              <button onClick={() => setLedgerModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}>
                <FiX size={18} />
              </button>
            </div>
            <div style={{ padding: '10px 22px', overflowY: 'auto', flex: 1 }}>
              {ledgerModal.ledger.length === 0 ? (
                <div style={{ padding: 30, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No history yet.</div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb', color: '#374151', fontSize: 11, textTransform: 'uppercase' }}>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 700 }}>When</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 700 }}>Kind</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 700 }}>Order</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>Qty</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>Balance</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 700 }}>By</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerModal.ledger.map(l => (
                      <tr key={l.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '8px 10px', color: '#374151', whiteSpace: 'nowrap' }}>{(l.created_at || '').replace('T', ' ').slice(0, 16)}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                                         background: l.kind === 'pure_return' ? '#dcfce7' : '#dbeafe',
                                         color:      l.kind === 'pure_return' ? '#166534' : '#1d4ed8' }}>
                            {l.kind === 'pure_return' ? 'Pure Return' : l.kind === 'sale' ? 'On Sale' : l.kind}
                          </span>
                        </td>
                        <td style={{ padding: '8px 10px', color: '#6b7280', fontFamily: 'monospace' }}>{l.order_number ? fmtInvoiceNo(l.order_number) : '—'}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: l.qty > 0 ? '#16a34a' : l.qty < 0 ? '#dc2626' : '#374151' }}>
                          {l.qty > 0 ? `+${l.qty}` : l.qty}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#0e7490' }}>{l.balance_after}</td>
                        <td style={{ padding: '8px 10px', color: '#6b7280' }}>{l.created_by_name || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
