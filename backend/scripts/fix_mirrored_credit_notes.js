/**
 * fix_mirrored_credit_notes.js — make HQ's copy of each GRN credit note match
 * the master record it was copied from.
 *
 * 2026-09-05. Generating a GRN wrote every credit note into two books:
 * master.db (hq_supplier_credit_notes) and HQ's own kelete.db
 * (supplier_credit_notes, which Account Payables and HQ Suppliers read).
 * The copy was not a copy - it recomputed the amount with a different
 * formula, taking the goods value and dropping both the line discount and
 * the VAT:
 *
 *     master  K5,684.50   = goods 5,188.30 - discount 0 + VAT 496.20
 *     HQ copy K5,188.30   = goods only
 *
 * It also minted its own credit-note number and sync_id, so nothing could
 * tell that the two rows were one credit note - and the GRN detail screen,
 * which lists both books, showed each ordinary credit twice.
 *
 * This script re-points HQ's copies onto their master originals: master's
 * number, master's sync_id, master's amount. Master is the authority - it is
 * what the GRN's stored payable and every total on screen were computed from,
 * so those figures do not move.
 *
 * Pairing: within one GRN, master rows and HQ rows are matched in insertion
 * order per reason. A leftover HQ row with no master partner is a genuinely
 * separate credit attached later and is left completely alone.
 *
 * Usage:
 *   node backend/scripts/fix_mirrored_credit_notes.js            # report only
 *   node backend/scripts/fix_mirrored_credit_notes.js --apply    # write
 */
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const MASTER = process.env.MASTER_DB_PATH || path.join(ROOT, 'master.db');
const HQ     = process.env.HQ_DB_PATH     || path.join(ROOT, 'backend', 'kelete.db');

const Database = require(path.join(ROOT, 'backend', 'node_modules', 'better-sqlite3'));
const APPLY = process.argv.includes('--apply');

const master = new Database(MASTER, { readonly: true });
const hq     = new Database(HQ, { readonly: !APPLY });

const money = (n) => 'K' + (parseFloat(n || 0)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Every GRN that has credit notes in HQ's book.
const grnIds = hq.prepare(
  `SELECT DISTINCT grn_sync_id FROM supplier_credit_notes
    WHERE grn_sync_id IS NOT NULL AND (deleted_at IS NULL OR deleted_at = '')`
).all().map(r => r.grn_sync_id);

const plan = [];
let untouched = 0, alreadyOk = 0;

for (const grnSyncId of grnIds) {
  const masterRows = master.prepare(
    `SELECT sync_id, credit_note_number, reason, amount, vat_amount
       FROM hq_supplier_credit_notes
      WHERE grn_sync_id = ? AND deleted_at IS NULL
      ORDER BY id ASC`
  ).all(grnSyncId);
  if (masterRows.length === 0) { untouched += 1; continue; }   // no original to match

  const hqRows = hq.prepare(
    `SELECT id, sync_id, credit_note_number, reason, amount
       FROM supplier_credit_notes
      WHERE grn_sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')
      ORDER BY id ASC`
  ).all(grnSyncId);

  // Match in order, within a reason. Anything left over stays as it is.
  const byReason = {};
  for (const m of masterRows) (byReason[m.reason] = byReason[m.reason] || []).push(m);

  for (const h of hqRows) {
    const queue = byReason[h.reason];
    if (!queue || queue.length === 0) { untouched += 1; continue; }
    const m = queue.shift();
    const sameId  = h.sync_id === m.sync_id;
    const sameNum = h.credit_note_number === m.credit_note_number;
    const sameAmt = Math.abs((parseFloat(h.amount) || 0) - (parseFloat(m.amount) || 0)) < 0.005;
    if (sameId && sameNum && sameAmt) { alreadyOk += 1; continue; }
    plan.push({
      grnSyncId, hqId: h.id, reason: h.reason,
      from: { num: h.credit_note_number, amt: parseFloat(h.amount) || 0, sync: h.sync_id },
      to:   { num: m.credit_note_number, amt: parseFloat(m.amount) || 0, sync: m.sync_id },
    });
  }
}

const grnNumberOf = (syncId) => {
  try {
    return master.prepare('SELECT grn_number FROM hq_grns WHERE sync_id = ?').get(syncId)?.grn_number
        || master.prepare('SELECT grn_number FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?').get(syncId)?.grn_number
        || syncId.slice(0, 8);
  } catch (_) { return syncId.slice(0, 8); }
};

console.log(`master : ${MASTER}`);
console.log(`hq     : ${HQ}`);
console.log(`GRNs with credit notes in HQ's book: ${grnIds.length}`);
console.log(`already correct: ${alreadyOk}   left alone (no master original): ${untouched}`);
console.log(`to correct: ${plan.length}\n`);

let delta = 0;
for (const p of plan) {
  delta += p.to.amt - p.from.amt;
  console.log(
    `${grnNumberOf(p.grnSyncId).padEnd(20)} ${p.reason.padEnd(14)} ` +
    `${p.from.num} ${money(p.from.amt).padStart(14)}  ->  ${p.to.num} ${money(p.to.amt).padStart(14)}`
  );
}
if (plan.length) {
  console.log(`\ncredit recorded in HQ's book moves by ${money(delta)} in total.`);
  console.log('Master is unchanged, and so is every GRN payable on screen - those were');
  console.log("already computed from master. This only makes HQ's copy agree.");
}

if (!APPLY) {
  console.log('\nReport only. Re-run with --apply to write.');
  process.exit(0);
}
if (plan.length === 0) { console.log('\nNothing to do.'); process.exit(0); }

const upd = hq.prepare(
  `UPDATE supplier_credit_notes
      SET sync_id = ?, credit_note_number = ?, amount = ?, synced = 0, updated_at = datetime('now')
    WHERE id = ?`
);
// Line items are keyed by credit_note_sync_id, so they follow the header.
const updItems = hq.prepare(
  `UPDATE supplier_credit_note_items
      SET credit_note_sync_id = ?, synced = 0, updated_at = datetime('now')
    WHERE credit_note_sync_id = ?`
);
const run = hq.transaction(() => {
  for (const p of plan) {
    updItems.run(p.to.sync, p.from.sync);
    upd.run(p.to.sync, p.to.num, p.to.amt, p.hqId);
  }
});
run();
console.log(`\nApplied to ${plan.length} row(s).`);
