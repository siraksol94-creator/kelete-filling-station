/**
 * import_zra_tags.js â€” v1.13.74
 *
 * One-shot: reads RED SEA STOCK PRICES 2 (2).xlsx and stamps
 *   products.tax_label
 *   products.zra_vat_cat_cd
 *   products.zra_rrp
 * onto every matching product in HQ kelete.db, then triggers
 * pushProductToBranches for each so all branch DBs get the same
 * classification (needs v1.13.73 which extended the push to include
 * ZRA fields).
 *
 * Match rule: case-insensitive, whitespace-collapsed comparison on
 *   products.name  ==  Excel 'PRODUCT NAME'
 * Anything without a clean 1:1 match is REPORTED and skipped â€” never
 * silently guessed.
 *
 * Excel tax label â†’ DB VAT cat mapping (1:1):
 *   A   â†’ tax_label='A', zra_vat_cat_cd='A', zra_rrp=NULL
 *   B   â†’ tax_label='B', zra_vat_cat_cd='B', zra_rrp=<Excel Selling PRICE>
 *   D   â†’ tax_label='D', zra_vat_cat_cd='D', zra_rrp=NULL
 *   ''  â†’ SKIP (flagged for manual review)
 *
 * Idempotent â€” running twice does not change anything after the first pass
 * (compares each field before writing).
 *
 * Usage on VPS:
 *   cd /var/www/kelete-pos-tenant/backend
 *   node scripts/import_zra_tags.js "/path/to/RED SEA STOCK PRICES 2 (2).xlsx"
 *   node scripts/import_zra_tags.js "/path/to/xlsx" --dry-run
 *   node scripts/import_zra_tags.js "/path/to/xlsx" --no-push   # skip branch mirror
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const XLSX = require('xlsx');
const db = require('../config/database');           // ALS-scoped proxy; CLI â†’ defaultDb (HQ kelete.db)
const { listTenants }  = require('../config/masterDb');
const { getTenantDb }  = require('../config/tenantDb');
const pushHelpers      = require('../middleware/hqPush');
const pushProductToBranches = pushHelpers.pushProductToBranches;

// â”€â”€ args â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipPush = args.includes('--no-push');
const xlsxPath = args.find(a => !a.startsWith('--'));
if (!xlsxPath) {
  console.error('Usage: node scripts/import_zra_tags.js <path/to/xlsx> [--dry-run] [--no-push]');
  process.exit(1);
}

// â”€â”€ read Excel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log(`[import] reading ${xlsxPath}`);
const wb = XLSX.readFile(xlsxPath);
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
console.log(`[import] ${rows.length} rows in Excel\n`);

// â”€â”€ normalise helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const norm = (s) => String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');

// â”€â”€ build DB product map â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const dbRows = db.prepare(
  `SELECT id, name, tax_label, zra_vat_cat_cd, zra_rrp
     FROM products
    WHERE deleted_at IS NULL`
).all();
const byName = new Map();
for (const r of dbRows) byName.set(norm(r.name), r);
console.log(`[import] ${dbRows.length} active products in HQ kelete.db\n`);

// â”€â”€ plan updates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const updates = [];
const skipped = [];
const noMatch = [];
for (const row of rows) {
  const xName = String(row['PRODUCT NAME'] || '').trim();
  if (!xName) continue;
  const label = String(row.TaxLabels || '').trim().toUpperCase();
  const price = parseFloat(String(row['Selling PRICE'] || '').trim());

  if (!['A', 'B', 'D'].includes(label)) {
    skipped.push({ name: xName, reason: label ? `unknown label "${label}"` : 'no tax label' });
    continue;
  }

  const dbRow = byName.get(norm(xName));
  if (!dbRow) {
    noMatch.push(xName);
    continue;
  }

  const newTaxLabel   = label;
  const newVatCatCd   = label;                          // 1:1 for A/B/D
  const newRrp        = label === 'B' && price > 0 ? price : null;

  // Idempotency guard â€” only update fields that actually changed.
  const changes = {};
  if (dbRow.tax_label !== newTaxLabel)         changes.tax_label       = newTaxLabel;
  if (dbRow.zra_vat_cat_cd !== newVatCatCd)    changes.zra_vat_cat_cd  = newVatCatCd;
  const curRrp = dbRow.zra_rrp == null ? null : parseFloat(dbRow.zra_rrp);
  if (curRrp !== newRrp)                       changes.zra_rrp         = newRrp;

  if (Object.keys(changes).length === 0) {
    // already tagged â€” no work
    continue;
  }
  updates.push({ id: dbRow.id, name: dbRow.name, xName, changes });
}

// â”€â”€ report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log(`[import] will update ${updates.length} rows`);
if (skipped.length) {
  console.log(`[import] skipped ${skipped.length} rows (no valid tax label):`);
  for (const s of skipped) console.log(`  ~ ${s.name}   â€” ${s.reason}`);
}
if (noMatch.length) {
  console.log(`[import] ${noMatch.length} Excel rows have NO matching product in HQ DB:`);
  for (const n of noMatch) console.log(`  ! ${n}`);
}
console.log();

if (dryRun) {
  console.log('[import] --dry-run â€” showing first 10 planned updates then exiting:');
  for (const u of updates.slice(0, 10)) {
    console.log(`  #${u.id}  ${u.name}`);
    for (const [k, v] of Object.entries(u.changes)) console.log(`      ${k}: ${v ?? 'NULL'}`);
  }
  process.exit(0);
}

// â”€â”€ apply â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const applyOne = db.transaction((upd) => {
  const sets = [];
  const vals = [];
  for (const [k, v] of Object.entries(upd.changes)) {
    sets.push(`${k}=?`); vals.push(v);
  }
  db.prepare(
    `UPDATE products SET ${sets.join(', ')}, updated_at=datetime('now'), synced=0 WHERE id=?`
  ).run(...vals, upd.id);
});

let hqUpdated = 0;
for (const u of updates) {
  applyOne(u);
  hqUpdated++;
}
console.log(`[import] HQ kelete.db: ${hqUpdated} products updated`);

// â”€â”€ mirror to branches â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (skipPush) {
  console.log('[import] --no-push â€” skipping branch mirror. Run mirrorHqToAllBranches later.');
  process.exit(0);
}

console.log(`[import] mirroring to branchesâ€¦`);
const rowsForPush = db.prepare(
  `SELECT id, sync_id, name, code, category_id, category_sync_id, unit, units_json,
          default_unit, image_url, container_product_sync_id, units_per_container,
          ub_number_start, ub_number_length, ub_quantity_start, ub_quantity_length,
          ub_decimal_start, alt_unit, conversion_factor,
          hs_code, tax_label,
          zra_item_cls_cd, zra_item_ty_cd, zra_orgn_nat_cd,
          zra_pkg_unit_cd, zra_qty_unit_cd, zra_vat_cat_cd,
          zra_excise_ty_cd, zra_rrp,
          deleted_at
     FROM products
    WHERE id IN (${updates.map(u => u.id).join(',') || '0'})`
).all();

let branchOk = 0, branchErr = 0;
const tenants = listTenants();
console.log(`[import] ${tenants.length} branch tenants: ${tenants.map(t => t.slug).join(', ')}`);
for (const p of rowsForPush) {
  try {
    const res = pushProductToBranches(p, { listTenants, getTenantDb });
    branchOk += (res.pushed || 0) + (res.updated || 0);
    if (res.errors?.length) {
      for (const e of res.errors) {
        console.error(`  ! ${p.name} @ ${e.slug}: ${e.error}`);
        branchErr++;
      }
    }
  } catch (e) {
    console.error(`  ! ${p.name}: ${e.message}`);
    branchErr++;
  }
}
console.log(`[import] branch mirror: ${branchOk} row-writes ok, ${branchErr} errors`);
console.log('[import] done.');
