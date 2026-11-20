import React, { useEffect, useState } from 'react';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiDroplet, FiCheck } from 'react-icons/fi';
// UX-9 — price board, margin per litre, named colours; the Forecourt kit look.
import { S } from './fuelStyles';
import { PageHero, EmptyState, useDialog } from '../ux/ForecourtKit';
import { fmtK, gradeMargin } from '../ux/forecourt';
import { businessToday } from '../utils/businessDate';
import { getFuelGrades, createFuelGrade, updateFuelGrade, deleteFuelGrade } from '../services/fuelApi';

const emptyForm = { code: '', name: '', unit: 'L', selling_price: 0, cost_price: 0, color: '#2563eb', status: 'Active' };
const DEFAULT_COLORS = ['#2563eb', '#dc2626', '#f59e0b', '#16a34a', '#8b5cf6', '#0f766e'];
// UX-9 — every colour has a name, for the picker and screen readers.
const COLOR_NAMES = { '#2563eb': 'Blue', '#dc2626': 'Red', '#f59e0b': 'Amber', '#16a34a': 'Green', '#8b5cf6': 'Purple', '#0f766e': 'Teal' };

export default function FuelGrades() {
  const [rows, setRows] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [dialog, ui] = useDialog();   // UX-9: in-app confirm / alert

  const load = async () => {
    try { const r = await getFuelGrades(); setRows(r.data || []); } catch (e) {}
  };
  useEffect(() => { load(); }, []);

  const openNew = () => { setEditingId(null); setForm(emptyForm); setErr(''); setShowForm(true); };
  const openEdit = (row) => { setEditingId(row.id); setForm({ ...row }); setErr(''); setShowForm(true); };

  const save = async (e) => {
    e.preventDefault(); setErr(''); setSaving(true);
    try {
      let synced = 0;
      if (editingId) {
        const r = await updateFuelGrade(editingId, form);
        synced = Number(r.data?.synced_open_shift_readings || 0);
      } else {
        await createFuelGrade(form);
      }
      setShowForm(false); await load();
      if (synced > 0) await ui.alert({ title: 'Price saved', text: `Price saved. ${synced} nozzle reading(s) on OPEN shifts were updated to the new price.` });
    } catch (ex) { setErr(ex.response?.data?.error || 'Save failed'); }
    finally { setSaving(false); }
  };

  const remove = async (row) => {
    if (!(await ui.confirm({ title: 'Delete fuel grade', text: `Delete fuel grade "${row.name}"?`, okLabel: 'Delete', danger: true }))) return;
    try { await deleteFuelGrade(row.id); await load(); }
    catch (ex) { await ui.alert({ title: 'Delete failed', text: ex.response?.data?.error || 'Delete failed' }); }
  };

  const active = rows.filter((r) => r.status === 'Active');
  return (
    <div style={S.page} className="k-page">
      <PageHero icon={<FiDroplet />} title="Fuel Grades" date={businessToday()}
        subtitle="Prices per litre, what each litre costs us, and the margin in between"
        actions={<button type="button" onClick={openNew} className="k-fc-btn-hero"><FiPlus /> New Grade</button>} />

      {rows.length === 0 ? (
        <div style={{ ...S.card, padding: 0 }}>
          <EmptyState art={<FiDroplet size={46} color="#b45309" />} title="No fuel grades yet"
            text="Add Petrol, Diesel and Paraffin with their selling price per litre. Tanks and nozzles are set up after the grades."
            action={<button type="button" onClick={openNew} style={S.btnPrimary}><FiPlus /> New Grade</button>} />
        </div>
      ) : (
        <div className="k-gr-layout">
          {/* The forecourt price board: what the customer sees on the sign. */}
          <section className="k-board" aria-label="Price board — selling price per litre">
            <div className="k-board-top"><span>Price per litre</span><span>Kwacha</span></div>
            {(active.length ? active : rows).map((r) => (
              <div key={r.id} className="k-board-row" style={{ '--k-g': r.color || '#64748b' }}>
                <span className="k-board-name"><i aria-hidden="true" />{r.name}<em>{r.code}</em></span>
                <span className="k-board-price" aria-label={`${r.name}: K ${Number(r.selling_price).toFixed(2)} per litre`}>
                  {Number(r.selling_price).toFixed(2).split('').map((ch, i) => <b key={i} className={ch === '.' ? 'is-dot' : ''}>{ch}</b>)}
                </span>
              </div>
            ))}
          </section>

          <div className="k-gr-grid">
            {rows.map((r) => {
              const m = gradeMargin(r.selling_price, r.cost_price);
              return (
                <article key={r.id} className={`k-gr-card${r.status !== 'Active' ? ' is-inactive' : ''}`} style={{ '--k-g': r.color || '#64748b' }} aria-label={`${r.name} grade`}>
                  <header className="k-gr-head">
                    <div>
                      <h3><i aria-hidden="true" />{r.name}</h3>
                      <div className="k-gr-sub">{r.code} · per {r.unit || 'L'} · <span className={r.status === 'Active' ? 'k-gr-on' : 'k-gr-off'}>{r.status}</span></div>
                    </div>
                    <div>
                      <button type="button" onClick={() => openEdit(r)} style={S.iconBtn} aria-label={`Edit ${r.name}`} title="Edit"><FiEdit2 /></button>
                      <button type="button" onClick={() => remove(r)} style={S.iconBtnDanger} aria-label={`Delete ${r.name}`} title="Delete"><FiTrash2 /></button>
                    </div>
                  </header>
                  <dl className="k-gr-figs">
                    <div><dt>Selling price</dt><dd className="k-fc-num">{fmtK(r.selling_price)}</dd></div>
                    <div><dt>Cost (WAC)</dt><dd className="k-fc-num">K {Number(r.cost_price || 0).toLocaleString('en-ZM', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</dd></div>
                    <div className={m.below ? 'is-below' : ''}>
                      <dt>Margin per litre</dt>
                      <dd className="k-fc-num">{m.unknownCost ? '—' : `K ${m.perL.toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`}</dd>
                      <span className="k-gr-note">{m.unknownCost ? 'no cost yet — set by the first delivery' : m.below ? 'selling below cost' : `${(m.pct * 100).toFixed(1)}% of the price`}</span>
                    </div>
                  </dl>
                  {!m.unknownCost && (
                    <div>
                      <div className="k-gr-bar" role="img" aria-label={`Of each kwacha: cost ${Math.round((1 - m.pct) * 100)}%, margin ${Math.round(m.pct * 100)}%`}>
                        <div className="k-gr-bar-cost" style={{ width: `${Math.min(100, Math.max(0, (1 - m.pct) * 100))}%` }} />
                        <div className="k-gr-bar-margin" style={{ width: `${Math.min(100, Math.max(0, m.pct * 100))}%` }} />
                      </div>
                      <div className="k-gr-bar-key" aria-hidden="true"><span><i className="is-cost" />cost {(Math.max(0, 1 - m.pct) * 100).toFixed(1)}%</span><span><i />margin {(m.pct * 100).toFixed(1)}%</span></div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      )}

      {showForm && (
        <div style={S.backdrop} className="k-modal-backdrop" onClick={() => setShowForm(false)}>
          <div style={S.modal} className="k-modal" role="dialog" aria-modal="true" aria-label={`${editingId ? 'Edit' : 'New'} Fuel Grade`} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>{editingId ? 'Edit' : 'New'} Fuel Grade</h3>
              <button onClick={() => setShowForm(false)} style={S.iconBtn} aria-label="Close"><FiX /></button>
            </div>
            <form onSubmit={save}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid} className="k-form-grid">
                <label style={S.lbl}>Code *<input value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} required style={S.input} placeholder="PMS / AGO / DPK" /></label>
                <label style={S.lbl}>Name *<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required style={S.input} placeholder="Petrol / Diesel / Paraffin" /></label>
                <label style={S.lbl}>Unit<input value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Selling Price (K / litre) *<input type="number" step="0.0001" value={form.selling_price} onChange={e => setForm({ ...form, selling_price: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Cost Price (K / litre, WAC)<input type="number" step="0.0001" value={form.cost_price} onChange={e => setForm({ ...form, cost_price: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Status
                  <select value={form.status} onChange={e => setForm({ ...form, status: e.target.value })} style={S.input}>
                    <option>Active</option><option>Inactive</option>
                  </select>
                </label>
                <fieldset className="k-gr-colors" style={{ gridColumn: '1 / -1' }}>
                  <legend>Colour <span>— used for this grade on tanks, pumps and reports</span></legend>
                  <div role="radiogroup" aria-label="Grade colour">
                    {DEFAULT_COLORS.map(c => (
                      <button key={c} type="button" role="radio" aria-checked={form.color === c} onClick={() => setForm({ ...form, color: c })}
                        className={`k-gr-swatch${form.color === c ? ' is-on' : ''}`} style={{ '--k-g': c }}>
                        <i aria-hidden="true">{form.color === c && <FiCheck />}</i>{COLOR_NAMES[c]}
                      </button>
                    ))}
                  </div>
                </fieldset>
                {(() => {
                  const m = gradeMargin(form.selling_price, form.cost_price);
                  return !m.unknownCost && Number(form.selling_price) > 0 ? (
                    <div className={`k-gr-live${m.below ? ' is-below' : ''}`} style={{ gridColumn: '1 / -1' }} aria-live="polite">
                      Margin per litre: <b className="k-fc-num">{m.perL < 0 ? '−' : ''}K{Math.abs(m.perL).toFixed(4)}</b> ({(m.pct * 100).toFixed(1)}% of the price){m.below ? ' — below cost' : ''}
                    </div>
                  ) : null;
                })()}
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
