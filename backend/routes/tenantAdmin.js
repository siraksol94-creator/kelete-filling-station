/**
 * tenantAdmin.js
 * Endpoints called by the master admin panel at sidanitsolutions.com/admin.
 * Protected by ADMIN_PASSWORD from .env (sent as x-admin-password header).
 * Mirrors the Lodge product shape so the same admin UI works for Kelete.
 */
const express = require('express');
const router  = express.Router();
const { randomUUID } = require('crypto');
const { registerTenant, listTenants, deactivateTenant, isRegistered, masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');

function adminAuth(req, res, next) {
  const password = req.headers['x-admin-password'] || req.body.adminPassword;
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// 2026-08-31 — KELETE, not KELETE. Kelete is a Kelete fork and this generator
// was never renamed, so every licence minted for a Kelete branch came out
// Kelete-branded — including the two currently on Buseko and Garden.
//
// The prefix is cosmetic: licences are matched on the whole key string and
// nothing parses it, so existing keys keep working untouched and are
// deliberately NOT reissued. This only affects keys minted from now on.
function genLicenseKey() {
  const raw = randomUUID().replace(/-/g, '').toUpperCase();
  return `KELETE-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

// GET /api/tenant-admin/list — all tenants
router.get('/list', adminAuth, (req, res) => {
  const tenants = listTenants();
  res.json({ tenants });
});

// GET /api/tenant-admin/stats — license stats for dashboard
router.get('/stats', adminAuth, (req, res) => {
  try {
    const now  = new Date().toISOString().slice(0, 10);
    const in14 = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    const total    = masterDb.prepare('SELECT COUNT(*) as n FROM licenses').get().n;
    const active   = masterDb.prepare("SELECT COUNT(*) as n FROM licenses WHERE is_active=1 AND expires_at >= ?").get(now).n;
    const expiring = masterDb.prepare("SELECT COUNT(*) as n FROM licenses WHERE is_active=1 AND expires_at >= ? AND expires_at <= ?").get(now, in14).n;
    const expired  = masterDb.prepare("SELECT COUNT(*) as n FROM licenses WHERE expires_at < ?").get(now).n;
    const tenants  = masterDb.prepare('SELECT COUNT(*) as n FROM tenants WHERE is_active=1').get().n;
    res.json({ total, active, expiring, expired, tenants });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/tenant-admin/licenses — full license list with branch info
router.get('/licenses', adminAuth, (req, res) => {
  try {
    const licenses = masterDb.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
    const result = licenses.map(l => {
      const branches = l.tenant_id
        ? masterDb.prepare('SELECT * FROM branches WHERE tenant_id = ?').all(l.tenant_id)
        : [];
      const slug = branches.length ? branches[0].slug : null;
      return {
        ...l,
        branch_count: branches.length,
        branch_codes: branches.map(b => `${b.branch_name} [${b.branch_id.replace(/-/g, '').substring(0, 8).toUpperCase()}]`).join(', ') || null,
        slug,
      };
    });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/tenant-admin/create-license — mint a license (no slug — claimed at register)
router.post('/create-license', adminAuth, (req, res) => {
  try {
    const { maxBranches = 1, expiresAt, notes } = req.body;
    if (!expiresAt) return res.status(400).json({ error: 'expiresAt is required' });
    const key = genLicenseKey();
    masterDb.prepare(`
      INSERT INTO licenses (key, max_branches, expires_at, notes, is_active)
      VALUES (?, ?, ?, ?, 1)
    `).run(key, maxBranches, expiresAt, notes || null);
    res.json({ success: true, key, maxBranches, expiresAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/tenant-admin/licenses/:key — edit expiry / branches / active
router.patch('/licenses/:key', adminAuth, (req, res) => {
  try {
    const { expiresAt, maxBranches, isActive } = req.body;
    masterDb.prepare(`
      UPDATE licenses SET expires_at=?, max_branches=?, is_active=? WHERE key=?
    `).run(expiresAt, maxBranches, isActive, req.params.key);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/tenant-admin/register — register a new tenant + pre-init DB
router.post('/register', adminAuth, (req, res) => {
  const { slug, businessName, email } = req.body;
  if (!slug || !businessName) return res.status(400).json({ error: 'slug and businessName are required' });
  if (!/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'slug must be lowercase letters, numbers, hyphens only' });
  if (isRegistered(slug)) return res.status(409).json({ error: 'Tenant already registered' });
  try {
    registerTenant(slug, businessName, email);
    getTenantDb(slug);
    res.json({ success: true, tenant: { slug, businessName, email }, url: `https://${slug}.keletezm.com` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /api/tenant-admin/tenants/:slug — edit business name / email
router.put('/tenants/:slug', adminAuth, (req, res) => {
  try {
    const { businessName, email } = req.body;
    masterDb.prepare('UPDATE tenants SET business_name=?, email=? WHERE slug=?')
      .run(businessName, email || null, req.params.slug);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/tenant-admin/deactivate — flip is_active off
router.post('/deactivate', adminAuth, (req, res) => {
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug is required' });
  deactivateTenant(slug);
  res.json({ success: true });
});

module.exports = router;
