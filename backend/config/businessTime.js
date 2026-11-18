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
 * KELETE_UTC_OFFSET_MINUTES overrides the offset (default 120) for this module
 * only. Static SQL in the routes and the migration-10 triggers use a fixed
 * '+120 minutes' (Zambia has no daylight saving): do not change the setting on
 * a live server.
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

// SQLite: 'now' in business time, for comparing with business-date columns
// (date = TODAY, date >= first of this month…). Pass extra modifiers after it.
function sqlBusinessNow(...modifiers) {
  const m = offsetMinutes();
  return `'now', '${m >= 0 ? '+' : ''}${m} minutes'${modifiers.map(x => `, '${x}'`).join('')}`;
}

// The UTC timestamp ('YYYY-MM-DD HH:MM:SS') for business day `dateStr` at the
// station's current time of day. Replaces "<date> + ' ' + toTimeString()",
// which mixed a chosen date with the SERVER's clock (UTC on the VPS, local on
// a till) and so stored timestamps no report could read consistently.
function businessStampUtc(dateStr, at = now()) {
  const m = offsetMinutes();
  const local = new Date(at.getTime() + m * 60000);
  const secs = local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? dateStr : businessDate(at);
  const utc = new Date(Date.parse(`${day}T00:00:00Z`) + secs * 1000 - m * 60000);
  return utc.toISOString().replace('T', ' ').slice(0, 19);
}

// The business day of a row that has business_date (orders, stock_movements):
// rows from before this column existed keep the day they always showed.
function businessDaySql(alias = '') {
  const p = alias ? `${alias}.` : '';
  return `COALESCE(${p}business_date, DATE(${p}created_at))`;
}

// The business day of a UTC timestamp string (JS).
function businessDateOf(ts) {
  if (!ts) return null;
  const s = String(ts);
  const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d) ? s.slice(0, 10) : businessDate(d);
}

module.exports = { offsetMinutes, now, businessDate, sqlBusinessDate, shiftDateSql, sqlBusinessNow, businessStampUtc, businessDaySql, businessDateOf };
