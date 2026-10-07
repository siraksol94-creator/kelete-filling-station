#!/usr/bin/env node
// Wipe ONE branch's transactional data, so a test branch can be reopened as a
// real one. 2026-09-01.
//
//   node backend/scripts/wipe_branch.js --branch=buseko              # report only
//   node backend/scripts/wipe_branch.js --branch=buseko --apply      # do it
//   ... --keep-users=sirak,dan1                                      # keep more
//
// It REFUSES to run if the keep list matches no user in this branch. Deleting
// every login would lock the branch out of its own web address with no way
// back in short of another database edit.
//
// WHY NOT factoryReset.js: that script walks EVERY tenant database. Running it
// now would destroy the opening balances just loaded into thirteen depots.
// This one touches exactly the branch named on the command line and refuses to
// run without one.
//
// WHAT IT KEEPS, and why each matters:
//   business_settings  â€” holds zra_last_invc_no. ZRA's invoice numbers are
//                        allocated as MAX(that column, highest number in
//                        orders) + 1 (vsdcClient.js allocInvcNo). Clearing
//                        orders drops the second half of that MAX to zero, so
//                        the column is the ONLY thing standing between the
//                        next sale and a number ZRA has already issued.
//                        Garden sits at 131; after this it must still say 131.
//   products           â€” the catalogue, prices and units_json
//   users              â€” ONLY the ones named by --keep-users (default: sirak).
//                        Every other login is deleted. Buseko carried 17 and
//                        Garden 6, all created during testing.
//   sync_config        â€” the tenant mapping login depends on
//   categories, main_categories, units, branches, pv_types, quick_items
//   zra_audit_log      â€” the record of what was transmitted. Kept deliberately:
//                        it is evidence, and it drives nothing operationally.
//
// WHAT IT CLEARS: sales, purchases, stock movements, cash, accounting, the
// capital/dividend/shareholder/loan ledgers, inter-branch transfers, and
// CUSTOMERS AND SUPPLIERS â€” because the receivable and the payable live on
// their balance columns, so keeping the party keeps the debt. Also resets
// products.current_stock to 0.
//
// Run compare_branches.js first. It lists every table in this branch beside a
// freshly loaded one, so anything holding test residue shows up even if nobody
// thought to put it on this list.
//
// AFTERWARDS the branch has a catalogue and no stock, exactly like the other
// depots before their opening balances were loaded. Load its real opening
// balance with a script like opening_<branch>.sql.
//
// SYNC WARNING: orders and stock_movements sync between the VPS and any
// Electron till. If this branch has a till, deleting here can either be undone
// by the till pushing its copy back, or propagate the deletion to the till.
// The report lists every device_id that has written to this branch â€” if more
// than one appears, stop and deal with the till first.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const branchArg = args.find(a => a.startsWith('--branch='));
if (!branchArg) {
  console.error('\nRefusing to run: name the branch.\n' +
                '  node backend/scripts/wipe_branch.js --branch=buseko\n');
  process.exit(1);
}
const slug = branchArg.split('=')[1].trim().toLowerCase();
if (!/^[a-z0-9_-]+$/.test(slug)) {
  console.error(`\nRefusing to run: "${slug}" is not a plausible branch slug.\n`);
  process.exit(1);
}

const dbPath = path.join(__dirname, '..', '..', 'tenants', `${slug}.db`);
if (!fs.existsSync(dbPath)) {
  // sqlite3 would happily CREATE this file. Refuse instead: a typo must not
  // silently produce an empty database and a "successful" wipe of nothing.
  console.error(`\nRefusing to run: ${dbPath} does not exist.\n` +
                `Check the slug â€” sqlite would create an empty file rather than complain.\n`);
  process.exit(1);
}

const keepArg = args.find(a => a.startsWith('--keep-users='));
const KEEP_USERS = (keepArg ? keepArg.split('=')[1] : 'sirak')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

const db = new Database(dbPath);

// Which logins survive. Matched on email, because that is the column
// routes/auth.js authenticates against â€” the form calls it "username".
function userSplit() {
  try {
    const all = db.prepare(
      'SELECT id, email, first_name, last_name, role FROM users WHERE deleted_at IS NULL ORDER BY id'
    ).all();
    const keep = all.filter(u => KEEP_USERS.includes(String(u.email || '').toLowerCase()));
    return { all, keep, drop: all.filter(u => !keep.includes(u)) };
  } catch (_) {
    return { all: [], keep: [], drop: [] };
  }
}

// Taken from factoryReset.js's branch-side list rather than from
// clear-test-data.js, which is a much shorter local-testing list and misses
// the ledgers. The user caught that: a test branch also carries ACCOUNTS
// RECEIVABLE on customers.balance, plus payables, capital, dividends,
// shareholders, loans and inter-branch transfers. None of those are
// transactions in the obvious sense, and all of them outlive a naive wipe.
//
// Tables absent from a given database are skipped silently â€” Kelete has never
// had cash_deposits or stock_transfer_variances, and the hq_* tables belong to
// the HQ database, so they simply will not be found here.
const CLEAR = [
  // sales
  'order_payment_edits',
  'order_items', 'orders',
  'sales_return_items', 'sales_returns',
  'discount_requests',
  'debit_notes',
  // purchases
  'grn_items', 'grn',
  'siv_items', 'siv',
  'empty_return_items', 'empty_returns',
  'customer_empty_returns',
  // Vouchers carry qty_remaining and stay claimable until spent. A voucher a
  // trainee issued is redeemable for real stock, so these cannot survive.
  'empty_vouchers',
  'supplier_credit_note_items', 'supplier_credit_notes',
  // money
  'customer_payments', 'ap_payments',
  'cash_receipts', 'payment_vouchers',
  'cash_book', 'cash_reports', 'cash_transfers', 'currency_exchanges',
  'cash_deposits',
  'daily_actual_balance', 'daily_cost_snapshot', 'daily_profit_summary',
  // stock
  'stock_movements',
  'stock_reconciliation_items', 'stock_reconciliations',
  'stock_count_items', 'stock_count_sessions',
  'stock_adjustments',
  'transfer_variances', 'stock_transfers',
  'production_inputs', 'production_outputs', 'production',
  // ledgers â€” the ones easy to forget
  'loan_transactions', 'loans',
  'shareholders', 'dividend_account', 'capital_account',
  // parties. Their BALANCE is the receivable/payable, so leaving the rows
  // behind leaves the debt behind with them.
  'customers',
  'suppliers',
  // ZRA working data. Found by compare_branches.js against a clean branch â€”
  // none of it was on the original list.
  //   zra_pending_purchases  the T06A purchase queue; test pulls sitting in it
  //   zra_supplier_item_map  supplier->item mappings, orphaned once suppliers go
  // DELIBERATELY NOT CLEARED: zra_codes and zra_notices are reference data
  // pulled from ZRA, and zra_sync_state holds the per-endpoint pull cursors.
  // Keeping the cursors is what stops the deleted test purchases being pulled
  // straight back down on the next sync.
  'zra_pending_purchases',
  'zra_supplier_item_map',
  // HQ-side, present only if this database ever acted as HQ
  'hq_grn_items', 'hq_grns',
  'hq_supplier_credit_note_items', 'hq_supplier_credit_notes',
  'hq_confirmed_grn_totals',
  'hq_purchase_receipt_extras',
  'hq_purchase_items', 'hq_purchases',
  'hq_supplier_payments', 'hq_suppliers',
  'hq_damages',
];

const count = (t) => {
  try { return db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; }
  catch { return null; }                       // table absent on this DB
};

console.log(`\n${dbPath}`);
console.log(APPLY ? 'MODE: APPLY â€” rows will be deleted\n' : 'MODE: dry run â€” nothing will be written\n');

// â”€â”€ what is here â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log('--- transactional rows ---');
let total = 0;
for (const t of CLEAR) {
  const n = count(t);
  if (n === null) continue;
  if (n > 0) { console.log(`  ${t.padEnd(28)} ${String(n).padStart(6)}`); total += n; }
}
console.log(`  ${'TOTAL'.padEnd(28)} ${String(total).padStart(6)}`);

// â”€â”€ logins â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const U = userSplit();
console.log('\n--- logins ---');
if (U.all.length === 0) {
  console.log('  no users table, or no live users');
} else {
  for (const u of U.keep) console.log(`  KEEP    ${String(u.email).padEnd(14)} ${u.first_name} ${u.last_name} (${u.role})`);
  for (const u of U.drop) console.log(`  delete  ${String(u.email).padEnd(14)} ${u.first_name} ${u.last_name} (${u.role})`);
  console.log(`  keeping ${U.keep.length} of ${U.all.length} (--keep-users=${KEEP_USERS.join(',')})`);
}

// â”€â”€ the ZRA position â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log('\n--- ZRA ---');
let zra = null;
try {
  zra = db.prepare(
    'SELECT zra_enabled, zra_env, zra_tpin, zra_bhf_id, zra_last_invc_no FROM business_settings LIMIT 1'
  ).get();
} catch (_) {}
if (zra) {
  console.log(`  env ${zra.zra_env || '(none)'} Â· tpin ${zra.zra_tpin || 'â€”'} Â· bhf ${zra.zra_bhf_id || 'â€”'}`);
  console.log(`  zra_last_invc_no = ${zra.zra_last_invc_no ?? '(blank)'}   <- MUST be unchanged afterwards`);
  let sent = 0;
  try { sent = db.prepare('SELECT COUNT(*) n FROM orders WHERE zra_cis_invc_no IS NOT NULL').get().n; } catch (_) {}
  console.log(`  orders already transmitted: ${sent}`);
  if (sent > 0 && String(zra.zra_env).toLowerCase() !== 'sandbox') {
    console.log('  *** NOT SANDBOX. Those invoices are real fiscal records at ZRA and');
    console.log('  *** deleting them here does not recall them. Stop and take advice.');
  }
} else {
  console.log('  no business_settings row found');
}

// â”€â”€ who has been writing here â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log('\n--- devices that have written to this branch ---');
let devices = [];
try {
  devices = db.prepare(`
    SELECT COALESCE(device_id, '(null)') AS device_id, COUNT(*) AS n
      FROM orders GROUP BY device_id ORDER BY n DESC`).all();
} catch (_) {}
if (devices.length === 0) console.log('  none');
for (const d of devices) console.log(`  ${d.device_id.padEnd(40)} ${d.n}`);
if (devices.length > 1) {
  console.log('  *** MORE THAN ONE DEVICE. If one is an Electron till it holds its own');
  console.log('  *** copy of these orders. Deal with the till before wiping, or the');
  console.log('  *** rows come back on the next sync â€” or the deletion reaches the till.');
}

if (!APPLY) {
  console.log(`\nDry run. Re-run with --apply to delete ${total} row(s).`);
  console.log('Back the file up first:');
  console.log(`  cp tenants/${slug}.db tenants/${slug}.db.bak-$(date +%F-wipe)\n`);
  process.exit(0);
}

// A branch with no login is a branch nobody can open, and the way back in is
// another database edit. Refuse rather than create that.
if (U.all.length > 0 && U.keep.length === 0) {
  console.error(`\nRefusing to run: --keep-users=${KEEP_USERS.join(',')} matches none of the`);
  console.error(`${U.all.length} login(s) in this branch, so every one would be deleted.`);
  console.error(`Emails here: ${U.all.map(u => u.email).join(', ')}\n`);
  process.exit(1);
}

// â”€â”€ the wipe â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const before = zra ? zra.zra_last_invc_no : null;

db.pragma('foreign_keys = OFF');
const tx = db.transaction(() => {
  for (const t of CLEAR) {
    if (count(t) === null) continue;
    db.prepare(`DELETE FROM ${t}`).run();
    try { db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(t); } catch (_) {}
  }
  // current_stock is a cache over stock_movements, which are now gone. Left
  // alone it would keep reporting stock the branch cannot account for.
  db.prepare(`UPDATE products SET current_stock = 0, synced = 0, updated_at = datetime('now')
               WHERE deleted_at IS NULL`).run();

  // Logins. Hard delete, matching the rest of the wipe â€” the rows that
  // referenced them (orders.created_by and friends) have just gone too.
  if (U.drop.length) {
    const del = db.prepare('DELETE FROM users WHERE id = ?');
    for (const u of U.drop) del.run(u.id);
  }
});
tx();
db.pragma('foreign_keys = ON');

console.log('\n--- after ---');
let left = 0;
for (const t of CLEAR) { const n = count(t); if (n) { console.log(`  ${t}: ${n} REMAIN`); left += n; } }
console.log(left === 0 ? '  all transactional tables empty' : `  ${left} row(s) survived â€” investigate`);

let after = null;
try { after = db.prepare('SELECT zra_last_invc_no FROM business_settings LIMIT 1').get()?.zra_last_invc_no; } catch (_) {}
console.log(`\n  zra_last_invc_no before ${before ?? '(blank)'} -> after ${after ?? '(blank)'}` +
            (String(before) === String(after) ? '   OK, preserved' : '   *** CHANGED â€” STOP ***'));

const prods = db.prepare('SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL').get().n;
const remaining = userSplit();
console.log(`  catalogue kept: ${prods} products`);
console.log(`  logins left: ${remaining.all.length ? remaining.all.map(u => u.email).join(', ') : 'NONE â€” THIS BRANCH CANNOT BE OPENED'}`);
console.log('\nBranch is now catalogue-only with zero stock. Load its opening balance next.\n');
