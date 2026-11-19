// UX-3 — Station Dashboard helpers: only rearrange what the server sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tankStatus, takingsSplit, niceMax, shiftSteps, trendBars, alerts } from '../../src/ux/stationMetrics';

test('tank status: own low level first, else a quarter of capacity', () => {
  assert.equal(tankStatus({ capacity: 30000, volume: 2000, low_level: 3000 }).level, 'low');
  assert.equal(tankStatus({ capacity: 30000, volume: 6000, low_level: 3000 }).level, 'watch');
  assert.equal(tankStatus({ capacity: 30000, volume: 20000, low_level: 3000 }).level, 'ok');
  assert.equal(tankStatus({ capacity: 30000, volume: 5000 }).level, 'watch');
  const s = tankStatus({ capacity: 0, volume: 50 });
  assert.equal(s.pct, 0, 'no capacity: no division by zero');
  assert.equal(tankStatus({ capacity: 100, volume: 150 }).pct, 1, 'overfull shows as full');
  assert.equal(tankStatus({ capacity: 100, volume: -5 }).litres, 0);
  assert.equal(tankStatus({ capacity: 1000, volume: 500, low_level: 100 }).lowPct, 0.1);
});

test('takings split: fuel never exceeds the total; shop is the rest', () => {
  assert.deepEqual(takingsSplit(1000, 600), { total: 1000, fuel: 600, shop: 400, fuelPct: 0.6 });
  assert.equal(takingsSplit(0, 0).fuelPct, 0);
  assert.equal(takingsSplit(500, 900).fuel, 500);
});

test('nice max is a round number above the largest value', () => {
  assert.equal(niceMax([1520, 1190]), 2000);
  assert.equal(niceMax([90]), 100);
  assert.equal(niceMax([]), 15);
  assert.ok(niceMax([33100]) >= 33100);
});

test('shift steps from the station counts', () => {
  assert.deepEqual(shiftSteps({ total: 3, closed: 2, cash: 2, approved: 0 }), { total: 3, done: 4, max: 9, pct: 4 / 9, complete: false });
  assert.equal(shiftSteps({ total: 2, closed: 2, cash: 2, approved: 2 }).complete, true);
  assert.equal(shiftSteps(undefined).complete, false);
});

test('trend bars split fuel from shop', () => {
  assert.deepEqual(trendBars([{ date: '2026-11-19', total: 1000, fuel: 700 }, { date: '2026-11-18', total: 300 }]),
    [{ date: '2026-11-19', total: 1000, fuel: 700, shop: 300 }, { date: '2026-11-18', total: 300, fuel: 0, shop: 300 }]);
});

test('alerts: low tanks, open shifts, shifts waiting for cash', () => {
  const a = alerts({ tanks: [{ code: 'T1', capacity: 100, volume: 5, low_level: 10 }, { code: 'T2', capacity: 100, volume: 90 }],
    shifts: { total: 3, open: 1, closed: 2, cash: 1, approved: 0 } });
  assert.deepEqual(a.map((x) => x.kind), ['tank', 'shift', 'cash']);
  assert.match(a[0].text, /T1 is below its low level/);
  assert.match(a[2].text, /1 closed shift is waiting for cash entry/);
  assert.deepEqual(alerts(null), []);
});
