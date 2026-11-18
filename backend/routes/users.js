const router = require('express').Router();
const db = require('../config/database');
const { auth, adminOnly, readOnlyGuard } = require('../middleware/auth');
const bcrypt = require('bcrypt');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const vsdc = require('../services/vsdcClient');

const parsePerms = (u) => ({ ...u, permissions: JSON.parse(u.permissions || '[]') });

// v1.13.128 — Fire-and-forget ZRA branch-user registration. Called after
// POST/PUT /users so a new cashier is registered with VSDC before their
// first sale. Never blocks the response — ZRA outages must not stop the
// operator from creating a user. Errors are captured on
// users.zra_last_error by the wrapper.
function fireZraUserSync(tenantId, userId, actor, isUpdate) {
  setImmediate(() => {
    try {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
      if (!row) return;
      vsdc.saveBranchUser(tenantId, row, { isUpdate, actor })
        .catch(e => console.warn('[zra saveBranchUser] threw:', e.message));
    } catch (e) {
      console.warn('[zra saveBranchUser] pre-fetch failed:', e.message);
    }
  });
}

router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      'SELECT id, first_name, last_name, email, role, permissions, status, phone, is_route_seller, last_login, created_at FROM users WHERE deleted_at IS NULL AND tenant_id = ? ORDER BY created_at DESC'
    ).all(req.user.tenantId);
    res.json(rows.map(parsePerms));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM users WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    const active = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE deleted_at IS NULL AND tenant_id = ? AND status = 'Active'").get(tenantId);
    const inactive = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE deleted_at IS NULL AND tenant_id = ? AND status = 'Inactive'").get(tenantId);
    const admins = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE deleted_at IS NULL AND tenant_id = ? AND role = 'Administrator'").get(tenantId);
    res.json({
      totalUsers: total.cnt,
      active: active.cnt,
      inactive: inactive.cnt,
      administrators: admins.cnt
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', auth, adminOnly, async (req, res) => {
  try {
    const { firstName, lastName, email, password, phone, role, permissions, isRouteSeller } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const info = db.prepare(
      `INSERT INTO users (first_name, last_name, email, password, phone, role, permissions, is_route_seller, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    ).run(firstName, lastName, email, hashedPassword, phone, role, JSON.stringify(permissions || []),
          isRouteSeller ? 1 : 0, randomUUID(), tenantId, branchId, deviceId);
    const row = db.prepare(
      'SELECT id, first_name, last_name, email, role, permissions, status FROM users WHERE id = ?'
    ).get(info.lastInsertRowid);
    fireZraUserSync(tenantId, info.lastInsertRowid, req.user?.email || 'system', false);
    res.status(201).json(parsePerms(row));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { firstName, lastName, email, phone, role, permissions, status, password, isRouteSeller } = req.body;
    // 2026-09-12 — permissions are written ONLY when the request carries them.
    // The Edit User form sends details alone (name, username, phone, role,
    // status, password) while the Permissions button sends the list; this
    // route used to store `permissions || []` on every save, so editing a
    // user's details silently wiped their permissions to nothing.
    const sets = ['first_name=?', 'last_name=?', 'email=?', 'phone=?', 'role=?', 'status=?'];
    const vals = [firstName, lastName, email, phone, role, status];
    if (permissions !== undefined) {
      sets.push('permissions=?');
      vals.push(JSON.stringify(Array.isArray(permissions) ? permissions : []));
    }
    if (password) {
      sets.push('password=?');
      vals.push(await bcrypt.hash(password, 10));
    }
    // 2026-09-15 — like permissions, only when sent (the Permissions save
    // does not carry it and must not clear it).
    if (isRouteSeller !== undefined) {
      sets.push('is_route_seller=?');
      vals.push(isRouteSeller ? 1 : 0);
    }
    db.prepare(
      `UPDATE users SET ${sets.join(', ')}, updated_at=datetime('now'), synced=0 WHERE id=?`
    ).run(...vals, req.params.id);
    const row = db.prepare(
      'SELECT id, first_name, last_name, email, role, permissions, status, phone, is_route_seller FROM users WHERE id = ?'
    ).get(req.params.id);
    fireZraUserSync(req.user.tenantId, req.params.id, req.user?.email || 'system', true);
    res.json(parsePerms(row));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', auth, adminOnly, (req, res) => {
  try {
    db.prepare("UPDATE users SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    res.json({ message: 'User deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
