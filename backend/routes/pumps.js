const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');

// --- Pumps ---
router.get('/', auth, (req, res) => {
  try {
    const pumps = db.prepare('SELECT * FROM pumps ORDER BY code').all();
    const nozzles = db.prepare(`
      SELECT n.*, t.code AS tank_code, fg.name AS grade_name, fg.color AS grade_color,
             fg.selling_price AS price_per_litre
        FROM nozzles n
        LEFT JOIN tanks t ON t.id = n.tank_id
        LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
       ORDER BY n.code
    `).all();
    const grouped = pumps.map(p => ({ ...p, nozzles: nozzles.filter(n => n.pump_id === p.id) }));
    res.json(grouped);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', auth, (req, res) => {
  try {
    const { code, name, branch_id = null } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    const info = db.prepare('INSERT INTO pumps (code, name, branch_id) VALUES (?,?,?)')
      .run(code.trim(), name.trim(), branch_id);
    res.status(201).json(db.prepare('SELECT * FROM pumps WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', auth, (req, res) => {
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

router.delete('/:id', auth, (req, res) => {
  try {
    db.prepare('DELETE FROM pumps WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Nozzles (nested under /api/pumps/nozzles) ---
router.get('/nozzles/list', auth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT n.*, p.code AS pump_code, p.name AS pump_name,
             t.code AS tank_code, fg.id AS grade_id, fg.code AS grade_code,
             fg.name AS grade_name, fg.color AS grade_color,
             fg.selling_price AS price_per_litre
        FROM nozzles n
        LEFT JOIN pumps p ON p.id = n.pump_id
        LEFT JOIN tanks t ON t.id = n.tank_id
        LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
       ORDER BY p.code, n.code
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/nozzles', auth, (req, res) => {
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

router.delete('/nozzles/:id', auth, (req, res) => {
  try {
    db.prepare('DELETE FROM nozzles WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
