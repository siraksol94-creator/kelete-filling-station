// Profit Report — Shop | Fuel | Station total. Pure arithmetic shared by the
// screen and the A4 print, so both always show the same figures.
//
//   shop    = the stored daily profit (inventory/sales/range-summary), with the
//             credit-ticket fuel it contains moved out (it was shop revenue with
//             no cost behind it);
//   fuel    = closed shifts (/api/fuel-profit): metered litres × price, cost at
//             the frozen (or today's) average cost, shifts' cash short/over;
//   station = shop + fuel, with expenses (payment vouchers and loan interest)
//             taken once, at station level — they are not split by side.

const n = (v) => Number(v) || 0;
const r2 = (v) => Math.round(n(v) * 100) / 100;

// rows: { key, label, op, shop, fuel, station, total? }  null = not applicable
export function stationPL(range = {}, fuel = {}) {
  const f = fuel.totals || {};
  const credit = n(fuel.credit_in_shop);
  const shopSales = r2(n(range.revenue) - credit);
  const shopGross = r2(n(range.gross_profit) - credit);
  const fuelGross = r2(f.gross_profit);
  const expenses = r2(n(range.gross_profit) - n(range.net_profit));   // vouchers + loan interest
  const stationGross = r2(shopGross + fuelGross);
  const sum = (a, b) => r2(n(a) + n(b));

  const rows = [
    { key: 'sales', label: 'Sales', op: '', shop: shopSales, fuel: r2(f.revenue), station: sum(shopSales, f.revenue) },
    { key: 'cost', label: 'Cost of sales', op: '−', shop: r2(range.cogs), fuel: r2(f.cost), station: sum(range.cogs, f.cost) },
    { key: 'damages', label: 'Damages', op: '−', shop: r2(range.damages), fuel: null, station: r2(range.damages) },
    { key: 'rebates', label: 'Supplier rebates', op: '+', shop: r2(range.supplier_rebates), fuel: null, station: r2(range.supplier_rebates) },
    { key: 'stock', label: 'Stock variance', op: '±', shop: r2(range.diff_value), fuel: null, station: r2(range.diff_value) },
    { key: 'cash', label: 'Cash short / over', op: '±', shop: r2(range.cash_difference), fuel: r2(f.cash_variance), station: sum(range.cash_difference, f.cash_variance) },
    { key: 'gross', label: 'Gross profit', op: '=', shop: shopGross, fuel: fuelGross, station: stationGross, total: true },
    { key: 'expenses', label: 'Expenses & loan interest', op: '−', shop: null, fuel: null, station: expenses },
    { key: 'net', label: 'Net profit', op: '=', shop: null, fuel: null, station: r2(stationGross - expenses), total: true },
  ];
  const stationSales = rows[0].station;
  return {
    rows,
    credit,
    net: rows[rows.length - 1].station,
    gross: stationGross,
    sales: stationSales,
    grossMargin: stationSales > 0 ? stationGross / stationSales : null,
    shopShare: stationSales > 0 ? shopSales / stationSales : null,
  };
}

// Month to date: the stored monthly shop figures + the month's fuel.
export function stationMonth(monthly = {}, fuelMonth = {}) {
  const f = fuelMonth.totals || {};
  const credit = n(fuelMonth.credit_in_shop);
  return {
    sales: r2(n(monthly.total_revenue) - credit + n(f.revenue)),
    gross: r2(n(monthly.gross_profit) - credit + n(f.gross_profit)),
    net: r2(n(monthly.net_profit) - credit + n(f.gross_profit)),
    litres: n(f.litres),
    stockDifference: r2(monthly.total_difference),
  };
}

// First day of the month of `ymd`, and the month's last day capped at `today`.
export function monthRange(ymd, today) {
  const m = String(ymd || today).slice(0, 7);
  const [y, mo] = m.split('-').map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  return { from: `${m}-01`, to: today && last > today ? today : last };
}

// Quick ranges for the date bar (business dates, YYYY-MM-DD).
export function quickRanges(today) {
  const d = new Date(`${today}T00:00:00Z`);
  const iso = (x) => x.toISOString().slice(0, 10);
  const add = (days) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + days); return iso(x); };
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const firstThis = `${today.slice(0, 7)}-01`;
  const lastPrev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return [
    { key: 'today', label: 'Today', from: today, to: today },
    { key: 'yesterday', label: 'Yesterday', from: add(-1), to: add(-1) },
    { key: 'week', label: 'This week', from: add(-dow), to: today },
    { key: 'month', label: 'This month', from: firstThis, to: today },
    { key: 'lastmonth', label: 'Last month', from: `${iso(lastPrev).slice(0, 7)}-01`, to: iso(lastPrev) },
  ];
}

// Bar length for a grade's margin per litre (0–100), against the best grade.
export function marginBar(value, best) {
  const v = n(value), b = n(best);
  if (!(b > 0) || v <= 0) return 0;
  return Math.max(4, Math.min(100, Math.round((v / b) * 100)));
}
