// UX-1 — progress and feedback logic for the fuel screens.
//
// Pure functions only (no React, no API calls), so they are unit-tested in CI
// (frontend/tests/ux). They read figures the screens already have; they never
// change a calculation.
//
// Rules (agreed for UX-1):
//   • Feedback rewards COMPLETING the process — meters entered, cash entered,
//     dips taken, shifts approved — never the size of a number.
//   • A variance is always reported in full, with its sign. "Balanced" means
//     the same thing the screens already use: less than K0.01 either way.
//   • The clean-shift streak counts the station's shifts, from the figures the
//     SERVER saved. It does not rank attendants against each other.

export const BALANCED_TOLERANCE = 0.01; // kwacha — the screens' existing "zero" test

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function formatKwacha(n) {
  const v = num(n);
  const sign = v < 0 ? '−' : '';
  return `${sign}K${Math.abs(v).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Cash variance → what to show. `amount` is always the full signed value.
export function varianceState(variance) {
  const v = num(variance);
  if (Math.abs(v) < BALANCED_TOLERANCE) return { state: 'balanced', label: 'Balanced', amount: v, tone: 'neutral' };
  if (v < 0) return { state: 'short', label: `Short ${formatKwacha(Math.abs(v))}`, amount: v, tone: 'danger' };
  return { state: 'over', label: `Over ${formatKwacha(v)}`, amount: v, tone: 'warning' };
}

// Close Shift checklist, from the rows the modal already computes
// (each row: { closing: number|null, invalid: boolean }).
export function closeChecklist(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const total = list.length;
  const entered = list.filter((r) => r && r.closing != null && Number.isFinite(Number(r.closing))).length;
  const invalid = list.filter((r) => r && r.invalid).length;
  const items = [
    { key: 'meters', label: `Closing meter entered on every nozzle (${entered} of ${total})`, done: total > 0 && entered === total },
    { key: 'valid', label: invalid ? `${invalid} closing reading${invalid === 1 ? ' is' : 's are'} below the opening` : 'No closing reading below its opening', done: invalid === 0 && entered > 0 },
  ];
  const done = items.filter((i) => i.done).length;
  return { items, done, total: items.length, ready: done === items.length, entered, nozzles: total, invalid };
}

// Has cash been entered for a shift (from saved figures)? A shift whose
// expected cash is zero (all credit/cards) counts as complete once closed.
export function cashEntered(shift) {
  if (!shift || shift.status !== 'Closed') return false;
  if (num(shift.payment_cash) > 0 || num(shift.actual_cash) > 0) return true;
  return shift.expected_cash != null && Math.abs(num(shift.expected_cash)) < BALANCED_TOLERANCE;
}

// The three steps every shift goes through.
export function shiftSteps(shift) {
  const closed = !!shift && shift.status === 'Closed';
  return [
    { key: 'meters', label: 'Meters closed', done: closed },
    { key: 'cash', label: 'Cash entered', done: cashEntered(shift) },
    { key: 'approved', label: 'Approved', done: !!(shift && shift.approval) },
  ];
}

// Day progress on the Fuel Cash Report, per DAY/NIGHT window and overall.
export function dayProgress(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const windows = {};
  for (const s of list) {
    const w = s.shift_type || 'DAY';
    if (!windows[w]) windows[w] = { shiftType: w, shifts: 0, closed: 0, cash: 0, approved: 0 };
    const steps = shiftSteps(s);
    windows[w].shifts += 1;
    if (steps[0].done) windows[w].closed += 1;
    if (steps[1].done) windows[w].cash += 1;
    if (steps[2].done) windows[w].approved += 1;
  }
  const out = Object.values(windows).map((w) => {
    const stepsDone = w.closed + w.cash + w.approved;
    const stepsTotal = w.shifts * 3;
    return { ...w, stepsDone, stepsTotal, pct: stepsTotal ? Math.round((stepsDone / stepsTotal) * 100) : 0, complete: stepsTotal > 0 && stepsDone === stepsTotal };
  });
  const stepsDone = out.reduce((a, w) => a + w.stepsDone, 0);
  const stepsTotal = out.reduce((a, w) => a + w.stepsTotal, 0);
  return {
    windows: out.sort((a, b) => (a.shiftType === 'DAY' ? -1 : b.shiftType === 'DAY' ? 1 : a.shiftType.localeCompare(b.shiftType))),
    stepsDone, stepsTotal,
    pct: stepsTotal ? Math.round((stepsDone / stepsTotal) * 100) : 0,
    complete: stepsTotal > 0 && stepsDone === stepsTotal,
  };
}

// Consecutive reconciled shifts (newest first) that balanced, from the
// server's saved variance. Open shifts and closed shifts without cash entered
// are skipped (not yet reconciled); the first shift that didn't balance ends
// the streak. Returns { count, lastBreak } — lastBreak is that shift, so the
// screen can say why the streak ended rather than hide it.
export function cleanStreak(shifts) {
  const list = (Array.isArray(shifts) ? shifts : []).slice()
    .sort((a, b) => String(b.opened_at || '').localeCompare(String(a.opened_at || '')));
  let count = 0;
  for (const s of list) {
    if (!cashEntered(s)) continue;
    if (Math.abs(num(s.variance)) < BALANCED_TOLERANCE) { count += 1; continue; }
    return { count, lastBreak: { id: s.id, variance: num(s.variance), attendant: s.attendant_name || null } };
  }
  return { count, lastBreak: null };
}

// Tank Dips: how many tanks (or plumbed groups) have a dip for this shift.
export function dipProgress(rows, edits = {}, keyOf = (r) => (r.tank_ids || []).join('-')) {
  const list = Array.isArray(rows) ? rows : [];
  let saved = 0, typedNotSaved = 0;
  for (const r of list) {
    // Saved = dip records exist. (Grouped tanks report measured_litres: 0 when
    // nothing is dipped, so that field can't be used.)
    const isSaved = (r.dip_rows || []).length > 0;
    if (isSaved) saved += 1;
    const e = edits[keyOf(r)];
    const typed = e && e.measured !== '' && e.measured != null;
    if (typed && !isSaved) typedNotSaved += 1;
  }
  return { total: list.length, saved, typedNotSaved, complete: list.length > 0 && saved === list.length, pct: list.length ? Math.round((saved / list.length) * 100) : 0 };
}

// Shift list summary for the strip at the top of Attendant Shifts.
export function shiftSummary(shifts, today) {
  const list = Array.isArray(shifts) ? shifts : [];
  const dayOf = (s) => s.shift_date || String(s.opened_at || '').slice(0, 10);
  return {
    open: list.filter((s) => s.status === 'Open').length,
    closedToday: list.filter((s) => s.status === 'Closed' && dayOf(s) === today).length,
    awaitingCash: list.filter((s) => s.status === 'Closed' && dayOf(s) === today && !cashEntered(s)).length,
  };
}
