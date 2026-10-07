/**
 * setRrpFromExcel.js â€” v1.13.104 (2026-07-29)
 *
 * One-shot: apply the Red Sea RRP + VAT Category schedule (77 SKUs)
 * to products.zra_rrp and products.zra_vat_cat_cd. RRP list embedded
 * below so the script is self-contained â€” no Excel dependency at run
 * time, no cross-machine file transfer.
 *
 * Matching:
 *   - Case-insensitive on products.name (whitespace normalised).
 *   - Skips rows with RRP === 'None' for the RRP update, but still
 *     applies the VAT Category for those rows (cat A snacks, cat D
 *     empties/containers still need the correct label).
 *   - Multiple products with the same name â†’ all updated.
 *
 * Idempotent â€” running twice does nothing (WHERE clause skips rows
 * already at the target values).
 *
 * Usage on VPS:
 *   node backend/scripts/setRrpFromExcel.js hq            # HQ mirror only
 *   node backend/scripts/setRrpFromExcel.js buseko        # one branch
 *   node backend/scripts/setRrpFromExcel.js all           # HQ + every branch
 *   node backend/scripts/setRrpFromExcel.js all --dry-run # preview only
 *
 * Prints per-DB summary of matched/updated/skipped/unmatched.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { defaultDb } = require('../config/database');
const { getTenantDb } = require('../config/tenantDb');
const { listTenants } = require('../config/masterDb');

// Verbatim from Red Sea's official RRP schedule (Excel from ZB, 2026-07).
// TaxLabels column values map to zra_vat_cat_cd. RRP === 'None' means the
// item is not MTV (either cat A standard-rated or cat D exempt).
const RRP_ROWS = [
  { name: 'Black Label 375ml',            vatCat: 'B', rrp: 341.26 },
  { name: 'Mosi 375ml',                   vatCat: 'B', rrp: 294 },
  { name: 'MOSI 750ml',                   vatCat: 'B', rrp: 252 },
  { name: 'MOSI LIGHT',                   vatCat: 'B', rrp: 252 },
  { name: 'MOSI CANNED',                  vatCat: 'B', rrp: 439 },
  { name: 'BLACK LABEL 750mls',           vatCat: 'B', rrp: 288.76 },
  { name: 'BLACK LABEL NRB 34mls',        vatCat: 'B', rrp: 514.51 },
  { name: 'BLACK LABEL CANNED',           vatCat: 'B', rrp: 619.5 },
  { name: 'CASTLE 375mls',                vatCat: 'B', rrp: 341.26 },
  { name: 'CASTLE 750mls',                vatCat: 'B', rrp: 288.76 },
  { name: 'CASTLE LITE RGB',              vatCat: 'B', rrp: 341.26 },
  { name: 'CASTLE LITE 660mls',           vatCat: 'B', rrp: 288.76 },
  { name: 'CASTLE LITE NRB',              vatCat: 'B', rrp: 546 },
  { name: 'CASTLE LITE CANNED',           vatCat: 'B', rrp: 661.5 },
  { name: 'EAGLE 750mls',                 vatCat: 'B', rrp: 178.5 },
  { name: 'EAGLE 375mls',                 vatCat: 'B', rrp: 189.01 },
  { name: 'EAGLE EXTERA 375mls',          vatCat: 'B', rrp: 219.51 },
  { name: 'FLYING FISH NRB',              vatCat: 'B', rrp: 498.21 },
  { name: 'FLYING FISH CANNED',           vatCat: 'B', rrp: 614.8 },
  { name: 'BRUTAL FRUIT NRB',             vatCat: 'B', rrp: 492.9 },
  { name: 'BRUTAL FRUIT CANNED',          vatCat: 'B', rrp: 710.21 },
  { name: 'BUDWEISER',                    vatCat: 'B', rrp: 932.8 },
  { name: 'STELLA',                       vatCat: 'B', rrp: 704.91 },
  { name: 'CORONA',                       vatCat: 'B', rrp: 816.21 },
  { name: 'SMIRNOFF SPIN',                vatCat: 'B', rrp: 565 },
  { name: 'SOFT DRINK 500mls',            vatCat: 'B', rrp: 131.84 },
  { name: 'COKE PET 350mls',              vatCat: 'B', rrp: 94.8 },
  { name: 'COKE RGB 300mls',              vatCat: 'B', rrp: 121.87 },
  { name: 'MAZOE 2LTR',                   vatCat: 'B', rrp: 216.2 },
  { name: 'MIXERS',                       vatCat: 'B', rrp: 401 },
  { name: 'CAN COKE 300mls',              vatCat: 'B', rrp: 400.48 },
  { name: 'CAN COKE 500mls',              vatCat: 'B', rrp: 300 },
  { name: 'SOFT DRINK 1 lit',             vatCat: 'B', rrp: 95.48 },
  { name: 'SOFT DRINK 2 lit',             vatCat: 'B', rrp: 157.86 },
  { name: 'CAN CAPPY',                    vatCat: 'B', rrp: 524.92 },
  { name: 'MONSTER',                      vatCat: 'B', rrp: 794.21 },
  { name: 'PREDATOR',                     vatCat: 'B', rrp: 412 },
  { name: 'JOLLY JUICE',                  vatCat: 'B', rrp: 168.93 },
  { name: 'SCOLL X6',                     vatCat: 'B', rrp: 83 },
  { name: 'AQUA SAVANA WATER 500mls',     vatCat: 'B', rrp: 52.95 },
  { name: 'AQUA SAVANA WATER 750mls',     vatCat: 'B', rrp: 63.1 },
  { name: 'WATER 18.9 mls',               vatCat: 'B', rrp: 61.9 },
  { name: 'MINUTE MAID 500mls X 12',      vatCat: 'B', rrp: 146.67 },
  { name: 'Appletiser/Grapetiser 300ml',  vatCat: 'B', rrp: 649.62 },
  { name: 'CB SHAKERZ 300mls X12',        vatCat: 'B', rrp: 105.01 },
  { name: 'AQUA CLEAR 500mls',            vatCat: 'B', rrp: 51 },
  { name: 'AQUA CLEAR 1000mls',           vatCat: 'B', rrp: 91.6 },
  { name: 'PEPSI RGB 350mls',             vatCat: 'B', rrp: 120 },
  { name: 'PEPSI PET 330mls',             vatCat: 'B', rrp: 79.56 },
  { name: 'PEPSI RGB 500ml',              vatCat: 'B', rrp: 128 },
  { name: 'PESI PET 500mls',              vatCat: 'B', rrp: 99 },
  { name: 'AQUACLEAR PET 750ML',          vatCat: 'B', rrp: 62.16 },
  { name: 'PESI PET 1000mls',             vatCat: 'B', rrp: 84 },
  { name: 'CB MILK MAHUE 500',            vatCat: 'B', rrp: 119 },
  { name: 'CB SHAKERZ 500mls X12',        vatCat: 'B', rrp: 151.04 },
  { name: 'PESI PET 2000 mls',            vatCat: 'B', rrp: 144 },
  { name: 'STING',                        vatCat: 'B', rrp: 88.08 },
  { name: 'CONTAINER 18.9',               vatCat: 'D', rrp: null },
  { name: 'EMPTY ZB',                     vatCat: 'D', rrp: null },
  { name: 'EMPTY S/D',                    vatCat: 'D', rrp: null },
  { name: 'BEER BOTTLE',                  vatCat: 'D', rrp: null },
  { name: 'BEER BOX',                     vatCat: 'D', rrp: null },
  { name: 'S/D BOTTLE',                   vatCat: 'D', rrp: null },
  { name: 'SIMBA 120g',                   vatCat: 'A', rrp: null },
  { name: 'CHEETOS 35GX20',               vatCat: 'B', rrp: null },
  { name: 'CB POUCH MILK PLUS 500mls X20',vatCat: 'D', rrp: null },
  { name: 'CB UHT MILK PLUS 500mls X12',  vatCat: 'D', rrp: null },
  { name: 'CB MILK POUCH 475mls  X 20',   vatCat: 'D', rrp: null },
  { name: 'CB MILK POUCH 225mls X 40',    vatCat: 'D', rrp: null },
  { name: 'CB MILK POUCH 225mls X 20',    vatCat: 'D', rrp: null },
  { name: 'BUZZ 100G',                    vatCat: 'A', rrp: null },
  { name: 'LAYS 23X30',                   vatCat: 'A', rrp: null },
  { name: 'LAYS 105 X 20',                vatCat: 'A', rrp: null },
  { name: 'HEINEKEN NRB',                 vatCat: 'A', rrp: null },
  { name: 'SAVANNA DRY',                  vatCat: 'A', rrp: null },
  { name: 'HUNTERS GOLD',                 vatCat: 'A', rrp: null },
  { name: 'HUNTERS DRY',                  vatCat: 'A', rrp: null },
];

const dryRun = process.argv.includes('--dry-run');

function normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function patchDb(label, db) {
  if (!db) {
    console.error(`[rrp] ${label}: DB not available, skipping`);
    return;
  }
  const products = db.prepare(`SELECT id, name, zra_vat_cat_cd, zra_rrp FROM products WHERE deleted_at IS NULL`).all();
  const nameIndex = new Map();
  for (const p of products) {
    const key = normName(p.name);
    if (!nameIndex.has(key)) nameIndex.set(key, []);
    nameIndex.get(key).push(p);
  }

  const upd = db.prepare(`UPDATE products SET
      zra_vat_cat_cd = ?,
      zra_rrp        = ?,
      updated_at     = datetime('now'),
      synced         = 0
    WHERE id = ?`);

  let matched = 0, updated = 0, alreadyOk = 0, unmatched = [];
  const tx = db.transaction(() => {
    for (const row of RRP_ROWS) {
      const hits = nameIndex.get(normName(row.name));
      if (!hits || hits.length === 0) {
        unmatched.push(row.name);
        continue;
      }
      matched += hits.length;
      for (const p of hits) {
        const targetCat = row.vatCat;
        const targetRrp = row.rrp; // may be null
        const catMatches = (p.zra_vat_cat_cd || '') === targetCat;
        const rrpMatches = (targetRrp === null)
          ? (p.zra_rrp == null || p.zra_rrp === 0)
          : (Number(p.zra_rrp) === Number(targetRrp));
        if (catMatches && rrpMatches) { alreadyOk++; continue; }
        if (!dryRun) upd.run(targetCat, targetRrp, p.id);
        updated++;
      }
    }
  });
  tx();

  console.log(`[rrp] ${label}:`);
  console.log(`      matched     : ${matched} product row(s) hit by name`);
  console.log(`      updated     : ${updated} row(s) ${dryRun ? '(dry-run â€” no writes)' : 'written'}`);
  console.log(`      already ok  : ${alreadyOk} row(s) already at target values`);
  console.log(`      unmatched   : ${unmatched.length} spreadsheet row(s) not found in DB`);
  if (unmatched.length) {
    for (const n of unmatched) console.log(`                    - ${n}`);
  }
}

const target = (process.argv[2] || '').toLowerCase();
if (!target) {
  console.error('Usage: node scripts/setRrpFromExcel.js hq | <slug> | all  [--dry-run]');
  process.exit(1);
}

if (dryRun) console.log('[rrp] DRY-RUN mode â€” no database writes will be made.');

if (target === 'all') {
  patchDb('hq (kelete.db)', defaultDb);
  const tenants = listTenants();
  console.log(`[rrp] found ${tenants.length} tenant(s): ${tenants.map(t => t.slug).join(', ')}`);
  for (const t of tenants) patchDb(t.slug, getTenantDb(t.slug));
} else if (target === 'hq') {
  patchDb('hq (kelete.db)', defaultDb);
} else {
  patchDb(target, getTenantDb(target));
}

console.log('[rrp] done.');
