import React, { useEffect, useMemo, useState } from 'react';
import { FiDollarSign, FiCheckCircle, FiRefreshCw, FiShield, FiUnlock, FiLock } from 'react-icons/fi';
import { getDailyRollup, finalizeShift, getDaySummary, approveShift, unApproveShift, getShifts } from '../services/fuelApi';
import { useAuth } from '../context/AuthContext';
import { S, shade } from './fuelStyles';
import { businessToday } from '../utils/businessDate';
import { useHotkeys } from '../ux/useHotkeys';
import { dayProgress, shiftSteps } from '../ux/fuelProgress';
import { StepTrail, ShortcutHelp, ShortcutHint } from '../ux/components';
import FuelLoader from '../ux/FuelLoader';
import AttendantAvatar, { Celebration } from '../ux/AttendantAvatar';
import { profileFor, milestones } from '../ux/attendantLevel';
// UX-10 — shared header, in-app dialogs, the station-day ring.
import { PageHero, EmptyState, useDialog } from '../ux/ForecourtKit';
import StationDay from '../ux/StationDay';

// "YYYY-MM-DD" ± n days, on the calendar (no time zone involved).
function shiftDate(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

const today = () => businessToday(); // station's day, not the UTC date

export default function FuelCashReport() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Administrator';
  const [date, setDate] = useState(today());
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  // Approval is now PER SHIFT; each row's .approval field carries it.
  const [inputs, setInputs] = useState({});
  const [saving, setSaving] = useState(null);  // shiftId being saved
  const [approving, setApproving] = useState(null);  // shiftId being (un)approved
  const [msg, setMsg] = useState('');
  const [dialog, ui] = useDialog();   // UX-10: in-app confirm
  const [loaded, setLoaded] = useState(false);     // UX-1: skeleton until the first answer
  const [helpOpen, setHelpOpen] = useState(false);
  // UX-2 — shift history for attendant levels/badges (read-only; same list as Attendant Shifts)
  const [history, setHistory] = useState([]);
  const [celebrate, setCelebrate] = useState(null);
  const loadHistory = async () => { try { const h = (await getShifts()).data || []; setHistory(h); return h; } catch (e) { return null; } };
  useEffect(() => { loadHistory(); /* eslint-disable-next-line */ }, []);
  const profileOf = (s, list = history) => profileFor(list, { id: s.attendant_user_id, name: s.attendant_name });

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
          payment_other:  s.payment_other  || '',
          payment_cash:   s.payment_cash   || '',
          notes:          '',
        };
      }
      setInputs(init);
    } catch (e) { setMsg('Load failed: ' + (e.response?.data?.error || e.message)); }
    setLoaded(true);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date]);

  // UX-1 — day progress (closed → cash entered → approved), from saved figures.
  const progress = useMemo(() => dayProgress(rows), [rows]);

  // Fast entry: Enter moves to the next box on the same shift card;
  // Ctrl+Enter finalises the card you're typing in (same as its button).
  const cardKeyDown = (e, s) => {
    if (e.target.tagName !== 'INPUT') return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!s.approval && saving !== s.id) finalize(s);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const boxes = Array.from(e.currentTarget.querySelectorAll('input:not([readonly])'));
      const i = boxes.indexOf(e.target);
      (boxes[i + 1] || e.currentTarget.querySelector('[data-k-finalize]'))?.focus();
    }
  };
  const bindings = [
    { combo: '[', label: 'Previous day', run: () => setDate(d => shiftDate(d, -1)) },
    { combo: ']', label: 'Next day', run: () => setDate(d => shiftDate(d, 1)) },
    { combo: 't', label: 'Today', run: () => setDate(today()) },
    { combo: 'r', label: 'Refresh', run: () => load() },
    { combo: '?', run: () => setHelpOpen(true), enabled: !helpOpen },
  ];
  useHotkeys(bindings);
  const helpList = [
    ...bindings,
    { combo: 'enter', label: 'Next box on the same shift card' },
    { combo: 'mod+enter', label: 'Finalise the shift card you are typing in' },
  ];

  const approve = async (shiftType) => {
    const windowShifts = rows.filter(r => (r.shift_type || 'DAY') === shiftType);
    if (windowShifts.length === 0) { setMsg(`No ${shiftType} shifts to approve.`); return; }
    if (windowShifts.some(r => r.status === 'Open')) { setMsg(`Close + finalize all ${shiftType} shifts first.`); return; }
    if (!(await ui.confirm({ title: `Approve ${shiftType} shift`, okLabel: 'Approve', text:
      `Approve ${shiftType} shift of ${date}?\n\n` +
      `This will:\n` +
      `  • Auto-post every un-posted dip for ${shiftType} as a ledger adjustment.\n` +
      `  • Lock Mobile Money / Swipes / Actual Cash on EVERY ${shiftType} attendant.\n\n` +
      `To change anything afterwards you must Un-approve first.` }))) return;
    setApproving(shiftType); setMsg('');
    try {
      const r = await approveShift(date, shiftType);
      await load();
      setMsg(`${shiftType} shift approved. ${r.data.dips_posted} dip adjustment(s) posted.`);
    } catch (e) { setMsg('Approve failed: ' + (e.response?.data?.error || e.message)); }
    finally { setApproving(null); }
  };

  const unApprove = async (shiftType) => {
    if (!(await ui.confirm({ title: `Un-approve ${shiftType} shift`, okLabel: 'Un-approve', danger: true, text:
      `Un-approve ${shiftType} shift of ${date}?\n\n` +
      `Cash inputs re-open for editing on every ${shiftType} attendant. Posted dip adjustments on the ledger are NOT reversed — if you need to undo those post a manual counter-adjustment in Tank Ledger.` }))) return;
    setApproving(shiftType); setMsg('');
    try { await unApproveShift(date, shiftType); await load(); setMsg(`${shiftType} shift un-approved.`); }
    catch (e) { setMsg('Un-approve failed: ' + (e.response?.data?.error || e.message)); }
    finally { setApproving(null); }
  };

  const finalize = async (s) => {
    const ip = inputs[s.id] || {};
    const before = profileOf(s);
    setSaving(s.id); setMsg('');
    try {
      await finalizeShift(s.id, {
        payment_cash:   Number(ip.payment_cash   || 0),
        payment_mobile: Number(ip.payment_mobile || 0),
        payment_swipes: Number(ip.payment_swipes || 0),
        payment_other:  Number(ip.payment_other  || 0),
        notes:          ip.notes || '',
      });
      await load();
      setMsg(`Shift #${s.id} finalized.`);
      const fresh = await loadHistory();
      if (fresh) {
        const items = milestones(before, profileOf(s, fresh));
        if (items.length) setCelebrate({ who: s.attendant_name, items });
      }
    } catch (ex) { setMsg('Finalize failed: ' + (ex.response?.data?.error || ex.message)); }
    finally { setSaving(null); }
  };

  return (
    <div style={S.page} className="k-page">
      <PageHero icon={<FiDollarSign />} title="Fuel Cash Report" date={date}
        subtitle="Count each attendant's cash against the meters, then approve the shift"
        actions={<>
          <label className="k-fc-hero-date"><span>Date</span><input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
          <button type="button" onClick={load} className="k-fc-btn-ghost"><FiRefreshCw /> Refresh</button>
          <ShortcutHint onClick={() => setHelpOpen(true)} />
        </>} />

      {loaded && <StationDay date={date} compact refresh={rows.map(x => `${x.id}:${x.status}:${x.payment_cash || 0}:${x.approved_at || ''}`).join('|') + msg} />}

      {msg && <div role="status" style={{ padding: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderLeft: '4px solid #f59e0b', borderRadius: 10, marginBottom: 12, fontSize: 13, color: '#0f172a' }}>{msg}</div>}

      {loaded && rows.length > 0 && (
        <div className="k-panel" style={{ marginBottom: 16 }}>
          <div className="k-panel-row" style={{ marginBottom: 8 }}>
            <span className="k-panel-title">
              {progress.complete ? <span className="k-ok-text">✓ Day reconciled — every shift closed, cash entered and approved</span> : 'Day reconciliation'}
            </span>
            <span className="k-muted">{progress.stepsDone} of {progress.stepsTotal} steps</span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 24px', marginTop: 10 }}>
            {progress.windows.map(w => (
              <span key={w.shiftType} className="k-muted">
                <strong style={{ color: '#0f172a' }}>{w.shiftType}</strong>{' · '}
                closed {w.closed}/{w.shifts} · cash {w.cash}/{w.shifts} · approved {w.approved}/{w.shifts}
                {w.complete && <span className="k-ok-text"> ✓</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {!loaded ? (
        <div style={S.card}><FuelLoader message="Loading the day's shifts…" /></div>
      ) : rows.length === 0 ? (
        <div style={{ ...S.card, padding: 0 }}><EmptyState art={<FiDollarSign size={44} color="#b45309" />} title="No shifts on this day" text="Pick another date with the arrows ([ and ]) or the date box, or open a shift on Attendant Shifts." /></div>
      ) : (
        ['DAY', 'NIGHT'].map(shiftType => {
          const windowShifts = rows.filter(r => (r.shift_type || 'DAY') === shiftType);
          if (windowShifts.length === 0) return null;
          const approval = windowShifts.find(r => r.approval)?.approval || null;
          const anyOpen = windowShifts.some(r => r.status === 'Open');
          return (
            <section key={shiftType} className={`k-cr-window${approval ? ' is-approved' : ''}`} aria-label={`${shiftType} shift`}>
              <header className="k-cr-window-head">
                <div className="k-cr-window-title">
                  <span className={`k-cr-shift-tag is-${shiftType.toLowerCase()}`}>{shiftType === 'DAY' ? '☀' : '☾'} {shiftType} SHIFT</span>
                  <span className="k-muted">{windowShifts.length} attendant{windowShifts.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="k-cr-approval">
                  {approval ? (
                    <span className="k-cr-approved"><FiShield aria-hidden="true" /> Approved by {approval.approved_by_name || '—'} · cash locked</span>
                  ) : (
                    <span className="k-cr-pending">{anyOpen ? `Close every ${shiftType} shift, then count the cash` : 'Ready for an Administrator to approve'}</span>
                  )}
                  {isAdmin && (
                    approval ? (
                      <button onClick={() => unApprove(shiftType)} disabled={approving === shiftType} style={{ ...S.btnSecondary, color: '#92400e', borderColor: '#fcd34d', background: '#fffbeb' }}>
                        <FiUnlock /> Un-approve {shiftType}
                      </button>
                    ) : (
                      <button onClick={() => approve(shiftType)} disabled={approving === shiftType || anyOpen} style={{ ...S.btnPrimary, background: '#15803d' }} title={anyOpen ? 'Close + finalize all ' + shiftType + ' shifts first' : ''}>
                        <FiShield /> {approving === shiftType ? 'Approving…' : `Approve ${shiftType}`}
                      </button>
                    )
                  )}
                </div>
              </header>
              <div className="k-cr-cards">
                {windowShifts.map(s => {
                  const ip = inputs[s.id] || {};
                  const fuelGross = Number(s.gross_from_nozzles || 0);
                  const posGross  = Number(s.pos_gross || 0);          // lubricants + any other POS sold on this shift
                  const gross = fuelGross + posGross;
                  const credit = Number(s.credit_total || 0) + Number(s.pos_credit || 0);
                  const onecard = Number(s.onecard_total || 0);
                  const posMomo  = Number(s.pos_momo || 0);
                  const posBank  = Number(s.pos_bank || 0);
                  const mobileTotal = Number(ip.payment_mobile || 0) + posMomo;
                  const swipesTotal = Number(ip.payment_swipes || 0) + posBank;
                  const otherAmt = Number(ip.payment_other || 0);   // "Other" tender (decision 2026-11-18)
                  const nonCash = mobileTotal + swipesTotal + otherAmt + credit + onecard;
                  const expected = Math.max(0, gross - nonCash);
                  const variance = Number(ip.payment_cash || 0) - expected;
                  const closed = s.status === 'Closed';
                  const locked = !!s.approval;
                  const counted = ip.payment_cash !== '' && ip.payment_cash != null;
                  const set = (k) => (v) => setInputs({ ...inputs, [s.id]: { ...ip, [k]: v } });
                  const split = [
                    { k: 'Credit', v: credit, c: '#7c3aed' }, { k: '1Card', v: onecard, c: '#0e7490' },
                    { k: 'Mobile money', v: mobileTotal, c: '#ca8a04' }, { k: 'Swipes', v: swipesTotal, c: '#2563eb' },
                    { k: 'Other', v: otherAmt, c: '#64748b' }, { k: 'Cash expected', v: expected, c: '#15803d' },
                  ].filter(x => x.v > 0.004);
                  return (
                    <article key={s.id} className={`k-cr-card${locked ? ' is-locked' : ''}${closed ? '' : ' is-open'}`} onKeyDown={e => cardKeyDown(e, s)} aria-label={`${s.attendant_name}, shift ${s.id}`}>
                      <header className="k-cr-head">
                        <div className="k-cr-who">
                          <AttendantAvatar profile={profileOf(s)} size={38} showName />
                          <div className="k-cr-meta">
                            <span>Shift #{s.id}</span>
                            <span>opened {String(s.opened_at || '').slice(11, 16) || '—'}</span>
                            <span style={S.pill(closed ? '#64748b' : '#16a34a')}>{s.status}</span>
                            {locked && <span className="k-cr-lock"><FiLock aria-hidden="true" /> Locked</span>}
                          </div>
                          <div style={{ marginTop: 6 }}><StepTrail steps={shiftSteps(s)} /></div>
                        </div>
                        <button data-k-finalize onClick={() => finalize(s)} disabled={saving === s.id || locked} style={S.btnPrimary} title={locked ? `${shiftType} shift approved — un-approve first` : 'Finalize (Ctrl + Enter while typing on this card)'}>
                          <FiCheckCircle /> {saving === s.id ? 'Finalizing…' : (closed ? 'Update' : 'Finalize')}
                        </button>
                      </header>

                      <div className="k-cr-body">
                        <div className="k-cr-flow" aria-label="From sales to the cash that should be in hand">
                          <FlowRow label="Fuel sales (meters)" value={fuelGross} />
                          <FlowRow label="Shop sales on this shift" hint="lubricants etc." value={posGross} sign="+" />
                          <FlowRow label="Gross takings" value={gross} total />
                          <FlowRow label="Credit tickets" hint="automatic" value={credit} sign="−" />
                          <FlowRow label="1Card tickets" hint="automatic" value={onecard} sign="−" />
                          <FlowRow label="Mobile money" hint={posMomo > 0 ? `+ ${fmtK(posMomo)} from the shop till` : null} sign="−" input value={ip.payment_mobile} onChange={set('payment_mobile')} locked={locked} />
                          <FlowRow label="Swipes" hint={posBank > 0 ? `+ ${fmtK(posBank)} from the shop till` : null} sign="−" input value={ip.payment_swipes} onChange={set('payment_swipes')} locked={locked} />
                          <FlowRow label="Other" hint="vouchers etc." sign="−" input value={ip.payment_other} onChange={set('payment_other')} locked={locked} />
                          <FlowRow label="Cash that should be in hand" value={expected} total strong />
                        </div>

                        <div className="k-cr-count">
                          <label className="k-cr-cash">
                            <span>Cash counted *{locked && <FiLock aria-hidden="true" style={{ marginLeft: 6 }} />}</span>
                            <div className="k-cr-cash-input">
                              <b aria-hidden="true">K</b>
                              <input type="number" step="0.01" inputMode="decimal" value={ip.payment_cash || ''} readOnly={locked}
                                onChange={e => set('payment_cash')(e.target.value)} aria-label={`Cash counted for ${s.attendant_name}`}
                                title={locked ? 'Shift approved — un-approve to edit' : ''} placeholder="0.00" />
                            </div>
                          </label>
                          <div className={`k-cr-var${!counted ? ' is-waiting' : Math.abs(variance) < 0.01 ? ' is-even' : variance < 0 ? ' is-short' : ' is-over'}`}>
                            <span>Variance</span>
                            <strong className="k-fc-num">{counted ? `${variance > 0.004 ? '+' : ''}${fmtK(variance)}` : '—'}</strong>
                            <em>{!counted ? 'enter the cash counted' : Math.abs(variance) < 0.01 ? 'balanced' : variance < 0 ? 'short — less cash than expected' : 'over — more cash than expected'}</em>
                          </div>
                          {gross > 0 && (
                            <div className="k-cr-split">
                              <span className="k-cr-split-title">How the takings were paid</span>
                              <div className="k-cr-split-bar" role="img" aria-label={split.map(x => `${x.k} ${fmtK(x.v)}`).join(', ')}>
                                {split.map(x => <div key={x.k} style={{ width: `${(x.v / gross) * 100}%`, background: x.c }} />)}
                              </div>
                              <div className="k-cr-split-key">{split.map(x => <span key={x.k}><i style={{ background: x.c }} aria-hidden="true" />{x.k}</span>)}</div>
                            </div>
                          )}
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          );
        })
      )}

      {summary && (rows.length > 0 || (summary.pumpGrades || []).length > 0) && (
        <DaySummaryPanel summary={summary} liveOverride={liveTotals(rows, inputs)} />
      )}
      {celebrate && <Celebration who={celebrate.who} items={celebrate.items} onDone={() => setCelebrate(null)} />}
      {dialog}
      <ShortcutHelp bindings={helpList.map(b => ({ ...b, run: b.run || (() => {}) }))} open={helpOpen} onClose={() => setHelpOpen(false)} title="Fuel Cash Report — shortcuts" />
    </div>
  );
}

// Sum what the user is CURRENTLY typing in the per-shift inputs so the
// Day Summary totals move in real time (backend summary is the saved
// baseline, we just substitute mobile/swipes/cash with the live typed
// values and recompute deductions + variance).
function liveTotals(rows, inputs) {
  const num = v => Number(v || 0);
  let mobile = 0, swipes = 0, other = 0, cash = 0, posGross = 0, posCredit = 0;
  for (const r of rows) {
    const ip = inputs[r.id] || {};
    // Typed fuel-side amount + POS non-cash of the same type → the real total
    mobile += num(ip.payment_mobile !== '' ? ip.payment_mobile : r.payment_mobile) + num(r.pos_momo);
    swipes += num(ip.payment_swipes !== '' ? ip.payment_swipes : r.payment_swipes) + num(r.pos_bank);
    other  += num(ip.payment_other !== undefined && ip.payment_other !== '' ? ip.payment_other : r.payment_other);
    cash   += num(ip.payment_cash   !== '' ? ip.payment_cash   : r.payment_cash);
    posGross  += num(r.pos_gross);
    posCredit += num(r.pos_credit);
  }
  return { mobile, swipes, other, cash, posGross, posCredit };
}

function fmtK(n)   { return (Number(n || 0) < 0 ? '−' : '') + 'K' + Math.abs(Number(n || 0)).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtL(n)   { return Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' L'; }

function DaySummaryPanel({ summary, liveOverride }) {
  const { pumpGrades = [], dips = [], credits = [], onecards = [], deductions = {}, totals = {} } = summary;

  // Swap in the live typed amounts (if any) and recompute totals so the
  // panel updates as the operator types mobile/swipes/actual-cash per shift.
  const mobileMoney = liveOverride ? liveOverride.mobile : Number(deductions.mobile_money || 0);
  const swipesAmt   = liveOverride ? liveOverride.swipes : Number(deductions.swipes || 0);
  const otherAmt    = liveOverride ? Number(liveOverride.other || 0) : Number(deductions.other || 0);
  const cashInHand  = liveOverride ? liveOverride.cash   : Number(totals.cash_in_hand || 0);
  const posGross    = liveOverride ? Number(liveOverride.posGross || 0)  : 0;
  const posCredit   = liveOverride ? Number(liveOverride.posCredit || 0) : 0;
  const creditTotal = Number(deductions.credit_total || 0) + posCredit;
  const onecardTotal = Number(deductions.onecard_total || 0);
  const totalDeductions = mobileMoney + swipesAmt + otherAmt + creditTotal + onecardTotal;
  const gross = Number(totals.gross || 0) + posGross;
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

  // UX-10b — the Forecourt kit look: soft cards, slate labels, tabular figures.
  const col = { background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, padding: 16, boxShadow: '0 1px 2px rgba(15,23,42,.04)' };
  const colTitle = { fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10, paddingBottom: 8, borderBottom: '2px solid #f1f5f9' };
  const line = { display: 'flex', justifyContent: 'space-between', gap: 8, padding: '4px 0', fontSize: 13, color: '#0f172a', fontVariantNumeric: 'tabular-nums' };
  const totLine = { ...line, marginTop: 8, paddingTop: 8, borderTop: '1px solid #e2e8f0', fontWeight: 800, fontSize: 14 };

  return (
    <div style={{ marginTop: 20 }}>
      <h3 className="k-cr-section">Day summary · all shifts</h3>

      {/* Per-grade totals banner — the 'how much Petrol / Diesel today' answer */}
      {gradeList.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 12 }}>
          {gradeList.map(g => (
            <div key={g.grade_id} className="k-cr-grade" style={{ '--k-g': g.grade_color || '#0e7490' }}>
              <div className="k-cr-grade-name"><i aria-hidden="true" />{g.grade_name} sold today</div>
              <div className="k-cr-grade-l k-fc-num">{fmtL(g.litres)}</div>
              <div className="k-cr-grade-k k-fc-num">{fmtK(g.amount)}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>

        {/* Column 1: Fuel Sales per Pump × Grade */}
        <div style={col}>
          <div style={colTitle}>Fuel Sales</div>
          {pumpList.length === 0 ? <div style={{ fontSize: 13, color: '#475569' }}>No readings.</div> : pumpList.map(p => (
            <div key={p.pump_code} style={{ marginBottom: 8 }}>
              {p.items.map(it => (
                <div key={it.grade_id} style={line}>
                  <span>{p.pump_code} {it.grade_name}</span>
                  <span style={{ color: '#475569' }}>{fmtL(it.litres)}</span>
                  <span style={{ fontWeight: 600, minWidth: 90, textAlign: 'right' }}>{fmtK(it.amount)}</span>
                </div>
              ))}
            </div>
          ))}
          <div style={totLine}>
            <span>TOTAL FUEL SALES</span>
            <span style={{ color: '#0e7490' }}>{fmtK(fuelTotal)}</span>
          </div>
        </div>

        {/* Column 2: Dip vs Read reconciliation per grade + per-tank levels */}
        <div style={col}>
          <div style={colTitle}>Dip vs Read (per grade)</div>
          {dips.length === 0 ? <div style={{ fontSize: 13, color: '#475569', marginBottom: 10 }}>No readings or dips.</div> : dips.map(d => {
            const hasDip = d.dip_total != null;
            const varColor = !hasDip ? '#64748b' : (Math.abs(d.variance) < 0.5 ? '#0f172a' : (d.variance >= 0 ? '#15803d' : '#b91c1c'));
            return (
              <div key={d.grade_id} style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px dashed #e2e8f0' }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: d.grade_color ? shade(d.grade_color, 0.42) : '#0f172a', marginBottom: 4 }}>{(d.grade_name || '').toUpperCase()}</div>
                <div style={line}><span style={{ color: '#475569' }}>Read (meter)</span><span>{fmtL(d.read_total)}</span></div>
                <div style={line}><span style={{ color: '#475569' }}>Dip (physical)</span><span>{hasDip ? fmtL(d.dip_total) : <span style={{ color: '#475569', fontSize: 11 }}>needs 2+ dips</span>}</span></div>
                <div style={line}><span style={{ color: '#475569' }}>Variance (R-D)</span><span style={{ color: varColor, fontWeight: 700 }}>{hasDip ? ((d.variance >= 0 ? '+' : '') + fmtL(d.variance)) : '—'}</span></div>
              </div>
            );
          })}

          <div style={{ ...colTitle, marginTop: 4 }}>Tank Dips (per tank)</div>
          {(() => {
            const list = summary.tank_dips_detail || [];
            if (list.length === 0) return <div style={{ fontSize: 13, color: '#475569' }}>No tanks.</div>;
            // Collapse plumbed group members (same group_code) into one
            // visual line — code list, sum of measured levels, grade.
            const groups = [];
            const singles = [];
            const byCode = {};
            for (const t of list) {
              const g = (t.group_code || '').trim();
              if (!g) { singles.push(t); continue; }
              if (!byCode[g]) {
                byCode[g] = { group_code: g, members: [] };
                groups.push(byCode[g]);
              }
              byCode[g].members.push(t);
            }
            const rows = [];
            for (const g of groups) {
              const anyDipped = g.members.some(m => m.closing_dip != null);
              const total = anyDipped ? g.members.reduce((s, m) => s + Number(m.closing_dip || 0), 0) : null;
              const codes = g.members.map(m => m.code || m.tank_code).join(' + ');
              const first = g.members[0];
              rows.push(
                <div key={`g-${g.group_code}`} style={{ ...line, borderBottom: '1px solid #f1f5f9', padding: '6px 0' }}>
                  <span>
                    <strong>{codes}</strong>
                    <span style={{ color: '#475569', fontSize: 11, marginLeft: 4 }}>{first.grade_name || ''} · Group {g.group_code}</span>
                  </span>
                  <span style={{ color: total == null ? '#64748b' : '#0f172a', fontWeight: total == null ? 400 : 600 }}>
                    {total != null ? fmtL(total) : <span style={{ fontSize: 11 }}>not dipped</span>}
                  </span>
                </div>
              );
            }
            for (const t of singles) {
              rows.push(
                <div key={`t-${t.tank_id}`} style={{ ...line, borderBottom: '1px solid #f1f5f9', padding: '6px 0' }}>
                  <span>
                    <strong>{t.tank_code}</strong>
                    <span style={{ color: '#475569', fontSize: 11, marginLeft: 4 }}>{t.grade_name || ''}</span>
                  </span>
                  <span style={{ color: t.closing_dip == null ? '#64748b' : '#0f172a', fontWeight: t.closing_dip == null ? 400 : 600 }}>
                    {t.closing_dip != null ? fmtL(t.closing_dip) : <span style={{ fontSize: 11 }}>not dipped</span>}
                  </span>
                </div>
              );
            }
            return rows;
          })()}
        </div>

        {/* Column 3: Deductions + Cash */}
        <div style={col}>
          <div style={colTitle}>Deductions &amp; Cash</div>
          <div style={line}><span>Swipes</span><span>{fmtK(swipesAmt)}</span></div>
          <div style={line}><span>Mobile Money</span><span>{fmtK(mobileMoney)}</span></div>
          <div style={line}><span>Other</span><span>{fmtK(otherAmt)}</span></div>

          <div style={{ ...line, marginTop: 6, color: '#475569', fontWeight: 600 }}><span>Engen 1Card</span><span>{fmtK(onecardTotal)}</span></div>
          {onecards.map((c, i) => (
            <div key={i} style={{ ...line, paddingLeft: 10, fontSize: 12, color: '#475569' }}>
              <span>{c.customer_name}{c.card_number ? ` (${c.card_number})` : ''}</span>
              <span>{fmtK(c.total)}</span>
            </div>
          ))}

          <div style={{ ...line, marginTop: 6, color: '#475569', fontWeight: 600 }}><span>Credit</span><span>{fmtK(creditTotal)}</span></div>
          {credits.map((c, i) => (
            <div key={i} style={{ ...line, paddingLeft: 10, fontSize: 12, color: '#475569' }}>
              <span>{c.customer_name}</span>
              <span>{fmtK(c.total)}</span>
            </div>
          ))}

          <div style={totLine}><span>TOTAL DEDUCTIONS</span><span>{fmtK(totalDeductions)}</span></div>
          <div style={{ ...totLine, borderTop: 'none', marginTop: 4 }}>
            <span>EXPECTED CASH</span>
            <span style={{ color: '#0e7490' }}>{fmtK(expectedCash)}</span>
          </div>
          <div style={{ ...line, fontWeight: 700, fontSize: 14 }}><span>CASH IN HAND</span><span>{fmtK(cashInHand)}</span></div>

          {/* Variance called out so it's never missed below the fold */}
          <div style={{
            marginTop: 10, padding: '10px 12px', borderRadius: 8,
            background: Math.abs(variance) < 0.01 ? '#f1f5f9' : (variance < 0 ? '#fef2f2' : '#f0fdf4'),
            border: '1px solid ' + (Math.abs(variance) < 0.01 ? '#e2e8f0' : (variance < 0 ? '#fecaca' : '#bbf7d0')),
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontWeight: 800, fontSize: 13, letterSpacing: '0.5px' }}>VARIANCE</span>
            <span style={{
              fontSize: 18, fontWeight: 800,
              color: Math.abs(variance) < 0.01 ? '#0f172a' : (variance < 0 ? '#b91c1c' : '#15803d'),
            }}>{variance > 0.004 ? '+' : ''}{fmtK(variance)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// UX-10b — one line of the money flow: a figure, or (for tenders the
// cashier types) an input; "−" lines are taken off the gross.
function FlowRow({ label, hint, value, sign, input, onChange, locked, total, strong }) {
  return (
    <div className={`k-flow${total ? ' is-total' : ''}${strong ? ' is-strong' : ''}`}>
      <span className="k-flow-sign" aria-hidden="true">{sign || (total ? '=' : '')}</span>
      <span className="k-flow-label">{label}{hint && <em>{hint}</em>}</span>
      {input ? (
        <input type="number" step="0.01" inputMode="decimal" value={value || ''} readOnly={locked}
          onChange={e => onChange(e.target.value)} aria-label={label} placeholder="0.00"
          title={locked ? 'Shift approved — un-approve to edit' : ''} className="k-flow-input" />
      ) : (
        <span className="k-flow-value k-fc-num">{fmtK(value)}</span>
      )}
    </div>
  );
}
