import React, { useEffect, useState } from 'react';
import { FiDollarSign, FiCheckCircle, FiRefreshCw } from 'react-icons/fi';
import { getDailyRollup, finalizeShift } from '../services/fuelApi';
import { S } from './fuelStyles';

const today = () => new Date().toISOString().slice(0, 10);

export default function FuelCashReport() {
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState([]);
  // per-shift inputs: { [shiftId]: { payment_mobile, payment_swipes, payment_cash } }
  const [inputs, setInputs] = useState({});
  const [saving, setSaving] = useState(null);  // shiftId being saved
  const [msg, setMsg] = useState('');

  const load = async () => {
    setMsg('');
    try {
      const r = await getDailyRollup(date);
      setRows(r.data || []);
      // Prefill inputs from already-saved values (so closed shifts show their reconciled amounts)
      const init = {};
      for (const s of (r.data || [])) {
        init[s.id] = {
          payment_mobile: s.payment_mobile || '',
          payment_swipes: s.payment_swipes || '',
          payment_cash:   s.payment_cash   || '',
          notes:          '',
        };
      }
      setInputs(init);
    } catch (e) { setMsg('Load failed: ' + (e.response?.data?.error || e.message)); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);

  const finalize = async (s) => {
    const ip = inputs[s.id] || {};
    setSaving(s.id); setMsg('');
    try {
      await finalizeShift(s.id, {
        payment_cash:   Number(ip.payment_cash   || 0),
        payment_mobile: Number(ip.payment_mobile || 0),
        payment_swipes: Number(ip.payment_swipes || 0),
        notes:          ip.notes || '',
      });
      await load();
      setMsg(`Shift #${s.id} finalized.`);
    } catch (ex) { setMsg('Finalize failed: ' + (ex.response?.data?.error || ex.message)); }
    finally { setSaving(null); }
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h2 style={S.h2}><FiDollarSign /> Fuel Cash Report</h2>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label style={S.lbl}>Date<input type="date" value={date} onChange={e => setDate(e.target.value)} style={S.input} /></label>
          <button onClick={load} style={S.btnSecondary}><FiRefreshCw /> Refresh</button>
        </div>
      </div>

      {msg && <div style={{ padding: 10, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{msg}</div>}

      {rows.length === 0 ? (
        <div style={{ ...S.card, padding: 40, textAlign: 'center', color: '#6b7280' }}>No shifts for this date.</div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          {rows.map(s => {
            const ip = inputs[s.id] || {};
            const gross = Number(s.gross_from_nozzles || 0);
            const credit = Number(s.credit_total || 0);
            const onecard = Number(s.onecard_total || 0);
            const nonCash = Number(ip.payment_mobile || 0) + Number(ip.payment_swipes || 0) + credit + onecard;
            const expected = Math.max(0, gross - nonCash);
            const variance = Number(ip.payment_cash || 0) - expected;
            const closed = s.status === 'Closed';
            return (
              <div key={s.id} style={S.card}>
                <div style={{ padding: 16, background: '#f9fafb', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <strong style={{ fontSize: 16 }}>{s.attendant_name}</strong>
                    <div style={{ fontSize: 12, color: '#6b7280' }}>Shift #{s.id} · opened {s.opened_at} · <span style={S.pill(closed ? '#6b7280' : '#16a34a')}>{s.status}</span></div>
                  </div>
                  <div>
                    <button onClick={() => finalize(s)} disabled={saving === s.id} style={S.btnPrimary}>
                      <FiCheckCircle /> {saving === s.id ? 'Finalizing…' : (closed ? 'Update' : 'Finalize')}
                    </button>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 12, padding: 16 }}>
                  <StatCell label="Gross" value={`K ${gross.toFixed(2)}`} />
                  <StatCell label="Credit (auto)" value={`K ${credit.toFixed(2)}`} />
                  <StatCell label="1Card (auto)" value={`K ${onecard.toFixed(2)}`} />
                  <StatCell label="Mobile Money" input value={ip.payment_mobile}
                    onChange={v => setInputs({ ...inputs, [s.id]: { ...ip, payment_mobile: v } })} />
                  <StatCell label="Swipes" input value={ip.payment_swipes}
                    onChange={v => setInputs({ ...inputs, [s.id]: { ...ip, payment_swipes: v } })} />
                  <StatCell label="Expected Cash" value={`K ${expected.toFixed(2)}`} highlight />
                  <StatCell label="Actual Cash *" input value={ip.payment_cash}
                    onChange={v => setInputs({ ...inputs, [s.id]: { ...ip, payment_cash: v } })} />
                  <StatCell label="Variance" value={`K ${variance.toFixed(2)}`}
                    color={Math.abs(variance) < 0.01 ? '#111' : (variance < 0 ? '#dc2626' : '#16a34a')} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatCell({ label, value, input, onChange, highlight, color }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {input ? (
        <input type="number" step="0.01" value={value || ''} onChange={e => onChange(e.target.value)} style={{ ...S.input, width: '100%', fontWeight: 700, textAlign: 'right' }} />
      ) : (
        <div style={{ fontSize: 18, fontWeight: 700, color: color || (highlight ? '#2563eb' : '#111') }}>{value}</div>
      )}
    </div>
  );
}
