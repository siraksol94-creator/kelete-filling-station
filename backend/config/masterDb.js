/**
 * masterDb.js
 * Manages the master database that tracks all registered tenants.
 * Lives at MASTER_DB_PATH (default: /var/www/kelete-pos-tenant/master.db)
 */
const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

// 2026-08-28 â€” Electron gets its own local master.db mirror in the userData
// directory, the same folder as the tenant DB.
//
// The old default resolved to __dirname/../.. which, in a packaged Electron
// app, is the install tree (resources/). electron-builder REPLACES that
// directory on every update, so the file was silently deleted each time the
// app was upgraded â€” verified live on 2026-08-28: master.db existed at
// 12:22, an update installed at 15:28, the file was gone. Nothing was lost
// only because it was still empty.
//
// services/electronBackup.js already looks in userData FIRST, so this brings
// the two into line rather than inventing a new location.
const masterDbPath = process.env.MASTER_DB_PATH
  || (process.env.ELECTRON_USER_DATA
        ? path.join(process.env.ELECTRON_USER_DATA, 'master.db')
        : path.join(__dirname, '..', '..', 'master.db'));

// One-time rescue: an install that already ran under the old path has its
// master.db sitting in the doomed folder. Move it across before we open
// anything, so upgrading does not read as "all the HQ data vanished".
// Copies the -wal/-shm sidecars too â€” without them any writes still parked
// in the write-ahead log would be dropped.
try {
  const legacyPath = path.join(__dirname, '..', '..', 'master.db');
  if (masterDbPath !== legacyPath
      && !fs.existsSync(masterDbPath)
      && fs.existsSync(legacyPath)) {
    const dir = path.dirname(masterDbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(legacyPath + suffix)) {
        fs.copyFileSync(legacyPath + suffix, masterDbPath + suffix);
      }
    }
    console.log('[master] migrated master.db out of the install folder ->', masterDbPath);
  }
} catch (e) {
  console.warn('[master] could not migrate legacy master.db:', e.message);
}

let masterDb = null;
try {
  const dir = path.dirname(masterDbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  masterDb = new Database(masterDbPath);
  masterDb.pragma('journal_mode = WAL');
  masterDb.pragma('foreign_keys = ON');

  // â”€â”€ Schema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  masterDb.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      slug          TEXT UNIQUE NOT NULL,
      business_name TEXT NOT NULL,
      email         TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS licenses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      key           TEXT UNIQUE NOT NULL,
      max_branches  INTEGER NOT NULL DEFAULT 1,
      expires_at    TEXT NOT NULL,
      notes         TEXT,
      is_active     INTEGER NOT NULL DEFAULT 1,
      tenant_email  TEXT,
      tenant_id     TEXT,
      activated_at  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS branches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT NOT NULL,
      branch_id   TEXT NOT NULL UNIQUE,
      branch_name TEXT NOT NULL,
      slug        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- â”€â”€ Phase C: cross-branch stock transfers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    -- Lives in master.db (not in per-branch DBs) so source and destination
    -- both read/write the same row without cross-DB queries. The items
    -- payload is a JSON array on the row itself:
    --   [{ product_sync_id, product_name, unit, quantity, cost_price }, ...]
    -- status state machine:
    --   PENDING   â€” source created + decremented its stock; in transit
    --   RECEIVED  â€” destination confirmed + incremented its stock
    --   CANCELLED â€” source aborted before destination received
    CREATE TABLE IF NOT EXISTS stock_transfers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_number TEXT NOT NULL UNIQUE,
      sync_id         TEXT NOT NULL UNIQUE,
      from_slug       TEXT NOT NULL,
      from_name       TEXT,
      to_slug         TEXT NOT NULL,
      to_name         TEXT,
      items_json      TEXT NOT NULL,
      total_items     INTEGER NOT NULL DEFAULT 0,
      total_value     REAL NOT NULL DEFAULT 0,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'PENDING',
      created_by      INTEGER,
      created_by_name TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      received_by     INTEGER,
      received_by_name TEXT,
      received_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_to_status   ON stock_transfers (to_slug, status);
    CREATE INDEX IF NOT EXISTS idx_transfers_from_status ON stock_transfers (from_slug, status);

    -- v1.8.64 â€” per-line variance on inter-branch transfer RECEIVE.
    -- When the receiving branch counts a shortage / damage / loss vs what
    -- the sender shipped, we record one variance row per affected line so
    -- HQ can investigate. The receiver's stock movement only counts the
    -- good qty; the gap lives here (a "Transit Variance" bucket).
    CREATE TABLE IF NOT EXISTS transfer_variances (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id           TEXT NOT NULL UNIQUE,
      transfer_sync_id  TEXT NOT NULL,
      transfer_number   TEXT,
      from_slug         TEXT,
      to_slug           TEXT,
      product_sync_id   TEXT,
      product_name      TEXT,
      unit              TEXT,
      sent_qty          REAL NOT NULL DEFAULT 0,
      received_qty      REAL NOT NULL DEFAULT 0,
      variance_qty      REAL NOT NULL DEFAULT 0,
      reason            TEXT NOT NULL DEFAULT 'Short',  -- 'Short' | 'Damaged' | 'Lost'
      notes             TEXT,
      received_by       INTEGER,
      received_by_name  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at       TEXT,
      resolution        TEXT   -- 'WRITE_OFF' | 'RECOVERED' | NULL
    );
    CREATE INDEX IF NOT EXISTS idx_transfer_variances_xfer ON transfer_variances (transfer_sync_id);

    -- â”€â”€ v1.8.57 â€” Branch â†’ HQ Cash Deposits â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    -- Branch records a physical cash deposit being sent to HQ. HQ
    -- inbox sees PENDING rows and confirms when the cash arrives.
    -- On HQ confirm: branch Cash Book gets a PV (cash out), HQ Cash
    -- Book gets a CR (cash in). On reject: no money moves.
    --
    -- Lives in master.db so branch (records it) and HQ (confirms it)
    -- read the same row â€” same pattern as stock_transfers.
    CREATE TABLE IF NOT EXISTS cash_deposits (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      deposit_number  TEXT NOT NULL UNIQUE,
      sync_id         TEXT NOT NULL UNIQUE,
      from_slug       TEXT NOT NULL,
      from_name       TEXT,
      currency        TEXT NOT NULL,                        -- 'USD' | 'FRA' | 'K'
      amount          REAL NOT NULL DEFAULT 0,              -- raw amount in the named currency
      amount_usd      REAL NOT NULL DEFAULT 0,              -- dollar value at sale-time / sent rate
      sell_rate       REAL,                                  -- snapshot of the rate used for amount_usd
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'PENDING',      -- PENDING | CONFIRMED | REJECTED
      created_by      INTEGER,
      created_by_name TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_by    INTEGER,
      confirmed_by_name TEXT,
      confirmed_at    TEXT,
      reject_reason   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cash_deposits_status   ON cash_deposits (status);
    CREATE INDEX IF NOT EXISTS idx_cash_deposits_from     ON cash_deposits (from_slug, status);
  `);

  // v1.8.60 â€” additional fields on cash_deposits: user-pickable deposit
  // date (so we can record cash that left earlier but arrived later)
  // and an attachment (deposit slip photo / bank receipt PDF).
  // Added via ALTER so existing master.db's don't error on re-create.
  const addMasterCol = (table, col, def) => {
    try {
      const cols = masterDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.includes(col)) {
        masterDb.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
      }
    } catch (_) { /* table doesn't exist yet â€” schema CREATE above will include it next boot */ }
  };
  addMasterCol('cash_deposits', 'deposit_date', 'TEXT');
  addMasterCol('cash_deposits', 'attachment',   'TEXT');
  // v1.10.48 â€” from_method: which physical drawer the cash left on a Liquor
  // branch (Cash / Mobile Money / Bank). NULL for Kelete tri-currency
  // deposits (they're currency-anchored, not method-anchored) and for
  // legacy Liquor rows written before this column existed.
  addMasterCol('cash_deposits', 'from_method', 'TEXT');
  // v1.13.47 â€” Option C: which branch absorbed a transit-variance write-off.
  // NULL until HQ resolves as WRITE_OFF (or if resolved as RECOVERED â€” no
  // absorbing branch in that case). Stored so the HQ list can show who took
  // the hit at a glance.
  addMasterCol('transfer_variances', 'absorbed_by_slug', 'TEXT');

  // 2026-08-28 â€” cash_deposits never had deleted_at, but every Cash Book
  // query filters on it (`AND deleted_at IS NULL`, 8 sites in cashBook.js).
  // SQLite threw "no such column" and a `catch (_) { /* non-fatal */ }`
  // swallowed it, so a CONFIRMED deposit simply never appeared: not deducted
  // from the branch, not added to HQ, no error anywhere. The row was there
  // and correct the whole time â€” the same query without that one clause
  // returns it.
  //
  // Adding the column rather than editing eight queries: it is one line, it
  // fixes every site at once, and it leaves soft-delete ready if the hard
  // DELETE in routes/cashDeposits.js is ever softened.
  addMasterCol('cash_deposits', 'deleted_at',      'TEXT');
  addMasterCol('cash_deposits', 'deleted_by',      'INTEGER');
  addMasterCol('cash_deposits', 'deleted_by_name', 'TEXT');
  addMasterCol('cash_deposits', 'delete_reason',   'TEXT');
  // 2026-09-11 â€” the Cash Report an auto deposit came from
  // (services/autoDeposit.js), so an edit or delete finds exactly its own.
  addMasterCol('cash_deposits', 'cash_report_sync_id', 'TEXT');
  // 2026-09-15 â€” where the deposit was sent. NULL = HQ; a depot slug = that
  // depot (the sender's System Settings â†’ Deposit to), which confirms it and
  // books it as money received (services/depositTarget.js).
  addMasterCol('cash_deposits', 'to_slug', 'TEXT');
  addMasterCol('cash_deposits', 'to_name', 'TEXT');
  try {
    masterDb.exec('CREATE INDEX IF NOT EXISTS idx_cash_deposits_report ON cash_deposits (cash_report_sync_id)');
  } catch (_) { /* column not there yet on a fresh file â€” next boot */ }

  masterDb.exec(`

    -- â”€â”€ Phase C: HQ Purchase Receipts (no warehouse, drop-ship to branch) â”€â”€
    -- HQ has no physical stock â€” every supplier purchase is logged here
    -- with PER-LINE destination_slug. Branches see lines targeted at them
    -- in their "Incoming Stock" queue and confirm with actual_received_qty.
    -- On confirm, the branch's tenant DB gets a stock_movement (+) and a
    -- products.current_stock increment (auto-creating the product if it
    -- doesn't exist yet, matched by sync_id, fallback to name).
    --
    -- AP at HQ: total_amount accumulates supplier debt at the HQ level.
    -- Variance (dispatched_qty vs received_qty) is captured per line; HQ
    -- can chase the supplier or write off the gap later.
    --
    -- A header row stays OPEN until every line is RECEIVED (or CANCELLED);
    -- then it auto-promotes to COMPLETED so HQ can filter the list.
    CREATE TABLE IF NOT EXISTS hq_purchases (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_number TEXT NOT NULL UNIQUE,
      sync_id         TEXT NOT NULL UNIQUE,
      supplier_name   TEXT,
      invoice_number  TEXT,
      date            TEXT NOT NULL,
      total_amount    REAL NOT NULL DEFAULT 0,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'OPEN',
      created_by      INTEGER,
      created_by_name TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS hq_purchase_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id       INTEGER NOT NULL REFERENCES hq_purchases(id),
      purchase_sync_id  TEXT NOT NULL,
      sync_id           TEXT NOT NULL UNIQUE,
      product_sync_id   TEXT NOT NULL,
      product_name      TEXT NOT NULL,
      unit              TEXT,
      dispatched_qty    REAL NOT NULL,
      cost_price        REAL NOT NULL DEFAULT 0,
      line_total        REAL NOT NULL DEFAULT 0,
      destination_slug  TEXT NOT NULL,
      destination_name  TEXT,
      received_qty      REAL,
      status            TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | RECEIVED | CANCELLED
      variance_notes    TEXT,
      received_by       INTEGER,
      received_by_name  TEXT,
      received_at       TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hq_pi_dest_status ON hq_purchase_items (destination_slug, status);
    CREATE INDEX IF NOT EXISTS idx_hq_pi_purchase   ON hq_purchase_items (purchase_id);

    -- â”€â”€ HQ Suppliers + AP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    -- Master supplier list lives at HQ. Each hq_purchases.supplier_name is
    -- denormalised text (for human readability + so older rows don't break
    -- when a supplier is renamed). AP per supplier is computed from joins,
    -- not stored, so it can never drift out of sync with the underlying
    -- purchases + payments:
    --   AP = SUM(hq_purchases.total_amount  WHERE supplier matches)
    --      - SUM(hq_supplier_payments.amount WHERE supplier matches)
    --
    -- Matching: by supplier_id when set, else by case-insensitive
    -- supplier_name. New purchases pick from the master list (supplier_id
    -- filled in); legacy rows fall back to name match.
    CREATE TABLE IF NOT EXISTS hq_suppliers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      phone           TEXT,
      email           TEXT,
      address         TEXT,
      contact_person  TEXT,
      notes           TEXT,
      status          TEXT NOT NULL DEFAULT 'Active',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hq_suppliers_name ON hq_suppliers (name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS hq_supplier_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_number  TEXT NOT NULL UNIQUE,
      supplier_id     INTEGER,
      supplier_name   TEXT NOT NULL,
      amount          REAL NOT NULL DEFAULT 0,
      payment_date    TEXT NOT NULL,
      payment_method  TEXT NOT NULL DEFAULT 'Cash',
      reference       TEXT,
      notes           TEXT,
      created_by      INTEGER,
      created_by_name TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hq_pay_supplier ON hq_supplier_payments (supplier_id, supplier_name);
    CREATE INDEX IF NOT EXISTS idx_hq_pay_date     ON hq_supplier_payments (payment_date);
  `);

  // Add supplier_id to hq_purchases (nullable â€” older rows stay name-only).
  // Run as a separate ALTER so re-running the schema on existing master.dbs
  // doesn't trip CREATE TABLE.
  try {
    const cols = masterDb.prepare(`PRAGMA table_info(hq_purchases)`).all();
    if (!cols.find(c => c.name === 'supplier_id')) {
      masterDb.prepare(`ALTER TABLE hq_purchases ADD COLUMN supplier_id INTEGER`).run();
    }
  } catch (_) { /* fresh DB â€” table created above */ }

  // â”€â”€ Phase 2 (Â§5.11): ZRA cross-reference columns on HQ Purchase rows.
  // When a purchase originates from /api/zra/purchases/:id/approve (i.e.
  // pulled from ZRA and converted to a Flow-A PO), we stamp the ZRA
  // supplier identity + registration type + originating pending-row id
  // on the header, and copy the per-line ZRA classification data onto
  // hq_purchase_items so hqPurchases.js Confirm can rebuild the correct
  // savePurchase / saveStockItems payload without re-hitting ZRA.
  const addHqCol = (table, col, def) => {
    try {
      const cols = masterDb.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.find(c => c.name === col)) {
        masterDb.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
      }
    } catch (_) { /* table not yet created */ }
  };
  addHqCol('hq_purchases',      'zra_pending_purchase_id', 'INTEGER');
  addHqCol('hq_purchases',      'zra_spplr_tpin',          'TEXT');
  addHqCol('hq_purchases',      'zra_spplr_bhf_id',        'TEXT');
  addHqCol('hq_purchases',      'zra_reg_ty_cd',           'TEXT');
  addHqCol('hq_purchases',      'zra_pchs_invc_no',        'INTEGER');
  addHqCol('hq_purchases',      'zra_status',              'TEXT');
  // 2026-08-30 â€” record a supplier invoice the way it is printed.
  //
  // A purchase line carried one number, cost_price, so entering a ZBDC invoice
  // meant working out (base + VAT - discount) / qty by hand for every line and
  // typing the answer. That is arithmetic done by a person at 6am, and the
  // rounding to 2 decimals left AP a few kwacha off the amount due.
  //
  // These three hold the invoice's own figures. cost_price keeps its exact
  // meaning â€” the effective unit cost â€” but is now DERIVED from them, so
  // stock, WAC, GRN, AP and the ZRA chain read it unchanged and never know
  // the difference.
  // 2026-08-30 â€” a supplier's credit note carries a per-line discount and its
  // own VAT, the same way its invoice does. Without these the amount could
  // only be recomputed as qty x unit_value, which silently dropped both: a
  // ZBL note of K66,621.54 would have been booked as K66,322.83.
  //
  // unit_value stays the price BEFORE discount, so returned stock is valued
  // exactly as the purchase valued it; the discount rides alongside and only
  // affects the money credited.
  // 2026-08-30 â€” carry the supplier's figures onto the GRN line.
  //
  // hq_grn_items held quantity, unit_price and total_price only, so the
  // moment a purchase became a GRN the invoice breakdown was dropped. Every
  // GRN-based screen â€” AP Approvals, GRN Archive â€” could then only ever show
  // the derived cost, and whoever approves a payment had no way to see why
  // the cost was K574.01 rather than the K504.56 printed on the paper.
  addHqCol('hq_grn_items', 'base_price',      'REAL NOT NULL DEFAULT 0');
  addHqCol('hq_grn_items', 'vat_amount',      'REAL NOT NULL DEFAULT 0');
  addHqCol('hq_grn_items', 'discount_amount', 'REAL NOT NULL DEFAULT 0');

  // Heal GRNs generated between the purchase columns landing and the carry
  // reaching hq_grn_items: the figures are on their PO line, just never
  // copied across. Matched by PO + product, and VAT and discount are scaled
  // by what was actually received, the same rule the live path uses.
  //
  // Only fills rows still at zero, so it cannot overwrite a real figure, and
  // skips extras, which were never on the supplier's invoice. Runs on every
  // boot and is a no-op once there is nothing left to fill.
  try {
    const healed = masterDb.prepare(`
      UPDATE hq_grn_items AS gi
         SET base_price = COALESCE((
               SELECT pi.base_price FROM hq_purchase_items pi
                 JOIN hq_grns g ON g.sync_id = gi.grn_sync_id
                WHERE pi.purchase_sync_id = g.po_sync_id
                  AND pi.product_sync_id  = gi.product_sync_id LIMIT 1), 0),
             vat_amount = COALESCE((
               SELECT CASE WHEN pi.dispatched_qty > 0
                           THEN pi.vat_amount / pi.dispatched_qty * gi.quantity ELSE 0 END
                 FROM hq_purchase_items pi
                 JOIN hq_grns g ON g.sync_id = gi.grn_sync_id
                WHERE pi.purchase_sync_id = g.po_sync_id
                  AND pi.product_sync_id  = gi.product_sync_id LIMIT 1), 0),
             discount_amount = COALESCE((
               SELECT CASE WHEN pi.dispatched_qty > 0
                           THEN pi.discount_amount / pi.dispatched_qty * gi.quantity ELSE 0 END
                 FROM hq_purchase_items pi
                 JOIN hq_grns g ON g.sync_id = gi.grn_sync_id
                WHERE pi.purchase_sync_id = g.po_sync_id
                  AND pi.product_sync_id  = gi.product_sync_id LIMIT 1), 0)
       WHERE COALESCE(gi.base_price, 0) = 0
         AND COALESCE(gi.is_extra, 0) = 0
         AND EXISTS (
               SELECT 1 FROM hq_purchase_items pi
                 JOIN hq_grns g ON g.sync_id = gi.grn_sync_id
                WHERE pi.purchase_sync_id = g.po_sync_id
                  AND pi.product_sync_id  = gi.product_sync_id
                  AND pi.base_price > 0)
    `).run();
    if (healed.changes > 0) {
      console.log(`[master] carried invoice figures onto ${healed.changes} GRN line(s) from their PO`);
    }
  } catch (e) {
    console.warn('[master] GRN invoice-figure backfill skipped:', e.message);
  }
  addHqCol('hq_receipt_credit_notes',      'vat_amount', 'REAL NOT NULL DEFAULT 0');
  addHqCol('hq_receipt_credit_note_items', 'discount',   'REAL NOT NULL DEFAULT 0');
  addHqCol('hq_supplier_credit_notes',      'vat_amount', 'REAL NOT NULL DEFAULT 0');
  addHqCol('hq_supplier_credit_note_items', 'discount',   'REAL NOT NULL DEFAULT 0');
  addHqCol('hq_purchase_items', 'base_price',       'REAL NOT NULL DEFAULT 0');  // unit, ex-VAT, pre-discount
  addHqCol('hq_purchase_items', 'vat_amount',       'REAL NOT NULL DEFAULT 0');  // per line, off the invoice
  // 2026-09-04 â€” the RRP this line was billed on. Suppliers charge VAT on the
  // RRP, not on what they bill us (minimum taxable value), so the figure has to
  // travel with the line: a product's RRP will change, and this invoice must
  // still show what it was computed from. 0 on every historic row, which is
  // why nothing recalculates them.
  addHqCol('hq_purchase_items', 'rrp',              'REAL NOT NULL DEFAULT 0');
  addHqCol('hq_purchase_items', 'discount_amount',  'REAL NOT NULL DEFAULT 0');  // per line, off the invoice
  addHqCol('hq_purchase_items', 'zra_item_cd',             'TEXT');
  addHqCol('hq_purchase_items', 'zra_item_cls_cd',         'TEXT');
  addHqCol('hq_purchase_items', 'zra_pkg_unit_cd',         'TEXT');
  addHqCol('hq_purchase_items', 'zra_qty_unit_cd',         'TEXT');
  addHqCol('hq_purchase_items', 'zra_vat_cat_cd',          'TEXT');
  addHqCol('hq_purchase_items', 'zra_excise_ty_cd',        'TEXT');
  addHqCol('hq_purchase_items', 'zra_rrp',                 'REAL');

  // â”€â”€ v1.3.3 â€” HQ Product Master â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // HQ owns the canonical catalogue. When HQ creates a product we INSERT
  // a copy into every registered branch's `products` table using the
  // SAME sync_id so the linkage is automatic + survives renames. Per-
  // branch selling_price stays branch-owned (HQ default fills only on
  // first insert; subsequent HQ edits won't overwrite a branch's
  // override unless ?override_prices=1 is passed).
  try {
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS hq_products (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id               TEXT UNIQUE NOT NULL,
        code                  TEXT,
        name                  TEXT NOT NULL,
        category_name         TEXT,
        main_category_name    TEXT,
        unit                  TEXT NOT NULL DEFAULT 'pcs',
        default_cost_price    REAL NOT NULL DEFAULT 0,
        default_selling_price REAL NOT NULL DEFAULT 0,
        min_stock             REAL NOT NULL DEFAULT 0,
        units_json            TEXT,
        status                TEXT NOT NULL DEFAULT 'Active',
        product_type          TEXT NOT NULL DEFAULT 'finished',
        image_url             TEXT,
        notes                 TEXT,
        created_by            INTEGER,
        created_by_name       TEXT,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hq_products_name ON hq_products(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_hq_products_status ON hq_products(status);
    `);
  } catch (e) {
    console.warn('[masterDb] v1.3.3 hq_products migration:', e.message);
  }

  // â”€â”€ v1.5.0 â€” HQ-owned vs branch-owned split â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // HQ now owns: code, name, category, base unit, packagings, default unit,
  // photo, returnable container, UB barcode. Each branch owns: prices,
  // min stock, status, opening stock, notes.
  // New hq_products columns mirror the per-product branch fields HQ
  // controls; pushToBranches copies them into each branch's products
  // table. Idempotent ALTERs so re-runs on existing master.dbs don't
  // break.
  try {
    const cols = masterDb.prepare(`PRAGMA table_info(hq_products)`).all().map(c => c.name);
    const addCol = (col, def) => {
      if (!cols.includes(col)) {
        masterDb.prepare(`ALTER TABLE hq_products ADD COLUMN ${col} ${def}`).run();
        cols.push(col);
      }
    };
    addCol('default_unit',              'TEXT');
    addCol('container_product_sync_id', 'TEXT');
    addCol('units_per_container',       'REAL');
    addCol('ub_number_start',           'INTEGER DEFAULT 1');
    addCol('ub_number_length',          'INTEGER DEFAULT 6');
    addCol('ub_quantity_start',         'INTEGER DEFAULT 7');
    addCol('ub_quantity_length',        'INTEGER DEFAULT 0');
    addCol('ub_decimal_start',          'INTEGER DEFAULT 2');
  } catch (e) {
    console.warn('[masterDb] v1.5.0 hq_products column migration:', e.message);
  }

  // â”€â”€ v1.3.0 â€” New procurement state machine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Old model: PENDING (HQ-created) â†’ RECEIVED (branch one-click, AP locked).
  // New model: AWAITING_GRN (HQ-created) â†’ GRN_SUBMITTED (branch enters
  //            actual qty, no stock change yet) â†’ CONFIRMED (HQ approves,
  //            now stock decrements at branch + supplier AP locks in).
  // Reasoning: HQ can't release a GRN because only the branch knows what
  // physically arrived; HQ then audits + confirms what branch reports.
  //
  // Add: confirmed_by / confirmed_by_name / confirmed_at / confirm_notes.
  // Backfill: any existing 'PENDING' rows â†’ 'AWAITING_GRN'; 'RECEIVED' â†’
  // 'CONFIRMED' with confirmed_at stamped from received_at so AP reports
  // don't lose the date. Idempotent â€” guarded by column-existence check.
  try {
    const piCols = masterDb.prepare(`PRAGMA table_info(hq_purchase_items)`).all().map(c => c.name);
    const addCol = (col, def) => {
      if (!piCols.includes(col)) {
        masterDb.prepare(`ALTER TABLE hq_purchase_items ADD COLUMN ${col} ${def}`).run();
        piCols.push(col);
      }
    };
    addCol('confirmed_by',      'INTEGER');
    addCol('confirmed_by_name', 'TEXT');
    addCol('confirmed_at',      'TEXT');
    addCol('confirm_notes',     'TEXT');
    // v1.8.65 â€” reason vocabulary aligned with transfer_variances:
    // OK / Short / Damaged / Lost. Existing rows default to OK on read.
    addCol('reason',            'TEXT');
    // v1.9.7 â€” branch-side rejection. Branch can decline an incoming PO
    // line (wrong branch, wrong supplier, qty looks off, etc.) instead
    // of being forced to generate a GRN for it. status becomes
    // BRANCH_REJECTED (terminal); reason + actor stamp captured for
    // HQ visibility on the Purchases list.
    addCol('branch_rejected_by',      'INTEGER');
    addCol('branch_rejected_by_name', 'TEXT');
    addCol('branch_rejected_at',      'TEXT');
    addCol('branch_reject_reason',    'TEXT');
    // v1.9.7 â€” link the PO line to the branch GRN that fulfilled it.
    // When branch creates a GRN with linked_purchase_sync_id pointing
    // at this PO, the GRN's sync_id is written here so HQ Confirm GRN
    // can pull the full GRN doc + credit notes by sync_id (no need to
    // join across tenant DBs).
    addCol('linked_grn_sync_id',  'TEXT');
    // v1.9.21 â€” denormalised GRN# for display on the branch's Incoming
    // Stock page (the "WAITING HQ" rows). Avoids a cross-tenant lookup
    // just to render a human-readable reference.
    addCol('linked_grn_number',   'TEXT');
  } catch (e) {
    console.warn('[masterDb] v1.3.0 hq_purchase_items migration:', e.message);
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // v1.9.14 â€” HQ snapshot of every confirmed branch GRN.
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Each confirmed GRN writes one row here. Lets HQ aggregate AP / per-
  // supplier statements / PO reconciliation in a single SQL query without
  // scanning every branch tenant DB. Full GRN line items + credit notes
  // stay at the branch â€” HQ pulls them on-demand via the existing
  // GET /api/hq/grns/:slug/:syncId endpoint when the user clicks
  // "See Details". Small (~200 bytes per GRN) so the duplication cost is
  // negligible vs the speed + offline-resilience win.
  try {
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS hq_confirmed_grn_totals (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        grn_sync_id         TEXT NOT NULL UNIQUE,
        grn_number          TEXT NOT NULL,
        branch_slug         TEXT NOT NULL,
        branch_name         TEXT,
        supplier_id         INTEGER,
        supplier_sync_id    TEXT,
        supplier_name       TEXT,
        po_sync_id          TEXT,
        po_number           TEXT,
        date                TEXT,
        items_count         INTEGER NOT NULL DEFAULT 0,
        items_subtotal      REAL NOT NULL DEFAULT 0,
        cn_total            REAL NOT NULL DEFAULT 0,
        final_payable       REAL NOT NULL DEFAULT 0,
        invoice_number      TEXT,
        confirmed_by        INTEGER,
        confirmed_by_name   TEXT,
        confirmed_at        TEXT NOT NULL DEFAULT (datetime('now')),
        notes               TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hq_grn_totals_branch   ON hq_confirmed_grn_totals (branch_slug);
      CREATE INDEX IF NOT EXISTS idx_hq_grn_totals_supplier ON hq_confirmed_grn_totals (supplier_sync_id);
      CREATE INDEX IF NOT EXISTS idx_hq_grn_totals_date     ON hq_confirmed_grn_totals (date);
      CREATE INDEX IF NOT EXISTS idx_hq_grn_totals_po       ON hq_confirmed_grn_totals (po_sync_id);
    `);
  } catch (e) {
    console.warn('[masterDb] v1.9.14 hq_confirmed_grn_totals:', e.message);
  }

  try {
    // Status rename â€” only on rows that still carry the legacy labels.
    masterDb.prepare(`
      UPDATE hq_purchase_items SET status = 'AWAITING_GRN'
       WHERE status = 'PENDING'
    `).run();
    masterDb.prepare(`
      UPDATE hq_purchase_items
         SET status = 'CONFIRMED',
             confirmed_by      = COALESCE(confirmed_by, received_by),
             confirmed_by_name = COALESCE(confirmed_by_name, received_by_name),
             confirmed_at      = COALESCE(confirmed_at, received_at)
       WHERE status = 'RECEIVED'
    `).run();
  } catch (e) {
    console.warn('[masterDb] v1.3.0 hq_purchase_items migration:', e.message);
  }

  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // v1.10.0 â€” procurement rearchitecture.
  // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The GRN-paperwork ownership shifts from branch to HQ. Branch's role
  // collapses to "confirm what physically arrived"; HQ does invoice + CN
  // paperwork and generates the GRN. New state machine on hq_purchase_items:
  //   AWAITING_CONFIRMATION â†’ RECEIPT_REPORTED â†’ CONFIRMED
  // (BRANCH_REJECTED unchanged; legacy AWAITING_GRN/GRN_SUBMITTED rows
  // continue to work through the old endpoints for back-compat.)
  try {
    // Branch confirmation captures invoice # + photo on the PO header.
    const hpCols = masterDb.prepare(`PRAGMA table_info(hq_purchases)`).all().map(c => c.name);
    const addHpCol = (col, def) => {
      if (!hpCols.includes(col)) {
        masterDb.prepare(`ALTER TABLE hq_purchases ADD COLUMN ${col} ${def}`).run();
        hpCols.push(col);
      }
    };
    addHpCol('supplier_invoice_number',  'TEXT');
    addHpCol('invoice_attachment',       'TEXT');
    addHpCol('confirmed_by_branch',      'INTEGER');
    addHpCol('confirmed_by_branch_name', 'TEXT');
    addHpCol('confirmed_at_branch',      'TEXT');
    addHpCol('confirmed_branch_slug',    'TEXT');
  } catch (e) {
    console.warn('[masterDb] v1.10.0 hq_purchases migration:', e.message);
  }

  try {
    // Off-PO items branch received (e.g. supplier sent SAVANNA 20 when the
    // PO only listed CASTLE LITE). Each gets reviewed by HQ when they
    // generate the GRN; rolls into the GRN as an extra line.
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS hq_purchase_receipt_extras (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id             TEXT NOT NULL UNIQUE,
        purchase_sync_id    TEXT NOT NULL,
        product_sync_id     TEXT,
        product_name        TEXT NOT NULL,
        unit                TEXT,
        quantity            REAL NOT NULL DEFAULT 0,
        cost_price          REAL NOT NULL DEFAULT 0,
        added_by            INTEGER,
        added_by_name       TEXT,
        added_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hq_extras_purchase ON hq_purchase_receipt_extras (purchase_sync_id);
    `);
  } catch (e) {
    console.warn('[masterDb] v1.10.0 hq_purchase_receipt_extras:', e.message);
  }

  try {
    // HQ-owned GRN. Replaces the per-branch grn table for v1.10.0+ flow.
    // Branch's grn table stays untouched for legacy reads.
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS hq_grns (
        id                        INTEGER PRIMARY KEY AUTOINCREMENT,
        grn_number                TEXT NOT NULL UNIQUE,
        sync_id                   TEXT NOT NULL UNIQUE,
        date                      TEXT NOT NULL,
        branch_slug               TEXT NOT NULL,
        branch_name               TEXT,
        supplier_id               INTEGER,
        supplier_sync_id          TEXT,
        supplier_name             TEXT,
        po_sync_id                TEXT,
        po_number                 TEXT,
        supplier_invoice_number   TEXT,
        invoice_attachment        TEXT,
        items_subtotal            REAL NOT NULL DEFAULT 0,
        cn_total                  REAL NOT NULL DEFAULT 0,
        final_payable             REAL NOT NULL DEFAULT 0,
        notes                     TEXT,
        confirmed_by_branch       INTEGER,
        confirmed_by_branch_name  TEXT,
        confirmed_at_branch       TEXT,
        generated_by_hq           INTEGER,
        generated_by_hq_name      TEXT,
        generated_at              TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at                TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hq_grns_branch   ON hq_grns (branch_slug);
      CREATE INDEX IF NOT EXISTS idx_hq_grns_supplier ON hq_grns (supplier_sync_id);
      CREATE INDEX IF NOT EXISTS idx_hq_grns_po       ON hq_grns (po_sync_id);
      CREATE INDEX IF NOT EXISTS idx_hq_grns_date     ON hq_grns (date);

      CREATE TABLE IF NOT EXISTS hq_grn_items (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id             TEXT NOT NULL UNIQUE,
        grn_id              INTEGER NOT NULL REFERENCES hq_grns(id),
        grn_sync_id         TEXT NOT NULL,
        product_sync_id     TEXT,
        product_name        TEXT NOT NULL,
        unit                TEXT,
        quantity            REAL NOT NULL DEFAULT 0,
        unit_price          REAL NOT NULL DEFAULT 0,
        total_price         REAL NOT NULL DEFAULT 0,
        expiry_date         TEXT,
        is_extra            INTEGER NOT NULL DEFAULT 0,
        po_expected_qty     REAL,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hq_grn_items_grn ON hq_grn_items (grn_sync_id);
    `);
  } catch (e) {
    console.warn('[masterDb] v1.10.0 hq_grns:', e.message);
  }

  try {
    // HQ-owned supplier credit notes (linked to hq_grns). Mirrors the
    // branch supplier_credit_notes shape so the existing CN UI maps cleanly.
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS hq_supplier_credit_notes (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        credit_note_number    TEXT NOT NULL UNIQUE,
        sync_id               TEXT NOT NULL UNIQUE,
        date                  TEXT NOT NULL,
        supplier_id           INTEGER,
        supplier_sync_id      TEXT,
        supplier_name         TEXT,
        reason                TEXT NOT NULL,
        reference             TEXT,
        amount                REAL NOT NULL DEFAULT 0,
        notes                 TEXT,
        grn_sync_id           TEXT,
        branch_slug           TEXT,
        created_by            INTEGER,
        created_by_name       TEXT,
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at            TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hq_scn_grn      ON hq_supplier_credit_notes (grn_sync_id);
      CREATE INDEX IF NOT EXISTS idx_hq_scn_supplier ON hq_supplier_credit_notes (supplier_sync_id);

      CREATE TABLE IF NOT EXISTS hq_supplier_credit_note_items (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id               TEXT NOT NULL UNIQUE,
        credit_note_id        INTEGER NOT NULL REFERENCES hq_supplier_credit_notes(id),
        credit_note_sync_id   TEXT NOT NULL,
        product_sync_id       TEXT,
        product_name          TEXT,
        quantity              REAL NOT NULL DEFAULT 0,
        unit                  TEXT,
        unit_conv             REAL NOT NULL DEFAULT 1,
        unit_value            REAL NOT NULL DEFAULT 0,
        total_price           REAL NOT NULL DEFAULT 0,
        created_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hq_scn_items_cn ON hq_supplier_credit_note_items (credit_note_sync_id);
    `);
  } catch (e) {
    console.warn('[masterDb] v1.10.0 hq_supplier_credit_notes:', e.message);
  }

  // v1.10.53 â€” WAC redesign schema additions.
  //
  // Every HQ PO carries ONE FX rate for its whole batch (per user's
  // 2026-07-03 decision â€” one rate per PO, not per line). Rate is
  // captured at PO Create time (HQ side), not at Confirm Receipt.
  // Currency label lets tri-currency branches (Kassumbalesa) declare
  // the supplier billed in K vs USD; K-only branches leave it NULL and
  // the code path skips the FX prompt entirely.
  addMasterCol('hq_purchases', 'cost_currency', 'TEXT');   // 'USD' | 'FRA' | 'K' â€” nullable, only set when the destination is a tri-currency branch
  addMasterCol('hq_purchases', 'fx_rate_used', 'REAL');    // e.g. 25 when 1 USD = 25 K on this PO â€” nullable for K-only destinations
  addMasterCol('hq_purchase_items', 'cost_price_usd', 'REAL'); // derived at insert time = cost_price / fx_rate_used (or cost_price itself when currency=USD or rate=NULL)

  // Same three fields on stock_transfers header â€” one rate per transfer.
  // Transfer items live inside stock_transfers.items_json so per-line
  // storage happens there, not in a separate table. Header rate applies
  // to every line uniformly.
  addMasterCol('stock_transfers', 'cost_currency', 'TEXT');
  addMasterCol('stock_transfers', 'fx_rate_used', 'REAL');

  // v1.13.30 â€” AP approval chain columns on hq_confirmed_grn_totals.
  // Kelete AP workflow: Store Manager Confirm â†’ Accounts Check â†’
  // Finance Approve â†’ Cashier Pay. Each stage stamps who + when.
  // ap_status transitions: PENDING â†’ CHECKED â†’ APPROVED â†’ PAID
  // Send-Back rolls status back to PENDING and stashes the reason.
  addMasterCol('hq_confirmed_grn_totals', 'ap_status',           "TEXT NOT NULL DEFAULT 'PENDING'");
  addMasterCol('hq_confirmed_grn_totals', 'checked_at',          'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'checked_by_id',       'INTEGER');
  addMasterCol('hq_confirmed_grn_totals', 'checked_by_name',     'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'approved_at',         'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'approved_by_id',      'INTEGER');
  addMasterCol('hq_confirmed_grn_totals', 'approved_by_name',    'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'sent_back_at',        'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'sent_back_by_id',     'INTEGER');
  addMasterCol('hq_confirmed_grn_totals', 'sent_back_by_name',   'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'sent_back_reason',    'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'sent_back_from_stage','TEXT'); // 'CHECKED' | 'APPROVED' â€” which stage rejected it
  // 2026-09-06 â€” the delivery confirmation that now sits in FRONT of the AP
  // queue. Every GRN lands on UNCONFIRMED when it is generated and waits
  // there while the depot finishes offloading and raises whatever credits the
  // truck produced. The Store Manager confirms once, against the supplier's
  // own invoice â€” which arrives by WhatsApp when offloading is done, and is
  // why no "returns complete" button is needed.
  //
  // Existing rows are untouched: the column defaults to NULL and only new
  // GRNs are written as UNCONFIRMED, so nothing already checked or paid is
  // dragged back to the front of the queue.
  addMasterCol('hq_confirmed_grn_totals', 'delivery_confirmed_at',      'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'delivery_confirmed_by_id',   'INTEGER');
  addMasterCol('hq_confirmed_grn_totals', 'delivery_confirmed_by_name', 'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'paid_at',             'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'paid_by_id',          'INTEGER');
  addMasterCol('hq_confirmed_grn_totals', 'paid_by_name',        'TEXT');

  // 2026-08-30 â€” payment batches. Several GRNs of ONE supplier approved in a
  // single decision, so Ready for Payment shows one collapsible line instead
  // of one row per invoice.
  //
  // Deliberately NOT called a voucher: payment_vouchers already exists and is
  // a different thing (general cash-out with a free-text paid_to and a
  // category). Two PV series would wreck reconciliation.
  //
  // This is a GROUPING, never the unit of truth. PAID/PARTIAL stays derived
  // per GRN from SUM(ap_payments.amount) â€” a part-paid batch cannot say which
  // invoice is settled, and that per-GRN answer is what ties to the supplier
  // ledger. A GRN approved alone simply has no batch: a batch of one.
  // 2026-08-31 â€” Finance's per-GRN review, before the batch approval.
  //
  // Approve (single) and Approve as One Batch did the same job, and the
  // checkbox sat on the row, so a whole page could be approved without
  // opening any of it. Confirmation is recorded here and the approval itself
  // stays a batch action â€” one button, and only reviewed rows can be in it.
  //
  // Deliberately NOT another ap_status: the row is still CHECKED until it is
  // approved, so every downstream query, filter and tab is untouched. This is
  // a marker on top, the same shape as the payment batch.
  addMasterCol('hq_confirmed_grn_totals', 'review_confirmed_at',      'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'review_confirmed_by_id',   'INTEGER');
  addMasterCol('hq_confirmed_grn_totals', 'review_confirmed_by_name', 'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'ap_batch_ref',        'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'ap_batch_number',     'TEXT');
  // 2026-09-17 â€” Void GRN (HQ Admin). The GRN stays on record, marked voided,
  // with who, when and why; ap_status becomes 'VOIDED', which no AP tab lists.
  addMasterCol('hq_confirmed_grn_totals', 'voided_at',       'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'voided_by_id',    'INTEGER');
  addMasterCol('hq_confirmed_grn_totals', 'voided_by_name',  'TEXT');
  addMasterCol('hq_confirmed_grn_totals', 'void_reason',     'TEXT');
  addMasterCol('hq_grns', 'voided_at',       'TEXT');
  addMasterCol('hq_grns', 'voided_by_id',    'INTEGER');
  addMasterCol('hq_grns', 'voided_by_name',  'TEXT');
  addMasterCol('hq_grns', 'void_reason',     'TEXT');
  addMasterCol('hq_grns', 'void_zra_result', 'TEXT');
  try {
    masterDb.exec('CREATE INDEX IF NOT EXISTS idx_hq_grn_totals_batch ON hq_confirmed_grn_totals (ap_batch_ref)');
  } catch (_) { /* index is an optimisation, not a requirement */ }

  // v1.13.35 â€” CN authoring moved to branch. Branch stashes CN drafts
  // against the PO when confirming receipt; HQ Generate GRN reads them
  // (read-only) and mints the real hq_supplier_credit_notes rows with
  // the newly generated grn_sync_id. Drafts are deleted on successful
  // generate so re-submissions from the branch stay idempotent.
  try {
    masterDb.exec(`
      CREATE TABLE IF NOT EXISTS hq_receipt_credit_notes (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id             TEXT UNIQUE NOT NULL,
        purchase_sync_id    TEXT NOT NULL,
        branch_slug         TEXT,
        reason              TEXT NOT NULL,
        amount              REAL NOT NULL DEFAULT 0,
        notes               TEXT,
        created_by          INTEGER,
        created_by_name     TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_hq_rcn_po ON hq_receipt_credit_notes (purchase_sync_id);

      CREATE TABLE IF NOT EXISTS hq_receipt_credit_note_items (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id               TEXT UNIQUE NOT NULL,
        credit_note_sync_id   TEXT NOT NULL,
        product_sync_id       TEXT,
        product_name          TEXT,
        quantity              REAL NOT NULL DEFAULT 0,
        unit                  TEXT,
        unit_conv             REAL NOT NULL DEFAULT 1,
        unit_value            REAL NOT NULL DEFAULT 0,
        total_price           REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_hq_rcni_cn ON hq_receipt_credit_note_items (credit_note_sync_id);
    `);
  } catch (e) {
    console.warn('[masterDb] v1.13.35 hq_receipt_credit_notes:', e.message);
  }

  // â•â•â• Master-DB sync bookkeeping â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  //
  // Ported from Kelete v1.10.248-254. These are the master.db tables a branch
  // needs a working copy of: deposits it made, transfers either end of, HQ
  // purchases destined for it, and the GRNs / credit notes raised against
  // those. Everything else in master.db stays VPS-only.
  //
  // Two columns drive the whole thing:
  //   synced     0 = changed here, the other side has not seen it yet.
  //   updated_at last-write time, used as the pull cursor and to settle
  //              conflicts (newest write wins).
  //
  // â”€â”€ CONTRACT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Route code MUST NOT set `updated_at` or `synced` on these tables. The
  // triggers below stamp both on every local write. The triggers deliberately
  // SKIP when the caller already touched either column â€” that is how the sync
  // loop's own writes (which set synced=1 on ack) avoid re-flagging a row it
  // just acknowledged. So a route that ALSO sets updated_at makes the trigger
  // skip, synced stays 1, and the change is never pushed.
  //
  // Kelete shipped that exact bug in three routes and spent a version finding
  // it â€” the symptom is a change that silently never reaches other devices.
  // Kelete had it in two (hqGrns.js, hqPurchases.js, both PO status writes);
  // removed alongside this block. If you catch yourself typing
  // `updated_at = datetime('now')` in a route touching one of these tables:
  // don't. The trigger has it.
  // â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  const MASTER_SYNC_TABLES = [
    'cash_deposits',
    'stock_transfers',
    'transfer_variances',
    'hq_purchases',
    'hq_purchase_items',
    'hq_purchase_receipt_extras',
    'hq_grns',
    'hq_grn_items',
    'hq_supplier_credit_notes',
    'hq_supplier_credit_note_items',
  ];

  for (const t of MASTER_SYNC_TABLES) {
    addMasterCol(t, 'synced',     'INTEGER NOT NULL DEFAULT 0');
    addMasterCol(t, 'updated_at', 'TEXT');
  }

  // Rows that pre-date this block have synced NULL. The push loop selects
  // `synced = 0`, so leave them at 0 and they replicate once on first run.
  for (const t of MASTER_SYNC_TABLES) {
    try { masterDb.prepare(`UPDATE ${t} SET synced = 0 WHERE synced IS NULL`).run(); }
    catch (_) { /* table absent on this install */ }
  }

  // SQLite runs with recursive_triggers OFF by default, so a trigger's own
  // UPDATE cannot re-fire it â€” no loop risk. The WHEN guards exist purely to
  // let the sync loop's writes pass through untouched.
  //
  // 2026-08-28 â€” MILLISECONDS, not datetime('now'). Kelete uses second
  // resolution, and the push guard rejects incoming rows whose timestamp is
  // <= the server's. Two writes inside the same second are therefore
  // indistinguishable and the second one is thrown away as "stale". A branch
  // confirming a transfer HQ raised moments earlier hit exactly that in
  // testing. Sub-second stamps close it. Format still sorts and compares as
  // a string, so the pull cursor is unaffected.
  for (const t of MASTER_SYNC_TABLES) {
    try {
      masterDb.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_${t}_touch_ins
        AFTER INSERT ON ${t}
        FOR EACH ROW
        WHEN NEW.updated_at IS NULL
        BEGIN
          UPDATE ${t} SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), synced = 0 WHERE id = NEW.id;
        END;

        CREATE TRIGGER IF NOT EXISTS trg_${t}_touch_upd
        AFTER UPDATE ON ${t}
        FOR EACH ROW
        WHEN NEW.updated_at IS OLD.updated_at AND NEW.synced IS OLD.synced
        BEGIN
          UPDATE ${t} SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now'), synced = 0 WHERE id = NEW.id;
        END;
      `);
    } catch (e) {
      console.warn(`[master sync trigger] ${t}:`, e.message);
    }
  }

  // â•â•â• Schema-change guard for the master pull â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
  //
  // 2026-08-30 â€” the pull copies only columns the RECEIVING database already
  // has:
  //     const cols = PRAGMA table_info(<table>)          // â† local columns
  //     updateCols = cols.filter(c => row[c] !== undefined)
  //
  // So a column that arrives AFTER the data is silently dropped, and the
  // incremental cursor then moves past that row for ever.
  //
  // It bit us: a deposit was soft-deleted on the VPS at 15:37:13. A till
  // pulled the row moments later and took updated_at (a column it had) but
  // NOT deleted_at (a column that only arrived with the next build). The
  // deposit stayed alive on that till, still counted in its Cash Book, and
  // no later pull would ever mention it again â€” its timestamp was already
  // behind the cursor.
  //
  // Fingerprint the synced tables' columns. When the shape changes, clear the
  // pull cursor so the next pull is a full one and every row is re-read with
  // the new columns in place. Cheap: it happens once per schema change.
  try {
    const shape = MASTER_SYNC_TABLES.map(t => {
      let cols = [];
      try { cols = masterDb.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name).sort(); }
      catch (_) { /* table absent on this install */ }
      return t + ':' + cols.join(',');
    }).join('|');
    const fingerprint = require('crypto').createHash('sha1').update(shape).digest('hex').slice(0, 16);

    const { defaultDb } = require('./database');
    const prev = defaultDb.prepare(
      "SELECT value FROM sync_config WHERE key = 'master_schema_fingerprint' LIMIT 1"
    ).get()?.value || null;

    if (prev !== fingerprint) {
      defaultDb.prepare(
        `INSERT INTO sync_config (key, value) VALUES ('master_schema_fingerprint', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(fingerprint);
      if (prev) {
        // Only on a CHANGE, not on first run â€” a fresh install pulls
        // everything anyway.
        defaultDb.prepare("DELETE FROM sync_config WHERE key = 'last_master_pull_time'").run();
        console.log('[master] synced-table columns changed â€” next pull will be a full one');
      }
    }
  } catch (e) {
    console.warn('[master] schema fingerprint check skipped:', e.message);
  }

  console.log('[master] Master DB ready:', masterDbPath);
} catch (e) {
  console.warn('[master] Could not open master DB (Electron mode â€” VPS-only features disabled):', e.message);
  masterDb = null;
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function isRegistered(slug) {
  if (!masterDb) return false;
  const row = masterDb.prepare('SELECT id FROM tenants WHERE slug = ? AND is_active = 1').get(slug);
  return !!row;
}

function getTenant(slug) {
  if (!masterDb) return null;
  return masterDb.prepare('SELECT * FROM tenants WHERE slug = ? AND is_active = 1').get(slug);
}

function registerTenant(slug, businessName, email) {
  if (!masterDb) return;
  masterDb.prepare('INSERT INTO tenants (slug, business_name, email) VALUES (?, ?, ?)').run(slug, businessName, email || null);
}

function listTenants() {
  if (!masterDb) return [];
  return masterDb.prepare(`
    SELECT t.*, b.tenant_id
    FROM tenants t
    LEFT JOIN branches b ON b.slug = t.slug
    GROUP BY t.id
    ORDER BY t.created_at DESC
  `).all();
}

function deactivateTenant(slug) {
  if (!masterDb) return;
  masterDb.prepare('UPDATE tenants SET is_active = 0 WHERE slug = ?').run(slug);
}

// â”€â”€ License helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function getLicense(key) {
  if (!masterDb) return null;
  return masterDb.prepare('SELECT * FROM licenses WHERE key = ?').get(key);
}

function createLicense(key, maxBranches, expiresAt, notes) {
  if (!masterDb) return;
  masterDb.prepare('INSERT INTO licenses (key, max_branches, expires_at, notes) VALUES (?, ?, ?, ?)').run(key, maxBranches, expiresAt, notes || null);
}

function activateLicense(key, email, tenantId) {
  if (!masterDb) return;
  masterDb.prepare("UPDATE licenses SET tenant_email = ?, tenant_id = ?, activated_at = datetime('now') WHERE key = ?").run(email, tenantId, key);
}

function updateLicense(key, fields) {
  if (!masterDb) return;
  const { expiresAt, isActive, maxBranches, notes } = fields;
  masterDb.prepare(`
    UPDATE licenses SET
      expires_at   = COALESCE(?, expires_at),
      is_active    = COALESCE(?, is_active),
      max_branches = COALESCE(?, max_branches),
      notes        = COALESCE(?, notes)
    WHERE key = ?
  `).run(expiresAt ?? null, isActive ?? null, maxBranches ?? null, notes ?? null, key);
}

function listLicenses() {
  if (!masterDb) return [];
  const licenses = masterDb.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
  return licenses.map(l => {
    const branches = l.tenant_id
      ? masterDb.prepare('SELECT * FROM branches WHERE tenant_id = ?').all(l.tenant_id)
      : [];
    const slug = branches.length ? branches[0].slug : null;
    return {
      ...l,
      branch_count: branches.length,
      branch_codes: branches.map(b => `${b.branch_name} [${b.branch_id.replace(/-/g,'').substring(0,8).toUpperCase()}]`).join(', ') || null,
      slug,
    };
  });
}

function getLicenseStats() {
  if (!masterDb) return { total: 0, active: 0, expired: 0, expiring: 0 };
  const now  = new Date().toISOString();
  const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
  return {
    total:    masterDb.prepare('SELECT COUNT(*) AS n FROM licenses').get().n,
    active:   masterDb.prepare("SELECT COUNT(*) AS n FROM licenses WHERE is_active=1 AND expires_at > ?").get(now).n,
    expired:  masterDb.prepare("SELECT COUNT(*) AS n FROM licenses WHERE expires_at <= ?").get(now).n,
    expiring: masterDb.prepare("SELECT COUNT(*) AS n FROM licenses WHERE is_active=1 AND expires_at > ? AND expires_at <= ?").get(now, soon).n,
  };
}

// â”€â”€ Branch helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function registerBranch(tenantId, branchId, branchName, slug) {
  if (!masterDb) return;
  try {
    masterDb.prepare('INSERT OR IGNORE INTO branches (tenant_id, branch_id, branch_name, slug) VALUES (?, ?, ?, ?)').run(tenantId, branchId, branchName, slug || null);
  } catch (_) {}
}

function getBranchesForTenant(tenantId) {
  if (!masterDb) return [];
  return masterDb.prepare('SELECT * FROM branches WHERE tenant_id = ?').all(tenantId);
}

module.exports = {
  isRegistered, getTenant, registerTenant, listTenants, deactivateTenant,
  getLicense, createLicense, activateLicense, updateLicense, listLicenses, getLicenseStats,
  registerBranch, getBranchesForTenant,
  masterDb,
  // Re-export the masterDb instance under a more obvious name for the
  // transfer routes, which need to read/write the stock_transfers table
  // directly without going through per-tenant routing.
  getMasterDb: () => masterDb,
};
