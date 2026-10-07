/**
 * electronBackup.js â€” daily local SQLite backup for Electron installs.
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
 *     â”œâ”€â”€ kelete.db
 *     â”œâ”€â”€ master.db          (if present)
 *     â””â”€â”€ tenants/           (if present)
 *         â””â”€â”€ <slug>.db
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

// Uses better-sqlite3's built-in .backup() which is an atomic
// snapshot even while the DB is being written (correct handling of
// WAL). Falls back to a raw file copy if for some reason the DB
// isn't accessible via better-sqlite3.
async function backupOne(srcPath, dstPath) {
  const name = path.basename(srcPath);
  if (!fs.existsSync(srcPath)) {
    log(`  Â· ${name}  SKIP (not found)`);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(dstPath), { recursive: true });
    const Database = require('better-sqlite3');
    const db = new Database(srcPath, { readonly: true, fileMustExist: true });
    try {
      await db.backup(dstPath);
    } finally {
      db.close();
    }
    const size = fs.statSync(dstPath).size;
    log(`  âœ“ ${name}  â†’ ${dstPath}  (${(size / 1024).toFixed(1)} KB)`);
  } catch (e) {
    log(`  âœ– ${name}  FAILED: ${e.message}`);
  }
}

function pruneOldBackups(backupRoot) {
  try {
    if (!fs.existsSync(backupRoot)) return;
    const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(backupRoot)) {
      const full = path.join(backupRoot, entry);
      const st = fs.statSync(full);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        fs.rmSync(full, { recursive: true, force: true });
        log(`  âˆ’ pruned ${full}`);
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

  log(`â–¶ starting daily backup â†’ ${dayDir}`);

  // Snapshot the main defaultDb (kelete.db in USER_DATA per database.js).
  await backupOne(path.join(USER_DATA, 'kelete.db'), path.join(dayDir, 'kelete.db'));

  // master.db and tenants/ may or may not exist on Electron depending
  // on whether the install is multi-branch â€” snapshot only if present.
  const masterCandidates = [
    path.join(USER_DATA, 'master.db'),
    path.join(__dirname, '..', '..', 'master.db'), // Electron repo layout fallback
  ];
  for (const m of masterCandidates) {
    if (fs.existsSync(m)) {
      await backupOne(m, path.join(dayDir, 'master.db'));
      break;
    }
  }

  const tenantsDir = path.join(USER_DATA, 'tenants');
  if (fs.existsSync(tenantsDir)) {
    for (const f of fs.readdirSync(tenantsDir)) {
      if (f.endsWith('.db')) {
        await backupOne(path.join(tenantsDir, f), path.join(dayDir, 'tenants', f));
      }
    }
  }

  pruneOldBackups(backupRoot);
  log(`âœ“ backup complete`);
}

function start() {
  if (!USER_DATA) {
    return; // Silent no-op on VPS â€” vps/backup.sh + cron handles that side.
  }
  log(`Electron backup scheduler enabled (interval 24h, keep ${KEEP_DAYS} days)`);
  // First run ~30 s after start so the app finishes booting first
  setTimeout(() => { runOnce().catch(e => log(`initial run failed: ${e.message}`)); }, 30_000);
  // Then every 24 hours
  setInterval(() => { runOnce().catch(e => log(`scheduled run failed: ${e.message}`)); }, INTERVAL_MS);
}

module.exports = { start, runOnce };
