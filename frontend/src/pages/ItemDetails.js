import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getProducts, createProduct, updateProduct, updateProductBarcode, deleteProduct, uploadProductImage, deleteProductImage, getSettings, getCategories, getMainCategories, getUnits, deleteAllProducts, importProducts, isHqHost, getZraItemClasses, getZraCodes, bulkPushPrices, mirrorHqToAllBranches } from '../services/api';
import CategoryFilter from '../components/CategoryFilter';
import CostPrices from './CostPrices';
import MirrorResultModal from '../components/MirrorResultModal';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { FiSearch, FiPlus, FiEdit2, FiTrash2, FiCamera, FiX, FiPrinter, FiUpload, FiDownload, FiAlertTriangle, FiTruck, FiUploadCloud } from 'react-icons/fi';
import { FaBarcode } from 'react-icons/fa';
import { formatStock, formatStockForProduct } from '../utils/unitFormat';
import { unitsForProduct, pickDisplayUnit, displayInDefaultUnit, displayPriceInDefaultUnit } from '../utils/productUnits';
import { useCurrency } from '../context/CurrencyContext';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { matchTokens } from '../utils/tokenSearch';

const API_BASE = process.env.REACT_APP_API_URL?.replace('/api', '') || 'http://localhost:5300';

// 2026-09-02 — "Push Prices to All Branches" HIDDEN at the user's request:
// too dangerous to sit next to the everyday buttons.
//
// One click overwrites the selling price of EVERY product in EVERY one of the
// 15 depots with HQ's price. Prices are branch-owned by design — each depot was
// loaded with its own — and there is no undo. The routine HQ mirror deliberately
// does NOT touch prices (mirrorAllHqToBranches defaults pushPrices = false);
// this button was the single thing in the system that did, and it sat in the
// same toolbar as Print and New Item.
//
// Nothing is deleted. The button, its confirmation modal, the handler and the
// POST /products/bulk-push-prices endpoint are all intact — set this to true to
// bring it back. To change one branch's prices, use HQ → Stock → Branch Prices,
// which changes one branch and shows what it is changing first.
const SHOW_BULK_PUSH_PRICES = false;

// 2026-09-02 - "Import CSV" HIDDEN at the user's request.
//
// It creates items in bulk with no confirmation and no undo, and a wrong file
// lands straight in the catalogue. Item codes are now assigned rather than
// typed and a category is required, so the two rules the form enforces are
// enforced on import too - but the blast radius of a bad file is still every
// row in it.
//
// Nothing is deleted. The button, handleImport, the hidden file input and
// POST /products/import all remain - set this to true to bring it back. A
// genuine bulk load can still be done by running a script against the
// database, which is reviewable before it writes.
const SHOW_IMPORT_CSV = false;

const getCategoryClass = (cat) => {
  const map = { 'Beef': 'category-beef', 'Chicken': 'category-chicken', 'Pork': 'category-pork', 'Lamb': 'category-lamb', 'Processed': 'category-processed' };
  return map[cat] || 'badge-gray';
};

// Inline category badge style for the print document
const catBadgeStyle = (cat) => {
  const map = {
    'Beef':      { background: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5' },
    'Chicken':   { background: '#fef9c3', color: '#854d0e', border: '1px solid #fde68a' },
    'Pork':      { background: '#ede9fe', color: '#5b21b6', border: '1px solid #c4b5fd' },
    'Lamb':      { background: '#dcfce7', color: '#166534', border: '1px solid #86efac' },
    'Processed': { background: '#e0f2fe', color: '#075985', border: '1px solid #7dd3fc' },
  };
  return {
    ...(map[cat] || { background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db' }),
    padding: '2px 8px', borderRadius: 12, fontSize: 10.5, fontWeight: 600, display: 'inline-block',
  };
};

const emptyBarcodeForm = { ub_number_start: 1, ub_number_length: 6, ub_quantity_start: 7, ub_quantity_length: 0, ub_decimal_start: 2 };

const BarcodePreview = ({ form }) => {
  const numStart  = parseInt(form.ub_number_start)  || 0;
  const numLen    = parseInt(form.ub_number_length)  || 0;
  const qStart    = parseInt(form.ub_quantity_start) || 0;
  const qLen      = parseInt(form.ub_quantity_length)|| 0;
  const decStart  = parseInt(form.ub_decimal_start)  || 0;
  const totalLen  = Math.max(numStart + numLen, qLen > 0 ? qStart + qLen : 0) + 1;
  const sample    = '2000006009982'.padEnd(totalLen, '?').slice(0, totalLen);
  return (
    <div style={{ marginTop: 16, padding: '12px 14px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#64748b', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live Preview</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, fontFamily: 'monospace', fontSize: 15 }}>
        {sample.split('').map((char, i) => {
          const isCode   = i >= numStart && i < numStart + numLen;
          const isWeight = qLen > 0 && i >= qStart && i < qStart + qLen;
          return (
            <span key={i} style={{
              padding: '3px 5px', borderRadius: 4, fontWeight: 700,
              background: isCode ? '#dbeafe' : isWeight ? '#dcfce7' : '#f1f5f9',
              color:      isCode ? '#1d4ed8' : isWeight ? '#15803d' : '#94a3b8',
              border: `1px solid ${isCode ? '#93c5fd' : isWeight ? '#86efac' : '#e2e8f0'}`,
            }}>{char}</span>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 12 }}>
        <span style={{ color: '#1d4ed8' }}>■ Product Code (pos {numStart}–{numStart + numLen - 1})</span>
        {qLen > 0 && <span style={{ color: '#15803d' }}>■ Weight (pos {qStart}–{qStart + qLen - 1})</span>}
      </div>
      {qLen > 0 && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#475569' }}>
          Weight digits: <strong>{sample.slice(qStart, qStart + qLen)}</strong> → insert decimal at {decStart} →{' '}
          <strong>{sample.slice(qStart, qStart + decStart)}.{sample.slice(qStart + decStart, qStart + qLen)}</strong> ={' '}
          <strong style={{ color: '#15803d' }}>{parseFloat(sample.slice(qStart, qStart + decStart) + '.' + sample.slice(qStart + decStart, qStart + qLen)).toFixed(3)} kg</strong>
        </div>
      )}
    </div>
  );
};

const ItemDetails = () => {
  // 'items' | 'cost' — the C.P. tab is HQ-only (see the strip below).
  const [tab, setTab] = useState('items');
  const { t } = useLanguage();
  const { hasPermission, user: authUser } = useAuth();
  const { symbol: curSym } = useCurrency();
  // v1.6.1: HQ uses the same Item Details page that branches use. HQ
  // sees the New/Import/Sample buttons; branches don't (only HQ creates).
  // Inside the modal the form is split into two tabs — Item Details
  // (HQ-owned fields) and Pricing & Stock (branch-owned fields). HQ sees
  // only Tab 1; branches see both but Tab 1 is read-only for is_hq_owned=1
  // rows.
  const isBranch = !isHqHost();
  const isHq     = !isBranch;
  // Modal tab state — 'details' (Tab 1) or 'pricing' (Tab 2).
  const [activeTab, setActiveTab] = useState('details');
  const [items, setItems] = useState([]);
  const [dbCategories, setDbCategories] = useState([]);
  const [dbMainCategories, setDbMainCategories] = useState([]);
  const [dbUnits, setDbUnits] = useState([]);
  const [selMainIds, setSelMainIds] = useState(null);
  const [selCatIds, setSelCatIds] = useState(null);
  const [search, setSearch] = useState('');
  // 2026-09-12 — phone only: the full category filter sits behind "Filters".
  const [showPhoneFilters, setShowPhoneFilters] = useState(false);
  // 2026-09-13 — Sync Products to All, moved here from HQ Overview: products
  // are managed on this page, so pushing them to the branches belongs with
  // them. HQ only. Same call and the same summary as before.
  const [mirroring, setMirroring] = useState(false);
  const [mirrorRes, setMirrorRes] = useState(null); // { entities, per_branch, elapsed_ms }
  const [mirrorErr, setMirrorErr] = useState('');
  const runMirror = async () => {
    if (mirroring) return;
    if (!window.confirm('Push every HQ product/category/unit to all branches now? Branch-owned fields (prices, stock, status) will NOT be touched.')) return;
    setMirroring(true);
    setMirrorErr('');
    setMirrorRes(null);
    try {
      const res = await mirrorHqToAllBranches();
      setMirrorRes(res.data);
    } catch (err) {
      setMirrorErr(err?.response?.data?.error || err?.message || 'Sync failed');
    }
    setMirroring(false);
  };
  const [showModal, setShowModal] = useState(false);
  const [editItem, setEditItem] = useState(null);
  // v1.8.1 — Bulk "Transfer all store stock to Sales" modal state.
  // v1.13.91 — bulkSiv state removed with the "Transfer All to Sales" button.
  // packagings: additional larger units (e.g. [{ name: 'Pack', conv: 6, price: 11 }, { name: 'Box', conv: 24, price: 40 }]).
  // The base unit (form.unit) is always the smallest packaging and lives in its own fields.
  // v1.7.2 — opening_base + per-packaging `opening` mirrors Grocery's pattern:
  // user enters how many of each unit they have ("46 Box + 10 Bottle"); save
  // collapses to a single base-unit total stored as current_stock in DB.
  const [form, setForm] = useState({ code: '', name: '', category_id: '', unit: 'pcs', cost_price: '', selling_price: '', current_stock: '', opening_base: '', min_stock: '', min_stock_unit: '', status: 'Active', packagings: [], container_product_sync_id: '', units_per_container: '', default_unit: '' });
  const [formError, setFormError] = useState('');
  // Fix A — "Also apply this price to all branches" checkbox on the HQ
  // product edit modal. When ticked, the PUT body carries
  // push_price_to_all=true so the backend force-overwrites cost/selling/
  // alt + units_json prices on every branch. Reset to false on every
  // open/close.
  const [pushPriceToAll, setPushPriceToAll] = useState(false);
  // Fix A — bulk "Push Prices to All Branches" confirmation modal + busy flag.
  const [showBulkPushConfirm, setShowBulkPushConfirm] = useState(false);
  const [bulkPushing, setBulkPushing] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  // Per-row breakdown of the last import — {imported_rows:[{row,code,name}],
  // skipped_rows:[{row,code,name,reason}]} — shown in a collapsible panel
  // below the status banner so the user can see exactly which CSV rows
  // landed and which got dropped (and why).
  const [importDetail, setImportDetail] = useState(null);
  const [importing, setImporting] = useState(false);
  const csvInputRef = React.useRef(null);
  // Admin-password gate: { kind: 'single' | 'all', item?: { id, name } }
  const [pendingDelete, setPendingDelete] = useState(null);
  // v1.6.7: same gate for unlocking a saved packaging row's conversion
  // factor. Holds the row index that the admin wants to unlock so the
  // password prompt knows which row to flip _locked=false on.
  const [pendingUnlockPack, setPendingUnlockPack] = useState(null);

  const handleDeleteAll = () => {
    setPendingDelete({ kind: 'all' });
  };

  const runDeleteAll = async () => {
    try {
      const res = await deleteAllProducts();
      await fetchItems();
      alert(res?.data?.message || 'Done.');
    } catch (err) {
      alert(err.response?.data?.error || 'Failed to delete all products.');
    }
  };

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    setImporting(true);
    setImportMsg('');
    setImportDetail(null);
    try {
      const res = await importProducts(file);
      setImportMsg(res.data.message);
      setImportDetail({
        imported_rows: res.data.imported_rows || [],
        skipped_rows:  res.data.skipped_rows  || [],
      });
      await fetchItems();
    } catch (err) {
      setImportMsg(err.response?.data?.error || 'Import failed.');
    } finally {
      setImporting(false);
    }
  };

  const handleDownloadSample = () => {
    // v1.6.2 — HQ-only columns. Branch-owned (cost/selling/current_stock/
    // min_stock/alt_price) are intentionally absent: branches set those
    // on their own Item Details page. Backend ignores them on HQ import
    // even if present in the file.
    const csv =
      'code,name,category,main_category,unit,default_unit,alt_unit,conversion_factor,units_per_container\n' +
      'CL001,Castlite 330ml RB,Beer,Beverage,Bottle,Crate,Crate,24,24\n' +
      'EC001,Eagle Cassava 375ml RB,Beer,Beverage,Bottle,Crate,Crate,24,24\n' +
      'SV001,Savanna 330ml,Cider,Beverage,Bottle,Pack,Pack,12,12\n' +
      'HG001,Hunter Gold 750ml,Spirits,Beverage,Bottle,Box,Box,6,6\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'kelete_hq_items.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);

  const [showBarcodeModal, setShowBarcodeModal] = useState(false);
  const [barcodeItem, setBarcodeItem]  = useState(null);
  const [barcodeForm, setBarcodeForm]  = useState(emptyBarcodeForm);

  useModalScrollLock(showModal || showBarcodeModal);
  const [barcodeSaving, setBarcodeSaving] = useState(false);

  // Print preview
  const [showPrintPreview, setShowPrintPreview] = useState(false);
  const [businessInfo, setBusinessInfo] = useState({});

  // Barcode scanner
  const scannerBuffer = useRef('');
  const scannerTimer = useRef(null);
  const itemsRef = useRef([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const handleScannerKey = useCallback((e) => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (e.key === 'Enter') {
      const code = scannerBuffer.current.trim();
      scannerBuffer.current = '';
      clearTimeout(scannerTimer.current);
      if (!code) return;
      const found = itemsRef.current.find(p => p.code && p.code.toLowerCase() === code.toLowerCase());
      if (found) {
        setSearch(found.name);
      } else {
        // Open Add New with scanned code pre-filled
        setEditItem(null);
        setForm({ code, name: '', category_id: '', unit: 'pcs', cost_price: '', selling_price: '', current_stock: '', opening_base: '', min_stock: '', min_stock_unit: '', product_type: 'sellable', status: 'Active', packagings: [], container_product_sync_id: '', units_per_container: '', default_unit: '' });
        setImageFile(null); setImagePreview(null); setFormError('');
        setShowModal(true);
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

  useEffect(() => {
    fetchItems();
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
    getCategories().then(r => setDbCategories(r.data || [])).catch(() => {});
    getMainCategories().then(r => setDbMainCategories(r.data || [])).catch(() => {});
    getUnits().then(r => setDbUnits(r.data || [])).catch(() => {});
  }, []);

  const fetchItems = async () => {
    try {
      const res = await getProducts();
      setItems(res.data || []);
    } catch (err) { setItems([]); }
  };

  const activeCatIds = selCatIds === null ? null : new Set(selCatIds.map(String));
  const filtered = items.filter(i => {
    const matchSearch = matchTokens(search, i.name, i.code, i.barcode);
    const matchCat = activeCatIds === null
      ? true
      : i.category_id ? activeCatIds.has(String(i.category_id)) : false;
    return matchSearch && matchCat;
  });

  // v1.13.174 — every item code is RS + a four-digit number, assigned here
  // and not editable. The old generator built a prefix from the category name
  // (Beer -> BR001, no category -> IT001), which is why the catalogue drifted:
  // nothing in it ever produced an RS code, so all of them were typed by hand.
  //
  // The number continues from the highest NUMBER in any existing code, never
  // the highest string. Sorted as text "RS091" sorts AFTER "RS0099" - at the
  // third character '9' beats '0' - so a string maximum would hand back a
  // number already in use. Matching \d+ at any width also means the legacy
  // three-digit codes (RS088..RS094) still count, and RS091 and RS0091 can
  // never both be issued.
  const nextRsCode = (codes) => {
    const taken = new Set(Array.from(codes, c => String(c || '').trim().toUpperCase()));
    let max = 0;
    for (const c of taken) {
      const m = /^RS(\d+)$/.exec(c);
      if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; }
    }
    let n = max + 1, code;
    do { code = `RS${String(n).padStart(4, '0')}`; n++; } while (taken.has(code));
    return code;
  };

  const handleSave = async () => {
    setFormError('');
    if (!form.code.trim()) {
      setFormError('Item code is required. Enter a code or click ⚡ to generate one.');
      return;
    }
    if (!form.name.trim()) {
      setFormError('Item name is required.');
      return;
    }
    // v1.13.174 — category is mandatory. It was never checked, which is how
    // RS088..RS091 ended up with no category at all. Editing one of those old
    // items now requires picking a category before it will save.
    if (!String(form.category_id || '').trim()) {
      setFormError('Category is required. Pick one before saving.');
      return;
    }
    const duplicate = items.find(i => i.code.trim().toLowerCase() === form.code.trim().toLowerCase() && (!editItem || i.id !== editItem.id));
    if (duplicate) {
      setFormError(`Code "${form.code}" is already used by "${duplicate.name}". Please choose a different code.`);
      return;
    }
    if (form.cost_price !== '' && parseFloat(form.cost_price) < 0) { setFormError('Cost Price cannot be negative.'); return; }
    if (form.selling_price !== '' && parseFloat(form.selling_price) < 0) { setFormError('Selling Price cannot be negative.'); return; }
    if (form.opening_base !== '' && parseFloat(form.opening_base) < 0) { setFormError('Opening Stock cannot be negative.'); return; }
    for (const p of (form.packagings || [])) {
      if (p.opening !== '' && p.opening != null && parseFloat(p.opening) < 0) { setFormError(`Opening for "${p.name}" cannot be negative.`); return; }
    }
    if (form.min_stock !== '' && parseFloat(form.min_stock) < 0) { setFormError('Min. Stock cannot be negative.'); return; }
    // Validate additional packagings: each must have a name + positive conversion factor.
    const seenNames = new Set([(form.unit || '').trim().toLowerCase()]);
    for (const p of (form.packagings || [])) {
      const name = (p.name || '').trim();
      if (!name) { setFormError('Packaging name cannot be empty.'); return; }
      if (seenNames.has(name.toLowerCase())) { setFormError(`Duplicate packaging name: ${name}.`); return; }
      seenNames.add(name.toLowerCase());
      if (!(parseFloat(p.conv) > 0)) { setFormError(`Conversion for "${name}" must be greater than 0.`); return; }
      if (p.price !== '' && parseFloat(p.price) < 0) { setFormError(`Price for "${name}" cannot be negative.`); return; }
    }
    try {
      // Build the units array — base first, then any larger packagings the user added.
      const units = [
        { name: (form.unit || 'pcs').trim() || 'pcs', conv: 1, price: parseFloat(form.selling_price || 0), is_base: true },
        ...(form.packagings || []).map(p => ({
          name: (p.name || '').trim(),
          conv: parseFloat(p.conv) || 0,
          price: parseFloat(p.price || 0),
          is_base: false,
        })),
      ];
      // Min Stock was entered in form.min_stock_unit (e.g. "Box"). Convert back
      // to base units before saving so the DB always holds it in the base unit.
      const minStockUnit = (form.min_stock_unit || '').trim();
      const minStockConv = minStockUnit
        ? (units.find(u => u.name === minStockUnit)?.conv || 1)
        : 1;
      const minStockEntered = form.min_stock === '' ? 10 : parseFloat(form.min_stock);
      // v1.7.2 (Grocery pattern): total opening stock = base qty + Σ(pack.qty × pack.conv).
      // The form lets the user type "46 Box + 10 Bottle"; we collapse it to a single
      // base-unit number (1114 Bottle) before saving. DB stores the total only.
      const openingBaseQty = parseFloat(form.opening_base) || 0;
      const openingPackQty = (form.packagings || []).reduce((sum, p) => {
        const q = parseFloat(p.opening) || 0;
        const c = parseFloat(p.conv) || 0;
        return sum + (q * c);
      }, 0);
      const totalOpening = openingBaseQty + openingPackQty;
      const data = {
        ...form,
        cost_price:    form.cost_price    === '' ? 0  : parseFloat(form.cost_price),
        selling_price: form.selling_price === '' ? 0  : parseFloat(form.selling_price),
        current_stock: totalOpening,
        min_stock:     minStockEntered * minStockConv,
        category_id:   form.category_id   === '' ? null : parseInt(form.category_id),
        units,
        container_product_sync_id: form.container_product_sync_id || null,
        units_per_container: form.units_per_container === '' ? null : parseFloat(form.units_per_container),
        // v1.13.72 — MTV RRP. Blank means "no RRP set" (send null so
        // backend clears the column rather than storing 0, which would
        // force MTV boost to 0 tax).
        zra_rrp:       form.zra_rrp === '' || form.zra_rrp == null ? null : parseFloat(form.zra_rrp),
      };
      delete data.packagings;
      delete data.opening_base;
      delete data.min_stock_unit;
      let savedProduct;
      if (editItem) {
        // Fix A — forward the "Also apply this price to all branches"
        // flag only on PUT. Create path doesn't need it (INSERT into
        // branch already inherits HQ's prices).
        const res = await updateProduct(editItem.id, { ...data, push_price_to_all: pushPriceToAll });
        savedProduct = res.data;
      } else {
        const res = await createProduct(data);
        savedProduct = res.data;
      }
      if (imageFile && savedProduct?.id) await uploadProductImage(savedProduct.id, imageFile);
      // Backend returns .zra = { ok } | { ok:false, error, resultCd } | { skipped }.
      // Only surface a warning when it actively failed — silence when ZRA
      // is off or the call succeeded.
      const zra = savedProduct?.zra;
      if (zra && zra.ok === false) {
        window.alert(`Saved locally, but ZRA registration failed:\n${zra.error || 'unknown error'}\n\nCheck ZRA Smart Invoice → Recent VSDC Calls.`);
      }
      fetchItems();
      setShowModal(false);
      setEditItem(null);
      setImageFile(null);
      setImagePreview(null);
      setFormError('');
      setPushPriceToAll(false);
    } catch (err) {
      setFormError('Failed to save item: ' + (err.response?.data?.error || err.message));
    }
  };

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  };

  const handleRemoveImage = async () => {
    if (editItem?.id && editItem.image_url) {
      try { await deleteProductImage(editItem.id); } catch (err) { /* ignore */ }
    }
    setImageFile(null);
    setImagePreview(null);
    if (editItem) setEditItem(prev => ({ ...prev, image_url: null }));
  };

  const handleDelete = (item) => {
    setPendingDelete({ kind: 'single', item: { id: item.id, name: item.name } });
  };

  const runDeleteSingle = async (id) => {
    try {
      await deleteProduct(id);
      fetchItems();
    } catch (err) {
      // Show the backend's blocking message (e.g. "used in 3 GRN line(s)…") instead of
      // silently removing the row from the UI.
      alert(err.response?.data?.error || err.message || 'Failed to delete item.');
    }
  };

  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (!job) return;
    if (job.kind === 'all') return runDeleteAll();
    if (job.kind === 'single') return runDeleteSingle(job.item.id);
  };

  const openNew = () => {
    setEditItem(null);
    // The code is assigned, not typed. nextRsCode is safe to call here even
    // though the form is being cleared in this same tick: unlike the old
    // generator it reads nothing from form state.
    const code = nextRsCode(items.map(i => i.code));
    setForm({ code, name: '', category_id: '', unit: 'pcs', cost_price: '', selling_price: '', current_stock: '', opening_base: '', min_stock: '', min_stock_unit: '', product_type: 'sellable', status: 'Active', packagings: [], container_product_sync_id: '', units_per_container: '', default_unit: '' });
    setImageFile(null); setImagePreview(null); setFormError('');
    setPushPriceToAll(false);
    setActiveTab('details');
    setShowModal(true);
  };

  // Parse units_json into the form's `packagings` array (skipping the base row, which lives in form.unit / form.selling_price).
  const buildPackagingsFromItem = (item) => {
    let arr = null;
    if (item.units_json) {
      try { arr = JSON.parse(item.units_json); } catch { arr = null; }
    }
    if (Array.isArray(arr) && arr.length) {
      // _locked: this row was loaded from the saved product, so its conversion factor is fixed
      // (historical stock movements rely on it). Price stays editable; users can add NEW packagings freely.
      return arr.filter(u => !u.is_base && (u.name || '').trim()).map(u => ({
        name: u.name, conv: String(u.conv ?? ''), price: String(u.price ?? ''), opening: '', _locked: true,
      }));
    }
    // Legacy fallback — single alt_unit row.
    if (item.alt_unit) {
      return [{ name: item.alt_unit, conv: String(item.conversion_factor ?? ''), price: String(item.alt_price ?? ''), opening: '', _locked: true }];
    }
    return [];
  };

  const openEdit = (item) => {
    setEditItem(item);
    // Min Stock is stored in base units. Display it in the product's default
    // unit (or base if none set) so the user reads/edits in the same unit
    // they see on Stock Card etc.
    const dispUnit = pickDisplayUnit(item);
    const minStockInDispUnit = parseFloat(item.min_stock || 0) / (dispUnit.conv || 1);
    setForm({
      code: item.code, name: item.name, category_id: item.category_id, unit: item.unit,
      cost_price: item.cost_price, selling_price: item.selling_price,
      current_stock: item.current_stock,
      opening_base: item.opening_balance_qty != null ? String(item.opening_balance_qty) : '',
      min_stock: minStockInDispUnit ? String(minStockInDispUnit) : '',
      min_stock_unit: dispUnit.name || item.unit || '',
      product_type: item.product_type || 'finished',
      status: item.status || 'Active',
      packagings: buildPackagingsFromItem(item),
      container_product_sync_id: item.container_product_sync_id || '',
      units_per_container: item.units_per_container ?? '',
      default_unit: item.default_unit || '',
      // ZRA VSDC fields — seed from existing row so an edit doesn't blank
      // them out (undefined would fall through the PUT patch logic).
      hs_code:          item.hs_code || '',
      tax_label:        item.tax_label || '',
      zra_item_cls_cd:  item.zra_item_cls_cd || '',
      zra_item_ty_cd:   item.zra_item_ty_cd || '',
      zra_orgn_nat_cd:  item.zra_orgn_nat_cd || '',
      zra_pkg_unit_cd:  item.zra_pkg_unit_cd || '',
      zra_qty_unit_cd:  item.zra_qty_unit_cd || '',
      zra_vat_cat_cd:   item.zra_vat_cat_cd || '',
      zra_excise_ty_cd: item.zra_excise_ty_cd || '',
      // v1.13.72 — RRP for MTV (cat B) items. String in the form for
      // clean input handling; parsed to REAL at submit time.
      zra_rrp:          item.zra_rrp != null ? String(item.zra_rrp) : '',
    });
    setImageFile(null);
    setImagePreview(item.image_url ? `${API_BASE}${item.image_url}` : null);
    setFormError('');
    setPushPriceToAll(false);
    // Branch editing an HQ-owned item → land on Pricing tab (since Details
    // is read-only there). HQ + non-HQ items → land on Details tab.
    setActiveTab(isBranch && item.is_hq_owned ? 'pricing' : 'details');
    setShowModal(true);
  };

  const closeModal = () => { setShowModal(false); setFormError(''); setPushPriceToAll(false); };

  const openBarcodeSettings = (item) => {
    setBarcodeItem(item);
    const defaultQtyLen = String(item.code || '').length === 6 ? 5 : 0;
    setBarcodeForm({
      ub_number_start:    item.ub_number_start   ?? 1,
      ub_number_length:   item.ub_number_length  ?? 6,
      ub_quantity_start:  item.ub_quantity_start  ?? 7,
      ub_quantity_length: item.ub_quantity_length ?? defaultQtyLen,
      ub_decimal_start:   item.ub_decimal_start   ?? 2,
    });
    setShowBarcodeModal(true);
  };

  const saveBarcodeSettings = async () => {
    setBarcodeSaving(true);
    try {
      const pInt = (val, def) => { const n = parseInt(val); return isNaN(n) ? def : n; };
      const newUB = {
        ub_number_start:    pInt(barcodeForm.ub_number_start,    1),
        ub_number_length:   pInt(barcodeForm.ub_number_length,   6),
        ub_quantity_start:  pInt(barcodeForm.ub_quantity_start,  7),
        ub_quantity_length: pInt(barcodeForm.ub_quantity_length, 0),
        ub_decimal_start:   pInt(barcodeForm.ub_decimal_start,   2),
      };
      const res = await updateProductBarcode(barcodeItem.id, newUB);
      const saved = res.data ? res.data : { ...barcodeItem, ...newUB };
      setItems(prev => prev.map(i => i.id === barcodeItem.id ? { ...i, ...saved } : i));
      setShowBarcodeModal(false);
      fetchItems();
    } catch (err) {
      alert('Failed to save barcode settings: ' + (err.response?.data?.error || err.message));
    } finally { setBarcodeSaving(false); }
  };

  const setBF = (field) => (e) => setBarcodeForm(prev => ({ ...prev, [field]: e.target.value }));
  const inputSt = { width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' };
  const labelSt = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 };

  // ── Print preview stats — follow the filter ──
  const lowStockItems = filtered.filter(i => parseFloat(i.store_balance || 0) <= parseFloat(i.min_stock || 0));
  const categories    = [...new Set(filtered.map(i => i.category_name).filter(Boolean))];

  // Subtotals by main category (for display below the table)
  const subtotalsByMain = (() => {
    const map = new Map();
    for (const item of filtered) {
      const main = dbMainCategories.find(m => String(m.id) === String(item.main_category_id));
      const key = main ? main.id : '__unassigned__';
      const name = main ? main.name : 'Uncategorized';
      const color = main ? main.color : '#6b7280';
      if (!map.has(key)) map.set(key, { name, color, count: 0, totalSell: 0 });
      const entry = map.get(key);
      entry.count += 1;
      entry.totalSell += parseFloat(item.selling_price || 0);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  })();

  const handlePrint = () => {
    const bizName = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  |  ');
    const printedAt = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const avgSell = items.length > 0 ? (items.reduce((s, i) => s + parseFloat(i.selling_price || 0), 0) / items.length).toFixed(2) : '0.00';

    const rows = items.map((item, idx) => {
      const isLow = parseFloat(item.store_balance || 0) <= parseFloat(item.min_stock || 0);
      return `<tr style="border-bottom:1px solid #ddd;background:${isLow ? '#f5f5f5' : idx % 2 === 1 ? '#f9f9f9' : '#fff'}">
        <td style="padding:7px 10px;font-size:10.5px">${idx + 1}</td>
        <td style="padding:7px 10px;font-weight:700;font-family:monospace;font-size:11px">${item.code || '—'}</td>
        <td style="padding:7px 10px;font-weight:500">${item.name}</td>
        <td style="padding:7px 10px">${item.category_name || '—'}</td>
        <td style="padding:7px 10px">${item.unit || '—'}</td>
        <td style="padding:7px 10px;text-align:right;font-family:monospace">${(parseFloat(parseFloat(item.avg_cost_price || item.cost_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        <td style="padding:7px 10px;text-align:right;font-weight:600;font-family:monospace">${(parseFloat(parseFloat(item.selling_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        <td style="padding:7px 10px;text-align:right;font-family:monospace">${(parseFloat(parseFloat(item.min_stock || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
        <td style="padding:7px 10px;text-align:right;font-weight:700;font-family:monospace">${isLow ? '⚠ ' : ''}${(parseFloat(parseFloat(item.store_balance || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} ${item.unit || ''}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 landscape;margin:12mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:8px 10px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10px;background:#f0f0f0;text-align:left}
      tfoot td{padding:9px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:8px;letter-spacing:3px;text-transform:uppercase;margin-bottom:6px">Product Items List</div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${bizName}</div>
          <div style="font-size:10px">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:14px;font-weight:700">${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
          <div style="font-size:9px;margin-top:4px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:14px">
        ${[['Total Items', items.length], ['Categories', categories.length], ['Low Stock', lowStockItems.length], ['Avg. Sell Price', curSym + avgSell]].map(([lbl, val]) => `
          <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
            <div style="font-size:16px;font-weight:800">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:16px">
        <div style="background:#000;padding:7px 12px">
          <span style="font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#fff">Product Inventory</span>
        </div>
        <table style="font-size:11px">
          <thead><tr>
            <th style="width:24px">#</th>
            <th>Code</th><th>Item Name</th><th>Category</th><th>Unit</th>
            <th style="text-align:right">Cost Price</th>
            <th style="text-align:right">Sell Price</th>
            <th style="text-align:right">Min. Stock</th>
            <th style="text-align:right">Store Balance</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>
            <td colspan="5">Total — ${items.length} items</td>
            <td style="text-align:right">—</td>
            <td style="text-align:right">Avg ${curSym}${avgSell}</td>
            <td colspan="2" style="text-align:right">${lowStockItems.length > 0 ? `⚠ ${lowStockItems.length} low on stock` : '✓ All OK'}</td>
          </tr></tfoot>
        </table>
      </div>
      ${lowStockItems.length > 0 ? `
        <div style="border:1.5px solid #000;padding:10px 14px;margin-bottom:16px">
          <div style="font-weight:700;font-size:11px;margin-bottom:4px">⚠ Low Stock Alert</div>
          <div style="font-size:11px">${lowStockItems.map(i => i.name).join(', ')} — at or below minimum threshold</div>
        </div>` : ''}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:24px;margin-bottom:14px">
        ${[['Prepared By', ''], ['Checked By', ''], ['Printed By', printedBy]].map(([label, name]) => `
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px">${bizName} — Confidential</span>
        <span style="font-size:9px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  // 2026-09-21 — a second tab for the opening cost price. It sits here because
  // it is the same list of items seen a different way. Returned separately so
  // the item list below is left exactly as it was.
  //
  // Later the same day — the depots asked for it too. They get the identical
  // screen READ-ONLY: HQ is still the only place a C.P. can be set, but a depot
  // can now see what its own costs are, and which of its items have none.
  const tabStrip = (
    <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid #e5e7eb', marginBottom: 16 }}>
      {[['items', t('itemDetailsTitle')], ['cost', 'Cost Price (C.P.)']].map(([key, label]) => (
        <button key={key} type="button" onClick={() => setTab(key)}
          style={{ padding: '10px 22px', border: 'none', background: 'none', cursor: 'pointer',
                   fontSize: 14, fontWeight: 700, marginBottom: -2,
                   color: tab === key ? '#C8102E' : '#6b7280',
                   borderBottom: tab === key ? '3px solid #C8102E' : '3px solid transparent' }}>
          {label}
        </button>
      ))}
    </div>
  );

  if (tab === 'cost') {
    return (
      <div className="page-content">
        {tabStrip}
        <CostPrices readOnly={!isHqHost()} />
      </div>
    );
  }

  return (
    // 2026-09-12 — item-details-page: on phones index.css lets this page
    // scroll normally; the locked desk layout left the list no height there.
    <div className="page-content item-details-page" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* ── Sticky Top Section ──────────────────────────────────── */}
      <div style={{ flexShrink: 0, background: '#fff', zIndex: 10 }}>
      {tabStrip}
      {/* ── Page Header ──────────────────────────────────────────── */}
      <div className="page-header desk-only">
        <div>
          <h1>{t('itemDetailsTitle')}</h1>
          <p>{t('itemsSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {!isBranch && (
            <button onClick={handleDownloadSample} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              <FiDownload size={14} /> {t('sampleCSV')}
            </button>
          )}
          {SHOW_IMPORT_CSV && !isBranch && (
            <button onClick={() => csvInputRef.current?.click()} disabled={importing} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', background: importing ? '#d1fae5' : 'linear-gradient(135deg,#059669,#10b981)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600, boxShadow: '0 3px 10px rgba(16,185,129,0.3)' }}>
              <FiUpload size={14} /> {importing ? t('importing') : t('importCSV')}
            </button>
          )}
          <input ref={csvInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={handleImport} />
          {isHqHost() && (
            <button onClick={runMirror} disabled={mirroring}
              title="Push every HQ product / category / unit to all branches. Branch prices, stock, and status are preserved."
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', background: mirroring ? '#94a3b8' : '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: mirroring ? 'wait' : 'pointer', fontSize: 13, fontWeight: 600 }}>
              <FiUploadCloud size={14} /> {mirroring ? 'Syncing…' : 'Sync Products to All'}
            </button>
          )}
          <button
            onClick={handlePrint}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500, color: '#374151', transition: 'all 0.15s' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#6b7280'; e.currentTarget.style.background = '#f9fafb'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = '#fff'; }}
          >
            <FiPrinter size={16} /> {t('print')}
          </button>
          {/* v1.13.91 — "Transfer All to Sales" bulk button removed at
              user's request. Backend endpoint bulkSivStoreToSales kept in
              case anything else calls it; only the branch UI + modal +
              handler + state were pulled. */}
          {/* Fix A — HQ-only bulk "Push Prices to All Branches". Wipes
              every branch's price override in one shot. Amber to signal
              destructive-ish (branches lose their local prices). */}
          {SHOW_BULK_PUSH_PRICES && isHqHost() && (
            <button
              onClick={() => setShowBulkPushConfirm(true)}
              disabled={bulkPushing}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', background: bulkPushing ? '#fde68a' : 'linear-gradient(135deg,#d97706,#f59e0b)', color: '#fff', border: 'none', borderRadius: 8, cursor: bulkPushing ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, boxShadow: '0 3px 10px rgba(245,158,11,0.3)' }}
              title="Overwrite every branch's cost/selling/alt prices with HQ's">
              {bulkPushing ? 'Pushing…' : 'Push Prices to All Branches'}
            </button>
          )}
          {!isBranch && hasPermission('Items:Add') && (
          <button className="btn btn-primary" onClick={openNew}>
            <FiPlus /> {t('newItem')}
          </button>
          )}
        </div>
      </div>

      {mirrorErr && (
        <div style={{ marginBottom: 16, padding: '10px 16px', background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Sync failed: {mirrorErr}</span>
          <button onClick={() => setMirrorErr('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}><FiX size={14} /></button>
        </div>
      )}
      {mirrorRes && <MirrorResultModal result={mirrorRes} onClose={() => setMirrorRes(null)} />}

      {importMsg && (
        <div style={{ marginBottom: 16, padding: '10px 16px', background: importMsg.includes('failed') || importMsg.includes('error') ? '#fef2f2' : '#f0fdf4', color: importMsg.includes('failed') || importMsg.includes('error') ? '#dc2626' : '#16a34a', borderRadius: 8, fontSize: 13, fontWeight: 500, border: `1px solid ${importMsg.includes('failed') || importMsg.includes('error') ? '#fecaca' : '#bbf7d0'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{importMsg}</span>
          <button onClick={() => { setImportMsg(''); setImportDetail(null); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}><FiX size={14} /></button>
        </div>
      )}

      {importDetail && (importDetail.imported_rows.length > 0 || importDetail.skipped_rows.length > 0) && (
        <div style={{ marginBottom: 16, display: 'grid', gridTemplateColumns: importDetail.skipped_rows.length > 0 ? '1fr 1fr' : '1fr', gap: 12 }}>
          {importDetail.imported_rows.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #bbf7d0', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '8px 12px', background: '#f0fdf4', color: '#166534', fontSize: 12, fontWeight: 700, borderBottom: '1px solid #bbf7d0' }}>
                ✓ Imported ({importDetail.imported_rows.length})
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', color: '#64748b' }}>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600, width: 40 }}>#</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600, width: 80 }}>Code</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Name</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importDetail.imported_rows.map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '6px 10px', color: '#94a3b8' }}>{r.row}</td>
                        <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.code}</td>
                        <td style={{ padding: '6px 10px' }}>{r.name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {importDetail.skipped_rows.length > 0 && (
            <div style={{ background: '#fff', border: '1px solid #fde68a', borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ padding: '8px 12px', background: '#fffbeb', color: '#92400e', fontSize: 12, fontWeight: 700, borderBottom: '1px solid #fde68a' }}>
                ⚠ Skipped ({importDetail.skipped_rows.length})
              </div>
              <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', color: '#64748b' }}>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600, width: 40 }}>#</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600, width: 80 }}>Code</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Name</th>
                      <th style={{ textAlign: 'left', padding: '6px 10px', fontWeight: 600 }}>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importDetail.skipped_rows.map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '6px 10px', color: '#94a3b8' }}>{r.row}</td>
                        <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.code || '—'}</td>
                        <td style={{ padding: '6px 10px' }}>{r.name || '—'}</td>
                        <td style={{ padding: '6px 10px', color: '#92400e' }}>{r.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 2026-09-12 — phone header, as designed: search with Print and New on
          one line, one sideways row of main categories with their counts, the
          item count with average sell price, and the full filter behind
          "Filters". The title is already in the top bar. */}
      <div className="phone-only" style={{ marginBottom: 10 }}>
        <div className="nowrap-row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <div className="search-input-container" style={{ flex: 1, minWidth: 0, margin: 0 }}>
            <FiSearch style={{ color: '#9ca3af' }} />
            <input type="text" placeholder={t('searchByItemOrCode')} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {isHqHost() && (
            <button onClick={runMirror} disabled={mirroring} title="Sync Products to All" aria-label="Sync Products to All"
              style={{ width: 38, height: 38, flexShrink: 0, background: mirroring ? '#94a3b8' : '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: mirroring ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <FiUploadCloud />
            </button>
          )}
          <button onClick={handlePrint} title={t('print')} aria-label={t('print')}
            style={{ width: 38, height: 38, flexShrink: 0, background: '#fff', color: '#374151', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            <FiPrinter />
          </button>
          {!isBranch && hasPermission('Items:Add') && (
            <button onClick={openNew} title={t('newItem')} aria-label={t('newItem')}
              style={{ width: 38, height: 38, flexShrink: 0, background: '#c8000a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <FiPlus />
            </button>
          )}
        </div>
        {(() => {
          // Counts per main category over everything the search matches, so
          // a chip says how many items tapping it will show.
          const searched = items.filter(i => matchTokens(search, i.name, i.code, i.barcode));
          const count = (mainId) => searched.filter(i => mainId === '__unassigned__'
            ? !i.main_category_id : String(i.main_category_id) === String(mainId)).length;
          const mains = [...dbMainCategories, { id: '__unassigned__', name: 'Uncategorized' }]
            .map(m => ({ ...m, n: count(m.id) }))
            .filter(m => m.n > 0);
          const allOn = selMainIds === null;
          const pickMain = (m) => {
            setSelMainIds([m.id]);
            setSelCatIds(dbCategories
              .filter(c => m.id === '__unassigned__' ? !c.main_category_id : String(c.main_category_id) === String(m.id))
              .map(c => c.id));
          };
          const chip = (on) => ({
            padding: '6px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap', cursor: 'pointer',
            border: `1px solid ${on ? '#13306b' : '#e2e6ee'}`, background: on ? '#13306b' : '#fff', color: on ? '#fff' : '#334155',
          });
          return (
            <div className="cat-filter-row" style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <button type="button" style={chip(allOn)} onClick={() => { setSelMainIds(null); setSelCatIds(null); }}>All {searched.length}</button>
              {mains.map(m => (
                <button key={m.id} type="button" onClick={() => pickMain(m)}
                  style={chip(!allOn && selMainIds.length === 1 && String(selMainIds[0]) === String(m.id))}>
                  {m.name} {m.n}
                </button>
              ))}
            </div>
          );
        })()}
        <div className="nowrap-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#5b6478' }}>
            {filtered.length} item{filtered.length === 1 ? '' : 's'}
            {filtered.length > 0 && <> · avg sell <b style={{ color: '#0f172a' }}>{curSym}{(filtered.reduce((s, i) => s + (parseFloat(i.selling_price) || 0), 0) / filtered.length).toFixed(2)}</b></>}
          </span>
          <button type="button" onClick={() => setShowPhoneFilters(v => !v)}
            style={{ padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, border: '1px solid #e2e6ee', background: showPhoneFilters ? '#e8edf7' : '#fff', color: '#13306b', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            {showPhoneFilters ? 'Hide filters' : 'Filters'}
          </button>
        </div>
        {showPhoneFilters && (
          <div style={{ marginTop: 8 }}>
            <CategoryFilter
              categories={dbCategories}
              mainCategories={dbMainCategories}
              selectedMainIds={selMainIds}
              selectedCatIds={selCatIds}
              onChange={({ mainIds, catIds }) => { setSelMainIds(mainIds); setSelCatIds(catIds); }}
            />
          </div>
        )}
      </div>

      <div className="search-input-container desk-only">
        <FiSearch style={{ color: '#9ca3af' }} />
        <input type="text" placeholder={t('searchByItemOrCode')} value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="desk-only">
      <CategoryFilter
        categories={dbCategories}
        mainCategories={dbMainCategories}
        selectedMainIds={selMainIds}
        selectedCatIds={selCatIds}
        onChange={({ mainIds, catIds }) => { setSelMainIds(mainIds); setSelCatIds(catIds); }}
      />
      </div>
      </div>{/* end sticky top */}

      {subtotalsByMain.length > 1 && (
        <div className="desk-only" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {subtotalsByMain.map(s => (
            <div key={s.name} style={{
              padding: '6px 12px', borderRadius: 8,
              background: (s.color || '#6b7280') + '15',
              border: `1px solid ${(s.color || '#6b7280')}40`,
              fontSize: 12,
            }}>
              <span style={{ color: s.color, fontWeight: 700 }}>{s.name}:</span>
              <span style={{ marginLeft: 6, color: '#374151', fontWeight: 600 }}>
                {s.count} item{s.count !== 1 ? 's' : ''} · avg {curSym}{s.count > 0 ? (s.totalSell / s.count).toFixed(2) : '0.00'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* 2026-09-12 — the phone list, as designed: one card per item. Name
          and selling price; main category · category · code; stock at a depot
          (HQ holds none). Tap to edit. */}
      <div className="phone-only">
        {filtered.map(item => {
          const main = dbMainCategories.find(m => String(m.id) === String(item.main_category_id));
          const sell = parseFloat(displayPriceInDefaultUnit(item.selling_price, item).price) || 0;
          const stock = displayInDefaultUnit(item.store_balance || 0, item);
          const isLow = parseFloat(item.store_balance || 0) <= parseFloat(item.min_stock || 0);
          const canEdit = hasPermission('Items:Edit');
          return (
            <div key={item.id} role={canEdit ? 'button' : undefined} tabIndex={canEdit ? 0 : undefined}
              onClick={canEdit ? () => openEdit(item) : undefined}
              style={{ background: '#fff', border: '1px solid #e2e6ee', borderRadius: 12, padding: '10px 12px', marginBottom: 8,
                       cursor: canEdit ? 'pointer' : 'default', opacity: item.status === 'Inactive' ? 0.55 : 1 }}>
              <div className="nowrap-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: '#0f172a', minWidth: 0 }}>
                  {item.name}
                  {item.status === 'Inactive' && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#6b7280' }}>INACTIVE</span>}
                </div>
                <div style={{ fontWeight: 700, fontSize: 13, fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                  {curSym}{sell.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
              </div>
              <div className="nowrap-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 4 }}>
                <div style={{ fontSize: 11.5, color: '#5b6478', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {main ? main.name : 'Uncategorized'}{item.category_name ? ` · ${item.category_name}` : ''} · <span style={{ fontFamily: 'monospace' }}>{item.code}</span>
                </div>
                {!isHqHost() && (
                  isLow
                    ? <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 800, padding: '1px 8px', borderRadius: 999, background: '#fdecec', color: '#9b0008' }}>{stock.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} {stock.unit} low</span>
                    : <span style={{ flexShrink: 0, fontSize: 11.5, color: '#5b6478', whiteSpace: 'nowrap' }}>{stock.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} {stock.unit}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="desk-only" style={{ flex: 1, overflow: 'auto' }}>
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 52 }}>{t('photo')}</th>
              <th>{t('code')}</th>
              <th>{t('name')}</th>
              <th>{t('category')}</th>
              <th>{t('units')}</th>
              <th>{t('avgCostPrice')}</th>
              <th>{t('sellingPrice')}</th>
              <th>{t('marginPct')}</th>
              <th>{t('minStock')}</th>
              <th>{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(item => (
              <tr key={item.id}>
                <td>
                  {item.image_url ? (
                    <img src={`${API_BASE}${item.image_url}`} alt={item.name} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 8, border: '1px solid #e5e7eb' }} />
                  ) : (
                    <div style={{ width: 40, height: 40, borderRadius: 8, background: '#f3f4f6', border: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#d1d5db' }}>
                      <FiCamera size={16} />
                    </div>
                  )}
                </td>
                <td style={{ fontWeight: 500, opacity: item.status === 'Inactive' ? 0.5 : 1 }}>{item.code}</td>
                <td style={{ fontWeight: 500, opacity: item.status === 'Inactive' ? 0.5 : 1 }}>
                  {item.name}
                  {item.status === 'Inactive' && (
                    <span style={{ marginLeft: 6, padding: '2px 8px', background: '#f3f4f6', color: '#6b7280', borderRadius: 10, fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Inactive</span>
                  )}
                </td>
                <td><span className={`badge ${getCategoryClass(item.category_name)}`}>{item.category_name}</span></td>
                <td>
                  {(() => {
                    const disp = pickDisplayUnit(item);
                    const extras = unitsForProduct(item).filter(u => !u.is_base);
                    return (
                      <>
                        {disp.name}
                        {extras.length > 0 && (
                          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, lineHeight: 1.4 }}>
                            {extras.map(u => (
                              <div key={u.name}>1 {u.name} = {u.conv} {item.unit}</div>
                            ))}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </td>
                <td>{curSym}{(parseFloat(displayPriceInDefaultUnit(item.avg_cost_price || item.cost_price || 0, item).price)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                <td>{curSym}{(parseFloat(displayPriceInDefaultUnit(item.selling_price, item).price)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                <td>
                  {(() => {
                    const cost = parseFloat(item.avg_cost_price || item.cost_price || 0);
                    const sell = parseFloat(item.selling_price || 0);
                    if (!(sell > 0)) return <span style={{ color: '#9ca3af' }}>—</span>;
                    const margin = ((sell - cost) / sell) * 100;
                    const color = margin >= 50 ? '#16a34a' : margin >= 25 ? '#b45309' : '#dc2626';
                    const bg    = margin >= 50 ? '#dcfce7' : margin >= 25 ? '#fef3c7' : '#fee2e2';
                    return (
                      <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 12, fontWeight: 700, background: bg, color }}>
                        {margin.toFixed(1)}%
                      </span>
                    );
                  })()}
                </td>
                <td>
                  {(() => {
                    const m = displayInDefaultUnit(item.min_stock || 0, item);
                    return `${m.qty.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${m.unit}`;
                  })()}
                </td>
                <td>
                  <div className="action-btns">
                    {hasPermission('Items:Edit') && <button className="action-btn edit" onClick={() => openEdit(item)} title="Edit item"><FiEdit2 /></button>}
                    <button
                      onClick={() => openBarcodeSettings(item)}
                      title="Barcode scanner settings"
                      style={{
                        background: parseInt(item.ub_quantity_length) > 0 ? '#f0fdf4' : '#fffbeb',
                        border: `1px solid ${parseInt(item.ub_quantity_length) > 0 ? '#86efac' : '#fcd34d'}`,
                        color: parseInt(item.ub_quantity_length) > 0 ? '#15803d' : '#92400e',
                        borderRadius: 6, padding: '5px 7px', cursor: 'pointer', fontSize: 13, display: 'inline-flex', alignItems: 'center',
                      }}
                    >
                      <FaBarcode />
                    </button>
                    {/* v1.13.148 — Delete removed from HQ per Sirak 2026-08-26,
                        raised mid ZRA UAT-2 T04A live testing: HQ is where
                        real catalog items live and a stray click during a
                        demo could delete production data. Branches keep
                        delete for their own (non-HQ-owned) items only. */}
                    {hasPermission('Items:Delete') && !isHqHost() && !item.is_hq_owned && <button className="action-btn delete" onClick={() => handleDelete(item)} title="Delete item"><FiTrash2 /></button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>{/* end scrollable */}

      {/* ── Add / Edit Modal ──────────────────────────────────────── */}
      {showModal && (() => {
        // v1.6.1: HQ + branches share this same modal, split into two tabs:
        //   Tab 1 (details) — HQ-owned: code, name, category, unit,
        //     packagings, default unit, container, photo, UB barcode.
        //   Tab 2 (pricing) — Branch-owned: cost, selling, min stock,
        //     status, opening stock, notes.
        // HQ sees only Tab 1 (saves push to all branches).
        // Branches see both tabs but Tab 1 is read-only for is_hq_owned
        // items (Tab 2 is where the branch fills its own prices).
        const hqLocked = !!(editItem && editItem.is_hq_owned && isBranch);
        const showDetailsTab = true;            // both hosts can view it
        // v1.13.143 — Fix A follow-up: HQ now owns the initial C.P/S.P
        // (per Sirak, 2026-08-14). Show the Pricing tab at HQ so the
        // operator can actually type prices when creating/editing a
        // product. Old rule was HQ-doesn't-price; new rule is HQ sets
        // defaults + branches optionally override.
        const showPricingTab = true;            // both hosts price now
        // For new items on branch (shouldn't happen via UI, but if it does)
        // both tabs work normally without HQ lock.
        const tab = (!showPricingTab && activeTab === 'pricing') ? 'details'
                  : (showPricingTab && hqLocked && !editItem ? 'details' : activeTab);
        return (
        <Portal>
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} style={{ width: 680 }}>
            {/* Sticky header — item name + breadcrumb (code · category · unit) */}
            <div className="modal-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                <h3 style={{ margin: 0 }}>
                  {editItem
                    ? (form.name || editItem.name || 'Item')
                    : `${t('newEntry')} Item`}
                </h3>
                <button className="modal-close" onClick={closeModal}>×</button>
              </div>
              {editItem && (
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                  {(form.code || editItem.code) && <span style={{ fontFamily: 'monospace' }}>{form.code || editItem.code}</span>}
                  {editItem.category_name && <> · {editItem.category_name}</>}
                  {(form.unit || editItem.unit) && <> · {form.unit || editItem.unit}</>}
                  {editItem.is_hq_owned ? <span style={{ marginLeft: 8, background: '#fef3c7', color: '#92400e', padding: '1px 8px', borderRadius: 8, fontSize: 10, fontWeight: 700, letterSpacing: 0.3 }}>HQ</span> : null}
                </div>
              )}
              {/* Tabs — only when BOTH are visible (branch). HQ sees one
                  panel without tabs. */}
              {(showDetailsTab && showPricingTab) && (
                <div style={{ display: 'flex', gap: 0, marginTop: 12, borderBottom: '1px solid #e5e7eb' }}>
                  {[
                    { key: 'details', label: 'Item Details' },
                    { key: 'pricing', label: 'Pricing & Stock' },
                  ].map(({ key, label }) => (
                    <button key={key} type="button" onClick={() => setActiveTab(key)}
                      style={{
                        padding: '8px 16px', background: 'transparent', border: 'none', cursor: 'pointer',
                        fontSize: 13, fontWeight: tab === key ? 700 : 500,
                        color: tab === key ? '#0ea5e9' : '#64748b',
                        borderBottom: tab === key ? '2px solid #0ea5e9' : '2px solid transparent',
                        marginBottom: -1,
                      }}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="modal-body">
              {formError && (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', fontSize: 13 }}>
                  <span style={{ flexShrink: 0, fontSize: 15, marginTop: 1 }}>⚠</span>
                  <span>{formError}</span>
                </div>
              )}
              {hqLocked && tab === 'details' && (
                <div style={{ marginBottom: 14, padding: '8px 12px', background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, fontSize: 12, color: '#92400e' }}>
                  <strong>HQ-owned item.</strong> These fields are managed centrally and can't be edited at the branch. Switch to <strong>Pricing &amp; Stock</strong> to set Cost / Selling / Min Stock / Status / Opening Stock.
                </div>
              )}
              {tab === 'details' && (<>
              <div className="form-row">
                <div className="form-group">
                  <label>
                    Code <span style={{ color: '#dc2626' }}>*</span>
                    {!editItem && <span style={{ fontSize: 10.5, fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>or click ⚡ to generate</span>}
                  </label>
                  {/* v1.13.174 — assigned, never typed, on new AND on edit.
                      An existing code is also the ZRA fallback identifier
                      (zra_item_cd || code), so letting one be re-typed could
                      break that item's VSDC mapping. */}
                  <input
                    value={form.code}
                    readOnly
                    disabled
                    title="Assigned automatically and cannot be changed"
                    style={{ width: '100%', background: '#f3f4f6', color: '#374151', fontWeight: 700, letterSpacing: 0.5, cursor: 'not-allowed' }}
                  />
                </div>
                <div className="form-group">
                  <label>Item Name <span style={{ color: '#dc2626' }}>*</span></label>
                  <input
                    value={form.name}
                    disabled={hqLocked}
                    onChange={e => { setForm({ ...form, name: e.target.value.toUpperCase() }); setFormError(''); }}
                    placeholder="PRODUCT NAME"
                    style={{ border: formError && !form.name.trim() ? '1.5px solid #dc2626' : undefined, textTransform: 'uppercase' }}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Unit</label>
                  <select value={form.unit || ''} disabled={!!editItem || hqLocked} onChange={e => setForm({ ...form, unit: e.target.value })}>
                    {/* Always include the current value so editing existing products doesn't lose it */}
                    {form.unit && !dbUnits.some(u => u.name === form.unit) && (
                      <option value={form.unit}>{form.unit}</option>
                    )}
                    {dbUnits.length === 0 && !form.unit && <option value="">— No units configured —</option>}
                    {dbUnits.map(u => (
                      <option key={u.id} value={u.name}>{u.name}{u.abbreviation ? ` (${u.abbreviation})` : ''}</option>
                    ))}
                  </select>
                  {dbUnits.length === 0 && (
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                      Add units in <strong>Categories and Units → Units</strong> tab.
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label>Category</label>
                  <select value={form.category_id} disabled={hqLocked} onChange={e => setForm({ ...form, category_id: e.target.value })}>
                    <option value="">Select Category</option>
                    {dbCategories.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* ZRA Smart Invoice fields — only used when VSDC is configured;
                  safe to leave blank otherwise. */}
              <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: '#f8fafc', border: '1px dashed #cbd5e1' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    ZRA Smart Invoice
                  </div>
                  {editItem?.zra_registered_at && (
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: '#dcfce7', color: '#166534' }}>
                      Registered {String(editItem.zra_registered_at).split('T')[0]}
                    </span>
                  )}
                  {editItem?.zra_last_error && !editItem?.zra_registered_at && (
                    <span title={editItem.zra_last_error} style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 12, background: '#fef2f2', color: '#b91c1c', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      Error: {editItem.zra_last_error}
                    </span>
                  )}
                </div>
                {/* v1.13.86 — ZRA classification is HQ-only. Branches see the
                    fields (for confidence + audit) but every input is disabled.
                    RRP consistency across branches is the hard constraint —
                    if Buseko sets RRP=K128 and Garden sets K130, ZRA sees
                    inconsistent MTV declarations for the same SKU. */}
                <div className="form-row">
                  <div className="form-group">
                    <label>UNSPSC Code (Item Class)</label>
                    <UnspscPicker
                      value={form.zra_item_cls_cd || ''}
                      onChange={cd => setForm({ ...form, zra_item_cls_cd: cd })}
                      disabled={hqLocked}
                    />
                  </div>
                  <div className="form-group">
                    <label>VAT Category</label>
                    <ZraVatCategorySelect value={form.zra_vat_cat_cd || ''}
                      onChange={cd => setForm({ ...form, zra_vat_cat_cd: cd })}
                      disabled={hqLocked} />
                  </div>
                  {/* v1.13.72 — MTV RRP. Only rendered for cat B items.
                      Value stored VAT-inclusive (matches how ZB invoices
                      + till receipts present it). At sale time,
                      vsdcClient computes tax on MAX(price, RRP). */}
                  {form.zra_vat_cat_cd === 'B' && (
                    <div className="form-group">
                      <label>
                        RRP (VAT-inc.) <span style={{ color: '#dc2626' }}>*</span>
                      </label>
                      <input type="number" min="0" step="0.01" disabled={hqLocked}
                        value={form.zra_rrp || ''}
                        onChange={e => setForm({ ...form, zra_rrp: e.target.value })}
                        placeholder="e.g. 590.00 (ZRA-declared)" />
                    </div>
                  )}
                  <div className="form-group">
                    <label>Item Type</label>
                    <ZraItemTypeSelect value={form.zra_item_ty_cd || ''}
                      onChange={cd => setForm({ ...form, zra_item_ty_cd: cd })}
                      disabled={hqLocked} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Packaging Unit</label>
                    <ZraCodePicker cls="17" value={form.zra_pkg_unit_cd || ''}
                      onChange={cd => setForm({ ...form, zra_pkg_unit_cd: cd })}
                      disabled={hqLocked}
                      placeholder="Type name or code (e.g. 'bottle' or 'BX')" />
                  </div>
                  <div className="form-group">
                    <label>Quantity Unit</label>
                    <ZraCodePicker cls="10" value={form.zra_qty_unit_cd || ''}
                      onChange={cd => setForm({ ...form, zra_qty_unit_cd: cd })}
                      disabled={hqLocked}
                      placeholder="Type name or code (e.g. 'litre' or 'L')" />
                  </div>
                  <div className="form-group">
                    <label>Origin Country</label>
                    <ZraCodePicker cls="05" value={form.zra_orgn_nat_cd || ''}
                      onChange={cd => setForm({ ...form, zra_orgn_nat_cd: cd })}
                      disabled={hqLocked}
                      placeholder="Type country name or code (e.g. 'Zambia' or 'ZM')" />
                  </div>
                </div>
              </div>
              </>)}{/* end tab===details block A — code/name/unit/category */}
              {tab === 'pricing' && (<>
              <div className="form-row">
                <div className="form-group">
                  <label>
                    Opening Order Price ({curSym} / {form.unit || 'unit'})
                    {(() => {
                      const baseName = (form.unit || 'pcs').trim();
                      const dflt = (form.default_unit || '').trim();
                      return (dflt && dflt !== baseName)
                        ? <span style={{ marginLeft: 6, fontSize: 10, color: '#7c3aed', fontWeight: 600 }}>(auto from {dflt})</span>
                        : null;
                    })()}
                  </label>
                  <input type="number" min="0" step="0.01" value={form.cost_price}
                    onChange={e => setForm({ ...form, cost_price: e.target.value })}
                    onBlur={e => { if (e.target.value !== '' && parseFloat(e.target.value) < 0) setForm(f => ({ ...f, cost_price: '0' })); }} />
                  {editItem && parseFloat(form.cost_price || 0) !== parseFloat(editItem.cost_price || 0) && (
                    <div style={{ marginTop: 6, padding: '8px 10px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, fontSize: 11.5, color: '#92400e', lineHeight: 1.5 }}>
                      <strong>⚠ Changing cost price.</strong> Past sales keep their original COGS — historical Profit
                      Reports won't change. New sales (and any GRN-less products) will use the new cost going forward.
                      Was <strong>{curSym}{(parseFloat(parseFloat(editItem.cost_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong> →
                      Will be <strong>{curSym}{(parseFloat(parseFloat(form.cost_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong>.
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label>
                    Selling Price ({curSym} / {form.unit || 'unit'})
                    {(() => {
                      const baseName = (form.unit || 'pcs').trim();
                      const dflt = (form.default_unit || '').trim();
                      return (dflt && dflt !== baseName)
                        ? <span style={{ marginLeft: 6, fontSize: 10, color: '#7c3aed', fontWeight: 600 }}>(auto from {dflt})</span>
                        : null;
                    })()}
                  </label>
                  <input type="number" min="0" step="0.01" value={form.selling_price}
                    onChange={e => {
                      const v = e.target.value;
                      // If the base unit IS the default unit (or no default set),
                      // a change here propagates: every packaging price becomes
                      // basePrice × conv. Otherwise just update the base price.
                      const baseName = (form.unit || 'pcs').trim();
                      const dflt = (form.default_unit || '').trim() || baseName;
                      if (dflt === baseName) {
                        const base = parseFloat(v) || 0;
                        setForm(f => ({
                          ...f,
                          selling_price: v,
                          packagings: f.packagings.map(p => ({
                            ...p,
                            price: (base * (parseFloat(p.conv) || 0)).toFixed(2),
                          })),
                        }));
                      } else {
                        setForm({ ...form, selling_price: v });
                      }
                    }}
                    onBlur={e => { if (e.target.value !== '' && parseFloat(e.target.value) < 0) setForm(f => ({ ...f, selling_price: '0' })); }} />
                </div>
              </div>
              {/* Fix A — "Also apply this price to all branches" (HQ-only, edit-only).
                  Ticked → PUT body carries push_price_to_all=true → backend
                  force-overwrites branch cost/selling/alt + units_json prices
                  in this call, wiping any local override. Unticked keeps the
                  default sticky-price behaviour (branches keep whatever they
                  set locally). */}
              {isHqHost() && editItem && (
                <div style={{ marginTop: 8, padding: '6px 10px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 6, fontSize: 12 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', color: '#92400e', fontWeight: 600 }}>
                    <input type="checkbox" checked={pushPriceToAll} onChange={e => setPushPriceToAll(e.target.checked)} />
                    Also apply this price to all branches
                    <span style={{ color: '#78350f', fontWeight: 400 }}>(overwrites any branch-set overrides)</span>
                  </label>
                </div>
              )}
              </>)}{/* end tab===pricing block A — cost/selling */}
              {tab === 'details' && (<>

              {/* v1.13.101 — Multi-Unit (Packagings) section hidden for
                  ZRA UAT (2026-07-29). Red Sea sells every product in
                  one unit (Box), so the multi-unit picker adds no value
                  and risks tester confusion. Backend + DB are intact —
                  flip the `false &&` guard back on to restore. */}
              {false && (
              <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginTop: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: '#374151' }}>Packaging (larger units)</div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                      Base unit is <strong>{form.unit || 'pcs'}</strong>. Add packs/boxes that contain multiple {form.unit || 'pcs'} (e.g. 1 Box = 24 {form.unit || 'pcs'}).
                      &nbsp;Add new units on the <em>Categories and Units</em> page.
                    </div>
                  </div>
                  {!hqLocked && (
                    <button type="button"
                      onClick={() => setForm(f => ({ ...f, packagings: [...(f.packagings || []), { name: '', conv: '', price: '' }] }))}
                      style={{ padding: '6px 12px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                      + Add Packaging
                    </button>
                  )}
                </div>

                {(form.packagings || []).length === 0 ? (
                  <div style={{ padding: '12px 14px', background: '#fff', border: '1px dashed #d1d5db', borderRadius: 8, fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
                    No extra packagings yet — this product is only sold in <strong>{form.unit || 'pcs'}</strong>.
                  </div>
                ) : (
                  <div style={{ display: 'grid', gap: 8 }}>
                    {(form.packagings || []).map((p, idx) => {
                      // Only conversion is locked for rows loaded from the saved product; name + price stay editable,
                      // and any "+ Add Packaging" rows added during this session are fully editable.
                      const lockConv = !!p._locked || hqLocked;
                      return (
                        <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1.1fr 1.4fr auto', gap: 8, alignItems: 'end', background: '#fff', padding: 10, borderRadius: 8, border: '1px solid #e5e7eb' }}>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>Unit Name</label>
                            {(() => {
                              // Hide units already used as the base unit or by other packaging rows on this product,
                              // but keep this row's current value selectable so editing doesn't blank it.
                              const usedElsewhere = new Set(
                                (form.packagings || [])
                                  .map((q, i) => i === idx ? null : (q.name || '').trim())
                                  .filter(Boolean)
                              );
                              const baseName = (form.unit || '').trim();
                              const options = (dbUnits || []).filter(u =>
                                u.name === p.name || (u.name !== baseName && !usedElsewhere.has(u.name))
                              );
                              return (
                                <select value={p.name || ''}
                                  disabled={lockConv}
                                  onChange={e => setForm(f => ({ ...f, packagings: f.packagings.map((q, i) => i === idx ? { ...q, name: e.target.value } : q) }))}
                                  style={{ width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: lockConv ? '#f3f4f6' : '#fff' }}>
                                  <option value="">— Select a unit —</option>
                                  {options.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
                                  {/* Preserve a custom name typed in older data so it doesn't silently blank out */}
                                  {p.name && !(dbUnits || []).some(u => u.name === p.name) && (
                                    <option value={p.name}>{p.name} (custom)</option>
                                  )}
                                </select>
                              );
                            })()}
                          </div>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>1 {p.name || 'unit'} = how many {form.unit || 'pcs'}?</label>
                            <input type="number" min="0" step="0.01" value={p.conv}
                              disabled={lockConv}
                              onChange={e => setForm(f => ({ ...f, packagings: f.packagings.map((q, i) => i === idx ? { ...q, conv: e.target.value } : q) }))}
                              placeholder="e.g. 6" />
                          </div>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>Order Price ({curSym} / {p.name || 'unit'}) — derived</label>
                            <div style={{ padding: '8px 10px', background: '#f3f4f6', borderRadius: 6, fontSize: 13, color: '#6b7280', minHeight: 18 }}>
                              {curSym}{(parseFloat(((parseFloat(form.cost_price) || 0) * (parseFloat(p.conv) || 0)))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                            </div>
                          </div>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>Selling Price ({curSym} / {p.name || 'unit'})</label>
                            <input type="number" min="0" step="0.01" value={p.price}
                              onChange={e => {
                                const v = e.target.value;
                                // If this row IS the default unit, editing its
                                // price propagates: base = v / this.conv, other
                                // packagings = base × their conv. Otherwise just
                                // set this row's price (keeps unequal pricing possible).
                                const isDefault = (form.default_unit || '').trim() === (p.name || '').trim();
                                if (isDefault) {
                                  const conv = parseFloat(p.conv) || 1;
                                  const base = (parseFloat(v) || 0) / conv;
                                  setForm(f => ({
                                    ...f,
                                    selling_price: base ? base.toFixed(4) : '',
                                    packagings: f.packagings.map((q, i) => i === idx
                                      ? { ...q, price: v }
                                      : { ...q, price: (base * (parseFloat(q.conv) || 0)).toFixed(2) }),
                                  }));
                                } else {
                                  setForm(f => ({ ...f, packagings: f.packagings.map((q, i) => i === idx ? { ...q, price: v } : q) }));
                                }
                              }}
                              placeholder="0.00" />
                          </div>
                          {/* v1.6.7: when a saved packaging is locked,
                              admin can unlock the conversion via password
                              prompt. After unlock, name/conv/remove are
                              editable. hqLocked rows can't be unlocked
                              from a branch (HQ owns the structure). */}
                          {lockConv && !hqLocked && p._locked && (
                            <button type="button"
                              onClick={() => setPendingUnlockPack(idx)}
                              title="Unlock with admin password to edit conversion or remove"
                              style={{ height: 36, width: 36, background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a', borderRadius: 6, cursor: 'pointer', fontSize: 14 }}>
                              🔒
                            </button>
                          )}
                          <button type="button"
                            disabled={lockConv}
                            onClick={() => setForm(f => ({ ...f, packagings: f.packagings.filter((_, i) => i !== idx) }))}
                            title={lockConv ? 'Saved packagings cannot be removed (history depends on them) — click the 🔒 to unlock' : 'Remove this packaging'}
                            style={{ height: 36, width: 36, background: lockConv ? '#f3f4f6' : '#fee2e2', color: lockConv ? '#9ca3af' : '#dc2626', border: 'none', borderRadius: 6, cursor: lockConv ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700 }}>
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
              )}

              {/* Default unit — auto-selected on GRN/SIV/POS lines (instead of always defaulting to base). */}
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: 14, marginTop: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1e40af', marginBottom: 6 }}>Default unit (auto-selected on GRN, SIV, POS)</div>
                <div style={{ fontSize: 11, color: '#1d4ed8', marginBottom: 10 }}>
                  Pick the unit you sell most often. New rows on GRN, SIV, and POS will start with this unit selected
                  instead of always defaulting to the base unit. Leave blank to use the base unit ({form.unit || 'pcs'}).
                </div>
                <select
                  value={form.default_unit || ''}
                  disabled={hqLocked}
                  onChange={e => setForm({ ...form, default_unit: e.target.value })}
                  style={{ width: '100%', maxWidth: 320, padding: '9px 10px', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 14, background: hqLocked ? '#f1f5f9' : '#fff' }}
                >
                  <option value="">— Use base unit ({form.unit || 'pcs'}) —</option>
                  <option value={form.unit || 'pcs'}>{form.unit || 'pcs'} (base)</option>
                  {(form.packagings || []).filter(p => (p.name || '').trim()).map((p, idx) => (
                    <option key={idx} value={p.name}>{p.name} (1 = {p.conv} {form.unit || 'pcs'})</option>
                  ))}
                </select>
              </div>

              {/* Returnable container link — used by GRN to record empties returned / new crates received. */}
              <div style={{ background: '#fefce8', border: '1px solid #fde68a', borderRadius: 10, padding: 14, marginTop: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#78350f', marginBottom: 6 }}>Returnable Container (Crate / Empties)</div>
                <div style={{ fontSize: 11, color: '#92400e', marginBottom: 10 }}>
                  If this product is sold in a deposit-bearing crate (you pay for empty crates from the supplier and get refunds when you return them), link it here.
                  The GRN form will show a container sub-row whenever you receive this product. Leave blank for items without crates.
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Container Product</label>
                    <select value={form.container_product_sync_id || ''}
                      disabled={hqLocked}
                      onChange={e => setForm({ ...form, container_product_sync_id: e.target.value })}>
                      <option value="">— No linked container —</option>
                      {items
                        .filter(p => !editItem || p.sync_id !== editItem.sync_id)
                        // Only items in the "Crates" category — keeps non-container
                        // products (beers, drinks, etc.) out of this list.
                        .filter(p => (p.category_name || '').toLowerCase() === 'crates')
                        .map(p => (
                          <option key={p.sync_id} value={p.sync_id}>{p.code ? `${p.code} · ` : ''}{p.name}</option>
                        ))}
                    </select>
                    <small style={{ color: '#92400e', fontSize: 11 }}>Pick the empty-crate product from the <strong>Crates</strong> category (create it as a normal item first, with a cost = deposit price).</small>
                  </div>
                  <div className="form-group">
                    <label>Units per Container</label>
                    <input type="number" min="0" step="1" value={form.units_per_container}
                      disabled={hqLocked}
                      onChange={e => setForm({ ...form, units_per_container: e.target.value })}
                      placeholder="e.g. 24" />
                    <small style={{ color: '#92400e', fontSize: 11 }}>How many bottles fit in one crate (used by GRN to suggest crate count).</small>
                  </div>
                </div>
              </div>
              </>)}{/* end tab===details block B — packagings/default/container */}
              {tab === 'pricing' && (<>
              {/* v1.7.2 (Grocery pattern): one Opening input per unit (base + each
                  packaging). User types "46 Box + 10 Bottle"; save collapses to
                  base total. Editing here replaces the prior opening movement. */}
              <div className="form-row">
                <div className="form-group">
                  <label>Opening Stock ({form.unit || 'unit'})</label>
                  <input type="number" min="0" step="0.01" value={form.opening_base}
                    onChange={e => setForm({ ...form, opening_base: e.target.value })}
                    onBlur={e => { if (e.target.value !== '' && parseFloat(e.target.value) < 0) setForm(f => ({ ...f, opening_base: '0' })); }}
                    placeholder={`how many loose ${form.unit || 'pcs'}`} />
                  {editItem && (
                    <div style={{ fontSize: 10, color: '#92400e', marginTop: 4 }}>
                      Saving voids the prior opening movement and writes a new one with the total below.
                    </div>
                  )}
                </div>
              </div>

              {/* Per-packaging opening + price (only when item has packagings). */}
              {(form.packagings || []).length > 0 && (
                <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginTop: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Packaging pricing &amp; opening</div>
                  <div style={{ display: 'grid', gap: 8 }}>
                    {(form.packagings || []).map((p, idx) => (
                      <div key={idx} style={{ background: '#fff', padding: 10, borderRadius: 8, border: '1px solid #e5e7eb' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#111827', marginBottom: 8 }}>
                          {p.name || '(unnamed packaging)'}
                          <span style={{ marginLeft: 8, color: '#6b7280', fontWeight: 400, fontSize: 11 }}>
                            (1 {p.name || 'unit'} = {p.conv || '?'} {form.unit || 'pcs'})
                          </span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, alignItems: 'end' }}>
                          {/* v1.8.71 — when this packaging is the DEFAULT unit (Box, Crate, etc.),
                              editing its price drives the base unit price + cascades to siblings.
                              Non-default packagings still allow per-packaging override. */}
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>
                              Cost ({curSym} / {p.name || 'unit'})
                              {(() => {
                                const baseName = (form.unit || 'pcs').trim();
                                const dflt = (form.default_unit || '').trim() || baseName;
                                return (p.name || '').trim() === dflt
                                  ? <span style={{ marginLeft: 6, fontSize: 9, color: '#7c3aed', fontWeight: 700 }}>(drives base)</span>
                                  : null;
                              })()}
                            </label>
                            {/* v1.10.11 — mirror Selling behaviour: store what
                                the user typed in packagings[idx].cost so the
                                input shows their exact value (not the rounded
                                base×conv re-render). Base cost_price still gets
                                updated so it drives siblings + saves correctly. */}
                            <input type="number" min="0" step="0.01"
                              value={(() => {
                                if (p.cost !== undefined && p.cost !== '') return p.cost;
                                const conv = parseFloat(p.conv) || 0;
                                const base = parseFloat(form.cost_price);
                                if (conv <= 0 || !base) return '';
                                return (base * conv).toFixed(2);
                              })()}
                              onChange={e => {
                                const conv = parseFloat(p.conv) || 0;
                                if (conv <= 0) return;
                                const raw = e.target.value;
                                const entered = parseFloat(raw);
                                const base = isNaN(entered) ? '' : (entered / conv);
                                setForm(f => ({
                                  ...f,
                                  cost_price: base === '' ? '' : base.toFixed(6),
                                  packagings: f.packagings.map((q, i) => i === idx ? { ...q, cost: raw } : q),
                                }));
                              }}
                              placeholder="0.00" />
                          </div>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>
                              Selling ({curSym} / {p.name || 'unit'})
                              {(() => {
                                const baseName = (form.unit || 'pcs').trim();
                                const dflt = (form.default_unit || '').trim() || baseName;
                                return (p.name || '').trim() === dflt
                                  ? <span style={{ marginLeft: 6, fontSize: 9, color: '#7c3aed', fontWeight: 700 }}>(drives base)</span>
                                  : null;
                              })()}
                            </label>
                            <input type="number" min="0" step="0.01"
                              value={(() => {
                                // v1.7.7: if user hasn't set a per-packaging price yet,
                                // display the derived base × conv as a hint. Do NOT back-
                                // solve to selling_price on edit — that truncation lost
                                // precision (e.g. 29.30/24 → 1.2208 → ×24 → 29.2992).
                                // Just store the typed value in packagings[idx].price.
                                const stored = parseFloat(p.price);
                                if (stored > 0) return p.price;
                                const conv = parseFloat(p.conv) || 0;
                                const base = parseFloat(form.selling_price);
                                if (conv <= 0 || !base) return p.price || '';
                                return (base * conv).toFixed(2);
                              })()}
                              onChange={e => {
                                // v1.8.71 — when editing the DEFAULT packaging's selling price,
                                // derive base selling_price = entered/conv AND cascade to all
                                // other packagings (clearing their per-row override). For non-
                                // default packagings, keep the existing override behavior.
                                const baseName = (form.unit || 'pcs').trim();
                                const dflt = (form.default_unit || '').trim() || baseName;
                                const isDefault = (p.name || '').trim() === dflt;
                                const conv = parseFloat(p.conv) || 0;
                                if (isDefault && conv > 0) {
                                  const entered = parseFloat(e.target.value);
                                  const base = isNaN(entered) ? '' : (entered / conv);
                                  setForm(f => ({
                                    ...f,
                                    selling_price: base === '' ? '' : base.toFixed(4),
                                    // Clear stored overrides — siblings now derive from base × conv.
                                    packagings: f.packagings.map((q, i) => ({ ...q, price: i === idx ? e.target.value : '' })),
                                  }));
                                } else {
                                  setForm(f => ({
                                    ...f,
                                    packagings: f.packagings.map((q, i) => i === idx ? { ...q, price: e.target.value } : q),
                                  }));
                                }
                              }}
                              placeholder="0.00" />
                          </div>
                          <div className="form-group" style={{ margin: 0 }}>
                            <label style={{ fontSize: 11 }}>Opening ({p.name || 'unit'})</label>
                            <input type="number" min="0" step="0.01" value={p.opening || ''}
                              onChange={e => setForm(f => ({ ...f, packagings: f.packagings.map((q, i) => i === idx ? { ...q, opening: e.target.value } : q) }))}
                              placeholder="0" />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Total Opening Balance + Min Stock summary card. */}
              {(() => {
                const baseName = (form.unit || 'pcs').trim() || 'pcs';
                const openingBase = parseFloat(form.opening_base) || 0;
                const packs = (form.packagings || []).map(p => ({
                  name: (p.name || '').trim(),
                  conv: parseFloat(p.conv) || 0,
                  qty: parseFloat(p.opening) || 0,
                })).filter(p => p.qty > 0 && p.conv > 0);
                const totalBase = openingBase + packs.reduce((s, p) => s + p.qty * p.conv, 0);
                const dfltName = (form.default_unit || '').trim() || baseName;
                const dfltConv = dfltName === baseName ? 1 : ((form.packagings || []).find(p => (p.name || '').trim() === dfltName)?.conv || 1);
                const totalInDflt = dfltConv > 0 ? totalBase / dfltConv : totalBase;
                const breakdown = [
                  ...packs.map(p => `${p.qty} ${p.name}`),
                  openingBase > 0 ? `${openingBase} ${baseName}` : null,
                ].filter(Boolean).join(' + ');
                return (
                  <div style={{ background: 'linear-gradient(135deg, #1F213F 0%, #494D6F 100%)', borderRadius: 12, padding: 16, marginTop: 12, color: '#fff' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                      <span style={{ fontSize: 18 }}>📦</span>
                      <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', color: '#F6C96B' }}>Total Opening Balance</div>
                    </div>
                    <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1 }}>
                      {totalInDflt.toLocaleString(undefined, { maximumFractionDigits: 3 })} <span style={{ fontSize: 16, fontWeight: 600, opacity: 0.85 }}>{dfltName}</span>
                    </div>
                    {breakdown && (
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>
                        = {breakdown} = {totalBase.toLocaleString(undefined, { maximumFractionDigits: 3 })} {baseName}
                      </div>
                    )}
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.15)' }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: '#F6C96B', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Minimum Stock</div>
                      <div style={{ display: 'flex', gap: 6, maxWidth: 280 }}>
                        <input type="number" min="0" step="0.01" value={form.min_stock}
                          onChange={e => setForm({ ...form, min_stock: e.target.value })}
                          onBlur={e => { if (e.target.value !== '' && parseFloat(e.target.value) < 0) setForm(f => ({ ...f, min_stock: '0' })); }}
                          style={{ flex: 2, minWidth: 0, width: '100%', padding: '7px 10px', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 13 }} />
                        {(() => {
                          const opts = [
                            { name: baseName, conv: 1 },
                            ...(form.packagings || [])
                              .filter(pp => (pp.name || '').trim() && parseFloat(pp.conv) > 0)
                              .map(pp => ({ name: pp.name.trim(), conv: parseFloat(pp.conv) })),
                          ];
                          const currentUnit = form.min_stock_unit || form.default_unit || baseName;
                          return (
                            <select
                              value={currentUnit}
                              onChange={e => setForm({ ...form, min_stock_unit: e.target.value })}
                              style={{ flex: 1, minWidth: 70, padding: '6px 8px', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 6, background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 13 }}
                            >
                              {opts.map(o => (
                                <option key={o.name} value={o.name} style={{ color: '#1F213F' }}>{o.name}</option>
                              ))}
                            </select>
                          );
                        })()}
                      </div>
                    </div>
                  </div>
                );
              })()}
              </>)}{/* end tab===pricing block B — opening stock + packagings + total */}
              {tab === 'details' && (<>
              <div className="form-group" style={{ marginTop: 4 }}>
                <label>Product Photo</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6 }}>
                  {imagePreview ? (
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <img src={imagePreview} alt="preview" style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 10, border: '2px solid #e5e7eb' }} />
                      <button type="button" onClick={handleRemoveImage} style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', background: '#dc2626', color: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, padding: 0 }}>
                        <FiX size={11} />
                      </button>
                    </div>
                  ) : (
                    <div style={{ width: 80, height: 80, borderRadius: 10, border: '2px dashed #d1d5db', background: '#f9fafb', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', flexShrink: 0 }}>
                      <FiCamera size={22} />
                      <span style={{ fontSize: 10, marginTop: 4 }}>No photo</span>
                    </div>
                  )}
                  <div>
                    {hqLocked ? (
                      <div style={{ fontSize: 12, color: '#92400e', background: '#fef3c7', border: '1px solid #fde68a', padding: '6px 10px', borderRadius: 6 }}>Photo is managed by HQ.</div>
                    ) : (
                      <>
                        <label htmlFor="product-image-input" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, cursor: 'pointer', background: 'linear-gradient(135deg, #2563eb, #1d4ed8)', color: '#fff', fontSize: 13, fontWeight: 600, boxShadow: '0 2px 8px rgba(37,99,235,0.3)' }}>
                          <FiCamera size={14} /> {imagePreview ? 'Change Photo' : 'Upload Photo'}
                        </label>
                        <input id="product-image-input" type="file" accept="image/*" onChange={handleImageChange} style={{ display: 'none' }} />
                        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#9ca3af' }}>JPG, PNG, WEBP · Max 5MB</p>
                      </>
                    )}
                  </div>
                </div>
              </div>
              </>)}{/* end tab===details block C — photo */}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={closeModal}>{t('cancel')}</button>
              <button className="btn btn-primary" onClick={handleSave}>{t('save')} Item</button>
            </div>
          </div>
        </div>
        </Portal>
        );
      })()}

      {/* ── Barcode Settings Modal ────────────────────────────────── */}
      {showBarcodeModal && barcodeItem && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <FaBarcode style={{ color: '#2563eb', fontSize: 18 }} />
                  <h3 style={{ margin: 0, fontSize: 16 }}>Barcode Scanner Settings</h3>
                </div>
                <p style={{ margin: 0, fontSize: 12, color: '#6b7280' }}>{barcodeItem.name} ({barcodeItem.code})</p>
              </div>
              <button onClick={() => setShowBarcodeModal(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#6b7280', padding: 0, lineHeight: 1 }}>×</button>
            </div>
            <div style={{ padding: '20px 24px' }}>
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#1e40af', marginBottom: 20 }}>
                Configure where in the barcode the <strong>product code</strong> and <strong>weight</strong> are located. Set <em>Quantity Length</em> to <strong>0</strong> for regular (non-weight) barcodes.
              </div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#1d4ed8', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ background: '#dbeafe', color: '#1d4ed8', padding: '2px 8px', borderRadius: 4 }}>■</span> Product Code Position
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelSt}>Start Position (0-indexed)</label>
                    <input style={inputSt} type="number" min="0" value={barcodeForm.ub_number_start} onChange={setBF('ub_number_start')} />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>e.g. 1 → skip first digit</div>
                  </div>
                  <div>
                    <label style={labelSt}>Code Length (digits)</label>
                    <input style={inputSt} type="number" min="1" value={barcodeForm.ub_number_length} onChange={setBF('ub_number_length')} />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>e.g. 6 → read 6 digits</div>
                  </div>
                </div>
              </div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ background: '#dcfce7', color: '#15803d', padding: '2px 8px', borderRadius: 4 }}>■</span> Weight / Quantity Position
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelSt}>Start Position</label>
                    <input style={inputSt} type="number" min="0" value={barcodeForm.ub_quantity_start} onChange={setBF('ub_quantity_start')} />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>e.g. 7</div>
                  </div>
                  <div>
                    <label style={labelSt}>Length (0 = none)</label>
                    <input style={inputSt} type="number" min="0" value={barcodeForm.ub_quantity_length} onChange={setBF('ub_quantity_length')} />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>e.g. 5 digits</div>
                  </div>
                  <div>
                    <label style={labelSt}>Decimal At</label>
                    <input style={inputSt} type="number" min="0" value={barcodeForm.ub_decimal_start} onChange={setBF('ub_decimal_start')} />
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>e.g. 2 → XX.XXX</div>
                  </div>
                </div>
              </div>
              <BarcodePreview form={barcodeForm} />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                <button onClick={() => setShowBarcodeModal(false)} style={{ padding: '9px 20px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
                <button onClick={saveBarcodeSettings} disabled={barcodeSaving} style={{ padding: '9px 24px', background: barcodeSaving ? '#9ca3af' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: barcodeSaving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
                  {barcodeSaving ? 'Saving...' : 'Save Settings'}
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Print Preview ─────────────────────────────────────────── */}
      {false && (
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
                Print Preview — Items List ({items.length} items)
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => window.print()}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
              >
                <FiPrinter size={14} /> Print
              </button>
              <button
                onClick={() => setShowPrintPreview(false)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}
              >
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
            <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%)', padding: '28px 44px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>
                  {businessInfo.business_name || 'Business Name'}
                </div>
                <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.7 }}>
                  {[businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  |  ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.65, marginBottom: 6 }}>Product Items List</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>
                  {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                </div>
              </div>
            </div>

            {/* Accent bar */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #ef4444, #8b5cf6)' }} />

            {/* Body */}
            <div style={{ padding: '26px 44px 36px' }}>

              {/* Summary chips */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Total Items',   value: items.length,        bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
                  { label: 'Categories',    value: categories.length,   bg: '#f0fdf4', color: '#15803d', border: '#86efac' },
                  { label: 'Low Stock',     value: lowStockItems.length, bg: lowStockItems.length > 0 ? '#fef2f2' : '#f0fdf4', color: lowStockItems.length > 0 ? '#dc2626' : '#15803d', border: lowStockItems.length > 0 ? '#fca5a5' : '#86efac' },
                  { label: 'Avg. Sell Price', value: items.length > 0 ? '$' + (items.reduce((s, i) => s + parseFloat(i.selling_price || 0), 0) / items.length).toFixed(2) : '$0.00', bg: '#fff7ed', color: '#c2410c', border: '#fed7aa' },
                ].map(chip => (
                  <div key={chip.label} style={{ padding: '12px 16px', borderRadius: 10, background: chip.bg, border: `1.5px solid ${chip.border}`, textAlign: 'center' }}>
                    <div style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 600, marginBottom: 6 }}>{chip.label}</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: chip.color }}>{chip.value}</div>
                  </div>
                ))}
              </div>

              {/* Items table */}
              <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                {/* Table header */}
                <div style={{ background: '#f8fafc', borderBottom: '1.5px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px' }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#2563eb', display: 'inline-block', flexShrink: 0 }} />
                  <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#475569' }}>
                    Product Inventory
                  </span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb' }}>
                      {['#', 'Code', 'Item Name', 'Category', 'Unit', 'Cost Price', 'Selling Price', 'Min. Stock', 'Store Balance'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: i >= 5 ? 'right' : 'left', fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb', fontSize: 10.5, letterSpacing: 0.3, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, idx) => {
                      const isLow = parseFloat(item.store_balance || 0) <= parseFloat(item.min_stock || 0);
                      return (
                        <tr key={item.id} style={{ borderBottom: '1px solid #f1f5f9', background: isLow ? '#fff5f5' : idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                          <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10.5 }}>{idx + 1}</td>
                          <td style={{ padding: '8px 12px', fontWeight: 700, color: '#374151', fontFamily: 'monospace', fontSize: 11 }}>{item.code}</td>
                          <td style={{ padding: '8px 12px', fontWeight: 500, color: '#1e293b' }}>{item.name}</td>
                          <td style={{ padding: '8px 12px' }}>
                            <span style={catBadgeStyle(item.category_name)}>{item.category_name || '—'}</span>
                          </td>
                          <td style={{ padding: '8px 12px', color: '#374151' }}>{item.unit}</td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                            {curSym}{(parseFloat(parseFloat(item.avg_cost_price || item.cost_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, fontFamily: 'monospace', color: '#1d4ed8' }}>
                            {curSym}{(parseFloat(parseFloat(item.selling_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#6b7280' }}>
                            {(parseFloat(parseFloat(item.min_stock || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: isLow ? '#dc2626' : '#16a34a' }}>
                            {isLow ? '⚠ ' : ''}{(parseFloat(parseFloat(item.store_balance || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {item.unit}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f8fafc', borderTop: '2px solid #e2e8f0' }}>
                      <td colSpan={5} style={{ padding: '10px 12px', fontWeight: 700, fontSize: 11, color: '#374151' }}>
                        Total — {items.length} items
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', fontSize: 11 }}>
                        —
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#1d4ed8', fontSize: 11 }}>
                        Avg ${items.length > 0 ? (items.reduce((s, i) => s + parseFloat(i.selling_price || 0), 0) / items.length).toFixed(2) : '0.00'}
                      </td>
                      <td colSpan={2} style={{ padding: '10px 12px', textAlign: 'right', fontSize: 11, color: lowStockItems.length > 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>
                        {lowStockItems.length > 0 ? `⚠ ${lowStockItems.length} item${lowStockItems.length > 1 ? 's' : ''} low on stock` : '✓ All stock levels OK'}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Low stock notice */}
              {lowStockItems.length > 0 && (
                <div style={{ border: '1px solid #fca5a5', borderRadius: 8, padding: '10px 16px', background: '#fff5f5', marginBottom: 20, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span style={{ fontSize: 14, color: '#dc2626', flexShrink: 0 }}>⚠</span>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 11, color: '#dc2626', marginBottom: 3 }}>Low Stock Alert</div>
                    <div style={{ fontSize: 11, color: '#7f1d1d' }}>
                      {lowStockItems.map(i => i.name).join(', ')} — stock at or below minimum threshold
                    </div>
                  </div>
                </div>
              )}

              {/* Legend */}
              <div style={{ display: 'flex', gap: 20, marginBottom: 20, fontSize: 10.5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 12, height: 12, background: '#fff5f5', border: '1px solid #fca5a5', borderRadius: 3, display: 'inline-block' }} />
                  <span style={{ color: '#6b7280' }}>Low / zero stock row</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: '#dc2626', fontWeight: 700 }}>⚠</span>
                  <span style={{ color: '#6b7280' }}>Balance at or below minimum</span>
                </div>
              </div>

              {/* Footer */}
              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>
                  {businessInfo.business_name || 'Business'} — Confidential
                </span>
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

      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={
          pendingDelete?.kind === 'all'
            ? 'ALL products with no GRN/SIV/sales history'
            : pendingDelete?.kind === 'single'
              ? `Product: ${pendingDelete.item.name}`
              : ''
        }
        actionLabel={pendingDelete?.kind === 'all' ? 'Delete All' : 'Confirm Delete'}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      {/* v1.6.7: unlock a saved packaging row's conversion / remove with
          admin password. Safer than dropping the lock entirely because
          historical movements may depend on the existing conversion. */}
      <AdminPasswordPrompt
        open={pendingUnlockPack !== null}
        subject={pendingUnlockPack !== null && form.packagings?.[pendingUnlockPack]
          ? `Edit packaging: ${form.packagings[pendingUnlockPack].name || 'unit'} (existing stock movements rely on the current conversion)`
          : 'Edit packaging'}
        actionLabel="Unlock"
        onConfirm={() => {
          if (pendingUnlockPack !== null) {
            const idx = pendingUnlockPack;
            setForm(f => ({
              ...f,
              packagings: f.packagings.map((q, i) => i === idx ? { ...q, _locked: false } : q),
            }));
          }
          setPendingUnlockPack(null);
        }}
        onCancel={() => setPendingUnlockPack(null)}
      />

      {/* Fix A — bulk "Push Prices to All Branches" confirmation modal. */}
      {showBulkPushConfirm && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: 10, padding: 22, width: 'min(520px, 92vw)', boxShadow: '0 10px 40px rgba(0,0,0,0.25)' }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#b45309', marginBottom: 10 }}>
              Push Prices to All Branches?
            </div>
            <div style={{ fontSize: 13.5, color: '#374151', lineHeight: 1.55, marginBottom: 8 }}>
              This will overwrite <strong>ALL branch price overrides</strong> across ALL products.
            </div>
            <div style={{ fontSize: 12.5, color: '#6b7280', lineHeight: 1.55, marginBottom: 18 }}>
              Any custom price a branch has set (e.g. Buseko selling Black Label at K475 instead of the HQ default K480) will be reset to the HQ price.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                onClick={() => setShowBulkPushConfirm(false)}
                disabled={bulkPushing}
                style={{ padding: '9px 16px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, cursor: bulkPushing ? 'default' : 'pointer', fontSize: 13, fontWeight: 600 }}>
                Cancel
              </button>
              <button
                onClick={async () => {
                  setBulkPushing(true);
                  try {
                    const res = await bulkPushPrices();
                    const d = res.data || {};
                    const branches = d.branch_count ?? 0;
                    const items    = d.entities?.products ?? 0;
                    const errs = Object.values(d.per_branch || {})
                      .flatMap(b => b.products?.errors || []).length;
                    setShowBulkPushConfirm(false);
                    fetchItems();
                    alert(`Pushed ${items} product price(s) to ${branches} branch(es).${errs ? ` ${errs} error(s) — check server logs.` : ''}`);
                  } catch (e) {
                    alert('Failed to push prices: ' + (e.response?.data?.error || e.message));
                  } finally {
                    setBulkPushing(false);
                  }
                }}
                disabled={bulkPushing}
                style={{ padding: '9px 16px', background: bulkPushing ? '#fbbf24' : 'linear-gradient(135deg,#d97706,#f59e0b)', color: '#fff', border: 'none', borderRadius: 8, cursor: bulkPushing ? 'default' : 'pointer', fontSize: 13, fontWeight: 600 }}>
                {bulkPushing ? 'Pushing…' : 'Yes, push prices to all branches'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// v1.13.42 — Searchable UNSPSC picker. Loads the current name for the
// stored code on mount, then debounces free-text search against the
// /zra/item-classes endpoint. Prevents cashiers from having to memorise
// 8-digit codes and keeps them from typing anything invalid.
function UnspscPicker({ value, onChange, disabled = false }) {
  const [query, setQuery] = React.useState('');
  const [results, setResults] = React.useState([]);
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [selectedName, setSelectedName] = React.useState('');
  // v1.13.146 — was permanently ambiguous: the label said "(loading
  // name…)" whether the lookup was still in flight OR had finished and
  // genuinely found nothing (code not present in the local
  // zra_item_classes cache — e.g. only a partial UNSPSC sync has run).
  // Sirak flagged this during UAT-2 T02A walkthrough on PEPSI PET
  // 330mls (code 50202303, cache only had 1,000 of ~40k rows). Track
  // whether the lookup has settled so we can show an honest message.
  const [nameLookupDone, setNameLookupDone] = React.useState(false);
  const wrapRef = React.useRef(null);
  const debounceRef = React.useRef(null);

  // Resolve the stored code → its name for display when the modal opens.
  React.useEffect(() => {
    let cancelled = false;
    setNameLookupDone(false);
    if (!value) { setSelectedName(''); setNameLookupDone(true); return; }
    getZraItemClasses({ search: value, limit: 5 })
      .then(res => {
        if (cancelled) return;
        const match = (res.data || []).find(r => r.item_cls_cd === value)
                   || (res.data || [])[0];
        if (match) setSelectedName(match.item_cls_nm);
        else setSelectedName('');
      })
      .catch(() => { if (!cancelled) setSelectedName(''); })
      .finally(() => { if (!cancelled) setNameLookupDone(true); });
    return () => { cancelled = true; };
  }, [value]);

  // Debounced search on typing.
  React.useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await getZraItemClasses({ search: query, limit: 50 });
        setResults(Array.isArray(data) ? data : []);
      } catch { setResults([]); }
      setLoading(false);
    }, 200);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [query, open]);

  // Close on outside click.
  React.useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const pick = (row) => {
    onChange(row.item_cls_cd);
    setSelectedName(row.item_cls_nm);
    setQuery('');
    setOpen(false);
  };

  const clear = (e) => {
    e.stopPropagation();
    onChange('');
    setSelectedName('');
    setQuery('');
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {value && !open ? (
        <div
          onClick={disabled ? undefined : () => { setOpen(true); setQuery(''); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer', background: disabled ? '#f3f4f6' : '#f0fdf4', minHeight: 38, opacity: disabled ? 0.7 : 1 }}
          title={disabled ? 'HQ-managed classification' : 'Click to change'}>
          <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#166534' }}>{value}</span>
          <span style={{ fontSize: 13, color: '#374151', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedName || (nameLookupDone ? '(name not in local cache — code is saved correctly)' : 'loading…')}
          </span>
          {!disabled && (
            <button type="button" onClick={clear} title="Clear"
              style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 0, fontSize: 16 }}>×</button>
          )}
        </div>
      ) : (
        <input
          type="text"
          value={query}
          disabled={disabled}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Type name or 8-digit code (e.g. 'beer' or '50202100')"
          autoComplete="off"
        />
      )}
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
          marginTop: 4, background: '#fff', border: '1px solid #d1d5db',
          borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          maxHeight: 320, overflowY: 'auto',
        }}>
          {loading ? (
            <div style={{ padding: 12, fontSize: 12, color: '#6b7280', textAlign: 'center' }}>Searching…</div>
          ) : results.length === 0 ? (
            <div style={{ padding: 12, fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
              {query ? 'No matches.' : 'Type to search 158,000+ UNSPSC codes.'}
            </div>
          ) : (
            results.map(r => (
              <div key={r.item_cls_cd}
                onClick={() => pick(r)}
                style={{ padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'baseline', gap: 8 }}
                onMouseEnter={e => e.currentTarget.style.background = '#f0f9ff'}
                onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: '#0e7490', minWidth: 74 }}>{r.item_cls_cd}</span>
                <span style={{ fontSize: 12, color: '#111827' }}>{r.item_cls_nm}</span>
                <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 'auto' }}>
                  L{r.item_cls_lvl}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// v1.13.138 — Reusable dropdown fed from /zra/codes?cls=XX. Replaces the
// old free-text inputs for Packaging Unit / Quantity Unit / Origin Country
// so typos ('KGS' instead of 'KG') can no longer sneak into saveSales and
// fail at ZRA with 913 (code value error). Same UX as UnspscPicker.
function ZraCodePicker({ cls, value, onChange, disabled = false, placeholder = '' }) {
  const [options, setOptions] = React.useState([]);
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const wrapRef = React.useRef(null);

  // Load the class list on mount + whenever cls changes.
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getZraCodes(cls)
      .then(res => { if (!cancelled) setOptions(Array.isArray(res.data) ? res.data : []); })
      .catch(() => { if (!cancelled) setOptions([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cls]);

  React.useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const selected = options.find(o => o.cd === value);
  const q = query.trim().toLowerCase();
  const filtered = q
    ? options.filter(o => (o.cd || '').toLowerCase().includes(q) || (o.cd_nm || '').toLowerCase().includes(q))
    : options;

  const pick = (row) => { onChange(row.cd); setQuery(''); setOpen(false); };
  const clear = (e) => { e.stopPropagation(); onChange(''); setQuery(''); };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      {value && !open ? (
        <div
          onClick={disabled ? undefined : () => { setOpen(true); setQuery(''); }}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer', background: disabled ? '#f3f4f6' : '#f0fdf4', minHeight: 38, opacity: disabled ? 0.7 : 1 }}
          title={disabled ? 'HQ-managed field' : 'Click to change'}>
          <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 700, color: '#166534' }}>{value}</span>
          <span style={{ fontSize: 13, color: '#374151', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected ? selected.cd_nm : (loading ? '(loading…)' : '(unknown code)')}
          </span>
          {!disabled && (
            <button type="button" onClick={clear} title="Clear"
              style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 0, fontSize: 16 }}>×</button>
          )}
        </div>
      ) : (
        <input
          type="text"
          value={query}
          disabled={disabled}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={placeholder || 'Type to search…'}
          autoComplete="off"
        />
      )}
      {open && !disabled && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20,
          marginTop: 4, background: '#fff', border: '1px solid #d1d5db',
          borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
          maxHeight: 320, overflowY: 'auto',
        }}>
          {loading ? (
            <div style={{ padding: 12, fontSize: 12, color: '#6b7280', textAlign: 'center' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 12, fontSize: 12, color: '#9ca3af', textAlign: 'center' }}>
              {options.length === 0 ? 'No codes cached. Sync from ZRA Smart Invoice page first.' : 'No matches.'}
            </div>
          ) : (
            filtered.slice(0, 200).map(o => (
              <div key={o.cd}
                onClick={() => pick(o)}
                style={{ padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'baseline', gap: 8 }}
                onMouseEnter={e => e.currentTarget.style.background = '#f0f9ff'}
                onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
                <span style={{ fontFamily: 'monospace', fontSize: 11, fontWeight: 700, color: '#0e7490', minWidth: 56 }}>{o.cd}</span>
                <span style={{ fontSize: 12, color: '#111827' }}>{o.cd_nm}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// v1.13.138 — VAT Category dropdown backed by /zra/codes?cls=04. Falls
// back to a spec-hardcoded list if the cache hasn't been synced yet so
// product setup never blocks on ZRA connectivity.
const VAT_FALLBACK = [
  { cd: 'A',    cd_nm: 'Standard Rated (16%)' },
  { cd: 'B',    cd_nm: 'Minimum Taxable Value (MTV)' },
  { cd: 'C1',   cd_nm: 'Exports (0%)' },
  { cd: 'C2',   cd_nm: 'Zero-rated LPO' },
  { cd: 'C3',   cd_nm: 'Zero-rated by nature' },
  { cd: 'D',    cd_nm: 'Exempt' },
  { cd: 'E',    cd_nm: 'Disbursement' },
  { cd: 'RVAT', cd_nm: 'Reverse VAT' },
  { cd: 'TOT',  cd_nm: 'Turnover Tax' },
];
function ZraVatCategorySelect({ value, onChange, disabled = false }) {
  const [options, setOptions] = React.useState(VAT_FALLBACK);
  React.useEffect(() => {
    let cancelled = false;
    getZraCodes('04')
      .then(res => {
        if (cancelled) return;
        const rows = Array.isArray(res.data) ? res.data : [];
        if (rows.length > 0) setOptions(rows);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return (
    <select value={value || ''} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">— select —</option>
      {options.map(o => (
        <option key={o.cd} value={o.cd}>{o.cd} — {o.cd_nm}</option>
      ))}
    </select>
  );
}

// v1.13.138 — Item Type dropdown backed by /zra/codes?cls=24. Same
// fallback pattern as VAT — spec-hardcoded list (4 types per §6.2) if
// cache is empty. Note: prior hardcoded UI missed 'Rebate' (code 4).
const ITEM_TYPE_FALLBACK = [
  { cd: '1', cd_nm: 'Raw Material' },
  { cd: '2', cd_nm: 'Finished Product' },
  { cd: '3', cd_nm: 'Service' },
  { cd: '4', cd_nm: 'Rebate' },
];
function ZraItemTypeSelect({ value, onChange, disabled = false }) {
  const [options, setOptions] = React.useState(ITEM_TYPE_FALLBACK);
  React.useEffect(() => {
    let cancelled = false;
    getZraCodes('24')
      .then(res => {
        if (cancelled) return;
        const rows = Array.isArray(res.data) ? res.data : [];
        if (rows.length > 0) setOptions(rows);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return (
    <select value={value || ''} disabled={disabled} onChange={e => onChange(e.target.value)}>
      <option value="">— default (Finished Product) —</option>
      {options.map(o => (
        <option key={o.cd} value={o.cd}>{o.cd} — {o.cd_nm}</option>
      ))}
    </select>
  );
}

export default ItemDetails;
