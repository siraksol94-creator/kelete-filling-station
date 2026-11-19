// UX-12 — Pay box helper. Pure: the till keeps all of its own sale rules;
// this only suggests amounts a customer is likely to hand over.

// In Zambian notes: the exact total, then the next round amounts above it.
// At most four, all at or above the total, no repeats.
export function quickCash(total) {
  const t = Math.round((Number(total) || 0) * 100) / 100;
  if (!(t > 0)) return [];
  const out = [t];
  for (const step of [10, 20, 50, 100, 200, 500]) {
    const v = Math.ceil(t / step) * step;
    if (v > t && !out.includes(v)) out.push(v);
    if (out.length >= 4) break;
  }
  return out;
}
