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
];
