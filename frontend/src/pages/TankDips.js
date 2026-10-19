import React, { useEffect, useState } from 'react';
import { FiActivity, FiRefreshCw, FiCheckCircle, FiClock } from 'react-icons/fi';
import { getTankDips, saveTankDip } from '../services/fuelApi';
import { useAuth } from '../context/AuthContext';
import { S } from './fuelStyles';

const today = () => new Date().toISOString().slice(0, 10);
const fmtL = n => Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' L';

export default function TankDips({ embedded = false } = {}) {
  const { user } = useAuth();   // kept for future per-user controls
  void user;
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState([]);
  // keyed by join of tank_ids so groups and standalone tanks each have a stable row key
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(null);
  const [msg, setMsg] = useState('');

  const rowKey = r => r.tank_ids.join('-');

  const load = async () => {
    setMsg('');
    try {
      const r = await getTankDips(date);
      setRows(r.data?.rows || []);
      const seed = {};
      for (const row of (r.data?.rows || [])) {
        seed[rowKey(row)] = {
          measured: row.measured_litres != null ? String(row.measured_litres) : '',
          notes:    row.dip_notes || '',
        };
      }
      setEdits(seed);
    } catch (e) { setMsg('Load failed: ' + (e.response?.data?.error || e.message)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);

  const save = async (row) => {
    const key = rowKey(row);
    const ip = edits[key] || {};
    if (ip.measured === '' || ip.measured == null) { setMsg('Enter measured litres first.'); return; }
    setSaving(key); setMsg('');
    try {
      await saveTankDip({ tank_ids: row.tank_ids, dip_date: date, measured_litres: Number(ip.measured), notes: ip.notes || '' });
      await load();
      setMsg(`Dip saved for ${row.tank_code}.`);
    } catch (e) { setMsg('Save failed: ' + (e.response?.data?.error || e.message)); }
    finally { setSaving(null); }
  };

  // Per-dip Post Adjustment removed — dips now auto-post when the
  // Administrator approves the day on Fuel Cash Report.

  const body = (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        {!embedded && <h2 style={S.h2}><FiActivity /> Tank Dips</h2>}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginLeft: embedded ? 'auto' : 0 }}>
          <label style={S.lbl}>Date<input type="date" value={date} onChange={e => setDate(e.target.value)} style={S.input} /></label>
          <button onClick={load} style={S.btnSecondary}><FiRefreshCw /> Refresh</button>
        </div>
      </div>

      <div style={{ padding: 10, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, marginBottom: 12, fontSize: 12, color: '#1e3a8a' }}>
        One dip per tank (or per plumbed group) per day. For plumbed groups the measured value is the shared fluid level; the system splits it proportionally into each member tank's ledger.
        Dips auto-post when an <strong>Administrator approves the day</strong> on Fuel Cash Report. Until then they sit as pending checks and do not change the book volume.
      </div>

      {msg && <div style={{ padding: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, marginBottom: 12, fontSize: 13, color: '#166534' }}>{msg}</div>}

      <div style={{ ...S.card, overflowX: 'auto' }}>
        <table style={{ ...S.table, minWidth: 820 }}>
          <thead><tr>
            <th style={{ ...S.th, whiteSpace: 'nowrap' }}>Tank / Group</th>
            <th style={{ ...S.th, whiteSpace: 'nowrap' }}>Grade</th>
            <th style={{ ...S.th, textAlign: 'right', whiteSpace: 'nowrap' }}>Book (L)</th>
            <th style={{ ...S.th, textAlign: 'right', whiteSpace: 'nowrap' }}>Measured (L) *</th>
            <th style={{ ...S.th, textAlign: 'right', whiteSpace: 'nowrap' }}>Variance</th>
            <th style={S.th}>Notes</th>
            <th style={{ ...S.th, whiteSpace: 'nowrap' }}>Taken by</th>
            <th style={S.th}></th>
          </tr></thead>
          <tbody>
            {rows.map(row => {
              const key = rowKey(row);
              const ip = edits[key] || {};
              const measured = Number(ip.measured);
              const liveVariance = isFinite(measured) && ip.measured !== '' ? (measured - Number(row.book_volume || 0)) : null;
              const vColor = liveVariance == null ? '#9ca3af' : (Math.abs(liveVariance) < 0.5 ? '#111' : (liveVariance < 0 ? '#dc2626' : '#16a34a'));
              const fullyPosted = row.posted_count === row.member_count && row.member_count > 0;
              return (
                <tr key={key} style={{ borderBottom: '1px solid #f3f4f6', background: fullyPosted ? '#f9fafb' : '#fff' }}>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    <strong>{row.tank_code}</strong>
                    <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2 }}>{row.tank_name}</div>
                  </td>
                  <td style={S.td}><span style={{ ...S.pill(row.grade_color || '#6b7280'), whiteSpace: 'nowrap' }}>{row.grade_name || '-'}</span></td>
                  <td style={{ ...S.tdR, whiteSpace: 'nowrap' }}>{fmtL(row.book_volume)}</td>
                  <td style={S.tdR}>
                    <input type="number" step="0.01" value={ip.measured || ''}
                      disabled={fullyPosted}
                      onChange={e => setEdits({ ...edits, [key]: { ...ip, measured: e.target.value } })}
                      style={{ ...S.input, width: 140, textAlign: 'right', background: fullyPosted ? '#f3f4f6' : '#fff' }} />
                  </td>
                  <td style={{ ...S.tdR, color: vColor, fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {liveVariance != null ? (liveVariance >= 0 ? '+' : '') + liveVariance.toFixed(2) + ' L' : '—'}
                  </td>
                  <td style={S.td}>
                    <input value={ip.notes || ''}
                      disabled={fullyPosted}
                      onChange={e => setEdits({ ...edits, [key]: { ...ip, notes: e.target.value } })}
                      style={{ ...S.input, minWidth: 160, background: fullyPosted ? '#f3f4f6' : '#fff' }}
                      placeholder="Optional" />
                  </td>
                  <td style={S.td}>{row.taken_by_name || '-'}</td>
                  <td style={S.td}>
                    {fullyPosted ? (
                      <span style={{ ...S.pill('#16a34a'), display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <FiCheckCircle size={12} /> Posted
                      </span>
                    ) : (
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <button onClick={() => save(row)} disabled={saving === key} style={{ ...S.btnPrimary, padding: '6px 10px', fontSize: 12 }}>
                          {saving === key ? 'Saving…' : (row.dip_rows.length > 0 ? 'Update' : 'Save')}
                        </button>
                        {row.dip_rows.length > 0 && (
                          <span style={{ fontSize: 10, padding: '3px 7px', borderRadius: 10, background: '#fffbeb', color: '#92400e', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
                            <FiClock size={11} /> Pending day approval
                          </span>
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
    </>
  );
  return embedded ? body : <div style={S.page}>{body}</div>;
}
