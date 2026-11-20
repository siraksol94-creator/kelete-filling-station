/**
 * setAllProductsBx.js — v1.13.101 (2026-07-28)
 *
 * One-shot: set zra_pkg_unit_cd = 'BX' and zra_qty_unit_cd = 'BX' on
 * every product row, on every DB. Prep for ZRA UAT on 2026-07-29 —
 * Red Sea sells everything in Box units, so both packaging and quantity
 * codes should be BX.
 *
 * Idempotent — running twice does nothing (WHERE clause skips rows
 * already at BX).
 *
 * Usage on VPS:
 *   node backend/scripts/setAllProductsBx.js hq        # HQ mirror only
 *   node backend/scripts/setAllProductsBx.js buseko    # one branch
 *   node backend/scripts/setAllProductsBx.js garden
 *   node backend/scripts/setAllProductsBx.js all       # HQ + every branch
 *
 * Prints per-DB summary of rows changed.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { defaultDb } = require('../config/database');
const { getTenantDb } = require('../config/tenantDb');
const { listTenants } = require('../config/masterDb');

function patchDb(label, db) {
  if (!db) {
    console.error(`[bx] ${label}: DB not available, skipping`);
    return;
  }
  const before = db.prepare(
    `SELECT COUNT(*) AS n FROM products
      WHERE zra_pkg_unit_cd IS NOT 'BX' OR zra_qty_unit_cd IS NOT 'BX'`
  ).get().n;
  const info = db.prepare(
    `UPDATE products
        SET zra_pkg_unit_cd = 'BX',
            zra_qty_unit_cd = 'BX',
            updated_at = datetime('now'),
            synced = 0
      WHERE zra_pkg_unit_cd IS NOT 'BX' OR zra_qty_unit_cd IS NOT 'BX'`
  ).run();
  console.log(`[bx] ${label}: needed ${before}, changed ${info.changes}`);
}

const target = (process.argv[2] || '').toLowerCase();
if (!target) {
  console.error('Usage: node scripts/setAllProductsBx.js hq | <slug> | all');
  process.exit(1);
}

if (target === 'all') {
  patchDb('hq (kelete.db)', defaultDb);
  const tenants = listTenants();
  console.log(`[bx] found ${tenants.length} tenant(s): ${tenants.map(t => t.slug).join(', ')}`);
  for (const t of tenants) patchDb(t.slug, getTenantDb(t.slug));
} else if (target === 'hq') {
  patchDb('hq (kelete.db)', defaultDb);
} else {
  patchDb(target, getTenantDb(target));
}

console.log('[bx] done.');
