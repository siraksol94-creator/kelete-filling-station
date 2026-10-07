#!/usr/bin/env node
// Retire the UAT/test products everywhere â€” HQ and every branch.
// 2026-09-01
//
//   node backend/scripts/retire_test_items.js            # report only
//   node backend/scripts/retire_test_items.js --apply    # do it
//
// WHY THIS IS NEEDED. Three of these were soft-deleted at HQ in the
// depot-items batch, by direct SQL. A direct database write fires no push, and
// middleware/hqPush.js's sweep only re-pushes LIVING rows â€” it has no way to
// tell a branch to forget something. So the branches never heard, and all four
// are still sellable at all fifteen. Branch product counts read 97 against
// HQ's 93 for exactly this reason.
//
// SOFT DELETE, not DELETE, matching routes/products.js: the row stays so any
// history referencing it still resolves, but it stops being sellable and stops
// appearing in pickers. A hard delete would orphan those references.
//
// synced = 0 is set on every row so the change propagates on the next sync
// rather than sitting on the VPS alone.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');

const CODES = ['SFT001', 'T04A-TEST-01', 'UAT7-001', 'UAT7-002'];

const ROOT = path.join(__dirname, '..', '..');
const targets = [];

// HQ first â€” it is the source the branches mirror from.
const hq = path.join(ROOT, 'backend', 'kelete.db');
if (fs.existsSync(hq)) targets.push({ label: 'HQ (backend/kelete.db)', file: hq });

const tenantsDir = path.join(ROOT, 'tenants');
if (fs.existsSync(tenantsDir)) {
  for (const f of fs.readdirSync(tenantsDir).filter(x => x.endsWith('.db')).sort())
    targets.push({ label: `branch ${f.replace(/\.db$/, '')}`, file: path.join(tenantsDir, f) });
}

if (targets.length === 0) {
  console.error('\nNo databases found. Run this from the repo root on the VPS.\n');
  process.exit(1);
}

console.log(`\n${APPLY ? 'MODE: APPLY' : 'MODE: dry run â€” nothing will be written'}`);
console.log(`Codes: ${CODES.join(', ')}\n`);

const q = CODES.map(() => '?').join(',');
let totalLive = 0, totalWithStock = 0;

for (const t of targets) {
  const db = new Database(t.file);
  let live = [];
  try {
    live = db.prepare(
      `SELECT code, name, COALESCE(current_stock, 0) AS stock
         FROM products WHERE code IN (${q}) AND deleted_at IS NULL ORDER BY code`
    ).all(...CODES);
  } catch (e) {
    console.log(`  ${t.label.padEnd(28)} skipped (${e.message})`);
    db.close();
    continue;
  }

  if (live.length === 0) {
    console.log(`  ${t.label.padEnd(28)} nothing live`);
    db.close();
    continue;
  }

  totalLive += live.length;
  const withStock = live.filter(r => Number(r.stock) !== 0);
  totalWithStock += withStock.length;

  console.log(`  ${t.label.padEnd(28)} ${live.length} live: ${live.map(r => r.code).join(', ')}`);
  // Stock on a test item means someone counted it as real. Retiring it hides
  // that stock rather than resolving it, so say so loudly instead of burying it.
  for (const r of withStock)
    console.log(`      *** ${r.code} holds ${r.stock} in stock â€” retiring it hides that stock`);

  if (APPLY) {
    const info = db.prepare(
      `UPDATE products
          SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
        WHERE code IN (${q}) AND deleted_at IS NULL`
    ).run(...CODES);
    console.log(`      retired ${info.changes}`);
  }
  db.close();
}

console.log(`\n  ${targets.length} database(s) checked Â· ${totalLive} live test item(s) found`);
if (totalWithStock) console.log(`  ${totalWithStock} of them hold stock â€” read the warnings above`);

if (!APPLY) {
  console.log('\n  Dry run. Re-run with --apply to retire them.');
  console.log('  Back up first:  cp -r tenants tenants.bak-$(date +%F)  &&  cp backend/kelete.db backend/kelete.db.bak-$(date +%F-testitems)\n');
} else {
  console.log('\n  Done. Branch product counts should now match HQ.\n');
}
