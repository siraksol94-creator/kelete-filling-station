-- D5 test fixture: schema of a branch database as built by the ORIGINAL code
-- (baseline commit = kelete-filling-station-main.zip as received), on a fresh database.
-- Schema only — no data. Used to test upgrades from the pre-D1 state.
-- Regenerate only if the baseline changes; live schema files (Phase 2a) go in fixtures/live-schemas/.

CREATE TABLE ap_payment_allocations (
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

CREATE TABLE ap_payments (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, cash_amount REAL NOT NULL DEFAULT 0, bank_amount REAL NOT NULL DEFAULT 0, momo_amount REAL NOT NULL DEFAULT 0, usd_amount REAL NOT NULL DEFAULT 0, fra_amount REAL NOT NULL DEFAULT 0, k_amount REAL NOT NULL DEFAULT 0, invoice_attachment TEXT, supplier_sync_id TEXT, grn_sync_id TEXT, batch_ref TEXT);

CREATE TABLE attendant_shifts (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      attendant_user_id  INTEGER NOT NULL REFERENCES users(id),
      branch_id          INTEGER,
      opened_at          TEXT NOT NULL DEFAULT (datetime('now')),
      opened_by          INTEGER REFERENCES users(id),
      closed_at          TEXT,
      closed_by          INTEGER REFERENCES users(id),
      status             TEXT NOT NULL DEFAULT 'Open',
      expected_cash      REAL DEFAULT 0,
      actual_cash        REAL DEFAULT 0,
      variance           REAL DEFAULT 0,
      -- Payment breakdown entered at close. Sum of these + credit sales
      -- (summed from shift_credit_sales) must equal gross nozzle sales.
      payment_cash       REAL DEFAULT 0,
      payment_swipes     REAL DEFAULT 0,
      payment_1card      REAL DEFAULT 0,
      payment_mobile     REAL DEFAULT 0,
      payment_other      REAL DEFAULT 0,
      notes              TEXT,
      sync_id            TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    , shift_type TEXT);

CREATE TABLE branches (
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
      );

CREATE TABLE business_settings (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      business_name    TEXT,
      business_phone   TEXT,
      business_email   TEXT,
      business_address TEXT,
      tpin             TEXT,
      tax_rate         REAL DEFAULT 0,
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, created_at TEXT, daily_expense_limit REAL NOT NULL DEFAULT 5000, single_location_mode INTEGER NOT NULL DEFAULT 0, block_oversell INTEGER NOT NULL DEFAULT 0, default_crate_deposit REAL DEFAULT 57, empty_container_product_sync_id TEXT, receipt_printer_type TEXT NOT NULL DEFAULT 'usb', receipt_printer_name TEXT, receipt_printer_ip TEXT, receipt_printer_port INTEGER DEFAULT 9100, currencies_json TEXT, currency_mode TEXT NOT NULL DEFAULT 'K', workflow_mode TEXT NOT NULL DEFAULT 'single_pos', legacy_procurement_enabled INTEGER NOT NULL DEFAULT 0, payment_methods TEXT NOT NULL DEFAULT 'cash_momo_bank', shown_payment_methods TEXT NOT NULL DEFAULT 'cash,momo,bank', auto_deposit_enabled INTEGER NOT NULL DEFAULT 0, deposit_to_slug TEXT, zra_enabled INTEGER NOT NULL DEFAULT 0, zra_env TEXT NOT NULL DEFAULT 'sandbox', zra_vsdc_url TEXT, zra_tpin TEXT, zra_bhf_id TEXT, zra_dvc_srl_no TEXT, zra_sdc_id TEXT, zra_mrc_no TEXT, zra_taxpr_nm TEXT, zra_vat_ty_cd TEXT, zra_last_invc_no INTEGER, zra_last_sale_invc_no INTEGER, zra_last_pchs_invc_no INTEGER, zra_last_sale_rcpt_no INTEGER, zra_last_train_invc_no INTEGER, zra_last_profrm_invc_no INTEGER, zra_last_copy_invc_no INTEGER, zra_initialized_at TEXT, zra_block_offline_sales INTEGER NOT NULL DEFAULT 1, zra_proxy_branch_slug TEXT NOT NULL DEFAULT '', zra_proxy_secret TEXT);

CREATE TABLE capital_account (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, shareholder_id INTEGER, shareholder_sync_id TEXT);

CREATE TABLE cash_book (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      date           TEXT NOT NULL,
      description    TEXT,
      reference      TEXT,
      receipt_amount REAL DEFAULT 0,
      payment_amount REAL DEFAULT 0,
      balance        REAL DEFAULT 0,
      type           TEXT DEFAULT 'entry',
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT);

CREATE TABLE cash_receipts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_number TEXT UNIQUE NOT NULL,
      received_from  TEXT,
      description    TEXT,
      payment_method TEXT,
      amount         REAL NOT NULL DEFAULT 0,
      date           TEXT NOT NULL,
      created_by     INTEGER REFERENCES users(id),
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, cash_amount REAL NOT NULL DEFAULT 0, bank_amount REAL NOT NULL DEFAULT 0, momo_amount REAL NOT NULL DEFAULT 0, usd_amount REAL NOT NULL DEFAULT 0, fra_amount REAL NOT NULL DEFAULT 0, k_amount REAL NOT NULL DEFAULT 0, source_type TEXT, source_customer_payment_id INTEGER);

CREATE TABLE cash_reports (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, cashier_id INTEGER DEFAULT 0, bank REAL NOT NULL DEFAULT 0, usd_received REAL NOT NULL DEFAULT 0, fra_received REAL NOT NULL DEFAULT 0, k_received REAL NOT NULL DEFAULT 0, usd_expected REAL NOT NULL DEFAULT 0, fra_expected REAL NOT NULL DEFAULT 0, k_expected REAL NOT NULL DEFAULT 0, usd_expenses REAL NOT NULL DEFAULT 0, fra_expenses REAL NOT NULL DEFAULT 0, k_expenses REAL NOT NULL DEFAULT 0);

CREATE TABLE cash_transfers (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0);

CREATE TABLE categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT,
      color       TEXT DEFAULT '#6B7280',
      status      TEXT NOT NULL DEFAULT 'Active',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, main_category_id INTEGER, main_category_sync_id TEXT, is_hq_owned INTEGER NOT NULL DEFAULT 0);

CREATE TABLE currency_exchanges (
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

CREATE TABLE customer_empty_returns (
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

CREATE TABLE customer_payments (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, cash_receipt_sync_id TEXT, cash_amount REAL NOT NULL DEFAULT 0, bank_amount REAL NOT NULL DEFAULT 0, momo_amount REAL NOT NULL DEFAULT 0, usd_amount REAL NOT NULL DEFAULT 0, fra_amount REAL NOT NULL DEFAULT 0, k_amount REAL NOT NULL DEFAULT 0, selling_rate_used REAL, selling_rate_k_used REAL);

CREATE TABLE customers (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, credit_limit REAL NOT NULL DEFAULT 0, opening_balance REAL NOT NULL DEFAULT 0, payment_terms_days INTEGER NOT NULL DEFAULT 0, credit_status TEXT NOT NULL DEFAULT 'Active', empty_balance INTEGER NOT NULL DEFAULT 0, tpin TEXT, zra_registered_at TEXT, zra_last_error TEXT);

CREATE TABLE daily_actual_balance (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id       INTEGER NOT NULL REFERENCES products(id),
      product_sync_id  TEXT,
      date             TEXT NOT NULL,
      actual_balance   REAL NOT NULL,
      reason           TEXT,
      created_by       INTEGER,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')), sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT,
      UNIQUE(product_id, date)
    );

CREATE TABLE daily_cost_snapshot (
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

CREATE TABLE daily_profit_summary (
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
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')), sync_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, created_at TEXT, supplier_rebates REAL NOT NULL DEFAULT 0, interest_expense REAL NOT NULL DEFAULT 0, damages REAL NOT NULL DEFAULT 0,
      UNIQUE(date, tenant_id)
    );

CREATE TABLE debit_notes (
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

CREATE TABLE discount_requests (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0);

CREATE TABLE dividend_account (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, shareholder_id INTEGER, shareholder_sync_id TEXT);

CREATE TABLE empty_return_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      empty_return_id INTEGER NOT NULL REFERENCES empty_returns(id),
      product_id  INTEGER REFERENCES products(id),
      quantity    REAL NOT NULL,
      deposit     REAL NOT NULL DEFAULT 0,
      total_price REAL NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, empty_return_sync_id TEXT, product_sync_id TEXT);

CREATE TABLE empty_returns (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, supplier_sync_id TEXT, ap_payment_sync_id TEXT, credit_note_sync_id TEXT);

CREATE TABLE empty_voucher_claims (
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

CREATE TABLE empty_vouchers (
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
    , product_sync_id TEXT, product_name TEXT);

CREATE TABLE fleet_customers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      company         TEXT,
      phone           TEXT,
      email           TEXT,
      address         TEXT,
      credit_limit    REAL DEFAULT 0,
      current_balance REAL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'Active',
      sync_id         TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE fleet_vehicles (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      fleet_customer_id  INTEGER NOT NULL REFERENCES fleet_customers(id) ON DELETE CASCADE,
      registration       TEXT NOT NULL,
      make               TEXT,
      model              TEXT,
      driver_name        TEXT,
      driver_phone       TEXT,
      status             TEXT NOT NULL DEFAULT 'Active',
      sync_id            TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE fuel_day_approvals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      approval_date   TEXT NOT NULL UNIQUE,
      approved_by     INTEGER REFERENCES users(id),
      approved_at     TEXT NOT NULL DEFAULT (datetime('now')),
      notes           TEXT
    );

CREATE TABLE fuel_deliveries (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_number  TEXT NOT NULL UNIQUE,
      supplier_id      INTEGER REFERENCES suppliers(id),
      tank_id          INTEGER NOT NULL REFERENCES tanks(id),
      fuel_grade_id    INTEGER NOT NULL REFERENCES fuel_grades(id),
      delivery_date    TEXT NOT NULL DEFAULT (date('now')),
      litres_ordered   REAL,
      litres_delivered REAL NOT NULL,
      dip_before       REAL,
      dip_after        REAL,
      cost_per_litre   REAL NOT NULL,
      total_cost       REAL NOT NULL,
      invoice_number   TEXT,
      branch_id        INTEGER,
      received_by      INTEGER REFERENCES users(id),
      status           TEXT NOT NULL DEFAULT 'Received',
      notes            TEXT,
      sync_id          TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE fuel_grades (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      code           TEXT NOT NULL UNIQUE,
      name           TEXT NOT NULL,
      unit           TEXT NOT NULL DEFAULT 'L',
      selling_price  REAL NOT NULL DEFAULT 0,
      cost_price     REAL NOT NULL DEFAULT 0,
      color          TEXT DEFAULT '#6B7280',
      status         TEXT NOT NULL DEFAULT 'Active',
      branch_id      INTEGER,
      sync_id        TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE fuel_sales (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_number        TEXT NOT NULL UNIQUE,
      shift_id           INTEGER REFERENCES attendant_shifts(id),
      nozzle_id          INTEGER NOT NULL REFERENCES nozzles(id),
      fuel_grade_id      INTEGER NOT NULL REFERENCES fuel_grades(id),
      litres             REAL NOT NULL,
      price_per_litre    REAL NOT NULL,
      total              REAL NOT NULL,
      payment_method     TEXT NOT NULL DEFAULT 'Cash',
      fleet_customer_id  INTEGER REFERENCES fleet_customers(id),
      fleet_vehicle_id   INTEGER REFERENCES fleet_vehicles(id),
      cashier_id         INTEGER REFERENCES users(id),
      branch_id          INTEGER,
      sale_date          TEXT NOT NULL DEFAULT (datetime('now')),
      status             TEXT NOT NULL DEFAULT 'Confirmed',
      notes              TEXT,
      sync_id            TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE fuel_shift_approvals (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id        INTEGER NOT NULL UNIQUE REFERENCES attendant_shifts(id) ON DELETE CASCADE,
      approved_by     INTEGER REFERENCES users(id),
      approved_at     TEXT NOT NULL DEFAULT (datetime('now')),
      notes           TEXT
    , approval_date TEXT, shift_type TEXT);

CREATE TABLE fx_rates (
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
    , sell_rate_k REAL, buy_rate_k REAL, effective_at TEXT);

CREATE TABLE grn (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, invoice_attachment TEXT, linked_purchase_sync_id TEXT, linked_purchase_number TEXT, hq_status TEXT, hq_confirmed_by INTEGER, hq_confirmed_by_name TEXT, hq_confirmed_at TEXT, hq_reject_reason TEXT, supplier_invoice_number TEXT, supplier_name TEXT, supplier_sync_id TEXT, zra_pchs_invc_no INTEGER, zra_spplr_tpin TEXT, zra_spplr_bhf_id TEXT, zra_reg_ty_cd TEXT DEFAULT 'M', zra_pchs_sts_cd TEXT, zra_status TEXT NOT NULL DEFAULT 'PENDING', zra_error_code TEXT, zra_error_message TEXT);

CREATE TABLE grn_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_id      INTEGER NOT NULL REFERENCES grn(id),
      product_id  INTEGER REFERENCES products(id),
      quantity    REAL NOT NULL,
      unit_price  REAL NOT NULL,
      total_price REAL NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, product_sync_id TEXT, grn_sync_id TEXT, expiry_date TEXT, unit TEXT, containers_received REAL NOT NULL DEFAULT 0, containers_returned REAL NOT NULL DEFAULT 0, container_deposit REAL NOT NULL DEFAULT 0, container_product_sync_id TEXT);

CREATE TABLE loan_transactions (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, loan_sync_id TEXT);

CREATE TABLE loans (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0);

CREATE TABLE main_categories (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      color       TEXT DEFAULT '#6B7280',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, is_hq_owned INTEGER NOT NULL DEFAULT 0);

CREATE TABLE nozzles (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      pump_id                INTEGER NOT NULL REFERENCES pumps(id) ON DELETE CASCADE,
      tank_id                INTEGER NOT NULL REFERENCES tanks(id),
      code                   TEXT NOT NULL,
      current_meter_reading  REAL NOT NULL DEFAULT 0,
      status                 TEXT NOT NULL DEFAULT 'Active',
      sync_id                TEXT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE order_duplicate_dismissals (
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

CREATE TABLE order_items (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, created_at TEXT, updated_at TEXT, product_sync_id TEXT, order_sync_id TEXT, unit TEXT, reversed_quantity REAL NOT NULL DEFAULT 0, discount REAL NOT NULL DEFAULT 0, zra_rrp_snap REAL, zra_vat_cat_snap TEXT, zra_vat_rate REAL, zra_vat_taxbl_amt REAL, zra_vat_amt REAL);

CREATE TABLE order_payment_edits (
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

CREATE TABLE orders (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, customer_id INTEGER, customer_sync_id TEXT, shift_id INTEGER, cash_received REAL NOT NULL DEFAULT 0, momo_received REAL NOT NULL DEFAULT 0, bank_received REAL NOT NULL DEFAULT 0, currency TEXT DEFAULT 'K', fra_received REAL DEFAULT 0, fra_change_given REAL DEFAULT 0, selling_rate_used REAL, buying_rate_used REAL, sales_user_id INTEGER, cashier_user_id INTEGER, dispatch_user_id INTEGER, sales_at TEXT, paid_at TEXT, dispatched_at TEXT, created_by_sync_id TEXT, cashier_user_sync_id TEXT, sales_user_sync_id TEXT, dispatch_user_sync_id TEXT, customer_tpin TEXT, customer_address TEXT, zra_cis_invc_no INTEGER, zra_rcpt_no INTEGER, zra_intrl_data TEXT, zra_rcpt_sign TEXT, zra_sdc_id TEXT, zra_mrc_no TEXT, zra_vsdc_rcpt_pbct_date TEXT, zra_qr_code_url TEXT, zra_currency_ty_cd TEXT DEFAULT 'ZMW', zra_exchange_rt REAL DEFAULT 1, zra_status TEXT NOT NULL DEFAULT 'PENDING', zra_error_kind TEXT, zra_error_code TEXT, zra_error_message TEXT, zra_last_attempt_at TEXT, zra_retry_count INTEGER NOT NULL DEFAULT 0, zra_stock_chain_done INTEGER NOT NULL DEFAULT 0, zra_reprint_count INTEGER NOT NULL DEFAULT 0, lpo_number TEXT, zra_cn_cis_invc_no INTEGER, zra_cn_rcpt_no INTEGER, zra_cn_intrl_data TEXT, zra_cn_rcpt_sign TEXT, zra_cn_sdc_id TEXT, zra_cn_mrc_no TEXT, zra_cn_vsdc_rcpt_pbct_date TEXT, zra_cn_qr_code_url TEXT, zra_cn_rfd_rsn_cd TEXT, zra_cn_rfd_rsn_other TEXT, zra_cn_signed_at TEXT, local_cn_number TEXT, cn_first_printed_at TEXT, k_received REAL DEFAULT 0, k_change_given REAL DEFAULT 0, selling_rate_k_used REAL, buying_rate_k_used REAL, usd_change_given REAL NOT NULL DEFAULT 0, overpaid_kept_ccy TEXT, overpaid_kept_amt REAL NOT NULL DEFAULT 0);

CREATE TABLE payment_vouchers (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, cash_amount REAL NOT NULL DEFAULT 0, bank_amount REAL NOT NULL DEFAULT 0, momo_amount REAL NOT NULL DEFAULT 0, usd_amount REAL NOT NULL DEFAULT 0, fra_amount REAL NOT NULL DEFAULT 0, k_amount REAL NOT NULL DEFAULT 0, invoice_attachment TEXT, deleted_by INTEGER, deleted_by_name TEXT, delete_reason TEXT, cashier_id INTEGER DEFAULT 0);

CREATE TABLE product_branch_prices (
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
      );

CREATE TABLE production (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0);

CREATE TABLE production_inputs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      production_id INTEGER NOT NULL REFERENCES production(id),
      product_id    INTEGER REFERENCES products(id),
      quantity      REAL NOT NULL,
      unit_cost     REAL NOT NULL DEFAULT 0,
      total_cost    REAL NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, product_sync_id TEXT, production_sync_id TEXT);

CREATE TABLE production_outputs (
      id                       INTEGER PRIMARY KEY AUTOINCREMENT,
      production_id            INTEGER NOT NULL REFERENCES production(id),
      product_id               INTEGER REFERENCES products(id),
      quantity                 REAL NOT NULL,
      allocated_cost_per_unit  REAL NOT NULL DEFAULT 0,
      total_allocated_cost     REAL NOT NULL DEFAULT 0,
      created_at               TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, product_sync_id TEXT, production_sync_id TEXT);

CREATE TABLE products (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, category_sync_id TEXT, container_product_sync_id TEXT, units_per_container REAL, default_unit TEXT, units_json TEXT, is_hq_owned INTEGER NOT NULL DEFAULT 0, avg_cost_price REAL, hs_code TEXT, tax_label TEXT, zra_item_cd TEXT, zra_item_cls_cd TEXT, zra_item_ty_cd TEXT, zra_orgn_nat_cd TEXT, zra_pkg_unit_cd TEXT, zra_qty_unit_cd TEXT, zra_vat_cat_cd TEXT, zra_excise_ty_cd TEXT, zra_rrp REAL, zra_mfr_item_cd TEXT, zra_use_yn TEXT NOT NULL DEFAULT 'Y', zra_registered_at TEXT, zra_last_error TEXT);

CREATE TABLE pumps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      branch_id   INTEGER,
      status      TEXT NOT NULL DEFAULT 'Active',
      sync_id     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE push_tokens (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        token         TEXT NOT NULL UNIQUE,
        user_id       INTEGER,
        branch_slug   TEXT,
        platform      TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at  TEXT
      );

CREATE TABLE pv_expense_requests (
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

CREATE TABLE pv_types (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      color       TEXT DEFAULT '#6B7280',
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT);

CREATE TABLE quick_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       TEXT,
      product_sync_id TEXT NOT NULL,
      position        INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')), sync_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT,
      UNIQUE(tenant_id, product_sync_id)
    );

CREATE TABLE sales_return_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id  INTEGER REFERENCES sales_returns(id),
      product_id INTEGER REFERENCES products(id),
      quantity   REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, product_sync_id TEXT, return_sync_id TEXT, unit TEXT);

CREATE TABLE sales_returns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      return_number TEXT UNIQUE NOT NULL,
      date          TEXT NOT NULL,
      notes         TEXT,
      total_items   INTEGER DEFAULT 0,
      created_by    INTEGER REFERENCES users(id),
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'CONFIRMED', confirmed_by INTEGER, confirmed_by_name TEXT, confirmed_at TEXT, confirm_notes TEXT, zra_cis_invc_no INTEGER, zra_rcpt_no INTEGER, zra_intrl_data TEXT, zra_rcpt_sign TEXT, zra_sdc_id TEXT, zra_qr_code_url TEXT, zra_org_incc_no INTEGER, zra_org_sdc_id TEXT, zra_rfd_rsn_cd TEXT, zra_status TEXT NOT NULL DEFAULT 'PENDING', zra_error_code TEXT, zra_error_message TEXT);

CREATE TABLE shareholders (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      email             TEXT,
      phone             TEXT,
      share_percentage  REAL NOT NULL DEFAULT 0,   -- optional, for reporting
      notes             TEXT,
      created_by        INTEGER REFERENCES users(id),
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0);

CREATE TABLE shift_credit_sales (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id              INTEGER NOT NULL REFERENCES attendant_shifts(id) ON DELETE CASCADE,
      payment_method        TEXT NOT NULL DEFAULT 'Credit',
      fleet_customer_id     INTEGER REFERENCES fleet_customers(id),
      customer_name         TEXT NOT NULL,
      card_number           TEXT,
      vehicle_registration  TEXT,
      fuel_grade_id         INTEGER REFERENCES fuel_grades(id),
      litres                REAL NOT NULL,
      price_per_litre       REAL NOT NULL,
      amount                REAL NOT NULL,
      receipt_number        TEXT,
      notes                 TEXT,
      created_at            TEXT NOT NULL DEFAULT (datetime('now'))
    , customer_id INTEGER, customer_sync_id TEXT, linked_order_id INTEGER, date TEXT);

CREATE TABLE shift_dips (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id        INTEGER NOT NULL REFERENCES attendant_shifts(id) ON DELETE CASCADE,
      tank_id         INTEGER NOT NULL REFERENCES tanks(id),
      dip_litres      REAL NOT NULL,
      reading_litres  REAL,
      variance        REAL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE shift_nozzle_readings (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id          INTEGER NOT NULL REFERENCES attendant_shifts(id) ON DELETE CASCADE,
      nozzle_id         INTEGER NOT NULL REFERENCES nozzles(id),
      opening_reading   REAL NOT NULL,
      closing_reading   REAL,
      litres_sold       REAL,
      price_per_litre   REAL NOT NULL,
      expected_cash     REAL,
      testing_litres    REAL DEFAULT 0,
      sync_id           TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE siv (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, source_grn_sync_id TEXT, production_id INTEGER, production_sync_id TEXT);

CREATE TABLE siv_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      siv_id      INTEGER NOT NULL REFERENCES siv(id),
      product_id  INTEGER REFERENCES products(id),
      quantity    REAL NOT NULL,
      unit_price  REAL DEFAULT 0,
      total_price REAL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, product_sync_id TEXT, siv_sync_id TEXT, unit TEXT);

CREATE TABLE stock_adjustments (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, product_sync_id TEXT);

CREATE TABLE stock_count_items (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES stock_count_sessions(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity   REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT);

CREATE TABLE stock_count_sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'Active',
      created_by INTEGER REFERENCES users(id),
      tenant_id  TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0);

CREATE TABLE stock_movements (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, reference_sync_id TEXT, product_sync_id TEXT, cost_at_sale REAL);

CREATE TABLE stock_reconciliation_items (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0);

CREATE TABLE stock_reconciliations (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      count_date   TEXT NOT NULL,
      location     TEXT NOT NULL DEFAULT 'sales',
      notes        TEXT,
      created_by   INTEGER,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0);

CREATE TABLE supplier_credit_note_items (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_note_id          INTEGER NOT NULL REFERENCES supplier_credit_notes(id),
      product_id              INTEGER REFERENCES products(id),
      quantity                REAL NOT NULL DEFAULT 0,
      unit_value              REAL NOT NULL DEFAULT 0,     -- deposit per unit
      total_price             REAL NOT NULL DEFAULT 0,
      created_at              TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, credit_note_sync_id TEXT, product_sync_id TEXT, unit TEXT, unit_conv REAL NOT NULL DEFAULT 1);

CREATE TABLE supplier_credit_notes (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, grn_sync_id TEXT, supplier_sync_id TEXT, ap_status TEXT NOT NULL DEFAULT 'PENDING', checked_at TEXT, checked_by_id INTEGER, checked_by_name TEXT, review_confirmed_at TEXT, review_confirmed_by_id INTEGER, review_confirmed_by_name TEXT, approved_at TEXT, approved_by_id INTEGER, approved_by_name TEXT, sent_back_at TEXT, sent_back_by_name TEXT, sent_back_reason TEXT, applied_at TEXT, applied_payment_sync_id TEXT, applied_amount REAL NOT NULL DEFAULT 0, proposed_grn_sync_id TEXT, raised_by_branch TEXT, raised_by_name TEXT, branch_confirmed_at TEXT, branch_confirmed_by_name TEXT);

CREATE TABLE suppliers (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, tpin TEXT);

CREATE TABLE sync_config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

CREATE TABLE tank_dips (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      tank_id                INTEGER NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
      shift_id               INTEGER REFERENCES attendant_shifts(id) ON DELETE CASCADE,
      dip_date               TEXT NOT NULL DEFAULT (date('now')),
      measured_litres        REAL NOT NULL,
      book_litres            REAL NOT NULL,
      variance               REAL NOT NULL,
      taken_by_user_id       INTEGER REFERENCES users(id),
      posted_adjustment_id   INTEGER REFERENCES tank_movements(id),
      notes                  TEXT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
    , shift_type TEXT);

CREATE TABLE tank_movements (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      tank_id        INTEGER NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
      movement_date  TEXT NOT NULL DEFAULT (date('now')),
      type           TEXT NOT NULL,   -- 'opening' | 'delivery' | 'sale' | 'adjustment' | 'dip_adjustment' | 'reversal'
      litres         REAL NOT NULL,   -- signed: + in, - out
      ref_table      TEXT,            -- e.g. 'fuel_deliveries', 'attendant_shifts', 'tank_dips'
      ref_id         INTEGER,
      notes          TEXT,
      created_by     INTEGER REFERENCES users(id),
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE tanks (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      code              TEXT NOT NULL,
      name              TEXT NOT NULL,
      fuel_grade_id     INTEGER NOT NULL REFERENCES fuel_grades(id),
      capacity_litres   REAL NOT NULL,
      current_volume    REAL NOT NULL DEFAULT 0,
      low_stock_litres  REAL DEFAULT 1000,
      vessel_count      INTEGER NOT NULL DEFAULT 1,
      branch_id         INTEGER,
      status            TEXT NOT NULL DEFAULT 'Active',
      sync_id           TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    , group_code TEXT);

CREATE TABLE units (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      abbreviation TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, updated_at TEXT, is_hq_owned INTEGER NOT NULL DEFAULT 0);

CREATE TABLE users (
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
    , sync_id TEXT, tenant_id TEXT, branch_id TEXT, device_id TEXT, deleted_at TEXT, synced INTEGER NOT NULL DEFAULT 0, zra_registered_at TEXT, zra_last_error TEXT, is_route_seller INTEGER NOT NULL DEFAULT 0);

CREATE TABLE zra_audit_log (
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

CREATE TABLE zra_codes (
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

CREATE TABLE zra_item_classes (
      item_cls_cd  TEXT PRIMARY KEY,       -- UNSPSC 8-digit
      item_cls_nm  TEXT NOT NULL,
      item_cls_lvl INTEGER,                -- 1=segment, 2=family, 3=class, 4=commodity
      tax_ty_cd    TEXT,                   -- default vatCatCd for this class
      mjr_tg_yn    TEXT,                   -- major target Y/N
      use_yn       TEXT NOT NULL DEFAULT 'Y',
      updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE zra_notices (
      notice_no  INTEGER PRIMARY KEY,
      title      TEXT,
      cont       TEXT,
      dtl_url    TEXT,
      reg_dt     TEXT,
      inserted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE zra_pending_imports (
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

CREATE TABLE zra_pending_purchases (
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
    , grn_id INTEGER, grn_number TEXT, match_summary TEXT, hq_purchase_id INTEGER, hq_purchase_number TEXT);

CREATE TABLE zra_supplier_item_map (
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

CREATE TABLE zra_supplier_map (
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

CREATE TABLE zra_sync_state (
      endpoint     TEXT PRIMARY KEY,      -- e.g. '/code/selectCodes'
      last_req_dt  TEXT NOT NULL,         -- yyyyMMddHHmmss (spec format)
      last_pulled_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_result_cd TEXT,
      last_error   TEXT
    );

CREATE INDEX idx_ap_alloc_grn     ON ap_payment_allocations (grn_sync_id);

CREATE INDEX idx_ap_alloc_payment ON ap_payment_allocations (payment_sync_id);

CREATE UNIQUE INDEX idx_ap_alloc_unique ON ap_payment_allocations (payment_sync_id, grn_sync_id);

CREATE INDEX idx_ap_payments_sync_id ON ap_payments (sync_id);

CREATE INDEX idx_ap_payments_tenant_updated ON ap_payments (tenant_id, updated_at);

CREATE INDEX idx_business_settings_sync_id ON business_settings (sync_id);

CREATE INDEX idx_business_settings_tenant_updated ON business_settings (tenant_id, updated_at);

CREATE INDEX idx_capital_account_sync_id ON capital_account (sync_id);

CREATE INDEX idx_capital_account_tenant_updated ON capital_account (tenant_id, updated_at);

CREATE INDEX idx_cash_book_sync_id ON cash_book (sync_id);

CREATE INDEX idx_cash_book_tenant_updated ON cash_book (tenant_id, updated_at);

CREATE INDEX idx_cash_receipts_sync_id ON cash_receipts (sync_id);

CREATE INDEX idx_cash_receipts_tenant_updated ON cash_receipts (tenant_id, updated_at);

CREATE UNIQUE INDEX idx_cash_reports_date_cashier ON cash_reports(date, cashier_id);

CREATE INDEX idx_cash_reports_sync_id ON cash_reports (sync_id);

CREATE INDEX idx_cash_reports_tenant_updated ON cash_reports (tenant_id, updated_at);

CREATE INDEX idx_cash_transfers_sync_id ON cash_transfers (sync_id);

CREATE INDEX idx_cash_transfers_tenant_updated ON cash_transfers (tenant_id, updated_at);

CREATE INDEX idx_categories_sync_id ON categories (sync_id);

CREATE INDEX idx_categories_tenant_updated ON categories (tenant_id, updated_at);

CREATE INDEX idx_currency_exchanges_cashier ON currency_exchanges(scope, date, cashier_id);

CREATE INDEX idx_currency_exchanges_scope_date ON currency_exchanges(scope, date);

CREATE INDEX idx_currency_exchanges_sync_id ON currency_exchanges (sync_id);

CREATE INDEX idx_currency_exchanges_tenant_updated ON currency_exchanges (tenant_id, updated_at);

CREATE INDEX idx_cust_empty_returns_cust ON customer_empty_returns (customer_id);

CREATE INDEX idx_cust_empty_returns_order ON customer_empty_returns (order_id);

CREATE INDEX idx_customer_payments_sync_id ON customer_payments (sync_id);

CREATE INDEX idx_customer_payments_tenant_updated ON customer_payments (tenant_id, updated_at);

CREATE INDEX idx_customers_sync_id ON customers (sync_id);

CREATE INDEX idx_customers_tenant_updated ON customers (tenant_id, updated_at);

CREATE UNIQUE INDEX idx_dab_product_sync_date ON daily_actual_balance (product_sync_id, date);

CREATE INDEX idx_daily_actual_balance_sync_id ON daily_actual_balance (sync_id);

CREATE INDEX idx_daily_actual_balance_tenant_updated ON daily_actual_balance (tenant_id, updated_at);

CREATE INDEX idx_daily_profit_summary_sync_id ON daily_profit_summary (sync_id);

CREATE INDEX idx_daily_profit_summary_tenant_updated ON daily_profit_summary (tenant_id, updated_at);

CREATE UNIQUE INDEX idx_dcs_product_sync_date ON daily_cost_snapshot (product_sync_id, date);

CREATE INDEX idx_debit_notes_date ON debit_notes (date);

CREATE INDEX idx_debit_notes_orig ON debit_notes (orig_order_id);

CREATE INDEX idx_discount_requests_sync_id ON discount_requests (sync_id);

CREATE INDEX idx_discount_requests_tenant_updated ON discount_requests (tenant_id, updated_at);

CREATE INDEX idx_dividend_account_sync_id ON dividend_account (sync_id);

CREATE INDEX idx_dividend_account_tenant_updated ON dividend_account (tenant_id, updated_at);

CREATE INDEX idx_dup_dismiss_pair ON order_duplicate_dismissals (pair_key);

CREATE INDEX idx_empty_voucher_claims_order   ON empty_voucher_claims (order_id);

CREATE INDEX idx_empty_voucher_claims_voucher ON empty_voucher_claims (voucher_id);

CREATE INDEX idx_empty_vouchers_number ON empty_vouchers (voucher_number);

CREATE INDEX idx_empty_vouchers_status ON empty_vouchers (status);

CREATE INDEX idx_fuel_sales_date ON fuel_sales(sale_date);

CREATE INDEX idx_fuel_sales_shift ON fuel_sales(shift_id);

CREATE UNIQUE INDEX idx_fuel_shift_approvals_date_type ON fuel_shift_approvals(approval_date, shift_type) WHERE approval_date IS NOT NULL AND shift_type IS NOT NULL;

CREATE INDEX idx_fx_rates_effective ON fx_rates (effective_date);

CREATE INDEX idx_grn_items_sync_id ON grn_items (sync_id);

CREATE INDEX idx_grn_items_tenant_updated ON grn_items (tenant_id, updated_at);

CREATE INDEX idx_grn_sync_id ON grn (sync_id);

CREATE INDEX idx_grn_tenant_updated ON grn (tenant_id, updated_at);

CREATE INDEX idx_loan_transactions_sync_id ON loan_transactions (sync_id);

CREATE INDEX idx_loan_transactions_tenant_updated ON loan_transactions (tenant_id, updated_at);

CREATE INDEX idx_loans_sync_id ON loans (sync_id);

CREATE INDEX idx_loans_tenant_updated ON loans (tenant_id, updated_at);

CREATE INDEX idx_main_categories_sync_id ON main_categories (sync_id);

CREATE INDEX idx_main_categories_tenant_updated ON main_categories (tenant_id, updated_at);

CREATE INDEX idx_nozzles_pump ON nozzles(pump_id);

CREATE INDEX idx_order_items_order_sync_id ON order_items (order_sync_id);

CREATE INDEX idx_order_items_sync_id ON order_items (sync_id);

CREATE INDEX idx_order_items_tenant_updated ON order_items (tenant_id, updated_at);

CREATE INDEX idx_orders_created_at ON orders (created_at);

CREATE INDEX idx_orders_sync_id ON orders (sync_id);

CREATE INDEX idx_orders_tenant_updated ON orders (tenant_id, updated_at);

CREATE INDEX idx_payment_vouchers_sync_id ON payment_vouchers (sync_id);

CREATE INDEX idx_payment_vouchers_tenant_updated ON payment_vouchers (tenant_id, updated_at);

CREATE INDEX idx_pbp_branch  ON product_branch_prices(branch_id);

CREATE INDEX idx_pbp_product ON product_branch_prices(product_id);

CREATE INDEX idx_production_inputs_sync_id ON production_inputs (sync_id);

CREATE INDEX idx_production_inputs_tenant_updated ON production_inputs (tenant_id, updated_at);

CREATE INDEX idx_production_outputs_sync_id ON production_outputs (sync_id);

CREATE INDEX idx_production_outputs_tenant_updated ON production_outputs (tenant_id, updated_at);

CREATE INDEX idx_production_sync_id ON production (sync_id);

CREATE INDEX idx_production_tenant_updated ON production (tenant_id, updated_at);

CREATE INDEX idx_products_sync_id ON products (sync_id);

CREATE INDEX idx_products_tenant_updated ON products (tenant_id, updated_at);

CREATE INDEX idx_push_tokens_user ON push_tokens (user_id);

CREATE INDEX idx_pv_expense_requests_status ON pv_expense_requests (status);

CREATE INDEX idx_pv_types_sync_id ON pv_types (sync_id);

CREATE INDEX idx_pv_types_tenant_updated ON pv_types (tenant_id, updated_at);

CREATE INDEX idx_sales_return_items_sync_id ON sales_return_items (sync_id);

CREATE INDEX idx_sales_return_items_tenant_updated ON sales_return_items (tenant_id, updated_at);

CREATE INDEX idx_sales_returns_sync_id ON sales_returns (sync_id);

CREATE INDEX idx_sales_returns_tenant_updated ON sales_returns (tenant_id, updated_at);

CREATE INDEX idx_shareholders_sync_id ON shareholders (sync_id);

CREATE INDEX idx_shareholders_tenant_updated ON shareholders (tenant_id, updated_at);

CREATE INDEX idx_shift_readings_shift ON shift_nozzle_readings(shift_id);

CREATE INDEX idx_siv_items_sync_id ON siv_items (sync_id);

CREATE INDEX idx_siv_items_tenant_updated ON siv_items (tenant_id, updated_at);

CREATE INDEX idx_siv_sync_id ON siv (sync_id);

CREATE INDEX idx_siv_tenant_updated ON siv (tenant_id, updated_at);

CREATE INDEX idx_stock_adjustments_sync_id ON stock_adjustments (sync_id);

CREATE INDEX idx_stock_adjustments_tenant_updated ON stock_adjustments (tenant_id, updated_at);

CREATE INDEX idx_stock_count_items_sync_id ON stock_count_items (sync_id);

CREATE INDEX idx_stock_count_items_tenant_updated ON stock_count_items (tenant_id, updated_at);

CREATE INDEX idx_stock_count_sessions_sync_id ON stock_count_sessions (sync_id);

CREATE INDEX idx_stock_count_sessions_tenant_updated ON stock_count_sessions (tenant_id, updated_at);

CREATE INDEX idx_stock_movements_sync_id ON stock_movements (sync_id);

CREATE INDEX idx_stock_movements_tenant_updated ON stock_movements (tenant_id, updated_at);

CREATE INDEX idx_stock_reconciliation_items_sync_id ON stock_reconciliation_items (sync_id);

CREATE INDEX idx_stock_reconciliation_items_tenant_updated ON stock_reconciliation_items (tenant_id, updated_at);

CREATE INDEX idx_stock_reconciliations_sync_id ON stock_reconciliations (sync_id);

CREATE INDEX idx_stock_reconciliations_tenant_updated ON stock_reconciliations (tenant_id, updated_at);

CREATE INDEX idx_supplier_credit_note_items_sync_id ON supplier_credit_note_items (sync_id);

CREATE INDEX idx_supplier_credit_note_items_tenant_updated ON supplier_credit_note_items (tenant_id, updated_at);

CREATE INDEX idx_supplier_credit_notes_sync_id ON supplier_credit_notes (sync_id);

CREATE INDEX idx_supplier_credit_notes_tenant_updated ON supplier_credit_notes (tenant_id, updated_at);

CREATE INDEX idx_suppliers_sync_id ON suppliers (sync_id);

CREATE INDEX idx_suppliers_tenant_updated ON suppliers (tenant_id, updated_at);

CREATE UNIQUE INDEX idx_tank_dips_tank_date ON tank_dips(tank_id, dip_date) WHERE shift_type IS NULL;

CREATE UNIQUE INDEX idx_tank_dips_tank_shift ON tank_dips(tank_id, dip_date, shift_type) WHERE shift_type IS NOT NULL;

CREATE INDEX idx_tank_movements_tank_date ON tank_movements(tank_id, movement_date);

CREATE INDEX idx_tanks_fuel_grade ON tanks(fuel_grade_id);

CREATE INDEX idx_units_sync_id ON units (sync_id);

CREATE INDEX idx_units_tenant_updated ON units (tenant_id, updated_at);

CREATE INDEX idx_users_sync_id ON users (sync_id);

CREATE INDEX idx_users_tenant_updated ON users (tenant_id, updated_at);

CREATE INDEX idx_zra_audit_cis     ON zra_audit_log (cis_invc_no);

CREATE INDEX idx_zra_audit_created ON zra_audit_log (created_at);

CREATE INDEX idx_zra_audit_result  ON zra_audit_log (result_cd);

CREATE INDEX idx_zra_codes_cls ON zra_codes (cd_cls);

CREATE INDEX idx_zra_item_classes_lvl ON zra_item_classes (item_cls_lvl);

CREATE INDEX idx_zra_item_classes_nm  ON zra_item_classes (item_cls_nm);

CREATE UNIQUE INDEX ix_zra_pending_imports_dedup
      ON zra_pending_imports(task_cd, dcl_no, item_seq)
      WHERE task_cd IS NOT NULL AND item_seq IS NOT NULL;

CREATE INDEX ix_zra_pending_imports_status
      ON zra_pending_imports(status);

CREATE UNIQUE INDEX ix_zra_pending_purchases_dedup
      ON zra_pending_purchases(spplr_tpin, spplr_invc_no)
      WHERE spplr_tpin IS NOT NULL AND spplr_invc_no IS NOT NULL;

CREATE INDEX ix_zra_pending_purchases_status
      ON zra_pending_purchases(status);

CREATE UNIQUE INDEX ix_zra_supplier_item_map_key
      ON zra_supplier_item_map(spplr_tpin, spplr_item_cd);

CREATE UNIQUE INDEX ix_zra_supplier_map_key
      ON zra_supplier_map(spplr_tpin);

CREATE TRIGGER trg_stamp_cost_at_sale
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
