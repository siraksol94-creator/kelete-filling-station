import React, { useEffect, useState } from 'react';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiDroplet } from 'react-icons/fi';
import { getFuelGrades, createFuelGrade, updateFuelGrade, deleteFuelGrade } from '../services/fuelApi';

const emptyForm = { code: '', name: '', unit: 'L', selling_price: 0, cost_price: 0, color: '#2563eb', status: 'Active' };
const DEFAULT_COLORS = ['#2563eb', '#dc2626', '#f59e0b', '#16a34a', '#8b5cf6', '#0f766e'];

export default function FuelGrades() {
  const [rows, setRows] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try { const r = await getFuelGrades(); setRows(r.data || []); } catch (e) {}
  };
  useEffect(() => { load(); }, []);

  const openNew = () => { setEditingId(null); setForm(emptyForm); setErr(''); setShowForm(true); };
  const openEdit = (row) => { setEditingId(row.id); setForm({ ...row }); setErr(''); setShowForm(true); };

  const save = async (e) => {
    e.preventDefault(); setErr(''); setSaving(true);
    try {
      if (editingId) await updateFuelGrade(editingId, form);
      else await createFuelGrade(form);
      setShowForm(false); await load();
    } catch (ex) { setErr(ex.response?.data?.error || 'Save failed'); }
    finally { setSaving(false); }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete fuel grade "${row.name}"?`)) return;
    try { await deleteFuelGrade(row.id); await load(); }
    catch (ex) { alert(ex.response?.data?.error || 'Delete failed'); }
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiDroplet /> Fuel Grades
        </h2>
        <button onClick={openNew} style={btnPrimary}><FiPlus /> New Grade</button>
      </div>

      <div style={card}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Code</th><th style={th}>Name</th><th style={th}>Unit</th>
              <th style={{ ...th, textAlign: 'right' }}>Selling Price</th>
              <th style={{ ...th, textAlign: 'right' }}>Cost (WAC)</th>
              <th style={th}>Status</th><th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No fuel grades yet. Add Petrol, Diesel, Paraffin to begin.</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={td}><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: r.color, marginRight: 8 }} />{r.code}</td>
                <td style={td}>{r.name}</td>
                <td style={td}>{r.unit}</td>
                <td style={{ ...td, textAlign: 'right' }}>K {Number(r.selling_price).toFixed(2)}</td>
                <td style={{ ...td, textAlign: 'right', color: '#6b7280' }}>K {Number(r.cost_price).toFixed(4)}</td>
                <td style={td}>{r.status}</td>
                <td style={td}>
                  <button onClick={() => openEdit(r)} style={iconBtn}><FiEdit2 /></button>
                  <button onClick={() => remove(r)} style={iconBtnDanger}><FiTrash2 /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm && (
        <div style={backdrop} onClick={() => setShowForm(false)}>
          <div style={modal} onClick={e => e.stopPropagation()}>
            <div style={modalHeader}>
              <h3 style={{ margin: 0 }}>{editingId ? 'Edit' : 'New'} Fuel Grade</h3>
              <button onClick={() => setShowForm(false)} style={iconBtn}><FiX /></button>
            </div>
            <form onSubmit={save}>
              {err && <div style={errBox}>{err}</div>}
              <div style={formGrid}>
                <label style={lbl}>Code *<input value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} required style={input} placeholder="PMS / AGO / DPK" /></label>
                <label style={lbl}>Name *<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required style={input} placeholder="Petrol / Diesel / Paraffin" /></label>
                <label style={lbl}>Unit<input value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })} style={input} /></label>
                <label style={lbl}>Selling Price (K / litre) *<input type="number" step="0.0001" value={form.selling_price} onChange={e => setForm({ ...form, selling_price: e.target.value })} required style={input} /></label>
                <label style={lbl}>Cost Price (K / litre, WAC)<input type="number" step="0.0001" value={form.cost_price} onChange={e => setForm({ ...form, cost_price: e.target.value })} style={input} /></label>
                <label style={lbl}>Status
                  <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} style={input}>
                    <option>Active</option><option>Inactive</option>
                  </select>
                </label>
                <label style={{ ...lbl, gridColumn: '1 / -1' }}>Color
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    {DEFAULT_COLORS.map(c => (
                      <button key={c} type="button" onClick={() => setForm({ ...form, color: c })}
                        style={{ width: 28, height: 28, borderRadius: '50%', background: c, border: form.color === c ? '3px solid #111' : '1px solid #ddd', cursor: 'pointer' }} />
                    ))}
                  </div>
                </label>
              </div>
              <div style={modalFooter}>
                <button type="button" onClick={() => setShowForm(false)} style={btnSecondary}>Cancel</button>
                <button type="submit" disabled={saving} style={btnPrimary}>{saving ? 'Saving...' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const card = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' };
const table = { width: '100%', borderCollapse: 'collapse' };
const th = { textAlign: 'left', padding: '12px 16px', fontSize: 12, fontWeight: 600, textTransform: 'uppercase', color: '#6b7280', background: '#f9fafb', borderBottom: '1px solid #e5e7eb' };
const td = { padding: '12px 16px', fontSize: 14 };
const btnPrimary = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 16px', background: '#2563eb', color: '#fff', border: 0, borderRadius: 6, cursor: 'pointer', fontWeight: 500 };
const btnSecondary = { padding: '10px 16px', background: '#f3f4f6', color: '#111', border: 0, borderRadius: 6, cursor: 'pointer' };
const iconBtn = { background: 'transparent', border: 0, padding: 6, cursor: 'pointer', color: '#374151', marginRight: 4 };
const iconBtnDanger = { ...iconBtn, color: '#dc2626' };
const backdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modal = { background: '#fff', borderRadius: 10, width: 'min(560px, 94vw)', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.2)' };
const modalHeader = { padding: 20, borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
const modalFooter = { padding: 20, borderTop: '1px solid #e5e7eb', display: 'flex', gap: 8, justifyContent: 'flex-end' };
const formGrid = { padding: 20, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 };
const lbl = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, fontWeight: 500, color: '#374151' };
const input = { padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, marginTop: 2 };
const errBox = { margin: 20, padding: 12, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 6, fontSize: 14 };
