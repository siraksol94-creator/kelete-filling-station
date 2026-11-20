// UX-1 — the progress/feedback rules. These encode the agreed limits:
// variances are always reported in full, "balanced" means < K0.01 (the
// screens' existing test), streaks use the server's saved figures, and
// progress counts completed steps, never money.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  varianceState, closeChecklist, cashEntered, shiftSteps, dayProgress, cleanStreak, dipProgress, shiftSummary, formatKwacha,
} from '../../src/ux/fuelProgress';

test('variance: balanced only under K0.01; short and over always carry the full signed amount', () => {
  assert.equal(varianceState(0).state, 'balanced');
  assert.equal(varianceState(0.009).state, 'balanced');
  assert.equal(varianceState(-0.009).state, 'balanced');
  const short = varianceState(-0.01);
  assert.equal(short.state, 'short');
  assert.equal(short.amount, -0.01);
  assert.match(short.label, /Short K0\.01/);
  const big = varianceState(-1234.5);
  assert.equal(big.label, 'Short K1,234.50');
  assert.equal(big.tone, 'danger');
  const over = varianceState(250);
  assert.equal(over.state, 'over');
  assert.equal(over.label, 'Over K250.00');
  assert.notEqual(over.tone, 'ok', 'an overage is not presented as a success');
  assert.equal(varianceState('not a number').state, 'balanced');
  assert.equal(formatKwacha(-5), '−K5.00');
});

test('close checklist: every meter entered and none below its opening', () => {
  const rows = [{ closing: 100, invalid: false }, { closing: null, invalid: false }, { closing: 50, invalid: true }];
  const c = closeChecklist(rows);
  assert.equal(c.entered, 2);
  assert.equal(c.invalid, 1);
  assert.equal(c.ready, false);
  assert.match(c.items[0].label, /2 of 3/);
  assert.match(c.items[1].label, /1 closing reading is below the opening/);
  const ok = closeChecklist([{ closing: 1, invalid: false }, { closing: 0, invalid: false }]);
  assert.equal(ok.ready, true, 'a closing of 0 counts as entered');
  assert.equal(closeChecklist([]).ready, false, 'nothing to close is not "ready"');
});

test('shift steps: meters → cash → approved, from saved figures', () => {
  assert.deepEqual(shiftSteps({ status: 'Open' }).map((s) => s.done), [false, false, false]);
  assert.deepEqual(shiftSteps({ status: 'Closed', payment_cash: 0, expected_cash: 900 }).map((s) => s.done), [true, false, false]);
  assert.deepEqual(shiftSteps({ status: 'Closed', payment_cash: 900 }).map((s) => s.done), [true, true, false]);
  assert.deepEqual(shiftSteps({ status: 'Closed', payment_cash: 900, approval: { id: 1 } }).map((s) => s.done), [true, true, true]);
  assert.equal(cashEntered({ status: 'Closed', payment_cash: 0, expected_cash: 0 }), true, 'all-credit shift: nothing to count');
  assert.equal(cashEntered({ status: 'Open', payment_cash: 500 }), false);
});

test('day progress per DAY/NIGHT window', () => {
  const rows = [
    { shift_type: 'DAY', status: 'Closed', payment_cash: 10, approval: { id: 1 } },
    { shift_type: 'DAY', status: 'Closed', payment_cash: 10, approval: { id: 1 } },
    { shift_type: 'NIGHT', status: 'Open' },
  ];
  const p = dayProgress(rows);
  assert.deepEqual(p.windows.map((w) => w.shiftType), ['DAY', 'NIGHT']);
  assert.equal(p.windows[0].complete, true);
  assert.equal(p.windows[1].pct, 0);
  assert.equal(p.stepsDone, 6);
  assert.equal(p.stepsTotal, 9);
  assert.equal(p.complete, false);
  assert.equal(dayProgress([]).complete, false);
});

test('clean-shift streak: newest first, skips unreconciled shifts, ends at the first imbalance and says which', () => {
  const shifts = [
    { id: 5, opened_at: '2026-11-19 06:00', status: 'Open' },                                        // skipped
    { id: 4, opened_at: '2026-11-18 18:00', status: 'Closed', payment_cash: 0, expected_cash: 800 }, // no cash yet: skipped
    { id: 3, opened_at: '2026-11-18 06:00', status: 'Closed', payment_cash: 900, variance: 0 },
    { id: 2, opened_at: '2026-11-17 18:00', status: 'Closed', payment_cash: 900, variance: 0.004 },
    { id: 1, opened_at: '2026-11-17 06:00', status: 'Closed', payment_cash: 900, variance: -40 },
    { id: 0, opened_at: '2026-11-16 06:00', status: 'Closed', payment_cash: 900, variance: 0 },
  ];
  const s = cleanStreak(shifts.slice().reverse());   // order of the input doesn't matter
  assert.equal(s.count, 2);
  assert.deepEqual(s.lastBreak, { id: 1, variance: -40, attendant: null });
  assert.deepEqual(cleanStreak([]), { count: 0, lastBreak: null });
});

test('dip progress: saved means dip records exist (grouped tanks report 0 when not dipped)', () => {
  const rows = [
    { tank_ids: [1], dip_rows: [{ dip_id: 9 }], measured_litres: 900 },
    { tank_ids: [2, 3], dip_rows: [], measured_litres: 0 },
    { tank_ids: [4], dip_rows: [], measured_litres: null },
  ];
  const p = dipProgress(rows, { '4': { measured: '120' } });
  assert.equal(p.saved, 1);
  assert.equal(p.total, 3);
  assert.equal(p.typedNotSaved, 1);
  assert.equal(p.complete, false);
});

test('shift summary uses the business date of each shift', () => {
  const s = shiftSummary([
    { status: 'Open', shift_date: '2026-11-19' },
    { status: 'Closed', shift_date: '2026-11-19', payment_cash: 0, expected_cash: 100 },
    { status: 'Closed', shift_date: '2026-11-19', payment_cash: 100 },
    { status: 'Closed', opened_at: '2026-11-18 23:30:00', shift_date: '2026-11-19', payment_cash: 5 },
    { status: 'Closed', shift_date: '2026-11-18', payment_cash: 5 },
  ], '2026-11-19');
  assert.deepEqual(s, { open: 1, closedToday: 3, awaitingCash: 1 });
});
