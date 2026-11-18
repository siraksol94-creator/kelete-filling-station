// HqRouteSales — route selling across every depot.
//
// 2026-09-15. A route seller is a depot user ticked "Route seller" in
// Users → Edit; every sale under their login is route selling. Stock and cash
// stay with the depot, so this page only splits each depot's sales into the
// depot's own and its route sellers', with each seller's sales listed.
//
// Filters: date-from, date-to, depot. Backend: GET /api/hq/route-sales.
import React, { useEffect, useMemo, useState } from 'react';
import { FiRefreshCw } from 'react-icons/fi';
import { getHqRouteSales, getHqBranches } from '../services/api';
import ExportButtons from '../components/ExportButtons';

const fmtMoney = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt   = (n) => parseFloat(n || 0).toLocaleString();
const todayISO = () => new Date().toISOString().slice(0, 10);

const NAVY = '#13306b';
const NAVY_DEEP = '#0b1f4a';
const AMBER = '#b45309';

// "Kelete Distribution - BANKERS (KABWE)" → "Bankers (Kabwe)"
const shortName = (name, slug) => String(name || slug || '')
  .split(/\s+-\s+/).pop()
  .toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

export default function HqRouteSales() {
  const [from, setFrom]     = useState(todayISO());
  const [to, setTo]         = useState(todayISO());
  const [branch, setBranch] = useState('all');
  const [branches, setBranches] = useState([]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    getHqBranches().then(r => setBranches(r.data?.branches || [])).catch(() => {});
  }, []);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await getHqRouteSales({ from, to, branch });
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load report');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const t = data?.totals || { revenue: 0, route_revenue: 0, depot_revenue: 0, route_orders: 0, route_cash: 0, route_credit: 0, sellers: 0 };
  const depots = data?.depots || [];
  // 2026-09-15 — route selling only: depots without route sellers are not shown,
  // and a depot's own sales are not shown anywhere on this page.
  const shown = depots.filter(d => d.sellers.length > 0);

  const exportRows = useMemo(() => depots.flatMap(d => d.sellers.map(s => ({
    depot: shortName(d.name, d.slug), seller: s.name, phone: s.phone || '',
    orders: s.orders, revenue: s.revenue, cash_sales: s.cash_sales, credit_sales: s.credit_sales,
  }))), [depots]);

  return (
    <div className="page-content">
      <div className="page-header desk-only">
        <div>
          <h1>HQ Route Selling</h1>
          <p>Sales made by route sellers, per depot — tick a user as Route seller in the depot's Users page</p>
        </div>
      </div>

      {/* ── Filters ──────────────────────────────────────────────────── */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, marginBottom: 16, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <Field label="From">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        </Field>
        <Field label="Depot">
          <select value={branch} onChange={e => setBranch(e.target.value)} style={inp}>
            <option value="all">All depots</option>
            {branches.map(b => <option key={b.slug} value={b.slug}>{shortName(b.name, b.slug)}</option>)}
          </select>
        </Field>
        <button onClick={load} disabled={loading}
          style={{ padding: '9px 18px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, cursor: loading ? 'wait' : 'pointer', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> {loading ? 'Loading…' : 'Run'}
        </button>
        <div style={{ flex: 1 }} />
        <ExportButtons
          rows={exportRows}
          filename={`hq-route-selling_${from}_to_${to}`}
          sheetName="RouteSelling"
          columns={[
            { key: 'depot',   label: 'Depot' },
            { key: 'seller',  label: 'Route seller' },
            { key: 'phone',   label: 'Phone' },
            { key: 'orders',  label: 'Sales' },
            { key: 'revenue', label: 'Total (K)',  format: v => Number(v || 0).toFixed(2) },
            { key: 'cash_sales',   label: 'Cash (K)',   format: v => Number(v || 0).toFixed(2) },
            { key: 'credit_sales', label: 'Credit (K)', format: v => Number(v || 0).toFixed(2) },
          ]}
          pdfOptions={{ title: 'HQ Route Selling', subtitle: `${from} → ${to} · ${branch === 'all' ? 'all depots' : branch}` }}
        />
      </div>

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading && !data && <p style={{ color: '#64748b' }}>Loading…</p>}

      {data && (
        <>
          {/* ── Totals ───────────────────────────────────────────────── */}
          <div className="tiles-2up" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 18 }}>
            <div style={{ background: `linear-gradient(150deg, ${NAVY_DEEP}, ${NAVY})`, color: '#fff', borderRadius: 14, padding: '14px 16px' }}>
              <div style={kLbl('rgba(255,255,255,0.75)')}>Route sales</div>
              <div className="tile-value" style={{ fontSize: 24, fontWeight: 800, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(t.route_revenue)}</div>
              <div style={{ fontSize: 11.5, opacity: 0.8, marginTop: 2 }}>
                {data.from === data.to ? data.from : `${data.from} → ${data.to}`}
              </div>
            </div>
            <div style={card}>
              <div style={kLbl('#64748b')}>Route cash / credit</div>
              <div className="tile-value" style={{ fontSize: 20, fontWeight: 800, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ color: '#15803d' }}>{fmtMoney(t.route_cash)}</span>
              </div>
              <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 2 }}>credit <b style={{ color: AMBER }}>{fmtMoney(t.route_credit)}</b></div>
            </div>
            <div style={card}>
              <div style={kLbl('#64748b')}>Route sellers</div>
              <div className="tile-value" style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', marginTop: 4 }}>{fmtInt(t.sellers)}</div>
              <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 2 }}>{fmtInt(t.route_orders)} sales · {fmtInt(shown.length)} depot{shown.length === 1 ? '' : 's'}</div>
            </div>
          </div>

          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: '#5b6478', margin: '0 0 10px' }}>
            Route sellers by depot
          </div>

          {shown.length === 0 ? (
            <div style={{ ...card, color: '#64748b', fontSize: 13.5 }}>
              No route sellers yet. In a depot's <b>Users</b> page, open <b>Edit</b> on the seller and tick <b>Route seller</b>.
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
              {shown.map(d => {
                return (
                  <div key={d.slug} style={{ ...card, padding: 0, overflow: 'hidden' }}>
                    <div style={{ padding: '12px 14px', borderBottom: '1px solid #eef2f7' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontWeight: 800, fontSize: 15, color: '#0f172a' }}>{shortName(d.name, d.slug)}</span>
                        <span style={{ fontSize: 17, fontWeight: 800, color: NAVY, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(d.route_revenue)}</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 2 }}>
                        route sales · {fmtInt(d.route_orders)} sales{d.route_credit > 0.004 ? ` · ${fmtMoney(d.route_credit)} credit` : ''}
                      </div>
                    </div>
                    {d.sellers.length === 0 ? (
                      <div style={{ padding: '10px 14px', fontSize: 12.5, color: '#94a3b8', fontStyle: 'italic' }}>No route sellers</div>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                          <thead>
                            <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                              <th style={th}>Route seller</th>
                              <th style={{ ...th, textAlign: 'right' }}>Sales</th>
                              <th style={{ ...th, textAlign: 'right' }}>Total</th>
                              <th style={{ ...th, textAlign: 'right' }}>Credit</th>
                            </tr>
                          </thead>
                          <tbody>
                            {d.sellers.map(s => (
                              <tr key={s.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                                <td style={td}>
                                  <div style={{ fontWeight: 600, color: '#0f172a' }}>{s.name}</div>
                                  {s.phone && <div style={{ fontSize: 11.5, color: '#94a3b8' }}>{s.phone}</div>}
                                </td>
                                <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{fmtInt(s.orders)}</td>
                                <td style={{ ...td, textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(s.revenue)}</td>
                                <td style={{ ...td, textAlign: 'right', color: s.credit_sales > 0.004 ? AMBER : '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(s.credit_sales)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
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

const inp  = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, background: '#fff', minWidth: 160 };
const card = { background: '#fff', border: '1px solid #e2e6ee', borderRadius: 14, padding: '14px 16px' };
const kLbl = (color) => ({ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color });
const th = { textAlign: 'left', padding: '7px 14px', fontWeight: 700 };
const td = { padding: '8px 14px', verticalAlign: 'top' };
