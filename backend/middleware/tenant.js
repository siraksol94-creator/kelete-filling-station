const { getTenantDb } = require('../config/tenantDb');
const { runWithDb } = require('../config/database');
const { isRegistered, masterDb } = require('../config/masterDb');

// v1.6.5: resolve a branch's tenant_id from any of the four places it can
// live. Branches activated via HQ have `tenant:<slug>` (HQ-style), branches
// activated via direct login have `tenant_id` (per-branch style), and fully
// fresh branches have neither (we then fall back to master.branches which
// the central registration stamps at activation).
function resolveBranchTenantId(slug, branchDb) {
  try {
    const r = masterDb?.prepare('SELECT tenant_id FROM branches WHERE slug = ? LIMIT 1').get(slug);
    if (r?.tenant_id) return r.tenant_id;
  } catch (_) {}
  try {
    const r = branchDb.prepare("SELECT value FROM sync_config WHERE key = 'tenant_id' OR key = ? ORDER BY (key = 'tenant_id') DESC LIMIT 1").get(`tenant:${slug}`);
    if (r?.value) return r.value;
  } catch (_) {}
  try {
    const r = branchDb.prepare("SELECT tenant_id FROM products WHERE tenant_id IS NOT NULL AND tenant_id != '' LIMIT 1").get();
    if (r?.tenant_id) return r.tenant_id;
  } catch (_) {}
  return null;
}

// Subdomains that bypass per-tenant DB routing. The bare domain hits here as
// 'keletedistributionzm' (the first dot-split of 'keletezm.com'); this is the HQ /
// management layer â€” admin panel + tenant-admin routes live here, not a
// real per-branch tenant DB. Same role as 'liquor' in Liquor's middleware.
// Without this entry, /api/tenant-admin/* returns 404 to any caller hitting
// the bare domain (which is how central admin reaches Kelete).
//
// HQ branch-switch override: when host is bare 'keletedistributionzm' AND the caller
// sends an 'X-Branch' header naming a registered tenant, we open THAT
// branch's DB instead. Bypass-list entries like 'www' / 'localhost' /
// 'api' do NOT honour X-Branch â€” only the bare brand domain does, so a
// child subdomain (lusaka1.keletezm.com) can never spoof its way into
// another branch's data.
const SKIP_SLUGS = new Set(['www', 'kelete', 'keletezm', 'keletedistributionzm', 'localhost', 'api', '127', 'sidanitsolutions']);
const HQ_SLUGS   = new Set(['keletezm', 'keletedistributionzm']);

module.exports = function tenantMiddleware(req, res, next) {
  // Nginx sets X-Tenant to the full hostname e.g. "wiskings.sidanitsolutions.com"
  const host = (req.headers['x-tenant'] || req.hostname || '').toLowerCase();
  const slug = host.split('.')[0];

  // HQ branch-switch path: bare keletezm.com + X-Branch header â†’ use that
  // branch's DB and stash the branch's tenant_id on req so the auth
  // middleware can override req.user.tenantId. Without an X-Branch header
  // we fall through to the default DB (so /api/tenant-admin/* + the public
  // HQ branches-list endpoint keep working).
  if (HQ_SLUGS.has(slug)) {
    const xBranch = (req.headers['x-branch'] || '').toString().trim().toLowerCase();
    if (xBranch) {
      if (!isRegistered(xBranch)) {
        return res.status(404).json({ error: `HQ branch "${xBranch}" not found` });
      }
      try {
        const branchDb = getTenantDb(xBranch);
        // v1.6.5: resolve from master.branches (authoritative) or any of
        // the 3 fallback locations. Previously this only checked the plain
        // 'tenant_id' key, which is missing on branches activated via HQ
        // (they have 'tenant:<slug>' instead) â†’ req.hqBranchTenantId
        // stayed undefined â†’ auth.js didn't override req.user.tenantId â†’
        // GET /products WHERE tenant_id='local-only' returned 0 rows.
        const tid = resolveBranchTenantId(xBranch, branchDb);
        if (tid) req.hqBranchTenantId = tid;
        req.hqBranchSlug = xBranch;
        // Stash on req so handlers can re-enter the runWithDb context after
        // async middleware (multer, etc.) that drops the AsyncLocalStorage.
        req.tenantDb = branchDb;
        return runWithDb(branchDb, () => next());
      } catch (err) {
        console.error(`[tenant] HQ branch-switch open failed for "${xBranch}":`, err.message);
        return res.status(503).json({ error: 'Branch database unavailable' });
      }
    }
    return next(); // bare HQ with no X-Branch â†’ default DB
  }

  if (!slug || SKIP_SLUGS.has(slug)) {
    return next(); // use default DB
  }

  // Block unregistered tenants
  if (!isRegistered(slug)) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  try {
    const tenantDb = getTenantDb(slug);
    // Stash on req so handlers can re-enter the runWithDb context after
    // async middleware (multer file uploads, etc.) that drops the
    // AsyncLocalStorage. Without this stash, multer-using POST routes
    // (CSV import, image upload, attachments) silently wrote to the
    // default DB instead of the tenant's â€” confirmed via diagnostic on
    // 2026-06-22: 242 products had landed in backend/kelete.db while
    // tenants/kassumbalesa1.db had 0.
    req.tenantDb = tenantDb;
    runWithDb(tenantDb, () => next());
  } catch (err) {
    console.error(`[tenant] Failed to open DB for "${slug}":`, err.message);
    res.status(503).json({ error: 'Tenant database unavailable' });
  }
};
