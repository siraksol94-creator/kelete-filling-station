/**
 * v1.10.75 â€” one-off migration:
 *   master.hq_suppliers                  â†’ hq.db.suppliers
 *   master.hq_grns                       â†’ hq.db.grn   (total_amount = final_payable)
 *   master.hq_grn_items                  â†’ hq.db.grn_items
 *   master.hq_supplier_credit_notes      â†’ hq.db.supplier_credit_notes
 *   master.hq_supplier_credit_note_items â†’ hq.db.supplier_credit_note_items
 *
 * WHY:
 *   v1.10.72 already moved hq_supplier_payments â†’ hq.db.ap_payments.
 *   This ships the rest, so HQ Suppliers + Account Payables + Cash Book
 *   all read from ONE source (hq.db) â€” no more cross-DB reads, no more
 *   $0 vs $485K mismatch between HQ Suppliers page and Account Payables
 *   page. Aligns with the memoised architecture: Suppliers/AP is HQ-only,
 *   HQ is itself a tenant, so the branch-style ap tables apply.
 *
 * SAFETY:
 *   * Idempotent â€” each row skipped if its sync_id already exists in the
 *     destination table.
 *   * Preserves original master.hq_suppliers.id â†’ hq.db.suppliers.id so
 *     the existing HQ Suppliers URL routes keep resolving to the same
 *     records after migration.
 *   * Read-only on master â€” the historical rows stay as an audit trail.
 *     No code path reads them after v1.10.75 refactor of hqSuppliers.js.
 *   * Prints before/after counts per table so the operator can eyeball.
 *
 * HOW TO RUN (once, on VPS from the project root):
 *   cp tenants/hq.db tenants/hq.db.bak-before-v75
 *   node backend/scripts/migrate_hq_suppliers_and_grns_to_tenant.js
 */

const { randomUUID } = require('crypto');
const { masterDb, listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');

function getHqSlug() {
  try {
    const t = listTenants().find(t => t.slug === 'hq');
    if (t) return 'hq';
    const bare = listTenants().find(t => /^(kelete|keletedistributionzm|hq)$/i.test(t.slug));
    return bare ? bare.slug : 'hq';
  } catch (_) { return 'hq'; }
}

function migrateSuppliers(masterDb, hqDb) {
  const rows = masterDb.prepare(`SELECT * FROM hq_suppliers`).all();
  const before = hqDb.prepare(`SELECT COUNT(*) AS n FROM suppliers`).get().n;

  // sync_id doesn't exist on master.hq_suppliers, so match by lowercase name.
  const findByName = hqDb.prepare(`SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?) LIMIT 1`);
  const insSup = hqDb.prepare(`
    INSERT INTO suppliers (id, name, phone, email, address, contact_person,
                            status, sync_id, tenant_id, branch_id, device_id,
                            synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)
  `);
  const nameToSyncId = new Map(); // name (lower) â†’ sync_id in hq.db
  const nameToNewId  = new Map(); // name (lower) â†’ id in hq.db

  let inserted = 0, skipped = 0;
  hqDb.transaction(() => {
    for (const r of rows) {
      const nameKey = String(r.name || '').toLowerCase();
      const existing = findByName.get(r.name);
      if (existing) {
        // Row already lives in hq.db (maybe from a prior run or from a
        // manually-created supplier). Record its sync_id so downstream
        // GRN/CN copies still resolve.
        const ex = hqDb.prepare(`SELECT sync_id, id FROM suppliers WHERE id = ?`).get(existing.id);
        nameToSyncId.set(nameKey, ex.sync_id);
        nameToNewId.set(nameKey, ex.id);
        skipped += 1;
        continue;
      }
      const syncId = randomUUID();
      // Preserve original id so existing HQ Suppliers URLs keep resolving.
      insSup.run(
        r.id, r.name, r.phone, r.email, r.address, r.contact_person,
        r.status || 'Active', syncId, null, null, null,
        r.created_at || new Date().toISOString(),
        r.updated_at || new Date().toISOString()
      );
      nameToSyncId.set(nameKey, syncId);
      nameToNewId.set(nameKey, r.id);
      inserted += 1;
    }
  })();
  console.log(`  suppliers: before=${before}  inserted=${inserted}  skipped=${skipped}`);
  return { nameToSyncId, nameToNewId };
}

function migrateGrns(masterDb, hqDb, nameToSyncId, nameToNewId) {
  const rows = masterDb.prepare(`SELECT * FROM hq_grns WHERE deleted_at IS NULL`).all();
  const before = hqDb.prepare(`SELECT COUNT(*) AS n FROM grn`).get().n;

  const findBySyncId = hqDb.prepare(`SELECT id FROM grn WHERE sync_id = ? LIMIT 1`);
  // Column list intentionally kept to the schema-safe subset. Any column
  // added by addCol migrations that isn't listed here defaults to NULL /
  // its declared default, which is fine for a historical import.
  const insGrn = hqDb.prepare(`
    INSERT INTO grn (id, grn_number, date, supplier_id, supplier_sync_id, supplier_name,
                      total_items, total_amount, notes, invoice_attachment, supplier_invoice_number,
                      created_by, status, linked_purchase_sync_id, linked_purchase_number,
                      hq_status, sync_id, tenant_id, branch_id, device_id,
                      synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
  `);
  const countItems = masterDb.prepare(
    `SELECT COUNT(*) AS n FROM hq_grn_items WHERE grn_sync_id = ?`
  );

  let inserted = 0, skipped = 0;
  hqDb.transaction(() => {
    for (const r of rows) {
      if (findBySyncId.get(r.sync_id)) { skipped += 1; continue; }
      const nameKey = String(r.supplier_name || '').toLowerCase();
      const supId  = nameToNewId.get(nameKey)  || null;
      const supSid = nameToSyncId.get(nameKey) || r.supplier_sync_id || null;
      const itemsN = countItems.get(r.sync_id).n;
      insGrn.run(
        r.id,
        r.grn_number,
        r.date,
        supId,                        // supplier_id points into new hq.db.suppliers
        supSid,                       // supplier_sync_id ditto
        r.supplier_name,
        itemsN,                       // total_items
        r.final_payable,              // total_amount = AP owed after CNs
        r.notes,
        r.invoice_attachment,
        r.supplier_invoice_number,
        r.generated_by_hq,            // created_by
        'Completed',                  // status
        r.po_sync_id,                 // linked_purchase_sync_id
        r.po_number,                  // linked_purchase_number
        'CONFIRMED',                  // hq_status
        r.sync_id,
        null, null, null,             // tenant_id / branch_id / device_id
        r.generated_at || r.date,     // created_at
        r.generated_at || r.date      // updated_at
      );
      inserted += 1;
    }
  })();
  console.log(`  grn:       before=${before}  inserted=${inserted}  skipped=${skipped}`);
}

function migrateGrnItems(masterDb, hqDb) {
  const rows = masterDb.prepare(`SELECT * FROM hq_grn_items`).all();
  const before = hqDb.prepare(`SELECT COUNT(*) AS n FROM grn_items`).get().n;

  const findBySyncId = hqDb.prepare(`SELECT id FROM grn_items WHERE sync_id = ? LIMIT 1`);
  const findProduct  = hqDb.prepare(`SELECT id FROM products WHERE sync_id = ? LIMIT 1`);
  const insItem = hqDb.prepare(`
    INSERT INTO grn_items (grn_id, grn_sync_id, product_id, product_sync_id,
                            quantity, unit, unit_price, total_price, expiry_date,
                            sync_id, tenant_id, branch_id, device_id,
                            synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
  `);

  let inserted = 0, skipped = 0;
  hqDb.transaction(() => {
    for (const r of rows) {
      if (findBySyncId.get(r.sync_id)) { skipped += 1; continue; }
      const prod = r.product_sync_id ? findProduct.get(r.product_sync_id) : null;
      insItem.run(
        r.grn_id,
        r.grn_sync_id,
        prod?.id || null,
        r.product_sync_id,
        r.quantity,
        r.unit,
        r.unit_price,
        r.total_price,
        r.expiry_date,
        r.sync_id,
        null, null, null
      );
      inserted += 1;
    }
  })();
  console.log(`  grn_items: before=${before}  inserted=${inserted}  skipped=${skipped}`);
}

function migrateCreditNotes(masterDb, hqDb, nameToSyncId, nameToNewId) {
  const rows = masterDb.prepare(
    `SELECT * FROM hq_supplier_credit_notes WHERE deleted_at IS NULL`
  ).all();
  const before = hqDb.prepare(`SELECT COUNT(*) AS n FROM supplier_credit_notes`).get().n;

  const findBySyncId = hqDb.prepare(`SELECT id FROM supplier_credit_notes WHERE sync_id = ? LIMIT 1`);
  // NOTE â€” tenant supplier_credit_notes has NO supplier_name column; the
  // name is JOIN'd via suppliers.id. So we drop that field from the INSERT
  // and rely on supplier_id + supplier_sync_id resolving correctly (they
  // point into the hq.db.suppliers rows we just migrated).
  const insCn = hqDb.prepare(`
    INSERT INTO supplier_credit_notes (id, credit_note_number, date, supplier_id, supplier_sync_id,
                                        reason, reference, amount, notes,
                                        grn_sync_id, created_by, sync_id, tenant_id, branch_id, device_id,
                                        synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)
  `);

  let inserted = 0, skipped = 0;
  const syncIdMap = new Map();
  hqDb.transaction(() => {
    for (const r of rows) {
      if (findBySyncId.get(r.sync_id)) { skipped += 1; syncIdMap.set(r.sync_id, r.sync_id); continue; }
      const nameKey = String(r.supplier_name || '').toLowerCase();
      const supId  = nameToNewId.get(nameKey)  || null;
      const supSid = nameToSyncId.get(nameKey) || r.supplier_sync_id || null;
      insCn.run(
        r.id, r.credit_note_number, r.date,
        supId, supSid,
        r.reason, r.reference, r.amount, r.notes,
        r.grn_sync_id, r.created_by,
        r.sync_id, null, null, null,
        r.created_at || r.date, r.created_at || r.date
      );
      syncIdMap.set(r.sync_id, r.sync_id);
      inserted += 1;
    }
  })();
  console.log(`  credit_notes: before=${before}  inserted=${inserted}  skipped=${skipped}`);
}

function migrateCreditNoteItems(masterDb, hqDb) {
  const rows = masterDb.prepare(`SELECT * FROM hq_supplier_credit_note_items`).all();
  const before = hqDb.prepare(`SELECT COUNT(*) AS n FROM supplier_credit_note_items`).get().n;

  const findBySyncId = hqDb.prepare(`SELECT id FROM supplier_credit_note_items WHERE sync_id = ? LIMIT 1`);
  const findProduct  = hqDb.prepare(`SELECT id FROM products WHERE sync_id = ? LIMIT 1`);
  const insItem = hqDb.prepare(`
    INSERT INTO supplier_credit_note_items (credit_note_id, credit_note_sync_id, product_id, product_sync_id,
                                             quantity, unit_value, total_price, unit, unit_conv,
                                             sync_id, tenant_id, branch_id, device_id,
                                             synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
  `);

  let inserted = 0, skipped = 0;
  hqDb.transaction(() => {
    for (const r of rows) {
      if (findBySyncId.get(r.sync_id)) { skipped += 1; continue; }
      const prod = r.product_sync_id ? findProduct.get(r.product_sync_id) : null;
      insItem.run(
        r.credit_note_id,
        r.credit_note_sync_id,
        prod?.id || null,
        r.product_sync_id,
        r.quantity,
        r.unit_value,
        r.total_price,
        r.unit,
        r.unit_conv || 1,
        r.sync_id,
        null, null, null
      );
      inserted += 1;
    }
  })();
  console.log(`  cn_items: before=${before}  inserted=${inserted}  skipped=${skipped}`);
}

function main() {
  if (!masterDb) { console.error('master.db not accessible â€” aborting.'); process.exit(1); }
  const hqSlug = getHqSlug();
  const hqDb = getTenantDb(hqSlug);
  if (!hqDb) { console.error(`HQ tenant DB not accessible at slug "${hqSlug}" â€” aborting.`); process.exit(1); }
  console.log(`HQ tenant slug resolved: ${hqSlug}`);
  console.log('Migratingâ€¦\n');

  hqDb.pragma('foreign_keys = OFF');

  const { nameToSyncId, nameToNewId } = migrateSuppliers(masterDb, hqDb);
  migrateGrns(masterDb, hqDb, nameToSyncId, nameToNewId);
  migrateGrnItems(masterDb, hqDb);
  migrateCreditNotes(masterDb, hqDb, nameToSyncId, nameToNewId);
  migrateCreditNoteItems(masterDb, hqDb);

  // v1.10.75 hotfix â€” backfill tenant_id on the rows we just inserted.
  // Account Payables page filters WHERE tenant_id = ? so a NULL leaves
  // migrated rows invisible even though HQ Suppliers page sees them.
  console.log('\nResolving HQ tenant_id for backfillâ€¦');
  const rows = ['cash_receipts', 'payment_vouchers', 'ap_payments', 'orders', 'products', 'users'];
  let tenantId = null;
  for (const t of rows) {
    try {
      const r = hqDb.prepare(`SELECT tenant_id FROM ${t} WHERE tenant_id IS NOT NULL LIMIT 1`).get();
      if (r && r.tenant_id) { tenantId = r.tenant_id; break; }
    } catch (_) { /* skip */ }
  }
  if (tenantId) {
    console.log(`  tenant_id = ${tenantId}`);
    for (const t of ['suppliers', 'grn', 'grn_items', 'supplier_credit_notes', 'supplier_credit_note_items']) {
      try {
        const info = hqDb.prepare(`UPDATE ${t} SET tenant_id = ? WHERE tenant_id IS NULL`).run(tenantId);
        console.log(`  ${t.padEnd(28)} updated ${info.changes} row(s)`);
      } catch (e) {
        console.error(`  ${t}: ${e.message}`);
      }
    }
  } else {
    console.log('  no non-NULL tenant_id found; run backfill_migrated_hq_tenant_id.js after your first login.');
  }

  hqDb.pragma('foreign_keys = ON');
  console.log('\nDone.');
}

main();
