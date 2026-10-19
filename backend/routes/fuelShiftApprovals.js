// Per-SHIFT sign-off keyed on (approval_date, shift_type). A "shift" is
// the DAY or NIGHT time window, not an attendant. Approving the DAY
// locks every attendant_shifts row in that DAY and auto-posts every
// un-posted tank_dip for (date, 'DAY').

const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const { recordTankMovement } = require('../config/fuelSchema');

// GET /:date/:shiftType  →  current approval row or null
router.get('/:date/:shiftType', auth, (req, res) => {
  try {
    const t = String(req.params.shiftType || '').toUpperCase();
    const row = db.prepare(`
      SELECT a.*, u.first_name || ' ' || u.last_name AS approved_by_name
        FROM fuel_shift_approvals a
        LEFT JOIN users u ON u.id = a.approved_by
       WHERE a.approval_date = DATE(?) AND a.shift_type = ?
    `).get(req.params.date, t);
    res.json(row || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:date/:shiftType/approve', auth, (req, res) => {
  if (req.user?.role !== 'Administrator') {
    return res.status(403).json({ error: 'Only administrators can approve a shift.' });
  }
  const date = req.params.date;
  const t = String(req.params.shiftType || '').toUpperCase();
  if (!['DAY', 'NIGHT'].includes(t)) return res.status(400).json({ error: 'shift_type must be DAY or NIGHT' });
  const { notes = '' } = req.body || {};

  const tx = db.transaction(() => {
    const already = db.prepare('SELECT id FROM fuel_shift_approvals WHERE approval_date = DATE(?) AND shift_type = ?').get(date, t);
    if (already) throw new Error('Shift already approved.');

    // Refuse if any attendant_shift in this (date, shift_type) is still Open
    const openCount = db.prepare(`
      SELECT COUNT(*) AS c FROM attendant_shifts
       WHERE DATE(opened_at) = DATE(?) AND COALESCE(shift_type, 'DAY') = ?
         AND status = 'Open'
    `).get(date, t).c;
    if (openCount > 0) throw new Error(`${openCount} ${t} shift(s) still Open — close + finalize before approving.`);

    // Auto-post every un-posted dip taken for this (date, shift_type)
    const pending = db.prepare(`
      SELECT * FROM tank_dips WHERE dip_date = DATE(?) AND shift_type = ? AND posted_adjustment_id IS NULL
    `).all(date, t);
    let postedCount = 0;
    for (const dip of pending) {
      if (!Number(dip.variance)) continue;
      const movId = recordTankMovement(db, {
        tank_id: dip.tank_id, litres: Number(dip.variance), type: 'dip_adjustment',
        ref_table: 'tank_dips', ref_id: dip.id,
        notes: `${t} shift approval ${date}: measured ${dip.measured_litres} vs book ${dip.book_litres}`,
        created_by: req.user?.id || null,
        movement_date: dip.dip_date,
      });
      db.prepare("UPDATE tank_dips SET posted_adjustment_id = ?, updated_at = datetime('now') WHERE id = ?").run(movId, dip.id);
      postedCount++;
    }

    const info = db.prepare(`
      INSERT INTO fuel_shift_approvals (approval_date, shift_type, approved_by, notes)
      VALUES (DATE(?), ?, ?, ?)
    `).run(date, t, req.user?.id || null, notes || null);

    return {
      approval: db.prepare(`
        SELECT a.*, u.first_name || ' ' || u.last_name AS approved_by_name
          FROM fuel_shift_approvals a LEFT JOIN users u ON u.id = a.approved_by
         WHERE a.id = ?
      `).get(info.lastInsertRowid),
      dips_posted: postedCount,
    };
  });

  try { res.json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/:date/:shiftType/un-approve', auth, (req, res) => {
  if (req.user?.role !== 'Administrator') {
    return res.status(403).json({ error: 'Only administrators can un-approve.' });
  }
  const t = String(req.params.shiftType || '').toUpperCase();
  try {
    db.prepare('DELETE FROM fuel_shift_approvals WHERE approval_date = DATE(?) AND shift_type = ?').run(req.params.date, t);
    res.json({ message: 'Shift un-approved. Posted dip adjustments were NOT reversed.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
