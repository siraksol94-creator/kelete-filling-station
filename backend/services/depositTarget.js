// depositTarget — where a depot's cash deposits go.
//
// 2026-09-15. System Settings → Deposit to (business_settings.deposit_to_slug).
// Empty = HQ, every depot's default. A depot slug (e.g. Bankers → kabwe) sends
// this depot's deposits — manual and Auto deposit — to that depot, which
// confirms them and books them as money received; HQ does not see them.
//
// Returns { slug, name } for another depot, or null for HQ. Anything that does
// not point at a real, different depot is treated as HQ.

function depositTargetFor(slug) {
  try {
    const { isRegistered, listTenants } = require('../config/masterDb');
    const { getTenantDb } = require('../config/tenantDb');
    const from = String(slug || '').toLowerCase().trim();
    if (!from || !isRegistered(from)) return null;
    const row = getTenantDb(from)
      .prepare('SELECT deposit_to_slug FROM business_settings ORDER BY id ASC LIMIT 1').get();
    const to = String(row?.deposit_to_slug || '').toLowerCase().trim();
    if (!to || to === from || !isRegistered(to)) return null;
    let name = null;
    try {
      name = getTenantDb(to).prepare('SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1').get()?.business_name || null;
    } catch (_) { /* fall back below */ }
    if (!name) name = listTenants().find(t => t.slug === to)?.business_name || to;
    return { slug: to, name };
  } catch (_) {
    return null; // column not added yet, or the depot's book unreadable → HQ
  }
}

module.exports = { depositTargetFor };
