const jwt = require('jsonwebtoken');
const db = require('../config/database');

const auth = (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'kelete-pro-secret-key-2026');
    req.user = decoded;
    // HQ branch-switch override: the JWT was issued from whichever branch
    // the user originally logged into, but the request may target a
    // DIFFERENT branch via X-Branch. tenant middleware already opened
    // the right DB; here we swap the tenantId on req.user so every WHERE
    // clause downstream (WHERE tenant_id = ?) filters by the operating
    // branch, not the original one. Roles/permissions still come from
    // the JWT â€” caller is responsible for keeping the same admin user
    // configured across branches if cross-branch operation is desired.
    if (req.hqBranchTenantId) {
      req.user = { ...decoded, tenantId: req.hqBranchTenantId };
    }
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token.' });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'Administrator') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
};

const readOnlyGuard = (req, res, next) => {
  if (req.user?.webAccess && req.method !== 'GET') {
    return res.status(403).json({ error: 'Web access is read-only.' });
  }
  next();
};

// Build a middleware that allows Admins through, or any user whose role
// matches the page name, or any user whose permissions array carries
// "<page>" or "<page>:Add"/"<page>:Edit" etc. Looks up perms from the
// current tenant DB so a permission change takes effect immediately
// without re-login (the JWT doesn't carry perms).
function requirePagePerm(page) {
  return (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Access denied' });
      if (req.user.role === 'Administrator') return next();
      // Role name match â€” e.g. role='Cashier' satisfies the Cashier gate.
      if (req.user.role === page) return next();
      // Permission keyword match â€” admins grant 'Cashier:Add' etc via Users.
      const u = db.prepare('SELECT permissions FROM users WHERE id = ?').get(req.user.id);
      let perms = [];
      try { perms = JSON.parse(u?.permissions || '[]'); } catch { /* ignore */ }
      // 2026-08-30 â€” honour the blanket grants the FRONTEND already treats as
      // all-access (AuthContext.isAllAccess: Administrator | 'All' | 'Full
      // Access'). Without this the two disagree: such a user passes every UI
      // gate, then gets 403 from the API â€” the page loads and the data does
      // not. Latent on FxRates/Dispatch/Cashier before this; adding the
      // HQOverview gate would have made it visible.
      if (perms.includes('All') || perms.includes('Full Access')) return next();
      if (perms.some(p => p === page || p === `${page}:Add` || p === `${page}:Edit` || p === `${page}:View` || p === `${page}:Delete`)) {
        return next();
      }
      return res.status(403).json({ error: `${page} permission required` });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  };
}

// Re-enter the per-tenant AsyncLocalStorage context for handlers that run
// AFTER async middleware (multer file uploads, etc.). multer's stream-based
// processing drops the ALS context that tenant middleware originally set
// via runWithDb, so by the time the route handler runs `db.proxy` falls
// back to defaultDb â€” every write silently lands in backend/kelete.db
// instead of the tenant's DB. tenant.js stashes the tenantDb on req before
// runWithDb; this middleware re-establishes the context just before the
// handler. Mount it AFTER the multer middleware:
//
//   router.post('/import', auth, multer.single('file'), withTenantDb, h)
function withTenantDb(req, res, next) {
  if (req.tenantDb) {
    return db.runWithDb(req.tenantDb, () => next());
  }
  next();
}

module.exports = { auth, adminOnly, readOnlyGuard, requirePagePerm, withTenantDb };
