const router  = require('express').Router();
const crypto  = require('crypto');
const path    = require('path');
const { getLicense, createLicense, updateLicense, listLicenses, getLicenseStats,
        listTenants, registerTenant, isRegistered } = require('../config/masterDb');

const { getAdminPanelSecret, safeEqual } = require('../config/secrets');

// S3 — no more built-in defaults. Previously ADMIN_PASSWORD fell back to the
// public string 'admin-change-me' and token signing to 'dev-secret', so a
// server without a .env had a licence panel anyone could log into.
// Now: with no ADMIN_PASSWORD set, the panel login is simply disabled (503);
// the rest of the server is unaffected.
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const KNOWN_WEAK_ADMIN = new Set(['admin-change-me', 'admin', 'admin123', 'password', 'changeme']);
const ADMIN_LOGIN_ENABLED = ADMIN_PASSWORD.length > 0 && !KNOWN_WEAK_ADMIN.has(ADMIN_PASSWORD);
if (!ADMIN_LOGIN_ENABLED) {
  console.warn('[admin] ADMIN_PASSWORD is not set (or is a known default) — /admin licence panel login is disabled.');
}

// ── Simple token helpers (no extra dependencies) ──────────────────────────────
function makeToken() {
  const payload = Buffer.from(JSON.stringify({ ts: Date.now() })).toString('base64');
  const sig     = crypto.createHmac('sha256', getAdminPanelSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = crypto.createHmac('sha256', getAdminPanelSecret()).update(payload).digest('hex');
  if (!ADMIN_LOGIN_ENABLED) return false;
  if (!safeEqual(sig, expected)) return false;
  try {
    const { ts } = JSON.parse(Buffer.from(payload, 'base64').toString());
    return Number.isFinite(ts) && Date.now() - ts < 24 * 60 * 60 * 1000; // 24h session
  } catch (_) {
    return false; // malformed payload: refuse instead of throwing a 500
  }
}

function authMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!verifyToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── License key generator: BUTCH-XXXX-XXXX-XXXX ───────────────────────────────
function generateLicenseKey() {
  const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
  return `BUTCH-${seg()}-${seg()}-${seg()}`;
}

// ─── Serve admin HTML page ────────────────────────────────────────────────────
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// ─── POST /admin/login ────────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  if (!ADMIN_LOGIN_ENABLED) {
    return res.status(503).json({ error: 'Admin panel login is disabled on this server.' });
  }
  if (!safeEqual(req.body?.password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: makeToken() });
});

// ─── GET /admin/licenses ──────────────────────────────────────────────────────
router.get('/licenses', authMiddleware, (req, res) => {
  res.json(listLicenses());
});

// ─── POST /admin/licenses ─────────────────────────────────────────────────────
router.post('/licenses', authMiddleware, (req, res) => {
  try {
    const { expiresAt, maxBranches = 1, notes = '' } = req.body;
    if (!expiresAt) return res.status(400).json({ error: 'expiresAt is required' });

    let key;
    do { key = generateLicenseKey(); }
    while (getLicense(key));

    createLicense(key, Number(maxBranches), expiresAt, notes);
    res.json({ key });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PATCH /admin/licenses/:key ───────────────────────────────────────────────
router.patch('/licenses/:key', authMiddleware, (req, res) => {
  try {
    const license = getLicense(req.params.key);
    if (!license) return res.status(404).json({ error: 'License not found' });
    updateLicense(req.params.key, req.body);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET /admin/stats ─────────────────────────────────────────────────────────
router.get('/stats', authMiddleware, (req, res) => {
  res.json(getLicenseStats());
});

// ─── GET /admin/tenants ───────────────────────────────────────────────────────
router.get('/tenants', authMiddleware, (req, res) => {
  res.json(listTenants());
});

// ─── POST /admin/tenants ──────────────────────────────────────────────────────
router.post('/tenants', authMiddleware, (req, res) => {
  try {
    const { slug, businessName, email } = req.body;
    if (!slug || !businessName) return res.status(400).json({ error: 'slug and businessName are required' });
    if (isRegistered(slug)) return res.status(409).json({ error: 'Subdomain already registered' });
    registerTenant(slug, businessName, email);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── PUT /admin/tenants/:slug ─────────────────────────────────────────────────
router.put('/tenants/:slug', authMiddleware, (req, res) => {
  try {
    const { businessName, email } = req.body;
    if (!businessName) return res.status(400).json({ error: 'Business name is required' });
    const { masterDb } = require('../config/masterDb');
    const info = masterDb.prepare(
      "UPDATE tenants SET business_name=?, email=? WHERE slug=?"
    ).run(businessName, email || null, req.params.slug);
    if (info.changes === 0) return res.status(404).json({ error: 'Tenant not found' });
    // Also sync email to the license record for this tenant
    if (email) {
      const branch = masterDb.prepare('SELECT tenant_id FROM branches WHERE slug=?').get(req.params.slug);
      if (branch && branch.tenant_id) {
        masterDb.prepare(
          "UPDATE licenses SET tenant_email=? WHERE tenant_id=?"
        ).run(email, branch.tenant_id);
      }
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
