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
];
