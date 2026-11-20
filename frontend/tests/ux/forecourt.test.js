// UX-7 — Forecourt kit: numbers, dates and the dip band read the same everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtK, fmtL, fmtSignedL, fmtDay, daysAgo, dipBand, spaceLeft } from '../../src/ux/forecourt';

test('money and litres', () => {
  assert.equal(fmtK(12345), 'K12,345.00');
  assert.equal(fmtK(-50.5), '−K50.50', 'minus before the K, never K-50');
  assert.equal(fmtK('x'), 'K0.00');
  assert.equal(fmtL(30000), '30,000 L');
  assert.equal(fmtL(1234.567, 2), '1,234.57 L');
  assert.equal(fmtSignedL(-60), '−60.00 L');
  assert.equal(fmtSignedL(12.5), '+12.50 L');
  assert.equal(fmtSignedL(0), '0.00 L');
});

test('dates', () => {
  assert.equal(fmtDay('2026-11-19', 2026), 'Thu 19 Nov');
  assert.equal(fmtDay('2025-11-19', 2026), 'Wed 19 Nov 2025');
  assert.equal(fmtDay(''), '—');
  assert.equal(daysAgo('2026-11-19', '2026-11-19'), 'today');
  assert.equal(daysAgo('2026-11-18', '2026-11-19'), 'yesterday');
  assert.equal(daysAgo('2026-11-12', '2026-11-19'), '7 days ago');
  assert.equal(daysAgo('bad', '2026-11-19'), '');
});

test('dip band: ±0.5% ok, to ±1% watch, beyond high — both directions', () => {
  assert.equal(dipBand(-50, 10000).level, 'ok');      // 0.5%
  assert.equal(dipBand(50.01, 10000).level, 'watch');
  assert.equal(dipBand(-100, 10000).level, 'watch');  // 1%
  assert.equal(dipBand(-100.5, 10000).level, 'high');
  assert.equal(dipBand(0, 0).level, 'ok');
  assert.equal(dipBand(5, 0).level, 'high', 'any litres against an empty book is out');
  assert.equal(dipBand('', 100), null);
  assert.equal(dipBand(-60, 10000).label, '0.5–1% out');
});

test('space left never negative', () => {
  assert.equal(spaceLeft(30000, 18452), 11548);
  assert.equal(spaceLeft(1000, 1200), 0);
});

import { ledgerSeries, ledgerTotals, ledgerTop } from '../../src/ux/ledgerSeries';
test('ledger chart: starts at the opening, one point per movement; totals by kind', () => {
  const rows = [
    { movement_date: '2026-11-18 08:00', type: 'sale', litres: -1200, balance_after: 8800 },
    { movement_date: '2026-11-18 14:00', type: 'delivery', litres: 15000, balance_after: 23800 },
    { movement_date: '2026-11-19', type: 'dip_adjustment', litres: -60, balance_after: 23740 },
  ];
  const s = ledgerSeries(10000, rows, '2026-11-18');
  assert.deepEqual(s.map((p) => p.balance), [10000, 8800, 23800, 23740]);
  assert.equal(s[0].type, 'start');
  assert.equal(s[3].date, '2026-11-19');
  assert.deepEqual(ledgerTotals(rows), { delivered: 15000, sold: 1200, corrected: -60 });
  assert.equal(ledgerTop(s, 30000), 30000);
  assert.ok(Math.abs(ledgerTop(s, 0) - 26180) < 1e-6);
});

import { niceTicks } from '../../src/ux/ledgerSeries';
test('ledger axis uses round steps', () => {
  assert.deepEqual(niceTicks(50000), [0, 20000, 40000, 60000]);
  assert.deepEqual(niceTicks(30000), [0, 10000, 20000, 30000]);
  assert.deepEqual(niceTicks(900), [0, 250, 500, 750, 1000]);
});

import { deliveryCheck, fitCheck } from '../../src/ux/forecourt';
test('delivery check: ordered vs delivered vs dipped, in full, banded like the dips', () => {
  const c = deliveryCheck({ litres_ordered: 15000, litres_delivered: 14950, dip_before: 3200, dip_after: 18080 });
  assert.equal(c.vsOrdered, -50);
  assert.equal(c.dipped, 14880);
  assert.equal(c.vsDipped, -70);
  assert.equal(c.band.level, 'ok', '70 L of 14,950 is under 0.5%');
  const n = deliveryCheck({ litres_delivered: 5000, dip_before: '', dip_after: 5100 });
  assert.equal(n.dipped, null); assert.equal(n.band, null); assert.equal(n.vsOrdered, null);
  assert.equal(deliveryCheck({ litres_delivered: 10000, dip_before: 0, dip_after: 9850 }).band.level, 'high');
});
test('will it fit?', () => {
  assert.deepEqual(fitCheck(30000, 3200, 20000), { after: 23200, over: 0, fits: true, space: 26800, pctAfter: 23200 / 30000 });
  const f = fitCheck(30000, 18452, 15000);
  assert.equal(f.fits, false); assert.equal(f.over, 3452); assert.equal(f.pctAfter, 1);
  assert.equal(fitCheck(0, 0, 100).fits, true, 'unknown capacity: no warning');
});

import { gradeMargin, creditUse, ticketSummary } from '../../src/ux/forecourt';
test('margin per litre, including below cost', () => {
  assert.deepEqual(gradeMargin(32.4, 26.4), { perL: 6, pct: 6 / 32.4, below: false, unknownCost: false });
  assert.equal(gradeMargin(25, 26.1).below, true);
  assert.equal(gradeMargin(25, 0).unknownCost, true);
});
test('credit use: within, over by, no limit', () => {
  assert.deepEqual(creditUse({ credit_limit: 50000, outstanding: 30000 }, 10000), { limit: 50000, owed: 30000, after: 40000, pct: 0.8, over: 0 });
  assert.equal(creditUse({ credit_limit: 50000, outstanding: 48000 }, 5000).over, 3000);
  assert.equal(creditUse({ credit_limit: 0, outstanding: 100 }, 5).limit, null);
});
test('ticket totals, grades alphabetical', () => {
  const s = ticketSummary([{ litres: 40, amount: 1296, grade_name: 'Petrol' }, { litres: 100, amount: 3090, grade_name: 'Diesel' }, { litres: 10.5, amount: 340.2, grade_name: 'Petrol' }]);
  assert.equal(s.count, 3); assert.equal(s.litres, 150.5); assert.equal(s.amount, 4726.2);
  assert.deepEqual(s.grades.map((g) => [g.name, g.litres]), [['Diesel', 100], ['Petrol', 50.5]]);
});
