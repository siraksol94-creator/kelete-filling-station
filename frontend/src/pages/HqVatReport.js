import React, { useState, useEffect, useMemo } from 'react';
import { FiDownload, FiFileText } from 'react-icons/fi';
import { getHqVatReport, getSettings } from '../services/api';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';
import { exportRowsToXlsx, exportRowsToCsv, exportRowsToPdf } from '../utils/exportReport';

// 2026-09-12 — HQ consolidated VAT Transaction Report: the depot report
// (pages/VatReport.js) across every depot. Same columns, same one-row-per-line
// shape with ↳ for a sale's further lines, same numbers — the server runs the
// same line builder in each depot's book. HQ adds a Depot column, a band and
// subtotal per depot, a depot filter and a ZRA tax-category filter.
//
// 2026-09-13 — fast. All depots over a fortnight is ~24,000 lines, and drawing
// every one froze the page. The totals and each depot's subtotal now come
// from the server and are exact from the start; the lines arrive 500 at a
// time ("Show next 500"). Excel / CSV / PDF fetch every line of the filter
// straight into the file without drawing them, led by a "Showing:" row.

const todayStr = new Date().toISOString().split('T')[0];
const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

const fmtMoney = (n) => Number(n || 0).toFixed(2);
const fmtInt   = (n) => Number(n || 0).toLocaleString();
const fmtDate  = (d) => d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtDay   = (d) => d ? new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const ACCENT = '#b91c1c';
const PAGE = 500;

// ZRA VAT categories, VSDC API spec §6.1 — the same list the depot report labels.
const CATS = [
  ['A',  'Standard 16%'],
  ['B',  'MTV 16%'],
  ['C1', 'Zero-rated (Exports)'],
  ['C2', 'Zero-rated (LPO)'],
  ['C3', 'Zero-rated by nature'],
  ['D',  'Exempt'],
  ['E',  'Disbursement'],
];

const th = (align = 'left') => ({ padding: '10px 12px', textAlign: align, background: ACCENT, whiteSpace: 'nowrap' });

// Export columns — the depot report's, with the depot first.
const money = (v) => (v == null || v === '' ? '' : fmtMoney(v));
const LINE_COLUMNS = [
  { key: 'depot_name',     label: 'Depot' },
  { key: 'invoice_number', label: 'Invoice No',           format: v => fmtInvoiceNo(v) },
  { key: 'date',           label: 'Date',                 format: v => (v ? fmtDate(v) : '') },
  { key: 'customer_name',  label: 'Customer' },
  { key: 'description',    label: 'Description of Goods' },
  { key: 'vat_category',   label: 'Tax Cat' },
  { key: 'vat_excl',       label: 'VAT Exclusive (K)',    format: money },
  { key: 'vat_amount',     label: 'VAT (K)',              format: money },
  { key: 'total_inc',      label: 'Total incl. VAT (K)',  format: money },
];

// Consecutive lines of one depot (the server keeps each depot's lines together).
function groupLines(lines) {
  const groups = [];
  for (const l of lines) {
    const key = l.depot_slug || l.depot_name;
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.lines.push(l);
    else groups.push({ key, name: l.depot_name, lines: [l] });
  }
  return groups;
}

export default function HqVatReport() {
  const [from, setFrom]       = useState(firstOfMonth);
  const [to, setTo]           = useState(todayStr);
  const [depot, setDepot]     = useState('');
  const [cats, setCats]       = useState([]);
  const [data, setData]       = useState(null);   // { summary, totals, depots, total_lines }
  const [lines, setLines]     = useState([]);     // the lines drawn so far
  // The filter the figures on screen were fetched with — what the "Showing"
  // line, "Show next 500" and every export use.
  const [applied, setApplied] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState('');
  const [error, setError]     = useState('');
  const [business, setBusiness] = useState({});

  const paramsFor = (f, extra = {}) => ({
    from: f.from ? `${f.from} 00:00:00` : undefined,
    to:   f.to   ? `${f.to} 23:59:59`   : undefined,
    slug: f.depot || undefined,
    cats: f.cats.length ? f.cats.join(',') : undefined,
    lines: 1,
    ...extra,
  });

  const fetchReport = async (over = {}) => {
    const f = { from, to, depot, cats, ...over };
    setLoading(true); setError('');
    try {
      const res = await getHqVatReport(paramsFor(f, { offset: 0, limit: PAGE }));
      setData(res.data || null);
      setLines(res.data?.lines || []);
      setApplied(f);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!applied || loadingMore) return;
    setLoadingMore(true); setError('');
    try {
      const res = await getHqVatReport(paramsFor(applied, { offset: lines.length, limit: PAGE }));
      setLines(prev => [...prev, ...(res.data?.lines || [])]);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Failed to load more');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    getSettings().then(r => setBusiness(r.data?.business || {})).catch(() => {});
    fetchReport();
    // eslint-disable-next-line
  }, []);

  // Depot and tax category apply at once; dates wait for Show, as on the
  // depot report.
  const pickDepot = (v) => { setDepot(v); fetchReport({ depot: v }); };
  const toggleCat = (k) => {
    const next = k === null ? [] : (cats.includes(k) ? cats.filter(c => c !== k) : [...cats, k]);
    setCats(next);
    fetchReport({ cats: next });
  };

  const depots = data?.depots || [];
  const totals = data?.totals || { invoices: 0, lines: 0, excl: 0, vat: 0, total: 0 };
  const totalLines = data?.total_lines ?? totals.lines;
  const summaryBySlug = useMemo(() => {
    const m = {};
    for (const s of data?.summary || []) m[s.slug] = s;
    return m;
  }, [data]);
  const depotsWithSales = (data?.summary || []).filter(s => s.lines > 0).length;

  const showing = applied
    ? [
        `${fmtDay(applied.from)} to ${fmtDay(applied.to)}`,
        applied.depot ? (depots.find(d => d.slug === applied.depot)?.name || applied.depot) : 'all depots',
        applied.cats.length ? `Tax Cat ${applied.cats.join(', ')}` : 'all tax categories',
      ].join(' · ')
    : '';

  const groups = useMemo(() => groupLines(lines), [lines]);

  // Every line of the filter, straight into the file — never drawn. A
  // "Showing:" row first, each depot's subtotal after its lines, then TOTALS.
  const exportAll = async (kind) => {
    if (!applied || exporting) return;
    setExporting(kind); setError('');
    try {
      const res = await getHqVatReport(paramsFor(applied));
      const all = res.data?.lines || [];
      const bySlug = {};
      for (const s of res.data?.summary || []) bySlug[s.slug] = s;
      const rows = [{ depot_name: 'Showing:', description: showing }];
      for (const g of groupLines(all)) {
        rows.push(...g.lines);
        const s = bySlug[g.key] || {};
        rows.push({ depot_name: g.name, description: `${g.name} subtotal`, vat_excl: s.excl, vat_amount: s.vat, total_inc: s.total });
      }
      const t = res.data?.totals || {};
      rows.push({ description: 'TOTALS', vat_excl: t.excl, vat_amount: t.vat, total_inc: t.total });
      const file = `HQ_VAT_Transactions_${applied.from}_to_${applied.to}${applied.depot ? '_' + applied.depot : ''}`;
      if (kind === 'xlsx') exportRowsToXlsx(rows, LINE_COLUMNS, file, 'VAT Transactions');
      else if (kind === 'csv') exportRowsToCsv(rows, LINE_COLUMNS, file);
      else await exportRowsToPdf(rows, LINE_COLUMNS, file, {
        title: 'HQ VAT Transaction Report',
        subtitle: `Line-by-line VAT for non-reversed sales — ZRA Ref 9 / attachment 5 · ${showing}`,
        businessName: business?.business_name || 'Red Sea Import & Export (Z) Ltd',
      });
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Export failed');
    } finally {
      setExporting('');
    }
  };

  const chip = (on) => ({
    padding: '5px 11px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
    border: `1px solid ${on ? ACCENT : '#d1d5db'}`, background: on ? ACCENT : '#fff', color: on ? '#fff' : '#374151',
  });
  const exBtn = (color, disabled) => ({
    display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 12px', borderRadius: 6,
    border: `1.5px solid ${color}`, background: disabled ? '#f3f4f6' : '#fff', color: disabled ? '#9ca3af' : color,
    cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
  });
  const noLines = !totalLines;

  return (
    <div className="page-content" style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="desk-only" style={{ background: ACCENT, color: 'white', borderRadius: 10, padding: 12 }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" style={{ display: 'block' }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        </div>
        <div className="desk-only" style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>HQ VAT Transaction Report</div>
          <div style={{ fontSize: 13, color: '#6b7280' }}>Line-by-line list of VAT-exclusive value, VAT and total for non-reversed sales, across every depot — for ZRA Ref 9 / attachment 5.</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" onClick={() => exportAll('xlsx')} disabled={!applied || noLines || !!exporting}
            title="Every line of this filter, into Excel" style={exBtn('#16a34a', !applied || noLines)}>
            <FiDownload size={12} /> {exporting === 'xlsx' ? 'Preparing…' : 'Excel'}
          </button>
          <button type="button" onClick={() => exportAll('csv')} disabled={!applied || noLines || !!exporting}
            title="Every line of this filter, as CSV" style={exBtn('#0369a1', !applied || noLines)}>
            <FiFileText size={12} /> {exporting === 'csv' ? 'Preparing…' : 'CSV'}
          </button>
          <button type="button" onClick={() => exportAll('pdf')} disabled={!applied || noLines || !!exporting}
            title="Every line of this filter, as PDF" style={exBtn(ACCENT, !applied || noLines)}>
            <FiFileText size={12} /> {exporting === 'pdf' ? 'Preparing…' : 'PDF'}
          </button>
        </div>
      </div>

      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 16, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 4 }}>From</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ padding: 8, border: '1px solid #d1d5db', borderRadius: 6 }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 4 }}>To</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ padding: 8, border: '1px solid #d1d5db', borderRadius: 6 }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 4 }}>Depot</label>
            <select value={depot} onChange={e => pickDepot(e.target.value)} style={{ padding: 8, border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', minWidth: 170 }}>
              <option value="">All depots ({depots.length})</option>
              {depots.map(d => <option key={d.slug} value={d.slug}>{d.name}</option>)}
            </select>
          </div>
          <button onClick={() => fetchReport()} disabled={loading} style={{
            background: ACCENT, color: 'white', border: 'none', borderRadius: 6, padding: '10px 20px', fontWeight: 600, cursor: 'pointer',
          }}>{loading ? 'Loading…' : 'Show'}</button>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 6 }}>Tax Cat</label>
          <div className="cat-filter-row" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => toggleCat(null)} style={chip(cats.length === 0)}>All</button>
            {CATS.map(([k, label]) => (
              <button key={k} type="button" onClick={() => toggleCat(k)} style={chip(cats.includes(k))} title={label}>
                <b style={{ marginRight: 4 }}>{k}</b>{label}
              </button>
            ))}
          </div>
        </div>
        {showing && (
          <div style={{ fontSize: 12, color: '#374151', borderTop: '1px dashed #e5e7eb', paddingTop: 10 }}>
            Showing: <b style={{ color: '#111827' }}>{showing}</b>
            <span style={{ color: '#9ca3af' }}> — the first row of every export</span>
          </div>
        )}
      </div>

      {error && (
        <div style={{ background: '#fee2e2', color: '#991b1b', padding: 12, borderRadius: 6, marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', fontWeight: 600, display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <span>
            {loading && !data ? 'Loading…' : `${fmtInt(depotsWithSales)} depot${depotsWithSales === 1 ? '' : 's'} · ${fmtInt(totals.invoices)} invoice${totals.invoices === 1 ? '' : 's'} · ${fmtInt(totalLines)} line${totalLines === 1 ? '' : 's'}`}
          </span>
          {lines.length < totalLines && (
            <span style={{ fontWeight: 400, color: '#6b7280' }}>showing the first {fmtInt(lines.length)} — totals include every line</span>
          )}
        </div>
        <div style={{ maxHeight: '60vh', overflowY: 'auto', overflowX: 'auto' }}>
          <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, minWidth: 1000 }}>
            <thead>
              <tr style={{ color: 'white', position: 'sticky', top: 0, zIndex: 1 }}>
                <th style={th()}>Depot</th>
                <th style={th()}>Invoice No</th>
                <th style={th()}>Date</th>
                <th style={th()}>Customer</th>
                <th style={th()}>Description of Goods</th>
                <th style={th('center')}>Tax Cat</th>
                <th style={th('right')}>VAT Exclusive</th>
                <th style={th('right')}>VAT</th>
                <th style={th('right')}>Total incl. VAT</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 && !loading && (
                <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No transactions in range.</td></tr>
              )}
              {groups.map((g, gi) => {
                const s = summaryBySlug[g.key] || {};
                // A depot's band opens with its first drawn line; its subtotal
                // closes it once every one of its lines is on screen.
                const startsHere = gi === 0 ? true : groups[gi - 1].key !== g.key;
                const drawnForDepot = lines.filter(l => (l.depot_slug || l.depot_name) === g.key).length;
                const complete = drawnForDepot >= (s.lines || 0);
                return (
                  <React.Fragment key={`${g.key}-${gi}`}>
                    {startsHere && (
                      <tr>
                        <td colSpan={9} style={{ padding: '8px 12px', background: '#f1f4f9', color: '#13306b', fontWeight: 700, borderBottom: '1px solid #e2e6ee' }}>
                          {g.name}
                          <span style={{ fontWeight: 500, color: '#6b7280', marginLeft: 8 }}>
                            {fmtInt(s.invoices)} invoice{s.invoices === 1 ? '' : 's'} · {fmtInt(s.lines)} line{s.lines === 1 ? '' : 's'}
                          </span>
                        </td>
                      </tr>
                    )}
                    {g.lines.map((r, i) => {
                      const cont = i > 0 && g.lines[i - 1].invoice_number === r.invoice_number;
                      return (
                        <tr key={`${g.key}-${gi}-${i}`} style={{ borderBottom: cont ? '1px dotted #f3f4f6' : '1px solid #e5e7eb', background: cont ? '#fbfbfd' : 'white' }}>
                          <td style={{ padding: '10px 12px', color: '#13306b', fontWeight: 600, whiteSpace: 'nowrap' }}>{cont ? '' : r.depot_name}</td>
                          <td style={{ padding: '10px 12px', fontFamily: 'monospace', color: cont ? '#d1d5db' : '#111827' }}>{cont ? '↳' : fmtInvoiceNo(r.invoice_number)}</td>
                          <td style={{ padding: '10px 12px', color: cont ? '#d1d5db' : '#374151' }}>{cont ? '' : fmtDate(r.date)}</td>
                          <td style={{ padding: '10px 12px', color: cont ? '#d1d5db' : '#374151' }}>{cont ? '' : r.customer_name}</td>
                          <td style={{ padding: '10px 12px', maxWidth: 320 }}>{r.description}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }} title={(CATS.find(c => c[0] === r.vat_category) || [])[1] || ''}>
                            <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, background: '#f3f4f6', color: '#374151', fontWeight: 700, fontSize: 12 }}>{r.vat_category || '—'}</span>
                          </td>
                          <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmtMoney(r.vat_excl)}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmtMoney(r.vat_amount)}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600 }}>{fmtMoney(r.total_inc)}</td>
                        </tr>
                      );
                    })}
                    {complete && (gi === groups.length - 1 || groups[gi + 1].key !== g.key) && (
                      <tr style={{ background: '#f9fafb', fontWeight: 700, borderBottom: '2px solid #e5e7eb' }}>
                        <td colSpan={6} style={{ padding: '10px 12px', textAlign: 'right' }}>{g.name} subtotal</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmtMoney(s.excl)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmtMoney(s.vat)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmtMoney(s.total)}</td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {lines.length > 0 && (
                <tr style={{ background: '#f9fafb', fontWeight: 800, position: 'sticky', bottom: 0 }}>
                  <td colSpan={6} style={{ padding: '10px 12px', textAlign: 'right', background: '#f9fafb', borderTop: '2px solid #d1d5db' }}>TOTALS</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', background: '#f9fafb', borderTop: '2px solid #d1d5db' }}>{fmtMoney(totals.excl)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', background: '#f9fafb', borderTop: '2px solid #d1d5db' }}>{fmtMoney(totals.vat)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', background: '#f9fafb', borderTop: '2px solid #d1d5db' }}>{fmtMoney(totals.total)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {lines.length < totalLines && (
          <div style={{ padding: 12, textAlign: 'center', borderTop: '1px solid #e5e7eb' }}>
            <button type="button" onClick={loadMore} disabled={loadingMore}
              style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e2e6ee', background: '#fff', color: '#13306b', fontWeight: 700, cursor: loadingMore ? 'wait' : 'pointer' }}>
              {loadingMore ? 'Loading…' : `Show next ${fmtInt(Math.min(PAGE, totalLines - lines.length))} · ${fmtInt(totalLines - lines.length)} more`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
