/**
 * appPasscode.js
 *
 * 2026-09-18 — the code HQ's phones are asked for on first use.
 *
 * Every depot has a licence key in master.db, so the phone app can ask the
 * server "does this key open this branch?" (GET /api/sync/verify-license).
 * HQ has no licence of its own — its tenant is 'local-only', which is exactly
 * why /api/sync/license-status waves it through — so there is no key to check.
 * Instead an HQ Administrator sets a passcode in System Settings and hands it
 * to whoever is allowed to open HQ on a phone.
 *
 * Kept in sync_config on HQ's own book as a SHA-256 hash: the code itself is
 * never stored and never sent back to any caller.
 *
 * defaultDb, not the request-scoped db proxy, on purpose. An HQ user who has
 * a depot selected in the branch picker sends X-Branch with every call, and
 * the proxy would then hand back THAT depot's database — the passcode would
 * be written into the depot's book while the phone app, which sends no such
 * header, kept reading HQ's. Pinning it to HQ's own book closes that.
 */
const { defaultDb: db } = require('../config/database');
const { createHash, timingSafeEqual } = require('crypto');

const KEY = 'hq_app_passcode';

const hash = (code) => createHash('sha256').update(String(code)).digest('hex');

function getHash() {
  try {
    return db.prepare('SELECT value FROM sync_config WHERE key = ?').get(KEY)?.value || null;
  } catch (_) {
    return null;                       // no sync_config table on this book
  }
}

function isSet() {
  return !!getHash();
}

// Blank clears it, which puts HQ back to opening without a passcode.
function setCode(code) {
  const v = String(code || '').trim();
  if (!v) {
    db.prepare('DELETE FROM sync_config WHERE key = ?').run(KEY);
    return false;
  }
  db.prepare('INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, ?)').run(KEY, hash(v));
  return true;
}

// No passcode set = nobody is locked out: HQ opens on a phone the way it
// always has until an Administrator sets one.
function verify(code) {
  const stored = getHash();
  if (!stored) return { ok: true, notSet: true };
  const given = hash(String(code || '').trim());
  let same = false;
  try {
    same = timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(stored, 'hex'));
  } catch (_) {
    same = false;                      // a stored value that isn't a hash
  }
  return { ok: same };
}

module.exports = { isSet, setCode, verify };
