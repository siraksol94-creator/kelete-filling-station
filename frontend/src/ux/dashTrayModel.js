// UX-12 — counts for the Dashboard shortcuts tray. Pure.

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
