/**
 * livingstone_ob_repair.js — finish and correct the Livingstone opening-balance
 * load of 2026-09-09.
 *
 * The load itself went in by hand, pasted into sqlite3 over a remote session.
 * A line was dropped in transit with no error of any kind, and a second fault
 * was already on the books from the Elndongwe load before it. Neither shows on
 * screen; both show in the totals. Hence a script: it reads what is actually
 * there, says what it would change, and changes nothing without --apply.
 *
 *   1  SAFARI PAR EXELLENCE
 *      Its ledger row and its payment were both lost in the paste. Opening
 *      balance is still 12,592 (the pre-load figure) instead of 35,009, and
 *      the 22,417 paid on 2 Sept is missing entirely. Every other customer in
 *      that load went in correctly.
 *
 *   2  Elndongwe Enterprises — K921,178 of cash counted twice
 *      Its two payments each carry TWO receipts: CR-2026-07E626-0006/0007 and
 *      CR-BACKFILL-000002/000003, same amounts, same dates. The Cash Book
 *      reads cash_receipts, so that money is in it twice. The BACKFILL pair
 *      goes, because the survivors have to be the ones the app can number
 *      from: generateNumber() self-heals off `CR-<year>-<shortcode>-%`, which
 *      the BACKFILL numbers do not match. The payments currently point AT the
 *      BACKFILL rows, so the link moves first and the delete happens second —
 *      the other order leaves a payment pointing at nothing.
 *
 *   3  SPAR / "Spa Livingstone" — the same 56,079 on two accounts
 *      The load searched for '%spar%', which does not match "Spa Livingstone",
 *      so it created a second account rather than updating the one already
 *      there. Which of them is real is a question about Red Sea's customers,
 *      not about the data, so this one only runs when told:
 *
 *        --spar=existing   keep "Spa Livingstone" with 56,079, remove "SPAR"
 *        --spar=rename     remove "SPAR", rename "Spa Livingstone" to "SPAR"
 *        (omitted)         report the pair and change neither
 *
 * Deletes are soft — deleted_at, the way the app deletes — so every read in
 * the codebase drops the row and a mistake is undone by clearing the column.
 *
 * Safe to run twice: every step checks the state it is about to create and
 * skips if it is already there.
 *
 * Usage:
 *   node backend/scripts/livingstone_ob_repair.js                    # report
 *   node backend/scripts/livingstone_ob_repair.js --apply
 *   node backend/scripts/livingstone_ob_repair.js --apply --spar=existing
 */
const { randomUUID } = require('crypto');
const { getTenantDb } = require('../config/tenantDb');

const SLUG  = process.env.OB_SLUG || 'livingstone';
const APPLY = process.argv.includes('--apply');
const SPAR  = (process.argv.find(a => a.startsWith('--spar=')) || '').split('=')[1] || null;

// The figures from the manual ledger, for the one customer that missed them.
const SAFARI     = 'SAFARI PAR EXELLENCE';
const SAFARI_OB  = 35009.00;
const SAFARI_PAY = { date: '2026-09-02', amount: 22417.00 };

const REF   = 'Pre-system settlement';
const NOTES = 'Recorded from the manual ledger';

const money = (n) => 'K' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const log   = (...a) => console.log(...a);

function main() {
  const db = getTenantDb(SLUG);
  if (!db) { console.error(`[repair] no database for "${SLUG}"`); process.exit(1); }

  if (SPAR && !['existing', 'rename'].includes(SPAR)) {
    console.error(`[repair] --spar must be "existing" or "rename", got "${SPAR}"`);
    process.exit(1);
  }

  const planned = [];
  log(`\n=== Livingstone opening-balance repair ${APPLY ? '(APPLYING)' : '(report only)'} ===\n`);

  planSafari(db, planned);
  planDuplicateReceipts(db, planned);
  planSpar(db, planned);

  log('');
  if (planned.length === 0) { log('Nothing to change.\n'); return; }
  if (!APPLY) { log(`${planned.length} change(s) ready. Re-run with --apply to write them.\n`); return; }

  db.transaction(() => { for (const step of planned) step(); })();
  log(`${planned.length} change(s) applied.\n`);
  report(db);
}

// ── 1. the customer the paste dropped ──────────────────────────────────────
function planSafari(db, planned) {
  const c = db.prepare(
    `SELECT id, sync_id, name, opening_balance, tenant_id, branch_id, device_id
       FROM customers WHERE name = ? AND deleted_at IS NULL`
  ).get(SAFARI);

  if (!c) { log(`1. Safari      SKIP — no customer named "${SAFARI}"`); return; }

  const obWrong = Math.abs((c.opening_balance || 0) - SAFARI_OB) > 0.005;
  const already = db.prepare(
    `SELECT id FROM customer_payments
      WHERE customer_id = ? AND reference = ? AND payment_date = ? AND deleted_at IS NULL`
  ).get(c.id, REF, SAFARI_PAY.date);

  log(`1. Safari      opening balance ${money(c.opening_balance)}`
      + (obWrong ? ` -> ${money(SAFARI_OB)}` : '   (already correct)'));
  log(`               payment ${SAFARI_PAY.date} ${money(SAFARI_PAY.amount)}`
      + (already ? '   (already recorded)' : ' -> will be added, with its cash receipt'));

  if (obWrong) planned.push(() => db.prepare(
    `UPDATE customers SET opening_balance = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?`
  ).run(SAFARI_OB, c.id));

  if (already) return;

  planned.push(() => {
    // created_by has a foreign key to users, so it is taken from a payment
    // that already exists rather than assumed to be 1.
    const uid = db.prepare(
      `SELECT created_by FROM customer_payments WHERE reference = ? AND deleted_at IS NULL LIMIT 1`
    ).get(REF)?.created_by || null;

    const payId = db.prepare(`
      INSERT INTO customer_payments (customer_id, customer_sync_id, amount, cash_amount,
                                     payment_date, payment_method, reference, notes, created_by,
                                     sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,'Cash',?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(c.id, c.sync_id, SAFARI_PAY.amount, SAFARI_PAY.amount,
           SAFARI_PAY.date, REF, NOTES, uid, randomUUID(),
           c.tenant_id, c.branch_id, c.device_id).lastInsertRowid;

    const crSync = randomUUID();
    db.prepare(`
      INSERT INTO cash_receipts (receipt_number, received_from, description, payment_method, amount,
                                 cash_amount, bank_amount, momo_amount, usd_amount, fra_amount, k_amount,
                                 date, created_by, sync_id, tenant_id, branch_id, device_id, synced,
                                 source_type, source_customer_payment_id, created_at, updated_at)
      VALUES (?,?,?,'Cash',?,?,0,0,0,0,0,?,?,?,?,?,?,0,'ar_payment',?,datetime('now'),datetime('now'))
    `).run(nextReceiptNumber(db), c.name, 'AR Payment — ' + NOTES, SAFARI_PAY.amount,
           SAFARI_PAY.amount, SAFARI_PAY.date, uid, crSync,
           c.tenant_id, c.branch_id, c.device_id, payId);

    db.prepare(
      `UPDATE customer_payments SET cash_receipt_sync_id = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?`
    ).run(crSync, payId);
  });
}

// ── 2. one payment, two receipts ───────────────────────────────────────────
function planDuplicateReceipts(db, planned) {
  const twin = `
    SELECT k.sync_id, k.receipt_number FROM cash_receipts k
     WHERE k.source_customer_payment_id = cr.source_customer_payment_id
       AND k.id <> cr.id AND k.deleted_at IS NULL
       AND k.receipt_number NOT LIKE 'CR-BACKFILL-%'
     ORDER BY k.id LIMIT 1`;

  const dupes = db.prepare(`
    SELECT cr.id, cr.receipt_number, cr.amount, cr.source_customer_payment_id AS pid,
           (SELECT sync_id        FROM (${twin})) AS keep_sync,
           (SELECT receipt_number FROM (${twin})) AS keep_number
      FROM cash_receipts cr
     WHERE cr.receipt_number LIKE 'CR-BACKFILL-%' AND cr.deleted_at IS NULL
     ORDER BY cr.id
  `).all();

  if (dupes.length === 0) { log(`\n2. Duplicates  none — no CR-BACKFILL receipts on the books`); return; }

  log(`\n2. Duplicates  ${dupes.length} receipt(s) putting the same cash in twice:`);
  let total = 0;
  for (const d of dupes) {
    // A BACKFILL receipt with no properly-numbered twin is the ONLY record of
    // that payment. Removing it would delete real cash, so it is left alone.
    if (!d.keep_sync) {
      log(`   ${d.receipt_number.padEnd(20)}${money(d.amount).padStart(15)}  KEPT — no twin; it is the only receipt for payment ${d.pid}`);
      continue;
    }
    total += d.amount;
    log(`   ${d.receipt_number.padEnd(20)}${money(d.amount).padStart(15)}  -> delete; payment ${d.pid} re-pointed to ${d.keep_number}`);
    planned.push(() => {
      db.prepare(
        `UPDATE customer_payments SET cash_receipt_sync_id = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?`
      ).run(d.keep_sync, d.pid);
      db.prepare(
        `UPDATE cash_receipts SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?`
      ).run(d.id);
    });
  }
  if (total > 0) log(`   ${''.padEnd(20)}${money(total).padStart(15)}  comes out of the Cash Book`);
}

// ── 3. the same customer under two names ───────────────────────────────────
function planSpar(db, planned) {
  const pick = (name) => db.prepare(
    `SELECT id, name, opening_balance FROM customers WHERE name = ? AND deleted_at IS NULL`
  ).get(name);
  const spar = pick('SPAR');
  const spa  = pick('Spa Livingstone');

  log('');
  if (!spar || !spa) {
    log(`3. Spar        nothing to do — ${!spar ? '"SPAR"' : '"Spa Livingstone"'} is not on the books`);
    return;
  }
  if (!SPAR) {
    log(`3. Spar        TWO accounts hold the same figure. Neither is touched:`);
    log(`                 "${spa.name}"  ${money(spa.opening_balance)}   (already on file before the load)`);
    log(`                 "${spar.name}"  ${money(spar.opening_balance)}   (created by the load)`);
    log(`               Re-run with --spar=existing to keep Spa Livingstone and drop SPAR,`);
    log(`                        or --spar=rename   to drop SPAR and rename Spa Livingstone to SPAR.`);
    return;
  }

  const pays  = db.prepare(`SELECT COUNT(*) n FROM customer_payments WHERE customer_id = ? AND deleted_at IS NULL`).get(spar.id).n;
  const ords  = db.prepare(`SELECT COUNT(*) n FROM orders WHERE customer_id = ? AND deleted_at IS NULL`).get(spar.id).n;
  if (pays > 0 || ords > 0) {
    // Refuse rather than bury history: the account the load created was never
    // supposed to have any of its own.
    log(`3. Spar        REFUSED — "SPAR" carries ${pays} payment(s) and ${ords} order(s).`);
    log(`               Something has been posted to it since. Sort that out first.`);
    return;
  }

  log(`3. Spar        delete "SPAR" (${money(spar.opening_balance)}, no history against it)`);
  planned.push(() => db.prepare(
    `UPDATE customers SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?`
  ).run(spar.id));

  if (SPAR === 'rename') {
    log(`               rename "Spa Livingstone" -> "SPAR", keeping ${money(spa.opening_balance)}`);
    planned.push(() => db.prepare(
      `UPDATE customers SET name = 'SPAR', updated_at = datetime('now'), synced = 0 WHERE id = ?`
    ).run(spa.id));
  } else {
    log(`               keep "Spa Livingstone" as it is, at ${money(spa.opening_balance)}`);
  }
}

// CR-<year>-<device shortcode>-<seq> — the same shape generateNumber() makes,
// carrying on from the highest already issued for this device.
function nextReceiptNumber(db) {
  const dev   = db.prepare(`SELECT value FROM sync_config WHERE key = 'device_id'`).get()?.value;
  const short = dev ? dev.replace(/-/g, '').substring(0, 6).toUpperCase() : 'LOCAL1';
  const year  = new Date().getFullYear();
  const top = db.prepare(
    `SELECT MAX(CAST(substr(receipt_number, -4) AS INTEGER)) AS n
       FROM cash_receipts WHERE receipt_number LIKE ?`
  ).get(`CR-${year}-${short}-%`)?.n || 0;
  const seq = top + 1;
  db.prepare(`INSERT OR REPLACE INTO sync_config (key, value) VALUES ('seq_cash_receipts', ?)`).run(String(seq));
  return `CR-${year}-${short}-${String(seq).padStart(4, '0')}`;
}

function report(db) {
  const rows = db.prepare(`
    SELECT c.name, c.opening_balance AS ob,
           COALESCE((SELECT SUM(p.amount) FROM customer_payments p
                      WHERE p.customer_id = c.id AND p.deleted_at IS NULL), 0) AS paid
      FROM customers c
     WHERE c.deleted_at IS NULL AND c.opening_balance <> 0
     ORDER BY c.name
  `).all();

  log('Customer'.padEnd(28) + 'Opening'.padStart(15) + 'Paid'.padStart(15) + 'Balance'.padStart(15));
  log(''.padEnd(73, '-'));
  let ob = 0, pd = 0;
  for (const r of rows) {
    ob += r.ob; pd += r.paid;
    log(r.name.slice(0, 27).padEnd(28) + money(r.ob).padStart(15) + money(r.paid).padStart(15) + money(r.ob - r.paid).padStart(15));
  }
  log(''.padEnd(73, '-'));
  log('TOTAL'.padEnd(28) + money(ob).padStart(15) + money(pd).padStart(15) + money(ob - pd).padStart(15));

  const cash = db.prepare(
    `SELECT COALESCE(SUM(amount),0) s FROM cash_receipts WHERE source_type = 'ar_payment' AND deleted_at IS NULL`
  ).get().s;
  log(`\nAR cash receipts now total ${money(cash)}\n`);
}

main();
