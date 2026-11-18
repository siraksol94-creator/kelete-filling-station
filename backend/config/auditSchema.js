// D2 — audit trail: table, append-only guard, and change-capture triggers.
//
// Two complementary sources write to audit_log:
//
//   source='db-trigger'  Written by SQLite itself, in the SAME statement as the
//                        change, so it cannot be skipped by any code path
//                        (route, bulk import, HQ push, sync pull, boot heal).
//                        Records exactly WHAT changed: before/after values.
//                        Cannot know WHO — SQLite has no notion of the user.
//
//   source='request'     Written by services/audit.js for every sensitive API
//                        request (deletes, voids, reversals, approvals, user /
//                        price / meter / tank changes, failed logins).
//                        Records WHO (user, role, IP), the request and result.
//
// Read together (same entity, same moment) they answer who changed what.
//
// audit_log is append-only: UPDATE and DELETE on it are refused by triggers.
// It is per-database and NOT synced, so every till and the VPS keep their own
// record of what happened on them.

const crypto = require('crypto');

function createAuditTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      source          TEXT NOT NULL,              -- 'db-trigger' | 'request'
      action          TEXT NOT NULL,              -- e.g. 'product.price_change', 'request.delete'
      entity_table    TEXT,
      entity_id       TEXT,
      entity_sync_id  TEXT,
      tenant_id       TEXT,
      actor_user_id   INTEGER,
      actor_email     TEXT,
      actor_role      TEXT,
      actor_name      TEXT,
      ip              TEXT,
      forwarded_for   TEXT,
      method          TEXT,
      path            TEXT,
      status_code     INTEGER,
      duration_ms     INTEGER,
      before_json     TEXT,
      after_json      TEXT,
      details_json    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_audit_log_occurred ON audit_log (occurred_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_entity   ON audit_log (entity_table, entity_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action   ON audit_log (action);
    CREATE INDEX IF NOT EXISTS idx_audit_log_actor    ON audit_log (actor_user_id);

    CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

    CREATE TABLE IF NOT EXISTS audit_trigger_state (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      signature  TEXT NOT NULL,
      built_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

// ─── Trigger definitions ──────────────────────────────────────────────────
// Only columns that exist in THIS database are referenced. A trigger naming
// a missing column would make every UPDATE on that table fail at runtime.

const PRICE_WATCH = {
  products:    { action: 'product.price_change',    cols: ['selling_price', 'cost_price', 'alt_price', 'units_json'] },
  fuel_grades: { action: 'fuel_grade.price_change', cols: ['selling_price', 'cost_price'] },
};

// Users: security-relevant fields. The password hash itself is NEVER copied
// into the audit log — only the fact that it changed.
const USER_WATCH = ['email', 'role', 'permissions', 'status', 'deleted_at'];

// Hard deletes: the deleted row is preserved in full in before_json.
const HARD_DELETE_WATCH = [
  'fuel_deliveries', 'fuel_sales', 'attendant_shifts', 'shift_credit_sales',
  'shift_nozzle_readings', 'shift_dips', 'tank_dips', 'tank_movements',
  'tanks', 'nozzles', 'pumps', 'fuel_grades', 'fleet_customers', 'fleet_vehicles',
  'fuel_shift_approvals', 'fuel_day_approvals',
];

// Soft deletes / voids: deleted_at going from NULL to a value.
const SOFT_DELETE_WATCH = [
  'orders', 'payment_vouchers', 'cash_receipts', 'customer_payments', 'ap_payments',
  'grn', 'siv', 'stock_adjustments', 'sales_returns', 'supplier_credit_notes',
  'customers', 'suppliers', 'products', 'cash_transfers', 'capital_account',
  'dividend_account', 'loans', 'loan_transactions', 'debit_notes',
];

const CHUNK = 40; // columns per json_object() call (stays well under SQLite's function-argument limit)

function columnsOf(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
  catch (_) { return []; }
}

const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// json_object over the given columns of OLD/NEW, merged in chunks with json_patch.
function rowJson(prefix, cols, exclude = []) {
  const use = cols.filter(c => !exclude.includes(c));
  if (!use.length) return 'NULL';
  const parts = [];
  for (let i = 0; i < use.length; i += CHUNK) {
    const slice = use.slice(i, i + CHUNK);
    parts.push(`json_object(${slice.map(c => `${lit(c)}, ${prefix}.${q(c)}`).join(', ')})`);
  }
  return parts.reduce((acc, p) => (acc ? `json_patch(${acc}, ${p})` : p), '');
}

function maybe(cols, name, prefix) {
  return cols.includes(name) ? `${prefix}.${q(name)}` : 'NULL';
}

function buildTriggerSql(db) {
  const out = []; // [name, sql]

  for (const [table, spec] of Object.entries(PRICE_WATCH)) {
    const cols = columnsOf(db, table);
    const watch = spec.cols.filter(c => cols.includes(c));
    if (!watch.length) continue;
    out.push([`trg_audit_${table}_price`, `
      CREATE TRIGGER trg_audit_${table}_price
      AFTER UPDATE OF ${watch.map(q).join(', ')} ON ${q(table)}
      WHEN ${watch.map(c => `OLD.${q(c)} IS NOT NEW.${q(c)}`).join(' OR ')}
      BEGIN
        INSERT INTO audit_log (source, action, entity_table, entity_id, entity_sync_id, tenant_id, before_json, after_json)
        VALUES ('db-trigger', ${lit(spec.action)}, ${lit(table)}, NEW.id, ${maybe(cols, 'sync_id', 'NEW')}, ${maybe(cols, 'tenant_id', 'NEW')},
                ${rowJson('OLD', watch)}, ${rowJson('NEW', watch)});
      END`]);
  }

  {
    const cols = columnsOf(db, 'nozzles');
    if (cols.includes('current_meter_reading')) {
      out.push(['trg_audit_nozzles_meter', `
        CREATE TRIGGER trg_audit_nozzles_meter
        AFTER UPDATE OF current_meter_reading ON nozzles
        WHEN OLD.current_meter_reading IS NOT NEW.current_meter_reading
        BEGIN
          INSERT INTO audit_log (source, action, entity_table, entity_id, entity_sync_id, before_json, after_json, details_json)
          VALUES ('db-trigger', 'nozzle.meter_change', 'nozzles', NEW.id, ${maybe(cols, 'sync_id', 'NEW')},
                  json_object('current_meter_reading', OLD.current_meter_reading),
                  json_object('current_meter_reading', NEW.current_meter_reading),
                  json_object('delta', NEW.current_meter_reading - OLD.current_meter_reading,
                              'pump_id', NEW.pump_id, 'tank_id', NEW.tank_id, 'code', NEW.code));
        END`]);
      out.push(['trg_audit_nozzles_insert', `
        CREATE TRIGGER trg_audit_nozzles_insert
        AFTER INSERT ON nozzles
        BEGIN
          INSERT INTO audit_log (source, action, entity_table, entity_id, entity_sync_id, after_json)
          VALUES ('db-trigger', 'nozzle.create', 'nozzles', NEW.id, ${maybe(cols, 'sync_id', 'NEW')}, ${rowJson('NEW', cols)});
        END`]);
    }
  }

  {
    const cols = columnsOf(db, 'users');
    const watch = USER_WATCH.filter(c => cols.includes(c));
    const pw = cols.includes('password');
    if (watch.length || pw) {
      const updOf = [...watch, ...(pw ? ['password'] : [])];
      out.push(['trg_audit_users_security', `
        CREATE TRIGGER trg_audit_users_security
        AFTER UPDATE OF ${updOf.map(q).join(', ')} ON users
        WHEN ${updOf.map(c => `OLD.${q(c)} IS NOT NEW.${q(c)}`).join(' OR ')}
        BEGIN
          INSERT INTO audit_log (source, action, entity_table, entity_id, entity_sync_id, tenant_id, before_json, after_json, details_json)
          VALUES ('db-trigger', 'user.security_change', 'users', NEW.id, ${maybe(cols, 'sync_id', 'NEW')}, ${maybe(cols, 'tenant_id', 'NEW')},
                  ${rowJson('OLD', watch)}, ${rowJson('NEW', watch)},
                  json_object('password_changed', ${pw ? 'CASE WHEN OLD.password IS NOT NEW.password THEN 1 ELSE 0 END' : '0'}));
        END`]);
      out.push(['trg_audit_users_insert', `
        CREATE TRIGGER trg_audit_users_insert
        AFTER INSERT ON users
        BEGIN
          INSERT INTO audit_log (source, action, entity_table, entity_id, entity_sync_id, tenant_id, after_json)
          VALUES ('db-trigger', 'user.create', 'users', NEW.id, ${maybe(cols, 'sync_id', 'NEW')}, ${maybe(cols, 'tenant_id', 'NEW')},
                  ${rowJson('NEW', cols, ['password'])});
        END`]);
    }
  }

  for (const table of HARD_DELETE_WATCH) {
    const cols = columnsOf(db, table);
    if (!cols.length) continue;
    out.push([`trg_audit_${table}_delete`, `
      CREATE TRIGGER trg_audit_${table}_delete
      AFTER DELETE ON ${q(table)}
      BEGIN
        INSERT INTO audit_log (source, action, entity_table, entity_id, entity_sync_id, tenant_id, before_json)
        VALUES ('db-trigger', ${lit(table + '.delete')}, ${lit(table)}, OLD.id, ${maybe(cols, 'sync_id', 'OLD')}, ${maybe(cols, 'tenant_id', 'OLD')},
                ${rowJson('OLD', cols, ['password'])});
      END`]);
  }

  for (const table of SOFT_DELETE_WATCH) {
    const cols = columnsOf(db, table);
    if (!cols.includes('deleted_at')) continue;
    out.push([`trg_audit_${table}_soft_delete`, `
      CREATE TRIGGER trg_audit_${table}_soft_delete
      AFTER UPDATE OF deleted_at ON ${q(table)}
      WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
      BEGIN
        INSERT INTO audit_log (source, action, entity_table, entity_id, entity_sync_id, tenant_id, before_json)
        VALUES ('db-trigger', ${lit(table + '.soft_delete')}, ${lit(table)}, OLD.id, ${maybe(cols, 'sync_id', 'OLD')}, ${maybe(cols, 'tenant_id', 'OLD')},
                ${rowJson('OLD', cols, ['password'])});
      END`]);
  }

  {
    const cols = columnsOf(db, 'orders');
    if (cols.includes('status')) {
      out.push(['trg_audit_orders_reverse', `
        CREATE TRIGGER trg_audit_orders_reverse
        AFTER UPDATE OF status ON orders
        WHEN NEW.status = 'Reversed' AND OLD.status IS NOT 'Reversed'
        BEGIN
          INSERT INTO audit_log (source, action, entity_table, entity_id, entity_sync_id, tenant_id, before_json)
          VALUES ('db-trigger', 'order.reverse', 'orders', OLD.id, ${maybe(cols, 'sync_id', 'OLD')}, ${maybe(cols, 'tenant_id', 'OLD')},
                  ${rowJson('OLD', cols)});
        END`]);
    }
  }

  return out;
}

// (Re)build the change-capture triggers when — and only when — the set of
// watched tables/columns differs from what they were built against. Columns
// added later by migrations are then included automatically on the next start.
// Runs in one transaction: either every trigger is rebuilt or none is.
function ensureAuditTriggers(db) {
  const defs = buildTriggerSql(db);
  const signature = crypto.createHash('sha256').update(defs.map(d => d[1]).join('\n')).digest('hex');
  const state = db.prepare('SELECT signature FROM audit_trigger_state WHERE id = 1').get();
  if (state && state.signature === signature) return { rebuilt: false, count: defs.length };

  const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_audit_%'").all()
    .map(r => r.name)
    .filter(n => n !== 'trg_audit_log_no_update' && n !== 'trg_audit_log_no_delete');
  db.transaction(() => {
    for (const n of existing) db.exec(`DROP TRIGGER IF EXISTS ${q(n)}`);
    for (const [, sql] of defs) db.exec(sql);
    db.prepare(`
      INSERT INTO audit_trigger_state (id, signature) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET signature = excluded.signature, built_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(signature);
  })();
  return { rebuilt: true, count: defs.length };
}

module.exports = {
  createAuditTable, ensureAuditTriggers, buildTriggerSql,
  PRICE_WATCH, USER_WATCH, HARD_DELETE_WATCH, SOFT_DELETE_WATCH,
};
