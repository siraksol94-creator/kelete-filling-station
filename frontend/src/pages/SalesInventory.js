import React, { useState, useEffect } from 'react';
import { getSalesInventory, getSalesMonthlySummary, getSalesDailySummary, getSIVBreakdown, saveSalesActualBalance, getCategories, getMainCategories, getSettings } from '../services/api';
import CategoryFilter from '../components/CategoryFilter';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import {
  FiSearch, FiPackage, FiAlertTriangle, FiCalendar, FiSave,
  FiCheckCircle, FiXCircle, FiEdit2, FiTrendingUp, FiDollarSign, FiPrinter, FiChevronDown
} from 'react-icons/fi';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import printHtml from '../utils/printHtml';
import { matchTokens } from '../utils/tokenSearch';
// v1.8.30 — display quantities in the largest configured packaging
// (e.g. "10 box + 4 pcs") instead of raw base-unit count.
import { formatStockForProduct } from '../utils/unitFormat';
const SalesInventory = () => {
  const { user, hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState('');
  const [actualBalances, setActualBalances] = useState({});
  const [reasons, setReasons] = useState({});
  const [filterDate, setFilterDate] = useState(new Date().toISOString().split('T')[0]);
  const maxDate = new Date(Date.now() + 86400000).toISOString().split('T')[0]; // today + 1 day
  const [toast, setToast] = useState(null);
  const [savedRows, setSavedRows] = useState({});   // rows confirmed saved on server
  const [editingRows, setEditingRows] = useState({}); // rows user unlocked for re-edit
  const [otherModal, setOtherModal] = useState(null); // { productId, text }

  useModalScrollLock(!!otherModal);
  const [expandedRows, setExpandedRows] = useState({}); // productId → true/false
  const [sivBreakdowns, setSivBreakdowns] = useState({}); // productId → rows[]
  const [monthlySummary, setMonthlySummary] = useState({ total_revenue: 0, gross_profit: 0, net_profit: 0, total_difference: 0, total_cash_difference: 0, total_pv: 0 });
  const [profitSummary, setProfitSummary] = useState({ revenue: 0, cogs: 0, diff_value: 0, cash_difference: 0, gross_profit: 0, pv_total: 0, stock_adj: 0, net_profit: 0 });
  // Category filter
  const [allCats, setAllCats] = useState([]);
  const [allMains, setAllMains] = useState([]);
  const [selMainIds, setSelMainIds] = useState(null);
  const [selCatIds, setSelCatIds] = useState(null);

  const toggleExpand = async (productId) => {
    const isOpen = expandedRows[productId];
    setExpandedRows(prev => ({ ...prev, [productId]: !isOpen }));
    if (!isOpen && !sivBreakdowns[productId]) {
      try {
        const res = await getSIVBreakdown(filterDate, productId);
        setSivBreakdowns(prev => ({ ...prev, [productId]: res.data || [] }));
      } catch { setSivBreakdowns(prev => ({ ...prev, [productId]: [] })); }
    }
  };

  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const loadData = async (date) => {
    setLoading(true);
    try {
      const month = date.slice(0, 7);
      const [res, monthRes, profitRes] = await Promise.all([
        getSalesInventory({ date }),
        getSalesMonthlySummary(month),
        getSalesDailySummary(date),
      ]);
      setMonthlySummary(monthRes.data || { total_revenue: 0, gross_profit: 0, net_profit: 0, total_difference: 0, total_cash_difference: 0, total_pv: 0 });
      setProfitSummary(profitRes.data || { revenue: 0, cogs: 0, diff_value: 0, cash_difference: 0, gross_profit: 0, pv_total: 0, stock_adj: 0, net_profit: 0 });
      // v1.6.3: hide inactive items from operational pages.
      const data = (res.data || []).filter(p => (p.status || 'Active') !== 'Inactive');
      setProducts(data);
      const savedAB = {}, savedReasons = {}, newSavedRows = {};
      data.forEach(p => {
        if (p.saved_actual_balance !== null && p.saved_actual_balance !== undefined) {
          savedAB[p.id] = p.saved_actual_balance;
        }
        if (p.saved_reason) {
          savedReasons[p.id] = p.saved_reason;
        }
        if (p.saved_actual_balance !== null && p.saved_actual_balance !== undefined && p.saved_reason) {
          newSavedRows[p.id] = true;
        }
      });
      setActualBalances(savedAB);
      setReasons(savedReasons);
      setSavedRows(newSavedRows);
      setEditingRows({});
    } catch (err) {
      setProducts([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData(filterDate);
    setExpandedRows({});
    setSivBreakdowns({});
  }, [filterDate]);

  const [businessInfo, setBusinessInfo] = useState({});
  useEffect(() => {
    getCategories().then(r => setAllCats(r.data || [])).catch(() => {});
    getMainCategories().then(r => setAllMains(r.data || [])).catch(() => {});
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
  }, []);

  const activeCatIds = selCatIds === null ? null : new Set(selCatIds.map(String));
  const filtered = products.filter(p => {
    const matchSearch = matchTokens(search, p.name, p.code, p.barcode);
    const matchCat = activeCatIds === null
      ? true
      : p.category_id ? activeCatIds.has(String(p.category_id)) : false;
    return matchSearch && matchCat;
  });

  const computeRow = (product) => {
    const openingBalance = parseFloat(product.opening_balance || 0);
    const input = parseFloat(product.input || 0);
    const totalStock = openingBalance + input;
    const totalSales = parseFloat(product.total_sales || 0);
    const salesReturns = parseFloat(product.total_returns || 0);
    const salesBalance = totalStock - totalSales - salesReturns;
    const costPrice = parseFloat(product.avg_cost_price || product.cost_price || 0);
    const sellingPrice = parseFloat(product.selling_price || 0);
    const actualVal = actualBalances[product.id] !== undefined && actualBalances[product.id] !== ''
      ? parseFloat(actualBalances[product.id]) : 0;
    const hasSavedBalance = product.saved_actual_balance !== null && product.saved_actual_balance !== undefined;
    const difference = actualVal - salesBalance;
    const totalCostPrice = totalSales * costPrice;
    const totalSellingPrice = totalSales * sellingPrice;
    const totalDifference = hasSavedBalance ? (difference * costPrice) : 0;
    const profit = totalSellingPrice - totalCostPrice + totalDifference;
    const stockingPrice = actualVal * sellingPrice;
    return {
      openingBalance, input, totalStock, totalSales, salesReturns, salesBalance,
      costPrice, sellingPrice, actualVal, difference,
      totalCostPrice, totalSellingPrice, totalDifference, profit, stockingPrice
    };
  };

  const isLocked = (id) => !!savedRows[id] && !editingRows[id];

  const PRESET_REASONS = ['Weight Loss', 'Shortage', 'Overage'];

  const getSelectValue = (id) => {
    const r = reasons[id];
    if (!r) return 'Weight Loss';
    return PRESET_REASONS.includes(r) ? r : 'Other';
  };

  const handleReasonChange = (productId, val) => {
    if (val === 'Other') {
      const current = reasons[productId];
      setOtherModal({ productId, text: PRESET_REASONS.includes(current) ? '' : (current || '') });
    } else {
      setReasons(prev => ({ ...prev, [productId]: val }));
    }
  };

  const confirmOtherReason = () => {
    if (!otherModal?.text?.trim()) return;
    setReasons(prev => ({ ...prev, [otherModal.productId]: otherModal.text.trim() }));
    setOtherModal(null);
  };

  const handleSave = async () => {
    // Block save if any visible unsaved/unlocked row has no actual balance filled
    const missingRows = filtered.filter(p => {
      if (savedRows[p.id] && !editingRows[p.id]) return false; // already locked
      return actualBalances[p.id] === '' || actualBalances[p.id] === undefined;
    });
    if (missingRows.length > 0) {
      showToast(`Fill in actual balance for all ${missingRows.length} remaining product${missingRows.length > 1 ? 's' : ''} (enter 0 if empty).`, 'error');
      return;
    }

    const entries = Object.keys(actualBalances)
      .filter(id => {
        if (actualBalances[id] === '' || actualBalances[id] === undefined) return false;
        if (savedRows[id] && !editingRows[id]) return false; // still locked
        return true;
      })
      .map(id => ({
        product_id: parseInt(id),
        actual_balance: parseFloat(actualBalances[id]),
        reason: reasons[id] || null
      }));

    if (entries.length === 0) {
      showToast('No actual balances to save.', 'warning');
      return;
    }

    setSaving(true);
    try {
      await saveSalesActualBalance({ date: filterDate, entries, created_by: user?.id, diff_value: summaryTotals.totalDiff });
      showToast(`${entries.length} actual balance${entries.length > 1 ? 's' : ''} saved successfully!`, 'success');
      await loadData(filterDate);
    } catch (err) {
      showToast('Failed to save: ' + (err.response?.data?.error || err.message), 'error');
    } finally {
      setSaving(false);
    }
  };

  const summaryTotals = filtered.reduce((acc, p) => {
    const r = computeRow(p);
    acc.totalSales += r.totalSales;
    acc.totalReturns += r.salesReturns;
    acc.totalCost += r.totalCostPrice;
    acc.totalRevenue += r.totalSellingPrice;
    acc.totalProfit += r.profit;
    acc.totalStocking += r.stockingPrice;
    acc.totalDiff += r.totalDifference || 0;
    return acc;
  }, { totalSales: 0, totalReturns: 0, totalCost: 0, totalRevenue: 0, totalProfit: 0, totalStocking: 0, totalDiff: 0 });

  const fmt = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const pendingCount = Object.keys(actualBalances)
    .filter(id => {
      if (actualBalances[id] === '' || actualBalances[id] === undefined) return false;
      if (savedRows[id] && !editingRows[id]) return false;
      return true;
    }).length;

  const dailyGrossProfit = profitSummary.gross_profit ?? 0;
  const dailyNetProfit = profitSummary.net_profit ?? 0;

  const summaryCards = [
    {
      label: 'Total Products', value: products.length, prefix: '',
      icon: <FiPackage size={18} />, color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe'
    },
    {
      label: 'Revenue', value: fmt(profitSummary.revenue), prefix: curSym,
      icon: <FiDollarSign size={18} />, color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0'
    },
    {
      label: 'Total Cost', value: fmt(summaryTotals.totalCost), prefix: curSym,
      icon: <FiDollarSign size={18} />, color: '#d97706', bg: '#fffbeb', border: '#fde68a'
    },
    {
      label: 'Gross Profit',
      value: fmt(dailyGrossProfit), prefix: curSym,
      icon: <FiTrendingUp size={18} />,
      color: dailyGrossProfit >= 0 ? '#16a34a' : '#dc2626',
      bg: dailyGrossProfit >= 0 ? '#f0fdf4' : '#fef2f2',
      border: dailyGrossProfit >= 0 ? '#bbf7d0' : '#fecaca'
    },
    {
      label: 'Net Profit',
      value: fmt(dailyNetProfit), prefix: curSym,
      icon: <FiTrendingUp size={18} />,
      color: dailyNetProfit >= 0 ? '#16a34a' : '#dc2626',
      bg: dailyNetProfit >= 0 ? '#f0fdf4' : '#fef2f2',
      border: dailyNetProfit >= 0 ? '#bbf7d0' : '#fecaca'
    },
    {
      label: 'Stocking Value', value: fmt(summaryTotals.totalStocking), prefix: curSym,
      icon: <FiPackage size={18} />, color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe'
    },
    {
      label: 'Difference',
      value: fmt(summaryTotals.totalDiff), prefix: curSym,
      icon: <FiAlertTriangle size={18} />,
      color: summaryTotals.totalDiff < 0 ? '#dc2626' : '#16a34a',
      bg: summaryTotals.totalDiff < 0 ? '#fef2f2' : '#f0fdf4',
      border: summaryTotals.totalDiff < 0 ? '#fecaca' : '#bbf7d0'
    },
    {
      label: 'Monthly Revenue', value: fmt(monthlySummary.total_revenue), prefix: curSym,
      icon: <FiDollarSign size={18} />, color: '#0369a1', bg: '#f0f9ff', border: '#bae6fd',
      monthly: true
    },
    {
      label: 'Monthly Gross Profit', value: fmt(monthlySummary.gross_profit), prefix: curSym,
      icon: <FiTrendingUp size={18} />,
      color: monthlySummary.gross_profit >= 0 ? '#16a34a' : '#dc2626',
      bg: monthlySummary.gross_profit >= 0 ? '#f0fdf4' : '#fef2f2',
      border: monthlySummary.gross_profit >= 0 ? '#bbf7d0' : '#fecaca',
      monthly: true
    },
    {
      label: 'Monthly Net Profit', value: fmt(monthlySummary.net_profit), prefix: curSym,
      icon: <FiTrendingUp size={18} />,
      color: monthlySummary.net_profit >= 0 ? '#16a34a' : '#dc2626',
      bg: monthlySummary.net_profit >= 0 ? '#f0fdf4' : '#fef2f2',
      border: monthlySummary.net_profit >= 0 ? '#bbf7d0' : '#fecaca',
      monthly: true
    },
    {
      label: 'Monthly Difference', value: fmt(monthlySummary.total_difference), prefix: curSym,
      icon: <FiAlertTriangle size={18} />,
      color: monthlySummary.total_difference < 0 ? '#dc2626' : '#16a34a',
      bg: monthlySummary.total_difference < 0 ? '#fef2f2' : '#f0fdf4',
      border: monthlySummary.total_difference < 0 ? '#fecaca' : '#bbf7d0',
      monthly: true
    },
  ];

  const printDirect = (html) => printHtml(html);

  // v1.13.117 — replaced thermal 80mm receipt-style print with A4 HTML
  // print (matching Sales Report Export PDF layout). Currency changed
  // from hardcoded '$' to curSym so K-mode receipts show K.
  const handlePrintInventory = async () => {
    const dateLabel = new Date(filterDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtQ = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const printedBy = [user?.firstName, user?.lastName].filter(Boolean).join(' ') || '—';
    const bizName = businessInfo?.business_name || 'Business Name';
    const bizPhone = businessInfo?.business_phone || '';
    const bizAddr = businessInfo?.business_address || '';

    const rows = filtered.map((p, idx) => {
      const r = computeRow(p);
      return `<tr style="background:${idx % 2 === 1 ? '#f5f5f5' : '#fff'};border-bottom:1px solid #ddd">
        <td style="padding:6px 10px;color:#000;font-size:10.5px">${idx + 1}</td>
        <td style="padding:6px 10px;font-weight:600">${p.name}</td>
        <td style="padding:6px 10px;text-align:right;font-family:monospace">${fmtQ(r.openingBalance)}</td>
        <td style="padding:6px 10px;text-align:right;font-family:monospace">${fmtQ(r.input)}</td>
        <td style="padding:6px 10px;text-align:right;font-family:monospace">${fmtQ(r.totalSales)}</td>
        <td style="padding:6px 10px;text-align:right;font-family:monospace">${fmtQ(r.salesReturns)}</td>
        <td style="padding:6px 10px;text-align:right;font-family:monospace">${fmtQ(r.salesBalance)}</td>
        <td style="padding:6px 10px;text-align:right;font-family:monospace">${curSym}${fmt(r.sellingPrice)}</td>
        <td style="padding:6px 10px;text-align:right;font-weight:700;font-family:monospace">${curSym}${fmt(r.totalSellingPrice)}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales Inventory — ${dateLabel}</title><style>
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
          <div style="font-size:10px;color:#000;line-height:1.6">${[bizAddr, bizPhone].filter(Boolean).join('  |  ')}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#000;margin-bottom:3px">Sales Inventory</div>
          <div style="font-size:14px;font-weight:700">${dateLabel}</div>
          <div style="font-size:9px;color:#000;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="border:1.5px solid #000;margin-bottom:14px">
        <table>
          <thead><tr>
            <th style="width:28px">#</th>
            <th>Product</th>
            <th style="text-align:right">Opening</th>
            <th style="text-align:right">Input</th>
            <th style="text-align:right">Sales</th>
            <th style="text-align:right">Returns</th>
            <th style="text-align:right">Balance</th>
            <th style="text-align:right">Sale Price</th>
            <th style="text-align:right">Total Revenue</th>
          </tr></thead>
          <tbody>${rows || '<tr><td colspan="9" style="padding:20px;text-align:center;color:#666">No products in this view</td></tr>'}</tbody>
          <tfoot><tr>
            <td colspan="8">GRAND TOTAL — ${filtered.length} product${filtered.length !== 1 ? 's' : ''}</td>
            <td style="text-align:right;font-size:13px;font-family:monospace">${curSym}${fmt(summaryTotals.totalRevenue)}</td>
          </tr></tfoot>
        </table>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:28px;margin-bottom:12px">
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
      <div className="page-header">
        <div>
          <h1>Sales Inventory</h1>
          <p>Daily stock tracking &mdash; transferred via SIV</p>
        </div>
        {hasPermission('SalesInventory:Add') && (
          <button
            onClick={handleSave}
            disabled={saving || pendingCount === 0}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              padding: '10px 22px', borderRadius: 10, border: 'none',
              cursor: pendingCount === 0 ? 'not-allowed' : 'pointer',
              fontSize: 14, fontWeight: 600,
              background: pendingCount > 0 ? 'linear-gradient(135deg, #16a34a, #15803d)' : '#d1d5db',
              color: 'white',
              boxShadow: pendingCount > 0 ? '0 4px 14px rgba(22,163,74,0.45)' : 'none',
              transition: 'all 0.25s', opacity: saving ? 0.75 : 1,
            }}
          >
            <FiSave size={17} />
            {saving ? 'Saving...' : 'Save Actual Balances'}
            {pendingCount > 0 && !saving && (
              <span style={{
                background: 'rgba(255,255,255,0.25)', borderRadius: 12,
                padding: '1px 9px', fontSize: 12, fontWeight: 700, marginLeft: 2
              }}>
                {pendingCount}
              </span>
            )}
          </button>
        )}
        <button
          onClick={handlePrintInventory}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 22px', borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600, backgroundColor: '#2563eb', color: 'white' }}
        >
          <FiPrinter size={17} /> Print
        </button>
      </div>

      {/* Summary Cards */}
      {(() => {
        const daily = summaryCards.filter(c => !c.monthly);
        const monthly = summaryCards.filter(c => c.monthly);
        const renderCard = (card) => (
          <div key={card.label} style={{
            flex: '1 1 0', display: 'flex', alignItems: 'center', gap: 12,
            padding: '14px 16px', borderRadius: 12,
            background: card.bg,
            border: `1.5px solid ${card.border}`,
            boxShadow: '0 1px 4px rgba(0,0,0,0.06)', minWidth: 0, overflow: 'hidden',
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, flexShrink: 0,
              background: card.color + '1a', display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: card.color,
            }}>
              {card.icon}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontSize: 10, color: '#6b7280', fontWeight: 600,
                letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 2,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}>
                {card.label}
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, color: card.color, lineHeight: 1.2, whiteSpace: 'nowrap' }}>
                {card.prefix}{card.value}
              </div>
            </div>
          </div>
        );
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
            <div style={{ display: 'flex', gap: 10 }}>
              {daily.map(renderCard)}
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' }}>
                {filterDate.slice(0, 7)} MTD
              </div>
              {monthly.map(c => renderCard(c))}
            </div>
          </div>
        );
      })()}

      {/* Filters */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="search-input-container" style={{ flex: 1, minWidth: 200, marginBottom: 0 }}>
            <FiSearch style={{ color: '#9ca3af' }} />
            <input type="text" placeholder="Search products..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiCalendar size={16} style={{ color: '#6b7280' }} />
            <input
              type="date" value={filterDate} max={maxDate}
              onChange={e => setFilterDate(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, fontWeight: 500, color: '#374151', cursor: 'pointer' }}
            />
            <button
              onClick={() => setFilterDate(new Date().toISOString().split('T')[0])}
              style={{
                padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb',
                background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                color: '#374151', whiteSpace: 'nowrap',
              }}
            >
              Today
            </button>
          </div>
        </div>
      </div>

      <CategoryFilter
        categories={allCats}
        mainCategories={allMains}
        selectedMainIds={selMainIds}
        selectedCatIds={selCatIds}
        onChange={({ mainIds, catIds }) => { setSelMainIds(mainIds); setSelCatIds(catIds); }}
      />

      {/* Subtotals by main category */}
      {(() => {
        const subMap = new Map();
        for (const p of filtered) {
          const main = allMains.find(m => String(m.id) === String(p.main_category_id));
          const key = main ? main.id : '__unassigned__';
          const name = main ? main.name : 'Uncategorized';
          const color = main ? main.color : '#6b7280';
          if (!subMap.has(key)) subMap.set(key, { name, color, count: 0, value: 0 });
          const e = subMap.get(key);
          e.count += 1;
          e.value += parseFloat(p.opening_balance || 0) * parseFloat(p.selling_price || 0);
        }
        const subs = Array.from(subMap.values()).sort((a, b) => b.value - a.value);
        if (subs.length <= 1) return null;
        return (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {subs.map(s => (
              <div key={s.name} style={{
                padding: '6px 12px', borderRadius: 8,
                background: (s.color || '#6b7280') + '15',
                border: `1px solid ${(s.color || '#6b7280')}40`, fontSize: 12,
              }}>
                <span style={{ color: s.color, fontWeight: 700 }}>{s.name}:</span>
                <span style={{ marginLeft: 6, color: '#374151', fontWeight: 600 }}>
                  {s.count} item{s.count !== 1 ? 's' : ''} · ${s.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Table */}
      <div className="card">
        <div className="card-header">
          <h3>Sales Stock Levels</h3>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{filtered.length} products</span>
        </div>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>No products found.</div>
        ) : (
          <div className="table-container" style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ fontSize: 12, minWidth: 1400 }}>
              <thead>
                <tr>
                  <th>Product</th>
                  <th style={{ textAlign: 'right' }}>Opening Bal.</th>
                  <th style={{ textAlign: 'right' }}>Input</th>
                  <th style={{ textAlign: 'right' }}>Total Stock</th>
                  <th style={{ textAlign: 'right' }}>Total Sales</th>
                  <th style={{ textAlign: 'right' }}>Returns</th>
                  <th style={{ textAlign: 'right' }}>Sales Bal.</th>
                  {/* v1.8.30 — Actual Bal / Difference / Reason columns
                      removed per user request (not needed on this view).
                      Underlying save logic kept for back-compat in case
                      another page needs it. */}
                  <th style={{ textAlign: 'right' }}>Cost Price</th>
                  <th style={{ textAlign: 'right' }}>Selling Price</th>
                  <th style={{ textAlign: 'right' }}>Total Cost</th>
                  <th style={{ textAlign: 'right' }}>Total Selling</th>
                  <th style={{ textAlign: 'right' }}>Total Diff.</th>
                  <th style={{ textAlign: 'right' }}>Profit</th>
                  <th style={{ textAlign: 'right' }}>Stocking Price</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((product, rowIndex) => {
                  const r = computeRow(product);
                  const locked = isLocked(product.id);
                  const hasActual = actualBalances[product.id] !== undefined && actualBalances[product.id] !== '';
                  const isExpanded = !!expandedRows[product.id];
                  return (
                    <React.Fragment key={product.id}>
                    <tr style={{ background: locked ? '#f9fafb' : undefined }}>
                      <td>
                        <div
                          onClick={() => toggleExpand(product.id)}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
                          title="Click to see SIV breakdown"
                        >
                          <FiChevronDown size={13} style={{ color: '#9ca3af', transition: 'transform 0.2s', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} />
                          <strong style={{ color: '#111827' }}>{product.name}</strong>
                        </div>
                      </td>
                      {/* v1.8.31 — always render in the product's configured
                          default unit (e.g. 'Box'). preferDefaultUnit forces
                          single-unit display; allowNegative renders '−106 Box'
                          for over-issued stock instead of falling back to
                          base 'Bottle' which made the table inconsistent. */}
                      <td style={{ textAlign: 'right' }}>{formatStockForProduct(r.openingBalance, product, { showBaseInParens: false, decimals: 2, allowNegative: true, preferDefaultUnit: true })}</td>
                      <td style={{ textAlign: 'right', color: r.input > 0 ? '#2563eb' : '#9ca3af' }}>{formatStockForProduct(r.input, product, { showBaseInParens: false, decimals: 2, allowNegative: true, preferDefaultUnit: true })}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatStockForProduct(r.totalStock, product, { showBaseInParens: false, decimals: 2, allowNegative: true, preferDefaultUnit: true })}</td>
                      <td style={{ textAlign: 'right', color: r.totalSales > 0 ? '#dc2626' : '#9ca3af' }}>{formatStockForProduct(r.totalSales, product, { showBaseInParens: false, decimals: 2, allowNegative: true, preferDefaultUnit: true })}</td>
                      <td style={{ textAlign: 'right', color: r.salesReturns > 0 ? '#d97706' : '#9ca3af' }}>{r.salesReturns > 0 ? formatStockForProduct(r.salesReturns, product, { showBaseInParens: false, decimals: 2, allowNegative: true, preferDefaultUnit: true }) : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatStockForProduct(r.salesBalance, product, { showBaseInParens: false, decimals: 2, allowNegative: true, preferDefaultUnit: true })}</td>

                      {/* v1.8.30 — Actual Balance / Difference / Reason
                          columns removed per user request. */}
                      <td style={{ textAlign: 'right' }}>{curSym}{r.costPrice.toFixed(2)}</td>
                      <td style={{ textAlign: 'right' }}>{curSym}{r.sellingPrice.toFixed(2)}</td>
                      <td style={{ textAlign: 'right' }}>{curSym}{fmt(r.totalCostPrice)}</td>
                      <td style={{ textAlign: 'right' }}>{curSym}{fmt(r.totalSellingPrice)}</td>
                      <td style={{ textAlign: 'right', color: r.totalDifference < 0 ? '#dc2626' : '#16a34a' }}>
                        ${fmt(r.totalDifference)}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: r.profit >= 0 ? '#16a34a' : '#dc2626' }}>
                        ${fmt(r.profit)}
                      </td>
                      <td style={{ textAlign: 'right' }}>{curSym}{fmt(r.stockingPrice)}</td>
                    </tr>
                    {isExpanded && (
                      <tr style={{ background: '#f0f9ff' }}>
                        <td colSpan={13} style={{ padding: '6px 24px 10px 32px' }}>
                          {!sivBreakdowns[product.id] ? (
                            <span style={{ fontSize: 12, color: '#9ca3af' }}>Loading...</span>
                          ) : sivBreakdowns[product.id].length === 0 ? (
                            <span style={{ fontSize: 12, color: '#9ca3af' }}>No SIV inputs found for this date.</span>
                          ) : (
                            <table style={{ fontSize: 12, borderCollapse: 'collapse', width: 'auto' }}>
                              <thead>
                                <tr style={{ color: '#6b7280' }}>
                                  <th style={{ padding: '3px 14px 3px 0', fontWeight: 600, textAlign: 'left' }}>SIV No</th>
                                  <th style={{ padding: '3px 14px 3px 0', fontWeight: 600, textAlign: 'left' }}>Department</th>
                                  <th style={{ padding: '3px 14px 3px 0', fontWeight: 600, textAlign: 'left' }}>Time</th>
                                  <th style={{ padding: '3px 0', fontWeight: 600, textAlign: 'right' }}>Qty</th>
                                </tr>
                              </thead>
                              <tbody>
                                {sivBreakdowns[product.id].map((row, i) => (
                                  <tr key={i}>
                                    <td style={{ padding: '2px 14px 2px 0', color: '#2563eb', fontWeight: 600 }}>{row.siv_number}</td>
                                    <td style={{ padding: '2px 14px 2px 0', color: '#374151' }}>{row.department}</td>
                                    <td style={{ padding: '2px 14px 2px 0', color: '#6b7280' }}>{new Date(row.created_at + 'Z').toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}</td>
                                    <td style={{ padding: '2px 0', textAlign: 'right', fontWeight: 600, color: '#16a34a' }}>{parseFloat(row.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: '2px solid #e5e7eb', background: '#f9fafb' }}>
                  <td>TOTALS</td>
                  <td colSpan={3}></td>
                  <td style={{ textAlign: 'right' }}>{summaryTotals.totalSales.toLocaleString()}</td>
                  <td style={{ textAlign: 'right', color: '#d97706' }}>{summaryTotals.totalReturns > 0 ? summaryTotals.totalReturns.toLocaleString() : '—'}</td>
                  <td colSpan={4}></td>
                  <td></td>
                  <td style={{ textAlign: 'right' }}>{curSym}{fmt(summaryTotals.totalCost)}</td>
                  <td style={{ textAlign: 'right' }}>{curSym}{fmt(summaryTotals.totalRevenue)}</td>
                  <td style={{ textAlign: 'right', color: summaryTotals.totalDiff < 0 ? '#dc2626' : '#16a34a' }}>{curSym}{fmt(summaryTotals.totalDiff)}</td>
                  <td style={{ textAlign: 'right', color: summaryTotals.totalProfit >= 0 ? '#16a34a' : '#dc2626' }}>{curSym}{fmt(summaryTotals.totalProfit)}</td>
                  <td style={{ textAlign: 'right' }}>{curSym}{fmt(summaryTotals.totalStocking)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* "Other" Reason Modal */}
      {otherModal && (
        <Portal>
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 9000,
          display: 'flex', alignItems: 'center', justifyContent: 'center'
        }}>
          <div style={{
            background: '#fff', borderRadius: 14, padding: '26px 28px', width: 380,
            boxShadow: '0 20px 60px rgba(0,0,0,0.22)', animation: 'slideUp 0.2s ease'
          }}>
            <h4 style={{ margin: '0 0 5px', fontSize: 16, fontWeight: 700, color: '#111827' }}>
              Enter Custom Reason
            </h4>
            <p style={{ margin: '0 0 16px', fontSize: 12, color: '#6b7280' }}>
              Describe why this difference occurred
            </p>
            <textarea
              autoFocus
              value={otherModal.text}
              onChange={e => setOtherModal(prev => ({ ...prev, text: e.target.value }))}
              placeholder="e.g. Spoilage due to refrigeration failure..."
              rows={3}
              style={{
                width: '100%', boxSizing: 'border-box', padding: '10px 12px',
                borderRadius: 8, border: '1.5px solid #d1d5db', fontSize: 13,
                resize: 'vertical', outline: 'none', fontFamily: 'inherit',
                transition: 'border-color 0.2s', lineHeight: 1.5,
              }}
              onFocus={e => e.target.style.borderColor = '#2563eb'}
              onBlur={e => e.target.style.borderColor = '#d1d5db'}
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
              <button
                onClick={() => setOtherModal(null)}
                style={{
                  padding: '9px 20px', borderRadius: 8, border: '1px solid #e5e7eb',
                  background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#374151'
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmOtherReason}
                disabled={!otherModal.text?.trim()}
                style={{
                  padding: '9px 20px', borderRadius: 8, border: 'none',
                  background: otherModal.text?.trim() ? '#2563eb' : '#d1d5db',
                  color: '#fff', cursor: otherModal.text?.trim() ? 'pointer' : 'not-allowed',
                  fontSize: 13, fontWeight: 600, transition: 'background 0.2s'
                }}
              >
                Save Reason
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Toast Notification */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 28, right: 28, zIndex: 9999,
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '13px 20px', borderRadius: 12, fontSize: 14, fontWeight: 500,
          color: 'white', boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
          background: toast.type === 'success'
            ? 'linear-gradient(135deg, #16a34a, #15803d)'
            : toast.type === 'warning'
            ? 'linear-gradient(135deg, #ca8a04, #a16207)'
            : 'linear-gradient(135deg, #dc2626, #b91c1c)',
          animation: 'slideUp 0.3s ease', minWidth: 260, maxWidth: 380,
        }}>
          {toast.type === 'success'
            ? <FiCheckCircle size={20} style={{ flexShrink: 0 }} />
            : toast.type === 'warning'
            ? <FiAlertTriangle size={20} style={{ flexShrink: 0 }} />
            : <FiXCircle size={20} style={{ flexShrink: 0 }} />
          }
          <span style={{ flex: 1 }}>{toast.message}</span>
          <button
            onClick={() => setToast(null)}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0, marginLeft: 4 }}
          >✕</button>
        </div>
      )}

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(16px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
};

export default SalesInventory;
