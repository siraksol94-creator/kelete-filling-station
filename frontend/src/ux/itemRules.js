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

// ── HQ Purchase (decision 2026-11-28) ──────────────────────────────────────
// One purchase goes to one kind of branch. The first item that is sold only
// at fuel stations or only at shops decides which; items sold at both fit
// either. An item with no category can't be bought until it has one.
export function purchaseKind(lines) {
  for (const l of lines || []) {
    const s = l && l.sold_at !== undefined ? soldAtOf(l.sold_at) : 'both';
    if (l && l.has_category && s !== 'both') return s;
  }
  return 'both';
}

// Why this line can't be on this purchase, or null. `kind` is the purchase's
// kind ('fuel' | 'shop' | 'both'); `destKind` the picked branch's, if any.
export function purchaseLineProblem(line, kind, destKind) {
  if (!line || !line.product_sync_id) return null;
  if (!line.has_category) return `"${line.name}" has no category. Give it one in Item Details before buying it.`;
  const s = soldAtOf(line.sold_at);
  const where = s === 'fuel' ? 'fuel stations' : 'shops';
  if (destKind && !soldAtFits(s, destKind)) {
    return `"${line.name}" is sold at ${where}; the branch picked is a ${destKind === 'fuel' ? 'fuel station' : 'shop'}. Raise a separate purchase for it.`;
  }
  if (kind !== 'both' && !soldAtFits(s, kind)) {
    return `"${line.name}" is sold at ${where}. This purchase is for ${kind === 'fuel' ? 'fuel stations' : 'shops'}; raise a separate purchase for it.`;
  }
  return null;
}

// The branches a purchase of this kind may go to. HQ itself never receives.
export function destinationsFor(branches, kind, kindOf) {
  return (branches || []).filter(b => {
    const k = kindOf(b);
    return k !== 'hq' && soldAtFits(kind, k);
  });
}

export function soldAtBadge(p) {
  if (!p || !p.category_id) return { label: 'No category', className: 'k-kind k-sold-none' };
  const s = soldAtOf(p.category_sold_at);
  return { label: s === 'both' ? 'Both' : s === 'fuel' ? 'Fuel stations' : 'Shops', className: `k-kind k-sold-${s}` };
}
