const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/secrets');
const db = require('../config/database');

const auth = (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }
    const decoded = jwt.verify(token, getJwtSecret());
    req.user = decoded;
    // HQ branch-switch override: the JWT was issued from whichever branch
    // the user originally logged into, but the request may target a
    // DIFFERENT branch via X-Branch. tenant middleware already opened
    // the right DB; here we swap the tenantId on req.user so every WHERE
    // clause downstream (WHERE tenant_id = ?) filters by the operating
    // branch, not the original one. Roles/permissions still come from
    // the JWT — caller is responsible for keeping the same admin user
    // configured across branches if cross-branch operation is desired.
    if (req.hqBranchTenantId) {
      req.user = { ...decoded, tenantId: req.hqBranchTenantId };
    }
    next();
  } catch (error) {
    res.status(401).json({ error: 'Invalid token.' });
  }
};

// S2 — the JWT's role is a snapshot from login and lives for 24h, so a demoted
// or deactivated admin kept admin rights until their token expired. Re-read
// the caller's CURRENT role and status from the database.
//
// HQ branch-switch (X-Branch): the request runs against the branch's DB, but
// req.user.id belongs to the HQ (default) DB the user logged into. Look there
// when the branch DB has no matching row, so HQ admins can still manage branch
// users exactly as before. Matching on id AND email keeps a different person
// who happens to share the numeric id from being mistaken for the caller.
//
// adminOnly is used by routes/users.js, routes/system.js (D1/D2 read-only
// endpoints and, since S7, backups) and routes/tanks.js (ledger check).
// Does the caller CURRENTLY hold one of `roles` (per the database, not just
// per their token), with an Active account? Shared by adminOnly and by routes
// that need a role check for only part of a request.
//
// HQ branch-switch: req.user.id belongs to the HQ (default) DB; fall back to
// it when the branch DB has no matching row (see S2 note above).
function hasActiveRole(req, roles) {
  if (!req.user || !roles.includes(req.user.role)) return false;
  const sql = "SELECT role, status FROM users WHERE id = ? AND email = ? AND deleted_at IS NULL";
  let me = db.prepare(sql).get(req.user.id, req.user.email);
  if (!me && req.hqBranchSlug && db.defaultDb) {
    me = db.defaultDb.prepare(sql).get(req.user.id, req.user.email);
  }
  return !!me && roles.includes(me.role) && (!me.status || me.status === 'Active');
}

const isActiveAdmin = (req) => hasActiveRole(req, ['Administrator']);

// Business decision 2026-11-18: shift reopening and nozzle meter edits are for
// supervisors and administrators. The system has no role named "Supervisor" —
// supervisors use the Manager role (frontend/src/pages/Users.js ROLES). A role
// literally named "Supervisor" is accepted too, should one be added.
const SUPERVISOR_ROLES = ['Administrator', 'Manager', 'Supervisor'];

const adminOnly = (req, res, next) => {
  try {
    if (!isActiveAdmin(req)) return res.status(403).json({ error: 'Admin access required.' });
    next();
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
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
      // Role name match — e.g. role='Cashier' satisfies the Cashier gate.
      if (req.user.role === page) return next();
      // Permission keyword match — admins grant 'Cashier:Add' etc via Users.
      const u = db.prepare('SELECT permissions FROM users WHERE id = ?').get(req.user.id);
      let perms = [];
      try { perms = JSON.parse(u?.permissions || '[]'); } catch { /* ignore */ }
      // 2026-08-30 — honour the blanket grants the FRONTEND already treats as
      // all-access (AuthContext.isAllAccess: Administrator | 'All' | 'Full
      // Access'). Without this the two disagree: such a user passes every UI
      // gate, then gets 403 from the API — the page loads and the data does
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
// back to defaultDb — every write silently lands in backend/kelete.db
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

module.exports = { auth, adminOnly, isActiveAdmin, hasActiveRole, SUPERVISOR_ROLES, readOnlyGuard, requirePagePerm, withTenantDb };
