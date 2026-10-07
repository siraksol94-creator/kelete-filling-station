const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');

function nextSaleNumber() {
  const row = db.prepare("SELECT COUNT(*) AS c FROM fuel_sales WHERE sale_number LIKE 'FS-%'").get();
  return `FS-${String(row.c + 1).padStart(7, '0')}`;
}

router.get('/', auth, (req, res) => {
  try {
    const { from, to, shift_id, payment_method } = req.query;
    const where = [];
    const params = [];
    if (from)           { where.push("date(fs.sale_date) >= date(?)"); params.push(from); }
    if (to)             { where.push("date(fs.sale_date) <= date(?)"); params.push(to); }
    if (shift_id)       { where.push("fs.shift_id = ?"); params.push(shift_id); }
    if (payment_method) { where.push("fs.payment_method = ?"); params.push(payment_method); }
    const sql = `
      SELECT fs.*, n.code AS nozzle_code, p.code AS pump_code,
             fg.code AS grade_code, fg.name AS grade_name, fg.color AS grade_color,
             fc.name AS fleet_customer_name, fv.registration AS vehicle_registration,
             u.first_name || ' ' || u.last_name AS cashier_name
        FROM fuel_sales fs
        LEFT JOIN nozzles n ON n.id = fs.nozzle_id
        LEFT JOIN pumps p ON p.id = n.pump_id
        LEFT JOIN fuel_grades fg ON fg.id = fs.fuel_grade_id
        LEFT JOIN fleet_customers fc ON fc.id = fs.fleet_customer_id
        LEFT JOIN fleet_vehicles fv ON fv.id = fs.fleet_vehicle_id
        LEFT JOIN users u ON u.id = fs.cashier_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY fs.sale_date DESC, fs.id DESC
       LIMIT 500
    `;
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/:id', auth, (req, res) => {
  const row = db.prepare(`
    SELECT fs.*, n.code AS nozzle_code, p.code AS pump_code,
           fg.code AS grade_code, fg.name AS grade_name,
           fc.name AS fleet_customer_name, fv.registration AS vehicle_registration
      FROM fuel_sales fs
      LEFT JOIN nozzles n ON n.id = fs.nozzle_id
      LEFT JOIN pumps p ON p.id = n.pump_id
      LEFT JOIN fuel_grades fg ON fg.id = fs.fuel_grade_id
      LEFT JOIN fleet_customers fc ON fc.id = fs.fleet_customer_id
      LEFT JOIN fleet_vehicles fv ON fv.id = fs.fleet_vehicle_id
     WHERE fs.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

router.post('/', auth, (req, res) => {
  const tx = db.transaction(() => {
    const {
      shift_id = null, nozzle_id, litres, price_per_litre = null,
      payment_method = 'Cash', fleet_customer_id = null, fleet_vehicle_id = null,
      branch_id = null, notes = ''
    } = req.body;

    if (!nozzle_id) throw new Error('nozzle_id is required');
    const l = Number(litres);
    if (!(l > 0)) throw new Error('litres must be > 0');

    const noz = db.prepare(`
      SELECT n.*, t.fuel_grade_id, t.current_volume,
             fg.selling_price AS grade_price
        FROM nozzles n
        LEFT JOIN tanks t ON t.id = n.tank_id
        LEFT JOIN fuel_grades fg ON fg.id = t.fuel_grade_id
       WHERE n.id = ?
    `).get(nozzle_id);
    if (!noz) throw new Error('Nozzle not found');

    const ppl = Number(price_per_litre != null ? price_per_litre : noz.grade_price) || 0;
    const total = Number((l * ppl).toFixed(2));

    if (payment_method === 'Fleet') {
      if (!fleet_customer_id) throw new Error('Fleet payment requires fleet_customer_id');
      const fc = db.prepare('SELECT * FROM fleet_customers WHERE id = ?').get(fleet_customer_id);
      if (!fc) throw new Error('Fleet customer not found');
      const newBal = (fc.current_balance || 0) + total;
      if (fc.credit_limit > 0 && newBal > fc.credit_limit) {
        throw new Error(`Fleet credit limit exceeded (limit ${fc.credit_limit}, would become ${newBal.toFixed(2)})`);
      }
      db.prepare('UPDATE fleet_customers SET current_balance = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(newBal, fleet_customer_id);
    }

    const number = nextSaleNumber();
    const info = db.prepare(`
      INSERT INTO fuel_sales (
        sale_number, shift_id, nozzle_id, fuel_grade_id, litres, price_per_litre, total,
        payment_method, fleet_customer_id, fleet_vehicle_id, cashier_id, branch_id, notes
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      number, shift_id, nozzle_id, noz.fuel_grade_id, l, ppl, total,
      payment_method, fleet_customer_id, fleet_vehicle_id,
      req.user?.id || null, branch_id, notes
    );

    // bump nozzle meter + decrement tank
    db.prepare('UPDATE nozzles SET current_meter_reading = current_meter_reading + ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(l, nozzle_id);
    db.prepare('UPDATE tanks SET current_volume = current_volume - ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(l, noz.tank_id);

    return db.prepare('SELECT * FROM fuel_sales WHERE id = ?').get(info.lastInsertRowid);
  });
  try { res.status(201).json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/:id', auth, (req, res) => {
  const tx = db.transaction(() => {
    const sale = db.prepare('SELECT * FROM fuel_sales WHERE id = ?').get(req.params.id);
    if (!sale) throw new Error('Not found');
    const noz = db.prepare('SELECT tank_id FROM nozzles WHERE id = ?').get(sale.nozzle_id);
    // reverse: tank + nozzle + fleet balance
    db.prepare('UPDATE nozzles SET current_meter_reading = current_meter_reading - ? WHERE id = ?')
      .run(sale.litres, sale.nozzle_id);
    if (noz) db.prepare('UPDATE tanks SET current_volume = current_volume + ? WHERE id = ?')
      .run(sale.litres, noz.tank_id);
    if (sale.payment_method === 'Fleet' && sale.fleet_customer_id) {
      db.prepare('UPDATE fleet_customers SET current_balance = current_balance - ? WHERE id = ?')
        .run(sale.total, sale.fleet_customer_id);
    }
    db.prepare('DELETE FROM fuel_sales WHERE id = ?').run(req.params.id);
    return { message: 'Deleted and reversed' };
  });
  try { res.json(tx()); } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
