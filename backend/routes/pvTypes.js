const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

const DEFAULTS = [
  { name: 'Supplier',  color: '#2563eb' },
  { name: 'Utilities', color: '#d97706' },
  { name: 'Salaries',  color: '#9333ea' },
  { name: 'Rent',      color: '#16a34a' },
  { name: 'Other',     color: '#6b7280' },
];

// Seed defaults on first-use (per tenant) so the dropdown is never empty.
function ensureSeeded(tenantId) {
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM pv_types WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId).c;
  if (cnt > 0) return;
  const { branchId, deviceId } = syncConfig.getConfig();
  const ins = db.prepare(`
    INSERT INTO pv_types (name, color, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,0,datetime('now'),datetime('now'))
  `);
  db.transaction(() => {
    for (const d of DEFAULTS) ins.run(d.name, d.color, randomUUID(), tenantId, branchId, deviceId);
  })();
}

router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    ensureSeeded(req.user.tenantId);
    const rows = db.prepare(
      'SELECT * FROM pv_types WHERE deleted_at IS NULL AND tenant_id = ? ORDER BY name'
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/', auth, (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const dup = db.prepare(
      'SELECT id FROM pv_types WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL AND tenant_id = ?'
    ).get(name.trim(), tenantId);
    if (dup) return res.status(400).json({ error: 'A type with that name already exists' });
    const info = db.prepare(`
      INSERT INTO pv_types (name, color, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(name.trim(), color || '#6B7280', randomUUID(), tenantId, branchId, deviceId);
    res.status(201).json(db.prepare('SELECT * FROM pv_types WHERE id = ?').get(info.lastInsertRowid));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/:id', auth, (req, res) => {
  try {
    const { name, color } = req.body;
    db.prepare(`
      UPDATE pv_types SET name = ?, color = ?, updated_at = datetime('now'), synced = 0
      WHERE id = ? AND tenant_id = ?
    `).run(name, color || '#6B7280', req.params.id, req.user.tenantId);
    res.json(db.prepare('SELECT * FROM pv_types WHERE id = ?').get(req.params.id));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const t = db.prepare('SELECT name FROM pv_types WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Type not found' });
    // Block delete if any active PV references this type by name.
    const inUse = db.prepare(
      "SELECT COUNT(*) AS c FROM payment_vouchers WHERE category = ? AND deleted_at IS NULL AND tenant_id = ?"
    ).get(t.name, req.user.tenantId);
    if (inUse.c > 0) {
      return res.status(400).json({ error: `Cannot delete "${t.name}" — ${inUse.c} payment voucher(s) use it.` });
    }
    db.prepare("UPDATE pv_types SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?").run(req.params.id);
    res.json({ message: 'Type deleted' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

module.exports = router;
