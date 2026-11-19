// UX-10 — the station's day as work done, never money: shifts closed, cash
// counted, every tank dipped for each shift that ran, and each shift
// approved. All four complete → the day is "sealed". Plus the station's dip
// streak: days in a row on which every tank was dipped for every shift.
// Read-only. Belongs to the whole station — no person is scored or ranked.
const bt = require('../config/businessTime');

const has = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const num = (v) => Number(v) || 0;
const BALANCED = 0.01;
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// One dip per standalone tank, one per plumbed group.
function dipUnits(db) {
  const tanks = db.prepare("SELECT id, group_code FROM tanks WHERE status = 'Active'").all();
  const units = new Map();
  for (const t of tanks) {
    const g = String(t.group_code || '').trim().toUpperCase();
    const key = g ? `g:${g}` : `t:${t.id}`;
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(t.id);
  }
  return [...units.values()];
}

function shiftsOn(db, date) {
  return db.prepare(`SELECT id, status, UPPER(COALESCE(shift_type, 'DAY')) AS shift_type, payment_cash, actual_cash, expected_cash
                       FROM attendant_shifts s WHERE ${bt.shiftDateSql('s')} = DATE(?)`).all(date);
}

function dippedFor(db, date, type, units) {
  const done = new Set(db.prepare('SELECT DISTINCT tank_id FROM tank_dips WHERE dip_date = DATE(?) AND UPPER(COALESCE(shift_type, \'\')) = ?').all(date, type).map((r) => r.tank_id));
  return units.filter((ids) => ids.some((id) => done.has(id))).length;
}

function stationDay(db, date = bt.businessDate()) {
  if (!has(db, 'attendant_shifts') || !has(db, 'tanks')) return null;
  const shifts = shiftsOn(db, date);
  const types = [...new Set(shifts.map((s) => s.shift_type))].sort();
  const units = dipUnits(db);
  const cashEntered = (s) => s.status === 'Closed' && (num(s.payment_cash) > 0 || num(s.actual_cash) > 0 || Math.abs(num(s.expected_cash)) < BALANCED);
  const approved = has(db, 'fuel_shift_approvals')
    ? new Set(db.prepare('SELECT UPPER(shift_type) AS t FROM fuel_shift_approvals WHERE approval_date = DATE(?)').all(date).map((r) => r.t))
    : new Set();
  const dipsDone = has(db, 'tank_dips') ? types.reduce((a, t) => a + dippedFor(db, date, t, units), 0) : 0;
  const steps = [
    { key: 'closed', label: 'Shifts closed', done: shifts.filter((s) => s.status !== 'Open').length, total: shifts.length },
    { key: 'cash', label: 'Cash counted', done: shifts.filter(cashEntered).length, total: shifts.length },
    { key: 'dips', label: 'Tanks dipped', done: dipsDone, total: units.length * types.length },
    { key: 'approved', label: 'Shifts approved', done: types.filter((t) => approved.has(t)).length, total: types.length },
  ];
  const sealed = shifts.length > 0 && steps.every((s) => s.done >= s.total);
  return { date, shift_types: types, steps, sealed, ...dipStreak(db, date, units) };
}

// Days in a row (back from today; today counts once complete, and an
// unfinished today doesn't break it) where every tank was dipped for every
// shift that ran. Days with no shifts are passed over.
function dipStreak(db, today, units = dipUnits(db)) {
  if (!has(db, 'tank_dips') || units.length === 0) return { dip_streak: 0 };
  let streak = 0;
  for (let i = 0; i < 120; i += 1) {
    const d = addDays(today, -i);
    const types = [...new Set(shiftsOn(db, d).map((s) => s.shift_type))];
    if (types.length === 0) { if (i > 30 && streak === 0) break; continue; }
    const complete = types.every((t) => dippedFor(db, d, t, units) >= units.length);
    if (complete) streak += 1;
    else if (i === 0) continue;   // today still in progress
    else break;
  }
  return { dip_streak: streak };
}

module.exports = { stationDay, dipStreak };
