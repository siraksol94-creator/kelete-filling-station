// S7 (full matrix) — server-side page permissions.
//
// Until now the server mostly trusted the screens: a logged-in cashier who
// cannot open, say, Payment Vouchers on screen could still create or delete
// vouchers by calling /api/payment-vouchers directly. This gate applies the
// screens' own rules on the server:
//
//   A request from a logged-in user who is not an Administrator (nor has the
//   'All' / 'Full Access' permission) is allowed only if that user could open
//   at least one screen that makes this call.
//
// The call → screens map is config/permissionMatrix.json, generated from the
// frontend by ops/permissions/build-matrix.js (CI checks it is up to date).
// Calls that no screen makes are for administrators only.
//
// It does not replace the checks inside routes (adminOnly, shift-approval
// locks, supervisor-only actions…): those still apply on top. Add / Edit /
// Delete within a screen are still checked by the screens only (as before),
// except where a route checks them itself.
//
// Untouched: requests with no login or an invalid one (the route's own auth
// answers those), and /api/auth, /api/sync, /api/updates, /api/tenant-admin
// and /api/health, which have their own authentication.
//
// KELETE_PERMISSIONS = enforce (default) | log | off
//   log: never blocks; writes "[permissions] WOULD DENY …" lines instead — for a
//   first live week, to confirm nobody's daily work is affected before enforcing.
const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/secrets');
const db = require('../config/database');
const matrix = require('../config/permissionMatrix.json');

const SKIP = /^\/(auth|sync|updates|tenant-admin|health)(\/|$)/i;
const LEGACY = matrix.legacy_map || {};

// method → segment count → [{ segs, entry }]
const index = {};
for (const e of matrix.endpoints) {
  const segs = e.path.split('/').slice(1).map(s => s.toLowerCase());
  ((index[e.method] ||= {})[segs.length] ||= []).push({ segs, entry: e });
}

function matching(method, p) {
  const segs = p.replace(/\/+$/, '').split('/').slice(1).map(s => decodeSeg(s).toLowerCase());
  const list = ((index[method === 'HEAD' ? 'GET' : method] || {})[segs.length]) || [];
  return list.filter(({ segs: pat }) => pat.every((s, i) => s === ':p' || s === segs[i])).map(x => x.entry);
}
function decodeSeg(s) { try { return decodeURIComponent(s); } catch (_) { return s; } }

// Same logic as the screens (frontend/src/context/AuthContext.js).
function hasPermission(perms, key) {
  if (perms.includes(key)) return true;
  if (key.includes(':')) {
    const legacy = LEGACY[key.split(':')[0]];
    if (legacy && perms.includes(legacy)) return true;
  }
  return false;
}

function parsePerms(raw) {
  if (Array.isArray(raw)) return raw;
  try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

// The caller as the database has them NOW (role, status and permissions can
// change after the token was issued). HQ branch-switch: the user row lives in
// the HQ (default) database — same fallback as middleware/auth.js.
function currentUser(req, decoded) {
  const sql = 'SELECT role, status, permissions FROM users WHERE id = ? AND email = ? AND deleted_at IS NULL';
  let me = db.prepare(sql).get(decoded.id, decoded.email);
  if (!me && req.hqBranchSlug && db.defaultDb) me = db.defaultDb.prepare(sql).get(decoded.id, decoded.email);
  return me || null;
}

function decide(req) {
  const p = req.path;
  if (SKIP.test(p)) return { allow: true };
  const header = req.header('Authorization') || '';
  if (!header.startsWith('Bearer ')) return { allow: true };
  let decoded;
  try { decoded = jwt.verify(header.slice(7), getJwtSecret()); } catch (_) { return { allow: true }; }
  if (!decoded || decoded.id == null) return { allow: true };
  // Who is asking (verified token) — so a refusal here is still recorded with
  // the caller in the audit log. The route's own auth sets this again.
  if (!req.user) req.user = req.hqBranchTenantId ? { ...decoded, tenantId: req.hqBranchTenantId } : decoded;

  const me = currentUser(req, decoded);
  if (!me) return { allow: false, reason: 'account not found' };
  if (me.status && me.status !== 'Active') return { allow: false, reason: 'account is not active' };
  const perms = parsePerms(me.permissions);
  if (me.role === 'Administrator' || perms.includes('All') || perms.includes('Full Access')) return { allow: true };

  const entries = matching(req.method, p);
  if (!entries.length) return { allow: false, reason: 'not used by any screen (administrators only)' };
  for (const e of entries) {
    if (e.any) return { allow: true };
    if (e.perms && e.perms.some(k => hasPermission(perms, k))) return { allow: true };
  }
  const screens = [...new Set(entries.flatMap(e => e.screens || []))].slice(0, 5).join(', ');
  return { allow: false, reason: `needs access to: ${screens}` };
}

function permissionGate(req, res, next) {
  const mode = (process.env.KELETE_PERMISSIONS || 'enforce').toLowerCase();
  if (mode === 'off' || req.method === 'OPTIONS') return next();
  let d;
  try { d = decide(req); } catch (e) {
    console.error('[permissions] check failed:', e.message);
    return mode === 'log' ? next() : res.status(500).json({ error: 'Permission check failed.' });
  }
  if (d.allow) return next();
  const line = `${req.method} /api${req.path} by ${req.user && req.user.email} — ${d.reason}`;
  if (mode === 'log') { console.warn(`[permissions] WOULD DENY ${line}`); return next(); }
  console.warn(`[permissions] DENY ${line}`);
  req.permissionDenied = true; // recorded by services/audit.js
  return res.status(403).json({ error: 'You do not have permission for this.', code: 'PERMISSION_DENIED' });
}

module.exports = { permissionGate, decide, hasPermission, matching };
