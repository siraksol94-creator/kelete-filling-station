import React, { useState, useEffect } from 'react';
import { getSalesRangeSummary, getSalesMonthlySummary, getSettings } from '../services/api';
import { FiTrendingUp, FiTrendingDown, FiDollarSign, FiAlertTriangle, FiPrinter } from 'react-icons/fi';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';

const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => new Date().toISOString().split('T')[0];

const StatCard = ({ label, value, color, bg, border, icon, symbol }) => (
  <div style={{
    flex: 1, minWidth: 160, borderRadius: 12, padding: '14px 16px',
    backgroundColor: bg, borderLeft: `4px solid ${border}`,
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ color, fontSize: 16 }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
    </div>
    <div style={{ fontSize: 20, fontWeight: 800, color }}>{symbol}{value}</div>
  </div>
);

const ProfitReport = () => {
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  const { user: authUser } = useAuth();
  const [from, setFrom] = useState(today());
  const [to, setTo]     = useState(today());
  const [range, setRange] = useState({});
  const [monthly, setMonthly] = useState({});
  const [loading, setLoading] = useState(true);
  const [businessInfo, setBusinessInfo] = useState({});
  useEffect(() => {
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
  }, []);

  const load = async (f, t) => {
    setLoading(true);
    try {
      const month = (t || f).slice(0, 7);
      const [rangeRes, monthRes] = await Promise.all([
        getSalesRangeSummary(f, t),
        getSalesMonthlySummary(month),
      ]);
      setRange(rangeRes.data || rangeRes || {});
      setMonthly(monthRes.data || monthRes || {});
    } catch (e) {
      console.log(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(from, to); }, [from, to]);

  const revenue       = parseFloat(range.revenue || 0);
  const cogs          = parseFloat(range.cogs || 0);
  // Damages (Sales Damages page) — recorded items destroyed/expired, valued at avg cost.
  const damages       = parseFloat(range.damages || 0);
  // Supplier Rebates — Credit Notes where reason is Discount or Other.
  // Crate/Bottle returns are deposit refunds, NOT income — excluded server-side.
  const supplierRebates = parseFloat(range.supplier_rebates || 0);
  // diff_value is now the Stock Variance from Stock Reconciliation (variance_base × cost_at_count).
  // The legacy `stock_adj` column is permanently 0 after the retirement, so we ignore it.
  const stockVariance = parseFloat(range.diff_value || 0);
  const cashVariance  = parseFloat(range.cash_difference || 0);
  const pvTotal       = parseFloat(range.pv_total || 0);
  const grossProfit   = parseFloat(range.gross_profit || 0);
  const netProfit     = parseFloat(range.net_profit || 0);

  // Label for the section header — single day if from == to, otherwise "from → to"
  const rangeLabel = from === to ? from : `${from}  →  ${to}`;

  const mRevenue    = parseFloat(monthly.total_revenue || 0);
  const mGross      = parseFloat(monthly.gross_profit || 0);
  const mNet        = parseFloat(monthly.net_profit || 0);
  const mDiff       = parseFloat(monthly.total_difference || 0);

  // v1.13.119 — ZRA Ref 13/attachment #6: A4 print of the Profit Report
  // so it can be handed to auditors. Renders the same numbers the page
  // shows (range stats + breakdown table + monthly summary) in a print-
  // friendly layout matching Sales Report / Sales Inventory prints.
  const handlePrintReport = () => {
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const printedBy = [authUser?.firstName, authUser?.lastName].filter(Boolean).join(' ') || '—';
    const bizName = businessInfo?.business_name || 'Business Name';
    const bizAddr = businessInfo?.business_address || '';
    const bizPhone = businessInfo?.business_phone || '';
    const mth = (to || from).slice(0, 7);

    const statCell = (label, val, colorHex = '#000') =>
      `<td style="border:1px solid #000;padding:9px 12px;vertical-align:top">
        <div style="font-size:9px;letter-spacing:0.6px;text-transform:uppercase;font-weight:700;color:#555;margin-bottom:4px">${label}</div>
        <div style="font-size:14px;font-weight:800;color:${colorHex};font-family:monospace">${curSym}${fmt(val)}</div>
      </td>`;

    const breakdownRows = [
      { label: t('revenue'), value: revenue, color: '#0369a1' },
      { label: `− ${t('cogs')}`, value: -cogs, color: '#d97706' },
      { label: `− ${t('damaged')}`, value: -damages, color: '#dc2626' },
      { label: `+ ${t('supplierRebates')}`, value: supplierRebates, color: '#16a34a' },
      { label: `${stockVariance < 0 ? '−' : '+'} ${t('stockVariance')}`, value: Math.abs(stockVariance), color: stockVariance < 0 ? '#dc2626' : '#16a34a' },
      { label: `${cashVariance  < 0 ? '−' : '+'} ${t('cashVariance')}`,  value: Math.abs(cashVariance),  color: cashVariance  < 0 ? '#dc2626' : '#16a34a' },
      { label: `= ${t('grossProfit')}`, value: grossProfit, color: grossProfit >= 0 ? '#16a34a' : '#dc2626', bold: true },
      { label: `− ${t('expensesPV')}`, value: pvTotal, color: '#dc2626' },
      { label: `= ${t('netProfit')}`, value: netProfit, color: netProfit >= 0 ? '#7c3aed' : '#dc2626', bold: true },
    ].map(r => `<tr style="border-bottom:1px solid #ddd">
      <td style="padding:7px 12px;font-weight:${r.bold ? 700 : 500};font-size:12px">${r.label}</td>
      <td style="padding:7px 12px;text-align:right;font-family:monospace;font-weight:${r.bold ? 800 : 500};font-size:${r.bold ? 13 : 12}px;color:${r.color}">${curSym}${fmt(Math.abs(r.value))}</td>
    </tr>`).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Profit Report — ${rangeLabel}</title><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:10px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:20px;font-weight:800;letter-spacing:0.3px;margin-bottom:3px">${bizName}</div>
          <div style="font-size:10px;color:#000;line-height:1.6">${[bizAddr, bizPhone].filter(Boolean).join('  |  ')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#000;margin-bottom:3px">Profit Report</div>
          <div style="font-size:14px;font-weight:700">${rangeLabel}</div>
          <div style="font-size:9px;color:#000;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>

      <div style="font-size:10px;letter-spacing:0.6px;text-transform:uppercase;font-weight:700;color:#555;margin-bottom:6px">${from === to ? t('daily') : t('rangeTotal')}</div>
      <table style="margin-bottom:14px">
        <tr>
          ${statCell(t('revenue'), revenue, '#0369a1')}
          ${statCell(t('cogs'), cogs, '#d97706')}
          ${statCell(t('damaged'), damages, '#dc2626')}
          ${statCell(t('supplierRebates'), supplierRebates, '#16a34a')}
        </tr>
        <tr>
          ${statCell(t('stockVariance'), stockVariance, stockVariance < 0 ? '#dc2626' : '#16a34a')}
          ${statCell(t('cashVariance'), cashVariance, cashVariance < 0 ? '#dc2626' : '#16a34a')}
          ${statCell(t('expensesPV'), pvTotal, '#dc2626')}
          ${statCell(t('grossProfit'), grossProfit, grossProfit >= 0 ? '#16a34a' : '#dc2626')}
        </tr>
        <tr>
          <td colspan="3" style="border:1px solid #000;padding:9px 12px;vertical-align:top;background:#fafafa">
            <div style="font-size:9px;letter-spacing:0.6px;text-transform:uppercase;font-weight:700;color:#555;margin-bottom:4px">${t('netProfit')}</div>
            <div style="font-size:18px;font-weight:800;color:${netProfit >= 0 ? '#7c3aed' : '#dc2626'};font-family:monospace">${curSym}${fmt(netProfit)}</div>
          </td>
          <td style="border:1px solid #000;padding:9px 12px;vertical-align:top">
            <div style="font-size:9px;letter-spacing:0.6px;text-transform:uppercase;font-weight:700;color:#555;margin-bottom:4px">Period</div>
            <div style="font-size:12px;font-weight:600">${rangeLabel}</div>
          </td>
        </tr>
      </table>

      <div style="font-size:10px;letter-spacing:0.6px;text-transform:uppercase;font-weight:700;color:#555;margin-bottom:6px">${t('breakdown')}</div>
      <div style="border:1.5px solid #000;margin-bottom:14px">
        <table><tbody>${breakdownRows}</tbody></table>
      </div>

      <div style="font-size:10px;letter-spacing:0.6px;text-transform:uppercase;font-weight:700;color:#555;margin-bottom:6px">${mth} — ${t('monthToDate')}</div>
      <table style="margin-bottom:20px">
        <tr>
          ${statCell(t('monthlyRevenue'), mRevenue, '#0369a1')}
          ${statCell(t('monthlyGrossProfit'), mGross, mGross >= 0 ? '#16a34a' : '#dc2626')}
          ${statCell(t('monthlyNetProfit'), mNet, mNet >= 0 ? '#7c3aed' : '#dc2626')}
          ${statCell(t('monthlyDifference'), mDiff, mDiff < 0 ? '#dc2626' : '#16a34a')}
        </tr>
      </table>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:24px;margin-bottom:12px">
        ${[['Prepared By', ''], ['Checked By', ''], ['Printed By', printedBy]].map(([label, name]) => `
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:30px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:6px;display:flex;justify-content:space-between">
        <span style="font-size:9px;color:#000">${bizName} — Confidential</span>
        <span style="font-size:9px;color:#000">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => { w.print(); }, 300); }
  };

  return (
    <div className="page-content">
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>{t('profitReport')}</h1>
          <p>{t('profitReportSubtitle')}</p>
        </div>
        <button
          onClick={handlePrintReport}
          disabled={loading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#16a34a', color: '#fff', cursor: loading ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, opacity: loading ? 0.5 : 1 }}
        >
          <FiPrinter size={15} /> Print Report
        </button>
      </div>

      {/* Date range picker */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>{t('from')}:</label>
        <input
          type="date"
          value={from}
          max={to || today()}
          onChange={e => setFrom(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
        />
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>{t('to')}:</label>
        <input
          type="date"
          value={to}
          min={from || undefined}
          max={today()}
          onChange={e => setTo(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
        />
        {from !== to && (
          <button
            onClick={() => { const t = today(); setFrom(t); setTo(t); }}
            style={{ padding: '6px 12px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 12 }}
          >{t('todayOnly')}</button>
        )}
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>{t('loading')}</div>
      ) : (
        <>
          {/* Range Section (Daily when from == to) */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>
              {rangeLabel} — {from === to ? t('daily') : t('rangeTotal')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
              <StatCard symbol={curSym} label={t('revenue')} value={fmt(revenue)} color="#0369a1" bg="#f0f9ff" border="#38bdf8" icon={<FiDollarSign />} />
              <StatCard symbol={curSym} label={t('cogs')} value={fmt(cogs)} color="#d97706" bg="#fffbeb" border="#fbbf24" icon={<FiTrendingDown />} />
              <StatCard symbol={curSym} label={t('damaged')} value={fmt(damages)} color="#dc2626" bg="#fef2f2" border="#fca5a5" icon={<FiTrendingDown />} />
              <StatCard symbol={curSym} label={t('supplierRebates')} value={fmt(supplierRebates)} color="#16a34a" bg="#f0fdf4" border="#86efac" icon={<FiTrendingUp />} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
              <StatCard symbol={curSym} label={t('stockVariance')} value={fmt(stockVariance)} color={stockVariance < 0 ? '#dc2626' : '#16a34a'} bg={stockVariance < 0 ? '#fef2f2' : '#f0fdf4'} border={stockVariance < 0 ? '#fca5a5' : '#86efac'} icon={<FiAlertTriangle />} />
              <StatCard symbol={curSym} label={t('cashVariance')} value={fmt(cashVariance)} color={cashVariance < 0 ? '#dc2626' : '#16a34a'} bg={cashVariance < 0 ? '#fef2f2' : '#f0fdf4'} border={cashVariance < 0 ? '#fca5a5' : '#86efac'} icon={<FiDollarSign />} />
              <StatCard symbol={curSym} label={t('expensesPV')} value={fmt(pvTotal)} color="#dc2626" bg="#fef2f2" border="#fca5a5" icon={<FiTrendingDown />} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <StatCard symbol={curSym} label={t('grossProfit')} value={fmt(grossProfit)} color={grossProfit >= 0 ? '#16a34a' : '#dc2626'} bg={grossProfit >= 0 ? '#f0fdf4' : '#fef2f2'} border={grossProfit >= 0 ? '#86efac' : '#fca5a5'} icon={<FiTrendingUp />} />
              <StatCard symbol={curSym} label={t('netProfit')} value={fmt(netProfit)} color={netProfit >= 0 ? '#7c3aed' : '#dc2626'} bg={netProfit >= 0 ? '#f5f3ff' : '#fef2f2'} border={netProfit >= 0 ? '#c4b5fd' : '#fca5a5'} icon={<FiTrendingUp />} />
            </div>
          </div>

          {/* Breakdown Table */}
          <div style={{ backgroundColor: '#fff', borderRadius: 10, padding: 16, marginTop: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>{t('breakdown')}</div>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <tbody>
                {[
                  { label: t('revenue'), value: revenue, color: '#0369a1' },
                  { label: `− ${t('cogs')}`, value: -cogs, color: '#d97706' },
                  { label: `− ${t('damaged')}`, value: -damages, color: '#dc2626' },
                  { label: `+ ${t('supplierRebates')}`, value: supplierRebates, color: '#16a34a' },
                  { label: `${stockVariance < 0 ? '−' : '+'} ${t('stockVariance')}`, value: Math.abs(stockVariance), color: stockVariance < 0 ? '#dc2626' : '#16a34a' },
                  { label: `${cashVariance  < 0 ? '−' : '+'} ${t('cashVariance')}`,  value: Math.abs(cashVariance),  color: cashVariance  < 0 ? '#dc2626' : '#16a34a' },
                  { label: `= ${t('grossProfit')}`, value: grossProfit, color: grossProfit >= 0 ? '#16a34a' : '#dc2626', bold: true },
                  { label: `− ${t('expensesPV')}`, value: pvTotal, color: '#dc2626' },
                  { label: `= ${t('netProfit')}`, value: netProfit, color: netProfit >= 0 ? '#7c3aed' : '#dc2626', bold: true },
                ].map((row, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px 4px', fontWeight: row.bold ? 700 : 400, color: '#374151' }}>{row.label}</td>
                    <td style={{ padding: '8px 4px', textAlign: 'right', fontWeight: row.bold ? 700 : 500, color: row.color }}>
                      {curSym}{fmt(Math.abs(row.value))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Monthly Section */}
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 12 }}>
              {(to || from).slice(0, 7)} — {t('monthToDate')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
              <StatCard symbol={curSym} label={t('monthlyRevenue')} value={fmt(mRevenue)} color="#0369a1" bg="#f0f9ff" border="#38bdf8" icon={<FiDollarSign />} />
              <StatCard symbol={curSym} label={t('monthlyGrossProfit')} value={fmt(mGross)} color={mGross >= 0 ? '#16a34a' : '#dc2626'} bg={mGross >= 0 ? '#f0fdf4' : '#fef2f2'} border={mGross >= 0 ? '#86efac' : '#fca5a5'} icon={<FiTrendingUp />} />
              <StatCard symbol={curSym} label={t('monthlyNetProfit')} value={fmt(mNet)} color={mNet >= 0 ? '#7c3aed' : '#dc2626'} bg={mNet >= 0 ? '#f5f3ff' : '#fef2f2'} border={mNet >= 0 ? '#c4b5fd' : '#fca5a5'} icon={<FiTrendingUp />} />
              <StatCard symbol={curSym} label={t('monthlyDifference')} value={fmt(mDiff)} color={mDiff < 0 ? '#dc2626' : '#16a34a'} bg={mDiff < 0 ? '#fef2f2' : '#f0fdf4'} border={mDiff < 0 ? '#fca5a5' : '#86efac'} icon={<FiAlertTriangle />} />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ProfitReport;
