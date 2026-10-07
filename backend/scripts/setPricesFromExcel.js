/**
 * setPricesFromExcel.js â€” v1.13.105 (2026-07-29)
 *
 * One-shot: apply the Red Sea Selling PRICE schedule (77 SKUs) from the
 * ZRA 2 spreadsheet to products.selling_price. Prices embedded below so
 * the script is self-contained.
 *
 * Matching:
 *   - Case-insensitive on products.name (whitespace normalised).
 *   - Multiple rows with the same name â†’ all updated to the same price.
 *   - Rows in the DB not on the list are left untouched.
 *   - Only the top-level products.selling_price column is written. Per-
 *     packaging prices inside units_json are branch-owned and NOT touched
 *     â€” configure Box/Piece prices via Item Details UI once the top-level
 *     is set, since the xlsx has one price per SKU without conversion.
 *
 * Idempotent â€” running twice does nothing (WHERE clause skips rows already
 * at the target values).
 *
 * Usage on VPS:
 *   node backend/scripts/setPricesFromExcel.js hq                    # HQ mirror only
 *   node backend/scripts/setPricesFromExcel.js buseko                # one branch
 *   node backend/scripts/setPricesFromExcel.js all                   # HQ + every branch
 *   node backend/scripts/setPricesFromExcel.js buseko --dry-run      # preview only
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { defaultDb } = require('../config/database');
const { getTenantDb } = require('../config/tenantDb');
const { listTenants } = require('../config/masterDb');

// Verbatim from Red Sea's ZRA 2 selling-price spreadsheet (2026-07-29).
const PRICE_ROWS = [
  { name: 'Black Label 375ml',            price: 325 },
  { name: 'Mosi 375ml',                   price: 280 },
  { name: 'MOSI 750ml',                   price: 240 },
  { name: 'MOSI LIGHT',                   price: 240 },
  { name: 'MOSI CANNED',                  price: 540 },
  { name: 'BLACK LABEL 750mls',           price: 275 },
  { name: 'BLACK LABEL NRB 34mls',        price: 490 },
  { name: 'BLACK LABEL CANNED',           price: 590 },
  { name: 'CASTLE 375mls',                price: 325 },
  { name: 'CASTLE 750mls',                price: 275 },
  { name: 'CASTLE LITE RGB',              price: 325 },
  { name: 'CASTLE LITE 660mls',           price: 275 },
  { name: 'CASTLE LITE NRB',              price: 480 },
  { name: 'CASTLE LITE CANNED',           price: 630 },
  { name: 'EAGLE 750mls',                 price: 160 },
  { name: 'EAGLE 375mls',                 price: 180 },
  { name: 'EAGLE EXTERA 375mls',          price: 180 },
  { name: 'FLYING FISH NRB',              price: 470 },
  { name: 'FLYING FISH CANNED',           price: 580 },
  { name: 'BRUTAL FRUIT NRB',             price: 465 },
  { name: 'BRUTAL FRUIT CANNED',          price: 670 },
  { name: 'BUDWEISER',                    price: 665 },
  { name: 'STELLA',                       price: 665 },
  { name: 'CORONA',                       price: 665 },
  { name: 'SMIRNOFF SPIN',                price: 505 },
  { name: 'SOFT DRINK 500mls',            price: 125 },
  { name: 'COKE PET 350mls',              price: 90 },
  { name: 'COKE RGB 300mls',              price: 113 },
  { name: 'MAZOE 2LTR',                   price: 205 },
  { name: 'MIXERS',                       price: 383 },
  { name: 'CAN COKE 300mls',              price: 383 },
  { name: 'CAN COKE 500mls',              price: 288 },
  { name: 'SOFT DRINK 1 lit',             price: 91 },
  { name: 'SOFT DRINK 2 lit',             price: 150 },
  { name: 'CAN CAPPY',                    price: 502 },
  { name: 'MONSTER',                      price: 757.5 },
  { name: 'PREDATOR',                     price: 391 },
  { name: 'JOLLY JUICE',                  price: 161 },
  { name: 'SCOLL X6',                     price: 70 },
  { name: 'AQUA SAVANA WATER 500mls',     price: 50 },
  { name: 'AQUA SAVANA WATER 750mls',     price: 60 },
  { name: 'WATER 18.9 mls',               price: 60 },
  { name: 'MINUTE MAID 500mls X 12',      price: 142 },
  { name: 'Appletiser/Grapetiser 300ml',  price: 622 },
  { name: 'CB SHAKERZ 300mls X12',        price: 101 },
  { name: 'AQUA CLEAR 500mls',            price: 50 },
  { name: 'AQUA CLEAR 1000mls',           price: 90 },
  { name: 'PEPSI RGB 350mls',             price: 118 },
  { name: 'PEPSI PET 330mls',             price: 77.5 },
  { name: 'PEPSI RGB 500ml',              price: 125 },
  { name: 'PESI PET 500mls',              price: 96 },
  { name: 'AQUACLEAR PET 750ML',          price: 60 },
  { name: 'PESI PET 1000mls',             price: 81 },
  { name: 'CB MILK MAHUE 500',            price: 115 },
  { name: 'CB SHAKERZ 500mls X12',        price: 146 },
  { name: 'PESI PET 2000 mls',            price: 141 },
  { name: 'STING',                        price: 84 },
  { name: 'CONTAINER 18.9',               price: 10 },
  { name: 'EMPTY ZB',                     price: 57 },
  { name: 'EMPTY S/D',                    price: 120 },
  { name: 'BEER BOTTLE',                  price: 30 },
  { name: 'BEER BOX',                     price: 21 },
  { name: 'S/D BOTTLE',                   price: 72 },
  { name: 'SIMBA 120g',                   price: 780 },
  { name: 'CHEETOS 35GX20',               price: 128 },
  { name: 'CB POUCH MILK PLUS 500mls X20',price: 260 },
  { name: 'CB UHT MILK PLUS 500mls X12',  price: 177 },
  { name: 'CB MILK POUCH 475mls  X 20',   price: 236 },
  { name: 'CB MILK POUCH 225mls X 40',    price: 240 },
  { name: 'CB MILK POUCH 225mls X 20',    price: 122 },
  { name: 'BUZZ 100G',                    price: 115 },
  { name: 'LAYS 23X30',                   price: 240 },
  { name: 'LAYS 105 X 20',                price: 640 },
  { name: 'HEINEKEN NRB',                 price: 720 },
  { name: 'SAVANNA DRY',                  price: 715 },
  { name: 'HUNTERS GOLD',                 price: 660 },
  { name: 'HUNTERS DRY',                  price: 660 },
];

const dryRun = process.argv.includes('--dry-run');

function normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function patchDb(label, db) {
  if (!db) {
    console.error(`[prices] ${label}: DB not available, skipping`);
    return;
  }
  const products = db.prepare(`SELECT id, name, selling_price FROM products WHERE deleted_at IS NULL`).all();
  const nameIndex = new Map();
  for (const p of products) {
    const key = normName(p.name);
    if (!nameIndex.has(key)) nameIndex.set(key, []);
    nameIndex.get(key).push(p);
  }

  const upd = db.prepare(`UPDATE products SET
      selling_price = ?,
      updated_at    = datetime('now'),
      synced        = 0
    WHERE id = ?`);

  let matched = 0, updated = 0, alreadyOk = 0, unmatched = [];
  const tx = db.transaction(() => {
    for (const row of PRICE_ROWS) {
      const hits = nameIndex.get(normName(row.name));
      if (!hits || hits.length === 0) {
        unmatched.push(row.name);
        continue;
      }
      matched += hits.length;
      for (const p of hits) {
        if (Number(p.selling_price) === Number(row.price)) { alreadyOk++; continue; }
        if (!dryRun) upd.run(row.price, p.id);
        updated++;
      }
    }
  });
  tx();

  console.log(`[prices] ${label}:`);
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
  console.error('Usage: node backend/scripts/setPricesFromExcel.js hq | <slug> | all  [--dry-run]');
  process.exit(1);
}

if (dryRun) console.log('[prices] DRY-RUN mode â€” no database writes will be made.');

if (target === 'all') {
  patchDb('hq (kelete.db)', defaultDb);
  const tenants = listTenants();
  console.log(`[prices] found ${tenants.length} tenant(s): ${tenants.map(t => t.slug).join(', ')}`);
  for (const t of tenants) patchDb(t.slug, getTenantDb(t.slug));
} else if (target === 'hq') {
  patchDb('hq (kelete.db)', defaultDb);
} else {
  patchDb(target, getTenantDb(target));
}

console.log('[prices] done.');
