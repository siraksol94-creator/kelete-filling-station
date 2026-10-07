// HqOverview â€” head-office single-page summary across every registered
// branch. Only useful when served from the bare HQ host (keletezm.com);
// on a per-branch subdomain the sidebar hides this entry. The page reads
// from /api/hq/overview, which loops over each tenant DB and aggregates.
//
// Each card jumps the user into the matching branch â€” clicking "Open"
// sets the HQ branch + reloads so the rest of the app operates on that
// branch's DB. No re-auth here (that's only enforced when the user
// actively switches via the sidebar's Active Branch dropdown).
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FiRefreshCw, FiTrendingUp, FiDollarSign, FiPackage,
  FiAlertTriangle, FiArrowRight,
} from 'react-icons/fi';
import { getHqOverview, setHqBranch } from '../services/api';

const fmtMoney = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt   = (n) => parseFloat(n || 0).toLocaleString();

export default function HqOverview() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // 2026-09-12 â€” branches whose full figures are open on a phone. Desks
  // always see every figure; the toggle is hidden above 768 px.
  const [openSlugs, setOpenSlugs] = useState(() => new Set());
  const toggleBranch = (slug) => setOpenSlugs(prev => {
    const next = new Set(prev);
    if (next.has(slug)) next.delete(slug); else next.add(slug);
    return next;
  });

  // 2026-09-13 â€” Sync Products to All moved to Item Details, where products
  // are managed (components/MirrorResultModal.js carries its summary).

  const load = async () => {
    setError('');
    try {
      const res = await getHqOverview();
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load overview');
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  const openBranch = (slug) => {
    setHqBranch(slug);
    // Hard reload so every page re-fetches its data via the new X-Branch.
    window.location.href = '/dashboard';
  };

  return (
    <div className="page-content">
      <div className="page-header desk-only">
        <div>
          <h1>HQ Overview</h1>
          <p>Live snapshot across all branches</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading && !data ? (
        <p style={{ color: '#64748b' }}>Loading overviewâ€¦</p>
      ) : data && (() => {
        // Defensive: backend may return without rollup (transient API
        // error, mid-render race, or older endpoint version). Use a
        // zeroed default rather than crashing the whole page. v1.3.13.
        const rollup = data.rollup || {};
        return (
        <>
          {/* Roll-up row */}
          <div className="tiles-2up" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 22 }}>
            <RollupCard icon={<FiTrendingUp />} label="Today's Revenue" value={fmtMoney(rollup.today_revenue)} sub={`${fmtInt(rollup.today_orders)} orders`} color="#0ea5e9" />
            <RollupCard icon={<FiTrendingUp />} label="Month-to-Date"     value={fmtMoney(rollup.mtd_revenue)}   sub={`${fmtInt(rollup.mtd_orders)} orders`}   color="#6366f1" />
            <RollupCard icon={<FiPackage />}    label="Stock Value"       value={fmtMoney(rollup.stock_value)}   sub="At cost, all branches"  color="#0f766e" />
            {/* 2026-09-13 â€” Awaiting Payment / Awaiting Dispatch removed from the
                roll-up at HQ's request. Four tiles now: Today, MTD, Stock Value
                and AR, which make a full two-by-two on a phone too. */}
            <RollupCard icon={<FiDollarSign />} label="AR Outstanding"    value={fmtMoney(rollup.ar_outstanding)} sub="Unpaid by customers"   color="#dc2626" />
          </div>

          {/* 2026-09-12 â€” phone, as designed: one row per branch with today's
              takings and a low-stock badge. Tapping a row opens its figures
              and the Open button. */}
          <div className="phone-only">
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: '#5b6478', margin: '0 0 8px' }}>Branches Â· today</div>
            {(data.branches || []).map(b => {
              const open = openSlugs.has(b.slug);
              const low = b.error ? 0 : (parseFloat(b.stock_low_count) || 0);
              return (
                <div key={b.slug} style={{ background: '#fff', border: '1px solid #e2e6ee', borderRadius: 12, padding: '10px 12px', marginBottom: 8 }}>
                  <div role="button" tabIndex={0} onClick={() => toggleBranch(b.slug)}
                    onKeyDown={e => { if (e.key === 'Enter') toggleBranch(b.slug); }}
                    style={{ cursor: 'pointer' }}>
                    <div className="nowrap-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                      <span style={{ fontWeight: 700, fontSize: 13.5, color: '#0f172a', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortBranch(b.name, b.slug)}</span>
                      <span style={{ fontWeight: 700, fontSize: 13, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{b.error ? 'â€”' : fmtMoney(b.today.revenue)}</span>
                    </div>
                    <div className="nowrap-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 3 }}>
                      <span style={{ fontSize: 11.5, color: b.error ? '#b91c1c' : '#5b6478', minWidth: 0 }}>
                        {b.error ? b.error : `${fmtInt(b.today.orders)} orders`}
                        {low > 0 && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 800, padding: '1px 7px', borderRadius: 999, background: '#fdecec', color: '#9b0008' }}>{fmtInt(low)} low</span>}
                      </span>
                      <span style={{ color: '#94a3b8', fontSize: 14 }}>{open ? 'â–¾' : 'â€º'}</span>
                    </div>
                  </div>
                  {open && !b.error && (
                    <>
                      <div className="tiles-2up" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 10 }}>
                        <Metric label="MTD" value={fmtMoney(b.mtd.revenue)} sub={`${b.mtd.orders} orders`} />
                        <Metric label="Stock Value" value={fmtMoney(b.stock_value)} />
                        {b.workflow_mode === 'three_station' && (
                          <>
                            <Metric label="Awaiting Payment"  value={fmtInt(b.pending_payment)}   warn={b.pending_payment > 0} />
                            <Metric label="Awaiting Dispatch" value={fmtInt(b.awaiting_dispatch)} warn={b.awaiting_dispatch > 0} />
                          </>
                        )}
                        <Metric label="Low Stock" value={fmtInt(b.stock_low_count)} warn={b.stock_low_count > 0} />
                        <Metric label="AR Open"   value={fmtMoney(b.ar_outstanding)} warn={b.ar_outstanding > 0.001} />
                      </div>
                      <button onClick={() => openBranch(b.slug)}
                        style={{ width: '100%', marginTop: 8, padding: '8px 10px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, fontSize: 12.5, fontWeight: 700 }}>
                        Open {shortBranch(b.name, b.slug)} <FiArrowRight size={12} />
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Per-branch cards */}
          <h3 className="desk-only" style={{ margin: '0 0 10px 0', fontSize: 15, color: '#0f172a' }}>Branches</h3>
          <div className="desk-only" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
            {(data.branches || []).map(b => (
              <div key={b.slug} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
                    <h4 style={{ margin: '0 0 2px 0', fontSize: 16, color: '#0f172a' }}>{b.name}</h4>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <span style={tagStyle('#e2e8f0', '#0f172a')}>{b.slug}</span>
                      {b.currency_mode === 'USD+FRA' && <span style={tagStyle('#fef3c7', '#92400e')}>Dual currency</span>}
                      {b.workflow_mode === 'three_station' && <span style={tagStyle('#dbeafe', '#1e40af')}>3-station</span>}
                    </div>
                  </div>
                  <button onClick={() => openBranch(b.slug)}
                    style={{ padding: '6px 10px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}>
                    Open <FiArrowRight size={12} />
                  </button>
                </div>

                {b.error ? (
                  <div style={{ padding: 10, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 6, fontSize: 12 }}>
                    <FiAlertTriangle style={{ verticalAlign: 'middle', marginRight: 4 }} /> {b.error}
                  </div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <Metric label="Today" value={fmtMoney(b.today.revenue)} sub={`${b.today.orders} orders`} />
                    <Metric label="MTD"   value={fmtMoney(b.mtd.revenue)}   sub={`${b.mtd.orders} orders`} />
                    {b.workflow_mode === 'three_station' && (
                      <>
                        <Metric label="Awaiting Payment"  value={fmtInt(b.pending_payment)}   warn={b.pending_payment > 0} />
                        <Metric label="Awaiting Dispatch" value={fmtInt(b.awaiting_dispatch)} warn={b.awaiting_dispatch > 0} />
                      </>
                    )}
                    <Metric label="Stock Value" value={fmtMoney(b.stock_value)} />
                    <Metric label="Low Stock"   value={fmtInt(b.stock_low_count)} warn={b.stock_low_count > 0} />
                    <Metric label="AR Open"     value={fmtMoney(b.ar_outstanding)} warn={b.ar_outstanding > 0.001} fullRow />
                  </div>
                )}
              </div>
            ))}
          </div>

          {data.as_of && (
            <p style={{ marginTop: 18, fontSize: 11, color: '#94a3b8' }}>
              Snapshot taken {new Date(data.as_of).toLocaleString()} Â· auto-refresh every 30s
            </p>
          )}
        </>
        );
      })()}
    </div>
  );
}

// "Kelete Distribution - BANKERS (KABWE)" â†’ "Bankers (Kabwe)", for the phone rows.
function shortBranch(name, slug) {
  const tail = String(name || slug || '').split(/\s+-\s+/).pop();
  return tail.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function RollupCard({ icon, label, value, sub, color, className }) {
  return (
    <div className={className} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color, fontSize: 12, fontWeight: 600 }}>
        {icon} <span>{label}</span>
      </div>
      <div className="tile-value" style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

function Metric({ label, value, sub, warn, fullRow, className }) {
  return (
    <div className={className} style={{ background: '#f8fafc', border: '1px solid #f1f5f9', borderRadius: 8, padding: '8px 10px', gridColumn: fullRow ? '1 / -1' : 'auto' }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color: warn ? '#b91c1c' : '#0f172a', marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

const tagStyle = (bg, fg) => ({
  background: bg, color: fg, fontSize: 10, fontWeight: 700,
  padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4,
});

