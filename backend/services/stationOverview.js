// UX-3 — the station's day at a glance, for the Dashboard. Read-only.
//
// Everything here is already shown elsewhere (Fuel Cash Report, Tanks,
// Attendant Shifts); it is summarised so the Dashboard doesn't have to call
// the fuel endpoints itself (which would widen who may read them).
//
//   grades  — litres and takings per grade from the day's meter readings
//   shifts  — how many shifts: open / closed / cash entered / approved
//   cash    — reconciled shifts, how many balanced, and the total variance
//             (the server-saved figure, in full, sign kept)
//   tanks   — active tanks with capacity, volume and low level
//
// Returns null when this database has no fuel tables (a shop-only branch).
const bt = require('../config/businessTime');

const BALANCED = 0.01;

function has(db, table) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}
function cols(db, table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
}

function stationToday(db, today = bt.businessDate()) {
  if (!has(db, 'attendant_shifts') || !has(db, 'tanks') || !has(db, 'fuel_grades')) return null;
  const SHIFT_DAY = bt.shiftDateSql('s');

  const shifts = db.prepare(`
    SELECT s.id, s.status, s.shift_type, s.payment_cash, s.actual_cash, s.expected_cash, s.variance
      FROM attendant_shifts s
     WHERE ${SHIFT_DAY} = DATE(?)
  `).all(today);

  const approvals = has(db, 'fuel_shift_approvals')
    ? new Set(db.prepare('SELECT shift_type FROM fuel_shift_approvals WHERE approval_date = DATE(?)').all(today).map((r) => r.shift_type || 'DAY'))
    : new Set();

  const num = (v) => Number(v) || 0;
  const cashEntered = (s) => s.status === 'Closed' && (num(s.payment_cash) > 0 || num(s.actual_cash) > 0 || Math.abs(num(s.expected_cash)) < BALANCED);
  const reconciled = shifts.filter(cashEntered);

  const ids = shifts.map((s) => s.id);
  const grades = ids.length === 0 ? [] : db.prepare(`
    SELECT fg.id AS grade_id, fg.name AS name, fg.color AS color,
           COALESCE(SUM(snr.litres_sold), 0) AS litres,
           COALESCE(SUM(snr.expected_cash), 0) AS amount
      FROM shift_nozzle_readings snr
      JOIN nozzles n ON n.id = snr.nozzle_id
      LEFT JOIN tanks t ON t.id = n.tank_id
      LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
     WHERE snr.shift_id IN (${ids.map(() => '?').join(',')})
     GROUP BY fg.id
     ORDER BY fg.name
  `).all(...ids).filter((g) => g.grade_id != null);

  // Average litres sold per day over the 7 days BEFORE today, per grade —
  // for "days of cover" on each tank. Days with no readings count as zero.
  const weekAgo = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  const avg = new Map(db.prepare(`
    SELECT fg.id AS grade_id, COALESCE(SUM(snr.litres_sold), 0) / 7.0 AS per_day
      FROM shift_nozzle_readings snr
      JOIN attendant_shifts s ON s.id = snr.shift_id
      JOIN nozzles n ON n.id = snr.nozzle_id
      LEFT JOIN tanks t ON t.id = n.tank_id
      LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
     WHERE ${SHIFT_DAY} >= DATE(?) AND ${SHIFT_DAY} < DATE(?)
     GROUP BY fg.id
  `).all(weekAgo, today).filter((r) => r.grade_id != null).map((r) => [r.grade_id, num(r.per_day)]));

  const tc = cols(db, 'tanks');
  const tanks = db.prepare(`
    SELECT t.id, t.code, t.name, t.capacity_litres AS capacity, t.current_volume AS volume,
           ${tc.includes('low_stock_litres') ? 't.low_stock_litres' : 'NULL'} AS low_level,
           ${tc.includes('group_code') ? 't.group_code' : 'NULL'} AS group_code,
           fg.id AS grade_id, fg.name AS grade, fg.color AS color
      FROM tanks t LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
     WHERE ${tc.includes('status') ? "COALESCE(t.status, 'Active') = 'Active'" : '1 = 1'}
     ORDER BY t.code
  `).all().map((t) => ({ ...t, capacity: num(t.capacity), volume: num(t.volume), low_level: t.low_level == null ? null : num(t.low_level) }));

  // Days of cover: all tanks of a grade together, at last week's average.
  const volByGrade = new Map();
  for (const t of tanks) volByGrade.set(t.grade_id, (volByGrade.get(t.grade_id) || 0) + Math.max(0, t.volume));
  for (const t of tanks) {
    const perDay = avg.get(t.grade_id) || 0;
    t.avg_daily_litres = Math.round(perDay * 10) / 10;
    t.days_cover = perDay > 0 ? Math.round((volByGrade.get(t.grade_id) / perDay) * 10) / 10 : null;
  }

  return {
    date: today,
    grades: grades.map((g) => ({ ...g, litres: num(g.litres), amount: num(g.amount) })),
    litres: grades.reduce((a, g) => a + num(g.litres), 0),
    shifts: {
      total: shifts.length,
      open: shifts.filter((s) => s.status === 'Open').length,
      closed: shifts.filter((s) => s.status === 'Closed').length,
      cash: reconciled.length,
      approved: shifts.filter((s) => approvals.has(s.shift_type || 'DAY')).length,
    },
    cash: {
      reconciled: reconciled.length,
      balanced: reconciled.filter((s) => Math.abs(num(s.variance)) < BALANCED).length,
      variance_total: Number(reconciled.reduce((a, s) => a + num(s.variance), 0).toFixed(2)),
    },
    tanks,
  };
}

module.exports = { stationToday };
