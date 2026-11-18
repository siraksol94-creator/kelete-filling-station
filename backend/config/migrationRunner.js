// D1 — migration versioning.
//
// Before this, every database open re-ran ~3,000 lines of config/migrations.js:
// schema statements (idempotent) mixed with ~30 data-changing statements that
// ran on EVERY boot, with no record of what had been applied, and with errors
// swallowed so a half-migrated database looked healthy.
//
// This module adds two small tables and two ways to run a change:
//
//   schema_migrations — numbered, ordered migrations. Each runs ONCE, inside a
//                       transaction, and is recorded with a checksum. If one
//                       fails it is rolled back, the failure is recorded, and
//                       no LATER migration runs on that database until it is
//                       fixed — so databases cannot drift into an unknown
//                       in-between state. The server keeps running (a till
//                       must still be able to sell); the failure is visible
//                       in the log and at GET /api/system/schema-status.
//
//   data_task_log     — named one-off data tasks (runOnce). A task that
//                       succeeds is never run again on that database. A task
//                       that fails is rolled back and retried next boot.
//
// The legacy initTenantDb() remains the schema BASELINE: its CREATE/ALTER
// statements stay idempotent and keep converging databases whose state we
// cannot see. New changes go in config/versionedMigrations.js, not there.

const crypto = require('crypto');

let APP_VERSION = 'unknown';
try { APP_VERSION = require('../package.json').version || 'unknown'; } catch (_) {}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      INTEGER PRIMARY KEY,
      name         TEXT    NOT NULL,
      checksum     TEXT    NOT NULL,
      applied_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      duration_ms  INTEGER,
      app_version  TEXT
    );
    CREATE TABLE IF NOT EXISTS schema_migration_failures (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      version      INTEGER NOT NULL,
      name         TEXT    NOT NULL,
      error        TEXT,
      failed_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      app_version  TEXT
    );
    CREATE TABLE IF NOT EXISTS data_task_log (
      name           TEXT PRIMARY KEY,
      outcome        TEXT NOT NULL,          -- 'ok' | 'failed'
      rows_affected  INTEGER,
      first_run_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_run_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      attempts       INTEGER NOT NULL DEFAULT 1,
      error          TEXT,
      app_version    TEXT
    );
  `);
}

function checksumOf(migration) {
  return crypto.createHash('sha256').update(String(migration.up)).digest('hex').slice(0, 16);
}

function dbLabel(db) {
  try { return db.name || 'db'; } catch (_) { return 'db'; }
}

// Apply every migration whose version is not yet recorded, lowest first.
// Returns { applied: [...], failed: {version,name,error} | null, mismatched: [...] }.
function runVersioned(db, migrations) {
  ensureTables(db);
  const list = [...migrations].sort((a, b) => a.version - b.version);
  const seen = new Set();
  for (const m of list) {
    if (!Number.isInteger(m.version) || m.version <= 0) throw new Error(`Invalid migration version: ${m.version}`);
    if (seen.has(m.version)) throw new Error(`Duplicate migration version: ${m.version}`);
    seen.add(m.version);
  }

  const applied = new Map(
    db.prepare('SELECT version, checksum FROM schema_migrations').all().map(r => [r.version, r.checksum])
  );
  const result = { applied: [], failed: null, mismatched: [] };

  for (const m of list) {
    const sum = checksumOf(m);
    if (applied.has(m.version)) {
      // Editing a migration after it has run on some databases would make
      // them differ silently. Warn; never re-run.
      if (applied.get(m.version) !== sum) result.mismatched.push(m.version);
      continue;
    }
    const t0 = Date.now();
    try {
      db.transaction(() => {
        m.up(db);
        db.prepare(
          'INSERT INTO schema_migrations (version, name, checksum, duration_ms, app_version) VALUES (?,?,?,?,?)'
        ).run(m.version, m.name, sum, Date.now() - t0, APP_VERSION);
      })();
      result.applied.push(m.version);
      console.log(`[migrate] ${dbLabel(db)}: applied ${m.version} ${m.name} (${Date.now() - t0}ms)`);
    } catch (e) {
      try {
        db.prepare(
          'INSERT INTO schema_migration_failures (version, name, error, app_version) VALUES (?,?,?,?)'
        ).run(m.version, m.name, String(e && e.message || e).slice(0, 2000), APP_VERSION);
      } catch (_) { /* recording the failure must not mask it */ }
      console.error(`[migrate] ${dbLabel(db)}: FAILED ${m.version} ${m.name} — rolled back; later migrations NOT applied. ${e && e.message}`);
      result.failed = { version: m.version, name: m.name, error: String(e && e.message || e) };
      break; // never skip ahead past a failed migration
    }
  }
  if (result.mismatched.length) {
    console.warn(`[migrate] ${dbLabel(db)}: migration(s) ${result.mismatched.join(', ')} changed after being applied — not re-run.`);
  }
  return result;
}

// Run a named data task once per database. `fn(db)` may return the number of
// rows it changed. Success is recorded and the task never runs again here;
// failure is rolled back, recorded, and retried on the next boot.
function runOnce(db, name, fn) {
  ensureTables(db);
  const prior = db.prepare('SELECT outcome FROM data_task_log WHERE name = ?').get(name);
  if (prior && prior.outcome === 'ok') return { skipped: true };
  try {
    let rows = null;
    db.transaction(() => {
      const r = fn(db);
      rows = Number.isFinite(r) ? r : null;
      db.prepare(`
        INSERT INTO data_task_log (name, outcome, rows_affected, app_version)
        VALUES (?, 'ok', ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          outcome = 'ok', rows_affected = excluded.rows_affected, error = NULL,
          last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          attempts = data_task_log.attempts + 1, app_version = excluded.app_version
      `).run(name, rows, APP_VERSION);
    })();
    if (rows) console.log(`[data-task] ${dbLabel(db)}: ${name} changed ${rows} row(s) (one-time)`);
    return { ran: true, rows };
  } catch (e) {
    try {
      db.prepare(`
        INSERT INTO data_task_log (name, outcome, error, app_version)
        VALUES (?, 'failed', ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          outcome = 'failed', error = excluded.error,
          last_run_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          attempts = data_task_log.attempts + 1, app_version = excluded.app_version
      `).run(name, String(e && e.message || e).slice(0, 2000), APP_VERSION);
    } catch (_) {}
    console.warn(`[data-task] ${dbLabel(db)}: ${name} failed and was rolled back (will retry next boot): ${e && e.message}`);
    return { ran: false, error: String(e && e.message || e) };
  }
}

function getStatus(db, migrations) {
  ensureTables(db);
  const applied = db.prepare('SELECT version, name, checksum, applied_at, duration_ms, app_version FROM schema_migrations ORDER BY version').all();
  const appliedSet = new Set(applied.map(r => r.version));
  const pending = [...migrations].sort((a, b) => a.version - b.version)
    .filter(m => !appliedSet.has(m.version)).map(m => ({ version: m.version, name: m.name }));
  const mismatched = applied
    .filter(r => { const m = migrations.find(x => x.version === r.version); return m && checksumOf(m) !== r.checksum; })
    .map(r => r.version);
  return {
    current_version: applied.length ? applied[applied.length - 1].version : 0,
    latest_version: migrations.reduce((mx, m) => Math.max(mx, m.version), 0),
    applied,
    pending,
    mismatched,
    recent_failures: db.prepare('SELECT version, name, error, failed_at, app_version FROM schema_migration_failures ORDER BY id DESC LIMIT 20').all(),
    data_tasks: db.prepare('SELECT name, outcome, rows_affected, first_run_at, last_run_at, attempts, error FROM data_task_log ORDER BY name').all(),
  };
}

module.exports = { ensureTables, runVersioned, runOnce, getStatus, checksumOf };
