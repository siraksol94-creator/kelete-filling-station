import React, { useEffect, useState } from 'react';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiZap } from 'react-icons/fi';
import { getPumpsWithNozzles, createPump, updatePump, deletePump, createNozzle, updateNozzle, deleteNozzle, getTanks } from '../services/fuelApi';
import { S } from './fuelStyles';

// Tanks sharing a group_code are plumbed together. For the Tank picker
// we show one entry per group (labelled "T1 + T4 — PETROL (Group A)")
// and store the tank_id of the first member. Standalone tanks appear
// as individual entries.
function tankPickerOptions(tanks) {
  const groups = {};
  const singles = [];
  for (const t of tanks) {
    const g = (t.group_code || '').trim();
    if (!g) singles.push(t);
    else {
      if (!groups[g]) groups[g] = [];
      groups[g].push(t);
    }
  }
  const groupOpts = Object.entries(groups)
    .map(([code, members]) => {
      members.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
      const label = `${members.map(m => m.code).join(' + ')} — ${members[0].grade_name || '—'}  (Group ${code})`;
      return { value: members[0].id, label, _sort: code };
    })
    .sort((a, b) => a._sort.localeCompare(b._sort));
  const singleOpts = singles
    .sort((a, b) => (a.code || '').localeCompare(b.code || ''))
    .map(t => ({ value: t.id, label: `${t.code} — ${t.grade_name || '—'}` }));
  return [...groupOpts, ...singleOpts];
}

// For the nozzle table: if the nozzle's tank is in a group, show the
// group's combined label (T1 + T4) instead of the single tank code so
// the visual matches the Tanks page.
function tankLabelForNozzle(n, tanks) {
  const t = tanks.find(x => Number(x.id) === Number(n.tank_id));
  if (!t) return n.tank_code || '-';
  const g = (t.group_code || '').trim();
  if (!g) return t.code;
  const members = tanks.filter(x => (x.group_code || '').trim() === g)
    .sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  return members.map(m => m.code).join(' + ');
}

export default function PumpsNozzles() {
  const [pumps, setPumps] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [pumpForm, setPumpForm] = useState(null);
  const [nozForm, setNozForm] = useState(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const [p, t] = await Promise.all([getPumpsWithNozzles(), getTanks()]);
      setPumps(p.data || []); setTanks(t.data || []);
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);

  const savePump = async (e) => {
    e.preventDefault(); setErr('');
    try {
      if (pumpForm.id) await updatePump(pumpForm.id, pumpForm);
      else await createPump(pumpForm);
      setPumpForm(null); await load();
    } catch (ex) { setErr(ex.response?.data?.error || 'Save failed'); }
  };

  const saveNoz = async (e) => {
    e.preventDefault(); setErr('');
    try {
      if (nozForm.id) await updateNozzle(nozForm.id, nozForm);
      else await createNozzle(nozForm);
      setNozForm(null); await load();
    } catch (ex) { setErr(ex.response?.data?.error || 'Save failed'); }
  };

  const removePump = async (p) => {
    if (!window.confirm(`Delete pump "${p.name}" and all its nozzles?`)) return;
    try { await deletePump(p.id); await load(); } catch (ex) { alert(ex.response?.data?.error || 'Delete failed'); }
  };
  const removeNoz = async (n) => {
    if (!window.confirm(`Delete nozzle "${n.code}"?`)) return;
    try { await deleteNozzle(n.id); await load(); } catch (ex) { alert(ex.response?.data?.error || 'Delete failed'); }
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h2 style={S.h2}><FiZap /> Pumps & Nozzles</h2>
        <button onClick={() => setPumpForm({ code: '', name: '' })} style={S.btnPrimary}><FiPlus /> New Pump</button>
      </div>

      {pumps.length === 0 && (
        <div style={{ ...S.card, padding: 40, textAlign: 'center', color: '#6b7280' }}>No pumps yet. Create a pump, then add nozzles under it.</div>
      )}

      <div style={{ display: 'grid', gap: 16 }}>
        {pumps.map(p => (
          <div key={p.id} style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: 16, borderBottom: '1px solid #f3f4f6', background: '#f9fafb' }}>
              <div><strong style={{ fontSize: 16 }}>{p.code}</strong> &nbsp; <span style={{ color: '#374151' }}>{p.name}</span></div>
              <div>
                <button onClick={() => setNozForm({ pump_id: p.id, tank_id: '', code: '', current_meter_reading: 0 })} style={S.btnSecondary}><FiPlus /> Nozzle</button>
                &nbsp;<button onClick={() => setPumpForm(p)} style={S.iconBtn}><FiEdit2 /></button>
                <button onClick={() => removePump(p)} style={S.iconBtnDanger}><FiTrash2 /></button>
              </div>
            </div>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Nozzle</th><th style={S.th}>Tank</th><th style={S.th}>Grade</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Meter Reading</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Price/L</th>
                  <th style={S.th}></th>
                </tr>
              </thead>
              <tbody>
                {(p.nozzles || []).map(n => (
                  <tr key={n.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={S.td}><strong>{n.code}</strong></td>
                    <td style={S.td}>{tankLabelForNozzle(n, tanks)}</td>
                    <td style={S.td}><span style={S.pill(n.grade_color || '#6b7280')}>{n.grade_name || '-'}</span></td>
                    <td style={S.tdR}>{Number(n.current_meter_reading).toFixed(2)} L</td>
                    <td style={S.tdR}>K {Number(n.price_per_litre || 0).toFixed(2)}</td>
                    <td style={S.td}>
                      <button onClick={() => setNozForm(n)} style={S.iconBtn}><FiEdit2 /></button>
                      <button onClick={() => removeNoz(n)} style={S.iconBtnDanger}><FiTrash2 /></button>
                    </td>
                  </tr>
                ))}
                {(p.nozzles || []).length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>No nozzles on this pump</td></tr>
                )}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      {pumpForm && (
        <div style={S.backdrop} onClick={() => setPumpForm(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}><h3 style={{ margin: 0 }}>{pumpForm.id ? 'Edit' : 'New'} Pump</h3><button onClick={() => setPumpForm(null)} style={S.iconBtn}><FiX /></button></div>
            <form onSubmit={savePump}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid}>
                <label style={S.lbl}>Code *<input value={pumpForm.code} onChange={e => setPumpForm({ ...pumpForm, code: e.target.value })} required style={S.input} placeholder="P1" /></label>
                <label style={S.lbl}>Name *<input value={pumpForm.name} onChange={e => setPumpForm({ ...pumpForm, name: e.target.value })} required style={S.input} /></label>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setPumpForm(null)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" style={S.btnPrimary}>Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {nozForm && (
        <div style={S.backdrop} onClick={() => setNozForm(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}><h3 style={{ margin: 0 }}>{nozForm.id ? 'Edit' : 'New'} Nozzle</h3><button onClick={() => setNozForm(null)} style={S.iconBtn}><FiX /></button></div>
            <form onSubmit={saveNoz}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid}>
                <label style={S.lbl}>Nozzle Code *<input value={nozForm.code} onChange={e => setNozForm({ ...nozForm, code: e.target.value })} required style={S.input} placeholder="N1" /></label>
                <label style={S.lbl}>Tank *
                  <select value={nozForm.tank_id} onChange={e => setNozForm({ ...nozForm, tank_id: e.target.value })} required style={S.input}>
                    <option value="">-- select --</option>
                    {tankPickerOptions(tanks).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </label>
                <label style={S.lbl}>Meter Reading (L)<input type="number" step="0.01" value={nozForm.current_meter_reading} onChange={e => setNozForm({ ...nozForm, current_meter_reading: e.target.value })} style={S.input} /></label>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setNozForm(null)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" style={S.btnPrimary}>Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
