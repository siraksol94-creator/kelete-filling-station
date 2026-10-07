// Pending Approvals — admin queue for discount-request verdicts coming from
// non-admin cashiers' POS terminals. Polls every 4s so a new request from
// another device appears without manual refresh.
import React, { useEffect, useState, useCallback } from 'react';
import {
  getDiscountRequests,
  approveDiscountRequest,
  rejectDiscountRequest,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiCheck, FiX, FiClock, FiRefreshCw, FiTag, FiUser, FiShoppingCart } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';

// Local YYYY-MM-DD for the date pickers — local timezone, NOT UTC, so the
// "today" default lines up with how the rest of the app stamps dates.
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const PendingApprovals = () => {
  const { user } = useAuth();
  const { symbol: curSym, money } = useCurrency();
  const isAdmin = user?.role === 'Administrator';

  const [statusFilter, setStatusFilter] = useState('pending');
  const [dateFrom, setDateFrom] = useState(todayStr());
  const [dateTo,   setDateTo]   = useState(todayStr());
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);
  const [rejectModal, setRejectModal] = useState(null); // { syncId, reason }

  useModalScrollLock(!!rejectModal);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  };

  const fetchList = useCallback(async () => {
    try {
      const res = await getDiscountRequests({
        status: statusFilter,
        from:   dateFrom || undefined,
        to:     dateTo   || undefined,
        limit:  200,
      });
      setList(res.data || []);
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to load requests.', 'error');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, dateFrom, dateTo]);

  useEffect(() => {
    setLoading(true);
    fetchList();
    // Poll while viewing pending — new requests show up automatically.
    if (statusFilter !== 'pending') return;
    const id = setInterval(fetchList, 4000);
    return () => clearInterval(id);
  }, [fetchList, statusFilter]);

  const approve = async (r) => {
    setBusyId(r.id);
    try {
      await approveDiscountRequest(r.sync_id);
      showToast('Discount approved.');
      setList(prev => prev.filter(x => x.sync_id !== r.sync_id));
    } catch (err) {
      showToast(err.response?.data?.error || 'Approve failed.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const reject = async () => {
    const { syncId, reason } = rejectModal;
    setBusyId(-1);
    try {
      await rejectDiscountRequest(syncId, (reason || '').trim() || null);
      showToast('Discount rejected.');
      setList(prev => prev.filter(x => x.sync_id !== syncId));
      setRejectModal(null);
    } catch (err) {
      showToast(err.response?.data?.error || 'Reject failed.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (!isAdmin) {
    return (
      <div style={{ padding: 30 }}>
        <h2>Pending Approvals</h2>
        <p style={{ color: '#6b7280' }}>Only administrators can view this page.</p>
      </div>
    );
  }

  return (
    // v1.13.91 — page-level scroll wrapper. Layout's main area doesn't
    // scroll on its own; a long approvals grid was getting clipped by the
    // viewport. Height + overflowY keep the header pinned while the
    // grid rolls.
    <div style={{ padding: 24, height: '100%', overflowY: 'auto' }}>
      <div style={{ marginBottom: 18 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>Discount Approvals</h2>
        <p style={{ margin: '4px 0 14px', color: '#6b7280', fontSize: 13 }}>Cashier discount requests awaiting your verdict.</p>

        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: 12, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 }}>From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff' }}
            />
            <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 }}>To</label>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff' }}
            />
            <button
              onClick={() => { setDateFrom(todayStr()); setDateTo(todayStr()); }}
              style={{ padding: '6px 10px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}
            >Today</button>
          </div>

          <div style={{ flex: 1 }} />

          <div style={{ display: 'flex', gap: 8 }}>
            {['pending', 'approved', 'rejected'].map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                style={{
                  padding: '8px 14px',
                  background: statusFilter === s ? '#dc2626' : '#fff',
                  color: statusFilter === s ? '#fff' : '#374151',
                  border: '1px solid ' + (statusFilter === s ? '#dc2626' : '#e5e7eb'),
                  borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700, textTransform: 'capitalize',
                }}
              >{s}</button>
            ))}
            <button
              onClick={fetchList}
              title="Refresh"
              style={{ padding: '8px 12px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}
            ><FiRefreshCw size={14} /></button>
          </div>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading…</div>
      ) : list.length === 0 ? (
        <div style={{ padding: 60, textAlign: 'center', background: '#f9fafb', border: '1px dashed #e5e7eb', borderRadius: 12 }}>
          <FiClock size={28} color="#9ca3af" />
          <div style={{ marginTop: 10, fontSize: 14, color: '#6b7280' }}>
            No {statusFilter} requests {dateFrom === dateTo ? `on ${dateFrom}` : `between ${dateFrom} and ${dateTo}`}.
          </div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 14 }}>
          {list.map(r => {
            const isCart    = r.target === 'cart';
            const qty       = parseFloat(r.quantity)        || 0;
            const unitPx    = parseFloat(r.unit_price)      || 0;
            const perUnitD  = parseFloat(r.discount_amount) || 0; // cart: flat off; line: per-unit (signed)
            // v1.8.98 — Line price-change requests carry new_price. When present,
            // we render as a price-change (red if discount, green if surcharge)
            // instead of the discount card style. Cart requests + legacy line
            // discount requests render the original way.
            const isPriceChange = !isCart && r.new_price !== null && r.new_price !== undefined;
            const newPrice  = isPriceChange ? parseFloat(r.new_price) || 0 : null;
            const isMarkup  = isPriceChange && newPrice > unitPx;
            const netUnitPx = isPriceChange ? newPrice : Math.max(0, unitPx - perUnitD);
            const subtotal  = isCart ? (parseFloat(r.subtotal) || 0) : qty * unitPx;
            const discount  = isCart ? perUnitD                       : qty * perUnitD; // signed for price-change
            const net       = isPriceChange ? qty * newPrice : Math.max(0, subtotal - discount);
            const row = (label, value, opts = {}) => (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 12, padding: '4px 0', ...(opts.divider ? { borderTop: '1px dashed #e5e7eb', marginTop: 4, paddingTop: 8 } : {}) }}>
                <span style={{ color: opts.muted ? '#6b7280' : '#374151', fontWeight: opts.bold ? 700 : 500 }}>{label}</span>
                <span style={{ color: opts.color || '#111827', fontWeight: opts.bold ? 800 : 600, fontSize: opts.big ? 14 : 12 }}>{value}</span>
              </div>
            );
            // Header pill colour: cart blue / line-discount red / line-markup green
            const pillBg = isCart ? '#eff6ff'
                         : isPriceChange ? (isMarkup ? '#dcfce7' : '#fef2f2')
                         : '#fef2f2';
            const pillFg = isCart ? '#1e40af'
                         : isPriceChange ? (isMarkup ? '#15803d' : '#991b1b')
                         : '#991b1b';
            const pillLabel = isCart ? 'Cart Discount'
                            : isPriceChange ? (isMarkup ? 'Price Change · Surcharge' : 'Price Change · Discount')
                            : 'Line Discount';
            return (
              <div key={r.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>

                {/* Header — tag pill + title */}
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', background: pillBg, color: pillFg, borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                  {isCart ? <FiShoppingCart size={11} /> : <FiTag size={11} />} {pillLabel}
                </div>
                <div style={{ marginTop: 8, fontWeight: 800, color: '#111827', fontSize: 15 }}>
                  {isCart ? 'Whole sale' : (r.product_name || 'Item')}
                </div>

                {/* Per-unit price math — only for line targets */}
                {!isCart && (
                  <div style={{ marginTop: 10, padding: '10px 12px', background: '#f9fafb', border: '1px solid #f3f4f6', borderRadius: 8 }}>
                    {row('Original price', `${curSym}${unitPx.toFixed(2)} / ${r.unit || ''}`, { muted: true })}
                    {isPriceChange ? (
                      <>
                        {row('New price', `${curSym}${newPrice.toFixed(2)} / ${r.unit || ''}`, { color: isMarkup ? '#15803d' : '#dc2626', bold: true })}
                        {row(isMarkup ? 'Surcharge' : 'Discount',
                          `${isMarkup ? '+' : '−'}${curSym}${Math.abs(unitPx - newPrice).toFixed(2)} / ${r.unit || ''}`,
                          { color: isMarkup ? '#15803d' : '#dc2626', divider: true })}
                      </>
                    ) : (
                      <>
                        {row('Discount',  `−${curSym}${perUnitD.toFixed(2)} / ${r.unit || ''}`, { color: '#dc2626' })}
                        {row('Net price', `${curSym}${netUnitPx.toFixed(2)} / ${r.unit || ''}`, { color: '#16a34a', bold: true, divider: true })}
                      </>
                    )}
                  </div>
                )}

                {/* Reason (price-change only) */}
                {isPriceChange && r.change_reason && (
                  <div style={{ marginTop: 10, padding: '8px 10px', background: '#fefce8', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#78350f' }}>
                    <strong>Reason:</strong> {r.change_reason}
                  </div>
                )}

                {/* Totals — line or cart */}
                <div style={{ marginTop: 10, padding: '10px 12px', background: '#f9fafb', border: '1px solid #f3f4f6', borderRadius: 8 }}>
                  {!isCart && row('Quantity', `${qty.toFixed(2)} ${r.unit || ''}`, { muted: true })}
                  {row(isCart ? 'Cart subtotal' : 'Line total (gross)', money(subtotal), { muted: true })}
                  {isPriceChange ? (
                    row(isMarkup ? 'Surcharge total' : 'Discount total',
                      `${isMarkup ? '+' : '−'}${money(Math.abs(qty * (unitPx - newPrice)))}`,
                      { color: isMarkup ? '#15803d' : '#dc2626' })
                  ) : (
                    row('Total discount', `−${money(discount)}`, { color: '#dc2626' })
                  )}
                  {row(isCart ? 'Cart total (net)' : 'Line total (net)', money(net),
                    { color: isPriceChange && isMarkup ? '#15803d' : '#16a34a', bold: true, big: true, divider: true })}
                </div>

                {/* Requester */}
                <div style={{ marginTop: 12, fontSize: 12, color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <FiUser size={12} color="#6b7280" /> Requested by <strong>{r.requester_name}</strong>
                  <span style={{ color: '#9ca3af', marginLeft: 'auto', fontSize: 11 }}>{(r.created_at || '').replace('T', ' ').slice(0, 16)}</span>
                </div>

                {/* Actions / verdict */}
                {r.status === 'pending' ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button
                      onClick={() => approve(r)}
                      disabled={busyId === r.id}
                      style={{ flex: 1, padding: '10px 0', background: busyId === r.id ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: busyId === r.id ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                    ><FiCheck size={14} /> Approve</button>
                    <button
                      onClick={() => setRejectModal({ syncId: r.sync_id, reason: '' })}
                      disabled={busyId === r.id}
                      style={{ flex: 1, padding: '10px 0', background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
                    ><FiX size={14} /> Reject</button>
                  </div>
                ) : (
                  <div style={{ marginTop: 12, padding: '8px 10px', background: r.status === 'approved' ? '#ecfdf5' : '#fef2f2', borderRadius: 8, fontSize: 12 }}>
                    <div style={{ fontWeight: 700, color: r.status === 'approved' ? '#065f46' : '#991b1b', textTransform: 'capitalize' }}>{r.status} {r.approver_name ? `by ${r.approver_name}` : ''}</div>
                    {r.rejection_reason && (
                      <div style={{ marginTop: 3, color: '#7f1d1d' }}><strong>Reason:</strong> {r.rejection_reason}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {rejectModal && (
        <Portal>
          <div onClick={() => setRejectModal(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 420, overflow: 'hidden' }}>
              <div style={{ padding: '14px 18px', background: '#dc2626', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <strong>Reject Discount</strong>
                <button onClick={() => setRejectModal(null)} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer' }}><FiX size={18} /></button>
              </div>
              <div style={{ padding: 18 }}>
                <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 6 }}>Reason (optional)</label>
                <textarea
                  autoFocus
                  rows={3}
                  value={rejectModal.reason}
                  onChange={e => setRejectModal({ ...rejectModal, reason: e.target.value })}
                  placeholder="e.g. Exceeds the discount limit for this product"
                  style={{ width: '100%', padding: 10, border: '1.5px solid #d1d5db', borderRadius: 8, fontSize: 13, resize: 'vertical', boxSizing: 'border-box', outline: 'none' }}
                />
              </div>
              <div style={{ padding: '12px 18px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={() => setRejectModal(null)} style={{ padding: '9px 16px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Cancel</button>
                <button onClick={reject} disabled={busyId === -1} style={{ padding: '9px 18px', background: busyId === -1 ? '#9ca3af' : '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: busyId === -1 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>{busyId === -1 ? 'Rejecting…' : 'Reject Discount'}</button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {toast && <Toast message={toast.msg} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
};

export default PendingApprovals;
