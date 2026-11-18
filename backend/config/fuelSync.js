/**
 * fuelSync.js — F1: fuel data travels between tills and the VPS.
 *
 * Before F1 no fuel table was in any sync list, and none could have been:
 * no tenant_id (the pull skips such tables), no `synced` flag (the push only
 * sends synced=0 rows), several had no sync_id / updated_at, and every link
 * between fuel records is a numeric row id (tank 3, nozzle 7…), which means
 * something different on every device.
 *
 * What F1 adds (migration v6 builds it from FUEL_TABLES below):
 *   • sync columns on every fuel table (sync_id, tenant_id, device_id,
 *     updated_at, synced) and, for every numeric link, a matching
 *     <link>_sync_id column naming the parent by its sync_id;
 *   • triggers that keep those filled and mark a row for sending whenever it is
 *     inserted or changed by the app — so no fuel route needs editing;
 *   • a deletion log (fuel_sync_deletions): fuel screens delete rows outright,
 *     so each delete leaves a tombstone that travels and is replayed.
 *
 * On the receiving side (server push handler, till pull), for fuel tables:
 *   • numeric links are re-pointed to the LOCAL row with the same sync_id
 *     (prepare); a required parent that has not arrived yet → the row is
 *     held back ('parent-missing') and retried, never stored dangling;
 *   • tank ledger rows are never rewritten (F4) — an existing one is skipped;
 *   • a row refused by a unique code/number already used by a DIFFERENT row
 *     here (e.g. both sides created grade "ULP") is reported 'duplicate', not
 *     silently dropped — that needs a person to decide;
 *   • afterwards, links whose parent has now arrived are filled in and each
 *     tank's current volume is recomputed from its ledger (afterBatch).
 * All of that runs with the "applying" flag set, so the triggers do not mark
 * incoming rows as local changes (no echo). An update that only changes
 * `synced` (the till acknowledging a sent row) is not a change either.
 *
 * KELETE_FUEL_SYNC=off removes the fuel tables from sync on that machine.
 */

// Ordered parents-first: rows are sent and applied in this order.
// fks: [column, parent table]   ref: polymorphic (tank_movements.ref_table/ref_id)
// late: link resolved after a later table (tank_dips.posted_adjustment_id).
const FUEL_TABLES = [
  { table: 'fuel_grades', fks: [] },
  { table: 'tanks', fks: [['fuel_grade_id', 'fuel_grades']] },
  { table: 'pumps', fks: [] },
  { table: 'nozzles', fks: [['pump_id', 'pumps'], ['tank_id', 'tanks']] },
  { table: 'fleet_customers', fks: [] },
  { table: 'fleet_vehicles', fks: [['fleet_customer_id', 'fleet_customers']] },
  { table: 'attendant_shifts', fks: [['attendant_user_id', 'users'], ['opened_by', 'users'], ['closed_by', 'users']] },
  { table: 'shift_nozzle_readings', fks: [['shift_id', 'attendant_shifts'], ['nozzle_id', 'nozzles']] },
  { table: 'shift_dips', fks: [['shift_id', 'attendant_shifts'], ['tank_id', 'tanks']] },
  { table: 'shift_credit_sales', fks: [['shift_id', 'attendant_shifts'], ['fleet_customer_id', 'fleet_customers'], ['fuel_grade_id', 'fuel_grades'], ['customer_id', 'customers'], ['linked_order_id', 'orders']] },
  { table: 'fuel_deliveries', fks: [['supplier_id', 'suppliers'], ['tank_id', 'tanks'], ['fuel_grade_id', 'fuel_grades'], ['received_by', 'users']] },
  { table: 'fuel_sales', fks: [['shift_id', 'attendant_shifts'], ['nozzle_id', 'nozzles'], ['fuel_grade_id', 'fuel_grades'], ['fleet_customer_id', 'fleet_customers'], ['fleet_vehicle_id', 'fleet_vehicles'], ['cashier_id', 'users']] },
  { table: 'tank_dips', fks: [['tank_id', 'tanks'], ['shift_id', 'attendant_shifts'], ['taken_by_user_id', 'users'], ['posted_adjustment_id', 'tank_movements', 'late']] },
  { table: 'tank_movements', fks: [['tank_id', 'tanks'], ['created_by', 'users']], ref: true, immutable: true },
  { table: 'fuel_shift_approvals', fks: [['shift_id', 'attendant_shifts'], ['approved_by', 'users']] },
  { table: 'fuel_day_approvals', fks: [['approved_by', 'users']] },
];
const DELETIONS = 'fuel_sync_deletions';
// tank_movements.ref_table values that name a synced fuel table.
const REF_TABLES = ['attendant_shifts', 'fuel_deliveries', 'fuel_sales', 'tank_dips'];

const syncCol = (fk) => (fk.endsWith('_id') ? fk.slice(0, -3) : fk) + '_sync_id';
const SPEC = Object.fromEntries(FUEL_TABLES.map(s => [s.table, s]));

const enabled = () => String(process.env.KELETE_FUEL_SYNC || 'on').toLowerCase() !== 'off';
const TABLE_NAMES = [...FUEL_TABLES.map(s => s.table), DELETIONS];
const isFuel = (t) => TABLE_NAMES.includes(t);

// The tables to add to a sync list (empty when switched off).
function syncTables() { return enabled() ? TABLE_NAMES.slice() : []; }

function columnsInfo(db, table) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all(); } catch (_) { return []; }
}

// Run fn with the "applying" flag set (inside the caller's transaction).
function withApplying(db, fn) {
  db.prepare("UPDATE sync_apply_state SET v = 1 WHERE k = 'applying'").run();
  try { return fn(); } finally { db.prepare("UPDATE sync_apply_state SET v = 0 WHERE k = 'applying'").run(); }
}

const idCache = new WeakMap();
function localId(db, table, syncId) {
  if (syncId == null || syncId === '') return null;
  const r = db.prepare(`SELECT id FROM ${table} WHERE sync_id = ?`).get(syncId);
  return r ? r.id : null;
}

// Re-point an incoming row's numeric links at this database's rows.
// Returns null (ok) or the reason the row must be held back.
function prepare(db, table, row) {
  const spec = SPEC[table];
  if (!spec) return null;
  let notNull = idCache.get(db) && idCache.get(db)[table];
  if (!notNull) {
    notNull = new Set(columnsInfo(db, table).filter(c => c.notnull).map(c => c.name));
    if (!idCache.get(db)) idCache.set(db, {});
    idCache.get(db)[table] = notNull;
  }
  for (const [fk, parent, late] of spec.fks) {
    if (!(fk in row) && !(syncCol(fk) in row)) continue;
    const sid = row[syncCol(fk)];
    let id = null;
    try { id = sid ? localId(db, parent, sid) : null; } catch (_) { id = null; }
    if (id != null) { row[fk] = id; continue; }
    if (sid && !late && notNull.has(fk)) return `parent-missing:${fk}`;
    row[fk] = null; // filled in by afterBatch once the parent arrives
  }
  if (spec.ref) {
    if (row.ref_table && REF_TABLES.includes(row.ref_table)) {
      row.ref_id = row.ref_sync_id ? localId(db, row.ref_table, row.ref_sync_id) : null;
    } else if (row.ref_table) {
      row.ref_id = null; // e.g. tank_opening_correction: no row behind it
    }
  }
  return null;
}

const isImmutable = (table) => !!(SPEC[table] && SPEC[table].immutable);

// After a batch of `table` rows was applied (flag set by caller):
function afterBatch(db, table, rows = []) {
  // 1. replay deletions
  if (table === DELETIONS) {
    for (const r of rows) {
      if (!r || !SPEC[r.table_name] || !r.row_sync_id) continue;
      try { db.prepare(`DELETE FROM ${r.table_name} WHERE sync_id = ?`).run(r.row_sync_id); }
      catch (e) { console.warn(`[fuelSync] deletion of ${r.table_name} ${r.row_sync_id} not replayed: ${e.message}`); }
    }
  }
  // 2. fill in links whose parent is now here
  for (const spec of FUEL_TABLES) {
    for (const [fk, parent] of spec.fks) {
      const sc = syncCol(fk);
      try {
        db.prepare(`UPDATE ${spec.table} SET ${fk} = (SELECT p.id FROM ${parent} p WHERE p.sync_id = ${spec.table}.${sc})
                    WHERE ${fk} IS NULL AND ${sc} IS NOT NULL AND EXISTS (SELECT 1 FROM ${parent} p WHERE p.sync_id = ${spec.table}.${sc})`).run();
      } catch (_) { /* column absent on an older schema */ }
    }
  }
  try {
    for (const rt of REF_TABLES) {
      db.prepare(`UPDATE tank_movements SET ref_id = (SELECT p.id FROM ${rt} p WHERE p.sync_id = tank_movements.ref_sync_id)
                  WHERE ref_table = ? AND ref_id IS NULL AND ref_sync_id IS NOT NULL`).run(rt);
    }
  } catch (_) {}
  // 3. a tank's volume is its ledger (never the sender's cached figure)
  if (table === 'tank_movements' || table === 'tanks' || table === DELETIONS) {
    db.prepare('UPDATE tanks SET current_volume = COALESCE((SELECT SUM(m.litres) FROM tank_movements m WHERE m.tank_id = tanks.id), 0)').run();
  }
}

// ─── schema (migration v6) ─────────────────────────────────────────────────
const UUID_SQL = "lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6)))";
const NOW_MS = "strftime('%Y-%m-%d %H:%M:%f', 'now')";
const CFG_TENANT = "COALESCE((SELECT value FROM sync_config WHERE key = 'tenant_id'), (SELECT value FROM sync_config WHERE key LIKE 'tenant:%' ORDER BY key LIMIT 1))";
const CFG_DEVICE = "(SELECT value FROM sync_config WHERE key = 'device_id')";
const NOT_APPLYING = "(SELECT v FROM sync_apply_state WHERE k = 'applying') IS NOT 1";

function addCol(db, table, col, type) {
  const cols = columnsInfo(db, table).map(c => c.name);
  if (cols.length && !cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

// Links whose parent table has a sync_id here (older schemas may lack one).
function linkable(db, spec) {
  return spec.fks.filter(([, parent]) => columnsInfo(db, parent).some(c => c.name === 'sync_id'));
}

function bookkeepingSet(spec, prefix, fks = spec.fks) {
  const sets = [
    `sync_id = COALESCE(${prefix}.sync_id, ${UUID_SQL})`,
    `tenant_id = COALESCE(${prefix}.tenant_id, ${CFG_TENANT})`,
    `device_id = COALESCE(${prefix}.device_id, ${CFG_DEVICE})`,
    `updated_at = ${NOW_MS}`,
    'synced = 0',
  ];
  for (const [fk, parent] of fks) {
    const sc = syncCol(fk);
    sets.push(`${sc} = CASE WHEN ${prefix}.${fk} IS NULL THEN ${prefix}.${sc} ELSE COALESCE((SELECT p.sync_id FROM ${parent} p WHERE p.id = ${prefix}.${fk}), ${prefix}.${sc}) END`);
  }
  if (spec.ref) {
    sets.push(`ref_sync_id = CASE ${REF_TABLES.map(rt => `WHEN ${prefix}.ref_table = '${rt}' THEN (SELECT p.sync_id FROM ${rt} p WHERE p.id = ${prefix}.ref_id)`).join(' ')} ELSE ${prefix}.ref_sync_id END`);
  }
  return sets.join(',\n            ');
}

function installSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sync_apply_state (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0);
           INSERT OR IGNORE INTO sync_apply_state (k, v) VALUES ('applying', 0);
           UPDATE sync_apply_state SET v = 0 WHERE k = 'applying';
           CREATE TABLE IF NOT EXISTS ${DELETIONS} (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             sync_id TEXT UNIQUE, tenant_id TEXT, device_id TEXT,
             table_name TEXT NOT NULL, row_sync_id TEXT NOT NULL,
             created_at TEXT NOT NULL DEFAULT (${NOW_MS}), updated_at TEXT, synced INTEGER NOT NULL DEFAULT 0
           );`);

  for (const spec of FUEL_TABLES) {
    const t = spec.table;
    if (!columnsInfo(db, t).length) continue;
    addCol(db, t, 'sync_id', 'TEXT');
    addCol(db, t, 'tenant_id', 'TEXT');
    addCol(db, t, 'device_id', 'TEXT');
    addCol(db, t, 'updated_at', 'TEXT');
    addCol(db, t, 'synced', 'INTEGER NOT NULL DEFAULT 0');
    for (const [fk] of spec.fks) addCol(db, t, syncCol(fk), 'TEXT');
    if (spec.ref) addCol(db, t, 'ref_sync_id', 'TEXT');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${t}_sync_id_f1 ON ${t}(sync_id) WHERE sync_id IS NOT NULL`);

    // Existing rows: give them their identity and links, and queue them for
    // the first sync. (Parents first, so links resolve.)
    db.prepare(`UPDATE ${t} SET sync_id = ${UUID_SQL} WHERE sync_id IS NULL`).run();
    const fks = linkable(db, spec);
    const backfill = bookkeepingSet(spec, t, fks).replace(`updated_at = ${NOW_MS}`, `updated_at = COALESCE(${t}.updated_at, ${columnsInfo(db, t).some(c => c.name === 'created_at') ? `${t}.created_at, ` : ''}${NOW_MS})`);
    db.prepare(`UPDATE ${t} SET ${backfill}`).run();

    db.exec(`DROP TRIGGER IF EXISTS trg_f1_${t}_ins; DROP TRIGGER IF EXISTS trg_f1_${t}_upd; DROP TRIGGER IF EXISTS trg_f1_${t}_del;`);
    db.exec(`
      CREATE TRIGGER trg_f1_${t}_ins AFTER INSERT ON ${t}
      WHEN ${NOT_APPLYING}
      BEGIN
        UPDATE ${t} SET
            ${bookkeepingSet(spec, 'NEW', fks)}
        WHERE rowid = NEW.rowid;
      END;
      CREATE TRIGGER trg_f1_${t}_upd AFTER UPDATE ON ${t}
      WHEN ${NOT_APPLYING} AND NEW.synced IS OLD.synced
      BEGIN
        UPDATE ${t} SET
            ${bookkeepingSet(spec, 'NEW', fks)}
        WHERE rowid = NEW.rowid;
      END;
      CREATE TRIGGER trg_f1_${t}_del AFTER DELETE ON ${t}
      WHEN ${NOT_APPLYING} AND OLD.sync_id IS NOT NULL
      BEGIN
        INSERT INTO ${DELETIONS} (sync_id, tenant_id, device_id, table_name, row_sync_id, updated_at, synced)
        VALUES (${UUID_SQL}, COALESCE(OLD.tenant_id, ${CFG_TENANT}), ${CFG_DEVICE}, '${t}', OLD.sync_id, ${NOW_MS}, 0);
      END;`);
  }
}

module.exports = { FUEL_TABLES, DELETIONS, TABLE_NAMES, syncCol, enabled, isFuel, syncTables, withApplying, prepare, isImmutable, afterBatch, installSchema };
