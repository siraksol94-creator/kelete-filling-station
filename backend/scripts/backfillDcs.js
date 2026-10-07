/**
 * backfillDcs.js â€” v1.13.48
 * One-shot: write daily_cost_snapshot rows for every historical date that
 * had ANY business activity, using date-bounded WAC. Idempotent â€” because
 * writeDailyCostSnapshot uses INSERT OR IGNORE, running it twice is safe
 * (existing snapshots stay untouched).
 *
 * Usage on VPS:
 *   node /var/www/kelete-pos-tenant/backend/scripts/backfillDcs.js <slug>
 *
 * Example:
 *   node scripts/backfillDcs.js buseko
 *   node scripts/backfillDcs.js garden
 *   node scripts/backfillDcs.js all      # every registered tenant
 *
 * Prints a per-slug summary: dates seen, snapshots written.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { getTenantDb } = require('../config/tenantDb');
const { listTenants } = require('../config/masterDb');
const { writeDailyCostSnapshot } = require('../config/profitHelper');

function backfillForSlug(slug) {
  const db = getTenantDb(slug);
  if (!db) {
    console.error(`[backfill] tenant "${slug}" not registered â€” skipping`);
    return;
  }

  // Collect every date that had activity from every source that would
  // normally trigger a recalc. Union of distinct dates keeps the sweep small.
  const dates = db.prepare(`
    SELECT DISTINCT d FROM (
      SELECT DATE(created_at) AS d FROM orders WHERE deleted_at IS NULL
      UNION
      SELECT DATE(created_at) AS d FROM stock_movements WHERE deleted_at IS NULL
      UNION
      SELECT date AS d FROM cash_reports WHERE deleted_at IS NULL
      UNION
      SELECT date AS d FROM payment_vouchers WHERE deleted_at IS NULL
    )
    WHERE d IS NOT NULL AND d >= '2020-01-01'
    ORDER BY d ASC
  `).all().map(r => r.d);

  const tenantIdRow = db.prepare('SELECT tenant_id FROM products WHERE tenant_id IS NOT NULL LIMIT 1').get();
  if (!tenantIdRow) {
    console.warn(`[backfill] ${slug} â€” no product with tenant_id, skipping`);
    return;
  }
  const tenantId = tenantIdRow.tenant_id;

  const before = db.prepare('SELECT COUNT(*) AS n FROM daily_cost_snapshot').get().n;
  const t0 = Date.now();
  for (const date of dates) {
    writeDailyCostSnapshot(db, date, tenantId);
  }
  const after = db.prepare('SELECT COUNT(*) AS n FROM daily_cost_snapshot').get().n;
  const elapsed = Date.now() - t0;

  console.log(
    `[backfill] ${slug}: swept ${dates.length} date(s), ` +
    `dcs rows ${before} â†’ ${after} (+${after - before}), ` +
    `${elapsed}ms`
  );
}

const target = (process.argv[2] || '').toLowerCase();
if (!target) {
  console.error('Usage: node scripts/backfillDcs.js <slug> | all');
  process.exit(1);
}

if (target === 'all') {
  const tenants = listTenants();
  console.log(`[backfill] running on ${tenants.length} tenant(s): ${tenants.map(t => t.slug).join(', ')}`);
  for (const t of tenants) backfillForSlug(t.slug);
} else {
  backfillForSlug(target);
}

console.log('[backfill] done.');
