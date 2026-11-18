// D1 — the ordered list of schema migrations for branch (tenant) databases,
// including the Electron till's kelete.db.
//
// RULES for adding one:
//   • Append with the next version number. Never renumber, edit or delete a
//     migration that has shipped — its checksum is recorded on every database
//     that ran it. Fix mistakes with a NEW migration.
//   • `up(db)` runs inside a transaction. Throw to abort; nothing is kept.
//   • Additive only (ADD COLUMN, CREATE TABLE/INDEX/TRIGGER) unless a change
//     has been separately approved. No DROP TABLE, no table rebuilds.
//   • Create a UNIQUE index only after a duplicate check that returns zero
//     rows, and throw with a clear message if it does not.
//   • Data fixes that must run once belong in runOnce() tasks, not here.

const { createAuditTable } = require('./auditSchema');

module.exports = [
  {
    version: 1,
    name: 'baseline',
    // Marks the point at which versioning began. Everything before it is the
    // legacy initTenantDb() schema, which keeps running idempotently because
    // the live databases' exact state cannot yet be seen (Phase 2a).
    up() { /* intentionally empty */ },
  },
  {
    version: 2,
    name: 'audit_log',
    // D2 — append-only audit table. Its change-capture triggers are built by
    // ensureAuditTriggers() from the columns actually present (auditSchema.js).
    up(db) { createAuditTable(db); },
  },
  {
    version: 3,
    name: 'fuel_ledger_guards',
    // F4 — the tank ledger becomes append-only at the database level, so no
    // code path (current or future) can erase or rewrite fuel history.
    //   • tank_movements rows cannot be deleted, and their litres / tank /
    //     type / date cannot be changed. Corrections are new rows
    //     (adjustment or reversal).
    //   • A tank that has ledger history cannot be deleted (the old ON DELETE
    //     CASCADE would have erased that history with it).
    //   • A dip that has been posted to the ledger cannot be deleted.
    // Only blocks future deletes/edits; existing rows are untouched.
    up(db) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_f4_tank_movements_no_delete
        BEFORE DELETE ON tank_movements
        BEGIN SELECT RAISE(ABORT, 'Tank ledger rows cannot be deleted. Post a reversal or adjustment instead.'); END;

        CREATE TRIGGER IF NOT EXISTS trg_f4_tank_movements_no_rewrite
        BEFORE UPDATE OF litres, tank_id, type, movement_date ON tank_movements
        BEGIN SELECT RAISE(ABORT, 'Tank ledger rows cannot be changed. Post an adjustment instead.'); END;

        CREATE TRIGGER IF NOT EXISTS trg_f4_tanks_keep_history
        BEFORE DELETE ON tanks
        WHEN EXISTS (SELECT 1 FROM tank_movements WHERE tank_id = OLD.id)
        BEGIN SELECT RAISE(ABORT, 'This tank has ledger history and cannot be deleted. Mark it Inactive instead.'); END;

        CREATE TRIGGER IF NOT EXISTS trg_f4_posted_dips_keep
        BEFORE DELETE ON tank_dips
        WHEN OLD.posted_adjustment_id IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'This dip has been posted to the tank ledger and cannot be deleted.'); END;
      `);
    },
  },
  {
    version: 4,
    name: 'credit_ticket_order_sync_link',
    // F2 — shift_credit_sales linked its receivable order only by numeric id,
    // which is meaningless on any other device after sync (Phase 2a C4). Add
    // the order's sync_id alongside it. Additive; existing rows stay NULL
    // until the per-device backfill (after the Phase 2b checks).
    up(db) {
      const cols = db.prepare('PRAGMA table_info(shift_credit_sales)').all().map(c => c.name);
      if (cols.length && !cols.includes('linked_order_sync_id')) {
        db.exec('ALTER TABLE shift_credit_sales ADD COLUMN linked_order_sync_id TEXT');
      }
    },
  },
  {
    version: 5,
    name: 'sync_device_tokens',
    // S1 stage 2 — one row per till allowed to sync with this database. Only a
    // SHA-256 of each token is stored. Server-side only: not in any sync list.
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_device_tokens (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash    TEXT NOT NULL UNIQUE,
          tenant_id     TEXT NOT NULL,
          branch_id     TEXT,
          device_id     TEXT,
          label         TEXT,
          issued_via    TEXT NOT NULL,          -- register | join-branch | auto-enrol
          created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_seen_at  TEXT,
          last_ip       TEXT,
          revoked_at    TEXT,
          revoked_by    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sync_device_tokens_device ON sync_device_tokens (tenant_id, device_id);
      `);
    },
  },
  {
    version: 6,
    name: 'fuel_sync',
    // F1 — sync columns, link sync_ids, change-marking triggers and the
    // deletion log on every fuel table (config/fuelSync.js). Additive: columns
    // are added, existing rows get a sync_id and their links' sync_ids, and are
    // queued to be sent once. No row is deleted or rewritten.
    up(db) { require('./fuelSync').installSchema(db); },
  },
  {
    version: 7,
    name: 'shift_business_date',
    // UTC dates fix — each attendant shift records its trading day (Zambian
    // date when opened). Existing shifts keep the date the old rule gave them
    // (DATE(opened_at), UTC), so no approval already given covers different
    // shifts afterwards. Additive.
    up(db) {
      const cols = db.prepare('PRAGMA table_info(attendant_shifts)').all().map(c => c.name);
      if (!cols.length) return;
      if (!cols.includes('shift_date')) db.exec('ALTER TABLE attendant_shifts ADD COLUMN shift_date TEXT');
      // Every device computes the same value for its existing rows, so this is
      // not a change to sync: run it with F1's "applying" flag set.
      const flag = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_apply_state'").get();
      if (flag) db.prepare("UPDATE sync_apply_state SET v = 1 WHERE k = 'applying'").run();
      try {
        db.prepare('UPDATE attendant_shifts SET shift_date = DATE(opened_at) WHERE shift_date IS NULL').run();
      } finally {
        if (flag) db.prepare("UPDATE sync_apply_state SET v = 0 WHERE k = 'applying'").run();
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_attendant_shifts_shift_date ON attendant_shifts (shift_date, shift_type)');
    },
  },
];
