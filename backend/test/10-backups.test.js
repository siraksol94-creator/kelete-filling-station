// S6 — backups and restore.
// Every database here is a throwaway file in this test's temporary folder.
// Checks that backups taken while sales are being written are complete and
// consistent, that every copy is verified and recorded, and that the restore
// tool refuses bad backups, refuses while the database is in use, and keeps
// a copy of what it replaces.
const { setupEnv, makeTempDir } = require('./helpers/harness');
const { dir: TEST_DIR } = setupEnv();
process.env.KELETE_BACKUP_SCRIPT = require('path').join(TEST_DIR, 'no-such-backup-script.sh');

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel } = require('./helpers/fixtures');
const { productStock } = require('./helpers/invariants');
const kit = require('../services/backupKit');

const REPO = path.resolve(__dirname, '../..');
let app, db, staff, pid, pSync;
const T = () => staff.tokens.owner;

function openRO(file) { return new Database(file, { readonly: true, fileMustExist: true }); }
function count(file, sql) { const d = openRO(file); try { return d.prepare(sql).get().n; } finally { d.close(); } }

async function sale() {
  const r = await app.request('POST', '/api/orders', { token: staff.tokens.cashier, body: {
    customer_name: 'Walk-in', payment_method: 'Cash',
    items: [{ product_id: pid, product_sync_id: pSync, product_name: 'Oil', quantity: 1, unit: 'pcs', unit_price: 150, total_price: 150 }],
    subtotal: 150, tax_amount: 0, total_amount: 150, discount: 0, amount_received: 150, change_amount: 0,
    cash_received: 150, momo_received: 0, bank_received: 0 } });
  if (r.status >= 300) throw new Error(`sale failed: ${r.status} ${r.text}`);
  return r.body;
}

// The things a torn (half-copied) backup would get wrong.
function consistencyProblems(file) {
  const d = openRO(file);
  try {
    const out = [];
    const orphanOrders = d.prepare(`SELECT COUNT(*) AS n FROM orders o WHERE NOT EXISTS
      (SELECT 1 FROM order_items i WHERE i.order_sync_id = o.sync_id OR i.order_id = o.id)`).get().n;
    if (orphanOrders) out.push(`${orphanOrders} order(s) without their lines`);
    out.push(...productStock(d));
    if (d.prepare("SELECT 1 FROM sqlite_master WHERE name = 's6_writer'").get()) {
      const torn = d.prepare('SELECT batch, COUNT(*) AS n FROM s6_writer GROUP BY batch HAVING n != 5').all();
      if (torn.length) out.push(`${torn.length} half-written batch(es) from the second process`);
    }
    return out;
  } finally { d.close(); }
}

before(async () => {
  app = await startApp(); db = app.db; staff = await seedStaff(app);
  const fuel = await seedFuel(app, T());
  await app.request('POST', '/api/attendant-shifts/open', { token: T(),
    body: { attendant_user_id: staff.users.cashier.id, nozzle_ids: [fuel.n2.id], shift_type: 'DAY' } });
  pSync = randomUUID();
  db.prepare("INSERT INTO products (code, name, unit, cost_price, selling_price, current_stock, sync_id, tenant_id, units_json) VALUES ('OIL1','Oil','pcs',100,150,0,?,'local-only',?)")
    .run(pSync, JSON.stringify([{ name: 'pcs', conv: 1, price: 150, is_base: true }]));
  pid = db.prepare('SELECT id FROM products WHERE sync_id = ?').get(pSync).id;
  db.prepare("INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, sync_id, tenant_id) VALUES (?,?,'sales','opening',1000,?,'local-only')").run(pid, pSync, randomUUID());
  db.prepare('UPDATE products SET current_stock = 1000 WHERE id = ?').run(pid);
  // A branch database too, so "every live database" includes tenants/.
  fs.mkdirSync(process.env.TENANTS_DIR, { recursive: true });
  const b = new Database(path.join(process.env.TENANTS_DIR, 'branch1.db'));
  b.exec("CREATE TABLE orders (id INTEGER PRIMARY KEY, total REAL); INSERT INTO orders (total) VALUES (10), (20)");
  b.close();
});
after(async () => { await app.close(); });

describe('S6 — why the old fallback had to go', () => {
  test('a plain file copy misses sales still in the -wal file; the online backup has them', async () => {
    db.pragma('wal_checkpoint(TRUNCATE)');
    for (let i = 0; i < 3; i++) await sale();             // now only in kelete.db-wal
    const live = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    const dir = makeTempDir('s6-why');
    // What the old fallback did. Done in a child process: a plain open/close of
    // the live file inside the app's own process silently drops the app's
    // SQLite locks on Linux (a documented SQLite hazard — another reason the
    // old in-app copyFileSync had to go).
    const cp = spawnSync(process.execPath, ['-e', 'require("fs").copyFileSync(process.argv[1], process.argv[2])', process.env.DB_PATH, path.join(dir, 'plain-copy.db')]);
    assert.equal(cp.status, 0);
    assert.equal(count(path.join(dir, 'plain-copy.db'), 'SELECT COUNT(*) AS n FROM orders'), live - 3, 'the plain copy lost the last 3 sales');
    const r = await kit.backupDatabase(process.env.DB_PATH, path.join(dir, 'online.db'));
    assert.equal(r.ok, true);
    assert.equal(count(path.join(dir, 'online.db'), 'SELECT COUNT(*) AS n FROM orders'), live);
  });

  test('the backup code looks where the app actually keeps its databases', () => {
    assert.equal(path.resolve(kit.liveDatabasePaths().main), path.resolve(db.defaultDb.name));
    assert.equal(path.resolve(kit.liveDatabasePaths().tenantsDir), path.resolve(require('../config/tenantDb').TENANTS_DIR));
    assert.equal(kit.defaultBackupRoot({ ELECTRON_USER_DATA: path.join('C:', 'AppData', 'Kelete') }), path.join('C:', 'AppData', 'Kelete', 'Backups'));
    assert.equal(kit.defaultBackupRoot({}), '/var/backups/kelete');
  });
});

describe('S6 — Create Backup Now', () => {
  let res;
  before(async () => { res = await app.request('POST', '/api/system/backup', { token: T() }); });

  test('backs up every live database with the online backup and verifies each one', () => {
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.method, 'inline');
    const names = res.body.files.map(f => f.file).sort();
    assert.ok(names.includes('kelete.db') && names.includes('tenants/branch1.db'), names.join(','));
    if (fs.existsSync(process.env.MASTER_DB_PATH)) assert.ok(names.includes('master.db'));
    assert.ok(res.body.files.every(f => f.ok));
    assert.equal(res.body.files_copied, names.length);
    assert.match(path.basename(res.body.dest), /^\d{4}-\d{2}-\d{2}_\d{6}-manual(-\d+)?$/);
  });

  test('manifest.json records integrity, row counts and a SHA-256 that match the files', () => {
    const m = kit.readManifest(res.body.dest);
    assert.equal(m.ok, true);
    const k = m.files['kelete.db'];
    assert.equal(k.integrity, 'ok');
    const file = path.join(res.body.dest, 'kelete.db');
    assert.equal(k.sha256, kit.sha256File(file));
    assert.equal(k.tables.orders, count(file, 'SELECT COUNT(*) AS n FROM orders'));
    assert.equal(m.files['tenants/branch1.db'].tables.orders, 2);
    assert.ok(k.schema_version >= 4);
    for (const f of ['kelete.db-wal', 'kelete.db-shm', 'kelete.db.partial']) assert.equal(fs.existsSync(path.join(res.body.dest, f)), false, `${f} left behind`);
  });

  test('the Backups list shows the verification result', async () => {
    const list = (await app.request('GET', '/api/system/backups', { token: T() })).body;
    const row = list.backups.find(b => b.name === path.basename(res.body.dest));
    assert.equal(row.verified, true);
    assert.deepEqual(row.failed_files, []);
  });

  test('a database that cannot be copied cleanly fails the request (500) — the others are still saved', async () => {
    const bad = path.join(process.env.TENANTS_DIR, 'broken.db');
    fs.writeFileSync(bad, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 0x41)]));
    try {
      const r = await app.request('POST', '/api/system/backup', { token: T() });
      assert.equal(r.status, 500);
      assert.match(r.body.error, /tenants\/broken\.db/);
      assert.equal(r.body.files.find(f => f.file === 'kelete.db').ok, true);
      assert.ok(fs.existsSync(path.join(r.body.dest, 'kelete.db')));
      assert.equal(fs.existsSync(path.join(r.body.dest, 'tenants', 'broken.db')), false, 'a failed copy is never stored under the real name');
      const list = (await app.request('GET', '/api/system/backups', { token: T() })).body;
      const row = list.backups.find(b => b.name === path.basename(r.body.dest));
      assert.equal(row.verified, false);
      assert.deepEqual(row.failed_files, ['tenants/broken.db']);
    } finally { fs.rmSync(bad, { force: true }); }
  });
});

describe('S6 — backups taken while sales are being written', () => {
  test('every copy is complete and consistent: no half-written sale, stock matches movements', async () => {
    db.exec('CREATE TABLE IF NOT EXISTS s6_writer (id INTEGER PRIMARY KEY, batch INTEGER, line INTEGER)');
    // A second process writing 5-row transactions the whole time (like a second till/LAN client).
    const writerJs = path.join(makeTempDir('s6-writer'), 'writer.js');
    fs.writeFileSync(writerJs, `
      const Database = require('module').createRequire(${JSON.stringify(path.join(__dirname, '..', 'package.json'))})('better-sqlite3');
      const d = new Database(process.argv[2], { timeout: 5000 });
      const ins = d.prepare('INSERT INTO s6_writer (batch, line) VALUES (?, ?)');
      const tx = d.transaction((b) => { for (let l = 0; l < 5; l++) ins.run(b, l); });
      let b = 0; const end = Date.now() + Number(process.argv[3]);
      (function loop() { if (Date.now() > end) { d.close(); console.log(b); return; } tx(++b); setTimeout(loop, 2); })();`);
    const writer = spawn(process.execPath, [writerJs, process.env.DB_PATH, '2500'], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
    let batches = ''; writer.stdout.on('data', d => { batches += d; });
    const done = new Promise((r) => writer.on('close', r));

    const dir = makeTempDir('s6-concurrent');
    const copies = [];
    const salesBefore = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    let made = 0;
    for (let round = 0; round < 5; round++) {
      // Sales and a backup at the same moment.
      const sales = Array.from({ length: 6 }, () => sale().then(() => { made++; }));
      const file = path.join(dir, `round${round}.db`);
      const backup = kit.backupDatabase(process.env.DB_PATH, file);
      const [r] = await Promise.all([backup, ...sales]);
      assert.equal(r.ok, true, r.error);
      copies.push(file);
    }
    const http = await app.request('POST', '/api/system/backup', { token: T() }); // and the button, mid-traffic
    assert.equal(http.status, 200, http.text);
    copies.push(path.join(http.body.dest, 'kelete.db'));
    assert.equal(await done, 0, 'writer process finished cleanly');
    assert.ok(Number(batches) > 0);
    assert.equal(made, 30);

    let lastOrders = 0;
    for (const f of copies) {
      assert.equal(kit.verifyDatabase(f).integrity, 'ok', f);
      assert.deepEqual(consistencyProblems(f), [], f);
      const n = count(f, 'SELECT COUNT(*) AS n FROM orders');
      assert.ok(n >= lastOrders && n >= salesBefore, 'each later backup has at least as many sales');
      lastOrders = n;
    }
    assert.deepEqual(consistencyProblems(process.env.DB_PATH), [], 'live database is consistent too');
  });
});

describe('S6 — restore', () => {
  let dir, good, goodRows, target;
  before(async () => {
    dir = makeTempDir('s6-restore');
    const snap = await kit.backupSet([{ src: process.env.DB_PATH, rel: 'kelete.db' }], path.join(dir, 'snap'), { method: 'test' });
    assert.equal(snap.ok, true);
    good = path.join(dir, 'snap', 'kelete.db');
    goodRows = count(good, 'SELECT COUNT(*) AS n FROM orders');
  });
  // An offline database (nothing has it open) standing in for a stopped app's file, with more sales than the backup.
  async function freshTarget(name) {
    for (let i = 0; i < 2; i++) await sale();
    const t = path.join(dir, 'live', name);
    const r = await kit.backupDatabase(process.env.DB_PATH, t);
    assert.equal(r.ok, true);
    return t;
  }

  test('a dry run checks everything and changes nothing', async () => {
    target = await freshTarget('dry.db');
    const before = kit.sha256File(target);
    const r = kit.restoreDatabase({ from: good, to: target });
    assert.equal(r.dry_run, true);
    assert.equal(kit.sha256File(target), before);
    assert.equal(fs.existsSync(path.join(dir, 'live', 'pre-restore')), false);
  });

  test('restoring keeps an exact copy of the current database first, then puts the backup in place', async () => {
    target = await freshTarget('kelete.db');
    const currentSha = kit.sha256File(target);
    const currentRows = count(target, 'SELECT COUNT(*) AS n FROM orders');
    assert.ok(currentRows > goodRows);
    const r = kit.restoreDatabase({ from: good, to: target, confirm: true });
    assert.equal(r.ok, true);
    assert.equal(kit.sha256File(target), kit.sha256File(good));
    assert.equal(count(target, 'SELECT COUNT(*) AS n FROM orders'), goodRows);
    // The replaced database is preserved byte for byte, and the restore is recorded.
    const kept = path.join(r.safety_copy.dir, 'kelete.db');
    assert.equal(kit.sha256File(kept), currentSha);
    assert.equal(count(kept, 'SELECT COUNT(*) AS n FROM orders'), currentRows);
    const record = JSON.parse(fs.readFileSync(path.join(r.safety_copy.dir, 'restore-record.json'), 'utf8'));
    assert.equal(record.from, good);
    assert.equal(fs.existsSync(`${target}.restoring`), false);
  });

  test('refused: a damaged backup (fails integrity_check)', async () => {
    target = await freshTarget('damaged-target.db');
    const before = kit.sha256File(target);
    const bad = path.join(dir, 'damaged.db');
    fs.copyFileSync(good, bad);
    const fd = fs.openSync(bad, 'r+');
    const size = fs.statSync(bad).size;
    // Overwrite a stretch of pages in the middle with garbage.
    fs.writeSync(fd, Buffer.alloc(Math.min(65536, Math.floor(size / 3)), 0xA5), 0, undefined, Math.floor(size / 3));
    fs.closeSync(fd);
    assert.equal(kit.verifyDatabase(bad).ok, false);
    assert.throws(() => kit.restoreDatabase({ from: bad, to: target, confirm: true }), (e) => e.code === 'BACKUP_FAILED_CHECK');
    assert.equal(kit.sha256File(target), before);
  });

  test('refused: a backup changed since it was taken (no longer matches its manifest)', async () => {
    target = await freshTarget('changed-target.db');
    const snap2 = path.join(dir, 'snap2');
    await kit.backupSet([{ src: process.env.DB_PATH, rel: 'kelete.db' }], snap2);
    const d = new Database(path.join(snap2, 'kelete.db'));
    d.prepare("UPDATE orders SET total_amount = 1 WHERE id = (SELECT MIN(id) FROM orders)").run();
    d.close();
    assert.throws(() => kit.restoreDatabase({ from: path.join(snap2, 'kelete.db'), to: target, confirm: true }), (e) => e.code === 'BACKUP_CHANGED');
  });

  test('refused: unfinished or failed copies, a live database with a -wal file, the wrong database', async () => {
    target = await freshTarget('misc-target.db');
    fs.copyFileSync(good, path.join(dir, 'x.db.FAILED'));
    assert.throws(() => kit.restoreDatabase({ from: path.join(dir, 'x.db.FAILED'), to: target, confirm: true }), (e) => e.code === 'BACKUP_INCOMPLETE');
    assert.throws(() => kit.restoreDatabase({ from: process.env.DB_PATH, to: target, confirm: true }), (e) => e.code === 'BACKUP_HAS_WAL');
    const branchBackup = path.join(dir, 'branch-snap', 'branch1.db');
    assert.equal((await kit.backupDatabase(path.join(process.env.TENANTS_DIR, 'branch1.db'), branchBackup)).ok, true);
    assert.throws(() => kit.restoreDatabase({ from: branchBackup, to: target, confirm: true }), (e) => e.code === 'DIFFERENT_DATABASE');
  });

  test('a backup whose copy failed its check never replaces an earlier good copy', async () => {
    const snap = path.join(dir, 'samefolder');
    const good1 = await kit.backupDatabase(path.join(process.env.TENANTS_DIR, 'branch1.db'), path.join(snap, 'b.db'));
    assert.equal(good1.ok, true);
    const brokenSrc = path.join(dir, 'broken-src.db');
    fs.writeFileSync(brokenSrc, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(8192, 0x41)]));
    const r = await kit.backupDatabase(brokenSrc, path.join(snap, 'b.db'));
    assert.equal(r.ok, false);
    assert.equal(kit.sha256File(path.join(snap, 'b.db')), good1.sha256, 'the good copy is still there');
    assert.equal(fs.existsSync(path.join(snap, 'b.db.partial')), false);
  });

  test('the restore command line: dry run, refused while the app has the database open, then --confirm', async () => {
    target = await freshTarget('cli-target.db');
    const run = (...a) => spawnSync(process.execPath, [path.join(REPO, 'ops/backup/restore.js'), ...a], { env: process.env, encoding: 'utf8' });
    let r = run('--from', good, '--to', target);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN OK/);
    // The app (this process) has the live database open: refused, nothing touched.
    const liveOrders = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    r = run('--from', good, '--to', process.env.DB_PATH, '--confirm');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /TARGET_IN_USE/);
    assert.equal(fs.existsSync(path.join(path.dirname(process.env.DB_PATH), 'pre-restore')), false, 'no copy made');
    assert.equal(fs.existsSync(`${process.env.DB_PATH}.restoring`), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, liveOrders, 'live data untouched');
    assert.ok(liveOrders > goodRows);
    r = run('--from', good, '--to', target, '--confirm');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RESTORED/);
    assert.equal(kit.sha256File(target), kit.sha256File(good));
  });
});

describe('S6 — VPS nightly script (vps/backup.sh) and the till daily backup', () => {
  // A stand-in `sqlite3` command (only the three commands backup.sh uses), so
  // the real script runs here exactly as cron would run it.
  function fakeSqlite3(binDir) {
    fs.mkdirSync(binDir, { recursive: true });
    const js = path.join(binDir, 'sqlite3.js');
    fs.writeFileSync(js, `
      const Database = require('module').createRequire(${JSON.stringify(path.join(__dirname, '..', 'package.json'))})('better-sqlite3');
      const args = process.argv.slice(2).filter(a => a !== '-readonly');
      const [file, sql] = args;
      (async () => {
        const m = /^\\.backup '(.*)'$/.exec(sql);
        const d = new Database(file);
        try {
          if (m) { await d.backup(m[1]); return; }
          for (const row of d.prepare(sql.replace(/;\\s*$/, '')).all()) console.log(Object.values(row)[0]);
        } finally { d.close(); }
      })().catch(e => { console.error('Error: ' + e.message); process.exit(1); });`);
    fs.writeFileSync(path.join(binDir, 'sqlite3'), `#!/usr/bin/env bash\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
  }
  function appDir() {
    const d = makeTempDir('s6-vps');
    fs.mkdirSync(path.join(d, 'backend')); fs.mkdirSync(path.join(d, 'tenants'));
    for (const [rel, rows] of [['backend/kelete.db', 3], ['master.db', 1], ['tenants/a.db', 2]]) {
      const x = new Database(path.join(d, rel));
      x.pragma('journal_mode = WAL');
      x.exec('CREATE TABLE t (v)'); for (let i = 0; i < rows; i++) x.prepare('INSERT INTO t VALUES (?)').run(i);
      x.close();
    }
    return d;
  }
  const runScript = (APP_DIR, BACKUP_ROOT, bin) => spawnSync('bash', [path.join(REPO, 'vps/backup.sh')], {
    env: { ...process.env, APP_DIR, BACKUP_ROOT, PATH: `${bin}:${process.env.PATH}`, KELETE_VERIFY_SCRIPT: path.join(REPO, 'ops/backup/verify.js') },
    encoding: 'utf8' });

  test('verifies every copy, writes manifest.json, exits 0', () => {
    const d = appDir(); const root = makeTempDir('s6-vps-out'); const bin = path.join(d, 'bin'); fakeSqlite3(bin);
    const r = runScript(d, root, bin);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const day = path.join(root, fs.readdirSync(root)[0]);
    const m = kit.readManifest(day);
    assert.equal(m.ok, true);
    assert.deepEqual(Object.keys(m.files).sort(), ['kelete.db', 'master.db', 'tenants/a.db']);
    assert.equal(m.files['kelete.db'].tables.t, 3);
    assert.equal(m.method, 'vps-nightly');
    assert.equal(fs.existsSync(path.join(day, 'kelete.db-wal')), false);
  });

  test('a database that fails is reported: exit 1, kept as .FAILED or not stored, the others still saved', () => {
    const d = appDir(); const root = makeTempDir('s6-vps-out'); const bin = path.join(d, 'bin'); fakeSqlite3(bin);
    fs.writeFileSync(path.join(d, 'tenants', 'bad.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(8192, 0x41)]));
    const r = runScript(d, root, bin);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /FAILURE/);
    const day = path.join(root, fs.readdirSync(root)[0]);
    assert.equal(fs.existsSync(path.join(day, 'tenants', 'bad.db')), false);
    assert.ok(fs.existsSync(path.join(day, 'kelete.db')) && fs.existsSync(path.join(day, 'tenants', 'a.db')));
  });

  test('till daily backup: verified copies + manifest; rotation never touches pre-restore copies', () => {
    const ud = makeTempDir('s6-till');
    const x = new Database(path.join(ud, 'kelete.db')); x.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY); INSERT INTO orders DEFAULT VALUES'); x.close();
    const old = path.join(ud, 'Backups', '2020-01-01'); fs.mkdirSync(old, { recursive: true });
    const keep = path.join(ud, 'Backups', 'pre-restore'); fs.mkdirSync(keep, { recursive: true });
    const past = new Date('2020-01-02'); fs.utimesSync(old, past, past); fs.utimesSync(keep, past, past);
    const env = { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH || '', ELECTRON_USER_DATA: ud };
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '../services/electronBackup.js'))}).runOnce().then(r => process.exit(r.ok ? 0 : 1))`], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const day = path.join(ud, 'Backups', new Date().toISOString().slice(0, 10));
    assert.equal(kit.readManifest(day).files['kelete.db'].tables.orders, 1);
    assert.equal(fs.existsSync(old), false, 'old dated backup rotated out');
    assert.equal(fs.existsSync(keep), true, 'pre-restore copies are kept');
  });
});
