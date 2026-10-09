/**
 * initTenantDb(db)
 * Runs on a fresh tenant SQLite database to create all tables and add sync columns.
 * Safe to run on existing DBs (all statements use IF NOT EXISTS / column checks).
 */
const bcrypt = require('bcrypt');
const crypto = require('crypto');

function initTenantDb(db) {
  // ── Core tables ────────────────────────────────────────────────────────────
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

    CREATE TABLE IF NOT EXISTS products (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      code                TEXT,
      name                TEXT NOT NULL,
      category_id         INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      unit                TEXT NOT NULL DEFAULT 'pcs',
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
      product_type        TEXT NOT NULL DEFAULT 'finished',
      alt_unit            TEXT,
      conversion_factor   REAL,
      alt_price           REAL,
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

    -- cash_reports is keyed on (date, cashier_id) so each cashier can save
    -- their own daily report for the same date. The composite uniqueness
    -- is enforced by an index further down (and back-migrated for tenant
    -- DBs that pre-date this change — see the cash_reports rewrite block
    -- after the CREATE TABLE pass).
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

    CREATE TABLE IF NOT EXISTS sync_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS daily_profit_summary (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      date            TEXT NOT NULL,
      tenant_id       TEXT NOT NULL,
      revenue         REAL NOT NULL DEFAULT 0,
      cogs            REAL NOT NULL DEFAULT 0,
      diff_value      REAL NOT NULL DEFAULT 0,
      cash_difference REAL NOT NULL DEFAULT 0,
      pv_total        REAL NOT NULL DEFAULT 0,
      stock_adj       REAL NOT NULL DEFAULT 0,
      gross_profit    REAL NOT NULL DEFAULT 0,
      net_profit      REAL NOT NULL DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(date, tenant_id)
    );

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

    CREATE TABLE IF NOT EXISTS daily_cost_snapshot (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id       INTEGER REFERENCES products(id),
      product_sync_id  TEXT,
      date             TEXT NOT NULL,
      avg_cost_price   REAL NOT NULL DEFAULT 0,
      selling_price    REAL NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      sync_id          TEXT,
      tenant_id        TEXT,
      branch_id        TEXT,
      device_id        TEXT,
      synced           INTEGER NOT NULL DEFAULT 0,
      deleted_at       TEXT
    );

    -- Stock Reconciliation (discrete physical count events; ≠ initial Stock Count sessions)
    CREATE TABLE IF NOT EXISTS stock_reconciliations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      count_date   TEXT NOT NULL,
      location     TEXT NOT NULL DEFAULT 'sales',
      notes        TEXT,
      created_by   INTEGER,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Customer Payments (Accounts Receivable) — after-sale payments from credit customers
    CREATE TABLE IF NOT EXISTS customer_payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id     INTEGER,
      customer_sync_id TEXT,
      amount          REAL NOT NULL DEFAULT 0,
      payment_date    TEXT NOT NULL,
      payment_method  TEXT DEFAULT 'Cash',
      reference       TEXT,
      notes           TEXT,
      created_by      INTEGER,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_reconciliation_items (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      reconciliation_id     INTEGER NOT NULL,
      reconciliation_sync_id TEXT,
      product_id            INTEGER NOT NULL,
      product_sync_id       TEXT,
      system_qty            REAL NOT NULL DEFAULT 0,
      physical_qty          REAL NOT NULL DEFAULT 0,
      unit                  TEXT,
      variance_base         REAL NOT NULL DEFAULT 0,
      cost_at_count         REAL NOT NULL DEFAULT 0,
      reason                TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Tables that may not exist in older tenant DBs — create them here so the
  // sync-column loop below doesn't crash on first run.
  db.exec(`
    -- ── Main categories + units ─────────────────────────────────────────────
    -- These were originally only created by server.js into the default DB.
    -- Per-tenant DBs need them too — products/items routes JOIN against these
    -- tables and crash with SQLITE_ERROR ("no such table") if missing.
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

    -- ── Empty Returns ───────────────────────────────────────────────────────
    -- Stand-alone document for sending empty crates / bottles back to the supplier
    -- and receiving a deposit credit. Distinct from GRN because there are no goods
    -- being received — only containers leaving the yard and an AP credit landing.
    CREATE TABLE IF NOT EXISTS empty_returns (
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
    );

    CREATE TABLE IF NOT EXISTS empty_return_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      empty_return_id INTEGER NOT NULL REFERENCES empty_returns(id),
      product_id  INTEGER REFERENCES products(id),
      quantity    REAL NOT NULL,
      deposit     REAL NOT NULL DEFAULT 0,
      total_price REAL NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Stock count + Quick items ───────────────────────────────────────────
    -- Same fix as main_categories/units: these were only defined in server.js
    -- (default DB), so per-tenant DBs lacked them and any feature using them 500-ed.
    CREATE TABLE IF NOT EXISTS stock_count_sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'Active',
      created_by INTEGER REFERENCES users(id),
      tenant_id  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS stock_count_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES stock_count_sessions(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity   REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS quick_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       TEXT,
      product_sync_id TEXT NOT NULL,
      position        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, product_sync_id)
    );

    -- ── Cash transfers ──────────────────────────────────────────────────────
    -- Moves money between cash buckets (Cash <-> Bank <-> Mobile Money).
    -- Doesn't affect the company's TOTAL cash balance — only redistributes
    -- between methods. Lives in its own table so it doesn't pollute CR / PV.
    CREATE TABLE IF NOT EXISTS cash_transfers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      transfer_number TEXT NOT NULL,
      date            TEXT NOT NULL,
      from_method     TEXT NOT NULL,  -- 'Cash' | 'Bank' | 'Mobile Money'
      to_method       TEXT NOT NULL,
      amount          REAL NOT NULL DEFAULT 0,
      description     TEXT,
      created_by      INTEGER REFERENCES users(id),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Supplier Credit Notes ───────────────────────────────────────────────
    -- Documents a credit the supplier owes you. Two real-world sources:
    --   Discount / Other  -> real income event, counted in Profit Report as
    --                        "Supplier Rebates" (positive line under gross)
    --   Crate Return / Bottle Return -> deposit refund, NOT income; profit
    --                        report ignores these (they only move AP balance
    --                        + stock of the empty product)
    -- Replaces the old GRN "containers_returned" deduction and is the storage
    -- backing the Empty Returns page (Phase 4A).
    CREATE TABLE IF NOT EXISTS supplier_credit_notes (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_note_number TEXT NOT NULL,
      date               TEXT NOT NULL,
      supplier_id        INTEGER REFERENCES suppliers(id),
      reason             TEXT NOT NULL DEFAULT 'Discount',  -- 'Discount' | 'Crate Return' | 'Bottle Return' | 'Other'
      reference          TEXT,                              -- free text: GRN # / driver name / etc.
      amount             REAL NOT NULL DEFAULT 0,           -- always positive
      notes              TEXT,
      created_by         INTEGER REFERENCES users(id),
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS supplier_credit_note_items (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_note_id          INTEGER NOT NULL REFERENCES supplier_credit_notes(id),
      product_id              INTEGER REFERENCES products(id),
      quantity                REAL NOT NULL DEFAULT 0,
      unit_value              REAL NOT NULL DEFAULT 0,     -- deposit per unit
      total_price             REAL NOT NULL DEFAULT 0,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Capital Account ────────────────────────────────────────────────────
    -- Owner equity ledger. Two flows in one table:
    --   Injection : owner puts money INTO the business (cash inflow, +equity)
    --   Drawing   : owner takes money OUT of the business (cash outflow, -equity)
    -- These hit the Cash Book like any CR/PV, but are excluded from the Profit
    -- Report because they're equity, not P&L.
    CREATE TABLE IF NOT EXISTS capital_account (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_number        TEXT NOT NULL,
      date                TEXT NOT NULL,
      type                TEXT NOT NULL DEFAULT 'Injection',  -- 'Injection' | 'Drawing'
      owner_name          TEXT,
      amount              REAL NOT NULL DEFAULT 0,            -- always positive
      cash_amount         REAL NOT NULL DEFAULT 0,
      bank_amount         REAL NOT NULL DEFAULT 0,
      momo_amount         REAL NOT NULL DEFAULT 0,
      description         TEXT,
      invoice_attachment  TEXT,
      created_by          INTEGER REFERENCES users(id),
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Dividend Account ───────────────────────────────────────────────────
    -- Profit distribution to the owner(s). Always an outflow. Excluded from
    -- the Profit Report — dividends are paid out of retained earnings, not
    -- treated as an operating expense.
    CREATE TABLE IF NOT EXISTS dividend_account (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_number        TEXT NOT NULL,
      date                TEXT NOT NULL,
      recipient           TEXT,
      amount              REAL NOT NULL DEFAULT 0,            -- always positive
      cash_amount         REAL NOT NULL DEFAULT 0,
      bank_amount         REAL NOT NULL DEFAULT 0,
      momo_amount         REAL NOT NULL DEFAULT 0,
      description         TEXT,
      invoice_attachment  TEXT,
      created_by          INTEGER REFERENCES users(id),
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Shareholders ───────────────────────────────────────────────────────
    -- Master list of people/entities holding equity in the business. Used as
    -- the source for the dropdown on Capital and Dividend entries so the
    -- system can answer per-shareholder questions: "How much has Sirak
    -- invested?" / "How much dividend has Nahom received?"
    CREATE TABLE IF NOT EXISTS shareholders (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      email             TEXT,
      phone             TEXT,
      share_percentage  REAL NOT NULL DEFAULT 0,   -- optional, for reporting
      notes             TEXT,
      created_by        INTEGER REFERENCES users(id),
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Loans ──────────────────────────────────────────────────────────────
    -- The loan AGREEMENT itself — one row per active or paid-off loan.
    -- Outstanding balance is derived from loan_transactions, not stored, so
    -- it can never drift out of sync with the underlying transactions.
    CREATE TABLE IF NOT EXISTS loans (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      loan_number       TEXT NOT NULL,
      lender_name       TEXT,
      principal_amount  REAL NOT NULL DEFAULT 0,
      interest_rate     REAL NOT NULL DEFAULT 0,   -- annual % — informational
      start_date        TEXT,
      maturity_date     TEXT,
      status            TEXT NOT NULL DEFAULT 'Active', -- 'Active' | 'Paid Off' | 'Defaulted'
      notes             TEXT,
      invoice_attachment TEXT,
      created_by        INTEGER REFERENCES users(id),
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Discount Requests ──────────────────────────────────────────────────
    -- Async approval workflow for cashier discounts. When a non-admin enters
    -- a discount on the POS, a pending row is created here; an Administrator
    -- approves or rejects from the Approvals page; the cashier's POS polls
    -- this row by sync_id and applies the discount when status flips to
    -- 'approved'. Admins skip this flow entirely (handled client-side).
    --
    -- target='line' → product_*, unit, quantity, unit_price populated;
    --                  discount_amount is the per-unit Kwacha off.
    -- target='cart' → only subtotal populated; discount_amount is a flat
    --                  Kwacha off the whole sale.
    CREATE TABLE IF NOT EXISTS discount_requests (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      requested_by      INTEGER NOT NULL REFERENCES users(id),
      requester_name    TEXT NOT NULL,
      target            TEXT NOT NULL,                 -- 'line' | 'cart'
      product_name      TEXT,
      product_sync_id   TEXT,
      unit              TEXT,
      quantity          REAL NOT NULL DEFAULT 0,
      unit_price        REAL NOT NULL DEFAULT 0,
      subtotal          REAL NOT NULL DEFAULT 0,
      discount_amount   REAL NOT NULL DEFAULT 0,
      -- v1.8.98 — Change Price feature. When set, this is the new final
      -- unit price the cashier wants to apply (replaces unit_price on approval).
      -- discount_amount is auto-computed as (unit_price - new_price) * quantity
      -- for back-compat with reports — can be negative for surcharges.
      -- change_reason captures the cashier's text (required, min 3 chars).
      new_price         REAL,
      change_reason     TEXT,
      status            TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
      approver_id       INTEGER REFERENCES users(id),
      approver_name     TEXT,
      approved_at       TEXT,
      rejection_reason  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- v1.8.87 — Order Payment Edits audit log.
    -- Admin-only post-payment corrections (typos, wrong currency, wrong rate)
    -- write a row here. old_payload / new_payload are JSON snapshots of the
    -- 12 mutable payment fields on the order so we can replay any sequence.
    -- 7-day window enforced at the route layer, not the schema.
    CREATE TABLE IF NOT EXISTS order_payment_edits (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id           INTEGER NOT NULL,
      order_sync_id      TEXT,
      edited_by          INTEGER REFERENCES users(id),
      edited_by_name     TEXT,
      edited_at          TEXT NOT NULL DEFAULT (datetime('now')),
      reason             TEXT NOT NULL,
      old_payload        TEXT NOT NULL,    -- JSON
      new_payload        TEXT NOT NULL,    -- JSON
      sync_id            TEXT UNIQUE,
      tenant_id          INTEGER,
      branch_id          TEXT,
      device_id          TEXT,
      synced             INTEGER DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ── Loan Transactions ──────────────────────────────────────────────────
    -- Every cash movement against a loan, of three kinds:
    --   'Disbursement' → lender pays us; cash IN; not income; +outstanding
    --   'Principal'    → we pay lender; cash OUT; not expense; -outstanding
    --   'Interest'     → we pay lender; cash OUT; IS expense; no balance effect
    CREATE TABLE IF NOT EXISTS loan_transactions (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      transaction_number TEXT NOT NULL,
      loan_id            INTEGER NOT NULL REFERENCES loans(id),
      date               TEXT NOT NULL,
      type               TEXT NOT NULL,            -- 'Disbursement' | 'Principal' | 'Interest'
      amount             REAL NOT NULL DEFAULT 0,
      cash_amount        REAL NOT NULL DEFAULT 0,
      bank_amount        REAL NOT NULL DEFAULT 0,
      momo_amount        REAL NOT NULL DEFAULT 0,
      description        TEXT,
      invoice_attachment TEXT,
      created_by         INTEGER REFERENCES users(id),
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // ── Add sync columns to all tables ────────────────────────────────────────
  function addCol(table, col, def) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    // 2026-08-31 — a table that does not exist yet is skipped, not fatal.
    //
    // PRAGMA table_info on a missing table returns [] rather than throwing, so
    // this fell straight through to an ALTER that failed with "no such table".
    // On an existing branch every table is already there and nothing showed;
    // on a BRAND-NEW tenant the database is empty and whichever addCol sits
    // above its CREATE kills the whole build — which is what half-created
    // Mandevu and Chawama, leaving them listed with no tenant id.
    //
    // Skipping is safe because migrations run on every boot: a column whose
    // table is created later in this file lands on the next start. The real
    // fix is still to place the call after the CREATE; this only stops one
    // mis-ordered line from taking tenant registration down with it.
    if (cols.length === 0) return;
    if (!cols.find(c => c.name === col)) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run();
    }
  }

  const allTables = [
    'users', 'categories', 'products', 'customers', 'suppliers',
    'orders', 'order_items', 'grn', 'grn_items', 'siv', 'siv_items',
    'stock_movements', 'cash_receipts', 'payment_vouchers', 'cash_book',
    'business_settings', 'cash_reports', 'stock_adjustments', 'daily_actual_balance',
    'production', 'production_inputs', 'production_outputs',
    'sales_returns', 'sales_return_items', 'ap_payments',
    'daily_cost_snapshot', 'daily_profit_summary',
    'stock_reconciliations', 'stock_reconciliation_items',
    'customer_payments', 'pv_types',
    'empty_returns', 'empty_return_items',
    // v1.1.2 added these tables but missed adding them here — routes querying
    // them with WHERE tenant_id = ? threw "no such column: tenant_id" → 500.
    'main_categories', 'units', 'stock_count_sessions', 'stock_count_items', 'quick_items',
    'cash_transfers',
    'supplier_credit_notes', 'supplier_credit_note_items',
    'capital_account', 'dividend_account',
    'shareholders', 'loans', 'loan_transactions',
    'discount_requests',
  ];

  const hasUpdatedAt = new Set([
    'users', 'products', 'customers', 'suppliers', 'business_settings', 'cash_reports',
    'daily_profit_summary',
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

  // v1.8.98 — Change Price feature on existing DBs.
  addCol('discount_requests',  'new_price',         'REAL');
  addCol('discount_requests',  'change_reason',     'TEXT');

  addCol('stock_movements',    'reference_sync_id', 'TEXT');
  addCol('stock_movements',    'product_sync_id',   'TEXT');
  // v1.13.49 — event-level cost lock. Stamp the WAC live at the moment of
  // the movement (sale, sale_reverse, sales_return, transit_writeoff) so
  // profitHelper's COGS/damages queries can read the exact cost that was
  // true at the moment of the event, not whatever the current WAC happens
  // to be at recalc time. NULL for rows written before this column existed
  // (backfill script handles them).
  addCol('stock_movements',    'cost_at_sale',      'REAL');
  // v1.13.49 — auto-stamp cost_at_sale on INSERT via SQL trigger so every
  // route that writes a cost-bearing movement (sale, sale_reverse,
  // sales_return, transit_writeoff) automatically freezes the live WAC
  // without changing any of the ~10 INSERT sites in orders.js /
  // salesReturns.js / hqDamages.js / hqGrns.js / hq.js. IF NEW.cost_at_sale
  // IS NOT NULL the caller can still override (backfill or explicit stamp).
  // Fallback chain matches profitHelper: p.avg_cost_price → p.cost_price → 0.
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS trg_stamp_cost_at_sale
      AFTER INSERT ON stock_movements
      FOR EACH ROW
      WHEN NEW.cost_at_sale IS NULL
        AND NEW.product_sync_id IS NOT NULL
        AND NEW.movement_type IN ('sale', 'sale_reverse', 'sales_return', 'transit_writeoff')
      BEGIN
        UPDATE stock_movements
           SET cost_at_sale = (
             SELECT COALESCE(NULLIF(p.avg_cost_price, 0), NULLIF(p.cost_price, 0), 0)
             FROM products p
             WHERE p.sync_id = NEW.product_sync_id
             LIMIT 1
           )
         WHERE id = NEW.id;
      END;
    `);
  } catch (_) { /* trigger may already exist */ }
  addCol('grn_items',          'product_sync_id',   'TEXT');
  addCol('grn_items',          'grn_sync_id',       'TEXT');
  addCol('siv_items',          'product_sync_id',   'TEXT');
  addCol('siv_items',          'siv_sync_id',       'TEXT');
  addCol('order_items',        'product_sync_id',   'TEXT');
  addCol('order_items',        'order_sync_id',     'TEXT');
  addCol('production_inputs',  'product_sync_id',   'TEXT');
  addCol('production_inputs',  'production_sync_id','TEXT');
  addCol('production_outputs', 'product_sync_id',   'TEXT');
  addCol('production_outputs', 'production_sync_id','TEXT');
  addCol('sales_return_items', 'product_sync_id',   'TEXT');
  addCol('sales_return_items', 'return_sync_id',    'TEXT');
  addCol('stock_adjustments',  'product_sync_id',   'TEXT');
  addCol('grn_items',          'expiry_date',        'TEXT');
  // Multi-unit: track which unit the line was received/issued in (NULL = base unit, backward compat)
  addCol('grn_items',          'unit',               'TEXT');
  addCol('order_items',        'unit',               'TEXT');
  // Partial reversal: track how much of this line has been reversed cumulatively.
  // When reversed_quantity reaches the full line quantity, `reversed` is set to 1.
  addCol('order_items',        'reversed_quantity',  'REAL NOT NULL DEFAULT 0');
  // Per-unit discount (Kwacha off the unit selling price). Line total stored
  // as: quantity * (unit_price - discount). Default 0 = no discount.
  addCol('order_items',        'discount',           'REAL NOT NULL DEFAULT 0');
  addCol('siv_items',          'unit',               'TEXT');
  addCol('sales_return_items', 'unit',               'TEXT');
  addCol('products',           'category_sync_id',  'TEXT');
  // Multi-unit support — alt_unit + conversion + alt_price (Kelete feature)
  addCol('products',           'alt_unit',          'TEXT');
  addCol('products',           'conversion_factor', 'REAL');
  addCol('products',           'alt_price',         'REAL');
  // Customer credit (Kelete feature) — limit on outstanding, payment terms, hold flag
  addCol('customers',          'credit_limit',         'REAL NOT NULL DEFAULT 0');
  // 2026-09-07 — balance carried over from whatever ran before this system.
  // Counted in the customer's outstanding alongside orders and payments, so
  // an account shows what is really owed without inventing a backdated sale.
  addCol('customers', 'opening_balance', 'REAL NOT NULL DEFAULT 0');
  addCol('customers',          'payment_terms_days',   'INTEGER NOT NULL DEFAULT 0');
  addCol('customers',          'credit_status',        "TEXT NOT NULL DEFAULT 'Active'");
  // v1.13.62 — empties deposit tracking.
  //   empty_balance is the running count of empty containers (EMPTY ZB
  //   crates + bottles) Kelete is holding on the customer's behalf. It
  //   is a physical count, NOT money — Sales Report and Cash Book stay
  //   untouched by it.
  //     + when the customer over-returns (Case 3) or does a pure return (Case 4)
  //     − when the customer under-returns and we draw against the credit
  //   Never goes negative: if credit is exhausted, the remaining shortfall
  //   is charged as EMPTY ZB line items on the sale invoice.
  //   Walk-ins (no customer record) can't accrue credit; over-returns
  //   become Kelete's gain, same as before.
  addCol('customers',          'empty_balance',        'INTEGER NOT NULL DEFAULT 0');
  // AR payments mint their own Cash Receipt voucher (standard accrual-to-cash entry).
  // The CR is linked back via this sync_id so edits/deletes cascade.
  addCol('customer_payments',  'cash_receipt_sync_id', 'TEXT');
  // Split payment-method amounts — a single AR/AP payment can be made with a
  // combination of Cash + Bank + Mobile Money. Total `amount` is the sum.
  // Legacy single-method rows get backfilled from the existing `payment_method` column.
  addCol('customer_payments',  'cash_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('customer_payments',  'bank_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('customer_payments',  'momo_amount', 'REAL NOT NULL DEFAULT 0');
  // v1.8.55 — triple-currency AR receipts (Kelete). cash_amount stays as
  // the dollar VALUE of the receipt (matches existing cash_receipts /
  // Cash Book aggregations). usd_amount is the physical USD portion;
  // fra_amount + k_amount are the foreign-currency portions; the
  // selling rates are snapshotted so historical receipts always reconcile.
  addCol('customer_payments',  'usd_amount',         'REAL NOT NULL DEFAULT 0');
  addCol('customer_payments',  'fra_amount',         'REAL NOT NULL DEFAULT 0');
  addCol('customer_payments',  'k_amount',           'REAL NOT NULL DEFAULT 0');
  addCol('customer_payments',  'selling_rate_used',  'REAL');
  addCol('customer_payments',  'selling_rate_k_used','REAL');
  addCol('ap_payments',        'cash_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('ap_payments',        'bank_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('ap_payments',        'momo_amount', 'REAL NOT NULL DEFAULT 0');
  // v1.13.23 — per-currency columns on ap_payments (Kelete forked from
  // Kelete v1.10.99, which was BEFORE Kelete added these). Cash Book
  // /stats and /ledger both sum these unconditionally; without them
  // the endpoints 500 with "no such column: usd_amount / k_amount".
  addCol('ap_payments',        'usd_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('ap_payments',        'fra_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('ap_payments',        'k_amount',   'REAL NOT NULL DEFAULT 0');
  // Same split on cash_receipts + payment_vouchers — needed for the Cash Book
  // to show current balance per method (Cash / Bank / Mobile Money).
  addCol('cash_receipts',      'cash_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('cash_receipts',      'bank_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('cash_receipts',      'momo_amount', 'REAL NOT NULL DEFAULT 0');
  // v1.8.31 — triple-currency receipts. Same pattern as payment_vouchers
  // (see v1.8.5). One CR = one currency. Legacy cash/bank/momo kept for
  // back-compat; reads should prefer usd/fra/k via CASE WHEN.
  addCol('cash_receipts',      'usd_amount',  'REAL NOT NULL DEFAULT 0');
  addCol('cash_receipts',      'fra_amount',  'REAL NOT NULL DEFAULT 0');
  addCol('cash_receipts',      'k_amount',    'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers',   'cash_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers',   'bank_amount', 'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers',   'momo_amount', 'REAL NOT NULL DEFAULT 0');
  // v1.8.5 — triple-currency payment vouchers. Each in its own currency
  // (USD in $, FRA in FRA, K in K). Legacy cash/bank/momo kept at 0.
  addCol('payment_vouchers',   'usd_amount',  'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers',   'fra_amount',  'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers',   'k_amount',    'REAL NOT NULL DEFAULT 0');

  // v1.8.6 — currency_exchanges. Append-only ledger; mistakes corrected by
  // a reverse entry, never deleted (so deleted_at column omitted on purpose).
  //   scope='drawer' → cashier's till exchange (shown on Cash Report)
  //   scope='book'   → cash book / accounting ledger exchange (Cash Book tab)
  db.prepare(`
    CREATE TABLE IF NOT EXISTS currency_exchanges (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id         TEXT UNIQUE,
      scope           TEXT NOT NULL CHECK (scope IN ('drawer','book')),
      date            TEXT NOT NULL,
      time            TEXT,
      from_currency   TEXT NOT NULL CHECK (from_currency IN ('USD','FRA','K')),
      from_amount     REAL NOT NULL,
      to_currency     TEXT NOT NULL CHECK (to_currency IN ('USD','FRA','K')),
      to_amount       REAL NOT NULL,
      rate            REAL,
      notes           TEXT,
      cashier_id      INTEGER REFERENCES users(id),
      created_by      INTEGER REFERENCES users(id),
      tenant_id       TEXT,
      branch_id       TEXT,
      device_id       TEXT,
      synced          INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_currency_exchanges_scope_date ON currency_exchanges(scope, date)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_currency_exchanges_cashier ON currency_exchanges(scope, date, cashier_id)`).run();
  // Invoice attachment — stored under uploads/invoices/. The column holds the
  // relative path (e.g. "invoices/grn_1700000000_abcd.pdf") so the same file
  // can be served from /uploads/<path> on any host.
  addCol('grn',                'invoice_attachment', 'TEXT');
  addCol('payment_vouchers',   'invoice_attachment', 'TEXT');
  // 2026-09-17 — who deleted a PV and why (HQ → All Depots → Delete).
  addCol('payment_vouchers',   'deleted_by',         'INTEGER');
  addCol('payment_vouchers',   'deleted_by_name',    'TEXT');
  addCol('payment_vouchers',   'delete_reason',      'TEXT');

  // 2026-09-18 — how much a depot may pay out in expenses in one day.
  // K5,000 everywhere to start; editable per depot in System Settings.
  // 0 or NULL = no limit. HQ is never limited (checked by host, not here).
  addCol('business_settings', 'daily_expense_limit', 'REAL NOT NULL DEFAULT 5000');

  // A voucher that would take the day over the limit is not saved. The depot
  // sends it here for HQ to approve; on approval the voucher can be saved
  // once, and the row becomes 'used'. Local to the depot's book — HQ reads
  // every depot's book the same way the All Depots PV list does.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pv_expense_requests (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        sync_id           TEXT NOT NULL UNIQUE,
        status            TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | used
        date              TEXT NOT NULL,
        paid_to           TEXT,
        description       TEXT,
        category          TEXT,
        paid_from         TEXT,
        amount            REAL NOT NULL DEFAULT 0,
        usd_amount        REAL NOT NULL DEFAULT 0,
        fra_amount        REAL NOT NULL DEFAULT 0,
        k_amount          REAL NOT NULL DEFAULT 0,
        cashier_id        INTEGER,
        invoice_attachment TEXT,
        day_total_before  REAL NOT NULL DEFAULT 0,
        daily_limit       REAL NOT NULL DEFAULT 0,
        reason            TEXT,
        requested_by      INTEGER,
        requester_name    TEXT,
        approver_name     TEXT,
        approved_at       TEXT,
        rejection_reason  TEXT,
        used_at           TEXT,
        used_voucher_id   INTEGER,
        tenant_id         TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        deleted_at        TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pv_expense_requests_status ON pv_expense_requests (status);
    `);
  } catch (e) {
    console.warn('[migrations] pv_expense_requests:', e.message);
  }

  // 2026-09-18 — which phones to wake. One row per device per user, in the
  // book that user belongs to: a depot's users live in that depot's database,
  // HQ's in HQ's own, so the tokens sit beside them. See services/push.js.
  //
  // Not synced anywhere — a token is about one physical handset talking to
  // Firebase, it means nothing on another machine, and it goes stale on its
  // own when the app is reinstalled.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_tokens (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        token         TEXT NOT NULL UNIQUE,
        user_id       INTEGER,
        branch_slug   TEXT,
        platform      TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens (user_id);
    `);
  } catch (e) {
    console.warn('[migrations] push_tokens:', e.message);
  }
  addCol('ap_payments',        'invoice_attachment', 'TEXT');

  // ─────────────────────────────────────────────────────────────────────────
  // v1.9.7 — HQ-PO-linked GRN flow.
  // ─────────────────────────────────────────────────────────────────────────
  // Kelete's procurement model: HQ creates the PO (keletezm.com/hq/purchases),
  // each line targets one branch. Branch sees the PO in their "Incoming"
  // queue and either rejects it OR clicks "Accept & Generate GRN" — which
  // opens a normal GRN form pre-filled with the PO number in notes. Branch
  // enters the invoice qty per line, attaches credit notes for any short/
  // damage/discount, and submits. The submitted GRN is NOT immediately
  // posted to stock — it waits for HQ to confirm. On HQ confirm, the
  // GRN's line items finally drive stock_movements at the branch (always
  // location='sales' for Kelete — no store layer) and HQ AP locks in.
  //
  // New columns on grn:
  //   linked_purchase_sync_id   — points at hq_purchases.sync_id when the
  //                               GRN was generated from a PO accept.
  //                               NULL for legacy / manual GRNs.
  //   linked_purchase_number    — denormalised PO# for display + receipt.
  //   hq_status                 — 'PENDING_HQ_CONFIRM' | 'CONFIRMED' |
  //                               'REJECTED' | NULL (legacy = no HQ gate)
  //   hq_confirmed_by/_name/_at — audit stamp for HQ confirmation.
  //   hq_reject_reason          — reason HQ sent the GRN back to branch.
  addCol('grn', 'linked_purchase_sync_id', 'TEXT');
  addCol('grn', 'linked_purchase_number',  'TEXT');
  addCol('grn', 'hq_status',               'TEXT');
  addCol('grn', 'hq_confirmed_by',         'INTEGER');
  addCol('grn', 'hq_confirmed_by_name',    'TEXT');
  addCol('grn', 'hq_confirmed_at',         'TEXT');
  addCol('grn', 'hq_reject_reason',        'TEXT');
  // v1.9.12 — supplier's printed invoice number captured at GRN time.
  // Mandatory on the branch-side GRN form so HQ sees what paper invoice
  // the purchase matched against when auditing AP.
  addCol('grn', 'supplier_invoice_number', 'TEXT');

  // v1.9.20 — supplier name copied from the HQ PO. Kelete branches no
  // longer maintain a supplier list (AP lives at HQ only), so the GRN
  // stores the supplier name as plain text rather than relying on a
  // local suppliers row. supplier_id may be NULL for HQ-linked GRNs.
  addCol('grn', 'supplier_name', 'TEXT');

  // v1.9.13 — GRN-scoped credit notes. supplier_credit_notes is the
  // existing master table; this new column ties each CN to the GRN it
  // belongs to so the GRN form can list / total CNs alongside line
  // items. NULL = standalone CN (legacy / not from a GRN).
  addCol('supplier_credit_notes', 'grn_sync_id', 'TEXT');

  // ── Single-location mode (Option 2: auto-SIV after each GRN) ────────────────
  // When ON, GRN saves trigger an auto-generated SIV that issues 100% of the receipt
  // to the sales counter, so a small one-room shop never has to do a manual SIV.
  // Default OFF — existing clients keep the dual-location flow.
  addCol('business_settings', 'single_location_mode', 'INTEGER NOT NULL DEFAULT 0');
  // Stock guard for POS: when 1, refuse to sell items with sales_balance<=0
  // and cap cart quantities at available stock. Default 0 — preserves the
  // long-standing behaviour of letting cashiers oversell when needed.
  addCol('business_settings', 'block_oversell',       'INTEGER NOT NULL DEFAULT 0');
  // Links each auto-SIV back to the GRN that triggered it. NULL for manually-created SIVs.
  // Bin Card uses it to render "from GRN-…" alongside the SIV reference.
  addCol('siv',               'source_grn_sync_id',   'TEXT');

  // ── Returnable container deposits (crates / bottles) ───────────────────────
  // Each beverage product can be linked to a separate "container" product (an empty crate)
  // that has its own stock and cost. When a GRN is saved, the cashier records how many
  // empties were returned to the supplier and how many new crates were received. The system
  // posts a stock movement for the container product and includes the net deposit cost in the
  // GRN total. Customers bring their own empties — POS is untouched.
  addCol('products',          'container_product_sync_id', 'TEXT');  // link to the matching empty-crate product
  addCol('products',          'units_per_container',       'REAL');  // e.g. 24 bottles per crate
  // Per-product preferred unit — auto-selected on GRN/SIV/POS lines instead of always defaulting to base unit.
  // Holds the unit name (must match one entry in units_json or the base `unit`). NULL = use base unit.
  addCol('products',          'default_unit',              'TEXT');
  addCol('business_settings', 'default_crate_deposit',     'REAL DEFAULT 57');
  // v1.13.62 — sync_id of the single "EMPTY ZB" (or equivalent) product
  // used for the customer-side empties deposit flow. Nullable — feature
  // stays dormant until admin picks one via System Settings. When set,
  // POS auto-charges this product's price × N for any short return
  // and updates its stock on return.
  addCol('business_settings', 'empty_container_product_sync_id', 'TEXT');

  // 2026-08-30 — which empty this voucher is for.
  //
  // The empties flow assumed ONE empty product, named once in
  // business_settings.empty_container_product_sync_id. Real stock is not like
  // that: EMPTY ZB, EMPTY 500ML and an empty crate are different products with
  // different stock. Under the old shape whichever one was named absorbed
  // every voucher and the rest never moved.
  //
  // The voucher now records the product itself, chosen at issue time from the
  // Crates category. One product per voucher — a person handing in two kinds
  // gets two slips, which keeps the bearer slip redeemable as a single line at
  // POS. The old setting stays as a fallback for anything already issued.
  // (empty_vouchers columns moved below — the table is not created until
  //  much later in this file, so altering it here failed on a fresh DB.)
  // Per-line container settlement captured on each grn_items row.
  addCol('grn_items',         'containers_received',       'REAL NOT NULL DEFAULT 0');
  addCol('grn_items',         'containers_returned',       'REAL NOT NULL DEFAULT 0');
  addCol('grn_items',         'container_deposit',         'REAL NOT NULL DEFAULT 0');
  addCol('grn_items',         'container_product_sync_id', 'TEXT');

  // ── Empty Returns — supplier-side sync linking ────────────────────────────
  addCol('empty_returns',      'supplier_sync_id',        'TEXT');
  addCol('empty_return_items', 'empty_return_sync_id',    'TEXT');
  addCol('empty_return_items', 'product_sync_id',         'TEXT');
  // Legacy AP credit linking (pre-Phase-4A — kept so old rows still update/delete cleanly).
  addCol('empty_returns',      'ap_payment_sync_id',      'TEXT');
  // Phase 4A: new empty returns mint a Credit Note (reason='Crate Return') instead
  // of an ap_payment. The CN goes through the same supplier_credit_notes pipeline
  // as discounts, so AP balance + Profit Report stay consistent.
  addCol('empty_returns',      'credit_note_sync_id',     'TEXT');

  // ── Supplier Credit Notes — sync linking ──────────────────────────────────
  addCol('supplier_credit_notes',      'supplier_sync_id',     'TEXT');
  addCol('supplier_credit_note_items', 'credit_note_sync_id',  'TEXT');
  addCol('supplier_credit_note_items', 'product_sync_id',      'TEXT');
  // Multi-unit: track which unit the line was returned in (NULL = base unit).
  // unit_value is per chosen unit; quantity * unit_conv = base-unit quantity
  // that leaves stock via stock_movements.
  addCol('supplier_credit_note_items', 'unit',                 'TEXT');
  addCol('supplier_credit_note_items', 'unit_conv',            'REAL NOT NULL DEFAULT 1');

  // Profit Report: Supplier Rebates line. Only Discount + Other credit notes
  // count; Crate/Bottle returns are deposit refunds (not income).
  addCol('daily_profit_summary',       'supplier_rebates',     'REAL NOT NULL DEFAULT 0');
  // Profit Report: Interest Expense line — sum of loan_transactions
  // WHERE type='Interest'. Principal repayments and disbursements stay out.
  addCol('daily_profit_summary',       'interest_expense',     'REAL NOT NULL DEFAULT 0');

  // ── Equity / Liabilities — sync linking ───────────────────────────────────
  // Capital and Dividend entries get linked to a shareholder via sync_id, so
  // per-shareholder reporting works across devices regardless of integer ids.
  addCol('capital_account',  'shareholder_id',      'INTEGER');
  addCol('capital_account',  'shareholder_sync_id', 'TEXT');
  addCol('dividend_account', 'shareholder_id',      'INTEGER');
  addCol('dividend_account', 'shareholder_sync_id', 'TEXT');
  // Loan transactions point to their parent loan via sync_id (same pattern
  // as grn_items.grn_sync_id, siv_items.siv_sync_id, etc.).
  addCol('loan_transactions', 'loan_sync_id', 'TEXT');

  // ── Receipt printer configuration ───────────────────────────────────────────
  // USB mode: prints via the Windows Print Spooler queue named `receipt_printer_name`
  //           (the same queue you'd see in Windows → Devices and Printers).
  // LAN mode: opens a raw TCP socket to `receipt_printer_ip:receipt_printer_port` (default 9100).
  // Default `usb` keeps every existing tenant on the existing flow.
  addCol('business_settings', 'receipt_printer_type', "TEXT NOT NULL DEFAULT 'usb'");
  addCol('business_settings', 'receipt_printer_name', 'TEXT');
  addCol('business_settings', 'receipt_printer_ip',   'TEXT');
  addCol('business_settings', 'receipt_printer_port', 'INTEGER DEFAULT 9100');

  // ── Currencies (multi-currency display) ─────────────────────────────────────
  // JSON array of { code, symbol, is_primary }. The primary entry's symbol is used
  // everywhere prices show. Default backfill = one row, USD/$, marked primary —
  // identical to today's behavior for any tenant that hasn't configured anything.
  addCol('business_settings', 'currencies_json', 'TEXT');
  try {
    const defaultCurrencies = JSON.stringify([{ code: 'K', symbol: 'K', is_primary: true }]);
    db.prepare(`UPDATE business_settings SET currencies_json = ? WHERE currencies_json IS NULL OR currencies_json = ''`).run(defaultCurrencies);
  } catch { /* fresh DB — no row yet, defaults applied on first save */ }

  // ── Currency mode (per-branch UI gate) ─────────────────────────────────────
  // Switches dual-currency UI features on/off PER TENANT (which now maps to
  // PER BRANCH in the new subdomain-per-branch architecture):
  //   'K'       — Kwacha only. Standard flow. Used for lusaka1, mansa1.
  //   'USD+FRA' — Dual currency. Unlocks: sell/buy FX rates, dual-currency
  //               payment modal, USD+FRA receipt lines, FX columns on orders.
  //               Used for kasumbalesa1.
  // Default 'K' so every existing tenant keeps the same behaviour it has
  // today; only kasumbalesa1's tenant DB needs to flip the setting to
  // 'USD+FRA' (via Settings UI later, or one-off UPDATE for now).
  addCol('business_settings', 'currency_mode', "TEXT NOT NULL DEFAULT 'K'");

  // Multi-unit support — JSON array of { name, conv, price, is_base } stored on the product.
  // The base unit (conv=1) is always the smallest packaging (e.g. PCS for kelete).
  // Other rows are larger packagings: { name:"Box", conv:24, price:40 } means 1 box = 24 base units.
  // Legacy fields (unit, alt_unit, conversion_factor, alt_price) remain populated for backward
  // compatibility; units_json is the new source of truth for the unit picker everywhere.
  addCol('products',           'units_json',         'TEXT');
  try {
    const productsForUnits = db.prepare(
      `SELECT id, unit, alt_unit, conversion_factor, selling_price, alt_price
       FROM products WHERE deleted_at IS NULL AND (units_json IS NULL OR units_json = '')`
    ).all();
    const updUnits = db.prepare('UPDATE products SET units_json = ? WHERE id = ?');
    for (const p of productsForUnits) {
      const baseUnit = (p.unit || 'pcs').trim();
      const arr = [{ name: baseUnit, conv: 1, price: parseFloat(p.selling_price || 0), is_base: true }];
      const alt = (p.alt_unit || '').trim();
      if (alt && parseFloat(p.conversion_factor || 0) > 0) {
        arr.push({ name: alt, conv: parseFloat(p.conversion_factor), price: parseFloat(p.alt_price || 0), is_base: false });
      }
      updUnits.run(JSON.stringify(arr), p.id);
    }
  } catch (e) { /* fresh DB or no products — fine */ }
  // Backfill CR splits from payment_method
  try {
    db.prepare(`
      UPDATE cash_receipts
      SET cash_amount = CASE WHEN payment_method = 'Cash' THEN amount ELSE 0 END,
          bank_amount = CASE WHEN payment_method IN ('Bank Transfer','Bank','Cheque') THEN amount ELSE 0 END,
          momo_amount = CASE WHEN payment_method = 'Mobile Money' THEN amount ELSE 0 END
      WHERE COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0) = 0
        AND amount > 0
        AND payment_method != 'Mixed'
    `).run();
    // Mixed CRs (AR payments) — pull split from the linked customer_payments row
    db.prepare(`
      UPDATE cash_receipts
      SET cash_amount = (SELECT cp.cash_amount FROM customer_payments cp WHERE cp.id = cash_receipts.source_customer_payment_id),
          bank_amount = (SELECT cp.bank_amount FROM customer_payments cp WHERE cp.id = cash_receipts.source_customer_payment_id),
          momo_amount = (SELECT cp.momo_amount FROM customer_payments cp WHERE cp.id = cash_receipts.source_customer_payment_id)
      WHERE payment_method = 'Mixed' AND source_customer_payment_id IS NOT NULL
    `).run();
    // 2026-09-11 — on a Kwacha-only book the PV window's three slots ARE the
    // methods (usd_amount = Cash, fra_amount = Mobile Money, k_amount =
    // Bank), and the Cash Book reads cash/momo/bank_amount. The PV route
    // used to write those as 0, and the paid_from guess below then booked
    // every PV as Cash — the window always sends "Cash drawer" — so MoMo and
    // Bank PVs came off Cash on Hand. Take the method from the slots, and
    // correct any row the guess already got wrong.
    let kOnlyBook = false;
    try {
      const bsRow = db.prepare('SELECT currency_mode FROM business_settings LIMIT 1').get();
      kOnlyBook = !!bsRow && String(bsRow.currency_mode || 'K').toUpperCase() === 'K';
    } catch (_) { kOnlyBook = false; }
    if (kOnlyBook) {
      db.prepare(`
        UPDATE payment_vouchers
           SET cash_amount = COALESCE(usd_amount,0),
               momo_amount = COALESCE(fra_amount,0),
               bank_amount = COALESCE(k_amount,0)
         WHERE COALESCE(usd_amount,0) + COALESCE(fra_amount,0) + COALESCE(k_amount,0) > 0
           AND (ABS(COALESCE(cash_amount,0) - COALESCE(usd_amount,0)) > 0.004
             OR ABS(COALESCE(momo_amount,0) - COALESCE(fra_amount,0)) > 0.004
             OR ABS(COALESCE(bank_amount,0) - COALESCE(k_amount,0))   > 0.004)
      `).run();
    }
    // Backfill PV splits from paid_from (best-effort heuristic) — on a
    // Kwacha-only book only for old PVs that have no slots to go by.
    db.prepare(`
      UPDATE payment_vouchers
      SET cash_amount = CASE WHEN paid_from LIKE '%Cash%' OR paid_from LIKE '%Drawer%' OR paid_from IS NULL THEN amount ELSE 0 END,
          bank_amount = CASE WHEN paid_from LIKE '%Bank%' OR paid_from LIKE '%Cheque%' THEN amount ELSE 0 END,
          momo_amount = CASE WHEN paid_from LIKE '%Mobile%' OR paid_from LIKE '%MoMo%' THEN amount ELSE 0 END
      WHERE COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0) = 0
        AND amount > 0
        ${kOnlyBook ? 'AND COALESCE(usd_amount,0) + COALESCE(fra_amount,0) + COALESCE(k_amount,0) = 0' : ''}
    `).run();
  } catch (e) { /* ignore */ }
  // Backfill: slot the legacy single amount into the right bucket based on payment_method/paid_from.
  try {
    db.prepare(`
      UPDATE customer_payments
      SET cash_amount = CASE WHEN payment_method IN ('Cash', '') OR payment_method IS NULL THEN amount ELSE 0 END,
          bank_amount = CASE WHEN payment_method IN ('Bank Transfer', 'Bank', 'Cheque') THEN amount ELSE 0 END,
          momo_amount = CASE WHEN payment_method = 'Mobile Money' THEN amount ELSE 0 END
      WHERE COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0) = 0
        AND amount > 0
    `).run();
    db.prepare(`
      UPDATE ap_payments
      SET cash_amount = CASE WHEN paid_from LIKE '%Cashier%' OR paid_from LIKE '%Cash%' OR paid_from IS NULL THEN amount ELSE 0 END,
          bank_amount = CASE WHEN paid_from LIKE '%Bank%' OR paid_from LIKE '%Cheque%' THEN amount ELSE 0 END,
          momo_amount = CASE WHEN paid_from LIKE '%Mobile%' OR paid_from LIKE '%MoMo%' THEN amount ELSE 0 END
      WHERE COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0) = 0
        AND amount > 0
    `).run();
  } catch (e) { /* ignore */ }
  // Mark CRs that originated from an AR payment so the Cash Receipt list can show
  // their source and we don't risk minting a duplicate on re-runs.
  addCol('cash_receipts',      'source_type',            'TEXT');
  addCol('cash_receipts',      'source_customer_payment_id', 'INTEGER');

  // Backfill: any existing customer_payment without a linked CR gets one minted.
  // This is the one-time migration when switching to the "CR per AR payment" model.
  // Uses a self-contained, collision-proof receipt number scheme so we don't depend
  // on syncConfig (which may not be initialised yet during DB bootstrap).
  try {
    const orphans = db.prepare(`
      SELECT cp.id, cp.amount, cp.payment_date, cp.payment_method, cp.reference, cp.notes,
             cp.created_by, cp.tenant_id, cp.branch_id, cp.device_id,
             c.name AS customer_name
      FROM customer_payments cp
      LEFT JOIN customers c ON c.id = cp.customer_id
      WHERE cp.deleted_at IS NULL AND (cp.cash_receipt_sync_id IS NULL OR cp.cash_receipt_sync_id = '')
    `).all();
    if (orphans.length > 0) {
      const { randomUUID } = require('crypto');
      db.transaction(() => {
        for (const p of orphans) {
          // Use the customer_payment.id as a stable, unique suffix — guaranteed
          // collision-proof against itself and unlikely to clash with normal CRs
          // (which use the seq-based scheme).
          const receiptNum = `CR-BACKFILL-${String(p.id).padStart(6, '0')}`;
          const crSyncId = randomUUID();
          db.prepare(`
            INSERT INTO cash_receipts (receipt_number, received_from, description, payment_method, amount, date,
                                       created_by, sync_id, tenant_id, branch_id, device_id, synced,
                                       source_type, source_customer_payment_id,
                                       created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,datetime('now'),datetime('now'))
          `).run(
            receiptNum,
            p.customer_name || 'Customer',
            p.notes ? `AR Payment — ${p.notes}` : 'AR Payment',
            p.payment_method || 'Cash',
            parseFloat(p.amount),
            p.payment_date,
            p.created_by,
            crSyncId, p.tenant_id, p.branch_id, p.device_id,
            'ar_payment', p.id
          );
          db.prepare(`UPDATE customer_payments SET cash_receipt_sync_id = ?, synced = 0 WHERE id = ?`)
            .run(crSyncId, p.id);
        }
      })();
    }
  } catch (e) { console.error('[migrations] AR payment CR backfill failed:', e.message); }
  // Link orders to a specific customer record (prevents same-name customers sharing balances).
  // Legacy orders carry NULL — user has to claim them via the "Claim orphan orders" action.
  addCol('orders',             'customer_id',          'INTEGER');
  addCol('orders',             'customer_sync_id',     'TEXT');
  // Split payment methods on the order itself. amount_received remains the sum;
  // these break it down so the Cash Report can show Cash / MoMo / Bank separately.
  addCol('orders',             'cash_received',        'REAL NOT NULL DEFAULT 0');
  addCol('orders',             'momo_received',        'REAL NOT NULL DEFAULT 0');
  addCol('orders',             'bank_received',        'REAL NOT NULL DEFAULT 0');
  // v1.13.20 — REMOVED two restart-time backfills that mirrored Kelete's
  // deleted ones (see project_kelete_phantom_change_backfill for the
  // failure pattern). Both would silently mutate NEW data if a later
  // write path regressed:
  //   (a) payment_method → cash/momo/bank bucket seed
  //   (b) orders → customer_id auto-link by unambiguous name
  // Legacy rows were already backfilled on every deployed DB. Use the
  // Merge tool for future customer-name disambiguation.
  addCol('grn',                'supplier_sync_id',  'TEXT');
  addCol('ap_payments',        'supplier_sync_id',  'TEXT');

  // 2026-08-30 — link a payment to the GRN it settles.
  //
  // The AP flow already passed a grnSyncId, but only used it to stamp the GRN
  // as PAID; it was never stored on the payment. So the money was recorded at
  // SUPPLIER level with no way to say how much of a given GRN was settled —
  // which is why a K10,000 payment against a K90,000 GRN marked the whole
  // thing paid and hid the K80,000 still owed.
  addCol('ap_payments',        'grn_sync_id',       'TEXT');

  // 2026-08-30 — batch payments. One payment against several GRNs of the same
  // supplier is stored as one ROW PER GRN (grn_sync_id above holds a single
  // GRN, and payment_number is UNIQUE so the rows cannot share one). batch_ref
  // is what ties them back together as a single act of paying, for the AP
  // ledger and for reversing the whole batch later. NULL on every ordinary
  // single-GRN payment.
  addCol('ap_payments',        'batch_ref',         'TEXT');

  // 2026-08-31 — a standalone credit note walks the same road as a GRN.
  //
  // Two kinds of supplier credit exist and they are not the same thing:
  //
  //   attached  — damage or shortage found at delivery. Belongs to that GRN,
  //               already reduces its payable, already rides its approval.
  //   standalone — empties handed back weeks later, a rebate, a goodwill
  //               credit. Belongs to NO invoice.
  //
  // The second kind used to lower the supplier's balance the moment it was
  // saved, with nobody checking it and no way to spend it: payments are
  // matched GRN by GRN, so the credit sat reducing a total while every GRN
  // still showed its full amount.
  //
  // It now carries the same stages a GRN does — Awaiting Check, Awaiting
  // Confirmation, Ready for Payment — and ends APPLIED rather than PAID,
  // because a credit is consumed against a payment rather than paid out.
  addCol('supplier_credit_notes', 'ap_status',                "TEXT NOT NULL DEFAULT 'PENDING'");
  addCol('supplier_credit_notes', 'checked_at',               'TEXT');
  addCol('supplier_credit_notes', 'checked_by_id',            'INTEGER');
  addCol('supplier_credit_notes', 'checked_by_name',          'TEXT');
  addCol('supplier_credit_notes', 'review_confirmed_at',      'TEXT');
  addCol('supplier_credit_notes', 'review_confirmed_by_id',   'INTEGER');
  addCol('supplier_credit_notes', 'review_confirmed_by_name', 'TEXT');
  addCol('supplier_credit_notes', 'approved_at',              'TEXT');
  addCol('supplier_credit_notes', 'approved_by_id',           'INTEGER');
  addCol('supplier_credit_notes', 'approved_by_name',         'TEXT');
  addCol('supplier_credit_notes', 'sent_back_at',             'TEXT');
  addCol('supplier_credit_notes', 'sent_back_by_name',        'TEXT');
  addCol('supplier_credit_notes', 'sent_back_reason',         'TEXT');
  // Consumed. Without this the same credit could be applied to every payment
  // for ever — the one column that must not be skipped.
  addCol('supplier_credit_notes', 'applied_at',               'TEXT');
  addCol('supplier_credit_notes', 'applied_payment_sync_id',  'TEXT');
  addCol('supplier_credit_notes', 'applied_amount',           'REAL NOT NULL DEFAULT 0');

  // 2026-09-04 — a depot raises the credit note for damage on its own
  // delivery. The row is written into HQ's book, because AP is HQ-only and
  // HQ's Credit Notes page reads its own table — a note left at the branch is
  // raised and then invisible.
  //
  // grn_sync_id stays NULL until HQ agrees. recomputeGrnPayable sums every
  // credit carrying a grn_sync_id, so filling it at raise time would net the
  // payable immediately and there would be nothing left to confirm. The depot
  // states which GRN it means; confirming is what makes it so.
  addCol('supplier_credit_notes', 'proposed_grn_sync_id',     'TEXT');
  addCol('supplier_credit_notes', 'raised_by_branch',         'TEXT');
  addCol('supplier_credit_notes', 'raised_by_name',           'TEXT');
  addCol('supplier_credit_notes', 'branch_confirmed_at',      'TEXT');
  addCol('supplier_credit_notes', 'branch_confirmed_by_name', 'TEXT');

  // A credit raised BEFORE this had no stages. Attached ones are part of
  // their GRN and never enter the queue, so only standalone ones matter:
  // they start at Awaiting Check, the same place a new GRN starts.
  try {
    db.prepare(
      "UPDATE supplier_credit_notes SET ap_status = 'PENDING' " +
      " WHERE (ap_status IS NULL OR ap_status = '')"
    ).run();
  } catch (_) { /* column just created on an empty table */ }

  // 2026-08-30 — one payment, many invoices.
  //
  // ap_payments used to carry a single grn_sync_id, so paying K44,000 across
  // two GRNs wrote TWO payment rows. Both the AP Payments list and the Cash
  // Book ledger list ap_payments row by row, so one physical payment appeared
  // as two lines in both.
  //
  // The fix is the standard AP shape: the PAYMENT is one record, and its
  // ALLOCATIONS say how it was applied. Every screen that lists payments then
  // shows one line with no change of its own, and per-GRN paid/remaining is
  // still exact — it just reads from here instead of from the payment row.
  //
  // ap_payments.grn_sync_id is kept and still written for single-GRN payments:
  // it costs nothing, and it keeps older builds and the sync bridge working
  // while every install catches up.
  db.exec(`
    CREATE TABLE IF NOT EXISTS ap_payment_allocations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_sync_id   TEXT NOT NULL,
      grn_sync_id       TEXT NOT NULL,
      amount            REAL NOT NULL DEFAULT 0,
      sync_id           TEXT,
      tenant_id         TEXT,
      branch_id         TEXT,
      device_id         TEXT,
      synced            INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_ap_alloc_grn     ON ap_payment_allocations (grn_sync_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_ap_alloc_payment ON ap_payment_allocations (payment_sync_id)');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_alloc_unique ON ap_payment_allocations (payment_sync_id, grn_sync_id)');
  } catch (_) { /* indexes are an optimisation, not a requirement */ }

  // One-time backfill: every existing GRN-linked payment becomes exactly one
  // allocation for its full amount. Without this, moving the paid/remaining
  // calculation onto allocations would read zero for all history and every
  // settled GRN would spring back to unpaid.
  //
  // Guarded by the unique index above, so re-running is a no-op rather than a
  // doubling — this file runs on every boot.
  try {
    const hasRows = db.prepare('SELECT COUNT(*) AS n FROM ap_payment_allocations').get()?.n || 0;
    const legacy  = db.prepare(
      "SELECT sync_id, grn_sync_id, amount, tenant_id, branch_id, device_id " +
      "  FROM ap_payments " +
      " WHERE grn_sync_id IS NOT NULL AND grn_sync_id != '' " +
      "   AND sync_id IS NOT NULL " +
      "   AND (deleted_at IS NULL OR deleted_at = '')"
    ).all();
    if (legacy.length > 0) {
      const ins = db.prepare(
        'INSERT OR IGNORE INTO ap_payment_allocations ' +
        '  (payment_sync_id, grn_sync_id, amount, sync_id, tenant_id, branch_id, device_id, synced) ' +
        'VALUES (?,?,?,?,?,?,?,0)'
      );
      const run = db.transaction(() => {
        for (const p of legacy) {
          ins.run(p.sync_id, p.grn_sync_id, p.amount || 0,
                  p.sync_id + ':' + p.grn_sync_id,   // deterministic, so replays collide instead of duplicating
                  p.tenant_id || null, p.branch_id || null, p.device_id || null);
        }
      });
      run();
      if (hasRows === 0) {
        console.log(`[migrations] ap_payment_allocations backfilled from ${legacy.length} payment(s)`);
      }
    }
  } catch (e) {
    console.warn('[migrations] ap allocation backfill skipped:', e.message);
  }

  // One-time backfill. AP Approvals writes its description as
  //   "GRN GRN-2026-12585695 - Invoice 42342"
  // so the historical link is recoverable from free text, which means no
  // existing payment is lost. Only done where grn_sync_id is still empty, so
  // it never overwrites a real value, and matched against hq_grns so a typo
  // in the text cannot invent a link.
  //
  // The description is NOT used as the live link: it is editable from the
  // payments list, and a corrected typo would silently detach the payment.
  try {
    const master = require('./masterDb').masterDb;
    if (master) {
      const orphans = db.prepare(
        `SELECT id, description FROM ap_payments
          WHERE (grn_sync_id IS NULL OR grn_sync_id = '')
            AND description LIKE 'GRN %'`
      ).all();
      const upd = db.prepare('UPDATE ap_payments SET grn_sync_id = ? WHERE id = ?');
      let linked = 0;
      for (const p of orphans) {
        const m = String(p.description || '').match(/GRN-[0-9A-Za-z-]+/);
        if (!m) continue;
        const g = master.prepare('SELECT sync_id FROM hq_grns WHERE grn_number = ?').get(m[0]);
        if (g?.sync_id) { upd.run(g.sync_id, p.id); linked++; }
      }
      if (linked) console.log(`[migration] linked ${linked} existing AP payment(s) to their GRN`);
    }
  } catch (_) { /* master.db absent (a till before first sync) — skip */ }
  addCol('daily_actual_balance','product_sync_id',  'TEXT');
  addCol('daily_profit_summary','stock_adj',        'REAL NOT NULL DEFAULT 0');
  // Sales Damages — items destroyed/expired, cost subtracted from gross profit.
  addCol('daily_profit_summary','damages',          'REAL NOT NULL DEFAULT 0');

  // ── Parity with server.js addCol calls that were missing here ──────────────
  // These were added in server.js (Electron default DB) but never to initTenantDb.
  // The first one — categories.main_category_id — is what was crashing /api/products
  // on web tenants ("no such column: c.main_category_id"). Adding the rest as a
  // single audit so we stop chasing them one at a time.
  addCol('categories',     'main_category_id',      'INTEGER');
  addCol('categories',     'main_category_sync_id', 'TEXT');
  addCol('products',       'product_type',          "TEXT NOT NULL DEFAULT 'finished'");
  addCol('cash_reports',   'cashier_id',            'INTEGER DEFAULT 0');
  addCol('cash_reports',   'bank',                  'REAL NOT NULL DEFAULT 0');
  // v1.8.1 — triple-currency cash report. Each holds the NET cash in that
  // currency (received minus change given), in that currency's own units.
  addCol('cash_reports',   'usd_received',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'fra_received',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'k_received',            'REAL NOT NULL DEFAULT 0');
  // v1.8.13 — per-currency Expected snapshot at save time. The difference
  // per currency = received - expected, computed at read. Stored so the
  // history shows what the POS said vs what the cashier counted, even if
  // the order table changes later (reversals, edits, etc.).
  addCol('cash_reports',   'usd_expected',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'fra_expected',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'k_expected',            'REAL NOT NULL DEFAULT 0');
  // v1.8.26 — per-currency expenses snapshot at save time so the history
  // table can show what was paid out of each currency's drawer for that
  // shift without re-querying payment_vouchers per row.
  addCol('cash_reports',   'usd_expenses',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'fra_expenses',          'REAL NOT NULL DEFAULT 0');
  addCol('cash_reports',   'k_expenses',            'REAL NOT NULL DEFAULT 0');
  addCol('payment_vouchers','cashier_id',           'INTEGER DEFAULT 0');
  addCol('siv',            'production_id',         'INTEGER');
  addCol('siv',            'production_sync_id',    'TEXT');

  try {
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dab_product_sync_date ON daily_actual_balance (product_sync_id, date)`).run();
  } catch (_) {}

  try {
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dcs_product_sync_date ON daily_cost_snapshot (product_sync_id, date)`).run();
  } catch (_) {}

  // ─── Indexes on sync_id for every sync table ───────────────────────────────
  // Sync push/pull does WHERE sync_id = ? on every row. Without these indexes,
  // every lookup is a full table scan — Mother freezes under load with big tables.
  const SYNC_TABLES = [
    'users', 'categories', 'main_categories', 'units', 'products', 'customers', 'suppliers',
    'orders', 'order_items', 'grn', 'grn_items', 'siv', 'siv_items',
    'production', 'production_inputs', 'production_outputs',
    'sales_returns', 'sales_return_items',
    'stock_movements', 'cash_receipts', 'payment_vouchers', 'cash_book',
    'business_settings', 'cash_reports', 'stock_adjustments', 'daily_actual_balance',
    'ap_payments', 'daily_profit_summary',
    // v1.8.33 — newer tables that participate in sync. Without these
    // index entries Mother does full-table scans on big sync push/pull.
    'customer_payments', 'stock_reconciliations', 'stock_reconciliation_items',
    'supplier_credit_notes', 'supplier_credit_note_items',
    'capital_account', 'dividend_account', 'shareholders', 'loans', 'loan_transactions',
    'cash_transfers', 'stock_count_sessions', 'stock_count_items',
    'discount_requests', 'pv_types',
    'branches', 'product_branch_prices',
    'currency_exchanges', 'fx_rates',
  ];
  for (const t of SYNC_TABLES) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      if (cols.includes('sync_id')) {
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_${t}_sync_id ON ${t} (sync_id)`).run();
      }
      if (cols.includes('tenant_id') && cols.includes('updated_at')) {
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_${t}_tenant_updated ON ${t} (tenant_id, updated_at)`).run();
      }
    } catch (_) {}
  }

  // 2026-09-13 — the joins every sales report makes. The VAT Transaction
  // Report (services/vatReport.js) reads orders in a date range, their items
  // by order_items.order_sync_id and each item's product by products.sync_id.
  // None of those had an index — the loop above indexes order_items.sync_id,
  // not the order it belongs to — so each report run left SQLite to build a
  // throw-away index or scan every item for every order, sixteen books over.
  // IF NOT EXISTS: a no-op wherever one is already there.
  try {
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_order_items_order_sync_id ON order_items (order_sync_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_products_sync_id ON products (sync_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at)`).run();
  } catch (_) { /* indexes are an optimisation, not a requirement */ }

  // No default admin — the Setup screen creates the real admin during registration

  // ─── One-time cleanup: remove daily_profit_summary rows with malformed date (timestamp instead of YYYY-MM-DD)
  // Caused by an old bug in order reverse where `created_at.split('T')[0]` returned the full SQLite timestamp.
  try {
    db.prepare(`DELETE FROM daily_profit_summary WHERE length(date) > 10`).run();
  } catch (_) {}

  // ─── One-time cleanup: recompute cost_at_count on existing stock_reconciliation_items.
  // Earlier rows used an un-converted avg from grn_items (mixed pcs/box totals) — yielding cost per box
  // when it should have been per base unit. This makes variance_value correct on rows posted before the fix.
  try {
    const { baseQtyExpr: _bq } = require('./unitsHelper');
    const fixedAvgCostSubquery = `
      SELECT CASE WHEN COALESCE(SUM(${_bq('gp', 'gi')}), 0) > 0
             THEN ROUND(SUM(gi.total_price) / SUM(${_bq('gp', 'gi')}), 4)
             ELSE 0 END AS avg_cost
      FROM grn_items gi
      LEFT JOIN products gp ON gp.sync_id = gi.product_sync_id
      WHERE gi.product_sync_id = ? AND gi.deleted_at IS NULL
    `;
    const items = db.prepare(`SELECT id, product_sync_id FROM stock_reconciliation_items WHERE deleted_at IS NULL`).all();
    const fixStmt = db.prepare(`UPDATE stock_reconciliation_items SET cost_at_count = ? WHERE id = ?`);
    for (const it of items) {
      const row = db.prepare(fixedAvgCostSubquery).get(it.product_sync_id);
      const newCost = parseFloat(row?.avg_cost || 0);
      if (newCost > 0) fixStmt.run(newCost, it.id);
    }
  } catch (_) {}

  // v1.13.20 — REMOVED (see also the deleted block earlier in this file).
  // Second, near-duplicate copy of the orders → customer_id auto-link
  // backfill. Same reason for removal: on every restart it would guess
  // and could wrongly link a newly-added same-named customer to an old
  // sale. Use the Merge tool for legacy fix-ups.

  // ── Cash Reports per-cashier migration ────────────────────────────────────
  // The original schema had UNIQUE on the `date` column alone, which blocked
  // a second cashier from saving their own Cash Report for the same day
  // (only one row per date could exist across all cashiers). This block
  // detects a tenant DB carrying the old date-only UNIQUE index and
  // rewrites the table without it, then creates a composite
  // UNIQUE(date, cashier_id) index. Mirrors the same migration that's in
  // server.js for Electron default DBs. Idempotent — no-op after first run.
  try {
    const idxList = db.prepare("PRAGMA index_list('cash_reports')").all();
    const hasDateOnlyUnique = idxList.some(idx => {
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
          bank           REAL DEFAULT 0,
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
          SELECT id, date, initial_change, mobile_money, cash,
                 COALESCE(bank, 0), expenses, pending, total,
                 after_change, expected, difference, status, comment, created_by,
                 created_at, updated_at, sync_id, tenant_id, branch_id, device_id,
                 deleted_at, COALESCE(synced, 0), COALESCE(cashier_id, 0)
          FROM cash_reports;
        DROP TABLE cash_reports;
        ALTER TABLE cash_reports_migrated RENAME TO cash_reports;
      `);
    }
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cash_reports_date_cashier ON cash_reports(date, cashier_id)`).run();
  } catch (_) { /* migration is idempotent and best-effort */ }

  // ─────────────────────────────────────────────────────────────────────────
  // Phase 1 — Multi-currency schema, but Kelete is K-only
  // ─────────────────────────────────────────────────────────────────────────
  // Kelete is a K-only system — all branches (HQ + branches) use K, no dual
  // currency. The multi-currency schema (branches.secondary_currency, selling/
  // buying rates, orders.fra_received, etc.) is inherited from the upstream
  // codebase but every branch is seeded with primary_currency='K' and
  // secondary_currency=NULL so the Pay modal renders exactly like Liquor
  // (no FRA fields, no FX rate inputs). The columns stay in case a future
  // Kelete variant needs them; unused today.
  try {
    // Branches — meta info about each physical location. The `id` here is
    // the same TEXT UUID the sync layer already stamps on rows as branch_id.
    db.exec(`
      CREATE TABLE IF NOT EXISTS branches (
        id                 TEXT PRIMARY KEY,
        name               TEXT NOT NULL,
        primary_currency   TEXT NOT NULL DEFAULT 'K',
        secondary_currency TEXT,
        selling_rate       REAL,
        buying_rate        REAL,
        status             TEXT NOT NULL DEFAULT 'Active',
        sync_id            TEXT,
        tenant_id          TEXT,
        device_id          TEXT,
        synced             INTEGER NOT NULL DEFAULT 0,
        deleted_at         TEXT,
        created_at         TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // Per-branch product price overrides. When a row exists for a given
    // (product_id, branch_id) pair, POS / receipts at that branch use these
    // values instead of products.cost_price / products.selling_price. When
    // missing, the fallback is the legacy single-price columns — so Branches
    // 1 & 2 keep working without any data entry.
    db.exec(`
      CREATE TABLE IF NOT EXISTS product_branch_prices (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        product_sync_id TEXT,
        branch_id       TEXT NOT NULL,
        cost_price      REAL NOT NULL DEFAULT 0,
        selling_price   REAL NOT NULL DEFAULT 0,
        currency        TEXT NOT NULL DEFAULT 'K',
        sync_id         TEXT,
        tenant_id       TEXT,
        device_id       TEXT,
        synced          INTEGER NOT NULL DEFAULT 0,
        deleted_at      TEXT,
        created_at      TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(product_id, branch_id)
      )
    `);
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pbp_product ON product_branch_prices(product_id)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_pbp_branch  ON product_branch_prices(branch_id)`).run();

    // ── Orders: frozen FX snapshot + FRA payment buckets ──────────────────
    // currency           = the branch's primary at sale time ('K' or 'USD')
    // fra_received       = how much FRA the cashier physically took
    // fra_change_given   = how much FRA the cashier physically returned
    // selling_rate_used  = FRA→primary rate frozen at sale  (used for receive)
    // buying_rate_used   = primary→FRA rate frozen at sale  (used for change)
    addCol('orders', 'currency',          "TEXT DEFAULT 'K'");
    addCol('orders', 'fra_received',      'REAL DEFAULT 0');
    addCol('orders', 'fra_change_given',  'REAL DEFAULT 0');
    addCol('orders', 'selling_rate_used', 'REAL');
    addCol('orders', 'buying_rate_used',  'REAL');

    // ── Seed Kelete's three branches the first time the table is empty ──────
    // Idempotent: re-running this migration does nothing once rows exist.
    // The IDs are stable UUIDs derived from sync-friendly randomness; the
    // existing device's sync_config.branch_id may point at a different UUID
    // — that's fine, we leave that untouched and the device can be assigned
    // to a branch later through the Settings UI (Phase 2).
    const branchCount = db.prepare('SELECT COUNT(*) AS n FROM branches').get().n;
    if (branchCount === 0) {
      const tenantRow = db.prepare("SELECT value FROM sync_config WHERE key = 'tenant_id'").get();
      const tenantId  = tenantRow ? tenantRow.value : null;
      const ins = db.prepare(`
        INSERT INTO branches (id, name, primary_currency, secondary_currency,
                              selling_rate, buying_rate, sync_id, tenant_id, synced)
        VALUES (?,?,?,?,?,?,?,?,0)
      `);
      const u = () => crypto.randomUUID();
      ins.run(u(), 'Branch 1', 'K', null, null, null, u(), tenantId);
      ins.run(u(), 'Branch 2', 'K', null, null, null, u(), tenantId);
      ins.run(u(), 'Branch 3', 'K', null, null, null, u(), tenantId);
    }
  } catch (e) {
    console.error('[migrations] phase-1 multi-currency failed:', e.message);
    // best-effort; later phases can re-attempt
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3-Station workflow (Sales → Cashier → Dispatch)
  // ─────────────────────────────────────────────────────────────────────────
  // Per-branch UI gate that swaps the single-screen POS for a 3-station flow
  // used at kasumbalesa1:
  //   'single_pos'    — one cashier creates + pays + dispatches in one step
  //                     (lusaka1, mansa1 — existing behaviour).
  //   'three_station' — Sales creates the order → Cashier collects payment →
  //                     Dispatch releases goods. Each station is a separate
  //                     screen; orders move through a status state machine.
  //
  // orders.status values used in this flow:
  //   'PENDING_PAYMENT' — Sales confirmed; awaiting Cashier
  //   'PAID'            — Cashier collected; awaiting Dispatch
  //   'DISPATCHED'      — Goods released; stock decremented HERE (not at sale)
  //   'CANCELLED'       — Voided at any stage
  //   NULL              — Legacy single_pos completed sale (unchanged)
  addCol('business_settings', 'workflow_mode', "TEXT NOT NULL DEFAULT 'single_pos'");
  addCol('orders', 'sales_user_id',    'INTEGER');
  addCol('orders', 'cashier_user_id',  'INTEGER');
  addCol('orders', 'dispatch_user_id', 'INTEGER');
  addCol('orders', 'sales_at',         'TEXT');
  addCol('orders', 'paid_at',          'TEXT');
  addCol('orders', 'dispatched_at',    'TEXT');

  // ─────────────────────────────────────────────────────────────────────────
  // v1.9.1 — cross-device cashier-name fix.
  // ─────────────────────────────────────────────────────────────────────────
  // orders.created_by / cashier_user_id / sales_user_id / dispatch_user_id
  // all stored the LOCAL users.id (INTEGER AUTOINCREMENT per DB). When an
  // order pushed from Electron to VPS, the integer was copied as-is — but
  // users.id=4 on Electron rarely matches users.id=4 on VPS, so the receipt
  // JOIN on the OTHER side picked whoever happened to occupy that id. Real
  // incident: Electron showed cashier "milan milan" while web showed the
  // SAME order's cashier as "Yonas Yonas". Confirmed via SQL: Electron
  // milan=id4, VPS milan=id2; Electron yonas=id2, VPS yonas=id4.
  //
  // Fix: store users.sync_id (UUID) in parallel mirror columns. Backfill
  // existing rows from the local users table at boot — pre-fix rows that
  // arrived via cross-device push may resolve to the wrong sync_id on this
  // side (no way to recover original creator), but new rows going forward
  // get stamped by the source device, so the JOIN always finds the right
  // user no matter which DB is reading.
  addCol('orders', 'created_by_sync_id',   'TEXT');
  addCol('orders', 'cashier_user_sync_id', 'TEXT');
  addCol('orders', 'sales_user_sync_id',   'TEXT');
  addCol('orders', 'dispatch_user_sync_id','TEXT');
  // Backfill from local users table — runs once per row (skips already-filled).
  try {
    db.prepare(`UPDATE orders SET created_by_sync_id    = (SELECT sync_id FROM users WHERE id = orders.created_by)     WHERE created_by_sync_id    IS NULL AND created_by     IS NOT NULL`).run();
    db.prepare(`UPDATE orders SET cashier_user_sync_id  = (SELECT sync_id FROM users WHERE id = orders.cashier_user_id) WHERE cashier_user_sync_id  IS NULL AND cashier_user_id  IS NOT NULL`).run();
    db.prepare(`UPDATE orders SET sales_user_sync_id    = (SELECT sync_id FROM users WHERE id = orders.sales_user_id)   WHERE sales_user_sync_id    IS NULL AND sales_user_id    IS NOT NULL`).run();
    db.prepare(`UPDATE orders SET dispatch_user_sync_id = (SELECT sync_id FROM users WHERE id = orders.dispatch_user_id) WHERE dispatch_user_sync_id IS NULL AND dispatch_user_id IS NOT NULL`).run();
  } catch (e) { /* tolerate empty users table on a fresh DB */ }

  // ─────────────────────────────────────────────────────────────────────────
  // v1.3.1 — Sales Damages state machine
  // ─────────────────────────────────────────────────────────────────────────
  // Spec: branches can only declare damages; HQ must confirm before the
  // sales-floor stock is decremented + the damages cost flows into
  // daily_profit_summary.damages. This keeps fraud / data-entry mistakes
  // off the books until HQ has eyes on them.
  //
  // Status enum on sales_returns:
  //   PENDING   — branch declared, awaiting HQ confirmation, no stock yet
  //   CONFIRMED — HQ approved, stock decremented + profit recalculated
  //   REJECTED  — HQ rejected with confirm_notes explaining why
  //
  // Default is 'CONFIRMED' so EXISTING legacy rows stay marked
  // already-actioned (they already created their stock_movements). New
  // rows from v1.3.1+ are written as PENDING by the POST endpoint.
  addCol('sales_returns', 'status',            "TEXT NOT NULL DEFAULT 'CONFIRMED'");
  addCol('sales_returns', 'confirmed_by',      'INTEGER');
  addCol('sales_returns', 'confirmed_by_name', 'TEXT');
  addCol('sales_returns', 'confirmed_at',      'TEXT');
  addCol('sales_returns', 'confirm_notes',     'TEXT');

  // v1.3.9 — per-branch toggle that re-enables the legacy GRN + Suppliers
  // sidebar entries (otherwise hidden on branches by v1.3.2's lockdown).
  // Use case: seeding initial stock at a freshly-deployed branch before
  // the HQ Procurement loop is producing receipts, or one-off rescues.
  // OFF by default — only branches that flip this ON see the legacy
  // pages. HQ host always sees them regardless of this flag.
  addCol('business_settings', 'legacy_procurement_enabled', 'INTEGER NOT NULL DEFAULT 0');

  // v1.9.26 — payment_methods is the third independent dial alongside
  // currency_mode + workflow_mode. 'cash_only' = Kelete 3-currency cash
  // branches (no MoMo, no Bank). 'cash_momo_bank' = Liquor-style
  // branches that take Cash + MoMo + Bank. Default cash_momo_bank so
  // existing tenants keep their current Pay-modal behaviour.
  addCol('business_settings', 'payment_methods', "TEXT NOT NULL DEFAULT 'cash_momo_bank'");

  // 2026-09-11 — which payment methods this branch SHOWS ('cash,momo,bank' by
  // default). Hiding only: nothing is deleted and no maths changes, and a
  // screen still shows a hidden method wherever money already sits on it.
  // Kept apart from payment_methods, whose 'cash_only' also switches the
  // money pages over to the three-currency model.
  addCol('business_settings', 'shown_payment_methods', "TEXT NOT NULL DEFAULT 'cash,momo,bank'");

  // 2026-09-11 — a saved Cash Report sends its counted money to HQ as PENDING
  // deposits (services/autoDeposit.js). Off by default; on for the Lusaka
  // depots.
  addCol('business_settings', 'auto_deposit_enabled', 'INTEGER NOT NULL DEFAULT 0');
  // 2026-09-15 — System Settings → Deposit to. NULL = HQ (every depot's
  // default); a depot slug sends this depot's deposits to that depot instead.
  addCol('business_settings', 'deposit_to_slug', 'TEXT');

  // ─────────────────────────────────────────────────────────────────────────
  // v1.4.0 — FX Rates (Accounting → Currency Rates)
  // ─────────────────────────────────────────────────────────────────────────
  // Per-branch history of USD ↔ FRA rates. Cashier reads the latest row
  // where effective_date <= today AND deleted_at IS NULL; receipts replay
  // with the rate snapshotted on the order (selling_rate_used /
  // buying_rate_used columns added back in Phase 1) so old prints stay
  // accurate even after the manager updates the rate.
  //
  // Only used by branches with currency_mode='USD+FRA' (Kassumbalesa).
  // Hardcoded SELL=2900 / BUY=2600 remains as the fallback when the
  // table is empty.
  db.exec(`
    CREATE TABLE IF NOT EXISTS fx_rates (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      effective_date  TEXT NOT NULL,
      sell_rate       REAL NOT NULL,
      buy_rate        REAL NOT NULL,
      notes           TEXT,
      set_by          INTEGER,
      set_by_name     TEXT,
      sync_id         TEXT,
      tenant_id       TEXT,
      branch_id       TEXT,
      device_id       TEXT,
      synced          INTEGER NOT NULL DEFAULT 0,
      deleted_at      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fx_rates_effective ON fx_rates (effective_date);
  `);

  // ─────────────────────────────────────────────────────────────────────────
  // v1.5.0 — HQ-owned products marker
  // ─────────────────────────────────────────────────────────────────────────
  // Marks a branch product as managed by HQ. Set to 1 by pushToBranches.
  // The branch UI uses this to lock HQ-owned fields (code, name, category,
  // unit, packagings, default_unit, photo, container, UB barcode) — branch
  // only edits price, status, min stock, notes, opening stock. The branch
  // PUT /api/products/:id ALSO enforces this server-side so a hostile
  // client can't bypass the UI lock.
  addCol('products', 'is_hq_owned', 'INTEGER NOT NULL DEFAULT 0');

  // v1.10.53 — Persisted Weighted Average Cost per product per branch.
  // Populated on:
  //   - GRN save (supplier receipt, branch-side)
  //   - HQ GRN generate (HQ pushes stock to branch)
  //   - Stock Transfer receive
  // Never overwritten by cost_price on product edit — cost_price is the
  // catalogue's "current buy price" (typing/reference), avg_cost_price is
  // the real weighted mean of on-hand stock. profitHelper.js COGS calc
  // reads this column directly instead of re-scanning grn_items every day.
  // NULL = never received any stock; profitHelper falls back to derived SUM
  // (backward-compat during backfill window).
  addCol('products', 'avg_cost_price', 'REAL');

  // v1.13.12 — ZRA Smart Invoice (VSDC) prep. Populated later; NULL until
  // then (no runtime effect until vsdc.js client is wired in).
  //   hs_code   — for Imports endpoint only (17-char customs code)
  //   tax_label — legacy client export label (A/B/C/D/NB) — kept for the
  //               Excel importer that reads their old system's export.
  addCol('products', 'hs_code',   'TEXT');
  addCol('products', 'tax_label', 'TEXT');

  // v1.13.13 — ZRA VSDC schema expansion (Step 1 of ZRA integration).
  // Full breakdown of endpoints/behaviour in the project memory
  // (project_kelete_zra.md). All columns nullable, all tables IF NOT
  // EXISTS — no runtime effect until vsdc.js client is written and
  // POS/product/GRN routes call it. Safe to deploy today.

  // ── Per-device / per-branch VSDC identifiers on business_settings ──
  // Set once during "Initialize Device" on the ZRA Config page. `env`
  // toggles between sandbox and production. `last_*` counters mirror
  // what VSDC returns from selectInitInfo so we can validate the next
  // cisInvcNo we send.
  addCol('business_settings', 'zra_enabled',            'INTEGER NOT NULL DEFAULT 0');
  addCol('business_settings', 'zra_env',                "TEXT NOT NULL DEFAULT 'sandbox'"); // sandbox | production
  addCol('business_settings', 'zra_vsdc_url',           'TEXT');   // e.g. http://localhost:8080/zraSandboxVsdc
  addCol('business_settings', 'zra_tpin',               'TEXT');
  addCol('business_settings', 'zra_bhf_id',             'TEXT');   // 3-char, "000" = HQ
  addCol('business_settings', 'zra_dvc_srl_no',         'TEXT');
  addCol('business_settings', 'zra_sdc_id',             'TEXT');   // returned by /initializer
  addCol('business_settings', 'zra_mrc_no',             'TEXT');
  addCol('business_settings', 'zra_taxpr_nm',           'TEXT');
  addCol('business_settings', 'zra_vat_ty_cd',          'TEXT');
  addCol('business_settings', 'zra_last_invc_no',       'INTEGER');
  addCol('business_settings', 'zra_last_sale_invc_no',  'INTEGER');
  addCol('business_settings', 'zra_last_pchs_invc_no',  'INTEGER');
  addCol('business_settings', 'zra_last_sale_rcpt_no',  'INTEGER');
  addCol('business_settings', 'zra_last_train_invc_no', 'INTEGER');
  addCol('business_settings', 'zra_last_profrm_invc_no','INTEGER');
  addCol('business_settings', 'zra_last_copy_invc_no',  'INTEGER');
  addCol('business_settings', 'zra_initialized_at',     'TEXT');

  // ── Item classification / packaging on products ──
  // vat_cat_cd is the ZRA VSDC vatCatCd (A/B/C1/C2/C3/D/RVAT/E/F/…) — this
  // is DIFFERENT from `tax_label` above, which holds the legacy
  // single-letter code from the client's old system. Mapping between the
  // two lives in the Excel importer.
  addCol('products', 'zra_item_cd',       'TEXT');   // ZRA-formatted item code (ZM + type + pkg + qtyUnit + seq)
  addCol('products', 'zra_item_cls_cd',   'TEXT');   // UNSPSC 8-digit, e.g. 50202100 (Beer)
  addCol('products', 'zra_item_ty_cd',    'TEXT');   // 1=raw material, 2=finished, 3=service
  addCol('products', 'zra_orgn_nat_cd',   'TEXT');   // origin country (ISO)
  addCol('products', 'zra_pkg_unit_cd',   'TEXT');   // BX/CT/BO/KZ/JY/BA/BE/BG…
  addCol('products', 'zra_qty_unit_cd',   'TEXT');   // U/L/LTR/KG/BX…
  addCol('products', 'zra_vat_cat_cd',    'TEXT');   // A/B/C1/C2/C3/D/RVAT/E/F/…
  addCol('products', 'zra_excise_ty_cd',  'TEXT');   // for beer/spirits/tobacco
  // v1.13.80 — Cache for /trnsPurchase/selectTrnsPurchaseSales pulls.
  //   Each row is a supplier invoice VSDC has already registered against
  //   our TPIN. Operator inspects and either APPROVES (fires
  //   /trnsPurchase/savePurchase with regTyCd='A') or REJECTS (marks
  //   locally, no VSDC call — since ZRA has already recorded the
  //   supplier's side, our reject is just an internal audit note).
  //
  //   UNIQUE(spplr_tpin, spplr_invc_no) dedups on repeated pulls.
  //   raw_json holds the untouched VSDC row so approval can rebuild
  //   the itemList without a second network round-trip.
  db.exec(`
    CREATE TABLE IF NOT EXISTS zra_pending_purchases (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      spplr_tpin            TEXT,
      spplr_nm              TEXT,
      spplr_bhf_id          TEXT,
      spplr_invc_no         TEXT,
      spplr_sdc_id          TEXT,
      rcpt_ty_cd            TEXT,
      pmt_ty_cd             TEXT,
      sales_dt              TEXT,
      stock_rls_dt          TEXT,
      tot_item_cnt          INTEGER,
      tot_taxbl_amt         REAL,
      tot_tax_amt           REAL,
      tot_amt               REAL,
      raw_json              TEXT,
      status                TEXT NOT NULL DEFAULT 'NEW',
      approved_pchs_invc_no INTEGER,
      error                 TEXT,
      pulled_at             TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at            TEXT,
      decided_by            INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ix_zra_pending_purchases_dedup
      ON zra_pending_purchases(spplr_tpin, spplr_invc_no)
      WHERE spplr_tpin IS NOT NULL AND spplr_invc_no IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_zra_pending_purchases_status
      ON zra_pending_purchases(status);
  `);

  // v1.13.77 — Buyer TPIN on customer records + captured per order.
  //   customers.tpin       — persistent B2B customer TPIN (10-digit).
  //   orders.customer_tpin — snapshot taken at sale time so the fiscal
  //                          receipt stays accurate even if the master
  //                          record is edited later. Walk-in sales fall
  //                          back to ZRA's '1000000000' at receipt time.
  addCol('customers', 'tpin',              'TEXT');
  addCol('orders',    'customer_tpin',     'TEXT');
  // v1.13.137 — supplier TPIN. Populated by /api/zra/purchases/:id/approve
  // (find-or-create supplier from a pulled VSDC purchase) and read by
  // routes/grn.js when a GRN fires savePurchase to VSDC. Without it the
  // approve endpoint 500s with "no such column: tpin" — surfaced during
  // §5.11 UAT-2 walkthrough.
  addCol('suppliers', 'tpin',              'TEXT');
  // v1.13.101 — snapshot the customer's address at sale time so the
  // ZRA tax invoice can print it (Part B Q4(vi) requires "customer's
  // name and address"). Walk-in sales (no customer_id) leave this
  // NULL and the receipt renders no address line.
  addCol('orders',    'customer_address',  'TEXT');
  // v1.13.101 — T11A offline-block toggle. When 1 AND zra_enabled=1,
  // POST /orders pre-flights VSDC connectivity and rejects the sale
  // with 503 if VSDC is unreachable. Default OFF (0) preserves the
  // existing provisional-receipt behaviour. Toggle to 1 during ZRA
  // UAT so the T11A test — which expects "invoice should not be
  // created on the CIS" when VSDC is offline — passes strictly.
  //
  // v1.13.141 — DEFAULT flipped 0 → 1. Compliance is not optional:
  // every tenant now boots with strict blocking on. UI toggle removed
  // in ZraConfig.js so no one can disable it. Existing tenants that
  // pre-date this bump keep their prior value (addCol only sets DEFAULT
  // on new rows); backfill script below is the one-shot fix for those.
  addCol('business_settings', 'zra_block_offline_sales', 'INTEGER NOT NULL DEFAULT 1');
  // v1.13.153 — HQ has no VSDC device of its own by default (Pattern A
  // decision). The T06A purchase-pull endpoints (pull/list/approve/
  // reject in routes/zra.js) need SOME live device to talk to ZRA on
  // Red Sea's behalf when the calling tenant (usually HQ) has none.
  // This column names which branch tenant to proxy through — a plain
  // "phone line" to ZRA (the pulled data is TPIN-scoped, not
  // branch-owned, so proxying doesn't misattribute anything). Default
  // 'garden' matches what's actually been tested; clear it (empty
  // string / NULL) once/if HQ registers its own device directly — the
  // resolver in routes/zra.js checks the calling tenant's own device
  // first and only falls back to this column when that's absent.
  // 2026-09-02 — default was 'garden'. Every branch was born pointing at
  // Garden as its VSDC proxy without anyone choosing it, which would have
  // signed an Electron till's sales with Garden's sandbox device. Only
  // read when the VSDC URL is a proxy URL, so it was invisible. Existing
  // databases keep their value until updated; this is for new ones.
  addCol('business_settings', 'zra_proxy_branch_slug', "TEXT NOT NULL DEFAULT ''");

  // 2026-08-27 — shared secret for the VSDC proxy (see routes/zra.js
  // POST /vsdc-proxy/*). An Electron till has no Tomcat, so it reaches
  // VSDC through the VPS; but vsdcClient is machine-to-machine — it
  // fires during a sale and carries no user session — so the proxy
  // cannot sit behind the normal `auth` middleware. It authenticates on
  // this per-tenant secret instead.
  //
  // Generated on first boot so no deployment ships a predictable value.
  // Both sides read the SAME branch row: the VPS validates it, and an
  // Electron install receives it through the existing settings sync.
  addCol('business_settings', 'zra_proxy_secret', 'TEXT');
  try {
    const needs = db.prepare(
      `SELECT id FROM business_settings
        WHERE zra_proxy_secret IS NULL OR zra_proxy_secret = ''`
    ).all();
    if (needs.length) {
      const gen = require('crypto').randomBytes(32).toString('hex');
      const upd = db.prepare('UPDATE business_settings SET zra_proxy_secret = ? WHERE id = ?');
      for (const r of needs) upd.run(gen, r.id);
    }
  } catch (_) { /* fresh DB — column just created, nothing to seed yet */ }
  // 2026-08-28 — the one-shot backfill that used to live here was NOT
  // one-shot. It ran on every boot, so it re-enabled the toggle every
  // time the app started and the operator's choice never survived a
  // restart (Electron carries its own backend, so that is every launch).
  // UAT-2 is approved; the DEFAULT 1 above already gives new installs
  // strict blocking, so only rows that were NEVER set need seeding.
  try {
    db.prepare("UPDATE business_settings SET zra_block_offline_sales = 1 WHERE zra_block_offline_sales IS NULL").run();
  } catch (_) { /* column not populated yet — fresh DB, ignore */ }
  // v1.13.82 — link an approved ZRA purchase back to the draft GRN
  // auto-created by /api/zra/purchases/:id/approve.
  addCol('zra_pending_purchases', 'grn_id',        'INTEGER');
  addCol('zra_pending_purchases', 'grn_number',    'TEXT');
  addCol('zra_pending_purchases', 'match_summary', 'TEXT');
  // v1.13.139 — approve now creates an HQ Purchase (master.db
  // hq_purchases + hq_purchase_items) instead of a Flow-B DRAFT_ZRA
  // GRN, so the ZRA-pulled invoice enters Red Sea's normal 3-step
  // workflow (Branch submits GRN → HQ confirms → stock bumps + ZRA
  // stock chain fires). These columns cross-reference the created HQ
  // purchase so the UI can badge / link back to it.
  addCol('zra_pending_purchases', 'hq_purchase_id',     'INTEGER');
  addCol('zra_pending_purchases', 'hq_purchase_number', 'TEXT');

  // 2026-08-26 — Supplier item mapping for the ZRA Purchase Queue.
  //
  // A supplier's ZRA item codes belong to THEIR TPIN, not ours: Chambishi
  // sends ZM2BGU23755 for a product we carry as ZM2NTBX0000023. The two
  // namespaces never coincide, so the approve handler's "match on
  // zra_item_cd, else match on name" heuristic essentially never hits —
  // every line fell through to auto-create, quietly filling the catalogue
  // with duplicate products under the supplier's own naming.
  //
  // This table is the operator's decision, remembered. Map a supplier's
  // code to one of our products once and every future invoice from that
  // supplier matches it automatically.
  //
  // Keyed on (spplr_tpin, spplr_item_cd) — scoped per supplier, because
  // two suppliers' codes for the same physical product are unrelated.
  //
  // action: 'MAP'    — spplr_item_cd is our product_sync_id
  //         'CREATE' — always bring in as a new product
  //         'IGNORE' — never bring this line onto a PO
  // Storing CREATE/IGNORE (not just MAP) means a deliberate "this really
  // is new" or "never import this" decision is also remembered, instead
  // of re-prompting on every delivery.
  db.exec(`
    CREATE TABLE IF NOT EXISTS zra_supplier_item_map (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      spplr_tpin      TEXT NOT NULL,
      spplr_item_cd   TEXT NOT NULL,
      spplr_item_nm   TEXT,
      action          TEXT NOT NULL DEFAULT 'MAP',
      product_sync_id TEXT,
      product_name    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      created_by      INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ix_zra_supplier_item_map_key
      ON zra_supplier_item_map(spplr_tpin, spplr_item_cd);
  `);

  // 2026-08-30 — remember which LOCAL supplier a ZRA supplier is, the same way
  // zra_supplier_item_map remembers items.
  //
  // A pulled purchase carries only the supplier's TPIN and their registered
  // name. hqGrns.js resolves the supplier for a GRN by exact name match
  // against the local suppliers table, so a ZRA name with no local counterpart
  // silently produces a GRN with no supplier link — which lands in AP as an
  // orphan with a name but nothing to reconcile against.
  //
  // Keyed on TPIN, not name: the TPIN is the supplier's identity at ZRA and
  // does not change when they alter their registered trading name.
  db.exec(`
    CREATE TABLE IF NOT EXISTS zra_supplier_map (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      spplr_tpin       TEXT NOT NULL,
      spplr_nm         TEXT,
      action           TEXT NOT NULL DEFAULT 'MAP',   -- MAP (matched existing) | CREATE (we made it)
      supplier_id      INTEGER,
      supplier_sync_id TEXT,
      supplier_name    TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
      created_by       INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ix_zra_supplier_map_key
      ON zra_supplier_map(spplr_tpin);
  `);

  // 2026-08-26 (T05A) — Cache for /imports/selectImportItems pulls.
  //   Deliberately mirrors zra_pending_purchases above so the Import
  //   Queue page behaves identically to the ZRA Purchase Queue: pull to
  //   a local queue, inspect, decide, and let stock land only when the
  //   goods physically arrive via the normal GRN workflow.
  //
  //   TWO DIFFERENCES from the purchase queue, both forced by the spec:
  //
  //   1. A reject is NOT local-only. ZRA is *waiting* on our decision for
  //      an import declaration, so BOTH approve and reject must be
  //      transmitted via /imports/updateImportItems (imptItemSttsCd
  //      '3' = approved, '4' = rejected). Contrast the purchase queue,
  //      where ZRA already holds the supplier's side and a reject is
  //      pure bookkeeping.
  //   2. Quantity is editable. T05A Test Procedure step 3 — "the user
  //      updates the quantities accordingly" — the declared customs qty
  //      may differ from what physically arrived, so approved_qty is
  //      stored per line alongside the declared qty.
  //
  //   Granularity: ZRA returns import declarations as a flat item list,
  //   each row keyed by (taskCd, dclNo, itemSeq) — there is no invoice
  //   header to group by, so one row here is one declared ITEM, not one
  //   document. Dedup is on that triple.
  db.exec(`
    CREATE TABLE IF NOT EXISTS zra_pending_imports (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      task_cd             TEXT,
      dcl_de              TEXT,
      dcl_no              TEXT,
      item_seq            INTEGER,
      hs_cd               TEXT,
      item_cd             TEXT,
      item_cls_cd         TEXT,
      item_nm             TEXT,
      orgn_nat_cd         TEXT,
      expt_nat_cd         TEXT,
      pkg                 REAL,
      pkg_unit_cd         TEXT,
      qty                 REAL,
      qty_unit_cd         TEXT,
      tot_wt              REAL,
      net_wt              REAL,
      spplr_nm            TEXT,
      agnt_nm             TEXT,
      invc_fcur_amt       REAL,
      invc_fcur_cd        TEXT,
      invc_fcur_excrt     REAL,
      dcl_ref_num         TEXT,
      impt_item_stts_cd   TEXT,
      raw_json            TEXT,
      status              TEXT NOT NULL DEFAULT 'NEW',
      approved_qty        REAL,
      destination_slug    TEXT,
      destination_name    TEXT,
      hq_purchase_id      INTEGER,
      hq_purchase_number  TEXT,
      match_summary       TEXT,
      error               TEXT,
      pulled_at           TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at          TEXT,
      decided_by          INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ix_zra_pending_imports_dedup
      ON zra_pending_imports(task_cd, dcl_no, item_seq)
      WHERE task_cd IS NOT NULL AND item_seq IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_zra_pending_imports_status
      ON zra_pending_imports(status);
  `);

  // v1.13.72 — Recommended Retail Price for MTV items (vatCatCd='B').
  // ZRA declares an RRP per SKU (usually via the manufacturer, e.g.
  // Zambian Breweries). Kelete may sell BELOW RRP; when they do, VSDC
  // needs VAT computed on MAX(actual_price, rrp) so the manufacturer's
  // declared minimum tax gets collected. Value stored VAT-inclusive to
  // match how the source data (ZB invoices + till receipts) presents it.
  // NULL / 0 means "no RRP set" and the standard price-based VAT applies.
  addCol('products', 'zra_rrp',           'REAL');

  // 2026-09-02 — the manufacturer's own item code for this SKU.
  //
  // ZRA's /items/selectRrpItems returns RRPs keyed by the MANUFACTURER's
  // item code, not ours: Varun files "AQUACLEAR PET 500ML/12", we sell the
  // same thing as RS041. The sync joins on COALESCE(zra_item_cd, code) and
  // therefore matched nothing - 580 RRPs pulled, 0 applied, confirmed on
  // sandbox 2026-09-02.
  //
  // Filling this once, from a human-checked mapping, makes every later sync
  // automatic. Without it the RRPs already in zra_rrp are frozen at whatever
  // was typed in, and any manufacturer price rise since is under-declared
  // silently - see the note on zra_rrp above for why that matters.
  addCol('products', 'zra_mfr_item_cd', 'TEXT');
  addCol('products', 'zra_use_yn',        "TEXT NOT NULL DEFAULT 'Y'");
  addCol('products', 'zra_registered_at', 'TEXT');   // when saveItem returned 000
  addCol('products', 'zra_last_error',    'TEXT');

  // ── Fiscal fields on orders (sales invoices) ──
  // cis_invc_no is what WE send; rcpt_no is what VSDC assigns and is the
  // permanent fiscal reference (used as orgIncNo on later credit notes).
  addCol('orders', 'zra_cis_invc_no',        'INTEGER');
  addCol('orders', 'zra_rcpt_no',            'INTEGER');
  addCol('orders', 'zra_intrl_data',         'TEXT');
  addCol('orders', 'zra_rcpt_sign',          'TEXT');
  addCol('orders', 'zra_sdc_id',             'TEXT');
  addCol('orders', 'zra_mrc_no',             'TEXT');
  addCol('orders', 'zra_vsdc_rcpt_pbct_date','TEXT');
  addCol('orders', 'zra_qr_code_url',        'TEXT');
  addCol('orders', 'zra_currency_ty_cd',     "TEXT DEFAULT 'ZMW'");
  addCol('orders', 'zra_exchange_rt',        'REAL DEFAULT 1');
  addCol('orders', 'zra_status',             "TEXT NOT NULL DEFAULT 'PENDING'"); // PENDING | SIGNED | FAILED | SKIPPED
  // 2026-08-28 — WHY a fiscalisation failed, not just that it did.
  // 'OFFLINE'  = nothing answered; the retry queue will fix it, wait.
  // 'SETTINGS' = ZRA answered and refused, or the address/credentials are
  //              wrong. Retrying cannot help — someone must correct the
  //              ZRA settings on this machine. The receipt says so.
  addCol('orders', 'zra_error_kind',         'TEXT');

  // 2026-08-28 — rescue stock movements orphaned by the HQ GRN bug.
  //
  // GRN confirmations written at HQ stamped tenant_id NULL (they read it from
  // hq_grns, which has no such column). The branch pull filters
  // `WHERE tenant_id = ?` and NULL never matches, so those movements sat on
  // the server invisible to the branch that owned them: correct stock number,
  // missing line on the Bin Card.
  //
  // Every row in a tenant DB belongs to that tenant by definition, so the id
  // is recoverable. updated_at is bumped so the rows travel on the next
  // incremental pull rather than waiting for a full resync.
  try {
    const own = db.prepare(
      'SELECT tenant_id FROM business_settings WHERE tenant_id IS NOT NULL LIMIT 1'
    ).get()?.tenant_id;
    if (own) {
      const orphans = db.prepare(
        'SELECT COUNT(*) AS n FROM stock_movements WHERE tenant_id IS NULL'
      ).get().n;
      if (orphans > 0) {
        db.prepare(
          `UPDATE stock_movements
              SET tenant_id  = ?,
                  updated_at = datetime('now')
            WHERE tenant_id IS NULL`
        ).run(own);
        console.log(`[migration] adopted ${orphans} orphaned stock_movements into tenant ${own}`);
      }
    }
  } catch (_) { /* table or column not present yet */ }
  addCol('orders', 'zra_error_code',         'TEXT');
  addCol('orders', 'zra_error_message',      'TEXT');
  addCol('orders', 'zra_last_attempt_at',    'TEXT');
  addCol('orders', 'zra_retry_count',        'INTEGER NOT NULL DEFAULT 0');
  // 2026-08-27 — the sale response no longer waits for the ZRA stock
  // chain (saveStockItems + saveStockMaster): only saveSales produces the
  // signature and QR the receipt needs, so making the cashier wait for
  // the other two roughly doubled time-to-print for no benefit.
  //
  // Deferring it opens a window: if the process dies between responding
  // and finishing the chain, the sale is SIGNED but its stock never
  // reaches ZRA — and nothing retries a stock chain for an already-signed
  // order. This flag closes that. Set when the chain completes; the retry
  // queue sweeps signed orders still missing it.
  //
  // Backfilled to 1 for existing signed orders: they were fiscalised
  // under the old synchronous path, so their chain already ran and must
  // not be re-sent (a duplicate stock movement would overstate ZRA's
  // ledger).
  addCol('orders', 'zra_stock_chain_done',  'INTEGER NOT NULL DEFAULT 0');
  try {
    db.prepare(
      `UPDATE orders SET zra_stock_chain_done = 1
        WHERE zra_status = 'SIGNED' AND COALESCE(zra_stock_chain_done, 0) = 0`
    ).run();
  } catch (_) { /* fresh DB — nothing to backfill */ }
  // Sale-type qualifier for reprints. VSDC sees the same invoice as a
  // "COPY" (salesTyCd=C) instead of a duplicate original.
  addCol('orders', 'zra_reprint_count',      'INTEGER NOT NULL DEFAULT 0');

  // LPO (Local Purchase Order) invoicing — T08A #6. When set, every line
  // on this sale is treated as vatCatCd='C2' (zero-rated LPO) regardless
  // of the product's declared category, and the LPO number rides on the
  // header lpoNumber field for ZRA cross-verification against TaxOnline.
  // A valid LPO number requires (seller TPIN, buyer TPIN, lpoNumber) to
  // match a live LPO certificate — sandbox test data uses 109506957.
  addCol('orders', 'lpo_number',             'TEXT');

  // v1.13.100 — Credit-note fiscal fields on the same order row (T08A
  // #13/14). When /reverse or /:id/items/:itemId/reverse fires a
  // rcptTyCd='R' saveSales, ZRA hands back a NEW receipt (rcptNo,
  // intrlData, rcptSign, qrCodeUrl, sdcId, vsdcRcptPbctDate) that must
  // be preserved so the CN can be reprinted with its own fiscal
  // signature — not the original sale's. Earlier revisions passed
  // skipOrderPersist=true and threw the response away, which means
  // Kelete had no fiscal proof of the reversal at all. Multiple partial
  // reversals overwrite these fields with the latest CN; that's a
  // conscious trade-off — the tester will only issue one CN per order
  // during T08A, and stacking-history isn't a documented ZRA
  // requirement. If it becomes one, migrate to sales_returns rows.
  addCol('orders', 'zra_cn_cis_invc_no',        'INTEGER');
  addCol('orders', 'zra_cn_rcpt_no',            'INTEGER');
  addCol('orders', 'zra_cn_intrl_data',         'TEXT');
  addCol('orders', 'zra_cn_rcpt_sign',          'TEXT');
  addCol('orders', 'zra_cn_sdc_id',             'TEXT');
  addCol('orders', 'zra_cn_mrc_no',             'TEXT');
  addCol('orders', 'zra_cn_vsdc_rcpt_pbct_date','TEXT');
  addCol('orders', 'zra_cn_qr_code_url',        'TEXT');
  addCol('orders', 'zra_cn_rfd_rsn_cd',         'TEXT'); // 01–07 per spec 6.15
  // v1.13.136 — Free-text description required when zra_cn_rfd_rsn_cd = '07'.
  // ZRA VSDC spec §6.15 wording: "Other (Provide other reason in brief)".
  // Rendered on the CN receipt as "Reason: 07 — Other (<brief>)". NULL when
  // reason is 01–06 (label alone suffices). Not sent to VSDC — kept local
  // for audit + receipt display.
  addCol('orders', 'zra_cn_rfd_rsn_other',      'TEXT');
  addCol('orders', 'zra_cn_signed_at',          'TEXT');
  // v1.13.136 — Local CN display number for non-fiscal reversals (ZRA off).
  // Format like "CN-2026-A5C013-0197" — generated via syncConfig.generateNumber
  // on the reverse route when the original sale was not fiscal-signed. Read by
  // the CN receipt template to render a proper "Credit Note No." line even
  // without a ZRA fiscal signature. Lets Buseko (ZRA off during UAT-1)
  // produce a compliant-looking CN with a distinct number that does not
  // reuse the original invoice number. NULL when ZRA is on — the CN gets
  // its number from zra_cn_rcpt_no (VSDC-returned CRN) instead.
  addCol('orders', 'local_cn_number',           'TEXT');
  // v1.13.124 — mark when the CN was first printed. Subsequent prints
  // add a "COPY / DUPLICATE" band above the "TAX CREDIT NOTE" band so
  // ZRA Attachment 4 (Duplicate CN) is visually distinguishable from
  // Attachment 3 (Original CN). Kept on orders row (not a separate
  // table) so it syncs to Electron via the normal sync path.
  addCol('orders', 'cn_first_printed_at',       'TEXT');

  // Same fiscal fields on sales_returns (credit notes go through saveSales
  // with rcptTyCd=R + orgIncNo referencing orders.zra_rcpt_no).
  addCol('sales_returns', 'zra_cis_invc_no',        'INTEGER');
  addCol('sales_returns', 'zra_rcpt_no',            'INTEGER');
  addCol('sales_returns', 'zra_intrl_data',         'TEXT');
  addCol('sales_returns', 'zra_rcpt_sign',          'TEXT');
  addCol('sales_returns', 'zra_sdc_id',             'TEXT');
  addCol('sales_returns', 'zra_qr_code_url',        'TEXT');
  addCol('sales_returns', 'zra_org_incc_no',        'INTEGER'); // orgIncNo — the original invoice's rcptNo
  addCol('sales_returns', 'zra_org_sdc_id',         'TEXT');
  addCol('sales_returns', 'zra_rfd_rsn_cd',         'TEXT');    // 01–07 (see spec 6.15)
  addCol('sales_returns', 'zra_status',             "TEXT NOT NULL DEFAULT 'PENDING'");
  addCol('sales_returns', 'zra_error_code',         'TEXT');
  addCol('sales_returns', 'zra_error_message',      'TEXT');

  // Purchase fiscal fields on GRN — VSDC's savePurchase (regTyCd=M for
  // non-VSDC suppliers, or approve rows from selectTrnsPurchaseSales).
  addCol('grn', 'zra_pchs_invc_no',   'INTEGER');
  addCol('grn', 'zra_spplr_tpin',     'TEXT');
  addCol('grn', 'zra_spplr_bhf_id',   'TEXT');
  addCol('grn', 'zra_reg_ty_cd',      "TEXT DEFAULT 'M'"); // M = manual (non-VSDC supplier)
  addCol('grn', 'zra_pchs_sts_cd',    'TEXT');             // 01/02/04 approve/reject
  addCol('grn', 'zra_status',         "TEXT NOT NULL DEFAULT 'PENDING'");
  addCol('grn', 'zra_error_code',     'TEXT');
  addCol('grn', 'zra_error_message',  'TEXT');

  // ── Debit Notes ────────────────────────────────────────────────────────
  // v1.13.38 — post-sale ADDITIONAL charge tied to an original invoice.
  // Mirrors the credit-note (reverse) shape but adds money the customer
  // owes instead of refunding. VSDC saveSales with rcptTyCd='D' and
  // orgIncNo/orgSdcId back-referencing the original invoice.
  //
  // Reason codes (ZRA spec 6.16 — same list as credit notes):
  //   01 wrong product · 02 wrong price · 03 damaged · 04 wrong customer
  //   05 duplicate     · 06 excess      · 07 other
  //
  // For the distributor case the common trigger is "we forgot to bill
  // the delivery fee" or "the item was more expensive than invoiced".
  // Kept monetary-only for v1 — the ZRA payload uses a single synthetic
  // "Additional charge" line at std VAT. Physical-item DNs can be layered
  // on later without changing the schema.
  db.exec(`
    CREATE TABLE IF NOT EXISTS debit_notes (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id             TEXT UNIQUE NOT NULL,
      dn_number           TEXT NOT NULL,
      date                TEXT NOT NULL DEFAULT (date('now')),
      orig_order_id       INTEGER,
      orig_order_sync_id  TEXT,
      orig_order_number   TEXT,
      customer_id         INTEGER,
      customer_name       TEXT,
      amount              REAL NOT NULL DEFAULT 0,
      reason_cd           TEXT NOT NULL,
      notes               TEXT,
      created_by          INTEGER,
      created_by_name     TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at          TEXT,
      tenant_id           TEXT,
      branch_id           TEXT,
      device_id           TEXT,
      synced              INTEGER NOT NULL DEFAULT 0,
      -- ZRA fiscal fields (same shape as sales_returns)
      zra_cis_invc_no     INTEGER,
      zra_rcpt_no         INTEGER,
      zra_intrl_data      TEXT,
      zra_rcpt_sign       TEXT,
      zra_sdc_id          TEXT,
      zra_mrc_no          TEXT,
      zra_vsdc_rcpt_pbct_date TEXT,
      zra_qr_code_url     TEXT,
      zra_org_incc_no     INTEGER,
      zra_org_sdc_id      TEXT,
      zra_dbt_rsn_cd      TEXT,
      zra_status          TEXT NOT NULL DEFAULT 'PENDING',
      zra_error_code      TEXT,
      zra_error_message   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_debit_notes_orig ON debit_notes (orig_order_id);
    CREATE INDEX IF NOT EXISTS idx_debit_notes_date ON debit_notes (date);
  `);

  // v1.13.62 — Customer-side empties ledger.
  //   Audit trail of every event that moved a customer's empty_balance:
  //     order_id NOT NULL, kind='sale'          → happened on a POS sale
  //     order_id IS  NULL, kind='pure_return'   → Case 4 standalone slip
  //   qty is signed:
  //     + credit added to customer (returned more than kept)
  //     − credit drawn (customer used up prior credit to reduce a shortfall)
  //   Not money — never touches AR / Cash Book / Sales Report.
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_empty_returns (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id           TEXT UNIQUE NOT NULL,
      customer_id       INTEGER NOT NULL,
      customer_sync_id  TEXT,
      customer_name     TEXT,
      kind              TEXT NOT NULL DEFAULT 'sale',   -- 'sale' | 'pure_return' | 'adjustment'
      qty               INTEGER NOT NULL,               -- signed; see above
      order_id          INTEGER,                        -- nullable — set when kind='sale'
      order_sync_id     TEXT,
      order_number      TEXT,
      balance_after     INTEGER NOT NULL,               -- customer.empty_balance right after this row landed
      notes             TEXT,
      created_by        INTEGER,
      created_by_name   TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at        TEXT,
      tenant_id         TEXT,
      branch_id         TEXT,
      device_id         TEXT,
      synced            INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_cust_empty_returns_cust ON customer_empty_returns (customer_id);
    CREATE INDEX IF NOT EXISTS idx_cust_empty_returns_order ON customer_empty_returns (order_id);
  `);

  // v1.13.67 — Bearer voucher system for empty containers.
  //   Replaces the customers.empty_balance flow (v1.13.62). Anyone can
  //   return empties at the Controller station — no customer registration
  //   required. The Controller issues an EMP- voucher with the qty;
  //   whoever holds the physical slip can redeem it at POS.
  //
  //   Sales Report + Cash Book are NEVER touched by this table — empties
  //   are physical stock, not money.
  //
  //   Partial redemption is supported: qty_remaining drops per claim;
  //   status flips to CLAIMED when it reaches 0. A voucher can be
  //   VOIDed by admin (lost slip, dispute) without affecting past claims.
  db.exec(`
    CREATE TABLE IF NOT EXISTS empty_vouchers (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_number      TEXT UNIQUE NOT NULL,     -- EMP-YYYY-DEVICEID-NNNNNN
      sync_id             TEXT UNIQUE NOT NULL,
      qty_original        INTEGER NOT NULL,         -- empties returned when issued
      qty_remaining       INTEGER NOT NULL,         -- drops on claim; 0 = fully used
      issued_to_name      TEXT,                     -- optional; printed on slip
      issued_to_phone     TEXT,                     -- optional
      notes               TEXT,
      status              TEXT NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | CLAIMED | VOID
      issued_at           TEXT NOT NULL DEFAULT (datetime('now')),
      issued_by           INTEGER,
      issued_by_name      TEXT,
      void_reason         TEXT,
      void_at             TEXT,
      void_by             INTEGER,
      void_by_name        TEXT,
      created_at          TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at          TEXT,
      tenant_id           TEXT,
      branch_id           TEXT,
      device_id           TEXT,
      synced              INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_empty_vouchers_status ON empty_vouchers (status);
    CREATE INDEX IF NOT EXISTS idx_empty_vouchers_number ON empty_vouchers (voucher_number);

    -- v1.13.155 — duplicate-sale review. A pair of sales is flagged when the
    -- items, quantities, total and cashier all match and they are seconds
    -- apart; INV-0067 and INV-0068 at Chawama were 6 seconds apart with an
    -- identical basket. The cause is a checkout that saved but whose response
    -- was lost: the till says "Checkout failed", the cart is deliberately kept
    -- so a real failure does not lose the basket, and the cashier presses Pay
    -- again.
    --
    -- This table records ONLY that a human looked at a pair and judged it
    -- fine. It reverses nothing, deletes nothing and moves no money — both
    -- sales stay exactly as they are. It exists so the same pair stops being
    -- raised tomorrow.
    --
    -- pair_key is the two order sync_ids sorted and joined, so the same pair
    -- produces the same key whichever order they arrive in.
    CREATE TABLE IF NOT EXISTS order_duplicate_dismissals (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      pair_key          TEXT UNIQUE NOT NULL,
      order_a_sync_id   TEXT NOT NULL,
      order_b_sync_id   TEXT NOT NULL,
      order_a_number    TEXT,
      order_b_number    TEXT,
      dismissed_by      INTEGER,
      dismissed_by_name TEXT,
      note              TEXT,
      sync_id           TEXT,
      tenant_id         TEXT,
      branch_id         TEXT,
      device_id         TEXT,
      deleted_at        TEXT,
      synced            INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dup_dismiss_pair ON order_duplicate_dismissals (pair_key);

    CREATE TABLE IF NOT EXISTS empty_voucher_claims (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_id             TEXT UNIQUE NOT NULL,
      voucher_id          INTEGER NOT NULL,
      voucher_sync_id     TEXT,
      voucher_number      TEXT,
      order_id            INTEGER,                  -- nullable when claim is standalone (rare)
      order_sync_id       TEXT,
      order_number        TEXT,
      qty_claimed         INTEGER NOT NULL,
      notes               TEXT,
      claimed_at          TEXT NOT NULL DEFAULT (datetime('now')),
      claimed_by          INTEGER,
      claimed_by_name     TEXT,
      tenant_id           TEXT,
      branch_id           TEXT,
      device_id           TEXT,
      synced              INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_empty_voucher_claims_voucher ON empty_voucher_claims (voucher_id);
    CREATE INDEX IF NOT EXISTS idx_empty_voucher_claims_order   ON empty_voucher_claims (order_id);
  `);

  // 2026-08-31 — which empty this voucher is for. Placed HERE, immediately
  // after empty_vouchers is created, not up with the other addCol calls: the
  // table does not exist at that point in this file, so a fresh tenant DB
  // failed to build at all.
  //
  // The empties flow assumed ONE empty product, named in
  // business_settings.empty_container_product_sync_id. Real stock is not like
  // that: EMPTY ZB, EMPTY 500ML and an empty crate are different products with
  // different stock, and whichever was named absorbed every voucher while the
  // rest never moved.
  addCol('empty_vouchers', 'product_sync_id', 'TEXT');
  addCol('empty_vouchers', 'product_name',    'TEXT');

  // ── ZRA code cache tables ──
  // Populated by daily cron pulls from /code/selectCodes and
  // /itemClass/selectItemsClass. Local cache so the POS never round-trips
  // to VSDC just to render a dropdown. Large — expect ~40k rows in
  // zra_item_classes (UNSPSC), a few hundred in zra_codes.
  db.exec(`
    CREATE TABLE IF NOT EXISTS zra_codes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      cd_cls      TEXT NOT NULL,          -- code class, e.g. "07" tax type
      cd          TEXT NOT NULL,          -- code value, e.g. "A"
      cd_nm       TEXT,                   -- code label
      cd_desc     TEXT,
      use_yn      TEXT NOT NULL DEFAULT 'Y',
      user_dfn_cd1 TEXT, user_dfn_cd2 TEXT, user_dfn_cd3 TEXT,
      srt_ord     INTEGER,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(cd_cls, cd)
    );
    CREATE INDEX IF NOT EXISTS idx_zra_codes_cls ON zra_codes (cd_cls);

    CREATE TABLE IF NOT EXISTS zra_item_classes (
      item_cls_cd  TEXT PRIMARY KEY,       -- UNSPSC 8-digit
      item_cls_nm  TEXT NOT NULL,
      item_cls_lvl INTEGER,                -- 1=segment, 2=family, 3=class, 4=commodity
      tax_ty_cd    TEXT,                   -- default vatCatCd for this class
      mjr_tg_yn    TEXT,                   -- major target Y/N
      use_yn       TEXT NOT NULL DEFAULT 'Y',
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_zra_item_classes_lvl ON zra_item_classes (item_cls_lvl);
    CREATE INDEX IF NOT EXISTS idx_zra_item_classes_nm  ON zra_item_classes (item_cls_nm);

    CREATE TABLE IF NOT EXISTS zra_notices (
      notice_no  INTEGER PRIMARY KEY,
      title      TEXT,
      cont       TEXT,
      dtl_url    TEXT,
      reg_dt     TEXT,
      inserted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-endpoint 'lastReqDt' bookmark so incremental sync only pulls new rows.
    CREATE TABLE IF NOT EXISTS zra_sync_state (
      endpoint     TEXT PRIMARY KEY,      -- e.g. '/code/selectCodes'
      last_req_dt  TEXT NOT NULL,         -- yyyyMMddHHmmss (spec format)
      last_pulled_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_result_cd TEXT,
      last_error   TEXT
    );

    -- Every VSDC call is logged for the audit trail (checklist item 32).
    -- Retained forever; queryable from an admin diagnostics page.
    CREATE TABLE IF NOT EXISTS zra_audit_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint     TEXT NOT NULL,
      cis_invc_no  INTEGER,               -- when applicable (sales/purchase)
      request_body TEXT,                  -- JSON
      response_body TEXT,                 -- JSON
      result_cd    TEXT,                  -- '000' ok, else error code
      result_msg   TEXT,
      http_status  INTEGER,
      duration_ms  INTEGER,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_zra_audit_cis     ON zra_audit_log (cis_invc_no);
    CREATE INDEX IF NOT EXISTS idx_zra_audit_created ON zra_audit_log (created_at);
    CREATE INDEX IF NOT EXISTS idx_zra_audit_result  ON zra_audit_log (result_cd);
  `);

  // v1.6.0 — Categories, main_categories and units are also HQ-owned now.
  // Same mechanism as products: HQ writes push to every branch with
  // is_hq_owned=1; branches can't edit/delete those rows.
  addCol('categories',      'is_hq_owned', 'INTEGER NOT NULL DEFAULT 0');
  addCol('main_categories', 'is_hq_owned', 'INTEGER NOT NULL DEFAULT 0');
  addCol('units',           'is_hq_owned', 'INTEGER NOT NULL DEFAULT 0');

  // v1.7.0 — Triple currency (USD + FRA + K). Adds a parallel set of K
  // columns to fx_rates + orders, mirroring the FRA columns from v1.4.0
  // / v1.0. K is a foreign-cash currency the cashier may accept; items
  // stay priced in USD (base). currency_mode='USD+FRA+K' enables it
  // (existing 'K' single-currency mode and 'USD+FRA' dual mode are
  // unchanged).
  addCol('fx_rates', 'sell_rate_k', 'REAL');
  addCol('fx_rates', 'buy_rate_k',  'REAL');
  // v1.8.2: rate intra-day timestamps. Rates can change multiple times in
  // one day (typical Kelete street-rate cadence). effective_at stores the
  // exact moment the rate becomes active so the Cashier picks the right
  // one based on the order's created_at, and the chart can plot intra-day.
  addCol('fx_rates', 'effective_at', 'TEXT'); // SQLite DATETIME (YYYY-MM-DD HH:MM:SS)

  // v1.8.82 — TZ FIX self-heal: previously effective_at was stored as the
  // user's LOCAL time string but compared against SQLite datetime('now')
  // (UTC) in /current. Any row whose effective_at is > current UTC NOW is
  // a misstored local-time value (no one legitimately back-sets future
  // effective times in practice).
  //
  // v1.8.81's heal tried to convert local→UTC using new Date() — but on a
  // UTC server that's a no-op (server tz == UTC means the conversion adds
  // nothing). So those rows stayed broken.
  //
  // v1.8.82's heal: snap any future row to datetime('now') so it's effective
  // immediately. Loses the original sub-minute precision but unblocks the
  // Cashier right away. New rates from v1.8.82+ frontend send UTC directly,
  // so this heal only ever runs on legacy rows.
  try {
    const result = db.prepare(`
      UPDATE fx_rates
         SET effective_at = datetime('now'),
             synced       = 0,
             updated_at   = datetime('now')
       WHERE deleted_at IS NULL
         AND effective_at IS NOT NULL
         AND effective_at > datetime('now')
    `).run();
    if (result.changes > 0) {
      console.log(`[self-heal fx_rates effective_at] snapped ${result.changes} future row(s) to NOW (legacy local-time storage)`);
    }
  } catch (e) { /* fresh DB or fx_rates table not yet present */ }
  addCol('orders',   'k_received',         'REAL DEFAULT 0');
  addCol('orders',   'k_change_given',     'REAL DEFAULT 0');
  addCol('orders',   'selling_rate_k_used','REAL');
  addCol('orders',   'buying_rate_k_used', 'REAL');

  // v1.8.68 — split phantom-debt change_amount into per-currency tracking.
  // BEFORE: change_amount stored USD-equivalent of every over-payment, even
  // when the over-payment was paid in FRA/K. Cash Report subtracted it from
  // the USD drawer → phantom surplus on USD when customer overpaid in FRA.
  // AFTER: usd_change_given holds ONLY physical USD returned. overpaid_kept_*
  // captures over-payments the cashier kept in the original currency.
  addCol('orders',   'usd_change_given',   'REAL NOT NULL DEFAULT 0');
  addCol('orders',   'overpaid_kept_ccy',  'TEXT');   // 'USD' | 'FRA' | 'K' | NULL
  addCol('orders',   'overpaid_kept_amt',  'REAL NOT NULL DEFAULT 0'); // in source ccy

  // v1.13.128 — ZRA branch-registry sync tracking for users + customers.
  // Mirrors the products.zra_registered_at / zra_last_error pattern so
  // /branches/saveBrancheUser + /branches/saveBrancheCustomers can record
  // "did this row make it to ZRA and when." Retry sweeps look for
  // zra_registered_at IS NULL (never pushed) or zra_last_error IS NOT NULL
  // (failed last time).
  addCol('users',     'zra_registered_at', 'TEXT');
  addCol('users',     'zra_last_error',    'TEXT');
  // 2026-09-15 — route seller tick (Users → Edit). Their sales are counted as
  // route selling in HQ → Route Selling; stock and cash stay with the depot.
  addCol('users',     'is_route_seller',   'INTEGER NOT NULL DEFAULT 0');
  addCol('customers', 'zra_registered_at', 'TEXT');
  addCol('customers', 'zra_last_error',    'TEXT');

  // v1.13.128j — Fiscal snapshot columns on order_items. A tax invoice
  // MUST be immutable: once issued, reprints and reports must show the
  // exact figures the customer saw at the time of sale, regardless of
  // later changes to product master (RRP, VAT category) or receipt
  // formulas. Prior to this migration Kelete recalculated Net + VAT
  // on every read from live product-master + raw price/qty, which meant
  // a formula change or a product-master edit could silently rewrite
  // history on old invoices. These five columns freeze the fiscal
  // fields at sale time:
  //
  //   zra_rrp_snap        — RRP × qty on this line at the moment of sale
  //   zra_vat_cat_snap    — VAT category code (A/B/C1/…/D/E) at sale time
  //   zra_vat_rate        — the rate applied (16 for A/B, 0 for C/D/E)
  //   zra_vat_taxbl_amt   — Net (VAT-exclusive) per ZRA VSDC spec §5.9:
  //                          max(sale, RRP × qty) / (1 + rate/100)
  //                          For Cat B sold < RRP this is RRP-boosted.
  //   zra_vat_amt         — VAT: max(sale, RRP × qty) × rate / (rate+100)
  //
  // Reprints, VAT Report, Sales Report and VSDC saveSales all read
  // from these columns when present; the previous live-recompute path
  // remains only as a fallback for very old rows the backfill missed.
  addCol('order_items', 'zra_rrp_snap',      'REAL');
  addCol('order_items', 'zra_vat_cat_snap',  'TEXT');
  addCol('order_items', 'zra_vat_rate',      'REAL');
  addCol('order_items', 'zra_vat_taxbl_amt', 'REAL');
  addCol('order_items', 'zra_vat_amt',       'REAL');

  // One-shot backfill for rows created before the snapshot columns
  // existed. Uses the CURRENT products.zra_vat_cat_cd + zra_rrp because
  // those are the only historical values we have — better than leaving
  // NULL, which would force reads to fall back to live recompute
  // (defeating the immutability purpose for pre-migration invoices).
  // Runs once: only touches rows where the snapshot is still NULL.
  // ZRA VAT_RATES follow the VSDC API spec §6.1: A/B/RVAT = 16, F = 10,
  // everything else (C1/C2/C3/D/E) = 0.
  try {
    const info = db.prepare("PRAGMA table_info(order_items)").all();
    const hasSnap = info.some(c => c.name === 'zra_vat_taxbl_amt');
    if (hasSnap) {
      const missing = db.prepare(`
        SELECT oi.id, oi.quantity, oi.unit_price, oi.discount,
               p.zra_vat_cat_cd, p.zra_rrp
          FROM order_items oi
          LEFT JOIN products p ON p.sync_id = oi.product_sync_id
         WHERE oi.zra_vat_taxbl_amt IS NULL
      `).all();
      if (missing.length) {
        const RATES = { A: 16, B: 16, C1: 0, C2: 0, C3: 0, D: 0, E: 0, F: 10, RVAT: 16 };
        const upd = db.prepare(`
          UPDATE order_items
             SET zra_rrp_snap      = ?,
                 zra_vat_cat_snap  = ?,
                 zra_vat_rate      = ?,
                 zra_vat_taxbl_amt = ?,
                 zra_vat_amt       = ?
           WHERE id = ?
        `);
        const tx = db.transaction((rows) => {
          for (const r of rows) {
            const qty    = Number(r.quantity)   || 0;
            const prc    = Number(r.unit_price) || 0;
            const dcU    = Number(r.discount)   || 0;
            const netInc = qty * (prc - dcU);
            const cat    = String(r.zra_vat_cat_cd || 'A').toUpperCase();
            const rrpU   = Number(r.zra_rrp) || 0;
            const rate   = RATES[cat] ?? 16;
            const boost  = (cat === 'B' && rrpU > 0) ? Math.max(netInc, rrpU * qty) : netInc;
            const taxbl  = rate > 0 ? boost / (1 + rate / 100) : boost;
            const vat    = boost - taxbl;
            // Store per-unit RRP so reprints can display it directly.
            upd.run(rrpU, cat, rate, +taxbl.toFixed(4), +vat.toFixed(4), r.id);
          }
        });
        tx(missing);
        console.log(`[migration] Backfilled ZRA fiscal snapshot on ${missing.length} order_items rows`);
      }
    }
  } catch (e) {
    console.warn('[migration] order_items ZRA snapshot backfill skipped:', e.message);
  }

  // v1.10.109 (from Kelete) — REMOVED the v1.8.68 backfill block that copied
  // change_amount → usd_change_given on every startup. On Kelete it inflated
  // FRA-change orders on Kassumbalesa; on Kelete (K-only) it would similarly
  // stamp phantom USD change onto K change_amount rows. Kelete is fresh DBs
  // and never uses USD, so the block has no legitimate work to do — dropped.

  // v1.8.77 — SELF-HEALING fix for orders confirmed before v1.8.74 when the
  // backend defaulted overpaid_kept_ccy='USD' any time the customer paid some
  // USD, even though the actual over-payment was in FRA/K. Symptom: Cash
  // Report Over-Collections shows "USD +$0.11" but Sales Report USD column
  // is $199.89 instead of $200 because usd_change_given got backfilled with
  // the FRA-overpayment USD-equivalent.
  //
  // Heals only the orders that match the bug fingerprint:
  //   • overpaid_kept_ccy = 'USD'
  //   • cash_received > 0 (USD was paid)
  //   • fra_received > 0 OR k_received > 0 (foreign currency also paid)
  //   • usd_change_given > 0 (USD supposedly returned, but it shouldn't have been)
  //   • fra_change_given = 0 AND k_change_given = 0 (cashier kept the change)
  // Re-attributes overpaid_kept_ccy/amt using source-currency priority
  // (USD pays first → FRA → K, surplus lives in the LAST currency used),
  // and zeroes usd_change_given since no USD was actually returned.
  try {
    const sus = db.prepare(`
      SELECT id, total_amount, cash_received, fra_received, k_received,
             selling_rate_used, selling_rate_k_used, usd_change_given,
             overpaid_kept_amt
        FROM orders
       WHERE deleted_at IS NULL
         AND COALESCE(overpaid_kept_ccy, '') = 'USD'
         AND COALESCE(cash_received, 0) > 0
         AND (COALESCE(fra_received, 0) > 0 OR COALESCE(k_received, 0) > 0)
         AND COALESCE(usd_change_given, 0) > 0
         AND COALESCE(fra_change_given, 0) = 0
         AND COALESCE(k_change_given, 0)   = 0
    `).all();
    if (sus.length > 0) {
      const upd = db.prepare(`
        UPDATE orders
           SET overpaid_kept_ccy = ?,
               overpaid_kept_amt = ?,
               usd_change_given  = 0,
               synced            = 0,
               updated_at        = datetime('now')
         WHERE id = ?
      `);
      let healed = 0;
      for (const r of sus) {
        const totalDue = parseFloat(r.total_amount)  || 0;
        const paidUSD  = parseFloat(r.cash_received) || 0;
        const paidFRA  = parseFloat(r.fra_received   || 0) || 0;
        const paidK    = parseFloat(r.k_received     || 0) || 0;
        const sellR    = parseFloat(r.selling_rate_used   || 0) || 0;
        const sellRK   = parseFloat(r.selling_rate_k_used || 0) || 0;
        // Source-currency over-payment chain (USD → FRA → K)
        let rem = totalDue - Math.min(paidUSD, totalDue);
        let overUSD  = paidUSD - Math.min(paidUSD, totalDue);
        let overFRA = 0, overK = 0;
        if (rem > 0 && paidFRA > 0 && sellR > 0) {
          const fraNeeded = rem * sellR;
          if (paidFRA >= fraNeeded) { overFRA = paidFRA - fraNeeded; rem = 0; }
          else                      { rem -= paidFRA / sellR; }
        } else if (paidFRA > 0) {
          overFRA = paidFRA;
        }
        if (rem > 0 && paidK > 0 && sellRK > 0) {
          const kNeeded = rem * sellRK;
          if (paidK >= kNeeded) { overK = paidK - kNeeded; rem = 0; }
        } else if (paidK > 0) {
          overK = paidK;
        }
        let newCcy = 'USD', newAmt = overUSD;
        if      (overFRA > 0.5)   { newCcy = 'FRA'; newAmt = overFRA; }
        else if (overK   > 0.5)   { newCcy = 'K';   newAmt = overK; }
        else if (overUSD > 0.001) { newCcy = 'USD'; newAmt = overUSD; }
        else continue; // nothing to attribute
        upd.run(newCcy, newAmt, r.id);
        healed++;
      }
      if (healed > 0) console.log(`[self-heal overpaid_kept] re-attributed ${healed} order(s) from USD default → source currency`);
    }
  } catch (e) { /* table may not yet have all columns on a fresh DB */ }

  // v1.8.80 — SELF-HEALING zero-out for usd_change_given when the surplus is
  // actually in a FRA or K drawer. The v1.8.68 backfill blindly seeded
  // usd_change_given = change_amount for ALL orders, but for orders where the
  // cashier kept the surplus in FRA/K (overpaid_kept_ccy != 'USD'), no USD
  // was physically returned — so usd_change_given should be 0.
  // Symptom: Sales Report By Payment USD column shows '$199.89' instead of
  // '$200.00' for orders where the customer paid USD + FRA and the FRA
  // surplus was kept by the cashier (e.g. ORD-0016).
  try {
    const result = db.prepare(`
      UPDATE orders
         SET usd_change_given = 0,
             synced           = 0,
             updated_at       = datetime('now')
       WHERE deleted_at IS NULL
         AND COALESCE(overpaid_kept_ccy, '') IN ('FRA', 'K')
         AND COALESCE(usd_change_given, 0) > 0.005
    `).run();
    if (result.changes > 0) {
      console.log(`[self-heal usd_change_given] zeroed ${result.changes} order(s) where surplus is in FRA/K drawer`);
    }
  } catch (e) { /* fresh DB or columns not yet present */ }

  // v1.13.20 — REMOVED two Kelete-inherited self-healers that are dead
  // code on Kelete's K-only Liquor setup:
  //   (a) v1.8.83 self-heal cash_receipts FRA/K from cash_reports —
  //       fra_received / k_received in cash_reports are always 0 on
  //       Kelete, so this was a permanent no-op that would only ever
  //       fire on a currency_mode change (in which case it would
  //       silently mutate CRs). Same risk profile as the deleted
  //       Kelete v1.8.68 usd_change_given backfill.
  //   (b) v1.8.58 self-heal orders.cash_received — WHERE requires
  //       fra_received > 0 OR k_received > 0, both permanently 0 on
  //       K-only Kelete. Dead code with a mutating time bomb if
  //       currency mode ever changes.
  // If Kelete moves to USD+FRA+K later, port the Kelete versions back.

  // ── v1.8.95 — SELF-HEALING products.current_stock ────────────────────────
  // current_stock is a cached/denormalized snapshot of total on-hand stock
  // per product. Truth lives in stock_movements (sum of in/out moves).
  // The cache gets out of sync because some legacy code paths bypass the
  // movements log when editing it. Real incident: SAVANNA 330ML showed
  // 300 Bottle on Inter-Branch Transfer page while Stock Reconciliation
  // (which computes live from stock_movements) showed 22,398 Bottle — a
  // 75x discrepancy that almost let a cashier under-transfer by 22,000.
  //
  // Strategy C heal: on every backend boot, rebuild current_stock for
  // every product by summing its non-deleted stock_movements. Brings the
  // cache back to truth so the 9 readers that still trust it (HQ
  // Inventory, Branch Dashboard low-stock widget, Stock Count baseline,
  // etc.) display correct numbers. Idempotent — running again gives
  // identical results. ~50ms for 1000 products.
  try {
    const result = db.prepare(`
      UPDATE products
         SET current_stock = COALESCE((
               SELECT SUM(sm.quantity)
                 FROM stock_movements sm
                WHERE sm.product_sync_id = products.sync_id
                  AND sm.deleted_at IS NULL
             ), 0),
             synced = 0,
             updated_at = datetime('now')
       WHERE deleted_at IS NULL
         AND sync_id IS NOT NULL
    `).run();
    if (result.changes > 0) {
      console.log(`[self-heal current_stock] rebuilt cache for ${result.changes} product(s) from stock_movements`);
    }
  } catch (e) {
    console.warn('[self-heal current_stock] skipped:', e.message);
  }

  // v1.10.53 — Seed products.avg_cost_price for rows that still have NULL.
  // Uses the same formula profitHelper.js was computing on the fly:
  //   avg = SUM(grn_items.total_price) / SUM(base_qty_from_units_json)
  // Only touches products where avg_cost_price IS NULL, so subsequent
  // shipment blends (which write back a fresh value) are preserved.
  // If no grn_items exist for a product yet, avg_cost_price stays NULL
  // and profitHelper's fallback chain (cost_price) kicks in.
  try {
    const baseQtyExpr = `(
      CASE
        WHEN gip.units_json IS NULL OR gip.units_json = '' THEN gi.quantity
        WHEN json_extract(gip.units_json, '$[0].name') = gi.unit THEN gi.quantity * COALESCE(json_extract(gip.units_json, '$[0].conv'), 1)
        WHEN json_extract(gip.units_json, '$[1].name') = gi.unit THEN gi.quantity * COALESCE(json_extract(gip.units_json, '$[1].conv'), 1)
        WHEN json_extract(gip.units_json, '$[2].name') = gi.unit THEN gi.quantity * COALESCE(json_extract(gip.units_json, '$[2].conv'), 1)
        WHEN json_extract(gip.units_json, '$[3].name') = gi.unit THEN gi.quantity * COALESCE(json_extract(gip.units_json, '$[3].conv'), 1)
        ELSE gi.quantity
      END
    )`;
    const result = db.prepare(`
      UPDATE products
         SET avg_cost_price = (
               SELECT CASE WHEN SUM(${baseQtyExpr}) > 0
                           THEN ROUND(SUM(gi.total_price) / SUM(${baseQtyExpr}), 4)
                           ELSE NULL END
                 FROM grn_items gi
                 LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
                WHERE gi.product_sync_id = products.sync_id
                  AND gi.deleted_at IS NULL
             ),
             updated_at = datetime('now'),
             synced     = 0
       WHERE deleted_at IS NULL
         AND sync_id IS NOT NULL
         AND avg_cost_price IS NULL
         AND EXISTS (
               SELECT 1 FROM grn_items gi2
                WHERE gi2.product_sync_id = products.sync_id
                  AND gi2.deleted_at IS NULL
             )
    `).run();
    if (result.changes > 0) {
      console.log(`[seed avg_cost_price] backfilled ${result.changes} product(s) from grn_items`);
    }
  } catch (e) {
    console.warn('[seed avg_cost_price] skipped:', e.message);
  }

  // Kelete fuel-station modules (tanks, pumps, nozzles, shifts, deliveries, fleet, sales)
  try {
    const { initFuelSchema } = require('./fuelSchema');
    initFuelSchema(db);
  } catch (e) {
    console.warn('[fuelSchema] skipped:', e.message);
  }
}

module.exports = { initTenantDb };
