import React, { useState, useEffect, useCallback } from 'react';
import { FiSave, FiClock, FiCheckCircle, FiChevronDown, FiChevronUp, FiTrash2, FiAlertTriangle, FiPrinter, FiFileText } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import { getReconciliationProducts, getReconciliations, getReconciliation, createReconciliation, deleteReconciliation, getSettings } from '../services/api';
import printHtml from '../utils/printHtml';
import { formatStock, formatStockForProduct } from '../utils/unitFormat';
import { unitsForProduct as unitsForProductFE, pickDisplayUnit } from '../utils/productUnits';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { matchTokens } from '../utils/tokenSearch';

const todayStr = () => new Date().toISOString().slice(0, 10);

const StockReconciliation = () => {
  const { user, hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  const [tab, setTab] = useState('count');
  const [location, setLocation] = useState('sales');
  const [countDate, setCountDate] = useState(todayStr());

  // Count tab
  const [products, setProducts] = useState([]);
  const [counts, setCounts] = useState({});       // { productId: { physical_qty, unit, reason } }
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  // 2026-09-12 — zero-stock items sit collapsed behind a separator and are left
  // off the printout entirely. A count happens against what is on the shelf, so
  // 500 zero lines are noise on the sheet and waste the roll. They stay on
  // screen and searchable, because stock the system thinks is zero is exactly
  // where an uncounted case turns up.
  const [showZero, setShowZero] = useState(false);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const [toast, setToast] = useState(null);

  // History tab
  const [history, setHistory] = useState([]);
  const [historyFilter, setHistoryFilter] = useState('all'); // 'all' | 'sales' | 'store'
  const [expandedId, setExpandedId] = useState(null);
  const [detail, setDetail] = useState({});

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const loadProducts = useCallback(async () => {
    try {
      const res = await getReconciliationProducts(location, countDate);
      // v1.6.3: hide inactive items.
      setProducts((res.data || []).filter(p => (p.status || 'Active') !== 'Inactive'));
      // Reset counts when location or date changes — old values would compare
      // against the wrong system_qty.
      setCounts({});
    } catch (err) {
      setProducts([]);
    }
  }, [location, countDate]);

  // History uses its own filter (independent of count location) so user can view ALL or per-floor
  const loadHistory = useCallback(async () => {
    try {
      const res = await getReconciliations(historyFilter === 'all' ? null : historyFilter);
      setHistory(res.data || []);
    } catch (err) { setHistory([]); }
  }, [historyFilter]);

  useEffect(() => { loadProducts(); }, [loadProducts]);
  useEffect(() => { loadHistory(); }, [loadHistory]);

  const updateCount = (productId, field, value) => {
    setCounts(prev => ({ ...prev, [productId]: { ...(prev[productId] || {}), [field]: value } }));
  };

  // Compute live variance for a row (in BASE units).
  // v1.13.6 — subtract transit_qty from system so items already dispatched
  // as PENDING outgoing transfers don't show up as shrinkage. Formula:
  //   variance = physical - (system - transit)
  // If transit_qty is 0 (store location, or no pending transfers) this
  // reduces to the previous behaviour.
  const lineVariance = (p, c) => {
    if (!c || c.physical_qty === '' || c.physical_qty == null || isNaN(parseFloat(c.physical_qty))) return null;
    const qty = parseFloat(c.physical_qty);
    const units = unitsForProductFE(p);
    const u = units.find(x => x.name === (c.unit || p.unit)) || units.find(x => x.is_base) || { conv: 1 };
    const physicalBase = qty * (u.conv || 1);
    const expected = parseFloat(p.system_qty || 0) - parseFloat(p.transit_qty || 0);
    return physicalBase - expected;
  };

  // v1.13.91 — client-side thermal print (80mm) via printHtml util.
  // Was calling backend printCountWorksheet which requires a physical
  // ESC/POS printer wired to the branch PC; failed whenever no printer
  // was attached (which is every non-till PC). Now builds the HTML
  // locally + opens the browser print dialog — user picks any printer
  // or "Save as PDF".
  const [printingSheet, setPrintingSheet] = useState(false);
  const printWorksheet = async () => {
    // 2026-09-12 — the sheet carries items in stock only.
    if (inStockProducts.length === 0) return;
    setPrintingSheet(true);
    try {
      let businessName = 'Stock Count Sheet';
      try {
        const s = await getSettings();
        businessName = s?.data?.business?.business_name || businessName;
      } catch (_) { /* ignore */ }

      const dateLabel = countDate
        ? new Date(countDate + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : new Date().toLocaleDateString('en-GB');
      const printedAt = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const locLabel = location === 'sales' ? 'Sales Floor' : 'Store Floor';
      const countedBy = `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || '—';

      const rows = inStockProducts.map((p, idx) => {
        const c = counts[p.id] || {};
        const hasPhysical = c.physical_qty !== '' && c.physical_qty != null && !isNaN(parseFloat(c.physical_qty));
        const baseQty = parseFloat(p.system_qty) || 0;
        const sysDisplay = formatStockForProduct(baseQty, p, { showBaseInParens: false });
        const physCell = hasPhysical
          ? `${parseFloat(c.physical_qty).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${c.unit || p.unit}`
          : `<span style="display:inline-block;border-bottom:1px solid #000;min-width:36px;height:10px"></span>`;
        return `<tr>
          <td style="padding:2px 0;font-size:9px;">${idx + 1}</td>
          <td style="padding:2px 4px;word-break:break-word;">${(p.name || '').replace(/</g, '&lt;')}<div style="font-size:9px;color:#000;">${p.code || ''}</div></td>
          <td style="padding:2px 0;text-align:right;font-size:10px;">${sysDisplay}</td>
          <td style="padding:2px 0;text-align:right;">${physCell}</td>
        </tr>`;
      }).join('');

      const div42eq = '='.repeat(42);
      const div42da = '-'.repeat(42);
      const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
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
  html, body { margin: 0; padding: 0; overflow-x: hidden; }
  * { box-sizing: border-box; }
  body {
    width: 72mm; max-width: 72mm;
    padding: 2mm;
    font-family: 'Courier New', Courier, monospace;
    font-size: 11px; color: #000; font-weight: 700;
  }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
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
  td { vertical-align: top; }
  .c { text-align: center; }
  .divider { text-align: center; font-size: 10px; overflow: hidden; white-space: nowrap; margin: 3px 0; }
  thead td { font-weight: 700; border-bottom: 1px solid #000; padding: 2px 0; font-size: 10px; }
</style></head><body>
  <div class="c" style="font-size:13px;font-weight:800;letter-spacing:1px;">${businessName}</div>
  <div class="c" style="font-weight:800;font-size:12px;margin-top:3px;">STOCK COUNT SHEET</div>
  <div class="divider">${div42eq}</div>
  <table>
    <tr><td>Location:</td><td style="text-align:right;">${locLabel}</td></tr>
    <tr><td>Date:</td><td style="text-align:right;">${dateLabel}</td></tr>
    <tr><td>Counted by:</td><td style="text-align:right;">${countedBy}</td></tr>
    <tr><td>Items:</td><td style="text-align:right;">${inStockProducts.length}</td></tr>
    ${notes ? `<tr><td colspan="2" style="padding-top:3px;">Notes: ${String(notes).replace(/</g,'&lt;')}</td></tr>` : ''}
  </table>
  <div class="divider">${div42eq}</div>
  <table>
    <thead>
      <tr>
        <td style="width:16px;">#</td>
        <td>Item</td>
        <td style="text-align:right;">System</td>
        <td style="text-align:right;">Physical</td>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="divider">${div42da}</div>
  <div class="c" style="font-size:9px;margin-top:4px;">Printed ${printedAt}</div>
  <div class="c" style="font-size:9px;margin-top:12px;">Signature: __________________________</div>
</body></html>`;

      printHtml(html);
      showToast('Print dialog opened.', 'success');
    } catch (err) {
      showToast(err?.message || 'Print failed.', 'error');
    } finally {
      setPrintingSheet(false);
    }
  };

  // ── Export the count sheet as an A4 PDF (mirrors GRN/SIV design) ─────────
  // Includes any physical quantities the user has already entered (so a
  // partially-counted sheet prints with their progress) and leaves the rest
  // blank with an underline for hand-filling in the warehouse.
  const handleExportPDF = async () => {
    // 2026-09-12 — the sheet carries items in stock only.
    if (inStockProducts.length === 0) return;
    let businessName = 'Stock Count Sheet';
    let businessPhone = '';
    try {
      const s = await getSettings();
      const biz = s?.data?.business || {};
      businessName = biz.business_name || businessName;
      businessPhone = biz.business_phone || '';
    } catch (_) { /* ignore — fall back to defaults */ }

    const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const countedBy = `${user?.firstName || ''} ${user?.lastName || ''}`.trim() || '—';
    const locLabel = location === 'sales' ? 'Sales Floor' : 'Store Floor';
    const dateLabel = countDate ? new Date(countDate + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

    const rows = inStockProducts.map((p, idx) => {
      const c = counts[p.id] || {};
      const hasPhysical = c.physical_qty !== '' && c.physical_qty != null && !isNaN(parseFloat(c.physical_qty));
      const physicalCell = hasPhysical
        ? `${fmt(c.physical_qty)} ${c.unit || p.unit}`
        : `<span style="display:inline-block;border-bottom:1px solid #000;min-width:60px;height:14px"></span>`;
      const variance = hasPhysical ? lineVariance(p, c) : null;
      const varianceCell = variance == null
        ? `<span style="color:#999">—</span>`
        : `<span style="font-weight:700;color:${variance < 0 ? '#b91c1c' : variance > 0 ? '#15803d' : '#000'}">${variance > 0 ? '+' : ''}${fmt(variance)} ${p.unit}</span>`;
      const reasonCell = c.reason
        ? c.reason
        : `<span style="display:inline-block;border-bottom:1px solid #000;min-width:80px;height:14px"></span>`;
      const baseQty = parseFloat(p.system_qty) || 0;
      const transitQty = parseFloat(p.transit_qty || 0);
      const netSysQty = Math.max(0, baseQty - transitQty);
      // v1.13.7 — printed System Qty column also shows net (raw − transit),
      // amber when transit > 0, matching the on-screen behaviour.
      const systemDisplay = formatStockForProduct(netSysQty, p, { showBaseInParens: false });
      const transitDisplay = transitQty > 0 ? formatStockForProduct(transitQty, p, { showBaseInParens: false }) : '—';
      return `<tr style="background:${idx % 2 === 1 ? '#f5f5f5' : '#fff'};border-bottom:1px solid #ddd">
        <td style="padding:6px 8px;color:#000;font-size:10px">${idx + 1}</td>
        <td style="padding:6px 8px;font-size:10px;font-family:monospace">${p.code || '—'}</td>
        <td style="padding:6px 8px;font-weight:600;font-size:10.5px">${p.name}</td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace;font-size:10.5px;color:${transitQty > 0 ? '#b45309' : '#000'};font-weight:${transitQty > 0 ? 700 : 400}">${systemDisplay}</td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace;font-size:10.5px;color:${transitQty > 0 ? '#0e7490' : '#999'}">${transitDisplay}</td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace;font-size:10.5px">${physicalCell}</td>
        <td style="padding:6px 8px;text-align:center;font-size:10px">${c.unit || p.unit}</td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace;font-size:10px">${varianceCell}</td>
        <td style="padding:6px 8px;font-size:10px;color:#444">${reasonCell}</td>
      </tr>`;
    }).join('');

    const counted = inStockProducts.filter(p => {
      const c = counts[p.id] || {};
      return c.physical_qty !== '' && c.physical_qty != null && !isNaN(parseFloat(c.physical_qty));
    }).length;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Stock Reconciliation — ${locLabel} — ${dateLabel}</title><style>
      @page{size:A4 portrait;margin:12mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:7px 8px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10px;background:#f0f0f0;text-align:left}
      td{font-size:10.5px}
      tfoot td{padding:8px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${businessName}</div>
          <div style="font-size:10px;color:#000;line-height:1.7">${businessPhone}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#000;margin-bottom:4px">Stock Reconciliation</div>
          <div style="font-size:15px;font-weight:700">${dateLabel}</div>
          <div style="font-size:9px;color:#000;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:12px">
        ${[
          ['Location', locLabel],
          ['Count Date', dateLabel],
          ['In Stock', inStockProducts.length],
          ['Counted', `${counted} / ${inStockProducts.length}`],
        ].map(([lbl, val]) => `
          <div style="flex:1;padding:8px 10px;border:1.5px solid #000;text-align:center">
            <div style="font-size:8px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:3px">${lbl}</div>
            <div style="font-size:13px;font-weight:800">${val}</div>
          </div>`).join('')}
      </div>
      ${notes ? `<div style="margin-bottom:10px;padding:8px 10px;border:1px solid #888;background:#fafafa;font-size:10.5px"><strong>Notes:</strong> ${notes}</div>` : ''}
      <div style="border:1.5px solid #000;margin-bottom:14px">
        <table>
          <thead><tr>
            <th style="width:24px">#</th>
            <th style="width:60px">Code</th>
            <th>Product</th>
            <th style="text-align:right">System Qty</th>
            <th style="text-align:right;color:#0e7490">Transit</th>
            <th style="text-align:right">Physical Qty</th>
            <th style="text-align:center;width:40px">Unit</th>
            <th style="text-align:right">Variance</th>
            <th style="width:90px">Reason</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-top:28px;margin-bottom:14px">
        ${[['Counted By', countedBy], ['Verified By', ''], ['Posted By', '']].map(([label, name]) => `
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:30px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:6px;display:flex;justify-content:space-between">
        <span style="font-size:9px;color:#000">${businessName} — Confidential</span>
        <span style="font-size:9px;color:#000">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => { w.print(); }, 300); }
  };

  const postCount = async () => {
    const items = products
      .map(p => {
        const c = counts[p.id] || {};
        if (c.physical_qty === '' || c.physical_qty == null || c.physical_qty === undefined) return null;
        if (isNaN(parseFloat(c.physical_qty))) return null;
        return {
          product_id: p.id,
          physical_qty: parseFloat(c.physical_qty),
          unit: c.unit || p.unit,
          reason: c.reason || null,
        };
      })
      .filter(Boolean);

    if (items.length === 0) {
      showToast('Enter physical count for at least one item before posting.', 'error');
      return;
    }

    setPosting(true);
    try {
      await createReconciliation({ count_date: countDate, location, notes, items });
      setPosted(true);
      setCounts({});
      setNotes('');
      await Promise.all([loadProducts(), loadHistory()]);
      showToast('Stock reconciliation posted.', 'success');
    } catch (err) {
      showToast(err.response?.data?.error || 'Failed to post reconciliation.', 'error');
    } finally {
      setPosting(false);
    }
  };

  const expandRow = async (id) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (!detail[id]) {
      try {
        const res = await getReconciliation(id);
        setDetail(prev => ({ ...prev, [id]: res.data }));
      } catch (_) {
        setDetail(prev => ({ ...prev, [id]: { items: [] } }));
      }
    }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const removeHistory = (id) => {
    setPendingDelete({
      subject: 'Reconciliation — stock adjustments will be reversed',
      perform: async () => {
        try {
          await deleteReconciliation(id);
          await Promise.all([loadProducts(), loadHistory()]);
          if (expandedId === id) setExpandedId(null);
          showToast('Reconciliation deleted.', 'success');
        } catch (err) {
          showToast(err.response?.data?.error || 'Failed to delete.', 'error');
        }
      },
    });
  };

  const filteredProducts = products.filter(p => matchTokens(search, p.name, p.code, p.barcode));
  // Net of stock already dispatched on a pending transfer — the same figure the
  // System Qty column shows, so "in stock" means the same thing as the number
  // printed beside it.
  const netQtyOf = (p) => (parseFloat(p.system_qty) || 0) - (parseFloat(p.transit_qty) || 0);
  const inStockProducts   = filteredProducts.filter(p => netQtyOf(p) > 0);
  const zeroStockProducts = filteredProducts.filter(p => netQtyOf(p) <= 0);
  const visibleProducts   = showZero ? [...inStockProducts, ...zeroStockProducts] : inStockProducts;
  const countedCount = Object.values(counts).filter(c => c?.physical_qty !== '' && c?.physical_qty != null).length;

  // The line between the two groups, and the only way into the zero-stock half.
  // Rendered inside the map before the first zero row when open, and after the
  // last in-stock row when closed — either way it sits between them.
  const zeroDivider = (
    <tr key="__zero-divider" style={{ background: '#f9fafb', borderTop: '2px solid #e5e7eb', borderBottom: '1px solid #e5e7eb' }}>
      <td colSpan={7} style={{ padding: '9px 14px' }}>
        <button type="button" onClick={() => setShowZero(v => !v)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7, background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 12.5, fontWeight: 700, color: '#6b7280' }}>
          {showZero ? <FiChevronUp size={14} /> : <FiChevronDown size={14} />}
          Zero stock — {zeroStockProducts.length} item{zeroStockProducts.length === 1 ? '' : 's'}
          <span style={{ fontWeight: 500, color: '#9ca3af' }}>
            {showZero ? '· hide' : '· not printed, open to count anyway'}
          </span>
        </button>
      </td>
    </tr>
  );

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('stockReconciliation')}</h1>
          <p>{t('stockReconciliationSubtitle')}</p>
        </div>
        {tab === 'count' && hasPermission('StockReconciliation:Add') !== false && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button onClick={handleExportPDF} disabled={inStockProducts.length === 0}
              title="Export an A4 count sheet as PDF — items in stock only"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: inStockProducts.length === 0 ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600, opacity: inStockProducts.length === 0 ? 0.55 : 1 }}>
              <FiFileText size={14} /> Export PDF
            </button>
            <button onClick={printWorksheet} disabled={printingSheet || inStockProducts.length === 0}
              title="Print a thermal worksheet for the warehouse — items in stock only"
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 16px', background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: printingSheet || inStockProducts.length === 0 ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600, opacity: printingSheet || inStockProducts.length === 0 ? 0.55 : 1 }}>
              <FiPrinter size={14} /> {printingSheet ? 'Printing…' : 'Print Sheet'}
            </button>
            <button onClick={postCount} disabled={posting || countedCount === 0}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 18px', background: '#1e40af', color: '#fff', border: 'none', borderRadius: 8, cursor: posting || countedCount === 0 ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700, opacity: posting || countedCount === 0 ? 0.55 : 1 }}>
              <FiSave size={14} /> {posting ? 'Posting…' : `Post Count (${countedCount})`}
            </button>
          </div>
        )}
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, padding: '10px 18px', borderRadius: 8, color: '#fff', fontWeight: 600, background: toast.type === 'error' ? '#dc2626' : '#16a34a', boxShadow: '0 4px 14px rgba(0,0,0,0.18)', zIndex: 1100 }}>
          {toast.msg}
        </div>
      )}

      {/* Location + date selectors — only relevant for the Count tab */}
      {tab === 'count' && (
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <div>
            <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>{t('location')}</label>
            <div style={{ display: 'inline-flex', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
              {['sales', 'store'].map(loc => (
                <button key={loc} onClick={() => setLocation(loc)}
                  style={{ padding: '8px 18px', border: 'none', background: location === loc ? '#1e40af' : '#fff', color: location === loc ? '#fff' : '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>
                  {loc} Floor
                </button>
              ))}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>{t('countDate')}</label>
            <input type="date" value={countDate} onChange={e => setCountDate(e.target.value)}
              style={{ padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '2px solid #e5e7eb', marginBottom: 16 }}>
        {[
          { key: 'count', label: 'Count', icon: <FiCheckCircle size={14} /> },
          { key: 'history', label: `History (${history.length})`, icon: <FiClock size={14} /> },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{ padding: '10px 24px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, color: tab === t.key ? '#1e40af' : '#64748b', borderBottom: tab === t.key ? '3px solid #1e40af' : '3px solid transparent', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {/* Count tab */}
      {tab === 'count' && (
        <>
          <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiAlertTriangle size={16} />
            <span><strong>Leave the count blank</strong> for items you didn't count — they're skipped (no variance, no stock movement). Only enter values for items you physically counted.</span>
          </div>

          <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder={t('searchProducts')}
            style={{ width: '100%', padding: '9px 14px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, marginBottom: 10, boxSizing: 'border-box' }} />

          <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder={t('notesOptional')}
            style={{ width: '100%', padding: '8px 14px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, marginBottom: 12, boxSizing: 'border-box' }} />

          <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Product</th>
                  <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb', width: 180 }}>System Qty</th>
                  <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#0e7490', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb', width: 120 }} title="Pending outgoing transfers (base units). Subtracted from System when computing Variance.">Transit</th>
                  <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb', width: 140 }}>Physical Qty</th>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb', width: 130 }}>Unit</th>
                  <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb', width: 110 }}>Variance</th>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb', width: 180 }}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.length === 0 ? (
                  <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No products.</td></tr>
                ) : visibleProducts.map((p, vi) => {
                  const c = counts[p.id] || {};
                  const variance = lineVariance(p, c);
                  const varianceClass = variance == null ? '' : variance > 0.0001 ? '#16a34a' : variance < -0.0001 ? '#dc2626' : '#6b7280';
                  return (
                    <React.Fragment key={p.id}>
                    {vi === inStockProducts.length && zeroDivider}
                    <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 14px' }}>
                        <div style={{ fontWeight: 500, color: '#111827' }}>{p.name}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{p.code || '—'}</div>
                      </td>
                      {(() => {
                        // v1.13.7 — System Qty column shows (system − transit)
                        // whenever there's pending outgoing transfers, coloured
                        // amber so the counter sees it's already net of transit
                        // and doesn't double-subtract manually. When transit = 0
                        // the raw system_qty is shown in the default slate.
                        const rawSys = parseFloat(p.system_qty) || 0;
                        const transit = parseFloat(p.transit_qty || 0);
                        const netSys = Math.max(0, rawSys - transit);
                        const hasTransit = transit > 0;
                        return (
                          <>
                            <td style={{ padding: '8px 14px', textAlign: 'right', color: hasTransit ? '#b45309' : '#374151', fontWeight: hasTransit ? 600 : 400 }}
                                title={hasTransit ? `Raw system ${formatStockForProduct(rawSys, p)} − Transit ${formatStockForProduct(transit, p)}` : undefined}>
                              {formatStockForProduct(netSys, p)}
                            </td>
                            <td style={{ padding: '8px 14px', textAlign: 'right', color: hasTransit ? '#0e7490' : '#9ca3af', fontWeight: hasTransit ? 600 : 400 }}>
                              {hasTransit ? formatStockForProduct(transit, p) : '—'}
                            </td>
                          </>
                        );
                      })()}
                      <td style={{ padding: '8px 6px' }}>
                        <input type="number" min="0" step="1" placeholder="—"
                          value={c.physical_qty ?? ''}
                          onChange={e => updateCount(p.id, 'physical_qty', e.target.value)}
                          style={{ width: '100%', padding: '7px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, textAlign: 'right', boxSizing: 'border-box' }} />
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        {(() => {
                          const units = unitsForProductFE(p);
                          if (units.length <= 1) {
                            return <div style={{ padding: '7px 8px', color: '#6b7280', fontSize: 13 }}>{p.unit}</div>;
                          }
                          return (
                            <select value={c.unit || p.unit}
                              onChange={e => updateCount(p.id, 'unit', e.target.value)}
                              style={{ width: '100%', padding: '7px 6px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' }}>
                              {units.map(u => (
                                <option key={u.name} value={u.name}>
                                  {u.name}{u.is_base ? '' : ` (1=${u.conv})`}
                                </option>
                              ))}
                            </select>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '8px 14px', textAlign: 'right', color: varianceClass, fontWeight: 600 }}>
                        {variance == null ? '—' : (() => {
                          // Variance is computed in base units (pcs). Render
                          // it in the product's DEFAULT unit (e.g. Crates) so
                          // the manager reads "−596.50 Crates" instead of
                          // "−14,316 pcs". Show the base total as a small
                          // parenthetical underneath when the two differ.
                          const du = pickDisplayUnit(p);
                          const conv = parseFloat(du.conv) || 1;
                          const varDefault = variance / conv;
                          const sign = variance > 0 ? '+' : '';
                          const fmt = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                          const showBase = conv !== 1 && du.name !== p.unit;
                          return (
                            <>
                              <div>{sign}{fmt(varDefault)} {du.name}</div>
                              {showBase && (
                                <div style={{ fontSize: 11, fontWeight: 500, opacity: 0.75 }}>
                                  ({sign}{fmt(variance)} {p.unit})
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '8px 6px' }}>
                        <input type="text" placeholder="(optional)"
                          value={c.reason || ''}
                          onChange={e => updateCount(p.id, 'reason', e.target.value)}
                          style={{ width: '100%', padding: '7px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, boxSizing: 'border-box' }} />
                      </td>
                    </tr>
                    </React.Fragment>
                  );
                })}
                {!showZero && zeroStockProducts.length > 0 && zeroDivider}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* History tab */}
      {tab === 'history' && (
        <>
          {/* Filter pills */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Show:</span>
            {['all', 'sales', 'store'].map(opt => (
              <button key={opt} onClick={() => setHistoryFilter(opt)}
                style={{
                  padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                  border: historyFilter === opt ? '1.5px solid #1e40af' : '1px solid #e5e7eb',
                  background: historyFilter === opt ? '#dbeafe' : '#fff',
                  color: historyFilter === opt ? '#1e40af' : '#6b7280',
                  cursor: 'pointer', textTransform: 'capitalize'
                }}>
                {opt === 'all' ? 'All Locations' : `${opt} Floor`}
              </button>
            ))}
          </div>

          {/* Stats — totals across filtered history */}
          {(() => {
            const totals = history.reduce((acc, h) => {
              const v = parseFloat(h.variance_value || 0);
              acc.count += 1;
              acc.total += v;
              acc.byLoc[h.location] = (acc.byLoc[h.location] || 0) + v;
              acc.itemsTotal += parseInt(h.item_count || 0);
              return acc;
            }, { count: 0, total: 0, byLoc: {}, itemsTotal: 0 });
            const positiveTotal = history.reduce((s, h) => parseFloat(h.variance_value || 0) > 0 ? s + parseFloat(h.variance_value) : s, 0);
            const negativeTotal = history.reduce((s, h) => parseFloat(h.variance_value || 0) < 0 ? s + parseFloat(h.variance_value) : s, 0);

            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 14 }}>
                <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Reconciliations</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#111827', marginTop: 4 }}>{totals.count}</div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{totals.itemsTotal} items counted</div>
                </div>
                <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Net Variance Value</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: totals.total > 0 ? '#16a34a' : totals.total < 0 ? '#dc2626' : '#111827', marginTop: 4 }}>
                    {totals.total > 0 ? '+' : ''}${(parseFloat(totals.total)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>positive = found extra · negative = shrinkage</div>
                </div>
                <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Surplus</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#16a34a', marginTop: 4 }}>+{curSym}{(parseFloat(positiveTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                </div>
                <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb' }}>
                  <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Shrinkage</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: '#dc2626', marginTop: 4 }}>−{curSym}{(parseFloat(Math.abs(negativeTotal))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>
                </div>
                {historyFilter === 'all' && Object.keys(totals.byLoc).length > 1 && (
                  <div style={{ background: '#fff', borderRadius: 10, padding: 14, border: '1px solid #e5e7eb', gridColumn: 'span 2' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>By Location</div>
                    {Object.entries(totals.byLoc).map(([loc, val]) => (
                      <div key={loc} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 4 }}>
                        <span style={{ color: '#374151', textTransform: 'capitalize' }}>{loc} Floor</span>
                        <span style={{ fontWeight: 600, color: val > 0 ? '#16a34a' : val < 0 ? '#dc2626' : '#6b7280' }}>
                          {val > 0 ? '+' : ''}{curSym}{(parseFloat(val)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
          {history.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No past reconciliations for this filter.</div>
          ) : (
            <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Date</th>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Location</th>
                  <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Counted By</th>
                  <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Items</th>
                  <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>Variance Value</th>
                  <th style={{ padding: '11px 14px', width: 80, borderBottom: '1px solid #e5e7eb' }}></th>
                </tr>
              </thead>
              <tbody>
                {history.map(h => (
                  <React.Fragment key={h.id}>
                    <tr style={{ borderBottom: '1px solid #f3f4f6', cursor: 'pointer' }} onClick={() => expandRow(h.id)}>
                      <td style={{ padding: '10px 14px', fontWeight: 500 }}>{h.count_date}</td>
                      <td style={{ padding: '10px 14px', textTransform: 'capitalize' }}>{h.location}</td>
                      <td style={{ padding: '10px 14px', color: '#6b7280' }}>{h.created_by_name || '—'}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right' }}>{h.item_count}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: parseFloat(h.variance_value || 0) > 0 ? '#16a34a' : parseFloat(h.variance_value || 0) < 0 ? '#dc2626' : '#6b7280' }}>
                        {(() => {
                          const v = parseFloat(h.variance_value || 0);
                          if (v < 0) return `−${curSym}${(parseFloat(Math.abs(v))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
                          if (v > 0) return `+${curSym}${(parseFloat(v)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
                          return `${curSym}0.00`;
                        })()}
                      </td>
                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>
                        <button onClick={e => { e.stopPropagation(); removeHistory(h.id); }}
                          style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4, marginRight: 6 }} title="Delete">
                          <FiTrash2 size={14} />
                        </button>
                        {expandedId === h.id ? <FiChevronUp /> : <FiChevronDown />}
                      </td>
                    </tr>
                    {expandedId === h.id && (
                      <tr>
                        <td colSpan={6} style={{ padding: '0 14px 12px', background: '#f9fafb' }}>
                          {!detail[h.id] ? (
                            <div style={{ padding: 12, color: '#9ca3af', fontSize: 12 }}>Loading…</div>
                          ) : (
                            <div style={{ paddingTop: 8 }}>
                              {detail[h.id].notes && (
                                <div style={{ fontSize: 12, color: '#374151', marginBottom: 8 }}>
                                  <strong>Notes:</strong> {detail[h.id].notes}
                                </div>
                              )}
                              <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <thead>
                                  <tr style={{ background: '#fff' }}>
                                    <th style={{ padding: '7px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Product</th>
                                    <th style={{ padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>System</th>
                                    <th style={{ padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Physical</th>
                                    <th style={{ padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Variance</th>
                                    <th style={{ padding: '7px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Cost</th>
                                    <th style={{ padding: '7px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Reason</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(detail[h.id].items || []).map(it => (
                                    <tr key={it.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                      <td style={{ padding: '6px 10px' }}>{it.product_name}</td>
                                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>{formatStock(it.system_qty, it.product_unit, it.alt_unit, it.conversion_factor)}</td>
                                      <td style={{ padding: '6px 10px', textAlign: 'right' }}>{(parseFloat(parseFloat(it.physical_qty))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {it.unit}</td>
                                      <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 600, color: parseFloat(it.variance_base) > 0 ? '#16a34a' : parseFloat(it.variance_base) < 0 ? '#dc2626' : '#6b7280' }}>
                                        {parseFloat(it.variance_base) > 0 ? '+' : ''}{(parseFloat(parseFloat(it.variance_base))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {it.product_unit}
                                      </td>
                                      <td style={{ padding: '6px 10px', textAlign: 'right', color: '#6b7280' }}>{curSym}{(parseFloat(parseFloat(it.cost_at_count))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                                      <td style={{ padding: '6px 10px', color: '#6b7280' }}>{it.reason || '—'}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
        </>
      )}

      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={pendingDelete?.subject || ''}
        actionLabel={pendingDelete?.actionLabel || 'Confirm Delete'}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

export default StockReconciliation;
