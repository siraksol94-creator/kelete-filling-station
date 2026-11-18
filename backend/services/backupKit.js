/**
 * backupKit.js — S6: one place that takes, checks and restores SQLite backups.
 *
 * Used by the manual "Create Backup Now" button (routes/system.js), the till's
 * daily backup (services/electronBackup.js), the VPS nightly script
 * (vps/backup.sh → ops/backup/verify.js) and the restore tool
 * (ops/backup/restore.js).
 *
 * Why this exists
 *   • The manual-backup fallback used fs.copyFileSync on the main .db file.
 *     With WAL on, recent sales can still be sitting in the -wal file, so
 *     a plain copy can silently miss them. It also looked in the wrong places
 *     (no master.db; a "tenants" folder relative to the code).
 *   • Nothing checked that a backup could actually be opened, so a broken
 *     copy looked exactly like a good one until the day it was needed.
 *   • There was no restore procedure at all.
 *
 * What a backup is now
 *   1. SQLite's online backup API copies the database (a consistent snapshot
 *      including anything still in the -wal file, while the app keeps
 *      writing) to "<name>.partial".
 *   2. The copy is switched to a single self-contained file (no -wal/-shm).
 *   3. It is verified: PRAGMA integrity_check, foreign-key check (recorded,
 *      not fatal: live data may already contain orphans), row count of every
 *      table, schema version, size and SHA-256.
 *   4. Only a copy that passes is renamed to "<name>". A copy that fails is
 *      kept as "<name>.FAILED" for investigation and never replaces a good one.
 *   5. The results are written to manifest.json in the snapshot folder.
 *
 * Nothing here deletes or rewrites a live database except restoreDatabase(),
 * which only runs with confirm: true, refuses a backup that fails its checks,
 * refuses while the database is in use, and first keeps an exact copy of the
 * database being replaced.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MANIFEST = 'manifest.json';
const MANIFEST_FORMAT = 'kelete-backup-manifest/1';
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'latin1');
// One big step so a busy database can't keep restarting a page-by-page copy.
const PAGES_PER_STEP = 1000000;

function Database() { return require('better-sqlite3'); }

// ─── where the live databases are (mirrors config/database.js, masterDb.js, tenantDb.js) ──
function liveDatabasePaths(env = process.env) {
  const backendDir = path.join(__dirname, '..');
  const ud = env.ELECTRON_USER_DATA;
  const main = env.DB_PATH || (ud ? path.join(ud, 'kelete.db') : path.join(backendDir, 'kelete.db'));
  const master = env.MASTER_DB_PATH || (ud ? path.join(ud, 'master.db') : path.join(backendDir, '..', 'master.db'));
  const tenantsDir = env.TENANTS_DIR || (ud ? path.join(ud, 'tenants') : path.join(backendDir, '..', 'tenants'));
  return { main, master, tenantsDir };
}

// Every live database that exists right now, as { src, rel } — rel is where it
// goes inside a snapshot folder (same layout as vps/backup.sh).
function liveDatabases(env = process.env) {
  const { main, master, tenantsDir } = liveDatabasePaths(env);
  const out = [];
  if (fs.existsSync(main)) out.push({ src: main, rel: 'kelete.db' });
  if (fs.existsSync(master)) out.push({ src: master, rel: 'master.db' });
  if (fs.existsSync(tenantsDir)) {
    for (const f of fs.readdirSync(tenantsDir).sort()) {
      if (f.endsWith('.db') && fs.statSync(path.join(tenantsDir, f)).isFile()) {
        out.push({ src: path.join(tenantsDir, f), rel: `tenants/${f}` });
      }
    }
  }
  return out;
}

function defaultBackupRoot(env = process.env) {
  if (env.KELETE_BACKUP_DIR) return env.KELETE_BACKUP_DIR;
  // A till keeps its backups next to its data (as electronBackup.js always
  // has) — not in C:\var\backups\kelete.
  if (env.ELECTRON_USER_DATA) return path.join(env.ELECTRON_USER_DATA, 'Backups');
  return '/var/backups/kelete';
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/\.\d+Z$/, '').replace('T', '_').replace(/:/g, '');
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

function rmQuiet(p) { try { fs.rmSync(p, { force: true }); } catch (_) {} }
const quoteIdent = (n) => `"${String(n).replace(/"/g, '""')}"`;

// ─── verification ──────────────────────────────────────────────────────────
// Read-only. Never throws: problems come back as ok:false with a reason.
function verifyDatabase(file) {
  const result = { file, ok: false, checked_at: new Date().toISOString() };
  try {
    if (!fs.existsSync(file)) { result.error = 'file not found'; return result; }
    result.bytes = fs.statSync(file).size;
    const head = Buffer.alloc(16);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
    if (!head.equals(SQLITE_HEADER)) { result.error = 'not an SQLite database'; return result; }
    result.sha256 = sha256File(file);

    const D = Database();
    const db = new D(file, { readonly: true, fileMustExist: true });
    try {
      const ic = db.prepare('PRAGMA integrity_check').all().map(r => Object.values(r)[0]);
      result.integrity = ic.length === 1 && ic[0] === 'ok' ? 'ok' : ic.slice(0, 20);
      result.fk_violations = db.prepare('PRAGMA foreign_key_check').all().length;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
      result.tables = {};
      let total = 0;
      for (const t of tables) {
        const n = db.prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(t)}`).get().n;
        result.tables[t] = n; total += n;
      }
      result.table_count = tables.length;
      result.total_rows = total;
      if (tables.includes('schema_migrations')) {
        result.schema_version = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v || 0;
      }
    } finally { db.close(); }
    result.ok = result.integrity === 'ok';
    if (!result.ok) result.error = 'integrity_check failed';
  } catch (e) {
    result.ok = false;
    result.error = e.message;
  }
  return result;
}

// ─── taking one backup ─────────────────────────────────────────────────────
async function backupDatabase(src, dst) {
  const partial = `${dst}.partial`;
  const out = { source: src, file: dst, ok: false };
  try {
    if (!fs.existsSync(src)) { out.error = 'source not found'; return out; }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    for (const s of ['', '-journal', '-wal', '-shm']) rmQuiet(partial + s);

    const D = Database();
    const source = new D(src, { readonly: true, fileMustExist: true });
    try {
      await source.backup(partial, { progress: () => PAGES_PER_STEP });
    } finally { source.close(); }

    // Make the copy one self-contained file (no -wal/-shm needed to read it).
    const copy = new D(partial);
    try { copy.pragma('journal_mode = DELETE'); } finally { copy.close(); }
    for (const s of ['-wal', '-shm']) rmQuiet(partial + s);

    const v = verifyDatabase(partial);
    Object.assign(out, v, { file: dst, source: src });
    if (v.ok) {
      fs.renameSync(partial, dst);
      rmQuiet(`${dst}.FAILED`);
    } else {
      fs.renameSync(partial, `${dst}.FAILED`);
      out.kept_as = `${dst}.FAILED`;
    }
  } catch (e) {
    out.ok = false;
    out.error = e.message;
    for (const s of ['', '-journal', '-wal', '-shm']) rmQuiet(partial + s);
  }
  return out;
}

// ─── manifest ──────────────────────────────────────────────────────────────
function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8')); } catch (_) { return null; }
}

function writeManifest(dir, entries, meta = {}) {
  const prev = readManifest(dir);
  const files = { ...((prev && prev.files) || {}) };
  for (const [rel, r] of Object.entries(entries)) {
    files[rel] = {
      source: r.source || null, ok: !!r.ok, error: r.error || null, bytes: r.bytes ?? null,
      sha256: r.sha256 || null, integrity: r.integrity ?? null, fk_violations: r.fk_violations ?? null,
      schema_version: r.schema_version ?? null, table_count: r.table_count ?? null,
      total_rows: r.total_rows ?? null, tables: r.tables || null, checked_at: r.checked_at || null,
    };
  }
  const manifest = {
    format: MANIFEST_FORMAT,
    created_at: (prev && prev.created_at) || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    host: os.hostname(),
    ...meta,
    ok: Object.values(files).length > 0 && Object.values(files).every(f => f.ok),
    files,
  };
  const tmp = path.join(dir, `${MANIFEST}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
  fs.renameSync(tmp, path.join(dir, MANIFEST));
  return manifest;
}

// Back up a set of databases into one snapshot folder, verify each, write
// the manifest. Carries on past a failed file so the others are still saved.
async function backupSet(dbs, snapshotDir, meta = {}) {
  fs.mkdirSync(snapshotDir, { recursive: true });
  const results = {};
  for (const { src, rel } of dbs) {
    results[rel] = await backupDatabase(src, path.join(snapshotDir, ...rel.split('/')));
  }
  const manifest = writeManifest(snapshotDir, results, meta);
  return { dir: snapshotDir, ok: manifest.ok && dbs.length > 0, results, manifest };
}

// Check every .db already in a snapshot folder and (optionally) record it —
// used by vps/backup.sh, whose copies are made by the sqlite3 command line.
function verifySnapshotDir(dir, { write = false, meta = {} } = {}) {
  const found = [];
  const walk = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
      else if (e.isFile() && e.name.endsWith('.db')) found.push(`${prefix}${e.name}`);
    }
  };
  walk(dir, '');
  const results = {};
  for (const rel of found.sort()) results[rel] = verifyDatabase(path.join(dir, ...rel.split('/')));
  const manifest = write ? writeManifest(dir, results, meta) : null;
  return { dir, ok: found.length > 0 && Object.values(results).every(r => r.ok), results, manifest };
}

// The snapshot folder a backup file belongs to (it or its parent holds manifest.json).
function manifestEntryFor(file) {
  let dir = path.dirname(file);
  let rel = path.basename(file);
  for (let i = 0; i < 2; i++) {
    const m = readManifest(dir);
    if (m && m.files && m.files[rel]) return { dir, rel, entry: m.files[rel] };
    rel = `${path.basename(dir)}/${rel}`;
    dir = path.dirname(dir);
  }
  return null;
}

// ─── restore ───────────────────────────────────────────────────────────────
function restoreError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// Is anything else using this database? Takes (and releases) an exclusive lock.
// Note: closing our connection checkpoints a leftover -wal file into the main
// file (exactly what the app does when it shuts down) — no data is lost.
function assertNotInUse(file) {
  const D = Database();
  let db;
  try {
    db = new D(file, { fileMustExist: true });
    db.pragma('busy_timeout = 0');
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
  } catch (e) {
    if (/locked|busy/i.test(e.message)) {
      throw restoreError('TARGET_IN_USE', `${file} is in use. Stop the Kelete app/service using it, then run the restore again.`);
    }
    throw restoreError('TARGET_UNREADABLE', `${file} could not be opened (${e.message}).`);
  } finally {
    try { if (db) db.close(); } catch (_) {}
  }
}

function tableOverlap(a, b) {
  const A = new Set(Object.keys(a || {})); const B = new Set(Object.keys(b || {}));
  if (!A.size || !B.size) return 1;
  let both = 0; for (const t of A) if (B.has(t)) both++;
  return both / new Set([...A, ...B]).size;
}

/**
 * Put a backup back in place of a live database.
 *
 * Run this only in its own process (ops/backup/restore.js), NEVER inside the
 * Kelete app: on Linux, reading the live file with ordinary file calls from the
 * process that has it open releases that process's SQLite locks (a documented
 * SQLite corruption hazard), and the "is it in use?" check would be fooled.
 *   from        backup file to restore
 *   to          the live database file it replaces
 *   safetyRoot  where the copy of the current database is kept (default: <dir of to>/pre-restore)
 *   confirm     false (default) = dry run: check everything, change nothing
 *   allowUnreadableTarget   the current database can't even be opened (e.g. it is
 *               the corrupt one being replaced): still copy it aside and restore
 *   allowDifferentDatabase  the backup's tables barely match the current
 *               database's (wrong file?) — restore anyway
 * Returns a report; throws an Error with .code when it refuses.
 */
function restoreDatabase({ from, to, safetyRoot, confirm = false, allowUnreadableTarget = false, allowDifferentDatabase = false, now = new Date() }) {
  if (!from || !to) throw restoreError('USAGE', 'both the backup file and the database to replace are required');
  from = path.resolve(from); to = path.resolve(to);
  if (from === to) throw restoreError('USAGE', 'the backup and the target are the same file');
  const report = { from, to, dry_run: !confirm, steps: [] };

  // 1. The backup must be a finished, self-contained copy that passes its checks.
  if (/\.(partial|FAILED)$/.test(from)) throw restoreError('BACKUP_INCOMPLETE', 'that file is an unfinished or failed backup');
  if (fs.existsSync(`${from}-wal`) && fs.statSync(`${from}-wal`).size > 0) {
    throw restoreError('BACKUP_HAS_WAL', `${from} has a -wal file next to it: it looks like a live database, not a backup. Use a file from a backup folder.`);
  }
  const check = verifyDatabase(from);
  report.backup_check = check;
  if (!check.ok) throw restoreError('BACKUP_FAILED_CHECK', `the backup failed its check (${check.error}); it will not be restored`, { report });
  const recorded = manifestEntryFor(from);
  if (recorded) {
    report.manifest = { dir: recorded.dir, rel: recorded.rel, recorded_ok: recorded.entry.ok, recorded_sha256: recorded.entry.sha256 };
    if (!recorded.entry.ok) throw restoreError('BACKUP_FAILED_CHECK', 'the backup was recorded as FAILED when it was taken', { report });
    if (recorded.entry.sha256 && recorded.entry.sha256 !== check.sha256) {
      throw restoreError('BACKUP_CHANGED', 'the backup file no longer matches what was recorded when it was taken (changed or damaged since)', { report });
    }
  } else {
    report.steps.push('no manifest.json for this backup (taken before S6): relying on the integrity check');
  }

  const targetExists = fs.existsSync(to);
  let current = null;
  if (targetExists) {
    current = verifyDatabase(to);
    report.current_check = { ok: current.ok, error: current.error || null, total_rows: current.total_rows ?? null, schema_version: current.schema_version ?? null };
    if (current.tables && tableOverlap(current.tables, check.tables) < 0.5 && !allowDifferentDatabase) {
      throw restoreError('DIFFERENT_DATABASE', 'the backup does not look like the same database (its tables barely match). Check you picked the right file (e.g. a branch file vs master.db).', { report });
    }
  }

  if (!confirm) {
    report.steps.push('DRY RUN: nothing was changed. Run again with confirmation to restore.');
    report.steps.push(targetExists ? 'would check the database is not in use, keep an exact copy of it, then replace it' : 'target does not exist: would create it from the backup');
    return report;
  }

  // 2. Nothing may be using the database while it is swapped.
  if (targetExists) {
    try { assertNotInUse(to); } catch (e) {
      if (e.code === 'TARGET_UNREADABLE' && allowUnreadableTarget) report.steps.push(`current database could not be opened (${e.message}); continuing because that was allowed`);
      else throw e;
    }
  }

  // 3. Keep an exact copy of what is there now (main file + any sidecars).
  const safetyDir = path.join(safetyRoot ? path.resolve(safetyRoot) : path.join(path.dirname(to), 'pre-restore'), `${stamp(now)}-${path.basename(to)}`);
  if (targetExists) {
    fs.mkdirSync(safetyDir, { recursive: true });
    const kept = {};
    for (const s of ['', '-wal', '-shm', '-journal']) {
      const f = to + s;
      if (!fs.existsSync(f)) continue;
      const dst = path.join(safetyDir, path.basename(f));
      fs.copyFileSync(f, dst);
      const a = sha256File(f); const b = sha256File(dst);
      if (a !== b) throw restoreError('SAFETY_COPY_FAILED', `the copy of ${f} does not match the original; nothing was restored`);
      kept[path.basename(f)] = { bytes: fs.statSync(dst).size, sha256: b };
    }
    report.safety_copy = { dir: safetyDir, files: kept, integrity_of_current: current ? (current.ok ? 'ok' : current.error) : null };
    report.steps.push(`kept a copy of the current database in ${safetyDir}`);
  }

  // 4. Swap: write next to the target, check it, then rename into place.
  const incoming = `${to}.restoring`;
  rmQuiet(incoming);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, incoming);
  if (sha256File(incoming) !== check.sha256) { rmQuiet(incoming); throw restoreError('COPY_FAILED', 'copying the backup into place failed; nothing was restored'); }
  for (const s of ['-wal', '-shm', '-journal']) rmQuiet(to + s); // belonged to the old file (kept in the safety copy)
  fs.renameSync(incoming, to);

  // 5. Confirm the restored file.
  const after = verifyDatabase(to);
  report.restored_check = { ok: after.ok, sha256: after.sha256, total_rows: after.total_rows, schema_version: after.schema_version ?? null };
  if (!after.ok) throw restoreError('RESTORED_FAILED_CHECK', `the restored database failed its check; the previous one is in ${safetyDir}`, { report });
  report.steps.push('restored and verified');
  report.ok = true;

  if (targetExists) {
    fs.writeFileSync(path.join(safetyDir, 'restore-record.json'), JSON.stringify({ ...report, restored_at: now.toISOString(), host: os.hostname() }, null, 2));
  }
  return report;
}

module.exports = {
  MANIFEST, liveDatabasePaths, liveDatabases, defaultBackupRoot, stamp, sha256File,
  verifyDatabase, backupDatabase, backupSet, verifySnapshotDir, readManifest, writeManifest,
  manifestEntryFor, assertNotInUse, restoreDatabase,
};
