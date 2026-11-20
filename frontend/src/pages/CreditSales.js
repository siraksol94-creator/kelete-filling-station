import React, { useEffect, useMemo, useState } from 'react';
import { FiPlus, FiTrash2, FiX, FiCreditCard, FiFilter, FiPrinter, FiCheckCircle, FiAlertTriangle } from 'react-icons/fi';
import { getAllTickets, addShiftCreditSale, deleteShiftCreditSale, getShifts, getNozzles } from '../services/fuelApi';
import { getCustomers, getSettings } from '../services/api';
import { S } from './fuelStyles';
import { printTicket, printTicketList } from './ticketPrint';
import keleteLogo from '../assets/kelete-logo.png';
import { businessToday } from '../utils/businessDate';
// UX-9 — Forecourt kit: summary, live calculator, credit limit, in-app dialogs.
import { PageHero, EmptyState, useDialog } from '../ux/ForecourtKit';
import { fmtK, fmtL, fmtDay, creditUse, ticketSummary } from '../ux/forecourt';

const today = () => businessToday(); // station's day, not the UTC date

export default function CreditSales() {
  return <TicketsPage method="Credit" />;
}

// Shared implementation used by both Credit Sales and 1Card Sales pages.
export function TicketsPage({ method }) {
  const isCard = method === '1Card';
  const [rows, setRows] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [nozzles, setNozzles] = useState([]);
  const [openShifts, setOpenShifts] = useState([]);
  const [seller, setSeller] = useState({});
  const logoUrl = useMemo(() => new URL(keleteLogo, window.location.origin).href, []);
  const [filter, setFilter] = useState({ from: today(), to: today(), customer_id: '', attendant_user_id: '' });
  const [showForm, setShowForm] = useState(false);
  const emptyForm = { shift_id: '', customer_id: '', customer_name: '', card_number: '', vehicle_registration: '', fuel_grade_id: '', litres: '', price_per_litre: '', receipt_number: '' };
  const [form, setForm] = useState(emptyForm);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [dialog, ui] = useDialog();
  const [printed, setPrinted] = useState(null);   // brief "printed" stamp after a save
  useEffect(() => { if (!printed) return undefined; const t = setTimeout(() => setPrinted(null), 2800); return () => clearTimeout(t); }, [printed]);

  const load = async () => {
    try {
      const [tks, cs, sh, nz, st] = await Promise.all([
        getAllTickets({ method, ...stripEmpty(filter) }),
        getCustomers(),
        getShifts({ status: 'Open' }),
        getNozzles(),
        getSettings().catch(() => ({ data: {} })),
      ]);
      setRows(tks.data || []); setCustomers(cs.data || []); setOpenShifts(sh.data || []); setNozzles(nz.data || []);
      setSeller(st.data?.business || {});
    } catch (e) {}
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filter.from, filter.to, filter.customer_id, filter.attendant_user_id]);

  const totalLitres = useMemo(() => rows.reduce((s, r) => s + Number(r.litres || 0), 0), [rows]);
  const totalAmount = useMemo(() => rows.reduce((s, r) => s + Number(r.amount || 0), 0), [rows]);

  const grades = useMemo(() => Array.from(new Map(nozzles.map(n => [n.grade_id, n])).values()).filter(n => n.grade_id), [nozzles]);

  const submit = async (e) => {
    e.preventDefault(); setErr(''); setSaving(true);
    try {
      if (!form.shift_id) throw new Error('Pick an open shift / attendant');
      const res = await addShiftCreditSale(form.shift_id, {
        payment_method: method,
        customer_name: form.customer_name.trim(),
        customer_id: !isCard ? (form.customer_id || null) : null,
        card_number: isCard ? form.card_number : '',
        vehicle_registration: form.vehicle_registration,
        fuel_grade_id: form.fuel_grade_id || null,
        litres: Number(form.litres),
        price_per_litre: Number(form.price_per_litre || 0),
        receipt_number: form.receipt_number || '',
      });
      // Enrich the backend row with the human labels we already have in
      // state so the receipt reads properly without a round-trip
      const sh = openShifts.find(s => Number(s.id) === Number(form.shift_id));
      const g  = grades.find(x => Number(x.grade_id) === Number(form.fuel_grade_id));
      const saved = { ...(res.data || {}),
        attendant_name: sh?.attendant_name || '',
        grade_name: g?.grade_name || '',
      };
      setShowForm(false); setForm(emptyForm); await load();
      printTicket(saved, method, seller, logoUrl);
      setPrinted(saved.customer_name || 'Ticket');
    } catch (ex) { setErr(ex.response?.data?.error || ex.message || 'Save failed'); }
    finally { setSaving(false); }
  };

  const remove = async (r) => {
    if (!(await ui.confirm({ title: 'Delete ticket', text: `Delete ticket for ${r.customer_name}?`, okLabel: 'Delete', danger: true }))) return;
    try { await deleteShiftCreditSale(r.id); await load(); }
    catch (ex) { await ui.alert({ title: 'Delete failed', text: ex.response?.data?.error || 'Delete failed' }); }
  };

  return (
    <div style={S.page} className="k-page">
      <PageHero icon={<FiCreditCard />} title={isCard ? '1Card Sales (Engen)' : 'Credit Sales (Receivables)'} date={today()}
        subtitle={isCard ? 'Fuel paid with an Engen 1Card — a ticket per fill' : 'Fuel taken on account — every ticket adds to what the customer owes'}
        actions={<>
          <button type="button" onClick={() => printTicketList(rows, method, filter, seller, logoUrl)} className="k-fc-btn-ghost" disabled={rows.length === 0} title="Print the full list below"><FiPrinter /> Print List</button>
          <button type="button" onClick={() => { setForm(emptyForm); setErr(''); setShowForm(true); }} className="k-fc-btn-hero"><FiPlus /> New {isCard ? '1Card' : 'Credit'} Ticket</button>
        </>} />

      {printed && <div className="k-stamp" role="status"><FiCheckCircle aria-hidden="true" /> Ticket saved and sent to the printer — {printed}</div>}

      {(() => {
        const sum = ticketSummary(rows);
        return (
          <div className="k-tix-summary" aria-label="Tickets in this range">
            <div><span>Tickets</span><strong className="k-fc-num">{sum.count}</strong></div>
            <div><span>Litres</span><strong className="k-fc-num">{fmtL(sum.litres, 2)}</strong></div>
            <div><span>Amount</span><strong className="k-fc-num">{fmtK(sum.amount)}</strong></div>
            <div className="k-tix-grades">
              <span>Litres by grade</span>
              {sum.litres > 0 ? (
                <>
                  <div className="k-tix-bar" role="img" aria-label={sum.grades.map((g) => `${g.name} ${fmtL(g.litres, 2)}`).join(', ')}>
                    {sum.grades.map((g) => <div key={g.name} style={{ width: `${(g.litres / sum.litres) * 100}%`, background: g.color }} />)}
                  </div>
                  <div className="k-tix-legend">{sum.grades.map((g) => <span key={g.name}><i style={{ background: g.color }} aria-hidden="true" />{g.name} {fmtL(g.litres)}</span>)}</div>
                </>
              ) : <em>No litres yet</em>}
            </div>
          </div>
        );
      })()}

      {/* Filters */}
      <div style={{ ...S.card, padding: 14, marginBottom: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <FiFilter />
        <label style={S.lbl}>From<input type="date" value={filter.from} onChange={e => setFilter({ ...filter, from: e.target.value })} style={S.input} /></label>
        <label style={S.lbl}>To<input type="date" value={filter.to} onChange={e => setFilter({ ...filter, to: e.target.value })} style={S.input} /></label>
        {!isCard && (
          <label style={S.lbl}>Customer
            <select value={filter.customer_id} onChange={e => setFilter({ ...filter, customer_id: e.target.value })} style={S.input}>
              <option value="">All</option>
              {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <div style={{ marginLeft: 'auto', fontSize: 13, color: '#334155' }} className="k-fc-num">
          <strong>{rows.length}</strong> tickets · <strong>{fmtL(totalLitres, 2)}</strong> · <strong>{fmtK(totalAmount)}</strong>
        </div>
      </div>

      {/* Table */}
      <div style={S.card} className="k-table-scroll">
        <table style={S.table} className="phone-cards">
          <thead><tr>
            <th style={S.th}>Date</th>
            <th style={S.th}>Attendant / Shift</th>
            <th style={S.th}>{isCard ? 'Card Holder · #' : 'Customer'}</th>
            <th style={S.th}>Vehicle</th>
            <th style={S.th}>Grade</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Litres</th>
            <th style={{ ...S.th, textAlign: 'right' }}>K/L</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Amount</th>
            <th style={S.th}>Receipt #</th>
            <th style={S.th}></th>
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={S.td}>{fmtDay(r.date || (r.created_at || '').slice(0, 10))}</td>
                <td style={S.td}>{r.attendant_name || '-'} <span style={{ color: '#475569', fontSize: 12 }}>(shift #{r.shift_id})</span></td>
                <td style={S.td}><strong>{r.customer_name}</strong>{r.card_number ? <span style={{ color: '#475569' }}> · {r.card_number}</span> : null}</td>
                <td style={S.td}>{r.vehicle_registration || '-'}</td>
                <td style={S.td}><span style={S.pill(r.grade_color || '#64748b')}>{r.grade_name || '-'}</span></td>
                <td style={S.tdR}>{fmtL(r.litres, 2)}</td>
                <td style={S.tdR}>{fmtK(r.price_per_litre)}</td>
                <td style={S.tdR}><strong>{fmtK(r.amount)}</strong></td>
                <td style={S.td}>{r.receipt_number || '-'}</td>
                <td style={S.td}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => printTicket(r, method, seller, logoUrl)} style={S.iconBtn} title="Print invoice" aria-label={`Print ticket for ${r.customer_name}`}><FiPrinter /></button>
                    <button onClick={() => remove(r)} style={S.iconBtnDanger} title="Delete" aria-label={`Delete ticket for ${r.customer_name}`}><FiTrash2 /></button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={10} style={{ padding: 0 }}><EmptyState art={<FiCreditCard size={40} color="#b45309" />} title="No tickets in this range" text={`Change the dates, or write a new ${isCard ? '1Card' : 'credit'} ticket for an attendant on an open shift.`} /></td></tr>}
          </tbody>
        </table>
      </div>

      {/* New ticket modal */}
      {showForm && (
        <div style={S.backdrop} className="k-modal-backdrop" onClick={() => setShowForm(false)}>
          <div style={{ ...S.modal, width: 'min(640px, 95vw)' }} className="k-modal" onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>New {isCard ? '1Card' : 'Credit'} Ticket</h3>
              <button onClick={() => setShowForm(false)} style={S.iconBtn}><FiX /></button>
            </div>
            <form onSubmit={submit}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid} className="k-form-grid">
                <label style={{ ...S.lbl, gridColumn: '1 / -1' }}>Attendant / Shift *
                  <select value={form.shift_id} onChange={e => setForm({ ...form, shift_id: e.target.value })} required style={S.input}>
                    <option value="">-- pick an open shift --</option>
                    {openShifts.map(s => <option key={s.id} value={s.id}>{s.attendant_name} (shift #{s.id}, opened {s.opened_at})</option>)}
                    {openShifts.length === 0 && <option disabled>No open shifts — open one from Attendant Shifts first</option>}
                  </select>
                </label>
                {isCard ? (
                  <>
                    <label style={S.lbl}>Card Holder *
                      <input value={form.customer_name} onChange={e => setForm({ ...form, customer_name: e.target.value })} required style={S.input} placeholder="Name on 1Card" />
                    </label>
                    <label style={S.lbl}>Card Number
                      <input value={form.card_number} onChange={e => setForm({ ...form, card_number: e.target.value })} style={S.input} placeholder="last 4 or full" />
                    </label>
                  </>
                ) : (
                  <label style={{ ...S.lbl, gridColumn: '1 / -1' }}>Customer *
                    <input list="cs-customer-list" value={form.customer_name} onChange={e => {
                      const match = customers.find(c => c.name === e.target.value);
                      setForm({ ...form, customer_name: e.target.value, customer_id: match?.id || '' });
                    }} required style={S.input} placeholder="Type or pick from Suppliers & Customers → Customers" />
                    <datalist id="cs-customer-list">
                      {customers.map(c => <option key={c.id} value={c.name} />)}
                    </datalist>
                  </label>
                )}
                <label style={S.lbl}>Vehicle
                  <input value={form.vehicle_registration} onChange={e => setForm({ ...form, vehicle_registration: e.target.value.toUpperCase() })} style={S.input} placeholder="e.g. CAA 3626" />
                </label>
                <label style={S.lbl}>Receipt #
                  <input value={form.receipt_number} onChange={e => setForm({ ...form, receipt_number: e.target.value })} style={S.input} />
                </label>
                <label style={S.lbl}>Grade
                  <select value={form.fuel_grade_id} onChange={e => {
                    const nz = grades.find(g => Number(g.grade_id) === Number(e.target.value));
                    setForm({ ...form, fuel_grade_id: e.target.value, price_per_litre: nz?.price_per_litre || form.price_per_litre });
                  }} style={S.input}>
                    <option value="">—</option>
                    {grades.map(g => <option key={g.grade_id} value={g.grade_id}>{g.grade_name}</option>)}
                  </select>
                </label>
                <label style={S.lbl}>Litres *<input type="number" step="0.01" value={form.litres} onChange={e => setForm({ ...form, litres: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>K/L<input type="number" step="0.01" value={form.price_per_litre} onChange={e => setForm({ ...form, price_per_litre: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Amount<input value={fmtK(Number(form.litres || 0) * Number(form.price_per_litre || 0))} readOnly style={{ ...S.input, background: '#f1f5f9', fontWeight: 800 }} /></label>
                {(() => {
                  const amt = Number(form.litres || 0) * Number(form.price_per_litre || 0);
                  const cust = !isCard ? customers.find((c) => String(c.id) === String(form.customer_id)) : null;
                  const cu = cust ? creditUse(cust, amt) : null;
                  return (
                    <div className="k-calc" style={{ gridColumn: '1 / -1' }} aria-live="polite">
                      <div className="k-calc-sum k-fc-num">
                        <span><b>{fmtL(form.litres || 0, 2)}</b><em>litres</em></span>
                        <i aria-hidden="true">×</i>
                        <span><b>{fmtK(form.price_per_litre || 0)}</b><em>per litre</em></span>
                        <i aria-hidden="true">=</i>
                        <span className="k-calc-total"><b>{fmtK(amt)}</b><em>on this ticket</em></span>
                      </div>
                      {cu && cu.limit != null && (
                        <div className={`k-credit${cu.over > 0 ? ' is-over' : ''}`}>
                          <div className="k-credit-row">
                            <span>{cust.name} owes <b className="k-fc-num">{fmtK(cu.owed)}</b> · after this ticket <b className="k-fc-num">{fmtK(cu.after)}</b> of a <b className="k-fc-num">{fmtK(cu.limit)}</b> limit</span>
                          </div>
                          <div className="k-credit-bar" role="img" aria-label={`Credit used after this ticket: ${Math.round(cu.pct * 100)}% of the limit`}>
                            <div style={{ width: `${Math.min(100, (cu.owed / cu.limit) * 100)}%` }} className="k-credit-owed" />
                            <div style={{ width: `${Math.max(0, Math.min(100, cu.pct * 100) - Math.min(100, (cu.owed / cu.limit) * 100))}%` }} className="k-credit-new" />
                          </div>
                          {cu.over > 0 && <div className="k-credit-warn"><FiAlertTriangle aria-hidden="true" /> {fmtK(cu.over)} over the credit limit — check with a supervisor before fuelling.</div>}
                        </div>
                      )}
                      {cust && cu && cu.limit == null && <div className="k-muted" style={{ fontSize: 12.5 }}>{cust.name} owes {fmtK(cu.owed)} · no credit limit set.</div>}
                    </div>
                  );
                })()}
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setShowForm(false)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" disabled={saving} style={S.btnPrimary}>{saving ? 'Saving…' : 'Save Ticket'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {dialog}
    </div>
  );
}

function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) out[k] = v;
  return out;
}
