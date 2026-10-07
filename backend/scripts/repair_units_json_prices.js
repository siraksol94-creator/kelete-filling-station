// Repair products whose units_json price disagrees with selling_price.
// 2026-08-31
//
// WHY THIS EXISTS: align_prices_to_chipata.sql set products.selling_price
// directly. That was incomplete. The POS prices a line from units_json first
// (POS.js:4369) and only falls back to selling_price when the unit is absent,
// so those 13 items would still have rung up at the OLD price. Quick Price
// reads the same field, so the old number would have stared back from the
// screen too.
//
// Worse, bulk-push-prices ships units_json to the branches verbatim. Pushing
// before this repair would have sent new selling_price + old units_json to
// every till â€” looking like it worked while charging the old price.
//
// This mirrors what routes/products.js bulk-update-prices does: every
// packaging's price = base price x conv. Written in Node, not SQL, so keys
// other than price survive â€” a json_object() rebuild would silently drop any
// field this script doesn't know about.
//
// OVERRIDES ARE PRESERVED. A non-base unit whose stored price differs from
// (old base x conv) by more than a cent was priced deliberately â€” a shop
// selling a Six Pack at an unequal price â€” and is left exactly as it is.
// Only re-derived cells move. This is the same override test QuickPrice.js
// uses to decide what is intentional.
//
// Run (reports only, changes nothing):
//   cd /var/www/kelete-pos-tenant
//   node backend/scripts/repair_units_json_prices.js
//
// Then, to actually write:
//   cp backend/kelete.db backend/kelete.db.bak-$(date +%F-unitsjson)
//   node backend/scripts/repair_units_json_prices.js --apply
//
// Idempotent: once repaired, a second run reports nothing to do.

const path = require('path');
const Database = require('better-sqlite3');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_PATH || path.join(__dirname, '..', 'kelete.db');
const db = new Database(DB);

const rows = db.prepare(`
  SELECT id, code, name, selling_price, alt_price, units_json
    FROM products
   WHERE deleted_at IS NULL AND units_json IS NOT NULL AND units_json != ''
`).all();

const upd = db.prepare(`UPDATE products
   SET units_json = ?, alt_price = ?, updated_at = datetime('now'), synced = 0
 WHERE id = ?`);

const drift = [];
const kept  = [];

for (const p of rows) {
  let units;
  try { units = JSON.parse(p.units_json); } catch { continue; }
  if (!Array.isArray(units) || units.length === 0) continue;

  // The base unit is conv=1. Fall back to the last entry, which is how
  // QuickPrice.js resolves it when is_base is missing.
  const baseUnit = units.find(u => u.is_base) || units[units.length - 1];
  const oldBase  = parseFloat(baseUnit?.price) || 0;
  const target   = parseFloat(p.selling_price) || 0;

  if (Math.abs(oldBase - target) < 0.005) continue;   // already agrees

  const next = units.map(u => {
    const conv    = parseFloat(u.conv) || 1;
    const stored  = parseFloat(u.price) || 0;
    const derived = parseFloat((oldBase * conv).toFixed(4));
    // A non-base cell that never matched the old cascade was set by hand.
    if (!u.is_base && oldBase > 0 && Math.abs(stored - derived) > 0.01) {
      kept.push(`${p.code} ${u.name} @ ${stored}`);
      return { ...u };
    }
    return { ...u, price: parseFloat((target * conv).toFixed(4)) };
  });

  const nonBase = next.find(u => !u.is_base);
  drift.push({ p, oldBase, target, next, altPrice: nonBase ? nonBase.price : p.alt_price });
}

console.log(`\n${DB}`);
console.log(`${rows.length} products with units_json, ${drift.length} disagreeing with selling_price\n`);

if (drift.length) {
  console.log('code    | item                          | units_json | selling_price');
  console.log('--------+-------------------------------+------------+--------------');
  for (const d of drift) {
    console.log(
      `${(d.p.code || '').padEnd(7)} | ${(d.p.name || '').slice(0, 29).padEnd(29)} | ` +
      `${String(d.oldBase).padStart(10)} | ${String(d.target).padStart(13)}`
    );
  }
}

if (kept.length) {
  console.log(`\nper-unit overrides left untouched (${kept.length}):`);
  for (const k of kept) console.log('  ' + k);
}

if (!APPLY) {
  console.log(drift.length
    ? '\nDRY RUN â€” nothing written. Re-run with --apply to fix.\n'
    : '\nNothing to do.\n');
  process.exit(0);
}

const tx = db.transaction(() => {
  for (const d of drift) upd.run(JSON.stringify(d.next), d.altPrice, d.p.id);
});
tx();
console.log(`\nRepaired ${drift.length} product(s). synced=0 set on each.\n`);
