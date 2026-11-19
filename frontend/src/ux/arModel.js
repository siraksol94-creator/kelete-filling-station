// UX-11 — Account Receivables (pure, tested): debt ageing totals across
// customers, each customer's oldest debt, and credit-limit use.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export const AGE_BUCKETS = [
  { key: 'current', label: 'Not yet due', short: 'Not due', color: '#0e7490' },
  { key: '1_30', label: '1–30 days over', short: '1–30', color: '#ca8a04' },
  { key: '31_60', label: '31–60 days over', short: '31–60', color: '#ea580c' },
  { key: '61_90', label: '61–90 days over', short: '61–90', color: '#dc2626' },
  { key: '90_plus', label: 'Over 90 days', short: '90+', color: '#7f1d1d' },
];

// Totals per bucket across customers, and how many customers have money in each.
export function ageingTotals(rows) {
  const out = AGE_BUCKETS.map((b) => ({ ...b, amount: 0, customers: 0 }));
  let total = 0;
  for (const r of rows || []) {
    out.forEach((b) => { const v = Math.max(0, num(r[b.key])); if (v > 0.005) { b.amount += v; b.customers += 1; } });
  }
  for (const b of out) { b.amount = Math.round(b.amount * 100) / 100; total += b.amount; }
  return { buckets: out, total: Math.round(total * 100) / 100 };
}

// The oldest bucket a customer still owes money in (null if nothing owed).
export function oldestBucket(row) {
  if (!row) return null;
  for (let i = AGE_BUCKETS.length - 1; i >= 0; i -= 1) if (num(row[AGE_BUCKETS[i].key]) > 0.005) return AGE_BUCKETS[i];
  return null;
}

// Credit used: what is owed against the limit (no limit → null).
export function creditBar(limit, owed) {
  const l = num(limit), o = Math.max(0, num(owed));
  if (!(l > 0)) return null;
  return { pct: o / l, shown: Math.min(1, o / l), over: Math.max(0, Math.round((o - l) * 100) / 100), level: o > l ? 'over' : o / l >= 0.8 ? 'near' : 'ok' };
}
