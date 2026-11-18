#!/usr/bin/env node
// ops/p0/inspect.js — READ-ONLY inspection of Kelete SQLite snapshots
// (P0 / Phase 2b and, only when explicitly asked, Phase 2c).
//
//   node ops/p0/inspect.js [--include-2c] [--out <dir>] <snapshot.db> [<snapshot.db> ...]
//
// SAFETY — what this tool does and does not do:
//   • It never opens a file you pass it with a database connection. Each one
//     is COPIED into a private temporary folder first and only the copy is
//     opened, with PRAGMA query_only = ON (any write fails).
//   • It hashes every original before and after; if a hash changed, it stops
//     and says so (it cannot happen, but the check proves it).
//   • It refuses a file that has a non-empty "-wal" file beside it: that is a
//     live database, or a copy taken without SQLite's .backup. Use the P0
//     snapshot procedure instead.
//   • It makes no network connections and needs no configuration or secrets.
//   • Phase 2b output contains only counts, dates, flags and schema. Phase 2c
//     (--include-2c, needs approval) adds a small number of usernames, tank
//     codes and — in a SEPARATE file — fleet customer names and balances.
//     It never outputs password hashes, secrets, URLs or tokens.
//
// Run from the repository root after `cd backend && npm ci` (it uses the
// backend's own SQLite driver and builds the schema the code expects).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

const BACKEND = path.resolve(__dirname, '../../backend');
const breq = createRequire(path.join(BACKEND, 'package.json'));

// ─── arguments ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const include2c = args.includes('--include-2c');
const allowWal = args.includes('--allow-wal-sidecar');
const outIdx = args.indexOf('--out');
const outDir = outIdx >= 0 ? path.resolve(args[outIdx + 1]) : path.resolve(`p0-report-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
const files = args.filter((a, i) => !a.startsWith('--') && !(outIdx >= 0 && i === outIdx + 1)).map(f => path.resolve(f));
if (!files.length) {
  console.error('usage: node ops/p0/inspect.js [--include-2c] [--out <dir>] <snapshot.db> [...]');
  process.exit(2);
}

// ─── private scratch space (removed on exit) ──────────────────────────────
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kelete-p0-'));
fs.chmodSync(scratch, 0o700);
const cleanup = () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) {} };
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130));

// The backend opens its default/master databases when its modules load;
// point those at the scratch folder so nothing else on disk is touched.
Object.assign(process.env, {
  DB_PATH: path.join(scratch, 'expected-default.db'),
  MASTER_DB_PATH: path.join(scratch, 'expected-master.db'),
  TENANTS_DIR: path.join(scratch, 'expected-tenants'),
  UPLOADS_DIR: path.join(scratch, 'uploads'),
  KELETE_NO_AUTOSTART: '1',
});
delete process.env.ELECTRON_USER_DATA;

const Database = breq('better-sqlite3');
const quietly = (fn) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return fn(); } finally { console.log = l; console.warn = w; } };
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ─── expected schemas, built by the code itself on throwaway files ────────
const expected = quietly(() => {
  const { initTenantDb } = breq('./config/migrations');
  const tdb = new Database(path.join(scratch, 'expected-tenant.db'));
  initTenantDb(tdb);
  const mdb = breq('./config/masterDb').masterDb;
  return { tenant: schemaOf(tdb), master: mdb ? schemaOf(mdb) : null };
});

function schemaOf(db) {
  const tables = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    tables[name] = Object.fromEntries(db.prepare(`PRAGMA table_info("${name}")`).all()
      .map(c => [c.name, { type: (c.type || '').toUpperCase(), notnull: c.notnull, dflt: c.dflt_value, pk: c.pk }]));
  }
  const indexes = db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(r => r.name);
  return { tables, indexes, triggers };
}

function diffSchema(actual, exp) {
  const out = { missing_tables: [], extra_tables: [], missing_columns: [], extra_columns: [], different_columns: [], missing_indexes: [] };
  for (const t of Object.keys(exp.tables)) if (!actual.tables[t]) out.missing_tables.push(t);
  for (const t of Object.keys(actual.tables)) if (!exp.tables[t]) out.extra_tables.push(t);
  for (const t of Object.keys(exp.tables)) {
    if (!actual.tables[t]) continue;
    for (const [c, e] of Object.entries(exp.tables[t])) {
      const a = actual.tables[t][c];
      if (!a) { out.missing_columns.push(`${t}.${c}`); continue; }
      const d = [];
      if (a.type !== e.type) d.push(`type ${a.type || '(none)'}≠${e.type || '(none)'}`);
      if (a.notnull !== e.notnull) d.push(`notnull ${a.notnull}≠${e.notnull}`);
      if (String(a.dflt) !== String(e.dflt)) d.push(`default ${a.dflt}≠${e.dflt}`);
      if (d.length) out.different_columns.push(`${t}.${c}: ${d.join(', ')}`);
    }
    for (const c of Object.keys(actual.tables[t])) if (!exp.tables[t][c]) out.extra_columns.push(`${t}.${c}`);
  }
  const have = new Set(actual.indexes.map(i => i.name));
  for (const i of exp.indexes) if (!have.has(i.name) && actual.tables[i.tbl_name]) out.missing_indexes.push(i.name);
  return out;
}

// ─── helpers on an opened (copied, query-only) database ───────────────────
const has = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const cols = (db, t) => has(db, t) ? db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name) : [];
const one = (db, sql, ...p) => { try { return db.prepare(sql).get(...p); } catch (e) { return { error: e.message }; } };
const all = (db, sql, ...p) => { try { return db.prepare(sql).all(...p); } catch (e) { return [{ error: e.message }]; } };

const FUEL_TABLES = ['fuel_grades', 'tanks', 'tank_movements', 'tank_dips', 'pumps', 'nozzles', 'attendant_shifts',
  'shift_nozzle_readings', 'shift_credit_sales', 'shift_dips', 'fuel_shift_approvals', 'fuel_day_approvals',
  'fuel_deliveries', 'fleet_customers', 'fleet_vehicles', 'fuel_sales'];
const DATED = [['orders', 'created_at'], ['attendant_shifts', 'opened_at'], ['fuel_deliveries', 'delivery_date'],
  ['cash_reports', 'date'], ['payment_vouchers', 'date'], ['cash_receipts', 'date'], ['grn', 'date'], ['tank_dips', 'dip_date']];

function phase2b(db, kind) {
  const r = {};
  r.integrity = one(db, 'PRAGMA quick_check')?.quick_check;
  r.schema_version = has(db, 'schema_migrations') ? one(db, 'SELECT MAX(version) AS v FROM schema_migrations')?.v : 'not versioned (pre-D1)';
  r.row_counts = Object.fromEntries(all(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map(({ name }) => [name, one(db, `SELECT COUNT(*) AS n FROM "${name}"`)?.n]));
  if (kind !== 'tenant') return r;

  r.date_ranges = {};
  for (const [t, c] of DATED) {
    if (!cols(db, t).includes(c)) continue;
    r.date_ranges[`${t}.${c}`] = one(db, `SELECT MIN(${c}) AS first, MAX(${c}) AS last,
      SUM(CASE WHEN ${c} >= date('now','-7 days') THEN 1 ELSE 0 END) AS last_7_days FROM "${t}"`);
  }
  r.fuel_table_counts = Object.fromEntries(FUEL_TABLES.filter(t => has(db, t)).map(t => [t, r.row_counts[t]]));
  const fsa = has(db, 'fuel_shift_approvals') ? db.prepare('PRAGMA table_info(fuel_shift_approvals)').all().find(c => c.name === 'shift_id') : null;
  r.shift_approval = {
    shift_id_required: fsa ? !!fsa.notnull : null,
    approvals_saved: r.row_counts.fuel_shift_approvals ?? null,
    note: fsa && fsa.notnull ? 'shift_id is NOT NULL — the original approve route cannot save an approval here (F4 fixes this)' : undefined,
  };
  r.business_settings = {
    rows: r.row_counts.business_settings,
    zra_enabled: cols(db, 'business_settings').includes('zra_enabled') ? all(db, 'SELECT zra_enabled FROM business_settings').map(x => x.zra_enabled) : null,
    currency_mode: cols(db, 'business_settings').includes('currency_mode') ? all(db, 'SELECT currency_mode FROM business_settings').map(x => x.currency_mode) : null,
  };
  r.duplicate_sync_ids = {};
  for (const t of Object.keys(r.row_counts)) {
    if (!cols(db, t).includes('sync_id')) continue;
    const d = one(db, `SELECT COUNT(*) AS n FROM (SELECT sync_id FROM "${t}" WHERE sync_id IS NOT NULL GROUP BY sync_id HAVING COUNT(*) > 1)`);
    if (d?.n) r.duplicate_sync_ids[t] = d.n;
  }
  r.numbering = {
    fuel_orders: one(db, "SELECT COUNT(*) AS n, MIN(order_number) AS first, MAX(order_number) AS last FROM orders WHERE order_number LIKE 'FUEL-%'"),
    fuel_deliveries: has(db, 'fuel_deliveries') ? one(db, 'SELECT COUNT(*) AS n, MIN(delivery_number) AS first, MAX(delivery_number) AS last FROM fuel_deliveries') : null,
  };
  r.cash_reports = {
    stray_cash_reports_migrated: has(db, 'cash_reports_migrated'),
    legacy_unique_date_index: all(db, "PRAGMA index_list('cash_reports')").filter(i => i.unique)
      .some(i => { const c = all(db, `PRAGMA index_info('${i.name}')`); return c.length === 1 && c[0].name === 'date'; }),
  };
  r.unlinked_order_lines = one(db, 'SELECT COUNT(*) AS n FROM order_items WHERE order_sync_id IS NULL')?.n;
  r.invariant_counts = {
    tanks_cache_not_equal_ledger: has(db, 'tank_movements') ? one(db, `SELECT COUNT(*) AS n FROM tanks t
      WHERE ABS(t.current_volume - COALESCE((SELECT SUM(litres) FROM tank_movements m WHERE m.tank_id = t.id), 0)) > 0.0001`)?.n : null,
    products_stock_not_equal_movements: one(db, `SELECT COUNT(*) AS n FROM (SELECT p.id FROM products p
      JOIN stock_movements sm ON sm.product_sync_id = p.sync_id AND sm.deleted_at IS NULL
      WHERE p.deleted_at IS NULL GROUP BY p.id HAVING ABS(MAX(p.current_stock) - SUM(sm.quantity)) > 0.0001)`)?.n,
  };
  return r;
}

function phase2c(db, kind, fleetRows) {
  if (kind !== 'tenant') return {};
  const bcrypt = breq('bcrypt');
  const r = {};
  const DEFAULTS = ['123', 'admin123', 'admin', 'password', '1234'];
  r.known_accounts = all(db, "SELECT id, email, role, status, deleted_at IS NOT NULL AS deleted, password FROM users WHERE LOWER(email) IN ('sirak','admin','admin@keletezm.com','admin@kelete.com')")
    .map(u => ({ username: u.email, role: u.role, status: u.status, deleted: !!u.deleted,
      uses_a_default_password: DEFAULTS.some(p => { try { return bcrypt.compareSync(p, u.password || ''); } catch (_) { return false; } }) }));
  r.administrators = all(db, "SELECT email AS username, status, last_login FROM users WHERE role = 'Administrator' AND deleted_at IS NULL ORDER BY email");
  r.inactive_users = all(db, "SELECT email AS username, role FROM users WHERE COALESCE(status,'Active') != 'Active' AND deleted_at IS NULL ORDER BY email");
  r.tank_drift = has(db, 'tank_movements') ? all(db, `SELECT t.code AS tank, t.current_volume AS cached,
      COALESCE((SELECT SUM(litres) FROM tank_movements m WHERE m.tank_id = t.id), 0) AS ledger FROM tanks t`)
    .filter(x => Math.abs(x.cached - x.ledger) > 0.0001).map(x => ({ ...x, difference: +(x.cached - x.ledger).toFixed(3) })) : [];
  r.orphans = {
    orders_pointing_to_missing_shift: cols(db, 'orders').includes('shift_id') && has(db, 'attendant_shifts')
      ? one(db, 'SELECT COUNT(*) AS n FROM orders o WHERE o.shift_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attendant_shifts s WHERE s.id = o.shift_id)')?.n : null,
    ledger_rows_pointing_to_missing_source: has(db, 'tank_movements') ? one(db, `SELECT COUNT(*) AS n FROM tank_movements m WHERE
      (m.ref_table = 'attendant_shifts' AND NOT EXISTS (SELECT 1 FROM attendant_shifts s WHERE s.id = m.ref_id)) OR
      (m.ref_table = 'fuel_deliveries' AND m.type = 'delivery' AND NOT EXISTS (SELECT 1 FROM fuel_deliveries d WHERE d.id = m.ref_id)) OR
      (m.ref_table = 'tank_dips' AND NOT EXISTS (SELECT 1 FROM tank_dips d WHERE d.id = m.ref_id))`)?.n : null,
    credit_tickets_pointing_to_missing_order: has(db, 'shift_credit_sales') && cols(db, 'shift_credit_sales').includes('linked_order_id')
      ? one(db, 'SELECT COUNT(*) AS n FROM shift_credit_sales c WHERE c.linked_order_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = c.linked_order_id)')?.n : null,
    credit_tickets_without_customer: has(db, 'shift_credit_sales') && cols(db, 'shift_credit_sales').includes('customer_id')
      ? one(db, "SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount FROM shift_credit_sales WHERE payment_method = 'Credit' AND customer_id IS NULL") : null,
  };
  r.ap_payments_without_allocation = has(db, 'ap_payment_allocations') ? one(db, `SELECT COUNT(*) AS n FROM ap_payments p
    WHERE p.deleted_at IS NULL AND p.grn_sync_id IS NOT NULL AND p.grn_sync_id != ''
      AND NOT EXISTS (SELECT 1 FROM ap_payment_allocations a WHERE a.payment_sync_id = p.sync_id)`)?.n : null;
  if (has(db, 'fleet_customers')) {
    for (const f of all(db, 'SELECT name, company, credit_limit, current_balance FROM fleet_customers WHERE COALESCE(current_balance,0) != 0 ORDER BY name')) {
      const match = all(db, "SELECT name FROM customers WHERE deleted_at IS NULL AND (LOWER(TRIM(name)) = LOWER(TRIM(?)) OR LOWER(TRIM(name)) = LOWER(TRIM(?)))", f.name || '', f.company || '');
      fleetRows.push({ ...f, possible_customer_matches: match.map(m => m.name).join('; ') });
    }
  }
  r.fleet_customers_with_balance = fleetRows.length;
  return r;
}

// ─── main ─────────────────────────────────────────────────────────────────
const report = { generated_at: new Date().toISOString(), phases: include2c ? ['2b', '2c'] : ['2b'], databases: {}, cross_database: {} };
const fleetByDb = {};
const fuelNumbers = new Map();

for (const original of files) {
  const label = path.relative(process.cwd(), original);
  if (!fs.existsSync(original)) { report.databases[label] = { error: 'file not found' }; continue; }
  const wal = original + '-wal';
  if (!allowWal && fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    report.databases[label] = { error: 'refused: a non-empty -wal file sits beside it (live database, or not a .backup snapshot)' };
    continue;
  }
  const before = sha256(original);
  const copy = path.join(scratch, crypto.randomBytes(6).toString('hex') + '.db');
  fs.copyFileSync(original, copy);
  const db = new Database(copy);
  db.pragma('query_only = ON');

  const tables = new Set(all(db, "SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
  const kind = tables.has('orders') ? 'tenant' : (tables.has('tenants') || tables.has('licenses')) ? 'master' : 'unknown';
  const entry = { kind, size_bytes: fs.statSync(original).size, sha256: before };
  entry.phase_2b = phase2b(db, kind);
  const exp = kind === 'tenant' ? expected.tenant : kind === 'master' ? expected.master : null;
  if (exp) entry.schema_vs_code = diffSchema(schemaOf(db), exp);
  if (include2c) { fleetByDb[label] = []; entry.phase_2c = phase2c(db, kind, fleetByDb[label]); }
  if (kind === 'tenant') {
    for (const r of all(db, "SELECT order_number FROM orders WHERE order_number LIKE 'FUEL-%'")) {
      if (!fuelNumbers.has(r.order_number)) fuelNumbers.set(r.order_number, new Set());
      fuelNumbers.get(r.order_number).add(label);
    }
  }
  db.close();
  fs.rmSync(copy, { force: true });
  if (sha256(original) !== before) { console.error(`ABORT: ${label} changed while being inspected`); process.exit(3); }
  entry.original_unchanged = true;
  report.databases[label] = entry;
}

const shared = [...fuelNumbers.entries()].filter(([, s]) => s.size > 1);
report.cross_database.fuel_order_numbers_used_in_more_than_one_database = { count: shared.length, examples: shared.slice(0, 5).map(([n, s]) => `${n}: ${[...s].join(', ')}`) };

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(outDir, 'summary.md'), summarise(report));
if (include2c) {
  const rows = Object.entries(fleetByDb).flatMap(([db, rs]) => rs.map(r => ({ database: db, ...r })));
  const csv = ['database,name,company,credit_limit,current_balance,possible_customer_matches',
    ...rows.map(r => [r.database, r.name, r.company, r.credit_limit, r.current_balance, r.possible_customer_matches].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
  fs.writeFileSync(path.join(outDir, 'phase2c-fleet-balances.csv'), csv + '\n');
}
console.log(`Inspected ${files.length} file(s). Report: ${path.join(outDir, 'summary.md')}`);

function summarise(rep) {
  const L = [`# P0 inspection — ${rep.generated_at}`, '', `Phases: ${rep.phases.join(', ')}. Originals were copied before opening and verified unchanged.`, ''];
  for (const [name, d] of Object.entries(rep.databases)) {
    L.push(`## ${name}`, '');
    if (d.error) { L.push(`**Not inspected:** ${d.error}`, ''); continue; }
    const b = d.phase_2b;
    L.push(`- Kind: **${d.kind}** · ${(d.size_bytes / 1048576).toFixed(1)} MB · integrity: **${b.integrity}** · schema version: ${b.schema_version}`);
    const busy = Object.entries(b.row_counts).filter(([, n]) => n > 0).sort((a, c) => c[1] - a[1]).slice(0, 12).map(([t, n]) => `${t} ${n}`);
    L.push(`- Largest tables: ${busy.join(', ') || '(empty)'}`);
    if (b.date_ranges) for (const [k, v] of Object.entries(b.date_ranges)) if (v && v.first) L.push(`- ${k}: ${v.first} → ${v.last} (${v.last_7_days} in last 7 days)`);
    if (b.fuel_table_counts) L.push(`- Fuel data: ${Object.entries(b.fuel_table_counts).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ') || 'none'}`);
    if (b.shift_approval) L.push(`- Shift approval: shift_id required = ${b.shift_approval.shift_id_required}; approvals saved = ${b.shift_approval.approvals_saved}`);
    if (b.business_settings) L.push(`- business_settings rows: ${b.business_settings.rows}; ZRA enabled: ${JSON.stringify(b.business_settings.zra_enabled)}; currency: ${JSON.stringify(b.business_settings.currency_mode)}`);
    if (b.duplicate_sync_ids && Object.keys(b.duplicate_sync_ids).length) L.push(`- **Duplicate sync_ids:** ${JSON.stringify(b.duplicate_sync_ids)}`);
    if (b.cash_reports) L.push(`- cash_reports: stray rebuild table = ${b.cash_reports.stray_cash_reports_migrated}; old UNIQUE(date) = ${b.cash_reports.legacy_unique_date_index}`);
    if (b.unlinked_order_lines !== undefined) L.push(`- Order lines without order_sync_id: ${b.unlinked_order_lines}`);
    if (b.invariant_counts) L.push(`- Tanks off-ledger: ${b.invariant_counts.tanks_cache_not_equal_ledger}; products with stock ≠ movements: ${b.invariant_counts.products_stock_not_equal_movements}`);
    const s = d.schema_vs_code;
    if (s) {
      const n = (k) => s[k].length;
      L.push(`- Schema vs code: missing tables ${n('missing_tables')}, extra tables ${n('extra_tables')}, missing columns ${n('missing_columns')}, extra columns ${n('extra_columns')}, differing columns ${n('different_columns')}, missing indexes ${n('missing_indexes')} (details in report.json)`);
    }
    if (d.phase_2c) {
      const c = d.phase_2c;
      L.push('', '**Phase 2c**', '');
      for (const a of c.known_accounts || []) L.push(`- Account \`${a.username}\`: ${a.role}, ${a.status}${a.deleted ? ', deleted' : ''}; uses a default password: **${a.uses_a_default_password ? 'YES' : 'no'}**`);
      if (c.administrators) L.push(`- Administrators: ${c.administrators.map(a => `${a.username} (${a.status})`).join(', ')}`);
      if (c.inactive_users) L.push(`- Inactive users: ${c.inactive_users.map(u => u.username).join(', ') || 'none'}`);
      if (c.tank_drift?.length) L.push(`- Tank drift: ${c.tank_drift.map(t => `${t.tank} ${t.difference} L`).join(', ')}`);
      if (c.orphans) L.push(`- Orphans: ${JSON.stringify(c.orphans)}`);
      L.push(`- AP payments without allocation: ${c.ap_payments_without_allocation}; fleet customers with a balance: ${c.fleet_customers_with_balance} (see phase2c-fleet-balances.csv)`);
    }
    L.push('');
  }
  const x = rep.cross_database.fuel_order_numbers_used_in_more_than_one_database;
  L.push('## Across databases', '', `- FUEL- order numbers used in more than one database: ${x.count}${x.examples.length ? ' — e.g. ' + x.examples.join('; ') : ''}`, '');
  return L.join('\n');
}
