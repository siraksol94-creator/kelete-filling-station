// UX-4 — HQ Overview helpers: alphabetical, shared scale, nothing hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortBranch, branchBars, forecourtFlags, fuelShare } from '../../src/ux/hqMetrics';
import { kindOf } from '../../src/ux/weatherKind';

test('short branch names', () => {
  assert.equal(shortBranch('Kelete Distribution - BANKERS (KABWE)'), 'Bankers (Kabwe)');
  assert.equal(shortBranch('', 'mansa'), 'Mansa');
});

test('branch bars: alphabetical (never ranked), one shared scale, errored branches left out', () => {
  const rows = branchBars([
    { slug: 'z', name: 'Zambezi', takings: { fuel: 600, shop: 400 } },
    { slug: 'a', name: 'Arcades', takings: { fuel: 100, shop: 400 } },
    { slug: 'e', name: 'Broken', error: 'db locked' },
  ]);
  assert.deepEqual(rows.map((r) => r.name), ['Arcades', 'Zambezi']);
  assert.equal(rows[1].fuelPct + rows[1].shopPct, 1, 'largest branch fills the bar');
  assert.equal(rows[0].fuelPct, 0.1);
  assert.equal(rows[0].total, 500);
  assert.deepEqual(branchBars([{ slug: 'x', name: 'X', takings: { fuel: 0, shop: 0 } }])[0].fuelPct, 0, 'no division by zero');
});

test('forecourt flags: low tanks and open shifts', () => {
  assert.deepEqual(forecourtFlags(null), []);
  const f = forecourtFlags({ tanks: [{ code: 'T1', capacity: 1000, volume: 50, low_level: 100 }, { code: 'T2', capacity: 1000, volume: 900, low_level: 100 }], shifts: { open: 2 } });
  assert.deepEqual(f.map((x) => x.text), ['T1 below low level', '2 shifts open']);
});

test('fuel share of group takings', () => {
  assert.equal(fuelShare({ takings_total: 1000, takings_fuel: 750 }), 0.75);
  assert.equal(fuelShare({ takings_total: 0, takings_fuel: 0 }), 0);
  assert.equal(fuelShare(undefined), 0);
});

test('weather symbols map to the right picture', () => {
  assert.equal(kindOf('clearsky_day'), 'sun');
  assert.equal(kindOf('clearsky_night'), 'night');
  assert.equal(kindOf('heavyrainandthunder'), 'thunder');
  assert.equal(kindOf('lightrainshowers_day'), 'rain');
  assert.equal(kindOf('fog'), 'fog');
  assert.equal(kindOf('partlycloudy_day'), 'partly');
  assert.equal(kindOf('cloudy'), 'cloud');
});

import { groupTanks, groupLabel } from '../../src/ux/tankGroups';
test('connected tanks: grouped where the first one sits; fuel settles from the fuller tank', () => {
  const items = groupTanks([
    { code: 'T1', group_code: 'a', capacity: 30000, volume: 18000 },
    { code: 'T2', capacity: 30000, volume: 3000 },
    { code: 'T3', group_code: 'A', capacity: 20000, volume: 6000 },
    { code: 'T4', group_code: 'solo', capacity: 10000, volume: 2000 },
  ]);
  assert.deepEqual(items.map((i) => i.kind), ['group', 'single', 'single']);
  assert.equal(groupLabel(items[0]), 'T1 + T3');
  assert.equal(items[0].volume, 24000);
  assert.equal(items[0].capacity, 50000);
  assert.equal(items[0].links[0].dir, 'right', '60% → 30%');
  assert.equal(items[0].links[0].strength, 1);
  assert.equal(items[2].tank.code, 'T4', 'a group of one is just a tank');
  const level = groupTanks([{ code: 'A', group_code: 'g', capacity: 100, volume: 50 }, { code: 'B', group_code: 'g', capacity: 200, volume: 100 }]);
  assert.equal(level[0].links[0].dir, 'still');
  assert.deepEqual(groupTanks(undefined), []);
});
