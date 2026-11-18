const router = require('express').Router();
const db = require('../config/database');
const { auth, adminOnly } = require('../middleware/auth');
const fleetMerge = require('../services/fleetMerge');
const syncConfig = require('../config/syncConfig');

// --- F3: merge fleet accounts into Customers (Administrators) ---
// Business decision 2026-11-18. Dry-run first (plan), then apply; every step
// is logged and can be undone. See services/fleetMerge.js.
const mergeCtx = (req) => {
  const cfg = syncConfig.getConfig() || {};
  return { userId: req.user && req.user.id, userLabel: req.user && req.user.email,
           tenantId: (req.user && req.user.tenantId) || cfg.tenantId, branchId: cfg.branchId || null, deviceId: cfg.deviceId || null };
};
router.get('/merge/plan', auth, adminOnly, (req, res) => {
  try { res.json(fleetMerge.plan(db)); } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/merge/apply', auth, adminOnly, (req, res) => {
  try {
    if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'Review the plan first, then send { confirm: true }.' });
    res.json(fleetMerge.apply(db, { ...mergeCtx(req), resolve: req.body.resolve || {} }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/merge/undo', auth, adminOnly, (req, res) => {
  try {
    if (!req.body || req.body.confirm !== true) return res.status(400).json({ error: 'Send { confirm: true } (and optionally log_id) to undo.' });
    res.json(fleetMerge.undo(db, { logId: req.body.log_id || null, userLabel: req.user && req.user.email }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/merge/log', auth, adminOnly, (req, res) => {
  try { res.json(db.prepare('SELECT * FROM fleet_merge_log ORDER BY id DESC').all()); } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Fleet customers ---
router.get('/', auth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT fc.*,
             (SELECT COUNT(*) FROM fleet_vehicles WHERE fleet_customer_id = fc.id AND status = 'Active') AS vehicle_count
        FROM fleet_customers fc
       ORDER BY fc.name
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM fleet_customers WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  row.vehicles = db.prepare('SELECT * FROM fleet_vehicles WHERE fleet_customer_id = ? ORDER BY registration').all(req.params.id);
  res.json(row);
});

router.post('/', auth, (req, res) => {
  try {
    const { name, company = '', phone = '', email = '', address = '', credit_limit = 0 } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const info = db.prepare(`
      INSERT INTO fleet_customers (name, company, phone, email, address, credit_limit)
      VALUES (?,?,?,?,?,?)
    `).run(name.trim(), company, phone, email, address, Number(credit_limit) || 0);
    // F3: a new fleet account is a Customer from the start (linked to the one
    // matching Customer, or a new one; a doubtful match waits for the review).
    try { fleetMerge.linkNewFleet(db, info.lastInsertRowid, mergeCtx(req)); } catch (e) { console.warn('[fleet] link to customer failed:', e.message); }
    res.status(201).json(db.prepare('SELECT * FROM fleet_customers WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', auth, (req, res) => {
  try {
    const ex = db.prepare('SELECT * FROM fleet_customers WHERE id = ?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    db.prepare(`
      UPDATE fleet_customers SET
        name = ?, company = ?, phone = ?, email = ?, address = ?,
        credit_limit = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.name ?? ex.name,
      b.company ?? ex.company,
      b.phone ?? ex.phone,
      b.email ?? ex.email,
      b.address ?? ex.address,
      b.credit_limit != null ? Number(b.credit_limit) : ex.credit_limit,
      b.status ?? ex.status,
      req.params.id
    );
    res.json(db.prepare('SELECT * FROM fleet_customers WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const bal = db.prepare('SELECT current_balance FROM fleet_customers WHERE id = ?').get(req.params.id);
    if (bal && Math.abs(bal.current_balance) > 0.01) {
      return res.status(400).json({ error: 'Cannot delete: outstanding balance' });
    }
    db.prepare('DELETE FROM fleet_customers WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Vehicles under /api/fleet-customers/vehicles ---
router.get('/:id/vehicles', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM fleet_vehicles WHERE fleet_customer_id = ? ORDER BY registration').all(req.params.id);
  res.json(rows);
});

router.post('/:id/vehicles', auth, (req, res) => {
  try {
    const { registration, make = '', model = '', driver_name = '', driver_phone = '' } = req.body;
    if (!registration) return res.status(400).json({ error: 'registration is required' });
    const info = db.prepare(`
      INSERT INTO fleet_vehicles (fleet_customer_id, registration, make, model, driver_name, driver_phone)
      VALUES (?,?,?,?,?,?)
    `).run(req.params.id, registration.trim().toUpperCase(), make, model, driver_name, driver_phone);
    res.status(201).json(db.prepare('SELECT * FROM fleet_vehicles WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/vehicles/:vid', auth, (req, res) => {
  try {
    const ex = db.prepare('SELECT * FROM fleet_vehicles WHERE id = ?').get(req.params.vid);
    if (!ex) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    db.prepare(`
      UPDATE fleet_vehicles SET
        registration = ?, make = ?, model = ?, driver_name = ?, driver_phone = ?, status = ?
      WHERE id = ?
    `).run(
      (b.registration ?? ex.registration).toUpperCase(),
      b.make ?? ex.make,
      b.model ?? ex.model,
      b.driver_name ?? ex.driver_name,
      b.driver_phone ?? ex.driver_phone,
      b.status ?? ex.status,
      req.params.vid
    );
    res.json(db.prepare('SELECT * FROM fleet_vehicles WHERE id = ?').get(req.params.vid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/vehicles/:vid', auth, (req, res) => {
  try {
    db.prepare('DELETE FROM fleet_vehicles WHERE id = ?').run(req.params.vid);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
