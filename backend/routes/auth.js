const router = require('express').Router();
const db = require('../config/database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { masterDb } = require('../config/masterDb');
const { auth } = require('../middleware/auth');

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    let tenantId;

    // For web: get tenantId from sync_config using the subdomain slug
    const slug = (req.headers['x-tenant'] || req.hostname || '').toLowerCase().split('.')[0];
    const tenantRow = slug ? db.prepare("SELECT value FROM sync_config WHERE key = ?").get(`tenant:${slug}`) : null;
    if (tenantRow) {
      tenantId = tenantRow.value;
    } else {
      tenantId = syncConfig.getConfig().tenantId || 'local-only';
    }

    const user = tenantId && tenantId !== 'local-only'
      ? db.prepare('SELECT * FROM users WHERE email = ? AND tenant_id = ? AND deleted_at IS NULL').get(email, tenantId)
      : db.prepare('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL').get(email);

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

    db.prepare("UPDATE users SET last_login = datetime('now'), synced=0 WHERE id = ?").run(user.id);

    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role, name: `${user.first_name} ${user.last_name}`, tenantId },
      process.env.JWT_SECRET || 'kelete-pro-secret-key-2026',
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.email,
        role: user.role,
        phone: user.phone,
        address: user.address,
        permissions: JSON.parse(user.permissions || '[]')
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify an Administrator's password. Used for inline approval flows
// (delete confirmation, POS discount, etc) where any admin in the tenant
// can authorize the action without logging out and back in.
// Accepts { password } only â€” tries every admin in the tenant, returns the
// first match. Email is optional for legacy callers.
router.post('/verify-admin', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password required.' });

    const slug = (req.headers['x-tenant'] || req.hostname || '').toLowerCase().split('.')[0];
    const tenantRow = slug ? db.prepare("SELECT value FROM sync_config WHERE key = ?").get(`tenant:${slug}`) : null;
    const tenantId = tenantRow ? tenantRow.value : (syncConfig.getConfig().tenantId || 'local-only');

    let admins;
    if (email) {
      // Legacy email+password flow â€” preserved for any caller still using it.
      admins = tenantId && tenantId !== 'local-only'
        ? db.prepare("SELECT id, first_name, last_name, password FROM users WHERE email = ? AND tenant_id = ? AND role = 'Administrator' AND deleted_at IS NULL").all(email, tenantId)
        : db.prepare("SELECT id, first_name, last_name, password FROM users WHERE email = ? AND role = 'Administrator' AND deleted_at IS NULL").all(email);
    } else {
      admins = tenantId && tenantId !== 'local-only'
        ? db.prepare("SELECT id, first_name, last_name, password FROM users WHERE tenant_id = ? AND role = 'Administrator' AND deleted_at IS NULL").all(tenantId)
        : db.prepare("SELECT id, first_name, last_name, password FROM users WHERE role = 'Administrator' AND deleted_at IS NULL").all();
    }

    for (const a of admins) {
      // eslint-disable-next-line no-await-in-loop
      if (await bcrypt.compare(password, a.password)) {
        return res.json({ ok: true, adminName: `${a.first_name} ${a.last_name}`, adminId: a.id });
      }
    }
    res.status(401).json({ error: 'Invalid admin password.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Account status â€” no auth required (used by App.js to check if any users exist)
router.get('/account-status', (req, res) => {
  try {
    const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users WHERE deleted_at IS NULL').get();
    res.json({ hasUsers: userCount.cnt > 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// First-time registration â€” no auth required, only works if no users exist
router.post('/register-first', async (req, res) => {
  try {
    // Delete any auto-created default admin so fresh installs can register
    db.prepare("DELETE FROM users WHERE (email = 'admin' OR email = 'admin@kelete.com') AND role = 'Administrator'").run();

    const users = db.prepare('SELECT id FROM users WHERE deleted_at IS NULL').all();
    if (users.length > 0) {
      return res.status(403).json({ error: 'Account already exists. Please log in.' });
    }
    const { firstName, lastName, email, password, phone, permissions } = req.body;
    if (!firstName || !lastName || !email || !password)
      return res.status(400).json({ error: 'First name, last name, email and password are required.' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const { deviceId, tenantId } = syncConfig.getConfig();
    const permissionsJson = JSON.stringify(Array.isArray(permissions) ? permissions : []);
    // v1.13.3 â€” stamp tenant_id at INSERT so subsequent tenant-filtered
    // SELECTs (login, permission checks) can find this user. Without it,
    // the row lands with tenant_id=NULL and login returns "Invalid
    // credentials" on the branch subdomain (matches gotcha #2 in memory).
    const info = db.prepare(
      'INSERT INTO users (first_name, last_name, email, password, phone, role, permissions, sync_id, tenant_id, device_id, synced) VALUES (?,?,?,?,?,?,?,?,?,?,0)'
    ).run(firstName, lastName, email, hashedPassword, phone || '', 'Administrator', permissionsJson, randomUUID(), tenantId || null, deviceId);
    const newUser = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    const token = jwt.sign(
      { id: newUser.id, email: newUser.email, role: newUser.role, name: `${newUser.first_name} ${newUser.last_name}`, tenantId: tenantId || 'local-only', webAccess: false },
      process.env.JWT_SECRET || 'kelete-pro-secret-key-2026',
      { expiresIn: '24h' }
    );
    res.status(201).json({
      token,
      user: { id: newUser.id, firstName: newUser.first_name, lastName: newUser.last_name, email: newUser.email, role: newUser.role, phone: newUser.phone, permissions: [] }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Register
router.post('/register', async (req, res) => {
  try {
    const { firstName, lastName, email, password, phone, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const { deviceId, tenantId } = syncConfig.getConfig();
    // v1.13.3 â€” stamp tenant_id at INSERT (see comment on register-first).
    const info = db.prepare(
      'INSERT INTO users (first_name, last_name, email, password, phone, role, sync_id, tenant_id, device_id, synced) VALUES (?,?,?,?,?,?,?,?,?,0)'
    ).run(firstName, lastName, email, hashedPassword, phone, role || 'Cashier', randomUUID(), tenantId || null, deviceId);
    const newUser = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ message: 'User created successfully', user: newUser });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2026-09-13 â€” a signed-in user changes their OWN password (sidebar â†’ Change
// password). The current password is checked first with the same bcrypt check
// as login. Mistakes answer 400, never 401: the frontend logs the user out on
// any 401, which would throw them out for a typo.
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Enter your current password and a new password.' });
    }
    if (String(newPassword).length < 4) {
      return res.status(400).json({ error: 'The new password must be at least 4 characters.' });
    }
    const tenantId = req.user?.tenantId;
    const user = tenantId && tenantId !== 'local-only'
      ? db.prepare('SELECT id, password FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(req.user.id, tenantId)
      : db.prepare('SELECT id, password FROM users WHERE id = ? AND deleted_at IS NULL').get(req.user?.id);
    if (!user) return res.status(404).json({ error: 'Your account was not found. Log out and log in again.' });

    if (!(await bcrypt.compare(String(currentPassword), user.password))) {
      return res.status(400).json({ error: 'Your current password is not correct.' });
    }
    if (await bcrypt.compare(String(newPassword), user.password)) {
      return res.status(400).json({ error: 'The new password must be different from the current one.' });
    }

    const hashed = await bcrypt.hash(String(newPassword), 10);
    db.prepare("UPDATE users SET password = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?").run(hashed, user.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
