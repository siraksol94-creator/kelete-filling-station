import React, { useState, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { getVatReport, getSettings } from '../services/api';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';

// v1.13.115 — ZRA Ref 9 VAT Transaction Report page.
// v1.13.128k — Restructured line-by-line (not per-invoice) so mixed-Cat
// invoices (e.g. Cat D empties + Cat B MTV drinks + Cat A snacks on the
// same sale) show each line's own VAT reasoning. Adds Tax Cat column,
// renames "Value (Net)" → "VAT Exclusive", makes the table body
// independently scrollable with a sticky header, and routes the invoice
// number through fmtInvoiceNo so pre-VSDC display shows INV- (matches
// the receipt) while the DB continues to store the raw ORD- string.

const todayStr = new Date().toISOString().split('T')[0];
const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

const fmtMoney = (n) => Number(n || 0).toFixed(2);
const fmtDate = (d) => d ? new Date(d).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

const ACCENT = '#b91c1c';

// ZRA VAT category labels — used only for the tooltip / export legend.
// Codes come straight from the VSDC API spec §6.1.
const CAT_LABEL = {
  A:    'Standard 16%',
  B:    'MTV 16%',
  C1:   'Zero-rated (Exports)',
  C2:   'Zero-rated (LPO)',
  C3:   'Zero-rated by nature',
  D:    'Exempt',
  E:    'Disbursement',
  RVAT: 'Reverse VAT',
  F:    'Service Charge 10%',
};

const VatReport = () => {
  const [from, setFrom]       = useState(firstOfMonth);
  const [to, setTo]           = useState(todayStr);
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [business, setBusiness] = useState({});

  useEffect(() => {
    getSettings().then(r => setBusiness(r.data?.business || {})).catch(() => {});
    fetchReport();
    // eslint-disable-next-line
  }, []);

  const fetchReport = async () => {
    setLoading(true); setError('');
    try {
      const fromTs = from ? `${from} 00:00:00` : undefined;
      const toTs   = to   ? `${to} 23:59:59`   : undefined;
      const res = await getVatReport({ from: fromTs, to: toTs });
      setRows(res.data || []);
    } catch (e) {
      setError(e?.response?.data?.error || e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  const totals = rows.reduce((acc, r) => ({
    vat_excl:   acc.vat_excl   + Number(r.vat_excl   || 0),
    vat_amount: acc.vat_amount + Number(r.vat_amount || 0),
    total_inc:  acc.total_inc  + Number(r.total_inc  || 0),
  }), { vat_excl: 0, vat_amount: 0, total_inc: 0 });

  // Count of distinct invoices in the current row set — the "12 invoices"
  // header line no longer equals rows.length once we break out per line.
  const invoiceCount = new Set(rows.map(r => r.invoice_number)).size;

  const handleExport = () => {
    if (!rows.length) return;
    const header = ['Invoice No', 'Date', 'Customer', 'Description of Goods', 'Tax Cat', 'VAT Exclusive (K)', 'VAT (K)', 'Total incl. VAT (K)'];
    const data = rows.map(r => [
      fmtInvoiceNo(r.invoice_number),
      fmtDate(r.date),
      r.customer_name,
      r.description,
      r.vat_category || '',
      fmtMoney(r.vat_excl),
      fmtMoney(r.vat_amount),
      fmtMoney(r.total_inc),
    ]);
    data.push([]);
    data.push(['', '', '', '', 'TOTALS', fmtMoney(totals.vat_excl), fmtMoney(totals.vat_amount), fmtMoney(totals.total_inc)]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...data]);
    ws['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 22 }, { wch: 34 }, { wch: 9 }, { wch: 16 }, { wch: 12 }, { wch: 18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'VAT Transactions');
    const bname = (business?.business_name || 'Report').replace(/[^\w\s-]/g, '');
    XLSX.writeFile(wb, `VAT_Transactions_${bname}_${from}_to_${to}.xlsx`);
  };

  // Visually collapse the invoice/date/customer columns for consecutive
  // rows belonging to the same invoice — so a 3-line sale looks grouped
  // without merging the underlying data (each row stays independently
  // auditable and independently exportable).
  const isContinuation = (i) => i > 0 && rows[i - 1].invoice_number === rows[i].invoice_number;

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
        <div style={{ background: ACCENT, color: 'white', borderRadius: 10, padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>VAT Transaction Report</div>
          <div style={{ fontSize: 13, color: '#6b7280' }}>Line-by-line list of VAT-exclusive value, VAT and total for non-reversed sales — for ZRA Ref 9 / attachment 5.</div>
        </div>
        <button onClick={handleExport} disabled={!rows.length} style={{
          background: '#16a34a', color: 'white', border: 'none', borderRadius: 6,
          padding: '10px 16px', fontWeight: 600, cursor: rows.length ? 'pointer' : 'not-allowed', opacity: rows.length ? 1 : 0.5,
        }}>Export to Excel</button>
      </div>

      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 4 }}>From</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ padding: 8, border: '1px solid #d1d5db', borderRadius: 6 }} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: '#374151', marginBottom: 4 }}>To</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ padding: 8, border: '1px solid #d1d5db', borderRadius: 6 }} />
          </div>
          <button onClick={fetchReport} disabled={loading} style={{
            background: ACCENT, color: 'white', border: 'none', borderRadius: 6, padding: '10px 20px', fontWeight: 600, cursor: 'pointer',
          }}>{loading ? 'Loading…' : 'Show'}</button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#fee2e2', color: '#991b1b', padding: 12, borderRadius: 6, marginBottom: 12 }}>{error}</div>
      )}

      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', fontWeight: 600 }}>
          {invoiceCount} invoice{invoiceCount === 1 ? '' : 's'} · {rows.length} line{rows.length === 1 ? '' : 's'}
        </div>
        {/* v1.13.128k — Sticky-header scrollable body. The table scrolls
            inside its own container so header + toolbar stay pinned when
            reviewing long ranges. */}
        <div style={{ maxHeight: '60vh', overflowY: 'auto', overflowX: 'auto' }}>
          <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: ACCENT, color: 'white', position: 'sticky', top: 0, zIndex: 1 }}>
                <th style={{ padding: '10px 12px', textAlign: 'left',  background: ACCENT }}>Invoice No</th>
                <th style={{ padding: '10px 12px', textAlign: 'left',  background: ACCENT }}>Date</th>
                <th style={{ padding: '10px 12px', textAlign: 'left',  background: ACCENT }}>Customer</th>
                <th style={{ padding: '10px 12px', textAlign: 'left',  background: ACCENT }}>Description of Goods</th>
                <th style={{ padding: '10px 12px', textAlign: 'center',background: ACCENT }}>Tax Cat</th>
                <th style={{ padding: '10px 12px', textAlign: 'right', background: ACCENT }}>VAT Exclusive</th>
                <th style={{ padding: '10px 12px', textAlign: 'right', background: ACCENT }}>VAT</th>
                <th style={{ padding: '10px 12px', textAlign: 'right', background: ACCENT }}>Total incl. VAT</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No transactions in range.</td></tr>
              )}
              {rows.map((r, i) => {
                const cont = isContinuation(i);
                return (
                  <tr key={i} style={{ borderBottom: cont ? '1px dotted #f3f4f6' : '1px solid #e5e7eb', background: cont ? '#fbfbfd' : 'white' }}>
                    <td style={{ padding: '10px 12px', fontFamily: 'monospace', color: cont ? '#d1d5db' : '#111827' }}>{cont ? '↳' : fmtInvoiceNo(r.invoice_number)}</td>
                    <td style={{ padding: '10px 12px', color: cont ? '#d1d5db' : '#374151' }}>{cont ? '' : fmtDate(r.date)}</td>
                    <td style={{ padding: '10px 12px', color: cont ? '#d1d5db' : '#374151' }}>{cont ? '' : r.customer_name}</td>
                    <td style={{ padding: '10px 12px', maxWidth: 320 }}>{r.description}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'center' }} title={CAT_LABEL[r.vat_category] || ''}>
                      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, background: '#f3f4f6', color: '#374151', fontWeight: 700, fontSize: 12 }}>{r.vat_category || '—'}</span>
                    </td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmtMoney(r.vat_excl)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>{fmtMoney(r.vat_amount)}</td>
                    <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600 }}>{fmtMoney(r.total_inc)}</td>
                  </tr>
                );
              })}
              {rows.length > 0 && (
                <tr style={{ background: '#f9fafb', fontWeight: 700, position: 'sticky', bottom: 0 }}>
                  <td colSpan={5} style={{ padding: '10px 12px', textAlign: 'right', background: '#f9fafb' }}>TOTALS</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', background: '#f9fafb' }}>{fmtMoney(totals.vat_excl)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', background: '#f9fafb' }}>{fmtMoney(totals.vat_amount)}</td>
                  <td style={{ padding: '10px 12px', textAlign: 'right', background: '#f9fafb' }}>{fmtMoney(totals.total_inc)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default VatReport;
