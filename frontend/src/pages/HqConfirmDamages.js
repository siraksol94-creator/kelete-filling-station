// HqConfirmDamages — HQ-side queue of branch-declared damages awaiting
// confirmation. Branches submit declarations (status='PENDING'); stock
// at the branch decrements + the damages cost lands on the day's Profit
// Report only after HQ confirms here. Reject sends it back with a reason
// (status='REJECTED', kept for audit; branch can re-declare if needed).
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiCheck, FiX, FiInbox, FiAlertTriangle } from 'react-icons/fi';
import {
  getHqDamagesAwaiting, confirmHqDamage, rejectHqDamage,
} from '../services/api';

const fmtMoney = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function HqConfirmDamages() {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing]   = useState(null); // { row, mode, notes, submitting }
  const [toast, setToast]     = useState(null);

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getHqDamagesAwaiting();
      setRows(r.data?.damages || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, []);

  const submit = async () => {
    if (!acting) return;
    setActing(a => ({ ...a, submitting: true }));
    try {
      const call = acting.mode === 'confirm' ? confirmHqDamage : rejectHqDamage;
      await call(acting.row.branch_slug, acting.row.id, { confirm_notes: acting.notes || null });
      flash(acting.mode === 'confirm'
        ? 'Confirmed — branch stock decremented.'
        : 'Rejected — branch will see the reason.', 'success');
      setActing(null);
      refresh();
    } catch (err) {
      flash(err?.response?.data?.error || `${acting.mode} failed`, 'error');
      setActing(a => ({ ...a, submitting: false }));
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Confirm Damages</h1>
          <p>Branch-declared damages waiting for HQ approval before stock leaves</p>
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

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {loading && rows.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}><FiInbox /> Nothing waiting.</p>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {rows.map(r => (
              <div key={`${r.branch_slug}-${r.id}`} style={{ border: '1px solid #fde68a', background: '#fffbeb', borderRadius: 10, padding: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <div style={{ fontFamily: 'monospace', fontSize: 12, color: '#92400e' }}>{r.return_number}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', marginTop: 2 }}>
                      {r.branch_name} <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 500 }}>({r.branch_slug})</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      {r.date} · declared by {r.created_by_name || '—'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 11, color: '#92400e', fontWeight: 700, textTransform: 'uppercase' }}>Est. value</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#92400e' }}>{fmtMoney(r.est_value)}</div>
                  </div>
                </div>
                {r.notes && (
                  <p style={{ fontSize: 12, color: '#475569', fontStyle: 'italic', marginBottom: 8 }}>"{r.notes}"</p>
                )}
                <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, background: '#fff', borderRadius: 6, overflow: 'hidden' }}>
                  <thead style={{ background: '#f8fafc' }}>
                    <tr>
                      <th style={th}>Product</th>
                      <th style={{ ...th, textAlign: 'right' }}>Qty</th>
                      <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                      <th style={{ ...th, textAlign: 'right' }}>Line value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(r.items || []).map(it => {
                      // v1.8.35 — backend now sends line_cost (cost per
                      // declared unit) and line_value (qty × line_cost),
                      // so 1 Box reads $23.55/Box instead of the
                      // per-Bottle $0.98. Fall back to old calc on
                      // pre-v1.8.35 rows where the enrichment is absent.
                      const lineCost  = it.line_cost  != null ? parseFloat(it.line_cost)  : (parseFloat(it.cost_price) || 0);
                      const lineValue = it.line_value != null ? parseFloat(it.line_value) : (parseFloat(it.quantity) || 0) * lineCost;
                      return (
                        <tr key={it.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={td}>{it.product_name || it.product_sync_id}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{fmtQty(it.quantity)} {it.unit || it.product_unit || ''}</td>
                          <td style={{ ...td, textAlign: 'right' }}>{fmtMoney(lineCost)}</td>
                          <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(lineValue)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 10 }}>
                  <button onClick={() => setActing({ row: r, mode: 'reject', notes: '', submitting: false })}
                    style={btn('#dc2626', true)}>
                    <FiX size={12} /> Reject
                  </button>
                  <button onClick={() => setActing({ row: r, mode: 'confirm', notes: '', submitting: false })}
                    style={btn('#16a34a')}>
                    <FiCheck size={12} /> Confirm
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {acting && <ActModal state={acting} setState={setActing} onCancel={() => setActing(null)} onSubmit={submit} />}
    </div>
  );
}

function ActModal({ state, setState, onCancel, onSubmit }) {
  const { row, mode, notes, submitting } = state;
  const isConfirm = mode === 'confirm';
  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(480px, 92vw)', padding: 22 }}>
        <h3 style={{ margin: '0 0 6px 0' }}>{isConfirm ? 'Confirm Damage' : 'Reject Damage'}</h3>
        <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
          {row.return_number} · {row.branch_name} · {row.date}
        </p>
        <div style={{ marginTop: 12, padding: '10px 12px', background: '#f8fafc', borderRadius: 8, fontSize: 13 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Items</span><strong>{(row.items || []).length}</strong></div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Estimated value</span><strong>{fmtMoney(row.est_value)}</strong></div>
        </div>
        {isConfirm ? (
          <div style={{ marginTop: 12, padding: '10px 12px', background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 6, fontSize: 12, color: '#065f46' }}>
            On confirm: <strong>{row.branch_name}</strong> sales-floor stock will decrement and the damages cost will land on the day's Profit Report.
          </div>
        ) : (
          <div style={{ marginTop: 12, padding: '10px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12, color: '#991b1b' }}>
            <FiAlertTriangle /> Rejecting marks this declaration as REJECTED. Branch will see your reason and can re-declare if needed. No stock moves.
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <label style={lbl}>{isConfirm ? 'Note (optional)' : 'Reason *'}</label>
          <input type="text" value={notes}
            onChange={e => setState(s => ({ ...s, notes: e.target.value }))}
            placeholder={isConfirm ? 'Verified with photos' : 'Recount needed — qty looks wrong'}
            style={inp} autoFocus />
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button onClick={onCancel} disabled={submitting}
            style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={onSubmit} disabled={submitting || (!isConfirm && !notes.trim())}
            style={{ flex: 1, padding: '12px',
                     background: submitting ? '#94a3b8'
                                : isConfirm ? 'linear-gradient(135deg,#16a34a,#15803d)'
                                            : 'linear-gradient(135deg,#dc2626,#991b1b)',
                     color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
            {submitting ? 'Working…' : isConfirm ? 'Confirm Damage' : 'Reject'}
          </button>
        </div>
      </div>
    </div>
  );
}

const btn = (color, outline) => ({
  padding: '8px 14px', background: outline ? '#fff' : color, color: outline ? color : '#fff',
  border: outline ? `1px solid ${color}` : 'none', borderRadius: 6,
  cursor: 'pointer', fontSize: 13, fontWeight: 600,
  display: 'inline-flex', alignItems: 'center', gap: 4,
});
const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inp = { width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '8px 10px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '6px 10px', color: '#0f172a' };
