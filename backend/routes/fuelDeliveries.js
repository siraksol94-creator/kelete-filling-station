const router = require('express').Router();
const db = require('../config/database');
const { auth, hasActiveRole, SUPERVISOR_ROLES } = require('../middleware/auth');
// Fuel Station access (business decision 2026-11-18): fuel deliveries are for
// Managers / Supervisors (and Administrators) only — viewing, recording and
// deleting. Cashiers have no access.
const supervisorsOnly = (req, res, next) => (hasActiveRole(req, SUPERVISOR_ROLES)
  ? next()
  : res.status(403).json({ error: 'Fuel deliveries are for Managers, Supervisors and Administrators only.' }));
const { recordTankMovement } = require('../config/fuelSchema');

// Numbering fix — was "FD-" + (row count + 1): deleting any delivery but the
// latest made the next number repeat an existing one (UNIQUE error, save
// refused), and two tills would mint the same numbers once fuel syncs. Now
// the system's standard document numbers (FD-<year>-<device>-<seq>): the
// per-device counter only moves forward and is never reused. Existing
// FD-000001-style numbers are left as they are.
function nextDeliveryNumber() {
  return require('../config/syncConfig').generateNumber('FD', 'fuel_deliveries');
}

router.get('/', auth, supervisorsOnly, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT fd.*, t.code AS tank_code, t.name AS tank_name,
             fg.code AS grade_code, fg.name AS grade_name,
             fg.color AS grade_color, t.capacity_litres AS tank_capacity,   -- UX-8 (read-only extras)
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

router.get('/:id', auth, supervisorsOnly, (req, res) => {
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

router.post('/', auth, supervisorsOnly, (req, res) => {
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
      delivery_date || require('../config/businessTime').businessDate(),
      litres_ordered != null ? Number(litres_ordered) : null,
      litres,
      dip_before != null ? Number(dip_before) : null,
      dip_after != null ? Number(dip_after) : null,
      cpl, total, invoice_number, branch_id,
      req.user?.id || null, notes
    );

    // Bin-card: inbound delivery → +litres ledger row, cache updated inside.
    recordTankMovement(db, {
      tank_id, litres, type: 'delivery',
      ref_table: 'fuel_deliveries', ref_id: info.lastInsertRowid,
      notes: `Delivery ${number}`,
      created_by: req.user?.id || null,
      movement_date: delivery_date || null,
    });

    const grade = db.prepare('SELECT * FROM fuel_grades WHERE id = ?').get(tank.fuel_grade_id);
    if (grade) {
      const oldVol = Math.max(tank.current_volume || 0, 0);
      const wac = (oldVol * grade.cost_price + litres * cpl) / Math.max(oldVol + litres, 1);
      const after = Number(wac.toFixed(4));
      db.prepare('UPDATE fuel_grades SET cost_price = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(after, grade.id);
      // Average-cost fix: remember the cost either side of this delivery so
      // deleting it can put the grade's cost back.
      db.prepare('UPDATE fuel_deliveries SET cost_before = ?, cost_after = ? WHERE id = ?')
        .run(Number(grade.cost_price), after, info.lastInsertRowid);
    }

    return db.prepare('SELECT * FROM fuel_deliveries WHERE id = ?').get(info.lastInsertRowid);
  });

  try { res.status(201).json(tx()); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Average-cost fix — deleting a delivery used to reverse its litres but leave
// its price blended into the grade's average cost for good.
//  • If it is still the latest cost change for the grade (the cost is exactly
//    what it set, and no later delivery of the grade exists), restore the cost
//    it replaced.
//  • Otherwise (a later delivery came after it, or it predates this fix and has
//    no recorded "before" cost), take its litres at its price back out of the
//    average held in the tank: (cost × volume − litres × price) ÷ (volume − litres).
//    If that cannot be worked out (the tank would be empty or the result is not
//    positive) the cost is left as it is and the response says so.
// Runs BEFORE the reversal movement, while the tank still holds the litres.
function reverseAverageCost(row) {
  const grade = db.prepare('SELECT id, cost_price FROM fuel_grades WHERE id = ?').get(row.fuel_grade_id);
  if (!grade) return 'grade not found — cost unchanged';
  const cur = Number(grade.cost_price);
  const later = db.prepare('SELECT 1 FROM fuel_deliveries WHERE fuel_grade_id = ? AND id > ? LIMIT 1').get(row.fuel_grade_id, row.id);
  let next = null, how;
  if (row.cost_before != null && !later && Math.abs(cur - Number(row.cost_after)) < 0.00005) {
    next = Number(row.cost_before); how = 'restored to the cost before this delivery';
  } else {
    const tank = db.prepare('SELECT current_volume FROM tanks WHERE id = ?').get(row.tank_id);
    const vol = Number(tank ? tank.current_volume : 0);
    const litres = Number(row.litres_delivered || 0);
    const remaining = vol - litres;
    const v = remaining > 0 ? (cur * vol - litres * Number(row.cost_per_litre || 0)) / remaining : NaN;
    if (Number.isFinite(v) && v > 0) { next = Number(v.toFixed(4)); how = 'this delivery taken out of the average'; }
    else return 'cost unchanged: the tank would be empty without this delivery — set the grade cost by hand if needed';
  }
  db.prepare("UPDATE fuel_grades SET cost_price = ?, updated_at = datetime('now') WHERE id = ?").run(next, grade.id);
  return `${how}: ${cur} → ${next}`;
}

router.delete('/:id', auth, supervisorsOnly, (req, res) => {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM fuel_deliveries WHERE id = ?').get(req.params.id);
    if (!row) throw new Error('Not found');
    const costNote = reverseAverageCost(row);
    // Reversal row (keeps the delivery row traceable as cancelled)
    recordTankMovement(db, {
      tank_id: row.tank_id, litres: -Number(row.litres_delivered || 0),
      type: 'reversal', ref_table: 'fuel_deliveries', ref_id: row.id,
      notes: `Reversed delivery ${row.delivery_number}`,
      created_by: req.user?.id || null,
    });
    db.prepare('DELETE FROM fuel_deliveries WHERE id = ?').run(req.params.id);
    return { message: 'Deleted; tank volume and average cost reversed', cost: costNote };
  });
  try { res.json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
