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
