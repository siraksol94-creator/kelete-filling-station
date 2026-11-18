const router = require('express').Router();
const db = require('../config/database');
const { recordTankMovement } = require('../config/fuelSchema');
const { auth } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

router.get('/', auth, (req, res) => {
  try {
    const { status, from, to } = req.query;
    const where = [];
    const params = [];
    if (status) { where.push('s.status = ?'); params.push(status); }
    if (from)   { where.push("date(s.opened_at) >= date(?)"); params.push(from); }
    if (to)     { where.push("date(s.opened_at) <= date(?)"); params.push(to); }
    const sql = `
      SELECT s.*, u.first_name || ' ' || u.last_name AS attendant_name
        FROM attendant_shifts s
        LEFT JOIN users u ON u.id = s.attendant_user_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.opened_at DESC
    `;
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/current', auth, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT s.*, u.first_name || ' ' || u.last_name AS attendant_name
        FROM attendant_shifts s
        LEFT JOIN users u ON u.id = s.attendant_user_id
       WHERE s.status = 'Open' AND s.attendant_user_id = ?
       ORDER BY s.opened_at DESC
       LIMIT 1
    `).get(req.user.id);
    if (!row) return res.json(null);
    row.readings = db.prepare(`
      SELECT snr.*, n.code AS nozzle_code, p.code AS pump_code,
             fg.name AS grade_name, fg.color AS grade_color
        FROM shift_nozzle_readings snr
        LEFT JOIN nozzles n ON n.id = snr.nozzle_id
        LEFT JOIN pumps p ON p.id = n.pump_id
        LEFT JOIN tanks t ON t.id = n.tank_id
        LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
       WHERE snr.shift_id = ?
    `).all(row.id);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// NOTE: static-path GETs (/all-tickets, /daily-rollup) MUST sit before the
// /:id route — Express matches top-down and /:id would otherwise swallow
// 'all-tickets' as an id, 404 the request, and silently break every page
// that calls these endpoints inside a Promise.all.
router.get('/all-tickets', auth, (req, res) => {
  try {
    const { method, from, to, customer_id, attendant_user_id, shift_id } = req.query;
    const where = [];
    const params = [];
    if (method)             { where.push("cs.payment_method = ?"); params.push(method); }
    if (from)               { where.push("COALESCE(cs.date, DATE(cs.created_at)) >= ?"); params.push(from); }
    if (to)                 { where.push("COALESCE(cs.date, DATE(cs.created_at)) <= ?"); params.push(to); }
    if (customer_id)        { where.push("cs.customer_id = ?"); params.push(customer_id); }
    if (attendant_user_id)  { where.push("s.attendant_user_id = ?"); params.push(attendant_user_id); }
    if (shift_id)           { where.push("cs.shift_id = ?"); params.push(shift_id); }
    const sql = `
      SELECT cs.*,
             s.attendant_user_id, u.first_name || ' ' || u.last_name AS attendant_name, s.status AS shift_status, s.opened_at,
             fg.name AS grade_name, fg.color AS grade_color
        FROM shift_credit_sales cs
        LEFT JOIN attendant_shifts s ON s.id = cs.shift_id
        LEFT JOIN users u ON u.id = s.attendant_user_id
        LEFT JOIN fuel_grades fg ON fg.id = cs.fuel_grade_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY cs.created_at DESC
       LIMIT 1000
    `;
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/daily-rollup', auth, (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });
    const shifts = db.prepare(`
      SELECT s.*, u.first_name || ' ' || u.last_name AS attendant_name
        FROM attendant_shifts s
        LEFT JOIN users u ON u.id = s.attendant_user_id
       WHERE DATE(s.opened_at) = DATE(?)
       ORDER BY s.opened_at
    `).all(date);
    for (const s of shifts) {
      s.gross_from_nozzles = db.prepare("SELECT COALESCE(SUM(expected_cash),0) AS t FROM shift_nozzle_readings WHERE shift_id = ?").get(s.id).t;
      s.credit_total  = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM shift_credit_sales WHERE shift_id = ? AND payment_method = 'Credit'").get(s.id).t;
      s.onecard_total = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM shift_credit_sales WHERE shift_id = ? AND payment_method = '1Card'").get(s.id).t;

      // POS sales rolled up per shift. Excludes orders already counted
      // in shift_credit_sales (fuel credit tickets) to avoid double-count.
      const posSums = db.prepare(`
        SELECT
          COALESCE(SUM(total_amount), 0) AS gross,
          COALESCE(SUM(CASE WHEN payment_method = 'Credit' THEN total_amount ELSE 0 END), 0) AS credit,
          COALESCE(SUM(CASE WHEN payment_method IN ('MoMo', 'Mobile Money', 'Airtel', 'MTN') THEN total_amount ELSE 0 END), 0) AS momo,
          COALESCE(SUM(CASE WHEN payment_method IN ('Bank', 'Card', 'Swipe', 'POS Card') THEN total_amount ELSE 0 END), 0) AS bank,
          COALESCE(SUM(CASE WHEN payment_method = 'Cash' THEN total_amount ELSE 0 END), 0) AS cash
        FROM orders
        WHERE shift_id = ?
          AND COALESCE(deleted_at, '') = ''
          AND id NOT IN (SELECT linked_order_id FROM shift_credit_sales WHERE shift_id = ? AND linked_order_id IS NOT NULL)
      `).get(s.id, s.id);
      s.pos_gross       = Number(posSums.gross || 0);
      s.pos_credit      = Number(posSums.credit || 0);
      s.pos_momo        = Number(posSums.momo || 0);
      s.pos_bank        = Number(posSums.bank || 0);
      s.pos_cash        = Number(posSums.cash || 0);

      s.shift_type = s.shift_type || 'DAY';
      s.approval = db.prepare(`
        SELECT a.*, u.first_name || ' ' || u.last_name AS approved_by_name
          FROM fuel_shift_approvals a
          LEFT JOIN users u ON u.id = a.approved_by
         WHERE a.approval_date = DATE(?) AND a.shift_type = ?
      `).get(date, s.shift_type) || null;
    }
    res.json(shifts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Day summary: everything the Fuel Cash Report bottom panel needs — fuel
// sales broken down per pump × grade, dip-vs-reading per grade, deductions
// (mobile money + swipes typed on shifts, plus 1Card and credit totals
// per customer from the ticket ledger), and the station totals for the
// date. One trip to the backend so the UI doesn't have to shred it.
router.get('/day-summary', auth, (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) is required' });

    const shifts = db.prepare(`
      SELECT id, status, payment_cash, payment_mobile, payment_swipes, expected_cash
        FROM attendant_shifts
       WHERE DATE(opened_at) = DATE(?)
    `).all(date);
    const shiftIds = shifts.map(s => s.id);
    const placeholders = shiftIds.map(() => '?').join(',') || "''";

    // Per pump × grade fuel sales (from nozzle readings)
    const pumpGrades = shiftIds.length === 0 ? [] : db.prepare(`
      SELECT p.id AS pump_id, p.code AS pump_code, p.name AS pump_name,
             fg.id AS grade_id, fg.name AS grade_name, fg.color AS grade_color,
             COALESCE(SUM(snr.litres_sold), 0) AS litres,
             COALESCE(SUM(snr.expected_cash), 0) AS amount
        FROM shift_nozzle_readings snr
        JOIN nozzles n ON n.id = snr.nozzle_id
        JOIN pumps p ON p.id = n.pump_id
        LEFT JOIN tanks t ON t.id = n.tank_id
        LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
       WHERE snr.shift_id IN (${placeholders})
       GROUP BY p.id, fg.id
       ORDER BY p.code, fg.name
    `).all(...shiftIds);

    // DIP vs READ per grade — two measurements of the SAME quantity
    // (litres sold today) from two different sources:
    //   READ = sum of nozzle meter deltas for the date (electronic)
    //   DIP  = opening tank level + deliveries - closing tank level,
    //          summed across all tanks of that grade (physical)
    //   Variance = READ - DIP  (positive = meter counted more than
    //              tank gave up; negative = tank lost more than meter)
    //
    // Opening tank level for the date = measured_litres from the most
    // recent tank_dips row strictly BEFORE the date. If no prior dip
    // exists for a tank, that tank is excluded from the comparison
    // (we can't compute its drop).
    const readingByGrade = shiftIds.length === 0 ? [] : db.prepare(`
      SELECT fg.id AS grade_id, fg.name AS grade_name, fg.color AS grade_color,
             COALESCE(SUM(snr.litres_sold), 0) AS reading_total
        FROM shift_nozzle_readings snr
        JOIN nozzles n ON n.id = snr.nozzle_id
        JOIN tanks t ON t.id = n.tank_id
        JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
       WHERE snr.shift_id IN (${placeholders})
       GROUP BY fg.id
    `).all(...shiftIds);
    const readMap = Object.fromEntries(readingByGrade.map(r => [r.grade_id, { name: r.grade_name, color: r.grade_color, read: Number(r.reading_total) }]));

    // Per-tank dip detail — the "TANK DIPS" strip at the top of the paper
    // form. One row per tank with today's measured level, the opening
    // baseline (previous dip when available, else the ledger's running
    // balance at the start of the day), and today's deliveries so the
    // UI can show the raw dip + the day's physical disappearance.
    const tankDipsDetail = db.prepare(`
      SELECT t.id AS tank_id, t.code AS tank_code, t.name AS tank_name, t.group_code,
             fg.id AS grade_id, fg.name AS grade_name, fg.color AS grade_color,
             d.measured_litres AS closing_dip,
             (
               SELECT dp.measured_litres FROM tank_dips dp
                WHERE dp.tank_id = t.id AND dp.dip_date < DATE(?)
                ORDER BY dp.dip_date DESC LIMIT 1
             ) AS prior_dip,
             (
               SELECT COALESCE(SUM(m.litres), 0) FROM tank_movements m
                WHERE m.tank_id = t.id AND m.movement_date < DATE(?)
             ) AS ledger_opening,
             (
               SELECT COALESCE(SUM(fd.litres_delivered), 0) FROM fuel_deliveries fd
                WHERE fd.tank_id = t.id AND DATE(fd.delivery_date) = DATE(?)
             ) AS deliveries
        FROM tanks t
        LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
        LEFT JOIN tank_dips d ON d.tank_id = t.id AND d.dip_date = DATE(?)
       WHERE t.status = 'Active'
       ORDER BY t.code
    `).all(date, date, date, date);
    // Normalise opening — prior dip wins (physical truth), else fall back
    // to the ledger balance at start of day (book truth) so day-one dips
    // still produce a variance.
    for (const t of tankDipsDetail) {
      t.opening_dip = t.prior_dip != null ? Number(t.prior_dip) : Number(t.ledger_opening || 0);
      t.opening_source = t.prior_dip != null ? 'dip' : 'ledger';
    }

    // Roll per-tank drops into per-grade DIP totals, but only count tanks
    // that have BOTH an opening and a closing dip (otherwise the drop is
    // meaningless).
    const dipByGrade = {};
    for (const t of tankDipsDetail) {
      if (t.closing_dip == null || t.opening_dip == null) continue;
      if (!t.grade_id) continue;
      const drop = Number(t.opening_dip) + Number(t.deliveries || 0) - Number(t.closing_dip);
      if (!dipByGrade[t.grade_id]) dipByGrade[t.grade_id] = { name: t.grade_name, color: t.grade_color, dip: 0, counted_tanks: 0 };
      dipByGrade[t.grade_id].dip += drop;
      dipByGrade[t.grade_id].counted_tanks += 1;
    }

    // Final per-grade reconciliation — union of grades that had READ or DIP
    const gradeIds = Array.from(new Set([...Object.keys(readMap), ...Object.keys(dipByGrade)]));
    const dips = gradeIds.map(gid => {
      const r = readMap[gid] || { read: 0 };
      const d = dipByGrade[gid] || { dip: null, counted_tanks: 0 };
      const name = r.name || d.name || '';
      const color = r.color || d.color || '#6b7280';
      const read_total = Number(r.read || 0);
      const dip_total = d.dip == null ? null : Number(d.dip);
      const variance = dip_total == null ? null : Number((read_total - dip_total).toFixed(2));
      return { grade_id: Number(gid), grade_name: name, grade_color: color,
               read_total, dip_total, variance, counted_tanks: d.counted_tanks };
    });

    // Per-customer breakdown (credit + 1card)
    const credits = shiftIds.length === 0 ? [] : db.prepare(`
      SELECT customer_name, COALESCE(SUM(amount), 0) AS total
        FROM shift_credit_sales
       WHERE shift_id IN (${placeholders}) AND payment_method = 'Credit'
       GROUP BY customer_name
       ORDER BY customer_name
    `).all(...shiftIds);

    const onecards = shiftIds.length === 0 ? [] : db.prepare(`
      SELECT customer_name, card_number, COALESCE(SUM(amount), 0) AS total
        FROM shift_credit_sales
       WHERE shift_id IN (${placeholders}) AND payment_method = '1Card'
       GROUP BY customer_name, card_number
       ORDER BY customer_name
    `).all(...shiftIds);

    // Totals
    const grossRow = shiftIds.length === 0 ? { t: 0 } : db.prepare(`
      SELECT COALESCE(SUM(expected_cash), 0) AS t
        FROM shift_nozzle_readings
       WHERE shift_id IN (${placeholders})
    `).get(...shiftIds);
    const gross = Number(grossRow.t);
    const mobileMoney = shifts.reduce((s, x) => s + Number(x.payment_mobile || 0), 0);
    const swipes      = shifts.reduce((s, x) => s + Number(x.payment_swipes || 0), 0);
    const creditTotal = credits.reduce((s, r) => s + Number(r.total), 0);
    const onecardTotal = onecards.reduce((s, r) => s + Number(r.total), 0);
    const totalDeductions = mobileMoney + swipes + creditTotal + onecardTotal;
    const expectedCash = Math.max(0, gross - totalDeductions);
    const cashInHand   = shifts.reduce((s, x) => s + Number(x.payment_cash || 0), 0);
    const variance     = Number((cashInHand - expectedCash).toFixed(2));

    res.json({
      pumpGrades, dips, tank_dips_detail: tankDipsDetail, credits, onecards,
      deductions: { mobile_money: mobileMoney, swipes, onecard_total: onecardTotal, credit_total: creditTotal, total: totalDeductions },
      totals: { gross, expected_cash: expectedCash, cash_in_hand: cashInHand, variance },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', auth, (req, res) => {
  const row = db.prepare(`
    SELECT s.*, u.first_name || ' ' || u.last_name AS attendant_name
      FROM attendant_shifts s
      LEFT JOIN users u ON u.id = s.attendant_user_id
     WHERE s.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  row.readings = db.prepare(`
    SELECT snr.*, n.code AS nozzle_code, p.code AS pump_code,
           n.tank_id, t.code AS tank_code,
           fg.id AS grade_id, fg.name AS grade_name, fg.color AS grade_color
      FROM shift_nozzle_readings snr
      LEFT JOIN nozzles n ON n.id = snr.nozzle_id
      LEFT JOIN pumps p ON p.id = n.pump_id
      LEFT JOIN tanks t ON t.id = n.tank_id
      LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
     WHERE snr.shift_id = ?
  `).all(req.params.id);
  row.credit_sales = db.prepare(`
    SELECT cs.*, fc.name AS fleet_customer_name,
           fg.name AS grade_name, fg.color AS grade_color
      FROM shift_credit_sales cs
      LEFT JOIN fleet_customers fc ON fc.id = cs.fleet_customer_id
      LEFT JOIN fuel_grades fg ON fg.id = cs.fuel_grade_id
     WHERE cs.shift_id = ?
     ORDER BY cs.id
  `).all(req.params.id);
  row.dips = db.prepare(`
    SELECT d.*, t.code AS tank_code, t.name AS tank_name,
           fg.name AS grade_name, fg.color AS grade_color
      FROM shift_dips d
      LEFT JOIN tanks t ON t.id = d.tank_id
      LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
     WHERE d.shift_id = ?
  `).all(req.params.id);
  res.json(row);
});

// Open a shift: attendant + list of nozzle_ids to assign (opening meter is snapshotted from each nozzle)
router.post('/open', auth, (req, res) => {
  const tx = db.transaction(() => {
    const { attendant_user_id, nozzle_ids = [], branch_id = null, notes = '', shift_type = null } = req.body;
    if (!attendant_user_id) throw new Error('attendant_user_id is required');
    if (!Array.isArray(nozzle_ids) || nozzle_ids.length === 0) throw new Error('nozzle_ids (array) is required');

    // Block if attendant has an open shift
    const open = db.prepare("SELECT id FROM attendant_shifts WHERE attendant_user_id = ? AND status = 'Open'").get(attendant_user_id);
    if (open) throw new Error('Attendant already has an open shift');

    // Default DAY/NIGHT by current hour if the UI didn't supply one.
    const inferType = () => {
      const h = new Date().getHours();
      return (h >= 6 && h < 18) ? 'DAY' : 'NIGHT';
    };
    const t = (shift_type && ['DAY', 'NIGHT'].includes(String(shift_type).toUpperCase()))
      ? String(shift_type).toUpperCase()
      : inferType();

    const info = db.prepare(`
      INSERT INTO attendant_shifts (attendant_user_id, branch_id, opened_by, notes, shift_type)
      VALUES (?,?,?,?,?)
    `).run(attendant_user_id, branch_id, req.user?.id || null, notes, t);
    const shiftId = info.lastInsertRowid;

    const insReading = db.prepare(`
      INSERT INTO shift_nozzle_readings (shift_id, nozzle_id, opening_reading, price_per_litre)
      VALUES (?,?,?,?)
    `);
    for (const nid of nozzle_ids) {
      const n = db.prepare(`
        SELECT n.*, fg.selling_price
          FROM nozzles n
          LEFT JOIN tanks t ON t.id = n.tank_id
          LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
         WHERE n.id = ?
      `).get(nid);
      if (!n) throw new Error('Nozzle not found: ' + nid);
      insReading.run(shiftId, nid, n.current_meter_reading || 0, n.selling_price || 0);
    }
    return db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(shiftId);
  });
  try { res.status(201).json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Add a credit sale (receivable ticket) to an open shift during the shift.
// Also usable in batch at close by submitting them with the close call.
// Lazy-get the products row for a fuel grade so credit sales can insert a
// matching order_items line. Keeps the fuel grade and the "product" (what
// Account Receivables sees) in lock-step without needing a seed script.
function ensureProductForGrade(gradeId, syncCfg, tenantId, userSyncId) {
  if (!gradeId) return null;
  const grade = db.prepare('SELECT * FROM fuel_grades WHERE id = ?').get(gradeId);
  if (!grade) return null;
  const existing = db.prepare('SELECT id, sync_id FROM products WHERE LOWER(code) = LOWER(?) AND deleted_at IS NULL AND tenant_id = ?')
    .get(`FUEL-${grade.code}`, tenantId);
  if (existing) return existing;
  const info = db.prepare(`
    INSERT INTO products (code, name, unit, cost_price, selling_price, current_stock, min_stock,
                           sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
  `).run(`FUEL-${grade.code}`, grade.name, grade.unit || 'L', grade.cost_price || 0,
         grade.selling_price || 0, 0, 0,
         randomUUID(), tenantId, syncCfg.branchId, syncCfg.deviceId);
  return { id: info.lastInsertRowid, sync_id: db.prepare('SELECT sync_id FROM products WHERE id = ?').get(info.lastInsertRowid).sync_id };
}

function nextOrderNumber(tenantId) {
  // Pick MAX suffix across ALL FUEL-* orders (including soft-deleted),
  // otherwise deleting a ticket drops the count and the next ticket
  // collides with the retired order_number (UNIQUE constraint fires).
  const row = db.prepare(`
    SELECT MAX(CAST(SUBSTR(order_number, 6) AS INTEGER)) AS maxN
      FROM orders
     WHERE tenant_id = ? AND order_number LIKE 'FUEL-%'
  `).get(tenantId);
  const next = (Number(row?.maxN) || 0) + 1;
  return `FUEL-${String(next).padStart(7, '0')}`;
}

router.post('/:id/credit-sales', auth, (req, res) => {
  const tx = db.transaction(() => {
    const shift = db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(req.params.id);
    if (!shift) throw new Error('Shift not found');
    if (shift.status !== 'Open') throw new Error('Shift already closed');
    const { payment_method = 'Credit',
            customer_id = null, customer_name, card_number = '',
            vehicle_registration = '', fuel_grade_id = null,
            litres, price_per_litre, amount = null,
            receipt_number = '', notes = '', date = null } = req.body;
    const method = String(payment_method).trim() || 'Credit';
    if (!customer_name || !(Number(litres) > 0)) throw new Error('customer_name and litres are required');
    const ppl = Number(price_per_litre) || 0;
    const qty = Number(litres);
    const amt = amount != null ? Number(amount) : Number((qty * ppl).toFixed(2));

    // Resolve the standard customer row (sync_id is what Account Receivables joins on)
    let customer = null;
    if (customer_id) {
      customer = db.prepare('SELECT id, sync_id, name FROM customers WHERE id = ? AND deleted_at IS NULL').get(customer_id);
    }

    let linkedOrderId = null;
    // 'Credit' routes through the standard AR plumbing by writing an order
    // + line item. '1Card' is tracked only in shift_credit_sales (Engen
    // reconciliation is monthly, not a Kelete customer receivable).
    if (method === 'Credit' && customer) {
      const syncCfg = syncConfig.getConfig();
      const tenantId = req.user.tenantId;
      const userSyncId = db.prepare('SELECT sync_id FROM users WHERE id = ?').get(req.user.id)?.sync_id || null;
      const product = ensureProductForGrade(fuel_grade_id, syncCfg, tenantId, userSyncId);
      const orderNumber = nextOrderNumber(tenantId);
      const orderSyncId = randomUUID();
      const info = db.prepare(`
        INSERT INTO orders (order_number, customer_name, customer_id, customer_sync_id,
                            subtotal, tax_amount, total_amount, discount,
                            amount_received, cash_received,
                            payment_method, created_by, created_by_sync_id,
                            status, sync_id, tenant_id, branch_id, device_id, synced,
                            shift_id,
                            created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),datetime('now'))
      `).run(orderNumber, customer.name, customer.id, customer.sync_id,
             amt, 0, amt, 0,
             0, 0,
             'Credit', req.user.id, userSyncId,
             null, orderSyncId, tenantId, syncCfg.branchId, syncCfg.deviceId,
             Number(req.params.id));
      linkedOrderId = info.lastInsertRowid;
      if (product) {
        db.prepare(`
          INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, total_price)
          VALUES (?,?,?,?,?,?)
        `).run(linkedOrderId, product.id, db.prepare('SELECT name FROM fuel_grades WHERE id = ?').get(fuel_grade_id)?.name || 'Fuel', qty, ppl, amt);
      }
    }

    const info = db.prepare(`
      INSERT INTO shift_credit_sales (
        shift_id, payment_method, customer_id, customer_sync_id, customer_name,
        card_number, vehicle_registration, fuel_grade_id,
        litres, price_per_litre, amount, receipt_number, notes,
        linked_order_id, date
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(req.params.id, method, customer?.id || null, customer?.sync_id || null, customer_name.trim(),
           card_number, vehicle_registration, fuel_grade_id,
           qty, ppl, amt, receipt_number, notes,
           linkedOrderId, date || new Date().toISOString().slice(0, 10));

    return db.prepare('SELECT * FROM shift_credit_sales WHERE id = ?').get(info.lastInsertRowid);
  });
  try { res.status(201).json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Finalize a shift's cash reconciliation (called by Fuel Cash Report).
// Requires nozzle readings to be already saved (gross known). Takes the
// typed payment amounts (Cash, Mobile Money, Swipes). Expected cash is
// derived from gross minus (mobile + swipes + credit + 1card).
router.post('/:id/finalize', auth, (req, res) => {
  const tx = db.transaction(() => {
    const shift = db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(req.params.id);
    if (!shift) throw new Error('Shift not found');
    // Lock: once this shift's (date, shift_type) window is approved,
    // cash fields are frozen. Admin would need to un-approve on Fuel
    // Cash Report first.
    const approved = db.prepare(`
      SELECT 1 FROM fuel_shift_approvals
       WHERE approval_date = DATE(?) AND shift_type = COALESCE(?, 'DAY')
    `).get(shift.opened_at, shift.shift_type);
    if (approved) throw new Error(`${shift.shift_type || 'DAY'} shift is approved — un-approve on Fuel Cash Report first.`);
    const { payment_cash = 0, payment_mobile = 0, payment_swipes = 0, notes = '' } = req.body;
    const gross = db.prepare("SELECT COALESCE(SUM(expected_cash),0) AS t FROM shift_nozzle_readings WHERE shift_id = ?").get(req.params.id).t;
    const credit  = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM shift_credit_sales WHERE shift_id = ? AND payment_method = 'Credit'").get(req.params.id).t;
    const onecard = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM shift_credit_sales WHERE shift_id = ? AND payment_method = '1Card'").get(req.params.id).t;
    const nonCash = Number(payment_mobile) + Number(payment_swipes) + credit + onecard;
    const expectedCash = Number((gross - nonCash).toFixed(2));
    const variance = Number((Number(payment_cash) - expectedCash).toFixed(2));
    db.prepare(`
      UPDATE attendant_shifts
         SET status = 'Closed', closed_at = COALESCE(closed_at, datetime('now')), closed_by = COALESCE(closed_by, ?),
             expected_cash = ?, actual_cash = ?, variance = ?,
             payment_cash = ?, payment_mobile = ?, payment_swipes = ?,
             payment_1card = ?, payment_other = ?,
             notes = COALESCE(?, notes), updated_at = datetime('now')
       WHERE id = ?
    `).run(req.user?.id || null, expectedCash, Number(payment_cash), variance,
           Number(payment_cash), Number(payment_mobile), Number(payment_swipes),
           Number(onecard), Number(credit),
           notes || null, req.params.id);
    return db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(req.params.id);
  });
  try { res.json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Hard-delete a shift and everything downstream. Requires the caller's
// own password (must be Administrator role).
//
// What gets removed/reversed:
//   - shift_nozzle_readings       → ON DELETE CASCADE
//     + reverses nozzles.current_meter_reading back to opening_reading
//     + adds litres_sold back to tanks.current_volume
//   - shift_credit_sales          → ON DELETE CASCADE
//     + soft-deletes each row's linked orders (AR stops showing them)
//   - shift_dips                  → ON DELETE CASCADE (no side-effect)
//   - fuel_sales                  → explicit DELETE (legacy table, no cascade)
//   - attendant_shifts            → the shift itself
router.post('/:id/delete', auth, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password) return res.status(400).json({ error: 'Password required' });
    const bcrypt = require('bcrypt');
    const admin = db.prepare("SELECT id, password, role FROM users WHERE id = ? AND deleted_at IS NULL").get(req.user?.id);
    if (!admin) return res.status(401).json({ error: 'User not found' });
    if (admin.role !== 'Administrator') return res.status(403).json({ error: 'Only administrators can delete shifts' });
    if (!(await bcrypt.compare(String(password), admin.password))) {
      return res.status(401).json({ error: 'Wrong password' });
    }

    const tx = db.transaction(() => {
      const shift = db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(req.params.id);
      if (!shift) throw new Error('Shift not found');

      // Reverse nozzle meter + tank volume side-effects of the close
      const readings = db.prepare('SELECT * FROM shift_nozzle_readings WHERE shift_id = ?').all(req.params.id);
      const updNozzle = db.prepare("UPDATE nozzles SET current_meter_reading = ?, updated_at = datetime('now') WHERE id = ?");
      for (const r of readings) {
        updNozzle.run(Number(r.opening_reading || 0), r.nozzle_id);
        const litres = Number(r.litres_sold || 0);
        if (litres > 0) {
          const noz = db.prepare('SELECT tank_id FROM nozzles WHERE id = ?').get(r.nozzle_id);
          if (noz?.tank_id) {
            recordTankMovement(db, {
              tank_id: noz.tank_id, litres, type: 'reversal',
              ref_table: 'attendant_shifts', ref_id: Number(req.params.id),
              notes: `Reversed sales for deleted shift #${req.params.id}`,
              created_by: req.user?.id || null,
            });
          }
        }
      }

      // Soft-delete the AR orders created from credit tickets
      const sales = db.prepare('SELECT linked_order_id FROM shift_credit_sales WHERE shift_id = ? AND linked_order_id IS NOT NULL').all(req.params.id);
      const softDelOrder = db.prepare("UPDATE orders SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?");
      for (const s of sales) softDelOrder.run(s.linked_order_id);

      // Legacy POS-style fuel_sales rows (no cascade)
      db.prepare('DELETE FROM fuel_sales WHERE shift_id = ?').run(req.params.id);

      // The shift itself (cascades handle shift_nozzle_readings / shift_credit_sales / shift_dips)
      db.prepare('DELETE FROM attendant_shifts WHERE id = ?').run(req.params.id);
    });
    tx();
    res.json({ message: 'Shift deleted' });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Reopen a closed shift (e.g. a credit sale was missed and the attendant
// needs to add it before finalising for the day). Does NOT touch any
// readings/payments already saved — just flips status back to Open so
// the Credit/1Card ticket pages let the user post to it.
router.post('/:id/reopen', auth, (req, res) => {
  try {
    const shift = db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(req.params.id);
    if (!shift) return res.status(404).json({ error: 'Shift not found' });
    if (shift.status === 'Open') return res.json({ message: 'Already open', shift });
    db.prepare(`
      UPDATE attendant_shifts
         SET status = 'Open', closed_at = NULL, closed_by = NULL,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(req.params.id);
    res.json({ message: 'Reopened', shift: db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(req.params.id) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/credit-sales/:cid', auth, (req, res) => {
  const tx = db.transaction(() => {
    const cs = db.prepare('SELECT * FROM shift_credit_sales WHERE id = ?').get(req.params.cid);
    if (!cs) throw new Error('Not found');
    // Soft-delete the linked order so AR stops counting it (no hard delete —
    // sync peers would re-create it on next pull)
    if (cs.linked_order_id) {
      db.prepare("UPDATE orders SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?")
        .run(cs.linked_order_id);
    }
    db.prepare('DELETE FROM shift_credit_sales WHERE id = ?').run(req.params.cid);
    return { message: 'Deleted' };
  });
  try { res.json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

// Close a shift with the full reconciliation: nozzle closings, payment
// breakdown, credit-sale tickets (optional batch), dip readings per tank.
// Expected cash = gross nozzle sales - (swipes + 1card + mobile + other + credits).
// Cash variance = payment_cash - expected cash.
router.post('/:id/close', auth, (req, res) => {
  const tx = db.transaction(() => {
    const shift = db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(req.params.id);
    if (!shift) throw new Error('Shift not found');
    if (shift.status !== 'Open') throw new Error('Shift already closed');

    const {
      readings = [],
      payment_cash = 0, payment_swipes = 0, payment_1card = 0,
      payment_mobile = 0, payment_other = 0,
      credit_sales_batch = [],  // optional: insert these in one shot
      dips = [],                // [{tank_id, dip_litres}]
      notes = '',
    } = req.body;
    if (!Array.isArray(readings) || readings.length === 0) throw new Error('readings array is required');

    // 1. Nozzle closings → gross sales + per-nozzle updates
    let grossSales = 0;
    const updReading = db.prepare(`
      UPDATE shift_nozzle_readings
         SET closing_reading = ?, testing_litres = ?, litres_sold = ?, expected_cash = ?
       WHERE id = ?
    `);
    const updNozzle = db.prepare('UPDATE nozzles SET current_meter_reading = ?, updated_at = datetime(\'now\') WHERE id = ?');

    for (const r of readings) {
      const base = db.prepare('SELECT * FROM shift_nozzle_readings WHERE id = ?').get(r.id);
      if (!base) throw new Error('Reading not found: ' + r.id);
      const closing = Number(r.closing_reading);
      if (!isFinite(closing) || closing < base.opening_reading) {
        throw new Error(`Closing < opening for nozzle reading ${r.id}`);
      }
      const testing = Number(r.testing_litres || 0);
      const litresSold = Math.max(closing - base.opening_reading - testing, 0);
      const expected = Number((litresSold * base.price_per_litre).toFixed(2));
      const prevLitres = Number(base.litres_sold || 0);  // 0 on first close
      updReading.run(closing, testing, litresSold, expected, base.id);
      grossSales += expected;

      const noz = db.prepare('SELECT * FROM nozzles WHERE id = ?').get(base.nozzle_id);
      updNozzle.run(closing, base.nozzle_id);
      // Bin-card: outbound sale → one ledger row per nozzle per shift close
      // (negative litres). Delta semantics preserved so Reopen → re-Close
      // doesn't double-drain: the previous close's row stays, and we post
      // only the difference.
      const deltaLitres = litresSold - prevLitres;
      if (deltaLitres !== 0) {
        recordTankMovement(db, {
          tank_id: noz.tank_id, litres: -deltaLitres,
          type: 'sale', ref_table: 'attendant_shifts', ref_id: Number(req.params.id),
          notes: `Shift #${req.params.id} close · nozzle ${base.nozzle_id}`,
          created_by: req.user?.id || null,
        });
      }
    }

    // 2. Batch credit sales (if any were submitted with the close rather
    //    than inserted individually during the shift)
    const insCredit = db.prepare(`
      INSERT INTO shift_credit_sales (
        shift_id, fleet_customer_id, customer_name, vehicle_registration,
        fuel_grade_id, litres, price_per_litre, amount, receipt_number, notes
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    const updFleet = db.prepare('UPDATE fleet_customers SET current_balance = current_balance + ?, updated_at = datetime(\'now\') WHERE id = ?');
    for (const cs of credit_sales_batch) {
      if (!cs.customer_name || !(Number(cs.litres) > 0)) continue;
      const ppl = Number(cs.price_per_litre) || 0;
      const amt = cs.amount != null ? Number(cs.amount) : Number((Number(cs.litres) * ppl).toFixed(2));
      insCredit.run(req.params.id, cs.fleet_customer_id || null, cs.customer_name.trim(),
        cs.vehicle_registration || '', cs.fuel_grade_id || null, Number(cs.litres), ppl, amt,
        cs.receipt_number || '', cs.notes || '');
      if (cs.fleet_customer_id) updFleet.run(amt, cs.fleet_customer_id);
    }

    // 3. Dip readings per tank → compare to book volume. Clear any prior
    //    dips for this shift first so Reopen → re-Close replaces rather
    //    than duplicates.
    db.prepare('DELETE FROM shift_dips WHERE shift_id = ?').run(req.params.id);
    const insDip = db.prepare(`
      INSERT INTO shift_dips (shift_id, tank_id, dip_litres, reading_litres, variance)
      VALUES (?,?,?,?,?)
    `);
    for (const d of dips) {
      if (!d.tank_id || d.dip_litres == null) continue;
      const tank = db.prepare('SELECT current_volume FROM tanks WHERE id = ?').get(d.tank_id);
      const reading = tank ? Number(tank.current_volume) : null;
      const variance = reading != null ? Number((Number(d.dip_litres) - reading).toFixed(2)) : null;
      insDip.run(req.params.id, d.tank_id, Number(d.dip_litres), reading, variance);
    }

    // 4. Sum per-method ticket totals for this shift. Credit (receivables)
    //    and 1Card (Engen pre-paid card) are both auto-summed from the
    //    shift_credit_sales ledger — the attendant doesn't type them.
    const creditTotal  = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM shift_credit_sales WHERE shift_id = ? AND payment_method = 'Credit'").get(req.params.id).t;
    const onecardTotal = db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM shift_credit_sales WHERE shift_id = ? AND payment_method = '1Card'").get(req.params.id).t;

    // 5. Expected cash = gross - all non-cash deductions. Only Mobile Money
    //    and Swipes come in as typed numbers; Credit + 1Card are computed.
    const nonCashDeductions = Number(payment_swipes || 0) + Number(payment_mobile || 0)
                            + Number(creditTotal) + Number(onecardTotal);
    const expectedCash = Number((grossSales - nonCashDeductions).toFixed(2));
    const variance = Number((Number(payment_cash || 0) - expectedCash).toFixed(2));

    db.prepare(`
      UPDATE attendant_shifts
         SET status = 'Closed', closed_at = datetime('now'), closed_by = ?,
             expected_cash = ?, actual_cash = ?, variance = ?,
             payment_cash = ?, payment_swipes = ?, payment_1card = ?,
             payment_mobile = ?, payment_other = ?,
             notes = COALESCE(?, notes), updated_at = datetime('now')
       WHERE id = ?
    `).run(req.user?.id || null, expectedCash, Number(payment_cash) || 0, variance,
           Number(payment_cash) || 0, Number(payment_swipes) || 0, Number(onecardTotal),
           Number(payment_mobile) || 0, Number(creditTotal),
           notes || null, req.params.id);

    return db.prepare('SELECT * FROM attendant_shifts WHERE id = ?').get(req.params.id);
  });
  try { res.json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
