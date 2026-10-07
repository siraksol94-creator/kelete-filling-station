#!/usr/bin/env node
// factoryReset.js â€” v1.10.5
// Full transactional wipe across master.db + every tenant DB.
//
// KEEPS: products (with prices/units/categories), categories, main_categories,
//        units, users, business_settings, sync_config, licenses, pv_types,
//        quick_items, fx_rates, product_branch_prices, branches / tenants.
//
// CLEARS: every sales / stock / cash / payment / accounting transaction row
//         + customers + suppliers (both branch and HQ side).
//
// SIDE EFFECT: products.current_stock is reset to 0 in every branch DB.
//
// SAFETY:
//   â€¢ Requires --yes-really flag (refuses otherwise).
//   â€¢ Snapshots every DB to backend/../backups/reset_<ts>/ BEFORE any DELETE.
//   â€¢ Wraps deletes in a transaction per DB (auto-rollback on error).
//   â€¢ --dry-run prints counts without touching anything.
//
// USAGE (on VPS, PM2 stopped):
//   pm2 stop kelete-tenant
//   node backend/scripts/factoryReset.js --dry-run          # preview
//   node backend/scripts/factoryReset.js --yes-really       # do it
//   pm2 start kelete-tenant

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args   = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const yes    = args.includes('--yes-really');

if (!dryRun && !yes) {
  console.error('\nRefusing to run without --yes-really (or --dry-run to preview).');
  process.exit(1);
}

const ROOT        = path.join(__dirname, '..');
const TENANTS_DIR = process.env.TENANTS_DIR || path.join(ROOT, '..', 'tenants');
const MASTER_DB   = path.join(ROOT, '..', 'master.db');
// Fallback: some installs keep master.db inside backend/
const MASTER_DB_ALT = path.join(ROOT, 'master.db');

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BACKUP_DIR  = path.join(ROOT, '..', 'backups', `reset_${ts}`);

// â”€â”€â”€ What we clear â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Per-branch DB (tenants/<slug>.db). Order matters for FK cascade even with
// FK OFF â€” child rows first is still cleaner.
const BRANCH_TABLES = [
  // Sales
  'order_payment_edits',
  'order_items', 'orders',
  'sales_return_items', 'sales_returns',
  'discount_requests',
  // Purchases + returns
  'grn_items', 'grn',
  'siv_items', 'siv',
  'empty_return_items', 'empty_returns',
  'supplier_credit_note_items', 'supplier_credit_notes',
  // Payments + AR/AP
  'customer_payments', 'ap_payments',
  'cash_receipts', 'payment_vouchers',
  // Cash / ledger
  'cash_book', 'cash_reports', 'cash_transfers', 'currency_exchanges',
  'daily_actual_balance', 'daily_cost_snapshot', 'daily_profit_summary',
  // Stock
  'stock_movements',
  'stock_reconciliation_items', 'stock_reconciliations',
  'stock_count_items', 'stock_count_sessions',
  'stock_adjustments',
  // Production (removed for Kelete, but wipe rows if the table lingers)
  'production_inputs', 'production_outputs', 'production',
  // Accounting balances (transactional even though named "account")
  'loan_transactions', 'loans',
  'shareholders', 'dividend_account', 'capital_account',
  // Master data user asked to clear
  'customers',
  'suppliers',
];

// master.db â€” HQ paperwork + inter-branch movements + HQ suppliers.
const MASTER_TABLES = [
  // v1.10.0 procurement
  'hq_grn_items', 'hq_grns',
  'hq_supplier_credit_note_items', 'hq_supplier_credit_notes',
  'hq_confirmed_grn_totals',
  'hq_purchase_receipt_extras',
  'hq_purchase_items', 'hq_purchases',
  // Supplier ledger at HQ
  'hq_supplier_payments', 'hq_suppliers',
  // Inter-branch + banking
  'transfer_variances', 'stock_transfers',
  'cash_deposits',
  // Any lingering HQ damage records
  'hq_damages',
];

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

function backupDb(dbPath) {
  if (dryRun) return null;
  if (!fs.existsSync(dbPath)) return null;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const dest = path.join(BACKUP_DIR, path.basename(dbPath) + '.bak');
  // Use SQLite online backup API for a consistent WAL-safe snapshot.
  const src = new Database(dbPath, { readonly: true });
  try {
    src.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  return dest;
}

function resetDb(dbPath, tables, opts = {}) {
  if (!fs.existsSync(dbPath)) {
    console.log(`  âš   skip (not found): ${dbPath}`);
    return { summary: [], skipped: true };
  }
  const db = new Database(dbPath);
  db.pragma('foreign_keys = OFF');
  const summary = [];
  const tx = db.transaction(() => {
    for (const t of tables) {
      if (!tableExists(db, t)) continue;
      const before = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
      if (before === 0) continue;
      if (!dryRun) {
        db.prepare(`DELETE FROM ${t}`).run();
        try { db.prepare(`DELETE FROM sqlite_sequence WHERE name=?`).run(t); } catch { /* no autoinc */ }
      }
      summary.push({ table: t, before, after: dryRun ? before : 0 });
    }
    // Zero product stock (branch DBs only)
    if (opts.zeroStock && tableExists(db, 'products')) {
      const nonZero = db.prepare(`SELECT COUNT(*) c FROM products WHERE current_stock != 0`).get().c;
      if (!dryRun && nonZero > 0) {
        db.prepare(`UPDATE products SET current_stock = 0, updated_at = datetime('now'), synced = 0`).run();
      }
      summary.push({ table: 'products.current_stock (zeroed)', before: nonZero, after: 0 });
    }
  });
  tx();
  db.pragma('foreign_keys = ON');
  db.close();
  return { summary, skipped: false };
}

function printSummary(label, summary) {
  console.log(`\nâ”€â”€ ${label} â”€â”€`);
  if (!summary.length) { console.log('  (nothing to clear)'); return; }
  for (const s of summary) {
    console.log(`  ${s.table.padEnd(40)} ${String(s.before).padStart(8)}  â†’  ${s.after}`);
  }
}

// â”€â”€â”€ Run â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log(`\nKelete Factory Reset â€” ${dryRun ? 'DRY RUN' : 'LIVE'}`);
console.log(`Tenants dir : ${TENANTS_DIR}`);
console.log(`Backup dir  : ${dryRun ? '(none â€” dry run)' : BACKUP_DIR}`);

// Locate master.db
let masterDbPath = fs.existsSync(MASTER_DB) ? MASTER_DB
                 : fs.existsSync(MASTER_DB_ALT) ? MASTER_DB_ALT
                 : null;
if (masterDbPath) console.log(`Master DB   : ${masterDbPath}`);
else              console.log(`Master DB   : (not found â€” skipping HQ tables)`);

// Discover tenant DBs
const tenantDbs = fs.existsSync(TENANTS_DIR)
  ? fs.readdirSync(TENANTS_DIR).filter(f => f.endsWith('.db')).map(f => path.join(TENANTS_DIR, f))
  : [];
console.log(`Tenants     : ${tenantDbs.length ? tenantDbs.map(p => path.basename(p)).join(', ') : '(none found)'}\n`);

// Back everything up first (unless dry run)
if (!dryRun) {
  console.log('Backing upâ€¦');
  if (masterDbPath) { const b = backupDb(masterDbPath); if (b) console.log(`  âœ“ ${b}`); }
  for (const p of tenantDbs) { const b = backupDb(p); if (b) console.log(`  âœ“ ${b}`); }
}

// Reset master.db
if (masterDbPath) {
  const { summary } = resetDb(masterDbPath, MASTER_TABLES, { zeroStock: false });
  printSummary(`master.db  (${path.basename(masterDbPath)})`, summary);
}

// Reset each tenant DB
for (const p of tenantDbs) {
  const { summary, skipped } = resetDb(p, BRANCH_TABLES, { zeroStock: true });
  if (!skipped) printSummary(`tenant     (${path.basename(p)})`, summary);
}

console.log(`\n${dryRun ? 'DRY RUN complete â€” nothing was written.' : 'DONE. Backups above; restart PM2 when ready.'}\n`);
