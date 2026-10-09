import React, { useEffect, useState } from 'react';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiDatabase, FiActivity, FiAlertTriangle } from 'react-icons/fi';
import { getTanks, createTank, updateTank, deleteTank, dipTank, getFuelGrades } from '../services/fuelApi';
import { S } from './fuelStyles';

// Vertical tank drawn as SVG. Fuel fills from the bottom, with a subtle wave
// on top and gauge marks on the side. Width 70px, height 130px.
function TankSvg({ pct, color, low }) {
  const w = 70, h = 130;
  const padTop = 10, padBottom = 8;
  const innerH = h - padTop - padBottom;
  const fillH = (pct / 100) * innerH;
  const fillY = h - padBottom - fillH;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id={`g-${color.replace('#', '')}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.95" />
          <stop offset="100%" stopColor={color} stopOpacity="0.65" />
        </linearGradient>
      </defs>
      {/* Tank body outline */}
      <rect x="4" y={padTop} width={w - 8} height={innerH} rx="8" fill="#f9fafb" stroke="#d1d5db" strokeWidth="1.5" />
      {/* Fuel fill */}
      {fillH > 1 && (
        <rect x="5" y={fillY} width={w - 10} height={fillH - 1} rx="6" fill={`url(#g-${color.replace('#', '')})`} />
      )}
      {/* Top cap / lid line */}
      <rect x="18" y={padTop - 6} width={w - 36} height="6" rx="2" fill="#9ca3af" />
      {/* Gauge ticks on the right side */}
      {[25, 50, 75].map(p => {
        const ty = h - padBottom - (p / 100) * innerH;
        return <line key={p} x1={w - 10} x2={w - 4} y1={ty} y2={ty} stroke="#9ca3af" strokeWidth="1" />;
      })}
      {/* Percentage label centered in the tank */}
      <text x={w / 2} y={h / 2 + 4} textAnchor="middle" fontSize="13" fontWeight="700" fill={pct > 55 ? '#fff' : color}>
        {pct.toFixed(0)}%
      </text>
      {low && (
        <circle cx={w - 8} cy={padTop + 2} r="4" fill="#dc2626" stroke="#fff" strokeWidth="1.5" />
      )}
    </svg>
  );
}

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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 20, marginBottom: 20 }}>
        {rows.map(t => {
          const cap = Number(t.capacity_litres) || 0;
          const vol = Number(t.current_volume) || 0;
          const pct = cap > 0 ? Math.min(100, Math.max(0, (vol / cap) * 100)) : 0;
          const low = vol <= (t.low_stock_litres || 0);
          const color = low ? '#dc2626' : (t.grade_color || '#2563eb');
          return (
            <div key={t.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
              {/* Header: code + grade pill + action icons */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#111' }}>{t.code}</div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{t.name}</div>
                </div>
                <div style={{ display: 'flex', gap: 2 }}>
                  <button onClick={() => { setDipFor(t); setDipVal(String(vol || '')); }} style={S.iconBtn} title="Record dip"><FiActivity /></button>
                  <button onClick={() => openEdit(t)} style={S.iconBtn} title="Edit"><FiEdit2 /></button>
                  <button onClick={() => remove(t)} style={S.iconBtnDanger} title="Delete"><FiTrash2 /></button>
                </div>
              </div>
              <div style={{ marginBottom: 10 }}><span style={S.pill(t.grade_color || '#6b7280')}>{t.grade_name || '-'}</span></div>

              {/* Tank visual */}
              <div style={{ display: 'flex', gap: 14, alignItems: 'stretch', marginTop: 4 }}>
                <TankSvg pct={pct} color={color} low={low} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 600, letterSpacing: 0.4 }}>Current</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: color, lineHeight: 1.1, marginTop: 2 }}>
                    {vol.toLocaleString(undefined, { maximumFractionDigits: 0 })} <span style={{ fontSize: 13, color: '#9ca3af', fontWeight: 500 }}>L</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 6 }}>
                    of <strong style={{ color: '#374151' }}>{cap.toLocaleString(undefined, { maximumFractionDigits: 0 })} L</strong>
                  </div>
                  <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>
                    <strong style={{ color: color }}>{pct.toFixed(0)}%</strong> full
                  </div>
                </div>
              </div>

              {low && (
                <div style={{ marginTop: 12, padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <FiAlertTriangle /> LOW STOCK — below {t.low_stock_litres} L
                </div>
              )}
            </div>
          );
        })}
        {rows.length === 0 && (
          <div style={{ ...S.statCard, textAlign: 'center', color: '#6b7280', gridColumn: '1 / -1', padding: 40 }}>
            No tanks yet. Create fuel grades first, then add tanks.
          </div>
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
