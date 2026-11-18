/**
 * whyCnPrice.js — where did a credit note line's price come from?
 *
 * 2026-09-18. SCN-2026-09D536EE is linked to invoice A70642, which bills
 * BLACK LABEL 750mls at K286.90, but the note carries K252.28. This prints
 * every figure that could have produced that number, side by side, so the
 * answer is read rather than guessed:
 *
 *   1. what the note actually stores (the figure on the screen)
 *   2. the linked GRN's own line     — what the form fills when an invoice
 *                                      is picked (total_price / quantity)
 *   3. the last-invoice fallback     — what it fills when none is picked
 *   4. every other GRN of that item  — so a matching price names its source
 *
 * READ ONLY. It opens the databases readonly and writes nothing.
 *
 * Usage, from /var/www/kelete-pos-tenant:
 *   node backend/scripts/whyCnPrice.js SCN-2026-09D536EE
 *   node backend/scripts/whyCnPrice.js SCN-2026-09D536EE "BLACK LABEL"
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..', '..');
const open = (p) => {
  if (!fs.existsSync(p)) return null;
  try { return new Database(p, { readonly: true, fileMustExist: true }); }
  catch (e) { console.log(`  (could not open ${p}: ${e.message})`); return null; }
};

const cnNumber = (process.argv[2] || '').trim();
const nameLike = (process.argv[3] || '').trim();
if (!cnNumber) {
  console.log('Usage: node backend/scripts/whyCnPrice.js <CREDIT-NOTE-NUMBER> [product name]');
  process.exit(1);
}

const master = open(process.env.MASTER_DB_PATH || path.join(ROOT, 'master.db'));
const hqBook = open(process.env.DB_PATH || path.join(ROOT, 'backend', 'kelete.db'));

const money = (n) => (n === null || n === undefined || n === '' ? '—' : `K${Number(n).toFixed(2)}`);
const head = (s) => console.log(`\n${s}\n${'─'.repeat(s.length)}`);

// ── 1. The note itself. It lives in HQ's book when a depot raised it, or in
//      master.db when it was minted from a GRN — look in both and say which.
head(`1. The credit note — ${cnNumber}`);
let note = null, noteItems = [], noteWhere = '';
if (hqBook) {
  try {
    note = hqBook.prepare(
      `SELECT *, 'HQ book (backend/kelete.db)' AS src FROM supplier_credit_notes
        WHERE credit_note_number = ? AND deleted_at IS NULL`).get(cnNumber) || null;
    if (note) {
      noteWhere = note.src;
      noteItems = hqBook.prepare(
        `SELECT i.quantity, i.unit_value, i.total_price, p.name AS product_name
           FROM supplier_credit_note_items i
           LEFT JOIN products p ON p.id = i.product_id
          WHERE i.credit_note_id = ? AND (i.deleted_at IS NULL OR i.deleted_at = '')`).all(note.id);
    }
  } catch (e) { console.log('  (HQ book:', e.message + ')'); }
}
if (!note && master) {
  try {
    note = master.prepare(
      `SELECT *, 'master.db (minted from a GRN)' AS src FROM hq_supplier_credit_notes
        WHERE credit_note_number = ? AND deleted_at IS NULL`).get(cnNumber) || null;
    if (note) {
      noteWhere = note.src;
      noteItems = master.prepare(
        `SELECT quantity, unit_value, total_price, product_name
           FROM hq_supplier_credit_note_items WHERE credit_note_sync_id = ?`).all(note.sync_id);
    }
  } catch (e) { console.log('  (master.db:', e.message + ')'); }
}
if (!note) { console.log('  Not found in either database.'); process.exit(0); }

const grnSyncId = note.grn_sync_id || note.proposed_grn_sync_id || null;
console.log(`  found in     : ${noteWhere}`);
console.log(`  date         : ${note.date}`);
console.log(`  created_at   : ${note.created_at || '—'}   by: ${note.created_by_name || note.created_by || '—'}`);
console.log(`  reference    : ${note.reference || '—'}`);
console.log(`  amount       : ${money(note.amount)}`);
console.log(`  grn_sync_id  : ${note.grn_sync_id || '—'}`);
console.log(`  proposed     : ${note.proposed_grn_sync_id || '—'}`);
console.log(`  raised_by    : ${note.raised_by_branch || note.branch_slug || '—'}`);
console.log('  lines stored on the note:');
for (const i of noteItems) {
  console.log(`    ${String(i.product_name || '?').padEnd(28)} qty ${String(i.quantity).padStart(6)}  @ ${money(i.unit_value)}  = ${money(i.total_price)}`);
}

// ── 2. The GRN it is linked to.
head('2. The invoice it is linked to — what the form fills when an invoice IS picked');
let grn = null;
if (grnSyncId && master) {
  try {
    grn = master.prepare(
      `SELECT id, grn_number, supplier_invoice_number, branch_slug, date
         FROM hq_grns WHERE sync_id = ? AND deleted_at IS NULL`).get(grnSyncId) || null;
  } catch (e) { console.log('  (', e.message, ')'); }
}
if (!grn) {
  console.log(grnSyncId ? '  The linked GRN was not found in master.db.' : '  The note has no GRN link at all.');
} else {
  console.log(`  ${grn.grn_number} · invoice ${grn.supplier_invoice_number || '—'} · ${grn.branch_slug} · ${grn.date}`);
  const lines = master.prepare(
    `SELECT product_name, unit, SUM(quantity) AS qty, SUM(total_price) AS total
       FROM hq_grn_items WHERE grn_sync_id = ? AND quantity > 0
      GROUP BY product_sync_id, unit, product_name`).all(grnSyncId);
  for (const l of lines) {
    if (nameLike && !String(l.product_name || '').toLowerCase().includes(nameLike.toLowerCase())) continue;
    console.log(`    ${String(l.product_name).padEnd(28)} qty ${String(l.qty).padStart(6)} ${String(l.unit || '').padEnd(5)}` +
                ` total ${money(l.total)}  ->  per ${l.unit || 'unit'} ${money(l.total / (l.qty || 1))}`);
  }
}

// ── 3. The fallback the form uses when no invoice is picked: the most recent
//      GRN of that item at that branch. Same query the app runs.
const branch = grn?.branch_slug || note.raised_by_branch || note.branch_slug || null;
head(`3. The fallback — the LAST invoice for this item at ${branch || '(branch unknown)'}`);
if (!master || !branch) {
  console.log('  (skipped — no master.db or no branch)');
} else {
  const rows = master.prepare(`
    SELECT product_name, unit, unit_price, date, grn_number, invoice_number FROM (
      SELECT TRIM(i.product_name) AS product_name, i.unit,
             i.total_price / i.quantity AS unit_price,
             g.date, g.grn_number, g.supplier_invoice_number AS invoice_number,
             ROW_NUMBER() OVER (PARTITION BY COALESCE(i.product_sync_id, LOWER(TRIM(i.product_name)))
                                ORDER BY g.date DESC, g.id DESC, i.id DESC) AS rn
        FROM hq_grn_items i JOIN hq_grns g ON g.id = i.grn_id
       WHERE g.deleted_at IS NULL AND i.quantity > 0 AND g.branch_slug = ?
    ) WHERE rn = 1`).all(branch);
  for (const r of rows) {
    if (nameLike && !String(r.product_name || '').toLowerCase().includes(nameLike.toLowerCase())) continue;
    console.log(`    ${String(r.product_name).padEnd(28)} ${money(r.unit_price)} per ${r.unit || 'unit'}` +
                `  (from ${r.grn_number} · inv ${r.invoice_number || '—'} · ${r.date})`);
  }
}

// ── 4. Every delivery of that item, so whichever one holds 252.28 is named.
head(`4. Every delivery of ${nameLike || 'the note\'s items'} at ${branch || '(branch unknown)'} — which one holds the price on the note?`);
if (!master || !branch) {
  console.log('  (skipped)');
} else {
  const names = nameLike ? [nameLike] : noteItems.map(i => i.product_name).filter(Boolean);
  const onNote = new Map(noteItems.map(i => [String(i.product_name || '').trim().toLowerCase(), Number(i.unit_value)]));
  for (const n of names) {
    const rows = master.prepare(`
      SELECT g.date, g.grn_number, g.supplier_invoice_number AS inv, i.unit,
             SUM(i.quantity) AS qty, SUM(i.total_price) AS total
        FROM hq_grn_items i JOIN hq_grns g ON g.id = i.grn_id
       WHERE g.deleted_at IS NULL AND i.quantity > 0 AND g.branch_slug = ?
         AND LOWER(TRIM(i.product_name)) LIKE ?
       GROUP BY g.id, i.unit
       ORDER BY g.date DESC, g.id DESC`).all(branch, `%${String(n).trim().toLowerCase()}%`);
    console.log(`  ${n}:`);
    if (!rows.length) console.log('    (no deliveries found)');
    for (const r of rows) {
      const per = r.total / (r.qty || 1);
      // Flag the delivery whose price matches what the note stored.
      const want = [...onNote.entries()].find(([k]) => String(n).trim().toLowerCase().includes(k) || k.includes(String(n).trim().toLowerCase()));
      const hit = want && Math.abs(per - want[1]) < 0.01 ? '   <<< this is the price on the note' : '';
      console.log(`    ${r.date}  ${String(r.grn_number).padEnd(22)} inv ${String(r.inv || '—').padEnd(10)}` +
                  ` qty ${String(r.qty).padStart(6)} ${String(r.unit || '').padEnd(5)} per ${r.unit || 'unit'} ${money(per)}${hit}`);
    }
  }
}

console.log('\nDone. Nothing was written.\n');
