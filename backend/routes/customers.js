const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const vsdc = require('../services/vsdcClient');

// v1.13.128 — Fire-and-forget ZRA branch-customer registration. Called
// after POST/PUT /customers when the row carries a TPIN. Walk-in
// customers (no TPIN) are silently skipped by the wrapper. Never blocks
// the response — ZRA outages must not stop the operator from creating
// or editing a customer record.
function fireZraCustomerSync(tenantId, customerId, actor) {
  setImmediate(() => {
    try {
      const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
      if (!row) return;
      vsdc.saveBranchCustomer(tenantId, row, { actor })
        .catch(e => console.warn('[zra saveBranchCustomer] threw:', e.message));
    } catch (e) {
      console.warn('[zra saveBranchCustomer] pre-fetch failed:', e.message);
    }
  });
}

// ── Customer list with outstanding balance + credit usage info ───────────────
// from/to (optional): restrict orders and customer_payments to a date range.
// Used by the AR page when the cashier wants a period view (totals = period activity).
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { type, search, from, to } = req.query;
    // Order rows are filtered by DATE(created_at); payments by payment_date.
    const orderDateClause = (from ? ' AND DATE(created_at) >= ?' : '') + (to ? ' AND DATE(created_at) <= ?' : '');
    const payDateClause   = (from ? ' AND payment_date >= ?' : '') + (to ? ' AND payment_date <= ?' : '');
    const dateArgsOrders  = [...(from ? [from] : []), ...(to ? [to] : [])];
    const dateArgsPay     = [...(from ? [from] : []), ...(to ? [to] : [])];

    let query = `
      SELECT c.*,
        COALESCE(orders_agg.total_sold, 0)       AS total_sold,
        COALESCE(orders_agg.cash_at_sale, 0)     AS cash_at_sale,
        COALESCE(payments_agg.total_paid, 0)     AS total_paid,
        -- AR owed = opening balance + full sales − cash paid at till
        --           − later AR payments
        -- 2026-09-07 — what the customer walked in owing.
        --
        -- Balances carried over from the old system have no orders behind
        -- them here, and must never be entered as backdated sales: an order
        -- goes through the ZRA fiscal chain, deducts stock and lands in the
        -- Profit Report, so it would declare revenue twice for trade that
        -- happened before go-live. This is an opening balance instead - a
        -- statement of what was owed on day one, touching nothing else.
        COALESCE(c.opening_balance, 0)
          + COALESCE(orders_agg.total_sold, 0)
          - COALESCE(orders_agg.cash_at_sale, 0)
          - COALESCE(payments_agg.total_paid, 0) AS outstanding,
        -- v1.8.57 — FRA / K equivalents of the outstanding, computed
        -- using the FX rate captured at each order's sale time. Per
        -- order: unpaid_usd × selling_rate_used. Then scaled by the
        -- ratio of (current outstanding) / (sum of order unpaids before
        -- AR payments) so AR payments reduce all three views together.
        COALESCE(orders_agg.unpaid_fra_at_sale, 0) AS unpaid_fra_at_sale,
        COALESCE(orders_agg.unpaid_k_at_sale, 0)   AS unpaid_k_at_sale,
        COALESCE(orders_agg.unpaid_usd_for_ratio, 0) AS unpaid_usd_for_ratio,
        oldest_unpaid.oldest_order_date AS oldest_unpaid_date
      FROM customers c
      LEFT JOIN (
        SELECT customer_sync_id,
          SUM(total_amount)                  AS total_sold,
          -- cap each line's cash_at_sale at the order total — over-tender came back as change
          SUM(CASE WHEN COALESCE(amount_received, 0) > total_amount
                   THEN total_amount
                   ELSE COALESCE(amount_received, 0) END)  AS cash_at_sale,
          -- Per-order unpaid at sale time, valued in FRA and K using
          -- the rate snapshot from when the order was placed.
          SUM(CASE WHEN total_amount > COALESCE(amount_received, 0)
                   THEN (total_amount - COALESCE(amount_received, 0)) * COALESCE(selling_rate_used, 0)
                   ELSE 0 END) AS unpaid_fra_at_sale,
          SUM(CASE WHEN total_amount > COALESCE(amount_received, 0)
                   THEN (total_amount - COALESCE(amount_received, 0)) * COALESCE(selling_rate_k_used, 0)
                   ELSE 0 END) AS unpaid_k_at_sale,
          SUM(CASE WHEN total_amount > COALESCE(amount_received, 0)
                   THEN (total_amount - COALESCE(amount_received, 0))
                   ELSE 0 END) AS unpaid_usd_for_ratio
        FROM orders
        WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
          AND customer_sync_id IS NOT NULL${orderDateClause}
        GROUP BY customer_sync_id
      ) orders_agg ON orders_agg.customer_sync_id = c.sync_id
      LEFT JOIN (
        SELECT customer_sync_id, SUM(amount) AS total_paid
        FROM customer_payments
        WHERE deleted_at IS NULL AND customer_sync_id IS NOT NULL${payDateClause}
        GROUP BY customer_sync_id
      ) payments_agg ON payments_agg.customer_sync_id = c.sync_id
      LEFT JOIN (
        SELECT customer_sync_id, MIN(DATE(created_at)) AS oldest_order_date
        FROM orders
        WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
          AND customer_sync_id IS NOT NULL${orderDateClause}
        GROUP BY customer_sync_id
      ) oldest_unpaid ON oldest_unpaid.customer_sync_id = c.sync_id
      WHERE c.deleted_at IS NULL AND c.tenant_id = ?`;
    const params = [...dateArgsOrders, ...dateArgsPay, ...dateArgsOrders, req.user.tenantId];
    if (type && type !== 'All Types') {
      params.push(type);
      query += ` AND c.type = ?`;
    }
    if (search) {
      params.push(`%${search}%`, `%${search}%`);
      query += ` AND (c.name LIKE ? OR c.phone LIKE ?)`;
    }
    query += ' ORDER BY c.name';
    const rows = db.prepare(query).all(...params);
    // v1.8.57 — scale per-currency unpaid totals by ratio of
    // current_outstanding / sum_of_order_unpaids_at_sale, so AR
    // payments reduce FRA/K equivalents in lockstep with USD.
    for (const r of rows) {
      const ratioDenom = parseFloat(r.unpaid_usd_for_ratio || 0);
      const outstanding = Math.max(0, parseFloat(r.outstanding || 0));
      const ratio = ratioDenom > 0 ? Math.min(1, outstanding / ratioDenom) : 0;
      r.outstanding_fra = parseFloat(r.unpaid_fra_at_sale || 0) * ratio;
      r.outstanding_k   = parseFloat(r.unpaid_k_at_sale   || 0) * ratio;
    }
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM customers WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    const retail = db.prepare("SELECT COUNT(*) AS cnt FROM customers WHERE deleted_at IS NULL AND tenant_id = ? AND type = 'Retail'").get(tenantId);
    const wholesale = db.prepare("SELECT COUNT(*) AS cnt FROM customers WHERE deleted_at IS NULL AND tenant_id = ? AND type = 'Wholesale'").get(tenantId);
    const revenue = db.prepare('SELECT COALESCE(SUM(total_purchases),0) AS total FROM customers WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    res.json({
      totalCustomers: total.cnt,
      retail: retail.cnt,
      wholesale: wholesale.cnt,
      totalRevenue: parseFloat(revenue.total)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── AR Stats — totals across the whole customer base for the AR dashboard ───
// 2026-09-13 — the body of GET /ar-stats, lifted out so HQ Cash Position shows
// each depot's AR still owed from the same calculation as the depot's AR page.
function computeArStats({ tenantId, from, to }) {
  {
    const orderDateClause = (from ? ' AND DATE(created_at) >= ?' : '') + (to ? ' AND DATE(created_at) <= ?' : '');
    const payDateClause   = (from ? ' AND payment_date >= ?' : '') + (to ? ' AND payment_date <= ?' : '');
    const dateArgsOrders  = [...(from ? [from] : []), ...(to ? [to] : [])];
    const dateArgsPay     = [...(from ? [from] : []), ...(to ? [to] : [])];

    const totals = db.prepare(`
      SELECT
        COALESCE(SUM(orders_agg.total_sold), 0)   AS total_sales,
        COALESCE(SUM(orders_agg.cash_at_sale), 0) AS cash_at_sale,
        COALESCE(SUM(payments_agg.total_paid), 0) AS total_received,
        COALESCE(SUM(c.opening_balance), 0)       AS opening_balance,
        -- Outstanding = opening balances + full sales − cash paid at till
        --               − later AR payments
        COALESCE(SUM(c.opening_balance), 0)
          + COALESCE(SUM(orders_agg.total_sold), 0)
          - COALESCE(SUM(orders_agg.cash_at_sale), 0)
          - COALESCE(SUM(payments_agg.total_paid), 0) AS outstanding
      FROM customers c
      LEFT JOIN (
        SELECT customer_sync_id,
          SUM(total_amount)                 AS total_sold,
          SUM(CASE WHEN COALESCE(amount_received, 0) > total_amount
                   THEN total_amount
                   ELSE COALESCE(amount_received, 0) END) AS cash_at_sale
        FROM orders
        WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
          AND customer_sync_id IS NOT NULL${orderDateClause}
        GROUP BY customer_sync_id
      ) orders_agg ON orders_agg.customer_sync_id = c.sync_id
      LEFT JOIN (
        SELECT customer_sync_id, SUM(amount) AS total_paid
        FROM customer_payments
        WHERE deleted_at IS NULL AND customer_sync_id IS NOT NULL${payDateClause}
        GROUP BY customer_sync_id
      ) payments_agg ON payments_agg.customer_sync_id = c.sync_id
      WHERE c.deleted_at IS NULL AND c.tenant_id = ?
    `).get(...dateArgsOrders, ...dateArgsPay, tenantId);

    const customerCount = db.prepare(
      "SELECT COUNT(*) AS cnt FROM customers WHERE deleted_at IS NULL AND tenant_id = ?"
    ).get(tenantId);

    const owingCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM customers c
      INNER JOIN (
        SELECT customer_sync_id,
          SUM(total_amount)                 AS total_sold,
          SUM(CASE WHEN COALESCE(amount_received, 0) > total_amount
                   THEN total_amount
                   ELSE COALESCE(amount_received, 0) END) AS cash_at_sale
        FROM orders WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed') AND customer_sync_id IS NOT NULL${orderDateClause}
        GROUP BY customer_sync_id
      ) orders_agg ON orders_agg.customer_sync_id = c.sync_id
      LEFT JOIN (
        SELECT customer_sync_id, SUM(amount) AS total_paid
        FROM customer_payments WHERE deleted_at IS NULL AND customer_sync_id IS NOT NULL${payDateClause}
        GROUP BY customer_sync_id
      ) payments_agg ON payments_agg.customer_sync_id = c.sync_id
      WHERE c.deleted_at IS NULL AND c.tenant_id = ?
        AND orders_agg.total_sold - orders_agg.cash_at_sale - COALESCE(payments_agg.total_paid, 0) > 0.01
    `).get(...dateArgsOrders, ...dateArgsPay, tenantId);

    return {
      totalSales:    parseFloat(totals.total_sales),
      // Money actually in: cash collected at POS + later AR payments.
      totalReceived: parseFloat(totals.cash_at_sale) + parseFloat(totals.total_received),
      cashAtSale:    parseFloat(totals.cash_at_sale),
      arPaid:        parseFloat(totals.total_received),
      outstanding:   parseFloat(totals.outstanding),
      customers:     customerCount.cnt,
      owingCount:    owingCount.cnt,
    };
  }
}

router.get('/ar-stats', auth, readOnlyGuard, (req, res) => {
  try {
    res.json(computeArStats({ tenantId: req.user.tenantId, from: req.query.from, to: req.query.to }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── AR Aging Report — customers grouped by overdue buckets ───────────────────
// Buckets are based on order date + payment_terms_days (defaults 0 = due immediately).
router.get('/aging', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const customers = db.prepare(`
      SELECT c.*,
        COALESCE(orders_agg.total_sold, 0)       AS total_sold,
        COALESCE(orders_agg.cash_at_sale, 0)     AS cash_at_sale,
        COALESCE(payments_agg.total_paid, 0)     AS total_paid,
        COALESCE(orders_agg.total_sold, 0)
          - COALESCE(orders_agg.cash_at_sale, 0)
          - COALESCE(payments_agg.total_paid, 0) AS outstanding
      FROM customers c
      LEFT JOIN (
        SELECT customer_sync_id,
          SUM(total_amount)                 AS total_sold,
          SUM(CASE WHEN COALESCE(amount_received, 0) > total_amount
                   THEN total_amount
                   ELSE COALESCE(amount_received, 0) END) AS cash_at_sale
        FROM orders
        WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
          AND customer_sync_id IS NOT NULL
        GROUP BY customer_sync_id
      ) orders_agg ON orders_agg.customer_sync_id = c.sync_id
      LEFT JOIN (
        SELECT customer_sync_id, SUM(amount) AS total_paid
        FROM customer_payments
        WHERE deleted_at IS NULL AND customer_sync_id IS NOT NULL
        GROUP BY customer_sync_id
      ) payments_agg ON payments_agg.customer_sync_id = c.sync_id
      WHERE c.deleted_at IS NULL AND c.tenant_id = ?
        AND COALESCE(orders_agg.total_sold, 0)
          - COALESCE(orders_agg.cash_at_sale, 0)
          - COALESCE(payments_agg.total_paid, 0) > 0.01
      ORDER BY c.name
    `).all(tenantId);

    // For each customer, fetch unpaid order dates so we can age the outstanding amount FIFO.
    // Use the CREDIT portion of each order (total_amount − amount_received) since
    // that's what the customer actually owes per sale.
    const result = customers.map(c => {
      const orders = db.prepare(`
        SELECT id, total_amount, COALESCE(amount_received, 0) AS cash_at_sale, DATE(created_at) AS order_date
        FROM orders
        WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
          AND customer_sync_id = ?
        ORDER BY created_at ASC
      `).all(c.sync_id);
      let remaining = parseFloat(c.total_paid);
      const buckets = { current: 0, '1_30': 0, '31_60': 0, '61_90': 0, '90_plus': 0 };
      const today = new Date();
      const terms = parseInt(c.payment_terms_days || 0);
      for (const o of orders) {
        // Only the credit portion of this order is part of AR
        const creditPortion = Math.max(0, parseFloat(o.total_amount) - parseFloat(o.cash_at_sale));
        if (creditPortion <= 0.001) continue;
        if (remaining >= creditPortion) { remaining -= creditPortion; continue; }
        const unpaid = creditPortion - remaining;
        remaining = 0;
        const orderDate = new Date(o.order_date + 'T00:00:00');
        const dueDate = new Date(orderDate.getTime() + terms * 86400000);
        const daysOver = Math.floor((today - dueDate) / 86400000);
        if (daysOver < 0)       buckets.current   += unpaid;
        else if (daysOver <= 30) buckets['1_30']   += unpaid;
        else if (daysOver <= 60) buckets['31_60']  += unpaid;
        else if (daysOver <= 90) buckets['61_90']  += unpaid;
        else                     buckets['90_plus'] += unpaid;
      }
      return {
        id: c.id, name: c.name, type: c.type, phone: c.phone,
        credit_limit: c.credit_limit, payment_terms_days: c.payment_terms_days, credit_status: c.credit_status,
        total_sold: c.total_sold, total_paid: c.total_paid, outstanding: c.outstanding,
        ...buckets,
      };
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Customer insights — visit frequency, recency, avg basket, top products ──
router.get('/:id/insights', auth, readOnlyGuard, (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?').get(req.params.id, req.user.tenantId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const summary = db.prepare(`
      SELECT
        COUNT(*) AS order_count,
        COALESCE(SUM(total_amount), 0) AS total_revenue,
        COALESCE(AVG(total_amount), 0) AS avg_basket,
        MIN(DATE(created_at)) AS first_order_date,
        MAX(DATE(created_at)) AS last_order_date
      FROM orders
      WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
        AND customer_sync_id = ? AND tenant_id = ?
    `).get(customer.sync_id, req.user.tenantId);

    // Frequency = mean days between visits, computed from distinct order dates
    const orderDates = db.prepare(`
      SELECT DISTINCT DATE(created_at) AS d
      FROM orders
      WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
        AND customer_sync_id = ? AND tenant_id = ?
      ORDER BY d ASC
    `).all(customer.sync_id, req.user.tenantId).map(r => r.d);

    let avgGapDays = null;
    if (orderDates.length >= 2) {
      const gaps = [];
      for (let i = 1; i < orderDates.length; i++) {
        const a = new Date(orderDates[i - 1] + 'T00:00:00');
        const b = new Date(orderDates[i]     + 'T00:00:00');
        gaps.push(Math.round((b - a) / 86400000));
      }
      avgGapDays = Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length);
    }

    const today = new Date();
    const daysSinceLast = summary.last_order_date
      ? Math.floor((today - new Date(summary.last_order_date + 'T00:00:00')) / 86400000)
      : null;

    // Last 30 / 90 day windows
    const window = (days) => db.prepare(`
      SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS revenue
      FROM orders
      WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
        AND customer_sync_id = ? AND tenant_id = ?
        AND DATE(created_at) >= DATE('now', ?)
    `).get(customer.sync_id, req.user.tenantId, `-${days} days`);

    const last30 = window(30);
    const last90 = window(90);

    // Top 5 products by revenue
    const topProducts = db.prepare(`
      SELECT oi.product_name,
             SUM(oi.quantity)    AS qty,
             SUM(oi.total_price) AS revenue
      FROM order_items oi
      JOIN orders o ON o.sync_id = oi.order_sync_id
      WHERE o.deleted_at IS NULL AND (o.status IS NULL OR o.status != 'Reversed')
        AND o.customer_sync_id = ? AND o.tenant_id = ?
        AND oi.deleted_at IS NULL
      GROUP BY oi.product_name
      ORDER BY revenue DESC
      LIMIT 5
    `).all(customer.sync_id, req.user.tenantId);

    res.json({
      customer: { id: customer.id, name: customer.name, type: customer.type, phone: customer.phone },
      order_count: summary.order_count,
      total_revenue: parseFloat(summary.total_revenue),
      avg_basket: parseFloat(summary.avg_basket),
      first_order_date: summary.first_order_date,
      last_order_date: summary.last_order_date,
      days_since_last: daysSinceLast,
      avg_gap_days: avgGapDays,
      last_30_days: { count: last30.cnt, revenue: parseFloat(last30.revenue) },
      last_90_days: { count: last90.cnt, revenue: parseFloat(last90.revenue) },
      top_products: topProducts.map(p => ({
        product_name: p.product_name,
        qty: parseFloat(p.qty),
        revenue: parseFloat(p.revenue),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Customer statement — orders + payments + running balance for one customer
router.get('/:id/statement', auth, readOnlyGuard, (req, res) => {
  try {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?').get(req.params.id, req.user.tenantId);
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Every credit sale for this customer — full total goes on the statement so it can be
    // paired with both the POS-time cash payment and any later AR payment. Fully-paid sales
    // still appear (they net to zero after the synthetic POS payment cancels them out).
    const orders = db.prepare(`
      SELECT id, order_number,
             total_amount AS amount,
             total_amount, COALESCE(amount_received, 0) AS cash_at_sale,
             COALESCE(cash_received, 0)  AS cash_received,
             COALESCE(momo_received, 0)  AS momo_received,
             COALESCE(bank_received, 0)  AS bank_received,
             created_at AS date, 'order' AS type
      FROM orders
      WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
        AND customer_sync_id = ? AND tenant_id = ?
    `).all(customer.sync_id, req.user.tenantId);

    // 2026-09-07 — the opening balance, as its own line. Dated before every
    // order so the running balance starts from it rather than having it
    // appear halfway down. Not a sale: no order number, no items.
    const openingRows = (parseFloat(customer.opening_balance) || 0) !== 0 ? [{
      id: 0,
      order_number: null,
      amount: parseFloat(customer.opening_balance) || 0,
      total_amount: parseFloat(customer.opening_balance) || 0,
      cash_at_sale: 0, cash_received: 0, momo_received: 0, bank_received: 0,
      date: '1970-01-01 00:00:00',
      type: 'opening',
    }] : [];

    // Manual AR payments (from the Pay modal).
    // 2026-09-10 — with the cash receipt's number, so the statement can show
    // it as the document number the way an AP statement shows its APR-.
    const arPayments = db.prepare(`
      SELECT cp.id, NULL AS order_number, -cp.amount AS amount, cp.payment_date AS date, 'payment' AS type,
             cp.payment_method, cp.reference, cp.notes, 'manual' AS source,
             (SELECT cr.receipt_number FROM cash_receipts cr
               WHERE cr.sync_id = cp.cash_receipt_sync_id AND cr.deleted_at IS NULL
               LIMIT 1) AS receipt_number
      FROM customer_payments cp
      WHERE cp.deleted_at IS NULL AND cp.customer_sync_id = ?
    `).all(customer.sync_id);

    // POS-time cash collected during a credit sale — synthesize a payment per order so the
    // breakdown shows what the customer paid at the till, not just what they still owe.
    // Amount is capped at the sale total (over-tender came back as change).
    const posPayments = orders
      .filter(o => parseFloat(o.cash_at_sale) > 0.001)
      .map(o => {
        const methods = ['cash_received', 'momo_received', 'bank_received'].filter(k => parseFloat(o[k]) > 0);
        const method = methods.length > 1 ? 'Mixed'
          : methods[0] === 'cash_received' ? 'Cash'
          : methods[0] === 'momo_received' ? 'Mobile Money'
          : methods[0] === 'bank_received' ? 'Bank Transfer'
          : 'Cash';
        const cappedAmount = Math.min(parseFloat(o.cash_at_sale), parseFloat(o.total_amount));
        return {
          id: -o.id,
          order_id: o.id,                             // for "click to view order" in the frontend
          order_number: null,
          amount: -cappedAmount,                      // negative because payments offset orders
          date: (o.date || '').slice(0, 10),
          type: 'payment',
          payment_method: method,
          reference: o.order_number,
          notes: 'Paid at sale',
          // Per-method breakdown so the modal can show "Cash $30 · MoMo $20" instead of just "Mixed"
          cash_amount: parseFloat(o.cash_received || 0),
          bank_amount: parseFloat(o.bank_received || 0),
          momo_amount: parseFloat(o.momo_received || 0),
          source: 'pos',
        };
      });

    // Strip the helper columns from orders before sending (used above to derive POS payments).
    // eslint-disable-next-line no-unused-vars
    const ordersClean = orders.map(({ cash_received, momo_received, bank_received, ...rest }) => rest);

    const combined = [...openingRows, ...ordersClean, ...arPayments, ...posPayments]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    let running = 0;
    combined.forEach(row => { running += parseFloat(row.amount); row.running_balance = running; });

    res.json({ customer, entries: combined, outstanding: running });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', auth, (req, res) => {
  try {
    const { name, type, phone, email, address, tpin, credit_limit, payment_terms_days, credit_status } = req.body;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const info = db.prepare(
      `INSERT INTO customers (name, type, phone, email, address, tpin, credit_limit, payment_terms_days, credit_status, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))`
    ).run(
      name, type || 'Regular', phone, email, address,
      (tpin || '').trim() || null,
      parseFloat(credit_limit || 0),
      parseInt(payment_terms_days || 0),
      credit_status || 'Active',
      randomUUID(), tenantId, branchId, deviceId
    );
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
    fireZraCustomerSync(tenantId, info.lastInsertRowid, req.user?.email || 'system');
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', auth, (req, res) => {
  try {
    const { name, type, phone, email, address, tpin, credit_limit, payment_terms_days, credit_status } = req.body;
    db.prepare(
      `UPDATE customers SET name=?, type=?, phone=?, email=?, address=?, tpin=?,
       credit_limit=?, payment_terms_days=?, credit_status=?,
       updated_at=datetime('now'), synced=0 WHERE id=?`
    ).run(
      name, type, phone, email, address,
      (tpin || '').trim() || null,
      parseFloat(credit_limit || 0),
      parseInt(payment_terms_days || 0),
      credit_status || 'Active',
      req.params.id
    );
    const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    fireZraCustomerSync(req.user.tenantId, req.params.id, req.user?.email || 'system');
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete customer — blocked if active (non-reversed) orders link to it.
// Reversed orders don't block (they're voided). Payment records can be cascaded
// with ?cascade=payments to soft-delete them alongside the customer.
router.delete('/:id', auth, (req, res) => {
  try {
    const c = db.prepare('SELECT name, sync_id FROM customers WHERE id = ?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Customer not found' });

    // Count only ACTIVE (non-reversed) orders — reversed orders are voided business records.
    const activeOrders = db.prepare(
      "SELECT COUNT(*) AS c FROM orders WHERE customer_sync_id = ? AND deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')"
    ).get(c.sync_id);
    const payments = db.prepare(
      "SELECT COUNT(*) AS c FROM customer_payments WHERE customer_sync_id = ? AND deleted_at IS NULL"
    ).get(c.sync_id);

    if (activeOrders.c > 0) {
      return res.status(400).json({
        error: `Cannot delete "${c.name}" — has ${activeOrders.c} active sales order(s). Reverse them first or mark the customer inactive.`,
        active_orders: activeOrders.c,
      });
    }

    if (payments.c > 0 && req.query.cascade !== 'payments') {
      return res.status(400).json({
        error: `"${c.name}" has ${payments.c} payment record(s). Confirm to delete the customer AND those payment records.`,
        needs_cascade: true,
        payment_count: payments.c,
      });
    }

    db.transaction(() => {
      if (payments.c > 0) {
        db.prepare(
          "UPDATE customer_payments SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE customer_sync_id = ? AND deleted_at IS NULL"
        ).run(c.sync_id);
      }
      db.prepare("UPDATE customers SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?").run(req.params.id);
    })();

    res.json({ message: 'Customer deleted', cascaded_payments: payments.c });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Orphan orders: orders whose customer_name matches this customer but whose
// customer_sync_id is NULL (legacy or ambiguous duplicates). Returns count + total.
router.get('/:id/orphan-orders', auth, readOnlyGuard, (req, res) => {
  try {
    const c = db.prepare('SELECT id, name, sync_id FROM customers WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?')
      .get(req.params.id, req.user.tenantId);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const stats = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total
      FROM orders
      WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
        AND tenant_id = ? AND customer_sync_id IS NULL
        AND LOWER(customer_name) = LOWER(?)
    `).get(req.user.tenantId, c.name);
    res.json({
      customer: { id: c.id, name: c.name, sync_id: c.sync_id },
      orphan_count: stats.count,
      orphan_total: parseFloat(stats.total),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Claim orphan orders: link any unassigned orders matching this customer's name
// to this specific customer. Used to resolve duplicate-name situations.
router.post('/:id/claim-orphan-orders', auth, (req, res) => {
  try {
    const c = db.prepare('SELECT id, name, sync_id FROM customers WHERE id = ? AND deleted_at IS NULL AND tenant_id = ?')
      .get(req.params.id, req.user.tenantId);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    const info = db.prepare(`
      UPDATE orders
      SET customer_id = ?, customer_sync_id = ?, synced = 0, updated_at = datetime('now')
      WHERE deleted_at IS NULL
        AND tenant_id = ? AND customer_sync_id IS NULL
        AND LOWER(customer_name) = LOWER(?)
    `).run(c.id, c.sync_id, req.user.tenantId, c.name);
    res.json({ claimed: info.changes, customer: { id: c.id, name: c.name } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.computeArStats = computeArStats;
module.exports = router;
