// S2 (security remediation) — failed-attempt throttle for password checks.
//
// No new dependency: an in-memory counter per key. It resets when the process
// restarts, which is acceptable for slowing down password guessing; it is not
// an audit record (that is D2).
//
// Keys are chosen by the caller, NOT by IP address: neither server sets
// `trust proxy`, so behind nginx every web request arrives from 127.0.0.1 and
// an IP key would either lock out every user at once or throttle nobody.
//   login        → tenant + lower-cased username  (per-account lockout)
//   verify-admin → tenant + the logged-in caller's user id
//
// Trade-off, accepted deliberately: someone who knows a username can lock that
// account out for LOCK_MS by failing on purpose. That is far less harmful than
// unlimited guessing, and it clears by itself.

const MAX_FAILURES = 10;               // failures allowed inside the window
const WINDOW_MS    = 15 * 60 * 1000;   // counting window
const LOCK_MS      = 15 * 60 * 1000;   // lockout once the limit is reached

const entries = new Map(); // key -> { count, firstAt, lockedUntil }

function now() { return Date.now(); }

// Milliseconds until the key may try again; 0 when not locked.
function lockedFor(key) {
  const e = entries.get(key);
  if (!e) return 0;
  const t = now();
  if (e.lockedUntil && e.lockedUntil > t) return e.lockedUntil - t;
  if (e.lockedUntil && e.lockedUntil <= t) { entries.delete(key); return 0; }
  if (t - e.firstAt > WINDOW_MS) { entries.delete(key); return 0; }
  return 0;
}

function recordFailure(key) {
  const t = now();
  let e = entries.get(key);
  if (!e || t - e.firstAt > WINDOW_MS) e = { count: 0, firstAt: t, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= MAX_FAILURES) e.lockedUntil = t + LOCK_MS;
  entries.set(key, e);
}

function clear(key) { entries.delete(key); }

// Housekeeping so the map cannot grow without bound.
setInterval(() => {
  const t = now();
  for (const [k, e] of entries) {
    if ((e.lockedUntil && e.lockedUntil <= t) || (!e.lockedUntil && t - e.firstAt > WINDOW_MS)) {
      entries.delete(k);
    }
  }
}, 5 * 60 * 1000).unref();

function lockedMessage(ms) {
  const mins = Math.max(1, Math.ceil(ms / 60000));
  return `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
}

module.exports = { lockedFor, recordFailure, clear, lockedMessage, MAX_FAILURES, WINDOW_MS, LOCK_MS };
