// UX-2 — attendant levels and badges (pure; unit-tested in CI).
//
// What is rewarded, and what isn't:
//   • LEVELS come from experience only: shifts worked to the end (meters
//     closed). Money never moves a level up or down.
//   • BADGES are earned and kept. Nothing is ever taken away, and a missing
//     badge is shown as "not yet", never as a failure.
//   • Two badges recognise balanced cash ("Clean Hands", "Steady Hand"), from
//     the variance the SERVER saved — the same "< K0.01" rule as the screens.
//     A shortage is never shown on the avatar; it stays on the shift where it
//     belongs, in full.
//   • No ranking: the crew is listed alphabetically and nobody is compared.
import { cashEntered, BALANCED_TOLERANCE } from './fuelProgress';

export const LEVELS = [
  { min: 0, title: 'Rookie' },
  { min: 5, title: 'Pump Pro' },
  { min: 20, title: 'Forecourt Ace' },
  { min: 50, title: 'Station Legend' },
  { min: 100, title: 'Hall of Fame' },
];

export const BADGES = [
  { key: 'first', icon: '⛽', title: 'First Fill', how: 'Finish a first shift', test: (s) => s.completed >= 1 },
  { key: 'ten', icon: '🔟', title: 'Ten Tanks', how: 'Finish 10 shifts', test: (s) => s.completed >= 10 },
  { key: 'night', icon: '🌙', title: 'Night Owl', how: 'Finish 5 night shifts', test: (s) => s.nights >= 5 },
  { key: 'clean', icon: '✨', title: 'Clean Hands', how: 'A shift that balanced to the ngwee', test: (s) => s.balanced >= 1 },
  { key: 'steady', icon: '🎯', title: 'Steady Hand', how: '5 balanced shifts in a row', test: (s) => s.bestBalancedRun >= 5 },
  { key: 'century', icon: '🏆', title: 'Century', how: 'Finish 100 shifts', test: (s) => s.completed >= 100 },
];

const sameAttendant = (s, who) =>
  (who.id != null && Number(s.attendant_user_id) === Number(who.id)) ||
  (who.id == null && who.name && s.attendant_name === who.name);

// Stats for one attendant from the shift list (oldest → newest order not required).
export function attendantStats(shifts, who) {
  const mine = (Array.isArray(shifts) ? shifts : []).filter((s) => s && sameAttendant(s, who))
    .sort((a, b) => String(a.opened_at || '').localeCompare(String(b.opened_at || '')));
  let completed = 0, nights = 0, balanced = 0, run = 0, bestBalancedRun = 0;
  for (const s of mine) {
    if (s.status !== 'Closed') continue;
    completed += 1;
    if ((s.shift_type || 'DAY') === 'NIGHT') nights += 1;
    if (!cashEntered(s)) continue;                       // not reconciled yet: neither counts nor breaks
    if (Math.abs(Number(s.variance) || 0) < BALANCED_TOLERANCE) { balanced += 1; run += 1; bestBalancedRun = Math.max(bestBalancedRun, run); }
    else run = 0;
  }
  return { completed, nights, balanced, bestBalancedRun, open: mine.some((s) => s.status === 'Open') };
}

export function levelFor(completed) {
  const n = Math.max(0, Number(completed) || 0);
  let idx = 0;
  LEVELS.forEach((l, i) => { if (n >= l.min) idx = i; });
  const cur = LEVELS[idx];
  const next = LEVELS[idx + 1] || null;
  const span = next ? next.min - cur.min : 1;
  return {
    level: idx + 1,
    title: cur.title,
    next: next ? next.title : null,
    toNext: next ? next.min - n : 0,
    progress: next ? Math.min(1, (n - cur.min) / span) : 1,
  };
}

export function badgesFor(stats) {
  return BADGES.map((b) => ({ key: b.key, icon: b.icon, title: b.title, how: b.how, earned: !!b.test(stats) }));
}

export function profileFor(shifts, who) {
  const stats = attendantStats(shifts, who);
  return { who, stats, level: levelFor(stats.completed), badges: badgesFor(stats) };
}

// What changed between two profiles of the same person (for a celebration
// after closing or finalising a shift). Only gains are reported.
export function milestones(before, after) {
  if (!before || !after) return [];
  const out = [];
  if (after.level.level > before.level.level) out.push({ kind: 'level', title: after.level.title });
  const had = new Set(before.badges.filter((b) => b.earned).map((b) => b.key));
  for (const b of after.badges) if (b.earned && !had.has(b.key)) out.push({ kind: 'badge', title: b.title, icon: b.icon });
  return out;
}

// Stable, friendly colours per person (not tied to performance).
const PALETTE = [
  { cap: '#0e7490', shirt: '#155e75' }, { cap: '#b91c1c', shirt: '#7f1d1d' }, { cap: '#1d4ed8', shirt: '#1e3a8a' },
  { cap: '#7c3aed', shirt: '#5b21b6' }, { cap: '#047857', shirt: '#064e3b' }, { cap: '#b45309', shirt: '#78350f' },
];
const SKIN = ['#8d5524', '#a0662f', '#c68642', '#6b3e1e', '#e0ac69', '#4a2c17'];
export function avatarLook(name) {
  let h = 0;
  for (const ch of String(name || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { ...PALETTE[h % PALETTE.length], skin: SKIN[(h >>> 3) % SKIN.length] };
}

export function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
