// UX-7 — the Forecourt kit's pure helpers (tested in CI): how money, litres
// and dates read on every fuel screen, and the dip variance band.
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// K 12,345.00 — always two decimals, thousands separated, minus sign kept.
export const fmtK = (n) => `K ${num(n).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// 30,000 L (or 1,234.56 L with dp = 2).
export const fmtL = (n, dp = 0) => `${num(n).toLocaleString('en-ZM', { minimumFractionDigits: dp, maximumFractionDigits: dp })} L`;
// +12.50 L / −60.00 L / 0.00 L — a variance, always with its sign, never rounded away.
export const fmtSignedL = (n, dp = 2) => {
  const v = num(n);
  const s = Math.abs(v).toLocaleString('en-ZM', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s} L`;
};

// "Thu 19 Nov" (and the year when it isn't this year). Unknown → "—".
export function fmtDay(ymd, thisYear = new Date().getFullYear()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return '—';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return +m[1] === thisYear ? day : `${day} ${m[1]}`;
}

// "today" / "yesterday" / "3 days ago" / "in 2 days" between two YYYY-MM-DD.
export function daysAgo(ymd, today) {
  const a = Date.parse(`${String(ymd || '').slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(today || '').slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  const d = Math.round((b - a) / 86400000);
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d > 1) return `${d} days ago`;
  return d === -1 ? 'tomorrow' : `in ${-d} days`;
}

// Dip variance against the book volume (business decision 2026-11-19):
//   within ±0.5%  → ok      ("Within 0.5%")
//   up to ±1%     → watch   ("0.5–1% out")
//   beyond ±1%    → high    ("Over 1% out")
// The variance itself is always shown in full beside the band.
export const DIP_BAND = { ok: 0.005, watch: 0.01 };
export function dipBand(variance, bookLitres) {
  if (variance === '' || variance == null) return null;
  const v = Number(variance);
  if (!Number.isFinite(v)) return null;
  const base = Math.abs(num(bookLitres));
  const pct = base > 0 ? Math.abs(v) / base : (Math.abs(v) > 0 ? Infinity : 0);
  const level = pct <= DIP_BAND.ok ? 'ok' : pct <= DIP_BAND.watch ? 'watch' : 'high';
  const label = level === 'ok' ? 'Within 0.5%' : level === 'watch' ? '0.5–1% out' : 'Over 1% out';
  return { level, pct, label };
}

// Space left in a tank (never negative).
export const spaceLeft = (capacity, volume) => Math.max(0, num(capacity) - num(volume));

// UX-8 — a delivery checked three ways: what was ordered, what the invoice
// says was delivered, and what the dips show went in (dip after − dip
// before). Differences are shown in full; the band uses the same ±0.5% /
// ±1% rule as the dips, measured against the litres delivered.
export function deliveryCheck(d) {
  const has = (v) => v !== '' && v != null && Number.isFinite(Number(v));
  const delivered = num(d && d.litres_delivered);
  const ordered = has(d && d.litres_ordered) ? num(d.litres_ordered) : null;
  const dipped = has(d && d.dip_before) && has(d && d.dip_after) ? num(d.dip_after) - num(d.dip_before) : null;
  const vsOrdered = ordered == null ? null : Math.round((delivered - ordered) * 100) / 100;
  const vsDipped = dipped == null ? null : Math.round((dipped - delivered) * 100) / 100;
  const band = vsDipped == null ? null : dipBand(vsDipped, delivered);
  return { delivered, ordered, dipped, vsOrdered, vsDipped, band };
}

// Will a delivery fit? The tank after it, and by how much it would overflow.
export function fitCheck(capacity, current, litres) {
  const cap = num(capacity), now = num(current), add = Math.max(0, num(litres));
  const after = now + add;
  const over = cap > 0 ? Math.max(0, after - cap) : 0;
  return { after, over, fits: over === 0, space: Math.max(0, cap - now), pctAfter: cap > 0 ? Math.min(1, after / cap) : 0 };
}

// UX-9 — margin per litre: selling price − weighted-average cost.
export function gradeMargin(selling, cost) {
  const s = num(selling), c = num(cost);
  const perL = Math.round((s - c) * 10000) / 10000;
  return { perL, pct: s > 0 ? perL / s : 0, below: perL < 0, unknownCost: c <= 0 };
}

// A customer's credit after a new ticket: limit, owed now, owed after, and
// how far over the limit it would go (0 if within). No limit → limit null.
export function creditUse(customer, newAmount = 0) {
  const limit = num(customer && customer.credit_limit);
  const owed = num(customer && customer.outstanding);
  const after = owed + Math.max(0, num(newAmount));
  if (!(limit > 0)) return { limit: null, owed, after, pct: null, over: 0 };
  return { limit, owed, after, pct: Math.min(1, after / limit), over: Math.max(0, Math.round((after - limit) * 100) / 100) };
}

// Totals for a list of credit / 1Card tickets, with litres by grade.
export function ticketSummary(rows) {
  const byGrade = new Map();
  let litres = 0, amount = 0;
  for (const r of rows || []) {
    const l = num(r.litres), a = num(r.amount);
    litres += l; amount += a;
    const k = r.grade_name || '—';
    const g = byGrade.get(k) || { name: k, color: r.grade_color || '#64748b', litres: 0, amount: 0 };
    g.litres += l; g.amount += a; byGrade.set(k, g);
  }
  return {
    count: (rows || []).length,
    litres: Math.round(litres * 100) / 100,
    amount: Math.round(amount * 100) / 100,
    grades: [...byGrade.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
