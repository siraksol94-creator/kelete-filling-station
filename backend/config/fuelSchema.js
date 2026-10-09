// Kelete Fuel schema - creates all fuel-specific tables if missing.
// Called from server.js and server-tenant.js on boot.

function initFuelSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fuel_grades (
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

    -- Tank groups: physically plumbed-together tanks sharing one pool of
    -- fuel. Nozzles still point at individual tanks (that's where the
    -- plumbing lands), but sales deduct proportionally from every tank in
    -- the group so the UI can show one combined card.
    CREATE TABLE IF NOT EXISTS tank_groups (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      fuel_grade_id  INTEGER NOT NULL REFERENCES fuel_grades(id),
      branch_id      INTEGER,
      status         TEXT NOT NULL DEFAULT 'Active',
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tanks (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      code              TEXT NOT NULL,
      name              TEXT NOT NULL,
      fuel_grade_id     INTEGER NOT NULL REFERENCES fuel_grades(id),
      tank_group_id     INTEGER REFERENCES tank_groups(id) ON DELETE SET NULL,
      capacity_litres   REAL NOT NULL,
      current_volume    REAL NOT NULL DEFAULT 0,
      low_stock_litres  REAL DEFAULT 1000,
      branch_id         INTEGER,
      status            TEXT NOT NULL DEFAULT 'Active',
      sync_id           TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Idempotent column add for existing deployments (ignores "duplicate column" error)
    -- SQLite ALTER TABLE ADD COLUMN is non-destructive; wrap in a safe helper


    CREATE TABLE IF NOT EXISTS pumps (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      branch_id   INTEGER,
      status      TEXT NOT NULL DEFAULT 'Active',
      sync_id     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS nozzles (
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

    CREATE TABLE IF NOT EXISTS attendant_shifts (
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
      notes              TEXT,
      sync_id            TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS shift_nozzle_readings (
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

    CREATE TABLE IF NOT EXISTS fuel_deliveries (
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

    CREATE TABLE IF NOT EXISTS fleet_customers (
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

    CREATE TABLE IF NOT EXISTS fleet_vehicles (
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

    CREATE TABLE IF NOT EXISTS fuel_sales (
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

    CREATE INDEX IF NOT EXISTS idx_fuel_sales_shift ON fuel_sales(shift_id);
    CREATE INDEX IF NOT EXISTS idx_fuel_sales_date ON fuel_sales(sale_date);
    CREATE INDEX IF NOT EXISTS idx_shift_readings_shift ON shift_nozzle_readings(shift_id);
    CREATE INDEX IF NOT EXISTS idx_nozzles_pump ON nozzles(pump_id);
    CREATE INDEX IF NOT EXISTS idx_tanks_fuel_grade ON tanks(fuel_grade_id);
    CREATE INDEX IF NOT EXISTS idx_tanks_group ON tanks(tank_group_id);
  `);

  // Idempotent column add for deployments that pre-date tank_group_id.
  // SQLite has no "ADD COLUMN IF NOT EXISTS", so catch the duplicate-column
  // error. First-time deploys already have the column from the CREATE above.
  try { db.exec('ALTER TABLE tanks ADD COLUMN tank_group_id INTEGER REFERENCES tank_groups(id)'); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

module.exports = { initFuelSchema };
