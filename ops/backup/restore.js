#!/usr/bin/env node
// S6 — restore one database from a backup, safely.
//
//   node ops/backup/restore.js --from <backup.db> --to <live.db> [--confirm]
//        [--safety-dir <dir>] [--allow-unreadable-target] [--allow-different-database]
//
// Without --confirm it is a DRY RUN: it checks the backup and the target and
// changes nothing. With --confirm it:
//   1. refuses a backup that fails integrity_check, was recorded as FAILED, or
//      no longer matches the SHA-256 recorded in its manifest.json;
//   2. refuses while anything has the live database open (stop the app first:
//      on the VPS the systemd/pm2 service; on a till, close Kelete);
//   3. keeps an exact copy of the current database (and any -wal/-shm) in
//      <dir of target>/pre-restore/<time>-<name>/ — these are never pruned;
//   4. copies the backup next to the target, checks it, renames it into place,
//      and checks the result; restore-record.json says what was done.
//
// Exit code: 0 = done (or dry run passed), 1 = refused/failed, 2 = usage.
const path = require('path');
const { createRequire } = require('module');
const Module = require('module');

const BACKEND = path.resolve(__dirname, '../../backend');
const breq = createRequire(path.join(BACKEND, 'package.json'));
const SQLITE = breq.resolve('better-sqlite3'); // resolved once, before the hook
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'better-sqlite3') return SQLITE;
  return origResolve.call(this, req, ...rest);
};
const kit = require(path.join(BACKEND, 'services/backupKit.js'));

const args = process.argv.slice(2);
const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const from = val('--from');
const to = val('--to');
if (!from || !to) {
  console.error('usage: node ops/backup/restore.js --from <backup.db> --to <live.db> [--confirm] [--safety-dir <dir>]');
  process.exit(2);
}

try {
  const report = kit.restoreDatabase({
    from, to, safetyRoot: val('--safety-dir'), confirm: args.includes('--confirm'),
    allowUnreadableTarget: args.includes('--allow-unreadable-target'),
    allowDifferentDatabase: args.includes('--allow-different-database'),
  });
  const c = report.backup_check;
  console.log(`Backup: ${report.from}`);
  console.log(`  integrity ok, ${c.table_count} tables, ${c.total_rows} rows${c.schema_version != null ? `, schema v${c.schema_version}` : ''}`);
  if (report.current_check) console.log(`Current: ${report.to} — ${report.current_check.ok ? 'integrity ok' : `FAILED CHECK (${report.current_check.error})`}, ${report.current_check.total_rows ?? '?'} rows`);
  for (const s of report.steps) console.log(`  • ${s}`);
  console.log(report.dry_run ? 'DRY RUN OK — add --confirm to restore.' : 'RESTORED.');
  process.exit(0);
} catch (e) {
  console.error(`REFUSED [${e.code || 'ERROR'}]: ${e.message}`);
  if (e.code === 'TARGET_IN_USE') console.error('Nothing was changed.');
  process.exit(1);
}
