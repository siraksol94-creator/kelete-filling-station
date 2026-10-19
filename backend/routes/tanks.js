const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const { recordTankMovement } = require('../config/fuelSchema');

router.get('/', auth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.*, fg.code AS grade_code, fg.name AS grade_name, fg.color AS grade_color,
             fg.selling_price AS grade_selling_price,
             (SELECT m.litres FROM tank_movements m
               WHERE m.tank_id = t.id AND m.type = 'opening'
               ORDER BY m.movement_date, m.id LIMIT 1) AS opening_litres
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

// Bin-card view: opening balance + every movement in the date range,
// with the running computed closing. ref_table/ref_id are returned so
// the UI can link each line back to the source document.
router.get('/:id/bin-card', auth, (req, res) => {
  try {
    const tank = db.prepare('SELECT * FROM tanks WHERE id = ?').get(req.params.id);
    if (!tank) return res.status(404).json({ error: 'Not found' });
    const { from = null, to = null } = req.query;
    const whereRange = (from && to) ? "AND movement_date BETWEEN ? AND ?" : '';
    const params = from && to ? [tank.id, from, to] : [tank.id];
    const movements = db.prepare(`
      SELECT m.*, u.first_name || ' ' || u.last_name AS created_by_name
        FROM tank_movements m
        LEFT JOIN users u ON u.id = m.created_by
       WHERE m.tank_id = ? ${whereRange}
       ORDER BY m.movement_date, m.id
    `).all(...params);
    let openingBefore = 0;
    if (from) {
      openingBefore = db.prepare(`
        SELECT COALESCE(SUM(litres), 0) AS t FROM tank_movements
         WHERE tank_id = ? AND movement_date < ?
      `).get(tank.id, from).t;
    }
    let running = Number(openingBefore);
    const rows = movements.map(m => {
      running += Number(m.litres);
      return { ...m, balance_after: Number(running.toFixed(2)) };
    });
    res.json({ tank, opening_before: Number(openingBefore), rows, current_volume: tank.current_volume });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Merged bin-card for a plumbed group. All member tanks' movements are
// unioned and shown as one ledger (ref column notes the physical tank so
// the audit trail isn't lost), with opening_before + current_volume
// summed across members.
router.get('/group/:code/bin-card', auth, (req, res) => {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'group code required' });
    const members = db.prepare("SELECT * FROM tanks WHERE UPPER(COALESCE(group_code, '')) = ? ORDER BY code").all(code);
    if (members.length === 0) return res.status(404).json({ error: 'No tanks in group ' + code });
    const ids = members.map(m => m.id);
    const idList = ids.map(() => '?').join(',');
    const { from = null, to = null } = req.query;
    const whereRange = (from && to) ? "AND m.movement_date BETWEEN ? AND ?" : '';
    const params = from && to ? [...ids, from, to] : [...ids];
    const movements = db.prepare(`
      SELECT m.*, u.first_name || ' ' || u.last_name AS created_by_name,
             t.code AS tank_code
        FROM tank_movements m
        LEFT JOIN users u ON u.id = m.created_by
        LEFT JOIN tanks t ON t.id = m.tank_id
       WHERE m.tank_id IN (${idList}) ${whereRange}
       ORDER BY m.movement_date, m.id
    `).all(...params);
    let openingBefore = 0;
    if (from) {
      openingBefore = db.prepare(`
        SELECT COALESCE(SUM(litres), 0) AS t FROM tank_movements
         WHERE tank_id IN (${idList}) AND movement_date < ?
      `).get(...ids, from).t;
    }
    let running = Number(openingBefore);
    const rows = movements.map(m => {
      running += Number(m.litres);
      return { ...m, balance_after: Number(running.toFixed(2)) };
    });
    const current = members.reduce((s, m) => s + Number(m.current_volume || 0), 0);
    const codes = members.map(m => m.code).join(' + ');
    res.json({
      tank: { code: `GROUP ${code}`, name: `${codes} (plumbed)`, group_code: code, members },
      opening_before: Number(openingBefore),
      rows,
      current_volume: Number(current.toFixed(2)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', auth, (req, res) => {
  const tx = db.transaction(() => {
    const { code, name, fuel_grade_id, capacity_litres, current_volume = 0, low_stock_litres = 1000, vessel_count = 1, group_code = null, branch_id = null } = req.body;
    if (!code || !name || !fuel_grade_id || !capacity_litres) {
      throw new Error('code, name, fuel_grade_id, capacity_litres are required');
    }
    // Create with ZERO current_volume; opening balance goes in through the
    // ledger so there's a traceable 'opening' row with a date and user.
    const info = db.prepare(`
      INSERT INTO tanks (code, name, fuel_grade_id, capacity_litres, current_volume, low_stock_litres, vessel_count, group_code, branch_id)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(code.trim(), name.trim(), Number(fuel_grade_id), Number(capacity_litres), 0, Number(low_stock_litres) || 0, Math.max(1, Math.min(6, Number(vessel_count) || 1)), (group_code || '').trim() || null, branch_id);
    const openingLitres = Number(current_volume) || 0;
    if (openingLitres !== 0) {
      recordTankMovement(db, {
        tank_id: info.lastInsertRowid, litres: openingLitres, type: 'opening',
        notes: 'Opening balance',
        created_by: req.user?.id || null,
      });
    }
    return db.prepare('SELECT * FROM tanks WHERE id = ?').get(info.lastInsertRowid);
  });
  try { res.status(201).json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Update: metadata is safe to edit directly (code, name, grade, capacity,
// low-stock threshold, group, status). opening_litres, if provided, edits
// the tank's existing 'opening' ledger row (or inserts one when missing)
// and re-syncs current_volume = SUM(tank_movements.litres). No adjustment
// row is written — operators treat this as "fix the day-one baseline".
router.put('/:id', auth, (req, res) => {
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM tanks WHERE id = ?').get(req.params.id);
    if (!existing) throw new Error('Not found');
    const b = req.body;
    db.prepare(`
      UPDATE tanks SET
        code = ?, name = ?, fuel_grade_id = ?, capacity_litres = ?,
        low_stock_litres = ?, vessel_count = ?, group_code = ?,
        branch_id = ?, status = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.code ?? existing.code,
      b.name ?? existing.name,
      b.fuel_grade_id ?? existing.fuel_grade_id,
      b.capacity_litres != null ? Number(b.capacity_litres) : existing.capacity_litres,
      b.low_stock_litres != null ? Number(b.low_stock_litres) : existing.low_stock_litres,
      b.vessel_count != null ? Math.max(1, Math.min(6, Number(b.vessel_count) || 1)) : (existing.vessel_count || 1),
      b.group_code !== undefined ? ((b.group_code || '').trim() || null) : existing.group_code,
      b.branch_id ?? existing.branch_id,
      b.status ?? existing.status,
      req.params.id
    );

    if (b.opening_litres != null) {
      const newOpening = Number(b.opening_litres) || 0;
      const openRow = db.prepare("SELECT id, litres FROM tank_movements WHERE tank_id = ? AND type = 'opening' ORDER BY movement_date, id LIMIT 1").get(req.params.id);
      if (openRow) {
        db.prepare("UPDATE tank_movements SET litres = ?, notes = COALESCE(notes, 'Opening balance') WHERE id = ?").run(newOpening, openRow.id);
      } else if (newOpening !== 0) {
        db.prepare(`
          INSERT INTO tank_movements (tank_id, movement_date, type, litres, notes, created_by)
          VALUES (?, date('now'), 'opening', ?, 'Opening balance', ?)
        `).run(req.params.id, newOpening, req.user?.id || null);
      }
      // Re-sync cached current_volume from the ledger
      const sum = db.prepare('SELECT COALESCE(SUM(litres), 0) AS t FROM tank_movements WHERE tank_id = ?').get(req.params.id).t;
      db.prepare("UPDATE tanks SET current_volume = ?, updated_at = datetime('now') WHERE id = ?").run(Number(sum), req.params.id);
    }

    return db.prepare('SELECT * FROM tanks WHERE id = ?').get(req.params.id);
  });
  try { res.json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const nozUse = db.prepare('SELECT COUNT(*) AS c FROM nozzles WHERE tank_id = ?').get(req.params.id).c;
    if (nozUse > 0) return res.status(400).json({ error: `In use by ${nozUse} nozzle(s)` });
    db.prepare('DELETE FROM tanks WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
