import React, { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  getCreditNotes, getCreditNoteStats, getCreditNote,
  createCreditNote, updateCreditNote, deleteCreditNote,
  getProducts, getSuppliers, getHqSuppliers, getSettings, getLinkableGrns, confirmCreditNote,
  getCreditNoteGrnLines, getCreditNoteLastPrices, isHqHost,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';

// 2026-09-14 — "Kelete Distribution - KABWE" / "Kabwe Depo" → "Kabwe".
const depotLabel = (name) => (name
  ? String(name).split(/\s+-\s+/).pop().replace(/\s+Depo$/i, '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
  : '—');

// A labelled fact in the View pop-up.
function Fact({ label, value, mono }) {
  return (
    <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 13, color: '#111827', fontWeight: 600, marginTop: 2, fontFamily: mono ? 'monospace' : 'inherit', overflowWrap: 'anywhere' }}>{value}</div>
    </div>
  );
}
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { unitsForProduct } from '../utils/productUnits';
import ItemPicker from '../components/ItemPicker';
import {
  FiPlus, FiTag, FiCalendar, FiUsers, FiDollarSign,
  FiX, FiTrash2, FiEye, FiEdit2, FiPrinter, FiChevronRight, FiChevronDown, FiChevronUp,
} from 'react-icons/fi';

// Crates and bottles share one reason — both are returnable containers.
// Goods Return is for the actual purchased product going back (damaged, wrong,
// excess). All three "with items" reasons reduce AP balance and move stock,
// but Profit Report only counts Discount + Other as income (Supplier Rebate);
// returns net to zero (stock and cash both leave / come back together).
const REASONS = ['Discount', 'Crate Return', 'Goods Return', 'Other'];
const reasonHasItems = (r) => r === 'Crate Return' || r === 'Goods Return';
const reasonAffectsProfit = (r) => r === 'Discount' || r === 'Other';

const reasonStyle = (r) => {
  switch (r) {
    case 'Discount':      return { bg: '#dcfce7', color: '#166534', border: '#86efac' };
    case 'Crate Return':  return { bg: '#dbeafe', color: '#1d4ed8', border: '#bfdbfe' };
    case 'Goods Return':  return { bg: '#ffedd5', color: '#9a3412', border: '#fed7aa' };
    default:              return { bg: '#f3f4f6', color: '#374151', border: '#d1d5db' };
  }
};

const todayStr = new Date().toISOString().split('T')[0];
const emptyItem = (dep = '') => ({ product_id: '', product_text: '', quantity: '', unit_value: dep ? String(dep) : '', unit: '', unit_conv: 1 });
const isRowComplete = (r) => r.product_id !== '' && parseFloat(r.quantity) > 0 && parseFloat(r.unit_value) >= 0;

// A product is a returnable container if its category name mentions one.
// Used by Crate Return to seed the row's unit value from the default deposit.
const isCrateProduct = (p) => {
  const cat = (p?.category_name || '').toLowerCase();
  return cat.includes('crate') || cat.includes('bottle') || cat.includes('container') || cat.includes('empty');
};
// Pick the product's preferred unit (default_unit, else base). Returns
// { name, conv } — conv is the base-unit count for one of the picked unit
// (e.g. one "Crate" of a 12-pack → conv = 12).
const pickProductUnit = (p) => {
  if (!p) return { name: '', conv: 1 };
  const units = unitsForProduct(p);
  const wanted = p.default_unit || p.unit || '';
  const found = units.find(u => u.name === wanted) || units.find(u => u.is_base) || units[0] || { name: wanted, conv: 1 };
  return { name: found.name || wanted, conv: parseFloat(found.conv) || 1 };
};
// Pick the right unit value for a row.
// 2026-09-12 — a returnable container is worth its deposit whatever the reason
// on the note (the deposit is per physical crate, already per-picked-unit).
// Goods Return is now the only reason the form offers, so crates and empty
// bottles come back through it and must still seed at the deposit rather than
// at the container's own cost price. Everything else is cost × conv.
const productUnitValue = (p, defaultDep, reason, conv = 1) => {
  if (!p) return '';
  const c = parseFloat(conv) > 0 ? parseFloat(conv) : 1;
  if (isCrateProduct(p)) return defaultDep ? String(defaultDep) : '';
  const avg = parseFloat(p.avg_cost_price || p.cost_price || 0);
  return avg > 0 ? (avg * c).toFixed(2) : '';
};
// 2026-09-11 — a price from an invoice line (VAT inclusive ÷ qty, per the
// line's own unit), expressed per the unit picked on the credit note. An
// invoice unit the product does not know is taken to be the picked unit.
const unitConvOf = (p, unitName, fallback) => {
  const u = unitsForProduct(p).find(x => (x.name || '').toLowerCase() === String(unitName || '').toLowerCase());
  return u ? (parseFloat(u.conv) || 1) : fallback;
};
const invoicePriceFor = (p, line, conv) => {
  const c = parseFloat(conv) > 0 ? parseFloat(conv) : 1;
  const v = (parseFloat(line.unit_price) || 0) / unitConvOf(p, line.unit, c) * c;
  return v > 0 ? v.toFixed(2) : '';
};
// Names are matched trimmed and case-blind: stored names carry stray spaces.
const nameKey = (s) => String(s || '').trim().toLowerCase();
const fmtQty = (q) => { const n = parseFloat(q) || 0; return n % 1 === 0 ? n.toFixed(0) : n.toFixed(2); };

const formatDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const CreditNotes = () => {
  const { hasPermission, user: authUser } = useAuth();
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  // URL params let other pages (GRN list, GRN view modal) deep-link into the
  // "New Credit Note" form pre-filled with their supplier / reference / reason.
  // Pattern: /accounting/credit-notes?new=1&supplier=<id>&reference=<text>&reason=<Discount|Other|...>
  const [searchParams, setSearchParams] = useSearchParams();

  const [stats, setStats]         = useState({ totalCreditNotes: 0, thisMonth: 0, totalValue: 0, byReason: [] });
  const [list, setList]           = useState([]);
  const [products, setProducts]   = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [toast, setToast]         = useState(null);
  // Pre-fill empty-container deposit from System Settings. Same source the
  // GRN form uses, so cashiers don't have to retype the deposit every time.
  const [defaultDeposit, setDefaultDeposit] = useState(0);
  // Captured for the print report header (business name + address + phone).
  const [businessInfo, setBusinessInfo] = useState({});
  // Two views over the same filtered list: per-document vs. per-supplier rollup.
  const [tab, setTab] = useState('byDocument'); // 'byDocument' | 'bySupplier'
  // When the user clicks a supplier name in the bySupplier rollup, we open a
  // drill-down modal listing that supplier's CNs grouped by reason.
  const [supplierDetail, setSupplierDetail] = useState(null); // supplier_name string
  // Per-CN expand state inside the supplier drill-down modal. Items are
  // lazy-loaded on first expand and cached so re-toggling is instant. Print
  // includes the breakdown of whichever CNs are currently expanded.
  const [expandedCNs, setExpandedCNs] = useState(() => new Set());
  const [cnItemsCache, setCnItemsCache] = useState({}); // { [cn.id]: { items, notes, loading } }

  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo]     = useState('');
  const [filterReason, setFilterReason] = useState('All');

  const [showForm, setShowForm]     = useState(false);
  const [editMode, setEditMode]     = useState(false);
  const [editId, setEditId]         = useState(null);
  const [viewCN, setViewCN]         = useState(null);
  // 2026-09-14 — HQ sees every depot's notes (Depot column) and is the only
  // side that confirms them.
  const onHq = isHqHost();
  const [viewLoading, setViewLoading] = useState(false);

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(showForm || !!viewCN || !!supplierDetail);

  const [supplierId, setSupplierId] = useState('');
  const [date, setDate]             = useState(todayStr);
  const [reason, setReason]         = useState('Discount');
  const [reference, setReference]   = useState('');
  // 2026-09-04 — the GRN this credit is against. Sending grn_sync_id is what
  // turns a note that merely lowers the supplier's overall balance into one
  // that reduces a specific payable, which is what a damaged delivery needs.
  const [grnSyncId, setGrnSyncId]   = useState('');
  // 2026-09-18 — the invoice an edited note is already attached to, shown
  // locked. null while adding a new note.
  const [editInvoice, setEditInvoice] = useState(null);
  // The note's own VAT, kept only on notes raised at goods-receive. 0 otherwise.
  const [editVat, setEditVat] = useState(0);
  const [linkable, setLinkable]     = useState([]);
  const [amount, setAmount]         = useState('');
  const [notes, setNotes]           = useState('');
  const [items, setItems]           = useState([emptyItem()]);
  // 2026-09-11 — the chosen invoice's lines, and each item's price on the
  // last invoice that delivered it. Both VAT inclusive ÷ qty.
  const [grnLines, setGrnLines]     = useState([]);
  const [lastPrices, setLastPrices] = useState([]);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchAll = async () => {
    try {
      const [listRes, statsRes] = await Promise.all([
        getCreditNotes({ from: filterFrom || undefined, to: filterTo || undefined, reason: filterReason !== 'All' ? filterReason : undefined }),
        getCreditNoteStats(),
      ]);
      setList(listRes.data || []);
      setStats(statsRes.data || { totalCreditNotes: 0, thisMonth: 0, totalValue: 0, byReason: [] });
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load credit notes.', 'error'); }
  };

  useEffect(() => {
    fetchAll();
    getProducts().then(r => setProducts((r.data || []).sort((a, b) => a.name.localeCompare(b.name)))).catch(() => {});
    // 2026-09-06 — HQ's supplier list, not the depot's own. Suppliers are
    // HQ-only, so a depot's table is empty and the box had nothing to offer -
    // which mattered most for a credit with NO invoice, where picking the
    // supplier is the only way to say who owes it. A depot's note is written
    // into HQ's book anyway, so HQ's list is the right one to choose from.
    // Falls back to the local table if the HQ route is unreachable.
    const sortByName = (rows) => (rows || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    getHqSuppliers()
      .then(r => {
        const rows = r.data?.suppliers || [];
        if (rows.length) { setSuppliers(sortByName(rows)); return; }
        return getSuppliers().then(x => setSuppliers(sortByName(x.data)));
      })
      .catch(() => { getSuppliers().then(x => setSuppliers(sortByName(x.data))).catch(() => {}); });
    getSettings().then(r => {
      setBusinessInfo(r.data?.business || {});
      const dep = parseFloat(r.data?.business?.default_crate_deposit || 0);
      if (dep > 0) setDefaultDeposit(dep);
    }).catch(() => {});
  }, []);

  useEffect(() => { fetchAll(); }, [filterFrom, filterTo, filterReason]);

  // Reset per-row expand state whenever the supplier-detail modal opens or
  // closes. Cache is purged too so the next open sees fresh data.
  useEffect(() => {
    if (!supplierDetail) {
      setExpandedCNs(new Set());
      setCnItemsCache({});
    }
  }, [supplierDetail]);

  // Lazy-fetch a CN's full record (items + notes) on first expand. Cached
  // by id so toggling open/closed doesn't re-hit the server.
  const ensureCNLoaded = async (cn) => {
    if (cnItemsCache[cn.id]?.items !== undefined) return cnItemsCache[cn.id];
    setCnItemsCache(prev => ({ ...prev, [cn.id]: { ...(prev[cn.id] || {}), loading: true } }));
    try {
      const res = await getCreditNote(cn.id);
      const entry = { items: res.data.items || [], notes: res.data.notes || '', loading: false };
      setCnItemsCache(prev => ({ ...prev, [cn.id]: entry }));
      return entry;
    } catch (e) {
      const entry = { items: [], notes: '', loading: false, error: e.message };
      setCnItemsCache(prev => ({ ...prev, [cn.id]: entry }));
      return entry;
    }
  };
  const toggleExpand = (cn) => {
    setExpandedCNs(prev => {
      const next = new Set(prev);
      if (next.has(cn.id)) next.delete(cn.id);
      else { next.add(cn.id); ensureCNLoaded(cn); }
      return next;
    });
  };
  const expandAllCNs = async (cns) => {
    setExpandedCNs(new Set(cns.map(c => c.id)));
    await Promise.all(cns.filter(c => cnItemsCache[c.id]?.items === undefined).map(ensureCNLoaded));
  };
  const collapseAllCNs = () => setExpandedCNs(new Set());

  // When the user picks Crate Return for a brand-new form, auto-fill the
  // first row with the first crate / empty-container product we can find,
  // pre-priced with the default deposit. Skipped on edit (items already
  // loaded) and skipped if the user has already started entering a row.
  useEffect(() => {
    if (!showForm || editMode || reason !== 'Crate Return') return;
    if (products.length === 0) return;
    const firstRow = items[0];
    if (!firstRow || firstRow.product_id || (firstRow.product_text || '').trim()) return;
    const crate = products.find(isCrateProduct);
    if (!crate) return;
    const picked = pickProductUnit(crate);
    setItems(prev => {
      const next = [...prev];
      next[0] = {
        ...next[0],
        product_id: String(crate.id),
        product_text: crate.name,
        unit: picked.name,
        unit_conv: picked.conv,
        unit_value: next[0].unit_value || (defaultDeposit ? String(defaultDeposit) : ''),
      };
      return next;
    });
  }, [showForm, editMode, reason, products, defaultDeposit, items]);

  // Deep-link auto-open: wait until the supplier list is loaded (so the
  // dropdown actually has the prefilled value as a real option), then open
  // the New Credit Note modal prefilled from URL params. Clear the params
  // afterwards so a refresh doesn't keep re-opening the form.
  useEffect(() => {
    const wantNew = searchParams.get('new') === '1';
    if (!wantNew || suppliers.length === 0 || showForm) return;
    const supplierParam = searchParams.get('supplier') || '';
    const referenceParam = searchParams.get('reference') || '';
    resetForm();
    if (supplierParam) setSupplierId(supplierParam);
    if (referenceParam) setReference(referenceParam);
    // 2026-09-12 — a `reason` URL param is ignored now. The form records Goods
    // Returns only, so an old bookmark can no longer mint a Discount note.
    setShowForm(true);
    setSearchParams({}, { replace: true });
  }, [searchParams, suppliers, showForm, setSearchParams]);

  // For Crate/Bottle Return: line subtotals
  const calcTotal = (rows) => rows.reduce((s, r) => s + (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_value) || 0), 0);
  // 2026-09-18 — a note raised at goods-receive carries a discount per line and
  // the note's VAT on the header, so its lines alone are NOT what the supplier
  // is credited. The preview has to show the same figure the server will save
  // (see the matching sum in routes/supplierCreditNotes.js), or Save Changes
  // looks like it is about to cut the credit. Both are 0 on a newer note.
  const editDiscount = useMemo(
    () => items.reduce((s, r) => s + (parseFloat(r.discount) || 0), 0), [items]);
  const formTotal = useMemo(() => (reasonHasItems(reason)
    ? calcTotal(items) - editDiscount + editVat
    : (parseFloat(amount) || 0)), [reason, items, amount, editDiscount, editVat]);

  // ── Form open / reset ──
  const resetForm = () => {
    setSupplierId(''); setDate(todayStr); setReason('Goods Return');
    setReference(''); setAmount(''); setNotes(''); setGrnSyncId(''); setEditInvoice(null); setEditVat(0);
    // 2026-09-12 — every new note is a Goods Return, and rows seed blank so the
    // value comes from the invoice line rather than from a guessed price.
    setItems([emptyItem('')]); setError(''); setEditMode(false); setEditId(null);
  };
  // The picker narrows to the chosen supplier — a credit belongs to one
  // supplier's invoice, and an unfiltered list of every GRN invites attaching
  // it to the wrong one.
  useEffect(() => {
    if (!showForm) return;
    const sup = suppliers.find(x => String(x.id) === String(supplierId));
    getLinkableGrns(sup?.sync_id)
      .then(r => {
        const rows = Array.isArray(r.data?.rows) ? r.data.rows : [];
        setLinkable(rows);
        // Switching supplier re-filters this list. An invoice picked before
        // the switch would otherwise stay selected in state while no longer
        // being offered, and get submitted against the wrong supplier.
        setGrnSyncId(cur => (cur && !rows.some(g => g.grn_sync_id === cur) ? '' : cur));
      })
      .catch(() => setLinkable([]));
    // eslint-disable-next-line
  }, [showForm, supplierId, suppliers]);

  // The supplier the chosen invoice belongs to. Used to fill the box in and
  // to carry the sync_id on save — suppliers are HQ-only, so a depot cannot
  // be relied on to hold a matching row id.
  const invoiceSupplier = grnSyncId
    ? (linkable.find(g => g.grn_sync_id === grnSyncId) || null)
    : null;

  // 2026-09-11 — the invoice's lines, offered first and priced as billed.
  useEffect(() => {
    if (!showForm || !grnSyncId) { setGrnLines([]); return undefined; }
    let live = true;
    getCreditNoteGrnLines(grnSyncId)
      .then(r => { if (live) setGrnLines(Array.isArray(r.data?.lines) ? r.data.lines : []); })
      .catch(() => { if (live) setGrnLines([]); });
    return () => { live = false; };
  }, [showForm, grnSyncId]);
  // …and the last-invoice price of everything else. HQ asks for the branch
  // of the invoice it is working on; a depot always gets its own.
  const invoiceBranch = invoiceSupplier?.branch_slug || '';
  useEffect(() => {
    if (!showForm) return undefined;
    let live = true;
    getCreditNoteLastPrices(invoiceBranch || undefined)
      .then(r => { if (live) setLastPrices(Array.isArray(r.data?.prices) ? r.data.prices : []); })
      .catch(() => { if (live) setLastPrices([]); });
    return () => { live = false; };
  }, [showForm, invoiceBranch]);

  // A product's line in a list, matched on sync_id and then on the name.
  const lineIn = (list, p) => (p && (
    list.find(l => l.product_sync_id && l.product_sync_id === p.sync_id)
    || list.find(l => nameKey(l.product_name) === nameKey(p.name))
  )) || null;
  const invoiceLineFor = (p) => lineIn(grnLines, p);

  // The picker's list: the invoice's items first, then everything else, so
  // an item returned that was never on this invoice can still be found.
  const pickerProducts = useMemo(() => {
    if (grnLines.length === 0) return products;
    const on = [], off = [];
    for (const p of products) (lineIn(grnLines, p) ? on : off).push(p);
    return [...on, ...off];
    // eslint-disable-next-line
  }, [products, grnLines]);
  const invoiceTag = (p) => {
    const l = invoiceLineFor(p);
    return l ? `on invoice · ${fmtQty(l.quantity)}${l.unit ? ' ' + l.unit : ''}` : null;
  };

  // What a newly picked item's value starts at. Goods Return: its line on
  // the chosen invoice, else the last invoice that delivered it, else the
  // avg cost. Crate Return keeps the deposit rule.
  const suggestValue = (p, conv) => {
    if (reason === 'Goods Return') {
      const l = invoiceLineFor(p) || lineIn(lastPrices, p);
      const v = l ? invoicePriceFor(p, l, conv) : '';
      if (v) return v;
    }
    return productUnitValue(p, defaultDeposit, reason, conv);
  };

  const openNew  = () => { resetForm(); setShowForm(true); };
  const openEdit = async (cn) => {
    try {
      const res = await getCreditNote(cn.id);
      const d = res.data;
      setEditMode(true); setEditId(d.id);
      setSupplierId(String(d.supplier_id || ''));
      setDate(d.date); setReason(d.reason);
      setReference(d.reference || ''); setAmount(String(d.amount || ''));
      setNotes(d.notes || '');
      // 2026-09-18 — the invoice a note is attached to was never loaded back,
      // so every edit opened reading "— none —" on a note that IS linked.
      // It is restored and shown locked: moving a credit to another invoice
      // changes which payable it reduces, which is its own decision, not
      // something to happen by accident while fixing a quantity.
      setGrnSyncId(d.grn_sync_id || d.proposed_grn_sync_id || '');
      setEditInvoice({
        grn: d.linked_grn_number || null,
        invoice: d.supplier_invoice_number || null,
        proposed: !d.grn_sync_id && !!d.proposed_grn_sync_id,
      });
      setEditVat(parseFloat(d.vat_amount) || 0);
      setItems(reasonHasItems(d.reason) && d.items?.length
        ? d.items.map(it => ({
            product_id: String(it.product_id || ''),
            product_text: it.product_name || '',
            quantity: String(it.quantity || ''),
            unit_value: String(it.unit_value || ''),
            unit: it.unit || '',
            unit_conv: parseFloat(it.unit_conv) > 0 ? parseFloat(it.unit_conv) : 1,
            // Carried so the preview matches what the server saves; it rides
            // with the row, so deleting the row drops its discount too.
            discount: parseFloat(it.discount) || 0,
          }))
        : [emptyItem(d.reason === 'Crate Return' ? defaultDeposit : '')]);
      setError(''); setShowForm(true);
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load credit note.', 'error'); }
  };

  // ── Item rows helpers (mirror EmptyReturns) ──
  // Crate Return seeds new rows with the default deposit (K57 from settings).
  // Goods Return / others start blank so the user isn't tricked into
  // recording a goods return at the crate-deposit price.
  const depForReason = (r) => (r === 'Crate Return' ? defaultDeposit : '');
  const updateRow = (idx, field, value) => {
    setItems(prev => {
      const next = [...prev];
      const oldConv = parseFloat(prev[idx].unit_conv) || 1;
      const oldProductId = prev[idx].product_id;
      next[idx] = { ...next[idx], [field]: value };
      if (field === 'product_text') {
        const m = products.find(p => p.name.toLowerCase() === value.trim().toLowerCase());
        next[idx].product_id = m ? String(m.id) : '';
        if (m) {
          const picked = pickProductUnit(m);
          next[idx].unit = picked.name;
          next[idx].unit_conv = picked.conv;
          // Always reprice when the user picks a different product — the old
          // product's price is meaningless for the new one. Keeps "swap to
          // another item" working correctly.
          if (String(m.id) !== String(oldProductId)) {
            const suggested = productUnitValue(m, defaultDeposit, reason, picked.conv);
            next[idx].unit_value = suggested || '';
          }
        } else {
          next[idx].unit = '';
          next[idx].unit_conv = 1;
        }
      }
      if (field === 'unit') {
        // Rescale unit_value when the user switches units, so the per-base
        // value stays constant: new = (current / oldConv) * newConv.
        const p = products.find(pp => String(pp.id) === String(next[idx].product_id));
        const units = p ? unitsForProduct(p) : [];
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
  const addRow    = () => setItems(prev => [...prev, emptyItem(depForReason(reason))]);
  const removeRow = (idx) => setItems(prev => prev.length === 1 ? [emptyItem(depForReason(reason))] : prev.filter((_, i) => i !== idx));
  // ItemPicker rows (2026-09-11). Typing only searches; a row holds a product
  // once one is chosen from the list.
  const pickRow = (idx, p) => {
    const picked = pickProductUnit(p);
    const value = suggestValue(p, picked.conv);
    setItems(prev => prev.map((r, i) => i !== idx ? r : {
      ...r, product_id: String(p.id), product_text: p.name,
      unit: picked.name, unit_conv: picked.conv, unit_value: value,
    }));
  };
  const typeRow  = (idx, text) => setItems(prev => prev.map((r, i) => i !== idx ? r : { ...r, product_text: text, product_id: '' }));
  const clearRow = (idx) => setItems(prev => prev.map((r, i) => i !== idx ? r : { ...r, product_text: '', product_id: '', unit: '', unit_conv: 1 }));

  // ── Save ──
  const save = async () => {
    setError('');
    // The invoice carries the supplier's sync_id, which is what the server
    // resolves against whichever book the note is written into.
    const supplierSyncForSave =
      (suppliers.find(x => String(x.id) === String(supplierId))?.sync_id)
      || invoiceSupplier?.supplier_sync_id
      || null;
    if (!supplierId && !supplierSyncForSave) {
      return setError('Choose the invoice, or pick a supplier.');
    }
    if (!REASONS.includes(reason)) return setError('Invalid reason.');

    let payload;
    if (reasonHasItems(reason)) {
      const validItems = items.filter(isRowComplete);
      if (validItems.length === 0) return setError('Add at least one product line.');
      payload = {
        supplier_id: supplierId ? parseInt(supplierId) : null,
        supplier_sync_id: supplierSyncForSave,
        date, reason, reference: reference || null, notes: notes || null,
        grn_sync_id: grnSyncId || null,
        items: validItems.map(r => ({
          product_id: parseInt(r.product_id),
          quantity: parseFloat(r.quantity),
          unit_value: parseFloat(r.unit_value),
          unit: r.unit || null,
          unit_conv: parseFloat(r.unit_conv) > 0 ? parseFloat(r.unit_conv) : 1,
        })),
      };
    } else {
      const amt = parseFloat(amount);
      if (!(amt > 0)) return setError('Amount must be greater than zero.');
      payload = { supplier_id: supplierId ? parseInt(supplierId) : null,
                  supplier_sync_id: supplierSyncForSave, date, reason,
                  reference: reference || null, notes: notes || null, amount: amt,
                  grn_sync_id: grnSyncId || null };
    }

    setSaving(true);
    try {
      if (editMode) await updateCreditNote(editId, payload);
      else          await createCreditNote(payload);
      setShowForm(false);
      resetForm();
      await fetchAll();
      showToast(editMode ? 'Credit note updated.' : 'Credit note saved.');
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); }
    finally { setSaving(false); }
  };

  // ── Delete ──
  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  // A depot raised it; HQ agreeing is what attaches it to the GRN and lowers
  // the payable. Until then proposed_grn_sync_id is only a claim.
  const handleConfirm = async (cn) => {
    if (!window.confirm(
      `Confirm ${cn.credit_note_number} for ${curSym}${Number(cn.amount || 0).toLocaleString(undefined,{minimumFractionDigits:2})}?

`
      + `Raised by ${cn.raised_by_name || 'a depot'}${cn.raised_by_branch ? ` at ${cn.raised_by_branch}` : ''}.
`
      + 'This reduces what we owe on the GRN it names.'
    )) return;
    try {
      const { data } = await confirmCreditNote(cn.sync_id);
      setError('');
      await fetchAll();
      window.alert(`Confirmed against ${data.grn_number}. Payable is now ${curSym}${Number(data.final_payable || 0).toLocaleString(undefined,{minimumFractionDigits:2})}.`);
    } catch (e) {
      setError(e?.response?.data?.error || 'Could not confirm.');
    }
  };

  const handleDelete = (cn) => {
    setPendingDelete({
      subject: `Credit Note ${cn.credit_note_number} — reverses AP credit + stock`,
      perform: async () => {
        try { await deleteCreditNote(cn.id); await fetchAll(); showToast('Credit note deleted.'); }
        catch (e) { showToast(e.response?.data?.error || 'Delete failed.', 'error'); }
      },
    });
  };

  // ── View ──
  const openView = async (cn) => {
    setViewLoading(true);
    try {
      const res = await getCreditNote(cn.id);
      setViewCN(res.data);
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load credit note.', 'error'); }
    finally { setViewLoading(false); }
  };

  // ── Print (A5-ish receipt window) ──
  const handlePrint = (cn) => {
    const reasonBadge = reasonStyle(cn.reason);
    const rows = (cn.items || []).map((it, i) => `
      <tr>
        <td>${i + 1}</td>
        <td>${it.product_name || ''}</td>
        <td style="text-align:right">${parseFloat(it.quantity || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        <td style="text-align:center">${it.unit || it.product_unit || ''}</td>
        <td style="text-align:right">${curSym}${parseFloat(it.unit_value || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
        <td style="text-align:right">${curSym}${parseFloat(it.total_price || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
      </tr>`).join('');
    const html = `<!DOCTYPE html><html><head><title>${cn.credit_note_number}</title><style>
      @page { size: A5; margin: 12mm; }
      body { font-family: Arial, sans-serif; color: #111; font-size: 11px; }
      h1 { margin: 0 0 4px; font-size: 16px; letter-spacing: 1px; }
      .meta { font-size: 10px; color: #555; }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; margin: 14px 0; }
      .grid div { padding: 5px 8px; background: #f6f6f6; border-radius: 4px; }
      .grid strong { display: block; font-size: 9px; letter-spacing: 0.5px; color: #555; text-transform: uppercase; }
      table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 10.5px; }
      th, td { border: 1px solid #d1d5db; padding: 4px 6px; }
      th { background: #f3f4f6; text-align: left; font-size: 10px; letter-spacing: 0.3px; }
      .total-row { background: #fef3c7; font-weight: 700; }
      .badge { display: inline-block; padding: 2px 9px; border-radius: 10px; font-size: 9px; font-weight: 700;
               background: ${reasonBadge.bg}; color: ${reasonBadge.color}; border: 1px solid ${reasonBadge.border}; }
      .notes { margin-top: 14px; padding: 8px 10px; background: #f9fafb; border-left: 3px solid #9ca3af; font-size: 10.5px; }
      .footer { margin-top: 22px; display: flex; justify-content: space-between; font-size: 10px; color: #555; }
    </style></head><body>
      <h1>SUPPLIER CREDIT NOTE</h1>
      <div class="meta">${cn.credit_note_number} · printed ${new Date().toLocaleString()}</div>
      <div class="grid">
        <div><strong>Date</strong>${formatDate(cn.date)}</div>
        <div><strong>Supplier</strong>${cn.supplier_name || '—'}</div>
        <div><strong>Reason</strong><span class="badge">${cn.reason}</span></div>
        <div><strong>Reference</strong>${cn.linked_grn_number ? (cn.linked_grn_number + (cn.linked_is_proposed ? ' (pending)' : '')) : (cn.reference || '—')}</div>
      </div>
      ${(cn.items && cn.items.length) ? `
      <table>
        <thead><tr><th style="width:24px">#</th><th>Product</th><th style="text-align:right">Qty</th><th style="text-align:center">Unit</th><th style="text-align:right">Unit Value</th><th style="text-align:right">Total</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr class="total-row"><td colspan="5" style="text-align:right">TOTAL</td><td style="text-align:right">${curSym}${parseFloat(cn.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td></tr></tfoot>
      </table>` : `
      <table>
        <tr><th>Amount</th><td style="text-align:right;font-size:13px;font-weight:700">${curSym}${parseFloat(cn.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td></tr>
      </table>`}
      ${cn.notes ? `<div class="notes"><strong>Notes:</strong> ${cn.notes}</div>` : ''}
      <div class="footer">
        <div>Prepared by: ${cn.created_by_name || '—'}</div>
        <div>Effect on AP balance: ${curSym}${parseFloat(cn.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })} credit</div>
      </div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { w.print(); }, 300);
  };

  // ── Subtotal of the currently-filtered list ─────────────────────────────
  // Updates live as the user changes date / reason filters so they can see
  // exactly how much the filter slice adds up to.
  const filteredTotal = useMemo(
    () => list.reduce((s, r) => s + parseFloat(r.amount || 0), 0),
    [list],
  );

  // ── By-Supplier rollup ──────────────────────────────────────────────────
  // Groups the same filtered list by supplier. The cashier picks "By
  // Supplier" when they want one row per ZB / Maruf etc., showing how much
  // each supplier owes in credits and split between discount vs. crate-return.
  const bySupplier = useMemo(() => {
    const map = new Map();
    for (const cn of list) {
      const key = cn.supplier_name || '— (no supplier)';
      const cur = map.get(key) || {
        supplier_name: key, count: 0, total: 0,
        discount: 0, crate_return: 0, goods_return: 0, other: 0,
      };
      cur.count += 1;
      cur.total += parseFloat(cn.amount || 0);
      if (cn.reason === 'Discount')       cur.discount     += parseFloat(cn.amount || 0);
      else if (cn.reason === 'Crate Return' || cn.reason === 'Bottle Return') cur.crate_return  += parseFloat(cn.amount || 0);
      else if (cn.reason === 'Goods Return')                                  cur.goods_return  += parseFloat(cn.amount || 0);
      else                                                                    cur.other         += parseFloat(cn.amount || 0);
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [list]);

  // ── Print: A4 report of the currently-filtered Credit Notes ─────────────
  const handlePrintReport = () => {
    const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const filterLabel = [
      filterFrom && `From ${filterFrom}`,
      filterTo   && `To ${filterTo}`,
      filterReason !== 'All' && `Reason: ${filterReason}`,
    ].filter(Boolean).join(' · ') || 'All time, all reasons';

    const rowsByDoc = list.map((cn, i) => `
      <tr style="border-bottom:1px solid #ddd;background:${i % 2 === 1 ? '#f9f9f9' : '#fff'}">
        <td style="padding:7px 9px;font-size:10.5px">${i + 1}</td>
        <td style="padding:7px 9px;font-weight:600">${cn.credit_note_number}</td>
        <td style="padding:7px 9px">${formatDate(cn.date)}</td>
        <td style="padding:7px 9px">${cn.supplier_name || '—'}</td>
        <td style="padding:7px 9px">${cn.reason}</td>
        <td style="padding:7px 9px">${cn.linked_grn_number ? (cn.linked_grn_number + (cn.linked_is_proposed ? ' (pending)' : '')) : (cn.reference || '—')}</td>
        <td style="padding:7px 9px;text-align:right;font-weight:700">${curSym}${fmt(cn.amount)}</td>
      </tr>`).join('');

    const rowsBySup = bySupplier.map((s, i) => `
      <tr style="border-bottom:1px solid #ddd;background:${i % 2 === 1 ? '#f9f9f9' : '#fff'}">
        <td style="padding:7px 9px;font-size:10.5px">${i + 1}</td>
        <td style="padding:7px 9px;font-weight:700">${s.supplier_name}</td>
        <td style="padding:7px 9px;text-align:center">${s.count}</td>
        <td style="padding:7px 9px;text-align:right">${curSym}${fmt(s.discount)}</td>
        <td style="padding:7px 9px;text-align:right">${curSym}${fmt(s.crate_return)}</td>
        <td style="padding:7px 9px;text-align:right">${curSym}${fmt(s.goods_return)}</td>
        <td style="padding:7px 9px;text-align:right">${curSym}${fmt(s.other)}</td>
        <td style="padding:7px 9px;text-align:right;font-weight:700">${curSym}${fmt(s.total)}</td>
      </tr>`).join('');

    const tableHtml = tab === 'bySupplier' ? `
      <table style="font-size:11.5px">
        <thead><tr>
          <th style="width:28px">#</th><th>Supplier</th>
          <th style="text-align:center">CNs</th>
          <th style="text-align:right">Discount</th>
          <th style="text-align:right">Crate Return</th>
          <th style="text-align:right">Goods Return</th>
          <th style="text-align:right">Other</th>
          <th style="text-align:right">Total</th>
        </tr></thead>
        <tbody>${rowsBySup}</tbody>
        <tfoot><tr>
          <td colspan="3">TOTAL — ${bySupplier.length} supplier${bySupplier.length !== 1 ? 's' : ''}</td>
          <td style="text-align:right">${curSym}${fmt(bySupplier.reduce((s, x) => s + x.discount, 0))}</td>
          <td style="text-align:right">${curSym}${fmt(bySupplier.reduce((s, x) => s + x.crate_return, 0))}</td>
          <td style="text-align:right">${curSym}${fmt(bySupplier.reduce((s, x) => s + x.goods_return, 0))}</td>
          <td style="text-align:right">${curSym}${fmt(bySupplier.reduce((s, x) => s + x.other, 0))}</td>
          <td style="text-align:right;font-size:13px">${curSym}${fmt(filteredTotal)}</td>
        </tr></tfoot>
      </table>` : `
      <table style="font-size:11.5px">
        <thead><tr>
          <th style="width:28px">#</th><th>CN #</th><th>Date</th><th>Supplier</th>
          <th>Reason</th><th>Reference</th><th style="text-align:right">Amount</th>
        </tr></thead>
        <tbody>${rowsByDoc}</tbody>
        <tfoot><tr>
          <td colspan="6">TOTAL — ${list.length} credit note${list.length !== 1 ? 's' : ''}</td>
          <td style="text-align:right;font-size:13px">${curSym}${fmt(filteredTotal)}</td>
        </tr></tfoot>
      </table>`;

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Credit Notes — ${printedAt}</title>
      <style>@page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:7px 9px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10.5px;background:#f0f0f0;text-align:left}
      tfoot td{padding:9px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
      </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:8px;letter-spacing:3px;text-transform:uppercase;margin-bottom:6px">Accounting</div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${biz}</div>
          <div style="font-size:10px">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Credit Notes</div>
          <div style="font-size:14px;font-weight:700">${tab === 'bySupplier' ? 'By Supplier' : 'By Document'}</div>
          <div style="font-size:9px;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        ${[['Filter', filterLabel], ['Total Credits', curSym+fmt(filteredTotal)], ['Count', String(list.length)]].map(([lbl, val]) => `
          <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
            <div style="font-size:13px;font-weight:800">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:16px">${tableHtml}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:32px;margin-bottom:16px">
        ${[['Prepared By', ''], ['Checked By', ''], ['Printed By', printedBy]].map(([label, name]) => `
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px">${biz} — Confidential</span>
        <span style="font-size:9px">Printed: ${printedAt}</span>
      </div>
      </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  // ── Print: one supplier's CNs grouped by reason ─────────────────────────
  // Triggered from the bySupplier drill-down modal. Prints only this
  // supplier's slice of the currently-filtered list.
  const handlePrintSupplier = (supplierName) => {
    const cns = list.filter(cn => (cn.supplier_name || '— (no supplier)') === supplierName);
    if (cns.length === 0) return;
    const fmt = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const total = cns.reduce((s, c) => s + parseFloat(c.amount || 0), 0);
    const groupOrder = ['Discount', 'Crate Return', 'Goods Return', 'Other'];
    const groups = groupOrder.map(g => ({
      reason: g,
      rows: cns.filter(c => c.reason === g || (g === 'Crate Return' && c.reason === 'Bottle Return')),
    })).filter(g => g.rows.length > 0);

    const sectionsHtml = groups.map(g => {
      const sub = g.rows.reduce((s, c) => s + parseFloat(c.amount || 0), 0);
      const rs = reasonStyle(g.reason);
      const trs = g.rows.map((cn, i) => {
        const isExp = expandedCNs.has(cn.id);
        const cache = cnItemsCache[cn.id];
        const baseRow = `
        <tr style="background:${i % 2 === 1 ? '#f9f9f9' : '#fff'}">
          <td style="padding:6px 9px;font-weight:600">${cn.credit_note_number}</td>
          <td style="padding:6px 9px">${formatDate(cn.date)}</td>
          <td style="padding:6px 9px">${cn.linked_grn_number ? (cn.linked_grn_number + (cn.linked_is_proposed ? ' (pending)' : '')) : (cn.reference || '—')}</td>
          <td style="padding:6px 9px;text-align:right;font-weight:700">${curSym}${fmt(cn.amount)}</td>
        </tr>`;
        if (!isExp || !cache) return baseRow;
        const reasonHasStock = g.reason === 'Crate Return' || g.reason === 'Goods Return';
        let breakdown = '';
        if (reasonHasStock && (cache.items || []).length > 0) {
          const itemRows = cache.items.map(it => `
            <tr>
              <td style="padding:4px 8px">${it.product_name || ''}</td>
              <td style="padding:4px 8px;text-align:right">${parseFloat(it.quantity || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
              <td style="padding:4px 8px;text-align:center">${it.unit || it.product_unit || ''}</td>
              <td style="padding:4px 8px;text-align:right">${curSym}${fmt(it.unit_value)}</td>
              <td style="padding:4px 8px;text-align:right;font-weight:600">${curSym}${fmt(it.total_price)}</td>
            </tr>`).join('');
          breakdown = `
            <tr><td colspan="4" style="padding:0">
              <div style="margin:0 14px 6px 14px;border:1px solid #ccc;background:#fafafa">
                <table style="width:100%;border-collapse:collapse;font-size:10px">
                  <thead><tr style="background:#eee">
                    <th style="padding:4px 8px;text-align:left">Product</th>
                    <th style="padding:4px 8px;text-align:right">Qty</th>
                    <th style="padding:4px 8px;text-align:center">Unit</th>
                    <th style="padding:4px 8px;text-align:right">Value</th>
                    <th style="padding:4px 8px;text-align:right">Total</th>
                  </tr></thead>
                  <tbody>${itemRows}</tbody>
                </table>
                ${cache.notes ? `<div style="padding:5px 9px;font-size:10px;color:#444;border-top:1px solid #ddd"><b>Notes:</b> ${cache.notes}</div>` : ''}
              </div>
            </td></tr>`;
        } else if (cache.notes) {
          breakdown = `
            <tr><td colspan="4" style="padding:0">
              <div style="margin:0 14px 6px 14px;padding:6px 10px;border-left:3px solid #aaa;background:#fafafa;font-size:10.5px;color:#444">
                <b>Notes:</b> ${cache.notes}
              </div>
            </td></tr>`;
        }
        return baseRow + breakdown;
      }).join('');
      return `
        <div style="margin-bottom:14px;border:1.5px solid #000">
          <div style="padding:7px 10px;background:${rs.bg};color:${rs.color};border-bottom:1.5px solid #000;display:flex;justify-content:space-between;align-items:center">
            <span style="font-weight:700;letter-spacing:0.4px">${g.reason} · ${g.rows.length}</span>
            <span style="font-weight:800">${curSym}${fmt(sub)}</span>
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead><tr style="background:#f0f0f0;border-bottom:1.5px solid #000">
              <th style="padding:6px 9px;text-align:left">CN #</th>
              <th style="padding:6px 9px;text-align:left">Date</th>
              <th style="padding:6px 9px;text-align:left">Reference</th>
              <th style="padding:6px 9px;text-align:right">Amount</th>
            </tr></thead>
            <tbody>${trs}</tbody>
          </table>
        </div>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${supplierName} — Credit Notes — ${printedAt}</title>
      <style>@page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:8px;letter-spacing:3px;text-transform:uppercase;margin-bottom:6px">Accounting</div>
          <div style="font-size:21px;font-weight:800;margin-bottom:4px">${biz}</div>
          <div style="font-size:10px">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Credit Notes — Supplier Detail</div>
          <div style="font-size:14px;font-weight:700">${supplierName}</div>
          <div style="font-size:9px;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:14px">
        <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
          <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">Total Credit Notes</div>
          <div style="font-size:13px;font-weight:800">${cns.length}</div>
        </div>
        <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
          <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">Total Value</div>
          <div style="font-size:13px;font-weight:800">${curSym}${fmt(total)}</div>
        </div>
      </div>
      ${sectionsHtml}
      <div style="margin-top:18px;padding-top:10px;border-top:2px solid #000;display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:800">
        <span>GRAND TOTAL — ${cns.length} credit note${cns.length !== 1 ? 's' : ''}</span>
        <span>${curSym}${fmt(total)}</span>
      </div>
      <div style="margin-top:24px;font-size:10px;color:#555">Printed by ${printedBy}</div>
      </body></html>`;
    const wS = window.open('', '_blank');
    if (!wS) return;
    wS.document.write(html); wS.document.close(); wS.focus();
    setTimeout(() => { wS.print(); wS.close(); }, 300);
  };

  // ── Subtotals by reason for the stat strip ──
  const reasonStats = useMemo(() => {
    const by = { Discount: 0, 'Crate Return': 0, 'Goods Return': 0, Other: 0 };
    (stats.byReason || []).forEach(r => {
      // Roll legacy 'Bottle Return' into Crate Return for the dashboard.
      const key = r.reason === 'Bottle Return' ? 'Crate Return' : r.reason;
      if (by[key] != null) by[key] += parseFloat(r.sum || 0);
    });
    return by;
  }, [stats]);

  const canAdd    = hasPermission('CreditNotes:Add')    !== false;
  const canEdit   = hasPermission('CreditNotes:Edit')   !== false;
  const canDelete = hasPermission('CreditNotes:Delete') !== false;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Credit Notes</h1>
          <p>{t('creditNotesSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={handlePrintReport} disabled={list.length === 0}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none',
                     backgroundColor: list.length === 0 ? '#cbd5e1' : '#7c3aed', color: '#fff',
                     cursor: list.length === 0 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>
            <FiPrinter size={15} /> {t('print')}
          </button>
          {canAdd && (
            <button className="btn btn-primary" onClick={openNew}>
              <FiPlus /> New Credit Note
            </button>
          )}
        </div>
      </div>

      {/* ── Stat cards ─────────────────────────────────────────────────────── */}
      <div className="stat-cards">
        <div className="stat-card blue">
          <div className="stat-icon"><FiTag /></div>
          <div><div className="stat-label">Total Credit Notes</div><div className="stat-value">{stats.totalCreditNotes}</div></div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon"><FiCalendar /></div>
          <div><div className="stat-label">{t('thisMonth')}</div><div className="stat-value">{stats.thisMonth}</div></div>
        </div>
        <div className="stat-card purple">
          <div className="stat-icon"><FiDollarSign /></div>
          <div>
            <div className="stat-label">Total Value</div>
            <div className="stat-value" style={{ fontSize: 18 }}>{curSym}{parseFloat(stats.totalValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
        </div>
        <div className="stat-card orange">
          <div className="stat-icon"><FiUsers /></div>
          <div>
            <div className="stat-label">By Reason</div>
            <div style={{ fontSize: 11, marginTop: 4, lineHeight: 1.5 }}>
              <div>Discount: {curSym}{reasonStats['Discount'].toLocaleString()}</div>
              <div>Crate Return: {curSym}{reasonStats['Crate Return'].toLocaleString()}</div>
              {reasonStats['Goods Return'] > 0 && (
                <div>Goods Return: {curSym}{reasonStats['Goods Return'].toLocaleString()}</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Filter bar ─────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
                    padding: '12px 16px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{t('filterByDate')}:</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('from')}</span>
          <input type="date" value={filterFrom} max={filterTo || todayStr}
            onChange={e => setFilterFrom(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('to')}</span>
          <input type="date" value={filterTo} min={filterFrom || undefined} max={todayStr}
            onChange={e => setFilterTo(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13 }} />
        </div>
        <select value={filterReason} onChange={e => setFilterReason(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, background: '#fff' }}>
          <option value="All">All reasons</option>
          {REASONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        {(filterFrom || filterTo || filterReason !== 'All') && (
          <button onClick={() => { setFilterFrom(''); setFilterTo(''); setFilterReason('All'); }}
            style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' }}>
            {t('clear')}
          </button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {list.length} credit note{list.length !== 1 ? 's' : ''}
          {list.length > 0 && (
            <> &nbsp;·&nbsp; Total: <strong style={{ color: '#0369a1' }}>{curSym}{filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></>
          )}
        </span>
      </div>

      {/* ── Tabs: per-document detail vs per-supplier rollup ─────────────── */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { key: 'byDocument', label: 'By Document' },
          { key: 'bySupplier', label: 'By Supplier' },
        ].map(tb => (
          <button key={tb.key} onClick={() => setTab(tb.key)}
            style={{ padding: '10px 18px', background: 'none', border: 'none',
                     borderBottom: tab === tb.key ? '3px solid #1d4ed8' : '3px solid transparent',
                     color: tab === tb.key ? '#1d4ed8' : '#6b7280',
                     fontWeight: tab === tb.key ? 700 : 500, fontSize: 13.5,
                     cursor: 'pointer', marginBottom: -2 }}>
            {tb.label}
          </button>
        ))}
      </div>

      {/* ── Table ──────────────────────────────────────────────────────────── */}
      <div className="data-table-container">
        {list.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
            No credit notes yet. Use "New Credit Note" to record a supplier discount or crate/bottle return.
          </div>
        ) : tab === 'bySupplier' ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('supplier')}</th>
                <th style={{ textAlign: 'center' }}>CNs</th>
                <th style={{ textAlign: 'right' }}>Discount</th>
                <th style={{ textAlign: 'right' }}>Crate Return</th>
                <th style={{ textAlign: 'right' }}>Goods Return</th>
                <th style={{ textAlign: 'right' }}>Other</th>
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {bySupplier.map((s, i) => (
                <tr key={s.supplier_name + i}>
                  <td style={{ fontWeight: 600 }}>
                    <button type="button" onClick={() => setSupplierDetail(s.supplier_name)}
                      style={{ background: 'none', border: 'none', padding: 0, color: '#0369a1', fontWeight: 700, cursor: 'pointer', textAlign: 'left', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>
                      {s.supplier_name}
                    </button>
                  </td>
                  <td style={{ textAlign: 'center' }}>{s.count}</td>
                  <td style={{ textAlign: 'right', color: s.discount > 0 ? '#16a34a' : '#9ca3af' }}>
                    {s.discount > 0 ? `${curSym}${s.discount.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: s.crate_return > 0 ? '#1d4ed8' : '#9ca3af' }}>
                    {s.crate_return > 0 ? `${curSym}${s.crate_return.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: s.goods_return > 0 ? '#9a3412' : '#9ca3af' }}>
                    {s.goods_return > 0 ? `${curSym}${s.goods_return.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: s.other > 0 ? '#374151' : '#9ca3af' }}>
                    {s.other > 0 ? `${curSym}${s.other.toLocaleString(undefined, { minimumFractionDigits: 2 })}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#0369a1' }}>
                    {curSym}{s.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                </tr>
              ))}
              <tr style={{ background: '#f0f9ff', fontWeight: 700 }}>
                <td>TOTAL — {bySupplier.length} supplier{bySupplier.length !== 1 ? 's' : ''}</td>
                <td style={{ textAlign: 'center' }}>{list.length}</td>
                <td style={{ textAlign: 'right', color: '#16a34a' }}>
                  {curSym}{bySupplier.reduce((s, x) => s + x.discount, 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
                <td style={{ textAlign: 'right', color: '#1d4ed8' }}>
                  {curSym}{bySupplier.reduce((s, x) => s + x.crate_return, 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
                <td style={{ textAlign: 'right', color: '#9a3412' }}>
                  {curSym}{bySupplier.reduce((s, x) => s + x.goods_return, 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
                <td style={{ textAlign: 'right' }}>
                  {curSym}{bySupplier.reduce((s, x) => s + x.other, 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
                <td style={{ textAlign: 'right', color: '#0369a1', fontSize: 14 }}>
                  {curSym}{filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>CN #</th>
                <th>{t('date')}</th>
                <th>{t('supplier')}</th>
                {onHq && <th>Depot</th>}
                <th>Reason</th>
                <th>Status</th>
                <th>{t('reference')}</th>
                <th>Invoice #</th>
                <th style={{ textAlign: 'right' }}>{t('amount')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {list.map(cn => {
                const rs = reasonStyle(cn.reason);
                return (
                  <tr key={cn.id}>
                    <td style={{ fontWeight: 500 }}>{cn.credit_note_number}</td>
                    <td>{formatDate(cn.date)}</td>
                    <td>{cn.supplier_name || '—'}</td>
                    {onHq && <td>{depotLabel(cn.depot_name)}</td>}
                    <td>
                      <span style={{ padding: '2px 9px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                                     background: rs.bg, color: rs.color, border: `1px solid ${rs.border}` }}>
                        {cn.reason}
                      </span>
                      {!reasonAffectsProfit(cn.reason) && (
                        <span title="Deposit refund — does not affect Profit Report" style={{ marginLeft: 6, fontSize: 10, color: '#9ca3af' }}>
                          (deposit refund)
                        </span>
                      )}
                    </td>
                    {/* 2026-09-07 — where the note stands. A depot's credit
                        is a claim until HQ agrees it: the stock has already
                        left the shelf, but nothing has been taken off what the
                        supplier is owed. Saying so is the difference between
                        "done" and "sent". */}
                    <td>
                      {cn.branch_confirmed_at ? (
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#dcfce7', color: '#166534' }}>
                          Confirmed
                        </span>
                      ) : cn.raised_by_branch ? (
                        <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#fef3c7', color: '#92400e' }}>
                          Awaiting confirmation
                        </span>
                      ) : <span style={{ color: '#cbd5e1' }}>—</span>}
                    </td>
                    <td style={{ color: '#6b7280' }}>{cn.linked_grn_number
                        ? <span title={cn.linked_is_proposed ? 'Proposed — waiting for HQ to confirm' : 'Attached to this GRN'}>
                            <span style={{ fontFamily: 'monospace' }}>{cn.linked_grn_number}</span>
                            {cn.linked_is_proposed && <span style={{ color: '#b45309' }}> · pending</span>}
                          </span>
                        : (cn.reference || '—')}</td>
                    <td style={{ fontFamily: 'monospace', color: cn.supplier_invoice_number ? '#111827' : '#cbd5e1' }}>
                      {cn.supplier_invoice_number || '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {curSym}{parseFloat(cn.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button onClick={() => openView(cn)} disabled={viewLoading}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px',
                                   borderRadius: 6, border: '1px solid #e5e7eb', background: '#f9fafb', color: '#6b7280', cursor: 'pointer', fontSize: 12 }}>
                          <FiEye size={12} /> {t('view')}
                        </button>
                          {/* 2026-09-14 — HQ confirms; a depot only sees the status. */}
                          {onHq && cn.proposed_grn_sync_id && !cn.branch_confirmed_at && (
                            <button onClick={() => handleConfirm(cn)} title="Confirm this depot's credit note"
                              style={{ padding: '4px 10px', borderRadius: 6, border: 'none', background: '#16a34a', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', marginRight: 4 }}>
                              Confirm
                            </button>
                          )}
                        {/* A confirmed credit is agreed with the supplier
                            and already off the payable. Editing or deleting it
                            would move money nobody looked at again, so it is
                            view-only from that point — at HQ as well as at the
                            depot. Correct a bad one with a reversing entry,
                            not by making it disappear.

                            A depot cannot edit even a pending one: the row is
                            in HQ's book and the edit route only reads the
                            depot's, so the button would 404. Cancel and raise
                            it again, which is honest about what is happening. */}
                        {canEdit && !cn.branch_confirmed_at && !cn.raised_here && (
                          <button onClick={() => openEdit(cn)} title="Edit"
                            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                     width: 30, height: 30, borderRadius: 6, border: '1px solid #e5e7eb',
                                     background: '#f9fafb', color: '#6b7280', cursor: 'pointer' }}>
                            <FiEdit2 size={13} />
                          </button>
                        )}
                        {/* Once HQ has agreed it the payable has already
                            moved, so a depot pulling it back would change what
                            a supplier is owed with nobody at HQ knowing. The
                            server refuses it too. */}
                        {canDelete && !cn.branch_confirmed_at && (
                          <button onClick={() => handleDelete(cn)} title={cn.raised_here ? 'Cancel this credit note' : 'Delete'}
                            style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                     width: 30, height: 30, borderRadius: 6, border: '1px solid #fecaca',
                                     background: '#fef2f2', color: '#dc2626', cursor: 'pointer' }}>
                            <FiTrash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              <tr style={{ background: '#f0f9ff', fontWeight: 700 }}>
                <td colSpan={6} style={{ textAlign: 'right' }}>TOTAL — {list.length} credit note{list.length !== 1 ? 's' : ''}</td>
                <td style={{ textAlign: 'right', fontSize: 14, color: '#0369a1' }}>
                  {curSym}{filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        )}
      </div>

      {/* ── New / Edit modal ───────────────────────────────────────────────── */}
      {showForm && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 720, maxHeight: '92vh', overflow: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '16px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{editMode ? 'Edit' : 'New'} Credit Note</h2>
              <button onClick={() => { setShowForm(false); resetForm(); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
            </div>

            <div style={{ padding: 22 }}>
              {/* 2026-09-12 — one reason, so nothing to choose. Goods Return
                  covers every credit a depot raises: the supplier's goods going
                  back, and crates or empty bottles, which still price at the
                  deposit. Discount and Other are gone (Red Sea gives no
                  discounts), and Crate Return is gone from the form only — the
                  Empty Returns page still mints its own. An older note keeps
                  whatever reason it was saved with, and this shows it. */}
              <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 6 }}>Reason</label>
              <div style={{ marginBottom: 16 }}>
                <span style={{ display: 'inline-block', padding: '7px 14px', borderRadius: 8,
                               border: `1.5px solid ${reasonStyle(reason).border}`,
                               background: reasonStyle(reason).bg, color: reasonStyle(reason).color,
                               fontWeight: 700, fontSize: 12.5 }}>
                  {reason}
                </span>
              </div>
              {!reasonAffectsProfit(reason) && (
                <div style={{ marginBottom: 12, padding: '8px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 11, color: '#1e3a8a' }}>
                  {reason === 'Crate Return' && (
                    <><strong>Note:</strong> Crate Returns are deposit refunds — covers any returnable container (crates, empty bottles, kegs). They reduce AP balance and move empty stock, but do <strong>not</strong> appear on the Profit Report (they're not income).</>
                  )}
                  {reason === 'Goods Return' && (
                    <><strong>Note:</strong> pick whatever is going back to the supplier — damaged, wrong or excess goods, and crates or empty bottles too. Stock leaves your store and the AP balance drops by the same amount. Does <strong>not</strong> appear on the Profit Report (it's a reversal, not income).</>
                  )}
                </div>
              )}

              {/* Supplier + date */}
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 4 }}>Supplier *</label>
                  {/* Always a dropdown. Choosing a supplier narrows the
                      invoice list below to that supplier's unpaid GRNs; a
                      credit with no invoice still needs one picked here. */}
                  <select value={supplierId} onChange={e => setSupplierId(e.target.value)}
                    style={{ width: '100%', padding: '9px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, background: '#fff', boxSizing: 'border-box' }}>
                    <option value="">— Select supplier —</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 4 }}>{t('date')}</label>
                  <input type="date" value={date} max={todayStr} onChange={e => setDate(e.target.value || todayStr)}
                    style={{ width: '100%', padding: '9px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                </div>
              </div>

              {/* 2026-09-04 — attach to a GRN. Optional: a credit that belongs
                  to no particular delivery still lowers the supplier's overall
                  balance, which is what Reference alone used to do. Choosing a
                  GRN is what makes it reduce THAT invoice's payable. */}
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 4 }}>
                  Invoice number <span style={{ textTransform: 'none', fontWeight: 500, color: '#9ca3af' }}>
                    {editMode && grnSyncId ? '— already attached' : '— optional'}
                  </span>
                </label>
                {editMode && grnSyncId ? (
                  // 2026-09-18 — locked while editing. Which invoice a credit
                  // reduces is not something to change by accident; to move it,
                  // delete the note and raise it against the right invoice.
                  <div style={{ width: '100%', padding: '9px 10px', border: '1px solid #e5e7eb', borderRadius: 8,
                                fontSize: 13, boxSizing: 'border-box', background: '#f9fafb', color: '#374151',
                                display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600 }}>
                      {editInvoice?.invoice ? `Inv ${editInvoice.invoice}` : (editInvoice?.grn || 'Attached to an invoice')}
                    </span>
                    {editInvoice?.grn && editInvoice?.invoice && (
                      <span style={{ color: '#6b7280', fontSize: 12 }}>· {editInvoice.grn}</span>
                    )}
                    {editInvoice?.proposed && (
                      <span style={{ color: '#b45309', fontSize: 11, fontWeight: 700 }}>· WAITING FOR HQ</span>
                    )}
                    <span style={{ marginLeft: 'auto', color: '#9ca3af', fontSize: 11 }}>locked</span>
                  </div>
                ) : (
                <select value={grnSyncId} onChange={e => {
                    const v = e.target.value;
                    setGrnSyncId(v);
                    // An invoice names its own supplier, so fill the box in
                    // rather than making it be typed twice. Not locked - the
                    // operator can still change their mind either way round.
                    const g = linkable.find(x => x.grn_sync_id === v);
                    if (g?.supplier_sync_id) {
                      const match = suppliers.find(x => x.sync_id === g.supplier_sync_id);
                      if (match) setSupplierId(String(match.id));
                    }
                  }}
                  style={{ width: '100%', padding: '9px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, boxSizing: 'border-box', background: '#fff' }}>
                  <option value="">— none · lowers the supplier's balance —</option>
                  {linkable.map(g => (
                    // 2026-09-04 — the SUPPLIER'S invoice number leads. That is the
                    // number on the paper the depot is holding; the GRN number is
                    // ours, minted when HQ confirmed receipt, and they have no
                    // reason to know it. Date and amount next, because those are
                    // also on the invoice. GRN number kept in the tail for HQ.
                    // 2026-09-06 — the supplier's name, right after their
                    // invoice number. With no supplier chosen this list mixes
                    // every supplier's invoices together and nothing said
                    // whose was whose.
                    // 2026-09-14 — an invoice that already has a credit note is
                    // coloured and says so, with the amount, so the same credit
                    // is not raised twice. The text carries it too: some phones
                    // ignore colours on dropdown options.
                    <option key={g.grn_sync_id} value={g.grn_sync_id}
                      style={g.cn_count > 0 ? { color: '#b45309', background: '#fff7ed', fontWeight: 600 } : undefined}>
                      {g.cn_count > 0 ? '● ' : ''}
                      {(g.supplier_invoice_number || g.invoice_number) ? `Inv ${g.supplier_invoice_number || g.invoice_number}` : g.grn_number}
                      {g.supplier_name ? ` · ${g.supplier_name}` : ''}
                      {g.date ? ` · ${g.date}` : ''}
                      {` · ${curSym}${Number(g.final_payable || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      {(g.supplier_invoice_number || g.invoice_number) ? ` · ${g.grn_number}` : ''}
                      {g.branch_name ? ` · ${g.branch_name}` : ''}
                      {g.cn_count > 0 ? ` · HAS CN ${curSym}${Number(g.cn_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''}
                    </option>
                  ))}
                </select>
                )}
                {linkable.some(g => g.cn_count > 0) && !grnSyncId && (
                  <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>
                    ● Amber invoices already have a credit note.
                  </div>
                )}
                {supplierId && linkable.length === 0 && (
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                    No unpaid GRNs for this supplier — a paid invoice cannot take a credit.
                  </div>
                )}
                {/* 2026-09-14 — the chosen invoice already has credit notes:
                    say which, and how much, before a second one is saved. */}
                {invoiceSupplier && invoiceSupplier.cn_count > 0 && (
                  <div style={{ marginTop: 6, padding: '9px 12px', background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 8, fontSize: 12, color: '#9a3412' }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      This invoice already has {invoiceSupplier.cn_count} credit note{invoiceSupplier.cn_count === 1 ? '' : 's'} ·{' '}
                      {curSym}{Number(invoiceSupplier.cn_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                    {(invoiceSupplier.credit_notes || []).map(n => (
                      <div key={n.number} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                        <span style={{ fontFamily: 'monospace' }}>{n.number}{n.pending ? ' · awaiting HQ' : ''}</span>
                        <span>{curSym}{Number(n.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                    ))}
                    <div style={{ marginTop: 4, color: '#b45309' }}>Check it is not the same return before saving another.</div>
                  </div>
                )}
                {/* 2026-09-12 — what the chosen invoice still owes. It was only
                    ever readable inside the dropdown option, so once the list
                    closed there was nothing to size the credit against. */}
                {invoiceSupplier && (
                  <div style={{ marginTop: 6, padding: '8px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8,
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
                    <span style={{ color: '#64748b' }}>
                      {(invoiceSupplier.supplier_invoice_number || invoiceSupplier.invoice_number)
                        ? `Invoice ${invoiceSupplier.supplier_invoice_number || invoiceSupplier.invoice_number}`
                        : invoiceSupplier.grn_number}
                      {invoiceSupplier.branch_name ? ` · ${invoiceSupplier.branch_name}` : ''}
                    </span>
                    <span style={{ color: '#0f172a', fontWeight: 700 }}>
                      Final payable {curSym}{Number(invoiceSupplier.final_payable || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                )}
              </div>

              {/* Reference */}
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 4 }}>Reference</label>
                <input type="text" value={reference} onChange={e => setReference(e.target.value)}
                  placeholder="e.g. driver name, delivery note"
                  style={{ width: '100%', padding: '9px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
              </div>

              {/* Either amount OR item rows depending on reason */}
              {reasonHasItems(reason) ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                      {reason === 'Goods Return' ? 'Items returned' : 'Items returned (crates & bottles)'}
                    </label>
                    {reason === 'Crate Return' && defaultDeposit > 0 && (
                      <span style={{ fontSize: 10, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '2px 8px' }}>
                        Default deposit {curSym}{parseFloat(defaultDeposit).toFixed(2)} (System Settings)
                      </span>
                    )}
                    {reason === 'Goods Return' && (
                      <span style={{ fontSize: 10, color: '#9a3412', background: '#ffedd5', border: '1px solid #fed7aa', borderRadius: 6, padding: '2px 8px' }}>
                        Value fills from the invoice (VAT incl ÷ qty), else the last invoice
                        {defaultDeposit > 0 ? ` · crates & empties at ${curSym}${parseFloat(defaultDeposit).toFixed(2)}` : ''}
                      </span>
                    )}
                  </div>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 8, marginBottom: 8, background: '#fafafa' }}>
                    {(() => {
                      // Product / Qty / Unit / Value / Total / X
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
                          {items.map((r, idx) => {
                            const lineTotal = (parseFloat(r.quantity) || 0) * (parseFloat(r.unit_value) || 0);
                            const rowProduct = products.find(pp => String(pp.id) === String(r.product_id));
                            const rowUnits = rowProduct ? unitsForProduct(rowProduct) : [];
                            // More returned than the invoice delivered, in the row's unit.
                            const rowConv = parseFloat(r.unit_conv) > 0 ? parseFloat(r.unit_conv) : 1;
                            const invLine = rowProduct ? invoiceLineFor(rowProduct) : null;
                            const invQty = invLine ? (parseFloat(invLine.quantity) || 0) * unitConvOf(rowProduct, invLine.unit, rowConv) / rowConv : 0;
                            const overInvoice = !!invLine && (parseFloat(r.quantity) || 0) > invQty + 1e-9;
                            return (
                              <React.Fragment key={idx}>
                              <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, alignItems: 'center', padding: '4px' }}>
                                {/* 2026-09-11 — the New HQ Purchase picker, with the
                                    chosen invoice's items first, in green. */}
                                <div style={{ minWidth: 0 }}>
                                  <ItemPicker
                                    products={pickerProducts}
                                    text={r.product_text || ''}
                                    selected={!!r.product_id}
                                    tagFor={grnLines.length ? invoiceTag : null}
                                    placeholder={reason === 'Goods Return' ? 'Type to search items…' : 'Crate or empty bottle'}
                                    onPick={(p) => pickRow(idx, p)}
                                    onText={(t) => typeRow(idx, t)}
                                    onClear={() => clearRow(idx)}
                                    style={{ width: '100%', padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff', minWidth: 0, boxSizing: 'border-box' }} />
                                </div>
                                <input type="number" min="0" step="0.01" value={r.quantity}
                                  onChange={e => updateRow(idx, 'quantity', e.target.value)}
                                  style={{ padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, textAlign: 'right', background: '#fff', minWidth: 0, boxSizing: 'border-box' }} />
                                {rowUnits.length > 1 ? (
                                  <select value={r.unit || ''} onChange={e => updateRow(idx, 'unit', e.target.value)}
                                    style={{ padding: '7px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff', minWidth: 0, boxSizing: 'border-box' }}>
                                    {rowUnits.map(u => <option key={u.name} value={u.name}>{u.name}</option>)}
                                  </select>
                                ) : (
                                  <span style={{ padding: '7px 6px', fontSize: 12, color: '#6b7280', textAlign: 'center', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {r.unit || (rowProduct?.unit || '')}
                                  </span>
                                )}
                                <input type="number" min="0" step="0.01" value={r.unit_value}
                                  onChange={e => updateRow(idx, 'unit_value', e.target.value)}
                                  style={{ padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, textAlign: 'right', background: '#fff', minWidth: 0, boxSizing: 'border-box' }} />
                                <span style={{ padding: '7px 4px', fontSize: 12, fontWeight: 700, color: '#374151', textAlign: 'right', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${curSym}${lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}>
                                  {curSym}{lineTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                                <button type="button" onClick={() => removeRow(idx)} title="Remove row"
                                  style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4 }}>
                                  <FiTrash2 size={14} />
                                </button>
                              </div>
                              {overInvoice && (
                                <div style={{ fontSize: 11, color: '#b45309', padding: '0 4px 4px' }}>
                                  More than the {fmtQty(invQty)}{r.unit ? ` ${r.unit}` : ''} on this invoice — check the quantity.
                                </div>
                              )}
                              </React.Fragment>
                            );
                          })}
                        </>
                      );
                    })()}
                  </div>
                  <button type="button" onClick={addRow}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, border: '1px dashed #93c5fd', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontSize: 12, fontWeight: 600, marginBottom: 12 }}>
                    <FiPlus size={12} /> Add Row
                  </button>
                </>
              ) : (
                <div style={{ marginBottom: 12 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 4 }}>Amount * ({curSym})</label>
                  <input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)}
                    placeholder="0.00"
                    style={{ width: '100%', padding: '11px 12px', border: '1.5px solid #d1d5db', borderRadius: 8, fontSize: 16, fontWeight: 700, textAlign: 'right', boxSizing: 'border-box' }} />
                </div>
              )}

              {/* Notes */}
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.4, display: 'block', marginBottom: 4 }}>{t('notes')}</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', resize: 'vertical' }} />
              </div>

              {/* Total preview */}
              <div style={{ marginBottom: 12, padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10 }}>
                {/* 2026-09-18 — on a note raised at goods-receive the lines are
                    pre-discount and ex-VAT, so the figure below is not just
                    their sum. Spelling it out is what stops "the total changed
                    when I opened it" — it did not; the rest was never shown. */}
                {reasonHasItems(reason) && (editVat > 0 || editDiscount > 0) && (
                  <>
                    {[['Goods (before VAT)', calcTotal(items)],
                      ...(editDiscount > 0 ? [['Less discount', -editDiscount]] : []),
                      ...(editVat > 0 ? [['VAT', editVat]] : [])].map(([label, value]) => (
                      <div key={label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#1e3a8a', padding: '1px 0' }}>
                        <span>{label}</span>
                        <span style={{ fontWeight: 600 }}>{curSym}{value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                    ))}
                    <div style={{ borderTop: '1px solid #bfdbfe', margin: '6px 0' }} />
                  </>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontSize: 12, color: '#1e3a8a' }}>
                    AP balance to {invoiceSupplier?.supplier_name
                      || (suppliers.find(s => String(s.id) === supplierId)?.name)
                      || 'supplier'} will go down by:
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: '#1d4ed8' }}>
                    {curSym}{formTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                </div>
              </div>

              {/* 2026-09-12 — and what that leaves on the invoice. A credit for
                  more than the invoice owes is a mistake worth seeing before it
                  is saved, not after Accounts finds a negative payable. */}
              {invoiceSupplier && (() => {
                const invPayable = parseFloat(invoiceSupplier.final_payable || 0) || 0;
                const left = invPayable - formTotal;
                const over = left < -0.005;
                const money = (n) => `${curSym}${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                return (
                  <div style={{ marginBottom: 12, padding: '9px 14px', borderRadius: 10, fontSize: 12,
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
                                background: over ? '#fef2f2' : '#f8fafc',
                                border: `1px solid ${over ? '#fecaca' : '#e2e8f0'}` }}>
                    <span style={{ color: over ? '#991b1b' : '#64748b', fontWeight: over ? 700 : 400 }}>
                      {over
                        ? `More than invoice ${invoiceSupplier.invoice_number || invoiceSupplier.grn_number} owes`
                        : 'Invoice left after this credit'}
                    </span>
                    <span style={{ fontSize: 14, fontWeight: 800, color: over ? '#b91c1c' : '#0f172a' }}>
                      {money(left)}{over ? ' over' : ''}
                    </span>
                  </div>
                );
              })()}

              {error && (
                <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#991b1b', fontWeight: 600 }}>
                  {error}
                </div>
              )}
            </div>

            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => { setShowForm(false); resetForm(); }}
                style={{ padding: '10px 18px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                {t('cancel')}
              </button>
              <button onClick={save} disabled={saving || !(supplierId || invoiceSupplier) || formTotal <= 0}
                style={{ padding: '10px 22px', background: saving || !(supplierId || invoiceSupplier) || formTotal <= 0 ? '#9ca3af' : '#1d4ed8', color: '#fff', border: 'none', borderRadius: 8, cursor: saving || !(supplierId || invoiceSupplier) || formTotal <= 0 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>
                {saving ? t('saving') : (editMode ? 'Save Changes' : 'Save Credit Note')}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── View modal ─────────────────────────────────────────────────────── */}
      {viewCN && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '16px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{viewCN.credit_note_number}</h2>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{formatDate(viewCN.date)} · {viewCN.supplier_name}</div>
              </div>
              <button onClick={() => setViewCN(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
            </div>

            <div style={{ padding: 22 }}>
              <div style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
                {(() => { const rs = reasonStyle(viewCN.reason); return (
                  <span style={{ padding: '4px 12px', borderRadius: 12, fontSize: 12, fontWeight: 700, background: rs.bg, color: rs.color, border: `1px solid ${rs.border}` }}>
                    {viewCN.reason}
                  </span>
                ); })()}
                {!reasonAffectsProfit(viewCN.reason) && (
                  <span style={{ fontSize: 11, color: '#6b7280', alignSelf: 'center' }}>(deposit refund — not income)</span>
                )}
              </div>

              {/* 2026-09-14 — the depot and the supplier's invoice number, next to the GRN. */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 12 }}>
                {onHq && <Fact label="Depot" value={depotLabel(viewCN.depot_name)} />}
                <Fact label="Supplier invoice #" value={viewCN.supplier_invoice_number || '—'} mono />
                <Fact label="GRN" value={viewCN.linked_grn_number
                  ? `${viewCN.linked_grn_number}${viewCN.linked_is_proposed ? ' (pending)' : ''}`
                  : '—'} mono />
              </div>

              {viewCN.reference && (
                <div style={{ marginBottom: 12, fontSize: 13 }}>
                  <strong style={{ color: '#374151' }}>Reference:</strong> <span style={{ color: '#6b7280' }}>{viewCN.reference}</span>
                </div>
              )}

              {viewCN.items?.length > 0 && (
                <div style={{ marginBottom: 12, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                  <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead style={{ background: '#f9fafb' }}>
                      <tr>
                        <th style={{ padding: '8px 10px', textAlign: 'left', fontWeight: 700, color: '#6b7280', fontSize: 11 }}>Product</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#6b7280', fontSize: 11 }}>Qty</th>
                        <th style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#6b7280', fontSize: 11 }}>Unit</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#6b7280', fontSize: 11 }}>Unit Value</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#6b7280', fontSize: 11 }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {viewCN.items.map(it => (
                        <tr key={it.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '8px 10px' }}>{it.product_name}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right' }}>{parseFloat(it.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#6b7280' }}>{it.unit || it.product_unit || ''}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right' }}>{curSym}{parseFloat(it.unit_value).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600 }}>{curSym}{parseFloat(it.total_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 2026-09-18 — notes raised at goods-receive (up to 10 Sept)
                  hold their lines at the BASE price, with the discount and the
                  note's VAT kept separately. Listing only the lines made those
                  notes look wrong: 10 × K252.28 under a total of K3,439.048,
                  with nothing saying where the rest came from. The breakdown
                  shows only when there is something to explain — a note raised
                  on this page has neither, and still shows one Amount line. */}
              {(() => {
                const lines = (viewCN.items || []).reduce((s, i) => s + (parseFloat(i.total_price) || 0), 0);
                const disc  = (viewCN.items || []).reduce((s, i) => s + (parseFloat(i.discount) || 0), 0);
                const vat   = parseFloat(viewCN.vat_amount) || 0;
                const total = parseFloat(viewCN.amount) || 0;
                const split = (viewCN.items || []).length > 0 && (vat > 0 || disc > 0);
                const Line = ({ label, value, hint }) => (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13, color: '#1e3a8a', padding: '2px 0' }}>
                    <span>{label}{hint && <span style={{ color: '#6b7280', fontSize: 11, marginLeft: 6 }}>{hint}</span>}</span>
                    <span style={{ fontWeight: 600 }}>{curSym}{value.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                );
                return (
                  <div style={{ padding: '12px 16px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, marginBottom: 12 }}>
                    {split && (
                      <>
                        <Line label="Goods" value={lines} hint="before VAT" />
                        {disc > 0 && <Line label="Less discount" value={-disc} />}
                        {vat  > 0 && <Line label="VAT" value={vat} />}
                        <div style={{ borderTop: '1px solid #bfdbfe', margin: '6px 0' }} />
                      </>
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 13, color: '#1e3a8a', fontWeight: 600 }}>Amount</span>
                      <span style={{ fontSize: 20, fontWeight: 800, color: '#1d4ed8' }}>{curSym}{total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                );
              })()}

              {viewCN.notes && (
                <div style={{ padding: '10px 14px', background: '#f9fafb', borderLeft: '3px solid #9ca3af', fontSize: 13, color: '#374151' }}>
                  {viewCN.notes}
                </div>
              )}

              <div style={{ marginTop: 14, fontSize: 11, color: '#9ca3af' }}>
                Prepared by {viewCN.created_by_name || '—'} on {formatDate(viewCN.created_at?.split(' ')[0])}
              </div>
            </div>

            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setViewCN(null)} style={{ padding: '10px 18px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                {t('close')}
              </button>
              <button onClick={() => handlePrint(viewCN)} style={{ padding: '10px 22px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                {t('print')}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Supplier drill-down modal (by-supplier rollup) ─────────────────── */}
      {supplierDetail && (() => {
        const cns = list.filter(cn => (cn.supplier_name || '— (no supplier)') === supplierDetail);
        const total = cns.reduce((s, c) => s + parseFloat(c.amount || 0), 0);
        const groupOrder = ['Discount', 'Crate Return', 'Goods Return', 'Other'];
        const groups = groupOrder.map(g => ({
          reason: g,
          rows: cns.filter(c => c.reason === g || (g === 'Crate Return' && c.reason === 'Bottle Return')),
        })).filter(g => g.rows.length > 0);
        return (
          <Portal>
            <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 720, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
                <div style={{ padding: '16px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{supplierDetail}</h2>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                      {cns.length} credit note{cns.length !== 1 ? 's' : ''} · {curSym}{total.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {cns.length > 0 && (() => {
                      const allExpanded = cns.length > 0 && cns.every(c => expandedCNs.has(c.id));
                      return (
                        <button type="button" onClick={() => allExpanded ? collapseAllCNs() : expandAllCNs(cns)}
                          style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#f1f5f9', color: '#0f172a', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                          {allExpanded ? <FiChevronUp size={13} /> : <FiChevronDown size={13} />}
                          {allExpanded ? 'Collapse all' : 'Expand all'}
                        </button>
                      );
                    })()}
                    <button onClick={() => setSupplierDetail(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
                  </div>
                </div>

                <div style={{ padding: 22 }}>
                  {groups.length === 0 ? (
                    <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No credit notes for this supplier in the current filter.</div>
                  ) : groups.map(g => {
                    const sub = g.rows.reduce((s, c) => s + parseFloat(c.amount || 0), 0);
                    const rs = reasonStyle(g.reason);
                    const reasonHasStock = g.reason === 'Crate Return' || g.reason === 'Goods Return';
                    return (
                      <div key={g.reason} style={{ marginBottom: 16, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                        <div style={{ padding: '8px 12px', background: rs.bg, color: rs.color, borderBottom: `1px solid ${rs.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 700, fontSize: 13 }}>{g.reason} · {g.rows.length}</span>
                          <span style={{ fontWeight: 800, fontSize: 13 }}>{curSym}{sub.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                        </div>
                        <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                          <thead style={{ background: '#f9fafb' }}>
                            <tr>
                              <th style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 700, color: '#6b7280', fontSize: 11 }}>CN #</th>
                              <th style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 700, color: '#6b7280', fontSize: 11 }}>Date</th>
                              <th style={{ padding: '7px 10px', textAlign: 'left', fontWeight: 700, color: '#6b7280', fontSize: 11 }}>Reference</th>
                              <th style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: '#6b7280', fontSize: 11 }}>Amount</th>
                              <th style={{ padding: '7px 10px', textAlign: 'center', fontWeight: 700, color: '#6b7280', fontSize: 11, width: 50 }}>View</th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.rows.map(cn => {
                              const isExp = expandedCNs.has(cn.id);
                              const cache = cnItemsCache[cn.id];
                              return (
                                <React.Fragment key={cn.id}>
                                  <tr style={{ borderTop: '1px solid #f3f4f6', background: isExp ? '#f8fafc' : 'transparent' }}>
                                    <td style={{ padding: '8px 10px', fontWeight: 600 }}>{cn.credit_note_number}</td>
                                    <td style={{ padding: '8px 10px', color: '#6b7280' }}>{formatDate(cn.date)}</td>
                                    <td style={{ padding: '8px 10px', color: '#6b7280' }}>{cn.linked_grn_number
                        ? <span title={cn.linked_is_proposed ? 'Proposed — waiting for HQ to confirm' : 'Attached to this GRN'}>
                            <span style={{ fontFamily: 'monospace' }}>{cn.linked_grn_number}</span>
                            {cn.linked_is_proposed && <span style={{ color: '#b45309' }}> · pending</span>}
                          </span>
                        : (cn.reference || '—')}</td>
                                    <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700 }}>{curSym}{parseFloat(cn.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                    <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                                      <button type="button" onClick={() => toggleExpand(cn)} title={isExp ? 'Hide breakdown' : 'Show breakdown'}
                                        style={{ background: 'none', border: 'none', color: isExp ? '#0f172a' : '#0369a1', cursor: 'pointer', padding: 2 }}>
                                        {isExp ? <FiChevronUp size={15} /> : <FiEye size={15} />}
                                      </button>
                                    </td>
                                  </tr>
                                  {isExp && (
                                    <tr style={{ background: '#f8fafc' }}>
                                      <td colSpan={5} style={{ padding: '4px 12px 12px' }}>
                                        {cache?.loading ? (
                                          <div style={{ padding: 10, fontSize: 11, color: '#6b7280' }}>Loading…</div>
                                        ) : cache?.error ? (
                                          <div style={{ padding: 10, fontSize: 11, color: '#dc2626' }}>Failed to load: {cache.error}</div>
                                        ) : reasonHasStock && (cache?.items || []).length > 0 ? (
                                          <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
                                            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                                              <thead style={{ background: '#f3f4f6' }}>
                                                <tr>
                                                  <th style={{ padding: '6px 9px', textAlign: 'left', fontWeight: 600, color: '#6b7280' }}>Product</th>
                                                  <th style={{ padding: '6px 9px', textAlign: 'right', fontWeight: 600, color: '#6b7280' }}>Qty</th>
                                                  <th style={{ padding: '6px 9px', textAlign: 'center', fontWeight: 600, color: '#6b7280' }}>Unit</th>
                                                  <th style={{ padding: '6px 9px', textAlign: 'right', fontWeight: 600, color: '#6b7280' }}>Value</th>
                                                  <th style={{ padding: '6px 9px', textAlign: 'right', fontWeight: 600, color: '#6b7280' }}>Total</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {cache.items.map(it => (
                                                  <tr key={it.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                                                    <td style={{ padding: '6px 9px' }}>{it.product_name}</td>
                                                    <td style={{ padding: '6px 9px', textAlign: 'right' }}>{parseFloat(it.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                                    <td style={{ padding: '6px 9px', textAlign: 'center', color: '#6b7280' }}>{it.unit || it.product_unit || ''}</td>
                                                    <td style={{ padding: '6px 9px', textAlign: 'right' }}>{curSym}{parseFloat(it.unit_value).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                                    <td style={{ padding: '6px 9px', textAlign: 'right', fontWeight: 600 }}>{curSym}{parseFloat(it.total_price).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                                  </tr>
                                                ))}
                                              </tbody>
                                            </table>
                                            {cache.notes && (
                                              <div style={{ padding: '6px 10px', borderTop: '1px solid #f3f4f6', fontSize: 11, color: '#6b7280' }}>
                                                <b>Notes:</b> {cache.notes}
                                              </div>
                                            )}
                                          </div>
                                        ) : cache?.notes ? (
                                          <div style={{ padding: '8px 12px', borderLeft: '3px solid #9ca3af', background: '#fff', fontSize: 11.5, color: '#374151' }}>
                                            <b>Notes:</b> {cache.notes}
                                          </div>
                                        ) : (
                                          <div style={{ padding: 10, fontSize: 11, color: '#9ca3af' }}>
                                            {reasonHasStock ? 'No items recorded.' : 'No notes.'}
                                          </div>
                                        )}
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    );
                  })}
                </div>

                <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button onClick={() => setSupplierDetail(null)} style={{ padding: '10px 18px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    Close
                  </button>
                  <button onClick={() => handlePrintSupplier(supplierDetail)} disabled={cns.length === 0}
                    style={{ padding: '10px 22px', background: cns.length === 0 ? '#9ca3af' : '#1d4ed8', color: '#fff', border: 'none', borderRadius: 8, cursor: cns.length === 0 ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <FiPrinter size={14} /> Print
                  </button>
                </div>
              </div>
            </div>
          </Portal>
        );
      })()}

      {toast && <Toast message={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

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

export default CreditNotes;
