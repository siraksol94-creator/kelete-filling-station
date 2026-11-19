// UX-7 — the Tank Ledger level chart's data (ledgerSeries.js; the drawing is LedgerChart.js) (pure, tested): one point per
// movement with the balance after it, starting from the opening balance.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function ledgerSeries(openingBefore, rows, fromDate) {
  const pts = [{ date: String(fromDate || '').slice(0, 10), balance: num(openingBefore), type: 'start', change: 0 }];
  for (const r of rows || []) {
    pts.push({ date: String(r.movement_date || '').slice(0, 10), balance: num(r.balance_after), type: r.type || 'adjustment', change: num(r.litres) });
  }
  return pts;
}

// Totals for the range: litres in (deliveries), out (sales), dip / other corrections.
export function ledgerTotals(rows) {
  const t = { delivered: 0, sold: 0, corrected: 0 };
  for (const r of rows || []) {
    const v = num(r.litres);
    if (r.type === 'delivery') t.delivered += v;
    else if (r.type === 'sale') t.sold += -v;
    else if (r.type !== 'opening') t.corrected += v;
  }
  return t;
}

// The y-axis top: the tank's capacity if known, else a little above the highest point.
export function ledgerTop(points, capacity) {
  const hi = Math.max(0, ...points.map((p) => p.balance));
  const cap = num(capacity);
  return cap > 0 ? Math.max(cap, hi) : Math.max(1, hi * 1.1);
}

// Round axis steps: 0, 10k, 20k… (1, 2, 2.5 or 5 × a power of ten).
export function niceTicks(top, want = 4) {
  const t = Math.max(1, num(top));
  const raw = t / want;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw) || 10 * p;
  const out = [];
  // …ending on the first step at or above `top`, so the highest point fits under it.
  for (let v = 0; ; v += step) { out.push(Math.round(v * 100) / 100); if (v >= t - 1e-9) break; }
  return out;
}
