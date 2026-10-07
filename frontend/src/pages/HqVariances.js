// HQ Transit Variances — unified view of shortages / damages / losses
// from both Inter-Branch Transfers and HQ Purchases (dropshipped to
// branches). HQ uses this to investigate gaps and write off / mark
// recovered.
//
// Routes consumed: GET /api/hq/variances, PUT /api/hq/variances/transfer/:syncId/resolve
//
// Branch user shouldn't see this page — it's gated to HQ host in the
// sidebar / route.
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiAlertTriangle, FiCheckCircle, FiInbox, FiTruck, FiShoppingCart } from 'react-icons/fi';
import { getHqVariances, resolveTransferVariance } from '../services/api';

const REASONS = ['', 'Short', 'Damaged', 'Lost'];
const SOURCES = [
  { value: '', label: 'All sources' },
  { value: 'TRANSFER', label: 'Inter-Branch Transfer' },
  { value: 'HQ_PURCHASE', label: 'HQ Purchase' },
];

const fmtQ = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function HqVariances() {
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState({ total: 0, open: 0, short: 0, damaged: 0, lost: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({ source: '', reason: '', status: 'OPEN' });
  const [resolving, setResolving] = useState(null); // { variance, resolution, notes }

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (filters.source) params.source = filters.source;
      if (filters.reason) params.reason = filters.reason;
      if (filters.status) params.status = filters.status;
      const r = await getHqVariances(params);
      setRows(Array.isArray(r.data?.variances) ? r.data.variances : []);
      setStats(r.data?.stats || { total: 0, open: 0, short: 0, damaged: 0, lost: 0 });
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Failed to load variances');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filters.source, filters.reason, filters.status]);

  const handleResolve = async () => {
    if (!resolving) return;
    // v1.13.47 — Option C: WRITE_OFF must pick an absorbing branch.
    if (resolving.resolution === 'WRITE_OFF' && !resolving.absorbed_by) {
      alert('Pick which branch absorbs the loss (Sender or Receiver) before confirming.');
      return;
    }
    try {
      await resolveTransferVariance(resolving.variance.sync_id, {
        resolution: resolving.resolution,
        absorbed_by: resolving.resolution === 'WRITE_OFF' ? resolving.absorbed_by : null,
        notes: resolving.notes || null,
      });
      setResolving(null);
      load();
    } catch (e) {
      alert(e?.response?.data?.error || 'Failed to resolve');
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Transit Variances</h1>
          <p>Shortages, damages, and losses across Inter-Branch Transfers and HQ Purchases</p>
        </div>
        <button onClick={load}
          style={{ padding: '8px 14px', background: '#f1f5f9', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> Refresh
        </button>
      </div>

      {/* Stat strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 16 }}>
        <Stat label="Total"    value={stats.total}    color="#0f172a" />
        <Stat label="Open"     value={stats.open}     color="#d97706" />
        <Stat label="Short"    value={stats.short}    color="#b45309" />
        <Stat label="Damaged"  value={stats.damaged}  color="#dc2626" />
        <Stat label="Lost"     value={stats.lost}     color="#7c3aed" />
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <FilterSelect label="Source" value={filters.source}
          options={SOURCES}
          onChange={v => setFilters(f => ({ ...f, source: v }))} />
        <FilterSelect label="Reason" value={filters.reason}
          options={REASONS.map(r => ({ value: r, label: r || 'Any' }))}
          onChange={v => setFilters(f => ({ ...f, reason: v }))} />
        <FilterSelect label="Status" value={filters.status}
          options={[{ value: '', label: 'All' }, { value: 'OPEN', label: 'Open' }, { value: 'RESOLVED', label: 'Resolved' }]}
          onChange={v => setFilters(f => ({ ...f, status: v }))} />
      </div>

      {error && (
        <div style={{ padding: 12, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 14 }}>
          {error}
        </div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {loading && rows.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>
            <FiInbox size={36} style={{ marginBottom: 8, opacity: 0.4 }} />
            <p style={{ fontStyle: 'italic' }}>No variances match the current filter.</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Source</th>
                  <th style={th}>Reference</th>
                  <th style={th}>From → To</th>
                  <th style={th}>Product</th>
                  <th style={{ ...th, textAlign: 'right' }}>Sent</th>
                  <th style={{ ...th, textAlign: 'right' }}>Received</th>
                  <th style={{ ...th, textAlign: 'right' }}>Variance</th>
                  <th style={th}>Reason</th>
                  <th style={th}>Notes</th>
                  <th style={th}>Reported</th>
                  <th style={th}>By</th>
                  <th style={th}>Status</th>
                  <th style={{ ...th, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v, idx) => {
                  const isTransfer = v.source === 'TRANSFER';
                  const reasonColor = v.reason === 'Damaged' ? '#dc2626'
                                    : v.reason === 'Lost'    ? '#7c3aed'
                                    : v.reason === 'Short'   ? '#b45309' : '#16a34a';
                  return (
                    <tr key={v.source + '-' + v.id + '-' + idx} style={{ borderTop: '1px solid #f1f5f9', background: v.resolved_at ? '#f9fafb' : '#fff' }}>
                      <td style={td}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, background: isTransfer ? '#dbeafe' : '#ede9fe', color: isTransfer ? '#1e40af' : '#6d28d9' }}>
                          {isTransfer ? <FiTruck size={11} /> : <FiShoppingCart size={11} />}
                          {isTransfer ? 'Transfer' : 'HQ Purchase'}
                        </span>
                      </td>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>{v.transfer_number || '—'}</td>
                      <td style={td}>
                        <strong>{v.from_slug}</strong> → <strong>{v.to_slug}</strong>
                      </td>
                      <td style={{ ...td, fontWeight: 600 }}>{v.product_name}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtQ(v.sent_qty)} {v.unit || ''}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{fmtQ(v.received_qty)} {v.unit || ''}</td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: '#b45309' }}>
                        {v.variance_qty > 0 ? `−${fmtQ(v.variance_qty)} ${v.unit || ''}` : '—'}
                      </td>
                      <td style={td}>
                        <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, color: reasonColor, background: reasonColor + '22' }}>
                          {v.reason}
                        </span>
                      </td>
                      <td style={{ ...td, color: '#475569', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v.notes}>
                        {v.notes || '—'}
                      </td>
                      <td style={{ ...td, color: '#64748b', fontSize: 11 }}>
                        {v.created_at ? new Date(v.created_at).toLocaleString() : '—'}
                      </td>
                      <td style={{ ...td, color: '#64748b', fontSize: 11 }}>{v.received_by_name || '—'}</td>
                      <td style={td}>
                        {v.resolved_at ? (
                          <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, background: '#dcfce7', color: '#166534' }}>
                            {v.resolution || 'RESOLVED'}
                          </span>
                        ) : (
                          <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, background: '#fef3c7', color: '#92400e' }}>OPEN</span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        {/* Resolve only available for transfer variances (HQ purchases
                            don't have a resolution column yet — could be added later). */}
                        {isTransfer && !v.resolved_at && (
                          <button onClick={() => setResolving({ variance: v, resolution: 'WRITE_OFF', notes: '' })}
                            style={{ padding: '4px 10px', background: '#fff', color: '#0369a1', border: '1px solid #bae6fd', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <FiCheckCircle size={11} /> Resolve
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Resolve modal */}
      {resolving && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }} onClick={() => setResolving(null)}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 12, width: 'min(480px, 96vw)', padding: 22 }}>
            <h3 style={{ margin: '0 0 6px 0', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <FiAlertTriangle color="#d97706" /> Resolve Variance
            </h3>
            <p style={{ margin: 0, fontSize: 13, color: '#64748b' }}>
              <strong>{resolving.variance.product_name}</strong> · {resolving.variance.reason} · −{fmtQ(resolving.variance.variance_qty)} {resolving.variance.unit}
            </p>
            <p style={{ margin: '4px 0 14px', fontSize: 12, color: '#475569' }}>
              {resolving.variance.from_slug} → {resolving.variance.to_slug} · {resolving.variance.transfer_number}
            </p>

            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Resolution</label>
              <div style={{ display: 'flex', gap: 10 }}>
                <label style={{ flex: 1, padding: 10, border: `2px solid ${resolving.resolution === 'WRITE_OFF' ? '#dc2626' : '#e5e7eb'}`, borderRadius: 6, cursor: 'pointer', background: resolving.resolution === 'WRITE_OFF' ? '#fef2f2' : '#fff' }}>
                  <input type="radio" checked={resolving.resolution === 'WRITE_OFF'} onChange={() => setResolving(r => ({ ...r, resolution: 'WRITE_OFF' }))} />
                  &nbsp;<strong>Write off</strong>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Accept the loss — branch absorbs it.</div>
                </label>
                <label style={{ flex: 1, padding: 10, border: `2px solid ${resolving.resolution === 'RECOVERED' ? '#16a34a' : '#e5e7eb'}`, borderRadius: 6, cursor: 'pointer', background: resolving.resolution === 'RECOVERED' ? '#f0fdf4' : '#fff' }}>
                  <input type="radio" checked={resolving.resolution === 'RECOVERED'} onChange={() => setResolving(r => ({ ...r, resolution: 'RECOVERED' }))} />
                  &nbsp;<strong>Recovered</strong>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Stock was found / returned later.</div>
                </label>
              </div>
            </div>

            {/* v1.13.47 — Option C: on Write off, HQ picks who absorbs the
                loss so the backend can post a damage entry against that
                branch's daily profit. Recovered skips this — no P&L hit. */}
            {resolving.resolution === 'WRITE_OFF' && (
              <div style={{ marginBottom: 12 }}>
                <label style={lbl}>Who absorbs the loss?</label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <label style={{ flex: 1, padding: 10, border: `2px solid ${resolving.absorbed_by === 'source' ? '#0369a1' : '#e5e7eb'}`, borderRadius: 6, cursor: 'pointer', background: resolving.absorbed_by === 'source' ? '#eff6ff' : '#fff' }}>
                    <input type="radio" checked={resolving.absorbed_by === 'source'} onChange={() => setResolving(r => ({ ...r, absorbed_by: 'source' }))} />
                    &nbsp;<strong>Sender</strong>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{resolving.variance.from_slug} — hit their profit.</div>
                  </label>
                  <label style={{ flex: 1, padding: 10, border: `2px solid ${resolving.absorbed_by === 'destination' ? '#0369a1' : '#e5e7eb'}`, borderRadius: 6, cursor: 'pointer', background: resolving.absorbed_by === 'destination' ? '#eff6ff' : '#fff' }}>
                    <input type="radio" checked={resolving.absorbed_by === 'destination'} onChange={() => setResolving(r => ({ ...r, absorbed_by: 'destination' }))} />
                    &nbsp;<strong>Receiver</strong>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{resolving.variance.to_slug} — hit their profit.</div>
                  </label>
                </div>
              </div>
            )}

            <div style={{ marginBottom: 12 }}>
              <label style={lbl}>Notes (optional)</label>
              <input type="text" value={resolving.notes}
                onChange={e => setResolving(r => ({ ...r, notes: e.target.value }))}
                placeholder="Why this resolution?"
                style={inp} />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setResolving(null)}
                style={{ padding: '8px 18px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
                Cancel
              </button>
              <button onClick={handleResolve}
                style={{ padding: '8px 22px', background: '#0369a1', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700 }}>
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12 }}>
      <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function FilterSelect({ label, value, options, onChange }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#64748b', fontWeight: 600 }}>
      {label}:
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ padding: '5px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff' }}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

const th = { padding: '8px 10px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4 };
const td = { padding: '8px 10px', color: '#0f172a' };
const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' };
