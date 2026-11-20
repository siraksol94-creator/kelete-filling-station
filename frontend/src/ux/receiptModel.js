// Cash receipts: how much of a receipt is in each slot of the screen.
// On a Kwacha book (Cash / Mobile Money / Bank — "Liquor style") the slots
// are METHODS: u = Cash, f = Mobile Money, k = Bank. Every writer there fills
// the method columns (cash_amount / momo_amount / bank_amount), but not the
// usd / fra / k slots the same way — the fuel day receipt keeps its whole
// total in k_amount, a customer payment leaves the slots at 0 — so a receipt
// with any method amount is read from the methods, one without from its
// slots. Same rule as GET /api/cash-receipts/stats (2026-11-20).
// A multi-currency book keeps the old reading: slot first, else the old
// column (cash → usd, bank → fra, momo → k).
const pf = (v) => parseFloat(v || 0) || 0;

export function receiptSplit(r = {}, kwachaBook = true) {
  if (kwachaBook) {
    const methods = pf(r.cash_amount) + pf(r.momo_amount) + pf(r.bank_amount);
    return methods > 0
      ? { u: pf(r.cash_amount), f: pf(r.momo_amount), k: pf(r.bank_amount) }
      : { u: pf(r.usd_amount), f: pf(r.fra_amount), k: pf(r.k_amount) };
  }
  return {
    u: pf(r.usd_amount) > 0 ? pf(r.usd_amount) : pf(r.cash_amount),
    f: pf(r.fra_amount) > 0 ? pf(r.fra_amount) : pf(r.bank_amount),
    k: pf(r.k_amount) > 0 ? pf(r.k_amount) : pf(r.momo_amount),
  };
}
