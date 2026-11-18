import React, { useState, useEffect, useRef } from 'react';
import { getCategories, createCategory, updateCategory, deleteCategory, deleteAllCategories, importCategories,
         getMainCategories, createMainCategory, updateMainCategory, deleteMainCategory,
         getUnits, createUnit, updateUnit, deleteUnit, isHqHost } from '../services/api';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiTag, FiUpload, FiDownload, FiAlertTriangle, FiLayers, FiHash } from 'react-icons/fi';
import Toast from '../components/Toast';
import { useAuth } from '../context/AuthContext';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const emptyForm = { name: '', color: '#6b7280', main_category_id: '' };
const emptyMainForm = { name: '', color: '#6b7280' };
const emptyUnitForm = { name: '', abbreviation: '' };

const PRESET_COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899',
  '#6b7280', '#92400e', '#166534', '#1e40af',
];

const Categories = () => {
  // v1.6.0: Categories / Main categories / Units are now HQ-owned. Branch
  // hosts can read the list but can't edit / delete rows where
  // is_hq_owned=1, and can't add new ones either. Backend enforces it too.
  const isBranch = !isHqHost();
  const [activeTab, setActiveTab] = useState('categories'); // 'categories' | 'main' | 'units'

  const [categories, setCategories] = useState([]);
  const [mainCategories, setMainCategories] = useState([]);
  const [units, setUnits] = useState([]);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);

  const [showMainForm, setShowMainForm] = useState(false);
  const [editingMainId, setEditingMainId] = useState(null);
  const [mainForm, setMainForm] = useState(emptyMainForm);

  const [showUnitForm, setShowUnitForm] = useState(false);
  const [editingUnitId, setEditingUnitId] = useState(null);
  const [unitForm, setUnitForm] = useState(emptyUnitForm);

  // Must run AFTER all three showXxxForm declarations — referencing them
  // earlier would trip the Temporal Dead Zone and crash the page after
  // bundle minification (same pattern as v1.4.44 GRN fix).
  useModalScrollLock(showForm || showMainForm || showUnitForm);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [importMsg, setImportMsg] = useState('');
  const [importing, setImporting] = useState(false);
  const csvInputRef = useRef(null);
  const [toast, setToast] = useState(null);
  // Admin-password gate for destructive actions. Shape: { subject, actionLabel?, perform }
  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };

  const { hasPermission } = useAuth();

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleDeleteAll = () => {
    setPendingDelete({
      subject: 'ALL categories (products will be uncategorized)',
      actionLabel: 'Delete All',
      perform: async () => {
        try { await deleteAllCategories(); await fetchData(); }
        catch (err) { alert(err.response?.data?.error || 'Failed to delete all categories.'); }
      },
    });
  };

  const handleImport = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    setImporting(true);
    setImportMsg('');
    try {
      const res = await importCategories(file);
      setImportMsg(res.data.message);
      await fetchData();
    } catch (err) {
      setImportMsg(err.response?.data?.error || 'Import failed.');
    } finally {
      setImporting(false);
    }
  };

  const handleDownloadSample = () => {
    const csv = 'name,color\nBeef,#ef4444\nChicken,#eab308\nPork,#8b5cf6\nLamb,#22c55e\nProcessed,#3b82f6\nBones,#92400e\nOthers,#6b7280\n';
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'sample_categories.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const fetchData = async () => {
    try {
      const [catsRes, mainsRes, unitsRes] = await Promise.all([getCategories(), getMainCategories(), getUnits()]);
      if (catsRes.data) setCategories(catsRes.data);
      if (mainsRes.data) setMainCategories(mainsRes.data);
      if (unitsRes.data) setUnits(unitsRes.data);
    } catch (err) {}
  };

  useEffect(() => {
    fetchData();
    window.addEventListener('sync-complete', fetchData);
    return () => window.removeEventListener('sync-complete', fetchData);
  }, []);

  // ── Main Category handlers ────────────────────────────────────────────
  const openAddMain = () => { setEditingMainId(null); setMainForm(emptyMainForm); setError(''); setShowMainForm(true); };
  const openEditMain = (m) => { setEditingMainId(m.id); setMainForm({ name: m.name || '', color: m.color || '#6b7280' }); setError(''); setShowMainForm(true); };
  const handleSaveMain = async () => {
    setError('');
    if (!mainForm.name.trim()) return setError('Main category name is required.');
    if (editingMainId && !window.confirm('Update this main category?')) return;
    setSaving(true);
    try {
      if (editingMainId) {
        await updateMainCategory(editingMainId, mainForm);
        showToast('Main category updated.');
      } else {
        await createMainCategory(mainForm);
        showToast('Main category saved.');
      }
      setShowMainForm(false);
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save main category.');
    } finally {
      setSaving(false);
    }
  };
  const handleDeleteMain = (m) => {
    const linkedCount = categories.filter(c => String(c.main_category_id) === String(m.id)).length;
    const note = linkedCount > 0
      ? ` (${linkedCount} categor${linkedCount === 1 ? 'y' : 'ies'} will be unlinked)`
      : '';
    setPendingDelete({
      subject: `Main category: ${m.name}${note}`,
      perform: async () => {
        try { await deleteMainCategory(m.id); await fetchData(); showToast('Main category deleted.', 'error'); }
        catch (err) { alert(err.response?.data?.error || 'Failed to delete main category.'); }
      },
    });
  };

  // ── Unit handlers ─────────────────────────────────────────────────────
  const openAddUnit = () => { setEditingUnitId(null); setUnitForm(emptyUnitForm); setError(''); setShowUnitForm(true); };
  const openEditUnit = (u) => { setEditingUnitId(u.id); setUnitForm({ name: u.name || '', abbreviation: u.abbreviation || '' }); setError(''); setShowUnitForm(true); };
  const handleSaveUnit = async () => {
    setError('');
    if (!unitForm.name.trim()) return setError('Unit name is required.');
    if (editingUnitId && !window.confirm('Update this unit?')) return;
    setSaving(true);
    try {
      if (editingUnitId) {
        await updateUnit(editingUnitId, unitForm);
        showToast('Unit updated.');
      } else {
        await createUnit(unitForm);
        showToast('Unit saved.');
      }
      setShowUnitForm(false);
      await fetchData();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save unit.');
    } finally {
      setSaving(false);
    }
  };
  const handleDeleteUnit = (u) => {
    setPendingDelete({
      subject: `Unit: ${u.name} (existing products keep their value)`,
      perform: async () => {
        try { await deleteUnit(u.id); await fetchData(); showToast('Unit deleted.', 'error'); }
        catch (err) { alert(err.response?.data?.error || 'Failed to delete unit.'); }
      },
    });
  };

  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setError('');
    setShowForm(true);
  };

  const openEdit = (cat) => {
    setEditingId(cat.id);
    setForm({
      name: cat.name || '',
      color: cat.color || '#6b7280',
      main_category_id: cat.main_category_id ? String(cat.main_category_id) : '',
    });
    setError('');
    setShowForm(true);
  };

  const handleSave = async () => {
    setError('');
    if (!form.name.trim()) return setError('Category name is required.');
    if (editingId) {
      if (!window.confirm('Are you sure you want to update this record?')) return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await updateCategory(editingId, form);
        setShowForm(false);
        await fetchData();
        showToast('Category updated successfully.');
      } else {
        await createCategory(form);
        setShowForm(false);
        await fetchData();
        showToast('Category saved successfully.');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save category.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (cat) => {
    setPendingDelete({
      subject: `Category: ${cat.name} (products will be uncategorized)`,
      perform: async () => {
        try { await deleteCategory(cat.id); await fetchData(); showToast('Category deleted.', 'error'); }
        catch (err) { alert(err.response?.data?.error || 'Failed to delete category.'); }
      },
    });
  };

  return (
    <div style={{ padding: 24 }}>
      <style>{`
        .cat-add-btn {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 11px 24px;
          background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
          color: #fff;
          border: none;
          border-radius: 50px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 700;
          box-shadow: 0 4px 15px rgba(37,99,235,0.35);
          letter-spacing: 0.3px;
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .cat-add-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(37,99,235,0.45);
        }
        .cat-add-btn:active {
          transform: translateY(0);
          box-shadow: 0 3px 10px rgba(37,99,235,0.3);
        }
        .cat-add-btn .plus-circle {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          background: rgba(255,255,255,0.25);
          flex-shrink: 0;
        }

        .cat-edit-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          background: linear-gradient(135deg, #60a5fa, #2563eb);
          color: #fff;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          box-shadow: 0 2px 8px rgba(37,99,235,0.3);
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .cat-edit-btn:hover {
          transform: translateY(-2px) scale(1.08);
          box-shadow: 0 6px 16px rgba(37,99,235,0.45);
        }
        .cat-edit-btn:active { transform: scale(0.95); }

        .cat-del-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          background: linear-gradient(135deg, #f87171, #dc2626);
          color: #fff;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          box-shadow: 0 2px 8px rgba(220,38,38,0.3);
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .cat-del-btn:hover {
          transform: translateY(-2px) scale(1.08);
          box-shadow: 0 6px 16px rgba(220,38,38,0.45);
        }
        .cat-del-btn:active { transform: scale(0.95); }

        .cat-save-btn {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 22px;
          background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
          color: #fff;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 700;
          box-shadow: 0 3px 12px rgba(37,99,235,0.3);
          transition: transform 0.15s, box-shadow 0.15s;
        }
        .cat-save-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 6px 18px rgba(37,99,235,0.4);
        }
        .cat-save-btn:disabled { opacity: 0.6; cursor: not-allowed; }

        .cat-row:hover { background: #f8faff; }
      `}</style>

      {/* Header */}
      <div className="page-header">
        <div>
          <h1>{activeTab === 'main' ? 'Main Categories' : activeTab === 'units' ? 'Units' : 'Categories'}</h1>
          <p>
            {activeTab === 'main'  && 'Group categories under departments (e.g. Whisky, Wine, Beer)'}
            {activeTab === 'units' && 'Manage units (kg, pcs, Pack, etc.) — used in product dropdowns across the app'}
            {activeTab === 'categories' && 'Manage product categories'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {activeTab === 'categories' && (
            <>
              {!isBranch && (
                <>
                  <button onClick={handleDownloadSample} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 50, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                    <FiDownload size={14} /> Sample CSV
                  </button>
                  <button onClick={() => csvInputRef.current?.click()} disabled={importing} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', background: importing ? '#d1fae5' : 'linear-gradient(135deg,#059669,#10b981)', color: '#fff', border: 'none', borderRadius: 50, cursor: 'pointer', fontSize: 13, fontWeight: 600, boxShadow: '0 3px 10px rgba(16,185,129,0.3)' }}>
                    <FiUpload size={14} /> {importing ? 'Importing...' : 'Import CSV'}
                  </button>
                  <input ref={csvInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={handleImport} />
                  <button onClick={handleDeleteAll} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', background: 'linear-gradient(135deg,#dc2626,#ef4444)', color: '#fff', border: 'none', borderRadius: 50, cursor: 'pointer', fontSize: 13, fontWeight: 600, boxShadow: '0 3px 10px rgba(220,38,38,0.3)' }}>
                    <FiAlertTriangle size={14} /> Delete All
                  </button>
                </>
              )}
              {!isBranch && hasPermission('Categories:Add') && (
                <button className="cat-add-btn" onClick={openAdd}>
                  <span className="plus-circle"><FiPlus size={14} /></span>
                  Add Category
                </button>
              )}
            </>
          )}
          {activeTab === 'main' && !isBranch && hasPermission('Categories:Add') && (
            <button className="cat-add-btn" onClick={openAddMain}>
              <span className="plus-circle"><FiPlus size={14} /></span>
              Add Main Category
            </button>
          )}
          {activeTab === 'units' && !isBranch && hasPermission('Categories:Add') && (
            <button className="cat-add-btn" onClick={openAddUnit}>
              <span className="plus-circle"><FiPlus size={14} /></span>
              Add Unit
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { id: 'categories', label: 'Categories', icon: <FiTag size={14} /> },
          { id: 'main',       label: 'Main Categories', icon: <FiLayers size={14} /> },
          { id: 'units',      label: 'Units', icon: <FiHash size={14} /> },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '10px 22px', background: 'transparent', border: 'none',
              borderBottom: activeTab === t.id ? '3px solid #2563eb' : '3px solid transparent',
              marginBottom: -2, cursor: 'pointer',
              fontSize: 14, fontWeight: activeTab === t.id ? 700 : 500,
              color: activeTab === t.id ? '#2563eb' : '#6b7280',
              transition: 'all 0.15s',
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {importMsg && (
        <div style={{ marginBottom: 16, padding: '10px 16px', background: importMsg.includes('failed') || importMsg.includes('error') ? '#fef2f2' : '#f0fdf4', color: importMsg.includes('failed') || importMsg.includes('error') ? '#dc2626' : '#16a34a', borderRadius: 8, fontSize: 13, fontWeight: 500, border: `1px solid ${importMsg.includes('failed') || importMsg.includes('error') ? '#fecaca' : '#bbf7d0'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>{importMsg}</span>
          <button onClick={() => setImportMsg('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}><FiX size={14} /></button>
        </div>
      )}

      {activeTab === 'categories' && (
        <>
          {/* Summary stat */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
            <div className="stat-card" style={{ flex: '0 0 auto', minWidth: 180 }}>
              <div className="stat-icon" style={{ background: 'linear-gradient(135deg,#eff6ff,#dbeafe)', color: '#2563eb' }}>
                <FiTag />
              </div>
              <div className="stat-info">
                <h3>{categories.length}</h3>
                <p>Total Categories</p>
              </div>
            </div>
          </div>

          {/* Table */}
          <div className="data-table-container" style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 48 }}>#</th>
                  <th style={{ width: 64 }}>Color</th>
                  <th>Name</th>
                  <th>Main Category</th>
                  <th style={{ width: 160, textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', padding: 48 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: '#9ca3af' }}>
                        <FiTag size={32} style={{ opacity: 0.4 }} />
                        <span style={{ fontSize: 14 }}>No categories yet.</span>
                        <button className="cat-add-btn" onClick={openAdd} style={{ marginTop: 4, fontSize: 13, padding: '8px 18px' }}>
                          <span className="plus-circle"><FiPlus size={12} /></span>
                          Add Category
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  categories.map((cat, i) => {
                    const main = mainCategories.find(m => String(m.id) === String(cat.main_category_id));
                    return (
                      <tr key={cat.id} className="cat-row" style={{ transition: 'background 0.15s' }}>
                        <td style={{ color: '#9ca3af', fontWeight: 500 }}>{i + 1}</td>
                        <td>
                          <span style={{
                            display: 'inline-block', width: 32, height: 32, borderRadius: 8,
                            background: cat.color || '#6b7280',
                            boxShadow: `0 2px 8px ${cat.color || '#6b7280'}60`,
                            border: '2px solid rgba(255,255,255,0.8)',
                            verticalAlign: 'middle'
                          }} />
                        </td>
                        <td>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 7,
                            padding: '5px 14px', borderRadius: 50,
                            background: (cat.color || '#6b7280') + '18',
                            color: cat.color || '#6b7280',
                            fontWeight: 700, fontSize: 13,
                            border: `1.5px solid ${cat.color || '#6b7280'}35`,
                            letterSpacing: 0.2
                          }}>
                            <span style={{
                              width: 7, height: 7, borderRadius: '50%',
                              background: cat.color || '#6b7280',
                              display: 'inline-block', flexShrink: 0
                            }} />
                            {cat.name}
                          </span>
                        </td>
                        <td>
                          {main ? (
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 6,
                              padding: '4px 12px', borderRadius: 50,
                              background: (main.color || '#6b7280') + '18',
                              color: main.color || '#6b7280',
                              fontWeight: 600, fontSize: 12,
                              border: `1px solid ${main.color || '#6b7280'}35`,
                            }}>
                              <FiLayers size={11} /> {main.name}
                            </span>
                          ) : (
                            <span style={{ color: '#9ca3af', fontSize: 12, fontStyle: 'italic' }}>— unassigned —</span>
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                            {hasPermission('Categories:Edit') && !(isBranch && cat.is_hq_owned) && (
                              <button className="cat-edit-btn" onClick={() => openEdit(cat)} title="Edit category">
                                <FiEdit2 size={15} />
                              </button>
                            )}
                            {hasPermission('Categories:Delete') && !(isBranch && cat.is_hq_owned) && (
                              <button className="cat-del-btn" onClick={() => handleDelete(cat)} title="Delete category">
                                <FiTrash2 size={15} />
                              </button>
                            )}
                            {isBranch && cat.is_hq_owned && (
                              <span style={{ fontSize: 10, color: '#92400e', background: '#fef3c7', padding: '2px 6px', borderRadius: 8, fontWeight: 700 }} title="Managed by HQ">HQ</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTab === 'main' && (
        <>
          <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
            <div className="stat-card" style={{ flex: '0 0 auto', minWidth: 180 }}>
              <div className="stat-icon" style={{ background: 'linear-gradient(135deg,#f5f3ff,#ddd6fe)', color: '#7c3aed' }}>
                <FiLayers />
              </div>
              <div className="stat-info">
                <h3>{mainCategories.length}</h3>
                <p>Main Categories</p>
              </div>
            </div>
          </div>
          <div className="data-table-container" style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 48 }}>#</th>
                  <th style={{ width: 64 }}>Color</th>
                  <th>Name</th>
                  <th>Categories Linked</th>
                  <th style={{ width: 160, textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {mainCategories.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', padding: 48 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: '#9ca3af' }}>
                        <FiLayers size={32} style={{ opacity: 0.4 }} />
                        <span style={{ fontSize: 14 }}>No main categories yet. Add one (e.g. "Whisky", "Wine", "Beer") then link your existing categories to it.</span>
                        <button className="cat-add-btn" onClick={openAddMain} style={{ marginTop: 4, fontSize: 13, padding: '8px 18px' }}>
                          <span className="plus-circle"><FiPlus size={12} /></span>
                          Add Main Category
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  mainCategories.map((m, i) => {
                    const linked = categories.filter(c => String(c.main_category_id) === String(m.id));
                    return (
                      <tr key={m.id} className="cat-row" style={{ transition: 'background 0.15s' }}>
                        <td style={{ color: '#9ca3af', fontWeight: 500 }}>{i + 1}</td>
                        <td>
                          <span style={{
                            display: 'inline-block', width: 32, height: 32, borderRadius: 8,
                            background: m.color || '#6b7280',
                            boxShadow: `0 2px 8px ${m.color || '#6b7280'}60`,
                            border: '2px solid rgba(255,255,255,0.8)',
                            verticalAlign: 'middle'
                          }} />
                        </td>
                        <td>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center', gap: 7,
                            padding: '5px 14px', borderRadius: 50,
                            background: (m.color || '#6b7280') + '18',
                            color: m.color || '#6b7280',
                            fontWeight: 700, fontSize: 13,
                            border: `1.5px solid ${m.color || '#6b7280'}35`,
                          }}>
                            <FiLayers size={12} /> {m.name}
                          </span>
                        </td>
                        <td>
                          {linked.length === 0
                            ? <span style={{ color: '#9ca3af', fontSize: 12, fontStyle: 'italic' }}>— none —</span>
                            : (
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                {linked.map(c => (
                                  <span key={c.id} style={{
                                    padding: '2px 9px', borderRadius: 50, fontSize: 11, fontWeight: 600,
                                    background: (c.color || '#6b7280') + '18',
                                    color: c.color || '#6b7280',
                                    border: `1px solid ${c.color || '#6b7280'}35`,
                                  }}>{c.name}</span>
                                ))}
                              </div>
                            )}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                            {hasPermission('Categories:Edit') && !(isBranch && m.is_hq_owned) && (
                              <button className="cat-edit-btn" onClick={() => openEditMain(m)} title="Edit">
                                <FiEdit2 size={15} />
                              </button>
                            )}
                            {hasPermission('Categories:Delete') && !(isBranch && m.is_hq_owned) && (
                              <button className="cat-del-btn" onClick={() => handleDeleteMain(m)} title="Delete">
                                <FiTrash2 size={15} />
                              </button>
                            )}
                            {isBranch && m.is_hq_owned && (
                              <span style={{ fontSize: 10, color: '#92400e', background: '#fef3c7', padding: '2px 6px', borderRadius: 8, fontWeight: 700 }} title="Managed by HQ">HQ</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {activeTab === 'units' && (
        <>
          <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
            <div className="stat-card" style={{ flex: '0 0 auto', minWidth: 180 }}>
              <div className="stat-icon" style={{ background: 'linear-gradient(135deg,#ecfeff,#bae6fd)', color: '#0891b2' }}>
                <FiHash />
              </div>
              <div className="stat-info">
                <h3>{units.length}</h3>
                <p>Units</p>
              </div>
            </div>
          </div>
          <div className="data-table-container" style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 48 }}>#</th>
                  <th>Name</th>
                  <th>Abbreviation</th>
                  <th style={{ width: 160, textAlign: 'center' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {units.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ textAlign: 'center', padding: 48 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, color: '#9ca3af' }}>
                        <FiHash size={32} style={{ opacity: 0.4 }} />
                        <span style={{ fontSize: 14 }}>No units yet. Existing product units (kg, Pack, etc.) are auto-imported on first load.</span>
                        <button className="cat-add-btn" onClick={openAddUnit} style={{ marginTop: 4, fontSize: 13, padding: '8px 18px' }}>
                          <span className="plus-circle"><FiPlus size={12} /></span>
                          Add Unit
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  units.map((u, i) => (
                    <tr key={u.id} className="cat-row" style={{ transition: 'background 0.15s' }}>
                      <td style={{ color: '#9ca3af', fontWeight: 500 }}>{i + 1}</td>
                      <td>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 7,
                          padding: '5px 14px', borderRadius: 50,
                          background: '#ecfeff', color: '#0891b2',
                          fontWeight: 700, fontSize: 13,
                          border: '1.5px solid #a5f3fc',
                        }}>
                          <FiHash size={12} /> {u.name}
                        </span>
                      </td>
                      <td style={{ color: '#6b7280', fontFamily: 'monospace' }}>
                        {u.abbreviation || <span style={{ color: '#cbd5e1' }}>—</span>}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                          {hasPermission('Categories:Edit') && !(isBranch && u.is_hq_owned) && (
                            <button className="cat-edit-btn" onClick={() => openEditUnit(u)} title="Edit">
                              <FiEdit2 size={15} />
                            </button>
                          )}
                          {hasPermission('Categories:Delete') && !(isBranch && u.is_hq_owned) && (
                            <button className="cat-del-btn" onClick={() => handleDeleteUnit(u)} title="Delete">
                              <FiTrash2 size={15} />
                            </button>
                          )}
                          {isBranch && u.is_hq_owned && (
                            <span style={{ fontSize: 10, color: '#92400e', background: '#fef3c7', padding: '2px 6px', borderRadius: 8, fontWeight: 700 }} title="Managed by HQ">HQ</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Add/Edit Modal */}
      {showForm && (
        <Portal>
        <div className="modal-overlay">
          <div className="modal" style={{ width: 440 }}>
            <div className="modal-header" style={{
              background: 'linear-gradient(135deg, #2563eb 0%, #7c3aed 100%)',
              borderRadius: '12px 12px 0 0', padding: '18px 24px'
            }}>
              <h3 style={{ color: '#fff', margin: 0, fontWeight: 700, fontSize: 16 }}>
                {editingId ? '✏️  Edit Category' : '🏷️  Add New Category'}
              </h3>
              <button
                onClick={() => setShowForm(false)}
                style={{
                  background: 'rgba(255,255,255,0.2)', border: 'none',
                  borderRadius: 8, color: '#fff', cursor: 'pointer',
                  width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 16, transition: 'background 0.15s'
                }}
              >
                <FiX />
              </button>
            </div>

            <div className="modal-body" style={{ padding: '22px 24px' }}>
              {error && (
                <div style={{
                  marginBottom: 16, padding: '10px 14px',
                  background: '#fef2f2', color: '#dc2626',
                  borderRadius: 8, fontSize: 13, fontWeight: 500,
                  border: '1px solid #fecaca', display: 'flex', alignItems: 'center', gap: 8
                }}>
                  ⚠️ {error}
                </div>
              )}

              <div className="form-group">
                <label style={{ fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 6, display: 'block' }}>
                  Category Name *
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Beef, Chicken, Pork..."
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleSave()}
                />
              </div>

              <div className="form-group">
                <label style={{ fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 6, display: 'block' }}>
                  Main Category (optional)
                </label>
                <select
                  value={form.main_category_id}
                  onChange={e => setForm(p => ({ ...p, main_category_id: e.target.value }))}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, background: '#fff', boxSizing: 'border-box' }}
                >
                  <option value="">— Unassigned —</option>
                  {mainCategories.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
                {mainCategories.length === 0 && (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#9ca3af' }}>
                    No main categories yet. Switch to the "Main Categories" tab to add one (e.g. Whisky, Wine, Beer).
                  </div>
                )}
              </div>

              <div className="form-group">
                <label style={{ fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 10, display: 'block' }}>
                  Choose Color
                </label>

                {/* Preset swatches */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
                  {PRESET_COLORS.map(c => (
                    <button
                      key={c}
                      onClick={() => setForm(p => ({ ...p, color: c }))}
                      title={c}
                      style={{
                        width: 34, height: 34, borderRadius: 8, background: c,
                        border: 'none', cursor: 'pointer',
                        boxShadow: form.color === c
                          ? `0 0 0 3px #fff, 0 0 0 5px ${c}`
                          : `0 2px 6px ${c}50`,
                        transform: form.color === c ? 'scale(1.15)' : 'scale(1)',
                        transition: 'all 0.15s'
                      }}
                    />
                  ))}
                </div>

                {/* Custom picker row */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px', background: '#f9fafb',
                  borderRadius: 10, border: '1px solid #e5e7eb'
                }}>
                  <input
                    type="color"
                    value={form.color}
                    onChange={e => setForm(p => ({ ...p, color: e.target.value }))}
                    style={{
                      width: 38, height: 38, border: 'none',
                      borderRadius: 8, cursor: 'pointer', padding: 0,
                      background: 'none'
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>Custom color</div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#374151', fontFamily: 'monospace' }}>{form.color}</div>
                  </div>
                  {/* Live preview badge */}
                  <span style={{
                    padding: '5px 16px', borderRadius: 50, fontSize: 13, fontWeight: 700,
                    background: form.color + '18', color: form.color,
                    border: `1.5px solid ${form.color}35`,
                    display: 'flex', alignItems: 'center', gap: 6
                  }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: form.color, display: 'inline-block' }} />
                    {form.name || 'Preview'}
                  </span>
                </div>
              </div>
            </div>

            <div className="modal-footer" style={{ padding: '16px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                className="btn-secondary"
                onClick={() => setShowForm(false)}
                style={{ borderRadius: 10, padding: '9px 20px', fontWeight: 600 }}
              >
                Cancel
              </button>
              <button className="cat-save-btn" onClick={handleSave} disabled={saving}>
                {saving ? (
                  <>⏳ Saving...</>
                ) : editingId ? (
                  <><FiEdit2 size={14} /> Update Category</>
                ) : (
                  <><FiPlus size={14} /> Add Category</>
                )}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}
      {/* Add/Edit Main Category Modal */}
      {showMainForm && (
        <Portal>
        <div className="modal-overlay">
          <div className="modal" style={{ width: 440 }}>
            <div className="modal-header" style={{
              background: 'linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)',
              borderRadius: '12px 12px 0 0', padding: '18px 24px'
            }}>
              <h3 style={{ color: '#fff', margin: 0, fontWeight: 700, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <FiLayers /> {editingMainId ? 'Edit Main Category' : 'Add Main Category'}
              </h3>
              <button onClick={() => setShowMainForm(false)}
                style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer', width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>
                <FiX />
              </button>
            </div>
            <div className="modal-body" style={{ padding: '22px 24px' }}>
              {error && (
                <div style={{ marginBottom: 16, padding: '10px 14px', background: '#fef2f2', color: '#dc2626', borderRadius: 8, fontSize: 13, fontWeight: 500, border: '1px solid #fecaca' }}>
                  ⚠️ {error}
                </div>
              )}
              <div className="form-group">
                <label style={{ fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 6, display: 'block' }}>
                  Main Category Name *
                </label>
                <input
                  type="text"
                  value={mainForm.name}
                  onChange={e => setMainForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Whisky, Wine, Beer..."
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleSaveMain()}
                />
              </div>
              <div className="form-group">
                <label style={{ fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 10, display: 'block' }}>
                  Choose Color
                </label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
                  {PRESET_COLORS.map(c => (
                    <button key={c} onClick={() => setMainForm(p => ({ ...p, color: c }))} title={c}
                      style={{
                        width: 34, height: 34, borderRadius: 8, background: c,
                        border: 'none', cursor: 'pointer',
                        boxShadow: mainForm.color === c ? `0 0 0 3px #fff, 0 0 0 5px ${c}` : `0 2px 6px ${c}50`,
                        transform: mainForm.color === c ? 'scale(1.15)' : 'scale(1)', transition: 'all 0.15s'
                      }} />
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: '#f9fafb', borderRadius: 10, border: '1px solid #e5e7eb' }}>
                  <input type="color" value={mainForm.color} onChange={e => setMainForm(p => ({ ...p, color: e.target.value }))}
                    style={{ width: 38, height: 38, border: 'none', borderRadius: 8, cursor: 'pointer', padding: 0, background: 'none' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>Custom color</div>
                    <div style={{ fontWeight: 600, fontSize: 13, color: '#374151', fontFamily: 'monospace' }}>{mainForm.color}</div>
                  </div>
                  <span style={{
                    padding: '5px 16px', borderRadius: 50, fontSize: 13, fontWeight: 700,
                    background: mainForm.color + '18', color: mainForm.color,
                    border: `1.5px solid ${mainForm.color}35`, display: 'flex', alignItems: 'center', gap: 6
                  }}>
                    <FiLayers size={11} /> {mainForm.name || 'Preview'}
                  </span>
                </div>
              </div>
            </div>
            <div className="modal-footer" style={{ padding: '16px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button className="btn-secondary" onClick={() => setShowMainForm(false)} style={{ borderRadius: 10, padding: '9px 20px', fontWeight: 600 }}>
                Cancel
              </button>
              <button className="cat-save-btn" onClick={handleSaveMain} disabled={saving}>
                {saving ? '⏳ Saving...' : editingMainId ? <><FiEdit2 size={14} /> Update</> : <><FiPlus size={14} /> Add</>}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Add/Edit Unit Modal */}
      {showUnitForm && (
        <Portal>
        <div className="modal-overlay">
          <div className="modal" style={{ width: 440 }}>
            <div className="modal-header" style={{
              background: 'linear-gradient(135deg, #0891b2 0%, #2563eb 100%)',
              borderRadius: '12px 12px 0 0', padding: '18px 24px'
            }}>
              <h3 style={{ color: '#fff', margin: 0, fontWeight: 700, fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
                <FiHash /> {editingUnitId ? 'Edit Unit' : 'Add Unit'}
              </h3>
              <button onClick={() => setShowUnitForm(false)}
                style={{ background: 'rgba(255,255,255,0.2)', border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer', width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>
                <FiX />
              </button>
            </div>
            <div className="modal-body" style={{ padding: '22px 24px' }}>
              {error && (
                <div style={{ marginBottom: 16, padding: '10px 14px', background: '#fef2f2', color: '#dc2626', borderRadius: 8, fontSize: 13, fontWeight: 500, border: '1px solid #fecaca' }}>
                  ⚠️ {error}
                </div>
              )}
              <div className="form-group">
                <label style={{ fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 6, display: 'block' }}>
                  Unit Name *
                </label>
                <input
                  type="text"
                  value={unitForm.name}
                  onChange={e => setUnitForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. kg, pcs, Pack, Bottle..."
                  autoFocus
                  onKeyDown={e => e.key === 'Enter' && handleSaveUnit()}
                />
              </div>
              <div className="form-group">
                <label style={{ fontWeight: 600, fontSize: 13, color: '#374151', marginBottom: 6, display: 'block' }}>
                  Abbreviation (optional)
                </label>
                <input
                  type="text"
                  value={unitForm.abbreviation}
                  onChange={e => setUnitForm(p => ({ ...p, abbreviation: e.target.value }))}
                  placeholder="e.g. kg, pc, pkt..."
                  onKeyDown={e => e.key === 'Enter' && handleSaveUnit()}
                />
                <div style={{ marginTop: 4, fontSize: 11, color: '#9ca3af' }}>Short form shown in compact views (defaults to the full name).</div>
              </div>
            </div>
            <div className="modal-footer" style={{ padding: '16px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button className="btn-secondary" onClick={() => setShowUnitForm(false)} style={{ borderRadius: 10, padding: '9px 20px', fontWeight: 600 }}>
                Cancel
              </button>
              <button className="cat-save-btn" onClick={handleSaveUnit} disabled={saving}>
                {saving ? '⏳ Saving...' : editingUnitId ? <><FiEdit2 size={14} /> Update</> : <><FiPlus size={14} /> Add</>}
              </button>
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

export default Categories;
