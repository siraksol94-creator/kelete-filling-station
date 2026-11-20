// Sales Report helpers. Pure; the report keeps all of its own totals, rules,
// reversals, credit notes and ZRA handling — these only shape what is shown.

const n = (v) => parseFloat(v || 0) || 0;
const r2 = (v) => Math.round(n(v) * 100) / 100;

// Local hour of a sale. created_at is UTC "YYYY-MM-DD HH:MM:SS" (SQLite), the
// same reading the report's own date filter uses (new Date(x + 'Z')).
export function localHour(createdAt) {
  const d = new Date(`${String(createdAt || '').replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d.getHours();
}

// Sales through the day: one bucket per hour that saw a sale, from the first
// to the last such hour (gaps in between kept, so the shape of the day reads
// true). Reversed sales are left out, like every other total on the page.
export function salesByHour(orders = []) {
  const by = new Map();
  for (const o of orders) {
    if (o.status === 'Reversed') continue;
    const h = localHour(o.created_at);
    if (h == null) continue;
    const b = by.get(h) || { hour: h, count: 0, total: 0 };
    b.count += 1; b.total += n(o.total_amount);
    by.set(h, b);
  }
  if (!by.size) return { hours: [], busiest: null, max: 0 };
  const hs = [...by.keys()];
  const lo = Math.min(...hs), hi = Math.max(...hs);
  const hours = [];
  for (let h = lo; h <= hi; h += 1) {
    const b = by.get(h) || { hour: h, count: 0, total: 0 };
    hours.push({ ...b, total: r2(b.total) });
  }
  const busiest = hours.reduce((a, b) => (b.total > a.total ? b : a), hours[0]);
  return { hours, busiest, max: busiest.total };
}

export const hourLabel = (h) => {
  const x = ((h % 24) + 24) % 24;
  const ampm = x < 12 ? 'am' : 'pm';
  const k = x % 12 === 0 ? 12 : x % 12;
  return `${k}${ampm}`;
};

// How customers paid: parts of a whole, largest first, zero parts dropped.
export function payMix(parts = []) {
  const list = parts.map((p) => ({ ...p, amount: r2(p.amount) })).filter((p) => p.amount > 0.004);
  const total = r2(list.reduce((a, p) => a + p.amount, 0));
  return {
    total,
    parts: list.sort((a, b) => b.amount - a.amount).map((p) => ({ ...p, share: total > 0 ? p.amount / total : 0 })),
  };
}

// A short "paid by" label for a sale row.
export function paidBy(o = {}) {
  const pm = String(o.payment_method || '').trim();
  if (!pm) return { label: '—', tone: 'other' };
  const k = pm.toLowerCase();
  if (k === 'cash') return { label: 'Cash', tone: 'cash' };
  if (k === 'momo' || k.includes('mobile')) return { label: 'MoMo', tone: 'momo' };
  if (k === 'bank' || k.includes('card') || k.includes('swipe')) return { label: pm === 'Bank' ? 'Bank' : pm, tone: 'bank' };
  if (k === 'credit') return { label: 'Credit', tone: 'credit' };
  if (k === 'partial-credit') return { label: 'Part credit', tone: 'credit' };
  return { label: pm, tone: 'other' };
}
