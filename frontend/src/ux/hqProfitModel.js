// HQ Consolidated Profit — Shop | Fuel | Station for every branch and the
// group. Pure. Same rules as the branch Profit Report (ux/profitModel.js):
//   shop    = the branch's stored daily profit, with the credit-ticket fuel it
//             contains moved out (it sat there with no cost);
//   fuel    = closed shifts (fuel.totals / fuel.daily from the server);
//   station = shop + fuel; branch expenses (vouchers + loan interest) taken
//             once; HQ overhead taken once at group level.
// A branch whose fuel could not be read (fuel === null) shows shop only and
// is listed in `noFuel`.

const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round(n(v) * 100) / 100;

// One line (a branch's period, or one of its days).
// shop: { revenue, gross, net }   fuel: { revenue, cost, gross_profit, litres, credit_in_shop, margin }
function line(shop, fuel) {
  const credit = n(fuel && fuel.credit_in_shop);
  const shopSales = r2(n(shop.revenue) - credit);
  const shopGross = r2(n(shop.gross) - credit);
  const fuelSales = r2(fuel && fuel.revenue);
  const fuelGross = r2(fuel && fuel.gross_profit);
  const expenses = r2(n(shop.gross) - n(shop.net));
  const gross = r2(shopGross + fuelGross);
  const litres = n(fuel && fuel.litres);
  const margin = r2(fuel && (fuel.margin != null ? fuel.margin : n(fuel.revenue) - n(fuel.cost)));
  return {
    shopSales, fuelSales, sales: r2(shopSales + fuelSales),
    shopGross, fuelGross, gross,
    expenses, net: r2(gross - expenses),
    litres, fuelMargin: margin,
    perLitre: litres > 0 ? r2(margin / litres) : null,
    credit,
  };
}

export function branchLine(b) {
  const t = b.totals || {};
  const f = b.fuel ? { ...b.fuel.totals, credit_in_shop: b.fuel.credit_in_shop } : null;
  return { slug: b.slug, name: b.name, hasFuel: !!b.fuel, estimatedLitres: n(b.fuel && b.fuel.totals && b.fuel.totals.estimated_litres), ...line(t, f) };
}

// A branch's days: stored shop days merged with fuel days (either may be
// missing on a given date). Days with nothing at all are left out.
export function branchDays(b) {
  const fuelByDate = new Map(((b.fuel && b.fuel.daily) || []).map((d) => [d.date, d]));
  const dates = new Set([...(b.daily || []).map((d) => d.date), ...fuelByDate.keys()]);
  const shopByDate = new Map((b.daily || []).map((d) => [d.date, d]));
  return [...dates].sort().map((date) => {
    const s = shopByDate.get(date) || {};
    const f = fuelByDate.get(date) || null;
    return { date, ...line({ revenue: s.revenue, gross: s.gross, net: s.net }, f) };
  }).filter((d) => d.sales || d.gross || d.expenses || d.net || d.litres);
}

// Grades across branches, matched by code (then name).
export function groupGrades(branches = []) {
  const m = new Map();
  for (const b of branches) {
    for (const g of (b.fuel && b.fuel.grades) || []) {
      const key = String(g.code || g.name || '').toUpperCase();
      let x = m.get(key);
      if (!x) { x = { key, code: g.code, name: g.name, color: g.color, litres: 0, revenue: 0, cost: 0, estimated_litres: 0, branches: 0 }; m.set(key, x); }
      x.litres += n(g.litres); x.revenue += n(g.revenue); x.cost += n(g.cost);
      x.estimated_litres += n(g.estimated_litres); x.branches += 1;
    }
  }
  return [...m.values()].map((x) => {
    const margin = r2(x.revenue - x.cost);
    return { ...x, litres: Math.round(x.litres * 1000) / 1000, revenue: r2(x.revenue), cost: r2(x.cost), margin,
      margin_per_litre: x.litres > 0 ? r2(margin / x.litres) : 0 };
  }).sort((a, b) => b.revenue - a.revenue);
}

export function hqGroup(data = {}) {
  const branches = (data.branches || []).map(branchLine);
  const sum = (k) => r2(branches.reduce((a, b) => a + n(b[k]), 0));
  const hq = r2(data.hq_overhead && data.hq_overhead.total);
  const branchNet = sum('net');
  const sales = sum('sales');
  const gross = sum('gross');
  const litres = branches.reduce((a, b) => a + n(b.litres), 0);
  const fuelMargin = sum('fuelMargin');
  return {
    branches,
    shopSales: sum('shopSales'), fuelSales: sum('fuelSales'), sales,
    gross, expenses: sum('expenses'), branchNet,
    hqOverhead: hq,
    groupNet: r2(branchNet - hq),
    grossMargin: sales > 0 ? gross / sales : null,
    shopShare: sales > 0 ? sum('shopSales') / sales : null,
    litres, fuelMargin,
    perLitre: litres > 0 ? r2(fuelMargin / litres) : null,
    credit: sum('credit'),
    estimatedLitres: branches.reduce((a, b) => a + b.estimatedLitres, 0),
    noFuel: branches.filter((b) => !b.hasFuel).map((b) => b.name),
    grades: groupGrades(data.branches || []),
  };
}
