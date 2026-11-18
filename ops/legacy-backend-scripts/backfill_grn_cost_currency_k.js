/**
 * v1.10.79 — one-off backfill: SET grn.cost_currency = 'K' on every
 * existing HQ GRN row that still has NULL / empty cost_currency.
 *
 * WHY:
 * All 6 GRNs migrated to kelete.db by v1.10.75/76 were entered when the
 * HQ Purchase form had no cost currency picker for K-only destinations.
 * Operators typed K amounts but the UI labelled them as $ (from the
 * tenant's primary curSym). Per user confirmation (2026-07-04 Option A):
 * every existing GRN is K. This script tags them so the new per-currency
 * display code renders them correctly.
 *
 * SAFETY:
 * - Only touches rows where cost_currency IS NULL or empty.
 * - Idempotent: re-runs are a no-op.
 * - Prints before/after counts.
 * - Foreign-keys stay ON (no risk).
 *
 * HOW TO RUN:
 *   node backend/scripts/backfill_grn_cost_currency_k.js
 */

const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'kelete.db');
const db = new Database(dbPath);

function main() {
  console.log(`Target: ${dbPath}`);
  const before = db.prepare(
    `SELECT COUNT(*) AS n FROM grn WHERE cost_currency IS NULL OR cost_currency = ''`
  ).get().n;
  const total  = db.prepare(`SELECT COUNT(*) AS n FROM grn`).get().n;
  console.log(`\nGRN rows: ${total} total, ${before} without cost_currency`);
  if (before === 0) { console.log('\nNothing to backfill. Done.'); return; }

  const info = db.prepare(
    `UPDATE grn SET cost_currency = 'K' WHERE cost_currency IS NULL OR cost_currency = ''`
  ).run();
  console.log(`Backfilled: ${info.changes} row(s) set to cost_currency = 'K'`);

  const after = db.prepare(
    `SELECT COUNT(*) AS n FROM grn WHERE cost_currency IS NULL OR cost_currency = ''`
  ).get().n;
  console.log(`\nAfter: ${after} row(s) still without cost_currency`);
  console.log('Done.');
}

main();
