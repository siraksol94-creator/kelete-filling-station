import React, { useEffect, useMemo, useState } from 'react';
import { FiPlus, FiX, FiPlay, FiStopCircle, FiClock, FiCheckCircle, FiTrash2, FiFileText, FiEdit } from 'react-icons/fi';
import { getShifts, getShift, openShift, closeShift, getNozzles, getTanks, getPumpsWithNozzles, addShiftCreditSale } from '../services/fuelApi';
import { getUsers, getCustomers } from '../services/api';
import { S } from './fuelStyles';

// Thousands separator for display (handles partial typing like "384343."
// so the user can still key a decimal point without the formatter eating it).
function formatThousands(v) {
  if (v === '' || v == null) return '';
  const s = String(v);
  const [intPart, decPart] = s.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart !== undefined ? `${withCommas}.${decPart}` : withCommas;
}

function fmtNum(n, dec = 2) {
  const num = Number(n);
  if (!isFinite(num)) return '-';
  return num.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

export default function AttendantShifts() {
  const [shifts, setShifts] = useState([]);
  const [users, setUsers] = useState([]);
  const [nozzles, setNozzles] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [customers, setCustomers] = useState([]);   // from the standard customers table (same as Account Receivables)
  const [pumps, setPumps] = useState([]);     // [{id, code, name, nozzles: [...]}]

  const [openForm, setOpenForm] = useState(null);
  const [closingShift, setClosingShift] = useState(null);
  const [cd, setCd] = useState({
    readings: {},                                // { readingId: { closing_reading, testing_litres } }
    credit_sales: [],                            // [{ customer_name, fleet_customer_id, vehicle_registration, fuel_grade_id, litres, price_per_litre, receipt_number }]
    dips: {},                                    // { tankId: dip_litres }
    payment_cash: '', payment_swipes: '', payment_1card: '', payment_mobile: '', payment_other: '',
    notes: '',
  });
  const [err, setErr] = useState('');
  const [viewShift, setViewShift] = useState(null);
  // Quick ticket modal (during an open shift). payment_method decides
  // which flavour (Credit = fleet receivable, 1Card = Engen pre-paid card).
  const [ticketShift, setTicketShift] = useState(null);  // {id, attendant_name}
  const [ticketMethod, setTicketMethod] = useState('Credit');
  const [ticket, setTicket] = useState({ customer_name: '', customer_id: '', card_number: '', vehicle_registration: '', fuel_grade_id: '', litres: '', price_per_litre: '', receipt_number: '' });
  const [savingTicket, setSavingTicket] = useState(false);

  const load = async () => {
    try {
      const [sh, u, n, t, cs, p] = await Promise.all([getShifts(), getUsers(), getNozzles(), getTanks(), getCustomers(), getPumpsWithNozzles()]);
      setShifts(sh.data || []);
      setUsers((u.data || []).filter(x => x.status === 'Active'));
      setNozzles(n.data || []);
      setTanks(t.data || []);
      setCustomers(cs.data || []);
      setPumps(p.data || []);
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);

  // ── Open ─────────────────────────────────────────────────────────────
  const submitOpen = async (e) => {
    e.preventDefault(); setErr('');
    if (!openForm.attendant_user_id) { setErr('Pick an attendant'); return; }
    if (openForm.nozzle_ids.length === 0) { setErr('Pick at least one nozzle'); return; }
    try { await openShift(openForm); setOpenForm(null); await load(); }
    catch (ex) { setErr(ex.response?.data?.error || 'Open failed'); }
  };

  // ── Close ────────────────────────────────────────────────────────────
  const beginClose = async (sh) => {
    try {
      const full = (await getShift(sh.id)).data;
      setClosingShift(full);
      // Leave Closing empty so the operator must type the real meter value;
      // pre-filling with the opening made every row calculate 0 and hid the
      // bug when a stale snapshot pre-dated the actual opening.
      const init = {};
      (full.readings || []).forEach(r => { init[r.id] = { closing_reading: '' }; });
      // Only tanks tied to this shift's nozzles need dips entered
      const tankIds = Array.from(new Set((full.readings || []).map(r => r.tank_id).filter(Boolean)));
      const dipsInit = {};
      tankIds.forEach(tid => { dipsInit[tid] = ''; });
      setCd({
        readings: init, credit_sales: [], dips: dipsInit,
        payment_cash: '', payment_swipes: '', payment_1card: '', payment_mobile: '', payment_other: '',
        notes: '',
      });
      setErr('');
    } catch (e) {}
  };

  // Live calculations. Rows sorted so Petrol lands first (P1, P2, ... P8),
  // then Diesel (D1, D2, ...), then anything else (K/A for paraffin etc.),
  // each group ordered by the numeric part of the nozzle code.
  const liveNozzleRows = useMemo(() => {
    if (!closingShift) return [];
    const groupOrder = { P: 0, D: 1, K: 2 };
    const sorted = [...(closingShift.readings || [])].sort((a, b) => {
      const ag = groupOrder[(a.nozzle_code || '').charAt(0).toUpperCase()] ?? 9;
      const bg = groupOrder[(b.nozzle_code || '').charAt(0).toUpperCase()] ?? 9;
      if (ag !== bg) return ag - bg;
      const an = parseInt(String(a.nozzle_code).replace(/\D/g, ''), 10) || 0;
      const bn = parseInt(String(b.nozzle_code).replace(/\D/g, ''), 10) || 0;
      return an - bn;
    });
    return sorted.map(r => {
      const rawC = cd.readings[r.id]?.closing_reading;
      const c = rawC === '' || rawC == null ? null : Number(rawC);
      const invalid = c != null && c < r.opening_reading;
      const sold = c != null && !invalid ? Math.max(c - r.opening_reading, 0) : 0;
      const amt = sold * r.price_per_litre;
      return { ...r, closing: c, sold, amt, invalid };
    });
  }, [closingShift, cd.readings]);

  const grossSales = useMemo(() => liveNozzleRows.reduce((s, r) => s + r.amt, 0), [liveNozzleRows]);
  // Credit + 1Card totals come from the tickets already logged on this shift
  // (via the Credit/1Card buttons during the day). Attendant doesn't type them.
  const existingTickets = closingShift?.credit_sales || [];
  const creditTotal  = useMemo(() => existingTickets.filter(c => (c.payment_method || 'Credit') === 'Credit').reduce((s, c) => s + Number(c.amount), 0), [existingTickets]);
  const onecardTotal = useMemo(() => existingTickets.filter(c => c.payment_method === '1Card').reduce((s, c) => s + Number(c.amount), 0), [existingTickets]);
  const nonCash      = Number(cd.payment_swipes || 0) + Number(cd.payment_mobile || 0) + creditTotal + onecardTotal;
  const expectedCash = Math.max(0, grossSales - nonCash);
  const variance     = Number(cd.payment_cash || 0) - expectedCash;

  // Dip reconciliation per grade group
  const dipReconciliation = useMemo(() => {
    if (!closingShift) return [];
    const soldByTank = {};
    for (const r of liveNozzleRows) {
      if (!r.tank_id) continue;
      soldByTank[r.tank_id] = (soldByTank[r.tank_id] || 0) + r.sold;
    }
    const uniqueTankIds = Object.keys(cd.dips);
    return uniqueTankIds.map(tid => {
      const tank = tanks.find(t => t.id === Number(tid));
      const sold = soldByTank[tid] || 0;
      const readingLitres = tank ? Math.max(0, Number(tank.current_volume) - sold) : null;
      const dip = cd.dips[tid] === '' ? null : Number(cd.dips[tid]);
      const varnc = (dip != null && readingLitres != null) ? Number((dip - readingLitres).toFixed(2)) : null;
      return { tank_id: Number(tid), tank, sold, reading: readingLitres, dip, variance: varnc };
    });
  }, [closingShift, cd.dips, cd.credit_sales, cd.readings, tanks, liveNozzleRows]);

  const addCreditSale = () => setCd({ ...cd, credit_sales: [...cd.credit_sales, {
    customer_name: '', fleet_customer_id: '', vehicle_registration: '',
    fuel_grade_id: '', litres: '', price_per_litre: '', receipt_number: '',
  }] });
  const updCreditSale = (i, patch) => setCd({ ...cd, credit_sales: cd.credit_sales.map((c, idx) => idx === i ? { ...c, ...patch } : c) });
  const rmCreditSale  = (i) => setCd({ ...cd, credit_sales: cd.credit_sales.filter((_, idx) => idx !== i) });

  // Submit a single credit ticket to the open shift. Posts to the fleet
  // customer's receivable ledger immediately via the dedicated endpoint.
  const submitTicket = async (e) => {
    e.preventDefault(); setErr(''); setSavingTicket(true);
    try {
      if (!ticket.customer_name) throw new Error('Customer name is required');
      if (!(Number(ticket.litres) > 0)) throw new Error('Litres must be > 0');
      await addShiftCreditSale(ticketShift.id, {
        payment_method: ticketMethod,
        customer_name: ticket.customer_name.trim(),
        customer_id: ticketMethod === 'Credit' ? (ticket.customer_id || null) : null,
        card_number: ticket.card_number || '',
        vehicle_registration: ticket.vehicle_registration || '',
        fuel_grade_id: ticket.fuel_grade_id || null,
        litres: Number(ticket.litres),
        price_per_litre: Number(ticket.price_per_litre || 0),
        receipt_number: ticket.receipt_number || '',
      });
      setTicketShift(null); await load();
    } catch (ex) { setErr(ex.response?.data?.error || ex.message || 'Save failed'); }
    finally { setSavingTicket(false); }
  };

  const submitClose = async (e) => {
    e.preventDefault(); setErr('');
    const readings = Object.entries(cd.readings).map(([id, r]) => ({
      id: Number(id), closing_reading: Number(r.closing_reading), testing_litres: 0,
    }));
    const credit_sales_batch = cd.credit_sales
      .filter(c => c.customer_name && Number(c.litres) > 0)
      .map(c => ({
        customer_name: c.customer_name.trim(),
        fleet_customer_id: c.fleet_customer_id || null,
        vehicle_registration: c.vehicle_registration || '',
        fuel_grade_id: c.fuel_grade_id || null,
        litres: Number(c.litres),
        price_per_litre: Number(c.price_per_litre || 0),
        receipt_number: c.receipt_number || '',
      }));
    const dips = Object.entries(cd.dips)
      .filter(([_, v]) => v !== '' && v != null)
      .map(([tid, v]) => ({ tank_id: Number(tid), dip_litres: Number(v) }));

    try {
      await closeShift(closingShift.id, {
        readings, credit_sales_batch, dips,
        payment_cash:   Number(cd.payment_cash   || 0),
        payment_swipes: Number(cd.payment_swipes || 0),
        payment_1card:  Number(cd.payment_1card  || 0),
        payment_mobile: Number(cd.payment_mobile || 0),
        payment_other:  Number(cd.payment_other  || 0),
        notes: cd.notes,
      });
      setClosingShift(null); await load();
    } catch (ex) { setErr(ex.response?.data?.error || 'Close failed'); }
  };

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <div style={S.header}>
        <h2 style={S.h2}><FiClock /> Attendant Shifts</h2>
        <button onClick={() => setOpenForm({ attendant_user_id: '', nozzle_ids: [] })} style={S.btnPrimary}><FiPlay /> Open Shift</button>
      </div>

      <div style={S.card}>
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>Status</th><th style={S.th}>Attendant</th>
            <th style={S.th}>Opened</th><th style={S.th}>Closed</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Gross</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Expected Cash</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Cash In</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Variance</th>
            <th style={S.th}></th>
          </tr></thead>
          <tbody>
            {shifts.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={S.td}><span style={S.pill(s.status === 'Open' ? '#16a34a' : '#6b7280')}>{s.status}</span></td>
                <td style={S.td}>{s.attendant_name || `#${s.attendant_user_id}`}</td>
                <td style={S.td}>{s.opened_at}</td>
                <td style={S.td}>{s.closed_at || '-'}</td>
                <td style={S.tdR}>K {Number((s.expected_cash || 0) + Number(s.payment_swipes || 0) + Number(s.payment_1card || 0) + Number(s.payment_mobile || 0) + Number(s.payment_other || 0)).toFixed(2)}</td>
                <td style={S.tdR}>K {Number(s.expected_cash || 0).toFixed(2)}</td>
                <td style={S.tdR}>K {Number(s.actual_cash || 0).toFixed(2)}</td>
                <td style={{ ...S.tdR, color: Math.abs(s.variance || 0) < 0.01 ? '#111' : (s.variance < 0 ? '#dc2626' : '#16a34a') }}>K {Number(s.variance || 0).toFixed(2)}</td>
                <td style={S.td}>
                  {s.status === 'Open' ? (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button onClick={() => {
                        setTicketShift(s); setTicketMethod('Credit');
                        setTicket({ customer_name: '', customer_id: '', card_number: '', vehicle_registration: '', fuel_grade_id: '', litres: '', price_per_litre: '', receipt_number: '' });
                      }} style={{ ...S.btnSecondary, padding: '6px 10px' }}>+ Credit</button>
                      <button onClick={() => {
                        setTicketShift(s); setTicketMethod('1Card');
                        setTicket({ customer_name: '', customer_id: '', card_number: '', vehicle_registration: '', fuel_grade_id: '', litres: '', price_per_litre: '', receipt_number: '' });
                      }} style={{ ...S.btnSecondary, padding: '6px 10px' }}>+ 1Card</button>
                      <button onClick={() => beginClose(s)} style={{ ...S.btnDanger, padding: '6px 12px' }}><FiStopCircle /> Close</button>
                    </div>
                  ) : (
                    <button onClick={async () => { const d = (await getShift(s.id)).data; setViewShift(d); }} style={S.btnSecondary}><FiFileText /> Report</button>
                  )}
                </td>
              </tr>
            ))}
            {shifts.length === 0 && <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No shifts yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {/* ── Open shift modal (unchanged) ─────────────────────────────── */}
      {openForm && (
        <div style={S.backdrop} onClick={() => setOpenForm(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}><h3 style={{ margin: 0 }}>Open Shift</h3><button onClick={() => setOpenForm(null)} style={S.iconBtn}><FiX /></button></div>
            <form onSubmit={submitOpen}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={{ padding: 20 }}>
                <label style={S.lbl}>Attendant *
                  <select value={openForm.attendant_user_id} onChange={e => setOpenForm({ ...openForm, attendant_user_id: e.target.value })} required style={S.input}>
                    <option value="">-- select --</option>
                    {users.map(u => <option key={u.id} value={u.id}>{u.first_name} {u.last_name} ({u.role})</option>)}
                  </select>
                </label>
                <div style={{ marginTop: 16 }}>
                  <strong style={{ fontSize: 13, color: '#374151' }}>Pumps for this attendant *</strong>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8 }}>Tick a pump and every nozzle on it is assigned.</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    {pumps.map(p => {
                      const pumpNozIds = (p.nozzles || []).map(n => n.id);
                      const allIn = pumpNozIds.length > 0 && pumpNozIds.every(id => openForm.nozzle_ids.includes(id));
                      return (
                        <label key={p.id} style={{ display: 'flex', alignItems: 'start', gap: 10, padding: 12, border: `1.5px solid ${allIn ? '#2563eb' : '#e5e7eb'}`, borderRadius: 8, cursor: 'pointer', background: allIn ? '#eff6ff' : '#fff' }}>
                          <input type="checkbox" checked={allIn} onChange={e => {
                            const next = e.target.checked
                              ? Array.from(new Set([...openForm.nozzle_ids, ...pumpNozIds]))
                              : openForm.nozzle_ids.filter(id => !pumpNozIds.includes(id));
                            setOpenForm({ ...openForm, nozzle_ids: next });
                          }} style={{ marginTop: 3 }} />
                          <div style={{ flex: 1 }}>
                            <div style={{ fontWeight: 700, fontSize: 14 }}>{p.code} <span style={{ color: '#6b7280', fontWeight: 500 }}>— {p.name}</span></div>
                            <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                              {(p.nozzles || []).map(n => (
                                <span key={n.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 4, background: '#f3f4f6' }}>
                                  <strong>{n.code}</strong>
                                  <span style={{ color: n.grade_color || '#9ca3af' }}>·</span>
                                  <span>{n.grade_name}</span>
                                </span>
                              ))}
                              {(p.nozzles || []).length === 0 && <span style={{ fontStyle: 'italic' }}>no nozzles</span>}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                    {pumps.length === 0 && <div style={{ color: '#6b7280', fontSize: 13 }}>No pumps configured.</div>}
                  </div>
                </div>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setOpenForm(null)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" style={S.btnPrimary}>Open Shift</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Close shift modal — the big one ──────────────────────────── */}
      {closingShift && (
        <div style={S.backdrop} onClick={() => setClosingShift(null)}>
          <div style={{ ...S.modal, width: 'min(1100px, 97vw)', maxHeight: '95vh' }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>Close Shift — {closingShift.attendant_name}</h3>
              <button onClick={() => setClosingShift(null)} style={S.iconBtn}><FiX /></button>
            </div>
            <form onSubmit={submitClose}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={{ padding: 20, overflowY: 'auto', maxHeight: 'calc(95vh - 160px)' }}>

                {/* ── Section 1: nozzle readings ─────────────────────── */}
                <SectionHeader title="1. Nozzle Readings" />
                <table style={S.table}>
                  <thead><tr>
                    <th style={S.th}>Nozzle</th><th style={S.th}>Grade</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Opening</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Closing *</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Litres</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>K/L</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Amount</th>
                  </tr></thead>
                  <tbody>
                    {liveNozzleRows.map(r => (
                      <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6', background: r.invalid ? '#fef2f2' : undefined }}>
                        <td style={S.td}><strong>{r.nozzle_code}</strong> <span style={{ color: '#9ca3af', fontSize: 12 }}>({r.pump_code})</span></td>
                        <td style={S.td}><span style={S.pill(r.grade_color || '#6b7280')}>{r.grade_name}</span></td>
                        <td style={S.tdR}>{fmtNum(r.opening_reading, 2)}</td>
                        <td style={S.tdR}>
                          <input type="text" inputMode="decimal"
                            value={formatThousands(cd.readings[r.id]?.closing_reading ?? '')}
                            onChange={e => {
                              const raw = e.target.value.replace(/,/g, '');
                              if (raw === '' || /^\d*\.?\d*$/.test(raw)) {
                                setCd({ ...cd, readings: { ...cd.readings, [r.id]: { ...cd.readings[r.id], closing_reading: raw } } });
                              }
                            }}
                            required
                            placeholder="type closing"
                            style={{ ...S.input, width: 140, textAlign: 'right', borderColor: r.invalid ? '#dc2626' : undefined }} />
                          {r.invalid && <div style={{ color: '#dc2626', fontSize: 11, marginTop: 2 }}>closing &lt; opening</div>}
                        </td>
                        <td style={S.tdR}><strong>{fmtNum(r.sold, 2)}</strong></td>
                        <td style={S.tdR}>K {fmtNum(r.price_per_litre, 2)}</td>
                        <td style={S.tdR}><strong>K {fmtNum(r.amt, 2)}</strong></td>
                      </tr>
                    ))}
                    <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                      <td colSpan={4} style={{ ...S.td, textAlign: 'right' }}>TOTAL READING SALES</td>
                      <td style={S.tdR}>{fmtNum(liveNozzleRows.reduce((s, r) => s + r.sold, 0), 2)}</td>
                      <td style={S.td}></td>
                      <td style={S.tdR}>K {fmtNum(grossSales, 2)}</td>
                    </tr>
                  </tbody>
                </table>

                {/* ── Section 2: Credit + 1Card ticket summaries (read-only) ── */}
                <SectionHeader title="2. Credit & 1Card Tickets (logged during shift)" />
                {existingTickets.length === 0 ? (
                  <div style={{ padding: 16, color: '#9ca3af', fontSize: 13, textAlign: 'center', border: '1px dashed #e5e7eb', borderRadius: 6 }}>
                    No tickets logged. Cancel this close, click "+ Credit" or "+ 1Card" on the shift row to add tickets, then close.
                  </div>
                ) : (
                  <table style={S.table}>
                    <thead><tr>
                      <th style={S.th}>Method</th><th style={S.th}>Customer / Card</th><th style={S.th}>Vehicle</th>
                      <th style={S.th}>Grade</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>Litres</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>K/L</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>Amount</th>
                      <th style={S.th}>Receipt #</th>
                    </tr></thead>
                    <tbody>
                      {existingTickets.map(c => (
                        <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={S.td}><span style={S.pill(c.payment_method === '1Card' ? '#f59e0b' : '#2563eb')}>{c.payment_method || 'Credit'}</span></td>
                          <td style={S.td}><strong>{c.customer_name}</strong>{c.card_number ? ` · ${c.card_number}` : ''}</td>
                          <td style={S.td}>{c.vehicle_registration || '-'}</td>
                          <td style={S.td}>{c.grade_name || '-'}</td>
                          <td style={S.tdR}>{fmtNum(c.litres, 2)}</td>
                          <td style={S.tdR}>K {fmtNum(c.price_per_litre, 2)}</td>
                          <td style={S.tdR}><strong>K {fmtNum(c.amount, 2)}</strong></td>
                          <td style={S.td}>{c.receipt_number || '-'}</td>
                        </tr>
                      ))}
                      <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                        <td colSpan={6} style={{ ...S.td, textAlign: 'right' }}>CREDIT · 1CARD TOTALS</td>
                        <td style={S.tdR}>K {fmtNum(creditTotal + onecardTotal, 2)}</td>
                        <td style={S.td}></td>
                      </tr>
                    </tbody>
                  </table>
                )}

                {/* ── Section 3: payment breakdown + dips side by side ── */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 16 }}>
                  <div>
                    <SectionHeader title="3. Payment Breakdown" />
                    <PayRow label="Cash *" value={cd.payment_cash} onChange={v => setCd({ ...cd, payment_cash: v })} highlight />
                    <PayRow label="Mobile Money" value={cd.payment_mobile} onChange={v => setCd({ ...cd, payment_mobile: v })} />
                    <PayRow label="Swipes" value={cd.payment_swipes} onChange={v => setCd({ ...cd, payment_swipes: v })} />
                    <PayRow label="Credit (auto)" value={creditTotal.toFixed(2)} readOnly />
                    <PayRow label="1Card (auto)" value={onecardTotal.toFixed(2)} readOnly />
                  </div>

                  <div>
                    <SectionHeader title="4. Dip Readings per Tank" />
                    <table style={S.table}>
                      <thead><tr>
                        <th style={S.th}>Tank</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>Reading (book)</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>Dip *</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>Variance</th>
                      </tr></thead>
                      <tbody>
                        {dipReconciliation.map(d => (
                          <tr key={d.tank_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={S.td}><strong>{d.tank?.code || d.tank_id}</strong> <span style={{ color: '#9ca3af' }}>— {d.tank?.grade_name}</span></td>
                            <td style={S.tdR}>{d.reading != null ? d.reading.toFixed(2) : '-'}</td>
                            <td style={S.tdR}>
                              <input type="number" step="0.01" value={cd.dips[d.tank_id] ?? ''} onChange={e => setCd({ ...cd, dips: { ...cd.dips, [d.tank_id]: e.target.value } })} style={{ ...S.input, width: 90, textAlign: 'right' }} />
                            </td>
                            <td style={{ ...S.tdR, color: d.variance == null ? '#9ca3af' : (Math.abs(d.variance) < 0.5 ? '#111' : (d.variance < 0 ? '#dc2626' : '#16a34a')) }}>
                              {d.variance != null ? d.variance.toFixed(2) : '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* ── Summary tiles ─────────────────────────────────── */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 20 }}>
                  <Tile label="Gross Sales" value={`K ${grossSales.toFixed(2)}`} />
                  <Tile label="Non-Cash + Credit" value={`K ${nonCash.toFixed(2)}`} />
                  <Tile label="Expected Cash" value={`K ${expectedCash.toFixed(2)}`} highlight />
                  <Tile label="Variance" value={`K ${variance.toFixed(2)}`} color={Math.abs(variance) < 0.01 ? '#111' : (variance < 0 ? '#dc2626' : '#16a34a')} />
                </div>

                <label style={{ ...S.lbl, marginTop: 16 }}>Notes
                  <input value={cd.notes} onChange={e => setCd({ ...cd, notes: e.target.value })} style={S.input} />
                </label>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setClosingShift(null)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" style={S.btnPrimary}><FiCheckCircle /> Close Shift</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Quick ticket modal (Credit OR 1Card during an open shift) ── */}
      {ticketShift && (
        <div style={S.backdrop} onClick={() => setTicketShift(null)}>
          <div style={{ ...S.modal, width: 'min(560px, 95vw)' }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>{ticketMethod === '1Card' ? 'Engen 1Card Ticket' : 'Credit Ticket'} — {ticketShift.attendant_name}</h3>
              <button onClick={() => setTicketShift(null)} style={S.iconBtn}><FiX /></button>
            </div>
            <form onSubmit={submitTicket}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid}>
                {ticketMethod === 'Credit' ? (
                  <label style={{ ...S.lbl, gridColumn: '1 / -1' }}>Customer *
                    <input list="ticket-customer-list" value={ticket.customer_name} onChange={e => {
                      const match = customers.find(c => c.name === e.target.value);
                      setTicket({ ...ticket, customer_name: e.target.value, customer_id: match?.id || '' });
                    }} required style={S.input} placeholder="Type or pick a customer (same list as Suppliers & Customers)" />
                    <datalist id="ticket-customer-list">
                      {customers.map(c => <option key={c.id} value={c.name} />)}
                    </datalist>
                  </label>
                ) : (
                  <>
                    <label style={S.lbl}>Card Holder *
                      <input value={ticket.customer_name} onChange={e => setTicket({ ...ticket, customer_name: e.target.value })} required style={S.input} placeholder="Name on 1Card" />
                    </label>
                    <label style={S.lbl}>Card Number
                      <input value={ticket.card_number} onChange={e => setTicket({ ...ticket, card_number: e.target.value })} style={S.input} placeholder="last 4 or full" />
                    </label>
                  </>
                )}
                <label style={S.lbl}>Vehicle
                  <input value={ticket.vehicle_registration} onChange={e => setTicket({ ...ticket, vehicle_registration: e.target.value.toUpperCase() })} style={S.input} placeholder="e.g. CAA 3626" />
                </label>
                <label style={S.lbl}>Receipt #
                  <input value={ticket.receipt_number} onChange={e => setTicket({ ...ticket, receipt_number: e.target.value })} style={S.input} />
                </label>
                <label style={S.lbl}>Grade
                  <select value={ticket.fuel_grade_id} onChange={e => {
                    const nz = nozzles.find(n => Number(n.grade_id || n.fuel_grade_id || 0) === Number(e.target.value));
                    setTicket({ ...ticket, fuel_grade_id: e.target.value, price_per_litre: nz?.price_per_litre || ticket.price_per_litre });
                  }} style={S.input}>
                    <option value="">—</option>
                    {Array.from(new Map(nozzles.map(n => [n.grade_id || n.fuel_grade_id, n])).values()).map(n => (
                      <option key={n.grade_id || n.fuel_grade_id} value={n.grade_id || n.fuel_grade_id}>{n.grade_name}</option>
                    ))}
                  </select>
                </label>
                <label style={S.lbl}>Litres *
                  <input type="number" step="0.01" value={ticket.litres} onChange={e => setTicket({ ...ticket, litres: e.target.value })} required style={S.input} />
                </label>
                <label style={S.lbl}>K/L
                  <input type="number" step="0.01" value={ticket.price_per_litre} onChange={e => setTicket({ ...ticket, price_per_litre: e.target.value })} style={S.input} />
                </label>
                <label style={S.lbl}>Amount
                  <input value={`K ${(Number(ticket.litres || 0) * Number(ticket.price_per_litre || 0)).toFixed(2)}`} readOnly style={{ ...S.input, background: '#f3f4f6', fontWeight: 700 }} />
                </label>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setTicketShift(null)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" disabled={savingTicket} style={S.btnPrimary}>{savingTicket ? 'Saving…' : 'Save Ticket'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── View report modal (closed shifts) ────────────────────────── */}
      {viewShift && (
        <div style={S.backdrop} onClick={() => setViewShift(null)}>
          <div style={{ ...S.modal, width: 'min(900px, 95vw)', maxHeight: '92vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>Shift Report — {viewShift.attendant_name}</h3>
              <button onClick={() => setViewShift(null)} style={S.iconBtn}><FiX /></button>
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ color: '#6b7280', marginBottom: 12 }}>Opened: {viewShift.opened_at} &nbsp;·&nbsp; Closed: {viewShift.closed_at}</div>
              <h4>Nozzle Readings</h4>
              <table style={S.table}>
                <thead><tr>
                  <th style={S.th}>Nozzle</th><th style={S.th}>Grade</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Opening</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Closing</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Litres</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>K/L</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>Amount</th>
                </tr></thead>
                <tbody>
                  {(viewShift.readings || []).map(r => (
                    <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={S.td}><strong>{r.nozzle_code}</strong> <span style={{ color: '#9ca3af', fontSize: 12 }}>({r.pump_code})</span></td>
                      <td style={S.td}><span style={S.pill(r.grade_color || '#6b7280')}>{r.grade_name}</span></td>
                      <td style={S.tdR}>{Number(r.opening_reading).toFixed(2)}</td>
                      <td style={S.tdR}>{Number(r.closing_reading || 0).toFixed(2)}</td>
                      <td style={S.tdR}><strong>{Number(r.litres_sold || 0).toFixed(2)}</strong></td>
                      <td style={S.tdR}>K {Number(r.price_per_litre).toFixed(2)}</td>
                      <td style={S.tdR}><strong>K {Number(r.expected_cash || 0).toFixed(2)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {(viewShift.credit_sales || []).length > 0 && (
                <>
                  <h4 style={{ marginTop: 20 }}>Credit Sales</h4>
                  <table style={S.table}>
                    <thead><tr><th style={S.th}>Customer</th><th style={S.th}>Vehicle</th><th style={S.th}>Grade</th><th style={{ ...S.th, textAlign: 'right' }}>Litres</th><th style={{ ...S.th, textAlign: 'right' }}>Amount</th><th style={S.th}>Receipt</th></tr></thead>
                    <tbody>
                      {viewShift.credit_sales.map(c => (
                        <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={S.td}>{c.customer_name}</td>
                          <td style={S.td}>{c.vehicle_registration || '-'}</td>
                          <td style={S.td}>{c.grade_name || '-'}</td>
                          <td style={S.tdR}>{Number(c.litres).toFixed(2)}</td>
                          <td style={S.tdR}>K {Number(c.amount).toFixed(2)}</td>
                          <td style={S.td}>{c.receipt_number || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              <h4 style={{ marginTop: 20 }}>Reconciliation</h4>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                <div>
                  <PayRow label="Cash" value={Number(viewShift.payment_cash || 0).toFixed(2)} readOnly />
                  <PayRow label="Swipes" value={Number(viewShift.payment_swipes || 0).toFixed(2)} readOnly />
                  <PayRow label="Engen 1Card" value={Number(viewShift.payment_1card || 0).toFixed(2)} readOnly />
                  <PayRow label="Mobile Money" value={Number(viewShift.payment_mobile || 0).toFixed(2)} readOnly />
                  <PayRow label="Other" value={Number(viewShift.payment_other || 0).toFixed(2)} readOnly />
                  <PayRow label="Credit Total" value={(viewShift.credit_sales || []).reduce((s, c) => s + Number(c.amount), 0).toFixed(2)} readOnly />
                </div>
                <div>
                  <Tile label="Expected Cash" value={`K ${Number(viewShift.expected_cash || 0).toFixed(2)}`} highlight />
                  <div style={{ height: 10 }} />
                  <Tile label="Actual Cash" value={`K ${Number(viewShift.actual_cash || 0).toFixed(2)}`} />
                  <div style={{ height: 10 }} />
                  <Tile label="Variance" value={`K ${Number(viewShift.variance || 0).toFixed(2)}`} color={Math.abs(viewShift.variance || 0) < 0.01 ? '#111' : (viewShift.variance < 0 ? '#dc2626' : '#16a34a')} />
                </div>
              </div>

              {(viewShift.dips || []).length > 0 && (
                <>
                  <h4 style={{ marginTop: 20 }}>Dip Readings</h4>
                  <table style={S.table}>
                    <thead><tr><th style={S.th}>Tank</th><th style={S.th}>Grade</th><th style={{ ...S.th, textAlign: 'right' }}>Reading</th><th style={{ ...S.th, textAlign: 'right' }}>Dip</th><th style={{ ...S.th, textAlign: 'right' }}>Variance</th></tr></thead>
                    <tbody>
                      {viewShift.dips.map(d => (
                        <tr key={d.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={S.td}><strong>{d.tank_code}</strong> — {d.tank_name}</td>
                          <td style={S.td}>{d.grade_name}</td>
                          <td style={S.tdR}>{d.reading_litres != null ? Number(d.reading_litres).toFixed(2) : '-'}</td>
                          <td style={S.tdR}>{Number(d.dip_litres).toFixed(2)}</td>
                          <td style={{ ...S.tdR, color: Math.abs(d.variance || 0) < 0.5 ? '#111' : (d.variance < 0 ? '#dc2626' : '#16a34a') }}>{d.variance != null ? Number(d.variance).toFixed(2) : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionHeader({ title, action }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '20px 0 10px' }}>
      <h4 style={{ margin: 0, fontSize: 14, color: '#111', textTransform: 'uppercase', letterSpacing: 0.4 }}>{title}</h4>
      {action}
    </div>
  );
}

function PayRow({ label, value, onChange, readOnly, highlight }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
      <span style={{ fontSize: 13, color: '#374151', fontWeight: highlight ? 700 : 500 }}>{label}</span>
      <input type="number" step="0.01" value={value} readOnly={readOnly} onChange={readOnly ? undefined : e => onChange(e.target.value)}
        style={{ ...S.input, width: 140, textAlign: 'right', background: readOnly ? '#f3f4f6' : '#fff', fontWeight: highlight ? 700 : 500 }} />
    </div>
  );
}

function Tile({ label, value, highlight, color }) {
  return (
    <div style={S.statCard}>
      <div style={S.statLabel}>{label}</div>
      <div style={{ ...S.statValue, color: color || (highlight ? '#2563eb' : '#111') }}>{value}</div>
    </div>
  );
}
