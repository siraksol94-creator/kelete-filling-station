// HqConsolidatedProfit — group profit across every Kelete branch, as
// Shop | Fuel | Station (decision 2026-11-20, same rules as the branch Profit
// Report; see ux/hqProfitModel.js). Kelete is K-only, so no fx conversion.
// HQ overhead = HQ's payment vouchers, taken once at group level.
//
// Only useful on the bare HQ host (keletezm.com). The sidebar entry lives
// under the Accounting group.
//
// v1.13.62 — first version (shop only). 2026-11-20 — fuel added per branch.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FiRefreshCw, FiChevronRight, FiChevronDown, FiLayers, FiInfo, FiShoppingBag, FiDroplet } from 'react-icons/fi';
import { getHqConsolidatedProfit } from '../services/api';
import { businessToday } from '../utils/businessDate';
import { PageHero } from '../ux/ForecourtKit';
import { fmtL } from '../ux/forecourt';
import { quickRanges, marginBar } from '../ux/profitModel';
import { hqGroup, branchDays } from '../ux/hqProfitModel';

// Money in full: "K1,234.56"; "−K10.00" when signed and negative.
const money = (v, signed = false) => `${signed && Number(v) < 0 ? '−' : ''}K${Math.abs(parseFloat(v || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const todayISO = () => businessToday();

function Money({ v, signed }) {
  const tone = signed ? (v < 0 ? ' is-neg' : v > 0 ? ' is-pos' : '') : '';
  return <span className={`k-pr-money${tone}`}>{money(v, signed)}</span>;
}

export default function HqConsolidatedProfit() {
  const quick = useMemo(() => quickRanges(todayISO()), []);
  const month = quick.find(q => q.key === 'month');
  const [from, setFrom] = useState(month.from);
  const [to,   setTo]   = useState(month.to);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const [expanded, setExpanded] = useState({});

  const load = useCallback(async (f, t) => {
    setLoading(true); setError('');
    try {
      const res = await getHqConsolidatedProfit({ from: f, to: t });
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to load consolidated profit');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(from, to); }, [from, to, load]);

  const g = useMemo(() => hqGroup(data || {}), [data]);
  const activeQuick = quick.find(q => q.from === from && q.to === to)?.key;
  const toggle = (slug) => setExpanded(e => ({ ...e, [slug]: !e[slug] }));
  const shopPct = g.shopShare == null ? 0 : Math.round(g.shopShare * 100);
  const bestPerLitre = Math.max(0, ...g.grades.map(x => x.margin_per_litre || 0));
  const rangeLabel = from === to ? from : `${from} → ${to}`;

  return (
    <div className="page-content k-pr">
      <PageHero icon={<FiLayers />} title="HQ Consolidated Profit"
        subtitle={`Shop, fuel and the whole group · every branch · ${rangeLabel}`}
        actions={<button type="button" onClick={() => load(from, to)} className="k-fc-btn-ghost" disabled={loading}><FiRefreshCw size={14} /> {loading ? 'Loading…' : 'Refresh'}</button>} />

      <div className="k-pr-toolbar">
        <div className="k-pr-quick" role="group" aria-label="Quick periods">
          {quick.map(q => (
            <button key={q.key} type="button" aria-pressed={activeQuick === q.key}
              className={`k-pr-qchip${activeQuick === q.key ? ' is-on' : ''}`}
              onClick={() => { setFrom(q.from); setTo(q.to); }}>{q.label}</button>
          ))}
        </div>
        <div className="k-pr-dates">
          <label>From <input type="date" value={from} max={to || todayISO()} onChange={e => e.target.value && setFrom(e.target.value)} /></label>
          <label>to <input type="date" value={to} min={from || undefined} max={todayISO()} onChange={e => e.target.value && setTo(e.target.value)} /></label>
        </div>
      </div>

      {error && <div className="k-pr-error" role="alert">{error}</div>}
      {!data && loading && <div className="k-pr-loading" role="status">Loading…</div>}

      {data && (
        <>
          <section className="k-pr-kpis" aria-label="Group headline figures">
            <div className="k-pr-kpi is-main">
              <span>Group net profit</span>
              <strong>{money(g.groupNet, true)}</strong>
              <em>branches <b>{money(g.branchNet, true)}</b> − HQ overhead <b>{money(g.hqOverhead)}</b></em>
            </div>
            <div className="k-pr-kpi">
              <span>Group sales</span>
              <strong>{money(g.sales)}</strong>
              <div className="k-pr-split" aria-hidden="true">
                <div className="is-shop" style={{ width: `${shopPct}%` }} />
                <div className="is-fuel" style={{ width: `${100 - shopPct}%` }} />
              </div>
              <em><i className="k-pr-key is-shop" /> Shop {money(g.shopSales)} · <i className="k-pr-key is-fuel" /> Fuel {money(g.fuelSales)}</em>
            </div>
            <div className="k-pr-kpi">
              <span>Group gross profit</span>
              <strong className={g.gross < 0 ? 'is-neg' : ''}>{money(g.gross, true)}</strong>
              <em>{g.grossMargin == null ? 'no sales in this period' : <><b>{(g.grossMargin * 100).toFixed(1)}%</b> of sales</>}</em>
            </div>
            <div className="k-pr-kpi">
              <span>Fuel margin per litre</span>
              <strong>{g.perLitre != null ? <>{money(g.perLitre, true)}<small> / L</small></> : '—'}</strong>
              <em>{g.litres > 0 ? <>on <b>{fmtL(g.litres, 0)}</b> across {g.branches.filter(b => b.litres > 0).length} {g.branches.filter(b => b.litres > 0).length === 1 ? 'branch' : 'branches'}</> : 'no closed shifts in this period'}</em>
            </div>
          </section>

          <section className="k-pr-card">
            <header><h3>By branch</h3><span>tap a branch for its days</span></header>
            <div className="k-pr-scroll">
              <table className="k-pr-pl k-hq-pl">
                <thead>
                  <tr>
                    <th scope="col">Branch</th>
                    <th scope="col"><FiShoppingBag aria-hidden="true" /> Shop sales</th>
                    <th scope="col"><FiDroplet aria-hidden="true" /> Fuel sales</th>
                    <th scope="col">Gross profit</th>
                    <th scope="col">Expenses</th>
                    <th scope="col" className="is-station">Net profit</th>
                    <th scope="col">Fuel / litre</th>
                  </tr>
                </thead>
                <tbody>
                  {g.branches.map(b => {
                    const open = !!expanded[b.slug];
                    const raw = (data.branches || []).find(x => x.slug === b.slug);
                    const days = open ? branchDays(raw) : [];
                    return (
                      <React.Fragment key={b.slug}>
                        <tr className="k-hq-branch">
                          <th scope="row">
                            <button type="button" className="k-hq-toggle" aria-expanded={open} onClick={() => toggle(b.slug)}>
                              {open ? <FiChevronDown aria-hidden="true" /> : <FiChevronRight aria-hidden="true" />} {b.name}
                            </button>
                            {!b.hasFuel && <small className="k-hq-tag">shop only</small>}
                          </th>
                          <td><Money v={b.shopSales} /></td>
                          <td>{b.hasFuel ? <Money v={b.fuelSales} /> : <span className="k-pr-na">—</span>}</td>
                          <td><Money v={b.gross} signed /></td>
                          <td><Money v={b.expenses} /></td>
                          <td className="is-station"><Money v={b.net} signed /></td>
                          <td>{b.perLitre != null ? <><Money v={b.perLitre} signed /><small className="k-hq-l"> / L</small></> : <span className="k-pr-na">—</span>}</td>
                        </tr>
                        {open && (days.length ? days.map(d => (
                          <tr key={`${b.slug}-${d.date}`} className="k-hq-day">
                            <th scope="row">{d.date}</th>
                            <td><Money v={d.shopSales} /></td>
                            <td>{b.hasFuel ? <Money v={d.fuelSales} /> : <span className="k-pr-na">—</span>}</td>
                            <td><Money v={d.gross} signed /></td>
                            <td><Money v={d.expenses} /></td>
                            <td className="is-station"><Money v={d.net} signed /></td>
                            <td>{d.perLitre != null ? <><Money v={d.perLitre} signed /><small className="k-hq-l"> / L</small></> : <span className="k-pr-na">—</span>}</td>
                          </tr>
                        )) : (
                          <tr className="k-hq-day"><th scope="row" colSpan={7}>No activity in this period.</th></tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                  <tr className="is-total">
                    <th scope="row">All branches</th>
                    <td><Money v={g.shopSales} /></td>
                    <td><Money v={g.fuelSales} /></td>
                    <td><Money v={g.gross} signed /></td>
                    <td><Money v={g.expenses} /></td>
                    <td className="is-station"><Money v={g.branchNet} signed /></td>
                    <td>{g.perLitre != null ? <><Money v={g.perLitre} signed /><small className="k-hq-l"> / L</small></> : <span className="k-pr-na">—</span>}</td>
                  </tr>
                  <tr>
                    <th scope="row"><span className="k-pr-op" aria-hidden="true">−</span>HQ overhead <small className="k-hq-l">(HQ payment vouchers)</small></th>
                    <td colSpan={4} />
                    <td className="is-station"><Money v={-g.hqOverhead} signed /></td>
                    <td />
                  </tr>
                  <tr className="is-total">
                    <th scope="row"><span className="k-pr-op" aria-hidden="true">=</span>Group net profit</th>
                    <td colSpan={4} />
                    <td className="is-station"><Money v={g.groupNet} signed /></td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
            {(g.credit > 0 || g.noFuel.length > 0) && (
              <div className="k-pr-notes">
                {g.credit > 0 && <p><FiInfo aria-hidden="true" /> <b>{money(g.credit)}</b> of credit-ticket fuel is shown under Fuel, not Shop, across the branches. Their stored shop sales held it with no cost behind it, so it is counted once, with its cost.</p>}
                {g.noFuel.length > 0 && <p><FiInfo aria-hidden="true" /> Shop figures only for <b>{g.noFuel.join(', ')}</b>: no forecourt records could be read there.</p>}
              </div>
            )}
          </section>

          <section className="k-pr-card">
            <header><h3>Fuel by grade, all branches</h3><span>litres from closed shifts · testing litres excluded</span></header>
            {g.grades.length === 0 ? (
              <p className="k-pr-empty">No closed shifts in this period.</p>
            ) : (
              <div className="k-pr-scroll">
                <table className="k-pr-grades">
                  <thead>
                    <tr>
                      <th scope="col">Grade</th><th scope="col">Litres</th><th scope="col">Sales</th>
                      <th scope="col">Cost</th><th scope="col">Margin</th><th scope="col" className="k-pr-pl-col">Margin per litre</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.grades.map(x => (
                      <tr key={x.key}>
                        <th scope="row">
                          <span className="k-pr-dot" style={{ background: x.color || '#64748b' }} aria-hidden="true" />
                          {x.name}{x.estimated_litres > 0 && <sup title="Partly costed at today's average cost">*</sup>}
                          <small>{x.branches} {x.branches === 1 ? 'branch' : 'branches'}</small>
                        </th>
                        <td>{fmtL(x.litres, 2)}</td>
                        <td>{money(x.revenue)}</td>
                        <td>{money(x.cost)}</td>
                        <td><span className={`k-pr-money${x.margin < 0 ? ' is-neg' : ''}`}>{money(x.margin, true)}</span></td>
                        <td className="k-pr-pl-col">
                          <span className="k-pr-plw">
                            <span className="k-pr-bar" aria-hidden="true"><span style={{ width: `${marginBar(x.margin_per_litre, bestPerLitre)}%`, background: x.color || '#64748b' }} /></span>
                            <b className={x.margin_per_litre < 0 ? 'is-neg' : ''}>{money(x.margin_per_litre, true)}<small> / L</small></b>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {g.estimatedLitres > 0 && (
              <div className="k-pr-notes">
                <p><FiInfo aria-hidden="true" /> <b>* {fmtL(g.estimatedLitres, 2)}</b> closed before fuel costs were frozen at shift close, so it is costed at each branch's average cost today.</p>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
