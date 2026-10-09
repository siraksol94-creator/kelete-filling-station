const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');

// GET /api/tank-groups - list all groups with aggregated volume/capacity
router.get('/', auth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT g.*,
             fg.code AS grade_code, fg.name AS grade_name, fg.color AS grade_color,
             fg.selling_price AS grade_selling_price,
             (SELECT COUNT(*) FROM tanks WHERE tank_group_id = g.id) AS tank_count,
             (SELECT COALESCE(SUM(capacity_litres), 0) FROM tanks WHERE tank_group_id = g.id) AS total_capacity,
             (SELECT COALESCE(SUM(current_volume), 0) FROM tanks WHERE tank_group_id = g.id) AS total_volume,
             (SELECT COALESCE(SUM(low_stock_litres), 0) FROM tanks WHERE tank_group_id = g.id) AS total_low_stock
        FROM tank_groups g
        LEFT JOIN fuel_grades fg ON fg.id = g.fuel_grade_id
       ORDER BY g.name
    `).all();
    // Attach the member tanks for each group
    const members = db.prepare('SELECT id, code, name, tank_group_id, capacity_litres, current_volume, low_stock_litres FROM tanks WHERE tank_group_id IS NOT NULL ORDER BY code').all();
    const byGroup = {};
    for (const m of members) {
      (byGroup[m.tank_group_id] ||= []).push(m);
    }
    for (const g of rows) g.tanks = byGroup[g.id] || [];
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', auth, (req, res) => {
  try {
    const { name, fuel_grade_id, branch_id = null } = req.body;
    if (!name || !fuel_grade_id) return res.status(400).json({ error: 'name and fuel_grade_id are required' });
    const info = db.prepare('INSERT INTO tank_groups (name, fuel_grade_id, branch_id) VALUES (?,?,?)')
      .run(name.trim(), Number(fuel_grade_id), branch_id);
    res.status(201).json(db.prepare('SELECT * FROM tank_groups WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', auth, (req, res) => {
  try {
    const ex = db.prepare('SELECT * FROM tank_groups WHERE id = ?').get(req.params.id);
    if (!ex) return res.status(404).json({ error: 'Not found' });
    const b = req.body;
    db.prepare(`
      UPDATE tank_groups SET name = ?, fuel_grade_id = ?, branch_id = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(b.name ?? ex.name, b.fuel_grade_id ?? ex.fuel_grade_id, b.branch_id ?? ex.branch_id, b.status ?? ex.status, req.params.id);
    res.json(db.prepare('SELECT * FROM tank_groups WHERE id = ?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id', auth, (req, res) => {
  try {
    // ON DELETE SET NULL will un-group member tanks; they stay standalone
    db.prepare('DELETE FROM tank_groups WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted; member tanks are now ungrouped' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Assign tanks to this group (or null to ungroup)
router.post('/:id/assign', auth, (req, res) => {
  try {
    const { tank_ids = [] } = req.body;
    const groupId = Number(req.params.id);
    const stmt = db.prepare('UPDATE tanks SET tank_group_id = ?, updated_at = datetime(\'now\') WHERE id = ?');
    db.transaction(() => {
      for (const id of tank_ids) stmt.run(groupId, Number(id));
    })();
    res.json({ message: `Assigned ${tank_ids.length} tank(s)` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/unassign', auth, (req, res) => {
  try {
    const { tank_ids = [] } = req.body;
    const stmt = db.prepare('UPDATE tanks SET tank_group_id = NULL, updated_at = datetime(\'now\') WHERE id = ?');
    db.transaction(() => { for (const id of tank_ids) stmt.run(Number(id)); })();
    res.json({ message: 'Unassigned' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
