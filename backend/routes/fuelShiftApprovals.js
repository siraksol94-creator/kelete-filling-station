// Per-shift sign-off. One shift (DAY or NIGHT) is reconciled at a time:
//   * tank dips captured for that shift auto-post as dip_adjustment
//   * the shift's cash fields are locked for editing
//   * un-approve clears the lock; posted adjustments stay (reverse manually)

const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const { recordTankMovement } = require('../config/fuelSchema');

router.get('/:shiftId', auth, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT a.*, u.first_name || ' ' || u.last_name AS approved_by_name
        FROM fuel_shift_approvals a
        LEFT JOIN users u ON u.id = a.approved_by
       WHERE a.shift_id = ?
    `).get(req.params.shiftId);
    res.json(row || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/:shiftId/approve', auth, (req, res) => {
  if (req.user?.role !== 'Administrator') {
    return res.status(403).json({ error: 'Only administrators can approve a shift.' });
  }
  const shiftId = Number(req.params.shiftId);
  const { notes = '' } = req.body || {};

  const tx = db.transaction(() => {
    const shift = db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(shiftId);
    if (!shift) throw new Error('Shift not found');
    if (shift.status === 'Open') throw new Error('Shift still Open — close + finalize before approving.');

    const already = db.prepare('SELECT id FROM fuel_shift_approvals WHERE shift_id = ?').get(shiftId);
    if (already) throw new Error('Shift already approved.');

    // Auto-post every un-posted dip taken for this shift
    const pending = db.prepare(`
      SELECT * FROM tank_dips WHERE shift_id = ? AND posted_adjustment_id IS NULL
    `).all(shiftId);
    let postedCount = 0;
    for (const dip of pending) {
      if (!Number(dip.variance)) continue;
      const movId = recordTankMovement(db, {
        tank_id: dip.tank_id, litres: Number(dip.variance), type: 'dip_adjustment',
        ref_table: 'tank_dips', ref_id: dip.id,
        notes: `Shift #${shiftId} approval: measured ${dip.measured_litres} vs book ${dip.book_litres}`,
        created_by: req.user?.id || null,
        movement_date: dip.dip_date,
      });
      db.prepare("UPDATE tank_dips SET posted_adjustment_id = ?, updated_at = datetime('now') WHERE id = ?").run(movId, dip.id);
      postedCount++;
    }

    const info = db.prepare(`
      INSERT INTO fuel_shift_approvals (shift_id, approved_by, notes)
      VALUES (?, ?, ?)
    `).run(shiftId, req.user?.id || null, notes || null);

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

router.post('/:shiftId/un-approve', auth, (req, res) => {
  if (req.user?.role !== 'Administrator') {
    return res.status(403).json({ error: 'Only administrators can un-approve.' });
  }
  try {
    db.prepare('DELETE FROM fuel_shift_approvals WHERE shift_id = ?').run(req.params.shiftId);
    res.json({ message: 'Shift un-approved. Posted dip adjustments were NOT reversed.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
