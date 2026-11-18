// D5 Suite 2 — D1 migration versioning, one-time data tasks, upgrades.
const { setupEnv, makeTempDir } = require('./helpers/harness');
setupEnv();

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { initTenantDb } = require('../config/migrations');
const { runVersioned, runOnce } = require('../config/migrationRunner');
const MIGRATIONS = require('../config/versionedMigrations');

const tmp = makeTempDir('kelete-mig');
let n = 0;
const newDb = () => new Database(path.join(tmp, `db${++n}.db`));
const changes = (db) => db.prepare('SELECT total_changes() AS n').get().n;
const LEGACY_SCHEMA = fs.readFileSync(path.join(__dirname, 'fixtures/legacy-baseline-schema.sql'), 'utf8');
const legacyDb = () => { const db = newDb(); db.exec(LEGACY_SCHEMA); return db; };

describe('fresh database', () => {
  test('first start applies every versioned migration', () => {
    const db = newDb();
    const r = initTenantDb(db);
    assert.equal(r.failed, null);
    assert.deepEqual(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(x => x.version), MIGRATIONS.map(m => m.version));
  });
  test('second start changes ZERO rows (nothing re-runs on every boot)', () => {
    const db = newDb();
    initTenantDb(db);
    const before = changes(db);
    const r = initTenantDb(db);
    assert.deepEqual(r.applied, []);
    assert.equal(changes(db) - before, 0);
  });
  test('every one-time data task is recorded as done', () => {
    const db = newDb();
    initTenantDb(db);
    const bad = db.prepare("SELECT name, outcome, error FROM data_task_log WHERE outcome != 'ok'").all();
    assert.deepEqual(bad, []);
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM data_task_log').get().n >= 9);
  });
});

describe('upgrade from a database built by the ORIGINAL code', () => {
  const build = () => {
    const db = legacyDb();
    db.prepare("INSERT INTO products (name, selling_price, cost_price, current_stock, avg_cost_price, units_json, sync_id, tenant_id, updated_at) VALUES ('Good', 10, 7, 3, 9, '[]', 'p-good', 't1', '2026-01-01 00:00:00')").run();
    db.prepare("INSERT INTO products (name, selling_price, cost_price, current_stock, avg_cost_price, units_json, sync_id, tenant_id, updated_at) VALUES ('Drifted', 10, 7, 99, 9, '[]', 'p-drift', 't1', '2026-01-01 00:00:00')").run();
    db.prepare("INSERT INTO stock_movements (product_sync_id, location, movement_type, quantity, sync_id) VALUES ('p-good','sales','opening',3,'m1')").run();
    db.prepare("INSERT INTO stock_movements (product_sync_id, location, movement_type, quantity, sync_id) VALUES ('p-drift','sales','opening',4,'m2')").run();
    db.prepare("INSERT INTO stock_movements (product_sync_id, location, movement_type, quantity, sync_id, deleted_at) VALUES ('p-good','sales','reconciliation',0,'m3', datetime('now'))").run();
    db.prepare("INSERT INTO stock_reconciliation_items (reconciliation_id, product_id, product_sync_id, cost_at_count, sync_id) VALUES (1, 1, 'p-good', 5.55, 'ri-1')").run();
    db.prepare("INSERT INTO grn (grn_number, date) VALUES ('GRN-1', '2026-01-01')").run();
    db.prepare("INSERT INTO grn_items (grn_id, product_sync_id, quantity, unit_price, total_price, sync_id) VALUES (1, 'p-good', 1, 9, 9, 'gi-1')").run();
    return db;
  };
  test('migrations apply and no business rows are lost', () => {
    const db = build();
    const count = () => db.prepare('SELECT (SELECT COUNT(*) FROM products)+(SELECT COUNT(*) FROM stock_movements)+(SELECT COUNT(*) FROM grn_items)+(SELECT COUNT(*) FROM stock_reconciliation_items) AS n').get().n;
    const before = count();
    const r = initTenantDb(db);
    assert.equal(r.failed, null);
    assert.equal(count(), before);
  });
  test('products whose stock is already correct are NOT re-stamped (prices/timestamps untouched)', () => {
    const db = build(); initTenantDb(db);
    assert.equal(db.prepare("SELECT updated_at FROM products WHERE sync_id='p-good'").get().updated_at, '2026-01-01 00:00:00');
  });
  test('a product with drifted stock is repaired from its movements', () => {
    const db = build(); initTenantDb(db);
    assert.equal(db.prepare("SELECT current_stock FROM products WHERE sync_id='p-drift'").get().current_stock, 4);
  });
  test('soft-deleted reconciliation movements are kept (hard-delete job retired)', () => {
    const db = build(); initTenantDb(db);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stock_movements WHERE sync_id='m3'").get().n, 1);
  });
  test('historical reconciliation costs no longer change on restart', () => {
    const db = build(); initTenantDb(db);
    const cost = db.prepare("SELECT cost_at_count FROM stock_reconciliation_items WHERE sync_id='ri-1'").get().cost_at_count;
    db.prepare("UPDATE grn_items SET total_price = 900 WHERE sync_id='gi-1'").run();
    const before = changes(db);
    initTenantDb(db);
    assert.equal(db.prepare("SELECT cost_at_count FROM stock_reconciliation_items WHERE sync_id='ri-1'").get().cost_at_count, cost);
    assert.equal(changes(db) - before, 0);
  });
});

describe('cash_reports UNIQUE(date) → UNIQUE(date, cashier_id) rebuild', () => {
  const uniqueSets = (db) => db.prepare("PRAGMA index_list('cash_reports')").all().filter(i => i.unique)
    .map(i => db.prepare(`PRAGMA index_info('${i.name}')`).all().map(c => c.name).join(','));
  const legacyCashReports = () => {
    const db = newDb(); initTenantDb(db);
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='cash_reports'").get().sql;
    db.exec('ALTER TABLE cash_reports RENAME TO cr_old; DROP INDEX IF EXISTS idx_cash_reports_date_cashier;');
    db.exec(ddl.replace(/date\s+TEXT NOT NULL/, 'date TEXT NOT NULL UNIQUE'));
    db.exec('DROP TABLE cr_old; ALTER TABLE cash_reports ADD COLUMN later_added TEXT; CREATE INDEX idx_cr_status ON cash_reports(status);');
    db.prepare("INSERT INTO users (first_name,last_name,email,password) VALUES ('O','W','o','x')").run();
    db.prepare("INSERT INTO cash_reports (date, cash, bank, k_received, usd_received, later_added, created_by, sync_id) VALUES ('2026-11-01', 100, 250, 555, 7, 'keep-me', 1, 'cr-1')").run();
    db.prepare("INSERT INTO cash_reports (date, cash, sync_id) VALUES ('2026-11-02', 50, 'cr-2')").run();
    return db;
  };
  test('keeps every column (including multi-currency and later-added ones) and every row', () => {
    const db = legacyCashReports();
    assert.ok(uniqueSets(db).includes('date'));
    initTenantDb(db);
    const r = db.prepare("SELECT * FROM cash_reports WHERE sync_id='cr-1'").get();
    assert.equal(r.bank, 250); assert.equal(r.k_received, 555); assert.equal(r.usd_received, 7); assert.equal(r.later_added, 'keep-me');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cash_reports').get().n, 2);
  });
  test('switches the uniqueness rule, keeps indexes, foreign keys and AUTOINCREMENT', () => {
    const db = legacyCashReports(); initTenantDb(db);
    assert.ok(!uniqueSets(db).includes('date'));
    assert.ok(uniqueSets(db).includes('date,cashier_id'));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_cr_status'").get());
    assert.deepEqual(db.prepare("PRAGMA foreign_key_list('cash_reports')").all().map(f => f.table), ['users']);
    db.prepare("INSERT INTO cash_reports (date, cash, cashier_id) VALUES ('2026-11-01', 1, 2)").run(); // second cashier, same date
    const id = db.prepare("INSERT INTO cash_reports (date, cash) VALUES ('2026-11-09', 1)").run().lastInsertRowid;
    assert.ok(id > 3);
    assert.ok(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='cash_reports_migrated'").get());
  });
});

describe('migration runner behaviour', () => {
  test('a failing migration is rolled back, recorded, and blocks later migrations', () => {
    const db = newDb(); initTenantDb(db);
    const r = runVersioned(db, [...MIGRATIONS,
      { version: 900, name: 'will_fail', up(x) { x.exec('CREATE TABLE half_done (id INTEGER)'); throw new Error('boom'); } },
      { version: 901, name: 'after_fail', up(x) { x.exec('CREATE TABLE should_not_exist (id INTEGER)'); } }]);
    assert.equal(r.failed.version, 900);
    assert.ok(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='half_done'").get());
    assert.ok(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='should_not_exist'").get());
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migration_failures WHERE version=900').get().n, 1);
  });
  test('a migration edited after it ran is reported and not re-run', () => {
    const db = newDb(); initTenantDb(db);
    const edited = MIGRATIONS.map(m => (m.version === 2 ? { ...m, up() { throw new Error('must not run'); } } : m));
    const r = runVersioned(db, edited);
    assert.ok(r.mismatched.includes(2));
    assert.equal(r.failed, null);
  });
  test('duplicate or invalid version numbers are rejected', () => {
    const db = newDb();
    assert.throws(() => runVersioned(db, [{ version: 1, name: 'a', up() {} }, { version: 1, name: 'b', up() {} }]), /Duplicate/);
    assert.throws(() => runVersioned(db, [{ version: 0, name: 'a', up() {} }]), /Invalid/);
  });
  test('runOnce: retried after a failure, never repeated after success', () => {
    const db = newDb(); initTenantDb(db);
    let calls = 0;
    runOnce(db, 'test-task', () => { calls++; throw new Error('first try fails'); });
    runOnce(db, 'test-task', () => { calls++; return 7; });
    runOnce(db, 'test-task', () => { calls++; return 7; });
    const t = db.prepare("SELECT outcome, rows_affected, attempts FROM data_task_log WHERE name='test-task'").get();
    assert.equal(calls, 2); assert.equal(t.outcome, 'ok'); assert.equal(t.rows_affected, 7); assert.equal(t.attempts, 2);
  });
  test('the versioned list is well-formed (sequential, named, never renumbered)', () => {
    MIGRATIONS.forEach((m, i) => { assert.equal(m.version, i + 1); assert.ok(m.name); assert.equal(typeof m.up, 'function'); });
  });
});

describe('live schema fixtures (fixtures/live-schemas/*.sql)', () => {
  const dir = path.join(__dirname, 'fixtures/live-schemas');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.sql')) : [];
  if (!files.length) test('no live schema files supplied yet (Phase 2a)', { skip: 'add schema-only .sql files to enable' }, () => {});
  for (const f of files) {
    test(`upgrades cleanly: ${f}`, () => {
      const db = newDb();
      db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
      const r = initTenantDb(db);
      assert.equal(r.failed, null, r.failed && r.failed.error);
      const before = changes(db);
      initTenantDb(db);
      assert.equal(changes(db) - before, 0, 'second start must change nothing');
    });
  }
});
