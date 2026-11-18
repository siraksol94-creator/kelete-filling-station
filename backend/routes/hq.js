/**
 * hq.js — HQ (head-office) endpoints served at the bare keletezm.com domain.
 *
 * Phase B v1 surfaces:
 *   GET /api/hq/branches  — public list of registered tenant slugs so the
 *                           HQ login page can render a branch picker. No
 *                           auth required; the response is just slugs +
 *                           display names, no secrets.
 *
 * Future endpoints (Phase D — consolidated reports) will live here too and
 * use the same X-Branch header pattern to read across all tenant DBs.
 *
 * Why a dedicated router instead of extending tenantAdmin: tenantAdmin is
 * gated by the central ADMIN_PASSWORD (used by sidanitsolutions.com to
 * manage tenants), which would prevent the public HQ login screen from
 * fetching the branches list. HQ endpoints have their own auth model.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { listTenants, masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const { defaultDb }   = require('../config/database');
const { mirrorAllHqToBranches } = require('../middleware/hqPush');
const { requirePagePerm } = require('../middleware/auth');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { buildVatLines } = require('../services/vatReport');

// HQ admin auth — same JWT model the per-branch app uses. The token comes
// from whichever branch the user picked at login; we trust it as proof of
// identity and don't enforce any per-branch role check here (the user
// already has admin powers on the branch they're signed into, and HQ
// overview is read-only aggregation).
function hqAuth(req, res, next) {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Access denied' });
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'kelete-pro-secret-key-2026');
    next();
  } catch (_) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// Safe-int helper — bails to 0 if the column is missing on an older DB.
function tryGet(db, sql, params = []) {
  try { return db.prepare(sql).get(...(Array.isArray(params) ? params : [params])); }
  catch { return null; }
}

// GET /api/hq/branches — list registered tenants for the HQ login picker.
// Returns at most slug + business_name + currency_mode. Anything that
// would help an attacker target a specific branch (status counts,
// license expiry, etc.) stays out — that's tenantAdmin territory.
// v1.10.54 — currency_mode added so the HQ Purchase / Send Transfer
// modals can decide whether to prompt for an FX rate. K-only branches
// (Mansa, Lusaka) get no prompt; tri-currency (Kassumbalesa) requires
// one rate per whole PO / transfer. Read once per branch DB, cheap.
router.get('/branches', (req, res) => {
  try {
    // 2026-09-12 — switched-off branches are left out. The APK's first screen
    // now builds its branch list from this route, so a deactivated tenant would
    // otherwise be offered to every new phone.
    const rows = listTenants().filter(r => Number(r.is_active ?? 1) !== 0);
    const enriched = rows.map(r => {
      let currencyMode = 'K';
      try {
        const db = getTenantDb(r.slug);
        const s = db.prepare(`SELECT currency_mode FROM business_settings ORDER BY id ASC LIMIT 1`).get();
        if (s?.currency_mode) currencyMode = String(s.currency_mode).toUpperCase();
      } catch { /* branch DB unavailable — default K */ }
      return {
        slug: r.slug,
        name: r.business_name || r.slug,
        currency_mode: currencyMode,
      };
    });
    res.json({ branches: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/overview — per-branch summary card data + roll-up totals.
// Iterates each registered tenant, opens its DB (cached via getTenantDb),
// and runs a handful of cheap aggregations. Designed to be the "front
// page" of HQ so the operator gets a one-screen view of every branch's
// day at a glance. Today = midnight to now in the server's local TZ.
// 2026-08-30 — HQOverview permission enforced here, not just in the UI.
//
// hqAuth only proves the token is valid, so ANY logged-in user could GET this
// and read group revenue, stock value and AR outstanding. The sidebar link was
// hidden and the route now guards too, but a hidden link is presentation — the
// endpoint was the actual leak, and a browser tab is enough to reach it.
//
// requirePagePerm re-reads permissions from the tenant DB on every call, so
// revoking access takes effect without waiting for the 24h token to expire.
router.get('/overview', hqAuth, requirePagePerm('HQOverview'), (req, res) => {
  try {
    const todayPrefix = new Date().toISOString().slice(0, 10);
    const tenants = listTenants();
    const branches = [];

    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);

        // Today's sales — completed orders only (status NULL = single_pos
        // sale, status='DISPATCHED' = 3-station completed). PAID-but-not-
        // dispatched orders are revenue-realised at Cashier but not yet
        // fully closed; we count them too because Cashier collected cash.
        const salesToday = tryGet(db, `
          SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                 COUNT(*)                       AS orders
            FROM orders
           WHERE deleted_at IS NULL
             AND (status IS NULL OR status IN ('PAID','DISPATCHED'))
             AND substr(COALESCE(paid_at, created_at), 1, 10) = ?
        `, [todayPrefix]) || { revenue: 0, orders: 0 };

        // Sales month-to-date for trend context.
        const salesMTD = tryGet(db, `
          SELECT COALESCE(SUM(total_amount), 0) AS revenue,
                 COUNT(*)                       AS orders
            FROM orders
           WHERE deleted_at IS NULL
             AND (status IS NULL OR status IN ('PAID','DISPATCHED'))
             AND substr(COALESCE(paid_at, created_at), 1, 7) = ?
        `, [todayPrefix.slice(0, 7)]) || { revenue: 0, orders: 0 };

        // 3-station queue depths (NULL on single_pos branches).
        const pendingPayment  = tryGet(db, `SELECT COUNT(*) AS n FROM orders WHERE deleted_at IS NULL AND status = 'PENDING_PAYMENT'`)?.n || 0;
        const awaitingDispatch= tryGet(db, `SELECT COUNT(*) AS n FROM orders WHERE deleted_at IS NULL AND status = 'PAID'`)?.n || 0;

        // Stock value at sales floor — sum(current_stock * cost_price) on
        // products that aren't soft-deleted.
        const stockValue = tryGet(db, `
          SELECT COALESCE(SUM(current_stock * cost_price), 0) AS v
            FROM products
           WHERE deleted_at IS NULL
        `)?.v || 0;
        const stockLowCount = tryGet(db, `
          SELECT COUNT(*) AS n
            FROM products
           WHERE deleted_at IS NULL AND current_stock <= min_stock
        `)?.n || 0;

        // Outstanding AR — credit sales that haven't been collected.
        const arOutstanding = tryGet(db, `
          SELECT COALESCE(
            (SELECT SUM(total_amount - COALESCE(amount_received,0)) FROM orders
              WHERE deleted_at IS NULL AND (status IS NULL OR status != 'Reversed')
                AND total_amount > COALESCE(amount_received,0)) -
            (SELECT COALESCE(SUM(amount), 0) FROM customer_payments WHERE deleted_at IS NULL),
            0
          ) AS ar
        `)?.ar || 0;

        // Branch business settings — currency_mode / workflow_mode so the
        // dashboard can flag dual-currency / 3-station branches at a glance.
        const settings = tryGet(db, `
          SELECT business_name, currency_mode, workflow_mode
            FROM business_settings
           ORDER BY id ASC LIMIT 1
        `) || {};

        branches.push({
          slug: t.slug,
          name: settings.business_name || t.business_name || t.slug,
          currency_mode: settings.currency_mode || 'K',
          workflow_mode: settings.workflow_mode || 'single_pos',
          today: { revenue: salesToday.revenue, orders: salesToday.orders },
          mtd:   { revenue: salesMTD.revenue,   orders: salesMTD.orders },
          pending_payment:   pendingPayment,
          awaiting_dispatch: awaitingDispatch,
          stock_value:       stockValue,
          stock_low_count:   stockLowCount,
          ar_outstanding:    Math.max(0, arOutstanding),
        });
      } catch (e) {
        branches.push({ slug: t.slug, name: t.business_name || t.slug, error: e.message });
      }
    }

    // Roll-up — sum across all branches (ignores ones that errored).
    const rollup = branches.reduce((acc, b) => {
      if (b.error) return acc;
      acc.today_revenue   += b.today.revenue;
      acc.today_orders    += b.today.orders;
      acc.mtd_revenue     += b.mtd.revenue;
      acc.mtd_orders      += b.mtd.orders;
      acc.pending_payment += b.pending_payment;
      acc.awaiting_dispatch += b.awaiting_dispatch;
      acc.stock_value     += b.stock_value;
      acc.ar_outstanding  += b.ar_outstanding;
      return acc;
    }, { today_revenue:0, today_orders:0, mtd_revenue:0, mtd_orders:0,
         pending_payment:0, awaiting_dispatch:0, stock_value:0, ar_outstanding:0 });

    res.json({ as_of: new Date().toISOString(), branches, rollup });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/sales-report?from=YYYY-MM-DD&to=YYYY-MM-DD&branch=slug
// Cross-branch order list with date + branch filters. Default range is
// today only; pass `branch=all` (or omit) to span every registered tenant.
// Sorted newest first; capped at 1000 rows so a busy multi-month query
// can't blow up the response. Each row carries its branch slug + name so
// the table can render origin without a second lookup.
// 2026-09-15 — GET /api/hq/route-sales?from=&to=&branch=
// Route selling per depot. A route seller is a depot user ticked "Route
// seller" (Users → Edit); every sale under their login is route selling. Stock
// and cash stay with the depot — this only splits the depot's sales into its
// own and its route sellers'. Counted exactly like /sales-report: not deleted,
// not Reversed, dated by paid_at (else created_at); cash sales = paid at the
// till capped at the sale total, credit = the rest.
router.get('/route-sales', hqAuth, (req, res) => {
  try {
    const from   = (req.query.from   || new Date().toISOString().slice(0, 10)).toString();
    const to     = (req.query.to     || from).toString();
    const branch = (req.query.branch || 'all').toString().toLowerCase();
    const tenants = listTenants().filter(t =>
      !/^(hq|keletedistributionzm)$/i.test(t.slug)
      && Number(t.is_active ?? 1) !== 0
      && (branch === 'all' || t.slug === branch));

    const IN_RANGE = `o.deleted_at IS NULL
      AND substr(COALESCE(o.paid_at, o.created_at), 1, 10) >= ?
      AND substr(COALESCE(o.paid_at, o.created_at), 1, 10) <= ?
      AND (o.status IS NULL OR o.status != 'Reversed')`;
    const CASH = `CASE WHEN COALESCE(o.amount_received, 0) > o.total_amount
                       THEN o.total_amount ELSE COALESCE(o.amount_received, 0) END`;

    const totals = { orders: 0, revenue: 0, route_orders: 0, route_revenue: 0, route_cash: 0, route_credit: 0, sellers: 0 };
    const depots = [];
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1`) || {};
        const all = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(o.total_amount), 0) AS revenue
                                  FROM orders o WHERE ${IN_RANGE}`).get(from, to) || {};
        let sellers = [];
        try {
          sellers = db.prepare(`
            SELECT u.id, TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS name,
                   u.phone, u.status,
                   COUNT(o.id) AS orders,
                   COALESCE(SUM(o.total_amount), 0) AS revenue,
                   COALESCE(SUM(${CASH}), 0) AS cash_sales
              FROM users u
              LEFT JOIN orders o
                ON (u.sync_id = o.created_by_sync_id OR (o.created_by_sync_id IS NULL AND u.id = o.created_by))
               AND ${IN_RANGE}
             WHERE u.deleted_at IS NULL AND COALESCE(u.is_route_seller, 0) = 1
             GROUP BY u.id
             ORDER BY revenue DESC, name`).all(from, to);
        } catch (_) { sellers = []; /* column not added yet on this depot */ }
        sellers = sellers.map(s => ({
          ...s,
          orders: Number(s.orders) || 0,
          revenue: Number(s.revenue) || 0,
          cash_sales: Number(s.cash_sales) || 0,
          credit_sales: Math.max(0, (Number(s.revenue) || 0) - (Number(s.cash_sales) || 0)),
        }));
        const d = {
          slug: t.slug,
          name: settings.business_name || t.business_name || t.slug,
          orders: Number(all.orders) || 0,
          revenue: Number(all.revenue) || 0,
          route_orders:  sellers.reduce((s, x) => s + x.orders, 0),
          route_revenue: sellers.reduce((s, x) => s + x.revenue, 0),
          route_cash:    sellers.reduce((s, x) => s + x.cash_sales, 0),
          route_credit:  sellers.reduce((s, x) => s + x.credit_sales, 0),
          sellers,
        };
        d.depot_revenue = Math.max(0, d.revenue - d.route_revenue);
        depots.push(d);
        totals.orders += d.orders; totals.revenue += d.revenue;
        totals.route_orders += d.route_orders; totals.route_revenue += d.route_revenue;
        totals.route_cash += d.route_cash; totals.route_credit += d.route_credit;
        totals.sellers += sellers.length;
      } catch (e) {
        console.error(`[hq.route-sales] ${t.slug}:`, e.message);
      }
    }
    totals.depot_revenue = Math.max(0, totals.revenue - totals.route_revenue);
    depots.sort((a, b) => (b.route_revenue - a.route_revenue) || (b.revenue - a.revenue) || String(a.name).localeCompare(String(b.name)));
    res.json({ from, to, branch, totals, depots });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/sales-report', hqAuth, (req, res) => {
  try {
    const from   = (req.query.from   || new Date().toISOString().slice(0, 10)).toString();
    const to     = (req.query.to     || from).toString();
    const branch = (req.query.branch || 'all').toString().toLowerCase();
    const LIMIT  = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    // 2026-09-13 — the order list is opt-in (orders=1). The HQ page shows the
    // depot totals only, and the totals now come from COUNT/SUM in each
    // depot's own book. They used to be added up from the capped order rows,
    // so any range past 1,000 orders reported less than was sold (K2,746,258
    // against HQ Overview's K2,930,347 on 12 Sep), and fetching up to 1,000
    // rows per depot was most of the wait.
    const withOrders = String(req.query.orders || '') === '1';

    // We compare ISO date prefixes (YYYY-MM-DD) so timestamps with a time
    // component still bucket correctly. `to` is inclusive: a created_at of
    // '2026-06-19 23:59:30' falls under to='2026-06-19'.
    // HQ and the stale bare-domain tenant sell nothing; switched-off tenants
    // are left out.
    const tenants = listTenants().filter(t =>
      !/^(hq|keletedistributionzm)$/i.test(t.slug)
      && Number(t.is_active ?? 1) !== 0
      && (branch === 'all' || t.slug === branch));
    const rows = [];
    const totals = { orders: 0, revenue: 0, received: 0, cash_sales: 0, credit_sales: 0, by_branch: {} };

    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1`) || {};
        const branchName = settings.business_name || t.business_name || t.slug;

        const sum = db.prepare(`
          SELECT COUNT(*) AS orders,
                 COALESCE(SUM(o.total_amount), 0)    AS revenue,
                 COALESCE(SUM(o.amount_received), 0) AS received,
                 -- 2026-09-13 — paid at the till, capped at the sale total (the
                 -- rest came back as change). Whatever is left unpaid is credit.
                 COALESCE(SUM(CASE WHEN COALESCE(o.amount_received, 0) > o.total_amount
                                   THEN o.total_amount
                                   ELSE COALESCE(o.amount_received, 0) END), 0) AS cash_sales
            FROM orders o
           WHERE o.deleted_at IS NULL
             AND substr(COALESCE(o.paid_at, o.created_at), 1, 10) >= ?
             AND substr(COALESCE(o.paid_at, o.created_at), 1, 10) <= ?
             AND (o.status IS NULL OR o.status != 'Reversed')
        `).get(from, to) || {};
        const b = {
          name: branchName,
          orders: Number(sum.orders) || 0,
          revenue: Number(sum.revenue) || 0,
          received: Number(sum.received) || 0,
          cash_sales: Number(sum.cash_sales) || 0,
          credit_sales: Math.max(0, (Number(sum.revenue) || 0) - (Number(sum.cash_sales) || 0)),
        };
        totals.by_branch[t.slug] = b;
        totals.orders += b.orders; totals.revenue += b.revenue; totals.received += b.received;
        totals.cash_sales += b.cash_sales; totals.credit_sales += b.credit_sales;

        if (!withOrders) continue;

        // Every column from `orders` must be prefixed with `o.` — id, status,
        // and created_at all collide with users columns, and better-sqlite3
        // throws "ambiguous column name" on the unprefixed form (vanilla
        // sqlite CLI silently picks one, which is what hid this in dev).
        const orders = db.prepare(`
          SELECT o.id, o.order_number, o.customer_name, o.total_amount, o.amount_received,
                 o.change_amount, o.payment_method, o.status, o.currency,
                 o.created_at, o.paid_at, o.dispatched_at,
                 TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS created_by_name
            FROM orders o
            LEFT JOIN users u ON u.sync_id = o.created_by_sync_id
                              OR (o.created_by_sync_id IS NULL AND u.id = o.created_by)
           WHERE o.deleted_at IS NULL
             AND substr(COALESCE(o.paid_at, o.created_at), 1, 10) >= ?
             AND substr(COALESCE(o.paid_at, o.created_at), 1, 10) <= ?
             AND (o.status IS NULL OR o.status != 'Reversed')
           ORDER BY COALESCE(o.paid_at, o.created_at) DESC
           LIMIT ?
        `).all(from, to, LIMIT);

        for (const o of orders) {
          rows.push({
            ...o,
            branch_slug: t.slug,
            branch_name: branchName,
          });
        }
      } catch (e) {
        // Skip branches that error out — they'll show up missing rather
        // than failing the whole report.
        console.error(`[hq.sales-report] ${t.slug}:`, e.message);
      }
    }

    // Sort the combined list by paid_at|created_at desc and trim to LIMIT.
    rows.sort((a, b) => {
      const av = a.paid_at || a.created_at || '';
      const bv = b.paid_at || b.created_at || '';
      return bv.localeCompare(av);
    });
    const capped = rows.slice(0, LIMIT);

    // Totals are the depot sums above — every order in range, never capped.
    res.json({
      from, to, branch,
      total_rows: withOrders ? rows.length : totals.orders,
      returned_rows: capped.length,
      truncated: withOrders && rows.length > capped.length,
      totals,
      orders: withOrders ? capped : [],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/inventory-report?branch=&low_only=&q=
// Cross-branch stock list — one row per product per branch. Capped at
// 2000 rows so a catalog explosion can't blow up the JSON.
//   branch    — slug or 'all' (default)
//   low_only  — '1' = only rows where current_stock <= min_stock
//   q         — substring match on product name (case-insensitive)
// Returns: per-branch summary (count, value, low-count) + flat rows.
router.get('/inventory-report', hqAuth, (req, res) => {
  try {
    const branch  = (req.query.branch || 'all').toString().toLowerCase();
    const lowOnly = req.query.low_only === '1' || req.query.low_only === 'true';
    const q       = (req.query.q || '').toString().trim().toLowerCase();
    const LIMIT   = Math.min(parseInt(req.query.limit, 10) || 2000, 5000);

    const tenants = listTenants().filter(t => branch === 'all' || t.slug === branch);
    const rows = [];
    const byBranch = {};

    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1`) || {};
        const branchName = settings.business_name || t.business_name || t.slug;
        byBranch[t.slug] = { name: branchName, products: 0, low: 0, stock_value: 0 };

        // Pull active products + category for context.
        let sql = `
          SELECT p.id, p.name, p.unit, p.current_stock, p.min_stock,
                 p.cost_price, p.selling_price, p.status,
                 c.name AS category_name
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
           WHERE p.deleted_at IS NULL`;
        const params = [];
        if (lowOnly) sql += ' AND p.current_stock <= p.min_stock';
        if (q)       { sql += ' AND LOWER(p.name) LIKE ?'; params.push(`%${q}%`); }
        sql += ' ORDER BY (p.current_stock * p.cost_price) DESC';
        const products = db.prepare(sql).all(...params);

        for (const p of products) {
          const stock = parseFloat(p.current_stock || 0);
          const min   = parseFloat(p.min_stock || 0);
          const cost  = parseFloat(p.cost_price || 0);
          const value = stock * cost;
          const isLow = stock <= min;
          byBranch[t.slug].products    += 1;
          byBranch[t.slug].stock_value += value;
          if (isLow) byBranch[t.slug].low += 1;
          rows.push({
            branch_slug: t.slug,
            branch_name: branchName,
            product_id:  p.id,
            name:        p.name,
            category:    p.category_name || '—',
            unit:        p.unit || '',
            current_stock: stock,
            min_stock:   min,
            cost_price:  cost,
            selling_price: parseFloat(p.selling_price || 0),
            value,
            low: isLow,
            status: p.status || 'Active',
          });
        }
      } catch (e) {
        console.error(`[hq.inventory-report] ${t.slug}:`, e.message);
      }
    }

    // Sort combined list by value desc and cap.
    rows.sort((a, b) => b.value - a.value);
    const capped = rows.slice(0, LIMIT);

    const rollup = Object.values(byBranch).reduce((acc, b) => {
      acc.products    += b.products;
      acc.stock_value += b.stock_value;
      acc.low         += b.low;
      return acc;
    }, { products: 0, stock_value: 0, low: 0 });

    res.json({
      branch, low_only: lowOnly, q,
      total_rows: rows.length,
      returned_rows: capped.length,
      truncated: rows.length > capped.length,
      rollup,
      by_branch: byBranch,
      rows: capped,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 2026-09-12 — HQ: every depot's Payment Vouchers in one list ────────
//
// GET /api/hq/payment-vouchers?from=&to=&slug=
//
// The "All Depots" tab on HQ's Payment Voucher page: every PV from every
// depot's own book plus HQ's. 2026-09-17 — deleted vouchers are listed too,
// flagged `deleted` (the page strikes them through), but count in no total.
// An HQ Administrator can delete one here (DELETE below); it is deleted in
// the depot's own book.
//
// Same per-depot loop as /cash-position below (listTenants + getTenantDb),
// each read guarded so one unreachable branch DB cannot empty the report.
router.get('/payment-vouchers', hqAuth, (req, res) => {
  try {
    const from = String(req.query.from || '').slice(0, 10) || null;
    const to   = String(req.query.to   || '').slice(0, 10) || null;
    const only = String(req.query.slug || '').trim().toLowerCase();

    const where = ['1=1'];
    const args  = [];
    if (from) { where.push("substr(COALESCE(pv.date,''), 1, 10) >= ?"); args.push(from); }
    if (to)   { where.push("substr(COALESCE(pv.date,''), 1, 10) <= ?"); args.push(to); }
    const sqlFor = (whoCols) => `
      SELECT pv.id, pv.voucher_number, pv.date, pv.paid_to, pv.description,
             pv.category, pv.paid_from, pv.amount,
             pv.usd_amount, pv.fra_amount, pv.k_amount,
             pv.cash_amount, pv.momo_amount, pv.bank_amount,
             pv.deleted_at, ${whoCols},
             TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS created_by_name
        FROM payment_vouchers pv
        LEFT JOIN users u ON u.id = pv.created_by
       WHERE ${where.join(' AND ')}
       ORDER BY pv.date DESC, pv.id DESC`;
    // A book not yet migrated has no deleted_by_name / delete_reason columns.
    const tryAll = (db) => {
      try { return db.prepare(sqlFor('pv.deleted_by_name, pv.delete_reason')).all(...args); }
      catch {
        try { return db.prepare(sqlFor('NULL AS deleted_by_name, NULL AS delete_reason')).all(...args); }
        catch { return []; }
      }
    };

    // HQ's own book first, then every depot. The bare-domain tenant row is a
    // stale empty mirror — HQ's real book is defaultDb.
    const books = [{ slug: 'hq', name: 'Head Office', db: defaultDb }];
    for (const t of listTenants()) {
      if (/^(hq|keletedistributionzm)$/i.test(t.slug)) continue;
      try { books.push({ slug: t.slug, name: t.business_name || t.slug, db: getTenantDb(t.slug) }); }
      catch { /* branch DB unavailable — skip it, the rest still report */ }
    }

    const num = (v) => parseFloat(v || 0) || 0;
    const rows = [];
    const byDepot = new Map();
    const byType  = new Map();
    for (const b of books) {
      if (only && b.slug !== only) continue;
      for (const v of tryAll(b.db)) {
        // On a Kwacha-only book the slots are methods: Cash → usd_amount,
        // Mobile Money → fra_amount, Bank → k_amount, legacy columns as
        // the fallback (same mapping the depot's own PV page shows).
        const cash = num(v.usd_amount) || num(v.cash_amount);
        const momo = num(v.fra_amount) || num(v.momo_amount);
        const bank = num(v.k_amount)   || num(v.bank_amount);
        const total = (cash + momo + bank) || num(v.amount);
        const type = v.category || 'Other';
        const deleted = !!v.deleted_at;
        rows.push({
          depot_slug: b.slug, depot_name: b.name,
          id: v.id, voucher_number: v.voucher_number, date: v.date,
          paid_to: v.paid_to, description: v.description, category: type,
          paid_from: v.paid_from, created_by_name: v.created_by_name || '',
          cash, momo, bank, total,
          deleted, deleted_at: v.deleted_at || null,
          deleted_by_name: v.deleted_by_name || null, delete_reason: v.delete_reason || null,
        });
        if (deleted) continue;   // listed, but counted nowhere
        const d = byDepot.get(b.slug) || { slug: b.slug, name: b.name, total: 0, count: 0 };
        d.total += total; d.count += 1; byDepot.set(b.slug, d);
        const ty = byType.get(type) || { type, total: 0, count: 0 };
        ty.total += total; ty.count += 1; byType.set(type, ty);
      }
    }
    rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.id - a.id);

    res.json({
      rows,
      // Every book, so the depot filter lists depots with nothing today too.
      depots: books.map(b => ({ slug: b.slug, name: b.name })),
      totals: {
        total: rows.filter(r => !r.deleted).reduce((s, r) => s + r.total, 0),
        count: rows.filter(r => !r.deleted).length,
        by_depot: [...byDepot.values()].sort((a, b) => b.total - a.total),
        by_type:  [...byType.values()].sort((a, b) => b.total - a.total),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 2026-09-18 — expense approvals (Payment Voucher → Approvals tab) ──────
//
// A depot whose day's expenses would go over its limit sends the voucher here
// instead of saving it. Each request lives in that depot's own book
// (pv_expense_requests), so this reads every depot the same way the All Depots
// list above does. Approving lets the depot save that one voucher.
// 2026-09-22 — carry the voucher it became. A request that shows "Saved" said
// nothing about WHICH voucher, so a K175 approved on the 21st and saved on the
// 22nd looked missing: HQ showed the request under the 21st while the depot
// filed the PV under the day it was actually saved. The number and that date
// are both returned so the two lists can be reconciled without guesswork.
const expenseReqSql = (statusList) => `
  SELECT r.*,
         pv.voucher_number AS used_voucher_number,
         pv.date           AS used_voucher_date
    FROM pv_expense_requests r
    LEFT JOIN payment_vouchers pv
           ON pv.id = r.used_voucher_id
          AND pv.deleted_at IS NULL
   WHERE r.deleted_at IS NULL AND r.status IN (${statusList.map(() => '?').join(',')})
   ORDER BY r.id DESC LIMIT 200`;

function depotBooks(onlySlug) {
  const books = [];
  for (const t of listTenants()) {
    const slug = String(t.slug || '').toLowerCase();
    if (!slug || /^(hq|kelete|keletedistributionzm)$/.test(slug)) continue;
    if (onlySlug && slug !== onlySlug) continue;
    try { books.push({ slug, name: t.business_name || slug, db: getTenantDb(slug) }); }
    catch { /* unreachable depot — skip */ }
  }
  return books;
}

// ─── 2026-09-18 — each depot's daily expense limit, managed from HQ ────────
//
// GET  /api/hq/expense-limits              — every depot and its limit
// PUT  /api/hq/expense-limits/:slug        — { limit } (HQ Administrator)
// The limit lives in that depot's own business_settings, the same value its
// System Settings page shows; this just saves HQ visiting each depot's site.
router.get('/expense-limits', hqAuth, (req, res) => {
  try {
    const rows = [];
    for (const b of depotBooks()) {
      let limit = null;
      let spentToday = 0;
      try { limit = parseFloat(b.db.prepare('SELECT daily_expense_limit FROM business_settings LIMIT 1').get()?.daily_expense_limit); }
      catch (_) { limit = null; }   // depot not migrated yet
      try {
        spentToday = parseFloat(b.db.prepare(
          `SELECT COALESCE(SUM(amount), 0) AS t FROM payment_vouchers
            WHERE deleted_at IS NULL AND date = date('now')`
        ).get()?.t) || 0;
      } catch (_) { spentToday = 0; }
      rows.push({
        slug: b.slug, name: b.name,
        limit: isFinite(limit) && limit != null ? limit : null,
        spent_today: spentToday,
      });
    }
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/expense-limits/:slug', hqAuth, (req, res) => {
  try {
    if (req.user?.role !== 'Administrator') {
      return res.status(403).json({ error: 'Only an HQ Administrator can change a depot\'s expense limit.' });
    }
    const limit = Math.max(0, parseFloat(req.body?.limit) || 0);
    const book = depotBooks(String(req.params.slug || '').toLowerCase())[0];
    if (!book) return res.status(404).json({ error: `Depot ${req.params.slug} not found.` });
    try {
      book.db.prepare(
        "UPDATE business_settings SET daily_expense_limit = ?, updated_at = datetime('now'), synced = 0"
      ).run(limit);
    } catch (_) {
      // Older books have no updated_at/synced on this table.
      book.db.prepare('UPDATE business_settings SET daily_expense_limit = ?').run(limit);
    }
    res.json({ ok: true, slug: book.slug, name: book.name, limit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/expense-requests?status=pending|all&slug=
router.get('/expense-requests', hqAuth, (req, res) => {
  try {
    const status = String(req.query.status || 'pending').toLowerCase();
    const list = status === 'all' ? ['pending', 'approved', 'rejected', 'used'] : [status];
    const rows = [];
    for (const b of depotBooks(String(req.query.slug || '').toLowerCase())) {
      try {
        for (const r of b.db.prepare(expenseReqSql(list)).all(...list)) {
          rows.push({ ...r, depot_slug: b.slug, depot_name: b.name });
        }
      } catch (_) { /* depot not migrated yet */ }
    }
    rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    res.json({ rows, pending: rows.filter(r => r.status === 'pending').length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/expense-requests/pending-count — for the sidebar badge.
router.get('/expense-requests/pending-count', hqAuth, (req, res) => {
  let n = 0;
  for (const b of depotBooks()) {
    try { n += b.db.prepare("SELECT COUNT(*) AS c FROM pv_expense_requests WHERE status = 'pending' AND deleted_at IS NULL").get().c; }
    catch (_) { /* depot not migrated yet */ }
  }
  res.json({ count: n });
});

// POST /api/hq/expense-requests/:slug/:syncId/approve | /reject   { reason }
function decideExpenseRequest(req, res, verdict) {
  try {
    if (req.user?.role !== 'Administrator') {
      return res.status(403).json({ error: 'Only an HQ Administrator can approve or reject expense requests.' });
    }
    const slug = String(req.params.slug || '').toLowerCase();
    const book = depotBooks(slug)[0];
    if (!book) return res.status(404).json({ error: `Depot ${slug} not found.` });
    const row = book.db.prepare('SELECT * FROM pv_expense_requests WHERE sync_id = ? AND deleted_at IS NULL').get(req.params.syncId);
    if (!row) return res.status(404).json({ error: 'Request not found.' });
    if (row.status !== 'pending') return res.status(400).json({ error: `This request is already ${row.status}.` });
    const who = req.user?.name || [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || req.user?.email || 'HQ';
    const reason = String(req.body?.reason || '').trim();
    if (verdict === 'rejected' && reason.length < 3) {
      return res.status(400).json({ error: 'A reason (at least 3 characters) is required to reject.' });
    }
    book.db.prepare(
      `UPDATE pv_expense_requests
          SET status = ?, approver_name = ?, approved_at = datetime('now'),
              rejection_reason = ?, updated_at = datetime('now')
        WHERE id = ?`
    ).run(verdict, who, verdict === 'rejected' ? reason : null, row.id);
    // 2026-09-18 — tell the depot on their phone. The person waiting is the
    // one who raised it, and they are waiting to know whether they can pay.
    // Fire-and-forget: HQ's decision is saved either way.
    try {
      const { notifyUser } = require('../services/notify');
      const money = `K${Number(row.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      notifyUser(book.db, row.requested_by, {
        title: verdict === 'approved' ? 'Expense approved' : 'Expense rejected',
        body: verdict === 'approved'
          ? `${money} approved by ${who}. You can raise the voucher now.`
          : `${money} rejected by ${who}: ${reason}`,
        data: { type: 'expense-decision', status: verdict, sync_id: row.sync_id },
        channelId: 'kelete-approvals-v1',
      }).catch(() => {});
    } catch (_) { /* never block the decision */ }
    res.json({ ok: true, status: verdict, depot: book.name, amount: row.amount });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
router.post('/expense-requests/:slug/:syncId/approve', hqAuth, (req, res) => decideExpenseRequest(req, res, 'approved'));
router.post('/expense-requests/:slug/:syncId/reject',  hqAuth, (req, res) => decideExpenseRequest(req, res, 'rejected'));

// DELETE /api/hq/payment-vouchers/:slug/:id   { reason }
//
// 2026-09-17 — HQ Administrator deletes a depot's PV from All Depots. The PV
// lives in that depot's own book ('hq' = HQ's book), so it is deleted there:
// the same soft delete as the depot's own Delete, plus who and why, and the
// day's profit recalculated in that book. The depot's Cash Book goes up by
// the amount, even when that day's Cash Report is already saved.
router.delete('/payment-vouchers/:slug/:id', hqAuth, (req, res) => {
  try {
    if (req.user?.role !== 'Administrator') {
      return res.status(403).json({ error: 'Only an HQ Administrator can delete a depot voucher.' });
    }
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'A reason (at least 3 characters) is required.' });

    const slug = String(req.params.slug || '').toLowerCase();
    const id = parseInt(req.params.id, 10);
    let db = null;
    if (slug === 'hq') db = defaultDb;
    else if (!/^(keletedistributionzm)$/.test(slug) && listTenants().some(t => String(t.slug).toLowerCase() === slug)) {
      db = getTenantDb(slug);
    }
    if (!db) return res.status(404).json({ error: `Depot ${slug} not found.` });

    const pv = db.prepare('SELECT id, voucher_number, date, tenant_id, deleted_at FROM payment_vouchers WHERE id = ?').get(id);
    if (!pv) return res.status(404).json({ error: 'Voucher not found.' });
    if (pv.deleted_at) return res.status(400).json({ error: `${pv.voucher_number} is already deleted.` });

    const who = req.user?.name || [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || req.user?.email || 'HQ';
    try {
      db.prepare(
        `UPDATE payment_vouchers
            SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0,
                deleted_by = ?, deleted_by_name = ?, delete_reason = ?
          WHERE id = ? AND deleted_at IS NULL`
      ).run(req.user?.id || null, who, reason, id);
    } catch (_) {
      // Book not migrated yet: delete without who/why rather than not at all.
      db.prepare(
        `UPDATE payment_vouchers SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
          WHERE id = ? AND deleted_at IS NULL`
      ).run(id);
    }

    const warnings = [];
    try {
      const date = String(pv.date || '').slice(0, 10);
      if (date) require('../config/database').runWithDb(db, () => recalculateDailyProfit(db, date, pv.tenant_id));
    } catch (e) {
      warnings.push(`Profit for that day was not recalculated: ${e.message}`);
    }
    res.json({ ok: true, voucher_number: pv.voucher_number, warnings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── 2026-09-12 — HQ consolidated VAT Transaction Report ────────────────
//
// GET /api/hq/vat-report?from=&to=&slug=&cats=A,B
//
// The depot VAT Transaction Report (GET /orders/vat-report), run in every
// depot's own book: the same line builder (services/vatReport.js), so the
// columns, the per-line VAT and the totals match what each depot prints.
// Each line is tagged with its depot. `slug` narrows to one depot, `cats` to
// ZRA tax categories. HQ sells nothing and the bare-domain tenant is a stale
// empty mirror, so neither is read; switched-off tenants are skipped. Each
// read is guarded so one unreachable depot cannot empty the report.
router.get('/vat-report', hqAuth, (req, res) => {
  try {
    const from = String(req.query.from || '').trim() || null;
    const to   = String(req.query.to   || '').trim() || null;
    const only = String(req.query.slug || '').trim().toLowerCase();
    const cats = new Set(String(req.query.cats || '').split(',')
      .map(s => s.trim().toUpperCase()).filter(Boolean));

    const books = [];
    for (const t of listTenants()) {
      if (/^(hq|keletedistributionzm)$/i.test(t.slug)) continue;
      if (Number(t.is_active ?? 1) === 0) continue;
      try { books.push({ slug: t.slug, name: t.business_name || t.slug, db: getTenantDb(t.slug) }); }
      catch { /* branch DB unavailable — skip it, the rest still report */ }
    }
    books.sort((a, b) => String(a.name).localeCompare(String(b.name)));

    // 2026-09-13 — totals always, lines on request and a page at a time. All
    // depots over a fortnight is ~24,000 lines; sending every one and drawing
    // them all froze the page, where HQ Sales Report (totals only) answers at
    // once. Each depot's totals (overall and per tax category) always come
    // back and are exact however many lines the page has drawn. lines=1 adds
    // the lines: with limit=N only that many from offset (the screen pages
    // 500 at a time), without limit every line (the exports, never drawn).
    const withLines = String(req.query.lines || '') === '1';
    const r2 = n => Math.round(n * 100) / 100;
    const lines = [];
    const summary = [];
    const totals = { invoices: 0, lines: 0, excl: 0, vat: 0, total: 0 };
    for (const b of books) {
      if (only && b.slug !== only) continue;
      let depotLines = [];
      try { depotLines = buildVatLines(b.db, { from, to }); } catch { depotLines = []; }
      const s = { slug: b.slug, name: b.name, invoices: 0, lines: 0, excl: 0, vat: 0, total: 0, by_cat: {} };
      const invoices = new Set();
      for (const l of depotLines) {
        if (cats.size && !cats.has(l.vat_category)) continue;
        invoices.add(l.invoice_number);
        s.lines += 1; s.excl += l.vat_excl; s.vat += l.vat_amount; s.total += l.total_inc;
        const c = s.by_cat[l.vat_category] || (s.by_cat[l.vat_category] = { lines: 0, excl: 0, vat: 0, total: 0 });
        c.lines += 1; c.excl += l.vat_excl; c.vat += l.vat_amount; c.total += l.total_inc;
        if (withLines) lines.push({ depot_slug: b.slug, depot_name: b.name, ...l });
      }
      s.invoices = invoices.size;
      s.excl = r2(s.excl); s.vat = r2(s.vat); s.total = r2(s.total);
      for (const c of Object.values(s.by_cat)) { c.excl = r2(c.excl); c.vat = r2(c.vat); c.total = r2(c.total); }
      totals.invoices += s.invoices; totals.lines += s.lines;
      totals.excl += s.excl; totals.vat += s.vat; totals.total += s.total;
      summary.push(s);
    }
    totals.excl = r2(totals.excl); totals.vat = r2(totals.vat); totals.total = r2(totals.total);

    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const limit  = Math.max(0, parseInt(req.query.limit, 10) || 0);   // 0 = every line
    const page   = withLines && limit > 0 ? lines.slice(offset, offset + limit) : lines;

    res.json({
      summary,
      totals,
      lines: page,
      total_lines: lines.length,
      offset: withLines && limit > 0 ? offset : 0,
      // Every depot, so the filter lists depots with no sales in range too.
      depots: books.map(b => ({ slug: b.slug, name: b.name })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/cash-position?to=YYYY-MM-DD
// 2026-09-13 (v3) — HQ sees each depot's Cash Book EXACTLY as the depot does.
// The figures come from computeCashBookStats, the same function behind the
// depot's own /api/cash-book/stats, run against that depot's database, so the
// two can never drift apart:
//   balance  = Cash & Cash Equivalent (opening + CR − PV − AP − confirmed
//              deposits; capital, loan and dividend moves included) at the
//              end of `to`, or up to now when `to` is not given
//   pending  = deposits sent to HQ and not confirmed yet. Shown beside the
//              balance, NOT taken off it: the depot's book only drops a
//              deposit once HQ confirms it.
//   ar_owed  = what customers still owe (computeArStats, the depot AR page)
router.get('/cash-position', hqAuth, (req, res) => {
  try {
    const database = require('../config/database');
    const { masterDb: mdb, listTenants: allTenants } = require('../config/masterDb');
    const { getTenantDb: tenantDbFor } = require('../config/tenantDb');
    const { computeCashBookStats } = require('./cashBook');
    const { computeArStats } = require('./customers');
    const { depositTargetFor } = require('../services/depositTarget');

    // 2026-09-13 — optional period. No `from` = from day one; no `to` = up to now.
    const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const from = isDay(req.query.from) ? String(req.query.from) : null;
    let to = isDay(req.query.to) ? String(req.query.to) : null;
    if (from && to && to < from) to = from;
    const num = (v) => Number(v) || 0;
    const r2 = (v) => Math.round(num(v) * 100) / 100;

    // Deposits HQ has not confirmed yet, split around the period:
    //   dated before `from` → the cash left the depot before the period began,
    //                          so it comes off the opening
    //   dated inside it     → part of the period's "Deposited"
    // The depot Cash Book itself only counts CONFIRMED deposits; these are the
    // HQ view's addition.
    // 2026-09-15 — inDep: the part of inT sent to another depot, not HQ.
    const pending = {};
    try {
      const rows = mdb.prepare(`
        SELECT from_slug, to_slug, amount, date(COALESCE(deposit_date, created_at)) AS d
          FROM cash_deposits
         WHERE status = 'PENDING' AND deleted_at IS NULL
      `).all();
      for (const p of rows) {
        if (to && p.d > to) continue;
        const key = String(p.from_slug || '').toLowerCase();
        const s = pending[key] || (pending[key] = { before: 0, inT: 0, inN: 0, inDep: 0 });
        if (from && p.d < from) s.before += num(p.amount);
        else {
          s.inT += num(p.amount); s.inN += 1;
          if (String(p.to_slug || '').trim()) s.inDep += num(p.amount);
        }
      }
    } catch (e) {
      console.error('[hq/cash-position] pending deposits:', e.message);
    }

    // 2026-09-15 — confirmed deposits between depots inside the period (System
    // Settings → Deposit to). The sender's part is inside its Cash Book
    // deposits; the receiver's is inside its balance. Split out here so HQ's
    // "Deposited to HQ" counts only what reached HQ.
    const between = { out: {}, in: {}, inFrom: {} };
    try {
      const depPred = `date(COALESCE(deposit_date, confirmed_at, created_at))`;
      const rows = mdb.prepare(`
        SELECT from_slug, from_name, to_slug, amount
          FROM cash_deposits
         WHERE status = 'CONFIRMED' AND deleted_at IS NULL AND COALESCE(to_slug, '') != ''
           ${from ? `AND ${depPred} >= ?` : ''} ${to ? `AND ${depPred} <= ?` : ''}
      `).all(...(from ? [from] : []), ...(to ? [to] : []));
      for (const r of rows) {
        const f = String(r.from_slug || '').toLowerCase();
        const tt = String(r.to_slug || '').toLowerCase();
        between.out[f] = num(between.out[f]) + num(r.amount);
        between.in[tt] = num(between.in[tt]) + num(r.amount);
        (between.inFrom[tt] = between.inFrom[tt] || new Set()).add(r.from_name || f);
      }
    } catch (e) {
      console.error('[hq/cash-position] deposits between depots:', e.message);
    }

    const SKIP = new Set(['hq', 'kelete', 'keletedistributionzm']);
    const depots = [];
    for (const t of allTenants()) {
      const slug = String(t.slug || '').toLowerCase();
      if (!slug || SKIP.has(slug) || t.is_active === 0) continue;
      const name = t.business_name || t.name || slug;
      try {
        const tdb = tenantDbFor(slug);
        const { cb, ar } = database.runWithDb(tdb, () => {
          // Same tenant id the depot's own login puts on the user (auth.js).
          const cfg = (k) => (tdb.prepare('SELECT value FROM sync_config WHERE key = ?').get(k) || {}).value;
          const tenantId = cfg(`tenant:${slug}`) || cfg('tenant_id') || 'local-only';
          return {
            cb: computeCashBookStats({ tenantId, slug, from: from || undefined, to: to || undefined }),
            ar: computeArStats({ tenantId, to: to || undefined }),
          };
        });
        const m = cb.currentByMethod || {};
        const balance = num(m.cash) + num(m.momo) + num(m.bank);
        const out = (cb.depositsByCcy && cb.depositsByCcy.out) || {};
        const deposits = num(out.usd) + num(out.fra) + num(out.k);
        // The depot Cash Book's own figures for the period. With `from`, its
        // opening already carries everything before the period (CR − PV − AP −
        // confirmed deposits), exactly as the depot's Cash Book shows it.
        const bookOpening = num(cb.openingBalance);
        const receipts = num(cb.totalReceipts) + num(cb.totalCapIn) + num(cb.totalLoanIn);
        const payments = num(cb.totalPayments);
        const pd = pending[slug] || { before: 0, inT: 0, inN: 0, inDep: 0 };
        // The HQ card: every deposit counts the day it was sent, confirmed or not.
        //   Opening   = book opening − pending deposits sent before the period
        //   Deposited = confirmed + pending deposits inside the period
        //   Balance   = Opening + In + Received − Out − Deposited
        //             = the depot's Cash Book balance − every pending deposit up to `to`
        // 2026-09-15 — Deposited is split into to HQ and to other depots, and
        // Received is what other depots deposited here (confirmed).
        const opening = bookOpening - pd.before;
        const toDepotsConfirmed = num(between.out[slug]);
        const received = num(between.in[slug]);
        const sentToDepots = toDepotsConfirmed + pd.inDep;
        const sentToHq = (deposits - toDepotsConfirmed) + (pd.inT - pd.inDep);
        const cashLeft = balance - pd.before - pd.inT;
        const target = depositTargetFor(slug);
        depots.push({
          slug, name,
          opening: r2(opening),
          receipts: r2(receipts),
          payments: r2(payments),
          deposits: r2(deposits),
          // Transfers between Cash / MoMo / Bank net to zero across the book;
          // anything left here is shown so the card still adds up.
          other: r2(cashLeft - (opening + receipts + received - payments - sentToHq - sentToDepots)),
          balance: r2(balance),
          book_opening: r2(bookOpening),
          cash_left: r2(cashLeft),
          sent_to_hq: r2(sentToHq),
          sent_to_depots: r2(sentToDepots),
          received_from_depots: r2(received),
          received_from: [...(between.inFrom[slug] || [])],
          deposit_to_name: target ? target.name : null,
          pending_deposits: r2(pd.inT),
          pending_count: pd.inN,
          pending_before: r2(pd.before),
          ar_owed: r2(ar.outstanding),
          owing_customers: num(ar.owingCount),
        });
      } catch (e) {
        depots.push({ slug, name, error: e.message });
      }
    }

    const totals = { opening: 0, receipts: 0, payments: 0, deposits: 0, other: 0, balance: 0, cash_left: 0, sent_to_hq: 0, sent_to_depots: 0, received_from_depots: 0, pending_deposits: 0, pending_count: 0, ar_owed: 0, owing_customers: 0 };
    for (const d of depots) if (!d.error) for (const k of Object.keys(totals)) totals[k] += num(d[k]);
    for (const k of Object.keys(totals)) totals[k] = r2(totals[k]);

    res.json({ as_of: new Date().toISOString(), from, to, depots, totals });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── v1.8.65 — HQ Transit Variances ─────────────────────────────────────────
// Unified list of variance rows from BOTH:
//   - master.db.transfer_variances (Inter-Branch Transfers)
//   - master.db.hq_purchase_items WHERE received_qty < dispatched_qty OR
//     reason IN ('Damaged','Lost') (HQ Purchases dropshipped to branches)
// Each row carries: source ('TRANSFER' | 'HQ_PURCHASE'), branch slugs,
// product, sent/received/variance qty, reason, notes, status (OPEN | RESOLVED).
// Filters: ?source=, ?reason=, ?status=, ?slug= (matches either from/to).
router.get('/variances', hqAuth, (req, res) => {
  try {
    const { source, reason, status, slug } = req.query || {};
    // Transfer variances
    let transferRows = [];
    if (!source || source === 'TRANSFER') {
      const where = ['1=1'];
      const params = [];
      if (reason) { where.push('reason = ?'); params.push(reason); }
      if (slug)   { where.push('(from_slug = ? OR to_slug = ?)'); params.push(slug, slug); }
      if (status === 'OPEN')     where.push('resolved_at IS NULL');
      if (status === 'RESOLVED') where.push('resolved_at IS NOT NULL');
      transferRows = masterDb.prepare(`
        SELECT
          'TRANSFER'        AS source,
          id, sync_id, transfer_sync_id, transfer_number,
          from_slug, to_slug,
          product_sync_id, product_name, unit,
          sent_qty, received_qty, variance_qty,
          reason, notes,
          received_by, received_by_name,
          created_at,
          resolved_at, resolution
        FROM transfer_variances
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
      `).all(...params);
    }

    // HQ purchase variances — items where the count doesn't match.
    let purchaseRows = [];
    if (!source || source === 'HQ_PURCHASE') {
      const where = [
        "(COALESCE(received_qty, dispatched_qty) < dispatched_qty OR reason IN ('Damaged','Lost'))",
        "pi.status IN ('GRN_SUBMITTED','CONFIRMED')",
      ];
      const params = [];
      if (reason) { where.push('reason = ?'); params.push(reason); }
      if (slug)   { where.push('destination_slug = ?'); params.push(slug); }
      // No resolved-tracking on purchase items yet — treat all as OPEN.
      if (status === 'RESOLVED') where.push('1=0');
      purchaseRows = masterDb.prepare(`
        SELECT
          'HQ_PURCHASE'        AS source,
          pi.id,
          NULL                 AS sync_id,
          NULL                 AS transfer_sync_id,
          p.purchase_number    AS transfer_number,
          'hq'                 AS from_slug,
          pi.destination_slug  AS to_slug,
          pi.product_sync_id, pi.product_name, pi.unit,
          pi.dispatched_qty    AS sent_qty,
          COALESCE(pi.received_qty, pi.dispatched_qty) AS received_qty,
          (pi.dispatched_qty - COALESCE(pi.received_qty, pi.dispatched_qty)) AS variance_qty,
          COALESCE(pi.reason,
            CASE WHEN COALESCE(pi.received_qty, pi.dispatched_qty) < pi.dispatched_qty THEN 'Short' ELSE 'OK' END
          ) AS reason,
          pi.variance_notes    AS notes,
          pi.received_by, pi.received_by_name,
          pi.received_at       AS created_at,
          NULL                 AS resolved_at,
          NULL                 AS resolution
        FROM hq_purchase_items pi
        -- 2026-08-28 — join on sync_id, NOT the integer id. purchase_id holds
        -- HQ's row number; on a synced mirror the local hq_purchases row has a
        -- DIFFERENT auto-number, so p.id = i.purchase_id matches the wrong
        -- purchase or none at all. Measured on a real till: of 20 items the
        -- id join matched 12, and SEVEN of those were attached to the wrong
        -- purchase; the sync_id join matched all 20 correctly. The OR arm is
        -- a fallback for any legacy row that never got a sync_id.
        LEFT JOIN hq_purchases p
               ON (p.sync_id = pi.purchase_sync_id
                   OR (pi.purchase_sync_id IS NULL AND p.id = pi.purchase_id))
        WHERE ${where.join(' AND ')}
        ORDER BY pi.received_at DESC
      `).all(...params);
    }

    const all = [...transferRows, ...purchaseRows]
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    res.json({
      variances: all,
      stats: {
        total: all.length,
        open:  all.filter(v => !v.resolved_at).length,
        short:    all.filter(v => v.reason === 'Short').length,
        damaged:  all.filter(v => v.reason === 'Damaged').length,
        lost:     all.filter(v => v.reason === 'Lost').length,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/hq/variances/transfer/:syncId/resolve
// v1.13.47 — Option C: on WRITE_OFF, actually book the loss as a damage
// on the chosen branch's daily profit (source or destination — HQ picks).
// RECOVERED remains no-op on P&L (stock re-entry is done manually via
// Stock Reconciliation at whichever branch got the physical goods back).
//
// Request body:
//   resolution:    'WRITE_OFF' | 'RECOVERED'  (required)
//   absorbed_by:   'source' | 'destination'   (required when WRITE_OFF)
//   notes:         optional free text
router.put('/variances/transfer/:syncId/resolve', hqAuth, (req, res) => {
  try {
    const { resolution, notes, absorbed_by } = req.body || {};
    const allowed = new Set(['WRITE_OFF', 'RECOVERED']);
    if (!allowed.has(resolution)) {
      return res.status(400).json({ error: 'resolution must be WRITE_OFF or RECOVERED' });
    }
    if (resolution === 'WRITE_OFF' && !['source', 'destination'].includes(absorbed_by)) {
      return res.status(400).json({ error: 'WRITE_OFF requires absorbed_by = "source" or "destination"' });
    }
    const row = masterDb.prepare('SELECT * FROM transfer_variances WHERE sync_id = ?').get(req.params.syncId);
    if (!row) return res.status(404).json({ error: 'Variance not found' });
    if (row.resolved_at) return res.status(400).json({ error: 'Already resolved' });

    let absorbedSlug = null;
    if (resolution === 'WRITE_OFF') {
      absorbedSlug = absorbed_by === 'source' ? row.from_slug : row.to_slug;
      const branchDb = getTenantDb(absorbedSlug);
      if (!branchDb) {
        return res.status(400).json({ error: `Absorbing branch "${absorbedSlug}" not registered` });
      }

      // Look up the branch's local product_id (FK on stock_movements).
      const prod = branchDb.prepare(
        'SELECT id, tenant_id FROM products WHERE sync_id = ? AND deleted_at IS NULL'
      ).get(row.product_sync_id);
      if (!prod) {
        return res.status(400).json({
          error: `Product ${row.product_name} (sync_id ${row.product_sync_id}) not found at branch ${absorbedSlug}. Cannot book write-off.`,
        });
      }

      // Movement is P&L-only. location='books_only' keeps it out of every
      // inventory sum (they all filter location='sales' or 'store'), so
      // current_stock stays truthful. profitHelper's damages query is
      // widened below to pick up movement_type='transit_writeoff' regardless
      // of location, so this row still hits daily_profit_summary.damages.
      const today = new Date().toISOString().split('T')[0];
      const varianceBaseQty = parseFloat(row.variance_qty) || 0;
      const movementNotes = `Transit variance write-off · ${row.transfer_number} · ${row.reason}${row.notes ? ' · ' + row.notes : ''}${notes ? ' · HQ: ' + notes : ''}`;
      branchDb.prepare(`
        INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                     quantity, reference_type, reference_sync_id, notes,
                                     created_by, sync_id, tenant_id, branch_id, device_id,
                                     synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(
        // v1.13.56 — created_by must reference a user on THIS branch's users
        // table. HQ users only exist in HQ auth, so req.user.id blows the
        // FK. row.received_by exists on the RECEIVER'S DB but not the
        // sender's, so it's not safe either when absorbed_by='source'.
        // Safest: NULL. Audit trail is preserved in transfer_variances
        // (received_by + received_by_name + resolved_at metadata).
        prod.id, row.product_sync_id, 'books_only', 'transit_writeoff',
        -varianceBaseQty, 'transfer_variance', row.sync_id, movementNotes,
        null, randomUUID(), prod.tenant_id, null, null
      );

      // Refresh the branch's daily profit for today so the loss shows up
      // immediately on the Cash Report / profit summary.
      recalculateDailyProfit(branchDb, today, prod.tenant_id);
    }

    masterDb.prepare(`
      UPDATE transfer_variances
         SET resolved_at      = datetime('now'),
             resolution       = ?,
             absorbed_by_slug = ?,
             notes            = COALESCE(?, notes)
       WHERE sync_id = ?
    `).run(resolution, absorbedSlug, notes || null, req.params.syncId);
    res.json({ ok: true, absorbed_by_slug: absorbedSlug });
  } catch (e) {
    console.error('[hq.variances.resolve] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── v1.9.0 — Layer 3: HQ admin Refresh button ──────────────────────────────
// Manual on-demand mirror of every HQ-owned entity (main_categories,
// categories, units, products) to every registered branch. Idempotent —
// safe to run any time, never overwrites branch-owned columns (prices /
// stock / status / notes). Same helper feeds the boot heal (Layer 1) and
// the on-register auto-mirror (Layer 2); the difference is just who
// triggers it.
//
// Optional ?slug=<branch> targets a single branch instead of all of them
// (e.g. for a "Resync mansa1 only" action from a future UI). When the
// query is omitted, every active tenant gets the sweep.
router.post('/mirror-all', hqAuth, (req, res) => {
  try {
    const slug = (req.query.slug || req.body?.slug || '').toString().trim().toLowerCase();
    const t0 = Date.now();
    const result = mirrorAllHqToBranches(defaultDb, {
      listTenants,
      getTenantDb,
      targetSlug: slug || null,
    });
    res.json({
      ok: true,
      elapsed_ms: Date.now() - t0,
      ...result,
    });
  } catch (e) {
    console.error('[hq.mirror-all] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── v1.13.62 — HQ Consolidated Profit ─────────────────────────────────────
// Group Net = SUM(branch net_profit) − HQ overhead (all K, no FX).
// Kelete is K-only across every branch, so there's no per-day currency
// conversion (contrast Kelete, which needs Kassumbalesa's USD/K rate). HQ
// overhead = SUM(payment_vouchers.amount). Kelete has no LCV concept, so
// no is_landed_cost exclusion is applied.
// 2026-09-15 — HQConsolidatedProfit permission enforced here, not just in the menu.
router.get('/consolidated-profit', hqAuth, requirePagePerm('HQConsolidatedProfit'), (req, res) => {
  try {
    const from = (req.query.from || new Date().toISOString().slice(0, 10)).toString();
    const to   = (req.query.to   || from).toString();

    const tenants = listTenants();

    // Enumerate every date in the range (inclusive).
    const dates = [];
    {
      const start = new Date(from + 'T00:00:00Z');
      const end   = new Date(to   + 'T00:00:00Z');
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        dates.push(d.toISOString().slice(0, 10));
      }
    }

    // Per branch: daily rows + range totals.
    const branches = [];
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const settings = tryGet(db, `SELECT business_name FROM business_settings LIMIT 1`) || {};
        const name = settings.business_name || t.business_name || t.slug;

        const dailyRows = db.prepare(`
          SELECT date, revenue, cogs, damages, gross_profit, pv_total, net_profit
            FROM daily_profit_summary
           WHERE date BETWEEN ? AND ?
        ORDER BY date
        `).all(from, to);
        const byDate = new Map(dailyRows.map(r => [r.date, r]));

        const daily = [];
        let sumRev = 0, sumCogs = 0, sumGross = 0, sumPv = 0, sumNet = 0;
        for (const d of dates) {
          const r = byDate.get(d);
          const revenue = parseFloat(r?.revenue      || 0);
          const cogs    = parseFloat(r?.cogs         || 0);
          const gross   = parseFloat(r?.gross_profit || 0);
          const pv      = parseFloat(r?.pv_total     || 0);
          const net     = parseFloat(r?.net_profit   || 0);
          daily.push({ date: d, revenue, cogs, gross, pv, net });
          sumRev += revenue; sumCogs += cogs; sumGross += gross; sumPv += pv; sumNet += net;
        }

        branches.push({
          slug: t.slug, name,
          totals: { revenue: sumRev, cogs: sumCogs, gross: sumGross, pv: sumPv, net: sumNet },
          daily,
        });
      } catch (e) {
        console.error(`[hq.consolidated-profit] ${t.slug}:`, e.message);
      }
    }

    // HQ Overhead — payment_vouchers on defaultDb. All K (no currency
    // split on Kelete). No LCV exclusion (Kelete has no LCVs).
    let hqDailyRows = [];
    try {
      hqDailyRows = defaultDb.prepare(`
        SELECT date, COALESCE(SUM(amount), 0) AS pv_total
          FROM payment_vouchers
         WHERE deleted_at IS NULL
           AND date BETWEEN ? AND ?
      GROUP BY date
      `).all(from, to);
    } catch (e) {
      try {
        hqDailyRows = defaultDb.prepare(`
          SELECT date, COALESCE(SUM(amount), 0) AS pv_total
            FROM payment_vouchers
           WHERE date BETWEEN ? AND ?
        GROUP BY date
        `).all(from, to);
      } catch (e2) {
        console.error('[hq.consolidated-profit] HQ PVs read failed:', e2.message);
      }
    }
    const hqByDate = new Map(hqDailyRows.map(r => [r.date, parseFloat(r.pv_total || 0)]));
    const hqDaily = [];
    let hqTotal = 0;
    for (const d of dates) {
      const amount = hqByDate.get(d) || 0;
      hqDaily.push({ date: d, amount });
      hqTotal += amount;
    }

    const branchNet = branches.reduce((s, b) => s + b.totals.net, 0);
    const groupNet  = branchNet - hqTotal;

    res.json({
      from, to,
      reporting_currency: 'K',
      branches,
      hq_overhead: { total: hqTotal, daily: hqDaily },
      group_net: groupNet,
    });
  } catch (error) {
    console.error('[hq.consolidated-profit] failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
