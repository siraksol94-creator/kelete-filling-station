// D5 — the P0 inspection tool (ops/p0/inspect.js) is read-only and reports correctly.
const { setupEnv, makeTempDir } = require('./helpers/harness');
setupEnv();

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const { initTenantDb } = require('../config/migrations');

const TOOL = path.resolve(__dirname, '../../ops/p0/inspect.js');
const dir = makeTempDir('kelete-p0test');
const p = (n) => path.join(dir, n);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
let legacyFile, currentFile, masterFile, liveLooking, report, report2c, outDir2c;

before(() => {
  // A "till" built by the ORIGINAL code, with planted problems.
  legacyFile = p('till-legacy.db');
  const a = new Database(legacyFile);
  a.exec(fs.readFileSync(path.join(__dirname, 'fixtures/legacy-baseline-schema.sql'), 'utf8'));
  a.prepare("INSERT INTO users (first_name,last_name,email,password,role,status) VALUES ('S','K','sirak',?, 'Administrator','Active')").run(bcrypt.hashSync('123', 10));
  a.prepare("INSERT INTO users (first_name,last_name,email,password,role,status) VALUES ('O','W','owner',?, 'Administrator','Active')").run(bcrypt.hashSync('Strong-Pass-9', 10));
  a.prepare("INSERT INTO users (first_name,last_name,email,password,role,status) VALUES ('G','N','gone',?, 'Cashier','Inactive')").run(bcrypt.hashSync('x', 10));
  a.prepare("INSERT INTO fuel_grades (code,name) VALUES ('ULP','Petrol')").run();
  a.prepare("INSERT INTO tanks (code,name,fuel_grade_id,capacity_litres,current_volume) VALUES ('T1','Tank 1',1,20000,5000)").run();
  a.prepare("INSERT INTO tank_movements (tank_id,type,litres) VALUES (1,'opening',4950)").run(); // 50 L drift
  a.prepare("INSERT INTO fleet_customers (name,company,credit_limit,current_balance) VALUES ('Hauliers','Hauliers Ltd',50000,12500)").run();
  a.prepare("INSERT INTO customers (name) VALUES ('Hauliers Ltd')").run();
  a.prepare("INSERT INTO orders (order_number,total_amount,created_at) VALUES ('FUEL-0000001',100,datetime('now'))").run();
  a.close();

  // A current-schema database (e.g. the VPS branch) sharing a FUEL- number.
  currentFile = p('vps-branch.db');
  const b = new Database(currentFile);
  initTenantDb(b);
  b.prepare("INSERT INTO orders (order_number,total_amount) VALUES ('FUEL-0000001',100)").run();
  // Go-live: the VPS also holds its own grade ULP (the till has a separate one).
  b.prepare("INSERT INTO fuel_grades (code,name) VALUES ('ULP','Petrol (VPS)')").run();
  b.prepare("INSERT INTO fuel_grades (code,name) VALUES ('LPG','Gas')").run();     // only here: no clash
  b.close();

  // master.db snapshot (VACUUM INTO = a consistent copy, like .backup).
  masterFile = p('master.db');
  require('../config/masterDb').masterDb.exec(`VACUUM INTO '${masterFile}'`);

  // A file that looks live: non-empty -wal beside it.
  liveLooking = p('live.db');
  fs.copyFileSync(currentFile, liveLooking);
  fs.writeFileSync(liveLooking + '-wal', 'not empty');

  const hashes = [legacyFile, currentFile, masterFile].map(sha);
  const run = (extra, out) => execFileSync(process.execPath, [TOOL, ...extra, '--out', out, legacyFile, currentFile, masterFile, liveLooking], { encoding: 'utf8', env: process.env });
  run([], p('out-2b'));
  outDir2c = p('out-2c');
  run(['--include-2c'], outDir2c);
  report = JSON.parse(fs.readFileSync(path.join(p('out-2b'), 'report.json'), 'utf8'));
  report2c = JSON.parse(fs.readFileSync(path.join(outDir2c, 'report.json'), 'utf8'));
  assert.deepEqual([legacyFile, currentFile, masterFile].map(sha), hashes, 'originals byte-for-byte unchanged');
});

const entry = (rep, f) => rep.databases[path.relative(process.cwd(), f)];

test('originals are never modified and are marked as verified', () => {
  for (const f of [legacyFile, currentFile, masterFile]) assert.equal(entry(report, f).original_unchanged, true);
});

test('a database with a live-looking -wal file is refused, not opened', () => {
  assert.match(entry(report, liveLooking).error, /refused/);
});

test('2b: kinds, integrity and versioning are detected', () => {
  assert.equal(entry(report, legacyFile).kind, 'tenant');
  assert.equal(entry(report, masterFile).kind, 'master');
  assert.equal(entry(report, legacyFile).phase_2b.integrity, 'ok');
  assert.match(String(entry(report, legacyFile).phase_2b.schema_version), /pre-D1/);
  assert.ok(Number(entry(report, currentFile).phase_2b.schema_version) >= 2);
});

test('2b: schema differences against the code are listed', () => {
  const s = entry(report, legacyFile).schema_vs_code;
  assert.ok(s.missing_tables.includes('audit_log'), 'legacy DB lacks the D2 table');
  assert.equal(entry(report, currentFile).schema_vs_code.missing_tables.length, 0);
});

test('2b: the shift-approval defect and invariant counts are reported', () => {
  const b = entry(report, legacyFile).phase_2b;
  assert.equal(b.shift_approval.shift_id_required, true);
  assert.equal(b.invariant_counts.tanks_cache_not_equal_ledger, 1);
});

test('2b: the same FUEL- number in two databases is flagged', () => {
  assert.equal(report.cross_database.fuel_order_numbers_used_in_more_than_one_database.count, 1);
});

test('2b contains no usernames and no password material', () => {
  const s = JSON.stringify(report);
  assert.ok(!s.includes('sirak') && !s.includes('$2') && !s.includes('$stub$'));
});

test('2c: default password detected as yes/no only — never the hash', () => {
  const c = entry(report2c, legacyFile).phase_2c;
  const sirak = c.known_accounts.find(a => a.username === 'sirak');
  assert.equal(sirak.uses_a_default_password, true);
  assert.ok(!/\$2[aby]\$|\$stub\$/.test(JSON.stringify(report2c)), 'no hashes in the 2c report');
  assert.deepEqual(c.inactive_users.map(u => u.username), ['gone']);
});

test('2c: tank drift is reported per tank', () => {
  assert.deepEqual(entry(report2c, legacyFile).phase_2c.tank_drift.map(t => [t.tank, t.difference]), [['T1', 50]]);
});

test('2c: fleet balances go to a separate file with possible customer matches', () => {
  const csv = fs.readFileSync(path.join(outDir2c, 'phase2c-fleet-balances.csv'), 'utf8');
  assert.match(csv, /Hauliers.*12500.*Hauliers Ltd/);
  assert.ok(!fs.existsSync(path.join(p('out-2b'), 'phase2c-fleet-balances.csv')), 'not produced without --include-2c');
});

test('the tool leaves no temporary copies behind', () => {
  const left = fs.readdirSync(require('os').tmpdir()).filter(n => n.startsWith('kelete-p0-'));
  assert.deepEqual(left, []);
});

// ─── go-live checks ──────────────────────────────────────────────────────
test('go-live: the upgrade is rehearsed on a scratch copy — original schema up to the current version', () => {
  const versions = require('../config/versionedMigrations').map(m => m.version);
  const u = entry(report, legacyFile).upgrade_rehearsal;
  assert.equal(u.version_before, 0);
  assert.equal(u.version_after, Math.max(...versions));
  assert.deepEqual(u.applied, versions.sort((x, y) => x - y));
  assert.equal(u.failed, null);
  assert.equal(u.integrity_after, 'ok');
  assert.equal(entry(report, legacyFile).phase_2b.schema_version, 'not versioned (pre-D1)', 'the inspected copy itself was not upgraded');
  const v = entry(report, currentFile).upgrade_rehearsal;
  assert.deepEqual(v.applied, [], 'an up-to-date database needs nothing');
  assert.equal(entry(report, masterFile).upgrade_rehearsal, undefined);
});

test('go-live: fleet merge review counts (2b) and names (2c, separate file)', () => {
  const f = entry(report, legacyFile).upgrade_rehearsal.fleet_merge_review;
  assert.equal(f.to_merge, 1);
  assert.equal(f.balance_to_carry, 12500);
  const g = entry(report, legacyFile).phase_2b.go_live;
  assert.equal(g.fleet_accounts, 1);
  assert.deepEqual(g.fleet_accounts_with_balance, { n: 1, total: 12500 });
  assert.ok(!JSON.stringify(report).includes('Hauliers'), 'no names in 2b');
  assert.ok(!fs.existsSync(path.join(p('out-2b'), 'phase2c-fleet-merge-review.csv')));
  const csv = fs.readFileSync(path.join(outDir2c, 'phase2c-fleet-merge-review.csv'), 'utf8');
  assert.match(csv, /"Hauliers".*"12500"/);
});

test('go-live: a fuel code held separately on the VPS and a till is flagged; the code itself only in 2c', () => {
  const c = report.cross_database.fuel_codes_held_separately_in_more_than_one_database;
  assert.equal(c.count, 1);
  assert.deepEqual(c.by_table, { fuel_grades: 1 });
  assert.equal(c.codes, undefined);
  assert.deepEqual(report2c.cross_database.fuel_codes_held_separately_in_more_than_one_database.codes.map(x => [x.table, x.code]), [['fuel_grades', 'ULP']]);
  assert.match(fs.readFileSync(path.join(p('out-2b'), 'summary.md'), 'utf8'), /Fuel codes held as separate records in more than one database: \*\*1\*\*/);
});

test('go-live: the summary shows the rehearsal verdict for each branch/till database', () => {
  const md = fs.readFileSync(path.join(p('out-2b'), 'summary.md'), 'utf8');
  assert.match(md, /Upgrade rehearsal on a scratch copy: ok — version 0 → \d+/);
  assert.match(md, /Fleet merge review \(after upgrade\): 1 to merge/);
});
