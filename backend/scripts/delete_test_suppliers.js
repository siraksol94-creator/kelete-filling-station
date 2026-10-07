/**
 * delete_test_suppliers.js â€” remove test suppliers and everything hanging off
 * them, keeping only the real ones.
 *
 * 2026-09-05. Red Sea buys from three suppliers. The rest of the HQ Suppliers
 * list is test data left from setup, and it is not harmless: all three AP
 * payments on the books - K768,674.86 - belong to test suppliers, so Total
 * Paid and the Cash Book are reporting money that was never paid to anybody.
 *
 * KEEP is the whole safety model: anything not named there is deleted, so the
 * list is deliberately explicit rather than a pattern like "MR." or "TEST".
 *
 * Deletes the way the app deletes - stamping deleted_at - because every read
 * in the codebase already filters on it. That means the Cash Book, AP and the
 * supplier ledger all drop these rows the moment this runs, and a mistake can
 * be undone by clearing the column. A table with no deleted_at column is
 * REPORTED AND SKIPPED, never hard-deleted behind your back.
 *
 * Scans HQ's kelete.db and master.db. Branch tenant databases are NOT touched;
 * these suppliers are HQ-side only (AP is HQ-only at Red Sea).
 *
 * Usage:
 *   node backend/scripts/delete_test_suppliers.js            # report only
 *   node backend/scripts/delete_test_suppliers.js --apply    # soft-delete
 */
const path = require('path');

const KEEP = [
  'NATIONAL BREWERIES',
  'ZAMBIAN BREWERIES',
  'PEPSI',
];

const ROOT   = path.join(__dirname, '..', '..');
const MASTER = process.env.MASTER_DB_PATH || path.join(ROOT, 'master.db');
const HQ     = process.env.HQ_DB_PATH     || path.join(ROOT, 'backend', 'kelete.db');

const Database = require(path.join(ROOT, 'backend', 'node_modules', 'better-sqlite3'));
const APPLY = process.argv.includes('--apply');

const money = (n) => 'K' + (parseFloat(n || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const norm  = (s) => String(s || '').trim().toUpperCase();

const hq     = new Database(HQ, { readonly: !APPLY });
const master = new Database(MASTER, { readonly: !APPLY });

// â”€â”€ who goes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const all = hq.prepare(
  `SELECT id, sync_id, name, tpin FROM suppliers
    WHERE deleted_at IS NULL AND COALESCE(status,'Active') != 'Deleted'
    ORDER BY name COLLATE NOCASE`
).all();

const keepSet = new Set(KEEP.map(norm));
const doomed  = all.filter(s => !keepSet.has(norm(s.name)));
const kept    = all.filter(s =>  keepSet.has(norm(s.name)));

console.log(`hq     : ${HQ}`);
console.log(`master : ${MASTER}\n`);
console.log('KEEPING:');
for (const s of kept) console.log(`   ${s.name}`);
const missing = KEEP.filter(k => !all.some(s => norm(s.name) === norm(k)));
if (missing.length) {
  console.log(`\n!! Not found in suppliers, check the spelling before applying: ${missing.join(', ')}`);
}
console.log('\nDELETING:');
for (const s of doomed) console.log(`   ${s.name}${s.tpin ? `  (TPIN ${s.tpin})` : ''}`);
if (doomed.length === 0) { console.log('   nothing'); process.exit(0); }

const ids   = doomed.map(s => s.id);
const syncs = doomed.map(s => s.sync_id).filter(Boolean);
const names = doomed.map(s => norm(s.name));

// â”€â”€ what hangs off them â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Found by scanning for supplier columns rather than a hand-written list, so a
// table nobody remembered cannot be quietly left behind.
function scan(db, label) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all().map(r => r.name);

  const hits = [];
  for (const t of tables) {
    if (t === 'suppliers') continue;
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
    const where = [];
    if (cols.includes('supplier_id')      && ids.length)   where.push(`supplier_id IN (${ids.join(',')})`);
    if (cols.includes('supplier_sync_id') && syncs.length) where.push(`supplier_sync_id IN (${syncs.map(x => `'${x}'`).join(',')})`);
    if (cols.includes('supplier_name')    && names.length) where.push(`UPPER(TRIM(supplier_name)) IN (${names.map(n => `'${n.replace(/'/g, "''")}'`).join(',')})`);
    if (where.length === 0) continue;

    const live = cols.includes('deleted_at') ? ` AND (deleted_at IS NULL OR deleted_at = '')` : '';
    const amountCol = ['amount', 'total_amount', 'final_payable'].find(c => cols.includes(c));
    const row = db.prepare(
      `SELECT COUNT(*) AS n${amountCol ? `, COALESCE(SUM(${amountCol}),0) AS total` : ''}
         FROM "${t}" WHERE (${where.join(' OR ')})${live}`
    ).get();
    if (row.n > 0) hits.push({ db: label, table: t, count: row.n, total: row.total, where, soft: cols.includes('deleted_at') });
  }
  return hits;
}

const hits = [...scan(hq, 'kelete.db'), ...scan(master, 'master.db')];

console.log('\nRows attached to them:');
if (hits.length === 0) console.log('   none');
for (const h of hits) {
  console.log(
    `   ${h.db.padEnd(11)} ${h.table.padEnd(28)} ${String(h.count).padStart(5)} row(s)` +
    (h.total != null ? `  ${money(h.total).padStart(16)}` : '') +
    (h.soft ? '' : '   << NO deleted_at COLUMN - WILL BE LEFT ALONE')
  );
}

const payRow = hits.find(h => h.table === 'ap_payments');
if (payRow) {
  console.log(`\n   Note: removing these drops ${money(payRow.total)} from Total Paid and from the`);
  console.log('   Cash Book, which reads ap_payments live. That is the point - the money was');
  console.log('   never actually paid - but the cash position will move.');
}

if (!APPLY) {
  console.log('\nReport only. Re-run with --apply to delete.');
  process.exit(0);
}

// â”€â”€ delete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const stamp = (db, label) => {
  let n = 0;
  for (const h of hits.filter(x => x.db === label && x.soft)) {
    const r = db.prepare(
      `UPDATE "${h.table}" SET deleted_at = datetime('now')
        WHERE (${h.where.join(' OR ')}) AND (deleted_at IS NULL OR deleted_at = '')`
    ).run();
    n += r.changes;
    console.log(`   ${label} ${h.table}: ${r.changes}`);
  }
  return n;
};

console.log('\nDeletingâ€¦');
let total = 0;
total += hq.transaction(() => stamp(hq, 'kelete.db'))();
total += master.transaction(() => stamp(master, 'master.db'))();

const supUpd = hq.prepare(
  `UPDATE suppliers SET deleted_at = datetime('now'), status = 'Deleted', synced = 0,
          updated_at = datetime('now')
    WHERE id = ?`
);
hq.transaction(() => { for (const s of doomed) supUpd.run(s.id); })();
console.log(`   kelete.db suppliers: ${doomed.length}`);
console.log(`\nDone. ${total} attached row(s) + ${doomed.length} supplier(s) marked deleted.`);
const skipped = hits.filter(h => !h.soft);
if (skipped.length) {
  console.log('\nLeft alone (no deleted_at column): ' + skipped.map(h => `${h.db}/${h.table}`).join(', '));
  console.log('Tell me if these should go too and I will handle them explicitly.');
}
