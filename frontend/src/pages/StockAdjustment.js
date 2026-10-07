import React, { useState, useEffect } from 'react';
import { getStoreInventory } from '../services/api';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { FiPlus, FiTrendingUp, FiTrendingDown, FiCalendar, FiPackage, FiX, FiTrash2, FiEdit2 } from 'react-icons/fi';
import Toast from '../components/Toast';
import { formatStock, formatStockForProduct } from '../utils/unitFormat';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const StockAdjustment = () => {
  const { t } = useLanguage();
  const { hasPermission } = useAuth();
  const [adjustments, setAdjustments] = useState([]);
  const [products, setProducts] = useState([]);
  const [stats, setStats] = useState({ total: 0, increases: 0, decreases: 0, thisMonth: 0 });
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Form state
  const [productId, setProductId] = useState('');
  const [adjustmentType, setAdjustmentType] = useState('increase');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);

  const fetchData = async () => {
    try {
      const [adjRes, statsRes] = await Promise.all([
        api.get('/stock-adjustments'),
        api.get('/stock-adjustments/stats'),
      ]);
      setAdjustments(adjRes.data || []);
      setStats(statsRes.data || { total: 0, increases: 0, decreases: 0, thisMonth: 0 });
    } catch (err) {}
  };

  const fetchProducts = () => {
    getStoreInventory().then(res => setProducts(res.data || [])).catch(() => {});
  };

  useEffect(() => {
    fetchData();
    fetchProducts();
  }, []);

  const openForm = () => {
    setEditId(null);
    setProductId('');
    setAdjustmentType('increase');
    setQuantity('');
    setReason('');
    setNotes('');
    setDate(new Date().toISOString().split('T')[0]);
    setError('');
    setShowForm(true);
  };

  const openEdit = (adj) => {
    setEditId(adj.id);
    setProductId(String(adj.product_id));
    setAdjustmentType(adj.adjustment_type);
    setQuantity(String(parseFloat(adj.quantity)));
    setReason(adj.reason || '');
    setNotes(adj.notes || '');
    setDate((adj.date || adj.created_at || '').split('T')[0]);
    setError('');
    setShowForm(true);
  };

  const handleSave = async () => {
    setError('');
    if (!productId) return setError('Please select a product.');
    if (!quantity || parseFloat(quantity) <= 0) return setError('Please enter a valid quantity.');

    setSaving(true);
    try {
      if (editId) {
        await api.put(`/stock-adjustments/${editId}`, {
          adjustment_type: adjustmentType,
          quantity: parseFloat(quantity),
          reason,
          notes,
          date,
        });
        showToast('Stock adjustment updated successfully.');
      } else {
        await api.post('/stock-adjustments', {
          product_id: parseInt(productId),
          adjustment_type: adjustmentType,
          quantity: parseFloat(quantity),
          reason,
          notes,
          date,
        });
        showToast('Stock adjustment saved successfully.');
      }
      setShowForm(false);
      await fetchData();
      fetchProducts();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save adjustment.');
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
  const handleDelete = (adj) => {
    setPendingDelete({
      subject: `Adjustment ${adj.adjustment_number} — stock change will be reversed`,
      perform: async () => {
        try {
          await api.delete(`/stock-adjustments/${adj.id}`);
          await fetchData();
          fetchProducts();
          showToast('Adjustment deleted.', 'error');
        } catch (err) {
          alert(err.response?.data?.error || 'Failed to delete adjustment.');
        }
      },
    });
  };

  const selectedProduct = products.find(p => p.id === parseInt(productId));
  const formatDate = d => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const reasons = ['Damage', 'Theft / Loss', 'Expiry', 'Stock Count Correction', 'Opening Stock', 'Transfer', 'Other'];

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('stockAdjustmentTitle')}</h1>
          <p>Manually adjust product stock levels</p>
        </div>
        {hasPermission('StockAdjustment:Add') && (
          <button className="btn btn-primary" onClick={openForm}><FiPlus /> {t('newAdjustment')}</button>
        )}
      </div>

      {/* Stat Cards */}
      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#ede9fe', color: '#7c3aed' }}><FiPackage /></div>
          <div><div className="stat-label">{t('total')} {t('stockAdjustment')}</div><div className="stat-value">{hasPermission('StockAdjustment:View') ? stats.total : 'N/A'}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#dcfce7', color: '#16a34a' }}><FiTrendingUp /></div>
          <div><div className="stat-label">{t('increase')}s</div><div className="stat-value">{hasPermission('StockAdjustment:View') ? stats.increases : 'N/A'}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#fee2e2', color: '#dc2626' }}><FiTrendingDown /></div>
          <div><div className="stat-label">{t('decrease')}s</div><div className="stat-value">{hasPermission('StockAdjustment:View') ? stats.decreases : 'N/A'}</div></div>
        </div>
        <div className="stat-card">
          <div className="stat-icon" style={{ background: '#dbeafe', color: '#2563eb' }}><FiCalendar /></div>
          <div><div className="stat-label">{t('thisMonth')}</div><div className="stat-value">{hasPermission('StockAdjustment:View') ? stats.thisMonth : 'N/A'}</div></div>
        </div>
      </div>

      {/* Table */}
      <div className="data-table-container">
        {adjustments.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
            {t('noData')}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Ref #</th>
                <th>{t('date')}</th>
                <th>{t('product')}</th>
                <th>{t('type')}</th>
                <th>{t('quantity')}</th>
                <th>{t('reason')}</th>
                <th>By</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {adjustments.map(adj => (
                <tr key={adj.id}>
                  <td style={{ fontWeight: 500 }}>{adj.adjustment_number}</td>
                  <td>{formatDate(adj.date || adj.created_at)}</td>
                  <td>{adj.product_name}</td>
                  <td>
                    <span className={`badge ${adj.adjustment_type === 'increase' ? 'badge-success' : 'badge-danger'}`}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {adj.adjustment_type === 'increase' ? <FiTrendingUp size={12} /> : <FiTrendingDown size={12} />}
                      {adj.adjustment_type === 'increase' ? t('increase') : t('decrease')}
                    </span>
                  </td>
                  <td style={{ fontWeight: 600, color: adj.adjustment_type === 'increase' ? '#16a34a' : '#dc2626' }}>
                    {adj.adjustment_type === 'increase' ? '+' : '-'}{(parseFloat(parseFloat(adj.quantity))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} {adj.unit}
                  </td>
                  <td>{adj.reason || '—'}</td>
                  <td>{adj.created_by_name || '—'}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {hasPermission('StockAdjustment:Edit') && (
                        <button
                          onClick={() => openEdit(adj)}
                          title="Edit"
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: '#9ca3af', padding: 4, borderRadius: 6,
                            display: 'inline-flex', alignItems: 'center', transition: 'color 0.15s',
                          }}
                          onMouseEnter={e => e.currentTarget.style.color = '#2563eb'}
                          onMouseLeave={e => e.currentTarget.style.color = '#9ca3af'}
                        >
                          <FiEdit2 size={15} />
                        </button>
                      )}
                      {hasPermission('StockAdjustment:Delete') && (
                        <button
                          onClick={() => handleDelete(adj)}
                          title="Delete"
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: '#9ca3af', padding: 4, borderRadius: 6,
                            display: 'inline-flex', alignItems: 'center', transition: 'color 0.15s',
                          }}
                          onMouseEnter={e => e.currentTarget.style.color = '#dc2626'}
                          onMouseLeave={e => e.currentTarget.style.color = '#9ca3af'}
                        >
                          <FiTrash2 size={15} />
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

      {/* Modal */}
      {showForm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 520, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>

            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 17 }}>{editId ? 'Edit Adjustment' : t('newAdjustment')}</h3>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>Adjust product stock level manually</p>
              </div>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
            </div>

            <div style={{ padding: '20px 24px' }}>

              {/* Product */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                  {t('product')} <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <select
                  value={productId}
                  onChange={e => setProductId(e.target.value)}
                  disabled={!!editId}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: editId ? '#f9fafb' : '#fff' }}
                >
                  <option value="">— Select Product —</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>{p.name} (Store: {formatStockForProduct(p.store_balance, p, { showBaseInParens: false })})</option>
                  ))}
                </select>
                {selectedProduct && (
                  <div style={{ marginTop: 6, padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 12, color: '#6b7280' }}>
                    {t('storeBalance')}: <strong style={{ color: '#374151' }}>{formatStockForProduct(selectedProduct.store_balance, selectedProduct)}</strong>
                  </div>
                )}
              </div>

              {/* Type & Quantity */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                    {t('type')} <span style={{ color: '#dc2626' }}>*</span>
                  </label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      onClick={() => setAdjustmentType('increase')}
                      style={{
                        flex: 1, padding: '9px 0', border: `2px solid ${adjustmentType === 'increase' ? '#16a34a' : '#e5e7eb'}`,
                        borderRadius: 8, background: adjustmentType === 'increase' ? '#dcfce7' : '#fff',
                        color: adjustmentType === 'increase' ? '#16a34a' : '#6b7280',
                        cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4
                      }}
                    >
                      <FiTrendingUp size={14} /> {t('increase')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdjustmentType('decrease')}
                      style={{
                        flex: 1, padding: '9px 0', border: `2px solid ${adjustmentType === 'decrease' ? '#dc2626' : '#e5e7eb'}`,
                        borderRadius: 8, background: adjustmentType === 'decrease' ? '#fee2e2' : '#fff',
                        color: adjustmentType === 'decrease' ? '#dc2626' : '#6b7280',
                        cursor: 'pointer', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4
                      }}
                    >
                      <FiTrendingDown size={14} /> {t('decrease')}
                    </button>
                  </div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                    {t('quantity')} <span style={{ color: '#dc2626' }}>*</span>
                  </label>
                  <input
                    type="number" min="0" step="1"
                    placeholder="0"
                    value={quantity}
                    onChange={e => setQuantity(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              {/* New stock preview */}
              {selectedProduct && quantity && parseFloat(quantity) > 0 && (
                <div style={{ marginBottom: 16, padding: '10px 14px', background: adjustmentType === 'increase' ? '#dcfce7' : '#fee2e2', borderRadius: 8, fontSize: 13 }}>
                  {t('newStockWillBe')}:{' '}
                  <strong style={{ color: adjustmentType === 'increase' ? '#16a34a' : '#dc2626' }}>
                    {formatStockForProduct(parseFloat(selectedProduct.store_balance) + (adjustmentType === 'increase' ? 1 : -1) * parseFloat(quantity), selectedProduct)}
                  </strong>
                </div>
              )}

              {/* Reason & Date */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('reason')}</label>
                  <select
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff' }}
                  >
                    <option value="">— Select Reason —</option>
                    {reasons.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('date')}</label>
                  <input
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
                  />
                </div>
              </div>

              {/* Notes */}
              <div style={{ marginBottom: 20 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 }}>{t('notes')}</label>
                <input
                  type="text"
                  value={notes}
                  onChange={e => setNotes(e.target.value)}
                  placeholder="Additional details..."
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
                />
              </div>

              {error && (
                <div style={{ background: '#fee2e2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
                  {error}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button
                  onClick={() => setShowForm(false)}
                  style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}
                >
                  {t('cancel')}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving}
                  style={{
                    padding: '10px 28px',
                    background: saving ? '#9ca3af' : adjustmentType === 'increase' ? '#16a34a' : '#dc2626',
                    color: '#fff', border: 'none', borderRadius: 8,
                    cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600
                  }}
                >
                  {saving ? t('saving') : editId ? 'Update Adjustment' : t('saveAdjustment')}
                </button>
              </div>
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

export default StockAdjustment;
