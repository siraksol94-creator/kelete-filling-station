// HqConsolidatedProfit — group net profit rolled up across every Kelete
// branch. Kelete is K-only across every branch, so there's no fx
// conversion (contrast Kelete, which needs Kassumbalesa's USD/K rate).
// HQ overhead is SUM(payment_vouchers.amount); Kelete has no LCV
// concept so no exclusion is applied.
//
// Only useful on the bare HQ host (keletezm.com). The
// sidebar entry lives under the Accounting group next to Profit Report.
//
// v1.13.62 — new page (Kelete's HqConsolidatedProfit ported, K-only).
import React, { useEffect, useMemo, useState } from 'react';
import { FiRefreshCw, FiChevronRight, FiChevronDown } from 'react-icons/fi';
import { getHqConsolidatedProfit } from '../services/api';

const fmtK       = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const fmtSign    = (n) => (parseFloat(n || 0) < 0 ? '−' : '');
const firstOfMonthISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};
const todayISO = () => new Date().toISOString().slice(0, 10);

export default function HqConsolidatedProfit() {
  const [from, setFrom] = useState(firstOfMonthISO());
  const [to,   setTo]   = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [expanded, setExpanded] = useState({});

  const load = async () => {
    setLoading(true); setError('');
    try {
      const res = await getHqConsolidatedProfit({ from, to });
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load consolidated profit');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const branchNetTotal = useMemo(() => {
    if (!data?.branches) return 0;
    return data.branches.reduce((s, b) => s + parseFloat(b.totals.net || 0), 0);
  }, [data]);

  const toggle = (slug) => setExpanded(e => ({ ...e, [slug]: !e[slug] }));

  const groupNet = parseFloat(data?.group_net || 0);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ Consolidated Profit</h1>
          <p>Group net profit across every branch, in K · HQ overhead = payment vouchers</p>
        </div>
      </div>

      {/* Filters */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 14, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
        <Field label="From">
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        </Field>
        <div style={{ flex: 1 }} />
        <button
          onClick={load}
          disabled={loading}
          style={{ padding: '9px 16px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <FiRefreshCw /> {loading ? 'Loading…' : 'Run'}
        </button>
      </div>

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {data && (
        <>
          {/* Headline tile */}
          <div style={{ background: 'linear-gradient(135deg,#075985,#0369a1)', color: '#fff', borderRadius: 12, padding: '22px 24px', marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, opacity: 0.8, fontWeight: 700 }}>Group Net Profit</div>
              <div style={{ fontSize: 30, fontWeight: 800, marginTop: 2 }}>{fmtSign(groupNet)}{fmtK(Math.abs(groupNet))}</div>
              <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                Branch Net {fmtK(branchNetTotal)} − HQ Overhead {fmtK(data.hq_overhead?.total)}
              </div>
            </div>
            <div style={{ textAlign: 'right', fontSize: 11, opacity: 0.85 }}>
              <div>{data.from} → {data.to}</div>
              <div style={{ marginTop: 4 }}>Reporting currency: {data.reporting_currency}</div>
            </div>
          </div>

          {/* Main table */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f9fafb' }}>
                <tr>
                  <th style={{ ...th, width: 32 }} />
                  <th style={th}>Branch</th>
                  <th style={{ ...th, textAlign: 'right' }}>Revenue</th>
                  <th style={{ ...th, textAlign: 'right' }}>COGS</th>
                  <th style={{ ...th, textAlign: 'right' }}>Gross Profit</th>
                  <th style={{ ...th, textAlign: 'right' }}>Expenses (PV)</th>
                  <th style={{ ...th, textAlign: 'right' }}>Net</th>
                </tr>
              </thead>
              <tbody>
                {data.branches.map(b => {
                  const isOpen = !!expanded[b.slug];
                  return (
                    <React.Fragment key={b.slug}>
                      <tr
                        style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }}
                        onClick={() => toggle(b.slug)}
                      >
                        <td style={{ ...td, textAlign: 'center', color: '#0ea5e9' }}>
                          {isOpen ? <FiChevronDown /> : <FiChevronRight />}
                        </td>
                        <td style={{ ...td, fontWeight: 700 }}>{b.name}</td>
                        <td style={numTd}>{fmtK(b.totals.revenue)}</td>
                        <td style={numTd}>{fmtK(b.totals.cogs)}</td>
                        <td style={{ ...numTd, color: parseFloat(b.totals.gross) >= 0 ? '#047857' : '#b91c1c' }}>{fmtK(b.totals.gross)}</td>
                        <td style={{ ...numTd, color: '#b45309' }}>{fmtK(b.totals.pv)}</td>
                        <td style={{ ...numTd, fontWeight: 700, color: b.totals.net >= 0 ? '#047857' : '#b91c1c' }}>{fmtSign(b.totals.net)}{fmtK(Math.abs(b.totals.net))}</td>
                      </tr>
                      {isOpen && b.daily
                        .filter(d => (d.revenue || d.cogs || d.gross || d.pv || d.net))
                        .map(d => (
                        <tr key={`${b.slug}-${d.date}`} style={{ background: '#fafafa', borderBottom: '1px solid #f3f4f6' }}>
                          <td />
                          <td style={{ ...td, paddingLeft: 32, color: '#6b7280', fontFamily: 'monospace', fontSize: 12 }}>{d.date}</td>
                          <td style={{ ...numTd, color: '#6b7280' }}>{fmtK(d.revenue)}</td>
                          <td style={{ ...numTd, color: '#6b7280' }}>{fmtK(d.cogs)}</td>
                          <td style={{ ...numTd, color: parseFloat(d.gross) >= 0 ? '#047857' : '#b91c1c' }}>{fmtK(d.gross)}</td>
                          <td style={{ ...numTd, color: '#b45309' }}>{fmtK(d.pv)}</td>
                          <td style={{ ...numTd, color: '#374151' }}>{fmtSign(d.net)}{fmtK(Math.abs(d.net))}</td>
                        </tr>
                      ))}
                    </React.Fragment>
                  );
                })}
                {/* Sub-totals row */}
                <tr style={{ background: '#f9fafb', borderTop: '2px solid #e5e7eb' }}>
                  <td />
                  <td style={{ ...td, fontWeight: 700, color: '#0f172a' }}>Branch Net Total</td>
                  <td colSpan={4} />
                  <td style={{ ...numTd, fontWeight: 800, color: '#047857' }}>{fmtSign(branchNetTotal)}{fmtK(Math.abs(branchNetTotal))}</td>
                </tr>
                {/* HQ overhead row */}
                <tr style={{ borderTop: '1px solid #e5e7eb' }}>
                  <td />
                  <td style={{ ...td, color: '#b91c1c', fontWeight: 700 }}>
                    HQ Overhead <span style={{ fontWeight: 400, fontSize: 11, color: '#6b7280' }}>(Payment Vouchers)</span>
                  </td>
                  <td colSpan={4} />
                  <td style={{ ...numTd, color: '#b91c1c', fontWeight: 700 }}>−{fmtK(data.hq_overhead?.total)}</td>
                </tr>
              </tbody>
              <tfoot>
                <tr style={{ background: '#ecfdf5', borderTop: '2px solid #059669' }}>
                  <td />
                  <td style={{ ...td, fontWeight: 800, fontSize: 15, color: '#065f46' }}>Group Net Profit</td>
                  <td colSpan={4} />
                  <td style={{ ...numTd, fontWeight: 800, fontSize: 16, color: groupNet >= 0 ? '#065f46' : '#b91c1c' }}>
                    {fmtSign(groupNet)}{fmtK(Math.abs(groupNet))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div style={{ marginTop: 10, fontSize: 11, color: '#6b7280', lineHeight: 1.55 }}>
            Click a branch row to expand daily rows. Days with no activity are hidden inside the drilldown.
          </div>
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

const inp   = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', minWidth: 160 };
const th    = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td    = { padding: '10px 12px', color: '#0f172a' };
const numTd = { ...td, textAlign: 'right', fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace', fontSize: 12.5 };
