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
    const perTank = db.prepare(`
      SELECT t.id AS tank_id, t.code AS tank_code, t.name AS tank_name,
             t.group_code,
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
       ORDER BY t.group_code, t.code
    `).all(date);

    // Collapse members of a group into a single row. The group row carries
    // combined book volume, combined measured (sum of member dips), and
    // the list of member tank_ids so the UI can re-split on save.
    const groups = {};
    const out = [];
    for (const t of perTank) {
      if (t.group_code) {
        if (!groups[t.group_code]) {
          groups[t.group_code] = {
            group_code: t.group_code, grade_name: t.grade_name, grade_color: t.grade_color,
            tank_codes: [], tank_ids: [], book_volume: 0, measured_litres: 0,
            dip_rows: [], dip_notes: '', posted: 0, taken_by_name: null,
          };
        }
        const g = groups[t.group_code];
        g.tank_codes.push(t.tank_code);
        g.tank_ids.push(t.tank_id);
        g.book_volume += Number(t.book_volume || 0);
        if (t.measured_litres != null) {
          g.measured_litres += Number(t.measured_litres);
          g.dip_rows.push({ dip_id: t.dip_id, tank_id: t.tank_id, measured: Number(t.measured_litres), posted: !!t.posted_adjustment_id });
          if (t.posted_adjustment_id) g.posted++;
          if (t.taken_by_name) g.taken_by_name = t.taken_by_name;
          if (t.dip_notes && !g.dip_notes) g.dip_notes = t.dip_notes;
        }
      } else {
        out.push({
          is_group: false, tank_code: t.tank_code, tank_name: t.tank_name,
          tank_ids: [t.tank_id], tank_codes: [t.tank_code],
          grade_name: t.grade_name, grade_color: t.grade_color,
          book_volume: Number(t.book_volume || 0),
          measured_litres: t.measured_litres,
          variance: t.variance,
          dip_rows: t.dip_id ? [{ dip_id: t.dip_id, tank_id: t.tank_id, measured: Number(t.measured_litres), posted: !!t.posted_adjustment_id }] : [],
          dip_notes: t.dip_notes,
          taken_by_name: t.taken_by_name,
          posted_count: t.posted_adjustment_id ? 1 : 0,
          member_count: 1,
        });
      }
    }
    for (const g of Object.values(groups)) {
      const hasAny = g.dip_rows.length > 0;
      const variance = hasAny ? Number((g.measured_litres - g.book_volume).toFixed(2)) : null;
      out.push({
        is_group: true, tank_code: `GROUP ${g.group_code}`, tank_name: g.tank_codes.join(' + '),
        tank_ids: g.tank_ids, tank_codes: g.tank_codes,
        grade_name: g.grade_name, grade_color: g.grade_color,
        book_volume: Number(g.book_volume.toFixed(2)),
        measured_litres: hasAny ? Number(g.measured_litres.toFixed(2)) : null,
        variance,
        dip_rows: g.dip_rows,
        dip_notes: g.dip_notes || '',
        taken_by_name: g.taken_by_name,
        posted_count: g.posted,
        member_count: g.tank_ids.length,
      });
    }
    res.json({ date, rows: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save (upsert) a dip. The book volume captured here is the tank's
// current_volume at the moment of save — it's a snapshot, not computed
// later. A later adjustment can rewrite the variance only via re-save.
// Save a dip. Accepts either a single `tank_id` (standalone tank) OR an
// array `tank_ids` (plumbed group — the measured litres is the shared
// level, split proportionally across members by their current book).
router.post('/', auth, (req, res) => {
  const tx = db.transaction(() => {
    const { tank_id, tank_ids, dip_date, measured_litres, notes = '' } = req.body;
    const ids = Array.isArray(tank_ids) && tank_ids.length > 0 ? tank_ids.map(Number) : (tank_id ? [Number(tank_id)] : []);
    if (ids.length === 0 || measured_litres == null) {
      throw new Error('tank_id (or tank_ids) and measured_litres are required');
    }
    const date = dip_date || new Date().toISOString().slice(0, 10);
    const totalMeasured = Number(measured_litres);

    const members = db.prepare(`SELECT id, current_volume FROM tanks WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    if (members.length !== ids.length) throw new Error('One or more tanks not found');
    const groupBook = members.reduce((s, m) => s + Number(m.current_volume || 0), 0);

    // Refuse if ANY member's dip is already posted — editing one half of
    // a plumbed pair would break the ledger invariant.
    for (const id of ids) {
      const ex = db.prepare('SELECT posted_adjustment_id FROM tank_dips WHERE tank_id = ? AND dip_date = ?').get(id, date);
      if (ex?.posted_adjustment_id) throw new Error('Dip already posted for a tank in this group — cannot edit');
    }

    const results = [];
    for (const m of members) {
      // Proportional allocation when the group has book volume; equal
      // split when all members are at zero (can happen on day one).
      const share = groupBook > 0 ? (Number(m.current_volume) / groupBook) : (1 / members.length);
      const measured = Number((totalMeasured * share).toFixed(4));
      const book = Number(m.current_volume);
      const variance = Number((measured - book).toFixed(2));
      const existing = db.prepare('SELECT id FROM tank_dips WHERE tank_id = ? AND dip_date = ?').get(m.id, date);
      if (existing) {
        db.prepare(`
          UPDATE tank_dips
             SET measured_litres = ?, book_litres = ?, variance = ?,
                 notes = ?, taken_by_user_id = ?, updated_at = datetime('now')
           WHERE id = ?
        `).run(measured, book, variance, notes || null, req.user?.id || null, existing.id);
        results.push(existing.id);
      } else {
        const info = db.prepare(`
          INSERT INTO tank_dips (tank_id, dip_date, measured_litres, book_litres, variance, taken_by_user_id, notes)
          VALUES (?,?,?,?,?,?,?)
        `).run(m.id, date, measured, book, variance, req.user?.id || null, notes || null);
        results.push(info.lastInsertRowid);
      }
    }
    return { dip_ids: results, member_count: members.length, group_variance: Number((totalMeasured - groupBook).toFixed(2)) };
  });
  try { res.status(201).json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
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
