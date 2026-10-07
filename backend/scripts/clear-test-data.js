// One-shot cleanup for local testing.
// Wipes transactional data; keeps master data (products / categories / units / suppliers / customers / users / settings).
const path = require('path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, '..', 'kelete.db'));
db.pragma('foreign_keys = OFF');

const tablesToClear = [
  // sales
  'order_items', 'orders',
  'sales_return_items', 'sales_returns',
  // purchases
  'grn_items', 'grn',
  'siv_items', 'siv',
  // payments
  'customer_payments', 'ap_payments',
  'cash_receipts', 'payment_vouchers',
  // stock
  'stock_movements',
  'stock_reconciliation_items', 'stock_reconciliations',
  'stock_count_items', 'stock_count_sessions',
  'stock_adjustments',
  // production
  'production_inputs', 'production_outputs', 'production',
  // ledger / reports
  'cash_book', 'cash_reports',
  'daily_actual_balance', 'daily_cost_snapshot', 'daily_profit_summary',
];

const before = {};
for (const t of tablesToClear) {
  try { before[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; }
  catch { before[t] = 'â€”'; }
}

const tx = db.transaction(() => {
  for (const t of tablesToClear) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
      db.prepare(`DELETE FROM sqlite_sequence WHERE name=?`).run(t);
    } catch (e) {
      console.warn(`skip ${t}: ${e.message}`);
    }
  }
});
tx();

db.pragma('foreign_keys = ON');

console.log('--- Cleared (rows removed) ---');
for (const t of tablesToClear) console.log(t.padEnd(35), before[t]);
console.log('\nMaster data kept: products, categories, main_categories, units, suppliers, customers, users, business_settings, pv_types, quick_items, licenses, sync_config.');
db.close();
