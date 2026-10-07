/**
 * v1.10.75 hotfix â€” backfill tenant_id on migrated HQ rows.
 *
 * The v1.10.72 + v1.10.75 migration scripts inserted rows with tenant_id
 * = NULL. Account Payables at HQ (routes/accountPayables.js) filters
 * WHERE s.tenant_id = ? so those migrated rows were invisible on that
 * page, even though HQ Suppliers page (which doesn't filter by
 * tenant_id) shows them correctly.
 *
 * This script resolves HQ's actual tenant_id from existing rows (users
 * or cash_receipts â€” whichever has one) and updates every migrated row
 * that still holds NULL. Idempotent + safe to re-run.
 *
 * HOW TO RUN:
 *   node backend/scripts/backfill_migrated_hq_tenant_id.js
 */

const { listTenants } = require('../config/masterDb');
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
  const hqSlug = getHqSlug();
  const hqDb = getTenantDb(hqSlug);
  if (!hqDb) { console.error(`HQ tenant DB not accessible at slug "${hqSlug}"`); process.exit(1); }

  // v1.10.75 hotfix#2 â€” resolve tenant_id from THREE places:
  // 1. sync_config table (the definitive source â€” routes/auth.js reads
  //    key = "tenant:<slug>" to build the JWT's tenantId).
  // 2. Any existing row that already has a tenant_id set.
  // 3. Master.tenants.id for this slug as a last-resort fallback.
  let tenantId = null;
  try {
    const row = hqDb.prepare(`SELECT value FROM sync_config WHERE key = ?`).get(`tenant:${hqSlug}`);
    if (row && row.value) tenantId = row.value;
  } catch (_) { /* sync_config may not exist */ }
  if (!tenantId) {
    for (const sql of [
      `SELECT tenant_id FROM cash_receipts    WHERE tenant_id IS NOT NULL LIMIT 1`,
      `SELECT tenant_id FROM payment_vouchers WHERE tenant_id IS NOT NULL LIMIT 1`,
      `SELECT tenant_id FROM ap_payments      WHERE tenant_id IS NOT NULL LIMIT 1`,
      `SELECT tenant_id FROM orders           WHERE tenant_id IS NOT NULL LIMIT 1`,
      `SELECT tenant_id FROM products         WHERE tenant_id IS NOT NULL LIMIT 1`,
      `SELECT tenant_id FROM users            WHERE tenant_id IS NOT NULL LIMIT 1`,
    ]) {
      try {
        const r = hqDb.prepare(sql).get();
        if (r && r.tenant_id) { tenantId = r.tenant_id; break; }
      } catch (_) { /* table may not exist */ }
    }
  }
  if (!tenantId) {
    // Last resort â€” pull the tenant id from master.tenants for this slug.
    try {
      const { masterDb } = require('../config/masterDb');
      const r = masterDb?.prepare(`SELECT id FROM tenants WHERE slug = ? LIMIT 1`).get(hqSlug);
      if (r && r.id) tenantId = String(r.id);
    } catch (_) { /* skip */ }
  }
  if (!tenantId) {
    console.error('Could not resolve HQ tenant_id.');
    console.error("Try: sqlite3 tenants/hq.db \"SELECT * FROM sync_config\"");
    console.error('and paste the output back â€” we can hard-code it.');
    process.exit(1);
  }
  console.log(`HQ tenant_id resolved: ${tenantId}`);
  console.log(`HQ tenant slug:        ${hqSlug}`);
  console.log('Backfillingâ€¦');

  const tables = [
    'suppliers',
    'grn',
    'grn_items',
    'ap_payments',
    'supplier_credit_notes',
    'supplier_credit_note_items',
  ];

  hqDb.pragma('foreign_keys = OFF');
  for (const t of tables) {
    try {
      const before = hqDb.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id IS NULL`).get().n;
      hqDb.prepare(`UPDATE ${t} SET tenant_id = ? WHERE tenant_id IS NULL`).run(tenantId);
      const after = hqDb.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE tenant_id IS NULL`).get().n;
      console.log(`  ${t.padEnd(28)}  before(null)=${before}  after(null)=${after}`);
    } catch (e) {
      console.error(`  ${t}: ${e.message}`);
    }
  }
  hqDb.pragma('foreign_keys = ON');
  console.log('Done.');
}

main();
