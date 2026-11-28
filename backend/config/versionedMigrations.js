// D1 — the ordered list of schema migrations for branch (tenant) databases,
// including the Electron till's kelete.db.
//
// RULES for adding one:
//   • Append with the next version number. Never renumber, edit or delete a
//     migration that has shipped — its checksum is recorded on every database
//     that ran it. Fix mistakes with a NEW migration.
//   • `up(db)` runs inside a transaction. Throw to abort; nothing is kept.
//   • Additive only (ADD COLUMN, CREATE TABLE/INDEX/TRIGGER) unless a change
//     has been separately approved. No DROP TABLE, no table rebuilds.
//   • Create a UNIQUE index only after a duplicate check that returns zero
//     rows, and throw with a clear message if it does not.
//   • Data fixes that must run once belong in runOnce() tasks, not here.

const { createAuditTable } = require('./auditSchema');

module.exports = [
  {
    version: 1,
    name: 'baseline',
    // Marks the point at which versioning began. Everything before it is the
    // legacy initTenantDb() schema, which keeps running idempotently because
    // the live databases' exact state cannot yet be seen (Phase 2a).
    up() { /* intentionally empty */ },
  },
  {
    version: 2,
    name: 'audit_log',
    // D2 — append-only audit table. Its change-capture triggers are built by
    // ensureAuditTriggers() from the columns actually present (auditSchema.js).
    up(db) { createAuditTable(db); },
  },
  {
    version: 3,
    name: 'fuel_ledger_guards',
    // F4 — the tank ledger becomes append-only at the database level, so no
    // code path (current or future) can erase or rewrite fuel history.
    //   • tank_movements rows cannot be deleted, and their litres / tank /
    //     type / date cannot be changed. Corrections are new rows
    //     (adjustment or reversal).
    //   • A tank that has ledger history cannot be deleted (the old ON DELETE
    //     CASCADE would have erased that history with it).
    //   • A dip that has been posted to the ledger cannot be deleted.
    // Only blocks future deletes/edits; existing rows are untouched.
    up(db) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_f4_tank_movements_no_delete
        BEFORE DELETE ON tank_movements
        BEGIN SELECT RAISE(ABORT, 'Tank ledger rows cannot be deleted. Post a reversal or adjustment instead.'); END;

        CREATE TRIGGER IF NOT EXISTS trg_f4_tank_movements_no_rewrite
        BEFORE UPDATE OF litres, tank_id, type, movement_date ON tank_movements
        BEGIN SELECT RAISE(ABORT, 'Tank ledger rows cannot be changed. Post an adjustment instead.'); END;

        CREATE TRIGGER IF NOT EXISTS trg_f4_tanks_keep_history
        BEFORE DELETE ON tanks
        WHEN EXISTS (SELECT 1 FROM tank_movements WHERE tank_id = OLD.id)
        BEGIN SELECT RAISE(ABORT, 'This tank has ledger history and cannot be deleted. Mark it Inactive instead.'); END;

        CREATE TRIGGER IF NOT EXISTS trg_f4_posted_dips_keep
        BEFORE DELETE ON tank_dips
        WHEN OLD.posted_adjustment_id IS NOT NULL
        BEGIN SELECT RAISE(ABORT, 'This dip has been posted to the tank ledger and cannot be deleted.'); END;
      `);
    },
  },
  {
    version: 4,
    name: 'credit_ticket_order_sync_link',
    // F2 — shift_credit_sales linked its receivable order only by numeric id,
    // which is meaningless on any other device after sync (Phase 2a C4). Add
    // the order's sync_id alongside it. Additive; existing rows stay NULL
    // until the per-device backfill (after the Phase 2b checks).
    up(db) {
      const cols = db.prepare('PRAGMA table_info(shift_credit_sales)').all().map(c => c.name);
      if (cols.length && !cols.includes('linked_order_sync_id')) {
        db.exec('ALTER TABLE shift_credit_sales ADD COLUMN linked_order_sync_id TEXT');
      }
    },
  },
  {
    version: 5,
    name: 'sync_device_tokens',
    // S1 stage 2 — one row per till allowed to sync with this database. Only a
    // SHA-256 of each token is stored. Server-side only: not in any sync list.
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_device_tokens (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          token_hash    TEXT NOT NULL UNIQUE,
          tenant_id     TEXT NOT NULL,
          branch_id     TEXT,
          device_id     TEXT,
          label         TEXT,
          issued_via    TEXT NOT NULL,          -- register | join-branch | auto-enrol
          created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_seen_at  TEXT,
          last_ip       TEXT,
          revoked_at    TEXT,
          revoked_by    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sync_device_tokens_device ON sync_device_tokens (tenant_id, device_id);
      `);
    },
  },
  {
    version: 6,
    name: 'fuel_sync',
    // F1 — sync columns, link sync_ids, change-marking triggers and the
    // deletion log on every fuel table (config/fuelSync.js). Additive: columns
    // are added, existing rows get a sync_id and their links' sync_ids, and are
    // queued to be sent once. No row is deleted or rewritten.
    up(db) { require('./fuelSync').installSchema(db); },
  },
  {
    version: 7,
    name: 'shift_business_date',
    // UTC dates fix — each attendant shift records its trading day (Zambian
    // date when opened). Existing shifts keep the date the old rule gave them
    // (DATE(opened_at), UTC), so no approval already given covers different
    // shifts afterwards. Additive.
    up(db) {
      const cols = db.prepare('PRAGMA table_info(attendant_shifts)').all().map(c => c.name);
      if (!cols.length) return;
      if (!cols.includes('shift_date')) db.exec('ALTER TABLE attendant_shifts ADD COLUMN shift_date TEXT');
      // Every device computes the same value for its existing rows, so this is
      // not a change to sync: run it with F1's "applying" flag set.
      const flag = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_apply_state'").get();
      if (flag) db.prepare("UPDATE sync_apply_state SET v = 1 WHERE k = 'applying'").run();
      try {
        db.prepare('UPDATE attendant_shifts SET shift_date = DATE(opened_at) WHERE shift_date IS NULL').run();
      } finally {
        if (flag) db.prepare("UPDATE sync_apply_state SET v = 0 WHERE k = 'applying'").run();
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_attendant_shifts_shift_date ON attendant_shifts (shift_date, shift_type)');
    },
  },
  {
    version: 8,
    name: 'delivery_cost_trail',
    // Average-cost fix — each delivery records the grade's cost just before
    // and after it, so deleting it can put the cost back. Additive; older
    // deliveries stay NULL (their deletion un-blends the average instead).
    up(db) {
      const cols = db.prepare('PRAGMA table_info(fuel_deliveries)').all().map(c => c.name);
      if (!cols.length) return;
      if (!cols.includes('cost_before')) db.exec('ALTER TABLE fuel_deliveries ADD COLUMN cost_before REAL');
      if (!cols.includes('cost_after')) db.exec('ALTER TABLE fuel_deliveries ADD COLUMN cost_after REAL');
    },
  },
  {
    version: 9,
    name: 'shift_credit_total_column',
    // Shift close stored the CREDIT total in payment_other (and whatever was
    // sent as "Other" was dropped); the shift view then showed credit twice.
    // New column payment_credit. Existing shifts whose payment_other equals
    // their credit-ticket total have it moved across (other → 0); any other
    // value is left untouched. Not marked for sync (F1 "applying" flag).
    up(db) {
      const cols = db.prepare('PRAGMA table_info(attendant_shifts)').all().map(c => c.name);
      if (!cols.length) return;
      if (!cols.includes('payment_credit')) db.exec('ALTER TABLE attendant_shifts ADD COLUMN payment_credit REAL');
      const flag = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_apply_state'").get();
      if (flag) db.prepare("UPDATE sync_apply_state SET v = 1 WHERE k = 'applying'").run();
      try {
        db.exec(`
          UPDATE attendant_shifts
             SET payment_credit = payment_other, payment_other = 0
           WHERE payment_credit IS NULL AND status != 'Open' AND COALESCE(payment_other, 0) != 0
             AND ABS(payment_other - (SELECT COALESCE(SUM(c.amount), 0) FROM shift_credit_sales c
                                       WHERE c.shift_id = attendant_shifts.id AND COALESCE(c.payment_method, 'Credit') = 'Credit')) < 0.005;
          UPDATE attendant_shifts
             SET payment_credit = (SELECT COALESCE(SUM(c.amount), 0) FROM shift_credit_sales c
                                    WHERE c.shift_id = attendant_shifts.id AND COALESCE(c.payment_method, 'Credit') = 'Credit')
           WHERE payment_credit IS NULL AND status != 'Open';`);
      } finally {
        if (flag) db.prepare("UPDATE sync_apply_state SET v = 0 WHERE k = 'applying'").run();
      }
    },
  },
  {
    version: 10,
    name: 'business_date_orders_stock',
    // UTC dates fix (shop/accounting) — orders and stock movements record the
    // station's day (UTC+2) when written. A trigger fills it, so no insert
    // needs changing; a row arriving by sync brings its own. Existing rows stay
    // NULL and reports fall back to the day they always showed (no historical
    // row moves to another day). The offset is fixed at +120 min here, as in
    // config/businessTime.js (Zambia has no daylight saving).
    up(db) {
      for (const t of ['orders', 'stock_movements']) {
        const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
        if (!cols.length) continue;
        if (!cols.includes('business_date')) db.exec(`ALTER TABLE ${t} ADD COLUMN business_date TEXT`);
        db.exec(`
          DROP TRIGGER IF EXISTS trg_${t}_business_date_ins;
          CREATE TRIGGER trg_${t}_business_date_ins AFTER INSERT ON ${t}
          WHEN NEW.business_date IS NULL AND NEW.created_at IS NOT NULL
          BEGIN
            UPDATE ${t} SET business_date = DATE(NEW.created_at, '+120 minutes') WHERE rowid = NEW.rowid;
          END;
          DROP TRIGGER IF EXISTS trg_${t}_business_date_upd;
          CREATE TRIGGER trg_${t}_business_date_upd AFTER UPDATE OF created_at ON ${t}
          WHEN NEW.created_at IS NOT OLD.created_at AND NEW.business_date IS OLD.business_date AND OLD.business_date IS NOT NULL
          BEGIN
            UPDATE ${t} SET business_date = DATE(NEW.created_at, '+120 minutes') WHERE rowid = NEW.rowid;
          END;
          CREATE INDEX IF NOT EXISTS idx_${t}_business_date ON ${t} (business_date);`);
      }
    },
  },
  {
    version: 11,
    name: 'fleet_customer_merge',
    // F3 — fleet accounts are merged into Customers (services/fleetMerge.js).
    // Each fleet account gets a link to its Customer; a log records every
    // merge step so it can be undone. Additive; nothing is merged here — the
    // merge is run (dry-run first) by an Administrator.
    up(db) {
      const cols = db.prepare('PRAGMA table_info(fleet_customers)').all().map(c => c.name);
      if (!cols.length) return;
      if (!cols.includes('customer_id')) db.exec('ALTER TABLE fleet_customers ADD COLUMN customer_id INTEGER');
      if (!cols.includes('customer_sync_id')) db.exec('ALTER TABLE fleet_customers ADD COLUMN customer_sync_id TEXT');
      if (!cols.includes('merged_at')) db.exec('ALTER TABLE fleet_customers ADD COLUMN merged_at TEXT');
      db.exec(`CREATE TABLE IF NOT EXISTS fleet_merge_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fleet_customer_id INTEGER, fleet_sync_id TEXT, fleet_name TEXT,
        customer_id INTEGER, customer_sync_id TEXT, customer_name TEXT,
        matched_by TEXT NOT NULL,                 -- phone | name | chosen | created
        created_customer INTEGER NOT NULL DEFAULT 0,
        balance_carried REAL NOT NULL DEFAULT 0,
        ticket_ids TEXT,                          -- JSON: credit tickets re-pointed
        merged_at TEXT NOT NULL DEFAULT (datetime('now')), merged_by TEXT,
        undone_at TEXT, undone_by TEXT)`);
      // the fleet → customer link travels with fuel sync (F1)
      const fuelSync = require('./fuelSync');
      fuelSync.installTriggers(db, fuelSync.SPEC.fleet_customers);
    },
  },
  {
    version: 12,
    name: 'station_weather_location',
    // UX-4 — where the station is, for the Dashboard weather card (chosen by
    // an Administrator from a list of towns, or typed coordinates). Additive.
    up(db) {
      const cols = db.prepare('PRAGMA table_info(business_settings)').all().map(c => c.name);
      if (!cols.length) return;
      if (!cols.includes('weather_town')) db.exec('ALTER TABLE business_settings ADD COLUMN weather_town TEXT');
      if (!cols.includes('weather_lat')) db.exec('ALTER TABLE business_settings ADD COLUMN weather_lat REAL');
      if (!cols.includes('weather_lon')) db.exec('ALTER TABLE business_settings ADD COLUMN weather_lon REAL');
    },
  },
  {
    version: 13,
    name: 'fuel_cost_at_close',
    // Profit Report (fuel) — each shift's nozzle readings keep the grade's
    // average cost per litre as it was when the shift closed, so a later
    // delivery that re-averages the cost can never change a past margin.
    // Additive; existing rows stay NULL (the report marks them "estimated"
    // and uses today's average cost). Travels with fuel sync like any column.
    up(db) {
      const cols = db.prepare('PRAGMA table_info(shift_nozzle_readings)').all().map(c => c.name);
      if (!cols.length) return;
      if (!cols.includes('cost_per_litre')) db.exec('ALTER TABLE shift_nozzle_readings ADD COLUMN cost_per_litre REAL');
    },
  },
  {
    version: 14,
    name: 'business_type',
    // Per-tenant mode so one Kelete install can serve filling stations AND
    // grocery depots from the same codebase. 'fuel' keeps the Fuel Station
    // sidebar group and hides Sales + Store. 'grocery' does the opposite.
    // Default 'fuel' so every existing live tenant keeps its current UI;
    // grocery tenants (lumumbashop, greateastshop) get flipped manually.
    up(db) {
      const cols = db.prepare('PRAGMA table_info(business_settings)').all().map(c => c.name);
      if (!cols.length) return;
      if (!cols.includes('business_type')) {
        db.exec("ALTER TABLE business_settings ADD COLUMN business_type TEXT NOT NULL DEFAULT 'fuel'");
      }
    },
  },
  {
    version: 15,
    name: 'onecard_ap_link',
    // 1Card tickets reduce AP to a fuel-card supplier (Engen, Puma, …) the
    // moment fuel is drawn — the supplier has effectively "paid" by taking
    // product. Each ticket auto-posts an ap_payments row; these columns
    // hold the link so a ticket deletion can reverse its own payment.
    // Additive; existing rows stay NULL (legacy 1Card tickets predate AP
    // linkage, and the Fuel Cash Report already treats them as settled).
    up(db) {
      const cols = db.prepare('PRAGMA table_info(shift_credit_sales)').all().map(c => c.name);
      if (!cols.length) return;
      if (!cols.includes('supplier_id')) db.exec('ALTER TABLE shift_credit_sales ADD COLUMN supplier_id INTEGER');
      if (!cols.includes('supplier_sync_id')) db.exec('ALTER TABLE shift_credit_sales ADD COLUMN supplier_sync_id TEXT');
      if (!cols.includes('linked_ap_payment_id')) db.exec('ALTER TABLE shift_credit_sales ADD COLUMN linked_ap_payment_id INTEGER');
      if (!cols.includes('linked_ap_payment_sync_id')) db.exec('ALTER TABLE shift_credit_sales ADD COLUMN linked_ap_payment_sync_id TEXT');
    },
  },
  {
    version: 16,
    name: 'grn_cost_currency',
    // Account Payables reads grn.cost_currency (v1.10.79), but the schema never
    // created it: only the one-off backfill script did, on the databases it was
    // run on. On a new till the AP page failed with "no such column". Additive;
    // NULL counts as Kwacha everywhere it is read.
    up(db) {
      const cols = db.prepare('PRAGMA table_info(grn)').all().map(c => c.name);
      if (!cols.length) return;
      if (!cols.includes('cost_currency')) db.exec('ALTER TABLE grn ADD COLUMN cost_currency TEXT');
    },
  },
  {
    version: 17,
    name: 'category_sold_at',
    // Where a category's items are sold: 'fuel' (fuel stations), 'shop'
    // (shops) or 'both'. HQ Purchase uses it to offer only the branches an
    // item belongs to. Additive; existing categories stay NULL, which is
    // read as 'both', so nothing that works today is narrowed.
    up(db) {
      const cols = db.prepare('PRAGMA table_info(categories)').all().map(c => c.name);
      if (!cols.length) return;
      if (!cols.includes('sold_at')) db.exec('ALTER TABLE categories ADD COLUMN sold_at TEXT');
    },
  },
  {
    version: 18,
    name: 'supplier_details',
    // Suppliers screen rebuild: what the supplier supplies ('fuel' | 'shop' |
    // 'both'; NULL = not set yet, treated as both), bank details and payment
    // terms. tpin already exists on most databases (added by the legacy list
    // for ZRA purchases); added here too in case it is missing. Additive.
    up(db) {
      const cols = db.prepare('PRAGMA table_info(suppliers)').all().map(c => c.name);
      if (!cols.length) return;
      for (const [c, t] of [['supplies', 'TEXT'], ['tpin', 'TEXT'], ['bank_name', 'TEXT'], ['bank_account', 'TEXT'], ['payment_terms', 'TEXT']]) {
        if (!cols.includes(c)) db.exec(`ALTER TABLE suppliers ADD COLUMN ${c} ${t}`);
      }
    },
  },
];
