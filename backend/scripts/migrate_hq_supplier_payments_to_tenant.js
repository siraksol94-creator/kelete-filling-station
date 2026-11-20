/**
 * v1.10.72 — one-off migration:
 *   master.hq_supplier_payments  →  hq.db.ap_payments
 *
 * WHY:
 *   As of v1.10.72, HQ Supplier Payments write directly to hq.db.ap_payments
 *   (single source of truth — Cash Book reads ap_payments natively so no
 *   mirror-write is needed). Any payments recorded before this ship still
 *   sit ONLY in master.hq_supplier_payments and never appear in Cash Book.
 *   This script copies them over.
 *
 * SAFETY:
 *   * Idempotent — skips payments whose payment_number already exists in
 *     the tenant DB.
 *   * Read-only on master (does NOT delete the master rows). Leave them
 *     as an audit trail; getBalances only reads the tenant DB now.
 *   * Prints before / after counts.
 *
 * HOW TO RUN (on the VPS, from the project root):
 *   node backend/scripts/migrate_hq_supplier_payments_to_tenant.js
 *
 * Requires no CLI flags. Uses the same master.db + tenants/hq.db resolution
 * as the running server.
 */

const { randomUUID } = require('crypto');
const { masterDb, listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');

function getHqSlug() {
  try {
    const t = listTenants().find(t => t.slug === 'hq');
    if (t) return 'hq';
    const bare = listTenants().find(t => /^(kelete|keletedistributionzm|hq)$/i.test(t.slug));
    return bare ? bare.slug : 'hq';
  } catch (_) { return 'hq'; }
}

function main() {
  if (!masterDb) {
    console.error('master.db not accessible — aborting.');
    process.exit(1);
  }

  const hqSlug = getHqSlug();
  const hqDb = getTenantDb(hqSlug);
  if (!hqDb) {
    console.error(`HQ tenant DB not accessible at slug "${hqSlug}" — aborting.`);
    process.exit(1);
  }

  // v1.10.75 hotfix — historical rows carry user IDs from master.db that
  // don't exist in hq.db.users. Disable FK checks for the migration so
  // the historical import can complete; the created_by column will hold
  // a stale user id but the AP display doesn't require the FK to resolve
  // (uses a LEFT JOIN in the read paths).
  hqDb.pragma('foreign_keys = OFF');

  const rows = masterDb.prepare(`
    SELECT id, payment_number, supplier_id, supplier_name,
           amount, payment_date, payment_method,
           reference, notes, created_by, created_by_name
      FROM hq_supplier_payments
     ORDER BY id ASC
  `).all();

  console.log(`Found ${rows.length} row(s) in master.hq_supplier_payments.`);
  console.log(`HQ tenant slug: ${hqSlug}`);

  const beforeTenant = hqDb.prepare(
    `SELECT COUNT(*) AS n FROM ap_payments WHERE payment_number LIKE 'HSP-%'`
  ).get().n;
  console.log(`Before: hq.db.ap_payments HSP rows = ${beforeTenant}`);

  const findExisting = hqDb.prepare(
    `SELECT id FROM ap_payments WHERE payment_number = ? LIMIT 1`
  );
  const insertMirror = hqDb.prepare(`
    INSERT INTO ap_payments (payment_number, supplier_id, supplier_sync_id, supplier_name,
                              amount, cash_amount, bank_amount, momo_amount,
                              description, date, paid_from, created_by,
                              sync_id, tenant_id, branch_id, device_id,
                              synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
  `);

  let inserted = 0;
  let skipped  = 0;
  hqDb.transaction(() => {
    for (const r of rows) {
      if (findExisting.get(r.payment_number)) {
        skipped += 1;
        continue;
      }
      const method  = ['Cash', 'Bank', 'Mobile Money'].includes(r.payment_method) ? r.payment_method : 'Cash';
      const cashAmt = method === 'Cash'         ? r.amount : 0;
      const bankAmt = method === 'Bank'         ? r.amount : 0;
      const momoAmt = method === 'Mobile Money' ? r.amount : 0;
      const description = r.notes
        ? r.notes
        : (r.reference ? `${r.supplier_name || 'Supplier'} · ${r.reference}` : (r.supplier_name || 'HQ Supplier Payment'));
      insertMirror.run(
        r.payment_number, null, null, r.supplier_name,
        r.amount, cashAmt, bankAmt, momoAmt,
        description, r.payment_date, method, r.created_by || null,
        randomUUID(), null, null, null
      );
      inserted += 1;
    }
  })();

  const afterTenant = hqDb.prepare(
    `SELECT COUNT(*) AS n FROM ap_payments WHERE payment_number LIKE 'HSP-%'`
  ).get().n;
  console.log(`After : hq.db.ap_payments HSP rows = ${afterTenant}`);
  console.log(`Inserted: ${inserted}  Skipped (already present): ${skipped}`);

  // v1.10.75 hotfix — backfill tenant_id so Cash Book + Account Payables see these.
  const rows = ['cash_receipts', 'payment_vouchers', 'orders', 'products', 'users'];
  let tenantId = null;
  for (const t of rows) {
    try {
      const r = hqDb.prepare(`SELECT tenant_id FROM ${t} WHERE tenant_id IS NOT NULL LIMIT 1`).get();
      if (r && r.tenant_id) { tenantId = r.tenant_id; break; }
    } catch (_) { /* skip */ }
  }
  if (tenantId) {
    const upd = hqDb.prepare(`UPDATE ap_payments SET tenant_id = ? WHERE tenant_id IS NULL AND payment_number LIKE 'HSP-%'`).run(tenantId);
    console.log(`tenant_id backfilled on ${upd.changes} row(s)`);
  }

  hqDb.pragma('foreign_keys = ON');
  console.log('Done.');
}

main();
