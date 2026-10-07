/**
 * chipata_ob_load.js â€” load Chipata's pre-system customer balances from the
 * manual ledger (sent 2026-09-13), the same way Livingstone was loaded:
 *
 *   opening balance = everything the customer took on credit before the system
 *   each payment    = a customer_payment on its real date with its own AR cash
 *                     receipt, so the statement AND the Cash Book both carry it
 *
 * The balance then comes out of the statement by itself. See
 * livingstone_ob_repair.js for how that load went wrong and why this is a
 * report-first script instead of SQL pasted over a remote session.
 *
 * Existing customers are matched by id, never by name â€” Red Sea names carry
 * trailing spaces â€” and each id's name is checked before anything is written.
 * A new customer is refused if a live customer already looks like it.
 *
 * Nothing is written without --apply. Safe to run twice: every step checks the
 * state it is about to create and skips if it is already there.
 *
 * Usage (on the VPS, from /var/www/kelete-pos-tenant):
 *   node backend/scripts/chipata_ob_load.js            # report
 *   node backend/scripts/chipata_ob_load.js --apply
 */
const { randomUUID } = require('crypto');
const { getTenantDb } = require('../config/tenantDb');

const SLUG  = process.env.OB_SLUG || 'chipata';
const APPLY = process.argv.includes('--apply');

const REF   = 'Pre-system settlement';
const NOTES = 'Recorded from the manual ledger';

// id = an existing Chipata customer (checked against its name below);
// null = create it. `like` guards against creating a second account for a
// customer already on file under another spelling.
const LEDGER = [
  { id: null, name: 'Z.B CANNED',      like: ['%Z%B%'],                           ob: 21270, payments: [] },
  { id: null, name: 'COCA COLA',       like: ['%COCA%', '%COKE%'],                ob: 10254, payments: [] },
  { id: null, name: 'PEPSI',           like: ['%PEPSI%'],                         ob: 6704,  payments: [] },
  { id: 3,    name: 'PROTEA HOTEL',                                               ob: 40792, payments: [{ date: '2026-09-07', amount: 40792 }] },
  { id: 4,    name: 'NYAMFINZI HOTEL',                                            ob: 12770, payments: [{ date: '2026-09-07', amount: 17025 }] },
  { id: null, name: 'KENNEDY PHIRI',   like: ['%KENNEDY%', '%PHIRI%'],            ob: 275,   payments: [{ date: '2026-09-08', amount: 275 }] },
  { id: null, name: 'RONARD KAKUMBI',  like: ['%KAKUMBI%', '%RONARD%', '%RONALD%'], ob: 435, payments: [{ date: '2026-09-03', amount: 355 }] },
  { id: 1,    name: 'SPAR CHIPATA',                                               ob: 13950, payments: [{ date: '2026-09-07', amount: 13950 }] },
];

const money = (n) => 'K' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const log   = (...a) => console.log(...a);
const same  = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.005;
const norm  = (s) => String(s || '').trim().toUpperCase();

function main() {
  const db = getTenantDb(SLUG);
  if (!db) { console.error(`[load] no database for "${SLUG}"`); process.exit(1); }

  log(`\n=== ${SLUG} opening-balance load ${APPLY ? '(APPLYING)' : '(report only)'} ===\n`);

  // Identity for new rows: the same tenant / branch / device the app stamped on
  // the customers it created here.
  const ident = db.prepare(
    `SELECT tenant_id, branch_id, device_id FROM customers
      WHERE deleted_at IS NULL AND tenant_id IS NOT NULL ORDER BY id LIMIT 1`
  ).get() || {
    tenant_id: db.prepare(`SELECT value FROM sync_config WHERE key = ?`).get(`tenant:${SLUG}`)?.value || null,
    branch_id: null, device_id: null,
  };
  // created_by has a foreign key to users â€” take one of THIS branch's users.
  const uid = db.prepare(
    `SELECT id FROM users WHERE deleted_at IS NULL AND role = 'Administrator' ORDER BY id LIMIT 1`
  ).get()?.id || null;

  // â”€â”€ plan: every check first, nothing written â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const problems = [];
  const plan = [];
  for (const row of LEDGER) {
    const p = { row, customer: null, create: false, setOb: false, addPays: [] };

    if (row.id) {
      const c = db.prepare(`SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL`).get(row.id);
      if (!c) { problems.push(`${row.name}: no live customer with id ${row.id}`); continue; }
      if (norm(c.name) !== row.name) { problems.push(`id ${row.id} is "${c.name}", expected "${row.name}"`); continue; }
      p.customer = c;
    } else {
      const exact = db.prepare(`SELECT * FROM customers WHERE deleted_at IS NULL AND UPPER(TRIM(name)) = ?`).all(row.name);
      if (exact.length > 1) { problems.push(`${row.name}: ${exact.length} live customers already have this name`); continue; }
      if (exact.length === 1) {
        p.customer = exact[0];
      } else {
        const lookalikes = db.prepare(
          `SELECT id, name FROM customers WHERE deleted_at IS NULL AND (${row.like.map(() => 'UPPER(name) LIKE ?').join(' OR ')})`
        ).all(...row.like);
        if (lookalikes.length) {
          problems.push(`${row.name}: not created â€” already on file as ${lookalikes.map(l => `#${l.id} "${l.name}"`).join(', ')}`);
          continue;
        }
        p.create = true;
      }
    }

    const currentOb = p.customer ? Number(p.customer.opening_balance || 0) : 0;
    if (!p.create && !same(currentOb, row.ob)) {
      if (!same(currentOb, 0)) { problems.push(`${row.name}: opening balance is already ${money(currentOb)}, not 0 â€” left alone`); continue; }
      p.setOb = true;
    }

    for (const pay of row.payments) {
      const exists = p.customer && db.prepare(
        `SELECT id FROM customer_payments
          WHERE customer_sync_id = ? AND reference = ? AND payment_date = ?
            AND ABS(amount - ?) < 0.005 AND deleted_at IS NULL`
      ).get(p.customer.sync_id, REF, pay.date, pay.amount);
      if (!exists) p.addPays.push(pay);
    }
    plan.push(p);
  }

  for (const p of plan) {
    const { row } = p;
    const what = [];
    what.push(p.create ? `create, OB ${money(row.ob)}`
      : p.setOb ? `#${p.customer.id} OB ${money(p.customer.opening_balance)} -> ${money(row.ob)}`
      : `#${p.customer.id} OB ${money(row.ob)} (already)`);
    for (const pay of row.payments) {
      const adding = p.addPays.includes(pay);
      what.push(`paid ${pay.date} ${money(pay.amount)}${adding ? ' + CR' : ' (already)'}`);
    }
    log(`  ${row.name.padEnd(17)} ${what.join(' Â· ')}`);
  }

  if (problems.length) {
    log(`\nSTOPPED â€” nothing written. Fix these first:`);
    for (const m of problems) log(`  - ${m}`);
    log('');
    process.exit(1);
  }

  const changes = plan.reduce((n, p) => n + (p.create ? 1 : 0) + (p.setOb ? 1 : 0) + p.addPays.length, 0);
  log('');
  if (changes === 0) { log('Nothing to change.\n'); report(db); return; }
  if (!APPLY) { log(`${changes} change(s) ready. Re-run with --apply to write them.\n`); return; }

  // â”€â”€ apply, all or nothing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  db.transaction(() => {
    for (const p of plan) {
      const { row } = p;
      if (p.create) {
        const id = db.prepare(`
          INSERT INTO customers (name, type, credit_limit, payment_terms_days, credit_status, opening_balance,
                                 sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?, 'Regular', 0, 0, 'Active', ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
        `).run(row.name, row.ob, randomUUID(), ident.tenant_id, ident.branch_id, ident.device_id).lastInsertRowid;
        p.customer = db.prepare(`SELECT * FROM customers WHERE id = ?`).get(id);
      } else if (p.setOb) {
        db.prepare(`UPDATE customers SET opening_balance = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?`)
          .run(row.ob, p.customer.id);
      }
      const c = p.customer;
      for (const pay of p.addPays) {
        const payId = db.prepare(`
          INSERT INTO customer_payments (customer_id, customer_sync_id, amount, cash_amount,
                                         payment_date, payment_method, reference, notes, created_by,
                                         sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
          VALUES (?,?,?,?,?,'Cash',?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(c.id, c.sync_id, pay.amount, pay.amount, pay.date, REF, NOTES, uid, randomUUID(),
               c.tenant_id, c.branch_id, c.device_id).lastInsertRowid;

        const crSync = randomUUID();
        db.prepare(`
          INSERT INTO cash_receipts (receipt_number, received_from, description, payment_method, amount,
                                     cash_amount, bank_amount, momo_amount, usd_amount, fra_amount, k_amount,
                                     date, created_by, sync_id, tenant_id, branch_id, device_id, synced,
                                     source_type, source_customer_payment_id, created_at, updated_at)
          VALUES (?,?,?,'Cash',?,?,0,0,0,0,0,?,?,?,?,?,?,0,'ar_payment',?,datetime('now'),datetime('now'))
        `).run(nextReceiptNumber(db), c.name.trim(), 'AR Payment â€” ' + NOTES, pay.amount,
               pay.amount, pay.date, uid, crSync, c.tenant_id, c.branch_id, c.device_id, payId);

        db.prepare(`UPDATE customer_payments SET cash_receipt_sync_id = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?`)
          .run(crSync, payId);
      }
    }
  })();
  log(`${changes} change(s) applied.\n`);
  report(db);
}

// CR-<year>-<device shortcode>-<seq> â€” the same shape generateNumber() makes,
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

// The statement balance for each customer in the ledger:
// opening + system sales âˆ’ paid at the till âˆ’ every AR payment.
function report(db) {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.opening_balance AS ob,
      COALESCE((SELECT SUM(p.amount) FROM customer_payments p
                 WHERE p.customer_sync_id = c.sync_id AND p.deleted_at IS NULL), 0) AS paid,
      COALESCE((SELECT SUM(o.total_amount) FROM orders o
                 WHERE o.customer_sync_id = c.sync_id AND o.deleted_at IS NULL
                   AND (o.status IS NULL OR o.status != 'Reversed')), 0) AS sales,
      COALESCE((SELECT SUM(MIN(COALESCE(o.amount_received, 0), o.total_amount)) FROM orders o
                 WHERE o.customer_sync_id = c.sync_id AND o.deleted_at IS NULL
                   AND (o.status IS NULL OR o.status != 'Reversed')), 0) AS till
      FROM customers c
     WHERE c.deleted_at IS NULL
     ORDER BY c.name
  `).all().filter(r => LEDGER.some(l => norm(r.name) === l.name));

  log('Customer'.padEnd(18) + 'Opening'.padStart(13) + 'AR paid'.padStart(13) + 'Sales'.padStart(13) + 'Till'.padStart(13) + 'Balance'.padStart(14));
  log(''.padEnd(84, '-'));
  const t = { ob: 0, paid: 0, sales: 0, till: 0 };
  for (const r of rows) {
    for (const k of Object.keys(t)) t[k] += r[k];
    const bal = r.ob + r.sales - r.till - r.paid;
    log(r.name.trim().slice(0, 17).padEnd(18) + money(r.ob).padStart(13) + money(r.paid).padStart(13)
        + money(r.sales).padStart(13) + money(r.till).padStart(13) + money(bal).padStart(14));
  }
  log(''.padEnd(84, '-'));
  log('TOTAL'.padEnd(18) + money(t.ob).padStart(13) + money(t.paid).padStart(13) + money(t.sales).padStart(13)
      + money(t.till).padStart(13) + money(t.ob + t.sales - t.till - t.paid).padStart(14));

  const cr = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(r.amount), 0) AS s
       FROM cash_receipts r JOIN customer_payments p ON p.id = r.source_customer_payment_id
      WHERE r.source_type = 'ar_payment' AND r.deleted_at IS NULL AND p.reference = ? AND p.deleted_at IS NULL`
  ).get(REF);
  log(`\nPre-system AR cash receipts: ${cr.n}, total ${money(cr.s)}\n`);
}

main();
