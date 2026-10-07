const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard, requirePagePerm } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { conversionToBase, baseQtyExpr } = require('../config/unitsHelper');
const vsdc = require('../services/vsdcClient');
const { retryOrder: zraRetryOrder } = require('../services/zraRetryQueue');
const { buildVatLines } = require('../services/vatReport');

// Get distinct users that have orders (for filter dropdown).
// v1.9.1 â€” JOIN by sync_id (with fallback to local id for legacy rows whose
// backfill couldn't run, e.g. user later deleted from this DB).
router.get('/users', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT o.created_by, u.first_name || ' ' || u.last_name AS full_name
       FROM orders o
       LEFT JOIN users u ON u.sync_id = o.created_by_sync_id
                         OR (o.created_by_sync_id IS NULL AND u.id = o.created_by)
       WHERE o.deleted_at IS NULL AND o.tenant_id = ? AND o.created_by IS NOT NULL`
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get all orders
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    // v1.13.50 â€” attach per-order COGS derived from stock_movements.cost_at_sale
    // (stamped by trg_stamp_cost_at_sale on every sale/sale_reverse). NET math
    // (sum of -qty * cost) so partially-reversed orders show the correct
    // remaining cost. Falls back to 0 for rows where cost_at_sale was never
    // stamped (very old rows before the backfill ran).
    // v1.13.151 â€” Also aggregate partial-refund amount + timestamp per
    // order (from order_items.reversed_quantity Ã— line price) so the
    // Sales Report can render partial CNs as their own row in the list.
    // For Reversed orders this equals the full total (every line
    // reversed); for Partial orders it's the refunded slice; for Active
    // orders it's 0.
    const rows = db.prepare(`
      SELECT o.*,
             COALESCE(cogs_agg.cogs, 0) AS cogs,
             COALESCE(pr_agg.partial_refund_amount, 0) AS partial_refund_amount,
             pr_agg.partial_refund_at AS partial_refund_at
      FROM orders o
      LEFT JOIN (
        SELECT sm.reference_sync_id AS order_sync_id,
               SUM(-sm.quantity * COALESCE(sm.cost_at_sale, 0)) AS cogs
        FROM stock_movements sm
        WHERE sm.reference_type = 'order'
          AND sm.movement_type IN ('sale', 'sale_reverse')
          AND sm.deleted_at IS NULL
          AND sm.reference_sync_id IS NOT NULL
        GROUP BY sm.reference_sync_id
      ) cogs_agg ON cogs_agg.order_sync_id = o.sync_id
      LEFT JOIN (
        SELECT oi.order_sync_id,
               SUM(COALESCE(oi.reversed_quantity, 0) * (oi.unit_price - COALESCE(oi.discount, 0))) AS partial_refund_amount,
               MAX(oi.reversed_at) AS partial_refund_at
        FROM order_items oi
        WHERE oi.deleted_at IS NULL
          AND COALESCE(oi.reversed_quantity, 0) > 0
        GROUP BY oi.order_sync_id
      ) pr_agg ON pr_agg.order_sync_id = o.sync_id
      WHERE o.deleted_at IS NULL AND o.tenant_id = ?
      ORDER BY o.created_at DESC
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.13.115 â€” ZRA Ref 9 VAT Transaction Report.
// One row per active (non-reversed) order in [from,to] range, with the 6
// fields ZRA Ref 9 requires: invoice #, date, customer, description of
// goods, value (net of VAT), VAT amount. VAT uses the same MTV-boost
// logic as the receipt (cat B + RRP>0 â†’ max(net_inc, RRP*qty) Ã— 16/116;
// else net_inc Ã— 16/116).
router.get('/vat-report', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to } = req.query;
    // 2026-09-12 â€” the line builder moved to services/vatReport.js unchanged,
    // so HQ's consolidated report reads exactly the same lines.
    res.json(buildVatLines(db, { tenantId: req.user.tenantId, from, to }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.13.124 â€” Mark a Credit Note as first-printed. Frontend calls this
// AFTER the very first successful CN print so subsequent prints add the
// COPY / DUPLICATE band. Idempotent â€” later calls are no-op.
router.put('/:id/mark-cn-printed', auth, (req, res) => {
  try {
    const row = db.prepare(
      `UPDATE orders SET cn_first_printed_at = COALESCE(cn_first_printed_at, datetime('now')),
                          updated_at = datetime('now'), synced = 0
        WHERE id = ? AND deleted_at IS NULL`
    ).run(req.params.id);
    if (!row.changes) return res.status(404).json({ error: 'Order not found' });
    const o = db.prepare('SELECT id, order_number, cn_first_printed_at FROM orders WHERE id = ?').get(req.params.id);
    res.json({ ok: true, cn_first_printed_at: o?.cn_first_printed_at || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v1.8.86 â€” Cashier Payment History: read-only list of orders the Cashier
// has already collected payment on. Newest first, limited to 50 by default
// (override with ?limit=N). Same column shape as cashier-inbox so the same
// list card UI can render it without changes.
router.get('/payment-history', auth, readOnlyGuard, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const rows = db.prepare(
      `SELECT o.id, o.order_number, o.customer_name, o.total_amount, o.subtotal, o.discount,
              o.paid_at, o.sales_at, o.cashier_user_id, o.currency,
              TRIM(COALESCE(uc.first_name, '') || ' ' || COALESCE(uc.last_name, '')) AS cashier_name,
              TRIM(COALESCE(uc.first_name, '') || ' ' || COALESCE(uc.last_name, '')) AS sales_by_name,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_sync_id = o.sync_id AND oi.deleted_at IS NULL) AS item_count
       FROM orders o
       LEFT JOIN users uc ON uc.sync_id = o.cashier_user_sync_id
                          OR (o.cashier_user_sync_id IS NULL AND uc.id = o.cashier_user_id)
       WHERE o.deleted_at IS NULL
         AND o.status IN ('PAID', 'DISPATCHED', 'COMPLETED', 'Partial')
         AND o.tenant_id = ?
       ORDER BY COALESCE(o.paid_at, o.created_at) DESC
       LIMIT ?`
    ).all(req.user.tenantId, limit);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.8.87 â€” Admin-only post-payment edit (typos, wrong currency, wrong rate).
// Mutates only the 12 payment/rate fields + recomputes amount_received from
// (cash + fra/sellRate + k/sellRateK). Stock, items, customer credit limit,
// order_number stay untouched. Writes an audit row to order_payment_edits.
// Rules: Administrator role Â· order has paid_at Â· paid_at within 7 days Â·
// reason >= 3 chars. Response includes cr_exists flag so the frontend can
// nudge the user to re-Save the day's Cash Report (no auto-fix).
router.put('/:id/edit-payment', auth, (req, res) => {
  try {
    if (req.user.role !== 'Administrator') {
      return res.status(403).json({ error: 'Only administrators can edit payments.' });
    }
    const reason = (req.body.reason || '').trim();
    if (reason.length < 3) {
      return res.status(400).json({ error: 'Reason must be at least 3 characters.' });
    }
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?')
      .get(req.params.id, req.user.tenantId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!order.paid_at) return res.status(400).json({ error: 'Order has no payment to edit.' });
    const paidAtMs = new Date(order.paid_at + (order.paid_at.includes('T') ? '' : 'Z')).getTime();
    const daysSince = (Date.now() - paidAtMs) / (1000 * 60 * 60 * 24);
    if (daysSince > 7) {
      return res.status(400).json({ error: `Order paid ${Math.floor(daysSince)} days ago â€” outside the 7-day edit window.` });
    }

    const oldPayload = {
      cash_received:        order.cash_received,
      fra_received:         order.fra_received,
      k_received:           order.k_received,
      usd_change_given:     order.usd_change_given,
      fra_change_given:     order.fra_change_given,
      k_change_given:       order.k_change_given,
      overpaid_kept_ccy:    order.overpaid_kept_ccy,
      overpaid_kept_amt:    order.overpaid_kept_amt,
      selling_rate_used:    order.selling_rate_used,
      buying_rate_used:     order.buying_rate_used,
      selling_rate_k_used:  order.selling_rate_k_used,
      buying_rate_k_used:   order.buying_rate_k_used,
      amount_received:      order.amount_received,
    };

    const num = (v) => parseFloat(v) || 0;
    const newPayload = {
      cash_received:        num(req.body.cash_received),
      fra_received:         num(req.body.fra_received),
      k_received:           num(req.body.k_received),
      usd_change_given:     num(req.body.usd_change_given),
      fra_change_given:     num(req.body.fra_change_given),
      k_change_given:       num(req.body.k_change_given),
      overpaid_kept_ccy:    req.body.overpaid_kept_ccy || null,
      overpaid_kept_amt:    num(req.body.overpaid_kept_amt),
      selling_rate_used:    num(req.body.selling_rate_used),
      buying_rate_used:     num(req.body.buying_rate_used),
      selling_rate_k_used:  num(req.body.selling_rate_k_used),
      buying_rate_k_used:   num(req.body.buying_rate_k_used),
    };

    // amount_received = USD-equivalent of cash + fra/sellFRA + k/sellK
    const newAmountReceived =
      newPayload.cash_received
      + (newPayload.selling_rate_used   > 0 ? newPayload.fra_received / newPayload.selling_rate_used   : 0)
      + (newPayload.selling_rate_k_used > 0 ? newPayload.k_received   / newPayload.selling_rate_k_used : 0);
    newPayload.amount_received = newAmountReceived;

    // v1.10.107 â€” same OVER-CHANGE guard as /collect-payment. Prevents
    // sneaking a bad edit past the frontend gate.
    {
      const bsEdit = db.prepare(
        "SELECT currency_mode, payment_methods FROM business_settings LIMIT 1"
      ).get() || {};
      const isLiquorEdit = String(bsEdit.currency_mode || '').toUpperCase() === 'K'
        && String(bsEdit.payment_methods || '').toLowerCase() === 'cash_momo_bank';
      if (!isLiquorEdit) {
        const totalDueEdit = parseFloat(order.total_amount || 0);
        const changeOwedEdit = Math.max(0, newAmountReceived - totalDueEdit);
        const givenTotalEditUSD =
          newPayload.usd_change_given
          + (newPayload.buying_rate_used   > 0 ? newPayload.fra_change_given / newPayload.buying_rate_used   : 0)
          + (newPayload.buying_rate_k_used > 0 ? newPayload.k_change_given   / newPayload.buying_rate_k_used : 0);
        if (givenTotalEditUSD - changeOwedEdit > 0.10) {
          return res.status(400).json({
            error: `Change returned ($${givenTotalEditUSD.toFixed(2)}) exceeds change owed ($${changeOwedEdit.toFixed(2)}) by $${(givenTotalEditUSD - changeOwedEdit).toFixed(2)}. Reduce the change-given amounts before saving.`
          });
        }
      }
    }

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const editorName = `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim() || req.user.email || 'unknown';

    db.transaction(() => {
      db.prepare(`
        UPDATE orders SET
          cash_received       = ?,
          fra_received        = ?,
          k_received          = ?,
          usd_change_given    = ?,
          fra_change_given    = ?,
          k_change_given      = ?,
          overpaid_kept_ccy   = ?,
          overpaid_kept_amt   = ?,
          selling_rate_used   = ?,
          buying_rate_used    = ?,
          selling_rate_k_used = ?,
          buying_rate_k_used  = ?,
          amount_received     = ?,
          synced              = 0,
          updated_at          = datetime('now')
        WHERE id = ?
      `).run(
        newPayload.cash_received, newPayload.fra_received, newPayload.k_received,
        newPayload.usd_change_given, newPayload.fra_change_given, newPayload.k_change_given,
        newPayload.overpaid_kept_ccy, newPayload.overpaid_kept_amt,
        newPayload.selling_rate_used, newPayload.buying_rate_used,
        newPayload.selling_rate_k_used, newPayload.buying_rate_k_used,
        newAmountReceived,
        req.params.id
      );

      db.prepare(`
        INSERT INTO order_payment_edits
          (order_id, order_sync_id, edited_by, edited_by_name, edited_at, reason,
           old_payload, new_payload, sync_id, tenant_id, branch_id, device_id, synced,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'), ?,
                ?, ?, ?, ?, ?, ?, 0,
                datetime('now'), datetime('now'))
      `).run(
        order.id, order.sync_id, req.user.id, editorName, reason,
        JSON.stringify(oldPayload), JSON.stringify(newPayload),
        randomUUID(), tenantId, branchId, deviceId
      );
    })();

    // CR existence check â€” does a Sales CR row exist for this order's paid date + cashier?
    // If yes, frontend will warn the user to re-Save the Cash Report.
    const paidDate = (order.paid_at || '').slice(0, 10);
    let crExists = false;
    let crCashierName = null;
    if (paidDate && order.cashier_user_id) {
      // v1.9.1 â€” look up by sync_id first (stable across DBs); fall back to
      // the legacy local-integer id only when the new column is empty (e.g.
      // for pre-fix rows that haven't been backfilled yet).
      const cashier = db.prepare(
        `SELECT first_name, TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) AS full_name
           FROM users
          WHERE sync_id = ?
             OR (? IS NULL AND id = ?)
          LIMIT 1`
      ).get(order.cashier_user_sync_id || null, order.cashier_user_sync_id || null, order.cashier_user_id);
      crCashierName = cashier?.full_name || `User ${order.cashier_user_id}`;
      const receivedFrom = cashier?.first_name ? `Sales / ${cashier.first_name}` : 'Sales';
      const crRow = db.prepare(
        `SELECT id FROM cash_receipts
          WHERE deleted_at IS NULL AND tenant_id = ? AND received_from = ? AND date = ?`
      ).get(tenantId, receivedFrom, paidDate);
      crExists = !!crRow;
    }

    const updated = db.prepare(
      `SELECT o.*,
              TRIM(COALESCE(u.first_name,  '') || ' ' || COALESCE(u.last_name,  '')) AS created_by_name,
              TRIM(COALESCE(uc.first_name, '') || ' ' || COALESCE(uc.last_name, '')) AS cashier_name
         FROM orders o
         LEFT JOIN users u  ON u.sync_id  = o.created_by_sync_id
                            OR (o.created_by_sync_id IS NULL AND u.id = o.created_by)
         LEFT JOIN users uc ON uc.sync_id = o.cashier_user_sync_id
                            OR (o.cashier_user_sync_id IS NULL AND uc.id = o.cashier_user_id)
        WHERE o.id = ?`
    ).get(req.params.id);
    res.json({ order: updated, cr_exists: crExists, cr_date: paidDate, cr_cashier_name: crCashierName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dispatch inbox â€” list orders that the Cashier has collected payment on
// and that are now waiting to be physically released by the Dispatch
// station. Same FIFO ordering as the Cashier inbox so the oldest order
// gets handed over first.
router.get('/dispatch-inbox', auth, requirePagePerm('Dispatch'), readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT o.id, o.order_number, o.customer_name, o.total_amount, o.subtotal, o.discount,
              -- 2026-09-26 â€” created_at added: pos_dispatch posts the order
              -- already PAID (line 545) and never stamps paid_at, so the card
              -- had no time to show. Payment and order are the same moment in
              -- that workflow, so the order's own time is the payment time.
              o.paid_at, o.sales_at, o.created_at, o.cashier_user_id, o.currency,
              -- 2026-09-04 â€” the Dispatch card shows the ZRA receipt number and
              -- falls back to "awaiting ZRA" when there is none. These three were
              -- not selected, so it fell back on EVERY order â€” telling the operator
              -- a sale ZRA had already signed was still pending.
              o.zra_status, o.zra_rcpt_no, o.zra_sdc_id,
              TRIM(COALESCE(uc.first_name, '') || ' ' || COALESCE(uc.last_name, '')) AS cashier_name,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_sync_id = o.sync_id AND oi.deleted_at IS NULL) AS item_count
       FROM orders o
       LEFT JOIN users uc ON uc.sync_id = o.cashier_user_sync_id
                          OR (o.cashier_user_sync_id IS NULL AND uc.id = o.cashier_user_id)
       WHERE o.deleted_at IS NULL
         AND o.status = 'PAID'
         AND o.tenant_id = ?
       ORDER BY COALESCE(o.paid_at, o.created_at) ASC`
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dispatch confirms goods released â€” 3-station flow's final step.
// This is the point at which stock physically leaves and we mint the
// stock_movements rows that the rest of the system (Bin Card, profit, etc.)
// reads. Also stamps dispatch_user_id + dispatched_at and triggers profit
// recalc so the day's revenue lines up with the day's COGS.
router.put('/:id/confirm-dispatch', auth, requirePagePerm('Dispatch'), (req, res) => {
  try {
    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?')
        .get(req.params.id, req.user.tenantId);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status !== 'PAID') {
        throw Object.assign(new Error('Order is not awaiting dispatch'), { status: 400 });
      }

      // Pull line items and decrement stock the same way POST /orders does
      // (see the single_pos checkout block above) â€” keeps Bin Card / profit
      // calculations identical regardless of which workflow created the row.
      const items = db.prepare(
        `SELECT oi.product_id, oi.product_sync_id, oi.quantity, oi.unit, oi.product_name
         FROM order_items oi
         WHERE oi.order_sync_id = ? AND oi.deleted_at IS NULL`
      ).all(order.sync_id);

      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();
      const movSql = `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),?)`;
      const movStmt = db.prepare(movSql);
      // v1.10.21 â€” keep products.current_stock in lockstep with stock_movements
      // so the cache never drifts (self-heal used to paper over this on boot).
      const stockDecStmt = db.prepare(
        `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
      );

      for (const it of items) {
        const prod = db.prepare('SELECT sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?').get(it.product_id);
        const productSyncId = it.product_sync_id || prod?.sync_id || null;
        const lineUnit = (it.unit || '').trim() || prod?.unit || null;
        const baseQty = parseFloat(it.quantity) * conversionToBase(prod, lineUnit);
        movStmt.run(
          it.product_id, productSyncId, 'sales', 'sale', -baseQty,
          order.id, 'order', req.user.id,
          randomUUID(), tenantId, branchId, deviceId,
          order.sync_id
        );
        if (productSyncId) stockDecStmt.run(baseQty, productSyncId);
      }

      // v1.9.1 â€” also stamp sync_id so cross-device dispatch attribution stays right.
      const userSyncId = db.prepare('SELECT sync_id FROM users WHERE id = ?').get(req.user.id)?.sync_id || null;
      db.prepare(`
        UPDATE orders
           SET status                 = 'DISPATCHED',
               dispatch_user_id       = ?,
               dispatch_user_sync_id  = ?,
               dispatched_at          = datetime('now'),
               synced                 = 0,
               updated_at             = datetime('now')
         WHERE id = ?
      `).run(req.user.id, userSyncId, req.params.id);

      return db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    })();

    // Sale is now fully realised: revenue (collected at Cashier) + COGS
    // (just minted above). Recalc the daily profit row.
    const orderDate = (result.created_at || '').split(' ')[0] || new Date().toISOString().split('T')[0];
    recalculateDailyProfit(db, orderDate, req.user.tenantId);
    res.json(result);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Cashier inbox â€” list orders awaiting payment in the 3-station flow.
// The Sales station POSTs orders with status='PENDING_PAYMENT'; this endpoint
// is what the Cashier page polls. Sorted by sales_at ASC so the oldest pending
// order is processed first (FIFO â€” fair to the customer who arrived earliest).
router.get('/cashier-inbox', auth, requirePagePerm('Cashier'), readOnlyGuard, (req, res) => {
  try {
    // customers.outstanding is NOT a column â€” it's computed as
    // SUM(orders.unpaid) âˆ’ SUM(customer_payments.amount). Two
    // aggregation subqueries handle that here so the Cashier can show
    // the customer's running balance + available credit before taking
    // the partial payment.
    const rows = db.prepare(
      `SELECT o.id, o.order_number, o.customer_name, o.customer_id, o.customer_sync_id,
              o.total_amount, o.subtotal, o.discount,
              o.sales_at, o.sales_user_id, o.currency,
              c.credit_limit AS customer_credit_limit,
              c.credit_status AS customer_credit_status,
              ( COALESCE(oa.sales_outstanding, 0) - COALESCE(pa.total_paid, 0) ) AS customer_outstanding,
              TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS sales_by_name,
              (SELECT COUNT(*) FROM order_items oi WHERE oi.order_sync_id = o.sync_id AND oi.deleted_at IS NULL) AS item_count
       FROM orders o
       LEFT JOIN users u     ON u.sync_id = o.sales_user_sync_id
                              OR (o.sales_user_sync_id IS NULL AND u.id = o.sales_user_id)
       LEFT JOIN customers c ON c.id = o.customer_id AND c.deleted_at IS NULL
       LEFT JOIN (
         SELECT customer_sync_id,
                SUM(total_amount)
                - SUM(CASE WHEN COALESCE(amount_received, 0) > total_amount
                           THEN total_amount
                           ELSE COALESCE(amount_received, 0) END) AS sales_outstanding
         FROM orders
         WHERE deleted_at IS NULL
           AND (status IS NULL OR status != 'Reversed')
           AND customer_sync_id IS NOT NULL
         GROUP BY customer_sync_id
       ) oa ON oa.customer_sync_id = c.sync_id
       LEFT JOIN (
         SELECT customer_sync_id, SUM(amount) AS total_paid
         FROM customer_payments
         WHERE deleted_at IS NULL AND customer_sync_id IS NOT NULL
         GROUP BY customer_sync_id
       ) pa ON pa.customer_sync_id = c.sync_id
       WHERE o.deleted_at IS NULL
         AND o.status = 'PENDING_PAYMENT'
         AND o.tenant_id = ?
       ORDER BY COALESCE(o.sales_at, o.created_at) ASC`
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create order (POS checkout)
router.post('/', auth, async (req, res) => {
  try {
    // v1.13.101 â€” T11A offline-block pre-flight. If the tenant has
    // enabled `zra_block_offline_sales` AND ZRA is on, ping VSDC before
    // accepting the sale. VSDC unreachable â†’ 503 with a clear message
    // so the cashier knows to wait / restart Tomcat. Default OFF so
    // provisional-receipt behaviour is preserved for non-UAT operation.
    if (vsdc.isEnabled(req.user.tenantId) && vsdc.isBlockOfflineOn(req.user.tenantId)) {
      // 2026-08-28 â€” diagnoseVsdc replaces the old boolean ping. It tells
      // the cashier WHICH problem this is: a genuine outage, or wrong ZRA
      // settings on this desktop. Those need opposite responses (wait vs.
      // fix a field), and the old blanket "VSDC is offline" sent people
      // to restart a Tomcat that was never down.
      const dx = await vsdc.diagnoseVsdc(req.user.tenantId);
      if (!dx.ok) {
        return res.status(503).json({
          error: dx.message,
          code: 'VSDC_UNAVAILABLE',
          reason: dx.code,
        });
      }
    }
    const {
      customer_name, customer_id, customer_sync_id, customer_tpin, customer_address, items, payment_method,
      subtotal, tax_amount, total_amount, discount, amount_received, change_amount,
      cash_received, momo_received, bank_received, sale_date,
      // Phase 4 dual-currency FX bucket (kassumbalesa1). K-only branches send
      // nothing here, so the COALESCEs below preserve historical row shape.
      currency, fra_received, fra_change_given, selling_rate_used, buying_rate_used,
      // Triple-currency K bucket (Kelete). POS Credit Sale modal now sends these.
      k_received, k_change_given, selling_rate_k_used, buying_rate_k_used,
      // v1.8.68 â€” per-currency change tracking. Optional from frontend; if
      // not sent, derived below from change_amount minus fra/k change-given.
      usd_change_given, overpaid_kept_ccy, overpaid_kept_amt,
      // 3-station workflow (kassumbalesa1): when the Sales station confirms an
      // order, status='PENDING_PAYMENT' is sent. We then skip credit checks,
      // skip stock movements (stock decrements at Dispatch), and skip profit
      // recalculation (no revenue realised until Cashier collects payment).
      status,
      // v1.13.62 â€” customer-side empties deposit flow. Optional; when
      // present, drives customers.empty_balance + EMPTY ZB stock inbound.
      empty_flow,
      // v1.13.67 â€” bearer voucher redemption. When present, POS is
      // claiming N empties against an existing EMP- voucher.
      //   voucher_code       : string    voucher_number to look up
      //   voucher_qty_claim  : integer   how many empties to draw
      // Server validates voucher exists, is ACTIVE, has enough
      // qty_remaining; then records the claim + decrements the voucher.
      // Sales Report / Cash Book stay untouched â€” physical stock only.
      voucher_code,
      voucher_qty_claim,
      // T08A #6 LPO invoice. When present, forces every line to zero-rated
      // LPO (Cat C2) in vsdcClient.saveSales + rides on the header
      // lpoNumber field. Buyer TPIN must be set alongside for ZRA to
      // cross-check the LPO certificate on TaxOnline.
      lpo_number,
    } = req.body;
    // v1.13.25 â€” pos_dispatch workflow: same operator writes + pays at POS,
    // then a dispatcher hands over goods. Order posts as PAID (payment
    // collected up front), stock deducts at Dispatch confirm. Read the
    // workflow_mode once so we can gate stock/profit paths on it.
    const workflowMode = String(
      db.prepare("SELECT workflow_mode FROM business_settings LIMIT 1").get()?.workflow_mode || 'single_pos'
    ).toLowerCase();
    const isPosDispatch = workflowMode === 'pos_dispatch';
    const orderStatus = (typeof status === 'string' && status.trim().toUpperCase() === 'PENDING_PAYMENT')
      ? 'PENDING_PAYMENT'
      : (isPosDispatch ? 'PAID' : null);
    const isPendingPayment = orderStatus === 'PENDING_PAYMENT';
    // Skip stock decrement + profit recalc when the order is still pending
    // physical handover â€” same reasoning as three_station's PENDING_PAYMENT
    // path (stock leaves at Dispatch confirm).
    const deferStockAndProfit = isPendingPayment || isPosDispatch;
    // 2026-08-28 â€” fiscalisation is NOT the same question as stock.
    //
    // These used to share one flag, and pos_dispatch fell through the gap:
    // the order is created already PAID, so ZRA was skipped here on the
    // grounds that "the Cashier collection triggers it" â€” but pos_dispatch
    // has no Cashier step. It goes straight to the Dispatch inbox, and
    // confirm-dispatch has no ZRA in it by design. The sale was never sent
    // to ZRA at all, and never marked FAILED either, so the retry queue
    // could not rescue it (it only looks for FAILED).
    //
    // Only PENDING_PAYMENT genuinely defers fiscalisation, because there a
    // real Cashier step follows and owns it. pos_dispatch fiscalises HERE,
    // at the POS, which is also where it belongs: Dispatch stays purely
    // physical and never touches ZRA.
    const deferZra = isPendingPayment;
    const orderCurrency  = (typeof currency === 'string' && currency.trim()) ? currency.trim() : 'K';
    const fraReceived    = parseFloat(fra_received     || 0) || 0;
    const fraChangeGiven = parseFloat(fra_change_given || 0) || 0;
    const sellingRateUsed = selling_rate_used !== undefined && selling_rate_used !== null
      ? parseFloat(selling_rate_used) || null : null;
    const buyingRateUsed  = buying_rate_used  !== undefined && buying_rate_used  !== null
      ? parseFloat(buying_rate_used)  || null : null;
    const kReceived       = parseFloat(k_received       || 0) || 0;
    const kChangeGiven    = parseFloat(k_change_given   || 0) || 0;
    const sellingRateKUsed = selling_rate_k_used !== undefined && selling_rate_k_used !== null
      ? parseFloat(selling_rate_k_used) || null : null;
    const buyingRateKUsed  = buying_rate_k_used  !== undefined && buying_rate_k_used  !== null
      ? parseFloat(buying_rate_k_used)  || null : null;

    // v1.8.68 â€” per-currency change tracking. Three fields are accepted
    // explicitly from the client; when missing we derive them so the bookkeeping
    // is correct even for older POS clients that haven't been updated yet.
    const _changeOwedUSD = parseFloat(change_amount || 0) || 0;
    // v1.8.78 â€” change handed back is a real currency exchange, BUY rate applies
    // (matches the frontend's totalChangeGiven formula in Cashier.js / POS.js).
    const _fraGivenAsUSD = (buyingRateUsed  || 0) > 0 ? fraChangeGiven / buyingRateUsed  : 0;
    const _kGivenAsUSD   = (buyingRateKUsed || 0) > 0 ? kChangeGiven   / buyingRateKUsed : 0;
    // v1.8.74 â€” compute per-currency over-payment using source-currency
    // priority (USD pays first, then FRA, then K). Mirrors the collect-payment
    // endpoint + frontend logic so the default keptCcy lands on the currency
    // that actually holds the surplus. NOTE: must compute physical USD here
    // inline because `cashIn` (with its multi-currency fallback) isn't declared
    // until a few lines below (TDZ on the original v1.8.74 attempt).
    const _cashInForOver = (() => {
      const _fraI = parseFloat(fra_received || 0) || 0;
      const _kI   = parseFloat(k_received   || 0) || 0;
      const _isMulti = _fraI > 0 || _kI > 0;
      const _legacy = (payment_method === 'Mobile Money' || payment_method === 'Transfer'
                       || payment_method === 'Bank' || payment_method === 'Bank Transfer') ? 0 : (amount_received || 0);
      return _isMulti
        ? (parseFloat(cash_received || 0) || 0)
        : (parseFloat(cash_received ?? _legacy) || 0);
    })();
    const _totalDuePost = parseFloat(total_amount || 0) || 0;
    let _remPost = _totalDuePost;
    const _usdUsedPost = Math.min(_cashInForOver, _remPost);
    const overUSDcomputedPost = _cashInForOver - _usdUsedPost;
    _remPost -= _usdUsedPost;
    let overFRAcomputedPost = 0;
    if (_remPost > 0 && fraReceived > 0 && (sellingRateUsed || 0) > 0) {
      const fraNeededP = _remPost * sellingRateUsed;
      if (fraReceived >= fraNeededP) { overFRAcomputedPost = fraReceived - fraNeededP; _remPost = 0; }
      else                           { _remPost -= fraReceived / sellingRateUsed; }
    } else if (fraReceived > 0) {
      overFRAcomputedPost = fraReceived;
    }
    let overKcomputedPost = 0;
    if (_remPost > 0 && kReceived > 0 && (sellingRateKUsed || 0) > 0) {
      const kNeededP = _remPost * sellingRateKUsed;
      if (kReceived >= kNeededP) { overKcomputedPost = kReceived - kNeededP; _remPost = 0; }
      else                       { _remPost -= kReceived / sellingRateKUsed; }
    } else if (kReceived > 0) {
      overKcomputedPost = kReceived;
    }

    let overpaidKeptCcy = (overpaid_kept_ccy || '').toUpperCase();
    if (!['USD', 'FRA', 'K'].includes(overpaidKeptCcy)) overpaidKeptCcy = null;
    let overpaidKeptAmt = parseFloat(overpaid_kept_amt || 0) || 0;
    // When the client tells us a kept-currency but no amount, derive from the
    // shortfall: change_amount MINUS what was physically given in any currency.
    // This is the common path for POS.js which only sends keptCcy.
    let usdChangeGiven;
    if (usd_change_given !== undefined && usd_change_given !== null) {
      usdChangeGiven = parseFloat(usd_change_given) || 0;
    } else if (overpaidKeptCcy) {
      // Cashier kept the over-payment â†’ no USD was returned for that portion.
      usdChangeGiven = 0;
    } else {
      usdChangeGiven = Math.max(0, _changeOwedUSD - _fraGivenAsUSD - _kGivenAsUSD);
    }
    // v1.8.74 â€” when keptCcy missing, default to source-currency of the
    // over-payment (FRA â†’ K â†’ USD priority) instead of legacy USD default.
    if (!overpaidKeptCcy && _changeOwedUSD > 0.005) {
      if      (overFRAcomputedPost > 0.5)   overpaidKeptCcy = 'FRA';
      else if (overKcomputedPost   > 0.5)   overpaidKeptCcy = 'K';
      else if (overUSDcomputedPost > 0.001) overpaidKeptCcy = 'USD';
    }
    if (overpaidKeptCcy && overpaidKeptAmt < 0.005) {
      // v1.8.79 â€” fall back to USD-leftover Ã— BUY rate (matches frontend
      // display) instead of sell rate, so kept = change owed âˆ’ change given.
      const keptUSD = Math.max(0, _changeOwedUSD - _fraGivenAsUSD - _kGivenAsUSD - usdChangeGiven);
      if (overpaidKeptCcy === 'USD') {
        overpaidKeptAmt = overUSDcomputedPost > 0.001 ? overUSDcomputedPost : keptUSD;
      } else if (overpaidKeptCcy === 'FRA') {
        overpaidKeptAmt = overFRAcomputedPost > 0.5
          ? overFRAcomputedPost
          : ((buyingRateUsed  || 0) > 0 ? keptUSD * buyingRateUsed  : 0);
      } else if (overpaidKeptCcy === 'K') {
        overpaidKeptAmt = overKcomputedPost > 0.5
          ? overKcomputedPost
          : ((buyingRateKUsed || 0) > 0 ? keptUSD * buyingRateKUsed : 0);
      }
    }
    if (overpaidKeptAmt < 0.005) { overpaidKeptCcy = null; overpaidKeptAmt = 0; }
    // Administrator-only back-dating: when the POS Pay modal sends an explicit
    // sale_date (YYYY-MM-DD), an Administrator can override the server clock.
    // For any other role we silently ignore it.
    const isAdmin = req.user && (req.user.role === 'Administrator' || req.user.role === 'Admin');
    const looksLikeDate = typeof sale_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sale_date);
    const overrideDate = (isAdmin && looksLikeDate) ? sale_date : null;
    // Stamp the override at the same wall-clock time the server would have used,
    // so existing reports and sorts behave naturally.
    const overrideTs = overrideDate ? `${overrideDate} ${new Date().toTimeString().slice(0, 8)}` : null;
    const tsExpr = overrideTs ? '?' : "datetime('now')";
    const tsArgs = overrideTs ? [overrideTs] : [];
    // v1.8.53 â€” for multi-currency sales (Kelete), `cash_received` MUST be
    // the physical USD only â€” never the dollar-VALUE of all cash. Falling
    // back to `amount_received` double-counts foreign-currency payments
    // (they appear in both the K/FRA bucket AND the USD bucket).
    //
    // Rule:
    //   - If any FRA/K was paid â†’ cash_received = whatever the client sent,
    //     defaulting to 0 (NOT amount_received).
    //   - Otherwise â†’ keep legacy fallback so single-currency tenants
    //     (lusaka1, mansa1 K-only or USD-only) still work.
    const fraInForFallback = parseFloat(fra_received || 0) || 0;
    const kInForFallback   = parseFloat(k_received   || 0) || 0;
    const isMultiCurrency  = fraInForFallback > 0 || kInForFallback > 0;
    const legacyFallback   = (payment_method === 'Mobile Money' || payment_method === 'Transfer' || payment_method === 'Bank' || payment_method === 'Bank Transfer') ? 0 : (amount_received || 0);
    const cashIn = isMultiCurrency
      ? (parseFloat(cash_received || 0) || 0)
      : (parseFloat(cash_received ?? legacyFallback) || 0);
    const momoIn = parseFloat(momo_received ?? (payment_method === 'Mobile Money' ? amount_received || 0 : 0)) || 0;
    const bankIn = parseFloat(bank_received ?? (payment_method === 'Transfer' || payment_method === 'Bank' || payment_method === 'Bank Transfer' ? amount_received || 0 : 0)) || 0;
    const totalReceived = cashIn + momoIn + bankIn;
    const finalAmountReceived = amount_received !== undefined ? parseFloat(amount_received) || 0 : totalReceived;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    // v1.13.149 â€” new orders now save as INV- in the DB (was ORD-).
    // Sequence carries forward: syncConfig.generateNumber reads
    // sync_config.seq_orders which was already at N from the last ORD-
    // generation, so first INV- picks up at N+1 (no restart at 1).
    // Historical ORD- rows will be migrated separately in Fix 2 Part B.
    const orderNum = syncConfig.generateNumber('INV', 'orders');

    // â”€â”€ Server-side credit-limit guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Mirrors the POS UI rule: if the buyer matches a known customer,
    // enforce credit_status and credit_limit. Walk-in sales must be paid in full.
    // PENDING_PAYMENT (3-station Sales hand-off) skips this â€” no payment is
    // being collected here, the Cashier station enforces it at the next stage.
    const unpaid = Math.max(0, parseFloat(total_amount || 0) - parseFloat(amount_received || 0));
    if (!isPendingPayment && unpaid > 0.001) {
      if (!customer_name || !customer_name.trim()) {
        return res.status(400).json({ error: 'Walk-in sales must be paid in full' });
      }
      // Prefer explicit customer_id; fall back to unique-name lookup.
      let cust = null;
      if (customer_id) {
        cust = db.prepare('SELECT id, sync_id, credit_limit, credit_status FROM customers WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?').get(customer_id, tenantId);
      }
      if (!cust) {
        const matches = db.prepare(
          'SELECT id, sync_id, credit_limit, credit_status FROM customers WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL AND tenant_id = ?'
        ).all(customer_name.trim(), tenantId);
        if (matches.length === 1) cust = matches[0];
        else if (matches.length > 1) {
          return res.status(400).json({ error: 'Multiple customers match this name â€” please select the customer explicitly' });
        }
      }
      if (!cust) {
        return res.status(400).json({ error: 'Unknown customer â€” partial payment requires a registered customer' });
      }
      if (cust.credit_status === 'OnHold') {
        return res.status(400).json({ error: 'Customer is on hold â€” payment in full required' });
      }
      const limit = parseFloat(cust.credit_limit || 0);
      if (limit > 0) {
        // Existing AR = credit portion of past sales âˆ’ payments collected later.
        // Then add the unpaid portion of THIS sale on top.
        const sold = db.prepare(`
          SELECT COALESCE(SUM(total_amount - COALESCE(amount_received, 0)), 0) AS s
          FROM orders
          WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
            AND customer_sync_id = ? AND tenant_id = ?
        `).get(cust.sync_id, tenantId).s;
        const paid = db.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS p
          FROM customer_payments
          WHERE deleted_at IS NULL AND customer_sync_id = ?
        `).get(cust.sync_id).p;
        const projected = (parseFloat(sold) - parseFloat(paid)) + unpaid;
        if (projected > limit + 0.001) {
          return res.status(400).json({
            error: `Sale exceeds credit limit (K${limit.toFixed(2)}). Projected outstanding: K${projected.toFixed(2)}`,
          });
        }
      }
    }

    // v1.9.1 â€” resolve sync_id for the authenticated user once per order, so
    // we can stamp it on created_by_sync_id (and sales_user_sync_id when
    // pending-payment). Storing the sync_id alongside the legacy integer id
    // means receipts JOIN to the correct user on any device, regardless of
    // local-id collisions when the order syncs cross-device.
    const userSyncId = db.prepare('SELECT sync_id FROM users WHERE id = ?').get(req.user.id)?.sync_id || null;

    const order = db.transaction(() => {
      const orderSyncId = randomUUID();
      // For PENDING_PAYMENT, also stamp sales_user_id + sales_at so the
      // Cashier inbox can show who created it and when.
      // v1.13.77 â€” snapshot the customer's TPIN onto the order. Front-end
      // may send it explicitly (Pay-modal override); otherwise fall back to
      // whatever's on the customer record so a saved B2B customer's TPIN
      // rides along without the cashier retyping it. Walk-in / missing â†’
      // null, and the receipt substitutes ZRA's '1000000000' default.
      let resolvedTpin = (typeof customer_tpin === 'string' && customer_tpin.trim())
        ? customer_tpin.trim() : null;
      // v1.13.102 â€” explicit customer_address from the POS Payment modal
      // takes precedence over the saved customer record. Enables B2B
      // walk-ins to enter TPIN + name + address ad-hoc without creating
      // a customer profile first. Fallback to customer record when the
      // walk-in modal leaves the field blank.
      let resolvedAddress = (typeof customer_address === 'string' && customer_address.trim())
        ? customer_address.trim() : null;
      if (customer_sync_id) {
        const c = db.prepare('SELECT tpin, address FROM customers WHERE sync_id = ? AND deleted_at IS NULL').get(customer_sync_id);
        if (c) {
          if (!resolvedTpin && c.tpin) resolvedTpin = String(c.tpin).trim() || null;
          if (!resolvedAddress && c.address) resolvedAddress = String(c.address).trim() || null;
        }
      }
      const ordSql = `INSERT INTO orders (order_number, customer_name, customer_id, customer_sync_id, customer_tpin, customer_address, subtotal, tax_amount, total_amount, discount,
          amount_received, cash_received, momo_received, bank_received,
          change_amount, usd_change_given, overpaid_kept_ccy, overpaid_kept_amt,
          payment_method, created_by, created_by_sync_id,
          currency, fra_received, fra_change_given, selling_rate_used, buying_rate_used,
          k_received, k_change_given, selling_rate_k_used, buying_rate_k_used,
          status, sales_user_id, sales_user_sync_id, sales_at,
          sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,${tsExpr},?,?,?,?,0,${tsExpr},${tsExpr})`;
      const ordArgs = [orderNum, customer_name, customer_id || null, customer_sync_id || null,
            resolvedTpin, resolvedAddress,
            subtotal, tax_amount, total_amount, discount || 0,
            finalAmountReceived, cashIn, momoIn, bankIn,
            change_amount || 0, usdChangeGiven, overpaidKeptCcy, overpaidKeptAmt,
            payment_method || 'Cash', req.user.id, userSyncId,
            orderCurrency, fraReceived, fraChangeGiven, sellingRateUsed, buyingRateUsed,
            kReceived, kChangeGiven, sellingRateKUsed, buyingRateKUsed,
            orderStatus,
            isPendingPayment ? req.user.id : null,
            isPendingPayment ? userSyncId   : null];
      if (overrideTs) ordArgs.push(overrideTs);                       // sales_at when override
      ordArgs.push(orderSyncId, tenantId, branchId, deviceId);
      if (overrideTs) ordArgs.push(overrideTs, overrideTs);
      const info = db.prepare(ordSql).run(...ordArgs);

      const orderId = info.lastInsertRowid;

      // v1.13.157 â€” persist a walk-in-typed TPIN/name/address so the
      // NEXT sale to this same buyer can auto-fill from OUR own record
      // (not just ZRA's, which is often thin on address data). Only
      // fires when a TPIN was actually captured; best-effort â€” never
      // blocks the sale. Existing customer records are only filled in
      // where blank (never overwrites an address someone already
      // entered deliberately via Suppliers & Customers).
      if (resolvedTpin) {
        try {
          const existingCust = db.prepare(
            'SELECT id, address FROM customers WHERE tpin = ? AND deleted_at IS NULL LIMIT 1'
          ).get(resolvedTpin);
          if (existingCust) {
            if (resolvedAddress && !existingCust.address) {
              db.prepare(
                "UPDATE customers SET address=?, updated_at=datetime('now'), synced=0 WHERE id=?"
              ).run(resolvedAddress, existingCust.id);
            }
          } else if (customer_name || resolvedAddress) {
            db.prepare(`
              INSERT INTO customers (name, tpin, address, status, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
              VALUES (?, ?, ?, 'Active', ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
            `).run(customer_name || `TPIN ${resolvedTpin}`, resolvedTpin, resolvedAddress || null, randomUUID(), tenantId, branchId, deviceId);
          }
        } catch (_) { /* best-effort â€” never block the sale over this */ }
      }

      // T08A #6 LPO â€” stamp lpo_number on the freshly inserted row so
      // vsdcClient.saveSales below reads it and flips the whole invoice
      // to Cat C2. Kept as a follow-up UPDATE (rather than baked into
      // ordSql) to keep the INSERT column list untouched.
      if (lpo_number && String(lpo_number).trim()) {
        db.prepare('UPDATE orders SET lpo_number = ? WHERE id = ?')
          .run(String(lpo_number).trim(), orderId);
      }

      // v1.13.128j â€” Snapshot ZRA fiscal fields onto the order line at
       // sale time (see migrations.js for column rationale). These make
       // the invoice immutable: reprints and reports read fields the
       // sale committed, not today's product master or today's formula.
       const itemSql = `INSERT INTO order_items (order_id, order_sync_id, product_id, product_sync_id, product_name, quantity, unit, unit_price, discount, total_price, zra_rrp_snap, zra_vat_cat_snap, zra_vat_rate, zra_vat_taxbl_amt, zra_vat_amt, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,${tsExpr},${tsExpr})`;
      const movSql = `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,${tsExpr},${tsExpr},?)`;
      const itemStmt = db.prepare(itemSql);
      const movStmt  = db.prepare(movSql);
      // v1.10.21 â€” decrement products.current_stock alongside the movement.
      const stockDecStmt = db.prepare(
        `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
      );

      // v1.13.128j â€” ZRA VAT rate lookup per VSDC API Spec Â§6.1. Anything
      // not listed defaults to 16 (safest for FMCG). Used inside the loop
      // to compute the fiscal snapshot for each line.
      const ZRA_VAT_RATES = { A: 16, B: 16, C1: 0, C2: 0, C3: 0, D: 0, E: 0, F: 10, RVAT: 16 };

      for (const item of items) {
        const prod = db.prepare('SELECT sync_id, unit, alt_unit, conversion_factor, units_json, zra_vat_cat_cd, zra_rrp FROM products WHERE id = ?').get(item.product_id);
        // Prefer client-sent product_sync_id to avoid mis-attributing a sale to
        // the wrong product when local ids drift across PCs.
        const productSyncId = item.product_sync_id || prod?.sync_id || null;
        const lineUnit = (item.unit || '').trim() || prod?.unit || null;
        const baseQty = parseFloat(item.quantity) * conversionToBase(prod, lineUnit);
        const lineDiscount = parseFloat(item.discount || 0);

        // Fiscal snapshot (see migrations.js zra_vat_taxbl_amt block).
        // Formula follows ZRA VSDC API Spec Â§5.9 MTV example (Chicken
        // Wings, page 118): taxable base = max(sale Ã— qty, RRP Ã— qty)
        // for Cat B when RRP > 0, else sale Ã— qty. Net = base/(1+rate/100),
        // VAT = base âˆ’ Net. Zero-rated categories keep Net = base.
        // zra_rrp_snap stores the per-unit RRP that was live at sale
        // time (matches how the receipt column displays it). VAT math
        // multiplies by qty internally where needed.
        //
        // 2026-08-26 â€” LPO sales snapshot as Cat C2 / 0%.
        //
        // The LPO zero-rating used to be applied ONLY in
        // vsdcClient.saveSales at transmission time, so the snapshot kept
        // each product's ordinary category. ZRA received the invoice
        // correctly zero-rated while the printed receipt and the VAT
        // report â€” both of which read the snapshot â€” still showed 16%.
        // Order INV-2026-C1DCF1-0062 (Embassy of Finland, LPO
        // 5721529679) went to ZRA as taxblAmtC2 2130 / totTaxAmt 0, yet
        // printed VAT of K303.63: a zero-rated customer handed an invoice
        // charging VAT the tax authority has no record of.
        //
        // MTV/RRP boosting is skipped too: an LPO line is zero-rated, so
        // there is no VAT to uplift to a minimum taxable value. This
        // mirrors vsdcClient's own `isLpo` branch exactly, so the two
        // paths cannot drift again.
        const isLpoSale  = !!(lpo_number && String(lpo_number).trim());
        const rrpPerUnit = Number(prod?.zra_rrp) || 0;
        const catSnap    = isLpoSale ? 'C2' : String(prod?.zra_vat_cat_cd || 'A').toUpperCase();
        const rateSnap   = isLpoSale ? 0 : (ZRA_VAT_RATES[catSnap] ?? 16);
        const netInc     = parseFloat(item.quantity) * (parseFloat(item.unit_price) - lineDiscount);
        const boost      = (!isLpoSale && catSnap === 'B' && rrpPerUnit > 0)
          ? Math.max(netInc, rrpPerUnit * parseFloat(item.quantity))
          : netInc;
        const taxblSnap  = rateSnap > 0 ? boost / (1 + rateSnap / 100) : boost;
        const vatSnap    = boost - taxblSnap;

        const itemArgs = [orderId, orderSyncId, item.product_id, productSyncId, item.product_name, item.quantity, lineUnit, item.unit_price, lineDiscount, item.total_price,
              rrpPerUnit, catSnap, rateSnap, +taxblSnap.toFixed(4), +vatSnap.toFixed(4),
              randomUUID(), tenantId, branchId, deviceId];
        if (overrideTs) itemArgs.push(overrideTs, overrideTs);
        itemStmt.run(...itemArgs);

        // PENDING_PAYMENT and pos_dispatch both skip the stock decrement â€”
        // stock only leaves at Dispatch (see memory
        // [[project-kelete-stock-deduction-timing]]). The matching decrement
        // movement is created when Dispatch confirms.
        if (!deferStockAndProfit) {
          const movArgs = [item.product_id, productSyncId, 'sales', 'sale', -baseQty, orderId, 'order', req.user.id,
                randomUUID(), tenantId, branchId, deviceId];
          if (overrideTs) movArgs.push(overrideTs, overrideTs);
          movArgs.push(orderSyncId);
          movStmt.run(...movArgs);
          if (productSyncId) stockDecStmt.run(baseQty, productSyncId);
        }
      }

      // v1.13.62 â€” Empties deposit flow. Applies AFTER items are recorded
      // so the stock_movements + order_items path stays untouched. Skips
      // cleanly when empty_flow isn't sent (feature dormant).
      //
      //   â€¢ Customer balance Â± via empty_credit_delta (server never lets
      //     it go negative â€” clamps at 0 and logs the actual applied
      //     value in customer_empty_returns.qty).
      //   â€¢ +empties_returned stock_movement against the EMPTY ZB product
      //     configured on business_settings.empty_container_product_sync_id.
      //     Walk-ins with empties_returned>0 still hit stock; the credit
      //     just can't be recorded (no customer to credit).
      if (empty_flow && !isPendingPayment) {
        const emptiesIn  = Math.max(0, parseInt(empty_flow.empties_returned || 0, 10) || 0);
        const rawDelta   = parseInt(empty_flow.empty_credit_delta || 0, 10) || 0;

        // Credit ledger â€” only if we have a customer to attach to.
        if (customer_id && rawDelta !== 0) {
          const cust = db.prepare(
            'SELECT id, sync_id, name, empty_balance FROM customers WHERE id = ? AND deleted_at IS NULL'
          ).get(customer_id);
          if (cust) {
            const oldBal = parseInt(cust.empty_balance || 0, 10) || 0;
            // Clamp so the balance never goes negative; the truly applied
            // delta lands in the audit row, matching what the balance
            // actually moved by. Prevents a mis-computed client payload
            // from silently wiping into the negatives.
            const proposed = oldBal + rawDelta;
            const clampedBal = Math.max(0, proposed);
            const appliedDelta = clampedBal - oldBal;
            db.prepare(
              `UPDATE customers SET empty_balance = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?`
            ).run(clampedBal, customer_id);
            db.prepare(`
              INSERT INTO customer_empty_returns
                (sync_id, customer_id, customer_sync_id, customer_name,
                 kind, qty, order_id, order_sync_id, order_number,
                 balance_after, created_by, created_by_name,
                 tenant_id, branch_id, device_id, synced)
              VALUES (?, ?, ?, ?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            `).run(
              randomUUID(), cust.id, cust.sync_id, cust.name,
              appliedDelta, orderId, orderSyncId, orderNum,
              clampedBal, req.user.id,
              `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email || 'staff',
              tenantId, branchId, deviceId,
            );
          }
        }

        // Physical stock in for returned empties. Ties the movement to the
        // order for traceability. Independent of the customer credit â€”
        // returned empties always count as inbound stock.
        if (emptiesIn > 0 && !deferStockAndProfit) {
          const emptyProdSyncId = db.prepare(
            "SELECT empty_container_product_sync_id FROM business_settings LIMIT 1"
          ).get()?.empty_container_product_sync_id;
          if (emptyProdSyncId) {
            const emptyProd = db.prepare(
              'SELECT id, sync_id FROM products WHERE sync_id = ? AND deleted_at IS NULL'
            ).get(emptyProdSyncId);
            if (emptyProd) {
              const movArgs = [emptyProd.id, emptyProd.sync_id, 'sales', 'customer_empty_return',
                               emptiesIn, orderId, 'order', req.user.id,
                               randomUUID(), tenantId, branchId, deviceId];
              if (overrideTs) movArgs.push(overrideTs, overrideTs);
              movArgs.push(orderSyncId);
              movStmt.run(...movArgs);
              stockDecStmt.run(-emptiesIn, emptyProd.sync_id); // -N against negation = +N
            }
          }
        }
      }

      // v1.13.67 â€” Voucher claim. Redeems N empties against an existing
      // EMP- voucher. Server-authoritative: validates voucher exists,
      // ACTIVE, has enough qty_remaining. Rejects the whole order (via
      // throw inside the transaction) on any mismatch so the client
      // sees a clear error and no half-baked claim lands. No stock
      // movement here â€” the stock was posted when the voucher was
      // ISSUED. This step just moves credit down.
      if (voucher_code && !isPendingPayment) {
        const code = String(voucher_code || '').trim();
        const claimQty = Math.max(0, parseInt(voucher_qty_claim, 10) || 0);
        if (code && claimQty > 0) {
          const voucher = db.prepare(
            "SELECT * FROM empty_vouchers WHERE voucher_number = ? AND deleted_at IS NULL"
          ).get(code);
          if (!voucher) {
            throw Object.assign(new Error(`Voucher ${code} not found.`), { status: 400 });
          }
          if (voucher.status !== 'ACTIVE') {
            throw Object.assign(new Error(`Voucher ${code} is ${voucher.status.toLowerCase()} â€” cannot claim.`), { status: 400 });
          }
          if (voucher.qty_remaining < claimQty) {
            throw Object.assign(new Error(`Voucher ${code} only has ${voucher.qty_remaining} empties left (attempted ${claimQty}).`), { status: 400 });
          }
          const newRemaining = voucher.qty_remaining - claimQty;
          const nextStatus = newRemaining <= 0 ? 'CLAIMED' : 'ACTIVE';
          db.prepare(`
            UPDATE empty_vouchers
               SET qty_remaining = ?, status = ?, updated_at = datetime('now'), synced = 0
             WHERE id = ?
          `).run(newRemaining, nextStatus, voucher.id);
          db.prepare(`
            INSERT INTO empty_voucher_claims
              (sync_id, voucher_id, voucher_sync_id, voucher_number,
               order_id, order_sync_id, order_number, qty_claimed,
               claimed_by, claimed_by_name,
               tenant_id, branch_id, device_id, synced)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
          `).run(
            randomUUID(), voucher.id, voucher.sync_id, voucher.voucher_number,
            orderId, orderSyncId, orderNum, claimQty,
            req.user.id,
            `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email || 'staff',
            tenantId, branchId, deviceId,
          );
        }
      }

      return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    })();

    // Revenue is realised only when goods are physically dispatched.
    // Both PENDING_PAYMENT (Cashier not collected) and pos_dispatch (goods
    // not released) defer the profit recalc.
    if (!deferStockAndProfit) {
      const orderDate = overrideDate || new Date().toISOString().split('T')[0];
      recalculateDailyProfit(db, orderDate, req.user.tenantId);
    }

    // ZRA saveSales â€” fires here for every flow EXCEPT PENDING_PAYMENT,
    // where the Cashier collection step owns it. Notably that includes
    // pos_dispatch: the order is paid at the POS, so it is fiscalised at
    // the POS. Dispatch never calls ZRA.
    let zra = { skipped: true, reason: 'not-paid' };
    let deferredStockChain = null;   // fired after res.json â€” see below
    if (!deferZra) {
      const zraItems = db.prepare(
        `SELECT oi.*, p.name AS product_name, p.code AS product_code,
                p.zra_item_cd, p.zra_item_cls_cd, p.zra_pkg_unit_cd,
                p.zra_qty_unit_cd, p.zra_vat_cat_cd, p.zra_excise_ty_cd, p.zra_rrp
           FROM order_items oi
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ? AND (oi.deleted_at IS NULL)`
      ).all(order.id);
      zra = await vsdc.saveSales(req.user.tenantId, order, zraItems, {
        actor:   String(req.user?.id || 'system'),
        actorNm: req.user?.name || req.user?.email || String(req.user?.id || 'system'),
      });
      // Stock chain â€” mandatory per ZRA checklist item 27-29. Runs only
      // when saveSales succeeded, so a failed sale doesn't emit stock
      // updates and mislead ZRA's view.
      //
      // 2026-08-27 â€” DEFERRED past the response. Only saveSales produces
      // the signature and QR the receipt needs; saveStockItems and
      // saveStockMaster add ~1.6s the cashier was standing there for with
      // nothing on the paper depending on them. Time-to-print drops from
      // ~3-5s to ~1-2s, which also absorbs the extra hop when Electron
      // tills fiscalise through the VPS.
      //
      // The snapshot is captured NOW, synchronously, so it reflects
      // post-sale stock rather than whatever it drifts to while the
      // deferred call is in flight.
      //
      // zra_stock_chain_done is what makes this safe: if the process dies
      // before the chain finishes, the flag stays 0 and the retry queue
      // picks the order up. Without it, deferring would trade speed for a
      // silent hole in stock reporting.
      if (zra.ok && zra.itemList) {
      // 2026-08-28 â€” residual must be what is left AFTER this sale.
      // In flows where the goods have not physically left yet
      // (pos_dispatch / three_station: stock leaves at Dispatch confirm),
      // products.current_stock still counts what was just sold. We are
      // telling ZRA the sale happened, so reporting the pre-sale shelf
      // count sends a residual one sale too high on every such line.
      // Subtracting the sold quantity here keeps the figure right WITHOUT
      // Dispatch having to call ZRA â€” it stays purely physical.
        const snapshots = zraItems.map(it => {
          const prod = db.prepare(
            'SELECT current_stock, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?'
          ).get(it.product_id);
          let rsdQty = parseFloat(prod?.current_stock || 0) || 0;
          if (deferStockAndProfit) {
            const lineUnit = (it.unit || '').trim() || prod?.unit || null;
            rsdQty -= (parseFloat(it.quantity) || 0) * conversionToBase(prod, lineUnit);
          }
          return { itemCd: it.zra_item_cd || it.product_code || String(it.product_id), rsdQty };
        });
        deferredStockChain = { order, itemList: zra.itemList, snapshots, tenantId: req.user.tenantId };
      }
    }
    // Re-read the order so the response includes any ZRA fiscal fields
    // saveSales just wrote (rcpt_no, qr_code_url, sdc_id, etc.).
    const finalOrder = zra.skipped ? order : db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    // v1.13.109 â€” return items joined with the current products.zra_rrp /
    // zra_vat_cat_cd so the fresh POS receipt renders correct RRP + Rate
    // columns even when the browser's cached /api/products response is
    // stale (e.g. RRP script ran after products were first loaded).
    // Mirrors the join in GET /orders/:id (v1.13.106).
    // v1.13.110 â€” renamed from `items` because req.body already destructures
    // `items` in this handler (line 437) and the shadowing threw
    // SyntaxError 'Identifier items has already been declared' on boot.
    const responseItems = db.prepare(
      `SELECT oi.*, p.alt_unit, p.conversion_factor, p.unit AS product_base_unit,
              p.default_unit, p.units_json,
              p.zra_qty_unit_cd, p.zra_vat_cat_cd, p.zra_excise_ty_cd, p.zra_rrp
       FROM order_items oi
       LEFT JOIN products p ON p.sync_id = oi.product_sync_id
       WHERE oi.order_sync_id = ? AND oi.deleted_at IS NULL`
    ).all(finalOrder.sync_id);
    res.status(201).json({ ...finalOrder, zra, items: responseItems });

    // â”€â”€ After the receipt is on its way â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Everything below runs with the response already sent, so it cannot
    // slow the till down. Failures are recorded, never thrown: the sale
    // is committed and fiscalised, and zra_stock_chain_done left at 0
    // hands the order to the retry queue.
    if (deferredStockChain) {
      const d = deferredStockChain;
      try {
        await vsdc.saveSaleStockChain(d.tenantId, d.order, d.itemList, d.snapshots, { isCredit: false });
        db.prepare('UPDATE orders SET zra_stock_chain_done = 1 WHERE id = ?').run(d.order.id);
      } catch (e) {
        console.error('[orders] deferred stock chain failed for order', d.order.id, e.message);
      }
    }
  } catch (error) {
    // Guard: the deferred block above runs after res.json, so a throw
    // there must not attempt a second response.
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else console.error('[orders] post-response error:', error.message);
  }
});

// GET /api/orders/product-breakdown?productName=...&from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns individual sale transactions for a specific product within a date range
router.get('/product-breakdown', auth, readOnlyGuard, (req, res) => {
  try {
    const { productName, from, to, userId } = req.query;
    if (!productName) return res.status(400).json({ error: 'productName is required' });
    let sql = `
      SELECT o.order_number, o.created_at, oi.quantity, oi.unit_price, oi.total_price
      FROM order_items oi
      INNER JOIN orders o ON o.sync_id = oi.order_sync_id
      WHERE o.deleted_at IS NULL
        AND (o.status IS NULL OR o.status != 'Reversed')
        AND oi.deleted_at IS NULL
        AND (oi.reversed IS NULL OR oi.reversed = 0)
        AND o.tenant_id = ?
        AND oi.product_name = ?
    `;
    const params = [req.user.tenantId, productName];
    // from / to are ISO datetimes (UTC) sent by the frontend so the comparison
    // works regardless of the user's timezone. Comparing strings is safe here
    // because SQLite stores datetimes as ISO 8601.
    if (from) { sql += ' AND o.created_at >= ?'; params.push(from); }
    if (to)   { sql += ' AND o.created_at <= ?'; params.push(to); }
    if (userId && userId !== 'all') { sql += ' AND o.created_by = ?'; params.push(userId); }
    sql += ' ORDER BY o.created_at ASC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/orders/product-summary?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns total qty sold and revenue per product for active (non-reversed) orders
router.get('/product-summary', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to, userId } = req.query;
    // total_qty is reported in BASE units (sum of oi.quantity Ã— conversion_factor when line is in alt unit).
    // Frontend uses unit + alt_unit + conversion_factor to format dual-unit display.
    let sql = `
      SELECT
        oi.product_name,
        p.category_id,
        c.name AS category_name,
        c.main_category_id,
        p.unit,
        p.alt_unit,
        p.conversion_factor,
        p.units_json,
        p.default_unit,
        SUM(${baseQtyExpr('p', 'oi')}) AS total_qty,
        SUM(oi.total_price) / NULLIF(SUM(${baseQtyExpr('p', 'oi')}), 0) AS avg_price,
        SUM(oi.total_price) AS total_revenue
      FROM order_items oi
      INNER JOIN orders o ON o.sync_id = oi.order_sync_id
      LEFT JOIN products p ON p.sync_id = oi.product_sync_id
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE o.deleted_at IS NULL
        AND (o.status IS NULL OR o.status != 'Reversed')
        AND oi.deleted_at IS NULL
        AND (oi.reversed IS NULL OR oi.reversed = 0)
        AND o.tenant_id = ?
    `;
    const params = [req.user.tenantId];
    // from / to are ISO datetimes (UTC) sent by the frontend so the comparison
    // works regardless of the user's timezone. Comparing strings is safe here
    // because SQLite stores datetimes as ISO 8601.
    if (from) { sql += ' AND o.created_at >= ?'; params.push(from); }
    if (to)   { sql += ' AND o.created_at <= ?'; params.push(to); }
    if (userId && userId !== 'all') { sql += ' AND o.created_by = ?'; params.push(userId); }
    sql += ' GROUP BY oi.product_name, p.category_id, c.name, c.main_category_id, p.unit, p.alt_unit, p.conversion_factor, p.units_json, p.default_unit ORDER BY total_revenue DESC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.13.62 â€” customer-side empties deposit endpoints.
//
// GET  /api/orders/customer-empties/:customerId          â€” balance + recent ledger rows
// GET  /api/orders/customer-empties                       â€” every customer that carries a non-zero balance (report)
// POST /api/orders/customer-empties/pure-return           â€” Case 4: customer walks in with empties, no beer sale
//
// v1.13.64 â€” MUST be declared BEFORE the /:id wildcard below, otherwise
// Express matches "customer-empties" as an order id.
router.get('/customer-empties/:customerId', auth, readOnlyGuard, (req, res) => {
  try {
    const cust = db.prepare(
      'SELECT id, sync_id, name, empty_balance FROM customers WHERE id = ? AND deleted_at IS NULL'
    ).get(req.params.customerId);
    if (!cust) return res.status(404).json({ error: 'Customer not found' });
    const ledger = db.prepare(`
      SELECT id, sync_id, kind, qty, order_number, balance_after, notes,
             created_by_name, created_at
        FROM customer_empty_returns
       WHERE customer_id = ? AND deleted_at IS NULL
       ORDER BY id DESC
       LIMIT 50
    `).all(req.params.customerId);
    res.json({
      customer: { id: cust.id, sync_id: cust.sync_id, name: cust.name },
      empty_balance: parseInt(cust.empty_balance || 0, 10) || 0,
      ledger,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/customer-empties', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT id, sync_id, name, phone, empty_balance
        FROM customers
       WHERE deleted_at IS NULL
         AND COALESCE(empty_balance, 0) > 0
       ORDER BY empty_balance DESC, name ASC
       LIMIT 500
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/customer-empties/pure-return', auth, (req, res) => {
  try {
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const { customer_id, qty, notes } = req.body || {};
    const returnQty = Math.max(0, parseInt(qty, 10) || 0);
    if (!customer_id) return res.status(400).json({ error: 'customer_id is required.' });
    if (!(returnQty > 0)) return res.status(400).json({ error: 'qty must be > 0.' });

    const cust = db.prepare(
      'SELECT id, sync_id, name, empty_balance FROM customers WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?'
    ).get(customer_id, tenantId);
    if (!cust) return res.status(404).json({ error: 'Customer not found.' });

    const oldBal = parseInt(cust.empty_balance || 0, 10) || 0;
    const newBal = oldBal + returnQty;

    // EMPTY ZB product resolver â€” matches order.POST behaviour.
    const emptyProdSyncId = db.prepare(
      "SELECT empty_container_product_sync_id FROM business_settings LIMIT 1"
    ).get()?.empty_container_product_sync_id;
    const emptyProd = emptyProdSyncId
      ? db.prepare('SELECT id, sync_id FROM products WHERE sync_id = ? AND deleted_at IS NULL').get(emptyProdSyncId)
      : null;

    const ledgerSyncId = randomUUID();
    const actorName = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email || 'staff';

    db.transaction(() => {
      db.prepare(
        "UPDATE customers SET empty_balance = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?"
      ).run(newBal, cust.id);
      db.prepare(`
        INSERT INTO customer_empty_returns
          (sync_id, customer_id, customer_sync_id, customer_name,
           kind, qty, order_id, order_sync_id, order_number,
           balance_after, notes, created_by, created_by_name,
           tenant_id, branch_id, device_id, synced)
        VALUES (?, ?, ?, ?, 'pure_return', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        ledgerSyncId, cust.id, cust.sync_id, cust.name,
        returnQty, newBal, notes || null,
        req.user.id, actorName,
        tenantId, branchId, deviceId,
      );
      if (emptyProd) {
        db.prepare(`
          INSERT INTO stock_movements
            (product_id, product_sync_id, location, movement_type, quantity,
             reference_id, reference_type, created_by, sync_id,
             tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
          VALUES (?, ?, 'sales', 'customer_empty_pure_return', ?, NULL, 'customer_empty_return',
                  ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'), ?)
        `).run(
          emptyProd.id, emptyProd.sync_id, returnQty,
          req.user.id, randomUUID(),
          tenantId, branchId, deviceId, ledgerSyncId,
        );
        db.prepare(
          `UPDATE products SET current_stock = current_stock + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
        ).run(returnQty, emptyProd.sync_id);
      }
    })();

    res.status(201).json({
      ok: true,
      customer_id: cust.id,
      customer_name: cust.name,
      qty: returnQty,
      old_balance: oldBal,
      new_balance: newBal,
      slip_sync_id: ledgerSyncId,
      stock_updated: !!emptyProd,
    });
  } catch (e) {
    console.error('[orders.customer-empties.pure-return]', e);
    res.status(500).json({ error: e.message });
  }
});

// Get order details
// â”€â”€ Possible duplicate sales â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// v1.13.155
//
// Chawama rang INV-0067 and INV-0068 six seconds apart with an identical
// basket. The cause is a checkout that SAVED but whose response was lost: the
// till shows "Checkout failed", the cart is deliberately kept so a genuine
// failure does not lose the customer's basket, and the cashier presses Pay
// again.
//
// Blocking the second sale automatically was considered and rejected. The
// cashier re-enters the money received after pressing Pay, so the retry is a
// genuinely different entry â€” an automatic block risks refusing a real sale at
// a live till. This flags instead, and a person decides.
//
// WHAT COUNTS AS A PAIR: same items and quantities, same total, same cashier,
// within 60 seconds. Amount received is deliberately NOT compared â€” it is
// re-typed on the retry, so it can differ between the two.
//
// WHY 60 SECONDS, measured on Chawama's real day:
//     1 min -> 2 pairs      5 min -> 4 pairs
//     2 min -> 3 pairs     10 min -> 7 pairs
// The extra five at ten minutes are ordinary trade. A warning that cries wolf
// stops being read.
//
// The gap in seconds rides on every pair because it is what a human judges by:
// six seconds is a duplicate, twenty-nine is two customers at opening time.
const DUP_WINDOW_SECONDS = 60;

// Signature of a sale: every line as product x quantity, in a stable order so
// the same basket always produces the same string.
const DUP_SIG_SQL = `
  (SELECT group_concat(oi.product_sync_id || 'x' || oi.quantity, '|')
     FROM order_items oi
    WHERE oi.order_sync_id = o.sync_id AND oi.deleted_at IS NULL
    ORDER BY oi.product_sync_id)`;

// GET /api/orders/possible-duplicates?from=&to=
router.get('/possible-duplicates', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to } = req.query;
    const params = [];
    let range = '';
    if (from) { range += ' AND o.created_at >= ?'; params.push(from); }
    if (to)   { range += ' AND o.created_at <= ?'; params.push(to); }

    const rows = db.prepare(`
      WITH sig AS (
        SELECT o.id, o.sync_id, o.order_number, o.created_at, o.total_amount,
               o.created_by, o.customer_name, ${DUP_SIG_SQL} AS items
          FROM orders o
         WHERE o.deleted_at IS NULL
           AND COALESCE(o.status, '') != 'Reversed'
           AND o.tenant_id = ?${range}
      )
      SELECT a.sync_id      AS a_sync_id,  b.sync_id      AS b_sync_id,
             a.order_number AS a_number,   b.order_number AS b_number,
             a.created_at   AS a_at,       b.created_at   AS b_at,
             a.total_amount AS total,
             a.customer_name AS customer,
             CAST(strftime('%s', b.created_at) - strftime('%s', a.created_at) AS INTEGER) AS secs_apart
        FROM sig a
        JOIN sig b
          ON b.id > a.id
         AND b.total_amount = a.total_amount
         AND b.items = a.items
         AND b.created_by = a.created_by
         -- items IS NOT NULL: an order with no lines would otherwise match
         -- every other order with no lines, since NULL = NULL never holds but
         -- an empty signature does.
         AND a.items IS NOT NULL
         AND ABS(strftime('%s', b.created_at) - strftime('%s', a.created_at)) <= ${DUP_WINDOW_SECONDS}
       ORDER BY a.created_at DESC
    `).all(req.user.tenantId, ...params);

    // Drop the pairs somebody has already looked at and judged fine.
    let dismissed = new Set();
    try {
      dismissed = new Set(db.prepare(
        'SELECT pair_key FROM order_duplicate_dismissals WHERE deleted_at IS NULL'
      ).all().map(r => r.pair_key));
    } catch (_) { /* table not present on an older database */ }

    const pairKey = (x, y) => [x, y].sort().join('~');
    const pairs = rows
      .filter(r => !dismissed.has(pairKey(r.a_sync_id, r.b_sync_id)))
      .map(r => ({ ...r, pair_key: pairKey(r.a_sync_id, r.b_sync_id) }));

    // A first line of each basket, so the banner can say WHAT was sold twice
    // rather than only how much it cost.
    const itemsOf = db.prepare(
      `SELECT product_name, quantity, unit FROM order_items
        WHERE order_sync_id = ? AND deleted_at IS NULL ORDER BY id`);
    for (const p of pairs) {
      try {
        const items = itemsOf.all(p.a_sync_id);
        p.item_count = items.length;
        p.first_item = items.length
          ? `${items[0].product_name}${items.length > 1 ? ` +${items.length - 1} more` : ''}`
          : '';
      } catch (_) { p.item_count = 0; p.first_item = ''; }
    }

    res.json({ window_seconds: DUP_WINDOW_SECONDS, pairs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/orders/possible-duplicates/dismiss
// Body: { order_a_sync_id, order_b_sync_id, order_a_number, order_b_number, note }
//
// RECORDS A JUDGEMENT, NOTHING MORE. Both sales stay exactly as they are â€”
// still in the report, still in the totals, still fiscalised, still in the
// Cash Book. No reversal, no delete, no money moves. All this does is stop the
// pair being raised again. Reversing a sale is the Reverse button on the row,
// unchanged and deliberately separate.
router.post('/possible-duplicates/dismiss', auth, readOnlyGuard, (req, res) => {
  try {
    const a = String(req.body?.order_a_sync_id || '').trim();
    const b = String(req.body?.order_b_sync_id || '').trim();
    if (!a || !b || a === b) return res.status(400).json({ error: 'Two different orders are required.' });

    const key = [a, b].sort().join('~');
    const { branchId, deviceId } = syncConfig.getConfig();
    const name = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim()
                 || req.user.email || 'staff';

    db.prepare(`
      INSERT INTO order_duplicate_dismissals
        (pair_key, order_a_sync_id, order_b_sync_id, order_a_number, order_b_number,
         dismissed_by, dismissed_by_name, note, sync_id, tenant_id, branch_id, device_id, synced)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)
      ON CONFLICT(pair_key) DO UPDATE SET
        deleted_at = NULL,
        dismissed_by = excluded.dismissed_by,
        dismissed_by_name = excluded.dismissed_by_name,
        updated_at = datetime('now'),
        synced = 0
    `).run(
      key, a, b,
      req.body?.order_a_number || null, req.body?.order_b_number || null,
      req.user.id, name, req.body?.note || null,
      randomUUID(), req.user.tenantId, branchId || null, deviceId || null,
    );

    res.json({ ok: true, pair_key: key });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    const order = db.prepare(
      `SELECT o.*,
              TRIM(COALESCE(u.first_name,  '') || ' ' || COALESCE(u.last_name,  '')) AS created_by_name,
              TRIM(COALESCE(uc.first_name, '') || ' ' || COALESCE(uc.last_name, '')) AS cashier_name
       FROM orders o
       LEFT JOIN users u  ON u.sync_id  = o.created_by_sync_id
                          OR (o.created_by_sync_id IS NULL AND u.id = o.created_by)
       LEFT JOIN users uc ON uc.sync_id = o.cashier_user_sync_id
                          OR (o.cashier_user_sync_id IS NULL AND uc.id = o.cashier_user_id)
       WHERE o.id = ? AND o.deleted_at IS NULL AND o.tenant_id = ?`
    ).get(req.params.id, req.user.tenantId);
    const items = db.prepare(
      `SELECT oi.*, p.alt_unit, p.conversion_factor, p.unit AS product_base_unit,
              p.default_unit, p.units_json,
              p.zra_qty_unit_cd, p.zra_vat_cat_cd, p.zra_excise_ty_cd, p.zra_rrp
       FROM order_items oi
       LEFT JOIN products p ON p.sync_id = oi.product_sync_id
       WHERE oi.order_sync_id = ? AND oi.deleted_at IS NULL`
    ).all(order?.sync_id);
    // 2026-09-01 â€” the empty voucher this sale drew on, so a reprint carries
    // the same EMPTIES block as the original. Dispatch reads that block to
    // decide whether to release the goods, and a duplicate that silently omits
    // it is worse than no duplicate at all.
    // Guarded on its own: the table is absent on older branch databases, and a
    // missing voucher must not take the whole order response down with it.
    let empty_voucher = null;
    try {
      empty_voucher = db.prepare(
        `SELECT voucher_number, qty AS qty_claimed
           FROM empty_voucher_claims
          WHERE order_sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')
          ORDER BY id LIMIT 1`
      ).get(order?.sync_id) || null;
    } catch (_) { /* table not present on this database */ }

    res.json({ ...order, items, empty_voucher });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cashier collects payment on a PENDING_PAYMENT order.
// 3-station flow: marks PAID; stock deducts later at Dispatch.
// 2-station flow (v1.6.3): marks DISPATCHED + deducts stock here. No
// separate dispatch step â€” used by branches that don't have a dedicated
// dispatch role. See workflow_mode='two_station' on business_settings.
router.put('/:id/collect-payment', auth, requirePagePerm('Cashier'), async (req, res) => {
  try {
    const {
      paid_usd, paid_fra, given_usd, given_fra,
      buy_rate, sell_rate,
      // v1.7.0 â€” third currency (K). Optional; cashier sends 0 / null when
      // not using K. Math: same Sirak pattern as FRA, just adds a 3rd term.
      paid_k, given_k, sell_rate_k, buy_rate_k,
      // v1.8.68 â€” over-payment kept by cashier (no change handed back).
      // Cashier picks which drawer holds the surplus so Cash Report doesn't
      // bleed it into the wrong currency.
      overpaid_kept_ccy,
      // v1.8.72 â€” frontend now sends the NATIVE source-currency amount
      // (e.g. FRA 250 instead of $0.108 â†’ 246 FRA round-trip). When
      // present > 0, backend uses it verbatim instead of recomputing.
      overpaid_kept_amt,
    } = req.body;
    const paidUSD = parseFloat(paid_usd || 0) || 0;
    const paidFRA = parseFloat(paid_fra || 0) || 0;
    const paidK   = parseFloat(paid_k   || 0) || 0;
    const givenUSD = parseFloat(given_usd || 0) || 0;
    const givenFRA = parseFloat(given_fra || 0) || 0;
    const givenK   = parseFloat(given_k   || 0) || 0;
    const sellRate  = parseFloat(sell_rate    || 0) || 0;
    const buyRate   = parseFloat(buy_rate     || 0) || 0;
    const sellRateK = parseFloat(sell_rate_k  || 0) || 0;
    const buyRateK  = parseFloat(buy_rate_k   || 0) || 0;

    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?')
        .get(req.params.id, req.user.tenantId);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status !== 'PENDING_PAYMENT') {
        throw Object.assign(new Error('Order is not awaiting payment'), { status: 400 });
      }

      // Math (v1.7.0, extended):
      //   paidFRAasUSD     = paidFRA / sellRate
      //   paidKasUSD       = paidK   / sellRateK
      //   totalAmountPaid  = paidUSD + paidFRAasUSD + paidKasUSD
      const paidFRAasUSD = sellRate  > 0 ? paidFRA / sellRate  : 0;
      const paidKasUSD   = sellRateK > 0 ? paidK   / sellRateK : 0;
      const totalAmountPaid = paidUSD + paidFRAasUSD + paidKasUSD;
      const totalDue = parseFloat(order.total_amount || 0);
      const change   = Math.max(0, totalAmountPaid - totalDue);
      const unpaid   = Math.max(0, totalDue - totalAmountPaid);

      // v1.8.68 â€” figure out the over-payment kept in the drawer (USD-equivalent
      // returned-as-change MINUS what cashier physically returned). What's left
      // is "kept" â€” by default in the currency the over-payment came from.
      // v1.8.78 â€” change handed back to customer in foreign currency is a real
      // exchange (we're "buying" USD back with FRA/K). Use BUY rate, matching the
      // frontend's totalChangeGiven formula. Previous SELL-rate use caused
      // frontend ($0.09 short) and backend ($1.07 short) to disagree, leading to
      // wildly inflated overpaid_kept_amt (2,475 FRA instead of ~200 FRA).
      const givenUSDasUSD = givenUSD;
      const givenFRAasUSD = buyRate   > 0 ? givenFRA / buyRate   : 0;
      const givenKasUSD   = buyRateK  > 0 ? givenK   / buyRateK  : 0;
      const totalGivenAsUSD = givenUSDasUSD + givenFRAasUSD + givenKasUSD;
      // v1.10.81 â€” On Liquor tenants (currency_mode='K' AND
      // payment_methods='cash_momo_bank'), the POS Pay modal has no
      // Change Given inputs â€” cashier physically hands change to the
      // customer, no drawer surplus concept. Skip the classifier so we
      // don't fabricate "kept in drawer" rows on Liquor. Kassumbalesa
      // (currency_mode='USD+FRA+K') still runs the full classifier.
      const bsRow = db.prepare(
        "SELECT currency_mode, payment_methods FROM business_settings LIMIT 1"
      ).get() || {};
      const isLiquorStyleServer = String(bsRow.currency_mode || '').toUpperCase() === 'K'
        && String(bsRow.payment_methods || '').toLowerCase() === 'cash_momo_bank';
      // v1.10.107 â€” hard OVER-CHANGE guard on Kassumbalesa / Kelete
      // (non-Liquor). Rejects any collect-payment where the total change
      // returned (USD-equivalent, summed across USD + FRA + K given)
      // exceeds the change actually owed by more than $0.10 tolerance.
      // The frontend has isOverChange gating on the Confirm button, but
      // 4 orders today on Kassumbalesa (ORD-0102/0106/0107/0112) show
      // the pattern usd_change_given = change_amount AND fra_change_given
      // = change Ã— buy_rate â€” i.e. the till returning ~2Ã— the amount
      // owed. Root cause is still under investigation (see conversation
      // notes 2026-07-05); until pinpointed, this backstop stops the
      // shop-loss regardless of how the frontend produced the payload.
      //
      // Liquor branches skip this guard â€” they legitimately use
      // "kept in drawer" flows where the math tolerates greater slack.
      if (!isLiquorStyleServer && (totalGivenAsUSD - change) > 0.10) {
        throw Object.assign(
          new Error(
            `Change returned ($${totalGivenAsUSD.toFixed(2)}) exceeds change owed ($${change.toFixed(2)}) by $${(totalGivenAsUSD - change).toFixed(2)}. Reduce the change-given amounts before saving.`
          ),
          { status: 400 }
        );
      }
      const overpaidKeptUSD = isLiquorStyleServer
        ? 0
        : Math.max(0, change - totalGivenAsUSD);
      // v1.8.74 â€” attribute the over-payment to its SOURCE currency using
      // the same priority chain as the frontend (USD pays first, then FRA,
      // then K). Whatever's left over in each currency is the native
      // over-payment in that currency. Backend default keptCcy then matches
      // the currency that actually holds the surplus â€” not the legacy
      // "FRA-only/K-only/else USD" heuristic which incorrectly picked USD
      // any time the customer also paid some USD.
      let _remBe = totalDue;
      const _usdUsedBe = Math.min(paidUSD, _remBe);
      const overUSDcomputed = paidUSD - _usdUsedBe;
      _remBe -= _usdUsedBe;
      let overFRAcomputed = 0;
      if (_remBe > 0 && paidFRA > 0 && sellRate > 0) {
        const fraNeeded = _remBe * sellRate;
        if (paidFRA >= fraNeeded) { overFRAcomputed = paidFRA - fraNeeded; _remBe = 0; }
        else                      { _remBe -= paidFRA / sellRate; }
      } else if (paidFRA > 0) {
        overFRAcomputed = paidFRA;
      }
      let overKcomputed = 0;
      if (_remBe > 0 && paidK > 0 && sellRateK > 0) {
        const kNeeded = _remBe * sellRateK;
        if (paidK >= kNeeded) { overKcomputed = paidK - kNeeded; _remBe = 0; }
        else                  { _remBe -= paidK / sellRateK; }
      } else if (paidK > 0) {
        overKcomputed = paidK;
      }
      // Pick currency: explicit param wins; else default to the currency
      // that actually holds the over-payment (FRA â†’ K â†’ USD priority).
      let keptCcy = (overpaid_kept_ccy || '').toUpperCase();
      if (overpaidKeptUSD < 0.005) {
        keptCcy = null;
      } else if (!['USD', 'FRA', 'K'].includes(keptCcy)) {
        if      (overFRAcomputed > 0.5)   keptCcy = 'FRA';
        else if (overKcomputed   > 0.5)   keptCcy = 'K';
        else if (overUSDcomputed > 0.001) keptCcy = 'USD';
        else                              keptCcy = 'USD';
      }
      // v1.8.72 â€” prefer the NATIVE amount sent by the frontend (it computed
      // it directly from `paidFRA âˆ’ fraNeeded`, no FX round-trip). Fall back
      // to source-currency native value computed above.
      // v1.8.79 â€” when no native amount, convert USD-leftover at BUY rate
      // (consistent with the frontend display rate so 200 kept stays 200,
      // not 203 from sell rate).
      const explicitKeptAmt = parseFloat(overpaid_kept_amt || 0) || 0;
      let keptAmt = 0;
      if (keptCcy && explicitKeptAmt > 0.005) {
        keptAmt = explicitKeptAmt;
      } else if (keptCcy === 'FRA') {
        keptAmt = overFRAcomputed > 0.5
          ? overFRAcomputed
          : (buyRate  > 0 ? overpaidKeptUSD * buyRate  : 0);
      } else if (keptCcy === 'K') {
        keptAmt = overKcomputed > 0.5
          ? overKcomputed
          : (buyRateK > 0 ? overpaidKeptUSD * buyRateK : 0);
      } else if (keptCcy === 'USD') {
        keptAmt = overUSDcomputed > 0.001 ? overUSDcomputed : overpaidKeptUSD;
      }

      // v1.8.49 â€” credit-at-Cashier. When the order has a registered
      // customer attached (set on the Sales/Reception screen), the Cashier
      // is allowed to take partial payment; the unpaid portion becomes a
      // credit balance on the customer. Walk-ins still must pay in full
      // (with the same 10Â¢ FRA/K rounding tolerance).
      const hasRegisteredCustomer = !!order.customer_id;
      if (hasRegisteredCustomer && unpaid > 0.10) {
        // Optional credit-limit guard â€” mirrors POS rule. customers
        // has no `outstanding` column â€” compute it from orders minus
        // customer_payments (same formula as the AR/customers list).
        const cust = db.prepare(
          'SELECT id, sync_id, credit_limit, credit_status FROM customers WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?'
        ).get(order.customer_id, req.user.tenantId);
        if (cust) {
          if (cust.credit_status === 'OnHold') {
            throw Object.assign(new Error('Customer is on hold â€” payment in full required'), { status: 400 });
          }
          const limit = parseFloat(cust.credit_limit || 0);
          if (limit > 0 && cust.sync_id) {
            const owedRow = db.prepare(
              `SELECT SUM(total_amount)
                    - SUM(CASE WHEN COALESCE(amount_received, 0) > total_amount
                               THEN total_amount
                               ELSE COALESCE(amount_received, 0) END) AS sales_owed
                 FROM orders
                WHERE deleted_at IS NULL
                  AND (status IS NULL OR status != 'Reversed')
                  AND customer_sync_id = ?`
            ).get(cust.sync_id);
            const paidRow = db.prepare(
              `SELECT COALESCE(SUM(amount), 0) AS total_paid
                 FROM customer_payments
                WHERE deleted_at IS NULL AND customer_sync_id = ?`
            ).get(cust.sync_id);
            const currentOutstanding = Math.max(0, parseFloat(owedRow?.sales_owed || 0) - parseFloat(paidRow?.total_paid || 0));
            const projected = currentOutstanding + unpaid;
            if (projected > limit + 0.001) {
              throw Object.assign(new Error(`Would exceed credit limit by ${(projected - limit).toFixed(2)}`), { status: 400 });
            }
          }
        }
      } else if (unpaid > 0.10) {
        throw Object.assign(new Error(`Payment is short by ${unpaid.toFixed(2)} ${order.currency || 'USD'}`), { status: 400 });
      }
      const isCreditCollection = hasRegisteredCustomer && unpaid > 0.10;
      const isFullCredit       = hasRegisteredCustomer && totalAmountPaid < 0.001;
      const paymentMethod      = isFullCredit ? 'Credit' : isCreditCollection ? 'Partial-Credit' : 'Cash';

      // v1.6.3 â€” detect workflow mode. two_station = stock deducts here.
      const wm = (db.prepare("SELECT workflow_mode FROM business_settings LIMIT 1").get()?.workflow_mode || 'three_station').toLowerCase();
      const isTwoStation = wm === 'two_station';

      // v1.9.1 â€” stamp the cashier's sync_id (and dispatch sync_id for the
      // two-station shortcut) so cross-device receipts show the right name.
      const userSyncId = db.prepare('SELECT sync_id FROM users WHERE id = ?').get(req.user.id)?.sync_id || null;

      db.prepare(`
        UPDATE orders
           SET status                = ?,
               cashier_user_id       = ?,
               cashier_user_sync_id  = ?,
               paid_at               = datetime('now'),
               amount_received       = ?,
               cash_received         = ?,
               momo_received         = 0,
               bank_received         = 0,
               change_amount         = ?,
               usd_change_given      = ?,
               overpaid_kept_ccy     = ?,
               overpaid_kept_amt     = ?,
               fra_received          = ?,
               fra_change_given      = ?,
               selling_rate_used     = ?,
               buying_rate_used      = ?,
               k_received            = ?,
               k_change_given        = ?,
               selling_rate_k_used   = ?,
               buying_rate_k_used    = ?,
               payment_method        = ?,
               ${isTwoStation ? "dispatch_user_id = ?, dispatch_user_sync_id = ?, dispatched_at = datetime('now')," : ''}
               synced                = 0,
               updated_at            = datetime('now')
         WHERE id = ?
      `).run(...[
        isTwoStation ? 'DISPATCHED' : 'PAID',
        req.user.id,
        userSyncId,
        totalAmountPaid,
        paidUSD,
        change,
        givenUSD,
        keptCcy,
        keptAmt,
        paidFRA, givenFRA, sellRate || null, buyRate || null,
        paidK,   givenK,   sellRateK || null, buyRateK || null,
        paymentMethod,
        ...(isTwoStation ? [req.user.id, userSyncId] : []),
        req.params.id,
      ]);

      // 2-station: also deduct stock from sales location, same as the
      // confirm-dispatch handler does in 3-station.
      if (isTwoStation) {
        const items = db.prepare(
          `SELECT product_id, product_sync_id, quantity, unit
           FROM order_items WHERE order_sync_id = ? AND deleted_at IS NULL`
        ).all(order.sync_id);
        const tenantId = syncConfig.getTenantId(req);
        const { branchId, deviceId } = syncConfig.getConfig();
        const movStmt = db.prepare(
          `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),?)`
        );
        // v1.10.21 â€” decrement products.current_stock alongside the movement.
        const stockDecStmt = db.prepare(
          `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
        );
        for (const it of items) {
          // v1.8.39 â€” look up by sync_id first (cross-device safe); fall
          // back to local integer id only if sync_id is missing. Same
          // localProductId logic as the reverse endpoint â€” prevents
          // FOREIGN KEY constraint failed on synced orders.
          const prodBySync = it.product_sync_id
            ? db.prepare('SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?').get(it.product_sync_id)
            : null;
          const prod = prodBySync || db.prepare('SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?').get(it.product_id);
          const productSyncId = it.product_sync_id || prod?.sync_id || null;
          const localProductId = prod?.id || it.product_id;
          const lineUnit = (it.unit || '').trim() || prod?.unit || null;
          const baseQty = parseFloat(it.quantity) * conversionToBase(prod, lineUnit);
          movStmt.run(
            localProductId, productSyncId, 'sales', 'sale', -baseQty,
            order.id, 'order', req.user.id,
            randomUUID(), tenantId, branchId, deviceId,
            order.sync_id
          );
          if (productSyncId) stockDecStmt.run(baseQty, productSyncId);
        }
      }

      return db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    })();

    // 2-station closes the loop here, so trigger the same daily profit
    // recalc that confirm-dispatch normally would.
    if (result.status === 'DISPATCHED') {
      const orderDate = (result.created_at || '').split(' ')[0] || new Date().toISOString().split('T')[0];
      try { recalculateDailyProfit(db, orderDate, req.user.tenantId); } catch (_) {}
    }
    // ZRA saveSales at Cashier payment collection â€” this is when a
    // pending-payment order becomes a real fiscal invoice. Skips if the
    // order was already signed on POS checkout (idempotency via
    // orders.zra_status !== 'SIGNED').
    let zra = { skipped: true, reason: 'already signed or zra off' };
    if (result.zra_status !== 'SIGNED') {
      const zraItems = db.prepare(
        `SELECT oi.*, p.name AS product_name, p.code AS product_code,
                p.zra_item_cd, p.zra_item_cls_cd, p.zra_pkg_unit_cd,
                p.zra_qty_unit_cd, p.zra_vat_cat_cd, p.zra_excise_ty_cd, p.zra_rrp
           FROM order_items oi
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ? AND (oi.deleted_at IS NULL)`
      ).all(result.id);
      zra = await vsdc.saveSales(req.user.tenantId, result, zraItems, {
        actor:   String(req.user?.id || 'system'),
        actorNm: req.user?.name || req.user?.email || String(req.user?.id || 'system'),
      });
      if (zra.ok && zra.itemList) {
        // two_station deducts stock in the transaction above (status lands
        // on DISPATCHED); three_station leaves it for Dispatch confirm.
        const stockAlreadyOut = result.status === 'DISPATCHED';
      // 2026-08-28 â€” residual must be what is left AFTER this sale.
      // In flows where the goods have not physically left yet
      // (pos_dispatch / three_station: stock leaves at Dispatch confirm),
      // products.current_stock still counts what was just sold. We are
      // telling ZRA the sale happened, so reporting the pre-sale shelf
      // count sends a residual one sale too high on every such line.
      // Subtracting the sold quantity here keeps the figure right WITHOUT
      // Dispatch having to call ZRA â€” it stays purely physical.
        const snapshots = zraItems.map(it => {
          const prod = db.prepare(
            'SELECT current_stock, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?'
          ).get(it.product_id);
          let rsdQty = parseFloat(prod?.current_stock || 0) || 0;
          if (!stockAlreadyOut) {
            const lineUnit = (it.unit || '').trim() || prod?.unit || null;
            rsdQty -= (parseFloat(it.quantity) || 0) * conversionToBase(prod, lineUnit);
          }
          return { itemCd: it.zra_item_cd || it.product_code || String(it.product_id), rsdQty };
        });
        try {
          zra.stockChain = await vsdc.saveSaleStockChain(req.user.tenantId, result, zra.itemList, snapshots, { isCredit: false });
        } catch (_) { /* non-fatal */ }
      }
    }
    const finalResult = zra.skipped ? result : db.prepare('SELECT * FROM orders WHERE id = ?').get(result.id);
    res.json({ ...finalResult, zra });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Reverse order - void the order and restore stock
router.put('/:id/reverse', auth, async (req, res) => {
  try {
    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status === 'Reversed') throw Object.assign(new Error('Order already reversed'), { status: 400 });

      // v1.10.21 â€” before soft-deleting the movements, roll their net effect
      // back on products.current_stock so the cache stays consistent with
      // the movements ledger. Net qty per product = SUM(movements to delete);
      // reversing that means subtracting it from current_stock (a sale
      // movement is negative, so subtracting it adds back to stock).
      const soonDeleted = db.prepare(
        `SELECT product_sync_id, SUM(quantity) AS net
           FROM stock_movements
          WHERE reference_sync_id = ? AND location = 'sales'
            AND movement_type IN ('sale', 'sale_reverse') AND deleted_at IS NULL
          GROUP BY product_sync_id`
      ).all(order.sync_id);
      const stockRevStmt = db.prepare(
        `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
      );
      for (const r of soonDeleted) {
        if (r.product_sync_id) stockRevStmt.run(r.net, r.product_sync_id);
      }
      // v1.13.114 â€” ZRA Ref 8 audit trail: on full order reversal, keep
      // the original sale movements INTACT and add a compensating
      // 'sale_reverse' movement per product for the outstanding qty.
      // Previously we soft-deleted the sale rows which hid the sale
      // from Bin Card entirely â€” an auditor comparing Sales Report
      // (shows Reversed order) to Bin Card (shows nothing) would
      // question the mismatch. Partial reverse endpoint below already
      // does the right thing (line ~1725); this brings full reverse
      // in line with that pattern.
      //
      // r.net is the SIGNED sum of (sale + prior sale_reverse) per
      // product. Negative = outstanding-sold; positive = over-reversed
      // (shouldn't happen). Insert -r.net as the compensating qty so
      // sum(sale + sale_reverse) becomes 0 per product.
      const tenantId  = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();
      const insertRevStmt = db.prepare(
        `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),?)`
      );
      for (const r of soonDeleted) {
        if (!r.product_sync_id) continue;
        const compQty = -Number(r.net || 0);
        if (compQty <= 0) continue; // nothing outstanding to reverse
        const prodId = db.prepare('SELECT id FROM products WHERE sync_id = ?').get(r.product_sync_id)?.id || null;
        insertRevStmt.run(
          prodId, r.product_sync_id, 'sales', 'sale_reverse', compQty,
          req.params.id, 'order_reverse',
          `Full reversal of ${order.order_number}`, req.user?.id || null,
          randomUUID(), tenantId, branchId, deviceId, order.sync_id
        );
      }

      // Mark all line items fully reversed (cumulative reversed_quantity = original quantity).
      // v1.9.4 â€” bump updated_at on both rows. Without this, sync push to VPS
      // gets silently REJECTed by the timestamp check (incoming == server
      // because the row's local timestamp didn't move when status flipped),
      // and the web side keeps showing PENDING_PAYMENT forever. Reproduced
      // 2026-06-29 with ORD-0058â€“0061.
      db.prepare(
        `UPDATE order_items
         SET reversed = 1, reversed_quantity = quantity, reversed_at = datetime('now'),
             updated_at = datetime('now'), synced = 0
         WHERE order_sync_id = ? AND reversed = 0 AND deleted_at IS NULL`
      ).run(order.sync_id);
      db.prepare(
        `UPDATE orders SET status = 'Reversed', updated_at = datetime('now'), synced = 0 WHERE id = ?`
      ).run(req.params.id);
      return db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    })();

    // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" (no 'T'), so .split('T')[0] would return the whole string.
    // .slice(0, 10) safely extracts YYYY-MM-DD for both SQLite and ISO formats.
    const orderDate = result.created_at ? result.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
    recalculateDailyProfit(db, orderDate, req.user.tenantId);

    // Credit note to ZRA â€” mandatory once the original invoice was
    // fiscal (zra_rcpt_no set). Uses the same /trnsSales/saveSales with
    // rcptTyCd='R' and orgIncNo/orgSdcId back-referencing the original.
    // Reason code default '07' (other) â€” a future UI can let the user
    // pick from the 01â€“07 list. Reason is passed via req.body.rfd_rsn_cd.
    //
    // v1.13.100 â€” skipOrderPersist prevents vsdcClient from clobbering
    // the ORIGINAL sale's fiscal fields (rcptNo etc.) with the CN's.
    // Instead we persist the CN response into a parallel zra_cn_* column
    // set so the Sales Report can reprint the CN with its own fiscal
    // signature â€” a T08A #13 requirement (Tax Credit Note prints must
    // carry their own SDC ID, QR, receipt sign, VSDC date). Prior to
    // this, ZRA saw a valid CN but Red Sea lost the fiscal proof.
    let zra = { skipped: true, reason: 'not fiscal or zra off' };
    // v1.13.136 â€” Non-fiscal reversal path (ZRA off or original not signed).
    // Still capture the reason code + generate a local CN display number so
    // the reprint template can render a proper "Tax Credit Note" with its
    // own number distinct from the original invoice. Buseko (ZRA off during
    // UAT-1) needs this to satisfy ZRA UAT Â§3.8(b)+(c): CN must show reason
    // and its own CN number. Fields populated:
    //   local_cn_number       â€” string display (e.g. "CN-2026-A5C013-0197")
    //   zra_cn_rfd_rsn_cd     â€” 01â€“07 per spec 6.15 (from req.body)
    //   zra_cn_signed_at      â€” timestamp of local CN generation (repurposed
    //                            from "when ZRA signed"); also gates the CN
    //                            reprint template to render the CN block.
    if (!result.zra_rcpt_no || !result.zra_sdc_id) {
      const rfdRsnCd = req.body?.rfd_rsn_cd || '01';
      const rfdRsnOther = rfdRsnCd === '07'
        ? (req.body?.rfd_rsn_other ? String(req.body.rfd_rsn_other).trim().slice(0, 120) : null)
        : null;
      const localCnNumber = syncConfig.generateNumber('CN', 'orders');
      db.prepare(`
        UPDATE orders SET
          local_cn_number = ?,
          zra_cn_rfd_rsn_cd = ?,
          zra_cn_rfd_rsn_other = ?,
          zra_cn_signed_at = datetime('now'),
          updated_at = datetime('now'),
          synced = 0
        WHERE id = ?
      `).run(localCnNumber, rfdRsnCd, rfdRsnOther, result.id);
      zra = { skipped: true, reason: 'zra off', localCnNumber, rfdRsnCd, rfdRsnOther };
    }
    if (result.zra_rcpt_no && result.zra_sdc_id) {
      const zraItems = db.prepare(
        `SELECT oi.*, p.name AS product_name, p.code AS product_code,
                p.zra_item_cd, p.zra_item_cls_cd, p.zra_pkg_unit_cd,
                p.zra_qty_unit_cd, p.zra_vat_cat_cd, p.zra_excise_ty_cd, p.zra_rrp
           FROM order_items oi
           LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ?`
      ).all(result.id);
      const rfdRsnCd = req.body?.rfd_rsn_cd || '07';
      const rfdRsnOtherFiscal = rfdRsnCd === '07'
        ? (req.body?.rfd_rsn_other ? String(req.body.rfd_rsn_other).trim().slice(0, 120) : null)
        : null;
      zra = await vsdc.saveSales(req.user.tenantId, result, zraItems, {
        actor:   String(req.user?.id || 'system'),
        actorNm: req.user?.name || req.user?.email || String(req.user?.id || 'system'),
        rcptTyCd: 'R',
        rfdRsnCd,
        skipOrderPersist: true,
        // v1.13.70 â€” key spelled orgInvcNo (V+c) to match vsdcClient's read
        // at services/vsdcClient.js:333. Prior versions typed orgIncNo, so
        // every credit note VSDC upload carried orgInvcNo=0 â†’ ZRA rejected
        // it as an un-linked reversal. Debit-note path (orders.js:1838)
        // was already correct.
        orgInvoice: { orgInvcNo: result.zra_rcpt_no, orgSdcId: result.zra_sdc_id },
      });
      if (zra.ok) {
        db.prepare(`
          UPDATE orders SET
            zra_cn_cis_invc_no = ?,
            zra_cn_rcpt_no = ?,
            zra_cn_intrl_data = ?,
            zra_cn_rcpt_sign = ?,
            zra_cn_sdc_id = ?,
            zra_cn_mrc_no = ?,
            zra_cn_vsdc_rcpt_pbct_date = ?,
            zra_cn_qr_code_url = ?,
            zra_cn_rfd_rsn_cd = ?,
            zra_cn_rfd_rsn_other = ?,
            zra_cn_signed_at = datetime('now'),
            updated_at = datetime('now'),
            synced = 0
          WHERE id = ?
        `).run(
          zra.cisInvcNo ?? null,
          zra.rcptNo ?? null,
          zra.intrlData ?? null,
          zra.rcptSign ?? null,
          zra.sdcId ?? null,
          zra.mrcNo ?? null,
          zra.vsdcRcptPbctDate ?? null,
          zra.qrCodeUrl ?? null,
          rfdRsnCd,
          rfdRsnOtherFiscal,
          result.id,
        );
      }
      // Stock chain for the reversal (SALE_CANCELLATION, sarTyCd 12).
      if (zra.ok && zra.itemList) {
        const snapshots = zraItems.map(it => ({
          itemCd: it.zra_item_cd || it.product_code || String(it.product_id),
          rsdQty: parseFloat(db.prepare('SELECT current_stock FROM products WHERE id = ?').get(it.product_id)?.current_stock || 0) || 0,
        }));
        try {
          zra.stockChain = await vsdc.saveSaleStockChain(req.user.tenantId, result, zra.itemList, snapshots, { isCredit: true });
        } catch (_) { /* non-fatal */ }
      }
    }
    // Re-read so the response carries the newly-stamped zra_cn_* fields.
    const finalResult = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.id) || result;
    res.json({ ...finalResult, zra });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Reverse a single item â€” supports PARTIAL reversal via body.quantity and body.unit
// Body: { quantity?: number, unit?: string }
//   quantity defaults to remaining line qty
//   unit defaults to the line's original unit (typically what was sold)
//   When unit differs from line.unit, the system converts via product's conversion_factor.
router.put('/:id/items/:itemId/reverse', auth, async (req, res) => {
  try {
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const requestedQty = req.body?.quantity != null ? parseFloat(req.body.quantity) : null;
    const requestedUnit = (req.body?.unit || '').trim() || null;
    // v1.13.79 â€” captured inside the tx and used AFTER commit to fire the
    // ZRA credit note that covers just this partial line reversal.
    let cnLine = null;

    const result = db.transaction(() => {
      const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
      if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
      if (order.status === 'Reversed') throw Object.assign(new Error('Order already fully reversed'), { status: 400 });

      const item = db.prepare('SELECT * FROM order_items WHERE id = ? AND order_sync_id = ? AND deleted_at IS NULL').get(req.params.itemId, order.sync_id);
      if (!item) throw Object.assign(new Error('Item not found in this order'), { status: 404 });
      if (item.reversed) throw Object.assign(new Error('Item already fully reversed'), { status: 400 });

      // v1.8.39 â€” include local products.id so the stock_movements INSERT
      // below uses the THIS-DB integer ID, not item.product_id which is
      // the originating device's local ID (cross-device sync sends order
      // rows verbatim so the integer can point at a nonexistent row on
      // the receiving DB â†’ FOREIGN KEY constraint failed).
      const prod = db.prepare('SELECT id, unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?').get(item.product_sync_id);
      const localProductId = prod?.id || item.product_id;

      // Resolve which unit user is reversing in
      const reverseUnit = requestedUnit || item.unit || prod?.unit;
      const reverseUnitConv = conversionToBase(prod, reverseUnit);
      const lineUnitConv = conversionToBase(prod, item.unit || prod?.unit);

      // Default to full remaining (in line's unit) if no qty given
      const alreadyReversedInLineUnit = parseFloat(item.reversed_quantity || 0);
      const remainingInLineUnit = parseFloat(item.quantity) - alreadyReversedInLineUnit;
      const reverseQty = requestedQty != null ? requestedQty : remainingInLineUnit;
      if (!(reverseQty > 0)) throw Object.assign(new Error('Reverse quantity must be greater than zero'), { status: 400 });

      // Convert reverseQty into BASE units (for stock_movement) and into LINE's unit (for tracking reversed_quantity)
      const reverseBaseQty = reverseQty * reverseUnitConv;
      const lineBaseQty    = parseFloat(item.quantity) * lineUnitConv;
      const reverseInLineUnit = reverseBaseQty / (lineUnitConv || 1);

      // Validate against remaining (compare in line's unit since that's how reversed_quantity is stored)
      if (reverseInLineUnit > remainingInLineUnit + 0.0001) {
        const remBase = remainingInLineUnit * lineUnitConv;
        throw Object.assign(new Error(`Cannot reverse more than ${remainingInLineUnit} ${item.unit || ''} (= ${remBase} ${prod?.unit || 'base units'})`), { status: 400 });
      }

      // Insert positive stock movement in BASE units to restore sales stock
      db.prepare(
        `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, reference_id, reference_type, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'),?)`
      ).run(localProductId, item.product_sync_id, 'sales', 'sale_reverse', reverseBaseQty, req.params.id, 'order_reverse',
            `Partial reverse of ${reverseQty} ${reverseUnit}`, req.user.id,
            randomUUID(), tenantId, branchId, deviceId, order.sync_id);
      // v1.10.21 â€” increment products.current_stock alongside the reversal movement.
      if (item.product_sync_id) {
        db.prepare(
          `UPDATE products SET current_stock = current_stock + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
        ).run(reverseBaseQty, item.product_sync_id);
      }

      // Track reversed_quantity in LINE's unit (so item.quantity vs item.reversed_quantity stays consistent)
      const newReversedQty = alreadyReversedInLineUnit + reverseInLineUnit;
      const fullyReversed = newReversedQty >= parseFloat(item.quantity) - 0.0001;
      db.prepare(
        // v1.9.4 â€” also bump updated_at; otherwise the row's local timestamp
        // doesn't move, server's timestamp REJECT silently drops the push.
        `UPDATE order_items SET reversed_quantity = ?, reversed = ?, reversed_at = CASE WHEN ? THEN datetime('now') ELSE reversed_at END, updated_at = datetime('now'), synced = 0 WHERE id = ?`
      ).run(newReversedQty, fullyReversed ? 1 : 0, fullyReversed ? 1 : 0, req.params.itemId);

      // Proportional refund based on reversed base qty relative to original base qty
      const refund = (reverseBaseQty / lineBaseQty) * parseFloat(item.total_price);
      const newSubtotal = Math.max(0, parseFloat(order.subtotal) - refund);
      const newTotal = Math.max(0, parseFloat(order.total_amount) - refund);

      // v1.8.12 â€” refund the customer in the same currency mix they paid with.
      // Otherwise the per-currency cash buckets stay overstated on the Cash
      // Report (status='Partial' leaves the order in the SUM, and cash_received
      // wouldn't drop). Distribution: each currency's USD-equivalent share of
      // the original amount_received determines its share of the refund.
      const oldCash = parseFloat(order.cash_received || 0);
      const oldFra  = parseFloat(order.fra_received  || 0);
      const oldK    = parseFloat(order.k_received    || 0);
      const sellRate  = parseFloat(order.selling_rate_used   || 0);
      const sellRateK = parseFloat(order.selling_rate_k_used || 0);
      const oldAmtRecv = parseFloat(order.amount_received || 0);
      const oldChange  = parseFloat(order.change_amount   || 0);
      let newCash = oldCash, newFra = oldFra, newK = oldK;
      let newAmtRecv = oldAmtRecv;
      let newChange = oldChange;
      if (oldAmtRecv > 0.0001 && refund > 0.0001) {
        // Each currency's USD-equivalent contribution
        const usdShare = oldCash;
        const fraShare = sellRate  > 0 ? (oldFra / sellRate)  : 0;
        const kShare   = sellRateK > 0 ? (oldK   / sellRateK) : 0;
        const totalShare = usdShare + fraShare + kShare;
        if (totalShare > 0.0001) {
          // Kelete tri-currency path: distribute refund across per-currency
          // received columns and decrement amount_received. change_amount
          // stays put â€” it already ties out because amount_received drops
          // by exactly the same delta as total_amount.
          const refundUsd = refund * (usdShare / totalShare);
          const refundFra = refund * (fraShare / totalShare) * (sellRate  || 0);
          const refundK   = refund * (kShare   / totalShare) * (sellRateK || 0);
          newCash = Math.max(0, oldCash - refundUsd);
          newFra  = Math.max(0, oldFra  - refundFra);
          newK    = Math.max(0, oldK    - refundK);
          newAmtRecv = Math.max(0, oldAmtRecv - refund);
        } else {
          // v1.10.102 â€” Liquor path (cash/fra/k all 0, customer paid via
          // momo/bank). Pre-v1.10.102 the block above was skipped entirely
          // and neither amount_received NOR change_amount moved, breaking
          // the reconciliation identity amount_received âˆ’ total_amount =
          // change_amount. The K200 gap seen on Lusaka1 ORD-0150 was this:
          // partial-refund reduced total from K1,795 to K1,595 but change
          // stayed at K455 (the change dispensed at sale time), leaving
          // K200 unaccounted for.
          //
          // Fix (option A per user 2026-07-04): keep amount_received and
          // momo/bank_received as-is (money physically already came in),
          // bump change_amount by the refund so the identity holds. Trade-
          // off: change_amount now means "total change owed to customer"
          // instead of "physical change dispensed at till". Cash drawer
          // will show a shortage equal to unpaid refunds â€” a useful signal
          // to remind the cashier to hand the money back.
          newChange = oldChange + refund;
        }
      }

      // Order status: 'Reversed' if every item is fully reversed, else 'Partial' (or original status if nothing reversed)
      const remaining = db.prepare('SELECT COUNT(*) AS cnt FROM order_items WHERE order_sync_id = ? AND reversed = 0 AND deleted_at IS NULL').get(order.sync_id);
      const allReversed = remaining.cnt === 0;

      db.prepare(`UPDATE orders
         SET subtotal = ?, total_amount = ?, status = ?,
             cash_received = ?, fra_received = ?, k_received = ?,
             amount_received = ?, change_amount = ?,
             updated_at = datetime('now'),
             synced = 0
         WHERE id = ?`).run(
        newSubtotal, newTotal, allReversed ? 'Reversed' : 'Partial',
        newCash, newFra, newK, newAmtRecv, newChange,
        req.params.id
      );

      const updatedOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
      const allItems = db.prepare('SELECT * FROM order_items WHERE order_sync_id = ? AND deleted_at IS NULL').all(order.sync_id);
      // v1.13.79 â€” capture ONE synthetic line describing the reversed
      // portion (in the LINE's original unit so unit_price applies
      // directly, matching what the original sale invoice already shows).
      // Enriched with the product's ZRA classification so saveSales can
      // compute VAT + MTV boost identically to the original sale.
      const zraProd = db.prepare(
        `SELECT id, sync_id, code, name,
                zra_item_cd, zra_item_cls_cd, zra_pkg_unit_cd,
                zra_qty_unit_cd, zra_vat_cat_cd, zra_excise_ty_cd, zra_rrp
           FROM products WHERE sync_id = ? LIMIT 1`
      ).get(item.product_sync_id) || {};
      // v1.13.129 â€” Carry the ORIGINAL sale's frozen snapshot fields
      // through to the credit note, prorated by the reversed fraction.
      // This means the CN's ZRA figures always mirror what the original
      // invoice reported, even if the product's RRP or VAT category was
      // later edited. Guards divide-by-zero if the line quantity was
      // somehow zero (defensive â€” should never fire, sale wouldn't post).
      const origLineQty = parseFloat(item.quantity) || 0;
      const propFrac = origLineQty > 0 ? (reverseInLineUnit / origLineQty) : 0;
      const snapTaxbl = item.zra_vat_taxbl_amt != null && item.zra_vat_taxbl_amt !== ''
        ? Number(item.zra_vat_taxbl_amt) * propFrac
        : null;
      const snapVat = item.zra_vat_amt != null && item.zra_vat_amt !== ''
        ? Number(item.zra_vat_amt) * propFrac
        : null;
      cnLine = {
        product_id:   localProductId,
        product_code: zraProd.code || null,
        product_name: zraProd.name || null,
        quantity:     reverseInLineUnit,             // in line's original unit
        unit:         item.unit,
        unit_price:   item.unit_price,               // per line's unit
        discount:     item.discount,                 // per-unit discount snapshot
        zra_item_cd:      zraProd.zra_item_cd || null,
        zra_item_cls_cd:  zraProd.zra_item_cls_cd || null,
        zra_pkg_unit_cd:  zraProd.zra_pkg_unit_cd || null,
        zra_qty_unit_cd:  zraProd.zra_qty_unit_cd || null,
        zra_vat_cat_cd:   zraProd.zra_vat_cat_cd || null,
        zra_excise_ty_cd: zraProd.zra_excise_ty_cd || null,
        zra_rrp:          zraProd.zra_rrp || null,
        // Snapshot fields â€” vsdcClient.saveSales prefers these when present.
        zra_vat_cat_snap:  item.zra_vat_cat_snap || null,
        zra_rrp_snap:      item.zra_rrp_snap != null ? item.zra_rrp_snap : null,
        zra_vat_rate:      item.zra_vat_rate    != null ? item.zra_vat_rate : null,
        zra_vat_taxbl_amt: snapTaxbl,
        zra_vat_amt:       snapVat,
      };
      return { ...updatedOrder, items: allItems };
    })();

    // SQLite's datetime('now') returns "YYYY-MM-DD HH:MM:SS" (no 'T'), so .split('T')[0] would return the whole string.
    // .slice(0, 10) safely extracts YYYY-MM-DD for both SQLite and ISO formats.
    const orderDate = result.created_at ? result.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
    recalculateDailyProfit(db, orderDate, req.user.tenantId);

    // v1.13.79 â€” ZRA credit note for the reversed portion (blocker #5).
    // Fires only when the ORIGINAL sale was fiscal (zra_rcpt_no set) and
    // we captured a reversed line above.
    //
    // synthOrder pattern (same shape as the DN path at line ~1894):
    //   * skipOrderPersist keeps the original invoice's fiscal fields on
    //     the order row intact â€” the order is still partially active so
    //     the CN's rcpt_no must NOT clobber the original.
    //   * A shim without zra_cis_invc_no forces saveSales to allocate a
    //     NEW cisInvcNo for the CN. If we passed the full `result`, its
    //     inherited zra_cis_invc_no would be reused and VSDC would
    //     reject the CN with resultCd 924 (duplicate).
    //   * cashDcAmt is skipped (discount=0 on the shim) â€” Red Sea doesn't
    //     use discounts and partial-refund fraction of the original
    //     cart discount isn't meaningful anyway.
    let zra = { skipped: true, reason: 'not fiscal or nothing to reverse' };
    if (result.zra_rcpt_no && result.zra_sdc_id && cnLine) {
      const synthOrder = {
        id:             result.id,
        customer_tpin:  result.customer_tpin || null,
        // v1.13.147 â€” partial CN / debit note synth orders no longer
        // hardcode 'Walk-in' as customer_name. ZRA custNm is OPTIONAL
        // per Â§5.8; sending literal 'Walk-in' polluted the portal's
        // Customer Name column while ordinary sales left it blank. Now
        // consistent: no B2B TPIN â†’ null custNm across ALL receipt
        // types (S / R full / R partial / D).
        customer_name:  result.customer_name || null,
        payment_method: result.payment_method || 'Cash',
        discount:       0,
        zra_currency_ty_cd: result.zra_currency_ty_cd || 'ZMW',
        zra_exchange_rt:    result.zra_exchange_rt || 1,
        // T08A #6 LPO â€” the original order's lpo_number was never copied
        // onto this synth shim, so vsdcClient's `isLpo` check always read
        // false here and sent the partial CN's line at its normal VAT
        // category/rate instead of the zero-rated Cat C2 the original
        // LPO invoice used. Carrying it through restores that override.
        lpo_number:     result.lpo_number || null,
      };
      const rfdRsnCd = req.body?.rfd_rsn_cd || '07';
      const rfdRsnOtherFiscal = rfdRsnCd === '07'
        ? (req.body?.rfd_rsn_other ? String(req.body.rfd_rsn_other).trim().slice(0, 120) : null)
        : null;
      try {
        zra = await vsdc.saveSales(req.user.tenantId, synthOrder, [cnLine], {
          actor:   String(req.user?.id || 'system'),
          actorNm: req.user?.name || req.user?.email || String(req.user?.id || 'system'),
          rcptTyCd: 'R',
          rfdRsnCd,
          skipOrderPersist: true,
          orgInvoice: { orgInvcNo: result.zra_rcpt_no, orgSdcId: result.zra_sdc_id },
        });
        // v1.13.100 â€” persist the CN's own fiscal data so the reprint
        // template can render it as a T08A-compliant Tax Credit Note
        // (CRN prefix + own QR + own SDC ID + own signature). Same
        // pattern as the full-reverse route above; partials overwrite
        // any prior partial's CN data on the same order.
        if (zra.ok) {
          db.prepare(`
            UPDATE orders SET
              zra_cn_cis_invc_no = ?,
              zra_cn_rcpt_no = ?,
              zra_cn_intrl_data = ?,
              zra_cn_rcpt_sign = ?,
              zra_cn_sdc_id = ?,
              zra_cn_mrc_no = ?,
              zra_cn_vsdc_rcpt_pbct_date = ?,
              zra_cn_qr_code_url = ?,
              zra_cn_rfd_rsn_cd = ?,
              zra_cn_rfd_rsn_other = ?,
              zra_cn_signed_at = datetime('now'),
              updated_at = datetime('now'),
              synced = 0
            WHERE id = ?
          `).run(
            zra.cisInvcNo ?? null,
            zra.rcptNo ?? null,
            zra.intrlData ?? null,
            zra.rcptSign ?? null,
            zra.sdcId ?? null,
            zra.mrcNo ?? null,
            zra.vsdcRcptPbctDate ?? null,
            zra.qrCodeUrl ?? null,
            rfdRsnCd,
            rfdRsnOtherFiscal,
            result.id,
          );
        }
        // Stock chain for the reversal (sarTyCd=12 SALE_CANCELLATION).
        // The snapshot is the POST-reverse current_stock â€” restored by
        // the transaction above.
        if (zra.ok && zra.itemList) {
          const snap = [{
            itemCd: cnLine.zra_item_cd || cnLine.product_code || String(cnLine.product_id),
            rsdQty: parseFloat(db.prepare('SELECT current_stock FROM products WHERE id = ?').get(cnLine.product_id)?.current_stock || 0) || 0,
          }];
          try {
            zra.stockChain = await vsdc.saveSaleStockChain(req.user.tenantId, synthOrder, zra.itemList, snap, { isCredit: true });
          } catch (_) { /* non-fatal */ }
        }
      } catch (e) {
        zra = { ok: false, error: e.message };
      }
    }

    // Re-read so the response carries the newly-stamped zra_cn_* fields.
    const finalResult = db.prepare('SELECT * FROM orders WHERE id = ?').get(result.id) || result;
    res.json({ ...finalResult, zra });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// v1.13.94 â€” Manual ZRA retry for a single order stuck in FAILED status.
// Same underlying logic the background retry queue uses; this endpoint
// exists so operators can force a retry from the SalesReport UI without
// waiting for the next cron tick.
router.post('/:id/retry-zra', auth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!orderId) return res.status(400).json({ error: 'invalid id' });
    const order = db.prepare('SELECT id, zra_status FROM orders WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?').get(orderId, req.user.tenantId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.zra_status === 'SIGNED') return res.status(400).json({ error: 'Already signed â€” nothing to retry.' });
    // ambient db proxy is already scoped to the current tenant via the
    // tenant middleware, so retryOrder can use it directly.
    const result = await zraRetryOrder(req.user.tenantId, orderId);
    res.json({ ok: !!result?.ok, zra: result });
  } catch (error) {
    console.error('[orders.retry-zra]', error);
    res.status(500).json({ error: error.message });
  }
});

// v1.13.38 â€” Debit Note flow.
//
// A debit note is an additional charge tied to an already-finalised sale
// ("we forgot to bill the delivery", "the item was more expensive than
// invoiced"). It is NOT a reversal â€” the customer owes MORE than the
// original invoice.
//
// Flow:
//   1. Insert debit_notes row locally (always saves â€” local wins).
//   2. If the original sale was fiscally signed by ZRA, register the DN
//      through /trnsSales/saveSales with rcptTyCd='D' and orgIncNo/
//      orgSdcId referencing the original. Uses a single synthetic
//      "Additional charge" line at standard VAT (cat A).
//   3. Copy ZRA fiscal fields onto the debit_notes row.
//
// Reason codes (ZRA spec 6.16 â€” same list as credit notes):
//   01 wrong product Â· 02 wrong price Â· 03 damaged Â· 04 wrong customer
//   05 duplicate     Â· 06 excess      Â· 07 other
router.post('/:id/debit-note', auth, async (req, res) => {
  try {
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const amount = parseFloat(req.body?.amount || 0);
    const reasonCd = String(req.body?.reason_cd || '07').padStart(2, '0');
    const notes = (req.body?.notes || '').trim() || null;

    if (!(amount > 0)) {
      return res.status(400).json({ error: 'Amount must be greater than zero.' });
    }
    if (!['01','02','03','04','05','06','07'].includes(reasonCd)) {
      return res.status(400).json({ error: 'reason_cd must be 01â€“07 (per ZRA spec 6.16).' });
    }

    const orig = db.prepare(
      `SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL`
    ).get(req.params.id);
    if (!orig) return res.status(404).json({ error: 'Original order not found.' });
    if (orig.status === 'Reversed') {
      return res.status(400).json({ error: 'Cannot issue a debit note against a reversed order.' });
    }

    // Allocate DN number using the local sequence for the tenant. Same
    // shape as GRN/SIV numbering ("DN-YYYY-<counter>"). If the counter
    // isn't seeded yet, start at 1.
    const now = new Date();
    const year = now.getFullYear();
    const seqRow = db.prepare(
      `SELECT COUNT(*) AS n FROM debit_notes WHERE strftime('%Y', date) = ?`
    ).get(String(year));
    const nextSeq = (seqRow?.n || 0) + 1;
    const dnNumber = `DN-${year}-${String(nextSeq).padStart(5, '0')}`;
    const dnSyncId = randomUUID();
    const dateStr = now.toISOString().slice(0, 10);
    const actorName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ')
                    || req.user?.email || 'staff';

    const info = db.prepare(`
      INSERT INTO debit_notes (
        sync_id, dn_number, date,
        orig_order_id, orig_order_sync_id, orig_order_number,
        customer_id, customer_name,
        amount, reason_cd, notes,
        created_by, created_by_name,
        tenant_id, branch_id, device_id, synced
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)
    `).run(
      dnSyncId, dnNumber, dateStr,
      orig.id, orig.sync_id, orig.order_number,
      orig.customer_id || null, orig.customer_name || null,
      amount, reasonCd, notes,
      req.user?.id || null, actorName,
      tenantId, branchId || null, deviceId || null,
    );
    const dnId = info.lastInsertRowid;

    // Fiscal registration â€” only if the original was signed by ZRA.
    // Otherwise mark SKIPPED so the DN still exists locally as a
    // billing artifact.
    let zra = { skipped: true, reason: 'original not fiscal or ZRA off' };
    if (orig.zra_rcpt_no && orig.zra_sdc_id) {
      // Synthetic single-line item at standard VAT. Doesn't hit stock â€”
      // debit notes in v1 are money-only adjustments.
      const synthOrder = {
        id: dnId,                                // won't be persisted (skipOrderPersist)
        customer_tpin: orig.customer_tpin || null,
        // v1.13.147 â€” see partial-CN block: no more 'Walk-in' literal
        // in ZRA custNm. Blank when no B2B TPIN, matching sale behaviour.
        customer_name: orig.customer_name || null,
        payment_method: orig.payment_method || 'Cash',
        zra_currency_ty_cd: 'ZMW',
        zra_exchange_rt: 1,
      };
      const synthItems = [{
        product_id:   null,
        product_code: 'DN-ADJ',
        product_name: notes || 'Additional charge',
        quantity:     1,
        unit_price:   amount,
        discount:     0,
        zra_item_cd:      'DN-ADJ',
        zra_item_cls_cd:  null,
        zra_pkg_unit_cd:  'NT',
        zra_qty_unit_cd:  'U',
        zra_vat_cat_cd:   'A',
        zra_excise_ty_cd: null,
      }];
      zra = await vsdc.saveSales(tenantId, synthOrder, synthItems, {
        actor:   String(req.user?.id || 'system'),
        actorNm: req.user?.name || req.user?.email || String(req.user?.id || 'system'),
        rcptTyCd: 'D',
        dbtRsnCd: reasonCd,
        orgInvoice: { orgInvcNo: orig.zra_rcpt_no, orgSdcId: orig.zra_sdc_id },
        skipOrderPersist: true,
      });
      // Copy the fiscal response into the debit_notes row.
      if (zra.ok) {
        db.prepare(`
          UPDATE debit_notes SET
            zra_cis_invc_no = ?,
            zra_rcpt_no     = ?,
            zra_intrl_data  = ?,
            zra_rcpt_sign   = ?,
            zra_sdc_id      = ?,
            zra_mrc_no      = ?,
            zra_vsdc_rcpt_pbct_date = ?,
            zra_qr_code_url = ?,
            zra_org_incc_no = ?,
            zra_org_sdc_id  = ?,
            zra_dbt_rsn_cd  = ?,
            zra_status      = 'SIGNED',
            zra_error_code  = NULL,
            zra_error_message = NULL,
            updated_at      = datetime('now')
          WHERE id = ?
        `).run(
          zra.cisInvcNo || null,
          zra.rcptNo || null,
          zra.intrlData || null,
          zra.rcptSign || null,
          zra.sdcId || null,
          zra.mrcNo || null,
          zra.vsdcRcptPbctDate || null,
          zra.qrCodeUrl || null,
          orig.zra_rcpt_no,
          orig.zra_sdc_id,
          reasonCd,
          dnId,
        );
      } else {
        db.prepare(`
          UPDATE debit_notes SET
            zra_status = 'FAILED',
            zra_cis_invc_no = ?,
            zra_error_code = ?,
            zra_error_message = ?,
            updated_at = datetime('now')
          WHERE id = ?
        `).run(
          zra.cisInvcNo || null,
          zra.resultCd || null,
          (zra.error || 'unknown').slice(0, 500),
          dnId,
        );
      }
    } else {
      db.prepare(
        `UPDATE debit_notes SET zra_status = 'SKIPPED' WHERE id = ?`
      ).run(dnId);
    }

    const saved = db.prepare(`SELECT * FROM debit_notes WHERE id = ?`).get(dnId);
    res.status(201).json({ ...saved, zra });
  } catch (error) {
    console.error('[orders.debit-note]', error);
    res.status(error.status || 500).json({ error: error.message });
  }
});

// GET /api/orders/:id/debit-notes â€” list DNs attached to an order.
router.get('/:id/debit-notes', auth, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT * FROM debit_notes
        WHERE orig_order_id = ? AND deleted_at IS NULL
        ORDER BY created_at DESC`
    ).all(req.params.id);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/debit-notes â€” global list for reports + AR reconciliation.
router.get('/debit-notes/list', auth, (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 1000);
    const rows = db.prepare(
      `SELECT * FROM debit_notes
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?`
    ).all(limit);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
