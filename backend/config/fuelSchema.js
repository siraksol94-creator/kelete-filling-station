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

    CREATE TABLE IF NOT EXISTS tanks (
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
    );

    -- Bin-card ledger for tanks. Every change to a tank's volume (opening,
    -- fuel delivery, shift-close sale, manual adjustment, dip-driven
    -- adjustment) writes exactly one row here. tanks.current_volume is a
    -- cache = sum(litres) for the tank. Nothing updates current_volume
    -- without a matching movement, so the ledger is the audit trail.
    CREATE TABLE IF NOT EXISTS tank_movements (
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
    CREATE INDEX IF NOT EXISTS idx_tank_movements_tank_date ON tank_movements(tank_id, movement_date);

    -- One dip measurement per tank per day. Taken at opening or by a
    -- supervisor, not per shift. Variance = measured - book_volume at the
    -- moment of save. An admin can later click "Post Adjustment" which
    -- writes a tank_movements row of type='dip_adjustment' and sets
    -- posted_adjustment_id so the dip can't be re-posted.
    CREATE TABLE IF NOT EXISTS tank_dips (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      tank_id                INTEGER NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
      dip_date               TEXT NOT NULL DEFAULT (date('now')),
      measured_litres        REAL NOT NULL,
      book_litres            REAL NOT NULL,
      variance               REAL NOT NULL,
      taken_by_user_id       INTEGER REFERENCES users(id),
      posted_adjustment_id   INTEGER REFERENCES tank_movements(id),
      notes                  TEXT,
      created_at             TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tank_dips_tank_date ON tank_dips(tank_id, dip_date);

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
    );

    -- Per-transaction non-cash sales inside a shift. payment_method
    -- distinguishes 'Credit' (posts to fleet customer's receivable ledger)
    -- from '1Card' (Engen fuel-card, reconciled against Engen's statement).
    -- Mobile Money + Swipes stay as lump sums on attendant_shifts.
    CREATE TABLE IF NOT EXISTS shift_credit_sales (
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
    );

    -- Dip-vs-reading reconciliation per tank per shift close.
    CREATE TABLE IF NOT EXISTS shift_dips (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id        INTEGER NOT NULL REFERENCES attendant_shifts(id) ON DELETE CASCADE,
      tank_id         INTEGER NOT NULL REFERENCES tanks(id),
      dip_litres      REAL NOT NULL,
      reading_litres  REAL,
      variance        REAL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
  `);

  // Idempotent column add for pre-existing tanks tables. vessel_count
  // controls how the tank is drawn (1 = single cylinder, 2+ = joined
  // vessels sharing one level — a logical merge of multiple physical
  // tanks). Data-model stays as one row; the number is UI-only.
  try { db.exec('ALTER TABLE tanks ADD COLUMN vessel_count INTEGER NOT NULL DEFAULT 1'); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

  // Plumbing group — tanks sharing a group_code are physically connected
  // at the bottom so fuel balances between them. They stay SEPARATE rows
  // (so deliveries and nozzle sales still attribute to the specific
  // tank), but the UI renders them as one card and the dip is a shared
  // measurement allocated proportionally across members.
  try { db.exec('ALTER TABLE tanks ADD COLUMN group_code TEXT'); }
  catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }

  // Payment-breakdown columns added later — safe to ALTER on upgrade.
  for (const col of ['payment_cash', 'payment_swipes', 'payment_1card', 'payment_mobile', 'payment_other']) {
    try { db.exec(`ALTER TABLE attendant_shifts ADD COLUMN ${col} REAL DEFAULT 0`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }
  // Idempotent column adds for the new per-transaction fields
  for (const col of [
    "payment_method TEXT NOT NULL DEFAULT 'Credit'",
    'card_number TEXT',
    'customer_id INTEGER',                 // → customers.id (standard AR path)
    'customer_sync_id TEXT',               // → customers.sync_id (for orders join)
    'linked_order_id INTEGER',             // the credit sale's corresponding orders row
    'date TEXT',                           // the business date of the sale
  ]) {
    try { db.exec(`ALTER TABLE shift_credit_sales ADD COLUMN ${col}`); }
    catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
  }

  // Backfill: every pre-existing tank's current_volume becomes an
  // 'opening' row in tank_movements so the ledger invariant
  // "current_volume == SUM(litres)" holds for day one.
  try {
    const tanks = db.prepare(`
      SELECT t.id, t.current_volume
        FROM tanks t
       WHERE NOT EXISTS (SELECT 1 FROM tank_movements m WHERE m.tank_id = t.id)
    `).all();
    const ins = db.prepare(`
      INSERT INTO tank_movements (tank_id, movement_date, type, litres, notes)
      VALUES (?, date('now'), 'opening', ?, 'Backfilled opening balance')
    `);
    for (const t of tanks) if (Number(t.current_volume || 0) !== 0) ins.run(t.id, Number(t.current_volume));
  } catch (e) { /* schema may still be initialising for a brand-new tenant */ }
}

// Record a signed litres movement + keep tanks.current_volume in step.
// All writers go through this: fuel deliveries (+), shift close (-),
// tank create opening (+), dip adjustments (±), shift delete reversal.
// Transaction-safe to call from inside db.transaction() blocks.
function recordTankMovement(db, { tank_id, litres, type, ref_table = null, ref_id = null, notes = '', created_by = null, movement_date = null }) {
  if (!tank_id || !type) throw new Error('tank_id + type required');
  const l = Number(litres);
  if (!isFinite(l)) throw new Error('litres must be a number');
  const info = db.prepare(`
    INSERT INTO tank_movements (tank_id, movement_date, type, litres, ref_table, ref_id, notes, created_by)
    VALUES (?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?)
  `).run(tank_id, movement_date, type, l, ref_table, ref_id, notes || null, created_by);
  db.prepare("UPDATE tanks SET current_volume = current_volume + ?, updated_at = datetime('now') WHERE id = ?").run(l, tank_id);
  return info.lastInsertRowid;
}

module.exports = { initFuelSchema, recordTankMovement };

module.exports = { initFuelSchema };
