import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getSIVs, getSIVStats, getSIVItemsSummary, createSIV, updateSIV, getSIV, deleteSIV, getSIVItemBreakdown, getProducts, getSettings, getSIVNotes, getSIVRecentProducts, getCategories, getMainCategories } from '../services/api';
import CategoryFilter from '../components/CategoryFilter';
import { unitsForProduct as unitsForProductFE } from '../utils/productUnits';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { FiPlus, FiFileText, FiCalendar, FiTrendingDown, FiClock, FiTrash2, FiX, FiPrinter, FiEye, FiEdit2, FiUpload, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { matchTokens } from '../utils/tokenSearch';

const defaultStats = { totalSIVs: 0, thisMonth: 0, totalValue: 0, pending: 0 };
const emptyItem = () => ({ product_id: '', product_text: '', quantity: '', unit_price: '', total_price: 0, unit: '' });

const DEFAULT_DEPARTMENTS = ['SALES DEPARTMENT', 'PRODUCTION', 'KITCHEN', 'MANAGEMENT', 'DELIVERY'];
const todayStr = new Date().toISOString().split('T')[0];
const firstOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0];

const SIV = () => {
  const { t } = useLanguage();
  const { hasPermission, user: authUser } = useAuth();
  const { symbol: curSym } = useCurrency();
  const [stats, setStats]     = useState(defaultStats);
  const [sivs, setSIVs]       = useState([]);
  const [products, setProducts] = useState([]);
  const [businessInfo, setBusinessInfo] = useState({});

  // ── Form state ────────────────────────────────────────────────────
  const [showForm, setShowForm]   = useState(false);
  const [editMode, setEditMode]   = useState(false);
  const [editId, setEditId]       = useState(null);
  const [editLoading, setEditLoading] = useState(false);
  // True when editing an auto-SIV (source_grn_sync_id present). Items are read-only
  // in that case so a re-save can update date/notes without desyncing from the GRN.
  const [editIsAuto, setEditIsAuto] = useState(false);
  const [saving, setSaving]       = useState(false);
  const [formError, setFormError] = useState('');
  const [department, setDepartment] = useState('SALES DEPARTMENT');
  const [date, setDate]           = useState(todayStr);
  const [notes, setNotes]         = useState('');
  const [items, setItems]         = useState([emptyItem()]);
  const [notesHistory, setNotesHistory] = useState([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const notesRef = useRef(null);
  const [recentProducts, setRecentProducts] = useState([]);

  // ── Product autocomplete ──────────────────────────────────────────
  const [openDropdownIdx, setOpenDropdownIdx] = useState(-1);
  const [highlightedIdx, setHighlightedIdx] = useState(-1);

  // ── CSV import ────────────────────────────────────────────────────
  const csvInputRef = useRef(null);
  const importCSV = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const lines = ev.target.result.split('\n').filter(l => l.trim());
      const header = lines[0].toLowerCase();
      const nameIdx = header.split(',').findIndex(h => h.trim().includes('name'));
      const qtyIdx  = header.split(',').findIndex(h => /q.*t/i.test(h.trim().replace(/\s/g, '')));
      if (nameIdx === -1) return;
      const newItems = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        const csvName = (cols[nameIdx] || '').trim();
        const qty = qtyIdx >= 0 ? (cols[qtyIdx] || '').trim() : '';
        if (!csvName) continue;
        const match = products.find(p => p.name.trim().toLowerCase() === csvName.toLowerCase());
        if (!match) continue;
        newItems.push({
          product_id: match.id,
          product_text: match.name,
          quantity: qty || '',
          unit_price: match.selling_price || '',
          total_price: qty && match.selling_price ? parseFloat(qty) * parseFloat(match.selling_price) : 0,
          unit: match.unit || '',
        });
      }
      if (newItems.length > 0) setItems(newItems);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // ── Department management ─────────────────────────────────────────
  const [departments, setDepartments]     = useState(DEFAULT_DEPARTMENTS);
  const [showAddDept, setShowAddDept]     = useState(false);
  const [newDeptName, setNewDeptName]     = useState('');

  // ── View / Print state ────────────────────────────────────────────
  const [viewSIV, setViewSIV]           = useState(null);
  const [viewLoading, setViewLoading]   = useState(false);
  const [showSIVPrint, setShowSIVPrint] = useState(false);
  const [showPrintPreview, setShowPrintPreview] = useState(false);
  const [printItemsMap, setPrintItemsMap]       = useState({});
  const [printItemsLoading, setPrintItemsLoading] = useState(false);

  // Mobile: lock .page-content scroll while any modal is open + restore on close.
  useModalScrollLock(!!viewSIV || showForm);

  // ── View mode ─────────────────────────────────────────────────────
  const [viewMode, setViewMode] = useState('by-siv'); // 'by-siv' | 'by-item'
  const [itemsSummary, setItemsSummary] = useState([]);
  // Category filter (for by-item view)
  const [allCats, setAllCats] = useState([]);
  const [allMains, setAllMains] = useState([]);
  const [selMainIds, setSelMainIds] = useState(null);
  const [selCatIds, setSelCatIds] = useState(null);
  const [expandedItems, setExpandedItems] = useState({});   // product_id → true/false
  const [itemBreakdowns, setItemBreakdowns] = useState({}); // product_id → rows

  const [toast, setToast] = useState(null);
  const [scanMsg, setScanMsg] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // ── Delete SIV ────────────────────────────────────────────────────
  const [deletingSIV, setDeletingSIV] = useState(false);

  // ── Date filter ───────────────────────────────────────────────────
  const [filterFrom, setFilterFrom] = useState(todayStr);
  const [filterTo,   setFilterTo]   = useState(todayStr);

  const fetchData = async () => {
    try {
      const [statsRes, sivsRes] = await Promise.all([getSIVStats(), getSIVs()]);
      if (statsRes.data) setStats(statsRes.data);
      setSIVs(sivsRes.data || []);
      // Deep-link: if the URL has ?ref=SIV-..., auto-open the matching SIV.
      // Triggered from Sales Bin Card so users can click an SIV reference and
      // land directly on its view modal. Strips the param after consuming it.
      const params = new URLSearchParams(window.location.search);
      const ref = params.get('ref');
      if (ref) {
        const match = (sivsRes.data || []).find(s => String(s.siv_number) === ref);
        if (match) openView(match);
        // Clean the query param so refresh doesn't keep re-opening it.
        const url = new URL(window.location.href);
        url.searchParams.delete('ref');
        window.history.replaceState({}, '', url.toString());
      }
    } catch (err) {}
  };

  useEffect(() => {
    fetchData();
    getProducts().then(r => { if (r.data?.length > 0) setProducts(r.data.filter(p => p.product_type !== 'raw_material' && (p.status || 'Active') === 'Active')); }).catch(() => {});
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
    getSIVNotes().then(r => setNotesHistory(r.data || [])).catch(() => {});
    getSIVRecentProducts().then(r => setRecentProducts(r.data || [])).catch(() => {});
    getCategories().then(r => setAllCats(r.data || [])).catch(() => {});
    getMainCategories().then(r => setAllMains(r.data || [])).catch(() => {});
    const handler = (e) => {
      if (notesRef.current && !notesRef.current.contains(e.target)) setNotesOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (viewMode === 'by-item') {
      setExpandedItems({});
      setItemBreakdowns({});
      getSIVItemsSummary(filterFrom, filterTo)
        .then(r => setItemsSummary(r.data || []))
        .catch(() => setItemsSummary([]));
    }
  }, [viewMode, filterFrom, filterTo]);

  // ── Barcode scanner ───────────────────────────────────────────────
  const scannerBuffer = useRef('');
  const scannerTimer  = useRef(null);
  const productsRef   = useRef([]);
  const showFormRef   = useRef(false);
  const itemsRef      = useRef([]);
  useEffect(() => { productsRef.current = products; }, [products]);
  useEffect(() => { showFormRef.current = showForm; }, [showForm]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const handleScannerKey = useCallback((e) => {
    if (!showFormRef.current) return;
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'Enter') {
      const code = scannerBuffer.current.trim();
      scannerBuffer.current = '';
      clearTimeout(scannerTimer.current);
      if (!code) return;
      const found = productsRef.current.find(p => p.code && p.code.toLowerCase() === code.toLowerCase());
      if (found) {
        const pickedUnit = found.default_unit || found.unit || '';
        const fUnits = unitsForProductFE(found);
        const conv = parseFloat((fUnits.find(u => u.name === pickedUnit) || fUnits.find(u => u.is_base) || { conv: 1 }).conv || 1);
        const newRow = { product_id: String(found.id), product_text: found.name, quantity: '', unit_price: (parseFloat(found.selling_price || 0) * conv).toFixed(2), total_price: 0, unit: pickedUnit };
        const last = itemsRef.current[itemsRef.current.length - 1];
        if (last && last.product_id === '') {
          setItems(prev => prev.map((item, i) => i === prev.length - 1 ? newRow : item));
        } else {
          setItems(prev => [...prev, newRow]);
        }
        setScanMsg({ text: `Added: ${found.name}`, type: 'success' });
        setTimeout(() => setScanMsg(null), 3000);
      } else {
        setScanMsg({ text: `No product found for code: ${code}`, type: 'error' });
        setTimeout(() => setScanMsg(null), 3000);
      }
    } else if (e.key.length === 1) {
      scannerBuffer.current += e.key;
      clearTimeout(scannerTimer.current);
      scannerTimer.current = setTimeout(() => { scannerBuffer.current = ''; }, 300);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleScannerKey);
    return () => window.removeEventListener('keydown', handleScannerKey);
  }, [handleScannerKey]);

  // ── Filtered list ─────────────────────────────────────────────────
  const filteredSIVs = sivs.filter(siv => {
    const d = (siv.date || '').split('T')[0];
    if (filterFrom && d < filterFrom) return false;
    if (filterTo   && d > filterTo)   return false;
    return true;
  });
  const filteredTotal = filteredSIVs.reduce((s, v) => s + parseFloat(v.total_value || 0), 0);
  const hasFilter = filterFrom || filterTo;

  // ── Formatters ────────────────────────────────────────────────────
  const formatDate = (d) => {
    const str = (d || '').split('T')[0];
    if (!str) return '—';
    return new Date(str + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };
  const formatDateLong = (d) =>
    new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // ── Form helpers ──────────────────────────────────────────────────
  const resetForm = () => {
    setEditMode(false); setEditId(null); setEditIsAuto(false);
    setDepartment('SALES DEPARTMENT'); setDate(todayStr);
    setNotes(''); setItems([emptyItem()]); setFormError('');
    setOpenDropdownIdx(-1); setShowAddDept(false); setNewDeptName('');
  };

  const openForm = () => { resetForm(); setShowForm(true); };

  const openEdit = async (siv) => {
    setEditLoading(true);
    setFormError('');
    try {
      const res = await getSIV(siv.id);
      const s = res.data;
      setEditMode(true);
      setEditId(s.id);
      setEditIsAuto(!!s.source_grn_sync_id);
      setDepartment(s.department || 'SALES DEPARTMENT');
      setDate((s.date || todayStr).split('T')[0]);
      setNotes(s.notes || '');
      setItems(
        (s.items || []).length > 0
          ? s.items.map(i => ({
              product_id:   String(i.product_id),
              product_text: i.product_name || '',
              quantity:     String(i.quantity),
              unit_price:   String(i.unit_price),
              total_price:  parseFloat(i.total_price || 0),
              unit:         i.unit || i.product_unit || '',
            }))
          : [emptyItem()]
      );
      setOpenDropdownIdx(-1); setShowAddDept(false); setNewDeptName('');
      setShowForm(true);
    } catch {
      alert('Failed to load SIV details.');
    } finally {
      setEditLoading(false);
    }
  };

  const openView = async (siv) => {
    setViewLoading(true);
    try {
      const res = await getSIV(siv.id);
      setViewSIV(res.data);
    } catch {
      alert('Failed to load SIV details.');
    } finally {
      setViewLoading(false);
    }
  };

  const updateItem = (index, field, value) => {
    setItems(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      if (field === 'product_id') {
        const product = products.find(p => String(p.id) === String(value));
        if (product) updated[index].unit_price = parseFloat(product.selling_price || 0).toFixed(2);
      }
      const qty   = parseFloat(updated[index].quantity) || 0;
      const price = parseFloat(updated[index].unit_price) || 0;
      updated[index].total_price = qty * price;
      return updated;
    });
  };

  const selectProduct = (index, product) => {
    setItems(prev => {
      const updated = [...prev];
      const qty = parseFloat(updated[index].quantity) || 0;
      // Honour the product's default_unit (else fall back to base). Scale selling price by the unit's conversion factor.
      const pickedUnit = product.default_unit || product.unit || '';
      const pUnits = unitsForProductFE(product);
      const conv = parseFloat((pUnits.find(u => u.name === pickedUnit) || pUnits.find(u => u.is_base) || { conv: 1 }).conv || 1);
      const baseSell = parseFloat(product.selling_price || 0);
      const price = baseSell * conv;
      updated[index] = {
        ...updated[index],
        product_id:   String(product.id),
        product_text: product.name,
        unit_price:   price.toFixed(2),
        total_price:  qty * price,
        unit:         pickedUnit,
      };
      return updated;
    });
    setOpenDropdownIdx(-1);
  };

  const addItem    = () => setItems(prev => [...prev, emptyItem()]);
  const removeItem = (index) => setItems(prev => prev.filter((_, i) => i !== index));
  const grandTotal = items.reduce((sum, item) => sum + (parseFloat(item.total_price) || 0), 0);

  const handleSave = async () => {
    setFormError('');
    if (!department.trim()) { setFormError('Department is required.'); return; }
    const validItems = items.filter(i => i.product_id && parseFloat(i.quantity) > 0);
    if (validItems.length === 0) { setFormError('Add at least one item with a product and quantity.'); return; }
    const payload = {
      department: department.trim(), date, notes,
      items: validItems.map(i => ({
        product_id: parseInt(i.product_id),
        quantity:   parseFloat(i.quantity),
        unit_price: parseFloat(i.unit_price) || 0,
        unit:       i.unit || null,
      })),
    };
    if (editMode) {
      if (!window.confirm('Are you sure you want to update this record?')) return;
    }
    setSaving(true);
    try {
      if (editMode) {
        await updateSIV(editId, payload);
        setShowForm(false);
        await fetchData();
        showToast('SIV updated successfully.');
      } else {
        await createSIV(payload);
        setShowForm(false);
        await fetchData();
        showToast('SIV saved successfully.');
      }
    } catch (err) {
      setFormError(err.response?.data?.error || 'Failed to save SIV. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDeleteSIV = () => {
    if (!viewSIV) return;
    const s = viewSIV;
    setPendingDelete({
      subject: `SIV ${s.siv_number} — all stock movements will be reversed`,
      perform: async () => {
        setDeletingSIV(true);
        try {
          await deleteSIV(s.id);
          setViewSIV(null);
          await fetchData();
          if (viewMode === 'by-item') {
            getSIVItemsSummary(filterFrom, filterTo).then(r => setItemsSummary(r.data || [])).catch(() => {});
          }
          showToast('SIV deleted.', 'error');
        } catch (err) {
          alert(err.response?.data?.error || 'Failed to delete SIV.');
        } finally {
          setDeletingSIV(false);
        }
      },
    });
  };

  const toggleItemExpand = async (productId) => {
    setExpandedItems(prev => {
      const next = { ...prev, [productId]: !prev[productId] };
      return next;
    });
    if (!itemBreakdowns[productId]) {
      try {
        const res = await getSIVItemBreakdown(productId, filterFrom, filterTo);
        setItemBreakdowns(prev => ({ ...prev, [productId]: res.data || [] }));
      } catch { setItemBreakdowns(prev => ({ ...prev, [productId]: [] })); }
    }
  };

  const printSingleSIV = (siv) => {
    const fmt = v => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
    const bizName = businessInfo.business_name || 'Business Name';
    const bizSub  = [businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  ·  ');
    const printedAt = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const preparedBy = siv.created_by_name || '—';

    const itemRows = (siv.items || []).map((item, idx) => `
      <tr style="border-bottom:1px solid #f1f5f9;background:${idx%2===1?'#fafafa':'#fff'}">
        <td style="padding:10px 14px;color:#9ca3af;font-size:10px">${idx+1}</td>
        <td style="padding:10px 14px;font-weight:600;color:#111827">${item.product_name}${item.unit?` <span style="font-size:10px;color:#6b7280">(${item.unit})</span>`:''}</td>
        <td style="padding:10px 14px;text-align:right;font-family:monospace;color:#374151">${fmt(item.quantity)}</td>
        <td style="padding:10px 14px;text-align:right;font-family:monospace;color:#374151">${fmt(item.unit_price)}</td>
        <td style="padding:10px 14px;text-align:right;font-weight:700;font-family:monospace;color:#1d4ed8">${fmt(item.total_price)}</td>
      </tr>`).join('');

    const notesHtml = siv.notes ? `
      <div style="padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:11px;color:#78350f;margin-bottom:24px">
        <span style="font-weight:700;text-transform:uppercase;font-size:9px;letter-spacing:0.8px;margin-right:8px;color:#92400e">Notes</span>${siv.notes}
      </div>` : '';

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:14mm}
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      .sig-line{height:40px;border-bottom:1.5px solid #000;margin-bottom:6px}
      .sig-lbl{font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#000;text-align:center}
      .sig-sub{font-size:9px;color:#000;margin-top:2px;text-align:center}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:8px;letter-spacing:3px;text-transform:uppercase;color:#000;margin-bottom:6px">Store Issue Voucher</div>
          <div style="font-size:22px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${bizName}</div>
          <div style="font-size:10px;color:#000">${bizSub}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#000;margin-bottom:6px">Document No.</div>
          <div style="font-size:22px;font-weight:900;letter-spacing:1px;font-family:monospace">${siv.siv_number}</div>
          <div style="margin-top:8px;display:inline-block;padding:3px 12px;border:1.5px solid #000;font-size:10px;font-weight:700">${siv.status||'Issued'}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px">
        ${[['Department', siv.department],['Issue Date', formatDate(siv.date)],['Total Lines', siv.total_items+' line'+(siv.total_items!==1?'s':'')]].map(([lbl,val])=>`
          <div style="padding:10px 14px;border:1.5px solid #000">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px;color:#000">${lbl}</div>
            <div style="font-size:13px;font-weight:700">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:20px">
        <div style="background:#000;padding:8px 14px">
          <span style="font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#fff">Items Issued</span>
        </div>
        <table>
          <thead><tr style="background:#f0f0f0;border-bottom:1.5px solid #000">
            <th style="padding:8px 12px;text-align:left;font-weight:700;color:#000;font-size:10px;width:30px">#</th>
            <th style="padding:8px 12px;text-align:left;font-weight:700;color:#000;font-size:10px">Product</th>
            <th style="padding:8px 12px;text-align:right;font-weight:700;color:#000;font-size:10px">Quantity</th>
            <th style="padding:8px 12px;text-align:right;font-weight:700;color:#000;font-size:10px">Unit Price</th>
            <th style="padding:8px 12px;text-align:right;font-weight:700;color:#000;font-size:10px">Line Total</th>
          </tr></thead>
          <tbody>${(siv.items||[]).map((item,idx)=>`
            <tr style="border-bottom:1px solid #ddd;background:${idx%2===1?'#f9f9f9':'#fff'}">
              <td style="padding:9px 12px;color:#000;font-size:10px">${idx+1}</td>
              <td style="padding:9px 12px;font-weight:600">${item.product_name}${item.unit?` <span style="font-size:10px;color:#000">(${item.unit})</span>`:''}</td>
              <td style="padding:9px 12px;text-align:right;font-family:monospace">${fmt(item.quantity)}</td>
              <td style="padding:9px 12px;text-align:right;font-family:monospace">${fmt(item.unit_price)}</td>
              <td style="padding:9px 12px;text-align:right;font-weight:700;font-family:monospace">${fmt(item.total_price)}</td>
            </tr>`).join('')}</tbody>
          <tfoot><tr style="background:#f0f0f0;border-top:2px solid #000">
            <td colspan="4" style="padding:11px 12px;font-weight:800;font-size:12px;letter-spacing:0.5px">GRAND TOTAL</td>
            <td style="padding:11px 12px;text-align:right;font-weight:900;font-size:16px;font-family:monospace">$${fmt(siv.total_value)}</td>
          </tr></tfoot>
        </table>
      </div>
      ${siv.notes?`<div style="padding:10px 14px;border:1.5px solid #000;margin-bottom:20px;font-size:11px"><span style="font-weight:700;text-transform:uppercase;font-size:9px;letter-spacing:0.8px;margin-right:8px">Notes:</span>${siv.notes}</div>`:''}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:44px">
        ${[['Prepared By', preparedBy],['Checked By',''],['Printed By', printedBy]].map(([label,name])=>`
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div class="sig-line"></div>
            <div class="sig-sub">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;margin-top:20px;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px;color:#000">${bizName} — Confidential Document</span>
        <span style="font-size:9px;color:#000">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  const openPrintPreview = async () => {
    setPrintItemsLoading(true);
    let map = {};
    try {
      const results = await Promise.all(filteredSIVs.map(s => getSIV(s.id)));
      results.forEach(res => { if (res?.data?.id) map[res.data.id] = res.data.items || []; });
    } catch (e) {}
    setPrintItemsLoading(false);

    const fmt = v => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
    const bizName = businessInfo.business_name || 'Business Name';
    const bizSub  = [businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  ·  ');
    const printedBy2 = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const dateLabel = (filterFrom && filterTo && filterFrom !== filterTo)
      ? `${formatDate(filterFrom)} — ${formatDate(filterTo)}`
      : filterFrom ? formatDate(filterFrom) : 'All Dates';
    const printedAt = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    const totalItems = filteredSIVs.reduce((s, v) => s + parseInt(v.total_items || 0), 0);

    const rows = filteredSIVs.map((siv, idx) => {
      const sivItems = map[siv.id] || [];
      const itemRows = sivItems.map((item, i) => `
        <tr style="border-bottom:1px solid #ddd;background:${i%2===1?'#f9f9f9':'#fff'}">
          <td style="padding:4px 10px;font-weight:500">${item.product_name}${item.unit?` <span style="font-size:9px;color:#000">(${item.unit})</span>`:''}</td>
          <td style="padding:4px 10px;text-align:right;font-family:monospace">${fmt(item.quantity)}</td>
          <td style="padding:4px 10px;text-align:right;font-family:monospace">${fmt(item.unit_price)}</td>
          <td style="padding:4px 10px;text-align:right;font-weight:600;font-family:monospace">${fmt(item.total_price)}</td>
        </tr>`).join('');
      const itemsTable = sivItems.length > 0 ? `
        <tr style="background:#f5f5f5">
          <td colspan="7" style="padding:0 10px 8px 28px">
            <table style="width:100%;border-collapse:collapse;font-size:10px">
              <thead><tr style="background:#e8e8e8;border-bottom:1px solid #bbb">
                <th style="padding:4px 10px;text-align:left;font-weight:600;color:#000">Product</th>
                <th style="padding:4px 10px;text-align:right;font-weight:600;color:#000">Qty</th>
                <th style="padding:4px 10px;text-align:right;font-weight:600;color:#000">Unit Price</th>
                <th style="padding:4px 10px;text-align:right;font-weight:600;color:#000">Total</th>
              </tr></thead>
              <tbody>${itemRows}</tbody>
            </table>
          </td>
        </tr>` : '';
      return `
        <tr style="background:${idx%2===1?'#f5f5f5':'#fff'};border-top:${idx>0?'2px solid #ccc':'none'}">
          <td style="padding:8px 10px;color:#000;font-size:10px">${idx+1}</td>
          <td style="padding:8px 10px;font-weight:700;font-family:monospace">${siv.siv_number}</td>
          <td style="padding:8px 10px">${formatDate(siv.date)}</td>
          <td style="padding:8px 10px;font-weight:500">${siv.department}</td>
          <td style="padding:8px 10px;text-align:right">${siv.total_items}</td>
          <td style="padding:8px 10px;text-align:right;font-weight:700;font-family:monospace">$${fmt(siv.total_value)}</td>
          <td style="padding:8px 10px;text-align:right"><span style="padding:2px 8px;border:1px solid #000;font-size:10px;font-weight:600">${siv.status}</span></td>
        </tr>${itemsTable}`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:14mm}
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:11.5px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:8px 10px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10.5px;background:#f0f0f0;text-align:left}
      td{font-size:11px}
      tfoot td{padding:10px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:20px;font-weight:800;letter-spacing:0.3px;margin-bottom:3px">${bizName}</div>
          <div style="font-size:10px;color:#000">${bizSub}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#000;margin-bottom:4px">Store Issue Vouchers</div>
          <div style="font-size:14px;font-weight:700">${dateLabel}</div>
          <div style="font-size:9px;color:#000;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        ${[['Period From',formatDate(filterFrom)],['Period To',formatDate(filterTo)],['SIVs in Period',filteredSIVs.length],['Total Value','$'+fmt(filteredTotal)]].map(([lbl,val])=>`
          <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px;color:#000">${lbl}</div>
            <div style="font-size:14px;font-weight:800">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:16px">
        <table>
          <thead><tr>
            <th style="width:28px">#</th>
            <th>SIV Number</th>
            <th>Date</th>
            <th>Department</th>
            <th style="text-align:right">Items</th>
            <th style="text-align:right">Total Value</th>
            <th style="text-align:right">Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>
            <td colspan="4">TOTAL — ${filteredSIVs.length} SIV${filteredSIVs.length!==1?'s':''}</td>
            <td style="text-align:right">${totalItems} items</td>
            <td style="text-align:right;font-size:13px;font-family:monospace">$${fmt(filteredTotal)}</td>
            <td></td>
          </tr></tfoot>
        </table>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:32px;margin-bottom:16px">
        ${[['Prepared By',''],['Checked By',''],['Printed By',printedBy2]].map(([label,name])=>`
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px;color:#000">${bizName} — Confidential</span>
        <span style="font-size:9px;color:#000">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  return (
    <div className="page-content">

      {/* ── Page Header ──────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1>{t('sivTitle')}</h1>
          <p>{t('sivSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={openPrintPreview}
            disabled={printItemsLoading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '9px 18px', borderRadius: 8, border: '1.5px solid #e5e7eb',
              background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500, color: '#374151',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#6b7280'; e.currentTarget.style.background = '#f9fafb'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = '#fff'; }}
          >
            <FiPrinter size={16} /> {t('print')}
          </button>
          {/* In single-location mode, GRN auto-creates the matching SIV.
              Hide the manual + New SIV button so the workflow stays consistent. */}
          {hasPermission('SIV:Add') && !businessInfo.single_location_mode && (
            <button className="btn btn-primary" onClick={openForm}><FiPlus /> {t('newSIV')}</button>
          )}
        </div>
      </div>

      {/* ── Summary Cards ────────────────────────────────────────── */}
      <div className="stat-cards">
        <div className="stat-card blue">
          <div className="stat-icon"><FiFileText /></div>
          <div><div className="stat-label">{t('totalSIVs')}</div><div className="stat-value">{hasPermission('SIV:View') ? stats.totalSIVs : 'N/A'}</div></div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon"><FiCalendar /></div>
          <div><div className="stat-label">{t('thisMonth')}</div><div className="stat-value">{hasPermission('SIV:View') ? stats.thisMonth : 'N/A'}</div></div>
        </div>
        <div className="stat-card red">
          <div className="stat-icon"><FiTrendingDown /></div>
          <div><div className="stat-label">{t('total')} {t('amount')}</div><div className="stat-value">{hasPermission('SIV:View') ? `${curSym}${parseFloat(stats.totalValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A'}</div></div>
        </div>
        <div className="stat-card orange">
          <div className="stat-icon"><FiClock /></div>
          <div><div className="stat-label">{t('pending')}</div><div className="stat-value">{hasPermission('SIV:View') ? stats.pending : 'N/A'}</div></div>
        </div>
      </div>

      {/* ── Date Filter Bar ───────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        padding: '12px 16px', background: '#f8fafc',
        border: '1px solid #e5e7eb', borderRadius: 10,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{t('filterByDate')}:</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('from')}</span>
          <input
            type="date" value={filterFrom} max={filterTo || todayStr}
            onChange={e => setFilterFrom(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('to')}</span>
          <input
            type="date" value={filterTo} min={filterFrom || undefined} max={todayStr}
            onChange={e => setFilterTo(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151' }}
          />
        </div>
        <button
          onClick={() => { setFilterFrom(todayStr); setFilterTo(todayStr); }}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' }}
        >
          {t('clear')}
        </button>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', borderRadius: 7, border: '1px solid #d1d5db', overflow: 'hidden' }}>
            {[{ key: 'by-siv', label: t('bySIVNo') }, { key: 'by-item', label: t('byItem') }].map(({ key, label }) => (
              <button key={key} onClick={() => setViewMode(key)} style={{
                padding: '5px 13px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: 'none',
                background: viewMode === key ? '#2563eb' : '#fff',
                color: viewMode === key ? '#fff' : '#6b7280',
              }}>{label}</button>
            ))}
          </div>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            {viewMode === 'by-siv'
              ? <>{filteredSIVs.length} SIV{filteredSIVs.length !== 1 ? 's' : ''}{hasFilter && <> &nbsp;·&nbsp; Total: <strong style={{ color: '#2563eb' }}>${filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></>}</>
              : (() => {
                const acid = selCatIds === null ? null : new Set(selCatIds.map(String));
                const fs = itemsSummary.filter(it => acid === null ? true : (it.category_id ? acid.has(String(it.category_id)) : false));
                return <>{fs.length} item{fs.length !== 1 ? 's' : ''} &nbsp;·&nbsp; Total: <strong style={{ color: '#2563eb' }}>${fs.reduce((s, r) => s + parseFloat(r.total_value || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></>;
              })()
            }
          </span>
        </div>
      </div>

      {/* ── SIV Table ─────────────────────────────────────────────── */}
      <div className="data-table-container">
        {viewMode === 'by-siv' ? (
          filteredSIVs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
              {hasFilter ? t('noSIVsInRange') : t('noData')}
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('sivNumber')}</th><th>{t('date')}</th><th>{t('department')}</th>
                  <th>{t('items')}</th><th>{t('totalAmount')}</th><th>{t('status')}</th><th></th>
                </tr>
              </thead>
              <tbody>
                {filteredSIVs.map(siv => (
                  <tr key={siv.id}>
                    <td style={{ fontWeight: 500 }}>
                      {siv.siv_number}
                      {siv.source_grn_sync_id && (
                        <span style={{ marginLeft: 6, padding: '1px 6px', background: '#dbeafe', color: '#1d4ed8', borderRadius: 8, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.3 }}>Auto</span>
                      )}
                    </td>
                    <td>{formatDate(siv.date)}</td>
                    <td>{siv.department}</td>
                    <td style={{ textAlign: 'center' }}>{siv.total_items}</td>
                    <td>{curSym}{parseFloat(siv.total_value || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                    <td>
                      <span className={`badge ${siv.status === 'Issued' ? 'badge-green' : 'badge-yellow'}`}>
                        {siv.status}
                      </span>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          onClick={() => openView(siv)}
                          disabled={viewLoading}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5,
                            padding: '5px 11px', borderRadius: 6, border: '1px solid #e5e7eb',
                            background: '#f9fafb', color: '#6b7280', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#f0fdf4'; e.currentTarget.style.color = '#16a34a'; e.currentTarget.style.borderColor = '#86efac'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.color = '#6b7280'; e.currentTarget.style.borderColor = '#e5e7eb'; }}
                        >
                          <FiEye size={12} /> View
                        </button>
                        {hasPermission('SIV:Edit') && !businessInfo.single_location_mode && <button
                          onClick={() => openEdit(siv)}
                          disabled={editLoading}
                          title={siv.source_grn_sync_id ? 'Edit auto-SIV — items locked to source GRN' : 'Edit SIV'}
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 30, height: 30, borderRadius: 6, border: '1px solid #e5e7eb',
                            background: '#f9fafb', color: '#6b7280', cursor: 'pointer',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#dbeafe'; e.currentTarget.style.color = '#2563eb'; e.currentTarget.style.borderColor = '#bfdbfe'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.color = '#6b7280'; e.currentTarget.style.borderColor = '#e5e7eb'; }}
                        >
                          <FiEdit2 size={13} />
                        </button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (() => {
          const activeCatIds = selCatIds === null ? null : new Set(selCatIds.map(String));
          const filteredSummary = itemsSummary.filter(it => {
            if (activeCatIds === null) return true;
            if (!it.category_id) return false;
            return activeCatIds.has(String(it.category_id));
          });
          // Subtotals by main
          const subMap = new Map();
          for (const it of filteredSummary) {
            const main = allMains.find(m => String(m.id) === String(it.main_category_id));
            const key = main ? main.id : '__unassigned__';
            const name = main ? main.name : 'Uncategorized';
            const color = main ? main.color : '#6b7280';
            if (!subMap.has(key)) subMap.set(key, { name, color, qty: 0, value: 0 });
            const e = subMap.get(key);
            e.qty += parseFloat(it.total_quantity || 0);
            e.value += parseFloat(it.total_value || 0);
          }
          const subs = Array.from(subMap.values()).sort((a, b) => b.value - a.value);

          return (
            <>
              <CategoryFilter
                categories={allCats}
                mainCategories={allMains}
                selectedMainIds={selMainIds}
                selectedCatIds={selCatIds}
                onChange={({ mainIds, catIds }) => { setSelMainIds(mainIds); setSelCatIds(catIds); }}
              />
              {subs.length > 1 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                  {subs.map(s => (
                    <div key={s.name} style={{
                      padding: '6px 12px', borderRadius: 8,
                      background: (s.color || '#6b7280') + '15',
                      border: `1px solid ${(s.color || '#6b7280')}40`, fontSize: 12,
                    }}>
                      <span style={{ color: s.color, fontWeight: 700 }}>{s.name}:</span>
                      <span style={{ marginLeft: 6, color: '#374151', fontWeight: 600 }}>
                        qty {(parseFloat(s.qty)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} · ${s.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {filteredSummary.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>No items issued for the selected categories.</div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Item Name</th><th>Unit</th>
                      <th style={{ textAlign: 'right' }}>Total Qty</th>
                      <th style={{ textAlign: 'right' }}>Total Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSummary.map((row, idx) => {
                  const isExpanded = !!expandedItems[row.product_id];
                  const breakdown = itemBreakdowns[row.product_id] || [];
                  return (
                    <React.Fragment key={row.product_id}>
                      <tr
                        onClick={() => toggleItemExpand(row.product_id)}
                        style={{ cursor: 'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background = '#f0f9ff'}
                        onMouseLeave={e => e.currentTarget.style.background = ''}
                      >
                        <td style={{ color: '#9ca3af', fontSize: 12 }}>{idx + 1}</td>
                        <td style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                          {isExpanded ? <FiChevronDown size={13} style={{ color: '#2563eb' }} /> : <FiChevronRight size={13} style={{ color: '#9ca3af' }} />}
                          {row.product_name}
                        </td>
                        <td style={{ color: '#6b7280' }}>{row.unit}</td>
                        <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{parseFloat(row.total_quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: '#2563eb', fontFamily: 'monospace' }}>${parseFloat(row.total_value).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={5} style={{ padding: 0, background: '#f8fafc' }}>
                            <div style={{ padding: '8px 24px 12px 40px' }}>
                              {breakdown.length === 0 ? (
                                <div style={{ fontSize: 12, color: '#9ca3af', padding: '4px 0' }}>No SIV records found.</div>
                              ) : (
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                  <thead>
                                    <tr style={{ color: '#6b7280' }}>
                                      <th style={{ textAlign: 'left', fontWeight: 600, padding: '3px 8px', borderBottom: '1px solid #e5e7eb' }}>SIV No</th>
                                      <th style={{ textAlign: 'left', fontWeight: 600, padding: '3px 8px', borderBottom: '1px solid #e5e7eb' }}>Date</th>
                                      <th style={{ textAlign: 'left', fontWeight: 600, padding: '3px 8px', borderBottom: '1px solid #e5e7eb' }}>Time</th>
                                      <th style={{ textAlign: 'right', fontWeight: 600, padding: '3px 8px', borderBottom: '1px solid #e5e7eb' }}>Qty</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {breakdown.map((b, i) => {
                                      const dt = new Date(b.created_at + 'Z');
                                      return (
                                        <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                          <td style={{ padding: '4px 8px', fontWeight: 500, color: '#1d4ed8' }}>{b.siv_number}</td>
                                          <td style={{ padding: '4px 8px', color: '#374151' }}>{new Date(b.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                                          <td style={{ padding: '4px 8px', color: '#374151' }}>{dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</td>
                                          <td style={{ padding: '4px 8px', textAlign: 'right', fontFamily: 'monospace', color: '#111827' }}>{parseFloat(b.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f0f9ff', fontWeight: 700, borderTop: '2px solid #93c5fd' }}>
                      <td colSpan={4} style={{ textAlign: 'right', color: '#1d4ed8' }}>TOTAL</td>
                      <td style={{ textAlign: 'right', color: '#1d4ed8', fontFamily: 'monospace' }}>
                        ${filteredSummary.reduce((s, r) => s + parseFloat(r.total_value || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </>
          );
        })()}
      </div>

      {/* ── View SIV Modal ────────────────────────────────────────── */}
      {viewSIV && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 680, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', margin: 'auto' }}>

            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)', borderRadius: '14px 14px 0 0', padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <FiFileText size={16} style={{ color: 'rgba(255,255,255,0.8)' }} />
                  <span style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)', fontWeight: 600 }}>Store Issue Voucher</span>
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', letterSpacing: 0.3 }}>{viewSIV.siv_number}</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 3 }}>
                  {formatDate(viewSIV.date)} &nbsp;·&nbsp; {viewSIV.department}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.35)' }}>
                  {viewSIV.status || 'Issued'}
                </span>
                <button
                  onClick={() => setViewSIV(null)}
                  style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 8, cursor: 'pointer', color: '#fff', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  <FiX size={16} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div style={{ padding: '24px 28px', flex: 1 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Department',  value: viewSIV.department },
                  { label: 'Date',        value: formatDate(viewSIV.date) },
                  { label: 'Total Items', value: viewSIV.total_items },
                ].map(info => (
                  <div key={info.label} style={{ padding: '10px 14px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                    <div style={{ fontSize: 10.5, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{info.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{info.value}</div>
                  </div>
                ))}
              </div>

              {/* Items table */}
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'visible', marginBottom: 20 }}>
                <div style={{ background: '#eff6ff', padding: '10px 14px', borderBottom: '1px solid #bfdbfe', fontSize: 11.5, fontWeight: 700, color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Items Issued
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      <th style={{ padding: '9px 14px', textAlign: 'left',  fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>#</th>
                      <th style={{ padding: '9px 14px', textAlign: 'left',  fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>Product</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>Quantity</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>Unit Price ($)</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>Total ($)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(viewSIV.items || []).map((item, idx) => (
                      <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                        <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 12 }}>{idx + 1}</td>
                        <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>
                          {item.product_name}
                          {item.unit && <span style={{ marginLeft: 6, fontSize: 11, color: '#6b7280', background: '#f3f4f6', padding: '1px 6px', borderRadius: 10 }}>{item.unit}</span>}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>{parseFloat(item.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>{parseFloat(item.unit_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#2563eb', fontFamily: 'monospace' }}>{parseFloat(item.total_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#eff6ff', borderTop: '2px solid #93c5fd' }}>
                      <td colSpan={4} style={{ padding: '10px 14px', fontWeight: 700, fontSize: 13, color: '#1d4ed8' }}>TOTAL</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 800, fontSize: 15, fontFamily: 'monospace', color: '#1d4ed8' }}>
                        {curSym}{parseFloat(viewSIV.total_value || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {viewSIV.notes && (
                <div style={{ padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 13, color: '#78350f' }}>
                  <span style={{ fontWeight: 600 }}>Notes: </span>{viewSIV.notes}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '14px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={() => printSingleSIV(viewSIV)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.borderColor = '#9ca3af'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = '#d1d5db'; }}
                >
                  <FiPrinter size={14} /> Print
                </button>
                {hasPermission('SIV:Delete') && !viewSIV.source_grn_sync_id && (
                  <button
                    onClick={handleDeleteSIV}
                    disabled={deletingSIV}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 8, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
                    onMouseEnter={e => { e.currentTarget.style.background = '#fef2f2'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
                  >
                    <FiTrash2 size={14} /> {deletingSIV ? 'Deleting...' : 'Delete'}
                  </button>
                )}
                {viewSIV.source_grn_sync_id && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', padding: '9px 12px', fontSize: 12, color: '#6b7280', fontStyle: 'italic' }}>
                    Auto-issued from GRN — delete the source GRN to remove this.
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                {hasPermission('SIV:Edit') && !businessInfo.single_location_mode && (
                  <button
                    onClick={() => { openEdit({ id: viewSIV.id }); setViewSIV(null); }}
                    title={viewSIV.source_grn_sync_id ? 'Edit auto-SIV — items locked to source GRN' : 'Edit SIV'}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
                  >
                    <FiEdit2 size={13} /> Edit
                  </button>
                )}
                <button
                  onClick={() => setViewSIV(null)}
                  style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── New / Edit SIV Modal ──────────────────────────────────── */}
      {showForm && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, overflowY: 'auto', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '20px 20px 40px' }}>
          <div className="modal" style={{ maxWidth: 980, width: '95%', overflow: 'visible', maxHeight: 'none', marginTop: 20 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {editMode && (
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: '#dbeafe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <FiEdit2 size={15} style={{ color: '#2563eb' }} />
                  </div>
                )}
                <div>
                  <h2 style={{ margin: 0 }}>{editMode ? 'Edit SIV' : t('sivTitle')}</h2>
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
                    {editMode ? 'Update the store issue voucher' : 'Record stock issued from store'}
                  </p>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input ref={csvInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={importCSV} />
                <button
                  type="button"
                  onClick={() => csvInputRef.current && csvInputRef.current.click()}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#16a34a', fontWeight: 600 }}
                >
                  <FiUpload size={14} /> Import CSV
                </button>
                <button className="modal-close" onClick={() => setShowForm(false)}><FiX /></button>
              </div>
            </div>

            <div className="modal-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
                <div className="form-group">
                  <label className="form-label">{t('department')} *</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <select
                      className="form-input"
                      style={{ flex: 1, margin: 0 }}
                      value={departments.includes(department) ? department : '__custom__'}
                      onChange={e => {
                        if (e.target.value !== '__custom__') setDepartment(e.target.value);
                      }}
                    >
                      {departments.map(d => <option key={d} value={d}>{d}</option>)}
                      {!departments.includes(department) && (
                        <option value="__custom__">{department} (custom)</option>
                      )}
                    </select>
                    <button
                      type="button"
                      onClick={() => { setShowAddDept(v => !v); setNewDeptName(''); }}
                      style={{ padding: '0 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: showAddDept ? '#dcfce7' : '#f9fafb', color: showAddDept ? '#16a34a' : '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}
                    >
                      <FiPlus size={13} /> New
                    </button>
                  </div>

                  {showAddDept && (
                    <div style={{ marginTop: 8, padding: '10px 12px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        value={newDeptName}
                        onChange={e => setNewDeptName(e.target.value)}
                        placeholder="New department name"
                        onKeyDown={e => {
                          if (e.key === 'Enter' && newDeptName.trim()) {
                            const name = newDeptName.trim().toUpperCase();
                            if (!departments.includes(name)) setDepartments(prev => [...prev, name]);
                            setDepartment(name);
                            setShowAddDept(false); setNewDeptName('');
                          }
                        }}
                        style={{ flex: 1, minWidth: 140, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (!newDeptName.trim()) return;
                          const name = newDeptName.trim().toUpperCase();
                          if (!departments.includes(name)) setDepartments(prev => [...prev, name]);
                          setDepartment(name);
                          setShowAddDept(false); setNewDeptName('');
                        }}
                        style={{ padding: '6px 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                      >
                        Add
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowAddDept(false); setNewDeptName(''); }}
                        style={{ padding: '6px 10px', background: '#fff', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label">{t('date')} *</label>
                  <input type="date" className="form-input" value={date} onChange={e => setDate(e.target.value)} />
                </div>
              </div>
              <div className="form-group" style={{ marginBottom: 20 }}>
                <label className="form-label">{t('notes')}</label>
                <div ref={notesRef} style={{ position: 'relative' }}>
                  <textarea
                    className="form-input" rows={2} value={notes}
                    onChange={e => { setNotes(e.target.value); setNotesOpen(true); }}
                    onFocus={() => setNotesOpen(true)}
                    placeholder="Optional notes..." style={{ resize: 'vertical' }}
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

              {/* Items Table */}
              <div style={{ marginBottom: 12 }}>
                {/* Barcode scan message */}
                {scanMsg && (
                  <div style={{ marginBottom: 8, padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: scanMsg.type === 'error' ? '#fee2e2' : '#dcfce7', color: scanMsg.type === 'error' ? '#dc2626' : '#16a34a', border: `1px solid ${scanMsg.type === 'error' ? '#fca5a5' : '#86efac'}` }}>
                    {scanMsg.type === 'error' ? '⚠ ' : '✓ '}{scanMsg.text}
                  </div>
                )}

                {recentProducts.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    <span style={{ fontSize: 11, color: '#9ca3af', alignSelf: 'center', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Recent:</span>
                    {recentProducts.map(p => (
                      <button key={p.product_id} type="button"
                        onClick={() => {
                          const last = items[items.length - 1];
                          const newRow = { product_id: String(p.product_id), product_text: p.product_name, quantity: '', unit_price: '', total_price: 0 };
                          if (last.product_id === '') {
                            setItems(prev => prev.map((item, i) => i === prev.length - 1 ? newRow : item));
                          } else {
                            setItems(prev => [...prev, newRow]);
                          }
                        }}
                        style={{ padding: '3px 10px', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontWeight: 500 }}
                      >{p.product_name}</button>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label className="form-label" style={{ margin: 0 }}>{t('product')}s *</label>
                  {!editIsAuto && (
                    <button
                      type="button" onClick={addItem}
                      style={{ padding: '6px 14px', borderRadius: 8, border: '1px solid #2563eb', background: '#eff6ff', color: '#2563eb', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
                    >
                      <FiPlus style={{ marginRight: 4, verticalAlign: 'middle' }} />Add Item
                    </button>
                  )}
                </div>
                {editIsAuto && (
                  <div style={{ marginBottom: 8, padding: '8px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 12, color: '#1e3a8a' }}>
                    Auto-SIV from GRN — items locked. You can change <strong>Date</strong> or <strong>Notes</strong>, and Save will refresh the linked stock movements.
                  </div>
                )}
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      <th style={{ padding: '8px 10px', textAlign: 'left',  border: '1px solid #e5e7eb', fontWeight: 600 }}>{t('product')}</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', border: '1px solid #e5e7eb', fontWeight: 600, width: 70 }}>{t('balance')}</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', border: '1px solid #e5e7eb', fontWeight: 600, width: 72 }}>{t('quantity')}</th>
                      <th style={{ padding: '8px 10px', textAlign: 'left',  border: '1px solid #e5e7eb', fontWeight: 600, width: 100 }}>Unit</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', border: '1px solid #e5e7eb', fontWeight: 600, width: 88 }}>Unit Price</th>
                      <th style={{ padding: '8px 10px', textAlign: 'right', border: '1px solid #e5e7eb', fontWeight: 600, width: 88 }}>{t('total')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, index) => {
                      const prod = products.find(pp => String(pp.id) === String(item.product_id));
                      // v1.7.4: convert balance via units_json (supports N packagings)
                      // instead of the legacy single-alt_unit fallback. Looks up the
                      // selected unit row and uses its conv; falls back to alt_unit
                      // for old items that have no units_json yet.
                      let remaining = null;
                      let displayUnit = '';
                      if (prod) {
                        const storeBase = parseFloat(prod.store_balance || 0);
                        const qty = parseFloat(item.quantity || 0);
                        let units = [];
                        try { units = JSON.parse(prod.units_json || '[]'); } catch { units = []; }
                        const selectedName = (item.unit || prod.unit || '').trim();
                        const selectedRow = units.find(u => (u.name || '').trim() === selectedName);
                        const legacyAlt = prod.alt_unit && selectedName === prod.alt_unit;
                        const conv = selectedRow
                          ? (parseFloat(selectedRow.conv) || 1)
                          : (legacyAlt ? (parseFloat(prod.conversion_factor) || 1) : 1);
                        const qtyBase = qty * conv;
                        const remainingBase = storeBase - qtyBase;
                        remaining = conv > 0 ? remainingBase / conv : remainingBase;
                        displayUnit = selectedName || prod.unit;
                      }
                      return (
                        <tr key={index}>
                          <td style={{ padding: '6px 8px', border: '1px solid #e5e7eb' }}>
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <div style={{ flex: 1, position: 'relative' }}>
                                <input
                                  value={item.product_text}
                                  readOnly={editIsAuto}
                                  onChange={e => {
                                    if (editIsAuto) return;
                                    setItems(prev => {
                                      const u = [...prev];
                                      u[index] = { ...u[index], product_text: e.target.value, product_id: '' };
                                      return u;
                                    });
                                    setOpenDropdownIdx(index);
                                    setHighlightedIdx(-1);
                                  }}
                                  onFocus={() => { if (editIsAuto) return; setOpenDropdownIdx(index); setHighlightedIdx(-1); }}
                                  onBlur={() => setTimeout(() => { setOpenDropdownIdx(-1); setHighlightedIdx(-1); }, 160)}
                                  onKeyDown={e => {
                                    const filtered = products.filter(p => matchTokens(items[index].product_text, p.name, p.code, p.barcode));
                                    if (e.key === 'ArrowDown') {
                                      e.preventDefault();
                                      setOpenDropdownIdx(index);
                                      setHighlightedIdx(prev => Math.min(prev + 1, filtered.length - 1));
                                    } else if (e.key === 'ArrowUp') {
                                      e.preventDefault();
                                      setHighlightedIdx(prev => Math.max(prev - 1, 0));
                                    } else if (e.key === 'Enter' && highlightedIdx >= 0 && filtered[highlightedIdx]) {
                                      e.preventDefault();
                                      selectProduct(index, filtered[highlightedIdx]);
                                      setHighlightedIdx(-1);
                                    } else if (e.key === 'Escape') {
                                      setOpenDropdownIdx(-1);
                                      setHighlightedIdx(-1);
                                    }
                                  }}
                                  placeholder="Type or search product…"
                                  style={{ width: '100%', padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }}
                                />
                                {openDropdownIdx === index && (
                                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999, background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, maxHeight: '40vh', overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.15)', marginTop: 2 }}>
                                    {products
                                      .filter(p => matchTokens(item.product_text, p.name, p.code, p.barcode))
                                      .map((p, pi) => (
                                        <div
                                          key={p.id}
                                          onMouseDown={() => selectProduct(index, p)}
                                          onMouseEnter={() => setHighlightedIdx(pi)}
                                          onMouseLeave={() => setHighlightedIdx(-1)}
                                          style={{ padding: '10px 14px', cursor: 'pointer', fontSize: 14, borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: highlightedIdx === pi ? '#eff6ff' : '#fff' }}
                                        >
                                          <span style={{ fontWeight: 500 }}>{p.name} <span style={{ fontSize: 12, color: '#9ca3af' }}>({p.unit})</span></span>
                                          <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 600 }}>${(parseFloat(parseFloat(p.selling_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                                        </div>
                                      ))
                                    }
                                    {products.filter(p => matchTokens(item.product_text, p.name, p.code, p.barcode)).length === 0 && (
                                      <div style={{ padding: '10px 12px', fontSize: 13, color: '#9ca3af' }}>No matching products</div>
                                    )}
                                  </div>
                                )}
                              </div>
                              {items.length > 1 && !editIsAuto && (
                                <button type="button" onClick={() => removeItem(index)}
                                  style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4, flexShrink: 0 }}>
                                  <FiTrash2 size={14} />
                                </button>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '6px 8px', border: '1px solid #e5e7eb', textAlign: 'right', fontWeight: 600, color: remaining !== null && remaining <= 0 ? '#dc2626' : '#16a34a' }}>
                            {remaining !== null ? `${remaining.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${displayUnit}` : '—'}
                          </td>
                          <td style={{ padding: '6px 8px', border: '1px solid #e5e7eb' }}>
                            <input type="number" className="form-input" style={{ margin: 0, padding: '6px 8px', fontSize: 13, textAlign: 'right', background: editIsAuto ? '#f3f4f6' : undefined }}
                              min="0" step="1" value={item.quantity} readOnly={editIsAuto}
                              onChange={e => { if (editIsAuto) return; updateItem(index, 'quantity', e.target.value); }} placeholder="0" />
                          </td>
                          <td style={{ padding: '6px 8px', border: '1px solid #e5e7eb' }}>
                            {(() => {
                              const units = prod ? unitsForProductFE(prod) : [];
                              if (!prod || units.length <= 1) {
                                return <div style={{ padding: '6px 8px', fontSize: 13, color: '#6b7280', background: '#f9fafb', borderRadius: 4 }}>{prod?.unit || '—'}</div>;
                              }
                              return (
                                <select
                                  value={item.unit || prod.unit}
                                  disabled={editIsAuto}
                                  onChange={e => {
                                    const newUnit = e.target.value;
                                    const u = units.find(x => x.name === newUnit) || units.find(x => x.is_base);
                                    const newPrice = parseFloat(u?.price || 0);
                                    setItems(prev => prev.map((it, i) => i === index ? { ...it, unit: newUnit, unit_price: newPrice.toFixed(2), total_price: (parseFloat(it.quantity) || 0) * newPrice } : it));
                                  }}
                                  style={{ width: '100%', padding: '6px 6px', fontSize: 13, border: '1px solid #d1d5db', borderRadius: 4, background: editIsAuto ? '#f3f4f6' : '#fff' }}
                                >
                                  {units.map(u => (
                                    <option key={u.name} value={u.name}>
                                      {u.name}{u.is_base ? '' : ` (1=${u.conv})`}
                                    </option>
                                  ))}
                                </select>
                              );
                            })()}
                          </td>
                          <td style={{ padding: '6px 8px', border: '1px solid #e5e7eb' }}>
                            <input type="number" className="form-input" style={{ margin: 0, padding: '6px 8px', fontSize: 13, textAlign: 'right' }}
                              min="0" step="0.01" value={item.unit_price}
                              onChange={e => updateItem(index, 'unit_price', e.target.value)} placeholder="0.00" />
                          </td>
                          <td style={{ padding: '6px 8px', border: '1px solid #e5e7eb', textAlign: 'right', fontWeight: 500 }}>
                            {curSym}{(parseFloat((parseFloat(item.total_price) || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f9fafb' }}>
                      <td colSpan={5} style={{ padding: '8px 10px', border: '1px solid #e5e7eb', textAlign: 'right', fontWeight: 600 }}>{t('total')}</td>
                      <td style={{ padding: '8px 10px', border: '1px solid #e5e7eb', textAlign: 'right', fontWeight: 700, color: '#2563eb' }}>
                        ${(parseFloat(grandTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {formError && (
                <div style={{ color: '#dc2626', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 14px', fontSize: 13 }}>
                  {formError}
                </div>
              )}
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowForm(false)} disabled={saving}>{t('cancel')}</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? t('saving') : editMode ? 'Update SIV' : `${t('save')} SIV`}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── List Print Preview — replaced by new-window print ── */}
      {false && showPrintPreview && (
        <div
          className="siv-print-overlay"
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.85)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}
        >
          <style>{`
            @media print {
              body * { visibility: hidden; }
              #siv-print-document { visibility: visible; position: absolute; top: 0; left: 0; width: 100%; margin: 0; box-shadow: none; overflow: visible !important; }
              #siv-print-document * { visibility: visible; overflow: visible !important; }
            }
          `}</style>
          <div
            className="no-print"
            style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 1001, borderBottom: '1px solid #1e293b' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={16} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>
                Print Preview — Store Issue Vouchers ({filteredSIVs.length} records)
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

          <div
            id="siv-print-document"
            style={{ width: 794, background: '#ffffff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}
          >
            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #2563eb 100%)', padding: '28px 44px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>
                  {businessInfo.business_name || 'Business Name'}
                </div>
                <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.7 }}>
                  {[businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  |  ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.65, marginBottom: 6 }}>Store Issue Vouchers</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  {hasFilter
                    ? `${filterFrom ? formatDate(filterFrom) : 'All'} — ${filterTo ? formatDate(filterTo) : 'All'}`
                    : formatDateLong(todayStr)}
                </div>
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #2563eb, #22c55e)' }} />

            <div style={{ padding: '26px 44px 36px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Period From',    value: formatDate(filterFrom),                                                              bg: '#f8fafc', color: '#374151',  border: '#e2e8f0' },
                  { label: 'Period To',      value: formatDate(filterTo),                                                                bg: '#f8fafc', color: '#374151',  border: '#e2e8f0' },
                  { label: 'SIVs in Period', value: filteredSIVs.length,                                                                 bg: '#eff6ff', color: '#1d4ed8',  border: '#bfdbfe' },
                  { label: 'Total Value',    value: '$' + filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 }),         bg: '#fff7ed', color: '#c2410c',  border: '#fed7aa' },
                ].map(chip => (
                  <div key={chip.label} style={{ padding: '12px 16px', borderRadius: 10, background: chip.bg, border: `1.5px solid ${chip.border}`, textAlign: 'center' }}>
                    <div style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 600, marginBottom: 6 }}>{chip.label}</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: chip.color }}>{chip.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ background: '#eff6ff' }}>
                      {['#', 'SIV Number', 'Date', 'Department', 'Items', 'Total Value', 'Status'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: i >= 4 ? 'right' : 'left', fontWeight: 600, color: '#1d4ed8', borderBottom: '1px solid #bfdbfe', fontSize: 10.5, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSIVs.map((siv, idx) => {
                      const sivItems = printItemsMap[siv.id] || [];
                      return (
                        <React.Fragment key={siv.id}>
                          <tr style={{ background: idx % 2 === 1 ? '#eff6ff' : '#fff', borderTop: idx > 0 ? '2px solid #e2e8f0' : 'none' }}>
                            <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10.5 }}>{idx + 1}</td>
                            <td style={{ padding: '8px 12px', fontWeight: 700, fontFamily: 'monospace', fontSize: 11, color: '#2563eb' }}>{siv.siv_number}</td>
                            <td style={{ padding: '8px 12px', color: '#374151' }}>{formatDate(siv.date)}</td>
                            <td style={{ padding: '8px 12px', fontWeight: 500 }}>{siv.department}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#374151' }}>{siv.total_items}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#1d4ed8' }}>
                              {curSym}{parseFloat(siv.total_value || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                              <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 10, fontWeight: 600,
                                background: siv.status === 'Issued' ? '#dcfce7' : '#fef9c3',
                                color: siv.status === 'Issued' ? '#166534' : '#854d0e' }}>
                                {siv.status}
                              </span>
                            </td>
                          </tr>
                          {sivItems.length > 0 && (
                            <tr style={{ background: '#f8fafc' }}>
                              <td colSpan={7} style={{ padding: '0 12px 10px 32px' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10.5 }}>
                                  <thead>
                                    <tr style={{ background: '#e2e8f0' }}>
                                      <th style={{ padding: '5px 10px', textAlign: 'left', color: '#475569', fontWeight: 600 }}>Product</th>
                                      <th style={{ padding: '5px 10px', textAlign: 'right', color: '#475569', fontWeight: 600 }}>Qty</th>
                                      <th style={{ padding: '5px 10px', textAlign: 'right', color: '#475569', fontWeight: 600 }}>Unit Price</th>
                                      <th style={{ padding: '5px 10px', textAlign: 'right', color: '#475569', fontWeight: 600 }}>Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sivItems.map((item, i) => (
                                      <tr key={i} style={{ borderBottom: '1px solid #e5e7eb' }}>
                                        <td style={{ padding: '5px 10px', color: '#111827', fontWeight: 500 }}>{item.product_name}{item.unit && <span style={{ marginLeft: 6, fontSize: 10, color: '#6b7280' }}>({item.unit})</span>}</td>
                                        <td style={{ padding: '5px 10px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>{parseFloat(item.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                        <td style={{ padding: '5px 10px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>{curSym}{parseFloat(item.unit_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                        <td style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 600, color: '#1d4ed8', fontFamily: 'monospace' }}>{curSym}{parseFloat(item.total_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
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
                    <tr style={{ background: '#eff6ff', borderTop: '2px solid #93c5fd' }}>
                      <td colSpan={4} style={{ padding: '10px 12px', fontWeight: 700, fontSize: 11.5, color: '#1d4ed8' }}>
                        TOTAL — {filteredSIVs.length} SIV{filteredSIVs.length !== 1 ? 's' : ''}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontSize: 11, color: '#374151' }}>
                        {filteredSIVs.reduce((s, v) => s + parseInt(v.total_items || 0), 0)} items
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13, fontFamily: 'monospace', color: '#1d4ed8' }}>
                        ${filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>{businessInfo.business_name || 'Business'} — Confidential</span>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Single SIV Print Preview — replaced by new-window print ── */}
      {false && viewSIV && showSIVPrint && (
        <div
          className="siv-print-overlay"
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.88)', zIndex: 2000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}
        >
          <div
            className="no-print"
            style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 2001, borderBottom: '1px solid #1e293b' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={15} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Print Preview — {viewSIV.siv_number}</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                <FiPrinter size={14} /> Print
              </button>
              <button onClick={() => setShowSIVPrint(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}>
                <FiX size={14} /> Close
              </button>
            </div>
          </div>

          <div
            id="siv-print-document"
            style={{ width: 794, background: '#fff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}
          >
            {/* Document header */}
            <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #1e40af 50%, #2563eb 100%)', padding: '30px 44px 24px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 8, letterSpacing: 3, textTransform: 'uppercase', opacity: 0.6, marginBottom: 8 }}>Store Issue Voucher</div>
                <div style={{ fontSize: 23, fontWeight: 800, letterSpacing: 0.3, marginBottom: 6 }}>
                  {businessInfo.business_name || 'Business Name'}
                </div>
                <div style={{ fontSize: 10.5, opacity: 0.7, lineHeight: 1.8 }}>
                  {[businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  ·  ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.55, marginBottom: 8 }}>Document No.</div>
                <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: 1, fontFamily: 'monospace' }}>{viewSIV.siv_number}</div>
                <div style={{ marginTop: 10, display: 'inline-block', padding: '3px 12px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                  background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.35)', color: '#fff' }}>
                  {viewSIV.status || 'Issued'}
                </div>
              </div>
            </div>
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #2563eb, #22c55e, #a855f7)' }} />

            <div style={{ padding: '28px 44px 40px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 26 }}>
                {[
                  { label: 'Department',   value: viewSIV.department,               bg: '#eff6ff', border: '#bfdbfe', color: '#1d4ed8' },
                  { label: 'Issue Date',   value: formatDate(viewSIV.date),          bg: '#f0fdf4', border: '#86efac', color: '#15803d' },
                  { label: 'Total Items',  value: `${viewSIV.total_items} line${viewSIV.total_items !== 1 ? 's' : ''}`, bg: '#fff7ed', border: '#fed7aa', color: '#c2410c' },
                ].map(card => (
                  <div key={card.label} style={{ padding: '12px 16px', borderRadius: 10, background: card.bg, border: `1.5px solid ${card.border}` }}>
                    <div style={{ fontSize: 9, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 600, marginBottom: 5 }}>{card.label}</div>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: card.color }}>{card.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                <div style={{ background: '#1e40af', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#93c5fd', display: 'inline-block' }} />
                  <span style={{ fontWeight: 700, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#dbeafe' }}>Items Issued</span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ background: '#eff6ff' }}>
                      <th style={{ padding: '9px 14px', textAlign: 'left',  fontWeight: 700, color: '#1d4ed8', borderBottom: '1.5px solid #93c5fd', fontSize: 10.5, width: 30 }}>#</th>
                      <th style={{ padding: '9px 14px', textAlign: 'left',  fontWeight: 700, color: '#1d4ed8', borderBottom: '1.5px solid #93c5fd', fontSize: 10.5 }}>Product</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: '#1d4ed8', borderBottom: '1.5px solid #93c5fd', fontSize: 10.5 }}>Quantity</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: '#1d4ed8', borderBottom: '1.5px solid #93c5fd', fontSize: 10.5 }}>Unit Price ($)</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: '#1d4ed8', borderBottom: '1.5px solid #93c5fd', fontSize: 10.5 }}>Line Total ($)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(viewSIV.items || []).map((item, idx) => (
                      <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                        <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 10.5 }}>{idx + 1}</td>
                        <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>
                          {item.product_name}
                          {item.unit && <span style={{ marginLeft: 6, fontSize: 10, color: '#6b7280' }}>({item.unit})</span>}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#374151' }}>{parseFloat(item.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#374151' }}>{parseFloat(item.unit_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#1d4ed8' }}>{parseFloat(item.total_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#eff6ff', borderTop: '2px solid #93c5fd' }}>
                      <td colSpan={4} style={{ padding: '12px 14px', fontWeight: 800, fontSize: 12, color: '#1e3a5f', letterSpacing: 0.5 }}>GRAND TOTAL</td>
                      <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 900, fontSize: 16, fontFamily: 'monospace', color: '#1d4ed8' }}>
                        {curSym}{parseFloat(viewSIV.total_value || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {viewSIV.notes && (
                <div style={{ padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 11.5, color: '#78350f', marginBottom: 24 }}>
                  <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 9.5, letterSpacing: 0.8, marginRight: 8, color: '#92400e' }}>Notes</span>
                  {viewSIV.notes}
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24, marginTop: 44 }}>
                {['Prepared By', 'Issued By', 'Received By'].map(label => (
                  <div key={label} style={{ textAlign: 'center' }}>
                    <div style={{ height: 40, borderBottom: '1.5px solid #cbd5e1', marginBottom: 6 }} />
                    <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#6b7280' }}>{label}</div>
                    <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 2 }}>Name / Signature / Date</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ background: '#f8fafc', borderTop: '1px solid #e2e8f0', padding: '10px 44px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: '#94a3b8' }}>{businessInfo.business_name || 'Business'} — Confidential Document</span>
              <span style={{ fontSize: 9, color: '#94a3b8' }}>Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          </div>
        </div>
      )}

      <Toast message={toast?.msg} type={toast?.type} onClose={() => setToast(null)} />

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

export default SIV;
