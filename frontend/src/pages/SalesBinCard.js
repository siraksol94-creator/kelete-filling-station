import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getProducts, getSalesBinCard, getSettings, getHqGrnForBranch } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { FiSearch, FiPrinter, FiShoppingCart, FiArrowDown, FiArrowUp, FiActivity, FiLock, FiUnlock, FiSmartphone, FiFileText, FiX } from 'react-icons/fi';
import { pickDisplayUnit } from '../utils/productUnits';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';

// Map a document reference number to the page that hosts its detail view.
// Returns { path, ref } for clickable references, or null for plain text
// (e.g. internal labels like 'credit_note', 'opening', 'adjustment').
function refTarget(refNumber) {
  if (!refNumber) return null;
  const s = String(refNumber).trim();
  if (/^SIV-/i.test(s)) return { path: '/stock/siv', ref: s };
  if (/^GRN-/i.test(s)) return { path: '/stock/grn', ref: s };
  return null;
}

const todayStr = new Date().toISOString().split('T')[0];
const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

const formatDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

// 2026-08-30 — covers every movement_type the sales bin card can surface.
// It previously stopped at six, so GRN, transfer and credit-note rows printed
// their raw database value ("grn", "transfer") in the Type column. Transfer
// direction comes from the sign of the quantity, since both directions share
// one movement_type. Anything unrecognised is title-cased rather than shown
// raw, so a new type reads cleanly the day it appears.
const movementLabel = (type, qty) => {
  if (type === 'siv')            return 'SIV In';
  if (type === 'sale')           return 'Sale';
  if (type === 'sale_reverse')   return 'Sale Reversal';
  if (type === 'reverse')        return 'Reversal';
  if (type === 'sales_return')   return 'Return';
  if (type === 'reconciliation') return 'Reconciliation';
  if (type === 'adjustment')     return 'Adjustment';
  if (type === 'grn')            return 'GRN In';
  if (type === 'hq_grn')         return 'HQ GRN In';
  if (type === 'credit_note')    return 'Credit Note Out';
  if (type === 'transfer')       return parseFloat(qty) > 0 ? 'Transfer In' : 'Transfer Out';
  if (type === 'transfer_in')    return 'Transfer In';
  if (type === 'transfer_out')   return 'Transfer Out';
  if (type === 'production')     return 'Production';
  if (type === 'opening')        return 'Opening';
  return String(type || '').replace(/_/g, ' ').replace(/\w/g, c => c.toUpperCase());
};

const typeStyle = (type) => {
  if (type === 'grn' || type === 'hq_grn') return { background: '#dcfce7', color: '#166534' }; // green — IN
  if (type === 'credit_note')   return { background: '#fee2e2', color: '#dc2626' };            // red — OUT
  if (type === 'transfer' || type === 'transfer_in' || type === 'transfer_out')
                                return { background: '#e0e7ff', color: '#4338ca' };            // indigo
  if (type === 'production')    return { background: '#cffafe', color: '#0e7490' };
  if (type === 'siv')           return { background: '#dcfce7', color: '#166534' };
  if (type === 'sale')          return { background: '#fee2e2', color: '#dc2626' };
  if (type === 'reverse')       return { background: '#dbeafe', color: '#1d4ed8' };
  if (type === 'sales_return')  return { background: '#fef9c3', color: '#854d0e' };
  if (type === 'reconciliation') return { background: '#ede9fe', color: '#7c3aed' };
  return { background: '#f3f4f6', color: '#374151' };
};

const ACCENT = '#b91c1c';
const ACCENT_DARK = '#7f1d1d';
const ACCENT_LIGHT = '#fef2f2';

const SalesBinCard = () => {
  const navigate = useNavigate();
  const { user: authUser } = useAuth();
  const [products, setProducts]           = useState([]);
  const [productId, setProductId]         = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [from, setFrom]                   = useState(firstOfMonth);
  const [to, setTo]                       = useState(todayStr);
  const [rows, setRows]                   = useState([]);
  const [openingBal, setOpeningBal]       = useState(0);
  const [loading, setLoading]             = useState(false);
  const [error, setError]                 = useState('');
  const [searched, setSearched]           = useState(false);
  const [businessInfo, setBusinessInfo]   = useState({});
  const [showPrint, setShowPrint]         = useState(false);
  const [stickyLocked, setStickyLocked]   = useState(true);
  // 2026-09-26 — IN/OUT/All row filter, ported from Kelete v1.10.315. Purely
  // a view: the totals bar stays period-wide and the Balance column keeps the
  // backend's cumulative running total, so narrowing to IN or OUT never
  // rewrites the history the card is reporting.
  const [rowFilter, setRowFilter]         = useState('all');
  // 2026-09-17 — phones never pin the top block and never cap the table's
  // height: the block is nearly the whole screen there, and the capped table
  // left a thin strip that scrolled while everything above it stayed put, so
  // the page felt stuck. On a phone the whole page scrolls, as it should.
  const [isPhone, setIsPhone] = useState(
    typeof window !== 'undefined' && window.innerWidth <= 768
  );
  useEffect(() => {
    const onResize = () => setIsPhone(window.innerWidth <= 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const pinned = stickyLocked && !isPhone;

  useModalScrollLock(showPrint);

  // 2026-08-30 — HQ GRN read-only modal. A GRN reference on this page points
  // at master.hq_grns, not the branch grn table, so it cannot be navigated to
  // — it is fetched and shown here instead.
  const [hqGrn, setHqGrn]               = useState(null);
  const [hqGrnLoading, setHqGrnLoading] = useState(false);
  const [hqGrnError, setHqGrnError]     = useState('');
  useModalScrollLock(!!(hqGrn || hqGrnLoading || hqGrnError));

  const openHqGrn = async (syncId) => {
    if (!syncId) return;
    setHqGrn(null); setHqGrnError(''); setHqGrnLoading(true);
    try {
      const res = await getHqGrnForBranch(syncId);
      setHqGrn(res.data);
    } catch (err) {
      setHqGrnError(err.response?.data?.error || 'Failed to load HQ GRN.');
    } finally {
      setHqGrnLoading(false);
    }
  };
  const closeHqGrn = () => { setHqGrn(null); setHqGrnError(''); setHqGrnLoading(false); };

  // Quantities and money in the modal — plain grouped numbers, 2dp.
  const money = (n) => (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  useEffect(() => {
    // v1.6.3: hide inactive items from the product picker.
    getProducts().then(r => setProducts(
      (r.data || []).filter(p => (p.status || 'Active') !== 'Inactive').sort((a, b) => a.name.localeCompare(b.name))
    )).catch(() => {});
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
  }, []);

  const selectedProduct = products.find(p => String(p.id) === String(productId));

  const handleProductInput = (val) => {
    setProductSearch(val);
    const match = products.find(p => `${p.name}${p.unit ? ` (${p.unit})` : ''}` === val);
    setProductId(match ? String(match.id) : '');
  };

  const handleSearch = async () => {
    if (!productId) { setError('Please select a product.'); return; }
    setError('');
    setLoading(true);
    try {
      const res = await getSalesBinCard({ product_id: productId, from, to });
      setRows(res.data?.rows || []);
      setOpeningBal(parseFloat(res.data?.opening_balance ?? 0));
      setSearched(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load sales bin card.');
    } finally {
      setLoading(false);
    }
  };

  // Convert base-unit movements/balances into the product's display unit so
  // everything (cards, table, totals, print) renders in the same unit.
  const dispUnit = pickDisplayUnit(selectedProduct);
  const conv = dispUnit?.conv || 1;
  const toDisp = (baseQty) => parseFloat(baseQty || 0) / conv;
  const unitLabel = dispUnit?.name || selectedProduct?.unit || '';

  const totalIn  = toDisp(rows.filter(r => parseFloat(r.quantity) > 0).reduce((s, r) => s + parseFloat(r.quantity), 0));
  const totalOut = toDisp(rows.filter(r => parseFloat(r.quantity) < 0).reduce((s, r) => s + Math.abs(parseFloat(r.quantity)), 0));
  const openBal  = toDisp(openingBal);
  const closeBal = toDisp(rows.length > 0 ? parseFloat(rows[rows.length - 1].balance) : openingBal);
  // The rows each table actually renders. The counts on the pills come from
  // the unfiltered set, so "OUT 529" keeps saying 529 while OUT is selected.
  const inCount      = rows.filter(r => parseFloat(r.quantity) > 0).length;
  const outCount     = rows.filter(r => parseFloat(r.quantity) < 0).length;
  const visibleRows  = rowFilter === 'in'  ? rows.filter(r => parseFloat(r.quantity) > 0)
                     : rowFilter === 'out' ? rows.filter(r => parseFloat(r.quantity) < 0)
                     : rows;

  // v1.13.121 — A4 print that opens the browser print dialog directly
  // (matches ProfitReport / SalesReport / SalesInventory style). Replaces
  // the modal-based preview so all Ref-13 report prints look identical.
  const handleA4Print = () => {
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const printedBy = [authUser?.firstName, authUser?.lastName].filter(Boolean).join(' ') || '—';
    const bizName = businessInfo?.business_name || 'Business Name';
    const bizAddr = businessInfo?.business_address || '';
    const bizPhone = businessInfo?.business_phone || '';
    const rangeLabel = from === to ? formatDate(from) : `${formatDate(from)}  →  ${formatDate(to)}`;
    const productLabel = `${selectedProduct?.name || ''}${unitLabel ? '  ·  ' + unitLabel : ''}`;

    const fmtN = (v) => (parseFloat(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const openingRow = `<tr style="background:#eff6ff">
      <td style="padding:7px 10px;color:#9ca3af">—</td>
      <td style="padding:7px 10px">${formatDate(from)}</td>
      <td style="padding:7px 10px;color:#9ca3af">—</td>
      <td style="padding:7px 10px;color:#1d4ed8;font-weight:700">Opening Balance</td>
      <td style="padding:7px 10px;text-align:right;color:#166534;font-weight:700">${openBal > 0 ? fmtN(openBal) : ''}</td>
      <td style="padding:7px 10px;text-align:right">—</td>
      <td style="padding:7px 10px;text-align:right;color:#1d4ed8;font-weight:800">${fmtN(openBal)}</td>
    </tr>`;

    // Prints what is on screen. The Balance column carries the backend's
    // cumulative running total and the totals block stays period-wide, so a
    // filtered print reads like a bank statement narrowed to withdrawals --
    // fewer lines, same true balances.
    const bodyRows = visibleRows.map((row, idx) => {
      const q = parseFloat(row.quantity);
      const inV  = q > 0 ? fmtN(toDisp(q)) : '';
      const outV = q < 0 ? fmtN(toDisp(Math.abs(q))) : '';
      return `<tr style="background:${idx % 2 === 0 ? '#fff' : '#f9fafb'};border-bottom:1px solid #f3f4f6">
        <td style="padding:6px 10px;color:#9ca3af">${idx + 1}</td>
        <td style="padding:6px 10px">${formatDate(row.date)}</td>
        <td style="padding:6px 10px;font-weight:600">${fmtInvoiceNo(row.reference) || '—'}</td>
        <td style="padding:6px 10px;color:#374151">${movementLabel(row.movement_type, row.quantity)}</td>
        <td style="padding:6px 10px;text-align:right;color:#166534;font-weight:700">${inV}</td>
        <td style="padding:6px 10px;text-align:right;color:#dc2626;font-weight:700">${outV}</td>
        <td style="padding:6px 10px;text-align:right;font-weight:800">${fmtN(toDisp(parseFloat(row.balance) || 0))}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales Bin Card — ${productLabel}</title><style>
      @page{size:A4 landscape;margin:12mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:8px 10px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10.5px;background:#f0f0f0;text-align:left}
      td{font-size:11px}
      tfoot td{padding:9px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:20px;font-weight:800;letter-spacing:0.3px;margin-bottom:3px">${bizName}</div>
          <div style="font-size:10px;line-height:1.6">${[bizAddr, bizPhone].filter(Boolean).join('  |  ')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:3px">Sales Bin Card</div>
          <div style="font-size:14px;font-weight:700">${productLabel}</div>
          <div style="font-size:10px;margin-top:2px">${rangeLabel}</div>
          <div style="font-size:9px;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:14px">
        ${[
          ['Opening Balance', `${fmtN(openBal)} ${unitLabel || ''}`],
          ['Total In',        `${fmtN(totalIn)} ${unitLabel || ''}`],
          ['Total Out',       `${fmtN(totalOut)} ${unitLabel || ''}`],
          ['Closing Balance', `${fmtN(closeBal)} ${unitLabel || ''}`],
        ].map(([lbl, val]) => `
          <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
            <div style="font-size:14px;font-weight:800;font-family:monospace">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:14px">
        <table>
          <thead><tr>
            <th style="width:28px">#</th>
            <th>Date</th>
            <th>Reference</th>
            <th>Type</th>
            <th style="text-align:right">In</th>
            <th style="text-align:right">Out</th>
            <th style="text-align:right">Balance</th>
          </tr></thead>
          <tbody>${openingRow}${bodyRows}</tbody>
          <tfoot><tr>
            <td colspan="4">TOTALS — ${rows.length} movement${rows.length !== 1 ? 's' : ''}</td>
            <td style="text-align:right;color:#166534">${fmtN(totalIn)}</td>
            <td style="text-align:right;color:#dc2626">${fmtN(totalOut)}</td>
            <td style="text-align:right">${fmtN(closeBal)}</td>
          </tr></tfoot>
        </table>
      </div>
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
        <span style="font-size:9px">${bizName} — Confidential</span>
        <span style="font-size:9px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => { w.print(); }, 300); }
  };

  // Thermal (80mm) print — compact bin-card that fits a receipt roll.
  // Opens a new window with a print-only stylesheet and triggers print
  // immediately. Same pattern the POS receipt uses.
  const handleThermalPrint = () => {
    const bName    = businessInfo?.business_name    || 'Kelete';
    const bAddress = businessInfo?.business_address || '';
    const bPhone   = businessInfo?.business_phone   || '';
    const div = '='.repeat(42);
    const dash = '-'.repeat(42);
    const nf2 = (n) => (parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const rowsHtml = [
      // Opening row
      `<tr><td colspan="4" style="padding-top:3px;font-weight:700;">Opening Balance</td>
           <td style="text-align:right;font-weight:700;">${nf2(openBal)} ${unitLabel}</td></tr>`,
      // Movements
      ...visibleRows.map(r => {
        const q = toDisp(r.quantity);
        const bal = toDisp(r.balance);
        const inQty  = q > 0 ? nf2(q) : '';
        const outQty = q < 0 ? nf2(Math.abs(q)) : '';
        return `<tr>
          <td style="font-size:10px;">${(r.created_at || '').slice(0, 10)}</td>
          <td style="font-size:10px;">${(fmtInvoiceNo(r.reference_number) || movementLabel(r.movement_type, r.quantity) || '').slice(0, 14)}</td>
          <td style="text-align:right;font-size:10px;">${inQty}</td>
          <td style="text-align:right;font-size:10px;">${outQty}</td>
          <td style="text-align:right;font-size:10px;">${nf2(bal)}</td>
        </tr>`;
      }),
    ].join('');

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  /* 2026-08-30 — 72mm, NOT 80mm. 80mm is the width of the PAPER; the print
     head only covers 72mm. The driver says so itself: its paper setting
     reads "ZPrinter Paper(80(72) x 3276mm)" — 80mm roll, 72mm printable.
     Declaring 80mm made Chrome lay the receipt out 8mm wider than the
     printer can reach, and the driver simply dropped the overhang. Every
     line lost the same three or four characters off the right: Walk-i(n),
     ZM(W), INV0060001067/9(0), 77.3(7). It read as a table problem, but the
     header and totals were clipped too — the canvas was just too wide.
     Matching the canvas to the print head means nothing can fall off. */
  @page { size: 72mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; }
  /* 2026-09-01 — same left-edge shift as every other 72mm print in this
     codebase. 4mm left, 0 right: the content moves across without the
     content area getting any narrower. */
  body { width: 72mm; max-width: 72mm; padding: 2mm 0 2mm 4mm;
         font-family: 'Courier New', Courier, monospace; font-size: 10px; color: #000; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 10px; }
  /* 2026-08-30 — see the note in the tax-invoice templates: width:100% on a
     table is only a suggestion under table-layout:auto, so an unbreakable
     value (an invoice number, a TPIN) stretches the table past the paper and
     carries every right-aligned figure off the edge with it. */
  /* 2026-08-30 — tables stop at 86% of the body. The remaining 14% is
     deliberately never printed on.
     Four earlier attempts tried to make the content FIT inside 100% —
     narrower page, narrower columns, smaller font, wrapping cells. But 100%
     is where the loss happens: a right-aligned value sits on the print
     head's last dot, and that dot is unreliable. It is why even 77.37 came
     out as 77.3 while the centred lines beside it printed in full.
     The reference receipt this was compared against does the same thing —
     its item table visibly stops well short of the edge. Leaving slack means
     an overflow eats into the margin instead of falling off the paper, and
     the Total column — the number that matters most and was always last in
     the row — is no longer the one closest to the cut. */
  table { width: 86%; max-width: 86%; }
  table tr > td:last-child { overflow-wrap: anywhere; word-break: break-word; }
  td, th { padding: 1px 0; vertical-align: top; }
  .c { text-align: center; }
  .divider { text-align: center; font-size: 9px; overflow: hidden; white-space: nowrap; margin: 3px 0; }
  .lbl { color: #000; }
</style></head><body>
  <div class="c" style="font-size:14px;letter-spacing:1px;">${bName}</div>
  ${bAddress ? `<div class="c" style="font-size:10px;">${String(bAddress).replace(/\n/g, '<br/>')}</div>` : ''}
  ${bPhone ? `<div class="c" style="font-size:10px;">Tel: ${bPhone}</div>` : ''}
  <div class="divider">${div}</div>
  <div class="c" style="font-weight:700;font-size:11px;">SALES BIN CARD</div>
  <div class="divider">${div}</div>
  <table>
    <tr><td>Product:</td><td style="text-align:right;">${(selectedProduct?.name || '').slice(0, 24)}</td></tr>
    <tr><td>Unit:</td><td style="text-align:right;">${unitLabel}</td></tr>
    <tr><td>From:</td><td style="text-align:right;">${formatDate(from)}</td></tr>
    <tr><td>To:</td><td style="text-align:right;">${formatDate(to)}</td></tr>
  </table>
  <div class="divider">${dash}</div>
  <table>
    <thead><tr>
      <th style="text-align:left;font-size:10px;">Date</th>
      <th style="text-align:left;font-size:10px;">Ref</th>
      <th style="text-align:right;font-size:10px;">In</th>
      <th style="text-align:right;font-size:10px;">Out</th>
      <th style="text-align:right;font-size:10px;">Bal</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
  </table>
  <div class="divider">${div}</div>
  <table>
    <tr><td>Total In:</td><td style="text-align:right;font-weight:700;">${nf2(totalIn)} ${unitLabel}</td></tr>
    <tr><td>Total Out:</td><td style="text-align:right;font-weight:700;">${nf2(totalOut)} ${unitLabel}</td></tr>
    <tr><td>Closing Balance:</td><td style="text-align:right;font-weight:700;">${nf2(closeBal)} ${unitLabel}</td></tr>
  </table>
  <div class="divider">${div}</div>
  <div class="c" style="font-size:9px;">Printed: ${new Date().toLocaleString('en-GB')}</div>
</body></html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Popup blocked — allow popups to print.'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { try { w.print(); } catch (_) {} }, 200);
  };

  return (
    // 2026-09-17 — the page's own scroll box, as every other page has. It used
    // to be a plain div, so nothing here scrolled on its own: the whole window
    // did, and the Locked (sticky) top block scrolled away with it — the
    // Locked / Unlocked button appeared to do nothing, on phones especially.
    <div className="page-content" style={{ background: '#f8fafc' }}>

      {/* Sticky top block — Header + Filter + Summary. Lock toggle keeps it
          pinned at the top of the viewport so long scrolling tables stay
          under it. Unlock to reclaim screen space (default browser flow). */}
      <div style={{
        position: pinned ? 'sticky' : 'static',
        top: 0,
        zIndex: 20,
        background: '#f8fafc',
        paddingTop: pinned ? 8 : 0,
        marginTop: pinned ? -8 : 0,
      }}>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 44, height: 44, borderRadius: 12, background: `linear-gradient(135deg,${ACCENT_DARK},${ACCENT})`, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(185,28,28,0.25)' }}>
              <FiShoppingCart size={22} color="#fff" />
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>Sales Bin Card</h1>
              <p style={{ margin: 0, fontSize: 13, color: '#6b7280' }}>Sales counter stock movement history per product</p>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* Pinning only makes sense where there is room for it. */}
            {!isPhone && <button onClick={() => setStickyLocked(v => !v)}
              title={stickyLocked ? 'Unlock top section (scrolls away)' : 'Lock top section (stays pinned on scroll)'}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 8, border: `1.5px solid ${stickyLocked ? ACCENT : '#d1d5db'}`, background: stickyLocked ? '#fef2f2' : '#fff', color: stickyLocked ? ACCENT : '#374151', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
              {stickyLocked ? <FiLock size={14} /> : <FiUnlock size={14} />}
              {stickyLocked ? 'Locked' : 'Unlocked'}
            </button>}
            {searched && (rows.length > 0 || openBal > 0) && (
              <>
                <button onClick={handleThermalPrint}
                  title="Print on 80mm thermal receipt printer"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 8, border: `1.5px solid ${ACCENT}`, background: '#fff', color: ACCENT, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                  <FiSmartphone size={14} /> Thermal
                </button>
                <button onClick={handleA4Print}
                  title="Print full page (A4)"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 18px', borderRadius: 8, border: 'none', background: ACCENT, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  <FiPrinter size={15} /> Print
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Filter Bar */}
      <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb', padding: '18px 20px', marginBottom: 24, display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        <div style={{ flex: '2 1 220px', minWidth: 180 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Product *</label>
          <input list="salesbincard-products" value={productSearch} onChange={e => handleProductInput(e.target.value)}
            placeholder="Type or select a product…"
            style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }} />
          <datalist id="salesbincard-products">
            {products.map(p => <option key={p.id} value={`${p.name}${p.unit ? ` (${p.unit})` : ''}`} />)}
          </datalist>
        </div>
        <div style={{ flex: '1 1 140px', minWidth: 130 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }} />
        </div>
        <div style={{ flex: '1 1 140px', minWidth: 130 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            style={{ width: '100%', padding: '9px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13 }} />
        </div>
        <div>
          <button onClick={handleSearch} disabled={loading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 22px', borderRadius: 8, border: 'none', background: loading ? '#9ca3af' : ACCENT, color: '#fff', cursor: loading ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>
            <FiSearch size={14} /> {loading ? 'Loading…' : 'Show'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 16px', marginBottom: 20, fontSize: 13, color: '#dc2626' }}>{error}</div>
      )}

      {/* Summary Cards */}
      {searched && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 14, marginBottom: 24 }}>
          {[
            // money() is the file's 2-dp grouped formatter (line 133) and is
            // already used for quantities further down. toFixed(2) gave
            // "4404.00" where every other figure on the page reads "4,404.00".
            { label: 'Opening Balance', value: money(openBal),  unit: unitLabel, color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe', icon: <FiActivity size={18} /> },
            { label: 'Total In',        value: money(totalIn),  unit: unitLabel, color: '#166534', bg: '#dcfce7', border: '#86efac', icon: <FiArrowDown size={18} /> },
            { label: 'Total Out',       value: money(totalOut), unit: unitLabel, color: '#b45309', bg: '#fef9c3', border: '#fcd34d', icon: <FiArrowUp size={18} /> },
            { label: 'Closing Balance', value: money(closeBal), unit: unitLabel, color: '#7c3aed', bg: '#f5f3ff', border: '#c4b5fd', icon: <FiShoppingCart size={18} /> },
          ].map((c, i) => (
            <div key={i} style={{ background: c.bg, border: `1px solid ${c.border}`, borderRadius: 12, padding: '16px 18px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: c.color }}>{c.label}</span>
                <span style={{ color: c.color }}>{c.icon}</span>
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: c.color }}>{c.value}</div>
              {c.unit && <div style={{ fontSize: 11, color: c.color, opacity: 0.7, marginTop: 2 }}>{c.unit}</div>}
            </div>
          ))}
        </div>
      )}

      </div>
      {/* End sticky top block */}

      {/* Table */}
      {searched && (
        <div style={{ background: '#fff', borderRadius: 12, border: '1px solid #e5e7eb' }}>
          <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', background: '#f9fafb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>
              {selectedProduct ? selectedProduct.name : 'Product'} — Sales Bin Card
            </div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {formatDate(from)} – {formatDate(to)} &nbsp;·&nbsp; {rows.length} movement{rows.length !== 1 ? 's' : ''}
            </div>
          </div>

          {rows.length > 0 && (() => {
            const pill = (key, label, count, activeBg) => {
              const active = rowFilter === key;
              return (
                <button key={key} onClick={() => setRowFilter(key)}
                  style={{
                    padding: '6px 14px', borderRadius: 20,
                    border: `1px solid ${active ? activeBg : '#e5e7eb'}`,
                    background: active ? activeBg : '#fff',
                    color: active ? '#fff' : '#374151',
                    fontSize: 12, fontWeight: 700, cursor: 'pointer',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                  }}>
                  {label}
                  <span style={{ background: active ? '#fff' : '#f3f4f6', color: active ? activeBg : '#6b7280', borderRadius: 10, padding: '1px 7px', fontSize: 11 }}>{count}</span>
                </button>
              );
            };
            return (
              <div style={{ padding: '10px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', gap: 8, alignItems: 'center', background: '#fff', flexWrap: 'wrap' }}>
                {pill('all', 'All', rows.length, ACCENT)}
                {pill('in',  'IN',  inCount,     '#166534')}
                {pill('out', 'OUT', outCount,    '#b45309')}
              </div>
            );
          })()}

          {rows.length === 0 && openBal === 0 ? (
            <div style={{ padding: 48, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>
              No sales movements found for this product in the selected period.
            </div>
          ) : (
            <div style={isPhone
              ? { overflowX: 'auto' }
              : { overflowX: 'auto', overflowY: 'auto', maxHeight: 'calc(100vh - 520px)', minHeight: 120 }}>
              <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 2 }}>
                  <tr style={{ background: ACCENT, color: '#fff' }}>
                    {['#', 'Date', 'Reference', 'Type', 'In', 'Out', 'Balance'].map((h, i) => (
                      <th key={i} style={{ padding: '11px 14px', textAlign: i >= 4 ? 'right' : 'left', fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.4, whiteSpace: 'nowrap', background: ACCENT }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr style={{ background: '#eff6ff', borderBottom: '1px solid #dbeafe' }}>
                    <td style={{ padding: '10px 14px', color: '#9ca3af', fontFamily: 'monospace' }}>—</td>
                    <td style={{ padding: '10px 14px', color: '#374151', whiteSpace: 'nowrap' }}>{formatDate(from)}</td>
                    <td style={{ padding: '10px 14px', color: '#6b7280' }}>—</td>
                    <td style={{ padding: '10px 14px' }}>
                      <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: '#dbeafe', color: '#1d4ed8' }}>Opening Balance</span>
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#166534', fontWeight: 700, fontFamily: 'monospace' }}>{openBal > 0 ? money(openBal) : '—'}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#dc2626', fontWeight: 700, fontFamily: 'monospace' }}>—</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#1d4ed8', fontWeight: 800, fontFamily: 'monospace' }}>{(parseFloat(openBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                  </tr>
                  {visibleRows.map((row, idx) => {
                    const qty   = parseFloat(row.quantity);
                    const isIn  = qty > 0;
                    const isOut = qty < 0;
                    const ts    = typeStyle(row.movement_type);
                    return (
                      <tr key={row.id} style={{ background: idx % 2 === 0 ? '#fff' : '#fafafa', borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '10px 14px', color: '#9ca3af', fontFamily: 'monospace' }}>{idx + 1}</td>
                        <td style={{ padding: '10px 14px', color: '#374151', whiteSpace: 'nowrap' }}>{formatDate(row.date)}</td>
                        <td style={{ padding: '10px 14px', color: '#111827', fontWeight: 600 }}>
                          {(() => {
                            // 2026-08-30 — a GRN reference opens the HQ
                            // read-only modal, not the branch GRN page. Red
                            // Sea procurement is HQ-owned, so the row lives in
                            // master.hq_grns and the branch GRN page has
                            // nothing to show. SIV references still navigate —
                            // those are branch-owned.
                            const t = refTarget(row.reference);
                            const displayRef = fmtInvoiceNo(row.reference);
                            const isGrn = /^GRN-/i.test(String(row.reference || ''));
                            if (isGrn && row.reference_sync_id) {
                              return <button type="button"
                                onClick={() => openHqGrn(row.reference_sync_id)}
                                style={{ background: 'none', border: 'none', padding: 0, color: '#1d4ed8', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3, fontSize: 'inherit', fontFamily: 'inherit' }}>
                                {displayRef}
                              </button>;
                            }
                            return t
                              ? <button type="button"
                                  onClick={() => navigate(`${t.path}?ref=${encodeURIComponent(t.ref)}`)}
                                  style={{ background: 'none', border: 'none', padding: 0, color: '#1d4ed8', fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3, fontSize: 'inherit', fontFamily: 'inherit' }}>
                                  {displayRef}
                                </button>
                              : (displayRef || '—');
                          })()}
                          {row.source_grn_number && (() => {
                            const g = refTarget(row.source_grn_number);
                            return g
                              ? <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, color: '#6b7280' }}>
                                  (from <button type="button"
                                    onClick={() => navigate(`${g.path}?ref=${encodeURIComponent(g.ref)}`)}
                                    style={{ background: 'none', border: 'none', padding: 0, color: '#1d4ed8', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3, fontSize: 'inherit', fontFamily: 'inherit', fontWeight: 500 }}>
                                    {row.source_grn_number}
                                  </button>)
                                </span>
                              : <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, color: '#6b7280' }}>(from {row.source_grn_number})</span>;
                          })()}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, ...ts }}>
                            {movementLabel(row.movement_type, row.quantity)}
                          </span>
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', color: '#166534', fontWeight: 700, fontFamily: 'monospace' }}>{isIn ? money(toDisp(qty)) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', color: '#dc2626', fontWeight: 700, fontFamily: 'monospace' }}>{isOut ? money(toDisp(Math.abs(qty))) : '—'}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', color: '#111827', fontWeight: 800, fontFamily: 'monospace' }}>{(parseFloat(toDisp(parseFloat(row.balance)))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: `2px solid ${ACCENT}`, background: ACCENT_LIGHT }}>
                    <td colSpan={4} style={{ padding: '11px 14px', fontWeight: 700, color: ACCENT, fontSize: 12, textTransform: 'uppercase' }}>Totals</td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 800, color: '#166534', fontFamily: 'monospace' }}>{(parseFloat(totalIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 800, color: '#dc2626', fontFamily: 'monospace' }}>{(parseFloat(totalOut)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    <td style={{ padding: '11px 14px', textAlign: 'right', fontWeight: 800, color: '#111827', fontFamily: 'monospace' }}>{(parseFloat(closeBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Print Preview */}
      {showPrint && (
        <Portal>
        <div className="print-preview-overlay" style={{ position: 'fixed', inset: 0, zIndex: 2000, background: '#0f172a', display: 'flex', flexDirection: 'column' }}>
          <div style={{ background: '#1e293b', padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <div style={{ color: '#94a3b8', fontSize: 13 }}>
              Sales Bin Card — <strong style={{ color: '#fff' }}>{selectedProduct?.name}</strong>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => window.print()} style={{ padding: '8px 20px', borderRadius: 7, border: 'none', background: ACCENT, color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                <FiPrinter size={13} style={{ marginRight: 6 }} />Print
              </button>
              <button onClick={() => setShowPrint(false)} style={{ padding: '8px 18px', borderRadius: 7, border: '1px solid #475569', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}>
                Close
              </button>
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '30px 20px' }}>
            <div id="print-document" style={{ width: 740, margin: '0 auto', background: '#fff', borderRadius: 8, overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.4)' }}>
              <div style={{ background: `linear-gradient(135deg,${ACCENT_DARK},${ACCENT},#f87171)`, padding: '28px 32px', color: '#fff' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 2, opacity: 0.75, marginBottom: 4 }}>Sales Document</div>
                    <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: -0.5 }}>SALES BIN CARD</div>
                    <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>{selectedProduct?.name} {unitLabel ? `· ${unitLabel}` : ''}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 16, fontWeight: 800 }}>{businessInfo.business_name || 'Business Name'}</div>
                    {businessInfo.business_address && <div style={{ fontSize: 11, opacity: 0.8, marginTop: 4 }}>{businessInfo.business_address}</div>}
                    {businessInfo.business_phone  && <div style={{ fontSize: 11, opacity: 0.8 }}>Tel: {businessInfo.business_phone}</div>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 3, marginTop: 20 }}>
                  {['#fbbf24','#34d399','#60a5fa','#f472b6'].map((c, i) => (
                    <div key={i} style={{ height: 4, flex: 1, background: c, borderRadius: 2 }} />
                  ))}
                </div>
              </div>

              <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb' }}>
                {[
                  { label: 'Period From',  value: formatDate(from) },
                  { label: 'Period To',    value: formatDate(to) },
                  { label: 'Opening Bal.', value: `${(parseFloat(openBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} ${unitLabel}` },
                  { label: 'Closing Bal.', value: `${(parseFloat(closeBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} ${unitLabel}` },
                ].map((item, i) => (
                  <div key={i} style={{ flex: 1, padding: '14px 16px', borderRight: i < 3 ? '1px solid #e5e7eb' : 'none' }}>
                    <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, color: '#9ca3af', marginBottom: 3 }}>{item.label}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{item.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ padding: '20px 24px' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: ACCENT, color: '#fff' }}>
                      {['#', 'Date', 'Reference', 'Type', 'In', 'Out', 'Balance'].map((h, i) => (
                        <th key={i} style={{ padding: '9px 10px', textAlign: i >= 4 ? 'right' : 'left', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr style={{ background: '#eff6ff', borderBottom: '1px solid #dbeafe' }}>
                      <td style={{ padding: '8px 10px', color: '#9ca3af' }}>—</td>
                      <td style={{ padding: '8px 10px', color: '#374151' }}>{formatDate(from)}</td>
                      <td style={{ padding: '8px 10px', color: '#6b7280' }}>—</td>
                      <td style={{ padding: '8px 10px', color: '#1d4ed8', fontWeight: 700 }}>Opening Balance</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: '#166534', fontWeight: 700 }}>{openBal > 0 ? money(openBal) : ''}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right' }}>—</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 800, color: '#1d4ed8' }}>{(parseFloat(openBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    </tr>
                    {visibleRows.map((row, idx) => {
                      const qty = parseFloat(row.quantity);
                      const isIn  = qty > 0;
                      const isOut = qty < 0;
                      return (
                        <tr key={row.id} style={{ background: idx % 2 === 0 ? '#fff' : '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '8px 10px', color: '#9ca3af' }}>{idx + 1}</td>
                          <td style={{ padding: '8px 10px', color: '#374151' }}>{formatDate(row.date)}</td>
                          <td style={{ padding: '8px 10px', fontWeight: 600 }}>{fmtInvoiceNo(row.reference) || '—'}</td>
                          <td style={{ padding: '8px 10px', color: '#6b7280' }}>{movementLabel(row.movement_type, row.quantity)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: '#166534', fontWeight: 700 }}>{isIn ? money(toDisp(qty)) : ''}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', color: '#dc2626', fontWeight: 700 }}>{isOut ? money(toDisp(Math.abs(qty))) : ''}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 800 }}>{(parseFloat(toDisp(parseFloat(row.balance)))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: ACCENT_LIGHT, borderTop: `2px solid ${ACCENT}` }}>
                      <td colSpan={4} style={{ padding: '9px 10px', fontWeight: 700, color: ACCENT, fontSize: 11, textTransform: 'uppercase' }}>Totals</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 800, color: '#166534' }}>{(parseFloat(totalIn)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 800, color: '#dc2626' }}>{(parseFloat(totalOut)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', fontWeight: 800 }}>{(parseFloat(closeBal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    </tr>
                  </tfoot>
                </table>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 40, paddingTop: 12 }}>
                  {['Prepared By', 'Checked By', 'Approved By'].map((label, i) => (
                    <div key={i} style={{ textAlign: 'center', width: 160 }}>
                      <div style={{ borderTop: '1px solid #374151', paddingTop: 8, fontSize: 11, color: '#6b7280' }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ background: ACCENT, padding: '10px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ color: '#fff', fontSize: 11, opacity: 0.8 }}>Printed: {new Date().toLocaleDateString('en-GB')}</span>
                <span style={{ color: '#fff', fontSize: 11, opacity: 0.8 }}>{businessInfo.business_name || ''}</span>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      <style>{`
        @media print {
          body > * { display: none !important; }
          .print-preview-overlay { position: static !important; background: #fff !important; }
          .print-preview-overlay > div:first-child { display: none !important; }
          #print-document { box-shadow: none !important; border-radius: 0 !important; width: 100% !important; margin: 0 !important; }
        }
      `}</style>

      {/* 2026-08-30 — HQ GRN read-only view, opened from a GRN reference in
          the movement table. Red Sea procurement is HQ-owned, so the branch
          `grn` table has no row for these; the header and lines come from
          master.hq_grns via /api/inventory/hq-grn/:syncId. Themed with the
          page's own ACCENT so it reads as part of the Bin Card rather than a
          borrowed screen. */}
      {(hqGrn || hqGrnLoading || hqGrnError) && (
        <Portal>
          <div
            onClick={closeHqGrn}
            style={{ position: 'fixed', inset: 0, background: 'rgba(17,24,39,0.55)', zIndex: 10000,
                     display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '5vh 16px', overflowY: 'auto' }}>
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 880,
                       boxShadow: '0 20px 60px rgba(0,0,0,0.28)', overflow: 'hidden' }}>

              <div style={{ background: ACCENT, color: '#fff', padding: '16px 20px',
                            display: 'flex', alignItems: 'center', gap: 12 }}>
                <FiFileText size={22} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, letterSpacing: 1, opacity: 0.85, fontWeight: 700 }}>HQ GOODS RECEIVED NOTE</div>
                  <div style={{ fontSize: 19, fontWeight: 800, fontFamily: 'monospace' }}>
                    {hqGrn?.grn?.grn_number || (hqGrnLoading ? 'Loading…' : '—')}
                  </div>
                </div>
                <button onClick={closeHqGrn} aria-label="Close"
                  style={{ background: 'rgba(255,255,255,0.18)', border: 'none', color: '#fff', width: 32, height: 32,
                           borderRadius: 8, cursor: 'pointer', display: 'grid', placeItems: 'center' }}>
                  <FiX size={18} />
                </button>
              </div>

              <div style={{ padding: 20 }}>
                {hqGrnLoading && <div style={{ color: '#6b7280', padding: '30px 0', textAlign: 'center' }}>Loading GRN…</div>}
                {hqGrnError && (
                  <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c',
                                borderRadius: 8, padding: 14, fontSize: 13 }}>{hqGrnError}</div>
                )}

                {hqGrn && (() => {
                  const g = hqGrn.grn || {};
                  const po = hqGrn.purchase || null;
                  const cell = (label, value, mono) => (
                    <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px', background: '#fafafa' }}>
                      <div style={{ fontSize: 10, letterSpacing: 0.6, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: '#111827', marginTop: 2,
                                    fontFamily: mono ? 'monospace' : 'inherit' }}>{value || '—'}</div>
                    </div>
                  );
                  const when = (name, at) => (name || at)
                    ? `${name || '—'}${at ? '  ·  ' + new Date(at).toLocaleString('en-GB', { hour12: false }) : ''}`
                    : '—';
                  return (
                    <>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(190px,1fr))', gap: 10, marginBottom: 16 }}>
                        {cell('GRN Date', formatDate(g.date))}
                        {cell('Branch', g.branch_name || g.branch_slug)}
                        {cell('Supplier', g.supplier_name)}
                        {cell('Supplier Inv #', g.supplier_invoice_number, true)}
                        {cell('PO Number', g.po_number || po?.purchase_number, true)}
                        {cell('PO Date', po?.date ? formatDate(po.date) : null)}
                        {cell('Initiated by (HQ)', when(po?.created_by_name, po?.created_at))}
                        {cell('Generated by (HQ)', when(g.generated_by_hq_name, g.generated_at))}
                        {cell('Confirmed by (Branch)', when(g.confirmed_by_branch_name, g.confirmed_at_branch))}
                      </div>

                      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                        <div style={{ background: '#fef2f2', color: ACCENT, padding: '9px 12px', fontSize: 11,
                                      fontWeight: 800, letterSpacing: 0.5 }}>
                          LINE ITEMS ({(hqGrn.items || []).length})
                        </div>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                            <thead>
                              <tr style={{ background: '#fff7f7', color: ACCENT }}>
                                <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 11, letterSpacing: 0.4 }}>PRODUCT</th>
                                <th style={{ textAlign: 'left',  padding: '8px 12px', fontSize: 11, letterSpacing: 0.4 }}>UNIT</th>
                                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, letterSpacing: 0.4 }}>QTY</th>
                                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, letterSpacing: 0.4 }}>UNIT PRICE</th>
                                <th style={{ textAlign: 'right', padding: '8px 12px', fontSize: 11, letterSpacing: 0.4 }}>TOTAL</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(hqGrn.items || []).map((it, i) => (
                                <tr key={it.id || i} style={{ borderTop: '1px solid #f3f4f6' }}>
                                  <td style={{ padding: '8px 12px', fontWeight: 600, color: '#111827' }}>
                                    {it.product_name}
                                    {it.is_extra ? <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#92400e',
                                      background: '#fef3c7', padding: '1px 6px', borderRadius: 10 }}>EXTRA</span> : null}
                                  </td>
                                  <td style={{ padding: '8px 12px', color: '#6b7280' }}>{it.unit || '—'}</td>
                                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>{money(it.quantity)}</td>
                                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>{money(it.unit_price)}</td>
                                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>{money(it.total_price)}</td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr style={{ borderTop: '2px solid #e5e7eb', background: '#fafafa' }}>
                                <td colSpan={4} style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 700, color: '#374151' }}>ITEMS SUBTOTAL</td>
                                <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>{money(g.items_subtotal)}</td>
                              </tr>
                              {parseFloat(g.cn_total || 0) !== 0 && (
                                <tr style={{ background: '#fafafa' }}>
                                  <td colSpan={4} style={{ padding: '9px 12px', textAlign: 'right', fontWeight: 700, color: '#374151' }}>CREDIT NOTES</td>
                                  <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#b91c1c' }}>−{money(g.cn_total)}</td>
                                </tr>
                              )}
                              <tr style={{ background: '#111827', color: '#fff' }}>
                                <td colSpan={4} style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800 }}>FINAL PAYABLE</td>
                                <td style={{ padding: '10px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 800 }}>{money(g.final_payable)}</td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      </div>

                      {/* 2026-08-31 — what actually went back.
                          The modal showed one CREDIT NOTES line and a figure,
                          so a bin card row that moved 3 boxes out could not be
                          traced to the note that moved them. */}
                      {(hqGrn.credit_notes || []).filter(c => (c.items || []).length > 0).map(cn => (
                        <div key={cn.sync_id} style={{ marginTop: 14, border: '1px solid #fecaca', borderRadius: 10, overflow: 'hidden' }}>
                          <div style={{ background: '#fef2f2', color: '#991b1b', padding: '9px 12px', fontSize: 11,
                                        fontWeight: 800, letterSpacing: 0.5, display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                            <span>
                              {cn.reason || 'CREDIT NOTE'}
                              {cn.credit_note_number && <span style={{ fontFamily: 'monospace', fontWeight: 700 }}> · {cn.credit_note_number}</span>}
                            </span>
                            <span>− {money(cn.amount)}</span>
                          </div>
                          <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                              <thead>
                                <tr style={{ background: '#fff7f7', color: '#991b1b' }}>
                                  <th style={{ textAlign: 'left',  padding: '7px 12px', fontSize: 10, letterSpacing: 0.4 }}>RETURNED</th>
                                  <th style={{ textAlign: 'left',  padding: '7px 12px', fontSize: 10, letterSpacing: 0.4 }}>UNIT</th>
                                  <th style={{ textAlign: 'right', padding: '7px 12px', fontSize: 10, letterSpacing: 0.4 }}>QTY</th>
                                  <th style={{ textAlign: 'right', padding: '7px 12px', fontSize: 10, letterSpacing: 0.4 }}>UNIT VALUE</th>
                                  <th style={{ textAlign: 'right', padding: '7px 12px', fontSize: 10, letterSpacing: 0.4 }}>DISCOUNT</th>
                                  <th style={{ textAlign: 'right', padding: '7px 12px', fontSize: 10, letterSpacing: 0.4 }}>TOTAL</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(cn.items || []).map((it, i) => (
                                  <tr key={i} style={{ borderTop: '1px solid #fee2e2' }}>
                                    <td style={{ padding: '7px 12px', fontWeight: 600, color: '#111827' }}>{it.product_name}</td>
                                    <td style={{ padding: '7px 12px', color: '#6b7280' }}>{it.unit || '—'}</td>
                                    <td style={{ padding: '7px 12px', textAlign: 'right', fontFamily: 'monospace' }}>{money(it.quantity)}</td>
                                    <td style={{ padding: '7px 12px', textAlign: 'right', fontFamily: 'monospace' }}>{money(it.unit_value)}</td>
                                    <td style={{ padding: '7px 12px', textAlign: 'right', fontFamily: 'monospace' }}>{money(it.discount)}</td>
                                    <td style={{ padding: '7px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>{money(it.total_price)}</td>
                                  </tr>
                                ))}
                              </tbody>
                              <tfoot>
                                <tr style={{ background: '#fff7f7', borderTop: '1px solid #fecaca' }}>
                                  <td colSpan={5} style={{ padding: '7px 12px', textAlign: 'right', color: '#991b1b' }}>VAT Amount</td>
                                  <td style={{ padding: '7px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>{money(cn.vat_amount)}</td>
                                </tr>
                                <tr style={{ background: '#fef2f2' }}>
                                  <td colSpan={5} style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: '#991b1b' }}>GRAND TOTAL</td>
                                  <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 800, color: '#991b1b' }}>− {money(cn.amount)}</td>
                                </tr>
                              </tfoot>
                            </table>
                          </div>
                        </div>
                      ))}

                      {g.notes && (
                        <div style={{ marginTop: 12, fontSize: 12, color: '#6b7280' }}>
                          <strong style={{ color: '#374151' }}>Notes:</strong> {g.notes}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>

              <div style={{ borderTop: '1px solid #e5e7eb', padding: '12px 20px', display: 'flex',
                            alignItems: 'center', justifyContent: 'space-between', background: '#fafafa' }}>
                <span style={{ fontSize: 11, color: '#9ca3af' }}>Read-only view · HQ archive</span>
                <button onClick={closeHqGrn}
                  style={{ background: ACCENT, color: '#fff', border: 'none', borderRadius: 8,
                           padding: '9px 20px', fontWeight: 700, cursor: 'pointer' }}>Close</button>
              </div>
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
};

export default SalesBinCard;
