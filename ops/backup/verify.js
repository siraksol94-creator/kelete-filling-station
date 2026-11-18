#!/usr/bin/env node
// S6 — check backup files and (with --write-manifest) record the result in the
// snapshot folder's manifest.json. Read-only apart from that manifest.
//
//   node ops/backup/verify.js <snapshot-folder | file.db> [--write-manifest] [--method <name>]
//
// Exit code: 0 = every database passed, 1 = at least one failed, 2 = usage.
// vps/backup.sh calls this after each nightly run.
const path = require('path');
const fs = require('fs');
const { createRequire } = require('module');

const BACKEND = path.resolve(__dirname, '../../backend');
// better-sqlite3 comes from backend/node_modules (as for ops/p0).
const breq = createRequire(path.join(BACKEND, 'package.json'));
const Module = require('module');
const SQLITE = breq.resolve('better-sqlite3'); // resolved once, before the hook
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'better-sqlite3') return SQLITE;
  return origResolve.call(this, req, ...rest);
};
const kit = require(path.join(BACKEND, 'services/backupKit.js'));

const args = process.argv.slice(2);
const write = args.includes('--write-manifest');
const mIdx = args.indexOf('--method');
const method = mIdx >= 0 ? args[mIdx + 1] : 'verify';
const target = args.find((a, i) => !a.startsWith('--') && !(mIdx >= 0 && i === mIdx + 1));
if (!target || !fs.existsSync(target)) {
  console.error('usage: node ops/backup/verify.js <snapshot-folder | file.db> [--write-manifest] [--method <name>]');
  process.exit(2);
}

let results;
let ok;
if (fs.statSync(target).isDirectory()) {
  const r = kit.verifySnapshotDir(path.resolve(target), { write, meta: { method } });
  results = r.results; ok = r.ok;
} else {
  const r = kit.verifyDatabase(path.resolve(target));
  results = { [path.basename(target)]: r }; ok = r.ok;
}
for (const [rel, r] of Object.entries(results)) {
  console.log(r.ok
    ? `  ✓ ${rel}  integrity ok, ${r.table_count} tables, ${r.total_rows} rows, ${r.bytes} bytes, sha256 ${r.sha256.slice(0, 12)}…`
    : `  ✖ ${rel}  FAILED: ${r.error}${Array.isArray(r.integrity) ? ` — ${r.integrity.slice(0, 3).join('; ')}` : ''}`);
}
if (!Object.keys(results).length) console.log('  ✖ no .db files found');
console.log(ok ? 'ALL BACKUPS VERIFIED' : 'BACKUP VERIFICATION FAILED');
process.exit(ok ? 0 : 1);
