/**
 * inspect_zra_pulled_lines.js â€” READ ONLY. Writes nothing.
 *
 * 2026-08-31. Ten ZRA-approved purchases were booked before the pulled line's
 * VAT and discount were read, so they were costed at BASE. Before deciding
 * whether to correct them, three things have to be known and none of them can
 * be guessed:
 *
 *   1. What the money fields are actually CALLED in the pull. The ZRA spec
 *      says taxAmt / dcAmt; the queue modal was written against real data and
 *      reads vatAmt. Whichever it is decides whether the fix just shipped
 *      does anything at all.
 *   2. Whether these lines carry any VAT. If Red Sea's own self-invoices are
 *      zero-rated, nothing is missing and there is nothing to correct.
 *   3. How much AP is actually short, per purchase.
 *
 * Run on the VPS:
 *   cd /var/www/kelete-pos-tenant
 *   node backend/scripts/inspect_zra_pulled_lines.js
 */
const path = require('path');
const Database = require(path.join(__dirname, '..', 'node_modules', 'better-sqlite3'));

const MASTER = path.join(__dirname, '..', '..', 'master.db');
const TENANT = process.env.DB_PATH || path.join(__dirname, '..', 'kelete.db');

const master = new Database(MASTER, { readonly: true });

// 2026-08-31 â€” find the database that actually holds the pulled invoices.
//
// The first run reported "NO raw_json" for all ten, which was the script being
// imprecise: it said the same thing whether the row was missing or the column
// was null, and it only ever looked in one file. zra_pending_purchases lives
// in whichever tenant DB the pull ran against, and on the HQ host that is not
// necessarily backend/kelete.db.
const fs = require('fs');
const candidates = [];
const push = (f) => { if (fs.existsSync(f) && !candidates.includes(f)) candidates.push(f); };
if (process.env.DB_PATH) push(process.env.DB_PATH);
push(TENANT);
try {
  const tdir = path.join(__dirname, '..', '..', 'tenants');
  if (fs.existsSync(tdir)) fs.readdirSync(tdir).filter(f => f.endsWith('.db')).forEach(f => push(path.join(tdir, f)));
} catch (_) {}
try {
  const bdir = path.join(__dirname, '..');
  fs.readdirSync(bdir).filter(f => f.endsWith('.db')).forEach(f => push(path.join(bdir, f)));
} catch (_) {}

console.log('--- searching for zra_pending_purchases ---');
let tenant = null;
for (const f of candidates) {
  try {
    const d = new Database(f, { readonly: true });
    const has = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='zra_pending_purchases'").get();
    if (!has) { console.log(`  ${f}  â€” table absent`); d.close(); continue; }
    const n   = d.prepare('SELECT COUNT(*) AS n FROM zra_pending_purchases').get().n;
    const raw = d.prepare("SELECT COUNT(*) AS n FROM zra_pending_purchases WHERE raw_json IS NOT NULL AND raw_json != ''").get().n;
    console.log(`  ${f}  â€” ${n} row(s), ${raw} with raw_json`);
    if (raw > 0 && !tenant) tenant = d; else d.close();
  } catch (e) { console.log(`  ${f}  â€” unreadable: ${e.message}`); }
}
if (!tenant) {
  console.log('');
  console.log('No database found holding pulled invoices with raw_json.');
  console.log('If a row count above is > 0 but raw_json is 0, the pull stored the');
  console.log('summary only and the figures cannot be recovered from here.');
  console.log('');
  process.exit(0);
}
console.log('');

const affected = master.prepare(`
  SELECT p.id, p.purchase_number, p.date, p.supplier_name, p.total_amount,
         p.zra_pending_purchase_id AS pending_id, p.sync_id,
         COUNT(i.id) AS lines
    FROM hq_purchase_items i
    JOIN hq_purchases p ON p.sync_id = i.purchase_sync_id
   WHERE p.zra_pending_purchase_id IS NOT NULL
     AND COALESCE(i.base_price, 0) = 0
     AND COALESCE(i.dispatched_qty, 0) > 0
   GROUP BY p.id
   ORDER BY p.date ASC
`).all();

console.log(`\n${affected.length} purchase(s) to inspect\n`);

const keysSeen = new Set();
let totalVat = 0, totalDisc = 0, totalBase = 0, unreadable = 0;

for (const p of affected) {
  const pend = tenant.prepare('SELECT id, raw_json FROM zra_pending_purchases WHERE id = ?').get(p.pending_id);
  // Say WHICH of the two it is â€” the first version conflated them.
  if (!pend) {
    console.log(`${p.purchase_number}  pending row ${p.pending_id} â€” row not in this DB`);
    unreadable++; continue;
  }
  if (!pend.raw_json) {
    console.log(`${p.purchase_number}  pending row ${p.pending_id} â€” row exists but raw_json is empty`);
    unreadable++; continue;
  }
  let items = [];
  try { items = JSON.parse(pend.raw_json)?.itemList || []; }
  catch (e) { console.log(`${p.purchase_number}  raw_json unparseable: ${e.message}`); unreadable++; continue; }

  // Every key on the first line, so the real field names are visible rather
  // than assumed.
  if (items[0]) Object.keys(items[0]).forEach(k => keysSeen.add(k));

  // 2026-08-31 â€” the money fields, in full, for the first line of each
  // purchase.
  //
  // qty x prc matched neither VAT-exclusive nor VAT-inclusive on the first
  // run: for HQP-2026-00029, 16% of 62,200 is 9,952 and 16/116 of it is
  // 8,579.31, but the pull says 8,960.28. Beer carries excise and VAT is
  // charged on top of it, so the relationship cannot be guessed from prc and
  // vatAmt alone. Whether the booked amount is already what we owe â€” and so
  // whether adding vatAmt is a correction or a double-count â€” is decided by
  // these fields.
  if (process.env.DUMP !== '0' && items[0]) {
    const it0 = items[0];
    const n = (v) => (v === undefined || v === null ? '-' : Number(v).toFixed(2));
    console.log(`    line1  qty ${n(it0.qty)} x prc ${n(it0.prc)} = ${n((+it0.qty || 0) * (+it0.prc || 0))}`);
    console.log(`           splyAmt ${n(it0.splyAmt)}  totAmt ${n(it0.totAmt)}  taxblAmt ${n(it0.taxblAmt)}`);
    console.log(`           vatTaxblAmt ${n(it0.vatTaxblAmt)}  vatAmt ${n(it0.vatAmt)}  vatCatCd ${it0.vatCatCd ?? '-'}`);
    console.log(`           exciseTaxblAmt ${n(it0.exciseTaxblAmt)}  exciseTxAmt ${n(it0.exciseTxAmt)}`);
    console.log(`           tlTaxblAmt ${n(it0.tlTaxblAmt)}  tlAmt ${n(it0.tlAmt)}  iplTaxblAmt ${n(it0.iplTaxblAmt)}  iplAmt ${n(it0.iplAmt)}`);
    console.log(`           dcRt ${n(it0.dcRt)}  dcAmt ${n(it0.dcAmt)}`);
  }

  const num = (v) => parseFloat(v) || 0;
  let base = 0, vat = 0, disc = 0;
  for (const it of items) {
    base += num(it.qty) * num(it.prc);
    vat  += num(it.taxAmt ?? it.vatAmt);
    disc += num(it.dcAmt ?? it.discountAmt ?? it.dcAmtC);
  }
  totalBase += base; totalVat += vat; totalDisc += disc;

  // NOT a verdict: this assumes prc is VAT-exclusive, which is exactly what is
  // in question. Read it as "the gap IF that assumption holds".
  const shouldBe = base + vat - disc;
  const booked   = num(p.total_amount);
  const flag = Math.abs(shouldBe - booked) < 0.01 ? 'ok' : `gap ${(shouldBe - booked).toFixed(2)} (if prc excl VAT)`;
  console.log(
    `${p.purchase_number}  ${p.date}  ${String(p.supplier_name).slice(0, 34).padEnd(34)} ` +
    `lines ${items.length}/${p.lines}  base ${base.toFixed(2).padStart(12)}  ` +
    `VAT ${vat.toFixed(2).padStart(10)}  disc ${disc.toFixed(2).padStart(9)}  ` +
    `booked ${booked.toFixed(2).padStart(12)}  ${flag}`
  );
}

console.log('\n--- field names actually present on a pulled line ---');
console.log([...keysSeen].sort().join(', ') || '(none read)');
console.log('\n--- totals across the affected purchases ---');
console.log(`base ${totalBase.toFixed(2)}   VAT ${totalVat.toFixed(2)}   discount ${totalDisc.toFixed(2)}`);
console.log(`Gap IF prc is VAT-exclusive: ${(totalVat - totalDisc).toFixed(2)}`);
console.log('If prc already includes VAT, the booked amounts are correct and');
console.log('adding vatAmt would DOUBLE-COUNT it. The line1 dumps above decide which.');
if (unreadable) console.log(`${unreadable} purchase(s) could not be read back.`);
console.log('\nNothing was written.\n');
