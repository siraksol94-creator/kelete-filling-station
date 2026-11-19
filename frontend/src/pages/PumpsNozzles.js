import React, { useEffect, useState } from 'react';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiZap, FiUser } from 'react-icons/fi';
// UX-8 — the forecourt view: pump drawings, meter displays, who's on shift.
import { PageHero, EmptyState, useDialog } from '../ux/ForecourtKit';
import PumpArt, { MeterDigits } from '../ux/PumpArt';
import { fmtK } from '../ux/forecourt';
import { businessToday } from '../utils/businessDate';
import { getPumpsWithNozzles, createPump, updatePump, deletePump, createNozzle, updateNozzle, deleteNozzle, getTanks } from '../services/fuelApi';
import { S } from './fuelStyles';
import { useAuth } from '../context/AuthContext';

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
  // Fuel Station access (decisions 2026-11-18): pumps and nozzles are set up by
  // Administrators; Managers / Supervisors may only correct a nozzle's meter
  // reading. The server enforces the same (routes/pumps.js).
  const { user } = useAuth();
  const isAdmin = user?.role === 'Administrator';
  const [pumps, setPumps] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [pumpForm, setPumpForm] = useState(null);
  const [nozForm, setNozForm] = useState(null);
  const [err, setErr] = useState('');
  const [dialog, ui] = useDialog();   // UX-8: in-app confirm / alert

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
    if (!(await ui.confirm({ title: 'Delete pump', text: `Delete pump "${p.name}" and all its nozzles?`, okLabel: 'Delete', danger: true }))) return;
    try { await deletePump(p.id); await load(); } catch (ex) { await ui.alert({ title: 'Delete failed', text: ex.response?.data?.error || 'Delete failed' }); }
  };
  const removeNoz = async (n) => {
    if (!(await ui.confirm({ title: 'Delete nozzle', text: `Delete nozzle "${n.code}"?`, okLabel: 'Delete', danger: true }))) return;
    try { await deleteNozzle(n.id); await load(); } catch (ex) { await ui.alert({ title: 'Delete failed', text: ex.response?.data?.error || 'Delete failed' }); }
  };

  return (
    <div style={S.page} className="k-page">
      <PageHero icon={<FiZap />} title="Pumps & Nozzles" date={businessToday()}
        subtitle={isAdmin ? 'The forecourt: every pump, its nozzles, meters and tanks' : 'Meter corrections only — pumps and nozzles are set up by an Administrator'}
        actions={isAdmin ? <button type="button" onClick={() => setPumpForm({ code: '', name: '' })} className="k-fc-btn-hero"><FiPlus /> New Pump</button> : null} />

      {pumps.length === 0 && (
        <div style={{ ...S.card, padding: 0 }}>
          <EmptyState art={<PumpArt code="P1" width={90} />} title="No pumps yet"
            text="Create a pump, then add its nozzles and say which tank each one draws from."
            action={isAdmin ? <button type="button" onClick={() => setPumpForm({ code: '', name: '' })} style={S.btnPrimary}><FiPlus /> New Pump</button> : null} />
        </div>
      )}
      <div className="k-pumps">
        {pumps.map(p => {
          const crew = p.on_shift || [];
          return (
          <section key={p.id} className="k-pump-card" aria-label={`Pump ${p.code}`}>
            <div className="k-pump-art"><PumpArt code={p.code} nozzles={p.nozzles || []} width={136} live={crew.length > 0} /></div>
            <div className="k-pump-main">
              <header className="k-pump-head">
                <div>
                  <h3>{p.code} <span>{p.name}</span></h3>
                  <div className={`k-pump-crew${crew.length ? ' is-on' : ''}`}>
                    {crew.length
                      ? <><span className="k-pump-dot" aria-hidden="true" />On shift: {crew.map((c) => <span key={c.shift_id} className="k-pump-who"><FiUser aria-hidden="true" />{c.attendant_name || 'Attendant'}</span>)}</>
                      : 'No open shift on this pump'}
                  </div>
                </div>
                {isAdmin && (
                  <div className="k-pump-tools">
                    <button type="button" onClick={() => setNozForm({ pump_id: p.id, tank_id: '', code: '', current_meter_reading: 0 })} style={S.btnSecondary}><FiPlus /> Nozzle</button>
                    <button type="button" onClick={() => setPumpForm(p)} style={S.iconBtn} aria-label={`Edit pump ${p.code}`} title="Edit pump"><FiEdit2 /></button>
                    <button type="button" onClick={() => removePump(p)} style={S.iconBtnDanger} aria-label={`Delete pump ${p.code}`} title="Delete pump"><FiTrash2 /></button>
                  </div>
                )}
              </header>
              <ul className="k-noz-list">
                {(p.nozzles || []).map(n => (
                  <li key={n.id} className="k-noz" style={{ '--k-noz': n.grade_color || '#64748b' }}>
                    <span className="k-noz-code">{n.code}</span>
                    <div className="k-noz-info">
                      <div><span style={S.pill(n.grade_color || '#64748b')}>{n.grade_name || '-'}</span> <span className="k-noz-tank">from {tankLabelForNozzle(n, tanks)}</span></div>
                      <MeterDigits value={n.current_meter_reading} label={`Nozzle ${n.code} meter`} />
                    </div>
                    <div className="k-noz-price"><span>Price</span><b className="k-fc-num">{fmtK(n.price_per_litre || 0)}</b><span>per litre</span></div>
                    <div className="k-noz-tools">
                      <button type="button" onClick={() => setNozForm(n)} style={S.iconBtn} aria-label={isAdmin ? `Edit nozzle ${n.code}` : `Correct meter for nozzle ${n.code}`} title={isAdmin ? 'Edit nozzle' : 'Correct the meter'}><FiEdit2 /></button>
                      {isAdmin && <button type="button" onClick={() => removeNoz(n)} style={S.iconBtnDanger} aria-label={`Delete nozzle ${n.code}`} title="Delete nozzle"><FiTrash2 /></button>}
                    </div>
                  </li>
                ))}
                {(p.nozzles || []).length === 0 && <li className="k-noz-empty">No nozzles on this pump{isAdmin ? ' — add one with “+ Nozzle”.' : '.'}</li>}
              </ul>
            </div>
          </section>
          );
        })}
      </div>

      {pumpForm && (
        <div style={S.backdrop} className="k-modal-backdrop" onClick={() => setPumpForm(null)}>
          <div style={S.modal} className="k-modal" onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}><h3 style={{ margin: 0 }}>{pumpForm.id ? 'Edit' : 'New'} Pump</h3><button onClick={() => setPumpForm(null)} style={S.iconBtn}><FiX /></button></div>
            <form onSubmit={savePump}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid} className="k-form-grid">
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
        <div style={S.backdrop} className="k-modal-backdrop" onClick={() => setNozForm(null)}>
          <div style={S.modal} className="k-modal" onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}><h3 style={{ margin: 0 }}>{nozForm.id ? 'Edit' : 'New'} Nozzle</h3><button onClick={() => setNozForm(null)} style={S.iconBtn}><FiX /></button></div>
            <form onSubmit={saveNoz}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid} className="k-form-grid">
                <label style={S.lbl}>Nozzle Code *<input value={nozForm.code} onChange={e => setNozForm({ ...nozForm, code: e.target.value })} required disabled={!isAdmin} style={S.input} placeholder="N1" /></label>
                <label style={S.lbl}>Tank *
                  <select value={nozForm.tank_id} onChange={e => setNozForm({ ...nozForm, tank_id: e.target.value })} required disabled={!isAdmin} style={S.input}>
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
      {dialog}
    </div>
  );
}
