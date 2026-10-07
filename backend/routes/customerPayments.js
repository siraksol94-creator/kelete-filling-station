const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// Derive a single label for the payment_method column from the split amounts.
function deriveMethodLabel(cash, bank, momo) {
  const methods = [
    cash > 0 && 'Cash',
    bank > 0 && 'Bank Transfer',
    momo > 0 && 'Mobile Money',
  ].filter(Boolean);
  if (methods.length === 0) return 'Cash';
  if (methods.length === 1) return methods[0];
  return 'Mixed';
}

// Insert ONE cash_receipts row per AR payment, even when the customer split across
// methods. The split is noted in the description and the payment_method is a derived
// label (Cash / Bank Transfer / Mobile Money / Mixed). Cash Book shows one entry per
// payment â€” matches "one payment = one voucher" mental model.
function mintReceipt({ customerPaymentId, customer, cash, bank, momo, date, notes, createdBy, tenantId, branchId, deviceId }) {
  const total = cash + bank + momo;
  if (!(total > 0)) return null;

  const used = [
    cash > 0 && { label: 'Cash',          amount: cash },
    bank > 0 && { label: 'Bank',          amount: bank },
    momo > 0 && { label: 'MoMo',          amount: momo },
  ].filter(Boolean);
  const isMixed = used.length > 1;
  const methodLabel = isMixed ? 'Mixed' : (cash > 0 ? 'Cash' : bank > 0 ? 'Bank Transfer' : 'Mobile Money');

  // Description shows the breakdown when mixed, e.g. "AR Payment â€” Cash 50.00, Bank 30.00, MoMo 20.00 â€” invoice notes"
  const breakdown = isMixed
    ? used.map(u => `${u.label} ${u.amount.toFixed(2)}`).join(', ')
    : null;
  const descParts = ['AR Payment'];
  if (breakdown) descParts.push(breakdown);
  if (notes)     descParts.push(notes);
  const desc = descParts.join(' â€” ');

  const crSyncId = randomUUID();
  const receiptNum = syncConfig.generateNumber('CR', 'cash_receipts');
  db.prepare(`
    INSERT INTO cash_receipts (receipt_number, received_from, description, payment_method, amount,
                               cash_amount, bank_amount, momo_amount,
                               date, created_by, sync_id, tenant_id, branch_id, device_id, synced,
                               source_type, source_customer_payment_id,
                               created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,datetime('now'),datetime('now'))
  `).run(
    receiptNum, customer.name, desc, methodLabel, total,
    cash, bank, momo,
    date, createdBy, crSyncId, tenantId, branchId, deviceId,
    'ar_payment', customerPaymentId
  );
  return crSyncId;
}

// Soft-delete all CRs linked to a given customer_payment.
function voidLinkedReceipts(customerPaymentId) {
  db.prepare(`
    UPDATE cash_receipts
    SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
    WHERE source_customer_payment_id = ? AND deleted_at IS NULL
  `).run(customerPaymentId);
}

// GET /api/customer-payments?customer_id=...&from=...&to=...
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { customer_id, from, to } = req.query;
    // â”€â”€ Manual AR payments (rows entered in the Payments modal) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    let sql = `
      SELECT cp.id, cp.payment_date, cp.customer_id, c.name AS customer_name,
             cp.payment_method, cp.reference, cp.notes, cp.amount,
             cp.cash_amount, cp.bank_amount, cp.momo_amount,
             u.first_name || ' ' || u.last_name AS created_by_name,
             'manual' AS source
      FROM customer_payments cp
      LEFT JOIN customers c ON c.sync_id = cp.customer_sync_id
      LEFT JOIN users u     ON u.id = cp.created_by
      WHERE cp.deleted_at IS NULL AND cp.tenant_id = ?`;
    const params = [req.user.tenantId];
    // Filter by sync_id derived from requested local id â€” drift-safe.
    if (customer_id) { sql += ' AND cp.customer_sync_id = (SELECT sync_id FROM customers WHERE id = ?)'; params.push(parseInt(customer_id)); }
    if (from)        { sql += ' AND cp.payment_date >= ?'; params.push(from); }
    if (to)          { sql += ' AND cp.payment_date <= ?'; params.push(to); }
    const manualRows = db.prepare(sql + ' ORDER BY cp.payment_date DESC, cp.id DESC').all(...params);

    // â”€â”€ Cash collected at POS during a credit sale â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Synthesize a payment row per order where a registered customer paid something at the till.
    // Amount is capped at the sale total â€” any over-tender came back as change, not revenue.
    // Negative id keeps these distinct from manual rows (which use the AUTOINCREMENT positive ids).
    let posSql = `
      SELECT (-o.id) AS id,
             DATE(o.created_at) AS payment_date,
             o.customer_id, c.name AS customer_name,
             CASE
               WHEN (CASE WHEN COALESCE(o.cash_received,0) > 0 THEN 1 ELSE 0 END
                   + CASE WHEN COALESCE(o.momo_received,0) > 0 THEN 1 ELSE 0 END
                   + CASE WHEN COALESCE(o.bank_received,0) > 0 THEN 1 ELSE 0 END) > 1 THEN 'Mixed'
               WHEN COALESCE(o.cash_received,0) > 0 THEN 'Cash'
               WHEN COALESCE(o.momo_received,0) > 0 THEN 'Mobile Money'
               WHEN COALESCE(o.bank_received,0) > 0 THEN 'Bank Transfer'
               ELSE 'Cash' END AS payment_method,
             o.order_number AS reference,
             'Paid at sale' AS notes,
             CASE WHEN COALESCE(o.amount_received,0) > o.total_amount
                  THEN o.total_amount
                  ELSE COALESCE(o.amount_received,0) END AS amount,
             COALESCE(o.cash_received, 0) AS cash_amount,
             COALESCE(o.bank_received, 0) AS bank_amount,
             COALESCE(o.momo_received, 0) AS momo_amount,
             u.first_name || ' ' || u.last_name AS created_by_name,
             'pos' AS source
      FROM orders o
      JOIN customers c ON c.sync_id = o.customer_sync_id
      LEFT JOIN users u ON u.id = o.created_by
      WHERE o.deleted_at IS NULL
        AND (o.status IS NULL OR o.status != 'Reversed')
        AND o.customer_sync_id IS NOT NULL
        AND COALESCE(o.amount_received, 0) > 0.001
        AND o.tenant_id = ?`;
    const posParams = [req.user.tenantId];
    if (customer_id) { posSql += ' AND o.customer_sync_id = (SELECT sync_id FROM customers WHERE id = ?)'; posParams.push(parseInt(customer_id)); }
    if (from)        { posSql += ' AND DATE(o.created_at) >= ?'; posParams.push(from); }
    if (to)          { posSql += ' AND DATE(o.created_at) <= ?'; posParams.push(to); }
    const posRows = db.prepare(posSql).all(...posParams);

    // Merge + sort newest first.
    const all = [...manualRows, ...posRows].sort((a, b) => {
      if (a.payment_date < b.payment_date) return 1;
      if (a.payment_date > b.payment_date) return -1;
      return (b.id || 0) - (a.id || 0);
    });
    res.json(all);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST â€” record a customer payment (split across Cash / Bank / Mobile Money).
// Mints one CR per non-zero method so the Cash Book reflects each cash event separately.
router.post('/', auth, (req, res) => {
  try {
    const {
      customer_id, payment_date, reference, notes,
      // legacy (still accepted from older clients / non-Kelete tenants)
      cash_amount, bank_amount, momo_amount,
      // v1.8.55 â€” triple-currency AR receipts (Kelete)
      usd_amount, fra_amount, k_amount, selling_rate_used, selling_rate_k_used,
    } = req.body;
    if (!customer_id) return res.status(400).json({ error: 'customer_id required' });

    // Detect which shape the client sent. New triple-currency clients
    // send usd_amount / fra_amount / k_amount; old clients send
    // cash_amount / bank_amount / momo_amount. Either is accepted.
    const isTripleCcy = usd_amount !== undefined || fra_amount !== undefined || k_amount !== undefined;
    const usd = parseFloat(usd_amount  || (isTripleCcy ? 0 : cash_amount) || 0) || 0;
    const fra = parseFloat(fra_amount  || 0) || 0;
    const kAmt= parseFloat(k_amount    || 0) || 0;
    const bank = isTripleCcy ? 0 : (parseFloat(bank_amount || 0) || 0);
    const momo = isTripleCcy ? 0 : (parseFloat(momo_amount || 0) || 0);
    const sellRate  = parseFloat(selling_rate_used   || 0) || 0;
    const sellRateK = parseFloat(selling_rate_k_used || 0) || 0;
    const fraAsUsd  = sellRate  > 0 ? fra  / sellRate  : 0;
    const kAsUsd    = sellRateK > 0 ? kAmt / sellRateK : 0;
    const totalUsd  = usd + fraAsUsd + kAsUsd + bank + momo;
    if (!(totalUsd > 0)) {
      return res.status(400).json({ error: 'At least one of USD / FRA / K (or Cash / Bank / Mobile Money) must be > 0' });
    }
    const customer = db.prepare('SELECT sync_id, name FROM customers WHERE id = ?').get(customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const finalDate = payment_date || new Date().toISOString().slice(0, 10);
    // cash_amount stays as the dollar VALUE of the receipt â€” Cash Book
    // and other legacy aggregations still SUM(cash_amount). For triple-
    // currency, that's usd + fra-as-usd + k-as-usd.
    const cashForLegacy = isTripleCcy ? (usd + fraAsUsd + kAsUsd) : usd;
    const methodLabel = isTripleCcy
      ? (() => {
          const parts = [];
          if (usd  > 0) parts.push('USD');
          if (fra  > 0) parts.push('FRA');
          if (kAmt > 0) parts.push('K');
          return parts.length <= 1 ? (parts[0] || 'Cash') : 'Mixed';
        })()
      : deriveMethodLabel(usd, bank, momo);
    const paySyncId = randomUUID();

    const row = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO customer_payments (customer_id, customer_sync_id, amount,
                                       cash_amount, bank_amount, momo_amount,
                                       usd_amount, fra_amount, k_amount,
                                       selling_rate_used, selling_rate_k_used,
                                       payment_date, payment_method, reference, notes, created_by,
                                       sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(
        customer_id, customer.sync_id, totalUsd,
        cashForLegacy, bank, momo,
        usd, fra, kAmt,
        sellRate || null, sellRateK || null,
        finalDate, methodLabel, reference || null, notes || null, req.user.id,
        paySyncId, tenantId, branchId, deviceId
      );
      const id = info.lastInsertRowid;
      const crSyncId = mintReceipt({
        customerPaymentId: id, customer, cash: cashForLegacy, bank, momo, date: finalDate, notes,
        createdBy: req.user.id, tenantId, branchId, deviceId,
      });
      if (crSyncId) {
        db.prepare('UPDATE customer_payments SET cash_receipt_sync_id = ? WHERE id = ?').run(crSyncId, id);
      }
      return db.prepare('SELECT * FROM customer_payments WHERE id = ?').get(id);
    })();

    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT â€” update a split-method payment. CRs are voided + re-minted from the new amounts.
router.put('/:id', auth, (req, res) => {
  try {
    const {
      payment_date, reference, notes,
      // legacy
      cash_amount, bank_amount, momo_amount,
      // v1.8.55 triple-currency
      usd_amount, fra_amount, k_amount, selling_rate_used, selling_rate_k_used,
    } = req.body;
    const prev = db.prepare('SELECT customer_id, customer_sync_id FROM customer_payments WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, req.user.tenantId);
    if (!prev) return res.status(404).json({ error: 'Payment not found' });
    const customer = db.prepare('SELECT sync_id, name FROM customers WHERE id = ?').get(prev.customer_id);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const isTripleCcy = usd_amount !== undefined || fra_amount !== undefined || k_amount !== undefined;
    const usd  = parseFloat(usd_amount  || (isTripleCcy ? 0 : cash_amount) || 0) || 0;
    const fra  = parseFloat(fra_amount  || 0) || 0;
    const kAmt = parseFloat(k_amount    || 0) || 0;
    const bank = isTripleCcy ? 0 : (parseFloat(bank_amount || 0) || 0);
    const momo = isTripleCcy ? 0 : (parseFloat(momo_amount || 0) || 0);
    const sellRate  = parseFloat(selling_rate_used   || 0) || 0;
    const sellRateK = parseFloat(selling_rate_k_used || 0) || 0;
    const fraAsUsd  = sellRate  > 0 ? fra  / sellRate  : 0;
    const kAsUsd    = sellRateK > 0 ? kAmt / sellRateK : 0;
    const totalUsd  = usd + fraAsUsd + kAsUsd + bank + momo;
    if (!(totalUsd > 0)) return res.status(400).json({ error: 'At least one of USD / FRA / K (or Cash / Bank / Mobile Money) must be > 0' });
    const cashForLegacy = isTripleCcy ? (usd + fraAsUsd + kAsUsd) : usd;
    const methodLabel = isTripleCcy
      ? (() => {
          const parts = [];
          if (usd  > 0) parts.push('USD');
          if (fra  > 0) parts.push('FRA');
          if (kAmt > 0) parts.push('K');
          return parts.length <= 1 ? (parts[0] || 'Cash') : 'Mixed';
        })()
      : deriveMethodLabel(usd, bank, momo);
    const tenantId = req.user.tenantId;
    const { branchId, deviceId } = syncConfig.getConfig();

    db.transaction(() => {
      db.prepare(`
        UPDATE customer_payments SET amount = ?,
          cash_amount = ?, bank_amount = ?, momo_amount = ?,
          usd_amount = ?, fra_amount = ?, k_amount = ?,
          selling_rate_used = ?, selling_rate_k_used = ?,
          payment_date = ?, payment_method = ?, reference = ?, notes = ?,
          updated_at = datetime('now'), synced = 0
        WHERE id = ? AND tenant_id = ?
      `).run(totalUsd,
             cashForLegacy, bank, momo,
             usd, fra, kAmt,
             sellRate || null, sellRateK || null,
             payment_date, methodLabel, reference || null, notes || null,
             req.params.id, tenantId);

      voidLinkedReceipts(parseInt(req.params.id));
      const crSyncId = mintReceipt({
        customerPaymentId: parseInt(req.params.id), customer, cash: cashForLegacy, bank, momo,
        date: payment_date, notes, createdBy: req.user.id, tenantId, branchId, deviceId,
      });
      db.prepare('UPDATE customer_payments SET cash_receipt_sync_id = ? WHERE id = ?').run(crSyncId, req.params.id);
    })();

    const row = db.prepare('SELECT * FROM customer_payments WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE â€” soft-delete the payment AND every CR it minted.
router.delete('/:id', auth, (req, res) => {
  try {
    const prev = db.prepare('SELECT id FROM customer_payments WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, req.user.tenantId);
    if (!prev) return res.status(404).json({ error: 'Payment not found' });

    db.transaction(() => {
      db.prepare("UPDATE customer_payments SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ? AND tenant_id = ?")
        .run(req.params.id, req.user.tenantId);
      voidLinkedReceipts(parseInt(req.params.id));
    })();

    res.json({ message: 'Payment deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
