#!/usr/bin/env node
// Compare two branch databases table by table.
// 2026-09-01
//
//   node backend/scripts/compare_branches.js --branch=buseko --against=malambo
//
// WHY: before wiping a branch that has been used for testing, the question is
// not "what does the wipe script clear" but "what does this branch hold that a
// clean branch does not". Those are different questions, and only the second
// one is answered by the data. A freshly loaded depot — Malambo, Chibombo, any
// of the thirteen — is the reference: whatever it has is normal, and every row
// above that is test residue.
//
// Lists EVERY table in both databases, so a table nobody thought of shows up
// on its own rather than being missed because it was not on a list.
//
// Reads only. Writes nothing, ever.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const get = (k) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1].trim().toLowerCase() : null; };
const A = get('branch');
const B = get('against');

if (!A) {
  console.error('\n  node backend/scripts/compare_branches.js --branch=buseko --against=malambo\n');
  process.exit(1);
}

const TEN = path.join(__dirname, '..', '..', 'tenants');
const pathFor = (slug) => path.join(TEN, `${slug}.db`);

for (const s of [A, B].filter(Boolean)) {
  if (!/^[a-z0-9_-]+$/.test(s)) { console.error(`\nRefusing: "${s}" is not a plausible slug.\n`); process.exit(1); }
  if (!fs.existsSync(pathFor(s))) { console.error(`\nRefusing: ${pathFor(s)} does not exist.\n`); process.exit(1); }
}

const open = (s) => new Database(pathFor(s), { readonly: true });
const tablesOf = (db) => db.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
).all().map(r => r.name);
const countOf = (db, t) => { try { return db.prepare(`SELECT COUNT(*) n FROM "${t}"`).get().n; } catch { return null; } };

const dbA = open(A);
const dbB = B ? open(B) : null;

const names = [...new Set(tablesOf(dbA).concat(dbB ? tablesOf(dbB) : []))].sort();

const rows = names.map(t => ({
  table: t,
  a: countOf(dbA, t),
  b: dbB ? countOf(dbB, t) : null,
}));

const fmt = (v) => v === null ? '—' : String(v);

console.log(`\n  A = ${A}${B ? `        B = ${B} (reference, freshly loaded)` : ''}\n`);
console.log('  ' + 'table'.padEnd(34) + A.padStart(9) + (B ? B.padStart(11) + '   only in A' : ''));
console.log('  ' + '-'.repeat(34) + ' ' + '-'.repeat(8) + (B ? ' ' + '-'.repeat(10) + '   ' + '-'.repeat(11) : ''));

let extraTotal = 0;
const extraTables = [];
for (const r of rows) {
  if (!r.a && !r.b) continue;                       // both empty, nothing to say
  const diff = (r.a || 0) - (r.b || 0);
  const flag = B && diff > 0 ? `   +${diff}` : '';
  if (B && diff > 0) { extraTotal += diff; extraTables.push(r.table); }
  console.log('  ' + r.table.padEnd(34) + fmt(r.a).padStart(9) + (B ? fmt(r.b).padStart(11) + flag : ''));
}

if (B) {
  console.log(`\n  ${extraTables.length} table(s) hold more in ${A} than in ${B}, ${extraTotal} row(s) in total:`);
  console.log('  ' + (extraTables.join(', ') || '(none)'));
  console.log(`\n  Those tables are what a wipe of ${A} has to cover. Anything listed here`);
  console.log(`  and NOT in wipe_branch.js's CLEAR list would survive the wipe.`);
}

// Accounts receivable and the other balance-carrying places are easy to miss
// because they are small and quiet. Call them out by name.
console.log('\n  --- balances that outlive a transaction wipe ---');
const probes = [
  ['customers',          'SELECT COUNT(*) n FROM customers WHERE COALESCE(balance,0) <> 0',        'customers carrying a balance (receivables)'],
  ['suppliers',          'SELECT COUNT(*) n FROM suppliers WHERE COALESCE(balance,0) <> 0',        'suppliers carrying a balance (payables)'],
  ['capital_account',    'SELECT COUNT(*) n FROM capital_account',                                  'capital account entries'],
  ['dividend_account',   'SELECT COUNT(*) n FROM dividend_account',                                 'dividend entries'],
  ['shareholders',       'SELECT COUNT(*) n FROM shareholders',                                     'shareholders'],
  ['loans',              'SELECT COUNT(*) n FROM loans',                                            'loans'],
  ['loan_transactions',  'SELECT COUNT(*) n FROM loan_transactions',                                'loan transactions'],
  ['products',           'SELECT COUNT(*) n FROM products WHERE COALESCE(current_stock,0) <> 0',   'products still showing stock'],
];
for (const [tbl, sql, label] of probes) {
  let a = null, b = null;
  try { a = dbA.prepare(sql).get().n; } catch { a = null; }
  if (dbB) { try { b = dbB.prepare(sql).get().n; } catch { b = null; } }
  if (a === null && b === null) continue;
  const mark = (dbB && (a || 0) > (b || 0)) ? '   <-- more than the reference' : '';
  console.log('  ' + label.padEnd(44) + fmt(a).padStart(7) + (dbB ? fmt(b).padStart(9) : '') + mark);
}
console.log('');
