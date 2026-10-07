import React, { useEffect, useState } from 'react';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiDatabase, FiActivity } from 'react-icons/fi';
import { getTanks, createTank, updateTank, deleteTank, dipTank, getFuelGrades } from '../services/fuelApi';
import { S } from './fuelStyles';

const emptyForm = { code: '', name: '', fuel_grade_id: '', capacity_litres: '', current_volume: 0, low_stock_litres: 1000, status: 'Active' };

export default function Tanks() {
  const [rows, setRows] = useState([]);
  const [grades, setGrades] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [dipFor, setDipFor] = useState(null);
  const [dipVal, setDipVal] = useState('');

  const load = async () => {
    try {
      const [t, g] = await Promise.all([getTanks(), getFuelGrades()]);
      setRows(t.data || []); setGrades(g.data || []);
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);

  const openNew = () => { setEditingId(null); setForm(emptyForm); setErr(''); setShowForm(true); };
  const openEdit = (r) => { setEditingId(r.id); setForm({ ...r }); setErr(''); setShowForm(true); };

  const save = async (e) => {
    e.preventDefault(); setErr(''); setSaving(true);
    try {
      if (editingId) await updateTank(editingId, form);
      else await createTank(form);
      setShowForm(false); await load();
    } catch (ex) { setErr(ex.response?.data?.error || 'Save failed'); }
    finally { setSaving(false); }
  };

  const remove = async (r) => {
    if (!window.confirm(`Delete tank "${r.name}"?`)) return;
    try { await deleteTank(r.id); await load(); }
    catch (ex) { alert(ex.response?.data?.error || 'Delete failed'); }
  };

  const submitDip = async (e) => {
    e.preventDefault();
    try {
      const resp = await dipTank(dipFor.id, { measured_litres: Number(dipVal) });
      alert(`Dip recorded: previous ${resp.data.previous_volume} L, new ${resp.data.new_volume} L, variance ${resp.data.variance.toFixed(2)} L`);
      setDipFor(null); setDipVal(''); await load();
    } catch (ex) { alert(ex.response?.data?.error || 'Dip failed'); }
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h2 style={S.h2}><FiDatabase /> Tanks</h2>
        <button onClick={openNew} style={S.btnPrimary}><FiPlus /> New Tank</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16, marginBottom: 20 }}>
        {rows.map(t => {
          const pct = t.capacity_litres > 0 ? (t.current_volume / t.capacity_litres) * 100 : 0;
          const low = t.current_volume <= (t.low_stock_litres || 0);
          const color = t.grade_color || '#2563eb';
          return (
            <div key={t.id} style={S.statCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div>
                  <div style={S.statLabel}>{t.code} - {t.name}</div>
                  <div style={{ marginTop: 4 }}><span style={S.pill(color)}>{t.grade_name || '-'}</span></div>
                </div>
                <div style={{ display: 'flex', gap: 2 }}>
                  <button onClick={() => { setDipFor(t); setDipVal(String(t.current_volume || '')); }} style={S.iconBtn} title="Record dip"><FiActivity /></button>
                  <button onClick={() => openEdit(t)} style={S.iconBtn}><FiEdit2 /></button>
                  <button onClick={() => remove(t)} style={S.iconBtnDanger}><FiTrash2 /></button>
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: low ? '#dc2626' : '#111' }}>
                  {Number(t.current_volume).toFixed(0)} <span style={{ fontSize: 13, color: '#6b7280' }}>/ {Number(t.capacity_litres).toFixed(0)} L</span>
                </div>
                <div style={S.bar(pct)}><div style={S.barFill(pct, low ? '#dc2626' : color)} /></div>
                {low && <div style={{ marginTop: 6, fontSize: 12, color: '#dc2626' }}>LOW STOCK - below {t.low_stock_litres} L</div>}
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <div style={{ ...S.statCard, textAlign: 'center', color: '#6b7280' }}>No tanks yet. Create fuel grades first, then add tanks.</div>
        )}
      </div>

      {showForm && (
        <div style={S.backdrop} onClick={() => setShowForm(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>{editingId ? 'Edit' : 'New'} Tank</h3>
              <button onClick={() => setShowForm(false)} style={S.iconBtn}><FiX /></button>
            </div>
            <form onSubmit={save}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid}>
                <label style={S.lbl}>Code *<input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} required style={S.input} placeholder="T1" /></label>
                <label style={S.lbl}>Name *<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Fuel Grade *
                  <select value={form.fuel_grade_id} onChange={e => setForm({ ...form, fuel_grade_id: e.target.value })} required style={S.input}>
                    <option value="">-- select --</option>
                    {grades.map(g => <option key={g.id} value={g.id}>{g.code} - {g.name}</option>)}
                  </select>
                </label>
                <label style={S.lbl}>Capacity (L) *<input type="number" value={form.capacity_litres} onChange={e => setForm({ ...form, capacity_litres: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Current Volume (L)<input type="number" value={form.current_volume} onChange={e => setForm({ ...form, current_volume: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Low Stock Alert (L)<input type="number" value={form.low_stock_litres} onChange={e => setForm({ ...form, low_stock_litres: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Status
                  <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} style={S.input}>
                    <option>Active</option><option>Inactive</option>
                  </select>
                </label>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setShowForm(false)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" disabled={saving} style={S.btnPrimary}>{saving ? 'Saving...' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {dipFor && (
        <div style={S.backdrop} onClick={() => setDipFor(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>Dip Reading: {dipFor.code}</h3>
              <button onClick={() => setDipFor(null)} style={S.iconBtn}><FiX /></button>
            </div>
            <form onSubmit={submitDip}>
              <div style={{ padding: 20 }}>
                <p style={{ marginTop: 0, color: '#6b7280' }}>Book volume: <strong>{Number(dipFor.current_volume).toFixed(2)} L</strong></p>
                <label style={S.lbl}>Measured volume (L) *
                  <input type="number" step="0.01" value={dipVal} onChange={e => setDipVal(e.target.value)} required autoFocus style={S.input} />
                </label>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setDipFor(null)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" style={S.btnPrimary}>Record Dip</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
