import React, { useEffect, useState } from 'react';
import { FiActivity, FiRefreshCw, FiCheckCircle, FiAlertCircle } from 'react-icons/fi';
import { getTankDips, saveTankDip, postTankDipAdjustment } from '../services/fuelApi';
import { useAuth } from '../context/AuthContext';
import { S } from './fuelStyles';

const today = () => new Date().toISOString().slice(0, 10);
const fmtL = n => Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' L';

export default function TankDips() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Administrator';
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState([]);
  const [edits, setEdits] = useState({});   // { tank_id: { measured, notes } }
  const [saving, setSaving] = useState(null);
  const [msg, setMsg] = useState('');

  const load = async () => {
    setMsg('');
    try {
      const r = await getTankDips(date);
      setRows(r.data?.rows || []);
      const seed = {};
      for (const row of (r.data?.rows || [])) {
        seed[row.tank_id] = {
          measured: row.measured_litres != null ? String(row.measured_litres) : '',
          notes:    row.dip_notes || '',
        };
      }
      setEdits(seed);
    } catch (e) { setMsg('Load failed: ' + (e.response?.data?.error || e.message)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);

  const save = async (row) => {
    const ip = edits[row.tank_id] || {};
    if (ip.measured === '' || ip.measured == null) { setMsg('Enter measured litres first.'); return; }
    setSaving(row.tank_id); setMsg('');
    try {
      await saveTankDip({ tank_id: row.tank_id, dip_date: date, measured_litres: Number(ip.measured), notes: ip.notes || '' });
      await load();
      setMsg(`Dip saved for ${row.tank_code}.`);
    } catch (e) { setMsg('Save failed: ' + (e.response?.data?.error || e.message)); }
    finally { setSaving(null); }
  };

  const postAdjustment = async (row) => {
    if (!window.confirm(
      `Post dip adjustment for ${row.tank_code}?\n\n` +
      `This will write a ledger adjustment of ${Number(row.variance).toFixed(2)} L and move the tank's book volume to match the measured dip (${Number(row.measured_litres).toFixed(2)} L).\n\n` +
      `Cannot be undone from this page — a reversal row would need to be posted manually.`
    )) return;
    setSaving(row.tank_id); setMsg('');
    try { await postTankDipAdjustment(row.dip_id); await load(); setMsg(`Adjustment posted for ${row.tank_code}.`); }
    catch (e) { setMsg('Post failed: ' + (e.response?.data?.error || e.message)); }
    finally { setSaving(null); }
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h2 style={S.h2}><FiActivity /> Tank Dips</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label style={S.lbl}>Date<input type="date" value={date} onChange={e => setDate(e.target.value)} style={S.input} /></label>
          <button onClick={load} style={S.btnSecondary}><FiRefreshCw /> Refresh</button>
        </div>
      </div>

      <div style={{ padding: 10, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, marginBottom: 12, fontSize: 12, color: '#1e3a8a' }}>
        One dip per tank per day. The dip is a <strong>check</strong> — it does not change the tank's book volume on its own.
        An Administrator can click <strong>Post Adjustment</strong> to accept the dip as truth; that writes a ledger adjustment row with the variance.
      </div>

      {msg && <div style={{ padding: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, marginBottom: 12, fontSize: 13, color: '#166534' }}>{msg}</div>}

      <div style={S.card}>
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>Tank</th>
            <th style={S.th}>Grade</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Book (L)</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Measured (L) *</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Variance</th>
            <th style={S.th}>Notes</th>
            <th style={S.th}>Taken by</th>
            <th style={S.th}></th>
          </tr></thead>
          <tbody>
            {rows.map(row => {
              const ip = edits[row.tank_id] || {};
              const measured = Number(ip.measured);
              const liveVariance = isFinite(measured) && ip.measured !== '' ? (measured - Number(row.book_volume || 0)) : null;
              const vColor = liveVariance == null ? '#9ca3af' : (Math.abs(liveVariance) < 0.5 ? '#111' : (liveVariance < 0 ? '#dc2626' : '#16a34a'));
              const posted = !!row.posted_adjustment_id;
              return (
                <tr key={row.tank_id} style={{ borderBottom: '1px solid #f3f4f6', background: posted ? '#f9fafb' : '#fff' }}>
                  <td style={S.td}><strong>{row.tank_code}</strong> <span style={{ color: '#9ca3af' }}>— {row.tank_name}</span></td>
                  <td style={S.td}><span style={S.pill(row.grade_color || '#6b7280')}>{row.grade_name || '-'}</span></td>
                  <td style={S.tdR}>{fmtL(row.book_volume)}</td>
                  <td style={S.tdR}>
                    <input type="number" step="0.01" value={ip.measured || ''}
                      disabled={posted}
                      onChange={e => setEdits({ ...edits, [row.tank_id]: { ...ip, measured: e.target.value } })}
                      style={{ ...S.input, width: 130, textAlign: 'right', background: posted ? '#f3f4f6' : '#fff' }} />
                  </td>
                  <td style={{ ...S.tdR, color: vColor, fontWeight: 600 }}>
                    {liveVariance != null ? (liveVariance >= 0 ? '+' : '') + liveVariance.toFixed(2) + ' L' : '—'}
                  </td>
                  <td style={S.td}>
                    <input value={ip.notes || ''}
                      disabled={posted}
                      onChange={e => setEdits({ ...edits, [row.tank_id]: { ...ip, notes: e.target.value } })}
                      style={{ ...S.input, minWidth: 160, background: posted ? '#f3f4f6' : '#fff' }}
                      placeholder="Optional" />
                  </td>
                  <td style={S.td}>{row.taken_by_name || '-'}</td>
                  <td style={S.td}>
                    {posted ? (
                      <span style={{ ...S.pill('#16a34a'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <FiCheckCircle size={12} /> Posted
                      </span>
                    ) : (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={() => save(row)} disabled={saving === row.tank_id} style={{ ...S.btnPrimary, padding: '6px 10px', fontSize: 12 }}>
                          {saving === row.tank_id ? 'Saving…' : (row.dip_id ? 'Update' : 'Save')}
                        </button>
                        {isAdmin && row.dip_id && Math.abs(Number(row.variance || 0)) >= 0.01 && (
                          <button onClick={() => postAdjustment(row)}
                            style={{ ...S.btnSecondary, padding: '6px 10px', fontSize: 12, color: '#b45309', borderColor: '#fcd34d', background: '#fffbeb' }}
                            title="Accept dip as new book volume — writes a ledger adjustment">
                            <FiAlertCircle size={12} /> Post Adjustment
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No tanks.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
