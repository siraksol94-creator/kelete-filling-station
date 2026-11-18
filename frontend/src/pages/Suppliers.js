import React, { useState, useEffect } from 'react';
import { getSuppliers, getSupplierStats, createSupplier, updateSupplier, deleteSupplier } from '../services/api';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiPlus, FiSearch, FiMapPin, FiPhone, FiMail, FiEdit2, FiTrash2, FiX } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { matchTokens } from '../utils/tokenSearch';

const defaultStats = { totalSuppliers: 0, activeAccounts: 0, outstanding: 0 };
const emptyForm = { name: '', type: '', phone: '', email: '', address: '', contact_person: '' };

const Suppliers = () => {
  const { t } = useLanguage();
  const { hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const [stats, setStats] = useState(defaultStats);
  const [suppliers, setSuppliers] = useState([]);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  useModalScrollLock(showForm);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchData = async () => {
    try {
      const [statsRes, suppliersRes] = await Promise.all([getSupplierStats(), getSuppliers()]);
      if (statsRes.data) setStats(statsRes.data);
      if (suppliersRes.data) setSuppliers(suppliersRes.data);
    } catch (err) {}
  };

  useEffect(() => {
    fetchData();
    window.addEventListener('sync-complete', fetchData);
    return () => window.removeEventListener('sync-complete', fetchData);
  }, []);

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setError('');
    setShowForm(true);
  };

  const openEdit = (supplier) => {
    setEditingId(supplier.id);
    setForm({
      name: supplier.name || '',
      type: supplier.type || '',
      phone: supplier.phone || '',
      email: supplier.email || '',
      address: supplier.address || '',
      contact_person: supplier.contact_person || '',
    });
    setError('');
    setShowForm(true);
  };

  const handleSave = async () => {
    setError('');
    if (!form.name.trim()) return setError('Supplier name is required.');
    if (editingId) {
      if (!window.confirm('Are you sure you want to update this record?')) return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await updateSupplier(editingId, form);
        setShowForm(false);
        await fetchData();
        showToast('Supplier updated successfully.');
      } else {
        await createSupplier(form);
        setShowForm(false);
        await fetchData();
        showToast('Supplier saved successfully.');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save supplier.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (supplier) => {
    setPendingDelete({
      subject: `Supplier: ${supplier.name}`,
      perform: async () => {
        try { await deleteSupplier(supplier.id); await fetchData(); showToast('Supplier deleted.', 'error'); }
        catch (err) { alert(err.response?.data?.error || 'Failed to delete supplier.'); }
      },
    });
  };
  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };

  const set = (field) => (e) => setForm(prev => ({ ...prev, [field]: e.target.value }));
  const filtered = suppliers.filter(s => matchTokens(search, s.name, s.phone, s.email, s.address));
  const inputStyle = { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' };
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 6 };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('suppliersTitle')}</h1>
          <p>{t('suppliersSubtitle')}</p>
        </div>
        {hasPermission('Suppliers:Add') && (
          <button className="btn btn-primary" onClick={openAdd}><FiPlus /> {t('addSupplier')}</button>
        )}
      </div>

      <div className="stat-cards" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div className="stat-card blue">
          <div className="stat-icon"><FiMapPin /></div>
          <div><div className="stat-label">{t('totalSuppliers')}</div><div className="stat-value">{hasPermission('Suppliers:View') ? stats.totalSuppliers : 'N/A'}</div></div>
        </div>
        <div className="stat-card green">
          <div className="stat-icon"><FiPhone /></div>
          <div><div className="stat-label">{t('activeAccounts')}</div><div className="stat-value">{hasPermission('Suppliers:View') ? stats.activeAccounts : 'N/A'}</div></div>
        </div>
        <div className="stat-card red">
          <div className="stat-icon"><FiMail /></div>
          <div><div className="stat-label">{t('outstanding')}</div><div className="stat-value">{hasPermission('Suppliers:View') ? `${curSym}${parseFloat(stats.outstanding || 0).toLocaleString()}` : 'N/A'}</div></div>
        </div>
      </div>

      <div className="search-input-container">
        <FiSearch style={{ color: '#9ca3af' }} />
        <input type="text" placeholder={t('searchSuppliers')} value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
          {search ? t('noSuppliersMatch') : t('noSuppliersYet')}
        </div>
      ) : (
        <div className="entity-grid">
          {filtered.map(supplier => (
            <div key={supplier.id} className="entity-card">
              <div className="entity-card-header">
                <div>
                  <h3>{supplier.name}</h3>
                  <span className="entity-type">{supplier.type || 'Supplier'}</span>
                </div>
                <div className="entity-card-actions">
                  {hasPermission('Suppliers:Edit') && <button className="edit-btn" onClick={() => openEdit(supplier)}><FiEdit2 /></button>}
                  {hasPermission('Suppliers:Delete') && <button className="delete-btn" onClick={() => handleDelete(supplier)}><FiTrash2 /></button>}
                </div>
              </div>
              <div className="entity-contact">
                {supplier.phone && <div className="entity-contact-item"><FiPhone size={12} /> {supplier.phone}</div>}
                {supplier.email && <div className="entity-contact-item"><FiMail size={12} /> {supplier.email}</div>}
                {supplier.address && <div className="entity-contact-item"><FiMapPin size={12} /> {supplier.address}</div>}
              </div>
              <div className="entity-stats">
                <div><div className="entity-stat-label">Contact Person:</div><div className="entity-stat-value">{supplier.contact_person || '—'}</div></div>
                <div><div className="entity-stat-label">Total Purchases:</div><div className="entity-stat-value">{curSym}{parseFloat(supplier.total_purchases || 0).toLocaleString()}</div></div>
                <div><div className="entity-stat-label">Outstanding:</div><div className={`entity-stat-value ${parseFloat(supplier.outstanding) > 0 ? 'outstanding' : 'zero'}`}>{curSym}{parseFloat(supplier.outstanding || 0).toLocaleString()}</div></div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit Modal */}
      {showForm && (
        <Portal>
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 540, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '20px 24px', borderBottom: '1px solid #e5e7eb' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 17 }}>{editingId ? `${t('edit')} ${t('supplier')}` : `${t('newEntry')} ${t('supplier')}`}</h3>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>Fill in the supplier details below</p>
              </div>
              <button onClick={() => setShowForm(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}><FiX size={20} /></button>
            </div>

            <div style={{ padding: '20px 24px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div>
                  <label style={labelStyle}>{t('name')} <span style={{ color: '#dc2626' }}>*</span></label>
                  <input style={inputStyle} type="text" placeholder="e.g. Prime Meats Ltd" value={form.name} onChange={set('name')} />
                </div>
                <div>
                  <label style={labelStyle}>{t('type')}</label>
                  <input style={inputStyle} type="text" placeholder="e.g. Beef Supplier" value={form.type} onChange={set('type')} />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div>
                  <label style={labelStyle}>{t('phone')}</label>
                  <input style={inputStyle} type="text" placeholder="+1 555-0101" value={form.phone} onChange={set('phone')} />
                </div>
                <div>
                  <label style={labelStyle}>{t('email')}</label>
                  <input style={inputStyle} type="email" placeholder="supplier@email.com" value={form.email} onChange={set('email')} />
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Contact Person</label>
                <input style={inputStyle} type="text" placeholder="e.g. John Smith" value={form.contact_person} onChange={set('contact_person')} />
              </div>

              <div style={{ marginBottom: 20 }}>
                <label style={labelStyle}>{t('address')}</label>
                <input style={inputStyle} type="text" placeholder="Street address, City" value={form.address} onChange={set('address')} />
              </div>

              {error && (
                <div style={{ background: '#fee2e2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
                  {error}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => setShowForm(false)} style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>
                  {t('cancel')}
                </button>
                <button onClick={handleSave} disabled={saving}
                  style={{ padding: '10px 28px', background: saving ? '#9ca3af' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
                  {saving ? t('saving') : editingId ? `${t('edit')} ${t('supplier')}` : `${t('newEntry')} ${t('supplier')}`}
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
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

export default Suppliers;
