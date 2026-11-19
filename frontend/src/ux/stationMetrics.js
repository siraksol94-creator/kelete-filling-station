// UX-3 — pure helpers for the Station Dashboard (unit-tested in CI).
// They only rearrange figures the server sent; nothing is recalculated.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Tank level → status. "low" uses the tank's own low level when it has one,
// otherwise a quarter of capacity counts as "watch".
export function tankStatus(t) {
  const cap = num(t && t.capacity);
  const vol = Math.max(0, num(t && t.volume));
  const pct = cap > 0 ? Math.min(1, vol / cap) : 0;
  const low = t && t.low_level != null ? num(t.low_level) : null;
  let level = 'ok';
  if (low != null && vol <= low) level = 'low';
  else if (pct < 0.25) level = 'watch';
  return { pct, level, litres: vol, capacity: cap, lowPct: low != null && cap > 0 ? Math.min(1, low / cap) : null };
}

// Today's takings split between fuel and the shop.
export function takingsSplit(todaySales, todayFuelSales) {
  const total = Math.max(0, num(todaySales));
  const fuel = Math.max(0, Math.min(total, num(todayFuelSales)));
  const shop = Math.max(0, total - fuel);
  return { total, fuel, shop, fuelPct: total > 0 ? fuel / total : 0 };
}

// A round top value for a shared scale (so gauges and bars compare fairly).
export function niceMax(values, minimum = 10) {
  const m = Math.max(minimum, ...(values || []).map(num));
  const mag = Math.pow(10, Math.floor(Math.log10(m)));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (step * mag >= m * 1.08) return step * mag;
  return 10 * mag;
}

// Steps done for the day's shifts (closed → cash → approved), from the
// station block's counts.
export function shiftSteps(shifts) {
  const s = shifts || {};
  const total = num(s.total);
  const done = num(s.closed) + num(s.cash) + num(s.approved);
  return { total, done, max: total * 3, pct: total ? done / (total * 3) : 0, complete: total > 0 && done === total * 3 };
}

// Weekly trend rows → bars with the fuel and shop parts.
export function trendBars(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const total = num(r.total);
    const fuel = Math.min(total, num(r.fuel));
    return { date: r.date, total, fuel, shop: Math.max(0, total - fuel) };
  });
}

export function alerts(station) {
  if (!station) return [];
  const out = [];
  for (const t of station.tanks || []) {
    const st = tankStatus(t);
    if (st.level === 'low') out.push({ kind: 'tank', tone: 'danger', text: `${t.code} is below its low level (${Math.round(st.litres).toLocaleString('en-ZM')} L)` });
  }
  if (num(station.shifts && station.shifts.open)) out.push({ kind: 'shift', tone: 'info', text: `${station.shifts.open} shift${station.shifts.open === 1 ? '' : 's'} still open` });
  const waiting = num(station.shifts && station.shifts.closed) - num(station.shifts && station.shifts.cash);
  if (waiting > 0) out.push({ kind: 'cash', tone: 'warn', text: `${waiting} closed shift${waiting === 1 ? ' is' : 's are'} waiting for cash entry` });
  return out;
}
