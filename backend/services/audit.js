// D2 — request-level audit: WHO did a sensitive action, and what happened.
//
// Complements the database triggers in config/auditSchema.js (which record
// WHAT changed, with before/after values, but cannot know the user).
//
// Recorded (source = 'request'):
//   • every DELETE request under /api
//   • POST/PUT/PATCH whose path names a void-type action: reverse, void,
//     delete, approve/un-approve, reopen, cancel, reject, post-adjustment,
//     wipe, reset, clear, factory
//   • changes to sensitive resources: users, own password, fuel grades
//     (prices), nozzles (meters), tanks, product prices, business settings,
//     shift close/finalize, dips
//   • failed logins (status 401/403/429 on POST /api/auth/login) — the
//     username tried, never the password
//
// Written when the response finishes, to the same database the request used.
// Best-effort: a failure here is logged and never breaks the user's request.
// Passwords, secrets, tokens, keys and PINs are removed from stored bodies.

const ACTION_WORDS = /(^|\/)(reverse|void|delete|un-?approve|approve|reopen|cancel|reject|post-adjustment|wipe-tenant|reset|clear-pending|factory-reset|force-resync)(\/|$)/i;

const SENSITIVE_RESOURCES = [
  /^\/api\/users(\/|$)/i,
  /^\/api\/auth\/change-password$/i,
  /^\/api\/fuel-grades(\/|$)/i,
  /^\/api\/pumps\/nozzles(\/|$)/i,
  /^\/api\/tanks(\/|$)/i,
  /^\/api\/tank-dips(\/|$)/i,
  /^\/api\/fuel-shift-approvals(\/|$)/i,
  /^\/api\/fuel-day-approvals(\/|$)/i,
  /^\/api\/attendant-shifts\/\d+\/(close|finalize|credit-sales)$/i,
  /^\/api\/products\/\d+$/i,
  /^\/api\/products\/(bulk-update-prices|bulk-push-prices|cost-prices|cost-prices-push|branch-prices|branch-prices-multi-push|opening-balances|import)(\/|$)/i,
  /^\/api\/settings\/(business|app-passcode)$/i,
  /^\/api\/fx-rates(\/|$)/i,
];

const NEVER = [
  /^\/api\/sync\/(push|pull|master\/)/i, // bulk sync traffic — not user actions
];

const REDACT_KEY = /(pass(word)?|secret|token|api[-_]?key|key$|pin$|passcode|authorization|signature)/i;
const MAX_BODY_CHARS = 4000;

function redact(value, depth = 0) {
  if (value == null || depth > 6) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEY.test(k) ? (v ? '[redacted]' : v) : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function safeJson(value) {
  if (value === undefined) return null;
  try {
    const s = JSON.stringify(redact(value));
    if (!s || s === '{}') return null;
    return s.length > MAX_BODY_CHARS ? JSON.stringify({ truncated: true, preview: s.slice(0, MAX_BODY_CHARS) }) : s;
  } catch (_) { return null; }
}

function classify(req) {
  const method = req.method.toUpperCase();
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (!path.toLowerCase().startsWith('/api/')) return null;
  if (NEVER.some(r => r.test(path))) return null;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  if (method === 'POST' && /^\/api\/auth\/login$/i.test(path)) return 'auth.login';
  if (method === 'DELETE') return 'request.delete';
  const m = path.match(ACTION_WORDS);
  if (m) return `request.${m[2].toLowerCase().replace('un-approve', 'unapprove')}`;
  if (SENSITIVE_RESOURCES.some(r => r.test(path))) return `request.${method.toLowerCase()}`;
  return null;
}

function entityFromPath(path) {
  // /api/<resource>[/<sub>]/<id>... → best-effort table + id hints for linking
  const parts = path.split('?')[0].split('/').filter(Boolean); // ['api','users','12']
  const resource = parts[1] || null;
  const id = parts.slice(2).find(p => /^\d+$/.test(p)) || null;
  return { resource, id };
}

// Express middleware. Mount once, before the API routes.
function auditRequests(fallbackDb) {
  return function auditRequestsMiddleware(req, res, next) {
    const action = classify(req);
    if (!action) return next();
    const started = Date.now();

    res.on('finish', () => {
      try {
        const status = res.statusCode;
        // Logins: record failures only (successes are routine and frequent).
        if (action === 'auth.login' && !(status === 401 || status === 403 || status === 429)) return;

        // The database this request used. AsyncLocalStorage context is gone by
        // the time 'finish' fires, so use the handle tenant middleware stored.
        const conn = req.tenantDb || (fallbackDb && fallbackDb.defaultDb) || null;
        if (!conn) return;
        const hasTable = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_log'").get();
        if (!hasTable) return;

        const path = (req.originalUrl || req.url || '').split('?')[0];
        const { resource, id } = entityFromPath(path);
        const u = req.user || {};
        const details = {
          params: req.params && Object.keys(req.params).length ? req.params : undefined,
          query: req.query && Object.keys(req.query).length ? redact(req.query) : undefined,
          hq_branch: req.hqBranchSlug || undefined,
          attempted_username: action === 'auth.login' ? String(req.body?.email || '').slice(0, 120) : undefined,
        };
        conn.prepare(`
          INSERT INTO audit_log (source, action, entity_table, entity_id, tenant_id,
                                 actor_user_id, actor_email, actor_role, actor_name,
                                 ip, forwarded_for, method, path, status_code, duration_ms,
                                 after_json, details_json)
          VALUES ('request', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          action === 'auth.login' ? 'auth.login_failed' : action,
          resource, id, u.tenantId || null,
          u.id ?? null, u.email ?? null, u.role ?? null, u.name ?? null,
          String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || null,
          String(req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').slice(0, 200) || null,
          req.method.toUpperCase(), path.slice(0, 500), status, Date.now() - started,
          action === 'auth.login' ? null : safeJson(req.body),
          safeJson(details),
        );
      } catch (e) {
        console.warn('[audit] request audit not written:', e.message);
      }
    });
    next();
  };
}

module.exports = { auditRequests, classify, redact };
