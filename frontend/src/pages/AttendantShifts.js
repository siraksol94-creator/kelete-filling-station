import React, { useEffect, useState } from 'react';
import { FiPlus, FiX, FiPlay, FiStopCircle, FiClock, FiCheckCircle } from 'react-icons/fi';
import { getShifts, getCurrentShift, getShift, openShift, closeShift, getNozzles } from '../services/fuelApi';
import { getUsers } from '../services/api';
import { S } from './fuelStyles';

export default function AttendantShifts() {
  const [shifts, setShifts] = useState([]);
  const [users, setUsers] = useState([]);
  const [nozzles, setNozzles] = useState([]);
  const [openForm, setOpenForm] = useState(null);   // { attendant_user_id, nozzle_ids: [] }
  const [closingShift, setClosingShift] = useState(null);  // full shift with readings
  const [closingData, setClosingData] = useState({ readings: {}, actual_cash: '', notes: '' });
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const [sh, u, n] = await Promise.all([getShifts(), getUsers(), getNozzles()]);
      setShifts(sh.data || []); setUsers((u.data || []).filter(x => x.status === 'Active')); setNozzles(n.data || []);
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);

  const submitOpen = async (e) => {
    e.preventDefault(); setErr('');
    if (!openForm.attendant_user_id) { setErr('Pick an attendant'); return; }
    if (openForm.nozzle_ids.length === 0) { setErr('Pick at least one nozzle'); return; }
    try {
      await openShift(openForm);
      setOpenForm(null); await load();
    } catch (ex) { setErr(ex.response?.data?.error || 'Open failed'); }
  };

  const beginClose = async (sh) => {
    try {
      const full = (await getShift(sh.id)).data;
      setClosingShift(full);
      const init = {};
      (full.readings || []).forEach(r => { init[r.id] = { closing_reading: r.opening_reading, testing_litres: 0 }; });
      setClosingData({ readings: init, actual_cash: '', notes: '' });
    } catch (e) {}
  };

  const submitClose = async (e) => {
    e.preventDefault(); setErr('');
    const readings = Object.entries(closingData.readings).map(([id, r]) => ({
      id: Number(id),
      closing_reading: Number(r.closing_reading),
      testing_litres: Number(r.testing_litres || 0),
    }));
    try {
      await closeShift(closingShift.id, { readings, actual_cash: Number(closingData.actual_cash) || 0, notes: closingData.notes });
      setClosingShift(null); await load();
    } catch (ex) { setErr(ex.response?.data?.error || 'Close failed'); }
  };

  const expectedPreview = closingShift ? (closingShift.readings || []).reduce((sum, r) => {
    const c = Number(closingData.readings[r.id]?.closing_reading || 0);
    const t = Number(closingData.readings[r.id]?.testing_litres || 0);
    const sold = Math.max(c - r.opening_reading - t, 0);
    return sum + sold * r.price_per_litre;
  }, 0) : 0;

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
            <th style={{ ...S.th, textAlign: 'right' }}>Expected</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Actual</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Variance</th>
            <th style={S.th}></th>
          </tr></thead>
          <tbody>
            {shifts.map(s => (
              <tr key={s.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={S.td}>
                  <span style={S.pill(s.status === 'Open' ? '#16a34a' : '#6b7280')}>{s.status}</span>
                </td>
                <td style={S.td}>{s.attendant_name || `#${s.attendant_user_id}`}</td>
                <td style={S.td}>{s.opened_at}</td>
                <td style={S.td}>{s.closed_at || '-'}</td>
                <td style={S.tdR}>K {Number(s.expected_cash || 0).toFixed(2)}</td>
                <td style={S.tdR}>K {Number(s.actual_cash || 0).toFixed(2)}</td>
                <td style={{ ...S.tdR, color: Math.abs(s.variance || 0) < 0.01 ? '#111' : (s.variance < 0 ? '#dc2626' : '#16a34a') }}>
                  K {Number(s.variance || 0).toFixed(2)}
                </td>
                <td style={S.td}>
                  {s.status === 'Open' && (
                    <button onClick={() => beginClose(s)} style={{ ...S.btnDanger, padding: '6px 12px' }}><FiStopCircle /> Close</button>
                  )}
                </td>
              </tr>
            ))}
            {shifts.length === 0 && <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No shifts yet.</td></tr>}
          </tbody>
        </table>
      </div>

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
                  <strong style={{ fontSize: 13, color: '#374151' }}>Nozzles assigned to this attendant *</strong>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
                    {nozzles.map(n => (
                      <label key={n.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={openForm.nozzle_ids.includes(n.id)} onChange={e => {
                          const list = e.target.checked
                            ? [...openForm.nozzle_ids, n.id]
                            : openForm.nozzle_ids.filter(x => x !== n.id);
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

      {closingShift && (
        <div style={S.backdrop} onClick={() => setClosingShift(null)}>
          <div style={{ ...S.modal, width: 'min(820px, 96vw)' }} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h3 style={{ margin: 0 }}>Close Shift - {closingShift.attendant_name}</h3>
              <button onClick={() => setClosingShift(null)} style={S.iconBtn}><FiX /></button>
            </div>
            <form onSubmit={submitClose}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={{ padding: 20 }}>
                <table style={S.table}>
                  <thead><tr>
                    <th style={S.th}>Nozzle</th><th style={S.th}>Grade</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Opening</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Closing *</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Testing</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Sold</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>K/L</th>
                    <th style={{ ...S.th, textAlign: 'right' }}>Expected</th>
                  </tr></thead>
                  <tbody>
                    {(closingShift.readings || []).map(r => {
                      const c = Number(closingData.readings[r.id]?.closing_reading || 0);
                      const t = Number(closingData.readings[r.id]?.testing_litres || 0);
                      const sold = Math.max(c - r.opening_reading - t, 0);
                      const expected = sold * r.price_per_litre;
                      return (
                        <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={S.td}><strong>{r.pump_code}-{r.nozzle_code}</strong></td>
                          <td style={S.td}><span style={S.pill(r.grade_color || '#6b7280')}>{r.grade_name}</span></td>
                          <td style={S.tdR}>{Number(r.opening_reading).toFixed(2)}</td>
                          <td style={S.tdR}>
                            <input type="number" step="0.01" value={closingData.readings[r.id]?.closing_reading ?? ''} onChange={e => setClosingData({
                              ...closingData,
                              readings: { ...closingData.readings, [r.id]: { ...closingData.readings[r.id], closing_reading: e.target.value } }
                            })} required style={{ ...S.input, width: 110, textAlign: 'right' }} />
                          </td>
                          <td style={S.tdR}>
                            <input type="number" step="0.01" value={closingData.readings[r.id]?.testing_litres ?? 0} onChange={e => setClosingData({
                              ...closingData,
                              readings: { ...closingData.readings, [r.id]: { ...closingData.readings[r.id], testing_litres: e.target.value } }
                            })} style={{ ...S.input, width: 80, textAlign: 'right' }} />
                          </td>
                          <td style={S.tdR}><strong>{sold.toFixed(2)}</strong></td>
                          <td style={S.tdR}>K {Number(r.price_per_litre).toFixed(2)}</td>
                          <td style={S.tdR}><strong>K {expected.toFixed(2)}</strong></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 20 }}>
                  <div style={S.statCard}>
                    <div style={S.statLabel}>Expected Cash</div>
                    <div style={S.statValue}>K {expectedPreview.toFixed(2)}</div>
                  </div>
                  <div style={S.statCard}>
                    <div style={S.statLabel}>Actual Cash *</div>
                    <input type="number" step="0.01" value={closingData.actual_cash} onChange={e => setClosingData({ ...closingData, actual_cash: e.target.value })} required style={{ ...S.input, fontSize: 20, fontWeight: 700, marginTop: 4 }} />
                  </div>
                  <div style={S.statCard}>
                    <div style={S.statLabel}>Variance</div>
                    <div style={{ ...S.statValue, color: Math.abs(Number(closingData.actual_cash || 0) - expectedPreview) < 0.01 ? '#111' : (Number(closingData.actual_cash || 0) < expectedPreview ? '#dc2626' : '#16a34a') }}>
                      K {(Number(closingData.actual_cash || 0) - expectedPreview).toFixed(2)}
                    </div>
                  </div>
                </div>
                <label style={{ ...S.lbl, marginTop: 16 }}>Notes<input value={closingData.notes} onChange={e => setClosingData({ ...closingData, notes: e.target.value })} style={S.input} /></label>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setClosingShift(null)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" style={S.btnPrimary}><FiCheckCircle /> Close Shift</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
