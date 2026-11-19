// UX-2 — attendant levels and badges. Encodes the agreed limits: levels come
// from experience only, badges are never taken away, money never appears on
// the avatar, and nobody is ranked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attendantStats, levelFor, badgesFor, profileFor, milestones, avatarLook, initials, LEVELS } from '../../src/ux/attendantLevel';

const shift = (n, o = {}) => ({ id: n, attendant_user_id: 7, attendant_name: 'Mary Banda', status: 'Closed', shift_type: 'DAY',
  opened_at: `2026-11-${String(n).padStart(2, '0')} 06:00`, payment_cash: 100, variance: 0, ...o });

test('levels come from shifts finished, nothing else', () => {
  assert.equal(levelFor(0).title, 'Rookie');
  assert.equal(levelFor(4).toNext, 1);
  assert.equal(levelFor(5).title, 'Pump Pro');
  assert.equal(levelFor(20).title, 'Forecourt Ace');
  assert.equal(levelFor(1000).title, 'Hall of Fame');
  assert.equal(levelFor(1000).next, null);
  assert.equal(levelFor(12).progress, (12 - 5) / 15);
  // a big shortage on every shift doesn't lower anyone's level
  const short = Array.from({ length: 6 }, (_, i) => shift(i + 1, { variance: -500 }));
  assert.equal(profileFor(short, { id: 7, name: 'Mary Banda' }).level.title, 'Pump Pro');
  assert.equal(LEVELS.length, 5);
});

test('stats: only this attendant, only closed shifts; unreconciled shifts neither count nor break a run', () => {
  const list = [
    shift(1), shift(2), shift(3, { payment_cash: 0, expected_cash: 900 }), shift(4), shift(5, { variance: -20 }), shift(6), shift(7),
    shift(8, { status: 'Open' }), shift(9, { attendant_user_id: 8, attendant_name: 'John' }), shift(10, { shift_type: 'NIGHT' }),
  ];
  const s = attendantStats(list, { id: 7 });
  assert.equal(s.completed, 8);
  assert.equal(s.nights, 1);
  assert.equal(s.balanced, 6);
  assert.equal(s.bestBalancedRun, 3, 'shifts 1,2,4 (3 skipped) then broken by 5; then 6,7,10');
  assert.equal(s.open, true);
});

test('badges are earned from stats and say how to earn the rest', () => {
  const b = badgesFor({ completed: 10, nights: 2, balanced: 1, bestBalancedRun: 1 });
  const earned = b.filter((x) => x.earned).map((x) => x.key);
  assert.deepEqual(earned, ['first', 'ten', 'clean']);
  assert.ok(b.find((x) => x.key === 'steady').how.includes('5 balanced'));
  assert.ok(!JSON.stringify(b).match(/K\s?\d/), 'no money amounts in badges');
});

test('milestones report gains only', () => {
  const four = Array.from({ length: 4 }, (_, i) => shift(i + 1));
  const before = profileFor(four, { id: 7, name: 'Mary' });
  const after = profileFor([...four, shift(5)], { id: 7, name: 'Mary' });
  assert.deepEqual(milestones(before, after), [{ kind: 'level', title: 'Pump Pro' }, { kind: 'badge', title: 'Steady Hand', icon: '🎯' }]);
  assert.deepEqual(milestones(after, before), [], 'nothing is ever reported as lost');
  assert.deepEqual(milestones(null, after), []);
});

test('avatar look is stable per name; initials', () => {
  assert.deepEqual(avatarLook('Mary Banda'), avatarLook('Mary Banda'));
  assert.equal(initials('Mary Banda'), 'MB');
  assert.equal(initials('john'), 'J');
  assert.equal(initials(''), '?');
});
