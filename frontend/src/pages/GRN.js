import React, { useState, useEffect, useRef, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { getGRNs, getGRNStats, createGRN, getProducts, getSuppliers, getSettings, getGRNProductReport, getGRNProductBreakdown, getGRN, updateGRN, deleteGRN, getGRNNotes, getGRNRecentProducts } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import Toast from '../components/Toast';
import InvoiceAttachment from '../components/InvoiceAttachment';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { unitsForProduct as unitsForProductFE } from '../utils/productUnits';
import { FiPlus, FiFileText, FiCalendar, FiUsers, FiClock, FiX, FiTrash2, FiPrinter, FiSearch, FiChevronDown, FiChevronUp, FiPackage, FiEdit2, FiEye, FiCheckCircle } from 'react-icons/fi';
import { matchTokens } from '../utils/tokenSearch';

const defaultStats = { totalGRNs: 0, thisMonth: 0, suppliers: 0, pending: 0 };
const emptyItem = () => ({
  product_id: '', product_text: '', quantity: '', unit_price: '', expiry_date: '', unit: '',
  // Returnable container fields (filled when the linked product has a container).
  containers_received: '', containers_returned: '', container_deposit: '', container_product_sync_id: '',
});
const todayStr = new Date().toISOString().split('T')[0];

// ── Row is "complete" when product, quantity > 0, and unit price are all filled ──
const isRowComplete = (row) =>
  row.product_id !== '' &&
  row.quantity !== '' && parseFloat(row.quantity) > 0 &&
  row.unit_price !== '';

// ── Credit Note helpers (mirror /accounting/credit-notes) ──────────────
const CN_REASON_HAS_ITEMS = (r) => r === 'Crate Return' || r === 'Goods Return';
const cnReasonStyle = (r) => {
  switch (r) {
    case 'Discount':     return { bg: '#dcfce7', color: '#15803d', border: '#86efac' };
    case 'Crate Return': return { bg: '#dbeafe', color: '#1d4ed8', border: '#bfdbfe' };
    case 'Goods Return': return { bg: '#ffedd5', color: '#9a3412', border: '#fed7aa' };
    default:             return { bg: '#f3f4f6', color: '#374151', border: '#e5e7eb' };
  }
};
const cnEmptyItem = (dep = '') => ({ product_id: '', product_text: '', quantity: '', unit_value: dep ? String(dep) : '', unit: '', unit_conv: 1 });
const cnIsRowComplete = (r) => r.product_id !== '' && parseFloat(r.quantity) > 0 && parseFloat(r.unit_value) >= 0;
const cnIsCrateProduct = (p) => {
  const cat = (p?.category_name || '').toLowerCase();
  return cat.includes('crate') || cat.includes('bottle') || cat.includes('container') || cat.includes('empty');
};
const cnPickProductUnit = (p) => {
  if (!p) return { name: '', conv: 1 };
  const units = unitsForProductFE(p);
  const wanted = p.default_unit || p.unit || '';
  const found = units.find(u => u.name === wanted) || units.find(u => u.is_base) || units[0] || { name: wanted, conv: 1 };
  return { name: found.name || wanted, conv: parseFloat(found.conv) || 1 };
};
const cnProductUnitValue = (p, defaultDep, reason, conv = 1) => {
  if (!p) return '';
  const c = parseFloat(conv) > 0 ? parseFloat(conv) : 1;
  if (reason === 'Goods Return') {
    const avg = parseFloat(p.avg_cost_price || p.cost_price || 0);
    return avg > 0 ? (avg * c).toFixed(2) : '';
  }
  if (cnIsCrateProduct(p)) return defaultDep ? String(defaultDep) : '';
  const avg = parseFloat(p.avg_cost_price || p.cost_price || 0);
  return avg > 0 ? (avg * c).toFixed(2) : '';
};

// ── Payment status badge style ────────────────────────────────────────────
// Used only for legacy / standalone GRNs (no HQ link). HQ-linked GRNs in
// Kelete don't carry AP at the branch — HQ pays — so they use hqStatusBadge.
const paymentStatusStyle = (status) => {
  if (status === 'Paid')           return { bg: '#dcfce7', color: '#166534', border: '#86efac' };
  if (status === 'Partially Paid') return { bg: '#fef9c3', color: '#854d0e', border: '#fcd34d' };
  return                                  { bg: '#fee2e2', color: '#991b1b', border: '#fca5a5' }; // Not Paid
};

// v1.9.21 — HQ-linked GRN lifecycle badge. Replaces the legacy "Not Paid"
// pill on the branch GRN view: Kelete branches no longer hold AP, so what
// the user actually needs to see is whether HQ has approved the GRN yet.
const hqStatusBadge = (s) => {
  if (s === 'CONFIRMED')           return { bg: '#dcfce7', color: '#166534', border: '#86efac', label: 'Confirmed by HQ' };
  if (s === 'HQ_REJECTED' || s === 'REJECTED')
                                   return { bg: '#fee2e2', color: '#991b1b', border: '#fca5a5', label: 'HQ Rejected' };
  return                                  { bg: '#fef3c7', color: '#92400e', border: '#fde68a', label: 'Awaiting HQ Confirm' };
};

// Track viewport width once at module scope so any page can read it. Re-checked
// on resize via a window listener inside the component.
const useIsMobile = (breakpoint = 768) => {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth <= breakpoint
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isMobile;
};

const GRN = () => {
  const { t } = useLanguage();
  const { hasPermission, user: authUser } = useAuth();
  const { symbol: curSym, money } = useCurrency();
  // v1.10.113 — each GRN row carries its own cost_currency ($/K/FRA),
  // because Kelete HQ books GRNs against suppliers with different native
  // currencies (MATUIDA in USD, HENIKEN in K, etc.). Use the row's own
  // currency for its amount display instead of the tenant-wide curSym.
  const symForCcy = (c) => {
    const u = String(c || '').toUpperCase();
    return u === 'K' ? 'K' : u === 'FRA' ? '' : u === 'USD' ? '$' : curSym;
  };
  const suffixForCcy = (c) => String(c || '').toUpperCase() === 'FRA' ? ' FRA' : '';
  // v1.10.113 — currency-aware money formatter that reads viewGRN's own
  // cost_currency instead of the tenant-wide money() from useCurrency.
  // Used throughout the detail-view modal (desktop + mobile).
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const pageScrollTopRef = useRef(0);
  const isAdmin = authUser?.role === 'Administrator';
  const [stats, setStats]       = useState(defaultStats);
  const [grns, setGRNs]         = useState([]);
  const [products, setProducts] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [showForm, setShowForm]   = useState(false);
  const [editMode, setEditMode]   = useState(false);   // true = editing existing GRN
  const [editId, setEditId]       = useState(null);
  const [editLoading, setEditLoading] = useState(false);
  const [viewGRN, setViewGRN]           = useState(null);
  // v1.10.113 — viewGrn-scoped money formatter. Reads viewGRN?.cost_currency
  // to pick the right symbol. Falls back to tenant money() before viewGRN
  // is set (should never render, but keeps the function safe to call).
  const viewMoney = (v) => {
    if (!viewGRN) return money(v);
    return `${symForCcy(viewGRN.cost_currency)}${parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${suffixForCcy(viewGRN.cost_currency)}`;
  };
  const [viewLoading, setViewLoading]   = useState(false);
  const [showGRNPrint, setShowGRNPrint] = useState(false);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  const [addRowError, setAddRowError] = useState('');
  const [notesHistory, setNotesHistory] = useState([]);
  const [notesOpen, setNotesOpen] = useState(false);
  const notesRef = useRef(null);
  const [recentProducts, setRecentProducts] = useState([]);

  // ── List date filter ──────────────────────────────────────────────
  const [filterFrom, setFilterFrom] = useState(todayStr);
  const [filterTo,   setFilterTo]   = useState(todayStr);

  // ── Print preview ─────────────────────────────────────────────────
  const [showPrintPreview, setShowPrintPreview] = useState(false);
  const [businessInfo, setBusinessInfo]         = useState({});
  const [printItemsMap, setPrintItemsMap]       = useState({});
  const [printItemsLoading, setPrintItemsLoading] = useState(false);

  // ── Product Received Report ────────────────────────────────────────
  const [showReport, setShowReport]           = useState(false);
  const [reportFrom, setReportFrom]           = useState('');
  const [reportTo, setReportTo]               = useState(todayStr);
  const [reportProduct, setReportProduct]     = useState(''); // selected product id
  const [reportSearchText, setReportSearchText] = useState('');
  const [reportShowDropdown, setReportShowDropdown] = useState(false);
  const [reportHighlightedIdx, setReportHighlightedIdx] = useState(-1);
  const [reportData, setReportData]           = useState([]);
  const [reportBreakdown, setReportBreakdown] = useState([]); // per-GRN rows
  const [reportLoading, setReportLoading]     = useState(false);
  const [reportError, setReportError]         = useState('');
  const [reportSearched, setReportSearched]   = useState(false);
  const reportSearchRef = useRef(null);
  const reportDropdownRef = useRef(null);

  // ── New GRN form state ────────────────────────────────────────────
  const [supplierId, setSupplierId] = useState('');
  const [date, setDate]             = useState(todayStr);
  const [notes, setNotes]           = useState('');
  const [items, setItems]           = useState([emptyItem()]);
  const [invoiceAttachment, setInvoiceAttachment] = useState(null); // relative path under uploads/
  // v1.9.7 — when the GRN form is opened via IncomingStock "Accept &
  // Generate GRN", these carry the parent PO context. Saving with these
  // set switches the GRN into PENDING_HQ_CONFIRM mode (no stock posted
  // until HQ confirms; supplier AP also deferred).
  const [linkedPurchaseSyncId, setLinkedPurchaseSyncId] = useState(null);
  const [linkedPurchaseNumber, setLinkedPurchaseNumber] = useState(null);
  // v1.9.12 — supplier's printed invoice number, mandatory on HQ-linked
  // GRNs. Surfaced as its own input next to the date.
  const [supplierInvoiceNumber, setSupplierInvoiceNumber] = useState('');
  // v1.9.17 — inline credit notes attached to this GRN. Each entry is
  // { reason, amount, notes, items? } and persists as a supplier_credit_notes
  // row (+ supplier_credit_note_items for Crate/Goods Return) with grn_sync_id
  // linking back. Active only when this GRN is linked to a HQ PO.
  const [creditNotes, setCreditNotes]   = useState([]);
  const [activeTab,   setActiveTab]     = useState('grn'); // 'grn' | 'Discount' | 'Crate Return' | 'Goods Return' | 'Other' | 'summary'
  // Per-tab draft state. The "Add Credit Note" button on each CN tab pushes
  // the current draft into creditNotes[] then resets these so the user can
  // queue another. The real POST happens with handleSave (GRN save) so each
  // CN inherits the new grn_sync_id atomically.
  const [cnDraftAmount, setCnDraftAmount] = useState('');
  const [cnDraftNotes,  setCnDraftNotes]  = useState('');
  const [cnDraftItems,  setCnDraftItems]  = useState([cnEmptyItem()]);
  const [cnDraftError,  setCnDraftError]  = useState('');
  const cnTotal = creditNotes.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);
  const cnCountByReason = (r) => creditNotes.filter(c => c.reason === r).length;
  const cnSumByReason   = (r) => creditNotes.filter(c => c.reason === r).reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);

  // ── Product autocomplete ──────────────────────────────────────────
  const [openDropdownIdx, setOpenDropdownIdx] = useState(-1);
  const [dropdownRect, setDropdownRect] = useState(null);
  const [highlightedIdx, setHighlightedIdx] = useState(-1);

  const [toast, setToast] = useState(null);
  const [scanMsg, setScanMsg] = useState(null); // { text, type: 'error'|'success' }

  // Mobile scroll-lock pattern. On mobile WebView (Capacitor + Android Chrome)
  // the outer scrolling container is .page-content, not body. When a
  // full-screen modal opens with position:fixed, the modal pins to the layout
  // viewport but the user's eyes are looking at a scrolled .page-content — so
  // the modal appears "above" the visible area and they have to scroll to find
  // it. Locking .page-content scroll + saving scrollTop while a modal is open
  // keeps the visual viewport aligned with the layout viewport. On close we
  // restore the scrollTop so the user lands back at the same row in the list
  // they tapped.
  useEffect(() => {
    if (!isMobile) return;
    const anyModalOpen = !!viewGRN || showForm || !!showPrintPreview;
    const pc = document.querySelector('.page-content');
    if (!pc) return;
    if (anyModalOpen) {
      pageScrollTopRef.current = pc.scrollTop;
      pc.style.overflow = 'hidden';
      pc.scrollTop = 0;
      document.body.style.overflow = 'hidden';
    } else {
      pc.style.overflow = '';
      document.body.style.overflow = '';
      requestAnimationFrame(() => { pc.scrollTop = pageScrollTopRef.current; });
    }
    return () => {
      if (pc) pc.style.overflow = '';
      document.body.style.overflow = '';
    };
  }, [viewGRN, showForm, showPrintPreview, isMobile]);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchData = async () => {
    try {
      const [statsRes, grnsRes] = await Promise.all([getGRNStats(), getGRNs()]);
      if (statsRes.data) setStats(statsRes.data);
      if (grnsRes.data) setGRNs(grnsRes.data);
      // Deep-link: if the URL has ?ref=GRN-..., auto-open the matching GRN.
      // Triggered from Sales Bin Card so users can click a GRN reference and
      // land directly on its view modal. Strips the param after consuming it.
      const params = new URLSearchParams(window.location.search);
      const ref = params.get('ref');
      if (ref) {
        const match = (grnsRes.data || []).find(g => String(g.grn_number) === ref);
        if (match) openView(match);
        const url = new URL(window.location.href);
        url.searchParams.delete('ref');
        window.history.replaceState({}, '', url.toString());
      }
    } catch (err) { /* use defaults */ }
  };

  // v1.9.7 — when navigated from IncomingStock "Accept & Generate GRN",
  // the URL carries the parent PO sync_id + number + supplier_id. Auto-
  // open the form, drop the PO# into Notes, lock the supplier, and stash
  // the linked_purchase_sync_id for the eventual save.
  // v1.9.18 — also stash the supplier name from the URL so we can resolve
  // the local supplier once the suppliers list has loaded (the HQ-side
  // supplier_id integer doesn't match the branch's local suppliers.id).
  const [pendingSupplierName, setPendingSupplierName] = useState('');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromPo  = params.get('from_purchase');
    const poNum   = params.get('purchase_number');
    const supId   = params.get('supplier_id');
    const supName = params.get('supplier_name') || '';
    if (fromPo) {
      setLinkedPurchaseSyncId(fromPo);
      setLinkedPurchaseNumber(poNum || null);
      setNotes(poNum ? `From HQ Purchase ${poNum}` : '');
      if (supId) setSupplierId(String(supId));
      if (supName) setPendingSupplierName(supName);
      setShowForm(true);
      // Clear the params so a refresh doesn't re-prefill.
      const url = new URL(window.location.href);
      url.searchParams.delete('from_purchase');
      url.searchParams.delete('purchase_number');
      url.searchParams.delete('supplier_id');
      url.searchParams.delete('supplier_name');
      window.history.replaceState({}, '', url.toString());
    }
  // eslint-disable-next-line
  }, []);

  // v1.9.18 — when suppliers finish loading, resolve the HQ-passed supplier:
  //   1) by current supplierId (if it's already a valid local id)
  //   2) by name (case-insensitive) — the reliable cross-system key
  // If still no match, leave supplierId empty so the supplier dropdown
  // re-appears and the user can pick / quick-add.
  useEffect(() => {
    if (!linkedPurchaseSyncId || suppliers.length === 0) return;
    const haveLocalMatch = supplierId && suppliers.some(s => String(s.id) === String(supplierId));
    if (haveLocalMatch) return;
    if (pendingSupplierName) {
      const byName = suppliers.find(s => (s.name || '').toLowerCase() === pendingSupplierName.toLowerCase());
      if (byName) { setSupplierId(String(byName.id)); return; }
    }
    // No match — clear so the dropdown shows and user can pick.
    setSupplierId('');
  // eslint-disable-next-line
  }, [suppliers, linkedPurchaseSyncId, pendingSupplierName]);

  useEffect(() => {
    fetchData();
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
    getGRNNotes().then(r => setNotesHistory(r.data || [])).catch(() => {});
    getGRNRecentProducts().then(r => setRecentProducts(r.data || [])).catch(() => {});
    const fetchFormData = async () => {
      try {
        const [prodRes, supRes] = await Promise.all([getProducts(), getSuppliers()]);
        if (prodRes.data?.length > 0) setProducts(prodRes.data.filter(p => (p.status || 'Active') === 'Active'));
        if (supRes.data?.length > 0)  setSuppliers(supRes.data);
      } catch (err) {}
    };
    fetchFormData();
    const handler = (e) => {
      if (notesRef.current && !notesRef.current.contains(e.target)) setNotesOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

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
        const conv = (fUnits.find(u => u.name === pickedUnit) || fUnits.find(u => u.is_base) || { conv: 1 }).conv;
        const newRow = { product_id: String(found.id), product_text: found.name, quantity: '', unit_price: ((parseFloat(found.cost_price || 0)) * parseFloat(conv || 1)).toFixed(2), expiry_date: '', unit: pickedUnit };
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

  // ── Filtered list (applied to the table + print) ──────────────────
  const filteredGRNs = grns.filter(grn => {
    const d = (grn.date || grn.created_at || '').split('T')[0];
    if (filterFrom && d < filterFrom) return false;
    if (filterTo   && d > filterTo)   return false;
    return true;
  });

  const filteredTotal = filteredGRNs.reduce((s, g) => s + parseFloat(g.total_amount || 0), 0);
  // v1.10.113 — split filtered total by currency so mixed-ccy lists
  // (e.g. one USD supplier + one K supplier) display honestly instead
  // of adding raw numbers across currencies.
  const filteredTotalsByCcy = filteredGRNs.reduce((acc, g) => {
    const c = String(g.cost_currency || '').toUpperCase() || 'USD';
    acc[c] = (acc[c] || 0) + parseFloat(g.total_amount || 0);
    return acc;
  }, {});
  const filteredTotalDisplay = Object.entries(filteredTotalsByCcy)
    .map(([c, v]) => `${symForCcy(c)}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${suffixForCcy(c)}`)
    .join(' + ') || `${curSym}0.00`;

  // ── Form helpers ──────────────────────────────────────────────────
  const openForm = () => {
    setEditMode(false); setEditId(null);
    setSupplierId(''); setDate(todayStr); setNotes(''); setInvoiceAttachment(null);
    setItems([emptyItem()]); setError(''); setAddRowError('');
    setOpenDropdownIdx(-1);
    setShowForm(true);
  };

  const openEdit = async (grn) => {
    setEditLoading(true);
    setError(''); setAddRowError('');
    try {
      const res = await getGRN(grn.id);
      const g = res.data;
      setEditMode(true);
      setEditId(g.id);
      setSupplierId(String(g.supplier_id || ''));
      setDate((g.date || g.created_at || todayStr).split('T')[0]);
      setNotes(g.notes || '');
      setInvoiceAttachment(g.invoice_attachment || null);
      setItems(
        (g.items || []).length > 0
          ? g.items.map(i => ({
              product_id:   String(i.product_id),
              product_text: i.product_name || '',
              quantity:     String(i.quantity),
              unit_price:   String(i.unit_price),
              expiry_date:  i.expiry_date || '',
              unit:         i.unit || i.product_unit || '',
              containers_received:      i.containers_received ? String(i.containers_received) : '',
              containers_returned:      i.containers_returned ? String(i.containers_returned) : '',
              container_deposit:        i.container_deposit ? String(i.container_deposit) : '',
              container_product_sync_id: i.container_product_sync_id || '',
            }))
          : [emptyItem()]
      );
      setOpenDropdownIdx(-1);
      setShowForm(true);
    } catch (err) {
      alert('Failed to load GRN details.');
    } finally {
      setEditLoading(false);
    }
  };

  const openView = async (grn) => {
    setViewLoading(true);
    try {
      const res = await getGRN(grn.id);
      setViewGRN(res.data);
    } catch (err) {
      alert('Failed to load GRN details.');
    } finally {
      setViewLoading(false);
    }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDeleteFromView = () => {
    const g = viewGRN;
    setPendingDelete({
      subject: `GRN ${g.grn_number} — stock will be reversed`,
      perform: async () => {
        try {
          await deleteGRN(g.id);
          setViewGRN(null);
          fetchData();
          showToast('GRN deleted.', 'error');
        } catch (err) {
          const msg = err.response?.data?.error || 'Failed to delete GRN.';
          const violations = err.response?.data?.violations;
          if (violations?.length) {
            alert(msg + '\n\n' + violations.map(v => `• ${v.product_name}: needs ${v.grn_qty}, only ${v.current_stock} in stock`).join('\n'));
          } else {
            alert(msg);
          }
        }
      },
    });
  };

  const updateItem = (idx, field, value) =>
    setItems(prev => prev.map((item, i) => i === idx ? { ...item, [field]: value } : item));

  const addItemRow = () => {
    const last = items[items.length - 1];
    if (!isRowComplete(last)) {
      setAddRowError('Please complete the current row — select a product, enter a quantity and unit cost — before adding another.');
      return;
    }
    setAddRowError('');
    setItems(prev => [...prev, emptyItem()]);
  };

  const removeItemRow = (idx) => {
    if (items.length === 1) return;
    setItems(prev => prev.filter((_, i) => i !== idx));
    setAddRowError('');
  };

  const beverageTotal = items.reduce((sum, item) => {
    return sum + (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0);
  }, 0);
  // Container line: new crates received × deposit. GRN is purchase-only;
  // empties going back to the supplier are recorded separately as a Credit
  // Note (reason='Crate Return') so this GRN matches the supplier invoice.
  // Legacy GRNs that already had containers_returned still net it out so
  // their displayed total stays consistent with what was saved.
  const containerTotal = items.reduce((sum, item) => {
    if (!item.container_product_sync_id) return sum;
    const recv = parseFloat(item.containers_received || 0);
    const ret  = parseFloat(item.containers_returned || 0);
    const dep  = parseFloat(item.container_deposit   || 0);
    return sum + (recv - ret) * dep;
  }, 0);
  const totalAmount = beverageTotal + containerTotal;

  const handleSave = async () => {
    setError('');
    // v1.9.20 — supplier_id no longer required at branch. Kelete branches
    // don't maintain a supplier list (AP lives at HQ). For HQ-linked GRNs
    // the supplier name comes via the URL prefill and is sent as text.
    if (linkedPurchaseSyncId && !(supplierInvoiceNumber || '').trim()) {
      return setError('Supplier invoice number is required.');
    }
    const validItems = items.filter(i => i.product_id && parseFloat(i.quantity) > 0 && parseFloat(i.unit_price) >= 0);
    if (validItems.length === 0) return setError('Please add at least one item with a product and quantity.');
    // v1.9.23 — only send supplier_id when it actually matches a local
    // supplier row. The HQ-side supplier_id passed via the URL prefill
    // doesn't exist in the branch's suppliers table, so passing it raw
    // triggered a FOREIGN KEY constraint failure on insert. Sending NULL
    // is fine — the branch has no AP, and supplier_name carries the
    // human-readable label.
    const localSupplier = supplierId ? suppliers.find(s => String(s.id) === String(supplierId)) : null;
    const payload = {
      supplier_id:   localSupplier ? parseInt(supplierId) : null,
      supplier_name: pendingSupplierName || localSupplier?.name || null,
      date, notes,
      invoice_attachment: invoiceAttachment,
      // v1.9.7 — when set, backend defers stock + AP until HQ confirms.
      linked_purchase_sync_id: linkedPurchaseSyncId || null,
      linked_purchase_number:  linkedPurchaseNumber || null,
      // v1.9.12 — paper invoice number from supplier (mandatory when linked).
      supplier_invoice_number: (supplierInvoiceNumber || '').trim() || null,
      // v1.9.17 — credit notes only sent when linked (legacy GRNs ignore).
      // Now carries optional `items` array for Crate Return / Goods Return
      // so the backend can persist the per-product breakdown + stock moves.
      credit_notes: linkedPurchaseSyncId
        ? creditNotes
            .map(c => ({
              reason: c.reason,
              amount: parseFloat(c.amount) || 0,
              notes: c.notes || '',
              items: Array.isArray(c.items) ? c.items.map(it => ({
                product_id: parseInt(it.product_id),
                quantity:   parseFloat(it.quantity),
                unit_value: parseFloat(it.unit_value),
                unit:       it.unit || null,
                unit_conv:  parseFloat(it.unit_conv) > 0 ? parseFloat(it.unit_conv) : 1,
              })) : undefined,
            }))
            .filter(c => c.amount > 0)
        : undefined,
      items: validItems.map(i => ({
        product_id:  parseInt(i.product_id),
        quantity:    parseFloat(i.quantity),
        unit_price:  parseFloat(i.unit_price),
        expiry_date: i.expiry_date || null,
        unit:        i.unit || null,
        // Container deposit sub-line (only if the product has a linked container).
        container_product_sync_id: i.container_product_sync_id || null,
        containers_received:       parseFloat(i.containers_received || 0),
        // Phase 3: new GRNs no longer accept returns at GRN time (use Credit
        // Notes / Empty Returns instead). Keep the field for backward compat
        // so editing a legacy GRN preserves its original total — but no UI
        // path adds new values.
        containers_returned:       parseFloat(i.containers_returned || 0),
        container_deposit:         parseFloat(i.container_deposit   || 0),
      })),
    };
    if (editMode) {
      if (!window.confirm('Are you sure you want to update this record?')) return;
    }
    setSaving(true);
    try {
      if (editMode) {
        await updateGRN(editId, payload);
        setShowForm(false);
        await fetchData();
        showToast('GRN updated successfully.');
      } else {
        await createGRN(payload);
        window.dispatchEvent(new Event('stock:refresh'));
        setShowForm(false);
        // v1.9.7 — reset PO link so the next GRN (manually started) isn't
        // accidentally tied to the previous PO.
        setLinkedPurchaseSyncId(null);
        setLinkedPurchaseNumber(null);
        setSupplierInvoiceNumber('');
        setCreditNotes([]);
        setActiveTab('grn');
        setCnDraftAmount(''); setCnDraftNotes(''); setCnDraftItems([cnEmptyItem()]); setCnDraftError('');
        await fetchData();
        showToast(linkedPurchaseSyncId
          ? 'GRN submitted to HQ for confirmation. Stock will become sellable once HQ approves.'
          : 'GRN saved successfully.');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save GRN. Please try again.');
    } finally { setSaving(false); }
  };

  const formatDate = (d) => {
    const str = (d || '').split('T')[0];
    if (!str) return '—';
    return new Date(str + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const formatDateLong = (d) =>
    new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const hasFilter = filterFrom || filterTo;

  const runProductReport = async (productId = reportProduct) => {
    setReportLoading(true);
    setReportError('');
    setReportSearched(true);
    try {
      const params = {};
      if (reportFrom) params.from = reportFrom;
      if (reportTo)   params.to   = reportTo;
      if (productId)  params.product_id = productId;
      const [summaryRes, breakdownRes] = await Promise.all([
        getGRNProductReport(params),
        productId ? getGRNProductBreakdown(params) : Promise.resolve({ data: [] }),
      ]);
      setReportData(summaryRes.data || []);
      setReportBreakdown(breakdownRes.data || []);
    } catch (err) {
      setReportError(err.response?.data?.error || 'Failed to load report.');
      setReportData([]);
      setReportBreakdown([]);
    } finally {
      setReportLoading(false);
    }
  };

  const reportTotal = reportData.reduce((s, r) => s + parseFloat(r.total_cost || 0), 0);

  const reportFilteredDropdown = products.filter(p => {
    if (!reportSearchText.trim()) return false;
    const q = reportSearchText.trim().toLowerCase();
    if (p.code && p.code.toLowerCase().includes(q)) return true;
    return q.split(/\s+/).every(w => p.name.toLowerCase().includes(w));
  }).slice(0, 20);

  const openPrintPreview = async () => {
    setPrintItemsLoading(true);
    try {
      const [results, settings] = await Promise.all([
        Promise.all(filteredGRNs.map(g => getGRN(g.id))),
        getSettings(),
      ]);
      const map = {};
      results.forEach(res => { if (res?.data?.id) map[res.data.id] = res.data.items || []; });
      const biz = settings?.data?.business || {};
      const fmt = (v) => parseFloat(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
      const printedAt = new Date().toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      const bizName = biz.business_name || 'Business Name';
      const addr = [biz.business_address,biz.business_phone,biz.business_email].filter(Boolean).join('  |  ');
      const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
      const hasF = filterFrom || filterTo;
      const dateLabel = hasF
        ? `${filterFrom?formatDate(filterFrom):'All'} — ${filterTo?formatDate(filterTo):'All'}`
        : formatDateLong(todayStr);
      const rows = filteredGRNs.map((grn,idx) => {
        const items = map[grn.id] || [];
        const ps = grn.payment_status||'Not Paid';
        const subRows = items.length > 0 ? `<tr style="background:#f5f5f5"><td colspan="7" style="padding:0 10px 8px 28px">
          <table style="width:100%;border-collapse:collapse;font-size:10px">
            <thead><tr style="background:#e8e8e8;border-bottom:1px solid #bbb">
              <th style="padding:4px 10px;text-align:left;font-weight:600;color:#000">Product</th>
              <th style="padding:4px 10px;text-align:right;font-weight:600;color:#000">Qty</th>
              <th style="padding:4px 10px;text-align:right;font-weight:600;color:#000">Unit Cost</th>
              <th style="padding:4px 10px;text-align:right;font-weight:600;color:#000">Total</th>
            </tr></thead><tbody>${items.map(item=>`<tr style="border-bottom:1px solid #ddd">
              <td style="padding:4px 10px;font-weight:500">${item.product_name}</td>
              <td style="padding:4px 10px;text-align:right;font-family:monospace">${parseFloat(item.quantity).toLocaleString(undefined,{minimumFractionDigits:2})}</td>
              <td style="padding:4px 10px;text-align:right;font-family:monospace">$${fmt(item.unit_price)}</td>
              <td style="padding:4px 10px;text-align:right;font-weight:600;font-family:monospace">$${fmt(item.total_price)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </td></tr>` : '';
        return `<tr style="background:${idx%2===1?'#f5f5f5':'#fff'};border-top:${idx>0?'2px solid #ccc':'none'}">
          <td style="padding:8px 10px;color:#000;font-size:10.5px">${idx+1}</td>
          <td style="padding:8px 10px;font-weight:700;font-family:monospace;font-size:11px">${grn.grn_number}</td>
          <td style="padding:8px 10px">${formatDate(grn.date||grn.created_at)}</td>
          <td style="padding:8px 10px;font-weight:500">${grn.supplier_name||'—'}</td>
          <td style="padding:8px 10px;text-align:right">${grn.total_items}</td>
          <td style="padding:8px 10px;text-align:right;font-weight:700;font-family:monospace">$${fmt(grn.total_amount)}</td>
          <td style="padding:8px 10px;text-align:right"><span style="padding:2px 8px;border:1px solid #000;font-size:10px;font-weight:600">${ps}</span></td>
        </tr>${subRows}`;
      }).join('');
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
        body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
        table{width:100%;border-collapse:collapse}
        th{padding:8px 10px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10.5px;background:#f0f0f0;text-align:left}
        td{font-size:11px}
        tfoot td{padding:10px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
      </style></head><body>
        <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${bizName}</div>
            <div style="font-size:10px;color:#000;line-height:1.7">${addr}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#000;margin-bottom:4px">Goods Received Notes</div>
            <div style="font-size:15px;font-weight:700">${dateLabel}</div>
            <div style="font-size:9px;color:#000;margin-top:3px">Printed: ${printedAt}</div>
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-bottom:16px">
          ${[['Total GRNs',stats.totalGRNs],['This Month',stats.thisMonth],[filteredGRNs.length===grns.length?'Total Amount':'Filtered Amount','$'+filteredTotal.toLocaleString(undefined,{minimumFractionDigits:2})],['Suppliers',stats.suppliers]].map(([lbl,val])=>`
            <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
              <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
              <div style="font-size:16px;font-weight:800">${val}</div>
            </div>`).join('')}
        </div>
        <div style="border:1.5px solid #000;margin-bottom:16px">
          <table>
            <thead><tr>
              <th style="width:28px">#</th>
              <th>GRN Number</th><th>Date</th><th>Supplier</th>
              <th style="text-align:right">Items</th>
              <th style="text-align:right">Total Amount</th>
              <th style="text-align:right">Status</th>
            </tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr>
              <td colspan="4">TOTAL — ${filteredGRNs.length} GRN${filteredGRNs.length!==1?'s':''}</td>
              <td style="text-align:right">${filteredGRNs.reduce((s,g)=>s+parseInt(g.total_items||0),0)} items</td>
              <td style="text-align:right;font-size:13px;font-family:monospace">$${filteredTotal.toLocaleString(undefined,{minimumFractionDigits:2})}</td>
              <td></td>
            </tr></tfoot>
          </table>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:32px;margin-bottom:16px">
          ${[['Prepared By',''],['Checked By',''],['Printed By',printedBy]].map(([label,name])=>`
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
      if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>{ w.print(); w.close(); },300); }
    } catch (e) {}
    setPrintItemsLoading(false);
  };

  const printSingleGRN = (grn) => {
    const fmt = (v) => parseFloat(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    const printedAt = new Date().toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const biz = businessInfo;
    const bizName = biz.business_name || 'Business Name';
    const addr = [biz.business_address,biz.business_phone,biz.business_email].filter(Boolean).join('  ·  ');
    const ps = grn.payment_status||'Not Paid';
    const items = grn.items || [];
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const preparedBy = grn.created_by_name || '—';
    const itemRows = items.map((item,idx)=>`<tr style="border-bottom:1px solid #ddd;background:${idx%2===1?'#f9f9f9':'#fff'}">
      <td style="padding:9px 12px;color:#000;font-size:10.5px">${idx+1}</td>
      <td style="padding:9px 12px;font-weight:600">${item.product_name}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace">${parseFloat(item.quantity).toLocaleString(undefined,{minimumFractionDigits:2})}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace">${fmt(item.unit_price)}</td>
      <td style="padding:9px 12px;text-align:right;font-weight:700;font-family:monospace">${fmt(item.total_price)}</td>
      <td style="padding:9px 12px;font-size:10.5px">${item.expiry_date||'—'}</td>
    </tr>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:14px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:8px;letter-spacing:3px;text-transform:uppercase;color:#000;margin-bottom:6px">Goods Received Note</div>
          <div style="font-size:23px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${bizName}</div>
          <div style="font-size:10.5px;color:#000;line-height:1.8">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#000;margin-bottom:6px">Document No.</div>
          <div style="font-size:22px;font-weight:900;letter-spacing:1px;font-family:monospace">${grn.grn_number}</div>
          <div style="margin-top:8px;display:inline-block;padding:3px 12px;border:1.5px solid #000;font-size:10px;font-weight:700">${ps}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px">
        ${[['Supplier',grn.supplier_name||'—'],['Received Date',formatDate(grn.date||grn.created_at)],['Total Lines',grn.total_items+' line'+(grn.total_items!==1?'s':'')]].map(([lbl,val])=>`
          <div style="padding:10px 14px;border:1.5px solid #000">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
            <div style="font-size:13px;font-weight:700">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:20px">
        <div style="background:#000;padding:8px 14px">
          <span style="font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#fff">Items Received</span>
        </div>
        <table>
          <thead><tr style="background:#f0f0f0;border-bottom:1.5px solid #000">
            <th style="padding:8px 12px;text-align:left;font-size:10px;width:30px">#</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px">Product</th>
            <th style="padding:8px 12px;text-align:right;font-size:10px">Quantity</th>
            <th style="padding:8px 12px;text-align:right;font-size:10px">Unit Cost</th>
            <th style="padding:8px 12px;text-align:right;font-size:10px">Line Total</th>
            <th style="padding:8px 12px;text-align:left;font-size:10px">Expiry Date</th>
          </tr></thead>
          <tbody>${itemRows}</tbody>
          <tfoot><tr style="background:#f0f0f0;border-top:2px solid #000">
            <td colspan="5" style="padding:11px 12px;font-weight:800;font-size:12px;letter-spacing:0.5px">GRAND TOTAL</td>
            <td style="padding:11px 12px;text-align:right;font-weight:900;font-size:16px;font-family:monospace">$${fmt(grn.total_amount)}</td>
          </tr></tfoot>
        </table>
      </div>
      ${grn.notes?`<div style="padding:10px 14px;border:1.5px solid #000;margin-bottom:20px;font-size:11px"><span style="font-weight:700;text-transform:uppercase;font-size:9px;letter-spacing:0.8px;margin-right:8px">Notes:</span>${grn.notes}</div>`:''}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:44px">
        ${[['Prepared By',preparedBy],['Checked By',''],['Printed By',printedBy]].map(([label,name])=>`
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:40px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;margin-top:20px;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px;color:#000">${bizName} — Confidential Document</span>
        <span style="font-size:9px;color:#000">Printed: ${printedAt}</span>
      </div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(()=>{ w.print(); w.close(); },300);
  };

  return (
    <div className="page-content">

      {/* ── Page Header ──────────────────────────────────────────── */}
      <div className="page-header">
        <div>
          <h1>{t('grnTitle')}</h1>
          <p>{t('grnSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={openPrintPreview}
            disabled={printItemsLoading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '9px 18px', borderRadius: 8, border: '1.5px solid #e5e7eb',
              background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500, color: '#374151',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#6b7280'; e.currentTarget.style.background = '#f9fafb'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = '#fff'; }}
          >
            <FiPrinter size={16} /> {t('print')}
          </button>
          {hasPermission('GRN:Add') && (
            <button className="btn btn-primary" onClick={openForm}><FiPlus /> {t('newGRN')}</button>
          )}
        </div>
      </div>

      {/* ── Summary Cards ────────────────────────────────────────── */}
      <div className="stat-cards">
        <div className="stat-card blue">
          <div className="stat-icon"><FiFileText /></div>
          <div><div className="stat-label">{t('totalGRNs')}</div><div className="stat-value">{hasPermission('GRN:View') ? stats.totalGRNs : 'N/A'}</div></div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon"><FiCalendar /></div>
          <div><div className="stat-label">{t('thisMonth')}</div><div className="stat-value">{hasPermission('GRN:View') ? stats.thisMonth : 'N/A'}</div></div>
        </div>
        <div className="stat-card purple">
          <div className="stat-icon"><FiUsers /></div>
          <div><div className="stat-label">{t('suppliers')}</div><div className="stat-value">{hasPermission('GRN:View') ? stats.suppliers : 'N/A'}</div></div>
        </div>
        <div className="stat-card orange">
          <div className="stat-icon"><FiClock /></div>
          <div><div className="stat-label">{t('pending')}</div><div className="stat-value">{hasPermission('GRN:View') ? stats.pending : 'N/A'}</div></div>
        </div>
        <div className="stat-card red">
          <div className="stat-icon"><FiFileText /></div>
          <div>
            <div className="stat-label">{t('totalAmount')}</div>
            <div className="stat-value" style={{ fontSize: 18 }}>{hasPermission('GRN:View') ? filteredTotalDisplay : 'N/A'}</div>
          </div>
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
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('to')}</span>
          <input
            type="date" value={filterTo} min={filterFrom || undefined} max={todayStr}
            onChange={e => setFilterTo(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }}
          />
        </div>

        {hasFilter && (
          <button
            onClick={() => { setFilterFrom(''); setFilterTo(''); }}
            style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' }}
          >
            {t('clear')}
          </button>
        )}

        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {filteredGRNs.length} GRN{filteredGRNs.length !== 1 ? 's' : ''}
          {hasFilter && <> &nbsp;·&nbsp; Total: <strong style={{ color: '#16a34a' }}>{filteredTotalDisplay}</strong></>}
        </span>
      </div>

      {/* ── GRN Table ─────────────────────────────────────────────── */}
      <div className="data-table-container">
        {filteredGRNs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
            {hasFilter ? t('noGRNsInRange') : t('noData')}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('grnNumber')}</th><th>{t('date')}</th><th>{t('supplier')}</th>
                <th>{t('items')}</th><th>{t('amount')}</th><th>{t('status')}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filteredGRNs.map(grn => (
                <tr key={grn.id}>
                  <td style={{ fontWeight: 500 }}>{grn.grn_number}</td>
                  <td>{formatDate(grn.date || grn.created_at)}</td>
                  <td>{grn.supplier_name || '—'}</td>
                  <td style={{ textAlign: 'center' }}>{grn.total_items}</td>
                  <td>{symForCcy(grn.cost_currency)}{parseFloat(grn.total_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}{suffixForCcy(grn.cost_currency)}</td>
                  <td>
                    {/* v1.9.21 — HQ-linked GRNs show their HQ lifecycle
                        (Awaiting / Confirmed / Rejected) instead of the
                        legacy payment_status pill. Branches no longer pay. */}
                    {grn.linked_purchase_sync_id ? (() => { const s = hqStatusBadge(grn.hq_status); return (
                      <span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                        background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
                        {s.label}
                      </span>
                    ); })() : (() => { const s = paymentStatusStyle(grn.payment_status); return (
                      <span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                        background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
                        {grn.payment_status || 'Not Paid'}
                      </span>
                    ); })()}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => openView(grn)}
                        disabled={viewLoading}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5,
                          padding: '5px 11px', borderRadius: 6, border: '1px solid #e5e7eb',
                          background: '#f9fafb', color: '#6b7280', cursor: 'pointer', transition: 'all 0.15s', fontSize: 12, fontWeight: 500,
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#f0fdf4'; e.currentTarget.style.color = '#16a34a'; e.currentTarget.style.borderColor = '#86efac'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.color = '#6b7280'; e.currentTarget.style.borderColor = '#e5e7eb'; }}
                      >
                        <FiEye size={12} /> {t('view')}
                      </button>
                      {hasPermission('GRN:Edit') && (
                        <button
                          onClick={() => openEdit(grn)}
                          disabled={editLoading}
                          title="Edit GRN"
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 30, height: 30, borderRadius: 6, border: '1px solid #e5e7eb',
                            background: '#f9fafb', color: '#6b7280', cursor: 'pointer', transition: 'all 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#dbeafe'; e.currentTarget.style.color = '#2563eb'; e.currentTarget.style.borderColor = '#bfdbfe'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.color = '#6b7280'; e.currentTarget.style.borderColor = '#e5e7eb'; }}
                        >
                          <FiEdit2 size={13} />
                        </button>
                      )}
                      {/* v1.9.19 — Pay button removed (HQ handles supplier payments).
                          v1.9.20 — CN button removed too. Credit Notes are
                          attached inside the NEW GRN form (Discount /
                          Crate Return / Goods Return / Other tabs); no
                          standalone CN flow on branch. */}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Product Received Breakdown ────────────────────────────── */}
      <div style={{ marginTop: 20, border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>

        {/* Collapsible Header */}
        <button
          onClick={() => setShowReport(v => !v)}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '14px 20px', background: showReport ? '#f0fdf4' : '#f8fafc',
            border: 'none', cursor: 'pointer', borderBottom: showReport ? '1px solid #d1fae5' : 'none',
            transition: 'background 0.15s',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FiPackage size={16} style={{ color: '#16a34a' }} />
            <span style={{ fontWeight: 700, fontSize: 14, color: '#15803d' }}>Product Received Breakdown</span>
            <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 400 }}>— How much of each product was received in a date range</span>
          </div>
          {showReport ? <FiChevronUp size={16} style={{ color: '#6b7280' }} /> : <FiChevronDown size={16} style={{ color: '#6b7280' }} />}
        </button>

        {showReport && (
          <div style={{ padding: '20px 24px', background: '#fff' }}>

            {/* Filter Row */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, flexWrap: 'wrap', marginBottom: 18 }}>
              {/* Product search */}
              <div style={{ flex: '0 0 240px' }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 5 }}>Product</label>
                <div style={{ position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1.5px solid #d1d5db', borderRadius: 8, padding: '7px 12px', background: '#fff' }}>
                    <FiSearch style={{ color: '#9ca3af', flexShrink: 0 }} size={14} />
                    <input
                      ref={reportSearchRef}
                      type="text"
                      value={reportSearchText}
                      onChange={e => {
                        setReportSearchText(e.target.value);
                        setReportProduct('');
                        setReportShowDropdown(true);
                        setReportHighlightedIdx(-1);
                      }}
                      onFocus={() => setReportShowDropdown(true)}
                      onBlur={() => setTimeout(() => setReportShowDropdown(false), 160)}
                      onKeyDown={e => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setReportHighlightedIdx(h => Math.min(h + 1, reportFilteredDropdown.length - 1));
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setReportHighlightedIdx(h => Math.max(h - 1, 0));
                        } else if (e.key === 'Enter' && reportHighlightedIdx >= 0 && reportFilteredDropdown[reportHighlightedIdx]) {
                          e.preventDefault();
                          const p = reportFilteredDropdown[reportHighlightedIdx];
                          setReportSearchText(p.name);
                          setReportProduct(p.id);
                          setReportShowDropdown(false);
                          setReportHighlightedIdx(-1);
                          runProductReport(p.id);
                        }
                      }}
                      placeholder="Search product..."
                      style={{ border: 'none', outline: 'none', fontSize: 13, width: '100%' }}
                    />
                    {reportProduct && <FiCheckCircle style={{ color: '#16a34a', flexShrink: 0 }} size={14} />}
                  </div>
                  {reportShowDropdown && reportFilteredDropdown.length > 0 && (
                    <div ref={reportDropdownRef} style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999, background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', marginTop: 2 }}>
                      {reportFilteredDropdown.map((p, idx) => (
                        <div
                          key={p.id}
                          onMouseDown={() => {
                            setReportSearchText(p.name);
                            setReportProduct(p.id);
                            setReportShowDropdown(false);
                            setReportHighlightedIdx(-1);
                            runProductReport(p.id);
                          }}
                          onMouseEnter={() => setReportHighlightedIdx(idx)}
                          style={{ padding: '9px 14px', cursor: 'pointer', fontSize: 13, background: reportHighlightedIdx === idx ? '#f0fdf4' : '#fff', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between' }}
                        >
                          <span style={{ fontWeight: 500 }}>{p.name}</span>
                          {p.code && <span style={{ color: '#9ca3af', fontSize: 12 }}>{p.code}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 5 }}>From Date</label>
                <input
                  type="date" value={reportFrom} max={reportTo || todayStr}
                  onChange={e => setReportFrom(e.target.value)}
                  style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, color: '#374151' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 5 }}>To Date</label>
                <input
                  type="date" value={reportTo} min={reportFrom || undefined} max={todayStr}
                  onChange={e => setReportTo(e.target.value)}
                  style={{ padding: '8px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, color: '#374151' }}
                />
              </div>
              <button
                onClick={() => runProductReport()}
                disabled={reportLoading}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 20px', borderRadius: 8, border: 'none', background: reportLoading ? '#9ca3af' : '#16a34a', color: '#fff', cursor: reportLoading ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}
              >
                <FiSearch size={14} />
                {reportLoading ? 'Searching…' : 'Search'}
              </button>
              {reportSearched && !reportLoading && (
                <button
                  onClick={() => { setReportFrom(''); setReportTo(todayStr); setReportProduct(''); setReportSearchText(''); setReportData([]); setReportBreakdown([]); setReportSearched(false); setReportError(''); }}
                  style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 13 }}
                >
                  Clear
                </button>
              )}
            </div>

            {/* Error */}
            {reportError && (
              <div style={{ padding: '10px 14px', background: '#fee2e2', color: '#dc2626', borderRadius: 8, fontSize: 13, marginBottom: 14 }}>
                {reportError}
              </div>
            )}

            {/* Results */}
            {!reportSearched && !reportLoading && (
              <div style={{ textAlign: 'center', padding: '30px 0', color: '#9ca3af', fontSize: 13 }}>
                Set a date range and click Search to see product quantities received.
              </div>
            )}

            {reportSearched && !reportLoading && reportData.length === 0 && !reportError && (
              <div style={{ textAlign: 'center', padding: '30px 0', color: '#9ca3af', fontSize: 13 }}>
                No GRN items found for the selected filters.
              </div>
            )}

            {reportData.length > 0 && (
              <>
                {/* Period label */}
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                  Showing <strong style={{ color: '#15803d' }}>{reportData.length}</strong> product{reportData.length !== 1 ? 's' : ''}
                  {(reportFrom || reportTo) && (
                    <> from <strong>{reportFrom ? formatDate(reportFrom) : 'the beginning'}</strong> to <strong>{reportTo ? formatDate(reportTo) : 'today'}</strong></>
                  )}
                </div>

                {/* Summary table */}
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', marginBottom: reportBreakdown.length > 0 ? 20 : 0 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f0fdf4' }}>
                        <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700, color: '#15803d', fontSize: 11.5, letterSpacing: 0.4 }}>#</th>
                        <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700, color: '#15803d', fontSize: 11.5, letterSpacing: 0.4 }}>Product</th>
                        <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#15803d', fontSize: 11.5, letterSpacing: 0.4 }}>Qty Received</th>
                        <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#15803d', fontSize: 11.5, letterSpacing: 0.4 }}>GRN Count</th>
                        <th style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#15803d', fontSize: 11.5, letterSpacing: 0.4 }}>Total Cost ({curSym})</th>
                        <th style={{ padding: '10px 14px', textAlign: 'center', fontWeight: 700, color: '#15803d', fontSize: 11.5, letterSpacing: 0.4 }}>First Received</th>
                        <th style={{ padding: '10px 14px', textAlign: 'center', fontWeight: 700, color: '#15803d', fontSize: 11.5, letterSpacing: 0.4 }}>Last Received</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reportData.map((row, idx) => (
                        <tr key={row.product_id} style={{ borderTop: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                          <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 12 }}>{idx + 1}</td>
                          <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>
                            {row.product_name}
                            {row.unit && <span style={{ marginLeft: 6, fontSize: 11, color: '#6b7280', background: '#f3f4f6', padding: '1px 6px', borderRadius: 10 }}>{row.unit}</span>}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontSize: 15, color: '#15803d', fontFamily: 'monospace' }}>
                            {parseFloat(row.total_quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', color: '#374151' }}>{row.grn_count}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: '#374151', fontFamily: 'monospace' }}>
                            ${parseFloat(row.total_cost || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                          </td>
                          <td style={{ padding: '10px 14px', textAlign: 'center', color: '#6b7280', fontSize: 12 }}>{formatDate(row.first_received)}</td>
                          <td style={{ padding: '10px 14px', textAlign: 'center', color: '#6b7280', fontSize: 12 }}>{formatDate(row.last_received)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#f0fdf4', borderTop: '2px solid #86efac' }}>
                        <td colSpan={4} style={{ padding: '10px 14px', fontWeight: 700, fontSize: 12.5, color: '#14532d' }}>TOTAL</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 800, fontSize: 14, fontFamily: 'monospace', color: '#15803d' }}>
                          ${reportTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td colSpan={2}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Per-GRN breakdown — shown only when a specific product is selected */}
                {reportBreakdown.length > 0 && (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#15803d', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <FiPackage size={13} /> GRN Breakdown — {reportData[0]?.product_name}
                    </div>
                    <div style={{ border: '1px solid #d1fae5', borderRadius: 10, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead>
                          <tr style={{ background: '#f0fdf4' }}>
                            <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, color: '#15803d', fontSize: 11.5 }}>#</th>
                            <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, color: '#15803d', fontSize: 11.5 }}>GRN Number</th>
                            <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, color: '#15803d', fontSize: 11.5 }}>Date</th>
                            <th style={{ padding: '9px 14px', textAlign: 'left', fontWeight: 700, color: '#15803d', fontSize: 11.5 }}>Supplier</th>
                            <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: '#15803d', fontSize: 11.5 }}>Qty</th>
                            <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: '#15803d', fontSize: 11.5 }}>Unit Price</th>
                            <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: '#15803d', fontSize: 11.5 }}>Total Cost</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reportBreakdown.map((row, idx) => (
                            <tr key={idx} style={{ borderTop: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                              <td style={{ padding: '9px 14px', color: '#9ca3af', fontSize: 12 }}>{idx + 1}</td>
                              <td style={{ padding: '9px 14px', fontWeight: 600, color: '#2563eb', fontFamily: 'monospace', fontSize: 12 }}>{row.grn_number}</td>
                              <td style={{ padding: '9px 14px', color: '#374151' }}>{formatDate(row.date)}</td>
                              <td style={{ padding: '9px 14px', color: '#374151' }}>{row.supplier_name || '—'}</td>
                              <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 600, color: '#15803d', fontFamily: 'monospace' }}>
                                {parseFloat(row.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                              </td>
                              <td style={{ padding: '9px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#374151' }}>
                                ${parseFloat(row.unit_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                              </td>
                              <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 600, fontFamily: 'monospace', color: '#374151' }}>
                                ${parseFloat(row.total_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr style={{ background: '#f0fdf4', borderTop: '2px solid #86efac' }}>
                            <td colSpan={4} style={{ padding: '9px 14px', fontWeight: 700, fontSize: 12, color: '#14532d' }}>
                              TOTAL — {reportBreakdown.length} GRN{reportBreakdown.length !== 1 ? 's' : ''}
                            </td>
                            <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 800, fontFamily: 'monospace', color: '#15803d' }}>
                              {reportBreakdown.reduce((s, r) => s + parseFloat(r.quantity || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </td>
                            <td></td>
                            <td style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 800, fontFamily: 'monospace', color: '#15803d' }}>
                              ${reportBreakdown.reduce((s, r) => s + parseFloat(r.total_price || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── View GRN Modal — Mobile (≤768px) ────────────────────────
          Rendered via portal into document.body so position:fixed
          really pins to the viewport (an ancestor in the React tree
          was breaking it, causing the modal to render at top of the
          document when the user was scrolled down the GRN list). */}
      {viewGRN && isMobile && ReactDOM.createPortal((
        <div className="view-modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'stretch', justifyContent: 'stretch' }}>
          <div style={{ background: '#fff', width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Compact header */}
            <div style={{ background: 'linear-gradient(135deg, #14532d 0%, #16a34a 100%)', padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexShrink: 0 }}>
              <button onClick={() => setViewGRN(null)} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 8, color: '#fff', width: 36, height: 36, fontSize: 20, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                ←
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{viewGRN.grn_number}</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {formatDate(viewGRN.date || viewGRN.created_at)} · {viewGRN.supplier_name || '—'}
                </div>
              </div>
              {/* v1.9.21 — HQ lifecycle pill for HQ-linked GRNs, legacy
                  payment_status for standalone/legacy GRNs. */}
              <span style={{ padding: '4px 10px', borderRadius: 14, fontSize: 10, fontWeight: 800, background: 'rgba(255,255,255,0.22)', color: '#fff', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {viewGRN.linked_purchase_sync_id ? hqStatusBadge(viewGRN.hq_status).label : (viewGRN.payment_status || 'Not Paid')}
              </span>
            </div>

            {/* Scrollable body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '14px 14px 80px' }}>
              {/* Totals box */}
              <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 12, padding: 14, marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#15803d', textTransform: 'uppercase', letterSpacing: 0.5 }}>Grand Total</span>
                  <span style={{ fontSize: 22, fontWeight: 900, color: '#15803d', fontFamily: 'monospace' }}>
                    {viewMoney(viewGRN.total_amount || 0)}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#166534', flexWrap: 'wrap' }}>
                  <span>Items: <strong>{viewGRN.total_items}</strong></span>
                  {/* v1.9.21 — Paid/Balance hidden for HQ-linked GRNs
                      (branch has no AP). Kept for legacy/standalone GRNs. */}
                  {!viewGRN.linked_purchase_sync_id && (
                    <>
                      <span>Paid: <strong>{viewMoney(viewGRN.amount_paid_on_grn || 0)}</strong></span>
                      <span>Balance: <strong style={{ color: parseFloat(viewGRN.balance_on_grn || 0) > 0.001 ? '#dc2626' : '#15803d' }}>{viewMoney(viewGRN.balance_on_grn || 0)}</strong></span>
                    </>
                  )}
                </div>
              </div>

              {/* v1.9.21 — HQ status card (linked GRNs only). Replaces the
                  legacy "Not Paid / Paid: $0 / Balance: $X" strip with
                  the lifecycle the branch actually cares about. */}
              {viewGRN.linked_purchase_sync_id && (() => {
                const s = hqStatusBadge(viewGRN.hq_status);
                const sub = viewGRN.hq_status === 'CONFIRMED'
                  ? `Stock is on the sales floor${viewGRN.hq_confirmed_at ? ` · ${formatDate(viewGRN.hq_confirmed_at)}` : ''}${viewGRN.hq_confirmed_by_name ? ` · by ${viewGRN.hq_confirmed_by_name}` : ''}`
                  : (viewGRN.hq_status === 'HQ_REJECTED' || viewGRN.hq_status === 'REJECTED')
                    ? (viewGRN.hq_reject_reason || 'Re-submit a corrected GRN.')
                    : 'Stock will post to the sales floor once HQ confirms.';
                return (
                  <div style={{ background: s.bg, border: `1px solid ${s.border}`, borderRadius: 12, padding: 12, marginBottom: 14 }}>
                    <div style={{ fontSize: 12, fontWeight: 800, color: s.color, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{s.label}</div>
                    <div style={{ fontSize: 11, color: s.color }}>{sub}</div>
                  </div>
                );
              })()}

              {/* Section heading */}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, padding: '4px 4px 8px' }}>
                Items Received ({(viewGRN.items || []).length})
              </div>

              {/* Product cards */}
              {(viewGRN.items || []).map((item, idx) => {
                const recv = parseFloat(item.containers_received || 0);
                const ret  = parseFloat(item.containers_returned || 0);
                const dep  = parseFloat(item.container_deposit   || 0);
                const containerLine = (recv - ret) * dep;
                const hasContainer = item.container_product_sync_id && (recv > 0 || ret > 0);
                const containerProd = hasContainer ? products.find(p => p.sync_id === item.container_product_sync_id) : null;
                return (
                  <div key={item.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, marginBottom: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#111827', marginBottom: 6 }}>
                      <span style={{ color: '#9ca3af', fontWeight: 500, marginRight: 6 }}>{idx + 1}.</span>
                      {item.product_name}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13, color: '#374151' }}>
                      <span>
                        {parseFloat(item.quantity).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} {item.unit || item.product_unit || ''}
                        <span style={{ color: '#9ca3af', margin: '0 6px' }}>×</span>
                        {viewMoney(item.unit_price)}
                      </span>
                      <span style={{ fontWeight: 800, color: '#15803d', fontFamily: 'monospace' }}>
                        {viewMoney(item.total_price)}
                      </span>
                    </div>
                    {item.expiry_date && (
                      <div style={{ fontSize: 11, color: '#92400e', marginTop: 4 }}>
                        Expiry: {item.expiry_date}
                      </div>
                    )}
                    {hasContainer && (
                      <div style={{ marginTop: 8, padding: '8px 10px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 11.5, color: '#92400e' }}>
                        <div style={{ fontWeight: 600 }}>↳ Returnable: {containerProd?.name || 'Empty container'}</div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                          <span>Recv {recv} / Ret {ret} @ {viewMoney(dep)}</span>
                          <span style={{ fontWeight: 700, color: containerLine < 0 ? '#dc2626' : '#92400e' }}>
                            {containerLine < 0 ? '−' : '+'}{viewMoney(Math.abs(containerLine))}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Notes */}
              {viewGRN.notes && (
                <div style={{ padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#78350f', marginTop: 8 }}>
                  <span style={{ fontWeight: 700 }}>Notes: </span>{viewGRN.notes}
                </div>
              )}

              {/* Invoice attachment */}
              {viewGRN.invoice_attachment && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Invoice Attachment</div>
                  <InvoiceAttachment value={viewGRN.invoice_attachment} onChange={() => {}} kind="grn" disabled />
                </div>
              )}
            </div>

            {/* Sticky footer */}
            <div style={{ borderTop: '1px solid #e5e7eb', padding: '10px 12px', display: 'flex', gap: 8, background: '#fff', flexShrink: 0 }}>
              <button
                onClick={() => printSingleGRN(viewGRN)}
                style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 8px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600 }}
              >
                <FiPrinter size={13} /> Print
              </button>
              {hasPermission('GRN:Edit') && (
                <button
                  onClick={() => { openEdit({ id: viewGRN.id }); setViewGRN(null); }}
                  style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 8px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600 }}
                >
                  <FiEdit2 size={13} /> Edit
                </button>
              )}
              {hasPermission('GRN:Delete') && (
                <button
                  onClick={handleDeleteFromView}
                  style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '10px 8px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontSize: 12, fontWeight: 700 }}
                >
                  <FiTrash2 size={13} /> Delete
                </button>
              )}
            </div>
          </div>
        </div>
      ), document.body)}

      {/* ── View GRN Modal — Desktop (>768px) ───────────────────── */}
      {viewGRN && !isMobile && ReactDOM.createPortal((
        <div className="view-modal-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 900, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column' }}>

            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #14532d 0%, #16a34a 100%)', borderRadius: '14px 14px 0 0', padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <FiFileText size={16} style={{ color: 'rgba(255,255,255,0.8)' }} />
                  <span style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)', fontWeight: 600 }}>Goods Received Note</span>
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', letterSpacing: 0.3 }}>{viewGRN.grn_number}</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 3 }}>
                  {formatDate(viewGRN.date || viewGRN.created_at)} &nbsp;·&nbsp; {viewGRN.supplier_name || '—'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {/* v1.9.21 — pill shows HQ lifecycle for HQ-linked GRNs,
                    legacy payment_status for standalone GRNs. */}
                <span style={{
                  padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700,
                  background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.35)',
                }}>
                  {viewGRN.linked_purchase_sync_id ? hqStatusBadge(viewGRN.hq_status).label : (viewGRN.payment_status || 'Not Paid')}
                </span>
                <button onClick={() => setViewGRN(null)} style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 8, cursor: 'pointer', color: '#fff', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <FiX size={16} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div style={{ padding: '24px 28px', flex: 1 }}>

              {/* v1.9.21 — Status strip: HQ lifecycle card for linked GRNs,
                  legacy Paid/Balance strip for standalone/legacy GRNs. */}
              {viewGRN.linked_purchase_sync_id ? (() => {
                const s = hqStatusBadge(viewGRN.hq_status);
                const sub = viewGRN.hq_status === 'CONFIRMED'
                  ? `Stock is on the sales floor${viewGRN.hq_confirmed_at ? ` · ${formatDate(viewGRN.hq_confirmed_at)}` : ''}${viewGRN.hq_confirmed_by_name ? ` · by ${viewGRN.hq_confirmed_by_name}` : ''}`
                  : (viewGRN.hq_status === 'HQ_REJECTED' || viewGRN.hq_status === 'REJECTED')
                    ? (viewGRN.hq_reject_reason || 'Re-submit a corrected GRN.')
                    : 'Stock will post to the sales floor once HQ confirms.';
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 16px', borderRadius: 8, background: s.bg, border: `1px solid ${s.border}`, marginBottom: 16 }}>
                    <span style={{ fontWeight: 800, fontSize: 13, color: s.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>{s.label}</span>
                    <span style={{ fontSize: 12, color: s.color, opacity: 0.85 }}>{sub}</span>
                  </div>
                );
              })() : (() => {
                const s = paymentStatusStyle(viewGRN.payment_status);
                return (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 8, background: s.bg, border: `1px solid ${s.border}`, marginBottom: 16 }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: s.color }}>{viewGRN.payment_status || 'Not Paid'}</span>
                    <span style={{ fontSize: 12, color: s.color, opacity: 0.8 }}>
                      &nbsp;·&nbsp; Paid: <strong>{viewMoney(viewGRN.amount_paid_on_grn || 0)}</strong>
                      &nbsp;&nbsp;Balance: <strong>{viewMoney(viewGRN.balance_on_grn || 0)}</strong>
                    </span>
                  </div>
                );
              })()}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Supplier',    value: viewGRN.supplier_name || '—' },
                  { label: 'Date',        value: formatDate(viewGRN.date || viewGRN.created_at) },
                  { label: 'Total Items', value: viewGRN.total_items },
                ].map(info => (
                  <div key={info.label} style={{ padding: '10px 14px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                    <div style={{ fontSize: 10.5, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{info.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{info.value}</div>
                  </div>
                ))}
              </div>

              {/* Items table */}
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                <div style={{ background: '#f0fdf4', padding: '10px 14px', borderBottom: '1px solid #d1fae5', fontSize: 11.5, fontWeight: 700, color: '#15803d', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Items Received
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      <th style={{ padding: '9px 14px', textAlign: 'left',  fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>#</th>
                      <th style={{ padding: '9px 14px', textAlign: 'left',  fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>Product</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>Quantity</th>
                      <th style={{ padding: '9px 14px', textAlign: 'left',  fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>Unit</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>Unit Cost ({symForCcy(viewGRN.cost_currency).trim() || 'FRA'})</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>Total ({symForCcy(viewGRN.cost_currency).trim() || 'FRA'})</th>
                      <th style={{ padding: '9px 14px', textAlign: 'left',  fontWeight: 600, color: '#6b7280', fontSize: 11.5, borderBottom: '1px solid #e5e7eb' }}>Expiry Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(viewGRN.items || []).map((item, idx) => {
                      const recv = parseFloat(item.containers_received || 0);
                      const ret  = parseFloat(item.containers_returned || 0);
                      const dep  = parseFloat(item.container_deposit   || 0);
                      const containerLine = (recv - ret) * dep;
                      const hasContainer = item.container_product_sync_id && (recv > 0 || ret > 0);
                      const containerProd = hasContainer
                        ? products.find(p => p.sync_id === item.container_product_sync_id)
                        : null;
                      return (
                        <React.Fragment key={item.id}>
                          <tr style={{ borderBottom: hasContainer ? 'none' : '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                            <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 12 }}>{idx + 1}</td>
                            <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>{item.product_name}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>{parseFloat(item.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td style={{ padding: '10px 14px', color: '#374151', fontSize: 12 }}>{item.unit || item.product_unit || '—'}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>{parseFloat(item.unit_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, color: '#15803d', fontFamily: 'monospace' }}>{parseFloat(item.total_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td style={{ padding: '10px 14px', color: '#374151', fontSize: 12 }}>{item.expiry_date || '—'}</td>
                          </tr>
                          {hasContainer && (
                            <tr style={{ background: '#fffbeb', borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '6px 14px 10px', color: '#b45309', fontSize: 11 }}></td>
                              <td style={{ padding: '6px 14px 10px 32px', fontSize: 12, color: '#92400e' }}>
                                <span style={{ fontWeight: 600 }}>↳ Returnable:</span> {containerProd?.name || 'Empty container'}
                                <span style={{ marginLeft: 10, color: '#a16207' }}>
                                  Recv {recv}, Ret {ret}
                                </span>
                              </td>
                              <td colSpan={3} style={{ padding: '6px 14px 10px', fontSize: 11, color: '#a16207', textAlign: 'right' }}>
                                {(recv - ret) > 0 && `+${recv - ret} into yard`}
                                {(recv - ret) < 0 && `${recv - ret} sent back`}
                                {(recv - ret) === 0 && '—'}
                                &nbsp;@ {viewMoney(dep)}
                              </td>
                              <td style={{ padding: '6px 14px 10px', textAlign: 'right', fontWeight: 600, fontFamily: 'monospace', color: containerLine < 0 ? '#dc2626' : '#92400e' }}>
                                {containerLine < 0 ? '−' : '+'}{viewMoney(Math.abs(containerLine))}
                              </td>
                              <td style={{ padding: '6px 14px 10px' }}></td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f0fdf4', borderTop: '2px solid #86efac' }}>
                      <td colSpan={6} style={{ padding: '10px 14px', fontWeight: 700, fontSize: 13, color: '#14532d' }}>TOTAL</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 800, fontSize: 15, fontFamily: 'monospace', color: '#15803d' }}>
                        {viewMoney(viewGRN.total_amount || 0)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Notes */}
              {viewGRN.notes && (
                <div style={{ padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 13, color: '#78350f' }}>
                  <span style={{ fontWeight: 600 }}>Notes: </span>{viewGRN.notes}
                </div>
              )}

              {/* Invoice attachment */}
              {viewGRN.invoice_attachment && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Invoice Attachment</div>
                  <InvoiceAttachment value={viewGRN.invoice_attachment} onChange={() => {}} kind="grn" disabled />
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '14px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                onClick={() => printSingleGRN(viewGRN)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.borderColor = '#9ca3af'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = '#d1d5db'; }}
              >
                <FiPrinter size={14} /> Print
              </button>
              <div style={{ display: 'flex', gap: 10 }}>
                {hasPermission('GRN:Edit') && (
                  <button
                    onClick={() => { openEdit({ id: viewGRN.id }); setViewGRN(null); }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
                  >
                    <FiEdit2 size={13} /> Edit
                  </button>
                )}
                {hasPermission('GRN:Delete') && (
                  <button
                    onClick={handleDeleteFromView}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                  >
                    <FiTrash2 size={13} /> Delete
                  </button>
                )}
                <button
                  onClick={() => setViewGRN(null)}
                  style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      ), document.body)}

      {/* ── New GRN Modal ─────────────────────────────────────────── */}
      {showForm && ReactDOM.createPortal((
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          {/* v1.9.17 — modal is back to its legacy centered size. The CN
              experience moved inside it as per-reason tabs (Discount /
              Crate Return / Goods Return / Other / Summary) mirroring the
              /accounting/credit-notes UX. */}
          <div style={{
            background: '#fff',
            borderRadius: 12,
            width: '100%',
            maxWidth: 980,
            maxHeight: '95vh',
            overflowY: 'auto',
            boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
          }}>

            {/* Modal Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {editMode && (
                  <div style={{ width: 32, height: 32, borderRadius: 8, background: '#dbeafe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <FiEdit2 size={15} style={{ color: '#2563eb' }} />
                  </div>
                )}
                <div>
                  <h3 style={{ margin: 0, fontSize: 17 }}>{editMode ? 'Edit GRN' : t('grnTitle')}</h3>
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>
                    {editMode ? 'Update the goods received note'
                      : linkedPurchaseSyncId ? `From HQ Purchase ${linkedPurchaseNumber}` : 'Record stock received from a supplier'}
                  </p>
                </div>
              </div>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}><FiX size={20} /></button>
            </div>

            {/* v1.9.17 — tab strip (HQ-linked GRNs only). Past/legacy GRNs
                keep the flat layout to avoid disrupting old behavior.
                Layout: [GRN] [Discount(n)] [Crate Return(n)] [Goods Return(n)]
                [Other(n)] [Summary]. Each CN tab queues a draft into
                creditNotes[] — the real POST happens on Save GRN. */}
            {linkedPurchaseSyncId && (
              <div style={{ display: 'flex', flexWrap: 'wrap', borderBottom: '1px solid #e5e7eb', padding: '0 24px' }}>
                {[
                  { id: 'grn',           label: 'GRN' },
                  { id: 'Discount',      label: `Discount${cnCountByReason('Discount')      ? ` (${cnCountByReason('Discount')})`      : ''}` },
                  { id: 'Crate Return',  label: `Crate Return${cnCountByReason('Crate Return')   ? ` (${cnCountByReason('Crate Return')})`   : ''}` },
                  { id: 'Goods Return',  label: `Goods Return${cnCountByReason('Goods Return')   ? ` (${cnCountByReason('Goods Return')})`   : ''}` },
                  { id: 'Other',         label: `Other${cnCountByReason('Other')         ? ` (${cnCountByReason('Other')})`         : ''}` },
                  { id: 'summary',       label: 'Summary' },
                ].map(tab => (
                  <button key={tab.id}
                    onClick={() => { setActiveTab(tab.id); setCnDraftError(''); }}
                    style={{
                      padding: '12px 16px', border: 'none', background: 'transparent',
                      cursor: 'pointer', fontSize: 13,
                      fontWeight: activeTab === tab.id ? 700 : 500,
                      color: activeTab === tab.id ? '#0ea5e9' : '#64748b',
                      borderBottom: activeTab === tab.id ? '2px solid #0ea5e9' : '2px solid transparent',
                      marginBottom: -1,
                    }}>
                    {tab.label}
                  </button>
                ))}
              </div>
            )}

            <div style={{ padding: '20px 24px', display: (linkedPurchaseSyncId && activeTab !== 'grn') ? 'none' : 'block' }}>

              {/* v1.9.20 — Supplier is now display-only on branch GRN. The
                  branch doesn't maintain a supplier list and doesn't pay
                  AP (HQ does both). The name comes from the HQ PO via the
                  ?supplier_name= URL prefill and is sent to the backend
                  as plain text on save. */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                    {t('supplier')}
                  </label>
                  <div style={{ padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#f3f4f6', fontSize: 14, color: '#374151', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>{pendingSupplierName || suppliers.find(s => String(s.id) === String(supplierId))?.name || '—'}</span>
                    {linkedPurchaseNumber && (
                      <span style={{ fontSize: 11, color: '#6b7280', fontStyle: 'italic' }}>from PO {linkedPurchaseNumber}</span>
                    )}
                  </div>
                </div>
                <div>
                  {/* v1.9.12 — Date + Supplier Invoice # share the right cell
                      when the GRN is HQ-PO-linked. Invoice # is required;
                      the form blocks save until it's filled. */}
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('date')}</label>
                  <input
                    type="date" value={date} max={todayStr}
                    onChange={e => setDate(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
                  />
                  {linkedPurchaseSyncId && (
                    <div style={{ marginTop: 10 }}>
                      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                        Supplier Invoice # <span style={{ color: '#dc2626' }}>*</span>
                      </label>
                      <input
                        type="text"
                        value={supplierInvoiceNumber}
                        onChange={e => setSupplierInvoiceNumber(e.target.value)}
                        placeholder="e.g. INV-12345"
                        style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Notes */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('notes')}</label>
                <div ref={notesRef} style={{ position: 'relative' }}>
                  <input
                    type="text" value={notes}
                    onChange={e => { setNotes(e.target.value); setNotesOpen(true); }}
                    onFocus={() => setNotesOpen(true)}
                    placeholder="e.g. Delivery reference, invoice number..."
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
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

              {/* Invoice attachment (PDF / image / camera) */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Invoice Attachment</label>
                <InvoiceAttachment value={invoiceAttachment} onChange={setInvoiceAttachment} kind="grn" />
              </div>

              {/* Items */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <label style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                    {t('product')}s <span style={{ color: '#dc2626' }}>*</span>
                  </label>
                  <button
                    onClick={addItemRow}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13 }}
                  >
                    <FiPlus size={13} /> Add Item
                  </button>
                </div>

                {/* Barcode scan message */}
                {scanMsg && (
                  <div style={{ marginBottom: 8, padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, background: scanMsg.type === 'error' ? '#fee2e2' : '#dcfce7', color: scanMsg.type === 'error' ? '#dc2626' : '#16a34a', border: `1px solid ${scanMsg.type === 'error' ? '#fca5a5' : '#86efac'}` }}>
                    {scanMsg.type === 'error' ? '⚠ ' : '✓ '}{scanMsg.text}
                  </div>
                )}

                {/* Recent products quick-add chips */}
                {recentProducts.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                    <span style={{ fontSize: 11, color: '#9ca3af', alignSelf: 'center', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Recent:</span>
                    {recentProducts.map(p => (
                      <button key={p.product_id} type="button"
                        onClick={() => {
                          const last = items[items.length - 1];
                          const target = last.product_id === '' ? items.length - 1 : null;
                          const prodMeta = products.find(pp => pp.id === p.product_id);
                          const pickedUnit = (prodMeta?.default_unit) || prodMeta?.unit || '';
                          const newRow = { product_id: String(p.product_id), product_text: p.product_name, quantity: '', unit_price: String(p.last_price || prodMeta?.cost_price || ''), expiry_date: '', unit: pickedUnit };
                          if (target !== null) {
                            setItems(prev => prev.map((item, i) => i === target ? newRow : item));
                          } else {
                            setItems(prev => [...prev, newRow]);
                          }
                          setAddRowError('');
                        }}
                        style={{ padding: '3px 10px', background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 20, fontSize: 12, cursor: 'pointer', fontWeight: 500 }}
                      >{p.product_name}</button>
                    ))}
                  </div>
                )}

                {/* Add-row validation message */}
                {addRowError && (
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                    padding: '9px 13px', marginBottom: 10, borderRadius: 8,
                    background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 12.5,
                  }}>
                    <span style={{ flexShrink: 0 }}>⚠</span>
                    <span>{addRowError}</span>
                  </div>
                )}

                {/* Items Table */}
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      <th style={{ padding: '10px 10px', textAlign: 'center', fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb' }}>{t('product')}</th>
                      <th style={{ padding: '10px 10px', textAlign: 'center', fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb', width: 90 }}>{t('quantity')}</th>
                      <th style={{ padding: '10px 10px', textAlign: 'center', fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb', width: 130 }}>Unit</th>
                      <th style={{ padding: '10px 10px', textAlign: 'center', fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb', width: 110 }}>Cost ({curSym})</th>
                      <th style={{ padding: '10px 10px', textAlign: 'center', fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb', width: 110 }}>Total ({curSym})</th>
                      <th style={{ padding: '10px 10px', textAlign: 'center', fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb', width: 140 }}>Expiry Date</th>
                      <th style={{ padding: '10px 8px', borderBottom: '1px solid #e5e7eb', width: 44 }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, idx) => {
                      const lineTotal  = (parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0);
                      const isLast     = idx === items.length - 1;
                      const incomplete = isLast && addRowError && !isRowComplete(item);
                      // Container sub-line — visible only when this item's product has a linked container.
                      const containerSyncId = item.container_product_sync_id;
                      const containerProduct = containerSyncId
                        ? products.find(p => p.sync_id === containerSyncId)
                        : null;
                      const recv = parseFloat(item.containers_received || 0);
                      const ret  = parseFloat(item.containers_returned || 0);
                      const dep  = parseFloat(item.container_deposit   || 0);
                      const containerLineTotal = (recv - ret) * dep;
                      return (
                        <React.Fragment key={idx}>
                        <tr>
                          {/* ── Product autocomplete ── */}
                          <td style={{ padding: '8px 8px 8px 0' }}>
                            <div style={{ position: 'relative' }}>
                              <input
                                value={item.product_text}
                                onChange={e => {
                                  updateItem(idx, 'product_text', e.target.value);
                                  updateItem(idx, 'product_id', '');
                                  setOpenDropdownIdx(idx);
                                  setHighlightedIdx(-1);
                                  if (addRowError) setAddRowError('');
                                }}
                                onFocus={e => { const r = e.target.getBoundingClientRect(); setDropdownRect({ top: r.bottom + 2, left: r.left, width: r.width }); setOpenDropdownIdx(idx); setHighlightedIdx(-1); }}
                                onBlur={() => { setTimeout(() => { setOpenDropdownIdx(-1); setHighlightedIdx(-1); }, 160); }}
                                placeholder="Type or search product…"
                                style={{ width: '100%', padding: '8px 10px', border: `1px solid ${incomplete && !item.product_id ? '#f59e0b' : '#e5e7eb'}`, borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }}
                                onKeyDown={e => {
                                  const filtered = products.filter(p => matchTokens(item.product_text, p.name, p.code, p.barcode));
                                  if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    setHighlightedIdx(h => Math.min(h + 1, filtered.length - 1));
                                  } else if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    setHighlightedIdx(h => Math.max(h - 1, 0));
                                  } else if (e.key === 'Enter' && highlightedIdx >= 0 && filtered[highlightedIdx]) {
                                    e.preventDefault();
                                    const p = filtered[highlightedIdx];
                                    // Honour the product's default_unit (else fall back to base). Scale cost by the unit's conversion factor.
                                    const pickedUnit = p.default_unit || p.unit || '';
                                    const pUnits = unitsForProductFE(p);
                                    const pickedConv = (pUnits.find(u => u.name === pickedUnit) || pUnits.find(u => u.is_base) || { conv: 1 }).conv;
                                    const baseCost = parseFloat(p.cost_price || p.selling_price || 0);
                                    setItems(prev => prev.map((it, i) => i === idx ? {
                                      ...it,
                                      product_id: String(p.id),
                                      product_text: p.name,
                                      unit: pickedUnit,
                                      unit_price: (baseCost * parseFloat(pickedConv || 1)).toFixed(2),
                                      container_product_sync_id: p.container_product_sync_id || '',
                                      container_deposit: p.container_product_sync_id
                                        ? String(parseFloat(businessInfo.default_crate_deposit || 0))
                                        : '',
                                    } : it));
                                    setOpenDropdownIdx(-1);
                                    setHighlightedIdx(-1);
                                    if (addRowError) setAddRowError('');
                                  } else if (e.key === 'Escape') {
                                    setOpenDropdownIdx(-1);
                                    setHighlightedIdx(-1);
                                  }
                                }}
                              />
                              {openDropdownIdx === idx && dropdownRect && (
                                <div style={{ position: 'fixed', top: dropdownRect.top, left: dropdownRect.left, width: dropdownRect.width, zIndex: 9999, background: '#fff', border: '1px solid #d1d5db', borderRadius: 6, maxHeight: 200, overflowY: 'auto', boxShadow: '0 6px 20px rgba(0,0,0,0.12)' }}>
                                  {products
                                    .filter(p => matchTokens(item.product_text, p.name, p.code, p.barcode))
                                    .map((p, pIdx) => (
                                      <div
                                        key={p.id}
                                        onMouseDown={() => {
                                          const pickedUnit = p.default_unit || p.unit || '';
                                          const pUnits = unitsForProductFE(p);
                                          const pickedConv = (pUnits.find(u => u.name === pickedUnit) || pUnits.find(u => u.is_base) || { conv: 1 }).conv;
                                          const baseCost = parseFloat(p.cost_price || p.selling_price || 0);
                                          setItems(prev => prev.map((it, i) => i === idx ? {
                                            ...it,
                                            product_id: String(p.id),
                                            product_text: p.name,
                                            unit: pickedUnit,
                                            unit_price: (baseCost * parseFloat(pickedConv || 1)).toFixed(2),
                                            container_product_sync_id: p.container_product_sync_id || '',
                                            container_deposit: p.container_product_sync_id
                                              ? String(parseFloat(businessInfo.default_crate_deposit || 0))
                                              : '',
                                          } : it));
                                          setOpenDropdownIdx(-1);
                                          setHighlightedIdx(-1);
                                          if (addRowError) setAddRowError('');
                                        }}
                                        style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: highlightedIdx === pIdx ? '#f0fdf4' : '#fff' }}
                                        onMouseEnter={() => setHighlightedIdx(pIdx)}
                                        onMouseLeave={() => setHighlightedIdx(-1)}
                                      >
                                        <span style={{ fontWeight: 500 }}>{p.name}</span>
                                        {(p.cost_price || p.selling_price) && (
                                          <span style={{ fontSize: 11, color: '#9ca3af' }}>${(parseFloat(parseFloat(p.cost_price || p.selling_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                                        )}
                                      </div>
                                    ))
                                  }
                                  {products.filter(p => matchTokens(item.product_text, p.name, p.code, p.barcode)).length === 0 && (
                                    <div style={{ padding: '10px 12px', fontSize: 13, color: '#9ca3af' }}>No matching products</div>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>
                          <td style={{ padding: '8px 8px' }}>
                            <input
                              type="number" min="0" step="1" placeholder="0"
                              value={item.quantity}
                              onChange={e => { updateItem(idx, 'quantity', e.target.value); if (addRowError) setAddRowError(''); }}
                              style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: `1px solid ${incomplete && (!item.quantity || parseFloat(item.quantity) <= 0) ? '#f59e0b' : '#e5e7eb'}`, borderRadius: 6, fontSize: 13, textAlign: 'right' }}
                            />
                          </td>
                          {/* ── Unit picker — dropdown enumerates every packaging the product was configured with. ── */}
                          <td style={{ padding: '8px 8px' }}>
                            {(() => {
                              const prod = products.find(p => p.id === parseInt(item.product_id));
                              if (!prod) {
                                return (
                                  <div style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, color: '#9ca3af', background: '#f9fafb' }}>—</div>
                                );
                              }
                              const units = unitsForProductFE(prod);
                              if (units.length <= 1) {
                                return (
                                  <div style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, color: '#374151', background: '#f9fafb' }}>{prod.unit}</div>
                                );
                              }
                              return (
                                <select
                                  value={item.unit || prod.unit}
                                  onChange={e => {
                                    const newUnit = e.target.value;
                                    updateItem(idx, 'unit', newUnit);
                                    // Auto-fill cost: scale base cost by the conversion factor of the chosen unit.
                                    const base = parseFloat(prod.cost_price || 0);
                                    const u = units.find(x => x.name === newUnit) || units.find(x => x.is_base);
                                    const conv = u ? parseFloat(u.conv) : 1;
                                    updateItem(idx, 'unit_price', (base * conv).toFixed(2));
                                  }}
                                  style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, background: '#fff' }}
                                >
                                  {units.map(u => (
                                    <option key={u.name} value={u.name}>
                                      {u.name}{u.is_base ? '' : ` (1 = ${u.conv} ${prod.unit})`}
                                    </option>
                                  ))}
                                </select>
                              );
                            })()}
                          </td>
                          <td style={{ padding: '8px 8px' }}>
                            <input
                              type="number" min="0" step="0.01" placeholder="0.00"
                              value={item.unit_price}
                              onChange={e => { updateItem(idx, 'unit_price', e.target.value); if (addRowError) setAddRowError(''); }}
                              style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: `1px solid ${incomplete && item.unit_price === '' ? '#f59e0b' : '#e5e7eb'}`, borderRadius: 6, fontSize: 13, textAlign: 'right' }}
                            />
                          </td>
                          <td style={{ padding: '8px 8px' }}>
                            <div style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, textAlign: 'right', background: '#f9fafb', color: '#374151' }}>
                              {(parseFloat(lineTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                            </div>
                          </td>
                          <td style={{ padding: '8px 8px' }}>
                            <input
                              type="date"
                              value={item.expiry_date}
                              onChange={e => updateItem(idx, 'expiry_date', e.target.value)}
                              style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12 }}
                            />
                          </td>
                          <td style={{ padding: '8px 4px', textAlign: 'center' }}>
                            <button
                              onClick={() => removeItemRow(idx)}
                              disabled={items.length === 1}
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, background: items.length === 1 ? '#f3f4f6' : '#fee2e2', color: items.length === 1 ? '#9ca3af' : '#dc2626', border: 'none', borderRadius: 6, cursor: items.length === 1 ? 'not-allowed' : 'pointer' }}
                            >
                              <FiTrash2 size={14} />
                            </button>
                          </td>
                        </tr>
                        {containerSyncId && (
                          <tr style={{ background: '#fffbeb' }}>
                            <td style={{ padding: '4px 8px 10px 28px', fontSize: 12, color: '#92400e' }}>
                              <span style={{ fontSize: 11, color: '#b45309', fontWeight: 600 }}>↳ Returnable: </span>
                              {containerProduct ? containerProduct.name : 'Empty container'}
                            </td>
                            <td style={{ padding: '4px 8px 10px' }}>
                              <input
                                type="number" min="0" step="1" placeholder="Recv"
                                title="Empties received from supplier (delivered with the goods)"
                                value={item.containers_received}
                                onChange={e => updateItem(idx, 'containers_received', e.target.value)}
                                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 8px', border: '1px solid #fde68a', borderRadius: 5, fontSize: 12, textAlign: 'right', background: '#fff' }}
                              />
                            </td>
                            <td style={{ padding: '4px 8px 10px' }}>
                              <input
                                type="number" min="0" step="0.01" placeholder="Deposit"
                                title={`Deposit per empty (${curSym}). Default is set in Profile.`}
                                value={item.container_deposit}
                                onChange={e => updateItem(idx, 'container_deposit', e.target.value)}
                                style={{ width: '100%', boxSizing: 'border-box', padding: '7px 8px', border: '1px solid #fde68a', borderRadius: 5, fontSize: 12, textAlign: 'right', background: '#fff' }}
                              />
                            </td>
                            <td style={{ padding: '4px 8px 10px' }}>
                              <div style={{ width: '100%', boxSizing: 'border-box', padding: '7px 8px', border: '1px solid #fde68a', borderRadius: 5, fontSize: 12, textAlign: 'right', background: '#fef3c7', color: '#92400e', fontWeight: 600 }}>
                                {(recv * (parseFloat(item.container_deposit)||0)).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                              </div>
                            </td>
                            <td colSpan={3} style={{ padding: '4px 8px 10px', fontSize: 11, color: '#a16207' }}>
                              {recv > 0 && `+${recv} new crates added to stock — to return empties later, use Credit Notes`}
                            </td>
                          </tr>
                        )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>

                {/* Grand Total */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 24, marginTop: 12, paddingTop: 12, borderTop: '2px solid #e5e7eb', flexWrap: 'wrap' }}>
                  {containerTotal !== 0 && (
                    <>
                      <span style={{ fontSize: 12, color: '#6b7280' }}>
                        Beverages: <strong style={{ color: '#374151' }}>{curSym}{(parseFloat(beverageTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong>
                      </span>
                      <span style={{ fontSize: 12, color: '#92400e' }}>
                        Containers: <strong>{containerTotal < 0 ? '−' : '+'}{curSym}{(parseFloat(Math.abs(containerTotal))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong>
                      </span>
                    </>
                  )}
                  <span style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>{t('amount')}:</span>
                  <span style={{ fontWeight: 700, fontSize: 18, color: '#16a34a' }}>{curSym}{(parseFloat(totalAmount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                </div>
              </div>
            </div>

            {/* v1.9.17 — Per-reason CN tab panels. Each tab shows the form
                matching that reason (Discount/Other = amount + notes,
                Crate/Goods Return = items table) plus a list of CNs
                already queued for that reason. + Add Credit Note pushes
                the draft into creditNotes[]; real POST happens on Save GRN. */}
            {linkedPurchaseSyncId && ['Discount', 'Crate Return', 'Goods Return', 'Other'].includes(activeTab) && (() => {
              const reason = activeTab;
              const defaultDep = parseFloat(businessInfo?.default_crate_deposit || 0);
              const hasItems = CN_REASON_HAS_ITEMS(reason);
              const draftTotal = hasItems
                ? cnDraftItems.reduce((s, r) => s + (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_value) || 0), 0)
                : (parseFloat(cnDraftAmount) || 0);
              const rs = cnReasonStyle(reason);

              const updateCnRow = (idx, field, value) => {
                setCnDraftItems(prev => {
                  const next = [...prev];
                  const oldConv = parseFloat(prev[idx].unit_conv) || 1;
                  const oldProductId = prev[idx].product_id;
                  next[idx] = { ...next[idx], [field]: value };
                  if (field === 'product_text') {
                    const m = products.find(p => p.name.toLowerCase() === value.trim().toLowerCase());
                    next[idx].product_id = m ? String(m.id) : '';
                    if (m) {
                      const picked = cnPickProductUnit(m);
                      next[idx].unit = picked.name;
                      next[idx].unit_conv = picked.conv;
                      if (String(m.id) !== String(oldProductId)) {
                        const suggested = cnProductUnitValue(m, defaultDep, reason, picked.conv);
                        next[idx].unit_value = suggested || '';
                      }
                    } else {
                      next[idx].unit = '';
                      next[idx].unit_conv = 1;
                    }
                  }
                  if (field === 'unit') {
                    const p = products.find(pp => String(pp.id) === String(next[idx].product_id));
                    const units = p ? unitsForProductFE(p) : [];
                    const picked = units.find(u => u.name === value) || { name: value, conv: 1 };
                    const newConv = parseFloat(picked.conv) || 1;
                    next[idx].unit_conv = newConv;
                    const curVal = parseFloat(next[idx].unit_value || 0);
                    if (curVal > 0 && oldConv > 0) {
                      next[idx].unit_value = ((curVal / oldConv) * newConv).toFixed(2);
                    }
                  }
                  return next;
                });
              };

              const addCnRow    = () => setCnDraftItems(prev => [...prev, cnEmptyItem(reason === 'Crate Return' ? defaultDep : '')]);
              const removeCnRow = (idx) => setCnDraftItems(prev => prev.length === 1 ? [cnEmptyItem(reason === 'Crate Return' ? defaultDep : '')] : prev.filter((_, i) => i !== idx));

              const queueCN = () => {
                setCnDraftError('');
                if (hasItems) {
                  const valid = cnDraftItems.filter(cnIsRowComplete);
                  if (valid.length === 0) { setCnDraftError('Add at least one product line.'); return; }
                  const amt = valid.reduce((s, r) => s + parseFloat(r.quantity) * parseFloat(r.unit_value || 0), 0);
                  if (!(amt > 0)) { setCnDraftError('Amount must be greater than zero.'); return; }
                  setCreditNotes(arr => [...arr, {
                    reason,
                    amount: amt,
                    notes: cnDraftNotes || '',
                    items: valid.map(r => ({
                      product_id: parseInt(r.product_id),
                      quantity: parseFloat(r.quantity),
                      unit_value: parseFloat(r.unit_value),
                      unit: r.unit || null,
                      unit_conv: parseFloat(r.unit_conv) > 0 ? parseFloat(r.unit_conv) : 1,
                      product_name: r.product_text,
                    })),
                  }]);
                  setCnDraftItems([cnEmptyItem(reason === 'Crate Return' ? defaultDep : '')]);
                } else {
                  const amt = parseFloat(cnDraftAmount);
                  if (!(amt > 0)) { setCnDraftError('Amount must be greater than zero.'); return; }
                  setCreditNotes(arr => [...arr, { reason, amount: amt, notes: cnDraftNotes || '' }]);
                  setCnDraftAmount('');
                }
                setCnDraftNotes('');
              };

              return (
                <div style={{ padding: '20px 24px' }}>
                  {/* Contextual help banner (matches /accounting/credit-notes) */}
                  {reason === 'Crate Return' && (
                    <div style={{ marginBottom: 14, padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 12, color: '#1e3a8a' }}>
                      <strong>Note:</strong> Crate Returns are deposit refunds — covers any returnable container (crates, empty bottles, kegs). They reduce AP balance and move empty stock, but do <strong>not</strong> appear on the Profit Report (they're not income).
                    </div>
                  )}
                  {reason === 'Goods Return' && (
                    <div style={{ marginBottom: 14, padding: '10px 14px', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 8, fontSize: 12, color: '#9a3412' }}>
                      <strong>Note:</strong> Goods Returns reverse a purchase — pick the actual product going back to the supplier (damaged, wrong, or excess). Stock leaves your store at the avg cost price; AP balance drops by the same amount. Does <strong>not</strong> appear on the Profit Report (it's a reversal, not income).
                    </div>
                  )}

                  {/* Reference (read-only, auto-linked to this GRN's PO) */}
                  <div style={{ marginBottom: 14 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 4 }}>Reference</label>
                    <div style={{ padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#f9fafb', fontSize: 13, color: '#374151' }}>
                      {linkedPurchaseNumber || '—'}
                    </div>
                  </div>

                  {/* Either Amount OR items table */}
                  {hasItems ? (
                    <>
                      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                        <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                          {reason === 'Goods Return' ? 'Items returned (goods)' : 'Items returned (crates & bottles)'}
                        </label>
                        {reason === 'Crate Return' && defaultDep > 0 && (
                          <span style={{ fontSize: 10, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '2px 8px' }}>
                            Default deposit {curSym}{defaultDep.toFixed(2)} (System Settings)
                          </span>
                        )}
                        {reason === 'Goods Return' && (
                          <span style={{ fontSize: 10, color: '#9a3412', background: '#ffedd5', border: '1px solid #fed7aa', borderRadius: 6, padding: '2px 8px' }}>
                            Unit value auto-fills from each product's avg cost
                          </span>
                        )}
                      </div>
                      <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 8, marginBottom: 8, background: '#fafafa' }}>
                        {(() => {
                          const gridCols = '2.2fr 0.7fr 0.9fr 1.0fr 1.2fr 28px';
                          return (
                            <>
                              <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, fontSize: 10, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', padding: '4px 4px 6px' }}>
                                <span>Product</span>
                                <span style={{ textAlign: 'right' }}>Qty</span>
                                <span style={{ textAlign: 'center' }}>Unit</span>
                                <span style={{ textAlign: 'right' }}>Value ({curSym})</span>
                                <span style={{ textAlign: 'right' }}>Total</span>
                                <span />
                              </div>
                              {cnDraftItems.map((r, idx) => {
                                const lineTotal = (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_value) || 0);
                                const rowProduct = products.find(pp => String(pp.id) === String(r.product_id));
                                const rowUnits = rowProduct ? unitsForProductFE(rowProduct) : [];
                                return (
                                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, alignItems: 'center', padding: '4px' }}>
                                    <input list={`grn-cn-products-${idx}`} value={r.product_text}
                                      onChange={e => updateCnRow(idx, 'product_text', e.target.value)}
                                      placeholder={reason === 'Goods Return' ? 'Product' : 'Crate or empty bottle'}
                                      style={{ padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff', minWidth: 0, boxSizing: 'border-box' }} />
                                    <datalist id={`grn-cn-products-${idx}`}>
                                      {products.map(p => <option key={p.id} value={p.name} />)}
                                    </datalist>
                                    <input type="number" min="0" step="0.01" value={r.quantity}
                                      onChange={e => updateCnRow(idx, 'quantity', e.target.value)}
                                      style={{ padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, textAlign: 'right', background: '#fff', minWidth: 0, boxSizing: 'border-box' }} />
                                    {rowUnits.length > 1 ? (
                                      <select value={r.unit || ''} onChange={e => updateCnRow(idx, 'unit', e.target.value)}
                                        style={{ padding: '7px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff', minWidth: 0, boxSizing: 'border-box' }}>
                                        {rowUnits.map(u => <option key={u.name} value={u.name}>{u.name}</option>)}
                                      </select>
                                    ) : (
                                      <span style={{ padding: '7px 6px', fontSize: 12, color: '#6b7280', textAlign: 'center', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {r.unit || (rowProduct?.unit || '')}
                                      </span>
                                    )}
                                    <input type="number" min="0" step="0.01" value={r.unit_value}
                                      onChange={e => updateCnRow(idx, 'unit_value', e.target.value)}
                                      style={{ padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, textAlign: 'right', background: '#fff', minWidth: 0, boxSizing: 'border-box' }} />
                                    <span style={{ padding: '7px 4px', fontSize: 12, fontWeight: 700, color: '#374151', textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                      {curSym}{lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </span>
                                    <button type="button" onClick={() => removeCnRow(idx)} title="Remove row"
                                      style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4 }}>
                                      <FiTrash2 size={14} />
                                    </button>
                                  </div>
                                );
                              })}
                            </>
                          );
                        })()}
                      </div>
                      <button type="button" onClick={addCnRow}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px dashed #93c5fd', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontSize: 12, fontWeight: 600, marginBottom: 12 }}>
                        <FiPlus size={12} /> Add Row
                      </button>
                    </>
                  ) : (
                    <div style={{ marginBottom: 12 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 4 }}>Amount * ({curSym})</label>
                      <input type="number" min="0" step="0.01" value={cnDraftAmount} onChange={e => setCnDraftAmount(e.target.value)}
                        placeholder="0.00"
                        style={{ width: '100%', padding: '11px 12px', border: '1.5px solid #d1d5db', borderRadius: 8, fontSize: 16, fontWeight: 700, textAlign: 'right', boxSizing: 'border-box' }} />
                    </div>
                  )}

                  {/* Notes */}
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 4 }}>Notes</label>
                    <textarea value={cnDraftNotes} onChange={e => setCnDraftNotes(e.target.value)} rows={2}
                      style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' }} />
                  </div>

                  {/* AP preview */}
                  <div style={{ marginBottom: 12, padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 12, color: '#1e3a8a' }}>AP balance to supplier will go down by:</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#1d4ed8' }}>
                      {curSym}{draftTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>

                  {cnDraftError && (
                    <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#991b1b', fontWeight: 600 }}>
                      {cnDraftError}
                    </div>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 18 }}>
                    <button type="button" onClick={queueCN}
                      style={{ padding: '10px 20px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <FiPlus size={14} /> Add Credit Note
                    </button>
                  </div>

                  {/* Already-queued CNs for this reason */}
                  {cnCountByReason(reason) > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <h5 style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                        Queued {reason} ({cnCountByReason(reason)})
                      </h5>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                        <thead style={{ background: '#f8fafc' }}>
                          <tr>
                            <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Notes</th>
                            <th style={{ padding: '8px 10px', textAlign: 'left', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Items</th>
                            <th style={{ padding: '8px 10px', textAlign: 'right', fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>Amount</th>
                            <th style={{ padding: '8px 10px' }}></th>
                          </tr>
                        </thead>
                        <tbody>
                          {creditNotes.map((c, idx) => c.reason !== reason ? null : (
                            <tr key={idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '8px 10px', color: '#374151' }}>{c.notes || '—'}</td>
                              <td style={{ padding: '8px 10px', color: '#6b7280', fontSize: 12 }}>
                                {c.items?.length ? c.items.map(it => `${it.quantity}×${it.product_name || ''}`).join(', ') : '—'}
                              </td>
                              <td style={{ padding: '8px 10px', textAlign: 'right', color: rs.color, fontWeight: 700 }}>−{curSym}{(parseFloat(c.amount)||0).toFixed(2)}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                                <button onClick={() => setCreditNotes(arr => arr.filter((_, i) => i !== idx))}
                                  style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', fontSize: 16 }} title="Remove">×</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* v1.9.17 — Summary tab panel — shows GRN totals + CN breakdown by reason. */}
            {linkedPurchaseSyncId && activeTab === 'summary' && (
              <div style={{ padding: '20px 24px' }}>
                <h4 style={{ margin: '0 0 14px', fontSize: 15 }}>Review &amp; Submit</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, fontSize: 13, color: '#374151' }}>
                  <div><span style={{ color: '#6b7280' }}>From PO:</span> <strong>{linkedPurchaseNumber || '—'}</strong></div>
                  <div><span style={{ color: '#6b7280' }}>Supplier Invoice #:</span> <strong>{supplierInvoiceNumber || '—'}</strong></div>
                  <div><span style={{ color: '#6b7280' }}>Date:</span> <strong>{date}</strong></div>
                  <div><span style={{ color: '#6b7280' }}>Items:</span> <strong>{items.filter(i => i.product_id && parseFloat(i.quantity) > 0).length}</strong></div>
                </div>
                <div style={{ marginTop: 22, padding: 18, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 14 }}>
                    <span>Items subtotal</span>
                    <strong>{curSym}{(parseFloat(totalAmount)||0).toFixed(2)}</strong>
                  </div>
                  {['Discount', 'Crate Return', 'Goods Return', 'Other'].map(r => {
                    const sum = cnSumByReason(r);
                    if (sum <= 0) return null;
                    return (
                      <div key={r} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0 4px 14px', fontSize: 13, color: '#dc2626' }}>
                        <span>− {r} CN</span>
                        <span>−{curSym}{sum.toFixed(2)}</span>
                      </div>
                    );
                  })}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 0 0', marginTop: 6, borderTop: '2px solid #e5e7eb', fontSize: 16, fontWeight: 700 }}>
                    <span>Final Payable to Supplier</span>
                    <span style={{ color: '#16a34a' }}>{curSym}{Math.max(0, (parseFloat(totalAmount)||0) - cnTotal).toFixed(2)}</span>
                  </div>
                </div>
                <p style={{ marginTop: 14, fontSize: 12, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', padding: '10px 14px', borderRadius: 8 }}>
                  On Save: this GRN is sent to HQ for confirmation. Stock posts to the sales floor only after HQ confirms.
                </p>
              </div>
            )}

            {/* Save error + Actions (always visible regardless of tab) */}
            <div style={{ padding: '0 24px 20px' }}>
              {error && (
                <div style={{ background: '#fee2e2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
                  {error}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => setShowForm(false)} style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>
                  {t('cancel')}
                </button>
                <button onClick={handleSave} disabled={saving} style={{ padding: '10px 28px', background: saving ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
                  {saving ? t('saving') : editMode ? 'Update GRN' : `${t('save')} GRN`}
                </button>
              </div>
            </div>
          </div>

        </div>
      ), document.body)}

      {/* ── Print Preview ─────────────────────────────────────────── */}
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
                Print Preview — Goods Received Notes ({filteredGRNs.length} records)
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
            <div style={{ background: 'linear-gradient(135deg, #14532d 0%, #16a34a 100%)', padding: '28px 44px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>
                  {businessInfo.business_name || 'Business Name'}
                </div>
                <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.7 }}>
                  {[businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  |  ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.65, marginBottom: 6 }}>
                  Goods Received Notes
                </div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  {hasFilter
                    ? `${filterFrom ? formatDate(filterFrom) : 'All'} — ${filterTo ? formatDate(filterTo) : 'All'}`
                    : formatDateLong(todayStr)}
                </div>
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>

            {/* Accent bar */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #22c55e, #2563eb)' }} />

            {/* Body */}
            <div style={{ padding: '26px 44px 36px' }}>

              {/* Summary chips */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Total GRNs (All)',  value: stats.totalGRNs, bg: '#f0fdf4', color: '#15803d', border: '#86efac' },
                  { label: 'This Month',         value: stats.thisMonth, bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
                  { label: filteredGRNs.length === grns.length ? 'Total Amount' : 'Filtered Amount',
                    value: '$' + filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 }),
                    bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
                  { label: 'Suppliers',           value: stats.suppliers, bg: '#faf5ff', color: '#7e22ce', border: '#d8b4fe' },
                ].map(chip => (
                  <div key={chip.label} style={{ padding: '12px 16px', borderRadius: 10, background: chip.bg, border: `1.5px solid ${chip.border}`, textAlign: 'center' }}>
                    <div style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 600, marginBottom: 6 }}>{chip.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: chip.color }}>{chip.value}</div>
                  </div>
                ))}
              </div>

              {/* GRN Table */}
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                <div style={{ background: '#f8fafc', borderBottom: '1.5px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#16a34a', display: 'inline-block' }} />
                    <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#475569' }}>
                      GRN Records
                    </span>
                  </div>
                  {hasFilter && (
                    <span style={{ fontSize: 10.5, color: '#64748b' }}>
                      {filterFrom ? formatDate(filterFrom) : '—'}  to  {filterTo ? formatDate(filterTo) : '—'}
                    </span>
                  )}
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['#', 'GRN Number', 'Date', 'Supplier', 'Items', 'Total Amount', 'Status'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: i >= 4 ? 'right' : 'left', fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb', fontSize: 10.5, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredGRNs.map((grn, idx) => {
                      const grnItems = printItemsMap[grn.id] || [];
                      return (
                        <React.Fragment key={grn.id}>
                          <tr style={{ background: idx % 2 === 1 ? '#f0fdf4' : '#fff', borderTop: idx > 0 ? '2px solid #e2e8f0' : 'none' }}>
                            <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10.5 }}>{idx + 1}</td>
                            <td style={{ padding: '8px 12px', fontWeight: 700, fontFamily: 'monospace', fontSize: 11, color: '#1d4ed8' }}>{grn.grn_number}</td>
                            <td style={{ padding: '8px 12px', color: '#374151' }}>{formatDate(grn.date || grn.created_at)}</td>
                            <td style={{ padding: '8px 12px', fontWeight: 500 }}>{grn.supplier_name || '—'}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#374151' }}>{grn.total_items}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#15803d' }}>
                              {curSym}{parseFloat(grn.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                              {/* v1.9.21 — Print preview honors HQ lifecycle for HQ-linked GRNs. */}
                              {grn.linked_purchase_sync_id ? (() => { const s = hqStatusBadge(grn.hq_status); return (
                                <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 10, fontWeight: 600,
                                  background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
                                  {s.label}
                                </span>
                              ); })() : (() => { const s = paymentStatusStyle(grn.payment_status); return (
                                <span style={{ padding: '2px 10px', borderRadius: 12, fontSize: 10, fontWeight: 600,
                                  background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>
                                  {grn.payment_status || 'Not Paid'}
                                </span>
                              ); })()}
                            </td>
                          </tr>
                          {grnItems.length > 0 && (
                            <tr style={{ background: '#f8fafc' }}>
                              <td colSpan={7} style={{ padding: '0 12px 10px 32px' }}>
                                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10.5 }}>
                                  <thead>
                                    <tr style={{ background: '#e2e8f0' }}>
                                      <th style={{ padding: '5px 10px', textAlign: 'left', color: '#475569', fontWeight: 600 }}>Product</th>
                                      <th style={{ padding: '5px 10px', textAlign: 'right', color: '#475569', fontWeight: 600 }}>Qty</th>
                                      <th style={{ padding: '5px 10px', textAlign: 'right', color: '#475569', fontWeight: 600 }}>Unit Cost</th>
                                      <th style={{ padding: '5px 10px', textAlign: 'right', color: '#475569', fontWeight: 600 }}>Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {grnItems.map((item, i) => (
                                      <tr key={i} style={{ borderBottom: '1px solid #e5e7eb' }}>
                                        <td style={{ padding: '5px 10px', color: '#111827', fontWeight: 500 }}>{item.product_name}</td>
                                        <td style={{ padding: '5px 10px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>{parseFloat(item.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                        <td style={{ padding: '5px 10px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>${parseFloat(item.unit_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                        <td style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 600, color: '#15803d', fontFamily: 'monospace' }}>${parseFloat(item.total_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
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
                    <tr style={{ background: '#f0fdf4', borderTop: '2px solid #86efac' }}>
                      <td colSpan={4} style={{ padding: '10px 12px', fontWeight: 700, fontSize: 11.5, color: '#14532d' }}>
                        TOTAL — {filteredGRNs.length} GRN{filteredGRNs.length !== 1 ? 's' : ''}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontSize: 11, color: '#374151' }}>
                        {filteredGRNs.reduce((s, g) => s + parseInt(g.total_items || 0), 0)} items
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13, fontFamily: 'monospace', color: '#15803d' }}>
                        ${filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Footer */}
              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>{businessInfo.business_name || 'Business'} — Confidential</span>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>
                  Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Print styles ──────────────────────────────────────────── */}
      <style>{`
        @media print {
          .no-print { display: none !important; }

          /* GRN list print preview */
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

      {/* ── GRN Single-Record Print Preview ───────────────────────── */}
      {false && viewGRN && showGRNPrint && (
        <div
          className="print-preview-overlay"
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.88)', zIndex: 2000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}
        >
          {/* Toolbar */}
          <div
            className="no-print"
            style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 2001, borderBottom: '1px solid #1e293b' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={15} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>
                Print Preview — {viewGRN.grn_number}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                <FiPrinter size={14} /> Print
              </button>
              <button onClick={() => setShowGRNPrint(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}>
                <FiX size={14} /> Close
              </button>
            </div>
          </div>

          {/* A4 Document */}
          <div
            id="print-document"
            style={{ width: 794, background: '#fff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}
          >
            {/* ── Green gradient header ── */}
            <div style={{ background: 'linear-gradient(135deg, #14532d 0%, #166534 50%, #16a34a 100%)', padding: '30px 44px 24px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 8, letterSpacing: 3, textTransform: 'uppercase', opacity: 0.6, marginBottom: 8 }}>Goods Received Note</div>
                <div style={{ fontSize: 23, fontWeight: 800, letterSpacing: 0.3, marginBottom: 6 }}>
                  {businessInfo.business_name || 'Business Name'}
                </div>
                <div style={{ fontSize: 10.5, opacity: 0.7, lineHeight: 1.8 }}>
                  {[businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  ·  ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.55, marginBottom: 8 }}>Document No.</div>
                <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: 1, fontFamily: 'monospace' }}>{viewGRN.grn_number}</div>
                <div style={{ marginTop: 10, display: 'inline-block', padding: '3px 12px', borderRadius: 20, fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                  background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.35)', color: '#fff' }}>
                  {viewGRN.payment_status || 'Not Paid'}
                </div>
              </div>
            </div>

            {/* Accent bar */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #22c55e, #2563eb, #a855f7)' }} />

            {/* Body */}
            <div style={{ padding: '28px 44px 40px' }}>

              {/* Info cards row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 26 }}>
                {[
                  { label: 'Supplier',     value: viewGRN.supplier_name || '—',                           icon: '🏢', bg: '#f0fdf4', border: '#86efac', color: '#15803d' },
                  { label: 'Received Date', value: formatDate(viewGRN.date || viewGRN.created_at),         icon: '📅', bg: '#eff6ff', border: '#bfdbfe', color: '#1d4ed8' },
                  { label: 'Total Items',   value: `${viewGRN.total_items} line${viewGRN.total_items !== 1 ? 's' : ''}`, icon: '📦', bg: '#fff7ed', border: '#fed7aa', color: '#c2410c' },
                ].map(card => (
                  <div key={card.label} style={{ padding: '12px 16px', borderRadius: 10, background: card.bg, border: `1.5px solid ${card.border}` }}>
                    <div style={{ fontSize: 9, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 600, marginBottom: 5 }}>{card.label}</div>
                    <div style={{ fontSize: 13.5, fontWeight: 700, color: card.color }}>{card.value}</div>
                  </div>
                ))}
              </div>

              {/* Items table */}
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                {/* Table header bar */}
                <div style={{ background: '#14532d', padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#4ade80', display: 'inline-block' }} />
                  <span style={{ fontWeight: 700, fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#d1fae5' }}>Items Received</span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ background: '#f0fdf4' }}>
                      <th style={{ padding: '9px 14px', textAlign: 'left',  fontWeight: 700, color: '#166534', borderBottom: '1.5px solid #86efac', fontSize: 10.5, letterSpacing: 0.3, width: 30 }}>#</th>
                      <th style={{ padding: '9px 14px', textAlign: 'left',  fontWeight: 700, color: '#166534', borderBottom: '1.5px solid #86efac', fontSize: 10.5, letterSpacing: 0.3 }}>Product</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: '#166534', borderBottom: '1.5px solid #86efac', fontSize: 10.5, letterSpacing: 0.3 }}>Quantity</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: '#166534', borderBottom: '1.5px solid #86efac', fontSize: 10.5, letterSpacing: 0.3 }}>Unit Cost ({curSym})</th>
                      <th style={{ padding: '9px 14px', textAlign: 'right', fontWeight: 700, color: '#166534', borderBottom: '1.5px solid #86efac', fontSize: 10.5, letterSpacing: 0.3 }}>Line Total ({curSym})</th>
                      <th style={{ padding: '9px 14px', textAlign: 'left',  fontWeight: 700, color: '#166534', borderBottom: '1.5px solid #86efac', fontSize: 10.5, letterSpacing: 0.3 }}>Expiry Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(viewGRN.items || []).map((item, idx) => (
                      <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                        <td style={{ padding: '10px 14px', color: '#9ca3af', fontSize: 10.5 }}>{idx + 1}</td>
                        <td style={{ padding: '10px 14px', fontWeight: 600, color: '#111827' }}>{item.product_name}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#374151' }}>{parseFloat(item.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontFamily: 'monospace', color: '#374151' }}>{parseFloat(item.unit_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#15803d' }}>{parseFloat(item.total_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        <td style={{ padding: '10px 14px', color: '#374151', fontSize: 10.5 }}>{item.expiry_date || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f0fdf4', borderTop: '2px solid #86efac' }}>
                      <td colSpan={5} style={{ padding: '12px 14px', fontWeight: 800, fontSize: 12, color: '#14532d', letterSpacing: 0.5 }}>GRAND TOTAL</td>
                      <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 900, fontSize: 16, fontFamily: 'monospace', color: '#15803d' }}>
                        {viewMoney(viewGRN.total_amount || 0)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Notes */}
              {viewGRN.notes && (
                <div style={{ padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 11.5, color: '#78350f', marginBottom: 24 }}>
                  <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 9.5, letterSpacing: 0.8, marginRight: 8, color: '#92400e' }}>Notes</span>
                  {viewGRN.notes}
                </div>
              )}

              {/* Signature section */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 24, marginTop: 44 }}>
                {['Prepared By', 'Received By', 'Approved By'].map(label => (
                  <div key={label} style={{ textAlign: 'center' }}>
                    <div style={{ height: 40, borderBottom: '1.5px solid #cbd5e1', marginBottom: 6 }} />
                    <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#6b7280' }}>{label}</div>
                    <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 2 }}>Name / Signature / Date</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Footer bar */}
            <div style={{ background: '#f8fafc', borderTop: '1px solid #e2e8f0', padding: '10px 44px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: '#94a3b8' }}>{businessInfo.business_name || 'Business'} — Confidential Document</span>
              <span style={{ fontSize: 9, color: '#94a3b8' }}>
                Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
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

export default GRN;
