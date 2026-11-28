// What kind of place this install serves — one answer for the menu, the
// Dashboard and the colours (decision 2026-11-28):
//   'hq'   head office (the HQ address): no fuel, ever, whatever its settings say
//   'fuel' a fuel station: the forecourt AND its shop (POS for oils, drinks, airtime)
//   'shop' a shop only: no fuel menus, no forecourt on the Dashboard
// Stored per install as business_settings.business_type: 'fuel' (default) or
// 'grocery' (shown as "Shop"). Pure; tested in tests/ux/branchType.test.js.
export function branchKind({ hq = false, businessType = 'fuel' } = {}) {
  if (hq) return 'hq';
  const t = String(businessType || 'fuel').toLowerCase();
  return t === 'grocery' || t === 'shop' ? 'shop' : 'fuel';
}

export const KIND_LABEL = { fuel: 'Fuel station', shop: 'Shop', hq: 'Head office' };

// The Fuel Station menu, the forecourt on the Dashboard, weather, tanks.
export const hasForecourt = (kind) => kind === 'fuel';

// A branch row from /api/hq/overview → its kind (business_type 'grocery' = shop).
export const kindOfBranch = (b) => (String((b && b.business_type) || 'fuel').toLowerCase() === 'grocery' ? 'shop' : 'fuel');

// HQ Overview: fuel stations first, then shops, each A to Z, with the group's
// takings today (in full). Empty groups are left out. `name` gives the label
// used for sorting (the screen's short branch name).
export function groupBranches(branches, name = (b) => b.name || b.slug || '') {
  const groups = [
    { kind: 'fuel', label: 'Fuel stations', branches: [] },
    { kind: 'shop', label: 'Shops', branches: [] },
  ];
  for (const b of Array.isArray(branches) ? branches : []) {
    (kindOfBranch(b) === 'shop' ? groups[1] : groups[0]).branches.push(b);
  }
  const r2 = (n) => Math.round(n * 100) / 100;
  return groups
    .filter((g) => g.branches.length)
    .map((g) => {
      const list = [...g.branches].sort((a, b) => String(name(a)).localeCompare(String(name(b))));
      const ok = list.filter((b) => !b.error);
      const t = (k) => r2(ok.reduce((s, b) => s + (Number(b.takings ? b.takings[k] : (k === 'shop' || k === 'total' ? b.today && b.today.revenue : 0)) || 0), 0));
      return { ...g, branches: list, total: t('total'), fuel: t('fuel'), shop: t('shop') };
    });
}
