const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');

function nextDeliveryNumber() {
  const row = db.prepare("SELECT COUNT(*) AS c FROM fuel_deliveries WHERE delivery_number LIKE 'FD-%'").get();
  return `FD-${String(row.c + 1).padStart(6, '0')}`;
}

router.get('/', auth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT fd.*, t.code AS tank_code, t.name AS tank_name,
             fg.code AS grade_code, fg.name AS grade_name,
             s.name AS supplier_name
        FROM fuel_deliveries fd
        LEFT JOIN tanks t ON t.id = fd.tank_id
        LEFT JOIN fuel_grades fg ON fg.id = fd.fuel_grade_id
        LEFT JOIN suppliers s ON s.id = fd.supplier_id
       ORDER BY fd.delivery_date DESC, fd.id DESC
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', auth, (req, res) => {
  const row = db.prepare(`
    SELECT fd.*, t.code AS tank_code, fg.name AS grade_name, s.name AS supplier_name
      FROM fuel_deliveries fd
      LEFT JOIN tanks t ON t.id = fd.tank_id
      LEFT JOIN fuel_grades fg ON fg.id = fd.fuel_grade_id
      LEFT JOIN suppliers s ON s.id = fd.supplier_id
     WHERE fd.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', auth, (req, res) => {
  const tx = db.transaction(() => {
    const {
      supplier_id = null, tank_id, delivery_date,
      litres_ordered = null, litres_delivered,
      dip_before = null, dip_after = null,
      cost_per_litre, invoice_number = '', branch_id = null, notes = ''
    } = req.body;

    if (!tank_id || !litres_delivered || !cost_per_litre) {
      throw new Error('tank_id, litres_delivered, cost_per_litre are required');
    }
    const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(tank_id);
    if (!tank) throw new Error('Tank not found');

    const litres = Number(litres_delivered);
    const cpl = Number(cost_per_litre);
    const total = litres * cpl;
    const number = nextDeliveryNumber();

    const info = db.prepare(`
      INSERT INTO fuel_deliveries (
        delivery_number, supplier_id, tank_id, fuel_grade_id, delivery_date,
        litres_ordered, litres_delivered, dip_before, dip_after,
        cost_per_litre, total_cost, invoice_number, branch_id, received_by, notes
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      number, supplier_id, tank_id, tank.fuel_grade_id,
      delivery_date || new Date().toISOString().slice(0, 10),
      litres_ordered != null ? Number(litres_ordered) : null,
      litres,
      dip_before != null ? Number(dip_before) : null,
      dip_after != null ? Number(dip_after) : null,
      cpl, total, invoice_number, branch_id,
      req.user?.id || null, notes
    );

    // Update tank volume and weighted-average cost on fuel_grade
    const newVolume = (tank.current_volume || 0) + litres;
    db.prepare('UPDATE tanks SET current_volume = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(newVolume, tank_id);

    const grade = db.prepare('SELECT * FROM fuel_grades WHERE id = ?').get(tank.fuel_grade_id);
    if (grade) {
      const oldVol = Math.max(tank.current_volume || 0, 0);
      const wac = (oldVol * grade.cost_price + litres * cpl) / Math.max(oldVol + litres, 1);
      db.prepare('UPDATE fuel_grades SET cost_price = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(Number(wac.toFixed(4)), grade.id);
    }

    return db.prepare('SELECT * FROM fuel_deliveries WHERE id = ?').get(info.lastInsertRowid);
  });

  try { res.status(201).json(tx()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', auth, (req, res) => {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM fuel_deliveries WHERE id = ?').get(req.params.id);
    if (!row) throw new Error('Not found');
    // reverse tank volume
    db.prepare('UPDATE tanks SET current_volume = current_volume - ? WHERE id = ?')
      .run(row.litres_delivered, row.tank_id);
    db.prepare('DELETE FROM fuel_deliveries WHERE id = ?').run(req.params.id);
    return { message: 'Deleted and tank volume reversed' };
  });
  try { res.json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
