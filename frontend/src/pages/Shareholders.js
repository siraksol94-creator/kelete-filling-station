// Shareholders — master list of equity holders.
// Powers the per-shareholder filter and dropdown on Capital + Dividend pages.
import React, { useEffect, useState } from 'react';
import {
  getShareholders, getShareholderStats,
  createShareholder, updateShareholder, deleteShareholder,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiUsers } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const Shareholders = () => {
  const { hasPermission } = useAuth();
  const { symbol: curSym } = useCurrency();
  const [list, setList] = useState([]);
  const [stats, setStats] = useState([]);
  const [toast, setToast] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', email: '', phone: '', share_percentage: '', notes: '' });

  useModalScrollLock(showForm);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchAll = async () => {
    try {
      const [listRes, statsRes] = await Promise.all([getShareholders(), getShareholderStats()]);
      setList(listRes.data || []);
      setStats(statsRes.data || []);
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load.', 'error'); }
  };

  useEffect(() => { fetchAll(); }, []);

  const openNew = () => {
    setEditId(null);
    setForm({ name: '', email: '', phone: '', share_percentage: '', notes: '' });
    setError('');
    setShowForm(true);
  };

  const openEdit = (s) => {
    setEditId(s.id);
    setForm({
      name: s.name || '',
      email: s.email || '',
      phone: s.phone || '',
      share_percentage: s.share_percentage > 0 ? String(s.share_percentage) : '',
      notes: s.notes || '',
    });
    setError('');
    setShowForm(true);
  };

  const save = async () => {
    setError('');
    if (!form.name.trim()) return setError('Name is required.');
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        share_percentage: parseFloat(form.share_percentage) || 0,
        notes: form.notes.trim() || null,
      };
      if (editId) await updateShareholder(editId, payload);
      else        await createShareholder(payload);
      setShowForm(false);
      await fetchAll();
      showToast(editId ? 'Shareholder updated.' : 'Shareholder added.');
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); }
    finally { setSaving(false); }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDelete = (s) => {
    setPendingDelete({
      subject: `Shareholder: ${s.name} (historical entries keep their labels)`,
      perform: async () => {
        try { await deleteShareholder(s.id); await fetchAll(); showToast('Shareholder deleted.', 'error'); }
        catch (e) { showToast(e.response?.data?.error || 'Delete failed.', 'error'); }
      },
    });
  };

  const totalEntered = stats.reduce((s, r) => s + parseFloat(r.total_injected || 0), 0);
  const totalDrawn   = stats.reduce((s, r) => s + parseFloat(r.total_drawn || 0), 0);
  const totalDiv     = stats.reduce((s, r) => s + parseFloat(r.total_dividends || 0), 0);

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Shareholders</h1>
          <p>Master list of equity holders — used to tag Capital + Dividend entries</p>
        </div>
        {hasPermission('Shareholders:Add') && (
          <button className="btn btn-primary" onClick={openNew}><FiPlus /> New Shareholder</button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#6b21a8,#581c87)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Shareholders</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{list.length}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#16a34a,#15803d)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Total Injected</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{curSym}{totalEntered.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#dc2626,#991b1b)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Total Drawn</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{curSym}{totalDrawn.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#1e40af,#1e3a8a)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Total Dividends Paid</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{curSym}{totalDiv.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
      </div>

      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>NAME</th><th>EMAIL</th><th>PHONE</th>
              <th style={{ textAlign: 'right' }}>SHARE %</th>
              <th style={{ textAlign: 'right' }}>NET CAPITAL</th>
              <th style={{ textAlign: 'right' }}>DIVIDENDS</th>
              <th style={{ textAlign: 'center' }}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No shareholders yet. Click "New Shareholder" to add one.</td></tr>
            ) : list.map(s => {
              const st = stats.find(x => x.id === s.id) || { total_injected: 0, total_drawn: 0, total_dividends: 0, net_capital: 0 };
              return (
                <tr key={s.id}>
                  <td style={{ fontWeight: 600 }}>{s.name}</td>
                  <td style={{ color: '#6b7280', fontSize: 12 }}>{s.email || '—'}</td>
                  <td style={{ color: '#6b7280', fontSize: 12 }}>{s.phone || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{s.share_percentage > 0 ? `${s.share_percentage}%` : '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: st.net_capital >= 0 ? '#16a34a' : '#dc2626' }}>
                    {curSym}{parseFloat(st.net_capital).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#6b21a8' }}>
                    {curSym}{parseFloat(st.total_dividends).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {hasPermission('Shareholders:Edit') && <button onClick={() => openEdit(s)} title="Edit" style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', padding: 4 }}><FiEdit2 /></button>}
                    {hasPermission('Shareholders:Delete') && <button onClick={() => handleDelete(s)} title="Delete" style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4 }}><FiTrash2 /></button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showForm && (
        <Portal>
          <div className="modal-overlay" onClick={() => setShowForm(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>{editId ? 'Edit Shareholder' : 'New Shareholder'}</h3>
                <button className="modal-close" onClick={() => setShowForm(false)}>×</button>
              </div>
              <div className="modal-body">
                {error && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{error}</div>}
                <div className="form-group">
                  <label>Name *</label>
                  <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="e.g. Sirak Solomon" />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Email</label>
                    <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="optional" />
                  </div>
                  <div className="form-group">
                    <label>Phone</label>
                    <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="optional" />
                  </div>
                </div>
                <div className="form-group">
                  <label>Share % (optional)</label>
                  <input type="number" min="0" max="100" step="0.01" value={form.share_percentage} onChange={e => setForm({ ...form, share_percentage: e.target.value })} placeholder="e.g. 50" />
                  <small style={{ color: '#6b7280', fontSize: 11, display: 'block', marginTop: 4 }}>Used for fair dividend allocation reporting later.</small>
                </div>
                <div className="form-group">
                  <label>Notes</label>
                  <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="optional" />
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving...' : editId ? 'Update' : 'Save'}</button>
              </div>
            </div>
          </div>
        </Portal>
      )}

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

export default Shareholders;
