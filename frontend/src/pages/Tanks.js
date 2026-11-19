import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiDatabase, FiAlertTriangle, FiActivity, FiBook } from 'react-icons/fi';
import { getTanks, createTank, updateTank, deleteTank, getFuelGrades, getTankInsights } from '../services/fuelApi';
// UX-7 — the Forecourt kit and the animated tanks from the Dashboard.
import { PageHero, EmptyState, useDialog } from '../ux/ForecourtKit';
import TankRow from '../ux/TankRow';
import { fmtL, fmtSignedL, fmtDay, daysAgo, dipBand } from '../ux/forecourt';
import { businessToday } from '../utils/businessDate';
import { S } from './fuelStyles';
import { useAuth } from '../context/AuthContext';
import TankDips from './TankDips';
import TankLedger from './TankLedger';

// UX-7 — tanks are drawn with ux/Tank3D (glass, moving fuel, days left) and
// plumbed groups are joined by ux/TankRow's flowing pipe; the old flat
// drawing that lived here is no longer used.

const emptyForm = { code: '', name: '', fuel_grade_id: '', capacity_litres: '', current_volume: 0, low_stock_litres: 1000, vessel_count: 1, group_code: '', status: 'Active' };

// Collapse tanks sharing a group_code into a single visual card. Tanks
// with no group_code render alone; tanks with the same group_code show
// as one plumbed-together card (sum capacity + sum volume + member list).
function groupTanks(rows) {
  const standalone = [];
  const byGroup = {};
  for (const t of rows) {
    const g = (t.group_code || '').trim();
    if (!g) standalone.push({ key: `t${t.id}`, members: [t] });
    else {
      if (!byGroup[g]) byGroup[g] = { key: `g${g}`, members: [] };
      byGroup[g].members.push(t);
    }
  }
  // Groups first (alphabetical by code), then standalone (by tank code)
  const groups = Object.values(byGroup).sort((a, b) => (a.members[0].group_code || '').localeCompare(b.members[0].group_code || ''));
  for (const g of groups) g.members.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
  standalone.sort((a, b) => (a.members[0].code || '').localeCompare(b.members[0].code || ''));
  return [...groups, ...standalone];
}

export default function Tanks() {
  const location = useLocation();
  const navigate = useNavigate();
  // /fuel/tank-dips → Dips tab, /fuel/tank-ledger → Ledger tab, else Tanks.
  // Fuel Station access (decision 2026-11-18): tank set-up is for
  // Administrators only; everyone else gets Dips and the Ledger (as before).
  const { user } = useAuth();
  const canManage = user?.role === 'Administrator';
  const tabFromPath = p => p.includes('tank-dips') ? 'dips' : (p.includes('tank-ledger') ? 'ledger' : (canManage ? 'tanks' : 'dips'));
  const [tab, setTab] = useState(tabFromPath(location.pathname));
  useEffect(() => {
    const want = tabFromPath(location.pathname);
    if (want !== tab) setTab(want);
  }, [location.pathname, tab]);

  const switchTab = (t) => {
    setTab(t);
    const path = t === 'dips' ? '/fuel/tank-dips' : (t === 'ledger' ? '/fuel/tank-ledger' : '/fuel/tanks');
    navigate(path, { replace: true });
  };

  const [rows, setRows] = useState([]);
  const [grades, setGrades] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const [insights, setInsights] = useState({});   // UX-7: per tank id
  const [dialog, ui] = useDialog();
  const load = async () => {
    try {
      const [t, g] = await Promise.all([getTanks({ include_inactive: showInactive ? 1 : 0 }), getFuelGrades()]);
      setRows(t.data || []); setGrades(g.data || []);
    } catch (e) {}
    // Space left, last dip / delivery: extra facts, never required.
    getTankInsights().then((r) => setInsights((r.data && r.data.tanks) || {})).catch(() => {});
  };
  useEffect(() => { load(); }, [showInactive]); // load reads showInactive from closure

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
    if (!(await ui.confirm({ title: 'Delete tank', text: `Delete tank "${r.name}"?`, okLabel: 'Delete', danger: true }))) return;
    try { await deleteTank(r.id); await load(); }
    catch (ex) { await ui.alert({ title: 'Delete failed', text: ex.response?.data?.error || 'Delete failed' }); }
  };


  const tabBtn = (id, label, icon) => (
    <button type="button" role="tab" aria-selected={tab === id} className="k-fc-tab" onClick={() => switchTab(id)}>{icon} {label}</button>
  );
  const subtitle = tab === 'dips' ? 'One dip per tank or plumbed group, every shift'
    : tab === 'ledger' ? 'Every litre in and out, with the running balance'
    : 'Levels, space left and the last dip for every tank';

  return (
    <div style={S.page} className="k-page">
      <PageHero icon={<FiDatabase />} title="Tanks" subtitle={subtitle} date={businessToday()}
        actions={tab === 'tanks' && canManage ? (
          <>
            <label className="k-fc-check"><input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} /> Show inactive</label>
            <button type="button" onClick={openNew} className="k-fc-btn-hero"><FiPlus /> New Tank</button>
          </>
        ) : null} />

      <div className="k-fc-tabs" role="tablist" aria-label="Tanks views">
        {canManage && tabBtn('tanks',  'Tanks',       <FiDatabase size={15} />)}
        {tabBtn('dips',   'Tank Dips',   <FiActivity size={15} />)}
        {tabBtn('ledger', 'Tank Ledger', <FiBook size={15} />)}
      </div>

      {tab === 'dips' ? <TankDips embedded /> : tab === 'ledger' ? <TankLedger embedded /> : (
      <>
      {rows.length > 0 && <TankSummary rows={rows} />}
      <div className="k-tk-grid">
        {groupTanks(rows).map(group => (
          <TankCard key={group.key} members={group.members} insights={insights} canManage={canManage}
            onEdit={openEdit} onDelete={remove} />
        ))}
        {rows.length === 0 && (
          <div className="k-tk-empty">
            <EmptyState art={<EmptyTankArt />} title="No tanks yet"
              text="Add the fuel grades first (Petrol, Diesel, Paraffin), then add each tank with its capacity and opening litres."
              action={canManage ? <button type="button" onClick={openNew} style={S.btnPrimary}><FiPlus /> New Tank</button> : null} />
          </div>
        )}
      </div>
      </>
      )}

      {tab === 'tanks' && showForm && (
        <div style={S.backdrop} className="k-modal-backdrop" onClick={() => setShowForm(false)}>
          <div style={S.modal} className="k-modal" onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>{editingId ? 'Edit' : 'New'} Tank</h3>
              <button onClick={() => setShowForm(false)} style={S.iconBtn}><FiX /></button>
            </div>
            <form onSubmit={save}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid} className="k-form-grid">
                <label style={S.lbl}>Code *<input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} required style={S.input} placeholder="T1" /></label>
                <label style={S.lbl}>Name *<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Fuel Grade *
                  <select value={form.fuel_grade_id} onChange={e => setForm({ ...form, fuel_grade_id: e.target.value })} required style={S.input}>
                    <option value="">-- select --</option>
                    {grades.map(g => <option key={g.id} value={g.id}>{g.code} - {g.name}</option>)}
                  </select>
                </label>
                <label style={S.lbl}>Capacity (L) *<input type="number" value={form.capacity_litres} onChange={e => setForm({ ...form, capacity_litres: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Opening Balance (L)
                  <input type="number" step="0.01"
                    value={editingId ? (form.opening_litres ?? '') : (form.current_volume ?? '')}
                    onChange={e => setForm(editingId ? { ...form, opening_litres: e.target.value } : { ...form, current_volume: e.target.value })}
                    style={S.input} />
                  <small style={{ color: '#6b7280', fontSize: 11 }}>
                    {editingId
                      ? 'Edits the tank\'s opening ledger row and re-syncs current volume. Deliveries/sales/dips on top stay intact.'
                      : 'Posted as the first \'opening\' ledger row.'}
                  </small>
                </label>
                <label style={S.lbl}>Low Stock Alert (L)<input type="number" value={form.low_stock_litres} onChange={e => setForm({ ...form, low_stock_litres: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Group Code
                  <input value={form.group_code || ''} onChange={e => setForm({ ...form, group_code: e.target.value.toUpperCase() })} style={S.input} placeholder="e.g. A — leave blank if standalone" />
                  <small style={{ color: '#6b7280', fontSize: 11 }}>Tanks sharing the same code are shown as one plumbed card. T1+T4=A, T2+T3=B, etc.</small>
                </label>
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

      {dialog}
    </div>
  );
}

// ── UX-7 · tank cards ───────────────────────────────────────────────────
// One card per tank, or per plumbed group (joined by the flowing pipe).
// The drawing comes from the Dashboard's Tank3D; the tiles underneath say
// how much space is left, when it was last dipped (variance in full, with
// its ±0.5% / ±1% band) and when fuel last came in.
const asTank3D = (t) => ({
  id: t.id, code: t.code, grade: t.grade_name, color: t.grade_color || '#64748b',
  capacity: Number(t.capacity_litres) || 0, volume: Number(t.current_volume) || 0,
  low_level: t.low_stock_litres == null ? null : Number(t.low_stock_litres),
  group_code: t.group_code || null,
});

function TankCard({ members, insights, canManage, onEdit, onDelete }) {
  const today = businessToday();
  const first = members[0];
  const isGroup = members.length > 1;
  const info = members.map((m) => insights[m.id] || {});
  const cap = members.reduce((s, t) => s + (Number(t.capacity_litres) || 0), 0);
  const vol = members.reduce((s, t) => s + (Number(t.current_volume) || 0), 0);
  const lowAt = members.reduce((s, t) => s + (Number(t.low_stock_litres) || 0), 0);
  const low = lowAt > 0 && vol <= lowAt;
  const pct = cap > 0 ? Math.round((vol / cap) * 100) : 0;
  const space = Math.max(0, cap - vol);
  const inactive = members.some((m) => m.status !== 'Active');
  const cover = info.map((x) => x.days_cover).find((d) => d != null);
  const dips = info.map((x) => x.last_dip).filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const lastDipDate = dips[0] && dips[0].date;
  const dipSame = dips.filter((d) => d.date === lastDipDate);
  const dip = dipSame.length ? {
    date: lastDipDate,
    variance: dipSame.reduce((s, d) => s + d.variance, 0),
    book: dipSame.reduce((s, d) => s + d.book, 0),
    posted: dipSame.every((d) => d.posted),
  } : null;
  const band = dip ? dipBand(dip.variance, dip.book) : null;
  const delivery = info.map((x) => x.last_delivery).filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const tanks3d = members.map((m) => ({ ...asTank3D(m), days_cover: (insights[m.id] || {}).days_cover ?? null }));
  const title = isGroup ? members.map((m) => m.code).join(' + ') : first.code;

  return (
    <section className={`k-tk-card${inactive ? ' is-inactive' : ''}${low ? ' is-low' : ''}`} aria-label={`${title}, ${first.grade_name || 'fuel'}: ${fmtL(vol)} of ${fmtL(cap)}`}>
      <header className="k-tk-head">
        <div className="k-tk-titles">
          <h3>{title}</h3>
          <div className="k-tk-sub">
            <span style={S.pill(first.grade_color || '#64748b')}>{first.grade_name || '—'}</span>
            <span>{isGroup ? `${members.length} tanks plumbed together · group ${first.group_code}` : first.name}</span>
            {inactive && <span className="k-tk-tag">Inactive</span>}
          </div>
        </div>
        {canManage && (
          <div className="k-tk-tools">
            {members.map((m) => (
              <button key={m.id} type="button" onClick={() => onEdit(m)} style={S.iconBtn} aria-label={`Edit ${m.code}`} title={`Edit ${m.code}`}><FiEdit2 /></button>
            ))}
            {!isGroup && <button type="button" onClick={() => onDelete(first)} style={S.iconBtnDanger} aria-label={`Delete ${first.code}`} title="Delete"><FiTrash2 /></button>}
          </div>
        )}
      </header>

      <div className="k-tk-stage">
        <TankRow tanks={tanks3d} width={isGroup ? 104 : 124} mini />
      </div>

      <div className="k-tk-level">
        <div><strong className="k-fc-num">{fmtL(vol)}</strong> <span>of {fmtL(cap)} · {pct}% full</span></div>
        {cover != null && <span className={`k-tk-cover${cover < 2 ? ' is-short' : cover < 4 ? ' is-watch' : ''}`}>≈ {cover < 10 ? cover.toFixed(1) : Math.round(cover)} days left</span>}
      </div>
      {isGroup && (
        <div className="k-tk-members">
          {members.map((m) => <span key={m.id}><b>{m.code}</b> {fmtL(m.current_volume)} of {fmtL(m.capacity_litres)}</span>)}
        </div>
      )}

      <dl className="k-tk-tiles">
        <div>
          <dt>Space left</dt>
          <dd className="k-fc-num">{fmtL(space)}</dd>
          <span className="k-tk-hint">room for a delivery</span>
        </div>
        <div>
          <dt>Last dip</dt>
          {dip ? (
            <>
              <dd className="k-fc-num">{fmtSignedL(dip.variance)}</dd>
              <span className="k-tk-hint">{fmtDay(dip.date)} · {daysAgo(dip.date, today)}</span>
              {band && <span className={`k-fc-band k-fc-band-${band.level}`}>{band.label}</span>}
            </>
          ) : <><dd>—</dd><span className="k-tk-hint">not dipped yet</span></>}
        </div>
        <div>
          <dt>Last delivery</dt>
          {delivery ? (
            <>
              <dd className="k-fc-num">{fmtL(delivery.litres)}</dd>
              <span className="k-tk-hint">{fmtDay(delivery.date)} · {daysAgo(delivery.date, today)}</span>
            </>
          ) : <><dd>—</dd><span className="k-tk-hint">none recorded</span></>}
        </div>
      </dl>

      {low && (
        <div className="k-tk-alert" role="status"><FiAlertTriangle aria-hidden="true" /> Low: {fmtL(vol)} left — the alert level is {fmtL(lowAt)}</div>
      )}
    </section>
  );
}

// Totals across the tanks shown: litres held, by grade, and how many are low.
function TankSummary({ rows }) {
  const byGrade = new Map();
  let low = 0;
  for (const t of rows) {
    if (t.status !== 'Active') continue;
    const k = t.grade_name || '—';
    const g = byGrade.get(k) || { name: k, color: t.grade_color || '#64748b', vol: 0, cap: 0 };
    g.vol += Number(t.current_volume) || 0; g.cap += Number(t.capacity_litres) || 0;
    byGrade.set(k, g);
    if (t.low_stock_litres != null && Number(t.current_volume) <= Number(t.low_stock_litres) && !(t.group_code || '').trim()) low += 1;
  }
  const grades = [...byGrade.values()].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="k-tk-summary" aria-label="Fuel in the tanks by grade">
      {grades.map((g) => (
        <div key={g.name} className="k-tk-sum">
          <span className="k-tk-sum-dot" style={{ background: g.color }} aria-hidden="true" />
          <div>
            <div className="k-tk-sum-name">{g.name}</div>
            <div className="k-fc-num"><strong>{fmtL(g.vol)}</strong> <span>of {fmtL(g.cap)}</span></div>
            <div className="k-tk-sum-bar" aria-hidden="true"><div style={{ width: `${g.cap > 0 ? Math.min(100, (g.vol / g.cap) * 100) : 0}%`, background: g.color }} /></div>
          </div>
        </div>
      ))}
      {low > 0 && <div className="k-tk-sum k-tk-sum-low"><FiAlertTriangle aria-hidden="true" /> {low} tank{low === 1 ? '' : 's'} below the alert level</div>}
    </div>
  );
}

function EmptyTankArt() {
  return (
    <svg width="120" height="96" viewBox="0 0 120 96" aria-hidden="true">
      <ellipse cx="60" cy="88" rx="44" ry="5" fill="#0f172a" opacity=".08" />
      <rect x="30" y="14" width="60" height="70" rx="12" fill="#f8fafc" stroke="#94a3b8" strokeWidth="2" />
      <ellipse cx="60" cy="16" rx="30" ry="6" fill="#e2e8f0" stroke="#94a3b8" strokeWidth="2" />
      <rect x="54" y="4" width="12" height="7" rx="2" fill="#64748b" />
      <path d="M36 70 q6 -4 12 0 t12 0 t12 0 t12 0 v8 h-48 z" fill="#fbbf24" opacity=".7" />
      <path d="M60 34 v18 M51 43 h18" stroke="#b45309" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
