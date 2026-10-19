// End-of-day sign-off for the Fuel Cash Report. Administrator approves
// the day, which (a) auto-posts every un-posted tank_dip for that date
// as a dip_adjustment ledger row and (b) locks the day's cash fields.

const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const { recordTankMovement } = require('../config/fuelSchema');

router.get('/:date', auth, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT fda.*, u.first_name || ' ' || u.last_name AS approved_by_name
        FROM fuel_day_approvals fda
        LEFT JOIN users u ON u.id = fda.approved_by
       WHERE fda.approval_date = DATE(?)
    `).get(req.params.date);
    res.json(row || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Approve the day. Administrator only. Refuses if any shift for the
// date is still Open (operators must finalise first).
router.post('/:date/approve', auth, (req, res) => {
  if (req.user?.role !== 'Administrator') {
    return res.status(403).json({ error: 'Only administrators can approve the day.' });
  }
  const date = req.params.date;
  const { notes = '' } = req.body || {};

  const tx = db.transaction(() => {
    const already = db.prepare('SELECT id FROM fuel_day_approvals WHERE approval_date = DATE(?)').get(date);
    if (already) throw new Error('Day already approved.');

    const openCount = db.prepare(`
      SELECT COUNT(*) AS c FROM attendant_shifts
       WHERE DATE(opened_at) = DATE(?) AND status = 'Open'
    `).get(date).c;
    if (openCount > 0) throw new Error(`${openCount} shift(s) still Open — close + finalize all shifts before approving.`);

    // Auto-post every un-posted dip for this date
    const pending = db.prepare(`
      SELECT * FROM tank_dips
       WHERE dip_date = DATE(?) AND posted_adjustment_id IS NULL
    `).all(date);
    let postedCount = 0;
    for (const dip of pending) {
      if (!Number(dip.variance)) continue;   // zero-variance dips get recorded but not posted
      const movId = recordTankMovement(db, {
        tank_id: dip.tank_id, litres: Number(dip.variance), type: 'dip_adjustment',
        ref_table: 'tank_dips', ref_id: dip.id,
        notes: `EOD approval ${date}: measured ${dip.measured_litres} vs book ${dip.book_litres}`,
        created_by: req.user?.id || null,
        movement_date: dip.dip_date,
      });
      db.prepare("UPDATE tank_dips SET posted_adjustment_id = ?, updated_at = datetime('now') WHERE id = ?").run(movId, dip.id);
      postedCount++;
    }

    const info = db.prepare(`
      INSERT INTO fuel_day_approvals (approval_date, approved_by, notes)
      VALUES (DATE(?), ?, ?)
    `).run(date, req.user?.id || null, notes || null);

    return {
      approval: db.prepare(`
        SELECT fda.*, u.first_name || ' ' || u.last_name AS approved_by_name
          FROM fuel_day_approvals fda
          LEFT JOIN users u ON u.id = fda.approved_by
         WHERE fda.id = ?
      `).get(info.lastInsertRowid),
      dips_posted: postedCount,
    };
  });

  try { res.json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Un-approve — only clears the fuel_day_approvals row. The ledger
// dip_adjustment rows stay (an admin would reverse those by posting a
// manual counter-adjustment if needed).
router.post('/:date/un-approve', auth, (req, res) => {
  if (req.user?.role !== 'Administrator') {
    return res.status(403).json({ error: 'Only administrators can un-approve.' });
  }
  try {
    db.prepare('DELETE FROM fuel_day_approvals WHERE approval_date = DATE(?)').run(req.params.date);
    res.json({ message: 'Un-approved. Posted dip adjustments were NOT reversed.' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
