import React, { useState, useEffect, useCallback } from 'react';
import { getSalesRangeSummary, getSalesMonthlySummary, getSettings, getFuelProfit } from '../services/api';
import { FiTrendingUp, FiPrinter, FiDroplet, FiShoppingBag, FiInfo, FiRefreshCw } from 'react-icons/fi';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { businessToday } from '../utils/businessDate';
import { PageHero } from '../ux/ForecourtKit';
import { fmtL } from '../ux/forecourt';
import { stationPL, stationMonth, monthRange, quickRanges, marginBar } from '../ux/profitModel';

// Profit Report — Shop | Fuel | Station total (see ux/profitModel.js).
// Shop figures are the stored daily profit, unchanged; fuel comes from closed
// shifts with the cost per litre frozen at close; expenses are taken once, at
// station level. Money is always shown in full.

const fmt = (v) => Math.abs(parseFloat(v || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => businessToday();
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ProfitReport = () => {
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  const { user: authUser } = useAuth();
  const [from, setFrom] = useState(today());
  const [to, setTo]     = useState(today());
  const [range, setRange] = useState({});
  const [monthly, setMonthly] = useState({});
  const [fuel, setFuel] = useState({});
  const [fuelMonth, setFuelMonth] = useState({});
  const [fuelError, setFuelError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [businessInfo, setBusinessInfo] = useState({});
  useEffect(() => {
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
  }, []);

  // Money: "K1,234.56", "−K10.00" when signed and negative.
  const money = (v, signed = false) => `${signed && Number(v) < 0 ? '−' : ''}${curSym}${fmt(v)}`;

  const load = useCallback(async (f, tt) => {
    setLoading(true);
    const mr = monthRange(tt || f, today());
    try {
      const [rangeRes, monthRes] = await Promise.all([
        getSalesRangeSummary(f, tt),
        getSalesMonthlySummary(mr.from.slice(0, 7)),
      ]);
      setRange(rangeRes.data || {});
      setMonthly(monthRes.data || {});
    } catch (e) {
      console.log(e);
    }
    // Fuel is loaded on its own so a fuel problem never hides the shop figures.
    try {
      const [fr, fm] = await Promise.all([getFuelProfit(f, tt), getFuelProfit(mr.from, mr.to)]);
      setFuel(fr.data || {}); setFuelMonth(fm.data || {}); setFuelError(false);
    } catch (e) {
      setFuel({}); setFuelMonth({}); setFuelError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(from, to); }, [from, to, load]);

  const pl = stationPL(range, fuel);
  const month = stationMonth(monthly, fuelMonth);
  const grades = fuel.grades || [];
  const ft = fuel.totals || {};
  const bestPerLitre = Math.max(0, ...grades.map(g => g.margin_per_litre || 0));
  const rangeLabel = from === to ? from : `${from} → ${to}`;
  const monthLabel = (to || from).slice(0, 7);
  const quick = quickRanges(today());
  const activeQuick = quick.find(q => q.from === from && q.to === to)?.key;

  const cell = (v, row) => {
    if (v == null) return <span className="k-pr-na" aria-label="not applicable">—</span>;
    const signed = row.op === '±' || row.total;
    const tone = signed ? (v < 0 ? ' is-neg' : v > 0 ? ' is-pos' : '') : '';
    return <span className={`k-pr-money${tone}`}>{money(v, signed)}</span>;
  };

  // v1.13.119 — A4 print for auditors; now Shop | Fuel | Station and fuel by grade.
  const handlePrintReport = () => {
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const printedBy = [authUser?.firstName, authUser?.lastName].filter(Boolean).join(' ') || '—';
    const bizName = esc(businessInfo?.business_name || 'Business Name');
    const bizAddr = esc(businessInfo?.business_address || '');
    const bizPhone = esc(businessInfo?.business_phone || '');
    const pc = (v, row) => (v == null ? '—' : esc(money(v, row.op === '±' || row.total)));
    const plRows = pl.rows.map(r => `<tr style="border-bottom:1px solid #e2e8f0${r.total ? ';background:#f1f5f9' : ''}">
      <td style="padding:6px 10px;font-weight:${r.total ? 700 : 500}">${r.op ? r.op + ' ' : ''}${esc(r.label)}</td>
      ${['shop', 'fuel', 'station'].map(k => `<td style="padding:6px 10px;text-align:right;font-family:monospace;font-weight:${r.total || k === 'station' ? 700 : 500}">${pc(r[k], r)}</td>`).join('')}
    </tr>`).join('');
    const gradeRows = grades.map(g => `<tr style="border-bottom:1px solid #e2e8f0">
      <td style="padding:6px 10px;font-weight:600">${esc(g.name)}${g.estimated_litres > 0 ? ' *' : ''}</td>
      <td style="padding:6px 10px;text-align:right;font-family:monospace">${esc(fmtL(g.litres, 2))}</td>
      <td style="padding:6px 10px;text-align:right;font-family:monospace">${esc(money(g.revenue))}</td>
      <td style="padding:6px 10px;text-align:right;font-family:monospace">${esc(money(g.cost))}</td>
      <td style="padding:6px 10px;text-align:right;font-family:monospace;font-weight:700">${esc(money(g.margin, true))}</td>
      <td style="padding:6px 10px;text-align:right;font-family:monospace;font-weight:700">${esc(money(g.margin_per_litre, true))} / L</td>
    </tr>`).join('');
    const th = (s, right = true) => `<th style="padding:7px 10px;text-align:${right ? 'right' : 'left'};font-size:9px;letter-spacing:.6px;text-transform:uppercase;border-bottom:1.5px solid #000">${s}</th>`;
    const notes = [
      pl.credit > 0 ? `${esc(money(pl.credit))} of credit-ticket fuel is shown under Fuel, not Shop (the shop's stored sales held it with no cost).` : '',
      ft.estimated_litres > 0 ? `* ${esc(fmtL(ft.estimated_litres, 2))} closed before fuel costs were frozen at shift close; costed at today's average cost.` : '',
      fuelError ? 'Fuel figures could not be loaded; Fuel column shows zero.' : '',
    ].filter(Boolean).map(x => `<div style="font-size:9.5px;margin-top:4px">${x}</div>`).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Profit Report — ${esc(rangeLabel)}</title><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:11.5px;color:#000}
      table{width:100%;border-collapse:collapse}
      .h{font-size:10px;letter-spacing:.6px;text-transform:uppercase;font-weight:700;color:#334155;margin:14px 0 6px}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:10px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:20px;font-weight:800;margin-bottom:3px">${bizName}</div>
          <div style="font-size:10px;line-height:1.6">${[bizAddr, bizPhone].filter(Boolean).join('  |  ')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:3px">Profit Report</div>
          <div style="font-size:14px;font-weight:700">${esc(rangeLabel)}</div>
          <div style="font-size:9px;margin-top:3px">Printed: ${esc(printedAt)}</div>
        </div>
      </div>
      <table style="margin:10px 0 4px"><tr>
        ${[['Station sales', money(pl.sales)], ['Station gross profit', money(pl.gross, true)], ['Station net profit', money(pl.net, true)], ['Fuel margin per litre', ft.litres > 0 ? `${money(ft.margin_per_litre, true)} / L` : '—']]
          .map(([l, v]) => `<td style="border:1px solid #000;padding:8px 10px"><div style="font-size:9px;letter-spacing:.6px;text-transform:uppercase;font-weight:700;color:#334155;margin-bottom:3px">${l}</div><div style="font-size:14px;font-weight:800;font-family:monospace">${esc(v)}</div></td>`).join('')}
      </tr></table>
      <div class="h">${t('breakdown')} — ${esc(rangeLabel)}</div>
      <div style="border:1.5px solid #000"><table>
        <thead><tr>${th('', false)}${th('Shop')}${th('Fuel')}${th('Station')}</tr></thead>
        <tbody>${plRows}</tbody>
      </table></div>
      <div class="h">Fuel by grade</div>
      <div style="border:1.5px solid #000"><table>
        <thead><tr>${th('Grade', false)}${th('Litres')}${th('Sales')}${th('Cost')}${th('Margin')}${th('Per litre')}</tr></thead>
        <tbody>${gradeRows || '<tr><td colspan="6" style="padding:12px;text-align:center">No closed shifts in this period.</td></tr>'}</tbody>
      </table></div>
      ${notes}
      <div class="h">${esc(monthLabel)} — ${t('monthToDate')}</div>
      <table><tr>
        ${[['Station sales', money(month.sales)], ['Station gross profit', money(month.gross, true)], ['Station net profit', money(month.net, true)], ['Fuel litres', fmtL(month.litres, 0)], ['Stock difference (shop)', money(month.stockDifference, true)]]
          .map(([l, v]) => `<td style="border:1px solid #000;padding:8px 10px"><div style="font-size:9px;letter-spacing:.6px;text-transform:uppercase;font-weight:700;color:#334155;margin-bottom:3px">${l}</div><div style="font-size:12.5px;font-weight:800;font-family:monospace">${esc(v)}</div></td>`).join('')}
      </tr></table>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:24px;margin-bottom:12px">
        ${[['Prepared By', ''], ['Checked By', ''], ['Printed By', esc(printedBy)]].map(([label, name]) => `
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:30px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #cbd5e1;padding-top:6px;display:flex;justify-content:space-between">
        <span style="font-size:9px">${bizName} — Confidential</span>
        <span style="font-size:9px">Printed: ${esc(printedAt)}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => { w.print(); }, 300); }
  };

  const shopPct = pl.shopShare == null ? 0 : Math.round(pl.shopShare * 100);

  return (
    <div className="page-content k-pr">
      <PageHero icon={<FiTrendingUp />} title={t('profitReport')}
        subtitle={`Shop, fuel and the whole station · ${rangeLabel}`}
        actions={<>
          <button type="button" onClick={() => load(from, to)} className="k-fc-btn-ghost" disabled={loading}><FiRefreshCw size={14} /> {t('refresh')}</button>
          <button type="button" onClick={handlePrintReport} className="k-fc-btn-hero" disabled={loading}><FiPrinter size={15} /> Print Report</button>
        </>} />

      {/* Period */}
      <div className="k-pr-toolbar">
        <div className="k-pr-quick" role="group" aria-label="Quick periods">
          {quick.map(q => (
            <button key={q.key} type="button" aria-pressed={activeQuick === q.key}
              className={`k-pr-qchip${activeQuick === q.key ? ' is-on' : ''}`}
              onClick={() => { setFrom(q.from); setTo(q.to); }}>{q.label}</button>
          ))}
        </div>
        <div className="k-pr-dates">
          <label>{t('from')}
            <input type="date" value={from} max={to || today()} onChange={e => e.target.value && setFrom(e.target.value)} />
          </label>
          <label>{t('to')}
            <input type="date" value={to} min={from || undefined} max={today()} onChange={e => e.target.value && setTo(e.target.value)} />
          </label>
        </div>
      </div>

      {loading ? (
        <div className="k-pr-loading" role="status">{t('loading')}</div>
      ) : (
        <>
          {/* Headline */}
          <section className="k-pr-kpis" aria-label="Headline figures">
            <div className="k-pr-kpi is-main">
              <span>Station net profit</span>
              <strong>{money(pl.net, true)}</strong>
              <em>after <b>{money(pl.rows.find(r => r.key === 'expenses').station)}</b> expenses &amp; loan interest</em>
            </div>
            <div className="k-pr-kpi">
              <span>Station sales</span>
              <strong>{money(pl.sales)}</strong>
              <div className="k-pr-split" aria-hidden="true">
                <div className="is-shop" style={{ width: `${shopPct}%` }} />
                <div className="is-fuel" style={{ width: `${100 - shopPct}%` }} />
              </div>
              <em><i className="k-pr-key is-shop" /> Shop {money(pl.rows[0].shop)} · <i className="k-pr-key is-fuel" /> Fuel {money(pl.rows[0].fuel)}</em>
            </div>
            <div className="k-pr-kpi">
              <span>Station gross profit</span>
              <strong className={pl.gross < 0 ? 'is-neg' : ''}>{money(pl.gross, true)}</strong>
              <em>{pl.grossMargin == null ? 'no sales in this period' : <><b>{(pl.grossMargin * 100).toFixed(1)}%</b> of sales</>}</em>
            </div>
            <div className="k-pr-kpi">
              <span>Fuel margin per litre</span>
              <strong>{ft.litres > 0 ? <>{money(ft.margin_per_litre, true)}<small> / L</small></> : '—'}</strong>
              <em>{ft.litres > 0 ? <>on <b>{fmtL(ft.litres, 0)}</b> sold · {fuel.shifts} {fuel.shifts === 1 ? 'shift' : 'shifts'}</> : 'no closed shifts in this period'}</em>
            </div>
          </section>

          {/* Shop | Fuel | Station */}
          <section className="k-pr-card">
            <header><h3>{t('breakdown')}</h3><span>{rangeLabel}</span></header>
            <div className="k-pr-scroll">
              <table className="k-pr-pl">
                <thead>
                  <tr>
                    <th scope="col"><span className="k-sr-only">Line</span></th>
                    <th scope="col"><FiShoppingBag aria-hidden="true" /> Shop</th>
                    <th scope="col"><FiDroplet aria-hidden="true" /> Fuel</th>
                    <th scope="col" className="is-station">Station</th>
                  </tr>
                </thead>
                <tbody>
                  {pl.rows.map(r => (
                    <tr key={r.key} className={r.total ? 'is-total' : ''}>
                      <th scope="row"><span className="k-pr-op" aria-hidden="true">{r.op}</span>{r.label}</th>
                      <td>{cell(r.shop, r)}</td>
                      <td>{cell(r.fuel, r)}</td>
                      <td className="is-station">{cell(r.station, r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(pl.credit > 0 || fuelError) && (
              <div className="k-pr-notes">
                {pl.credit > 0 && <p><FiInfo aria-hidden="true" /> <b>{money(pl.credit)}</b> of credit-ticket fuel is shown under Fuel, not Shop. The shop's stored sales held it with no cost behind it, so it is counted once, with its cost.</p>}
                {fuelError && <p className="is-warn"><FiInfo aria-hidden="true" /> Fuel figures could not be loaded, so the Fuel column shows zero. Try Refresh.</p>}
              </div>
            )}
          </section>

          {/* Fuel by grade */}
          <section className="k-pr-card">
            <header><h3>Fuel by grade</h3><span>litres from closed shifts · testing litres excluded</span></header>
            {grades.length === 0 ? (
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
                    {grades.map(g => (
                      <tr key={g.grade_id}>
                        <th scope="row">
                          <span className="k-pr-dot" style={{ background: g.color || '#64748b' }} aria-hidden="true" />
                          {g.name}{g.estimated_litres > 0 && <sup title="Partly costed at today's average cost">*</sup>}
                          <small>{money(g.price_per_litre)} sell · {money(g.cost_per_litre)} cost / L</small>
                        </th>
                        <td>{fmtL(g.litres, 2)}</td>
                        <td>{money(g.revenue)}</td>
                        <td>{money(g.cost)}</td>
                        <td><span className={`k-pr-money${g.margin < 0 ? ' is-neg' : ''}`}>{money(g.margin, true)}</span></td>
                        <td className="k-pr-pl-col">
                          <span className="k-pr-plw">
                            <span className="k-pr-bar" aria-hidden="true"><span style={{ width: `${marginBar(g.margin_per_litre, bestPerLitre)}%`, background: g.color || '#64748b' }} /></span>
                            <b className={g.margin_per_litre < 0 ? 'is-neg' : ''}>{money(g.margin_per_litre, true)}<small> / L</small></b>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th scope="row">All grades</th>
                      <td>{fmtL(ft.litres, 2)}</td>
                      <td>{money(ft.revenue)}</td>
                      <td>{money(ft.cost)}</td>
                      <td><span className={`k-pr-money${ft.margin < 0 ? ' is-neg' : ''}`}>{money(ft.margin, true)}</span></td>
                      <td className="k-pr-pl-col"><b>{money(ft.margin_per_litre, true)}<small> / L</small></b></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
            {ft.estimated_litres > 0 && (
              <div className="k-pr-notes">
                <p><FiInfo aria-hidden="true" /> <b>* {fmtL(ft.estimated_litres, 2)}</b> closed before fuel costs were frozen at shift close, so it is costed at today's average cost. Shifts closed from now on keep the cost they closed with.</p>
              </div>
            )}
          </section>

          {/* Month to date */}
          <section className="k-pr-card">
            <header><h3>{monthLabel} — {t('monthToDate')}</h3><span>shop + fuel</span></header>
            <div className="k-pr-month">
              <div><span>Station sales</span><strong>{money(month.sales)}</strong></div>
              <div><span>Station gross profit</span><strong className={month.gross < 0 ? 'is-neg' : ''}>{money(month.gross, true)}</strong></div>
              <div><span>Station net profit</span><strong className={month.net < 0 ? 'is-neg' : ''}>{money(month.net, true)}</strong></div>
              <div><span>Fuel sold</span><strong>{fmtL(month.litres, 0)}</strong></div>
              <div><span>Stock difference (shop)</span><strong className={month.stockDifference < 0 ? 'is-neg' : ''}>{money(month.stockDifference, true)}</strong></div>
            </div>
          </section>
        </>
      )}
    </div>
  );
};

export default ProfitReport;
