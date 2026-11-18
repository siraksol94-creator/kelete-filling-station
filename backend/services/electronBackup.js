/**
 * electronBackup.js — daily local SQLite backup for Electron installs.
 *
 * Runs INSIDE the Electron backend process (no cron / Task Scheduler
 * needed). Backs up the defaultDb + master.db + any tenants/*.db files
 * from the Electron user-data folder to a dated backup directory next
 * to them. Rotates keeping last KEEP_DAYS (default 14) days.
 *
 * Trigger:
 *   - Once ~30 s after backend start (so first-run installs get an
 *     initial baseline)
 *   - Then every 24 h while the backend keeps running
 *
 * Why in-process (not a separate cron/scheduler): Electron's backend
 * is already always-running while the app is open. A single
 * setInterval covers the whole use case without asking the user to
 * configure Windows Task Scheduler.
 *
 * VPS side: handled by vps/backup.sh + cron. This module is a no-op
 * when ELECTRON_USER_DATA is not set (i.e., on VPS).
 *
 * Location:
 *   %APPDATA%/Kelete/Backups/YYYY-MM-DD/
 *     ├── kelete.db
 *     ├── master.db          (if present)
 *     └── tenants/           (if present)
 *         └── <slug>.db
 */
const fs = require('fs');
const path = require('path');

const KEEP_DAYS = parseInt(process.env.KELETE_BACKUP_KEEP_DAYS || '14', 10);
const INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// The Electron user-data root. When set (only in Electron), this is
// where the running DBs live and where we'll drop the Backups/ folder.
const USER_DATA = process.env.ELECTRON_USER_DATA;

function log(msg) {
  console.log(`[electronBackup] ${msg}`);
}

// S6: each copy is taken with SQLite's online backup API, checked
// (integrity_check + row counts) and recorded in the day's manifest.json by
// backupKit. A copy that fails its check is kept as <name>.FAILED and never
// replaces an earlier good copy from the same day.
const backupKit = require('./backupKit');

function pruneOldBackups(backupRoot) {
  try {
    if (!fs.existsSync(backupRoot)) return;
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(backupRoot)) {
      // S6: only dated backup folders rotate. pre-restore/ (the copies kept
      // before a restore) and anything else in here are never deleted.
      if (!/^\d{4}-\d{2}-\d{2}(_\d{6}-manual(-\d+)?)?$/.test(entry)) continue;
      const full = path.join(backupRoot, entry);
      const st = fs.statSync(full);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        log(`  − pruned ${full}`);
      }
    }
  } catch (e) {
    log(`  prune failed: ${e.message}`);
  }
}

async function runOnce() {
  if (!USER_DATA) return; // No-op on VPS
  const dayStamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const backupRoot = path.join(USER_DATA, 'Backups');
  const dayDir = path.join(backupRoot, dayStamp);

  log(`▶ starting daily backup → ${dayDir}`);

  // kelete.db, master.db (if this install has one) and tenants/*.db.
  const dbs = backupKit.liveDatabases();
  // Older installs may still have master.db in the install folder.
  if (!dbs.some(d => d.rel === 'master.db')) {
    const legacy = path.join(__dirname, '..', '..', 'master.db');
    if (fs.existsSync(legacy)) dbs.push({ src: legacy, rel: 'master.db' });
  }
  const r = await backupKit.backupSet(dbs, dayDir, { method: 'electron-daily' });
  for (const [rel, x] of Object.entries(r.results)) {
    if (x.ok) log(`  ✓ ${rel}  (${(x.bytes / 1024).toFixed(1)} KB, ${x.total_rows} rows, integrity ok)`);
    else log(`  ✖ ${rel}  FAILED: ${x.error}${x.kept_as ? ` (kept as ${x.kept_as})` : ''}`);
  }

  pruneOldBackups(backupRoot);
  log(r.ok ? '✓ backup complete — every copy verified' : '✖ backup finished WITH FAILURES — see manifest.json');
  return r;
}

function start() {
  if (!USER_DATA) {
    return; // Silent no-op on VPS — vps/backup.sh + cron handles that side.
  }
  log(`Electron backup scheduler enabled (interval 24h, keep ${KEEP_DAYS} days)`);
  // First run ~30 s after start so the app finishes booting first
  setTimeout(() => { runOnce().catch(e => log(`initial run failed: ${e.message}`)); }, 30_000);
  // Then every 24 hours
  setInterval(() => { runOnce().catch(e => log(`scheduled run failed: ${e.message}`)); }, INTERVAL_MS);
}

module.exports = { start, runOnce };
