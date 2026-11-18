/**
 * deviceAuth.js — S1 stages 2/3: per-till sync tokens.
 *
 * Problem: /api/sync/push, /pull and /master/* on the VPS accept any request
 * that names a tenantId. Anyone who learns it can download the tenant's data
 * (users with password hashes included) or overwrite records. nginx (S1
 * stage 1) cannot block these: the tills need them.
 *
 * Each till now holds its own random token (sent as X-Device-Token). Only a
 * SHA-256 of it is stored, in sync_device_tokens (migration 5) of the database
 * the till syncs with. A token belongs to one tenant (and branch); it can be
 * revoked on its own without touching any other till.
 *
 * Tokens are issued
 *   • by POST /api/sync/register and /join-branch (licence key checked), and
 *   • to tills already in the field, by POST /api/sync/device-token on their
 *     next sync ("auto-enrol"), while enrolment is open (stage 2). A device id
 *     that already holds a live token cannot enrol again.
 *
 * KELETE_SYNC_AUTH (read per request):
 *   accept  (default, stage 2) — a valid token is checked against the tenant /
 *           branch it asks for; a revoked token is refused; a till with no
 *           token is still served (as before) and logged; auto-enrol is open.
 *   require (stage 3) — no token → 401; unknown token → 401; auto-enrol closed
 *           (a till that lost its token re-joins: Setup → Join existing
 *           branch, with the licence key).
 *   off     — no checks (as before S1 stage 2).
 * Requests a LAN Mother has already authenticated with its LAN sync key skip
 * this check (children talk to the Mother, not the VPS).
 */
const crypto = require('crypto');
const db = require('../config/database');

const mode = () => (process.env.KELETE_SYNC_AUTH || 'accept').toLowerCase();
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const now = () => new Date().toISOString();

function masterDb() {
  try { return require('../config/masterDb').masterDb || null; } catch (_) { return null; }
}

function issueToken({ tenantId, branchId = null, deviceId = null, label = null, via }) {
  const token = `kdt_${crypto.randomBytes(32).toString('base64url')}`;
  db.prepare(`INSERT INTO sync_device_tokens (token_hash, tenant_id, branch_id, device_id, label, issued_via)
              VALUES (?, ?, ?, ?, ?, ?)`).run(hash(token), tenantId, branchId, deviceId, label ? String(label).slice(0, 120) : null, via);
  return token;
}

function lookup(token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM sync_device_tokens WHERE token_hash = ?').get(hash(token)) || null;
}

const unauthSeen = new Map(); // throttle the "no token" log line
function logUnauthenticated(req, tenantId) {
  const key = `${tenantId}|${(req.body && req.body.deviceId) || req.query.deviceId || req.ip}`;
  const last = unauthSeen.get(key) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  unauthSeen.set(key, Date.now());
  console.warn(`[deviceAuth] sync WITHOUT a device token: tenant=${tenantId} device=${key.split('|')[1]} path=${req.path}`);
}

function refuse(res, status, code, error) { return res.status(status).json({ error, code }); }

// scope: 'tenant' (push/pull: tenantId in body/query), 'slug' (master push/pull),
// 'none' (master registry).
function deviceGate(scope) {
  return function deviceGateMiddleware(req, res, next) {
    const m = mode();
    if (m === 'off' || req.lanAuthenticated) return next();
    const asked = scope === 'tenant' ? ((req.body && req.body.tenantId) || req.query.tenantId || null)
                : scope === 'slug' ? ((req.body && req.body.slug) || req.query.slug || null) : null;
    const token = req.headers['x-device-token'];
    if (!token) {
      if (m === 'require') return refuse(res, 401, 'DEVICE_TOKEN_REQUIRED', 'This till is not linked to the server. Run Setup → Join existing branch with the licence key.');
      logUnauthenticated(req, asked);
      return next();
    }
    let row;
    try { row = lookup(token); } catch (e) { return refuse(res, 500, 'DEVICE_CHECK_FAILED', e.message); }
    if (!row) {
      if (m === 'require') return refuse(res, 401, 'DEVICE_TOKEN_UNKNOWN', 'This till\'s link is not recognised by the server. Run Setup → Join existing branch with the licence key.');
      res.setHeader('X-Device-Token-Status', 'unknown'); // the till forgets it and enrols again
      console.warn(`[deviceAuth] unknown device token for tenant=${asked} path=${req.path}`);
      return next();
    }
    if (row.revoked_at) return refuse(res, 401, 'DEVICE_TOKEN_REVOKED', 'This till\'s access to the server has been revoked by an administrator.');
    if (scope === 'tenant' && asked && asked !== row.tenant_id) {
      return refuse(res, 403, 'DEVICE_WRONG_TENANT', 'This till is not linked to that account.');
    }
    if (scope === 'slug' && asked && row.branch_id) {
      const mdb = masterDb();
      const b = mdb && mdb.prepare('SELECT slug FROM branches WHERE branch_id = ?').get(row.branch_id);
      if (b && b.slug && b.slug !== asked) return refuse(res, 403, 'DEVICE_WRONG_BRANCH', 'This till is not linked to that branch.');
    }
    if (!row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > 60 * 1000) {
      try { db.prepare('UPDATE sync_device_tokens SET last_seen_at = ?, last_ip = ? WHERE id = ?').run(now(), String(req.headers['x-forwarded-for'] || req.ip || '').slice(0, 100), row.id); } catch (_) {}
    }
    req.syncDevice = row;
    next();
  };
}

// Is this tenant (and branch) one this server actually serves?
function knownTenant(tenantId, branchId) {
  const mdb = masterDb();
  if (branchId && mdb) {
    const b = mdb.prepare('SELECT tenant_id FROM branches WHERE branch_id = ?').get(branchId);
    if (b) return b.tenant_id === tenantId;
  }
  const local = db.prepare("SELECT 1 FROM sync_config WHERE (key LIKE 'tenant:%' AND value = ?) OR (key = 'tenant_id' AND value = ?) LIMIT 1").get(tenantId, tenantId);
  if (local) return true;
  return !!(mdb && mdb.prepare('SELECT 1 FROM branches WHERE tenant_id = ? LIMIT 1').get(tenantId));
}

// POST /api/sync/device-token — a till already in the field asks for its token.
function enrol(req, res) {
  const m = mode();
  if (m === 'require') return refuse(res, 403, 'ENROLMENT_CLOSED', 'New tills must be linked with the licence key: Setup → Join existing branch.');
  const { tenantId, branchId, deviceId, label } = req.body || {};
  if (!tenantId || !deviceId) return refuse(res, 400, 'BAD_REQUEST', 'tenantId and deviceId are required');
  if (!knownTenant(tenantId, branchId)) return refuse(res, 403, 'UNKNOWN_TENANT', 'This server does not serve that account/branch.');
  const live = db.prepare('SELECT id FROM sync_device_tokens WHERE tenant_id = ? AND device_id = ? AND revoked_at IS NULL').get(tenantId, deviceId);
  if (live) return refuse(res, 409, 'ALREADY_ENROLLED', 'This till already has a link. An administrator must revoke it before it can be issued again.');
  const deviceToken = issueToken({ tenantId, branchId: branchId || null, deviceId, label, via: 'auto-enrol' });
  console.log(`[deviceAuth] auto-enrolled device=${deviceId} tenant=${tenantId} branch=${branchId || '-'} label=${label || '-'}`);
  res.json({ deviceToken });
}

function listDevices() {
  return db.prepare(`SELECT id, tenant_id, branch_id, device_id, label, issued_via, created_at, last_seen_at, last_ip, revoked_at, revoked_by
                       FROM sync_device_tokens ORDER BY revoked_at IS NOT NULL, COALESCE(last_seen_at, created_at) DESC`).all();
}

function revoke(id, by) {
  return db.prepare('UPDATE sync_device_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(now(), by || null, id).changes;
}

module.exports = { deviceGate, enrol, issueToken, lookup, listDevices, revoke, hash, mode };
