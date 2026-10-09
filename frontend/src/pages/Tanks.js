import React, { useEffect, useMemo, useState } from 'react';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiDatabase, FiActivity, FiAlertTriangle, FiLink, FiLink2 } from 'react-icons/fi';
import {
  getTanks, createTank, updateTank, deleteTank, dipTank, getFuelGrades,
  getTankGroups, createTankGroup, updateTankGroup, deleteTankGroup, assignTanksToGroup, unassignTanks,
} from '../services/fuelApi';
import { S } from './fuelStyles';

// Vertical tank drawn as SVG. Fuel fills from the bottom.
function TankSvg({ pct, color, low, width = 70, height = 130 }) {
  const padTop = 10, padBottom = 8;
  const innerH = height - padTop - padBottom;
  const fillH = Math.max(0, (pct / 100) * innerH);
  const fillY = height - padBottom - fillH;
  const gradId = `g-${color.replace('#', '')}-${width}`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ flexShrink: 0 }}>
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.95" />
          <stop offset="100%" stopColor={color} stopOpacity="0.65" />
        </linearGradient>
      </defs>
      <rect x="4" y={padTop} width={width - 8} height={innerH} rx="8" fill="#f9fafb" stroke="#d1d5db" strokeWidth="1.5" />
      {fillH > 1 && (
        <rect x="5" y={fillY} width={width - 10} height={fillH - 1} rx="6" fill={`url(#${gradId})`} />
      )}
      <rect x={width * 0.26} y={padTop - 6} width={width * 0.48} height="6" rx="2" fill="#9ca3af" />
      {[25, 50, 75].map(p => {
        const ty = height - padBottom - (p / 100) * innerH;
        return <line key={p} x1={width - 10} x2={width - 4} y1={ty} y2={ty} stroke="#9ca3af" strokeWidth="1" />;
      })}
      <text x={width / 2} y={height / 2 + 4} textAnchor="middle" fontSize={width > 90 ? 16 : 13} fontWeight="700" fill={pct > 55 ? '#fff' : color}>
        {pct.toFixed(0)}%
      </text>
      {low && <circle cx={width - 8} cy={padTop + 2} r="4" fill="#dc2626" stroke="#fff" strokeWidth="1.5" />}
    </svg>
  );
}

const emptyForm = { code: '', name: '', fuel_grade_id: '', tank_group_id: '', capacity_litres: '', current_volume: 0, low_stock_litres: 1000, status: 'Active' };
const emptyGroupForm = { name: '', fuel_grade_id: '' };

export default function Tanks() {
  const [tanks, setTanks] = useState([]);
  const [groups, setGroups] = useState([]);
  const [grades, setGrades] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [dipFor, setDipFor] = useState(null);
  const [dipVal, setDipVal] = useState('');
  const [showGroupMgr, setShowGroupMgr] = useState(false);

  const load = async () => {
    try {
      const [t, g, gr] = await Promise.all([getTanks(), getFuelGrades(), getTankGroups()]);
      setTanks(t.data || []); setGrades(g.data || []); setGroups(gr.data || []);
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);

  const openNew = () => { setEditingId(null); setForm(emptyForm); setErr(''); setShowForm(true); };
  const openEdit = (r) => { setEditingId(r.id); setForm({ ...r, tank_group_id: r.tank_group_id || '' }); setErr(''); setShowForm(true); };

  const save = async (e) => {
    e.preventDefault(); setErr(''); setSaving(true);
    try {
      const payload = { ...form, tank_group_id: form.tank_group_id || null };
      if (editingId) await updateTank(editingId, payload);
      else await createTank(payload);
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

  // Split tanks: those in a group get grouped; the rest render as standalone cards.
  const ungrouped = useMemo(() => tanks.filter(t => !t.tank_group_id), [tanks]);

  // Compose group cards from groups + their member tanks (full tank data)
  const groupCards = useMemo(() => groups.map(g => {
    const members = tanks.filter(t => t.tank_group_id === g.id);
    const total_volume   = members.reduce((s, t) => s + (Number(t.current_volume)  || 0), 0);
    const total_capacity = members.reduce((s, t) => s + (Number(t.capacity_litres) || 0), 0);
    const total_low      = members.reduce((s, t) => s + (Number(t.low_stock_litres) || 0), 0);
    return { ...g, members, total_volume, total_capacity, total_low };
  }), [groups, tanks]);

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h2 style={S.h2}><FiDatabase /> Tanks</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowGroupMgr(true)} style={S.btnSecondary}><FiLink /> Manage Groups</button>
          <button onClick={openNew} style={S.btnPrimary}><FiPlus /> New Tank</button>
        </div>
      </div>

      {/* ── Tank Groups (combined cards) ────────────────────────────────── */}
      {groupCards.length > 0 && (
        <>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 }}>Connected Tank Groups</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 20, marginBottom: 24 }}>
            {groupCards.map(g => {
              const cap = g.total_capacity;
              const vol = g.total_volume;
              const pct = cap > 0 ? Math.min(100, Math.max(0, (vol / cap) * 100)) : 0;
              const low = vol <= (g.total_low || 0) && g.members.length > 0;
              const color = low ? '#dc2626' : (g.grade_color || '#2563eb');
              return (
                <div key={`g-${g.id}`} style={{ background: '#fff', border: `1.5px solid ${color}33`, borderRadius: 14, padding: 18, boxShadow: '0 2px 6px rgba(0,0,0,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 11, color: color, textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.5, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <FiLink2 size={12} /> GROUP
                      </div>
                      <div style={{ fontWeight: 700, fontSize: 17, color: '#111', marginTop: 2 }}>{g.name}</div>
                    </div>
                    <span style={S.pill(g.grade_color || '#6b7280')}>{g.grade_name || '-'}</span>
                  </div>

                  <div style={{ display: 'flex', gap: 16, marginTop: 8 }}>
                    <TankSvg pct={pct} color={color} low={low} width={90} height={150} />
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 600 }}>Combined Volume</div>
                      <div style={{ fontSize: 30, fontWeight: 800, color: color, lineHeight: 1.1, marginTop: 2 }}>
                        {vol.toLocaleString(undefined, { maximumFractionDigits: 0 })} <span style={{ fontSize: 14, color: '#9ca3af', fontWeight: 500 }}>L</span>
                      </div>
                      <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>
                        of <strong style={{ color: '#374151' }}>{cap.toLocaleString(undefined, { maximumFractionDigits: 0 })} L</strong> &nbsp;·&nbsp; <strong style={{ color }}>{pct.toFixed(0)}%</strong>
                      </div>
                    </div>
                  </div>

                  <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed #e5e7eb' }}>
                    <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, marginBottom: 6 }}>{g.members.length} connected tank{g.members.length === 1 ? '' : 's'}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {g.members.map(m => (
                        <span key={m.id} title={`${m.name}: ${Number(m.current_volume).toFixed(0)} / ${Number(m.capacity_litres).toFixed(0)} L`}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', background: '#f3f4f6', borderRadius: 6, fontSize: 12, fontWeight: 500 }}>
                          <strong>{m.code}</strong>
                          <span style={{ color: '#9ca3af' }}>·</span>
                          <span style={{ color: '#6b7280' }}>{Number(m.capacity_litres).toLocaleString(undefined, { maximumFractionDigits: 0 })} L</span>
                        </span>
                      ))}
                      {g.members.length === 0 && <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>no tanks yet — assign some via Manage Groups</span>}
                    </div>
                  </div>

                  {low && (
                    <div style={{ marginTop: 12, padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <FiAlertTriangle /> LOW STOCK — combined below {g.total_low} L
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Standalone / ungrouped tanks ─────────────────────────────────── */}
      {ungrouped.length > 0 && groupCards.length > 0 && (
        <div style={{ fontSize: 12, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 10 }}>Standalone Tanks</div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 20, marginBottom: 20 }}>
        {ungrouped.map(t => {
          const cap = Number(t.capacity_litres) || 0;
          const vol = Number(t.current_volume) || 0;
          const pct = cap > 0 ? Math.min(100, Math.max(0, (vol / cap) * 100)) : 0;
          const low = vol <= (t.low_stock_litres || 0);
          const color = low ? '#dc2626' : (t.grade_color || '#2563eb');
          return (
            <div key={t.id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 14, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
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
        {ungrouped.length === 0 && groupCards.length === 0 && (
          <div style={{ ...S.statCard, textAlign: 'center', color: '#6b7280', gridColumn: '1 / -1', padding: 40 }}>
            No tanks yet. Create fuel grades first, then add tanks.
          </div>
        )}
      </div>

      {/* ── New / Edit Tank modal ───────────────────────────────────────── */}
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
                  <select value={form.fuel_grade_id} onChange={e => setForm({ ...form, fuel_grade_id: e.target.value, tank_group_id: '' })} required style={S.input}>
                    <option value="">-- select --</option>
                    {grades.map(g => <option key={g.id} value={g.id}>{g.code} - {g.name}</option>)}
                  </select>
                </label>
                <label style={S.lbl}>Group (optional)
                  <select value={form.tank_group_id || ''} onChange={e => setForm({ ...form, tank_group_id: e.target.value })} style={S.input}>
                    <option value="">— Standalone —</option>
                    {groups.filter(g => !form.fuel_grade_id || Number(g.fuel_grade_id) === Number(form.fuel_grade_id)).map(g => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
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

      {/* ── Dip modal ───────────────────────────────────────────────────── */}
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

      {/* ── Group manager modal ─────────────────────────────────────────── */}
      {showGroupMgr && (
        <GroupManagerModal
          initialGroups={groups}
          initialTanks={tanks}
          grades={grades}
          onClose={() => { setShowGroupMgr(false); load(); }}
        />
      )}
    </div>
  );
}

function GroupManagerModal({ initialGroups, initialTanks, grades, onClose }) {
  const [groups, setGroupsState] = useState(initialGroups);
  const [tanks, setTanksState] = useState(initialTanks);
  const [gForm, setGForm] = useState({ name: '', fuel_grade_id: '' });
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');

  // Re-fetch groups + tanks IN-PLACE after each save/toggle so the modal
  // updates without closing. Earlier version used window.location.reload()
  // which dropped the user straight back to the tanks page.
  const reloadData = async () => {
    try {
      const [g, t] = await Promise.all([getTankGroups(), getTanks()]);
      setGroupsState(g.data || []);
      setTanksState(t.data || []);
    } catch (_) {}
  };

  const saveGroup = async (e) => {
    e.preventDefault(); setErr('');
    try {
      if (editing) await updateTankGroup(editing, gForm);
      else await createTankGroup(gForm);
      setGForm({ name: '', fuel_grade_id: '' }); setEditing(null);
      await reloadData();
    } catch (ex) { setErr(ex.response?.data?.error || 'Save failed'); }
  };

  const delGroup = async (g) => {
    if (!window.confirm(`Delete group "${g.name}"? Its tanks will become standalone.`)) return;
    try { await deleteTankGroup(g.id); await reloadData(); } catch (ex) { alert(ex.response?.data?.error || 'Delete failed'); }
  };

  const toggleTank = async (groupId, tank) => {
    try {
      if (tank.tank_group_id === groupId) await unassignTanks([tank.id]);
      else await assignTanksToGroup(groupId, [tank.id]);
      await reloadData();
    } catch (ex) { alert(ex.response?.data?.error || 'Failed'); }
  };

  return (
    <div style={S.backdrop} onClick={onClose}>
      <div style={{ ...S.modal, width: 'min(720px, 96vw)' }} onClick={e => e.stopPropagation()}>
        <div style={S.modalHeader}>
          <h3 style={{ margin: 0 }}><FiLink /> Manage Tank Groups</h3>
          <button onClick={onClose} style={S.iconBtn}><FiX /></button>
        </div>
        <div style={{ padding: 20 }}>
          {err && <div style={{ ...S.errBox, marginTop: 0, marginBottom: 14 }}>{err}</div>}

          {/* Create / edit group */}
          <form onSubmit={saveGroup} style={{ display: 'flex', gap: 8, marginBottom: 20, alignItems: 'flex-end' }}>
            <label style={{ ...S.lbl, flex: 1 }}>Group Name
              <input value={gForm.name} onChange={e => setGForm({ ...gForm, name: e.target.value })} required style={S.input} placeholder="e.g. Petrol Group A" />
            </label>
            <label style={{ ...S.lbl, flex: 1 }}>Fuel Grade
              <select value={gForm.fuel_grade_id} onChange={e => setGForm({ ...gForm, fuel_grade_id: e.target.value })} required style={S.input}>
                <option value="">-- select --</option>
                {grades.map(g => <option key={g.id} value={g.id}>{g.code} - {g.name}</option>)}
              </select>
            </label>
            <button type="submit" style={S.btnPrimary}>{editing ? 'Update' : <><FiPlus /> Add Group</>}</button>
            {editing && <button type="button" onClick={() => { setEditing(null); setGForm({ name: '', fuel_grade_id: '' }); }} style={S.btnSecondary}>Cancel</button>}
          </form>

          {/* Existing groups */}
          {groups.length === 0 && <div style={{ textAlign: 'center', color: '#6b7280', padding: 20 }}>No groups yet. Create one above.</div>}
          {groups.map(g => {
            const members = tanks.filter(t => t.tank_group_id === g.id);
            const eligible = tanks.filter(t => Number(t.fuel_grade_id) === Number(g.fuel_grade_id));
            return (
              <div key={g.id} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <div>
                    <strong>{g.name}</strong> &nbsp;<span style={S.pill(g.grade_color || '#6b7280')}>{g.grade_name}</span>
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{members.length} tank(s) connected</div>
                  </div>
                  <div>
                    <button onClick={() => { setEditing(g.id); setGForm({ name: g.name, fuel_grade_id: g.fuel_grade_id }); }} style={S.iconBtn}><FiEdit2 /></button>
                    <button onClick={() => delGroup(g)} style={S.iconBtnDanger}><FiTrash2 /></button>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 6, fontWeight: 600 }}>Click to toggle membership (only {g.grade_name} tanks shown):</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {eligible.length === 0 && <span style={{ fontSize: 12, color: '#9ca3af', fontStyle: 'italic' }}>No {g.grade_name} tanks exist yet.</span>}
                  {eligible.map(t => {
                    const inThis = t.tank_group_id === g.id;
                    const inOther = t.tank_group_id && !inThis;
                    return (
                      <button key={t.id} type="button" disabled={inOther}
                        onClick={() => toggleTank(g.id, t)}
                        title={inOther ? 'Already in another group — remove it there first' : ''}
                        style={{
                          padding: '6px 12px', borderRadius: 6, fontSize: 13, cursor: inOther ? 'not-allowed' : 'pointer',
                          border: inThis ? '1.5px solid #16a34a' : '1px solid #d1d5db',
                          background: inThis ? '#dcfce7' : (inOther ? '#f3f4f6' : '#fff'),
                          color: inOther ? '#9ca3af' : '#111',
                          fontWeight: inThis ? 700 : 500,
                        }}>
                        {inThis && '✓ '}{t.code} — {t.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div style={S.modalFooter}>
          <button type="button" onClick={onClose} style={S.btnPrimary}>Done</button>
        </div>
      </div>
    </div>
  );
}
