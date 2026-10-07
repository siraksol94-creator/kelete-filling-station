const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  try {
    const rows = db.prepare(`SELECT * FROM fuel_grades ORDER BY name`).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM fuel_grades WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', auth, (req, res) => {
  try {
    const { code, name, unit = 'L', selling_price = 0, cost_price = 0, color = '#6B7280', branch_id = null } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    const dup = db.prepare('SELECT id FROM fuel_grades WHERE LOWER(code) = LOWER(?)').get(code.trim());
    if (dup) return res.status(400).json({ error: 'A fuel grade with that code already exists' });
    const info = db.prepare(`
      INSERT INTO fuel_grades (code, name, unit, selling_price, cost_price, color, branch_id)
      VALUES (?,?,?,?,?,?,?)
    `).run(code.trim().toUpperCase(), name.trim(), unit, Number(selling_price) || 0, Number(cost_price) || 0, color, branch_id);
    res.status(201).json(db.prepare('SELECT * FROM fuel_grades WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', auth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM fuel_grades WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const { code, name, unit, selling_price, cost_price, color, status, branch_id } = req.body;
    db.prepare(`
      UPDATE fuel_grades
         SET code = ?, name = ?, unit = ?, selling_price = ?, cost_price = ?,
             color = ?, status = ?, branch_id = ?, updated_at = datetime('now')
       WHERE id = ?
    `).run(
      (code ?? existing.code).toUpperCase(),
      name ?? existing.name,
      unit ?? existing.unit,
      selling_price != null ? Number(selling_price) : existing.selling_price,
      cost_price != null ? Number(cost_price) : existing.cost_price,
      color ?? existing.color,
      status ?? existing.status,
      branch_id ?? existing.branch_id,
      req.params.id
    );
    res.json(db.prepare('SELECT * FROM fuel_grades WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const tankUse = db.prepare('SELECT COUNT(*) AS c FROM tanks WHERE fuel_grade_id = ?').get(req.params.id).c;
    if (tankUse > 0) return res.status(400).json({ error: `In use by ${tankUse} tank(s)` });
    db.prepare('DELETE FROM fuel_grades WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
