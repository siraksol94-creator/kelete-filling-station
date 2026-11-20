// Cash Book (Kelete: Kwacha only, Cash / Mobile Money / Bank). Pure helpers
// for the ledger view. The server's rows are untouched; these only decide how
// they read:
//   • every row's money in / out is the sum of its USD/FRA/K columns, as the
//     old IN / OUT columns did;
//   • a transfer between accounts (TRF) or an exchange (EXCH) puts the same
//     amount in and out — it is shown once, as "moved", and kept out of the
//     money-in / money-out totals (the balance is unaffected either way);
//   • the running balance is the server's, after the row.

const n = (v) => parseFloat(v || 0) || 0;
const r2 = (v) => Math.round(n(v) * 100) / 100;

const KINDS = {
  CR:          { label: 'Receipt',             tone: 'in' },
  'DEP-IN':    { label: 'Deposit received',    tone: 'in' },
  'CAP-IN':    { label: "Owner's capital in",  tone: 'in' },
  'LOAN-IN':   { label: 'Loan received',       tone: 'in' },
  PV:          { label: 'Payment voucher',     tone: 'out' },
  AP:          { label: 'Supplier payment',    tone: 'out' },
  'DEP-OUT':   { label: 'Deposit sent',        tone: 'dep' },
  'CAP-OUT':   { label: "Owner's drawing",     tone: 'out' },
  DIV:         { label: 'Dividend',            tone: 'out' },
  'LOAN-PRIN': { label: 'Loan repayment',      tone: 'out' },
  'LOAN-INT':  { label: 'Loan interest',       tone: 'out' },
  TRF:         { label: 'Moved between accounts', tone: 'move' },
  EXCH:        { label: 'Exchange',            tone: 'move' },
};

export const isFuelReceipt = (e) => e && e.type === 'CR' && /^fuel sales\b/i.test(String(e.description || ''));

export function kindOf(e, depositTo = 'HQ') {
  if (isFuelReceipt(e)) return { key: 'fuel', label: 'Fuel takings', tone: 'fuel' };
  const k = KINDS[e && e.type];
  if (!k) return { key: String((e && e.type) || ''), label: String((e && e.type) || 'Entry'), tone: 'other' };
  const label = e.type === 'DEP-OUT' ? `Deposit to ${depositTo}` : k.label;
  return { key: e.type, label, tone: k.tone };
}

export function moneyOf(e) {
  const inn = n(e.usd_in) + n(e.fra_in) + n(e.k_in);
  const out = n(e.usd_out) + n(e.fra_out) + n(e.k_out);
  const move = e.type === 'TRF' || e.type === 'EXCH';
  return {
    in: move ? 0 : r2(inn),
    out: move ? 0 : r2(out),
    moved: move ? r2(Math.max(inn, out)) : 0,
    balance: r2(n(e.balance_usd) + n(e.balance_fra) + n(e.balance_k)),
  };
}

export function periodTotals(entries = []) {
  const t = entries.reduce((a, e) => {
    const m = moneyOf(e);
    a.in += m.in; a.out += m.out; a.moved += m.moved;
    if (isFuelReceipt(e)) a.fuel += m.in;
    return a;
  }, { in: 0, out: 0, moved: 0, fuel: 0 });
  return { in: r2(t.in), out: r2(t.out), moved: r2(t.moved), fuel: r2(t.fuel), net: r2(t.in - t.out), count: entries.length };
}

// Filters for the chips above the ledger.
export const FILTERS = [
  { key: 'all', label: 'Everything' },
  { key: 'in', label: 'Money in' },
  { key: 'out', label: 'Money out' },
  { key: 'fuel', label: 'Fuel takings' },
  { key: 'move', label: 'Transfers' },
  { key: 'dep', label: 'Deposits' },
];

export function matches(e, filter = 'all', q = '') {
  const k = kindOf(e);
  const m = moneyOf(e);
  if (filter === 'in' && !(m.in > 0)) return false;
  if (filter === 'out' && !(m.out > 0)) return false;
  if (filter === 'fuel' && k.tone !== 'fuel') return false;
  if (filter === 'move' && k.tone !== 'move') return false;
  if (filter === 'dep' && !(e.type === 'DEP-IN' || e.type === 'DEP-OUT')) return false;
  const s = String(q || '').trim().toLowerCase();
  if (!s) return true;
  return [e.description, e.reference, k.label].some((x) => String(x || '').toLowerCase().includes(s));
}

// Rows (already filtered) grouped by day, newest day first, rows inside a day
// in the order they happened (so the running balance reads down the day).
export function groupDays(rows = []) {
  const by = new Map();
  for (const e of rows) {
    const d = String(e.date || '').slice(0, 10);
    if (!by.has(d)) by.set(d, []);
    by.get(d).push(e);
  }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, list]) => {
    const t = periodTotals(list);
    return { date, rows: list, in: t.in, out: t.out, moved: t.moved, closing: moneyOf(list[list.length - 1]).balance };
  });
}

// Each account (Cash / MoMo / Bank): opening → now, and the change.
export function accounts(stats = {}, shown = () => true) {
  const list = [
    { key: 'cash', label: 'Cash on hand' },
    { key: 'momo', label: 'Mobile money' },
    { key: 'bank', label: 'Cash at bank' },
  ].map((a) => {
    const open = r2(stats.openingByMethod && stats.openingByMethod[a.key]);
    const now = r2(stats.currentByMethod && stats.currentByMethod[a.key]);
    return { ...a, open, now, change: r2(now - open) };
  }).filter((a) => shown(a.key) || Math.abs(a.now) > 0.004 || Math.abs(a.open) > 0.004);
  const now = r2(list.reduce((s, a) => s + a.now, 0));
  const open = r2(list.reduce((s, a) => s + a.open, 0));
  return { list, now, open, change: r2(now - open), shares: list.map((a) => ({ key: a.key, share: now > 0 ? Math.max(0, a.now) / now : 0 })) };
}

// Rows for Excel / CSV / PDF: the figures the screen shows.
export function exportRows(entries = [], depositTo = 'HQ') {
  return entries.map((e) => {
    const m = moneyOf(e);
    return {
      date: e.date, description: e.description, reference: e.reference,
      type: kindOf(e, depositTo).label,
      money_in: m.in || m.moved || 0,
      money_out: m.out || m.moved || 0,
      balance: m.balance,
    };
  });
}
