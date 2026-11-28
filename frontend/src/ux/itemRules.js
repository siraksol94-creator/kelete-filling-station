// Rules about items and categories shared by Item Details, Categories and
// HQ Purchase. Kept free of React so the tests can run them directly.

// Where a category's items are sold. NULL or '' is read as 'both', so the
// categories that existed before this setting keep working everywhere.
export const SOLD_AT = ['fuel', 'shop', 'both'];
export const SOLD_AT_LABEL = { fuel: 'Fuel stations', shop: 'Shops', both: 'Fuel stations and shops' };

export function soldAtOf(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'fuel' || s === 'shop' ? s : 'both';
}

// Can an item sold at `soldAt` go to a branch of this kind ('fuel' | 'shop')?
export function soldAtFits(soldAt, kind) {
  const s = soldAtOf(soldAt);
  return s === 'both' || s === kind;
}

// The products the till makes for fuel credit tickets ("FUEL-DSL Diesel").
// They are managed under Fuel Grades and carry no category; showing them in
// Item Details put litres of diesel among the shop stock with a margin.
// An item someone deliberately filed under a category is never hidden.
export function isFuelSystemItem(item) {
  return /^FUEL-/i.test(String(item?.code || '')) && !item?.category_id;
}

export function shopItems(items) {
  return (items || []).filter(i => !isFuelSystemItem(i));
}

export function uncategorised(items) {
  return (items || []).filter(i => !i.category_id);
}
