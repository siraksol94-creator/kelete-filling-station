// sortBranches — depot lists in the order people look for them.
//
// 2026-09-20. The list arrives newest-depot-first (listTenants orders by
// created_at DESC), so Bankers and Buwach sat at the top simply because they
// were added last, and finding a depot in a dropdown meant reading all of it.
//
// Sorted on the part people actually see: every name is stored as
// "Kelete Distribution - KABWE", so sorting the whole string files them all
// under R. The depot name is what follows the last dash, and the slug is the
// fallback for anything not written that way.
export const branchLabel = (b) => {
  const name = String(b?.name || b?.business_name || b?.slug || '');
  const dash = name.lastIndexOf('-');
  const tail = dash > -1 ? name.slice(dash + 1) : name;
  return tail.trim() || String(b?.slug || '');
};

export const sortBranches = (list) =>
  [...(Array.isArray(list) ? list : [])]
    .sort((a, b) => branchLabel(a).localeCompare(branchLabel(b), undefined, { sensitivity: 'base' }));
