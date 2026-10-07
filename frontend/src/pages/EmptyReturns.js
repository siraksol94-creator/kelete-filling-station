import React, { useState, useEffect } from 'react';
import {
  getEmptyReturns, getEmptyReturnStats, getEmptyReturn,
  createEmptyReturn, updateEmptyReturn, deleteEmptyReturn,
  getProducts, getSuppliers, getSettings,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import {
  FiPlus, FiCornerUpLeft, FiCalendar, FiUsers, FiDollarSign,
  FiX, FiTrash2, FiEye, FiEdit2,
} from 'react-icons/fi';

const defaultStats = { totalReturns: 0, thisMonth: 0, totalValue: 0, suppliers: 0 };
const emptyItem = () => ({ product_id: '', product_text: '', quantity: '', deposit: '' });
const todayStr = new Date().toISOString().split('T')[0];

const isRowComplete = (row) =>
  row.product_id !== '' && parseFloat(row.quantity) > 0 && parseFloat(row.deposit) >= 0;

const EmptyReturns = () => {
  const { hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  const [stats, setStats]         = useState(defaultStats);
  const [returns, setReturns]     = useState([]);
  const [products, setProducts]   = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [defaultDeposit, setDefaultDeposit] = useState(0);

  const [showForm, setShowForm]   = useState(false);
  const [editMode, setEditMode]   = useState(false);
  const [editId, setEditId]       = useState(null);
  const [editLoading, setEditLoading] = useState(false);
  const [viewER, setViewER]       = useState(null);
  const [viewLoading, setViewLoading] = useState(false);

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(!!viewER || showForm);

  const [supplierId, setSupplierId] = useState('');
  const [date, setDate]             = useState(todayStr);
  const [notes, setNotes]           = useState('');
  const [items, setItems]           = useState([emptyItem()]);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');

  const [filterFrom, setFilterFrom] = useState(todayStr);
  const [filterTo, setFilterTo]     = useState(todayStr);
  const [toast, setToast]           = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchData = async () => {
    try {
      const [statsRes, listRes] = await Promise.all([getEmptyReturnStats(), getEmptyReturns()]);
      if (statsRes.data) setStats(statsRes.data);
      if (listRes.data)  setReturns(listRes.data);
    } catch (_) {}
  };

  useEffect(() => {
    fetchData();
    (async () => {
      try {
        const [prodRes, supRes, setRes] = await Promise.all([getProducts(), getSuppliers(), getSettings()]);
        if (prodRes.data) setProducts(prodRes.data.filter(p => (p.status || 'Active') === 'Active'));
        if (supRes.data)  setSuppliers(supRes.data);
        if (setRes.data?.business?.default_crate_deposit !== undefined) {
          setDefaultDeposit(parseFloat(setRes.data.business.default_crate_deposit) || 0);
        }
      } catch (_) {}
    })();
  }, []);

  // Empty-container products only — items that themselves have no container link
  // AND look like a "deposit-bearing" item. We surface anything that is referenced
  // BY another product's container_product_sync_id (i.e. someone else's crate).
  // Fall back to all products if no links exist yet (lets the user pick anything).
  const containerSyncIds = new Set(
    products.map(p => p.container_product_sync_id).filter(Boolean)
  );
  const eligibleProducts = containerSyncIds.size > 0
    ? products.filter(p => containerSyncIds.has(p.sync_id))
    : products;

  // Sort suppliers by most-recently-used (based on last empty return date).
  // Suppliers with no prior returns fall to the bottom in alphabetical order
  // so first-time pickers still find them — but frequent ones float to the top.
  const lastUsedBySupplier = returns.reduce((m, r) => {
    const d = r.date || r.created_at || '';
    if (r.supplier_id && (!m[r.supplier_id] || d > m[r.supplier_id])) m[r.supplier_id] = d;
    return m;
  }, {});
  const suppliersSorted = [...suppliers].sort((a, b) => {
    const la = lastUsedBySupplier[a.id];
    const lb = lastUsedBySupplier[b.id];
    if (la && lb) return lb.localeCompare(la);   // both used → most recent first
    if (la) return -1;                           // a used, b never → a first
    if (lb) return 1;                            // b used, a never → b first
    return (a.name || '').localeCompare(b.name || ''); // neither used → alphabetical
  });

  const filteredReturns = returns.filter(r => {
    const d = (r.date || r.created_at || '').split('T')[0];
    if (filterFrom && d < filterFrom) return false;
    if (filterTo   && d > filterTo)   return false;
    return true;
  });
  const filteredTotal = filteredReturns.reduce((s, r) => s + parseFloat(r.total_amount || 0), 0);

  const totalAmount = items.reduce(
    (s, i) => s + (parseFloat(i.quantity) || 0) * (parseFloat(i.deposit) || 0), 0
  );

  const updateItem = (idx, field, value) =>
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));

  const addItemRow = () => {
    setItems(prev => [...prev, { ...emptyItem(), deposit: defaultDeposit ? String(defaultDeposit) : '' }]);
  };

  const removeItemRow = (idx) => {
    if (items.length === 1) return;
    setItems(prev => prev.filter((_, i) => i !== idx));
  };

  const openForm = () => {
    setEditMode(false); setEditId(null);
    setSupplierId(''); setDate(todayStr); setNotes('');
    setItems([{ ...emptyItem(), deposit: defaultDeposit ? String(defaultDeposit) : '' }]);
    setError(''); setShowForm(true);
  };

  const openEdit = async (er) => {
    setEditLoading(true);
    try {
      const res = await getEmptyReturn(er.id);
      const e = res.data;
      setEditMode(true); setEditId(e.id);
      setSupplierId(String(e.supplier_id || ''));
      setDate((e.date || todayStr).split('T')[0]);
      setNotes(e.notes || '');
      setItems((e.items || []).length > 0
        ? e.items.map(i => ({
            product_id: String(i.product_id),
            product_text: i.product_name || '',
            quantity: String(i.quantity),
            deposit: String(i.deposit),
          }))
        : [emptyItem()]);
      setError(''); setShowForm(true);
    } catch (_) {
      alert('Failed to load empty return.');
    } finally {
      setEditLoading(false);
    }
  };

  const openView = async (er) => {
    setViewLoading(true);
    try {
      const res = await getEmptyReturn(er.id);
      setViewER(res.data);
    } catch (_) {
      alert('Failed to load empty return.');
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
    const er = viewER;
    setPendingDelete({
      subject: `Empty Return ${er.return_number} — reverses stock + AP credit`,
      perform: async () => {
        try {
          await deleteEmptyReturn(er.id);
          setViewER(null);
          fetchData();
          showToast('Empty return deleted.', 'error');
        } catch (err) {
          alert(err.response?.data?.error || 'Failed to delete.');
        }
      },
    });
  };

  const handleSave = async () => {
    setError('');
    if (!supplierId) return setError('Please select a supplier.');
    const validItems = items.filter(isRowComplete);
    if (validItems.length === 0) return setError('Add at least one line (product, qty, deposit).');

    const payload = {
      supplier_id: parseInt(supplierId),
      date, notes,
      items: validItems.map(i => ({
        product_id: parseInt(i.product_id),
        quantity:   parseFloat(i.quantity),
        deposit:    parseFloat(i.deposit),
      })),
    };
    if (editMode && !window.confirm('Update this empty return?')) return;

    setSaving(true);
    try {
      if (editMode) {
        await updateEmptyReturn(editId, payload);
        showToast('Empty return updated.');
      } else {
        await createEmptyReturn(payload);
        showToast('Empty return saved.');
      }
      setShowForm(false);
      fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save.');
    } finally {
      setSaving(false);
    }
  };

  const formatDate = (d) => {
    const str = (d || '').split('T')[0];
    if (!str) return '—';
    return new Date(str + 'T12:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  const hasFilter = filterFrom || filterTo;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('emptyReturns')}</h1>
          <p>{t('emptyReturnsSubtitle')}</p>
        </div>
        {hasPermission('GRN:Add') && (
          <button className="btn btn-primary" onClick={openForm}><FiPlus /> {t('newEmptyReturn')}</button>
        )}
      </div>

      <div className="stat-cards">
        <div className="stat-card blue">
          <div className="stat-icon"><FiCornerUpLeft /></div>
          <div><div className="stat-label">{t('totalReturns')}</div><div className="stat-value">{stats.totalReturns}</div></div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon"><FiCalendar /></div>
          <div><div className="stat-label">{t('thisMonth')}</div><div className="stat-value">{stats.thisMonth}</div></div>
        </div>
        <div className="stat-card purple">
          <div className="stat-icon"><FiUsers /></div>
          <div><div className="stat-label">{t('suppliers')}</div><div className="stat-value">{stats.suppliers}</div></div>
        </div>
        <div className="stat-card orange">
          <div className="stat-icon"><FiDollarSign /></div>
          <div>
            <div className="stat-label">{t('totalCreditValue')}</div>
            <div className="stat-value" style={{ fontSize: 18 }}>{curSym}{parseFloat(stats.totalValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, padding: '12px 16px', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10 }}>
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
        {hasFilter && (
          <button onClick={() => { setFilterFrom(''); setFilterTo(''); }}
            style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' }}>{t('clear')}</button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {filteredReturns.length} return{filteredReturns.length !== 1 ? 's' : ''}
          {hasFilter && <> &nbsp;·&nbsp; Total credit: <strong style={{ color: '#16a34a' }}>{curSym}{filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></>}
        </span>
      </div>

      <div className="data-table-container">
        {filteredReturns.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
            {hasFilter ? t('noEmptyReturnsInRange') : t('noEmptyReturnsYet')}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>{t('returnNumber')}</th><th>{t('date')}</th><th>{t('supplier')}</th><th>{t('items')}</th><th>{t('credit')} ({curSym})</th><th></th></tr>
            </thead>
            <tbody>
              {filteredReturns.map(r => (
                <tr key={r.id}>
                  <td style={{ fontWeight: 500 }}>{r.return_number}</td>
                  <td>{formatDate(r.date)}</td>
                  <td>{r.supplier_name || '—'}</td>
                  <td style={{ textAlign: 'center' }}>{r.total_items}</td>
                  <td style={{ color: '#16a34a', fontWeight: 600 }}>{curSym}{parseFloat(r.total_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button onClick={() => openView(r)} disabled={viewLoading}
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 11px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#f9fafb', color: '#6b7280', cursor: 'pointer', fontSize: 12 }}>
                        <FiEye size={12} /> View
                      </button>
                      {hasPermission('GRN:Edit') && (
                        <button onClick={() => openEdit(r)} disabled={editLoading} title="Edit"
                          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: 6, border: '1px solid #e5e7eb', background: '#f9fafb', color: '#6b7280', cursor: 'pointer' }}>
                          <FiEdit2 size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Create / Edit modal ──────────────────────────────────────── */}
      {showForm && (
        <Portal>
        <div className="modal-overlay" onClick={() => setShowForm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 1100, width: '95vw' }}>
            <div className="modal-header">
              <h2>{editMode ? 'Edit Empty Return' : 'New Empty Return'}</h2>
              <button className="modal-close" onClick={() => setShowForm(false)}><FiX /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Supplier *</label>
                  <select value={supplierId} onChange={e => setSupplierId(e.target.value)}>
                    <option value="">— Select supplier —</option>
                    {suppliersSorted.map(s => {
                      const last = lastUsedBySupplier[s.id];
                      return <option key={s.id} value={s.id}>{s.name}{last ? ` · last: ${last.split('T')[0]}` : ''}</option>;
                    })}
                  </select>
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label>Date</label>
                  <input type="date" value={date} max={todayStr} onChange={e => setDate(e.target.value)} />
                </div>
              </div>

              <div className="form-group">
                <label>Notes</label>
                <textarea value={notes} onChange={e => setNotes(e.target.value)}
                  rows={2} placeholder="e.g. Collected from POS counter on 20 May"
                  style={{ width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit' }} />
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: 'auto' }} />
                  <col style={{ width: 100 }} />
                  <col style={{ width: 110 }} />
                  <col style={{ width: 130 }} />
                  <col style={{ width: 130 }} />
                  <col style={{ width: 50 }} />
                </colgroup>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <th style={{ padding: '10px 10px', textAlign: 'left',   fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb' }}>Empty Product</th>
                    <th style={{ padding: '10px 10px', textAlign: 'right',  fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb' }}>In Yard</th>
                    <th style={{ padding: '10px 10px', textAlign: 'center', fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb' }}>Quantity</th>
                    <th style={{ padding: '10px 10px', textAlign: 'center', fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb' }}>Deposit ({curSym})</th>
                    <th style={{ padding: '10px 10px', textAlign: 'center', fontWeight: 600, color: '#6b7280', fontSize: 12, borderBottom: '1px solid #e5e7eb' }}>Total ({curSym})</th>
                    <th style={{ padding: '10px 8px',  borderBottom: '1px solid #e5e7eb' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => {
                    const prod      = products.find(p => p.id === parseInt(item.product_id));
                    const inYard    = prod ? (parseFloat(prod.store_balance || 0) + parseFloat(prod.sales_balance || 0)) : null;
                    const qty       = parseFloat(item.quantity) || 0;
                    const remaining = prod ? (inYard - qty) : null;
                    const overshoot = remaining !== null && remaining < 0;
                    const lineTotal = qty * (parseFloat(item.deposit) || 0);
                    return (
                      <tr key={idx}>
                        <td style={{ padding: '8px 8px 8px 0' }}>
                          <select value={item.product_id}
                            onChange={e => {
                              const pid = e.target.value;
                              const sel = products.find(p => p.id === parseInt(pid));
                              setItems(prev => prev.map((it, i) => i === idx ? {
                                ...it,
                                product_id: pid,
                                product_text: sel?.name || '',
                                deposit: it.deposit || (defaultDeposit ? String(defaultDeposit) : (sel?.cost_price ? String(sel.cost_price) : '')),
                              } : it));
                            }}
                            style={{ width: '100%', padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, background: '#fff' }}>
                            <option value="">— Select empty product —</option>
                            {eligibleProducts.map(p => {
                              const bal = parseFloat(p.store_balance || 0) + parseFloat(p.sales_balance || 0);
                              return (
                                <option key={p.id} value={p.id}>
                                  {p.code ? `${p.code} · ` : ''}{p.name} — {bal.toFixed(0)} {p.unit || 'pcs'} on hand
                                </option>
                              );
                            })}
                          </select>
                        </td>
                        <td style={{ padding: '8px 8px', textAlign: 'right', fontSize: 12, color: remaining !== null && remaining < 0 ? '#dc2626' : '#6b7280', fontFamily: 'monospace' }}>
                          {prod ? (
                            <>
                              <div style={{ fontWeight: 600, color: '#374151' }}>{inYard.toFixed(0)}</div>
                              {qty > 0 && (
                                <div style={{ fontSize: 10, marginTop: 2, color: overshoot ? '#dc2626' : '#16a34a' }}>
                                  after: {remaining.toFixed(0)}
                                </div>
                              )}
                            </>
                          ) : '—'}
                        </td>
                        <td style={{ padding: '8px 8px' }}>
                          <input type="number" min="0" step="1" placeholder="0"
                            value={item.quantity}
                            onChange={e => updateItem(idx, 'quantity', e.target.value)}
                            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: `1px solid ${overshoot ? '#fca5a5' : '#e5e7eb'}`, borderRadius: 6, fontSize: 13, textAlign: 'right', background: overshoot ? '#fef2f2' : '#fff' }} />
                        </td>
                        <td style={{ padding: '8px 8px' }}>
                          <input type="number" min="0" step="0.01" placeholder="0.00"
                            value={item.deposit}
                            onChange={e => updateItem(idx, 'deposit', e.target.value)}
                            style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, textAlign: 'right' }} />
                        </td>
                        <td style={{ padding: '8px 8px' }}>
                          <div style={{ width: '100%', boxSizing: 'border-box', padding: '9px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, textAlign: 'right', background: '#f9fafb', color: '#374151' }}>
                            {(parseFloat(lineTotal)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                          </div>
                        </td>
                        <td style={{ padding: '8px 4px', textAlign: 'center' }}>
                          <button onClick={() => removeItemRow(idx)} disabled={items.length === 1}
                            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, background: items.length === 1 ? '#f3f4f6' : '#fee2e2', color: items.length === 1 ? '#9ca3af' : '#dc2626', border: 'none', borderRadius: 6, cursor: items.length === 1 ? 'not-allowed' : 'pointer' }}>
                            <FiTrash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <button onClick={addItemRow}
                  style={{ padding: '7px 14px', background: '#f0fdf4', color: '#16a34a', border: '1px dashed #86efac', borderRadius: 6, fontSize: 13, cursor: 'pointer', fontWeight: 500 }}>
                  <FiPlus size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Add Line
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingTop: 12, borderTop: '2px solid #e5e7eb' }}>
                  <span style={{ fontWeight: 600, color: '#374151', fontSize: 14 }}>Supplier Credit:</span>
                  <span style={{ fontWeight: 700, fontSize: 18, color: '#16a34a' }}>{curSym}{(parseFloat(totalAmount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
                </div>
              </div>

              {error && (
                <div style={{ background: '#fee2e2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginTop: 12 }}>{error}</div>
              )}

              <div style={{ marginTop: 14, padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 12, color: '#1e40af', lineHeight: 1.5 }}>
                <strong>What this does:</strong> Reduces store stock by the qty entered, then posts a matching AP credit
                ({curSym}{(parseFloat(totalAmount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}) against this supplier — same as if they paid you cash. View it on the
                Account Payables page or Supplier ledger as <em>"Empty Return Credit"</em>.
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 14 }}>
                <button onClick={() => setShowForm(false)} style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
                <button onClick={handleSave} disabled={saving}
                  style={{ padding: '10px 28px', background: saving ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
                  {saving ? 'Saving...' : (editMode ? 'Update Return' : 'Save Return')}
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── View modal ──────────────────────────────────────────────── */}
      {viewER && (
        <Portal>
        <div className="modal-overlay" onClick={() => setViewER(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 720 }}>
            <div className="modal-header">
              <h2>Empty Return {viewER.return_number}</h2>
              <button className="modal-close" onClick={() => setViewER(null)}><FiX /></button>
            </div>
            <div className="modal-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14, fontSize: 13 }}>
                <div><strong style={{ color: '#6b7280' }}>Supplier:</strong> {viewER.supplier_name || '—'}</div>
                <div><strong style={{ color: '#6b7280' }}>Date:</strong> {formatDate(viewER.date)}</div>
                <div><strong style={{ color: '#6b7280' }}>Items:</strong> {viewER.total_items}</div>
                <div><strong style={{ color: '#6b7280' }}>Total Credit:</strong> <span style={{ color: '#16a34a', fontWeight: 700 }}>{curSym}{(parseFloat(parseFloat(viewER.total_amount))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span></div>
                {viewER.created_by_name && <div><strong style={{ color: '#6b7280' }}>Created by:</strong> {viewER.created_by_name}</div>}
              </div>
              {viewER.notes && (
                <div style={{ padding: '10px 14px', background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 13, marginBottom: 12 }}>{viewER.notes}</div>
              )}
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <th style={{ padding: 10, textAlign: 'left', fontSize: 12, color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>Product</th>
                    <th style={{ padding: 10, textAlign: 'right', fontSize: 12, color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>Qty</th>
                    <th style={{ padding: 10, textAlign: 'right', fontSize: 12, color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>Deposit</th>
                    <th style={{ padding: 10, textAlign: 'right', fontSize: 12, color: '#6b7280', borderBottom: '1px solid #e5e7eb' }}>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(viewER.items || []).map(i => (
                    <tr key={i.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: 10 }}>{i.product_name || '—'}</td>
                      <td style={{ padding: 10, textAlign: 'right' }}>{parseFloat(i.quantity).toFixed(0)} {i.product_unit || ''}</td>
                      <td style={{ padding: 10, textAlign: 'right' }}>{curSym}{(parseFloat(parseFloat(i.deposit))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                      <td style={{ padding: 10, textAlign: 'right', fontWeight: 600 }}>{curSym}{(parseFloat(parseFloat(i.total_price))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
                {hasPermission('GRN:Delete') && (
                  <button onClick={handleDeleteFromView}
                    style={{ padding: '8px 16px', background: '#fee2e2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>
                    <FiTrash2 size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Delete
                  </button>
                )}
                <button onClick={() => setViewER(null)} style={{ padding: '8px 20px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 13 }}>Close</button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {toast && <Toast message={toast.msg} type={toast.type} />}

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

export default EmptyReturns;
