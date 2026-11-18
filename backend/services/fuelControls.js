// F4 — shared fuel-shift controls, so every route applies the same rules.

const db = require('../config/database');

// A "shift window" is one business DATE plus DAY or NIGHT. Approving it locks
// every attendant shift opened in that window. (The date is DATE(opened_at),
// which is UTC — see Phase 1 §5B-6; unchanged here.)
function windowOf(shift) {
  return { date: String(shift.opened_at || '').slice(0, 10), type: shift.shift_type || 'DAY' };
}

function isWindowApproved(shift) {
  const w = windowOf(shift);
  return !!db.prepare(
    'SELECT 1 FROM fuel_shift_approvals WHERE approval_date = DATE(?) AND shift_type = ?'
  ).get(w.date, w.type);
}

// Throws a 409 when the shift's window is approved.
function assertNotApproved(shift, action) {
  if (isWindowApproved(shift)) {
    const w = windowOf(shift);
    const err = new Error(`The ${w.type} shift for ${w.date} is approved, so it cannot be ${action}. An Administrator must un-approve it first.`);
    err.status = 409;
    throw err;
  }
}

// Nozzles that are already in an OPEN attendant shift (optionally excluding one shift).
function nozzlesInOpenShifts(nozzleIds, exceptShiftId = null) {
  if (!nozzleIds.length) return [];
  const marks = nozzleIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT r.nozzle_id, n.code AS nozzle_code, s.id AS shift_id,
           u.first_name || ' ' || u.last_name AS attendant
      FROM shift_nozzle_readings r
      JOIN attendant_shifts s ON s.id = r.shift_id AND s.status = 'Open'
      LEFT JOIN nozzles n ON n.id = r.nozzle_id
      LEFT JOIN users u ON u.id = s.attendant_user_id
     WHERE r.nozzle_id IN (${marks}) AND (? IS NULL OR s.id != ?)
  `).all(...nozzleIds, exceptShiftId, exceptShiftId);
}

module.exports = { windowOf, isWindowApproved, assertNotApproved, nozzlesInOpenShifts };
