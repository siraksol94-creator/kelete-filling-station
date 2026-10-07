const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { getHostSlug } = require('../middleware/hqPush');
// 2026-09-11 â€” Cash Report â†’ PENDING deposits to HQ (per-depot switch).
const autoDeposit = require('../services/autoDeposit');
// v1.8.67 â€” HQ Deposit math removed from Cash Report (per user: in real
// operations the cashier hands cash to the manager, who later sends to
// HQ â€” so the deposit never affects the till count). The deposit still
// flows through Cash Book (where it belongs at the accounting level).

// Get all cash reports
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { cashier_id } = req.query;
    let query = `SELECT cr.*, u.first_name || ' ' || u.last_name AS created_by_name,
       CASE WHEN cr.cashier_id = 0 THEN 'All' ELSE cu.first_name || ' ' || cu.last_name END AS cashier_name
       FROM cash_reports cr
       LEFT JOIN users u ON cr.created_by = u.id
       LEFT JOIN users cu ON cr.cashier_id = cu.id
       WHERE cr.deleted_at IS NULL AND cr.tenant_id = ?`;
    const params = [req.user.tenantId];
    if (cashier_id !== undefined && cashier_id !== 'all') {
      query += ' AND cr.cashier_id = ?';
      params.push(parseInt(cashier_id));
    }
    query += ' ORDER BY cr.date DESC';
    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get distinct cashiers that have submitted cash reports (for filter dropdown)
router.get('/users', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT DISTINCT cr.cashier_id,
        CASE WHEN cr.cashier_id = 0 THEN 'All' ELSE u.first_name || ' ' || u.last_name END AS full_name
       FROM cash_reports cr
       LEFT JOIN users u ON cr.cashier_id = u.id
       WHERE cr.deleted_at IS NULL AND cr.tenant_id = ?
       ORDER BY cr.cashier_id`
    ).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get distinct users who made sales (optionally filtered by date)
router.get('/sales-cashiers', auth, readOnlyGuard, (req, res) => {
  try {
    // v1.10.43 â€” accept from_utc / to_utc same as /daily. orders.created_at
    // is stored in UTC; a naive DATE() match drops any sale rung up between
    // local midnight and UTC midnight (e.g. Lusaka +2 â†’ a 12:47 AM local
    // sale on Jul 2 is 22:47 UTC Jul 1, so a caller asking "who sold on
    // Jul 2?" with date=2026-07-02 saw an empty list). The frontend already
    // has the UTC bounds for the /daily call; just plumb them through.
    const { date, from, to, from_utc, to_utc } = req.query;
    let query = `SELECT DISTINCT o.created_by AS id, u.first_name, u.last_name
       FROM orders o
       JOIN users u ON o.created_by = u.id
       WHERE o.deleted_at IS NULL AND o.tenant_id = ?
         AND (o.status IS NULL OR o.status != 'Reversed')`;
    const params = [req.user.tenantId];
    if (from_utc && to_utc) {
      query += ' AND o.created_at >= ? AND o.created_at <= ?';
      params.push(from_utc, to_utc);
    } else {
      if (date) { query += ' AND DATE(o.created_at) = ?';  params.push(date); }
      if (from) { query += ' AND DATE(o.created_at) >= ?'; params.push(from); }
      if (to)   { query += ' AND DATE(o.created_at) <= ?'; params.push(to); }
    }
    query += ' ORDER BY u.first_name';
    const rows = db.prepare(query).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get report for a specific date (auto-populate from sales data)
// cashier_id=0 or missing = all cashiers combined; cashier_id=N = filter by that user
// from_utc / to_utc: optional SQLite-format UTC datetime range corresponding to the
// LOCAL day. Sent by the frontend so orders.created_at (UTC) gets bucketed to the
// cashier's local day, not the UTC day. Falls back to DATE() match if absent.
router.get('/daily', auth, readOnlyGuard, (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const cashierId = req.query.cashier_id ? parseInt(req.query.cashier_id) : 0;
    const tenantId = req.user.tenantId;
    const fromUtc = req.query.from_utc;
    const toUtc   = req.query.to_utc;

    // Build the order-date predicate + parameter list
    const useRange = !!(fromUtc && toUtc);
    const orderDateClause = useRange
      ? 'created_at >= ? AND created_at <= ?'
      : 'DATE(created_at) = ?';
    const orderDateParams = useRange ? [fromUtc, toUtc] : [date];

    const userFilter = cashierId > 0 ? ' AND created_by = ?' : '';
    const baseParams = cashierId > 0 ? [...orderDateParams, tenantId, cashierId] : [...orderDateParams, tenantId];

    // v1.8.1 â€” Kelete is cash-only across 3 currencies (USD / FRA / K).
    // Each bucket is NET of change given out in that same currency.
    //   USD = cash_received - usd_change_given (v1.8.68: was change_amount,
    //         which mixed currencies and made FRA-overpaid orders show a
    //         phantom USD surplus. usd_change_given holds ONLY physical USD
    //         the cashier handed back.)
    //   FRA = fra_received  - fra_change_given
    //   K   = k_received    - k_change_given
    // No more cash/momo/bank split â€” those columns are legacy and kept at 0.
    const sumOrders = (col) => db.prepare(
      `SELECT COALESCE(SUM(${col}), 0) AS total
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')${userFilter}`
    ).get(...baseParams).total;
    // v1.8.67 â€” Pure POS net. Deposits don't touch the till in Kelete's
    // operational model (cashier â†’ manager â†’ HQ).
    const usdNet = parseFloat(sumOrders('cash_received')) - parseFloat(sumOrders('usd_change_given'));
    const fraNet = parseFloat(sumOrders('fra_received'))  - parseFloat(sumOrders('fra_change_given'));
    const kNet   = parseFloat(sumOrders('k_received'))    - parseFloat(sumOrders('k_change_given'));

    // v1.9.30 â€” Liquor-style branches (Mansa / Lusaka) collect K via three
    // methods (Cash / MoMo / Bank). The single-screen Pay modal writes the
    // amounts into cash_received / momo_received / bank_received. Cash
    // Report needs these summed per method so each counter card has the
    // right Expected value. On Kelete branches these columns are 0 (the
    // walk-in modal isn't used), so the sums are 0 â€” harmless.
    //
    // v1.10.101 â€” subtract change_amount from Cash bucket (mirrors the
    // reference Liquor project's cashReport.js:105). When a Liquor customer
    // overpays via MoMo/Bank, the cashier hands back Cash change from the
    // drawer â€” so the till's Cash bucket must be NET of the change dispensed.
    // Without this, Expected Cash inflates by the over-collection amount
    // (K2,330 gap on 2026-07-04 Lusaka1). MoMo/Bank don't need subtraction
    // because change never comes back through those methods on Liquor.
    // Kassumbalesa (tri-currency) is unaffected â€” its UI reads usdNet/fraNet/
    // kNet (lines 123-125) which already subtract per-currency change_given.
    const cashNet = parseFloat(sumOrders('cash_received')) - parseFloat(sumOrders('change_amount'));
    const momoNet = parseFloat(sumOrders('momo_received'));
    const bankNet = parseFloat(sumOrders('bank_received'));

    // v1.8.68 â€” over-collections breakdown. When customer overpays and cashier
    // keeps the surplus, the over-payment lives in the drawer of the currency
    // it was paid in. Reported here so it's visible without polluting any
    // drawer's Diff line.
    const overpaidByCcy = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN overpaid_kept_ccy = 'USD' THEN overpaid_kept_amt ELSE 0 END), 0) AS usd,
         COALESCE(SUM(CASE WHEN overpaid_kept_ccy = 'FRA' THEN overpaid_kept_amt ELSE 0 END), 0) AS fra,
         COALESCE(SUM(CASE WHEN overpaid_kept_ccy = 'K'   THEN overpaid_kept_amt ELSE 0 END), 0) AS k
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')${userFilter}`
    ).get(...baseParams);

    // v1.8.76 â€” under-payments (silently absorbed). Walk-in shortages within
    // the $0.10 tolerance keep payment_method='Cash' but have total > received.
    // These represent silent shop LOSS.
    // v1.8.77 â€” attribute the shortfall to its SOURCE currency (same priority
    // chain as over-payments: USD pays first, FRA next, K last â†’ shortage lives
    // in the LAST currency the customer used). So if customer paid USD + FRA
    // and was short, the shortage is in FRA, not USD-equivalent.
    const underRowsRaw = db.prepare(
      `SELECT total_amount, amount_received, cash_received, fra_received, k_received,
              selling_rate_used, selling_rate_k_used
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')
       AND total_amount > amount_received
       AND payment_method = 'Cash'${userFilter}`
    ).all(...baseParams);
    let underpaidUSD = 0, underpaidFRA = 0, underpaidK = 0;
    for (const r of underRowsRaw) {
      const shortUSD = parseFloat(r.total_amount) - parseFloat(r.amount_received);
      if (shortUSD < 0.005) continue;
      const paidFRA = parseFloat(r.fra_received || 0) || 0;
      const paidK   = parseFloat(r.k_received   || 0) || 0;
      const sellR   = parseFloat(r.selling_rate_used   || 0) || 0;
      const sellRK  = parseFloat(r.selling_rate_k_used || 0) || 0;
      // Source-currency attribution: shortage in the LAST currency used
      // (highest in priority chain USD â†’ FRA â†’ K).
      if (paidK > 0 && sellRK > 0) {
        underpaidK += shortUSD * sellRK;
      } else if (paidFRA > 0 && sellR > 0) {
        underpaidFRA += shortUSD * sellR;
      } else {
        underpaidUSD += shortUSD;
      }
    }

    // v1.8.81 â€” Category 3: cashier OVER-CHANGED (gave back more than owed).
    // Real shop loss. Detected by: total USD-equivalent of change actually
    // returned > change_amount (USD-equivalent of change owed).
    // FRA / K change conversion uses BUY rate (matches the front-end formula
    // and the v1.8.78 backend fix).
    const overChangeRows = db.prepare(
      `SELECT total_amount, change_amount, usd_change_given,
              cash_received, fra_received, fra_change_given,
              k_received, k_change_given,
              selling_rate_used, buying_rate_used,
              selling_rate_k_used, buying_rate_k_used
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')${userFilter}`
    ).all(...baseParams);
    for (const r of overChangeRows) {
      const changeOwedUSD = parseFloat(r.change_amount || 0) || 0;
      if (changeOwedUSD < 0.005) continue;
      const usdGiven = parseFloat(r.usd_change_given || 0) || 0;
      const fraGiven = parseFloat(r.fra_change_given || 0) || 0;
      const kGiven   = parseFloat(r.k_change_given   || 0) || 0;
      const buyR     = parseFloat(r.buying_rate_used   || 0) || 0;
      const buyRK    = parseFloat(r.buying_rate_k_used || 0) || 0;
      const usdEqGiven = usdGiven
                       + (buyR  > 0 ? fraGiven / buyR  : 0)
                       + (buyRK > 0 ? kGiven   / buyRK : 0);
      const overUSD = usdEqGiven - changeOwedUSD;
      if (overUSD < 0.005) continue;
      // Source currency of the overshoot: whichever foreign currency was
      // returned in MORE than its share. Compute the "owed" portion per
      // currency by walking USD-first â†’ FRA â†’ K consumption of changeOwedUSD.
      let rem = changeOwedUSD;
      const usdConsumed = Math.min(usdGiven, rem); rem -= usdConsumed;
      let fraOver = 0;
      if (buyR > 0 && fraGiven > 0) {
        const fraOwedFRA = rem > 0 ? rem * buyR : 0;
        fraOver = Math.max(0, fraGiven - fraOwedFRA);
        rem -= Math.min(fraGiven / buyR, rem);
      }
      let kOver = 0;
      if (buyRK > 0 && kGiven > 0) {
        const kOwedK = rem > 0 ? rem * buyRK : 0;
        kOver = Math.max(0, kGiven - kOwedK);
      }
      const usdOver = Math.max(0, usdGiven - usdConsumed);
      // Attribute the overshoot to whichever currency has the biggest excess
      // (in USD-equivalent), so a $0.04 over-given in FRA = FRA 100 stored
      // natively, not USD-attributed.
      const usdOverAsUSD = usdOver;
      const fraOverAsUSD = buyR  > 0 ? fraOver / buyR  : 0;
      const kOverAsUSD   = buyRK > 0 ? kOver   / buyRK : 0;
      if (fraOverAsUSD >= kOverAsUSD && fraOverAsUSD >= usdOverAsUSD && fraOver > 0.5) {
        underpaidFRA += fraOver;
      } else if (kOverAsUSD >= usdOverAsUSD && kOver > 0.5) {
        underpaidK += kOver;
      } else if (usdOver > 0.005) {
        underpaidUSD += usdOver;
      } else if (fraOver > 0.5) {
        underpaidFRA += fraOver;
      } else if (kOver > 0.5) {
        underpaidK += kOver;
      }
    }

    // CREDIT SALES ISSUED bucket = today's new receivables (unpaid portion of today's sales).
    // This is informational â€” represents money owed, NOT cash received.
    // v1.8.76 â€” only count rows whose payment_method is actually Credit or
    // Partial-Credit. Walk-in shortages within the $0.10 tolerance still have
    // total_amount > amount_received but payment_method='Cash' (no customer to
    // bill) â€” those should NOT bleed into the Credit Sales bucket.
    const creditSales = db.prepare(
      `SELECT COALESCE(SUM(total_amount - amount_received), 0) AS total
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')
       AND total_amount > amount_received
       AND payment_method IN ('Credit', 'Partial-Credit')${userFilter}`
    ).get(...baseParams);

    // PENDING bucket retained for "other" / unrecognised payment methods.
    const pendingSales = db.prepare(
      `SELECT COALESCE(SUM(amount_received), 0) AS total
       FROM orders WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')
       AND payment_method NOT IN ('Cash', 'Transfer', 'Mobile Money', 'Credit', 'Partial-Credit')${userFilter}`
    ).get(...baseParams);

    // v1.8.85 â€” match the orders pattern: cashier_id=0 means "all cashiers"
    // (no filter), not "PVs tagged to cashier 0 only". Without this, the top
    // KPI bar's Total cash in undercounts by the PV total (e.g. shows 500K
    // instead of 550K when 50K in expenses exist).
    // 2026-09-21 â€” the spelling is ignored. A voucher raised on the Payment
    // Voucher page saves "Cash drawer"; one raised from this screen saves
    // "Cash Drawer". A case-sensitive `=` silently dropped every one of the
    // former, which is how a K5,000 expense showed as K0.00.
    //
    // The cashier filter is deliberately NOT relaxed. An untagged voucher
    // briefly counted for whoever was selected, to rescue an expense that had
    // lost its cashier on the way back from HQ approval â€” but that loss is
    // fixed at its source now (the voucher keeps the cashier it was raised
    // with), and the rule pulled PV-page expenses into a cashier's
    // reconciliation where they do not belong.
    const expensesCashierClause = cashierId > 0 ? ' AND cashier_id = ?' : '';
    const expensesParams = cashierId > 0 ? [tenantId, date, cashierId] : [tenantId, date];
    const DRAWER = "LOWER(TRIM(paid_from)) = 'cash drawer'";
    const expenses = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM payment_vouchers
       WHERE deleted_at IS NULL AND tenant_id = ? AND date = ? AND ${DRAWER}${expensesCashierClause}`
    ).get(...expensesParams);
    // v1.8.14 + v1.8.17 â€” per-currency expenses. A PV recorded in FRA
    // reduces FRA drawer (not USD). Prefer the new usd_amount column when
    // set, else fall back to the legacy cash_amount (per row â€” adding the
    // two columns together double-counts the rows where both got populated
    // during the v1.8.5 transition).
    const expensesByCcy = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN COALESCE(usd_amount, 0) > 0 THEN usd_amount ELSE COALESCE(cash_amount, 0) END), 0) AS usd,
         COALESCE(SUM(CASE WHEN COALESCE(fra_amount, 0) > 0 THEN fra_amount ELSE COALESCE(bank_amount, 0) END), 0) AS fra,
         COALESCE(SUM(CASE WHEN COALESCE(k_amount,   0) > 0 THEN k_amount   ELSE COALESCE(momo_amount, 0) END), 0) AS k
       FROM payment_vouchers
       WHERE deleted_at IS NULL AND tenant_id = ? AND date = ? AND ${DRAWER}${expensesCashierClause}`
    ).get(...expensesParams);

    const totalRevenue = db.prepare(
      `SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders
       WHERE ${orderDateClause} AND deleted_at IS NULL AND tenant_id = ?
       AND (status IS NULL OR status != 'Reversed')${userFilter}`
    ).get(...baseParams);

    res.json({
      date,
      // v1.8.1 â€” triple-currency. Each is NET (received minus change) in
      // that currency's own units. UI shows them as three separate rows.
      usd_received: usdNet,
      fra_received: fraNet,
      k_received:   kNet,
      // v1.9.30 â€” method-axis rollups for Liquor-style branches.
      cash_net: cashNet,
      momo_net: momoNet,
      bank_net: bankNet,
      // v1.8.14 â€” per-currency expenses paid from cash drawer.
      usd_expenses: parseFloat(expensesByCcy.usd) || 0,
      fra_expenses: parseFloat(expensesByCcy.fra) || 0,
      k_expenses:   parseFloat(expensesByCcy.k)   || 0,
      // v1.8.68 â€” over-collections kept by cashier (per source currency).
      usd_overpaid_kept: parseFloat(overpaidByCcy.usd) || 0,
      fra_overpaid_kept: parseFloat(overpaidByCcy.fra) || 0,
      k_overpaid_kept:   parseFloat(overpaidByCcy.k)   || 0,
      // v1.8.76 â€” under-payments silently absorbed (walk-in tolerance shortages).
      // v1.8.77 â€” per-currency attribution (source-currency, same as over-payments).
      usd_underpaid:     parseFloat(underpaidUSD) || 0,
      fra_underpaid:     parseFloat(underpaidFRA) || 0,
      k_underpaid:       parseFloat(underpaidK)   || 0,
      pending: parseFloat(pendingSales.total),
      credit_sales: parseFloat(creditSales.total),
      expenses: parseFloat(expenses.total),
      total_revenue: parseFloat(totalRevenue.total),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.8.68 â€” per-order over-collections for the day. Returns one row per
// order where the cashier kept an over-payment in the drawer (overpaid_kept_amt > 0).
// v1.8.76 â€” also returns under-payment rows (walk-in shortages within tolerance).
// Each row tagged with `direction`: 'OVER' (kept by cashier) or 'UNDER' (absorbed by shop).
router.get('/overpaid', auth, readOnlyGuard, (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const cashierId = req.query.cashier_id ? parseInt(req.query.cashier_id) : 0;
    const fromUtc = req.query.from_utc;
    const toUtc   = req.query.to_utc;
    const useRange = !!(fromUtc && toUtc);
    const dateClause = useRange
      ? 'o.created_at >= ? AND o.created_at <= ?'
      : 'DATE(o.created_at) = ?';
    const dateParams = useRange ? [fromUtc, toUtc] : [date];
    const userFilter = cashierId > 0 ? ' AND o.created_by = ?' : '';
    const params = cashierId > 0
      ? [...dateParams, req.user.tenantId, cashierId]
      : [...dateParams, req.user.tenantId];

    // Over-payments kept in drawer
    const overRows = db.prepare(
      `SELECT o.id, o.order_number, o.customer_name, o.total_amount,
              'OVER' AS direction,
              o.overpaid_kept_ccy AS ccy, o.overpaid_kept_amt AS amt,
              o.selling_rate_used, o.selling_rate_k_used,
              o.created_at,
              u.first_name || ' ' || u.last_name AS cashier_name
         FROM orders o
         LEFT JOIN users u ON o.created_by = u.id
        WHERE ${dateClause} AND o.deleted_at IS NULL AND o.tenant_id = ?
          AND (o.status IS NULL OR o.status != 'Reversed')
          AND COALESCE(o.overpaid_kept_amt, 0) > 0
          ${userFilter}`
    ).all(...params);

    // Under-payments silently absorbed (walk-in tolerance shortages)
    // v1.8.77 â€” attribute shortage to source currency (last currency used).
    const underRowsRawDetail = db.prepare(
      `SELECT o.id, o.order_number, o.customer_name, o.total_amount, o.amount_received,
              o.cash_received, o.fra_received, o.k_received,
              o.selling_rate_used, o.selling_rate_k_used,
              o.created_at,
              u.first_name || ' ' || u.last_name AS cashier_name
         FROM orders o
         LEFT JOIN users u ON o.created_by = u.id
        WHERE ${dateClause} AND o.deleted_at IS NULL AND o.tenant_id = ?
          AND (o.status IS NULL OR o.status != 'Reversed')
          AND o.total_amount > o.amount_received
          AND o.payment_method = 'Cash'
          ${userFilter}`
    ).all(...params);
    const underRows = underRowsRawDetail.map(r => {
      const shortUSD = parseFloat(r.total_amount) - parseFloat(r.amount_received);
      const paidFRA = parseFloat(r.fra_received || 0) || 0;
      const paidK   = parseFloat(r.k_received   || 0) || 0;
      const sellR   = parseFloat(r.selling_rate_used   || 0) || 0;
      const sellRK  = parseFloat(r.selling_rate_k_used || 0) || 0;
      let ccy = 'USD', amt = shortUSD;
      if (paidK > 0 && sellRK > 0)        { ccy = 'K';   amt = shortUSD * sellRK; }
      else if (paidFRA > 0 && sellR > 0)  { ccy = 'FRA'; amt = shortUSD * sellR; }
      return {
        id: r.id, order_number: r.order_number, customer_name: r.customer_name,
        total_amount: r.total_amount, direction: 'UNDER', ccy, amt,
        selling_rate_used: r.selling_rate_used, selling_rate_k_used: r.selling_rate_k_used,
        created_at: r.created_at, cashier_name: r.cashier_name,
      };
    });

    // v1.8.81 â€” Category 3: cashier over-changed rows. Same shop-loss bucket
    // as under-payments but caught by a different formula: USD-equivalent of
    // change RETURNED > change OWED. Tag direction='UNDER' so frontend shows
    // them with the â†“ arrow alongside customer under-payments.
    const overChangeRowsDetail = db.prepare(
      `SELECT o.id, o.order_number, o.customer_name, o.total_amount,
              o.change_amount, o.usd_change_given,
              o.fra_change_given, o.k_change_given,
              o.buying_rate_used, o.buying_rate_k_used,
              o.selling_rate_used, o.selling_rate_k_used,
              o.created_at,
              u.first_name || ' ' || u.last_name AS cashier_name
         FROM orders o
         LEFT JOIN users u ON o.created_by = u.id
        WHERE ${dateClause} AND o.deleted_at IS NULL AND o.tenant_id = ?
          AND (o.status IS NULL OR o.status != 'Reversed')
          ${userFilter}`
    ).all(...params);
    const overChangeMappedRows = overChangeRowsDetail.map(r => {
      const changeOwedUSD = parseFloat(r.change_amount || 0) || 0;
      if (changeOwedUSD < 0.005) return null;
      const usdGiven = parseFloat(r.usd_change_given || 0) || 0;
      const fraGiven = parseFloat(r.fra_change_given || 0) || 0;
      const kGiven   = parseFloat(r.k_change_given   || 0) || 0;
      const buyR     = parseFloat(r.buying_rate_used   || 0) || 0;
      const buyRK    = parseFloat(r.buying_rate_k_used || 0) || 0;
      const usdEqGiven = usdGiven
                       + (buyR  > 0 ? fraGiven / buyR  : 0)
                       + (buyRK > 0 ? kGiven   / buyRK : 0);
      const overUSD = usdEqGiven - changeOwedUSD;
      if (overUSD < 0.005) return null;
      // Source-currency attribution (USD-first â†’ FRA â†’ K consumption).
      let rem = changeOwedUSD;
      const usdConsumed = Math.min(usdGiven, rem); rem -= usdConsumed;
      let fraOver = 0;
      if (buyR > 0 && fraGiven > 0) {
        const fraOwedFRA = rem > 0 ? rem * buyR : 0;
        fraOver = Math.max(0, fraGiven - fraOwedFRA);
        rem -= Math.min(fraGiven / buyR, rem);
      }
      let kOver = 0;
      if (buyRK > 0 && kGiven > 0) {
        const kOwedK = rem > 0 ? rem * buyRK : 0;
        kOver = Math.max(0, kGiven - kOwedK);
      }
      const usdOver = Math.max(0, usdGiven - usdConsumed);
      let ccy = 'USD', amt = overUSD;
      const fraOverAsUSD = buyR  > 0 ? fraOver / buyR  : 0;
      const kOverAsUSD   = buyRK > 0 ? kOver   / buyRK : 0;
      if (fraOverAsUSD >= kOverAsUSD && fraOverAsUSD >= usdOver && fraOver > 0.5) {
        ccy = 'FRA'; amt = fraOver;
      } else if (kOverAsUSD >= usdOver && kOver > 0.5) {
        ccy = 'K'; amt = kOver;
      } else if (usdOver > 0.005) {
        ccy = 'USD'; amt = usdOver;
      }
      return {
        id: r.id, order_number: r.order_number, customer_name: r.customer_name,
        total_amount: r.total_amount, direction: 'UNDER', ccy, amt,
        selling_rate_used: r.selling_rate_used, selling_rate_k_used: r.selling_rate_k_used,
        created_at: r.created_at, cashier_name: r.cashier_name,
      };
    }).filter(Boolean);

    const rows = [...overRows, ...underRows, ...overChangeMappedRows].sort((a, b) =>
      (b.created_at || '').localeCompare(a.created_at || ''));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create / save cash report
router.post('/', auth, (req, res) => {
  try {
    // v1.8.1 â€” accept triple-currency fields. Legacy cash/mobile_money/bank
    // still accepted for backwards compatibility (ignored if usd/fra/k sent).
    // v1.8.13 â€” also accept per-currency Expected snapshots.
    const { date, initial_change, expenses, pending, total,
            after_change, expected, difference, status, comment, cashier_id,
            usd_received, fra_received, k_received,
            usd_expected, fra_expected, k_expected,
            usd_expenses, fra_expenses, k_expenses,
            mobile_money, cash, bank } = req.body;
    const usdAmt = parseFloat(usd_received ?? cash ?? 0);
    const fraAmt = parseFloat(fra_received ?? mobile_money ?? 0);
    const kAmt   = parseFloat(k_received   ?? bank ?? 0);
    // v1.10.32 â€” persist per-method counted amounts (Cash / MoMo / Bank) on
    // Liquor-style branches. Was always zeroed, which made CashReport's
    // "ALL CASHIERS" top bar show Short Kâˆ’<expected> even after a cashier
    // saved. Frontend sends these explicitly on Liquor. Kelete branches keep
    // them at 0 (no method concept there).
    const cashAmt = parseFloat(cash         ?? 0) || 0;
    const momoAmt = parseFloat(mobile_money ?? 0) || 0;
    const bankAmt = parseFloat(bank         ?? 0) || 0;
    const usdExp = parseFloat(usd_expected ?? 0) || 0;
    const fraExp = parseFloat(fra_expected ?? 0) || 0;
    const kExp   = parseFloat(k_expected   ?? 0) || 0;
    // v1.8.26 â€” snapshot per-currency expenses paid out of each drawer.
    const usdExpense = parseFloat(usd_expenses ?? 0) || 0;
    const fraExpense = parseFloat(fra_expenses ?? 0) || 0;
    const kExpense   = parseFloat(k_expenses   ?? 0) || 0;

    const cashierId = cashier_id !== undefined ? parseInt(cashier_id) : 0; // 0 = All
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();

    // v1.10.16 â€” include soft-deleted rows in the existence check. The
    // UNIQUE index on (date, cashier_id) doesn't know about deleted_at, so
    // if v1.10.9's admin delete has marked an earlier row deleted_at=<ts>,
    // an INSERT for the same (date, cashier_id) still fails. Reuse the row:
    // clear its deleted_at and rewrite the values.
    const existing = db.prepare(
      'SELECT id, deleted_at, sync_id FROM cash_reports WHERE date = ? AND cashier_id = ?'
    ).get(date, cashierId);
    // 2026-09-11 â€” once HQ has confirmed this report's auto deposit, the
    // report is locked: HQ has balanced against those figures.
    if (existing && !existing.deleted_at) {
      const blocked = autoDeposit.blockIfConfirmed(existing.sync_id);
      if (blocked) return res.status(409).json({ error: blocked });
    }
    let row;

    if (existing) {
      db.prepare(
        `UPDATE cash_reports SET
          initial_change=?, usd_received=?, fra_received=?, k_received=?,
          usd_expected=?, fra_expected=?, k_expected=?,
          usd_expenses=?, fra_expenses=?, k_expenses=?,
          mobile_money=?, cash=?, bank=?,
          expenses=?, pending=?, total=?,
          after_change=?, expected=?, difference=?, status=?, comment=?,
          cashier_id=?, deleted_at=NULL, updated_at=datetime('now'), synced=0
         WHERE id = ?`
      ).run(initial_change, usdAmt, fraAmt, kAmt,
             usdExp, fraExp, kExp,
             usdExpense, fraExpense, kExpense,
             momoAmt, cashAmt, bankAmt,
             expenses, pending, total,
             after_change, expected, difference, status, comment,
             cashierId, existing.id);
      row = db.prepare('SELECT * FROM cash_reports WHERE id = ?').get(existing.id);
    } else {
      const info = db.prepare(
        `INSERT INTO cash_reports (date, initial_change,
          usd_received, fra_received, k_received,
          usd_expected, fra_expected, k_expected,
          usd_expenses, fra_expenses, k_expenses,
          mobile_money, cash, bank,
          expenses, pending, total,
          after_change, expected, difference, status, comment, cashier_id, created_by,
          sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
         VALUES (?,?, ?,?,?, ?,?,?, ?,?,?, ?,?,?, ?,?,?,?,?,?,?,?,?,?, ?,?,?,?, 0,datetime('now'),datetime('now'))`
      ).run(date, initial_change,
             usdAmt, fraAmt, kAmt,
             usdExp, fraExp, kExp,
             usdExpense, fraExpense, kExpense,
             momoAmt, cashAmt, bankAmt,
             expenses, pending, total,
             after_change, expected, difference, status, comment,
             cashierId, req.user.id,
             randomUUID(), tenantId, branchId, deviceId);
      row = db.prepare('SELECT * FROM cash_reports WHERE id = ?').get(info.lastInsertRowid);
    }

    recalculateDailyProfit(db, date, req.user.tenantId);

    // 2026-09-11 â€” auto deposit (System Settings â†’ Auto deposit). The report
    // is already saved; a failure here is reported back, not thrown.
    let autoDeposits = null;
    try {
      const bs = db.prepare('SELECT auto_deposit_enabled, currency_mode, business_name FROM business_settings LIMIT 1').get() || {};
      if (String(bs.currency_mode || 'K').toUpperCase() === 'K') {
        const cashier = row.cashier_id ? db.prepare('SELECT first_name FROM users WHERE id = ?').get(row.cashier_id) : null;
        autoDeposits = autoDeposit.syncFromReport({
          report: row, slug: getHostSlug(req), branchName: bs.business_name || null,
          cashierName: cashier?.first_name || null, user: req.user,
          enabled: !!parseInt(bs.auto_deposit_enabled || 0, 10),
        });
      }
    } catch (e) {
      console.error('[cash-report] auto deposit failed:', e.message);
      autoDeposits = { error: e.message };
    }
    res.status(201).json(autoDeposits ? { ...row, auto_deposits: autoDeposits } : row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.10.9 â€” Admin-only delete a saved cash report so the UI falls back to
// the live daily figure. The frontend already gates this behind
// AdminPasswordPrompt (which re-verifies the admin credential server-side
// via /auth/verify-admin); this handler just enforces role at the API too.
router.delete('/:id', auth, (req, res) => {
  try {
    if ((req.user.role || '').toLowerCase() !== 'administrator') {
      return res.status(403).json({ error: 'Only administrators can delete a cash report.' });
    }
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const row = db.prepare('SELECT * FROM cash_reports WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!row) return res.status(404).json({ error: 'Cash report not found (or already deleted).' });
    // 2026-09-11 â€” refused once HQ has confirmed this report's auto deposit.
    const blocked = autoDeposit.blockIfConfirmed(row.sync_id);
    if (blocked) return res.status(409).json({ error: blocked });
    db.prepare(`
      UPDATE cash_reports
         SET deleted_at = datetime('now'),
             updated_at = datetime('now'),
             synced = 0
       WHERE id = ?
    `).run(id);
    // v1.10.46 â€” cascade soft-delete the auto-created Cash Receipt for this
    // cashier's day so `Delete saved` is a real reset. Without this the CR
    // hangs behind with stale figures and the next save prompts an
    // update-or-keep modal for a row the user thought was already gone.
    // Match by (date, tenant, received_from) â€” same tuple the frontend uses
    // to auto-create it, so manual CRs typed on the same day with a
    // different `received_from` (e.g. "Rent income") are untouched.
    try {
      const cashier = row.cashier_id
        ? db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(row.cashier_id)
        : null;
      const receivedFrom = cashier ? `Sales / ${cashier.first_name}` : 'Sales';
      const crInfo = db.prepare(`
        UPDATE cash_receipts
           SET deleted_at = datetime('now'),
               updated_at = datetime('now'),
               synced = 0
         WHERE tenant_id = ?
           AND date = ?
           AND received_from = ?
           AND deleted_at IS NULL
      `).run(req.user.tenantId, row.date, receivedFrom);
      if (crInfo.changes > 0) {
        console.log(`[cash-report DELETE] cascaded soft-delete to ${crInfo.changes} auto-CR row(s) for ${receivedFrom} on ${row.date}`);
      }
    } catch (e) {
      console.error('[cash-report DELETE] cascade CR delete failed:', e.message);
    }
    // 2026-09-11 â€” and its PENDING auto deposits, soft-deleted with a reason.
    try {
      const n = autoDeposit.removeForReport({ reportSyncId: row.sync_id, user: req.user });
      if (n > 0) console.log(`[cash-report DELETE] cascaded soft-delete to ${n} auto deposit(s) for ${row.date}`);
    } catch (e) {
      console.error('[cash-report DELETE] cascade deposit delete failed:', e.message);
    }
    if (row.date && req.user.tenantId) {
      try { recalculateDailyProfit(db, row.date, req.user.tenantId); } catch { /* non-fatal */ }
    }
    res.json({ ok: true, id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
