import React, { useEffect, useMemo, useState } from 'react';
import { FiPlus, FiTrash2, FiX, FiCreditCard, FiFilter, FiPrinter } from 'react-icons/fi';
import { getAllTickets, addShiftCreditSale, deleteShiftCreditSale, getShifts, getNozzles } from '../services/fuelApi';
import { getCustomers } from '../services/api';
import { S } from './fuelStyles';
import { printTicket, printTicketList } from './ticketPrint';

const today = () => new Date().toISOString().slice(0, 10);

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
  const [filter, setFilter] = useState({ from: today(), to: today(), customer_id: '', attendant_user_id: '' });
  const [showForm, setShowForm] = useState(false);
  const emptyForm = { shift_id: '', customer_id: '', customer_name: '', card_number: '', vehicle_registration: '', fuel_grade_id: '', litres: '', price_per_litre: '', receipt_number: '' };
  const [form, setForm] = useState(emptyForm);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const [tks, cs, sh, nz] = await Promise.all([
        getAllTickets({ method, ...stripEmpty(filter) }),
        getCustomers(),
        getShifts({ status: 'Open' }),
        getNozzles(),
      ]);
      setRows(tks.data || []); setCustomers(cs.data || []); setOpenShifts(sh.data || []); setNozzles(nz.data || []);
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
      printTicket(saved, method);
    } catch (ex) { setErr(ex.response?.data?.error || ex.message || 'Save failed'); }
    finally { setSaving(false); }
  };

  const remove = async (r) => {
    if (!window.confirm(`Delete ticket for ${r.customer_name}?`)) return;
    try { await deleteShiftCreditSale(r.id); await load(); }
    catch (ex) { alert(ex.response?.data?.error || 'Delete failed'); }
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h2 style={S.h2}><FiCreditCard /> {isCard ? '1Card Sales (Engen)' : 'Credit Sales (Receivables)'}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => printTicketList(rows, method, filter)} style={S.btnSecondary} disabled={rows.length === 0} title="Print the full list below"><FiPrinter /> Print List</button>
          <button onClick={() => { setForm(emptyForm); setErr(''); setShowForm(true); }} style={S.btnPrimary}><FiPlus /> New {isCard ? '1Card' : 'Credit'} Ticket</button>
        </div>
      </div>

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
        <div style={{ marginLeft: 'auto', fontSize: 13, color: '#374151' }}>
          <strong>{rows.length}</strong> tickets · <strong>{totalLitres.toFixed(2)} L</strong> · <strong>K {totalAmount.toFixed(2)}</strong>
        </div>
      </div>

      {/* Table */}
      <div style={S.card}>
        <table style={S.table}>
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
              <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={S.td}>{r.date || (r.created_at || '').slice(0, 10)}</td>
                <td style={S.td}>{r.attendant_name || '-'} <span style={{ color: '#9ca3af', fontSize: 12 }}>(shift #{r.shift_id})</span></td>
                <td style={S.td}><strong>{r.customer_name}</strong>{r.card_number ? <span style={{ color: '#9ca3af' }}> · {r.card_number}</span> : null}</td>
                <td style={S.td}>{r.vehicle_registration || '-'}</td>
                <td style={S.td}><span style={S.pill(r.grade_color || '#6b7280')}>{r.grade_name || '-'}</span></td>
                <td style={S.tdR}>{Number(r.litres).toFixed(2)}</td>
                <td style={S.tdR}>K {Number(r.price_per_litre).toFixed(2)}</td>
                <td style={S.tdR}><strong>K {Number(r.amount).toFixed(2)}</strong></td>
                <td style={S.td}>{r.receipt_number || '-'}</td>
                <td style={S.td}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => printTicket(r, method)} style={S.iconBtn} title="Print receipt"><FiPrinter /></button>
                    <button onClick={() => remove(r)} style={S.iconBtnDanger} title="Delete"><FiTrash2 /></button>
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No tickets in this range.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* New ticket modal */}
      {showForm && (
        <div style={S.backdrop} onClick={() => setShowForm(false)}>
          <div style={{ ...S.modal, width: 'min(640px, 95vw)' }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>New {isCard ? '1Card' : 'Credit'} Ticket</h3>
              <button onClick={() => setShowForm(false)} style={S.iconBtn}><FiX /></button>
            </div>
            <form onSubmit={submit}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid}>
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
                <label style={S.lbl}>Amount<input value={`K ${(Number(form.litres || 0) * Number(form.price_per_litre || 0)).toFixed(2)}`} readOnly style={{ ...S.input, background: '#f3f4f6', fontWeight: 700 }} /></label>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setShowForm(false)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" disabled={saving} style={S.btnPrimary}>{saving ? 'Saving…' : 'Save Ticket'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v != null) out[k] = v;
  return out;
}
