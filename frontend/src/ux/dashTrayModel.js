// UX-12 — Dashboard shortcuts tray. Pure.

// Which shortcut tiles to show, in order.
// - Point of Sale: anyone who may use the till. Shown at head office too
//   (the side menu hides it there), so the till is always one tap away.
// - Empty Vouchers: only where the side menu shows it — branch hosts.
// - Fuel (2026-11-28): fuel stations only — "a fuel station shows both POS and
//   Fuel, a shop only POS". Fuel comes first, as everywhere else.
export function trayTiles({ hq = false, canPos = false, canVouchers = false, kind = null, canFuel = true } = {}) {
  const tiles = [];
  if (kind === 'fuel' && !hq && canFuel) tiles.push('fuel');
  // HQ has no till (decision 2026-11-28): its Sales menu holds the HQ reports only.
  if (canPos && !hq) tiles.push('pos');
  if (!hq && canVouchers) tiles.push('vouchers');
  return tiles;
}

// Open (not yet redeemed) empties slips: ACTIVE with something left on them.
// The server already filters with active_only=1; this re-checks so a stale
// or unfiltered list can never inflate the badge.
export function voucherSummary(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const open = list.filter((r) => r && String(r.status || '').toUpperCase() === 'ACTIVE' && Number(r.qty_remaining) > 0);
  return {
    slips: open.length,
    units: open.reduce((a, r) => a + (Number(r.qty_remaining) || 0), 0),
  };
}
