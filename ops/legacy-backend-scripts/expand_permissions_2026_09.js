/**
 * expand_permissions_2026_09.js — 2026-09-03
 *
 * Seven branch pages used to render off another page's permission:
 *
 *   Quick Price, Opening Balance          rode on  Items
 *   Sales Stock Card, Incoming Stock,
 *   Inter-Branch Transfers                rode on  Inventory
 *   VAT Transaction Report                rode on  SalesReport
 *   Empty Vouchers                        rode on  GRN / SIV
 *
 * They now carry their own keys so each can be granted or revoked on its own.
 * Without this script, every existing user would silently lose those pages the
 * moment the new build goes live — staff would arrive to a shorter menu with no
 * explanation. So: grant the new key wherever the user already holds the old
 * one, action for action. Nobody gains access they did not already have.
 *
 * Users on the old FLAT permissions ('Stock', 'Sales', 'GRN') are covered by
 * LEGACY_MAP in frontend/src/context/AuthContext.js and are left alone here.
 * Users on 'All' need nothing.
 *
 * DRY RUN BY DEFAULT.
 *
 *   node backend/scripts/expand_permissions_2026_09.js            # show
 *   node backend/scripts/expand_permissions_2026_09.js --apply    # write
 *   node backend/scripts/expand_permissions_2026_09.js katete --apply
 *
 * Idempotent — a second run adds nothing.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { getTenantDb } = require('../config/tenantDb');
const { listTenants } = require('../config/masterDb');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY = args.filter(a => !a.startsWith('--'))[0] || null;

// new key  ->  the key it used to render off
const INHERITS = {
  QuickPrice:      ['Items'],
  OpeningBalance:  ['Items'],
  SalesStockCard:  ['Inventory'],
  IncomingStock:   ['Inventory'],
  BranchTransfers: ['Inventory'],
  VATReport:       ['SalesReport'],
  EmptyVouchers:   ['GRN', 'SIV'],
};
const ACTIONS = ['View', 'Add', 'Edit', 'Delete'];

function expand(perms) {
  const held = new Set(perms);
  const added = [];
  for (const [newKey, parents] of Object.entries(INHERITS)) {
    for (const action of ACTIONS) {
      const target = newKey + ':' + action;
      if (held.has(target)) continue;
      if (parents.some(p => held.has(p + ':' + action))) {
        held.add(target);
        added.push(target);
      }
    }
  }
  return { perms: Array.from(held), added };
}

let touched = 0, scanned = 0;
for (const t of listTenants()) {
  if (ONLY && t.slug !== ONLY) continue;
  let db;
  try { db = getTenantDb(t.slug); } catch (_) { continue; }

  let users = [];
  try {
    users = db.prepare(
      "SELECT id, first_name, last_name, permissions FROM users WHERE deleted_at IS NULL"
    ).all();
  } catch (_) { continue; }

  const lines = [];
  for (const u of users) {
    scanned++;
    let perms;
    try { perms = JSON.parse(u.permissions || '[]'); } catch (_) { continue; }
    if (!Array.isArray(perms)) continue;
    // 'All' / 'Full Access' already covers everything.
    if (perms.includes('All') || perms.includes('Full Access')) continue;

    const { perms: next, added } = expand(perms);
    if (!added.length) continue;

    const who = ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || ('user#' + u.id);
    lines.push('  ' + who.padEnd(24) + '+' + added.length + '  ' + added.join(', '));
    touched++;
    if (APPLY) {
      db.prepare("UPDATE users SET permissions = ?, updated_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(next), u.id);
    }
  }
  if (lines.length) {
    console.log('\n=== ' + t.slug);
    lines.forEach(l => console.log(l));
  }
}

console.log('\n' + (APPLY ? 'APPLIED' : 'DRY RUN') + ' — ' + scanned +
  ' user(s) scanned, ' + touched + ' would change');
if (!APPLY) console.log('Re-run with --apply to write.');
process.exit(0);
