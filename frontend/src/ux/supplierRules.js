// Supplier rules (decision 2026-11-28). Kept free of React for the tests.

export const SUPPLIES = ['fuel', 'shop', 'both'];
export const SUPPLIES_LABEL = { fuel: 'Fuel', shop: 'Shop', both: 'Fuel and shop' };

// NULL (a supplier from before the setting existed) reads as "both", so no
// existing supplier disappears from a picker until someone marks it.
export const suppliesOf = (s) => {
  const v = String((s && s.supplies) || '').toLowerCase();
  return v === 'fuel' || v === 'shop' ? v : 'both';
};
export const isActive = (s) => String((s && s.status) || 'Active') !== 'Inactive';

// 1Card tickets and fuel deliveries: fuel suppliers only (not shop-only, not
// inactive). Fuel-only suppliers are listed first, then the rest A to Z.
export function fuelSuppliers(list) {
  return (list || [])
    .filter((s) => isActive(s) && suppliesOf(s) !== 'shop')
    .sort((a, b) => (suppliesOf(a) === 'fuel' ? 0 : 1) - (suppliesOf(b) === 'fuel' ? 0 : 1)
      || String(a.name || '').localeCompare(String(b.name || '')));
}

// Suppliers screen filters.
export function supplierFilter(list, f) {
  const l = list || [];
  switch (f) {
    case 'fuel': return l.filter((s) => isActive(s) && suppliesOf(s) !== 'shop');
    case 'shop': return l.filter((s) => isActive(s) && suppliesOf(s) !== 'fuel');
    case 'owe': return l.filter((s) => Number(s.outstanding) > 0.005);
    case 'inactive': return l.filter((s) => !isActive(s));
    default: return l.filter(isActive);
  }
}

// "We owe K960.00" / "In credit K2,500.00" / "Settled": words, never a bare minus.
export function balanceWords(n, sym = 'K') {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  const k = `${sym}${Math.abs(v).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (v > 0) return { tone: 'owe', label: 'We owe', amount: k };
  if (v < 0) return { tone: 'credit', label: 'In credit', amount: k };
  return { tone: 'settled', label: 'Settled', amount: k };
}
