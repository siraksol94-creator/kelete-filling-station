require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const db = require('./config/database');
const syncConfig = require('./config/syncConfig');
const app = express();

const uploadsDir = process.env.UPLOADS_DIR
  || (process.env.ELECTRON_USER_DATA ? path.join(process.env.ELECTRON_USER_DATA, 'uploads') : path.join(__dirname, 'uploads'));

const fs = require('fs');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(uploadsDir));

// ─── Create all tables on first run ────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name  TEXT NOT NULL,
    last_name   TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    phone       TEXT,
    address     TEXT,
    role        TEXT NOT NULL DEFAULT 'Cashier',
    permissions TEXT DEFAULT '[]',
    status      TEXT NOT NULL DEFAULT 'Active',
    last_login  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    color       TEXT DEFAULT '#6B7280',
    status      TEXT NOT NULL DEFAULT 'Active',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS main_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    color       TEXT DEFAULT '#6B7280',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS units (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    abbreviation TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pv_types (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    color       TEXT DEFAULT '#6B7280',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    code                TEXT,
    name                TEXT NOT NULL,
    category_id         INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    unit                TEXT NOT NULL DEFAULT 'kg',
    cost_price          REAL NOT NULL DEFAULT 0,
    selling_price       REAL NOT NULL DEFAULT 0,
    current_stock       REAL NOT NULL DEFAULT 0,
    min_stock           REAL NOT NULL DEFAULT 10,
    status              TEXT NOT NULL DEFAULT 'Active',
    image_url           TEXT,
    ub_number_start     INTEGER DEFAULT 1,
    ub_number_length    INTEGER DEFAULT 6,
    ub_quantity_start   INTEGER DEFAULT 7,
    ub_quantity_length  INTEGER DEFAULT 0,
    ub_decimal_start    INTEGER DEFAULT 2,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    type             TEXT NOT NULL DEFAULT 'Regular',
    phone            TEXT,
    email            TEXT,
    address          TEXT,
    total_purchases  REAL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'Active',
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS suppliers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    type            TEXT,
    phone           TEXT,
    email           TEXT,
    address         TEXT,
    contact_person  TEXT,
    outstanding     REAL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'Active',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_number    TEXT UNIQUE NOT NULL,
    customer_name   TEXT,
    payment_method  TEXT DEFAULT 'Cash',
    subtotal        REAL NOT NULL DEFAULT 0,
    tax_rate        REAL DEFAULT 0,
    tax_amount      REAL DEFAULT 0,
    discount        REAL DEFAULT 0,
    total_amount    REAL NOT NULL DEFAULT 0,
    amount_received REAL DEFAULT 0,
    change_amount   REAL DEFAULT 0,
    status          TEXT DEFAULT NULL,
    created_by      INTEGER REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id            INTEGER NOT NULL REFERENCES orders(id),
    product_id          INTEGER REFERENCES products(id),
    product_name        TEXT NOT NULL,
    quantity            REAL NOT NULL,
    unit_price          REAL NOT NULL,
    discount_percentage REAL DEFAULT 0,
    discount_amount     REAL DEFAULT 0,
    total_price         REAL NOT NULL,
    reversed            INTEGER NOT NULL DEFAULT 0,
    reversed_at         TEXT
  );

  CREATE TABLE IF NOT EXISTS grn (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    grn_number   TEXT UNIQUE NOT NULL,
    date         TEXT NOT NULL,
    supplier_id  INTEGER REFERENCES suppliers(id),
    total_items  INTEGER DEFAULT 0,
    total_amount REAL DEFAULT 0,
    notes        TEXT,
    created_by   INTEGER REFERENCES users(id),
    status       TEXT DEFAULT 'Completed',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS grn_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    grn_id      INTEGER NOT NULL REFERENCES grn(id),
    product_id  INTEGER REFERENCES products(id),
    quantity    REAL NOT NULL,
    unit_price  REAL NOT NULL,
    total_price REAL NOT NULL,
    sync_id     TEXT,
    tenant_id   INTEGER,
    branch_id   INTEGER,
    device_id   TEXT,
    synced      INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS siv (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    siv_number  TEXT UNIQUE NOT NULL,
    date        TEXT NOT NULL,
    department  TEXT,
    total_items INTEGER DEFAULT 0,
    total_value REAL DEFAULT 0,
    notes       TEXT,
    created_by  INTEGER REFERENCES users(id),
    status      TEXT DEFAULT 'Issued',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS siv_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    siv_id      INTEGER NOT NULL REFERENCES siv(id),
    product_id  INTEGER REFERENCES products(id),
    quantity    REAL NOT NULL,
    unit_price  REAL DEFAULT 0,
    total_price REAL DEFAULT 0,
    sync_id     TEXT,
    tenant_id   INTEGER,
    branch_id   INTEGER,
    device_id   TEXT,
    synced      INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stock_movements (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id     INTEGER REFERENCES products(id),
    location       TEXT NOT NULL,
    movement_type  TEXT NOT NULL,
    quantity       REAL NOT NULL,
    reference_id   INTEGER,
    reference_type TEXT,
    notes          TEXT,
    created_by     INTEGER REFERENCES users(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cash_receipts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    receipt_number TEXT UNIQUE NOT NULL,
    received_from  TEXT,
    description    TEXT,
    payment_method TEXT,
    amount         REAL NOT NULL DEFAULT 0,
    date           TEXT NOT NULL,
    created_by     INTEGER REFERENCES users(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payment_vouchers (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    voucher_number TEXT UNIQUE NOT NULL,
    paid_to        TEXT,
    description    TEXT,
    category       TEXT,
    amount         REAL NOT NULL DEFAULT 0,
    date           TEXT NOT NULL,
    paid_from      TEXT DEFAULT 'Main cashier',
    created_by     INTEGER REFERENCES users(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ap_payments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_number TEXT UNIQUE NOT NULL,
    supplier_id    INTEGER REFERENCES suppliers(id),
    supplier_name  TEXT,
    amount         REAL NOT NULL DEFAULT 0,
    description    TEXT,
    date           TEXT NOT NULL,
    paid_from      TEXT DEFAULT 'Main cashier',
    created_by     INTEGER REFERENCES users(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

    CREATE TABLE IF NOT EXISTS cash_book (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    date           TEXT NOT NULL,
    description    TEXT,
    reference      TEXT,
    receipt_amount REAL DEFAULT 0,
    payment_amount REAL DEFAULT 0,
    balance        REAL DEFAULT 0,
    type           TEXT DEFAULT 'entry',
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS business_settings (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name    TEXT,
    business_phone   TEXT,
    business_email   TEXT,
    business_address TEXT,
    tax_rate         REAL DEFAULT 0,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cash_reports (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    date           TEXT NOT NULL,
    initial_change REAL DEFAULT 0,
    mobile_money   REAL DEFAULT 0,
    cash           REAL DEFAULT 0,
    expenses       REAL DEFAULT 0,
    pending        REAL DEFAULT 0,
    total          REAL DEFAULT 0,
    after_change   REAL DEFAULT 0,
    expected       REAL DEFAULT 0,
    difference     REAL DEFAULT 0,
    status         TEXT,
    comment        TEXT,
    created_by     INTEGER REFERENCES users(id),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS stock_adjustments (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    adjustment_number TEXT UNIQUE NOT NULL,
    date              TEXT NOT NULL,
    product_id        INTEGER REFERENCES products(id),
    adjustment_type   TEXT NOT NULL,
    quantity          REAL NOT NULL,
    reason            TEXT,
    notes             TEXT,
    created_by        INTEGER REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_actual_balance (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id       INTEGER NOT NULL REFERENCES products(id),
    product_sync_id  TEXT,
    date             TEXT NOT NULL,
    actual_balance   REAL NOT NULL,
    reason           TEXT,
    created_by       INTEGER,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(product_id, date)
  );
`);

// ─── Daily cost snapshot ─────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_cost_snapshot (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id      INTEGER REFERENCES products(id),
    product_sync_id TEXT,
    date            TEXT NOT NULL,
    avg_cost_price  REAL NOT NULL DEFAULT 0,
    selling_price   REAL NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    sync_id         TEXT,
    tenant_id       TEXT,
    branch_id       TEXT,
    device_id       TEXT,
    synced          INTEGER NOT NULL DEFAULT 0,
    deleted_at      TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_dcs_product_sync_date ON daily_cost_snapshot (product_sync_id, date);
`);

// ─── Daily profit summary ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_profit_summary (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    date            TEXT NOT NULL,
    tenant_id       TEXT NOT NULL,
    revenue         REAL NOT NULL DEFAULT 0,
    cogs            REAL NOT NULL DEFAULT 0,
    diff_value      REAL NOT NULL DEFAULT 0,
    cash_difference REAL NOT NULL DEFAULT 0,
    pv_total        REAL NOT NULL DEFAULT 0,
    gross_profit    REAL NOT NULL DEFAULT 0,
    net_profit      REAL NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(date, tenant_id)
  );
`);

// ─── Sync: config table ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sync_config (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ─── Licenses table ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key          TEXT UNIQUE NOT NULL,
    tenant_email TEXT,
    tenant_id    TEXT,
    max_branches INTEGER NOT NULL DEFAULT 1,
    expires_at   TEXT NOT NULL,
    is_active    INTEGER NOT NULL DEFAULT 1,
    notes        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at TEXT
  );
`);

// ─── Production tables ────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS production (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    production_number TEXT UNIQUE NOT NULL,
    date              TEXT NOT NULL,
    notes             TEXT,
    total_input_cost  REAL DEFAULT 0,
    cost_per_kg       REAL DEFAULT 0,
    total_output_qty  REAL DEFAULT 0,
    created_by        INTEGER REFERENCES users(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS production_inputs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    production_id INTEGER NOT NULL REFERENCES production(id),
    product_id    INTEGER REFERENCES products(id),
    quantity      REAL NOT NULL,
    unit_cost     REAL NOT NULL DEFAULT 0,
    total_cost    REAL NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS production_outputs (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    production_id            INTEGER NOT NULL REFERENCES production(id),
    product_id               INTEGER REFERENCES products(id),
    quantity                 REAL NOT NULL,
    allocated_cost_per_unit  REAL NOT NULL DEFAULT 0,
    total_allocated_cost     REAL NOT NULL DEFAULT 0,
    created_at               TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sales_returns (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    return_number TEXT UNIQUE NOT NULL,
    date          TEXT NOT NULL,
    notes         TEXT,
    total_items   INTEGER DEFAULT 0,
    created_by    INTEGER REFERENCES users(id),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sales_return_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id  INTEGER REFERENCES sales_returns(id),
    product_id INTEGER REFERENCES products(id),
    quantity   REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── Sync: schema migration (add sync columns to all tables) ─────────────────
(function runSyncMigration() {
  function addCol(table, col, def) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!cols.find(c => c.name === col)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
    }
  }

  // Add product_type to products
  addCol('products', 'product_type', "TEXT NOT NULL DEFAULT 'finished'");

  const allTables = [
    'users', 'categories', 'main_categories', 'units', 'products', 'customers', 'suppliers',
    'orders', 'order_items', 'grn', 'grn_items', 'siv', 'siv_items',
    'stock_movements', 'cash_receipts', 'payment_vouchers', 'cash_book',
    'business_settings', 'cash_reports', 'stock_adjustments', 'daily_actual_balance', 'daily_cost_snapshot',
    'production', 'production_inputs', 'production_outputs',
    'sales_returns', 'sales_return_items', 'ap_payments', 'daily_profit_summary',
  ];

  // Tables that already have updated_at — skip them
  const hasUpdatedAt = new Set([
    'users', 'products', 'customers', 'suppliers', 'business_settings', 'cash_reports', 'daily_profit_summary',
  ]);

  for (const t of allTables) {
    addCol(t, 'sync_id',   'TEXT');
    addCol(t, 'tenant_id', 'TEXT');
    addCol(t, 'branch_id', 'TEXT');
    addCol(t, 'device_id', 'TEXT');
    addCol(t, 'deleted_at','TEXT');
    addCol(t, 'synced',    'INTEGER NOT NULL DEFAULT 0');
    addCol(t, 'created_at', 'TEXT');
    if (!hasUpdatedAt.has(t)) {
      addCol(t, 'updated_at', 'TEXT');
    }
  }

  // Add reference_sync_id to stock_movements for cross-device FK integrity
  addCol('stock_movements', 'reference_sync_id', 'TEXT');

  // Backfill reference_sync_id for existing records (runs once; skips already-filled rows)
  db.prepare(`UPDATE stock_movements SET reference_sync_id = (SELECT sync_id FROM siv WHERE id = stock_movements.reference_id) WHERE reference_type = 'siv' AND reference_sync_id IS NULL`).run();
  db.prepare(`UPDATE stock_movements SET reference_sync_id = (SELECT sync_id FROM grn WHERE id = stock_movements.reference_id) WHERE reference_type = 'grn' AND reference_sync_id IS NULL`).run();
  db.prepare(`UPDATE stock_movements SET reference_sync_id = (SELECT sync_id FROM production WHERE id = stock_movements.reference_id) WHERE reference_type = 'production' AND reference_sync_id IS NULL`).run();
  db.prepare(`UPDATE stock_movements SET reference_sync_id = (SELECT sync_id FROM orders WHERE id = stock_movements.reference_id) WHERE reference_type = 'order' AND reference_sync_id IS NULL`).run();
  db.prepare(`UPDATE stock_movements SET reference_sync_id = (SELECT sync_id FROM stock_adjustments WHERE id = stock_movements.reference_id) WHERE reference_type = 'adjustment' AND reference_sync_id IS NULL`).run();
  db.prepare(`UPDATE stock_movements SET reference_sync_id = (SELECT sync_id FROM sales_returns WHERE id = stock_movements.reference_id) WHERE reference_type = 'sales_return' AND reference_sync_id IS NULL`).run();

  // Add product_sync_id to stock_movements and all item tables
  addCol('stock_movements',    'product_sync_id', 'TEXT');
  addCol('grn_items',          'product_sync_id', 'TEXT');
  addCol('siv_items',          'product_sync_id', 'TEXT');
  addCol('order_items',        'product_sync_id', 'TEXT');
  addCol('production_inputs',  'product_sync_id', 'TEXT');
  addCol('production_outputs', 'product_sync_id', 'TEXT');
  addCol('sales_return_items',  'product_sync_id', 'TEXT');
  addCol('stock_adjustments',   'product_sync_id', 'TEXT');
  // Add category_sync_id to products
  addCol('products', 'category_sync_id', 'TEXT');

  // Backfill product_sync_id (runs once; skips already-filled rows)
  db.prepare(`UPDATE stock_movements SET product_sync_id = (SELECT sync_id FROM products WHERE id = stock_movements.product_id) WHERE product_sync_id IS NULL`).run();
  db.prepare(`UPDATE grn_items SET product_sync_id = (SELECT sync_id FROM products WHERE id = grn_items.product_id) WHERE product_sync_id IS NULL`).run();
  db.prepare(`UPDATE siv_items SET product_sync_id = (SELECT sync_id FROM products WHERE id = siv_items.product_id) WHERE product_sync_id IS NULL`).run();
  db.prepare(`UPDATE order_items SET product_sync_id = (SELECT sync_id FROM products WHERE id = order_items.product_id) WHERE product_sync_id IS NULL`).run();
  db.prepare(`UPDATE production_inputs SET product_sync_id = (SELECT sync_id FROM products WHERE id = production_inputs.product_id) WHERE product_sync_id IS NULL`).run();
  db.prepare(`UPDATE production_outputs SET product_sync_id = (SELECT sync_id FROM products WHERE id = production_outputs.product_id) WHERE product_sync_id IS NULL`).run();
  db.prepare(`UPDATE sales_return_items SET product_sync_id = (SELECT sync_id FROM products WHERE id = sales_return_items.product_id) WHERE product_sync_id IS NULL`).run();
  db.prepare(`UPDATE stock_adjustments SET product_sync_id = (SELECT sync_id FROM products WHERE id = stock_adjustments.product_id) WHERE product_sync_id IS NULL`).run();
  // Backfill category_sync_id for products
  db.prepare(`UPDATE products SET category_sync_id = (SELECT sync_id FROM categories WHERE id = products.category_id) WHERE category_sync_id IS NULL AND category_id IS NOT NULL`).run();

  // Add supplier_sync_id to grn
  addCol('grn', 'supplier_sync_id', 'TEXT');
  db.prepare(`UPDATE grn SET supplier_sync_id = (SELECT sync_id FROM suppliers WHERE id = grn.supplier_id) WHERE supplier_sync_id IS NULL AND supplier_id IS NOT NULL`).run();

  // Add supplier_sync_id to ap_payments
  addCol('ap_payments', 'supplier_sync_id', 'TEXT');
  db.prepare(`UPDATE ap_payments SET supplier_sync_id = (SELECT sync_id FROM suppliers WHERE id = ap_payments.supplier_id) WHERE supplier_sync_id IS NULL AND supplier_id IS NOT NULL`).run();
  // Fallback: backfill by supplier_name for VPS where integer IDs differ
  db.prepare(`UPDATE ap_payments SET supplier_sync_id = (SELECT sync_id FROM suppliers WHERE name = ap_payments.supplier_name AND deleted_at IS NULL LIMIT 1) WHERE supplier_sync_id IS NULL AND supplier_name IS NOT NULL`).run();
  // Fallback: backfill by supplier_name for VPS where integer IDs differ
  db.prepare(`UPDATE ap_payments SET supplier_sync_id = (SELECT sync_id FROM suppliers WHERE name = ap_payments.supplier_name AND deleted_at IS NULL LIMIT 1) WHERE supplier_sync_id IS NULL AND supplier_name IS NOT NULL`).run();

  // Add production_sync_id to production_inputs and production_outputs for cross-device DELETE
  addCol('production_inputs',  'production_sync_id', 'TEXT');
  addCol('production_outputs', 'production_sync_id', 'TEXT');
  db.prepare(`UPDATE production_inputs SET production_sync_id = (SELECT sync_id FROM production WHERE id = production_inputs.production_id) WHERE production_sync_id IS NULL`).run();
  db.prepare(`UPDATE production_outputs SET production_sync_id = (SELECT sync_id FROM production WHERE id = production_outputs.production_id) WHERE production_sync_id IS NULL`).run();

  // Add parent sync_id to item tables for cross-device DELETE/UPDATE operations
  addCol('siv_items',   'siv_sync_id',   'TEXT');
  addCol('grn_items',   'grn_sync_id',   'TEXT');
  addCol('order_items', 'order_sync_id', 'TEXT');
  db.prepare(`UPDATE siv_items   SET siv_sync_id   = (SELECT sync_id FROM siv    WHERE id = siv_items.siv_id)     WHERE siv_sync_id   IS NULL`).run();
  db.prepare(`UPDATE grn_items   SET grn_sync_id   = (SELECT sync_id FROM grn    WHERE id = grn_items.grn_id)     WHERE grn_sync_id   IS NULL`).run();
  db.prepare(`UPDATE order_items SET order_sync_id = (SELECT sync_id FROM orders WHERE id = order_items.order_id) WHERE order_sync_id IS NULL`).run();
  addCol('sales_return_items', 'return_sync_id', 'TEXT');
  db.prepare(`UPDATE sales_return_items SET return_sync_id = (SELECT sync_id FROM sales_returns WHERE id = sales_return_items.return_id) WHERE return_sync_id IS NULL`).run();

  // Add product_sync_id to daily_actual_balance + unique index for cross-device conflict resolution
  addCol('daily_actual_balance', 'product_sync_id', 'TEXT');
  db.prepare(`UPDATE daily_actual_balance SET product_sync_id = (SELECT sync_id FROM products WHERE id = daily_actual_balance.product_id) WHERE product_sync_id IS NULL`).run();
  // Add cashier_id to cash_reports (0 = All/combined, user_id = specific cashier)
  addCol('cash_reports', 'cashier_id', 'INTEGER DEFAULT 0');
  // Bank payment bucket (split from the legacy single "cash" column).
  addCol('cash_reports', 'bank', 'REAL NOT NULL DEFAULT 0');
  // Add cashier_id to payment_vouchers so expenses link to the correct cashier's report
  addCol('payment_vouchers', 'cashier_id', 'INTEGER DEFAULT 0');
  // Link SIV back to production entry when auto-created from production
  addCol('siv', 'production_id',      'INTEGER');
  addCol('siv', 'production_sync_id', 'TEXT');
  // Main category support — categories can be grouped under a main category (e.g., Whisky, Wine, Beer)
  addCol('categories', 'main_category_id',      'INTEGER');
  addCol('categories', 'main_category_sync_id', 'TEXT');
  // Per-product preferred unit (auto-selected on GRN/SIV/POS instead of always defaulting to base).
  addCol('products',   'default_unit',          'TEXT');
  // Daily profit summary — new columns introduced over time.
  // stock_adj: legacy column (no longer written but kept for schema parity with VPS migrations).
  // damages:   subtracted from gross profit when Sales Damages are recorded.
  addCol('daily_profit_summary', 'stock_adj', 'REAL NOT NULL DEFAULT 0');
  addCol('daily_profit_summary', 'damages',   'REAL NOT NULL DEFAULT 0');

  // Migrate cash_reports: replace UNIQUE(date) with UNIQUE(date, cashier_id)
  const crIdxList = db.prepare("PRAGMA index_list('cash_reports')").all();
  const hasDateOnlyUnique = crIdxList.some(idx => {
    if (!idx.unique) return false;
    const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all();
    return cols.length === 1 && cols[0].name === 'date';
  });
  if (hasDateOnlyUnique) {
    db.exec(`
      CREATE TABLE cash_reports_migrated (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        date           TEXT NOT NULL,
        initial_change REAL DEFAULT 0,
        mobile_money   REAL DEFAULT 0,
        cash           REAL DEFAULT 0,
        expenses       REAL DEFAULT 0,
        pending        REAL DEFAULT 0,
        total          REAL DEFAULT 0,
        after_change   REAL DEFAULT 0,
        expected       REAL DEFAULT 0,
        difference     REAL DEFAULT 0,
        status         TEXT,
        comment        TEXT,
        created_by     INTEGER REFERENCES users(id),
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
        sync_id        TEXT,
        tenant_id      TEXT,
        branch_id      TEXT,
        device_id      TEXT,
        deleted_at     TEXT,
        synced         INTEGER NOT NULL DEFAULT 0,
        cashier_id     INTEGER DEFAULT 0
      );
      INSERT INTO cash_reports_migrated
        SELECT id, date, initial_change, mobile_money, cash, expenses, pending, total,
               after_change, expected, difference, status, comment, created_by,
               created_at, updated_at, sync_id, tenant_id, branch_id, device_id,
               deleted_at, COALESCE(synced, 0), COALESCE(cashier_id, 0)
        FROM cash_reports;
      DROP TABLE cash_reports;
      ALTER TABLE cash_reports_migrated RENAME TO cash_reports;
    `);
  }
  db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_reports_date_cashier ON cash_reports(date, cashier_id)`).run();

  // Stock Count tables
  db.prepare(`CREATE TABLE IF NOT EXISTS stock_count_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'Active',
    created_by INTEGER REFERENCES users(id),
    tenant_id  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS stock_count_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES stock_count_sessions(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity   REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS quick_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id       TEXT,
    product_sync_id TEXT NOT NULL,
    position        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(tenant_id, product_sync_id)
  )`).run();
  // Cash transfers — bucket-to-bucket money moves (Cash / Bank / Mobile Money).
  db.prepare(`CREATE TABLE IF NOT EXISTS cash_transfers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    transfer_number TEXT NOT NULL,
    date            TEXT NOT NULL,
    from_method     TEXT NOT NULL,
    to_method       TEXT NOT NULL,
    amount          REAL NOT NULL DEFAULT 0,
    description     TEXT,
    created_by      INTEGER REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();

  // ── Parity tables (also in initTenantDb) ───────────────────────────────────
  // These were added to per-tenant DBs via initTenantDb but never backported to
  // server.js, so a fresh Electron install on a clean machine would crash 500
  // when hitting the related pages. Same schema as migrations.js — kept here for
  // local Electron parity. If the schemas drift, treat migrations.js as authoritative.
  db.prepare(`CREATE TABLE IF NOT EXISTS stock_reconciliations (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    count_date   TEXT NOT NULL,
    location     TEXT NOT NULL DEFAULT 'sales',
    notes        TEXT,
    created_by   INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS stock_reconciliation_items (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    reconciliation_id      INTEGER NOT NULL,
    reconciliation_sync_id TEXT,
    product_id             INTEGER NOT NULL,
    product_sync_id        TEXT,
    system_qty             REAL NOT NULL DEFAULT 0,
    physical_qty           REAL NOT NULL DEFAULT 0,
    unit                   TEXT,
    variance_base          REAL NOT NULL DEFAULT 0,
    cost_at_count          REAL NOT NULL DEFAULT 0,
    reason                 TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS customer_payments (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id      INTEGER,
    customer_sync_id TEXT,
    amount           REAL NOT NULL DEFAULT 0,
    payment_date     TEXT NOT NULL,
    payment_method   TEXT DEFAULT 'Cash',
    reference        TEXT,
    notes            TEXT,
    created_by       INTEGER,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS empty_returns (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    return_number TEXT NOT NULL,
    date          TEXT NOT NULL,
    supplier_id   INTEGER REFERENCES suppliers(id),
    total_items   INTEGER DEFAULT 0,
    total_amount  REAL DEFAULT 0,
    notes         TEXT,
    created_by    INTEGER REFERENCES users(id),
    status        TEXT DEFAULT 'Completed',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS empty_return_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    empty_return_id INTEGER NOT NULL REFERENCES empty_returns(id),
    product_id      INTEGER REFERENCES products(id),
    quantity        REAL NOT NULL,
    deposit         REAL NOT NULL DEFAULT 0,
    total_price     REAL NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();
  // Discount approval requests — see migrations.js for the canonical schema.
  // Sync columns are baked in here (this CREATE runs AFTER the allTables loop,
  // so we can't rely on addCol to retro-add them; tenant DBs handle this via
  // migrations.js).
  db.prepare(`CREATE TABLE IF NOT EXISTS discount_requests (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    requested_by      INTEGER NOT NULL REFERENCES users(id),
    requester_name    TEXT NOT NULL,
    target            TEXT NOT NULL,
    product_name      TEXT,
    product_sync_id   TEXT,
    unit              TEXT,
    quantity          REAL NOT NULL DEFAULT 0,
    unit_price        REAL NOT NULL DEFAULT 0,
    subtotal          REAL NOT NULL DEFAULT 0,
    discount_amount   REAL NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending',
    approver_id       INTEGER REFERENCES users(id),
    approver_name     TEXT,
    approved_at       TEXT,
    rejection_reason  TEXT,
    sync_id           TEXT,
    tenant_id         TEXT,
    branch_id         TEXT,
    device_id         TEXT,
    deleted_at        TEXT,
    synced            INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  )`).run();

  try { db.prepare(`DROP INDEX IF EXISTS idx_dab_product_sync_date`).run(); } catch (_) {}
  try { db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dab_product_sync_date ON daily_actual_balance (product_sync_id, date)`).run(); } catch (e) { slog('idx_dab_psync_date: ' + e.message); }

  // Backfill sync_id + tenant_id + branch_id + device_id for records created before sync was set up
  // Uses SQLite randomblob(16) for UUID generation — runs once per row, skips already-filled rows
  for (const t of allTables) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      if (cols.includes('sync_id')) {
        db.prepare(`UPDATE ${t} SET sync_id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))) WHERE sync_id IS NULL`).run();
      }
      if (cols.includes('tenant_id')) {
        db.prepare(`UPDATE ${t} SET tenant_id = (SELECT value FROM sync_config WHERE key = 'tenant_id') WHERE tenant_id IS NULL`).run();
      }
      if (cols.includes('branch_id')) {
        db.prepare(`UPDATE ${t} SET branch_id = (SELECT value FROM sync_config WHERE key = 'branch_id') WHERE branch_id IS NULL`).run();
      }
      if (cols.includes('device_id')) {
        db.prepare(`UPDATE ${t} SET device_id = (SELECT value FROM sync_config WHERE key = 'device_id') WHERE device_id IS NULL`).run();
      }
    } catch (_) {}
  }
})();

// ─── Sync: initialise device_id ──────────────────────────────────────────────
syncConfig.init(db);

// ─── Sync: start background sync service ─────────────────────────────────────
const syncService = require('./services/syncService');
syncService.start(db, syncConfig);

console.log('Database schema ready');

// ─── Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/zra',  require('./routes/zra'));
app.use('/api/products', require('./routes/products'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/main-categories', require('./routes/mainCategories'));
app.use('/api/units', require('./routes/units'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/grn', require('./routes/grn'));
app.use('/api/empty-returns', require('./routes/emptyReturns'));
// v1.13.67 — customer-side bearer voucher for empty containers.
app.use('/api/empty-vouchers', require('./routes/emptyVouchers'));
app.use('/api/credit-notes', require('./routes/supplierCreditNotes'));
app.use('/api/capital-account',  require('./routes/capitalAccount'));
app.use('/api/dividend-account', require('./routes/dividendAccount'));
app.use('/api/shareholders',     require('./routes/shareholders'));
app.use('/api/loans',            require('./routes/loans'));
app.use('/api/siv', require('./routes/siv'));
app.use('/api/cash-receipts', require('./routes/cashReceipts'));
app.use('/api/payment-vouchers', require('./routes/paymentVouchers'));
app.use('/api/pv-types',         require('./routes/pvTypes'));
app.use('/api/cash-book', require('./routes/cashBook'));
app.use('/api/account-payables', require('./routes/accountPayables'));
app.use('/api/suppliers', require('./routes/suppliers'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/users', require('./routes/users'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/cash-reports', require('./routes/cashReport'));
app.use('/api/currency-exchanges', require('./routes/currencyExchanges'));
app.use('/api/stock-adjustments', require('./routes/stockAdjustments'));
app.use('/api/stock-reconciliation', require('./routes/stockReconciliation'));
app.use('/api/customer-payments', require('./routes/customerPayments'));
// Production module removed for Kelete system.
// app.use('/api/production', require('./routes/production'));
app.use('/api/sales-returns', require('./routes/salesReturns'));
app.use('/api/stock-count', require('./routes/stockCount'));
app.use('/api/ap-payments', require('./routes/apPayments'));
app.use('/api/attachments', require('./routes/attachments'));
app.use('/api/discount-requests', require('./routes/discountRequests'));
app.use('/api/sync', require('./routes/sync'));
app.use('/api/updates', require('./routes/updates'));
app.use('/api/fx-rates', require('./routes/fxRates'));
// v1.8.33 — branch Electron needs these two: Inter-Branch Transfers
// (sidebar + page) and sidebar notification badges. Without them
// Electron 404s on every sidebar load + the Transfers menu item.
// HQ-only routes (tenant-admin, hq/suppliers, hq/products, hq/damages,
// hq/grns) intentionally not mounted — Electron is a branch device, not HQ.
//
// 2026-08-28 — but THREE of them are branch-facing despite living under the
// /api/hq prefix, and leaving them off made the Incoming Stock page 404 on
// every till: it showed an empty queue with no error, while the same account
// on the web showed a pending PO and a full history. Harmless-looking, and
// it cost a long hunt through the sync layer before the missing mount turned
// out to be the cause.
//   /api/hq                  -> /hq/branches, the branch list the transfer
//                               and receipt screens read.
//   /api/hq/purchases        -> /incoming (this branch's own queue) and
//                               /items/:id/branch-reject.
//   /api/branch/po-receipts  -> the branch confirming what physically
//                               arrived. HQ still generates the GRN.
// Mounted in the same order as server-tenant.js.
app.use('/api/hq',                 require('./routes/hq'));
app.use('/api/hq/purchases',       require('./routes/hqPurchases'));
app.use('/api/branch/po-receipts', require('./routes/branchReceipts'));
app.use('/api/transfers',     require('./routes/transfers'));
app.use('/api/cash-deposits', require('./routes/cashDeposits'));
app.use('/api/notifications', require('./routes/notifications'));
// 2026-09-18 — search the note written on any document, whatever that
// document happens to call the box. See services/noteSources.js.
app.use('/api/search',        require('./routes/search'));
app.use('/api/system',        require('./routes/system'));
app.use('/admin', require('./routes/admin'));
// Called by the master admin panel at sidanitsolutions.com/admin.
// Lives on server-tenant.js too, mirrored here for the single-tenant
// VPS deploy where only server.js runs.
app.use('/api/tenant-admin', require('./routes/tenantAdmin'));

// --- Kelete fuel-station modules ---
app.use('/api/fuel-grades',       require('./routes/fuelGrades'));
app.use('/api/tank-groups',       require('./routes/tankGroups'));
app.use('/api/tanks',             require('./routes/tanks'));
app.use('/api/pumps',             require('./routes/pumps'));
app.use('/api/fleet-customers',   require('./routes/fleetCustomers'));
app.use('/api/fuel-deliveries',   require('./routes/fuelDeliveries'));
app.use('/api/attendant-shifts',  require('./routes/attendantShifts'));
app.use('/api/fuel-sales',        require('./routes/fuelSales'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

// Serve React frontend (Electron mode only — web mode uses Nginx)
// Try multiple paths in case env var isn't set
const _frontendBuild = process.env.ELECTRON_FRONTEND_BUILD
  || (process.resourcesPath ? path.join(process.resourcesPath, 'frontend', 'build') : null)
  || (process.env.ELECTRON_USER_DATA ? path.join(__dirname, '../frontend/build') : null);

if (_frontendBuild && require('fs').existsSync(_frontendBuild)) {
  app.use(express.static(_frontendBuild));
  app.get('*', (req, res) => res.sendFile(path.join(_frontendBuild, 'index.html')));
}

// Global error handler — prevents crashes on PayloadTooLarge and other Express errors
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large' });
  }
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 5300;
app.listen(PORT, () => {
  console.log(`Kelete server running on port ${PORT}`);
});

// 2026-08-28 — background ZRA retry, on the till itself.
//
// Sales are rung here, so this machine owns getting them signed. It used
// to have no automatic retry at all: a sale that failed (VSDC unreachable
// because the till was offline) sat until someone noticed and clicked
// Retry, and meanwhile the VPS — the only place this worker ran — picked
// up the synced copy and sent it too. Two machines, one sale, and ZRA
// answering 924 "invoice number already exists" to the second one.
//
// graceMs 0: this is the owner, it acts on its own orders at once. The
// VPS runs the same worker with a 30-minute grace as a safety net.
try {
  require('./services/zraRetryQueue').start({ graceMs: 0 });
} catch (e) {
  console.warn('[zra-retry] failed to arm queue:', e.message);
}

// v1.13.123 — Electron in-app daily SQLite backup (ZRA Ref 11 Electron-side).
// Silent no-op on VPS (guarded by ELECTRON_USER_DATA env var). Snapshots
// kelete.db + master.db + any tenants/*.db to %APPDATA%/Kelete/Backups/
// once ~30s after boot, then every 24h. Keeps last 14 days.
try {
  require('./services/electronBackup').start();
} catch (e) {
  console.warn('[electronBackup] failed to start:', e.message);
}

// ─── Backfill daily_profit_summary for all tenant DBs ────────────────────────
const { recalculateDailyProfit } = require('./config/profitHelper');
const { getTenantDb, TENANTS_DIR } = require('./config/tenantDb');
function backfillDailyProfit() {
  try {
    if (!fs.existsSync(TENANTS_DIR)) return;
    const slugs = fs.readdirSync(TENANTS_DIR)
      .filter(f => f.endsWith('.db'))
      .map(f => f.replace('.db', ''));
    if (slugs.length === 0) return;
    console.log(`[profit backfill] Found ${slugs.length} tenant(s): ${slugs.join(', ')}`);
    for (const slug of slugs) {
      try {
        const tenantDb = getTenantDb(slug);
        const rows = tenantDb.prepare(`
          SELECT DISTINCT dab.date, p.tenant_id
          FROM daily_actual_balance dab
          JOIN products p ON p.sync_id = dab.product_sync_id
          WHERE dab.deleted_at IS NULL AND p.tenant_id IS NOT NULL
          ORDER BY dab.date ASC
        `).all();
        if (rows.length === 0) { console.log(`[profit backfill] ${slug}: no actual balance data`); continue; }
        console.log(`[profit backfill] ${slug}: processing ${rows.length} date/tenant pairs...`);
        for (const row of rows) {
          recalculateDailyProfit(tenantDb, row.date, row.tenant_id);
        }
        console.log(`[profit backfill] ${slug}: done.`);
      } catch (e) {
        console.error(`[profit backfill] ${slug} failed:`, e.message);
      }
    }
  } catch (e) {
    console.error('[profit backfill] Failed:', e.message);
  }
}
backfillDailyProfit();

// ─── Nightly cleanup: remove already-deleted reconciliation movements ────────
function cleanStaleReconciliations() {
  try {
    const result = db.prepare(
      `DELETE FROM stock_movements WHERE movement_type = 'reconciliation' AND deleted_at IS NOT NULL`
    ).run();
    if (result.changes > 0) console.log(`[cleanup] Removed ${result.changes} stale reconciliation(s)`);
  } catch (e) {
    console.error('[cleanup] Failed:', e.message);
  }
}
cleanStaleReconciliations(); // run once on startup
setInterval(cleanStaleReconciliations, 24 * 60 * 60 * 1000); // then every 24 hours
