/**
 * profitHelper.js
 * Reusable function to compute and store daily gross/net profit.
 *
 * Formula (after the Sales Inventory / Stock Adjustment retirement):
 *   Gross Profit = Revenue âˆ’ COGS âˆ’ Damages + Supplier Rebates + Stock Variance + Cash Variance
 *   Net Profit   = Gross Profit âˆ’ Expenses (PV)
 *
 * "Supplier Rebates" = SUM(supplier_credit_notes.amount) for the day where
 * reason IN ('Discount','Other'). Crate/Bottle returns are excluded â€” those
 * are deposit refunds, not income (they affect AP balance + empty stock only).
 *
 * Stock Variance is the sum of stock_reconciliation_items.variance_base Ã— cost_at_count
 * for that count_date â€” covers BOTH sales and store locations.
 *
 * Called from: stock reconciliation POST, cash-reports save, payment-vouchers save,
 * order create/reverse, GRN save.
 */
const { randomUUID } = require('crypto');
const { baseQtyExpr } = require('./unitsHelper');

/**
 * writeDailyCostSnapshot â€” v1.13.48
 * First-write-wins snapshot of avg_cost_price + selling_price per product
 * per date. Uses INSERT OR IGNORE so once a date/product row exists, later
 * calls (which see today's freshly-blended WAC) can never overwrite the
 * cost that was live at the moment of first activity that day.
 *
 * The GRN/production aggregates are DATE-BOUNDED (created_at <= date) so
 * backfills for historical dates don't get contaminated by future GRNs.
 * The three-step fallback: p.avg_cost_price (live WAC when it's set),
 * else the dated aggregate, else p.cost_price.
 *
 * Called at the top of recalculateDailyProfit so every business event
 * (sale, GRN, PV, damage, transit_writeoff, reconciliation, â€¦) auto-locks
 * that day's cost before COGS/damages queries read from dcs.
 */
function writeDailyCostSnapshot(db, date, tenantId) {
  try {
    const rows = db.prepare(`
      SELECT p.id, p.sync_id, p.avg_cost_price, p.cost_price, p.selling_price,
        COALESCE(grn_agg.total_qty, 0)  + COALESCE(prod_agg.total_qty, 0)  AS combined_qty,
        COALESCE(grn_agg.total_cost, 0) + COALESCE(prod_agg.total_cost, 0) AS combined_cost
      FROM products p
      LEFT JOIN (
        SELECT product_sync_id,
               SUM(quantity) AS total_qty, SUM(total_price) AS total_cost
        FROM grn_items
        WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL
          AND date(created_at) <= ?
        GROUP BY product_sync_id
      ) grn_agg ON grn_agg.product_sync_id = p.sync_id
      LEFT JOIN (
        SELECT product_sync_id,
               SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost
        FROM production_outputs
        WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL
          AND date(created_at) <= ?
        GROUP BY product_sync_id
      ) prod_agg ON prod_agg.product_sync_id = p.sync_id
      WHERE p.deleted_at IS NULL AND p.tenant_id = ?
    `).all(date, date, tenantId);

    const insert = db.prepare(`
      INSERT OR IGNORE INTO daily_cost_snapshot
        (product_id, product_sync_id, date, avg_cost_price, selling_price,
         sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    `);

    db.transaction(() => {
      for (const p of rows) {
        const live = parseFloat(p.avg_cost_price) || 0;
        const dated = (p.combined_qty > 0)
          ? parseFloat(p.combined_cost) / parseFloat(p.combined_qty)
          : 0;
        const cost = live > 0 ? live : (dated > 0 ? dated : (parseFloat(p.cost_price) || 0));
        insert.run(
          p.id, p.sync_id, date, cost, parseFloat(p.selling_price) || 0,
          randomUUID(), tenantId, null, null
        );
      }
    })();
  } catch (e) {
    console.error('[dcs.write] failed:', e.message);
  }
}

function recalculateDailyProfit(db, date, tenantId) {
  try {
    // v1.13.48 â€” lock cost for this date BEFORE reading COGS/damages. Any
    // event that would trigger a recalc (sale, GRN, PV, damage, recon, â€¦)
    // now auto-snapshots the date. INSERT OR IGNORE means the very first
    // event of the date wins; later events for the same date leave the
    // frozen cost alone. Result: historical dates become tamper-proof
    // to later cost changes without needing a per-sale cost_at_sale column.
    writeDailyCostSnapshot(db, date, tenantId);

    // Revenue: total sales billed today (accrual â€” includes credit sales whether paid or not).
    // Cash actually collected is tracked separately in the Cash Report.
    const revRow = db.prepare(`
      SELECT COALESCE(SUM(total_amount), 0) AS revenue
      FROM orders
      WHERE DATE(created_at) = ? AND deleted_at IS NULL AND tenant_id = ?
        AND (status IS NULL OR status != 'Reversed')
    `).get(date, tenantId);

    // COGS: sale movements Ã— cost.
    // v1.13.49 â€” cost fallback now starts with sm.cost_at_sale (the WAC
    // frozen at the MOMENT of the sale by trigger trg_stamp_cost_at_sale).
    // Fully immune to any later WAC change â€” even mid-day GRN blends.
    // Fallbacks (in order): frozen sale cost â†’ dcs snapshot â†’ dated GRN
    // aggregate â†’ live products.cost_price.
    //
    // Also fixed movement_type filter from 'reverse' (a ghost that no code
    // path writes) to 'sale_reverse' (what orders.js:1235 actually emits),
    // and flipped ABS(quantity) â†’ -quantity so reverses subtract cost
    // (sale is negative â†’ +cost, sale_reverse is positive â†’ -cost).
    // Same shape as Kelete v1.10.215.
    const cogsRow = db.prepare(`
      SELECT COALESCE(SUM(-sm.quantity *
        COALESCE(sm.cost_at_sale, dcs.avg_cost_price,
          CASE WHEN COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0) > 0
            THEN (COALESCE(grn_agg.total_cost,0)+COALESCE(prod_agg.total_cost,0)) /
                 (COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0))
            ELSE p.cost_price END)
      ), 0) AS cogs
      FROM stock_movements sm
      JOIN products p ON p.sync_id = sm.product_sync_id
      LEFT JOIN daily_cost_snapshot dcs ON dcs.product_sync_id = sm.product_sync_id AND dcs.date = ? AND dcs.deleted_at IS NULL
      LEFT JOIN (
        -- Avg cost per BASE unit. baseQtyExpr handles N packagings via units_json.
        SELECT gi.product_sync_id,
               SUM(${baseQtyExpr('gip', 'gi')}) AS total_qty,
               SUM(gi.total_price) AS total_cost
        FROM grn_items gi
        LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
        WHERE gi.deleted_at IS NULL AND gi.product_sync_id IS NOT NULL
        GROUP BY gi.product_sync_id
      ) grn_agg ON grn_agg.product_sync_id = sm.product_sync_id
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) prod_agg ON prod_agg.product_sync_id = sm.product_sync_id
      WHERE sm.location = 'sales' AND sm.movement_type IN ('sale', 'sale_reverse')
        AND DATE(sm.created_at) = ? AND sm.deleted_at IS NULL AND sm.product_sync_id IS NOT NULL
        AND p.tenant_id = ?
    `).get(date, date, tenantId);

    // Diff: mirrors exactly what the frontend computes per row:
    // difference = actual_balance - (opening_balance + input - total_sales - total_returns)
    // totalDiff  = SUM(difference Ã— avg_cost_price)
    // Cash difference (drawer over / short for the day).
    // v1.13.57 â€” for K-only branches (Buseko, Garden â€” Kelete is K-only
    // by default), compute the difference live from the raw fields,
    // matching the Cash Report / Report History display formula exactly:
    //   total = cash + mobile_money + bank + pending + expenses
    //   diff  = total âˆ’ expected
    // The stored `difference` column is legacy USD-bucket math left over
    // from an older save version that drops MoMo + Bank on K-only
    // branches, producing wildly negative diffs even when the drawer
    // balanced. Report History (CashReport.js:1795-1804) already computes
    // correctly on the fly; profitHelper now mirrors it.
    // Tri-currency branches (if any registered in future) keep using the
    // stored `difference` â€” already correct in USD terms.
    //
    // Ported from Kelete v1.10.222.
    // v1.13.58 â€” SUM across all cash_reports rows for the date. Some
    // dates have multiple reports (one per cashier); prior .get() picked
    // only the first row and silently dropped the rest. Cash Report's
    // top-tile totals sum across ALL reports, so profitHelper matches now.
    const cashRow = db.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN (SELECT currency_mode FROM business_settings LIMIT 1)
               NOT IN ('USD+FRA','USD+FRA+K')
            THEN (COALESCE(usd_received,0) + COALESCE(fra_received,0) + COALESCE(k_received,0)
                + COALESCE(pending,0)
                + COALESCE(usd_expenses,0) + COALESCE(fra_expenses,0) + COALESCE(k_expenses,0))
               - COALESCE(expected, 0)
          ELSE difference
        END
      ), 0) AS cash_difference
      FROM cash_reports WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
    `).get(date, tenantId);

    // Expenses for the day (Payment Vouchers)
    const pvRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS pv_total
      FROM payment_vouchers WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
    `).get(date, tenantId);

    // Stock Variance â€” from Stock Reconciliation only (replaces the old daily_actual_balance + stock_adjustments)
    // Sums variance Ã— cost_at_count across BOTH sales and store reconciliations for the date.
    // Positive = found extra stock (stock gain) Â· Negative = shrinkage.
    const reconRow = db.prepare(`
      SELECT COALESCE(SUM(sri.variance_base * sri.cost_at_count), 0) AS recon_value
      FROM stock_reconciliation_items sri
      JOIN stock_reconciliations sr ON sr.id = sri.reconciliation_id
      WHERE sr.count_date = ? AND sr.deleted_at IS NULL AND sri.deleted_at IS NULL AND sr.tenant_id = ?
    `).get(date, tenantId);

    // Damages â€” items destroyed/expired (recorded via Sales Damages page).
    // Cost = ABS(qty) Ã— avg_cost_price for sales_return movements at 'sales' location.
    // Uses the same cost basis as COGS (snapshot-first, falling back to GRN+production avg, then cost_price).
    // v1.13.49 â€” damages: prefer sm.cost_at_sale (frozen on the movement
    // by trigger trg_stamp_cost_at_sale) before falling through to dcs and
    // the dated aggregates. Ensures a Sales Damages / transit_writeoff
    // recorded today can't retroactively re-cost when the product's live
    // WAC changes tomorrow.
    const damageRow = db.prepare(`
      SELECT COALESCE(SUM(ABS(sm.quantity) *
        COALESCE(sm.cost_at_sale, dcs.avg_cost_price,
          CASE WHEN COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0) > 0
            THEN (COALESCE(grn_agg.total_cost,0)+COALESCE(prod_agg.total_cost,0)) /
                 (COALESCE(grn_agg.total_qty,0)+COALESCE(prod_agg.total_qty,0))
            ELSE p.cost_price END)
      ), 0) AS damages
      FROM stock_movements sm
      JOIN products p ON p.sync_id = sm.product_sync_id
      LEFT JOIN daily_cost_snapshot dcs ON dcs.product_sync_id = sm.product_sync_id AND dcs.date = ? AND dcs.deleted_at IS NULL
      LEFT JOIN (
        SELECT gi.product_sync_id,
               SUM(${baseQtyExpr('gip', 'gi')}) AS total_qty,
               SUM(gi.total_price) AS total_cost
        FROM grn_items gi
        LEFT JOIN products gip ON gip.sync_id = gi.product_sync_id
        WHERE gi.deleted_at IS NULL AND gi.product_sync_id IS NOT NULL
        GROUP BY gi.product_sync_id
      ) grn_agg ON grn_agg.product_sync_id = sm.product_sync_id
      LEFT JOIN (SELECT product_sync_id, SUM(quantity) AS total_qty, SUM(total_allocated_cost) AS total_cost FROM production_outputs WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL GROUP BY product_sync_id) prod_agg ON prod_agg.product_sync_id = sm.product_sync_id
      -- v1.13.47 â€” include transit_writeoff (Option C: HQ resolves a Transit
      -- Variance as WRITE_OFF and the loss lands on the chosen branch's
      -- damages line). Written by hq.js with location='books_only' so it's
      -- invisible to inventory sums but visible here â€” drop the location
      -- filter for the writeoff type so it's picked up regardless.
      WHERE ((sm.location = 'sales' AND sm.movement_type = 'sales_return')
             OR sm.movement_type = 'transit_writeoff')
        AND DATE(sm.created_at) = ? AND sm.deleted_at IS NULL AND sm.product_sync_id IS NOT NULL
        AND p.tenant_id = ?
    `).get(date, date, tenantId);

    // Supplier Rebates â€” confirmed credit notes for the day, excluding
    // crate/bottle returns (those are deposit refunds, not income).
    const rebateRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS supplier_rebates
      FROM supplier_credit_notes
      WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
        AND reason IN ('Discount', 'Other')
        -- Unconfirmed depot credits are claims, not rebates.
        AND (raised_by_branch IS NULL OR branch_confirmed_at IS NOT NULL)
    `).get(date, tenantId);

    // Interest Expense â€” interest payments on loans for the day. The cost of
    // borrowing IS a real expense. Principal repayments and disbursements are
    // not â€” they only move cash + the loan balance, not the P&L.
    const intRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS interest_expense
      FROM loan_transactions
      WHERE date = ? AND deleted_at IS NULL AND tenant_id = ?
        AND type = 'Interest'
    `).get(date, tenantId);

    const revenue         = parseFloat(revRow.revenue);
    const cogs            = parseFloat(cogsRow.cogs);
    const cashDiff        = parseFloat(cashRow?.cash_difference ?? 0);
    const pvTotal         = parseFloat(pvRow.pv_total);
    const stockVariance   = parseFloat(reconRow?.recon_value ?? 0);
    const damages         = parseFloat(damageRow?.damages ?? 0);
    const supplierRebates = parseFloat(rebateRow?.supplier_rebates ?? 0);
    const interestExpense = parseFloat(intRow?.interest_expense ?? 0);
    // Gross = Revenue âˆ’ COGS âˆ’ Damages + Supplier Rebates + Stock Variance + Cash Variance
    const grossProfit     = revenue - cogs - damages + supplierRebates + stockVariance + cashDiff;
    // Net = Gross âˆ’ PV expenses âˆ’ Interest expense on loans
    const netProfit       = grossProfit - pvTotal - interestExpense;
    // Legacy columns kept for schema compatibility â€” diff_value now stores the stock variance, stock_adj retired (0).
    const diffValue     = stockVariance;
    const stockAdj      = 0;

    // Upsert into daily_profit_summary
    db.prepare(`
      INSERT INTO daily_profit_summary (date, tenant_id, revenue, cogs, damages, supplier_rebates, interest_expense, diff_value, cash_difference, pv_total, stock_adj, gross_profit, net_profit, sync_id, synced, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
      ON CONFLICT (date, tenant_id)
      DO UPDATE SET
        revenue = excluded.revenue,
        cogs = excluded.cogs,
        damages = excluded.damages,
        supplier_rebates = excluded.supplier_rebates,
        interest_expense = excluded.interest_expense,
        diff_value = excluded.diff_value,
        cash_difference = excluded.cash_difference,
        pv_total = excluded.pv_total,
        stock_adj = excluded.stock_adj,
        gross_profit = excluded.gross_profit,
        net_profit = excluded.net_profit,
        synced = 0,
        updated_at = datetime('now')
    `).run(date, tenantId, revenue, cogs, damages, supplierRebates, interestExpense, diffValue, cashDiff, pvTotal, stockAdj, grossProfit, netProfit, randomUUID());

  } catch (e) {
    console.error('[profit] recalculate error:', e.message);
  }
}

/**
 * reapplyReconciliation
 * After a SIV is created/edited/deleted, re-run reconciliation for each affected product
 * on the SIV date â€” but ONLY if a daily_actual_balance already exists for that product+date.
 * This keeps POS "In Stock" correct after SIV changes.
 */
function reapplyReconciliation(db, date, productSyncIds, tenantId, branchId, deviceId, userId) {
  try {
    for (const productSyncId of productSyncIds) {
      // Check if actual balance was saved for this product+date
      const actual = db.prepare(
        `SELECT actual_balance, product_id FROM daily_actual_balance WHERE product_sync_id = ? AND date = ? AND deleted_at IS NULL`
      ).get(productSyncId, date);
      if (!actual) continue; // No actual balance saved â€” skip

      // v1.10.24 â€” roll the old reconciliation off current_stock before deleting it.
      const oldRec = db.prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS net FROM stock_movements
          WHERE product_sync_id = ? AND location = 'sales'
            AND movement_type = 'reconciliation' AND deleted_at IS NULL`
      ).get(productSyncId).net;
      if (oldRec && Math.abs(oldRec) > 0.0001) {
        db.prepare(
          `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
        ).run(oldRec, productSyncId);
      }
      // Delete old reconciliation movement
      db.prepare(
        `UPDATE stock_movements SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
         WHERE product_sync_id = ? AND location = 'sales' AND movement_type = 'reconciliation' AND deleted_at IS NULL`
      ).run(productSyncId);

      // Recalculate natural balance (all non-reconciliation sales movements)
      const natural = db.prepare(
        `SELECT COALESCE(SUM(quantity), 0) AS bal FROM stock_movements
         WHERE product_sync_id = ? AND location = 'sales' AND deleted_at IS NULL`
      ).get(productSyncId);

      const diff = parseFloat(actual.actual_balance) - parseFloat(natural.bal);
      if (Math.abs(diff) > 0.0001) {
        db.prepare(
          `INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity, notes, created_by, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
           VALUES (?, ?, 'sales', 'reconciliation', ?, ?, ?, ?, ?, ?, ?, 0, ?, datetime('now'))`
        ).run(actual.product_id, productSyncId, diff,
              `Reconciliation: actual balance set to ${actual.actual_balance}`,
              userId, randomUUID(), tenantId, branchId, deviceId, date);
        // v1.10.24 â€” apply new reconciliation delta to current_stock.
        db.prepare(
          `UPDATE products SET current_stock = current_stock + ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
        ).run(diff, productSyncId);
      }
    }
  } catch (e) {
    console.error('[reconciliation] reapply error:', e.message);
  }
}

module.exports = { recalculateDailyProfit, reapplyReconciliation, writeDailyCostSnapshot };
