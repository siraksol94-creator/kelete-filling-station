import React, { useEffect, useMemo, useState } from 'react';
import { FiActivity, FiRefreshCw, FiCheckCircle, FiClock } from 'react-icons/fi';
import { getTankDips, saveTankDip } from '../services/fuelApi';
import { useAuth } from '../context/AuthContext';
import { S } from './fuelStyles';
import { businessToday } from '../utils/businessDate';
import { dipProgress } from '../ux/fuelProgress';
// UX-7 — dip ring and the ±0.5% / ±1% variance band (variance always in full).
import { Ring } from '../ux/ForecourtKit';
import { dipBand, fmtSignedL } from '../ux/forecourt';
import FuelLoader from '../ux/FuelLoader';

const today = () => businessToday();
const fmtL = n => Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' L';

export default function TankDips({ embedded = false } = {}) {
  const { user } = useAuth();   // kept for future per-user controls
  void user;
  const [date, setDate] = useState(today());
  // DAY/NIGHT selector — defaults by current hour (06:00-17:59 = DAY).
  const defaultType = () => (new Date().getHours() >= 6 && new Date().getHours() < 18) ? 'DAY' : 'NIGHT';
  const [shiftType, setShiftType] = useState(defaultType());
  const [rows, setRows] = useState([]);
  // keyed by join of tank_ids so groups and standalone tanks each have a stable row key
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(null);
  const [msg, setMsg] = useState('');
  const [loaded, setLoaded] = useState(false);   // UX-1

  const rowKey = r => r.tank_ids.join('-');
  // UX-1 — a tank can't hold negative litres: say so at the box and don't send it.
  const fieldError = (v) => (v !== '' && v != null && Number(v) < 0) ? "Can't be negative" : '';
  const progress = useMemo(() => dipProgress(rows, edits), [rows, edits]);   // same key as rowKey

  const load = async () => {
    setMsg('');
    try {
      const r = await getTankDips({ date, shift_type: shiftType });
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
    setLoaded(true);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date, shiftType]);

  const save = async (row) => {
    const key = rowKey(row);
    const ip = edits[key] || {};
    if (ip.measured === '' || ip.measured == null) { setMsg('Enter measured litres first.'); return; }
    if (fieldError(ip.measured)) { setMsg(`${row.tank_code}: measured litres can't be negative.`); return; }
    setSaving(key); setMsg('');
    try {
      await saveTankDip({ tank_ids: row.tank_ids, shift_type: shiftType, dip_date: date, measured_litres: Number(ip.measured), notes: ip.notes || '' });
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
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginLeft: embedded ? 'auto' : 0, flexWrap: 'wrap' }}>
          <label style={S.lbl}>Date<input type="date" value={date} onChange={e => setDate(e.target.value)} style={S.input} /></label>
          <label style={S.lbl}>Shift
            <select value={shiftType} onChange={e => setShiftType(e.target.value)} style={{ ...S.input, minWidth: 140 }}>
              <option value="DAY">DAY</option>
              <option value="NIGHT">NIGHT</option>
            </select>
          </label>
          <button onClick={load} style={S.btnSecondary}><FiRefreshCw /> Refresh</button>
        </div>
      </div>

      <div className="k-dip-note">
        One dip per tank (or per plumbed group) per <strong>SHIFT</strong> (DAY and NIGHT reconcile independently). Plumbed groups' measured value is the shared fluid level — split proportionally into each member tank's ledger.
        Dips auto-post when an <strong>Administrator approves the SHIFT</strong> on Fuel Cash Report. Until then they sit as pending checks and do not change the book volume.
      </div>

      {msg && <div role="status" style={{ padding: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, marginBottom: 12, fontSize: 13, color: '#166534' }}>{msg}</div>}

      {loaded && rows.length > 0 && (
        <div className="k-panel k-dip-round" style={{ marginBottom: 12 }}>
          <Ring value={progress.saved} max={progress.total} label={`Tanks dipped for the ${shiftType} shift`} sub="dipped" size={84} />
          <div style={{ flex: 1, minWidth: 0 }}>
          <div className="k-panel-row" style={{ marginBottom: 8 }}>
            <span className="k-panel-title">
              {progress.complete ? <span className="k-ok-text">✓ Every tank dipped for the {shiftType} shift</span> : `Tanks dipped for the ${shiftType} shift`}
            </span>
            <span className="k-muted">
              {progress.saved} of {progress.total} saved
              {progress.typedNotSaved > 0 && <strong style={{ color: '#b45309' }}> · {progress.typedNotSaved} typed but not saved</strong>}
              <span className="k-hide-sm"> · Enter in a box saves that row</span>
            </span>
          </div>
          <div className="k-dip-legend" aria-label="What the variance colours mean">
            <span className="k-fc-band k-fc-band-ok">Within 0.5%</span>
            <span className="k-fc-band k-fc-band-watch">0.5–1% out</span>
            <span className="k-fc-band k-fc-band-high">Over 1% out</span>
            <span className="k-muted">of the book litres · the variance is always shown in full</span>
          </div>
          </div>
        </div>
      )}

      <div style={{ ...S.card, overflowX: 'auto' }}>
        {!loaded ? <FuelLoader message="Dipping the tanks…" /> : (
        <table style={{ ...S.table, minWidth: 820 }} className="phone-cards">
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
            {rows.map((row, idx) => {
              const key = rowKey(row);
              const ip = edits[key] || {};
              const measured = Number(ip.measured);
              const liveVariance = isFinite(measured) && ip.measured !== '' ? (measured - Number(row.book_volume || 0)) : null;
              const band = liveVariance == null ? null : dipBand(liveVariance, row.book_volume);
              const fullyPosted = row.posted_count === row.member_count && row.member_count > 0;
              return (
                <tr key={key} style={{ borderBottom: '1px solid #f3f4f6', background: fullyPosted ? '#f9fafb' : '#fff' }}>
                  <td style={{ ...S.td, whiteSpace: 'nowrap' }}>
                    <strong>{row.tank_code}</strong>
                    <div style={{ color: '#6b7280', fontSize: 11, marginTop: 2 }}>{row.tank_name}</div>
                  </td>
                  <td style={S.td}><span style={{ ...S.pill(row.grade_color || '#6b7280'), whiteSpace: 'nowrap' }}>{row.grade_name || '-'}</span></td>
                  <td style={{ ...S.tdR, whiteSpace: 'nowrap' }}>{fmtL(row.book_volume)}</td>
                  <td style={S.tdR}>
                    <input type="number" step="0.01" min="0" inputMode="decimal" value={ip.measured || ''}
                      disabled={fullyPosted}
                      data-k-dip={idx}
                      aria-label={`Measured litres for ${row.tank_code}`}
                      aria-invalid={fieldError(ip.measured) ? 'true' : undefined}
                      onChange={e => setEdits({ ...edits, [key]: { ...ip, measured: e.target.value } })}
                      onKeyDown={e => {
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        if (!fieldError(ip.measured) && ip.measured !== '' && saving !== key) save(row);
                        e.currentTarget.closest('table')?.querySelector(`[data-k-dip="${idx + 1}"]`)?.focus();
                      }}
                      style={{ ...S.input, width: 140, textAlign: 'right', background: fullyPosted ? '#f3f4f6' : '#fff', borderColor: fieldError(ip.measured) ? '#b91c1c' : undefined }} />
                    {fieldError(ip.measured) && <div className="k-field-error" role="alert">{fieldError(ip.measured)}</div>}
                  </td>
                  <td style={{ ...S.tdR, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {liveVariance != null ? (
                      <div className="k-dip-var">
                        <span>{fmtSignedL(liveVariance)}</span>
                        {band && <span className={`k-fc-band k-fc-band-${band.level}`}>{band.label}</span>}
                      </div>
                    ) : <span className="k-muted">—</span>}
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
                        <button onClick={() => save(row)} disabled={saving === key || !!fieldError(ip.measured)} style={{ ...S.btnPrimary, padding: '6px 10px', fontSize: 12 }}>
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
        )}
      </div>
    </>
  );
  return embedded ? body : <div style={S.page} className="k-page">{body}</div>;
}
