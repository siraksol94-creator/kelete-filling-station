import React, { useEffect, useMemo, useState } from 'react';
import { FiPlus, FiTrash2, FiX, FiDownloadCloud, FiAlertTriangle, FiCheckCircle } from 'react-icons/fi';
// UX-8 — Forecourt kit: delivery timeline, three-way check, "will it fit?".
import { PageHero, EmptyState, useDialog } from '../ux/ForecourtKit';
import { fmtK, fmtL, fmtSignedL, fmtDay, daysAgo, deliveryCheck, fitCheck } from '../ux/forecourt';
import Tank3D from '../ux/Tank3D';
import TankerArt from '../ux/TankerArt';
import { getFuelDeliveries, createFuelDelivery, deleteFuelDelivery, getTanks } from '../services/fuelApi';
import { getSuppliers } from '../services/api';
import { S } from './fuelStyles';
import { businessToday } from '../utils/businessDate';

const emptyForm = {
  supplier_id: '', tank_id: '', delivery_date: businessToday(),
  litres_ordered: '', litres_delivered: '', dip_before: '', dip_after: '',
  cost_per_litre: '', invoice_number: '', notes: ''
};

export default function FuelDeliveries() {
  const [rows, setRows] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');
  const [dialog, ui] = useDialog();
  const today = businessToday();

  const load = async () => {
    try {
      const [d, t, s] = await Promise.all([getFuelDeliveries(), getTanks(), getSuppliers()]);
      setRows(d.data || []); setTanks(t.data || []); setSuppliers(s.data || []);
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault(); setErr('');
    try {
      await createFuelDelivery({
        ...form,
        supplier_id: form.supplier_id || null,
      });
      setForm(null); await load();
    } catch (ex) { setErr(ex.response?.data?.error || 'Save failed'); }
  };

  const remove = async (r) => {
    if (!(await ui.confirm({ title: 'Delete delivery', text: `Delete delivery ${r.delivery_number}? Tank volume will be reversed.`, okLabel: 'Delete', danger: true }))) return;
    try { await deleteFuelDelivery(r.id); await load(); }
    catch (ex) { await ui.alert({ title: 'Delete failed', text: ex.response?.data?.error || 'Delete failed' }); }
  };

  const total = form ? (Number(form.litres_delivered || 0) * Number(form.cost_per_litre || 0)) : 0;
  const month = today.slice(0, 7);
  const monthRows = useMemo(() => rows.filter((r) => String(r.delivery_date || '').startsWith(month)), [rows, month]);
  const monthLitres = monthRows.reduce((a, r) => a + Number(r.litres_delivered || 0), 0);
  const monthCost = monthRows.reduce((a, r) => a + Number(r.total_cost || 0), 0);
  const checked = monthRows.map(deliveryCheck).filter((c) => c.band);
  const formTank = form ? tanks.find((t) => String(t.id) === String(form.tank_id)) : null;
  const fit = formTank ? fitCheck(formTank.capacity_litres, formTank.current_volume, form.litres_delivered) : null;
  const formCheck = form ? deliveryCheck(form) : null;

  return (
    <div style={S.page} className="k-page">
      <PageHero icon={<FiDownloadCloud />} title="Fuel Deliveries" date={today}
        subtitle="Tanker deliveries into the tanks — checked against the order and the dips"
        actions={<button type="button" onClick={() => { setErr(''); setForm({ ...emptyForm, delivery_date: businessToday() }); }} className="k-fc-btn-hero"><FiPlus /> Record Delivery</button>} />

      {rows.length > 0 && (
        <div className="k-dl-summary" aria-label="This month">
          <div><span>This month</span><strong className="k-fc-num">{monthRows.length}</strong><em>deliver{monthRows.length === 1 ? 'y' : 'ies'}</em></div>
          <div><span>Litres in</span><strong className="k-fc-num">{fmtL(monthLitres)}</strong></div>
          <div><span>Cost</span><strong className="k-fc-num">{fmtK(monthCost)}</strong></div>
          <div><span>Checked against dips</span><strong className="k-fc-num">{checked.length} of {monthRows.length}</strong>
            <em>{checked.filter((c) => c.band.level !== 'ok').length} outside 0.5%</em></div>
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ ...S.card, padding: 0 }}>
          <EmptyState art={<TankerArt width={150} moving />} title="No deliveries yet"
            text="When a tanker offloads, record it here with the dip before and after — the screen checks the litres against the order and the dips."
            action={<button type="button" onClick={() => setForm({ ...emptyForm, delivery_date: businessToday() })} style={S.btnPrimary}><FiPlus /> Record Delivery</button>} />
        </div>
      ) : (
        <ol className="k-dl-list">
          {rows.map((r) => {
            const c = deliveryCheck(r);
            const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(r.delivery_date || '')) || [];
            const mon = d[2] ? new Date(Date.UTC(+d[1], +d[2] - 1, 1)).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) : '';
            return (
              <li key={r.id} className="k-dl-item">
                <div className="k-dl-when" aria-hidden="true"><b>{d[3] ? +d[3] : '—'}</b><span>{mon}</span></div>
                <article className="k-dl-card" aria-label={`Delivery ${r.delivery_number}, ${fmtDay(r.delivery_date)}, ${fmtL(r.litres_delivered)} into ${r.tank_code}`}>
                  <header className="k-dl-head">
                    <div>
                      <div className="k-dl-num">{r.delivery_number}<span> · {fmtDay(r.delivery_date)} · {daysAgo(r.delivery_date, today)}</span></div>
                      <div className="k-dl-meta">
                        <span className="k-dl-tank"><i style={{ background: r.grade_color || '#64748b' }} aria-hidden="true" />{r.tank_code} · {r.grade_name || '—'}</span>
                        <span>{r.supplier_name || 'No supplier'}</span>
                        {r.invoice_number && <span>Invoice {r.invoice_number}</span>}
                      </div>
                    </div>
                    <button type="button" onClick={() => remove(r)} style={S.iconBtnDanger} aria-label={`Delete delivery ${r.delivery_number}`} title="Delete"><FiTrash2 /></button>
                  </header>
                  <div className="k-dl-body">
                    <div className="k-dl-main">
                      <TankerArt width={86} color={r.grade_color || '#0e7490'} />
                      <div>
                        <div className="k-dl-litres k-fc-num">{fmtL(r.litres_delivered)}</div>
                        <div className="k-dl-cost k-fc-num">K {Number(r.cost_per_litre || 0).toLocaleString('en-ZM', { minimumFractionDigits: 4, maximumFractionDigits: 4 })} /L · <b>{fmtK(r.total_cost)}</b></div>
                      </div>
                    </div>
                    <dl className="k-dl-check">
                      <div><dt>Ordered</dt><dd className="k-fc-num">{c.ordered == null ? '—' : fmtL(c.ordered)}</dd>
                        {c.vsOrdered != null && c.vsOrdered !== 0 && <span className="k-dl-diff">{fmtSignedL(c.vsOrdered)} vs order</span>}</div>
                      <div><dt>Invoice</dt><dd className="k-fc-num">{fmtL(c.delivered)}</dd><span className="k-dl-diff">delivered</span></div>
                      <div><dt>Dips show</dt><dd className="k-fc-num">{c.dipped == null ? '—' : fmtL(c.dipped)}</dd>
                        {c.vsDipped != null && <span className="k-dl-diff">{fmtSignedL(c.vsDipped)} vs invoice</span>}
                        {c.band ? <span className={`k-fc-band k-fc-band-${c.band.level}`}>{c.band.level === 'ok' ? <FiCheckCircle aria-hidden="true" /> : <FiAlertTriangle aria-hidden="true" />}{c.band.label}</span>
                          : <span className="k-dl-diff">no dip before/after</span>}
                      </div>
                    </dl>
                  </div>
                  {r.notes && <p className="k-dl-notes">{r.notes}</p>}
                </article>
              </li>
            );
          })}
        </ol>
      )}

      {form && (
        <div style={S.backdrop} className="k-modal-backdrop" onClick={() => setForm(null)}>
          <div style={{ ...S.modal, width: 'min(920px, 96vw)' }} className="k-modal" role="dialog" aria-modal="true" aria-label="New Fuel Delivery" onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}><h3 style={{ margin: 0 }}>New Fuel Delivery</h3><button onClick={() => setForm(null)} style={S.iconBtn} aria-label="Close"><FiX /></button></div>
            <form onSubmit={save}>
              {err && <div style={S.errBox}>{err}</div>}
              <div className="k-dl-form">
              <div style={S.formGrid} className="k-form-grid">
                <label style={S.lbl}>Date *<input type="date" value={form.delivery_date} onChange={e => setForm({ ...form, delivery_date: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Supplier
                  <select value={form.supplier_id} onChange={e => setForm({ ...form, supplier_id: e.target.value })} style={S.input}>
                    <option value="">-- none --</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label style={S.lbl}>Tank *
                  <select value={form.tank_id} onChange={e => setForm({ ...form, tank_id: e.target.value })} required style={S.input}>
                    <option value="">-- select --</option>
                    {tanks.map(t => <option key={t.id} value={t.id}>{t.code} - {t.grade_name}</option>)}
                  </select>
                </label>
                <label style={S.lbl}>Invoice #<input value={form.invoice_number} onChange={e => setForm({ ...form, invoice_number: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Litres Ordered<input type="number" step="0.01" value={form.litres_ordered} onChange={e => setForm({ ...form, litres_ordered: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Litres Delivered *<input type="number" step="0.01" value={form.litres_delivered} onChange={e => setForm({ ...form, litres_delivered: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Dip Before (L)<input type="number" step="0.01" value={form.dip_before} onChange={e => setForm({ ...form, dip_before: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Dip After (L)<input type="number" step="0.01" value={form.dip_after} onChange={e => setForm({ ...form, dip_after: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Cost / Litre *<input type="number" step="0.0001" value={form.cost_per_litre} onChange={e => setForm({ ...form, cost_per_litre: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Total<input value={fmtK(total)} readOnly style={{ ...S.input, background: '#f1f5f9', fontWeight: 800 }} /></label>
                <label style={{ ...S.lbl, gridColumn: '1 / -1' }}>Notes<input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={S.input} /></label>
              </div>
              <aside className="k-dl-preview" aria-live="polite">
                <h4>Will it fit?</h4>
                {!formTank ? <p className="k-muted">Pick the tank to see it fill.</p> : (
                  <>
                    <Tank3D width={120} showLabel={false} tank={{
                      code: formTank.code, grade: formTank.grade_name, color: formTank.grade_color || '#0e7490',
                      capacity: Number(formTank.capacity_litres) || 0, volume: Math.min(fit.after, Number(formTank.capacity_litres) || fit.after),
                      low_level: formTank.low_stock_litres == null ? null : Number(formTank.low_stock_litres),
                    }} />
                    <dl className="k-dl-fit">
                      <div><dt>In the tank now</dt><dd className="k-fc-num">{fmtL(formTank.current_volume)}</dd></div>
                      <div><dt>Space left</dt><dd className="k-fc-num">{fmtL(fit.space)}</dd></div>
                      <div><dt>After this delivery</dt><dd className="k-fc-num">{fmtL(fit.after)} <span>of {fmtL(formTank.capacity_litres)}</span></dd></div>
                    </dl>
                    {fit.fits
                      ? (Number(form.litres_delivered) > 0 && <div className="k-dl-ok"><FiCheckCircle aria-hidden="true" /> Fits, with {fmtL(fit.space - Number(form.litres_delivered || 0))} to spare</div>)
                      : <div className="k-dl-over" role="alert"><FiAlertTriangle aria-hidden="true" /> Won't fit: {fmtL(fit.over)} more than the space left. Check the litres and the tank.</div>}
                  </>
                )}
                {formCheck && formCheck.dipped != null && Number(form.litres_delivered) > 0 && (
                  <div className="k-dl-live">
                    Dips show <b className="k-fc-num">{fmtL(formCheck.dipped)}</b> went in — <b className="k-fc-num">{fmtSignedL(formCheck.vsDipped)}</b> vs the invoice
                    {formCheck.band && <span className={`k-fc-band k-fc-band-${formCheck.band.level}`}>{formCheck.band.label}</span>}
                  </div>
                )}
              </aside>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setForm(null)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" style={S.btnPrimary}>Save Delivery</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {dialog}
    </div>
  );
}
