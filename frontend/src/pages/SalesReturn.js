import React, { useState, useEffect, useRef } from 'react';
import { getSalesReturns, getSalesReturnStats, getSalesReturnNotes, createSalesReturn, updateSalesReturn, deleteSalesReturn, getSalesReturn, getInventory, getSettings } from '../services/api';
import { FiPlus, FiTrash2, FiX, FiEye, FiCornerDownLeft, FiAlertTriangle, FiPrinter, FiEdit2 } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { unitsForProduct as unitsForProductFE } from '../utils/productUnits';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import { matchTokens } from '../utils/tokenSearch';

const todayStr = new Date().toISOString().split('T')[0];

const lbl = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '10px 12px', fontSize: 13 };

const emptyItem = { product_id: '', product_name: '', quantity: '', sales_balance: 0, unit: 'kg' };

const SalesReturn = () => {
  const [entries, setEntries]   = useState([]);
  const [stats, setStats]       = useState({ total: 0, thisMonth: 0 });
  const [products, setProducts] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [modal, setModal]       = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail]     = useState(null);
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');
  const [filterFrom, setFilterFrom] = useState(todayStr);
  const [filterTo,   setFilterTo]   = useState(todayStr);
  const [showPrintPreview, setShowPrintPreview]   = useState(false);

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(!!modal || showPrintPreview);
  const [printItemsMap, setPrintItemsMap]         = useState({});
  const [printItemsLoading, setPrintItemsLoading] = useState(false);
  const [businessInfo, setBusinessInfo]           = useState({});
  const [toast, setToast] = useState(null);

  const { hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const [date, setDate]   = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([{ ...emptyItem }]);

  const [search, setSearch]         = useState([]);
  const [open, setOpen]             = useState([]);
  const [notesHistory, setNotesHistory] = useState([]);
  const [notesOpen, setNotesOpen]   = useState(false);
  const dropRef = useRef([]);
  const notesRef = useRef(null);

  const fetchAll = async () => {
    try {
      const [eRes, sRes, pRes, nRes] = await Promise.all([
        getSalesReturns(), getSalesReturnStats(), getInventory(), getSalesReturnNotes()
      ]);
      setEntries(eRes.data || []);
      setStats(sRes.data || { total: 0, thisMonth: 0 });
      // v1.6.3: exclude inactive items from the sales-return picker too.
      setProducts((pRes.data || []).filter(p =>
        parseFloat(p.sales_balance || 0) > 0 && (p.status || 'Active') !== 'Inactive'
      ));
      setNotesHistory(nRes.data || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchAll(); }, []);

  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest('.srt-dropdown')) setOpen([]);
      if (notesRef.current && !notesRef.current.contains(e.target)) setNotesOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const openCreate = () => {
    setDate(new Date().toISOString().split('T')[0]);
    setNotes('');
    setItems([{ ...emptyItem }]);
    setSearch([]);
    setOpen([]);
    setError('');
    setModal('create');
  };

  const openView = async (entry) => {
    setSelected(entry);
    setModal('view');
    // v1.13.59 — synthetic rows (HQ GRN damage, Transit write-off) have
    // no matching sales_returns row on the backend, so skip the fetch.
    if ((entry.source || 'branch') !== 'branch') { setDetail(null); return; }
    try { const res = await getSalesReturn(entry.id); setDetail(res.data); }
    catch { setDetail(null); }
  };

  const openDelete = (entry) => {
    setPendingDelete({
      subject: `${entry.return_number} — stock movements will be reversed`,
      perform: async () => {
        try { await deleteSalesReturn(entry.id); await fetchAll(); showToast('Damage record deleted.', 'error'); }
        catch { showToast('Failed to delete.', 'error'); }
      },
    });
  };
  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const closeModal = () => { setModal(null); setSelected(null); setDetail(null); setError(''); };

  const openEdit = async (entry) => {
    setSelected(entry);
    setError('');
    try {
      const res = await getSalesReturn(entry.id);
      const d = res.data;
      setDate(d.date ? d.date.split('T')[0] : todayStr);
      setNotes(d.notes || '');
      setItems((d.items || []).map(i => ({ product_id: i.product_id, product_name: i.product_name, quantity: String(i.quantity), unit: i.unit || 'kg', sales_balance: 0 })));
      setSearch((d.items || []).map(() => ''));
      setOpen((d.items || []).map(() => false));
    } catch { setError('Failed to load entry.'); }
    setModal('edit');
  };

  const addItem    = () => setItems(prev => [...prev, { ...emptyItem }]);
  const removeItem = (i) => setItems(prev => prev.filter((_, idx) => idx !== i));
  const updateItem = (i, field, val) => setItems(prev => prev.map((row, idx) => idx === i ? { ...row, [field]: val } : row));

  const selectProduct = (i, product) => {
    setItems(prev => prev.map((row, idx) => idx === i ? {
      ...row,
      product_id: product.id,
      product_name: product.name,
      unit: product.unit || 'kg',
      sales_balance: parseFloat(product.sales_balance || 0),
    } : row));
    setSearch(prev => { const a = [...prev]; a[i] = ''; return a; });
    setOpen(prev => { const a = [...prev]; a[i] = false; return a; });
  };

  const filteredProducts = (s) =>
    products.filter(p => matchTokens(s, p.name, p.code, p.barcode)).slice(0, 8);

  const handleSave = async () => {
    const valid = items.filter(r => r.product_id && parseFloat(r.quantity) > 0);
    if (!notes.trim()) { setError('Notes is required.'); return; }
    if (!valid.length) { setError('Add at least one item with a valid product and quantity.'); return; }
    if (modal === 'edit') {
      if (!window.confirm('Are you sure you want to update this record?')) return;
    } else {
      // New-entry safety: reminds the cashier this row goes to HQ's queue.
      if (!window.confirm('Save this damage entry? It will be sent to HQ for confirmation.')) return;
    }
    setSaving(true); setError('');
    try {
      if (modal === 'edit') {
        await updateSalesReturn(selected.id, { date, notes, items: valid });
        await fetchAll();
        closeModal();
        showToast('Damage record updated.');
      } else {
        await createSalesReturn({ date, notes, items: valid });
        await fetchAll();
        closeModal();
        showToast('Damage record saved.');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save damage record.');
    }
    setSaving(false);
  };

  const handleDelete = async () => {
    try {
      await deleteSalesReturn(selected.id);
      await fetchAll();
      closeModal();
      showToast('Damage record deleted.', 'error');
    } catch { setError('Failed to delete.'); }
  };

  const formatDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

  const filteredEntries = entries.filter(e => {
    const d = (e.date || '').split('T')[0];
    if (filterFrom && d < filterFrom) return false;
    if (filterTo   && d > filterTo)   return false;
    return true;
  });

  const openPrintPreview = async () => {
    setPrintItemsLoading(true);
    try {
      const [results, settings] = await Promise.all([
        Promise.all(filteredEntries.map(e => getSalesReturn(e.id))),
        getSettings(),
      ]);
      const map = {};
      results.forEach(res => { if (res?.data?.id) map[res.data.id] = res.data; });
      const biz = settings?.data?.business || {};
      const printedAt = new Date().toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      const bizName = biz.business_name || 'Business Name';
      const addr = [biz.business_address,biz.business_phone,biz.business_email].filter(Boolean).join('  |  ');
      const dateLabel = filterFrom||filterTo
        ? `${filterFrom?formatDate(filterFrom):'All'} — ${filterTo?formatDate(filterTo):'All'}` : formatDate(todayStr);
      const chip = (label,value,bg,color,border) =>
        `<div style="padding:12px 16px;border-radius:10px;background:${bg};border:1.5px solid ${border};text-align:center">
          <div style="font-size:9.5px;letter-spacing:0.8px;text-transform:uppercase;color:#64748b;font-weight:600;margin-bottom:6px">${label}</div>
          <div style="font-size:20px;font-weight:800;color:${color}">${value}</div>
        </div>`;
      const chips = [
        chip('Total Returns (All)', stats.total,            '#eff6ff','#1d4ed8','#bfdbfe'),
        chip('This Month',           stats.thisMonth,        '#f0fdf4','#15803d','#86efac'),
        chip('Filtered Returns',     filteredEntries.length, '#fff7ed','#c2410c','#fed7aa'),
      ].join('');
      const rows = filteredEntries.map((entry,idx) => {
        const detail = map[entry.id];
        const retItems = detail?.items || [];
        const subRows = retItems.length>0 ? `<tr style="background:#f8fafc"><td colspan="6" style="padding:0 12px 10px 32px">
          <table style="width:100%;border-collapse:collapse;font-size:10.5px">
            <thead><tr style="background:#e0f2fe">
              <th style="padding:5px 10px;text-align:left;color:#0369a1;font-weight:600">Product</th>
              <th style="padding:5px 10px;text-align:right;color:#0369a1;font-weight:600">Qty Damaged</th>
            </tr></thead><tbody>${retItems.map(item=>`<tr style="border-bottom:1px solid #bae6fd">
              <td style="padding:5px 10px;color:#111827;font-weight:500">${item.product_name}</td>
              <td style="padding:5px 10px;text-align:right;font-weight:600;color:#0284c7;font-family:monospace">${(parseFloat(parseFloat(item.quantity))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} ${item.unit}</td>
            </tr>`).join('')}</tbody>
          </table>
        </td></tr>` : '';
        return `<tr style="background:${idx%2===1?'#f0f9ff':'#fff'};border-top:${idx>0?'2px solid #e2e8f0':'none'}">
          <td style="padding:8px 12px;color:#9ca3af;font-size:10.5px">${idx+1}</td>
          <td style="padding:8px 12px;font-weight:700;font-family:monospace;font-size:11px;color:#1d4ed8">${entry.return_number}</td>
          <td style="padding:8px 12px;color:#374151">${formatDate(entry.date)}</td>
          <td style="padding:8px 12px;color:#374151">${entry.item_count} item${entry.item_count!==1?'s':''}</td>
          <td style="padding:8px 12px;text-align:right;font-family:monospace;color:#dc2626;font-weight:700">${curSym}${parseFloat(entry.total_value||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
          <td style="padding:8px 12px;color:#6b7280;font-size:10.5px">${entry.notes||'—'}</td>
        </tr>${subRows}`;
      }).join('');
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        @page{size:A4 portrait;margin:0}*{box-sizing:border-box;margin:0;padding:0}
        body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#1a1a2e}
      </style></head><body><div style="width:794px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#1e3a8a 0%,#0284c7 100%);padding:28px 44px 22px;color:#fff;display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:5px">${bizName}</div>
            <div style="font-size:11px;opacity:0.75;line-height:1.7">${addr}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:0.65;margin-bottom:6px">Sales Damages</div>
            <div style="font-size:15px;font-weight:700">${dateLabel}</div>
            <div style="font-size:10px;opacity:0.6;margin-top:4px">Printed: ${printedAt}</div>
          </div>
        </div>
        <div style="height:4px;background:linear-gradient(90deg,#2563eb,#0284c7,#06b6d4)"></div>
        <div style="padding:26px 44px 36px">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px">${chips}</div>
          <div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
            <div style="background:#f8fafc;border-bottom:1.5px solid #e2e8f0;padding:10px 16px;display:flex;align-items:center;gap:8px">
              <span style="width:8px;height:8px;border-radius:50%;background:#0284c7;display:inline-block"></span>
              <span style="font-weight:700;font-size:10.5px;letter-spacing:0.8px;text-transform:uppercase;color:#475569">Return Records</span>
            </div>
            <table style="width:100%;border-collapse:collapse;font-size:11.5px">
              <thead><tr style="background:#f9fafb">
                <th style="padding:8px 12px;text-align:left;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;font-size:10.5px">#</th>
                <th style="padding:8px 12px;text-align:left;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;font-size:10.5px">Return #</th>
                <th style="padding:8px 12px;text-align:left;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;font-size:10.5px">Date</th>
                <th style="padding:8px 12px;text-align:left;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;font-size:10.5px">Items</th>
                <th style="padding:8px 12px;text-align:right;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;font-size:10.5px">Value (${curSym})</th>
                <th style="padding:8px 12px;text-align:left;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb;font-size:10.5px">Notes</th>
              </tr></thead>
              <tbody>${rows}</tbody>
              <tfoot><tr style="background:#f0f9ff;border-top:2px solid #bae6fd">
                <td colspan="3" style="padding:10px 12px;font-weight:700;font-size:11.5px;color:#0c4a6e">TOTAL — ${filteredEntries.length} Damage${filteredEntries.length!==1?'s':''}</td>
                <td style="padding:10px 12px;font-weight:700;color:#374151">${filteredEntries.reduce((s,e)=>s+parseInt(e.item_count||0),0)} items</td>
                <td style="padding:10px 12px;text-align:right;font-weight:700;font-family:monospace;color:#dc2626">${curSym}${filteredEntries.reduce((s,e)=>s+parseFloat(e.total_value||0),0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                <td></td>
              </tr></tfoot>
            </table>
          </div>
          <div style="border-top:1px solid #f1f5f9;padding-top:12px;display:flex;justify-content:space-between">
            <span style="font-size:9.5px;color:#cbd5e1">${bizName} — Confidential</span>
            <span style="font-size:9.5px;color:#cbd5e1">Printed: ${printedAt}</span>
          </div>
        </div>
      </div></body></html>`;
      const w = window.open('', '_blank');
      if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>{ w.print(); w.close(); },300); }
    } catch (e) {}
    setPrintItemsLoading(false);
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('salesDamages')}</h1>
          <p>{t('salesDamagesSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={openPrintPreview} disabled={printItemsLoading} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: printItemsLoading ? '#93c5fd' : '#2563eb', color: '#fff', cursor: printItemsLoading ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>
            <FiPrinter size={15} /> {printItemsLoading ? t('loading') : t('print')}
          </button>
          {hasPermission('SalesReturns:Add') && (
          <button className="btn btn-primary" onClick={openCreate} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FiPlus /> {t('newSalesDamage')}
          </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="stat-cards" style={{ gridTemplateColumns: 'repeat(2, 1fr)', maxWidth: 480 }}>
        <div className="stat-card stat-card-blue">
          <div className="stat-icon" style={{ background: '#dbeafe', color: '#2563eb' }}><FiCornerDownLeft /></div>
          <div><div className="stat-label">{t('totalDamages')}</div><div className="stat-value">{hasPermission('SalesReturns:View') ? stats.total : 'N/A'}</div></div>
        </div>
        <div className="stat-card stat-card-green">
          <div className="stat-icon" style={{ background: '#dcfce7', color: '#16a34a' }}><FiCornerDownLeft /></div>
          <div><div className="stat-label">{t('thisMonth')}</div><div className="stat-value">{hasPermission('SalesReturns:View') ? stats.thisMonth : 'N/A'}</div></div>
        </div>
      </div>

      {/* Date Filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, padding: '12px 16px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{t('filterByDate')}:</span>
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('from')}</span>
        <input type="date" value={filterFrom} max={filterTo || todayStr} onChange={e => setFilterFrom(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', cursor: 'pointer' }} />
        <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('to')}</span>
        <input type="date" value={filterTo} min={filterFrom || undefined} max={todayStr} onChange={e => setFilterTo(e.target.value)}
          style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', cursor: 'pointer' }} />
        {(filterFrom || filterTo) && (
          <button onClick={() => { setFilterFrom(''); setFilterTo(''); }}
            style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' }}>
            {t('clear')}
          </button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>{filteredEntries.length} return{filteredEntries.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Table */}
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>{t('returnNumber')}</th>
              <th>{t('date')}</th>
              <th>{t('items')}</th>
              <th style={{ textAlign: 'right' }}>{t('value')} ({curSym})</th>
              <th>Status</th>
              <th>{t('notes')}</th>
              <th>{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>Loading...</td></tr>
            ) : filteredEntries.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: '#9ca3af' }}>{entries.length === 0 ? 'No damages recorded yet.' : 'No damages for selected date range.'}</td></tr>
            ) : filteredEntries.map(e => {
              const st = (e.status || 'PENDING').toUpperCase();
              const stColor  = st === 'CONFIRMED' ? '#166534' : st === 'REJECTED' ? '#b91c1c' : st === 'AUTO' ? '#1d4ed8' : st === 'WRITE_OFF' ? '#6d28d9' : '#b45309';
              const stBg     = st === 'CONFIRMED' ? '#dcfce7' : st === 'REJECTED' ? '#fee2e2' : st === 'AUTO' ? '#eff6ff' : st === 'WRITE_OFF' ? '#f5f3ff' : '#fef3c7';
              const stBorder = st === 'CONFIRMED' ? '#86efac' : st === 'REJECTED' ? '#fecaca' : st === 'AUTO' ? '#bfdbfe' : st === 'WRITE_OFF' ? '#ddd6fe' : '#fde68a';
              // v1.13.59 — source badge. Branch keeps edit/delete;
              // hq_grn and transit are read-only synthetic rows.
              // v1.13.60 — CONFIRMED branch rows are HQ-locked; can't be
              // edited/deleted from the branch. Only PENDING/REJECTED
              // branch rows are still user-editable.
              const source = e.source || 'branch';
              const badge = source === 'branch'
                ? { label: 'Branch',  bg: '#fff7ed', color: '#c2410c', border: '#fdba74' }
                : source === 'hq_grn'
                ? { label: 'HQ GRN',  bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' }
                : { label: 'Transit', bg: '#f5f3ff', color: '#6d28d9', border: '#ddd6fe' };
              const isBranch = source === 'branch';
              const canEdit  = isBranch && st !== 'CONFIRMED';
              return (
              <tr key={e.id}>
                <td>
                  <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: badge.bg, color: badge.color, border: `1px solid ${badge.border}`, fontSize: 11, fontWeight: 700 }}>{badge.label}</span>
                </td>
                <td style={{ fontWeight: 600, color: '#2563eb', fontFamily: 'monospace', fontSize: 12 }}>{e.return_number}</td>
                <td>{formatDate(e.date)}</td>
                <td>{e.item_count} item{e.item_count !== 1 ? 's' : ''}</td>
                <td style={{ textAlign: 'right', fontFamily: 'monospace', color: '#dc2626', fontWeight: 600 }}>
                  {curSym}{parseFloat(e.total_value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td>
                  <span style={{ padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 700, background: stBg, color: stColor, border: `1px solid ${stBorder}` }}>
                    {st === 'CONFIRMED' ? 'Confirmed' : st === 'REJECTED' ? 'Rejected' : st === 'AUTO' ? 'Auto' : st === 'WRITE_OFF' ? 'Write-Off' : 'Pending HQ'}
                  </span>
                </td>
                <td style={{ color: '#9ca3af', fontSize: 13 }}>{e.notes || '—'}</td>
                <td>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => openView(e)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                      <FiEye size={13} /> View
                    </button>
                    {canEdit && hasPermission('SalesReturns:Edit') && (
                    <button onClick={() => openEdit(e)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                      <FiEdit2 size={13} /> Edit
                    </button>
                    )}
                    {canEdit && hasPermission('SalesReturns:Delete') && (
                    <button onClick={() => openDelete(e)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#fff1f2', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                      <FiTrash2 size={13} /> Delete
                    </button>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Create / Edit Modal ── */}
      {(modal === 'create' || modal === 'edit') && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 2000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '20px 16px', overflowY: 'auto' }}>
          <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 680, boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px', borderBottom: '1px solid #f1f5f9' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{modal === 'edit' ? 'Edit Damage Record' : 'Record Damage'}</h3>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>Return items from the sales floor back to the store</p>
              </div>
              <button onClick={closeModal} style={{ background: '#f1f5f9', border: 'none', borderRadius: 8, width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#6b7280' }}><FiX size={18} /></button>
            </div>

            <div style={{ padding: '20px 24px' }}>
              {error && <div style={{ background: '#fff1f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', color: '#dc2626', fontSize: 13, marginBottom: 16 }}>{error}</div>}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 14, marginBottom: 20 }}>
                <div>
                  <label style={lbl}>Date</label>
                  <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inp} />
                </div>
                <div ref={notesRef} style={{ position: 'relative' }}>
                  <label style={lbl}>Notes <span style={{ color: '#dc2626' }}>*</span></label>
                  <input
                    type="text"
                    value={notes}
                    onChange={e => { setNotes(e.target.value); setNotesOpen(true); }}
                    onFocus={() => setNotesOpen(true)}
                    placeholder="e.g. Returned from sales — re-processing"
                    style={{ ...inp, borderColor: !notes.trim() && error ? '#dc2626' : '#e5e7eb' }}
                    autoComplete="off"
                  />
                  {notesOpen && notesHistory.filter(n => !notes || n.toLowerCase().includes(notes.toLowerCase())).length > 0 && (
                    <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', zIndex: 200, maxHeight: 180, overflowY: 'auto' }}>
                      {notesHistory.filter(n => !notes || n.toLowerCase().includes(notes.toLowerCase())).map((n, i) => (
                        <div key={i}
                          onMouseDown={() => { setNotes(n); setNotesOpen(false); }}
                          style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f1f5f9' }}
                          onMouseEnter={e => e.currentTarget.style.background = '#f0f9ff'}
                          onMouseLeave={e => e.currentTarget.style.background = '#fff'}
                        >{n}</div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Items */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div>
                    <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#2563eb' }}>Items Returned</h4>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: '#9ca3af' }}>Products moving from Sales floor → Store</p>
                  </div>
                  <button onClick={addItem} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 7, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    <FiPlus size={13} /> Add Item
                  </button>
                </div>
                <div style={{ background: '#f0f9ff', borderRadius: 10, border: '1px solid #bae6fd', overflow: 'visible' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#e0f2fe' }}>
                        <th style={th}>Product</th>
                        <th style={th}>Sales Balance</th>
                        <th style={th}>Return Qty</th>
                        <th style={th}>Unit</th>
                        <th style={{ ...th, width: 40 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((row, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #bae6fd' }}>
                          <td style={td}>
                            <div className="srt-dropdown" style={{ position: 'relative' }}>
                              <input
                                type="text"
                                value={row.product_name || (search[i] !== undefined ? search[i] : '')}
                                onChange={e => {
                                  const v = e.target.value;
                                  setSearch(prev => { const a = [...prev]; a[i] = v; return a; });
                                  if (!v) updateItem(i, 'product_id', '');
                                  updateItem(i, 'product_name', v);
                                  setOpen(prev => { const a = [...prev]; a[i] = true; return a; });
                                }}
                                onFocus={() => setOpen(prev => { const a = [...prev]; a[i] = true; return a; })}
                                placeholder="Search product on sales floor..."
                                style={{ ...inp, minWidth: 180 }}
                              />
                              {open[i] && (
                                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.1)', zIndex: 100, maxHeight: 200, overflowY: 'auto' }}>
                                  {filteredProducts(row.product_name).length === 0
                                    ? <div style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 13 }}>No products with sales balance found.</div>
                                    : filteredProducts(row.product_name).map(p => (
                                      <div key={p.id} onMouseDown={() => selectProduct(i, p)}
                                        style={{ padding: '8px 14px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                                        onMouseEnter={e => e.currentTarget.style.background = '#f0f9ff'}
                                        onMouseLeave={e => e.currentTarget.style.background = '#fff'}
                                      >
                                        <span style={{ fontWeight: 500 }}>{p.name}</span>
                                        <span style={{ color: '#0284c7', fontSize: 12, fontWeight: 600 }}>{(parseFloat(parseFloat(p.sales_balance || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {p.unit}</span>
                                      </div>
                                    ))
                                  }
                                </div>
                              )}
                            </div>
                          </td>
                          <td style={{ ...td, color: '#0284c7', fontWeight: 600, textAlign: 'center' }}>
                            {(parseFloat(parseFloat(row.sales_balance || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {row.unit}
                          </td>
                          <td style={td}>
                            <input type="number" min="0" step="1" value={row.quantity}
                              onChange={e => updateItem(i, 'quantity', e.target.value)}
                              placeholder="0"
                              style={{ ...inp, width: 90 }}
                            />
                          </td>
                          <td style={td}>
                            {(() => {
                              const prod = products.find(pp => pp.id === row.product_id);
                              const units = prod ? unitsForProductFE(prod) : [];
                              if (units.length > 1) {
                                return (
                                  <select
                                    value={row.unit || prod.unit}
                                    onChange={e => updateItem(i, 'unit', e.target.value)}
                                    style={{ ...inp, width: 120 }}
                                  >
                                    {units.map(u => (
                                      <option key={u.name} value={u.name}>
                                        {u.name}{u.is_base ? '' : ` (1=${u.conv})`}
                                      </option>
                                    ))}
                                  </select>
                                );
                              }
                              return <span style={{ color: '#6b7280', fontSize: 13 }}>{row.unit || prod?.unit || '—'}</span>;
                            })()}
                          </td>
                          <td style={td}>
                            {items.length > 1 && (
                              <button onClick={() => removeItem(i)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: 4 }}><FiX size={14} /></button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={closeModal} style={{ padding: '9px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
                <button onClick={handleSave} disabled={saving} style={{ padding: '9px 20px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
                  {saving ? 'Saving...' : modal === 'edit' ? 'Update Return' : 'Save Return'}
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── View Modal ── */}
      {modal === 'view' && selected && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)', borderRadius: '14px 14px 0 0', padding: '18px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)', fontWeight: 600, marginBottom: 3 }}>Sales Damage</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#fff' }}>{selected.return_number}</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>{formatDate(selected.date)}</div>
              </div>
              <button onClick={closeModal} style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 8, cursor: 'pointer', color: '#fff', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><FiX size={16} /></button>
            </div>
            <div style={{ padding: '18px 22px' }}>
              {selected.notes && <div style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#374151', marginBottom: 16 }}>{selected.notes}</div>}
              {!detail ? <div style={{ textAlign: 'center', padding: 20, color: '#9ca3af' }}>Loading...</div> : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      <th style={th}>Product</th>
                      <th style={{ ...th, textAlign: 'right' }}>Qty Returned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.items?.map((item, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={td}>{item.product_name}</td>
                        <td style={{ ...td, textAlign: 'right', fontWeight: 600, color: '#2563eb' }}>{(parseFloat(parseFloat(item.quantity))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {item.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, padding: '14px 22px', borderTop: '1px solid #f1f5f9', justifyContent: 'flex-end' }}>
              <button onClick={closeModal} style={{ padding: '9px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Close</button>
              {(selected?.source || 'branch') === 'branch' && (selected?.status || 'PENDING').toUpperCase() !== 'CONFIRMED' && hasPermission('SalesReturns:Edit') && (
              <button onClick={() => { closeModal(); openEdit(selected); }} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 20px', background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
                <FiEdit2 size={14} /> Edit
              </button>
              )}
            </div>
          </div>
        </div>
        </Portal>
      )}

      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={pendingDelete?.subject || ''}
        actionLabel={pendingDelete?.actionLabel || 'Confirm Delete'}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      {/* ── Print Preview ──────────────────────────────────────────── */}
      {false && showPrintPreview && (
        <div
          className="print-preview-overlay"
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.85)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}
        >
          {/* Toolbar */}
          <div
            className="no-print"
            style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 1001, borderBottom: '1px solid #1e293b' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={16} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>
                Print Preview — Sales Damages ({filteredEntries.length} records)
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                <FiPrinter size={14} /> Print
              </button>
              <button onClick={() => setShowPrintPreview(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}>
                <FiX size={14} /> Close
              </button>
            </div>
          </div>

          {/* A4 Document */}
          <div
            id="print-document"
            style={{ width: 794, background: '#ffffff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}
          >
            {/* Header Banner */}
            <div style={{ background: 'linear-gradient(135deg, #1e3a8a 0%, #0284c7 100%)', padding: '28px 44px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>
                  {businessInfo.business_name || 'Business Name'}
                </div>
                <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.7 }}>
                  {[businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  |  ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.65, marginBottom: 6 }}>Sales Damages</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  {filterFrom || filterTo
                    ? `${filterFrom ? formatDate(filterFrom) : 'All'} — ${filterTo ? formatDate(filterTo) : 'All'}`
                    : formatDate(todayStr)}
                </div>
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>

            {/* Accent bar */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #2563eb, #0284c7, #06b6d4)' }} />

            {/* Body */}
            <div style={{ padding: '26px 44px 36px' }}>

              {/* Summary chips */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Total Returns (All)', value: stats.total,            bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
                  { label: 'This Month',           value: stats.thisMonth,        bg: '#f0fdf4', color: '#15803d', border: '#86efac' },
                  { label: 'Filtered Returns',     value: filteredEntries.length, bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
                ].map(chip => (
                  <div key={chip.label} style={{ padding: '12px 16px', borderRadius: 10, background: chip.bg, border: `1.5px solid ${chip.border}`, textAlign: 'center' }}>
                    <div style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 600, marginBottom: 6 }}>{chip.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: chip.color }}>{chip.value}</div>
                  </div>
                ))}
              </div>

              {/* Returns Table */}
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                <div style={{ background: '#f8fafc', borderBottom: '1.5px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#0284c7', display: 'inline-block' }} />
                    <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#475569' }}>Return Records</span>
                  </div>
                  {(filterFrom || filterTo) && (
                    <span style={{ fontSize: 10.5, color: '#64748b' }}>
                      {filterFrom ? formatDate(filterFrom) : '—'}  to  {filterTo ? formatDate(filterTo) : '—'}
                    </span>
                  )}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['#', 'Return #', 'Date', 'Items', `Value (${curSym})`, 'Notes'].map((h) => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: h.startsWith('Value') ? 'right' : 'left', fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb', fontSize: 10.5, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.map((entry, idx) => {
                      const detail = printItemsMap[entry.id];
                      const retItems = detail?.items || [];
                      return (
                        <React.Fragment key={entry.id}>
                          <tr style={{ background: idx % 2 === 1 ? '#f0f9ff' : '#fff', borderTop: idx > 0 ? '2px solid #e2e8f0' : 'none' }}>
                            <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10.5 }}>{idx + 1}</td>
                            <td style={{ padding: '8px 12px', fontWeight: 700, fontFamily: 'monospace', fontSize: 11, color: '#1d4ed8' }}>{entry.return_number}</td>
                            <td style={{ padding: '8px 12px', color: '#374151' }}>{formatDate(entry.date)}</td>
                            <td style={{ padding: '8px 12px', color: '#374151' }}>{entry.item_count} item{entry.item_count !== 1 ? 's' : ''}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#dc2626' }}>{curSym}{parseFloat(entry.total_value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                            <td style={{ padding: '8px 12px', color: '#6b7280', fontSize: 10.5 }}>{entry.notes || '—'}</td>
                          </tr>
                          {retItems.length > 0 && (
                            <tr style={{ background: '#f8fafc' }}>
                              <td colSpan={6} style={{ padding: '0 12px 10px 32px' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10.5 }}>
                                  <thead>
                                    <tr style={{ background: '#e0f2fe' }}>
                                      <th style={{ padding: '5px 10px', textAlign: 'left',  color: '#0369a1', fontWeight: 600 }}>Product</th>
                                      <th style={{ padding: '5px 10px', textAlign: 'right', color: '#0369a1', fontWeight: 600 }}>Qty Damaged</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {retItems.map((item, i) => (
                                      <tr key={i} style={{ borderBottom: '1px solid #bae6fd' }}>
                                        <td style={{ padding: '5px 10px', color: '#111827', fontWeight: 500 }}>{item.product_name}</td>
                                        <td style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 600, color: '#0284c7', fontFamily: 'monospace' }}>{(parseFloat(parseFloat(item.quantity))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {item.unit}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f0f9ff', borderTop: '2px solid #bae6fd' }}>
                      <td colSpan={3} style={{ padding: '10px 12px', fontWeight: 700, fontSize: 11.5, color: '#0c4a6e' }}>
                        TOTAL — {filteredEntries.length} Damage{filteredEntries.length !== 1 ? 's' : ''}
                      </td>
                      <td style={{ padding: '10px 12px', fontWeight: 700, color: '#374151' }}>
                        {filteredEntries.reduce((s, e) => s + parseInt(e.item_count || 0), 0)} items
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#dc2626' }}>
                        {curSym}{filteredEntries.reduce((s, e) => s + parseFloat(e.total_value || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Footer */}
              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>{businessInfo.business_name || 'Business'} — Confidential</span>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Print styles ──────────────────────────────────────────── */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          .print-preview-overlay {
            position: fixed !important;
            top: 0 !important; left: 0 !important;
            right: 0 !important; bottom: 0 !important;
            background: #fff !important;
            padding: 0 !important;
            overflow: visible !important;
            display: block !important;
          }
          #print-document {
            box-shadow: none !important;
            width: 100% !important;
            margin: 0 !important;
          }
        }
      `}</style>
      <Toast message={toast?.msg} type={toast?.type} onClose={() => setToast(null)} />
    </div>
  );
};

export default SalesReturn;
