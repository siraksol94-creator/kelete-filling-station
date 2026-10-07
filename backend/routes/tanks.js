const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.*, fg.code AS grade_code, fg.name AS grade_name, fg.color AS grade_color,
             fg.selling_price AS grade_selling_price
        FROM tanks t
        LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
       ORDER BY t.code
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', auth, (req, res) => {
  const row = db.prepare(`
    SELECT t.*, fg.code AS grade_code, fg.name AS grade_name, fg.color AS grade_color
      FROM tanks t
      LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
     WHERE t.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', auth, (req, res) => {
  try {
    const { code, name, fuel_grade_id, capacity_litres, current_volume = 0, low_stock_litres = 1000, branch_id = null } = req.body;
    if (!code || !name || !fuel_grade_id || !capacity_litres) {
      return res.status(400).json({ error: 'code, name, fuel_grade_id, capacity_litres are required' });
    }
    const info = db.prepare(`
      INSERT INTO tanks (code, name, fuel_grade_id, capacity_litres, current_volume, low_stock_litres, branch_id)
      VALUES (?,?,?,?,?,?,?)
    `).run(code.trim(), name.trim(), Number(fuel_grade_id), Number(capacity_litres), Number(current_volume) || 0, Number(low_stock_litres) || 0, branch_id);
    res.status(201).json(db.prepare('SELECT * FROM tanks WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', auth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM tanks WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    db.prepare(`
      UPDATE tanks SET
        code = ?, name = ?, fuel_grade_id = ?, capacity_litres = ?,
        current_volume = ?, low_stock_litres = ?, branch_id = ?, status = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.code ?? existing.code,
      b.name ?? existing.name,
      b.fuel_grade_id ?? existing.fuel_grade_id,
      b.capacity_litres != null ? Number(b.capacity_litres) : existing.capacity_litres,
      b.current_volume != null ? Number(b.current_volume) : existing.current_volume,
      b.low_stock_litres != null ? Number(b.low_stock_litres) : existing.low_stock_litres,
      b.branch_id ?? existing.branch_id,
      b.status ?? existing.status,
      req.params.id
    );
    res.json(db.prepare('SELECT * FROM tanks WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const nozUse = db.prepare('SELECT COUNT(*) AS c FROM nozzles WHERE tank_id = ?').get(req.params.id).c;
    if (nozUse > 0) return res.status(400).json({ error: `In use by ${nozUse} nozzle(s)` });
    db.prepare('DELETE FROM tanks WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Dip-stick manual adjustment (opening/closing stock reconciliation)
router.post('/:id/dip', auth, (req, res) => {
  try {
    const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(req.params.id);
    if (!tank) return res.status(404).json({ error: 'Not found' });
    const { measured_litres, notes = '' } = req.body;
    if (measured_litres == null) return res.status(400).json({ error: 'measured_litres is required' });
    const variance = Number(measured_litres) - tank.current_volume;
    db.prepare('UPDATE tanks SET current_volume = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(Number(measured_litres), req.params.id);
    res.json({
      message: 'Dip recorded',
      previous_volume: tank.current_volume,
      new_volume: Number(measured_litres),
      variance,
      notes
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
