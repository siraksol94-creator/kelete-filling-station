#!/usr/bin/env node
// checkDrift.js — v1.10.21
// Compares products.current_stock (the cache) against SUM(stock_movements)
// (the truth) for every product in every tenant DB. Reports any product
// whose cache drifted from truth by more than 0.001 base units.
//
// Zero output = every write path is honestly keeping the cache in sync.
// Any output = a write path is missing its products.current_stock update.
//
// Usage (on VPS):
//   node backend/scripts/checkDrift.js             # all tenants
//   node backend/scripts/checkDrift.js mansa1      # just one tenant
//   node backend/scripts/checkDrift.js --verbose   # also show clean products

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const targetSlug = args.find(a => !a.startsWith('--'));

const TENANTS_DIR = process.env.TENANTS_DIR
  || path.join(__dirname, '..', '..', 'tenants');

if (!fs.existsSync(TENANTS_DIR)) {
  console.error(`Tenants dir not found: ${TENANTS_DIR}`);
  process.exit(1);
}

const dbs = fs.readdirSync(TENANTS_DIR)
  .filter(f => f.endsWith('.db'))
  .map(f => ({ slug: f.replace(/\.db$/, ''), path: path.join(TENANTS_DIR, f) }))
  .filter(t => !targetSlug || t.slug === targetSlug);

if (dbs.length === 0) {
  console.error(targetSlug
    ? `No tenant DB matched slug "${targetSlug}".`
    : 'No tenant DBs found.');
  process.exit(1);
}

let totalDrifted = 0;

for (const { slug, path: dbPath } of dbs) {
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare(`
    SELECT p.id, p.code, p.name, p.current_stock,
           COALESCE((
             SELECT SUM(sm.quantity) FROM stock_movements sm
              WHERE sm.product_sync_id = p.sync_id
                AND sm.deleted_at IS NULL
           ), 0) AS truth
      FROM products p
     WHERE p.deleted_at IS NULL AND p.sync_id IS NOT NULL
     ORDER BY p.id
  `).all();
  db.close();

  const drifted = rows
    .map(r => ({ ...r, drift: (r.current_stock || 0) - (r.truth || 0) }))
    .filter(r => Math.abs(r.drift) > 0.001);

  console.log(`\n── ${slug} — ${rows.length} products, ${drifted.length} drifted ──`);
  if (drifted.length === 0 && !verbose) continue;

  const list = verbose ? rows.map(r => ({ ...r, drift: (r.current_stock || 0) - (r.truth || 0) })) : drifted;
  console.log('  ' + 'id'.padStart(4) + '  ' + 'code'.padEnd(10) + '  ' + 'name'.padEnd(30)
    + '  ' + 'cached'.padStart(10) + '  ' + 'truth'.padStart(10) + '  ' + 'drift'.padStart(10));
  for (const r of list) {
    const marker = Math.abs(r.drift) > 0.001 ? '⚠ ' : '  ';
    console.log(marker + String(r.id).padStart(4) + '  ' + String(r.code || '').padEnd(10)
      + '  ' + String(r.name || '').slice(0, 30).padEnd(30)
      + '  ' + (r.current_stock || 0).toFixed(3).padStart(10)
      + '  ' + (r.truth || 0).toFixed(3).padStart(10)
      + '  ' + r.drift.toFixed(3).padStart(10));
  }
  totalDrifted += drifted.length;
}

console.log(`\nTotal drifted across all tenants: ${totalDrifted}`);
process.exit(totalDrifted > 0 ? 1 : 0);
