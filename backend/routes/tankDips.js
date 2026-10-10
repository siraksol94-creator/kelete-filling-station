// Tank Dips — one measured dip per tank per day. Captures the variance
// against the computed book volume but does NOT change tanks.current_volume.
// An admin can later "post adjustment" to accept the dip as the new truth,
// which writes a tank_movements row of type='dip_adjustment' so the ledger
// retains the full audit trail.

const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const { recordTankMovement } = require('../config/fuelSchema');

// Dip grid for a date: every active tank with the day's dip (if any) +
// current book volume + variance.
router.get('/', auth, (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT t.id AS tank_id, t.code AS tank_code, t.name AS tank_name,
             t.current_volume AS book_volume,
             fg.name AS grade_name, fg.color AS grade_color,
             d.id AS dip_id, d.measured_litres, d.variance, d.posted_adjustment_id,
             d.notes AS dip_notes,
             u.first_name || ' ' || u.last_name AS taken_by_name
        FROM tanks t
        LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
        LEFT JOIN tank_dips d ON d.tank_id = t.id AND d.dip_date = ?
        LEFT JOIN users u ON u.id = d.taken_by_user_id
       WHERE t.status != 'Deleted'
       ORDER BY t.code
    `).all(date);
    res.json({ date, rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save (upsert) a dip. The book volume captured here is the tank's
// current_volume at the moment of save — it's a snapshot, not computed
// later. A later adjustment can rewrite the variance only via re-save.
router.post('/', auth, (req, res) => {
  try {
    const { tank_id, dip_date, measured_litres, notes = '' } = req.body;
    if (!tank_id || measured_litres == null) {
      return res.status(400).json({ error: 'tank_id and measured_litres are required' });
    }
    const tank = db.prepare('SELECT current_volume FROM tanks WHERE id = ?').get(tank_id);
    if (!tank) return res.status(404).json({ error: 'Tank not found' });
    const date = dip_date || new Date().toISOString().slice(0, 10);
    const measured = Number(measured_litres);
    const book = Number(tank.current_volume);
    const variance = Number((measured - book).toFixed(2));

    const existing = db.prepare('SELECT id, posted_adjustment_id FROM tank_dips WHERE tank_id = ? AND dip_date = ?').get(tank_id, date);
    if (existing && existing.posted_adjustment_id) {
      return res.status(400).json({ error: 'Dip already posted as adjustment — cannot edit' });
    }
    if (existing) {
      db.prepare(`
        UPDATE tank_dips
           SET measured_litres = ?, book_litres = ?, variance = ?,
               notes = ?, taken_by_user_id = ?, updated_at = datetime('now')
         WHERE id = ?
      `).run(measured, book, variance, notes || null, req.user?.id || null, existing.id);
      res.json(db.prepare('SELECT * FROM tank_dips WHERE id = ?').get(existing.id));
    } else {
      const info = db.prepare(`
        INSERT INTO tank_dips (tank_id, dip_date, measured_litres, book_litres, variance, taken_by_user_id, notes)
        VALUES (?,?,?,?,?,?,?)
      `).run(tank_id, date, measured, book, variance, req.user?.id || null, notes || null);
      res.status(201).json(db.prepare('SELECT * FROM tank_dips WHERE id = ?').get(info.lastInsertRowid));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Post the dip as a ledger adjustment — tank.current_volume moves to
// match the measured value. Writes a tank_movements row of type
// 'dip_adjustment' with litres = variance. Admin only.
router.post('/:id/post-adjustment', auth, (req, res) => {
  if (req.user?.role !== 'Administrator') {
    return res.status(403).json({ error: 'Administrator only' });
  }
  const tx = db.transaction(() => {
    const dip = db.prepare('SELECT * FROM tank_dips WHERE id = ?').get(req.params.id);
    if (!dip) throw new Error('Dip not found');
    if (dip.posted_adjustment_id) throw new Error('Already posted');
    if (!Number(dip.variance)) throw new Error('Zero variance — nothing to post');
    const movId = recordTankMovement(db, {
      tank_id: dip.tank_id, litres: Number(dip.variance), type: 'dip_adjustment',
      ref_table: 'tank_dips', ref_id: dip.id,
      notes: `Dip adjustment ${dip.dip_date}: measured ${dip.measured_litres} vs book ${dip.book_litres}`,
      created_by: req.user?.id || null,
      movement_date: dip.dip_date,
    });
    db.prepare("UPDATE tank_dips SET posted_adjustment_id = ?, updated_at = datetime('now') WHERE id = ?").run(movId, dip.id);
    return db.prepare('SELECT * FROM tank_dips WHERE id = ?').get(dip.id);
  });
  try { res.json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const dip = db.prepare('SELECT posted_adjustment_id FROM tank_dips WHERE id = ?').get(req.params.id);
    if (!dip) return res.status(404).json({ error: 'Not found' });
    if (dip.posted_adjustment_id) return res.status(400).json({ error: 'Posted dip — cannot delete' });
    db.prepare('DELETE FROM tank_dips WHERE id = ?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
