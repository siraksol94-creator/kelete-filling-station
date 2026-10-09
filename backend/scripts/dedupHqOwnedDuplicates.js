/**
 * dedupHqOwnedDuplicates.js — v1.13.105 (2026-07-29)
 *
 * One-shot: on branch tenant DBs (buseko, garden, ...), find HQ-owned rows
 * that share the same NAME but have different sync_ids and reconcile them
 * onto the canonical HQ sync_id.
 *
 * Root cause this repairs: the /sync/push handler used to match rows by
 * sync_id only and INSERT when no match was found. When an Electron install
 * (whose local HQ mints its own sync_ids for the same product names) pushed
 * a branch's rows upstream, VPS didn't recognise the sync_ids → INSERTed →
 * every product name ended up with two rows in the branch DB. v1.13.105
 * adds a guard in /sync/push that stops the recurrence; this script cleans
 * the rows that already got in.
 *
 * Reconciliation rule per name:
 *   - "canonical" = the sync_id of the same-named row in the HQ default DB
 *     (backend/kelete.db). That's the sync_id mirrorAllHqToBranches will
 *     re-push, so it must be the one that stays.
 *   - Every other same-name row in the branch DB is an "orphan":
 *       1. Rewire every *_sync_id FK across all sync tables that references
 *          the orphan sync_id → point at canonical instead.
 *       2. Soft-delete the orphan row (deleted_at=now, synced=0) so the
 *          deletion propagates to Electron on next /sync/pull.
 *   - If NO branch row matches HQ's sync_id (Electron ran alone, never
 *     received the HQ mirror), the OLDEST branch row is promoted to
 *     canonical and the rest are treated as orphans. That keeps FK history
 *     intact and mirrorAllHqToBranches on next boot will UPDATE the row
 *     with HQ's data — but its sync_id will still diverge from HQ's, so
 *     future HQ pushes create a second row again. Re-run this script after
 *     HQ push in that case.
 *
 * Idempotent — running twice does nothing. --dry-run previews without
 * writing.
 *
 * Usage on VPS:
 *   node backend/scripts/dedupHqOwnedDuplicates.js buseko            # one branch
 *   node backend/scripts/dedupHqOwnedDuplicates.js all               # every branch
 *   node backend/scripts/dedupHqOwnedDuplicates.js all --dry-run     # preview only
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { defaultDb } = require('../config/database');
const { getTenantDb } = require('../config/tenantDb');
const { listTenants } = require('../config/masterDb');

const dryRun = process.argv.includes('--dry-run');

// FK columns that reference a product's sync_id. Rewired when a duplicate
// product is collapsed onto its canonical sibling.
const PRODUCT_FKS = [
  { table: 'stock_movements',            col: 'product_sync_id' },
  { table: 'grn_items',                  col: 'product_sync_id' },
  { table: 'grn_items',                  col: 'container_product_sync_id' },
  { table: 'siv_items',                  col: 'product_sync_id' },
  { table: 'order_items',                col: 'product_sync_id' },
  { table: 'production_inputs',          col: 'product_sync_id' },
  { table: 'production_outputs',         col: 'product_sync_id' },
  { table: 'sales_return_items',         col: 'product_sync_id' },
  { table: 'stock_adjustments',          col: 'product_sync_id' },
  { table: 'empty_return_items',         col: 'product_sync_id' },
  { table: 'supplier_credit_note_items', col: 'product_sync_id' },
  { table: 'daily_actual_balance',       col: 'product_sync_id' },
  { table: 'daily_cost_snapshot',        col: 'product_sync_id' },
  { table: 'stock_reconciliation_items', col: 'product_sync_id' },
  { table: 'products',                   col: 'container_product_sync_id' },
  { table: 'business_settings',          col: 'empty_container_product_sync_id' },
];

// FK columns for categories and main_categories.
const CATEGORY_FKS = [
  { table: 'products', col: 'category_sync_id' },
];
const MAIN_CATEGORY_FKS = [
  { table: 'categories', col: 'main_category_sync_id' },
];
// Units are referenced by name string (products.unit), not sync_id — no
// FK rewire needed. Duplicate unit rows are safe to soft-delete directly.
const UNIT_FKS = [];

function normName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function tableExists(db, name) {
  const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return !!r;
}

function columnExists(db, table, col) {
  if (!tableExists(db, table)) return false;
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  return info.some(c => c.name === col);
}

// Returns Map<normName, canonicalSyncId> from the HQ default DB. Only rows
// still live (deleted_at IS NULL) count as canonical — a deleted HQ row is
// not authoritative.
function buildCanonicalMap(hqDb, table) {
  const map = new Map();
  if (!tableExists(hqDb, table)) return map;
  const rows = hqDb.prepare(`SELECT name, sync_id FROM ${table} WHERE deleted_at IS NULL AND sync_id IS NOT NULL AND sync_id != ''`).all();
  for (const r of rows) {
    const key = normName(r.name);
    if (!map.has(key)) map.set(key, r.sync_id);
  }
  return map;
}

function dedupTable(label, branchDb, hqDb, table, fks) {
  if (!tableExists(branchDb, table)) return { skipped: true };
  const canonical = buildCanonicalMap(hqDb, table);

  const rows = branchDb.prepare(`SELECT id, name, sync_id, created_at, deleted_at FROM ${table} WHERE deleted_at IS NULL AND sync_id IS NOT NULL AND sync_id != ''`).all();

  const byName = new Map();
  for (const r of rows) {
    const key = normName(r.name);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(r);
  }

  let groups = 0, rewired = 0, softDeleted = 0, orphanedGroups = 0;
  const problems = [];

  const softDelete = branchDb.prepare(`UPDATE ${table} SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?`);

  const rewireStmts = new Map();
  function rewireOne(fk, fromSyncId, toSyncId) {
    if (!columnExists(branchDb, fk.table, fk.col)) return 0;
    const key = `${fk.table}.${fk.col}`;
    if (!rewireStmts.has(key)) {
      rewireStmts.set(key, branchDb.prepare(`UPDATE ${fk.table} SET ${fk.col} = ? WHERE ${fk.col} = ?`));
    }
    const r = rewireStmts.get(key).run(toSyncId, fromSyncId);
    return r.changes || 0;
  }

  const tx = branchDb.transaction(() => {
    for (const [name, group] of byName.entries()) {
      if (group.length < 2) continue;
      groups++;

      let canonicalSyncId = canonical.get(name);
      const groupSyncIds = new Set(group.map(g => g.sync_id));
      if (!canonicalSyncId || !groupSyncIds.has(canonicalSyncId)) {
        const sorted = [...group].sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
        canonicalSyncId = sorted[0].sync_id;
        orphanedGroups++;
        problems.push(`  [orphan-group] name="${group[0].name}" — no HQ match; keeping oldest sync_id=${canonicalSyncId}`);
      }

      for (const r of group) {
        if (r.sync_id === canonicalSyncId) continue;
        for (const fk of fks) {
          const n = dryRun ? 0 : rewireOne(fk, r.sync_id, canonicalSyncId);
          rewired += n;
        }
        if (!dryRun) softDelete.run(r.id);
        softDeleted++;
      }
    }
  });
  tx();

  return { groups, rewired, softDeleted, orphanedGroups, problems, rowsScanned: rows.length };
}

function dedupBranch(slug, branchDb, hqDb) {
  console.log(`\n[dedup] === ${slug} ===`);
  if (!branchDb) { console.error(`[dedup] ${slug}: branch DB not available, skipping`); return; }

  const plan = [
    { table: 'main_categories', fks: MAIN_CATEGORY_FKS },
    { table: 'categories',      fks: CATEGORY_FKS },
    { table: 'units',           fks: UNIT_FKS },
    { table: 'products',        fks: PRODUCT_FKS },
  ];

  for (const step of plan) {
    const result = dedupTable(slug, branchDb, hqDb, step.table, step.fks);
    if (result.skipped) { console.log(`  ${step.table.padEnd(18)}: (table missing, skipped)`); continue; }
    console.log(`  ${step.table.padEnd(18)}: scanned=${result.rowsScanned}  duplicate-name-groups=${result.groups}  orphan-only-groups=${result.orphanedGroups}  rows soft-deleted=${result.softDeleted}${dryRun ? ' (dry-run)' : ''}  FK cells rewired=${result.rewired}${dryRun ? ' (dry-run — not written)' : ''}`);
    for (const p of result.problems || []) console.log(p);
  }
}

const target = (process.argv[2] || '').toLowerCase();
if (!target) {
  console.error('Usage: node backend/scripts/dedupHqOwnedDuplicates.js <slug> | all  [--dry-run]');
  process.exit(1);
}

if (dryRun) console.log('[dedup] DRY-RUN mode — no database writes will be made.');

const hqDb = defaultDb;

if (target === 'all') {
  const tenants = listTenants();
  console.log(`[dedup] found ${tenants.length} tenant(s): ${tenants.map(t => t.slug).join(', ')}`);
  for (const t of tenants) dedupBranch(t.slug, getTenantDb(t.slug), hqDb);
} else {
  dedupBranch(target, getTenantDb(target), hqDb);
}

console.log('\n[dedup] done.');
