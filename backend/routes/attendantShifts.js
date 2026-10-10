const router = require('express').Router();
const db = require('../config/database');
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
    }
    res.json(shifts);
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
    const { attendant_user_id, nozzle_ids = [], branch_id = null, notes = '' } = req.body;
    if (!attendant_user_id) throw new Error('attendant_user_id is required');
    if (!Array.isArray(nozzle_ids) || nozzle_ids.length === 0) throw new Error('nozzle_ids (array) is required');

    // Block if attendant has an open shift
    const open = db.prepare("SELECT id FROM attendant_shifts WHERE attendant_user_id = ? AND status = 'Open'").get(attendant_user_id);
    if (open) throw new Error('Attendant already has an open shift');

    const info = db.prepare(`
      INSERT INTO attendant_shifts (attendant_user_id, branch_id, opened_by, notes)
      VALUES (?,?,?,?)
    `).run(attendant_user_id, branch_id, req.user?.id || null, notes);
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
  const row = db.prepare("SELECT COUNT(*) AS c FROM orders WHERE tenant_id = ? AND deleted_at IS NULL").get(tenantId);
  return `FUEL-${String(row.c + 1).padStart(7, '0')}`;
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
                            created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(orderNumber, customer.name, customer.id, customer.sync_id,
             amt, 0, amt, 0,
             0, 0,
             'Credit', req.user.id, userSyncId,
             null, orderSyncId, tenantId, syncCfg.branchId, syncCfg.deviceId);
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
    const updTank   = db.prepare('UPDATE tanks SET current_volume = current_volume - ?, updated_at = datetime(\'now\') WHERE id = ?');

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
      updReading.run(closing, testing, litresSold, expected, base.id);
      grossSales += expected;

      const noz = db.prepare('SELECT * FROM nozzles WHERE id = ?').get(base.nozzle_id);
      updNozzle.run(closing, base.nozzle_id);
      updTank.run(litresSold, noz.tank_id);
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

    // 3. Dip readings per tank → compare to book volume
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
