// Dispatch — 3-station workflow's final station (kassumbalesa1).
//
// Cashier has flipped the order to PAID and handed the customer a copy.
// The customer walks to Dispatch with that copy; the dispatcher pulls up
// the same order here, confirms each line physically, and clicks
// "Confirm Dispatch". Status flips to DISPATCHED, stock_movements rows
// are minted on the server, and the daily profit row is recalculated.
//
// No payment math here — that's Cashier's job. We're a manifest screen.
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiClock, FiUser, FiTruck, FiCheckCircle } from 'react-icons/fi';
import { getDispatchInbox, getOrder, confirmDispatch } from '../services/api';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';
import InvoiceNo from '../components/InvoiceNo';
import { useCurrency } from '../context/CurrencyContext';


export default function Dispatch() {
  // 2026-09-04 — was a module-scope `fmtUSD` hardcoding a dollar sign, which
  // never asked the currency context and printed $2,952.00 on a page where
  // every other figure is in Kwacha. money() reads the branch's own symbol.
  const { money } = useCurrency();
  const [inbox, setInbox] = useState([]);
  const [loadingInbox, setLoadingInbox] = useState(false);
  const [selected, setSelected] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refreshInbox = async () => {
    setLoadingInbox(true);
    try {
      const res = await getDispatchInbox();
      setInbox(Array.isArray(res.data) ? res.data : []);
    } catch { /* ignore */ }
    setLoadingInbox(false);
  };

  useEffect(() => {
    refreshInbox();
    const id = setInterval(refreshInbox, 5000);
    return () => clearInterval(id);
  }, []);

  const openOrder = async (id) => {
    setLoadingDetail(true);
    try {
      const res = await getOrder(id);
      setSelected(res.data);
    } catch { setSelected(null); }
    setLoadingDetail(false);
  };

  const doConfirm = async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      await confirmDispatch(selected.id);
      setSelected(null);
      setConfirmOpen(false);
      setToast({ text: 'Goods released — order dispatched.', type: 'success' });
      setTimeout(() => setToast(null), 3000);
      refreshInbox();
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Dispatch failed';
      setToast({ text: msg, type: 'error' });
      setTimeout(() => setToast(null), 4500);
    }
    setSubmitting(false);
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Dispatch</h1>
          <p>Release goods on paid orders</p>
        </div>
        <button onClick={refreshInbox}
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

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, height: 'calc(100vh - 200px)' }}>
        {/* ── LEFT: Paid orders queue ─────────────────────────────────── */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, overflowY: 'auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 15, color: '#0f172a' }}>Paid · Awaiting Dispatch</h3>
            <span style={{ fontSize: 12, color: '#64748b', background: '#f1f5f9', padding: '2px 8px', borderRadius: 12 }}>
              {inbox.length}
            </span>
          </div>
          {loadingInbox && inbox.length === 0 ? (
            <p style={{ color: '#64748b', fontSize: 13 }}>Loading…</p>
          ) : inbox.length === 0 ? (
            <p style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>No orders to dispatch</p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {inbox.map(o => {
                // The card used to key its time off paid_at alone, which the
                // pos_dispatch workflow never stamps (orders.js:545 posts the
                // order already PAID), so every Buseko card showed no time at
                // all. Sale and payment are one action there, so the order's
                // own time is the payment time.
                const when = o.paid_at || o.sales_at || o.created_at;
                // SQLite hands back UTC as 'YYYY-MM-DD HH:MM:SS' with no zone.
                // Date() reads that as local and would show every sale two
                // hours early in Lusaka.
                const whenAt = when
                  ? new Date(when.includes('T') ? when : when.replace(' ', 'T') + 'Z')
                  : null;
                return (
                <div key={o.id}
                  onClick={() => openOrder(o.id)}
                  style={{
                    padding: '10px 12px',
                    border: `1.5px solid ${selected?.id === o.id ? '#2563eb' : '#e5e7eb'}`,
                    background: selected?.id === o.id ? '#eff6ff' : '#fff',
                    borderRadius: 8, cursor: 'pointer',
                  }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    {/* 2026-09-03 — ZRA receipt leads when the sale is signed;
                        ours is the fallback and says so when it is not. */}
                    <InvoiceNo order={o} size={15} />
                    <span style={{ background: '#dcfce7', color: '#166534', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10 }}>PAID</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b' }}>
                    <span><FiUser size={10} style={{ verticalAlign: 'middle' }} /> {o.customer_name || 'Walk-in'}</span>
                    <span>{o.item_count} item{o.item_count === 1 ? '' : 's'}</span>
                  </div>
                  {whenAt && (
                    <div style={{ marginTop: 4, fontSize: 10, color: '#94a3b8' }}>
                      <FiClock size={10} style={{ verticalAlign: 'middle' }} /> {whenAt.toLocaleString()}
                      {o.cashier_name ? ` · ${o.cashier_name}` : ''}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── RIGHT: Order detail + confirm ──────────────────────────── */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, overflowY: 'auto' }}>
          {!selected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94a3b8', flexDirection: 'column' }}>
              <FiTruck size={48} style={{ marginBottom: 12, opacity: 0.4 }} />
              <p style={{ fontStyle: 'italic' }}>Select a paid order to release the goods</p>
            </div>
          ) : loadingDetail ? (
            <p style={{ color: '#64748b' }}>Loading order…</p>
          ) : (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <h3 style={{ margin: '0 0 4px 0', fontSize: 18, color: '#0f172a' }}>Order {fmtInvoiceNo(selected.order_number)}</h3>
                  <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
                    Customer: <strong>{selected.customer_name || 'Walk-in'}</strong>
                  </p>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 11, color: '#64748b' }}>Total Paid</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: '#16a34a' }}>{money(selected.total_amount)}</div>
                </div>
              </div>

              <h4 style={{ margin: '18px 0 8px 0', fontSize: 14, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 6 }}>
                <FiCheckCircle /> Items to Release
              </h4>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead style={{ background: '#f8fafc' }}>
                    <tr>
                      <th style={thStyle}>Item</th>
                      <th style={{ ...thStyle, textAlign: 'right', width: 140 }}>Quantity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selected.items || []).map((it, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ ...tdStyle, fontWeight: 600 }}>{it.product_name}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontSize: 15, fontWeight: 700, color: '#0f172a' }}>
                          {parseFloat(it.quantity).toFixed(2)} <span style={{ fontSize: 11, color: '#64748b', fontWeight: 500 }}>{it.unit || ''}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <button onClick={() => setConfirmOpen(true)}
                disabled={submitting}
                style={{
                  marginTop: 22, width: '100%', padding: '16px',
                  background: 'linear-gradient(135deg,#16a34a,#15803d)',
                  color: '#fff', border: 'none', borderRadius: 10,
                  fontSize: 16, fontWeight: 700, cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                }}>
                <FiTruck /> Confirm Dispatch →
              </button>
            </div>
          )}
        </div>
      </div>

      {confirmOpen && selected && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: 'min(420px, 92vw)', padding: 22 }}>
            <h3 style={{ margin: '0 0 12px 0' }}>Release goods?</h3>
            <p style={{ margin: 0, fontSize: 13, color: '#475569' }}>
              You're about to release <strong>{(selected.items || []).length} line{(selected.items || []).length === 1 ? '' : 's'}</strong> for
              order <strong>{fmtInvoiceNo(selected.order_number)}</strong>. Stock will be decremented and the daily profit recalculated.
            </p>
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button onClick={() => setConfirmOpen(false)}
                style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
                Cancel
              </button>
              <button onClick={doConfirm} disabled={submitting}
                style={{ flex: 1, padding: '12px',
                         background: submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                         color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                {submitting ? 'Releasing…' : 'Yes, Release'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 600, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const tdStyle = { padding: '10px 12px', color: '#0f172a' };
