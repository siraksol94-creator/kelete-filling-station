import React, { useEffect, useMemo, useState } from 'react';
import { FiRefreshCw, FiBook } from 'react-icons/fi';
import { getTanks, getTankBinCard } from '../services/fuelApi';
import { S } from './fuelStyles';

// Default range: today only. Backend returns an opening-before line + each
// movement with its running balance, so the operator can see where a tank
// stood at midnight and every row that moved it since.
const today = () => new Date().toISOString().slice(0, 10);
const fmtL = n => Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' L';
const fmtDate = s => (s || '').slice(0, 10);

const TYPE_COLORS = {
  opening:        { bg: '#eef2ff', fg: '#4338ca', label: 'OPENING' },
  delivery:       { bg: '#f0fdf4', fg: '#166534', label: 'DELIVERY' },
  sale:           { bg: '#fef2f2', fg: '#991b1b', label: 'SALE' },
  adjustment:     { bg: '#fffbeb', fg: '#92400e', label: 'ADJUSTMENT' },
  dip_adjustment: { bg: '#fffbeb', fg: '#b45309', label: 'DIP ADJ' },
  reversal:       { bg: '#f3f4f6', fg: '#6b7280', label: 'REVERSAL' },
};

export default function TankLedger({ embedded = false } = {}) {
  const [tanks, setTanks] = useState([]);
  const [tankId, setTankId] = useState('');
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // Load the tank list once; pick the first tank by default so the view
  // isn't a blank screen on open.
  useEffect(() => {
    getTanks().then(r => {
      const list = r.data || [];
      setTanks(list);
      if (list[0] && !tankId) setTankId(String(list[0].id));
    }).catch(() => {});
  // eslint-disable-next-line
  }, []);

  const load = async () => {
    if (!tankId) return;
    setLoading(true); setErr('');
    try {
      const r = await getTankBinCard(tankId, { from, to });
      setData(r.data);
    } catch (e) { setErr(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [tankId, from, to]);

  // Group tanks by group_code in the picker so the operator picks a plumbed
  // pair as easily as a single tank — but still per-tank underneath because
  // the ledger is per physical tank's inflows and outflows.
  const tankOptions = useMemo(() => {
    const groups = {};
    const standalone = [];
    for (const t of tanks) {
      const g = (t.group_code || '').trim();
      if (!g) standalone.push(t);
      else { (groups[g] = groups[g] || []).push(t); }
    }
    const out = [];
    Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).forEach(([code, members]) => {
      members.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
      for (const m of members) out.push({ id: m.id, label: `${m.code} — ${m.grade_name || ''}  (Group ${code})` });
    });
    standalone.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    for (const t of standalone) out.push({ id: t.id, label: `${t.code} — ${t.grade_name || ''}` });
    return out;
  }, [tanks]);

  const body = (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 16 }}>
        {!embedded && <h2 style={{ ...S.h2, margin: 0 }}><FiBook /> Tank Ledger</h2>}
        <label style={S.lbl}>Tank
          <select value={tankId} onChange={e => setTankId(e.target.value)} style={{ ...S.input, minWidth: 220 }}>
            {tankOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label style={S.lbl}>From<input type="date" value={from} onChange={e => setFrom(e.target.value)} style={S.input} /></label>
        <label style={S.lbl}>To<input type="date" value={to} onChange={e => setTo(e.target.value)} style={S.input} /></label>
        <button onClick={load} style={S.btnSecondary}><FiRefreshCw /> Refresh</button>
      </div>

      {err && <div style={{ padding: 10, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, marginBottom: 12, fontSize: 13, color: '#991b1b' }}>{err}</div>}

      {data && (
        <>
          {/* Headline card: tank identity + opening-before + current */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 14 }}>
            <KeyStat label="Tank"           value={data.tank?.code || '—'} />
            <KeyStat label="Opening Before" value={fmtL(data.opening_before)} />
            <KeyStat label="Movements"      value={(data.rows || []).length} />
            <KeyStat label="Current Volume" value={fmtL(data.current_volume)} highlight />
          </div>

          <div style={{ ...S.card, overflowX: 'auto' }}>
            <table style={{ ...S.table, minWidth: 720 }}>
              <thead><tr>
                <th style={{ ...S.th, whiteSpace: 'nowrap' }}>Date</th>
                <th style={{ ...S.th, whiteSpace: 'nowrap' }}>Type</th>
                <th style={{ ...S.th, textAlign: 'right', whiteSpace: 'nowrap' }}>Change</th>
                <th style={{ ...S.th, textAlign: 'right', whiteSpace: 'nowrap' }}>Balance</th>
                <th style={S.th}>Notes</th>
                <th style={{ ...S.th, whiteSpace: 'nowrap' }}>By</th>
              </tr></thead>
              <tbody>
                {(data.rows || []).map(r => {
                  const t = TYPE_COLORS[r.type] || TYPE_COLORS.adjustment;
                  const positive = Number(r.litres) >= 0;
                  return (
                    <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ ...S.td, whiteSpace: 'nowrap' }}>{fmtDate(r.movement_date)}</td>
                      <td style={S.td}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '3px 7px', borderRadius: 10, background: t.bg, color: t.fg, letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>{t.label}</span>
                      </td>
                      <td style={{ ...S.tdR, whiteSpace: 'nowrap', color: positive ? '#16a34a' : '#dc2626', fontWeight: 600 }}>
                        {positive ? '+' : ''}{fmtL(r.litres)}
                      </td>
                      <td style={{ ...S.tdR, whiteSpace: 'nowrap', fontWeight: 700 }}>{fmtL(r.balance_after)}</td>
                      <td style={S.td}>{r.notes || '—'}</td>
                      <td style={{ ...S.td, whiteSpace: 'nowrap', color: '#6b7280', fontSize: 12 }}>{r.created_by_name || '—'}</td>
                    </tr>
                  );
                })}
                {(data.rows || []).length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No movements in this date range.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!data && !loading && <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>Pick a tank to view its ledger.</div>}
    </>
  );
  return embedded ? body : <div style={S.page}>{body}</div>;
}

function KeyStat({ label, value, highlight }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: highlight ? '#2563eb' : '#111', marginTop: 4 }}>{value}</div>
    </div>
  );
}
