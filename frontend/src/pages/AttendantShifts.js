import React, { useEffect, useMemo, useState } from 'react';
import { FiPlus, FiX, FiPlay, FiStopCircle, FiClock, FiCheckCircle, FiTrash2, FiFileText } from 'react-icons/fi';
import { getShifts, getShift, openShift, closeShift, getNozzles, getTanks, getFleetCustomers } from '../services/fuelApi';
import { getUsers } from '../services/api';
import { S } from './fuelStyles';

export default function AttendantShifts() {
  const [shifts, setShifts] = useState([]);
  const [users, setUsers] = useState([]);
  const [nozzles, setNozzles] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [fleet, setFleet] = useState([]);

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

  const load = async () => {
    try {
      const [sh, u, n, t, fl] = await Promise.all([getShifts(), getUsers(), getNozzles(), getTanks(), getFleetCustomers()]);
      setShifts(sh.data || []);
      setUsers((u.data || []).filter(x => x.status === 'Active'));
      setNozzles(n.data || []);
      setTanks(t.data || []);
      setFleet(fl.data || []);
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
      const init = {};
      (full.readings || []).forEach(r => { init[r.id] = { closing_reading: r.opening_reading, testing_litres: 0 }; });
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

  // Live calculations
  const liveNozzleRows = useMemo(() => {
    if (!closingShift) return [];
    return (closingShift.readings || []).map(r => {
      const c = Number(cd.readings[r.id]?.closing_reading ?? r.opening_reading);
      const t = Number(cd.readings[r.id]?.testing_litres || 0);
      const sold = Math.max(c - r.opening_reading - t, 0);
      const amt = sold * r.price_per_litre;
      return { ...r, closing: c, testing: t, sold, amt };
    });
  }, [closingShift, cd.readings]);

  const grossSales   = useMemo(() => liveNozzleRows.reduce((s, r) => s + r.amt, 0), [liveNozzleRows]);
  const creditTotal  = useMemo(() => cd.credit_sales.reduce((s, c) => s + (Number(c.litres) * Number(c.price_per_litre || 0)), 0), [cd.credit_sales]);
  const nonCash      = Number(cd.payment_swipes || 0) + Number(cd.payment_1card || 0) + Number(cd.payment_mobile || 0) + Number(cd.payment_other || 0) + creditTotal;
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

  const submitClose = async (e) => {
    e.preventDefault(); setErr('');
    const readings = Object.entries(cd.readings).map(([id, r]) => ({
      id: Number(id), closing_reading: Number(r.closing_reading), testing_litres: Number(r.testing_litres || 0),
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
                    <button onClick={() => beginClose(s)} style={{ ...S.btnDanger, padding: '6px 12px' }}><FiStopCircle /> Close</button>
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
                  <strong style={{ fontSize: 13, color: '#374151' }}>Nozzles for this attendant *</strong>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                    {nozzles.map(n => (
                      <label key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={openForm.nozzle_ids.includes(n.id)} onChange={e => {
                          const list = e.target.checked ? [...openForm.nozzle_ids, n.id] : openForm.nozzle_ids.filter(x => x !== n.id);
                          setOpenForm({ ...openForm, nozzle_ids: list });
                        }} />
                        <div>
                          <div><strong>{n.pump_code}-{n.code}</strong></div>
                          <div style={{ fontSize: 12, color: '#6b7280' }}>{n.grade_name} @ {Number(n.current_meter_reading).toFixed(2)} L</div>
                        </div>
                      </label>
                    ))}
                    {nozzles.length === 0 && <div style={{ color: '#6b7280', fontSize: 13 }}>No nozzles configured.</div>}
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
                    <th style={{ ...S.th, textAlign: 'right' }}>Testing</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Litres</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>K/L</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Amount</th>
                  </tr></thead>
                  <tbody>
                    {liveNozzleRows.map(r => (
                      <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={S.td}><strong>{r.pump_code}-{r.nozzle_code}</strong></td>
                        <td style={S.td}><span style={S.pill(r.grade_color || '#6b7280')}>{r.grade_name}</span></td>
                        <td style={S.tdR}>{Number(r.opening_reading).toFixed(2)}</td>
                        <td style={S.tdR}>
                          <input type="number" step="0.01" value={cd.readings[r.id]?.closing_reading ?? ''} onChange={e => setCd({
                            ...cd, readings: { ...cd.readings, [r.id]: { ...cd.readings[r.id], closing_reading: e.target.value } }
                          })} required style={{ ...S.input, width: 120, textAlign: 'right' }} />
                        </td>
                        <td style={S.tdR}>
                          <input type="number" step="0.01" value={cd.readings[r.id]?.testing_litres ?? 0} onChange={e => setCd({
                            ...cd, readings: { ...cd.readings, [r.id]: { ...cd.readings[r.id], testing_litres: e.target.value } }
                          })} style={{ ...S.input, width: 80, textAlign: 'right' }} />
                        </td>
                        <td style={S.tdR}><strong>{r.sold.toFixed(2)}</strong></td>
                        <td style={S.tdR}>K {Number(r.price_per_litre).toFixed(2)}</td>
                        <td style={S.tdR}><strong>K {r.amt.toFixed(2)}</strong></td>
                      </tr>
                    ))}
                    <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                      <td colSpan={5} style={{ ...S.td, textAlign: 'right' }}>TOTAL READING SALES</td>
                      <td style={S.tdR}>{liveNozzleRows.reduce((s, r) => s + r.sold, 0).toFixed(2)}</td>
                      <td style={S.td}></td>
                      <td style={S.tdR}>K {grossSales.toFixed(2)}</td>
                    </tr>
                  </tbody>
                </table>

                {/* ── Section 2: credit sales ──────────────────────── */}
                <SectionHeader title="2. Credit Sales (Receivables)" action={
                  <button type="button" onClick={addCreditSale} style={S.btnSecondary}><FiPlus /> Add Ticket</button>
                } />
                {cd.credit_sales.length === 0 ? (
                  <div style={{ padding: 16, color: '#9ca3af', fontSize: 13, textAlign: 'center', border: '1px dashed #e5e7eb', borderRadius: 6 }}>
                    No credit tickets. Click "+ Add Ticket" for each paper receipt (CAA 3626, IDC, etc.)
                  </div>
                ) : (
                  <table style={S.table}>
                    <thead><tr>
                      <th style={S.th}>Customer *</th><th style={S.th}>Vehicle</th>
                      <th style={S.th}>Grade</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>Litres *</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>K/L</th>
                      <th style={{ ...S.th, textAlign: 'right' }}>Amount</th>
                      <th style={S.th}>Receipt #</th><th style={S.th}></th>
                    </tr></thead>
                    <tbody>
                      {cd.credit_sales.map((c, i) => {
                        const amt = Number(c.litres || 0) * Number(c.price_per_litre || 0);
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={S.td}>
                              <input list="fleet-list" value={c.customer_name} onChange={e => {
                                const match = fleet.find(f => f.name === e.target.value);
                                updCreditSale(i, { customer_name: e.target.value, fleet_customer_id: match?.id || '' });
                              }} style={{ ...S.input, minWidth: 150 }} placeholder="Type or pick…" />
                              <datalist id="fleet-list">
                                {fleet.map(f => <option key={f.id} value={f.name} />)}
                              </datalist>
                            </td>
                            <td style={S.td}><input value={c.vehicle_registration} onChange={e => updCreditSale(i, { vehicle_registration: e.target.value.toUpperCase() })} style={{ ...S.input, width: 100 }} /></td>
                            <td style={S.td}>
                              <select value={c.fuel_grade_id} onChange={e => {
                                const nz = nozzles.find(n => Number(n.grade_id || n.fuel_grade_id || 0) === Number(e.target.value));
                                const price = nz?.price_per_litre || c.price_per_litre;
                                updCreditSale(i, { fuel_grade_id: e.target.value, price_per_litre: price });
                              }} style={{ ...S.input, width: 110 }}>
                                <option value="">—</option>
                                {Array.from(new Map(nozzles.map(n => [n.grade_id || n.fuel_grade_id, n])).values()).map(n => (
                                  <option key={n.grade_id || n.fuel_grade_id} value={n.grade_id || n.fuel_grade_id}>{n.grade_name}</option>
                                ))}
                              </select>
                            </td>
                            <td style={S.tdR}><input type="number" step="0.01" value={c.litres} onChange={e => updCreditSale(i, { litres: e.target.value })} style={{ ...S.input, width: 80, textAlign: 'right' }} /></td>
                            <td style={S.tdR}><input type="number" step="0.01" value={c.price_per_litre} onChange={e => updCreditSale(i, { price_per_litre: e.target.value })} style={{ ...S.input, width: 80, textAlign: 'right' }} /></td>
                            <td style={S.tdR}><strong>K {amt.toFixed(2)}</strong></td>
                            <td style={S.td}><input value={c.receipt_number} onChange={e => updCreditSale(i, { receipt_number: e.target.value })} style={{ ...S.input, width: 90 }} /></td>
                            <td style={S.td}><button type="button" onClick={() => rmCreditSale(i)} style={S.iconBtnDanger}><FiTrash2 /></button></td>
                          </tr>
                        );
                      })}
                      <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                        <td colSpan={5} style={{ ...S.td, textAlign: 'right' }}>TOTAL CREDIT</td>
                        <td style={S.tdR}>K {creditTotal.toFixed(2)}</td>
                        <td colSpan={2} style={S.td}></td>
                      </tr>
                    </tbody>
                  </table>
                )}

                {/* ── Section 3: payment breakdown + dips side by side ── */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 16 }}>
                  <div>
                    <SectionHeader title="3. Payment Breakdown" />
                    <PayRow label="Cash *" value={cd.payment_cash} onChange={v => setCd({ ...cd, payment_cash: v })} highlight />
                    <PayRow label="Swipes" value={cd.payment_swipes} onChange={v => setCd({ ...cd, payment_swipes: v })} />
                    <PayRow label="Engen 1Card" value={cd.payment_1card} onChange={v => setCd({ ...cd, payment_1card: v })} />
                    <PayRow label="Mobile Money" value={cd.payment_mobile} onChange={v => setCd({ ...cd, payment_mobile: v })} />
                    <PayRow label="Other" value={cd.payment_other} onChange={v => setCd({ ...cd, payment_other: v })} />
                    <PayRow label="Credit (auto)" value={creditTotal.toFixed(2)} readOnly />
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
                      <td style={S.td}><strong>{r.pump_code}-{r.nozzle_code}</strong></td>
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
