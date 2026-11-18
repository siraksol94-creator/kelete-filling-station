/**
 * businessTime.js — the station's business date (Zambia, UTC+2, no daylight
 * saving).
 *
 * Timestamps (opened_at, created_at…) are stored in UTC, which is right for a
 * moment in time. But the fuel module took the CALENDAR DATE of a shift, a dip,
 * a delivery or a credit ticket from UTC too — DATE(opened_at), date('now'),
 * new Date().toISOString().slice(0, 10) — so anything between 00:00 and 02:00
 * in Lusaka landed on the previous day: night shifts filed, approved and
 * reported under the wrong date.
 *
 * Everything that needs "which trading day is this?" now asks here.
 * KELETE_UTC_OFFSET_MINUTES overrides the offset (default 120).
 */
function offsetMinutes() {
  const raw = process.env.KELETE_UTC_OFFSET_MINUTES;
  const v = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(v) ? v : 120;
}

// Tests only: pretend the clock reads KELETE_TEST_NOW (an ISO time). Ignored
// unless NODE_ENV=test, so it can never move a live server's dates.
function now() {
  if (process.env.NODE_ENV === 'test' && process.env.KELETE_TEST_NOW) {
    const t = new Date(process.env.KELETE_TEST_NOW);
    if (!isNaN(t)) return t;
  }
  return new Date();
}

// 'YYYY-MM-DD' in business time.
function businessDate(at = now()) {
  return new Date(at.getTime() + offsetMinutes() * 60000).toISOString().slice(0, 10);
}

// SQLite: DATE(<utc timestamp column>) in business time.
function sqlBusinessDate(col) {
  const m = offsetMinutes();
  return `DATE(${col}, '${m >= 0 ? '+' : ''}${m} minutes')`;
}

// A shift's trading day: the business date recorded when it was opened
// (shift_date); older rows without it keep the date they always had.
function shiftDateSql(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `COALESCE(${p}shift_date, DATE(${p}opened_at))`;
}

module.exports = { offsetMinutes, now, businessDate, sqlBusinessDate, shiftDateSql };
