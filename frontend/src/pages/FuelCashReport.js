import React, { useEffect, useState } from 'react';
import { FiDollarSign, FiCheckCircle, FiRefreshCw } from 'react-icons/fi';
import { getDailyRollup, finalizeShift, getDaySummary } from '../services/fuelApi';
import { S } from './fuelStyles';

const today = () => new Date().toISOString().slice(0, 10);

export default function FuelCashReport() {
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  // per-shift inputs: { [shiftId]: { payment_mobile, payment_swipes, payment_cash } }
  const [inputs, setInputs] = useState({});
  const [saving, setSaving] = useState(null);  // shiftId being saved
  const [msg, setMsg] = useState('');

  const load = async () => {
    setMsg('');
    try {
      const [r, sm] = await Promise.all([getDailyRollup(date), getDaySummary(date)]);
      setRows(r.data || []);
      setSummary(sm.data || null);
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

      {summary && (rows.length > 0 || (summary.pumpGrades || []).length > 0) && (
        <DaySummaryPanel summary={summary} liveOverride={liveTotals(rows, inputs)} />
      )}
    </div>
  );
}

// Sum what the user is CURRENTLY typing in the per-shift inputs so the
// Day Summary totals move in real time (backend summary is the saved
// baseline, we just substitute mobile/swipes/cash with the live typed
// values and recompute deductions + variance).
function liveTotals(rows, inputs) {
  const num = v => Number(v || 0);
  let mobile = 0, swipes = 0, cash = 0;
  for (const r of rows) {
    const ip = inputs[r.id] || {};
    mobile += num(ip.payment_mobile !== '' ? ip.payment_mobile : r.payment_mobile);
    swipes += num(ip.payment_swipes !== '' ? ip.payment_swipes : r.payment_swipes);
    cash   += num(ip.payment_cash   !== '' ? ip.payment_cash   : r.payment_cash);
  }
  return { mobile, swipes, cash };
}

function fmtK(n)   { return 'K ' + Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtL(n)   { return Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' L'; }

function DaySummaryPanel({ summary, liveOverride }) {
  const { pumpGrades = [], dips = [], credits = [], onecards = [], deductions = {}, totals = {} } = summary;

  // Swap in the live typed amounts (if any) and recompute totals so the
  // panel updates as the operator types mobile/swipes/actual-cash per shift.
  const mobileMoney = liveOverride ? liveOverride.mobile : Number(deductions.mobile_money || 0);
  const swipesAmt   = liveOverride ? liveOverride.swipes : Number(deductions.swipes || 0);
  const cashInHand  = liveOverride ? liveOverride.cash   : Number(totals.cash_in_hand || 0);
  const creditTotal = Number(deductions.credit_total || 0);
  const onecardTotal = Number(deductions.onecard_total || 0);
  const totalDeductions = mobileMoney + swipesAmt + creditTotal + onecardTotal;
  const gross = Number(totals.gross || 0);
  const expectedCash = Math.max(0, gross - totalDeductions);
  const variance = Number((cashInHand - expectedCash).toFixed(2));

  // Group pumpGrades by pump for display
  const byPump = {};
  for (const r of pumpGrades) {
    const k = r.pump_id;
    if (!byPump[k]) byPump[k] = { pump_code: r.pump_code, pump_name: r.pump_name, items: [] };
    byPump[k].items.push(r);
  }
  const pumpList = Object.values(byPump);
  const fuelTotal = pumpGrades.reduce((s, r) => s + Number(r.amount || 0), 0);

  // Per-grade day totals (Petrol / Diesel / etc.) rolled up across every
  // pump so the operator can see 'how much fuel of each kind went out today'
  // in one glance, not spread over Pump 1/2/3 lines.
  const byGrade = {};
  for (const r of pumpGrades) {
    if (!r.grade_id) continue;
    if (!byGrade[r.grade_id]) byGrade[r.grade_id] = { grade_id: r.grade_id, grade_name: r.grade_name, grade_color: r.grade_color, litres: 0, amount: 0 };
    byGrade[r.grade_id].litres += Number(r.litres || 0);
    byGrade[r.grade_id].amount += Number(r.amount || 0);
  }
  const gradeList = Object.values(byGrade).sort((a, b) => (a.grade_name || '').localeCompare(b.grade_name || ''));

  const col = { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 };
  const colTitle = { fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10, paddingBottom: 8, borderBottom: '2px solid #e5e7eb' };
  const line = { display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 };
  const totLine = { ...line, marginTop: 8, paddingTop: 8, borderTop: '1px solid #e5e7eb', fontWeight: 700, fontSize: 14 };

  return (
    <div style={{ marginTop: 20 }}>
      <h3 style={{ fontSize: 15, fontWeight: 700, color: '#111', marginBottom: 10 }}>Day Summary</h3>

      {/* Per-grade totals banner — the 'how much Petrol / Diesel today' answer */}
      {gradeList.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(gradeList.length, 4)}, 1fr)`, gap: 12, marginBottom: 12 }}>
          {gradeList.map(g => (
            <div key={g.grade_id} style={{ background: '#fff', border: '1px solid #e5e7eb', borderLeft: `4px solid ${g.grade_color || '#2563eb'}`, borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Total {g.grade_name} Sold
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: '#111', marginTop: 4 }}>{fmtL(g.litres)}</div>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>{fmtK(g.amount)}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>

        {/* Column 1: Fuel Sales per Pump × Grade */}
        <div style={col}>
          <div style={colTitle}>Fuel Sales</div>
          {pumpList.length === 0 ? <div style={{ fontSize: 13, color: '#9ca3af' }}>No readings.</div> : pumpList.map(p => (
            <div key={p.pump_code} style={{ marginBottom: 8 }}>
              {p.items.map(it => (
                <div key={it.grade_id} style={line}>
                  <span>{p.pump_code} {it.grade_name}</span>
                  <span style={{ color: '#6b7280' }}>{fmtL(it.litres)}</span>
                  <span style={{ fontWeight: 600, minWidth: 90, textAlign: 'right' }}>{fmtK(it.amount)}</span>
                </div>
              ))}
            </div>
          ))}
          <div style={totLine}>
            <span>TOTAL FUEL SALES</span>
            <span style={{ color: '#2563eb' }}>{fmtK(fuelTotal)}</span>
          </div>
        </div>

        {/* Column 2: Dip vs Reading per grade */}
        <div style={col}>
          <div style={colTitle}>Dip vs Reading</div>
          {dips.length === 0 ? <div style={{ fontSize: 13, color: '#9ca3af' }}>No dips.</div> : dips.map(d => {
            const varColor = Math.abs(d.variance) < 0.5 ? '#111' : (d.variance < 0 ? '#dc2626' : '#16a34a');
            return (
              <div key={d.grade_id} style={{ marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: d.grade_color || '#111', marginBottom: 4 }}>{(d.grade_name || '').toUpperCase()}</div>
                <div style={line}><span style={{ color: '#6b7280' }}>Dip</span><span>{fmtL(d.dip_total)}</span></div>
                <div style={line}><span style={{ color: '#6b7280' }}>Read</span><span>{fmtL(d.reading_total)}</span></div>
                <div style={line}><span style={{ color: '#6b7280' }}>Variance</span><span style={{ color: varColor, fontWeight: 600 }}>{fmtL(d.variance)}</span></div>
              </div>
            );
          })}
        </div>

        {/* Column 3: Deductions + Cash */}
        <div style={col}>
          <div style={colTitle}>Deductions &amp; Cash</div>
          <div style={line}><span>Swipes</span><span>{fmtK(swipesAmt)}</span></div>
          <div style={line}><span>Mobile Money</span><span>{fmtK(mobileMoney)}</span></div>

          <div style={{ ...line, marginTop: 6, color: '#6b7280', fontWeight: 600 }}><span>Engen 1Card</span><span>{fmtK(onecardTotal)}</span></div>
          {onecards.map((c, i) => (
            <div key={i} style={{ ...line, paddingLeft: 10, fontSize: 12, color: '#6b7280' }}>
              <span>{c.customer_name}{c.card_number ? ` (${c.card_number})` : ''}</span>
              <span>{fmtK(c.total)}</span>
            </div>
          ))}

          <div style={{ ...line, marginTop: 6, color: '#6b7280', fontWeight: 600 }}><span>Credit</span><span>{fmtK(creditTotal)}</span></div>
          {credits.map((c, i) => (
            <div key={i} style={{ ...line, paddingLeft: 10, fontSize: 12, color: '#6b7280' }}>
              <span>{c.customer_name}</span>
              <span>{fmtK(c.total)}</span>
            </div>
          ))}

          <div style={totLine}><span>TOTAL DEDUCTIONS</span><span>{fmtK(totalDeductions)}</span></div>
          <div style={{ ...totLine, borderTop: 'none', marginTop: 4 }}>
            <span>EXPECTED CASH</span>
            <span style={{ color: '#2563eb' }}>{fmtK(expectedCash)}</span>
          </div>
          <div style={{ ...line, fontWeight: 700, fontSize: 14 }}><span>CASH IN HAND</span><span>{fmtK(cashInHand)}</span></div>
          <div style={{ ...line, fontWeight: 700, fontSize: 14 }}>
            <span>VARIANCE</span>
            <span style={{ color: Math.abs(variance) < 0.01 ? '#111' : (variance < 0 ? '#dc2626' : '#16a34a') }}>{fmtK(variance)}</span>
          </div>
        </div>
      </div>
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
