// UX-10 — the station-day ring: quarters fill with the work, idle steps don't count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ringSegments, dayProgress, arcPath } from '../../src/ux/stationDayModel';

const steps = [
  { key: 'closed', done: 3, total: 3 }, { key: 'cash', done: 2, total: 3 },
  { key: 'dips', done: 0, total: 4 }, { key: 'approved', done: 0, total: 0 },
];
test('segments and progress', () => {
  const s = ringSegments(steps);
  assert.deepEqual(s.map((x) => [x.key, x.frac, x.complete, x.idle]), [['closed', 1, true, false], ['cash', 2 / 3, false, false], ['dips', 0, false, false], ['approved', 0, false, true]]);
  assert.deepEqual(dayProgress(steps), { done: 1, total: 3 });
  assert.deepEqual(dayProgress([]), { done: 0, total: 0 });
  assert.equal(ringSegments([{ key: 'x', done: 9, total: 3 }])[0].frac, 1, 'never more than full');
});
test('arc path', () => {
  assert.equal(arcPath(50, 50, 40, 0, 90), 'M50.00 10.00 A40 40 0 0 1 90.00 50.00');
  assert.ok(arcPath(50, 50, 40, 0, 270).includes(' 0 1 1 '), 'large arc flag past 180°');
});
