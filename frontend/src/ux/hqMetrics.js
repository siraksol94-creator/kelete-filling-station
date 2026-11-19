// UX-4 — pure helpers for the HQ Overview (unit-tested in CI). They only
// arrange figures the server sent; nothing is recalculated.
import { tankStatus } from './stationMetrics';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// "Kelete Distribution - BANKERS (KABWE)" → "Bankers (Kabwe)".
export function shortBranch(name, slug) {
  const tail = String(name || slug || '').split(/\s+-\s+/).pop();
  return tail.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

// Branches in alphabetical order (never ranked by takings), with bar widths
// on one shared scale so the bars compare fairly.
export function branchBars(branches) {
  const rows = (branches || []).filter((b) => b && !b.error && b.takings).map((b) => ({
    slug: b.slug,
    name: shortBranch(b.name, b.slug),
    fuel: Math.max(0, num(b.takings.fuel)),
    shop: Math.max(0, num(b.takings.shop)),
  })).sort((a, b) => a.name.localeCompare(b.name));
  const max = Math.max(0, ...rows.map((r) => r.fuel + r.shop));
  return rows.map((r) => ({
    ...r,
    total: r.fuel + r.shop,
    fuelPct: max > 0 ? r.fuel / max : 0,
    shopPct: max > 0 ? r.shop / max : 0,
  }));
}

// A branch's forecourt in a few words: tanks below their low level, open
// shifts and the cash variance (in full, sign kept).
export function forecourtFlags(station) {
  if (!station) return [];
  const out = [];
  const low = (station.tanks || []).filter((t) => tankStatus(t).level === 'low');
  if (low.length) out.push({ tone: 'danger', text: `${low.map((t) => t.code).join(', ')} below low level` });
  if (num(station.shifts && station.shifts.open)) out.push({ tone: 'info', text: `${station.shifts.open} shift${station.shifts.open === 1 ? '' : 's'} open` });
  return out;
}

// Share of the group's takings that is fuel, 0…1.
export function fuelShare(rollup) {
  const total = num(rollup && rollup.takings_total);
  return total > 0 ? Math.min(1, Math.max(0, num(rollup.takings_fuel) / total)) : 0;
}
