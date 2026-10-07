const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');

router.get('/', auth, (req, res) => {
  try {
    const { status, from, to } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('s.status = ?'); params.push(status); }
    if (from)   { where.push("date(s.opened_at) >= date(?)"); params.push(from); }
    if (to)     { where.push("date(s.opened_at) <= date(?)"); params.push(to); }
    const sql = `
      SELECT s.*, u.first_name || ' ' || u.last_name AS attendant_name
        FROM attendant_shifts s
        LEFT JOIN users u ON u.id = s.attendant_user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.opened_at DESC
    `;
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/current', auth, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT s.*, u.first_name || ' ' || u.last_name AS attendant_name
        FROM attendant_shifts s
        LEFT JOIN users u ON u.id = s.attendant_user_id
       WHERE s.status = 'Open' AND s.attendant_user_id = ?
       ORDER BY s.opened_at DESC
       LIMIT 1
    `).get(req.user.id);
    if (!row) return res.json(null);
    row.readings = db.prepare(`
      SELECT snr.*, n.code AS nozzle_code, p.code AS pump_code,
             fg.name AS grade_name, fg.color AS grade_color
        FROM shift_nozzle_readings snr
        LEFT JOIN nozzles n ON n.id = snr.nozzle_id
        LEFT JOIN pumps p ON p.id = n.pump_id
        LEFT JOIN tanks t ON t.id = n.tank_id
        LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
       WHERE snr.shift_id = ?
    `).all(row.id);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', auth, (req, res) => {
  const row = db.prepare(`
    SELECT s.*, u.first_name || ' ' || u.last_name AS attendant_name
      FROM attendant_shifts s
      LEFT JOIN users u ON u.id = s.attendant_user_id
     WHERE s.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  row.readings = db.prepare(`
    SELECT snr.*, n.code AS nozzle_code, p.code AS pump_code,
           fg.name AS grade_name, fg.color AS grade_color
      FROM shift_nozzle_readings snr
      LEFT JOIN nozzles n ON n.id = snr.nozzle_id
      LEFT JOIN pumps p ON p.id = n.pump_id
      LEFT JOIN tanks t ON t.id = n.tank_id
      LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
     WHERE snr.shift_id = ?
  `).all(req.params.id);
  res.json(row);
});

// Open a shift: attendant + list of nozzle_ids to assign (opening meter is snapshotted from each nozzle)
router.post('/open', auth, (req, res) => {
  const tx = db.transaction(() => {
    const { attendant_user_id, nozzle_ids = [], branch_id = null, notes = '' } = req.body;
    if (!attendant_user_id) throw new Error('attendant_user_id is required');
    if (!Array.isArray(nozzle_ids) || nozzle_ids.length === 0) throw new Error('nozzle_ids (array) is required');

    // Block if attendant has an open shift
    const open = db.prepare("SELECT id FROM attendant_shifts WHERE attendant_user_id = ? AND status = 'Open'").get(attendant_user_id);
    if (open) throw new Error('Attendant already has an open shift');

    const info = db.prepare(`
      INSERT INTO attendant_shifts (attendant_user_id, branch_id, opened_by, notes)
      VALUES (?,?,?,?)
    `).run(attendant_user_id, branch_id, req.user?.id || null, notes);
    const shiftId = info.lastInsertRowid;

    const insReading = db.prepare(`
      INSERT INTO shift_nozzle_readings (shift_id, nozzle_id, opening_reading, price_per_litre)
      VALUES (?,?,?,?)
    `);
    for (const nid of nozzle_ids) {
      const n = db.prepare(`
        SELECT n.*, fg.selling_price
          FROM nozzles n
          LEFT JOIN tanks t ON t.id = n.tank_id
          LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
         WHERE n.id = ?
      `).get(nid);
      if (!n) throw new Error('Nozzle not found: ' + nid);
      insReading.run(shiftId, nid, n.current_meter_reading || 0, n.selling_price || 0);
    }
    return db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(shiftId);
  });
  try { res.status(201).json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Close a shift: closing meter per nozzle, testing litres, actual cash in
router.post('/:id/close', auth, (req, res) => {
  const tx = db.transaction(() => {
    const shift = db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(req.params.id);
    if (!shift) throw new Error('Shift not found');
    if (shift.status !== 'Open') throw new Error('Shift already closed');
    const { readings = [], actual_cash = 0, notes = '' } = req.body;
    if (!Array.isArray(readings) || readings.length === 0) throw new Error('readings array is required');

    let expectedCash = 0;
    const updReading = db.prepare(`
      UPDATE shift_nozzle_readings
         SET closing_reading = ?, testing_litres = ?, litres_sold = ?, expected_cash = ?
       WHERE id = ?
    `);
    const updNozzle = db.prepare('UPDATE nozzles SET current_meter_reading = ?, updated_at = datetime(\'now\') WHERE id = ?');
    const updTank   = db.prepare('UPDATE tanks SET current_volume = current_volume - ?, updated_at = datetime(\'now\') WHERE id = ?');

    for (const r of readings) {
      const base = db.prepare('SELECT * FROM shift_nozzle_readings WHERE id = ?').get(r.id);
      if (!base) throw new Error('Reading not found: ' + r.id);
      const closing = Number(r.closing_reading);
      if (!isFinite(closing) || closing < base.opening_reading) throw new Error(`Closing reading < opening for nozzle reading ${r.id}`);
      const testing = Number(r.testing_litres || 0);
      const litresSold = Math.max(closing - base.opening_reading - testing, 0);
      const expected = Number((litresSold * base.price_per_litre).toFixed(2));
      updReading.run(closing, testing, litresSold, expected, base.id);
      expectedCash += expected;

      // bump nozzle meter + decrement tank volume
      const noz = db.prepare('SELECT * FROM nozzles WHERE id = ?').get(base.nozzle_id);
      updNozzle.run(closing, base.nozzle_id);
      updTank.run(litresSold, noz.tank_id);
    }

    const variance = Number((Number(actual_cash) - expectedCash).toFixed(2));
    db.prepare(`
      UPDATE attendant_shifts
         SET status = 'Closed', closed_at = datetime('now'), closed_by = ?,
             expected_cash = ?, actual_cash = ?, variance = ?, notes = COALESCE(?, notes), updated_at = datetime('now')
       WHERE id = ?
    `).run(req.user?.id || null, expectedCash, Number(actual_cash) || 0, variance, notes || null, req.params.id);

    return db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(req.params.id);
  });
  try { res.json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
