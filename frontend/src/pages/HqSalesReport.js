// HqSalesReport â€” sales across every depot, as cards.
//
// 2026-09-13 â€” the order list is gone. It was most of the wait (up to 1,000
// order rows per depot, joined to users, drawn as a table) and its totals were
// added up from those capped rows, so a busy range read low. The page now asks
// the server for each depot's COUNT and SUM only: three total cards, then one
// tile per depot â€” the app-grid layout, in the Red Sea navy with the top three
// marked in red. A tile opens that depot's own Sales Report for the detail.
//
// Filters: date-from, date-to, depot. Backend: GET /api/hq/sales-report.
import React, { useEffect, useMemo, useState } from 'react';
import { FiRefreshCw } from 'react-icons/fi';
import { getHqSalesReport, getHqBranches, setHqBranch } from '../services/api';
import ExportButtons from '../components/ExportButtons';

const fmtMoney = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtInt   = (n) => parseFloat(n || 0).toLocaleString();
const todayISO = () => new Date().toISOString().slice(0, 10);

const NAVY = '#13306b';
const NAVY_DEEP = '#0b1f4a';
const RED = '#c8000a';

// "Kelete Distribution - BANKERS (KABWE)" â†’ "Bankers (Kabwe)"
const shortName = (name, slug) => String(name || slug || '')
  .split(/\s+-\s+/).pop()
  .toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

export default function HqSalesReport() {
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
      const res = await getHqSalesReport({ from, to, branch });
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load report');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  // Every depot in the range, busiest first; a depot with no sales still
  // gets a (quiet) tile, so "nothing sold" is visible rather than missing.
  const tiles = useMemo(() => {
    const byBranch = data?.totals?.by_branch || {};
    const total = Number(data?.totals?.revenue) || 0;
    return Object.entries(byBranch)
      .map(([slug, v]) => ({ slug, ...v, share: total > 0 ? (Number(v.revenue) || 0) / total : 0 }))
      .sort((a, b) => (b.revenue - a.revenue) || String(a.name).localeCompare(String(b.name)));
  }, [data]);

  const openDepot = (slug) => {
    setHqBranch(slug);
    window.location.href = '/pos/sales-report';
  };

  const t = data?.totals || { orders: 0, revenue: 0, cash_sales: 0, credit_sales: 0 };

  return (
    <div className="page-content">
      <div className="page-header desk-only">
        <div>
          <h1>HQ Sales Report</h1>
          <p>Sales across every depot â€” tap a depot for its orders</p>
        </div>
      </div>

      {/* â”€â”€ Filters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
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
          <FiRefreshCw /> {loading ? 'Loadingâ€¦' : 'Run'}
        </button>
        <div style={{ flex: 1 }} />
        <ExportButtons
          rows={tiles}
          filename={`hq-sales_${from}_to_${to}`}
          sheetName="HqSales"
          columns={[
            { key: 'name',     label: 'Depot' },
            { key: 'orders',   label: 'Orders' },
            { key: 'revenue',  label: 'Total Sales (K)', format: v => Number(v || 0).toFixed(2) },
            { key: 'cash_sales',   label: 'Cash Sales (K)',   format: v => Number(v || 0).toFixed(2) },
            { key: 'credit_sales', label: 'Credit Sales (K)', format: v => Number(v || 0).toFixed(2) },
            { key: 'share',    label: 'Share of sales',  format: v => `${(Number(v || 0) * 100).toFixed(1)}%` },
          ]}
          pdfOptions={{ title: 'HQ Sales Report', subtitle: `${from} â†’ ${to} Â· ${branch === 'all' ? 'all depots' : branch}` }}
        />
      </div>

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading && !data && <p style={{ color: '#64748b' }}>Loadingâ€¦</p>}

      {data && (
        <>
          {/* â”€â”€ Totals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
          <div className="tiles-2up" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 12, marginBottom: 18 }}>
            <div style={{ background: `linear-gradient(150deg, ${NAVY_DEEP}, ${NAVY})`, color: '#fff', borderRadius: 14, padding: '14px 16px' }}>
              <div style={kLbl('rgba(255,255,255,0.75)')}>Total sales</div>
              <div className="tile-value" style={{ fontSize: 24, fontWeight: 800, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(t.revenue)}</div>
              <div style={{ fontSize: 11.5, opacity: 0.8, marginTop: 2 }}>{data.from === data.to ? data.from : `${data.from} â†’ ${data.to}`}</div>
            </div>
            <div style={card}>
              <div style={kLbl('#64748b')}>Orders</div>
              <div className="tile-value" style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', marginTop: 4 }}>{fmtInt(t.orders)}</div>
              <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 2 }}>{fmtInt(tiles.filter(x => x.orders > 0).length)} depot{tiles.filter(x => x.orders > 0).length === 1 ? '' : 's'} selling</div>
            </div>
            {/* 2026-09-13 â€” Collected (cash handed over, change included) is gone.
                Cash sales + Credit sales = Total sales. */}
            <div style={card}>
              <div style={kLbl('#64748b')}>Cash sales</div>
              <div className="tile-value" style={{ fontSize: 24, fontWeight: 800, color: '#15803d', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(t.cash_sales)}</div>
              <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 2 }}>paid at the till Â· cash, MoMo, bank</div>
            </div>
            <div style={card}>
              <div style={kLbl('#64748b')}>Credit sales</div>
              <div className="tile-value" style={{ fontSize: 24, fontWeight: 800, color: '#b45309', marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(t.credit_sales)}</div>
              <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 2 }}>not paid at the till</div>
            </div>
          </div>

          {/* â”€â”€ One tile per depot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, textTransform: 'uppercase', color: '#5b6478', margin: '0 0 10px' }}>
            Depots Â· busiest first
          </div>
          {tiles.length === 0 ? (
            <p style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>No depots in this selection.</p>
          ) : (
            // 2026-09-18 â€” one depot per row on a phone: the tiles-2up class is
            // gone, so a card is no longer squeezed into half a screen with its
            // amount shrunk to 15px. Two or more per row on a laptop, as before.
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
              {tiles.map((d, i) => {
                const quiet = !(d.orders > 0);
                const top = !quiet && i < 3;
                return (
                  <button key={d.slug} type="button" onClick={() => openDepot(d.slug)}
                    title={`Open ${shortName(d.name, d.slug)}'s Sales Report`}
                    style={{
                      textAlign: 'left', cursor: 'pointer', font: 'inherit',
                      borderRadius: 14, padding: '12px 14px', minHeight: 132,
                      display: 'flex', flexDirection: 'column', gap: 6,
                      border: quiet ? '1px solid #e2e6ee' : 'none',
                      background: quiet ? '#fff' : `linear-gradient(150deg, ${NAVY_DEEP}, ${NAVY})`,
                      color: quiet ? '#64748b' : '#fff',
                      boxShadow: quiet ? 'none' : '0 4px 14px rgba(11,31,74,0.18)',
                    }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontWeight: 800, fontSize: 14, lineHeight: 1.2, color: quiet ? '#0f172a' : '#fff' }}>{shortName(d.name, d.slug)}</span>
                      {top && (
                        <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 999, background: RED, color: '#fff' }}>#{i + 1}</span>
                      )}
                    </div>
                    <div className="tile-value" style={{ fontSize: 19, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: quiet ? '#94a3b8' : '#fff' }}>
                      {fmtMoney(d.revenue)}
                    </div>
                    <div style={{ fontSize: 11.5, opacity: quiet ? 1 : 0.85 }}>
                      {quiet ? 'No sales'
                        : `${fmtInt(d.orders)} orders${d.credit_sales > 0.004 ? ` Â· ${fmtMoney(d.credit_sales)} credit` : ''}`}
                    </div>
                    <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 4, borderRadius: 4, background: quiet ? '#eef2f7' : 'rgba(255,255,255,0.18)', overflow: 'hidden' }}>
                        <div style={{ width: `${Math.round(d.share * 100)}%`, height: '100%', background: top ? RED : (quiet ? '#cbd5e1' : '#fff') }} />
                      </div>
                      <span style={{ fontSize: 10.5, fontWeight: 700, whiteSpace: 'nowrap' }}>{(d.share * 100).toFixed(1)}%</span>
                    </div>
                  </button>
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
