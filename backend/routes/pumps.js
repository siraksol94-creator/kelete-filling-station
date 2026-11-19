const router = require('express').Router();
const db = require('../config/database');
const { auth, adminOnly, hasActiveRole, isActiveAdmin, SUPERVISOR_ROLES } = require('../middleware/auth');
// Fuel Station access (business decision 2026-11-18): fuel prices (grades),
// pumps and tanks are set up and changed by Administrators only; cashiers and
// other roles can still READ them (the shift, credit-ticket and fuel cash
// screens show prices, nozzles and tank levels).
// Nozzle meter corrections stay open to supervisors (Manager) as decided
// earlier (S7): on PUT /nozzles/:id a supervisor may change ONLY the meter
// reading; any other nozzle change needs an Administrator.
const { nozzlesInOpenShifts } = require('../services/fuelControls');

// --- Pumps ---
router.get('/', auth, (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
    const whereActive = includeInactive ? '' : "WHERE COALESCE(t.status, 'Active') = 'Active'";
    const pumps = db.prepare('SELECT * FROM pumps ORDER BY code').all();
    // Default: only nozzles whose tank is Active. Deactivating a tank
    // removes its nozzles from this list so Open Shift / edit screens
    // don't offer them. Open shifts in progress are untouched (they
    // reference nozzle_id directly, not via this query).
    const nozzles = db.prepare(`
      SELECT n.*, t.code AS tank_code, t.status AS tank_status,
             fg.name AS grade_name, fg.color AS grade_color,
             fg.selling_price AS price_per_litre
        FROM nozzles n
        LEFT JOIN tanks t ON t.id = n.tank_id
        LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
        ${whereActive}
       ORDER BY n.code
    `).all();
    // UX-8 — who is on each pump right now: attendants whose OPEN shift has
    // a reading on one of its nozzles (read-only; for the pump island view).
    let onShift = [];
    try {
      onShift = db.prepare(`
        SELECT DISTINCT n.pump_id, s.id AS shift_id, s.attendant_user_id,
               TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS attendant_name
          FROM shift_nozzle_readings snr
          JOIN attendant_shifts s ON s.id = snr.shift_id AND s.status = 'Open'
          JOIN nozzles n ON n.id = snr.nozzle_id
          LEFT JOIN users u ON u.id = s.attendant_user_id
         ORDER BY attendant_name`).all();
    } catch (_) { onShift = []; }
    const grouped = pumps.map(p => ({
      ...p,
      nozzles: nozzles.filter(n => n.pump_id === p.id),
      on_shift: onShift.filter(o => o.pump_id === p.id).map(({ pump_id, ...o }) => o),
    }));
    res.json(grouped);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', auth, adminOnly, (req, res) => {
  try {
    const { code, name, branch_id = null } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    const info = db.prepare('INSERT INTO pumps (code, name, branch_id) VALUES (?,?,?)')
      .run(code.trim(), name.trim(), branch_id);
    res.status(201).json(db.prepare('SELECT * FROM pumps WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', auth, adminOnly, (req, res) => {
  try {
    const ex = db.prepare('SELECT * FROM pumps WHERE id = ?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    db.prepare(`
      UPDATE pumps SET code = ?, name = ?, branch_id = ?, status = ?, updated_at = datetime('now') WHERE id = ?
    `).run(b.code ?? ex.code, b.name ?? ex.name, b.branch_id ?? ex.branch_id, b.status ?? ex.status, req.params.id);
    res.json(db.prepare('SELECT * FROM pumps WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', auth, adminOnly, (req, res) => {
  try {
    db.prepare('DELETE FROM pumps WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Nozzles (nested under /api/pumps/nozzles) ---
// By default returns ONLY nozzles whose tank is Active (so Open Shift
// pickers etc. don't offer retired tanks). ?include_inactive=1 for admin.
router.get('/nozzles/list', auth, (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
    const whereActive = includeInactive ? '' : "WHERE COALESCE(t.status, 'Active') = 'Active'";
    const rows = db.prepare(`
      SELECT n.*, p.code AS pump_code, p.name AS pump_name,
             t.code AS tank_code, t.status AS tank_status,
             fg.id AS grade_id, fg.code AS grade_code,
             fg.name AS grade_name, fg.color AS grade_color,
             fg.selling_price AS price_per_litre
        FROM nozzles n
        LEFT JOIN pumps p ON p.id = n.pump_id
        LEFT JOIN tanks t ON t.id = n.tank_id
        LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
        ${whereActive}
       ORDER BY p.code, n.code
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/nozzles', auth, adminOnly, (req, res) => {
  try {
    const { pump_id, tank_id, code, current_meter_reading = 0 } = req.body;
    if (!pump_id || !tank_id || !code) return res.status(400).json({ error: 'pump_id, tank_id, code are required' });
    const info = db.prepare(`
      INSERT INTO nozzles (pump_id, tank_id, code, current_meter_reading)
      VALUES (?,?,?,?)
    `).run(Number(pump_id), Number(tank_id), code.trim(), Number(current_meter_reading) || 0);
    res.status(201).json(db.prepare('SELECT * FROM nozzles WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/nozzles/:id', auth, (req, res) => {
  try {
    const ex = db.prepare('SELECT * FROM nozzles WHERE id = ?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    // F4 — the edit form sends every field on every save, so act only on
    // values that actually CHANGE.
    const meterChanges = b.current_meter_reading != null && b.current_meter_reading !== ''
      && Number(b.current_meter_reading) !== Number(ex.current_meter_reading);
    const tankChanges = b.tank_id != null && Number(b.tank_id) !== Number(ex.tank_id);
    // Fuel Station access: only Administrators and supervisors edit nozzles at
    // all, and a supervisor may change nothing but the meter reading.
    if (!hasActiveRole(req, SUPERVISOR_ROLES)) {
      return res.status(403).json({ error: 'Only an Administrator (or a supervisor, for meter readings) can change a nozzle.' });
    }
    const otherChanges = tankChanges
      || (b.pump_id != null && Number(b.pump_id) !== Number(ex.pump_id))
      || (b.code != null && String(b.code).trim() !== String(ex.code))
      || (b.status != null && String(b.status) !== String(ex.status));
    if (otherChanges && !isActiveAdmin(req)) {
      return res.status(403).json({ error: 'Only an Administrator can change a nozzle\'s pump, tank, code or status. Supervisors can correct the meter reading only.' });
    }
    if ((meterChanges || tankChanges) && nozzlesInOpenShifts([ex.id]).length) {
      // An open shift started from this meter and draws from this tank;
      // changing either mid-shift corrupts that shift's litres.
      return res.status(409).json({ error: 'This nozzle is in an open shift. Close the shift before changing its meter reading or tank.' });
    }
    if (meterChanges && !hasActiveRole(req, SUPERVISOR_ROLES)) {
      // A manual meter change decides how many litres the next shift is
      // charged for. Business decision 2026-11-18: supervisors (Manager role)
      // and administrators only. Every change is audited (D2).
      return res.status(403).json({ error: 'Only a supervisor (Manager) or Administrator can change a nozzle meter reading.' });
    }
    db.prepare(`
      UPDATE nozzles SET pump_id = ?, tank_id = ?, code = ?, current_meter_reading = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.pump_id ?? ex.pump_id,
      b.tank_id ?? ex.tank_id,
      b.code ?? ex.code,
      b.current_meter_reading != null ? Number(b.current_meter_reading) : ex.current_meter_reading,
      b.status ?? ex.status,
      req.params.id
    );
    res.json(db.prepare('SELECT * FROM nozzles WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/nozzles/:id', auth, adminOnly, (req, res) => {
  try {
    // F4 — a nozzle with shift readings is part of the fuel history; the
    // database already refuses (foreign key), this just says so clearly.
    const used = db.prepare('SELECT COUNT(*) AS n FROM shift_nozzle_readings WHERE nozzle_id = ?').get(req.params.id).n;
    if (used) return res.status(409).json({ error: 'This nozzle has shift readings and cannot be deleted. Mark it Inactive instead.' });
    db.prepare('DELETE FROM nozzles WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
