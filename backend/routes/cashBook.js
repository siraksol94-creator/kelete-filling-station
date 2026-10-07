const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const bcrypt = require('bcrypt');
// v1.8.61 â€” Cash Book also surfaces HQ Deposits (master.db) so the
// branch's ledger reflects cash leaving its drawer, and HQ's ledger
// reflects cash arriving. Neutral entries â€” no P&L impact.
let masterDb = null;
try { masterDb = require('../config/masterDb').masterDb; } catch (_) { /* offline mode */ }

const HQ_INBOX_SLUGS = new Set(['hq', 'kelete', 'keletedistributionzm']);

// v1.13.22 (port from Kelete v1.10.171) â€” belt-and-suspenders check: if
// the request is for an HQ host, force isLiquorK=false regardless of
// what business_settings.currency_mode says. Prevents an HQ instance
// mis-shipped with currency_mode='K' from silently dropping K amounts.
function isHqRequest(req) {
  try {
    const slug = String(req.query?.slug || '').toLowerCase();
    if (HQ_INBOX_SLUGS.has(slug)) return true;
    const host = String(req.hostname || req.headers?.host || '').toLowerCase();
    if (host === 'keletezm.com' || host === 'www.keletezm.com') return true;
    return false;
  } catch (_) { return false; }
}
// 2026-08-29 â€” Kelete trades in Kwacha only. Every branch is K, and so is HQ
// ("Kelete is a single-currency system â€” every branch operates in Kwacha").
//
// The three drawer columns (cash_amount / bank_amount / momo_amount) were
// being repurposed to carry USD / K / FRA whenever this returned false, which
// it ALWAYS did on an HQ host. That is Kelete's design and correct there â€” HQ
// is tri-currency and has no drawers, so it borrows the three columns to show
// three currencies. On Kelete it meant the Cash Book tiles labelled Cash on
// Hand / Mobile Money / Bank were actually showing USD / FRA / Kwacha: two
// that can never be anything but zero, and every Kwacha landing in "Bank"
// regardless of how it was really paid.
//
// So: K-only unless the tenant explicitly says otherwise, HQ included. The
// default matters â€” an unset currency_mode at HQ must mean Kwacha here, not
// "fall back to the three-currency layout".
const MULTI_CCY_MODES = new Set(['USD+FRA', 'USD+FRA+K']);
function isKOnly(db) {
  try {
    const bs = db.prepare(`SELECT currency_mode FROM business_settings ORDER BY id ASC LIMIT 1`).get();
    return !MULTI_CCY_MODES.has(String(bs?.currency_mode || '').toUpperCase());
  } catch (_) { return true; }   // pre-migration DB â€” Kelete is K
}

function detectLiquorK(db, req) {
  // The HQ short-circuit that used to live here is gone â€” see isKOnly above.
  return isKOnly(db);
}

// Opening balances are stored as up to 3 rows in cash_book with type='opening':
//   reference='OB-CASH' / 'OB-BANK' / 'OB-MOMO'
// A pre-existing single 'OB' row (legacy) is treated as the Cash opening.
function getOpeningByMethod(tenantId) {
  const rows = db.prepare(
    "SELECT reference, COALESCE(receipt_amount, 0) AS amount FROM cash_book WHERE type = 'opening' AND deleted_at IS NULL AND tenant_id = ?"
  ).all(tenantId);
  const out = { cash: 0, bank: 0, momo: 0 };
  for (const r of rows) {
    const ref = (r.reference || '').toUpperCase();
    if (ref === 'OB-BANK') out.bank += parseFloat(r.amount);
    else if (ref === 'OB-MOMO') out.momo += parseFloat(r.amount);
    else if (ref === 'OB-CASH' || ref === 'OB') out.cash += parseFloat(r.amount);
    // v1.10.25 â€” OB-USD / OB-FRA / OB-K are Kelete per-currency openings.
    // They belong to openingByCcy only. The previous fallback lumped them
    // all into `cash`, so on Kelete the "opening balance" became a raw
    // USD+FRA+K sum (e.g. 23,775 + 196,000 + 3,980 = 223,755) which the
    // ledger's Balance column then showed as a $-amount â€” nonsense.
  }
  return out;
}

// v1.8.62 â€” per-currency opening balance for Kelete (USD / FRA / K).
// New references: 'OB-USD', 'OB-FRA', 'OB-K'. Legacy 'OB' / 'OB-CASH' rows
// fall through as USD so existing tenants don't lose their opening cash.
// 'OB-BANK' and 'OB-MOMO' (Liquor/Butchery) are ignored here â€” Kelete's
// drawers are physical USD/FRA/K, not method buckets.
function getOpeningByCurrency(tenantId) {
  const rows = db.prepare(
    "SELECT reference, COALESCE(receipt_amount, 0) AS amount FROM cash_book WHERE type = 'opening' AND deleted_at IS NULL AND tenant_id = ?"
  ).all(tenantId);
  const out = { usd: 0, fra: 0, k: 0 };
  for (const r of rows) {
    const ref = (r.reference || '').toUpperCase();
    if      (ref === 'OB-USD' || ref === 'OB-CASH' || ref === 'OB') out.usd += parseFloat(r.amount);
    else if (ref === 'OB-FRA') out.fra += parseFloat(r.amount);
    else if (ref === 'OB-K')   out.k   += parseFloat(r.amount);
  }
  return out;
}

// v1.10.25 â€” Per-currency receipts + payments for an arbitrary date clause.
// Used to fold pre-period activity into openingByCcy so opening on day N
// equals closing on day N-1.
//
// SOURCES MUST MATCH THE LEDGER UNION in GET / â€” the ledger only shows
// cash_receipts (CR), payment_vouchers (PV), ap_payments (AP) and HQ
// deposits. It does NOT show orders.cash_received. So opening = ledger
// closing requires this helper to skip orders too.
//
// v1.10.27 â€” Removed orders. On Kelete every POS sale creates BOTH an
// orders row (with cash_received/fra_received/k_received) and a cash_receipt
// row that appears in the ledger. /stats accidentally avoids double-counting
// because its `date <= to` clause on orders' paid_at (a datetime, not date)
// fails to match same-day rows with a time component. My earlier
// `date < from` clause matched both â†’ every fold double-counted every POS
// sale, so Jul 2 opening = Jul 1 opening + Jul 1 receipts (twice) instead of
// Jul 1 closing.
// v1.10.98 â€” reverted the isLiquorTenant() helper introduced in v1.10.91.
// The Liquor-specific column swaps in ccyReceiptsPayments / sumMethod /
// /ledger UNION produced doubled stats (Payments (PV) K120 vs actual K60)
// and mis-anchored per-currency balances (ledger jump K78,360 on a
// K36,395 DEP-OUT). Pre-v1.10.91 behaviour was correct because Liquor
// writes drawer amounts to usd_amount, and the single-column reads
// captured them cleanly. Keeping the frontend PaymentVoucher.js v1.10.91
// column-header fix (that one is safe â€” it only affects display).

function ccyReceiptsPayments(tenantId, slug, dateClause, dateParams) {
  const receipts = { usd: 0, fra: 0, k: 0 };
  const payments = { usd: 0, fra: 0, k: 0 };
  const num = (v) => parseFloat(v || 0) || 0;
  // v1.13.22 (port from Kelete v1.10.156â†’v1.10.163): on Liquor branches
  // Cash Receipts store K amounts in cash_amount / bank_amount / momo_amount
  // (all three are K on Liquor). Sum ALL THREE for K; force USD/FRA to 0 so
  // mirror columns don't double-count. HQ override protects HQ instances
  // mis-shipped with currency_mode='K'.
  const isLiquorK = isKOnly(db);
  const usdExprCR = isLiquorK
    ? `0`
    : `CASE WHEN COALESCE(usd_amount,0) > 0 THEN usd_amount WHEN COALESCE(k_amount,0) > 0 THEN 0 ELSE COALESCE(cash_amount,0) END`;
  const kExprCR = isLiquorK
    ? `COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0)`
    : `COALESCE(k_amount, 0)`;
  // CR â€” cash_receipts.
  receipts.usd += num(db.prepare(`SELECT COALESCE(SUM(${usdExprCR}), 0) AS t FROM cash_receipts WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  receipts.fra += num(db.prepare(`SELECT COALESCE(SUM(${isLiquorK ? '0' : 'fra_amount'}), 0) AS t FROM cash_receipts WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  receipts.k   += num(db.prepare(`SELECT COALESCE(SUM(${kExprCR}), 0) AS t FROM cash_receipts WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  // PV â€” payment_vouchers.
  payments.usd += num(db.prepare(`SELECT COALESCE(SUM(${usdExprCR}), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  payments.fra += num(db.prepare(`SELECT COALESCE(SUM(${isLiquorK ? '0' : 'fra_amount'}), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  payments.k   += num(db.prepare(`SELECT COALESCE(SUM(${kExprCR}), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  // v1.10.78 â€” AP payments now support triple-currency (usd/fra/k) on HQ
  // via the ap_payments columns added in the same version. Route each
  // currency to its own bucket; rows that pre-date v1.10.78 (only
  // amount populated, usd/fra/k = 0) fall back to k_out (legacy K-only
  // behaviour matching v1.10.77).
  payments.usd += num(db.prepare(`SELECT COALESCE(SUM(usd_amount), 0) AS t FROM ap_payments WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  payments.fra += num(db.prepare(`SELECT COALESCE(SUM(fra_amount), 0) AS t FROM ap_payments WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t);
  payments.k   += num(db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN (COALESCE(usd_amount,0) + COALESCE(fra_amount,0) + COALESCE(k_amount,0)) > 0
        THEN COALESCE(k_amount, 0)
        ELSE amount END
    ), 0) AS t
      FROM ap_payments
     WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}
  `).get(tenantId, ...dateParams).t);
  // v1.10.42 â€” book-scope currency exchanges. Same shape as the ledger
  // UNION addition: from_currency â†’ payments, to_currency â†’ receipts.
  // Append-only, no deleted_at filter.
  const exchRows = db.prepare(`
    SELECT from_currency, from_amount, to_currency, to_amount
      FROM currency_exchanges
     WHERE scope = 'book' AND tenant_id = ?${dateClause}
  `).all(tenantId, ...dateParams);
  for (const r of exchRows) {
    const fromKey = r.from_currency === 'USD' ? 'usd' : r.from_currency === 'FRA' ? 'fra' : 'k';
    const toKey   = r.to_currency   === 'USD' ? 'usd' : r.to_currency   === 'FRA' ? 'fra' : 'k';
    payments[fromKey] += num(r.from_amount);
    receipts[toKey]   += num(r.to_amount);
  }
  // HQ deposits (master.db). Branches: outgoing â†’ payment. HQ: incoming â†’ receipt.
  if (masterDb && slug) {
    try {
      const datePred = `date(COALESCE(deposit_date, confirmed_at, created_at))`;
      const depClause = dateClause.replace(/\bdate\b/g, datePred);
      const outRows = masterDb.prepare(`
        SELECT currency, COALESCE(SUM(amount), 0) AS t
          FROM cash_deposits
         WHERE status = 'CONFIRMED' AND deleted_at IS NULL AND from_slug = ?${depClause}
         GROUP BY currency
      `).all(slug, ...dateParams);
      for (const r of outRows) {
        const key = r.currency === 'USD' ? 'usd' : r.currency === 'FRA' ? 'fra' : 'k';
        payments[key] += num(r.t);
      }
      // 2026-09-15 â€” incoming. HQ receives the deposits sent to HQ (no to_slug);
      // a depot receives the ones other depots sent to it (System Settings â†’
      // Deposit to). HQ used to count every confirmed deposit.
      {
        const isHqBook = HQ_INBOX_SLUGS.has(slug);
        const inRows = masterDb.prepare(`
          SELECT currency, COALESCE(SUM(amount), 0) AS t
            FROM cash_deposits
           WHERE status = 'CONFIRMED' AND deleted_at IS NULL
             AND ${isHqBook ? "COALESCE(to_slug, '') = ''" : 'to_slug = ?'}${depClause}
           GROUP BY currency
        `).all(...(isHqBook ? [] : [slug]), ...dateParams);
        for (const r of inRows) {
          const key = r.currency === 'USD' ? 'usd' : r.currency === 'FRA' ? 'fra' : 'k';
          receipts[key] += num(r.t);
        }
      }
    } catch (e) {
    // 2026-08-28 â€” log it. This used to swallow silently, and a single
    // missing column meant deposits vanished from the Cash Book on BOTH
    // sides with nothing to show anyone was wrong.
    console.error('[cashBook] deposit rollup failed:', e.message);
  }
  }
  return { receipts, payments };
}

// Sum a money column across all inflow/outflow tables with optional date filter.
// Capital Injection + Loan Disbursement â†’ inflow (like CR).
// Capital Drawing + Dividend + Loan Principal + Loan Interest â†’ outflow (like PV).
// Also computes net transfer effect for this method (in - out).
function sumMethod(tenantId, methodCol, dateClause, dateParams, hqSlug) {
  // v1.10.99 â€” CR / PV / AP tables carry BOTH currency columns
  // (usd/fra/k) and method columns (cash/bank/momo). On Liquor, the
  // modal writes drawer amounts into the currency column and leaves the
  // method column at 0 â€” pre-v1.10.99 sumMethod summed only the method
  // column, so any modern-modal Liquor PV/CR silently missed the stats
  // card even though it appeared in the ledger. Use the same CASE
  // fallback the ledger UNION uses so both eras count once.
  //
  // v1.10.165 (ported v1.13.22) â€” on Liquor branches the mirror
  // OR-fallback double-counts corrupted rows (row with both fra_amount
  // mirror AND cash_amount legacy showed as MoMo AND Cash for the same
  // payment). Trust ONLY the legacy method columns on Liquor: manual
  // Liquor PVs/CRs fill both sets identically so this reads the same
  // number for a clean row, but silently ignores the redundant mirror.
  //
  // v1.10.171 (ported) â€” HQ override: if the caller passed an HQ slug,
  // force isLiquorK=false regardless of currency_mode. Prevents HQ
  // ever falling into the Liquor code path.
  const isLiquorK = isKOnly(db);
  const cxMap = isLiquorK ? {
    cash_amount: 'COALESCE(cash_amount, 0)',
    bank_amount: 'COALESCE(bank_amount, 0)',
    momo_amount: 'COALESCE(momo_amount, 0)',
  } : {
    cash_amount: 'CASE WHEN COALESCE(usd_amount, 0) > 0 THEN usd_amount ELSE COALESCE(cash_amount, 0) END',
    bank_amount: 'CASE WHEN COALESCE(k_amount,   0) > 0 THEN k_amount   ELSE COALESCE(bank_amount, 0) END',
    momo_amount: 'CASE WHEN COALESCE(fra_amount, 0) > 0 THEN fra_amount ELSE COALESCE(momo_amount, 0) END',
  };
  const exprCcy = cxMap[methodCol] || methodCol;
  const cr = db.prepare(`SELECT COALESCE(SUM(${exprCcy}), 0) AS t FROM cash_receipts    WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const pv = db.prepare(`SELECT COALESCE(SUM(${exprCcy}), 0) AS t FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const ap = db.prepare(`SELECT COALESCE(SUM(${exprCcy}), 0) AS t FROM ap_payments      WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const capIn  = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM capital_account  WHERE deleted_at IS NULL AND tenant_id = ? AND type='Injection'${dateClause}`).get(tenantId, ...dateParams).t;
  const capOut = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM capital_account  WHERE deleted_at IS NULL AND tenant_id = ? AND type='Drawing'${dateClause}`).get(tenantId, ...dateParams).t;
  const div    = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM dividend_account WHERE deleted_at IS NULL AND tenant_id = ?${dateClause}`).get(tenantId, ...dateParams).t;
  const loanIn   = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Disbursement'${dateClause}`).get(tenantId, ...dateParams).t;
  const loanPrin = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Principal'${dateClause}`).get(tenantId, ...dateParams).t;
  const loanInt  = db.prepare(`SELECT COALESCE(SUM(${methodCol}), 0) AS t FROM loan_transactions WHERE deleted_at IS NULL AND tenant_id = ? AND type='Interest'${dateClause}`).get(tenantId, ...dateParams).t;
  // Net cash transfer effect on this method = inflow (to_method) - outflow (from_method)
  const methodName = methodCol === 'cash_amount' ? 'Cash' : methodCol === 'bank_amount' ? 'Bank' : 'Mobile Money';
  const trIn  = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM cash_transfers WHERE deleted_at IS NULL AND tenant_id = ? AND to_method   = ?${dateClause}`).get(tenantId, methodName, ...dateParams).t;
  const trOut = db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM cash_transfers WHERE deleted_at IS NULL AND tenant_id = ? AND from_method = ?${dateClause}`).get(tenantId, methodName, ...dateParams).t;
  return {
    cr: parseFloat(cr), pv: parseFloat(pv), ap: parseFloat(ap),
    capIn: parseFloat(capIn), capOut: parseFloat(capOut), div: parseFloat(div),
    loanIn: parseFloat(loanIn), loanPrin: parseFloat(loanPrin), loanInt: parseFloat(loanInt),
    transferNet: parseFloat(trIn) - parseFloat(trOut),
  };
}

// Get cash book â€” derived from CR + PV + AP with per-method opening balance
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const opening = getOpeningByMethod(tenantId);
    const { from, to } = req.query;

    // Period filter for the entries shown in the table
    const dateFilter = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const dParams = [...(from ? [from] : []), ...(to ? [to] : [])];

    // v1.13.22 (port from Kelete v1.10.156â†’v1.10.164â†’v1.10.171) â€” on Liquor
    // K-only branches, ledger UNION reads CR/PV K amounts from cash+bank+
    // momo instead of k_amount alone (Liquor stores drawer amounts in the
    // method columns). USD_in / FRA_in forced to 0 so mirror columns don't
    // double-count. HQ requests short-circuit isLiquorK to false.
    const isLiquorK = detectLiquorK(db, req);
    const hqSlugForSubcalls = isHqRequest(req) ? 'hq' : null;
    const kInFallbackExpr  = isLiquorK
      ? `COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0)`
      : `COALESCE(k_amount, 0)`;
    const kOutFallbackExpr = kInFallbackExpr;
    const usdInExpr = isLiquorK
      ? `0`
      : `CASE WHEN COALESCE(usd_amount,0) > 0 THEN usd_amount WHEN COALESCE(k_amount,0) > 0 THEN 0 ELSE COALESCE(cash_amount,0) END`;
    const usdOutExpr = usdInExpr;
    const fraInExpr  = isLiquorK ? `0` : `COALESCE(fra_amount, 0)`;
    const fraOutExpr = fraInExpr;

    // When a `from` is set, fold all prior activity into the displayed opening
    let openingBalance = opening.cash + opening.bank + opening.momo;
    let openingByMethod = { ...opening };
    if (from) {
      const beforeClause = ' AND date < ?';
      ['cash_amount', 'bank_amount', 'momo_amount'].forEach((col) => {
        const key = col.replace('_amount', '');
        const m = sumMethod(tenantId, col, beforeClause, [from], hqSlugForSubcalls);
        openingByMethod[key] = openingByMethod[key]
          + m.cr + m.capIn + m.loanIn
          - m.pv - m.ap - m.capOut - m.div - m.loanPrin - m.loanInt
          + m.transferNet;
      });
      openingBalance = openingByMethod.cash + openingByMethod.bank + openingByMethod.momo;
    }

    // v1.8.61 â€” per-currency in/out columns alongside the legacy
    // receipt_amount/payment_amount (USD-equivalent for running balance).
    // CR / PV / customer_payments tables have usd_amount/fra_amount/k_amount;
    // legacy cash_amount falls back to USD. Sources without per-currency
    // columns (AP / capital / dividend / loan) bucket their amount into USD.
    //
    // v1.10.98 â€” reverted the v1.10.91â†’97 Liquor SQL branching. Same code
    // path for every tenant now, matching pre-v1.10.91 behaviour that
    // worked cleanly on both Kelete and Liquor.
    const entries = db.prepare(`
      SELECT date, 'CR' AS type, receipt_number AS reference,
        -- v1.10.49 â€” no trailing " - " when description is empty.
        CASE
          WHEN COALESCE(description, '') != ''
            THEN COALESCE(received_from, '') || ' â€” ' || description
          ELSE COALESCE(received_from, '')
        END AS description,
        amount AS receipt_amount, 0 AS payment_amount,
        ${usdInExpr} AS usd_in,
        ${fraInExpr} AS fra_in,
        ${kInFallbackExpr} AS k_in,
        0 AS usd_out, 0 AS fra_out, 0 AS k_out
      FROM cash_receipts
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT date, 'PV' AS type, voucher_number AS reference,
        -- v1.10.49 â€” PV description now folds in the Type (category)
        -- from the PV modal. Priority: description > category > (empty).
        -- Bare " - " suffix removed. Example results:
        --   paid_to='Edron', category='Salaries', desc='' â†’ 'Edron Â· Salaries'
        --   paid_to='Edron', desc='for July'              â†’ 'Edron â€” for July'
        --   paid_to='Edron', category='Salaries', desc='for July'
        --     â†’ 'Edron Â· Salaries â€” for July'
        CASE
          WHEN COALESCE(description, '') != '' AND COALESCE(category, '') != ''
            THEN COALESCE(paid_to, '') || ' Â· ' || category || ' â€” ' || description
          WHEN COALESCE(description, '') != ''
            THEN COALESCE(paid_to, '') || ' â€” ' || description
          WHEN COALESCE(category, '') != ''
            THEN COALESCE(paid_to, '') || ' Â· ' || category
          ELSE COALESCE(paid_to, '')
        END AS description,
        0 AS receipt_amount, amount AS payment_amount,
        0 AS usd_in, 0 AS fra_in, 0 AS k_in,
        ${usdOutExpr} AS usd_out,
        ${fraOutExpr} AS fra_out,
        ${kOutFallbackExpr} AS k_out
      FROM payment_vouchers
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT date, 'AP' AS type, payment_number AS reference,
        -- v1.10.49 â€” same tidy-up for AP. "Supplier Payment" only kicks
        -- in when description is genuinely blank.
        CASE
          WHEN COALESCE(description, '') != ''
            THEN COALESCE(supplier_name, '') || ' â€” ' || description
          ELSE COALESCE(supplier_name, 'Supplier Payment')
        END AS description,
        0 AS receipt_amount,
        -- v1.10.79 â€” payment_amount is the LEGACY USD-equivalent running-
        -- balance driver. When the triple-currency split is present, use
        -- usd_amount only. Prior to this the whole amount column
        -- (K32,000 for a K-only supplier payment) got subtracted from
        -- the USD running balance, driving it artificially negative.
        -- Legacy rows fall back to amount for backward compat.
        CASE WHEN (COALESCE(usd_amount,0) + COALESCE(fra_amount,0) + COALESCE(k_amount,0)) > 0
          THEN COALESCE(usd_amount, 0)
          ELSE amount END AS payment_amount,
        0 AS usd_in, 0 AS fra_in, 0 AS k_in,
        -- v1.10.78 â€” split by currency when the triple-ccy columns are
        -- populated (HQ from v1.10.78). Legacy rows fall back to k_out
        -- per the v1.10.77 K-primary default for supplier payments.
        COALESCE(usd_amount, 0) AS usd_out,
        COALESCE(fra_amount, 0) AS fra_out,
        CASE WHEN (COALESCE(usd_amount,0) + COALESCE(fra_amount,0) + COALESCE(k_amount,0)) > 0
          THEN COALESCE(k_amount, 0)
          ELSE amount END AS k_out
      FROM ap_payments
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
        AND COALESCE(paid_from, '') != 'Empty Return'
        AND COALESCE(description, '') NOT LIKE 'Empty container deposit credit%'
      UNION ALL
      SELECT date, 'TRF' AS type, transfer_number AS reference,
        'Transfer: ' || from_method || ' -> ' || to_method ||
          CASE WHEN description IS NOT NULL AND description != '' THEN ' (' || description || ')' ELSE '' END AS description,
        amount AS receipt_amount, amount AS payment_amount,
        amount AS usd_in, 0 AS fra_in, 0 AS k_in,
        amount AS usd_out, 0 AS fra_out, 0 AS k_out
      FROM cash_transfers
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT date,
        CASE WHEN type='Injection' THEN 'CAP-IN' ELSE 'CAP-OUT' END AS type,
        entry_number AS reference,
        COALESCE(owner_name, '') || ' - ' || COALESCE(description, type) AS description,
        CASE WHEN type='Injection' THEN amount ELSE 0 END AS receipt_amount,
        CASE WHEN type='Drawing'   THEN amount ELSE 0 END AS payment_amount,
        CASE WHEN type='Injection' THEN amount ELSE 0 END AS usd_in,
        0 AS fra_in, 0 AS k_in,
        CASE WHEN type='Drawing' THEN amount ELSE 0 END AS usd_out,
        0 AS fra_out, 0 AS k_out
      FROM capital_account
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT date, 'DIV' AS type, entry_number AS reference,
        COALESCE(recipient, '') || ' - ' || COALESCE(description, 'Dividend') AS description,
        0 AS receipt_amount, amount AS payment_amount,
        0 AS usd_in, 0 AS fra_in, 0 AS k_in,
        amount AS usd_out, 0 AS fra_out, 0 AS k_out
      FROM dividend_account
      WHERE deleted_at IS NULL AND tenant_id = ?${dateFilter}
      UNION ALL
      SELECT lt.date,
        CASE lt.type
          WHEN 'Disbursement' THEN 'LOAN-IN'
          WHEN 'Principal'    THEN 'LOAN-PRIN'
          ELSE                     'LOAN-INT'
        END AS type,
        lt.transaction_number AS reference,
        COALESCE(l.lender_name, '') || ' - ' || lt.type || COALESCE(' (' || lt.description || ')', '') AS description,
        CASE WHEN lt.type='Disbursement' THEN lt.amount ELSE 0 END AS receipt_amount,
        CASE WHEN lt.type IN ('Principal','Interest') THEN lt.amount ELSE 0 END AS payment_amount,
        CASE WHEN lt.type='Disbursement' THEN lt.amount ELSE 0 END AS usd_in,
        0 AS fra_in, 0 AS k_in,
        CASE WHEN lt.type IN ('Principal','Interest') THEN lt.amount ELSE 0 END AS usd_out,
        0 AS fra_out, 0 AS k_out
      FROM loan_transactions lt
      LEFT JOIN loans l ON l.sync_id = lt.loan_sync_id
      WHERE lt.deleted_at IS NULL AND lt.tenant_id = ?${dateFilter.replace(/date/g, 'lt.date')}
      UNION ALL
      -- v1.10.42 â€” book-scope currency exchanges. Design memo in
      -- currencyExchanges.js:6-7 says they "affect the Cash Book running
      -- balance per currency directly", but this UNION never queried
      -- them. Each exchange decrements the from_currency and increments
      -- the to_currency. Legacy USD-equivalent balance is left at 0 since
      -- an exchange is a swap (net zero in USD-equiv terms).
      -- Append-only table so no deleted_at filter.
      SELECT date,
        'EXCH' AS type,
        'EXCH-' || id AS reference,
        'Exchange ' || from_currency || ' ' || CAST(from_amount AS INTEGER) ||
          ' â†’ ' || to_currency || ' ' || CAST(to_amount AS INTEGER) ||
          COALESCE(' (' || NULLIF(notes,'') || ')', '') AS description,
        0 AS receipt_amount,
        0 AS payment_amount,
        CASE WHEN to_currency   = 'USD' THEN to_amount   ELSE 0 END AS usd_in,
        CASE WHEN to_currency   = 'FRA' THEN to_amount   ELSE 0 END AS fra_in,
        CASE WHEN to_currency   = 'K'   THEN to_amount   ELSE 0 END AS k_in,
        CASE WHEN from_currency = 'USD' THEN from_amount ELSE 0 END AS usd_out,
        CASE WHEN from_currency = 'FRA' THEN from_amount ELSE 0 END AS fra_out,
        CASE WHEN from_currency = 'K'   THEN from_amount ELSE 0 END AS k_out
      FROM currency_exchanges
      WHERE scope = 'book' AND tenant_id = ?${dateFilter}
      ORDER BY date ASC, reference ASC
    `).all(tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams, tenantId, ...dParams);

    // v1.8.61 â€” HQ Deposit entries from master.db (cross-tenant).
    //   Branch ledger (from_slug = caller's slug)  â†’ cash OUT  (payment_amount = amount)
    //   HQ ledger     (caller is HQ_INBOX_SLUGS)   â†’ cash IN   (receipt_amount = amount)
    // Date uses COALESCE(deposit_date, confirmed_at, created_at) so
    // backdated entries land on the right line in the ledger.
    let depEntries = [];
    const slug = String(req.query.slug || '').toLowerCase();
    if (masterDb && slug) {
      try {
        const datePred = `date(COALESCE(deposit_date, confirmed_at, created_at))`;
        const depDateFilter = (from && to) ? ` AND ${datePred} BETWEEN ? AND ?`
                            : from         ? ` AND ${datePred} >= ?`
                            : to           ? ` AND ${datePred} <= ?` : '';
        const depParams = (from && to) ? [from, to]
                        : from         ? [from]
                        : to           ? [to] : [];
        // Outgoing â€” this branch's own deposits.
        // v1.10.48 â€” also pull from_method so the ledger row description
        // labels which physical drawer the cash left (Liquor-only; NULL on
        // Kelete is harmless).
        const out = masterDb.prepare(`
          SELECT deposit_number, currency, amount, from_method,
                 COALESCE(deposit_date, date(COALESCE(confirmed_at, created_at))) AS date,
                 from_name, to_name, notes
            FROM cash_deposits
           WHERE status = 'CONFIRMED' AND deleted_at IS NULL AND from_slug = ?${depDateFilter}
        `).all(slug, ...depParams);
        for (const r of out) {
          const amt = parseFloat(r.amount);
          depEntries.push({
            date: r.date,
            type: 'DEP-OUT',
            reference: r.deposit_number,
            description: `Deposit to ${r.to_name || 'HQ'} â€” ${r.currency} ${Math.round(amt).toLocaleString()}${r.from_method ? ` from ${r.from_method}` : ''}${r.notes ? ` (${r.notes})` : ''}`,
            // Legacy fields kept for backwards-compat (USD-equivalent
            // not computed â€” only the native currency moves).
            receipt_amount: 0,
            payment_amount: r.currency === 'USD' ? amt : 0,
            currency: r.currency,
            // Per-currency split â€” populates the right column on the
            // new Cash Book table.
            usd_in: 0, fra_in: 0, k_in: 0,
            usd_out: r.currency === 'USD' ? amt : 0,
            fra_out: r.currency === 'FRA' ? amt : 0,
            k_out:   r.currency === 'K'   ? amt : 0,
          });
        }
        // Incoming â€” HQ gets the deposits sent to HQ; a depot gets the ones
        // other depots sent to it (2026-09-15, System Settings â†’ Deposit to).
        {
          const isHqBook = HQ_INBOX_SLUGS.has(slug);
          const incoming = masterDb.prepare(`
            SELECT deposit_number, currency, amount,
                   COALESCE(deposit_date, date(COALESCE(confirmed_at, created_at))) AS date,
                   from_slug, from_name, notes
              FROM cash_deposits
             WHERE status = 'CONFIRMED' AND deleted_at IS NULL
               AND ${isHqBook ? "COALESCE(to_slug, '') = ''" : 'to_slug = ?'}${depDateFilter}
          `).all(...(isHqBook ? [] : [slug]), ...depParams);
          for (const r of incoming) {
            const amt = parseFloat(r.amount);
            // v1.10.80 â€” Option A: slug in parens after the trading name.
            // Skip the paren when name is missing or already equals the
            // slug (avoids "lusaka1 (lusaka1)" noise).
            const nameLbl = r.from_name && r.from_name.toLowerCase() !== String(r.from_slug || '').toLowerCase()
              ? `${r.from_name} (${r.from_slug})`
              : (r.from_slug || r.from_name || 'branch');
            depEntries.push({
              date: r.date,
              type: 'DEP-IN',
              reference: r.deposit_number,
              description: `Deposit from ${nameLbl} â€” ${r.currency} ${Math.round(amt).toLocaleString()}${r.notes ? ` (${r.notes})` : ''}`,
              receipt_amount: r.currency === 'USD' ? amt : 0,
              payment_amount: 0,
              currency: r.currency,
              usd_in: r.currency === 'USD' ? amt : 0,
              fra_in: r.currency === 'FRA' ? amt : 0,
              k_in:   r.currency === 'K'   ? amt : 0,
              usd_out: 0, fra_out: 0, k_out: 0,
            });
          }
        }
      } catch (e) { /* non-fatal */ }
    }

    // Merge + chronological sort.
    const merged = [...entries, ...depEntries].sort((a, b) => {
      const aDate = String(a.date || '');
      const bDate = String(b.date || '');
      if (aDate !== bDate) return aDate < bDate ? -1 : 1;
      return String(a.reference || '').localeCompare(String(b.reference || ''));
    });

    // v1.8.62 â€” per-currency running balance. Each row carries its
    // closing USD / FRA / K balance after the row applied. The legacy
    // single-$ `balance` field stays for backwards compat (sums the
    // USD-equivalent legacy receipt/payment columns).
    // v1.10.25 â€” fold pre-period activity into openingByCcy so opening on
    // day N = closing on day N-1. Previously we only folded openingByMethod,
    // so per-currency opening stayed at the install-time seed regardless of
    // date filter â†’ Jul 2 showed Jul 1's opening instead of Jul 1's closing.
    let openingByCcy = getOpeningByCurrency(tenantId);
    if (from) {
      const before = ccyReceiptsPayments(tenantId, slug, ' AND date < ?', [from]);
      openingByCcy = {
        usd: openingByCcy.usd + before.receipts.usd - before.payments.usd,
        fra: openingByCcy.fra + before.receipts.fra - before.payments.fra,
        k:   openingByCcy.k   + before.receipts.k   - before.payments.k,
      };
    }
    let balance = openingBalance;
    let bUsd = openingByCcy.usd;
    let bFra = openingByCcy.fra;
    let bK   = openingByCcy.k;
    const rows = merged.map((e, i) => {
      balance = balance + parseFloat(e.receipt_amount) - parseFloat(e.payment_amount);
      bUsd = bUsd + parseFloat(e.usd_in || 0) - parseFloat(e.usd_out || 0);
      bFra = bFra + parseFloat(e.fra_in || 0) - parseFloat(e.fra_out || 0);
      bK   = bK   + parseFloat(e.k_in   || 0) - parseFloat(e.k_out   || 0);
      return { ...e, id: i + 1, balance, balance_usd: bUsd, balance_fra: bFra, balance_k: bK };
    });

    res.json({
      openingBalance, openingByMethod, openingByCcy,
      closingByCcy: { usd: bUsd, fra: bFra, k: bK },
      entries: rows,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stats â€” per-method receipts, payments, and balances (the cards on the page)
// 2026-09-13 â€” the body of GET /stats, lifted out so HQ Cash Position can run
// the SAME calculation against each depot's database (db.runWithDb). The
// route below passes in exactly what it used to read off the request.
function computeCashBookStats({ tenantId, slug: slugIn = '', from, to, isHq = false }) {
  {
    const opening = getOpeningByMethod(tenantId);
    const df = (from ? ' AND date >= ?' : '') + (to ? ' AND date <= ?' : '');
    const dp = [...(from ? [from] : []), ...(to ? [to] : [])];
    // v1.13.22 (port from Kelete v1.10.171) â€” HQ safety net + Liquor detection
    // for the per-currency stats. Passed to sumMethod so it picks the right
    // cxMap and never falls into Liquor code on HQ hosts.
    const isLiquorKStats = detectLiquorK(db, null);
    const hqSlugForSubcalls = isHq ? 'hq' : null;

    // Period inflows/outflows for each method
    const cash = sumMethod(tenantId, 'cash_amount', df, dp, hqSlugForSubcalls);
    const bank = sumMethod(tenantId, 'bank_amount', df, dp, hqSlugForSubcalls);
    const momo = sumMethod(tenantId, 'momo_amount', df, dp, hqSlugForSubcalls);

    // Folded openings (carry pre-period activity into the opening when a `from` is set)
    let openingByMethod = { ...opening };
    if (from) {
      ['cash_amount', 'bank_amount', 'momo_amount'].forEach((col) => {
        const key = col.replace('_amount', '');
        const b = sumMethod(tenantId, col, ' AND date < ?', [from], hqSlugForSubcalls);
        openingByMethod[key] = openingByMethod[key]
          + b.cr + b.capIn + b.loanIn
          - b.pv - b.ap - b.capOut - b.div - b.loanPrin - b.loanInt
          + b.transferNet;
      });
      // v1.10.49 â€” subtract pre-period deposits per drawer so Jul-2's
      // opening tiles reflect Jul-1's closing. Same shape as v1.10.48's
      // current-day adjustment, applied to the fold instead. Needs
      // masterDb + slug â€” read them out of the enclosing /stats scope.
      const slugForFold = String(slugIn || '').toLowerCase();
      if (masterDb && slugForFold) {
        try {
          const datePredFold = `date(COALESCE(deposit_date, confirmed_at, created_at))`;
          const preDepRows = masterDb.prepare(`
            SELECT COALESCE(from_method, 'Cash') AS m, COALESCE(SUM(amount), 0) AS t
              FROM cash_deposits
             WHERE status = 'CONFIRMED' AND deleted_at IS NULL AND from_slug = ?
               AND ${datePredFold} < ?
             GROUP BY COALESCE(from_method, 'Cash')
          `).all(slugForFold, from);
          for (const r of preDepRows) {
            const key = r.m === 'Mobile Money' ? 'momo' : r.m === 'Bank' ? 'bank' : 'cash';
            openingByMethod[key] -= parseFloat(r.t);
          }
          // Add what arrived before the period, as the outgoing side is taken
          // off above. 2026-09-15 â€” a depot other depots deposit to.
          // 2026-09-16 â€” and HQ, which never had this: with a From date its
          // tiles opened without every deposit received before that date
          // (15 Sep opened at K-64,660 while the ledger ran to K5,688,108).
          {
            const isHqBook = HQ_INBOX_SLUGS.has(slugForFold);
            const preInRows = masterDb.prepare(`
              SELECT COALESCE(from_method, 'Cash') AS m, COALESCE(SUM(amount), 0) AS t
                FROM cash_deposits
               WHERE status = 'CONFIRMED' AND deleted_at IS NULL
                 AND ${isHqBook ? "COALESCE(to_slug, '') = ''" : 'to_slug = ?'}
                 AND ${datePredFold} < ?
               GROUP BY COALESCE(from_method, 'Cash')
            `).all(...(isHqBook ? [] : [slugForFold]), from);
            for (const r of preInRows) {
              const key = r.m === 'Mobile Money' ? 'momo' : r.m === 'Bank' ? 'bank' : 'cash';
              openingByMethod[key] += parseFloat(r.t);
            }
          }
        } catch (e) {
    // 2026-08-28 â€” log it. This used to swallow silently, and a single
    // missing column meant deposits vanished from the Cash Book on BOTH
    // sides with nothing to show anyone was wrong.
    console.error('[cashBook] deposit rollup failed:', e.message);
  }
      }
    }

    const currentByMethod = {
      cash: openingByMethod.cash + cash.cr + cash.capIn + cash.loanIn - cash.pv - cash.ap - cash.capOut - cash.div - cash.loanPrin - cash.loanInt + cash.transferNet,
      bank: openingByMethod.bank + bank.cr + bank.capIn + bank.loanIn - bank.pv - bank.ap - bank.capOut - bank.div - bank.loanPrin - bank.loanInt + bank.transferNet,
      momo: openingByMethod.momo + momo.cr + momo.capIn + momo.loanIn - momo.pv - momo.ap - momo.capOut - momo.div - momo.loanPrin - momo.loanInt + momo.transferNet,
    };
    const totalReceipts   = cash.cr + bank.cr + momo.cr;
    const totalPV         = cash.pv + bank.pv + momo.pv;
    const totalAP         = cash.ap + bank.ap + momo.ap;
    const totalCapIn      = cash.capIn  + bank.capIn  + momo.capIn;
    const totalCapOut     = cash.capOut + bank.capOut + momo.capOut;
    const totalDividend   = cash.div    + bank.div    + momo.div;
    const totalLoanIn     = cash.loanIn   + bank.loanIn   + momo.loanIn;
    const totalLoanPrin   = cash.loanPrin + bank.loanPrin + momo.loanPrin;
    const totalLoanInt    = cash.loanInt  + bank.loanInt  + momo.loanInt;
    const totalPayments   = totalPV + totalAP + totalCapOut + totalDividend + totalLoanPrin + totalLoanInt;
    const openingBalance = openingByMethod.cash + openingByMethod.bank + openingByMethod.momo;
    const currentBalance = currentByMethod.cash + currentByMethod.bank + currentByMethod.momo;

    // v1.8.62 â€” per-currency stats (USD/FRA/K) for the dashboard cards.
    // Reads usd_amount / fra_amount / k_amount with fallback to legacy
    // cash_amount (= USD) so single-currency tenants still total correctly.
    // Also pulls today's confirmed HQ Deposits from master.db (subtract
    // outgoing from branch / add incoming for HQ) so the cards stay in
    // sync with the ledger entries endpoint.
    const slug = String(slugIn || '').toLowerCase();
    // v1.13.22 (port from Kelete v1.10.163â†’164) â€” on Liquor branches, K
    // amounts live in cash_amount + bank_amount + momo_amount (all three
    // are K on K-only). Force USD/FRA to 0 so mirror columns don't
    // double-count. HQ short-circuits.
    const sumCcy = (table, dateCol) => {
      const usdExpr = isLiquorKStats
        ? `0`
        : `CASE WHEN COALESCE(usd_amount,0)>0 THEN usd_amount ELSE COALESCE(cash_amount,0) END`;
      const fraExpr = isLiquorKStats ? `0` : `COALESCE(fra_amount, 0)`;
      const kExpr   = isLiquorKStats
        ? `COALESCE(cash_amount,0) + COALESCE(bank_amount,0) + COALESCE(momo_amount,0)`
        : `COALESCE(k_amount, 0)`;
      const usd = db.prepare(`SELECT COALESCE(SUM(${usdExpr}), 0) AS t FROM ${table} WHERE deleted_at IS NULL AND tenant_id = ?${df.replace(/date/g, dateCol)}`).get(tenantId, ...dp).t;
      const fra = db.prepare(`SELECT COALESCE(SUM(${fraExpr}), 0) AS t FROM ${table} WHERE deleted_at IS NULL AND tenant_id = ?${df.replace(/date/g, dateCol)}`).get(tenantId, ...dp).t;
      const kAmt= db.prepare(`SELECT COALESCE(SUM(${kExpr}),   0) AS t FROM ${table} WHERE deleted_at IS NULL AND tenant_id = ?${df.replace(/date/g, dateCol)}`).get(tenantId, ...dp).t;
      return { usd: parseFloat(usd), fra: parseFloat(fra), k: parseFloat(kAmt) };
    };
    const crByCcy = sumCcy('cash_receipts',    'date');
    const pvByCcy = sumCcy('payment_vouchers', 'date');
    // v1.10.79 â€” AP now splits by currency, matching CR/PV. Previous code
    // lumped every ap_payments.amount into apUsd (subtracting from the USD
    // balance card) AND never touched the K balance card. Now:
    //   apByCcy.usd += usd_amount (or amount for legacy rows w/ no split)
    //   apByCcy.fra += fra_amount
    //   apByCcy.k   += k_amount   (or amount for legacy)
    const apByCcy = (() => {
      const row = db.prepare(`
        SELECT
          COALESCE(SUM(usd_amount), 0) AS usd_ccy,
          COALESCE(SUM(fra_amount), 0) AS fra_ccy,
          COALESCE(SUM(k_amount),   0) AS k_ccy,
          COALESCE(SUM(CASE WHEN (COALESCE(usd_amount,0)+COALESCE(fra_amount,0)+COALESCE(k_amount,0)) = 0
                             THEN amount ELSE 0 END), 0) AS legacy_amount
        FROM ap_payments
        WHERE deleted_at IS NULL AND tenant_id = ?${df}
      `).get(tenantId, ...dp);
      // Route legacy rows to K (matches v1.10.77 default: HQ + Liquor are K-primary).
      return {
        usd: parseFloat(row.usd_ccy),
        fra: parseFloat(row.fra_ccy),
        k:   parseFloat(row.k_ccy) + parseFloat(row.legacy_amount),
      };
    })();
    // POS sales â€” orders.cash_received / fra_received / k_received.
    const ordersUsd = db.prepare(`SELECT COALESCE(SUM(cash_received), 0) AS t FROM orders WHERE deleted_at IS NULL AND tenant_id = ? AND (status IS NULL OR status IN ('PAID','DISPATCHED'))${df.replace(/date/g, 'paid_at')}`).get(tenantId, ...dp).t;
    const ordersFra = db.prepare(`SELECT COALESCE(SUM(fra_received), 0) AS t FROM orders WHERE deleted_at IS NULL AND tenant_id = ? AND (status IS NULL OR status IN ('PAID','DISPATCHED'))${df.replace(/date/g, 'paid_at')}`).get(tenantId, ...dp).t;
    const ordersK   = db.prepare(`SELECT COALESCE(SUM(k_received), 0)   AS t FROM orders WHERE deleted_at IS NULL AND tenant_id = ? AND (status IS NULL OR status IN ('PAID','DISPATCHED'))${df.replace(/date/g, 'paid_at')}`).get(tenantId, ...dp).t;

    // HQ Deposits from master.db.
    let depInByCcy  = { usd: 0, fra: 0, k: 0 };
    let depOutByCcy = { usd: 0, fra: 0, k: 0 };
    // v1.10.48 â€” per-method Liquor rollup: which physical drawer the
    // deposit came out of on a Liquor branch. Populated only for outgoing
    // (branch â†’ HQ); incoming HQ deposits stay method-less.
    let depOutByMethod = { cash: 0, momo: 0, bank: 0 };
    // 2026-08-29 â€” the receiving half. depOutByMethod existed from day one;
    // there was never a depInByMethod, so money LEAVING a branch was taken off
    // a drawer tile while money ARRIVING at HQ was added to nothing. A
    // confirmed deposit showed in the HQ ledger and in none of the tiles above
    // it, and Cash & Cash Equivalent (the three tiles summed) missed it too.
    let depInByMethod = { cash: 0, momo: 0, bank: 0 };
    if (masterDb && slug) {
      try {
        const datePred = `date(COALESCE(deposit_date, confirmed_at, created_at))`;
        const depDf = (from && to) ? ` AND ${datePred} BETWEEN ? AND ?`
                    : from         ? ` AND ${datePred} >= ?`
                    : to           ? ` AND ${datePred} <= ?` : '';
        const depParams = (from && to) ? [from, to] : from ? [from] : to ? [to] : [];
        const outRows = masterDb.prepare(`
          SELECT currency, COALESCE(SUM(amount), 0) AS t
            FROM cash_deposits
           WHERE status = 'CONFIRMED' AND deleted_at IS NULL AND from_slug = ?${depDf}
           GROUP BY currency
        `).all(slug, ...depParams);
        for (const r of outRows) {
          const key = r.currency === 'USD' ? 'usd' : r.currency === 'FRA' ? 'fra' : 'k';
          depOutByCcy[key] += parseFloat(r.t);
        }
        // v1.10.48 â€” also aggregate per-method for Liquor tile decrement.
        // NULL from_method (legacy rows or Kelete deposits) falls back to
        // 'Cash' so nothing goes unaccounted for.
        const outByMethodRows = masterDb.prepare(`
          SELECT COALESCE(from_method, 'Cash') AS m, COALESCE(SUM(amount), 0) AS t
            FROM cash_deposits
           WHERE status = 'CONFIRMED' AND deleted_at IS NULL AND from_slug = ?${depDf}
           GROUP BY COALESCE(from_method, 'Cash')
        `).all(slug, ...depParams);
        for (const r of outByMethodRows) {
          const key = r.m === 'Mobile Money' ? 'momo' : r.m === 'Bank' ? 'bank' : 'cash';
          depOutByMethod[key] += parseFloat(r.t);
        }
        // 2026-09-15 â€” incoming: HQ counts the deposits sent to HQ; a depot the
        // ones other depots sent to it (System Settings â†’ Deposit to).
        {
          const isHqBook = HQ_INBOX_SLUGS.has(slug);
          const inWhere = isHqBook ? "COALESCE(to_slug, '') = ''" : 'to_slug = ?';
          const inArgs = isHqBook ? [] : [slug];
          const inRows = masterDb.prepare(`
            SELECT currency, COALESCE(SUM(amount), 0) AS t
              FROM cash_deposits
             WHERE status = 'CONFIRMED' AND deleted_at IS NULL AND ${inWhere}${depDf}
             GROUP BY currency
          `).all(...inArgs, ...depParams);
          // Which drawer the cash landed in at HQ. from_method records how the
          // branch sent it; absent that (legacy rows) treat it as cash, the
          // same fallback the outgoing side uses.
          const inByMethodRows = masterDb.prepare(`
            SELECT COALESCE(from_method, 'Cash') AS m, COALESCE(SUM(amount), 0) AS t
              FROM cash_deposits
             WHERE status = 'CONFIRMED' AND deleted_at IS NULL AND ${inWhere}${depDf}
             GROUP BY COALESCE(from_method, 'Cash')
          `).all(...inArgs, ...depParams);
          for (const r of inByMethodRows) {
            const key = r.m === 'Mobile Money' ? 'momo' : r.m === 'Bank' ? 'bank' : 'cash';
            depInByMethod[key] += parseFloat(r.t);
          }
          for (const r of inRows) {
            const key = r.currency === 'USD' ? 'usd' : r.currency === 'FRA' ? 'fra' : 'k';
            depInByCcy[key] += parseFloat(r.t);
          }
        }
      } catch (e) {
    // 2026-08-28 â€” log it. This used to swallow silently, and a single
    // missing column meant deposits vanished from the Cash Book on BOTH
    // sides with nothing to show anyone was wrong.
    console.error('[cashBook] deposit rollup failed:', e.message);
  }
    }

    // v1.10.42 â€” book-scope currency exchanges (in-range). Same convention
    // as the ledger UNION and the fold helper: from_currency â†’ payments,
    // to_currency â†’ receipts. Append-only table so no deleted_at filter.
    const exchInRange = db.prepare(`
      SELECT from_currency, from_amount, to_currency, to_amount
        FROM currency_exchanges
       WHERE scope = 'book' AND tenant_id = ?${df}
    `).all(tenantId, ...dp);
    const exchIn  = { usd: 0, fra: 0, k: 0 };
    const exchOut = { usd: 0, fra: 0, k: 0 };
    for (const r of exchInRange) {
      const fromKey = r.from_currency === 'USD' ? 'usd' : r.from_currency === 'FRA' ? 'fra' : 'k';
      const toKey   = r.to_currency   === 'USD' ? 'usd' : r.to_currency   === 'FRA' ? 'fra' : 'k';
      exchOut[fromKey] += parseFloat(r.from_amount || 0);
      exchIn[toKey]    += parseFloat(r.to_amount   || 0);
    }
    // v1.10.48 â€” subtract Liquor-method deposits from the per-method tiles.
    // currentByMethod was computed above from cash_receipts / PV / etc.
    // without any awareness of cash_deposits; now that we've fetched
    // depOutByMethod, apply it so the Cash on Hand / Mobile Money / Bank
    // tiles reflect real drawer state on Liquor branches. Kelete deposits
    // land in 'cash' by our COALESCE default â€” harmless because Kelete's
    // Cash Book doesn't render per-method tiles.
    currentByMethod.cash -= depOutByMethod.cash;
    currentByMethod.momo -= depOutByMethod.momo;
    currentByMethod.bank -= depOutByMethod.bank;
    // ...and add what arrived: at HQ, and (2026-09-15) at a depot other depots
    // deposit to. Zero for every other branch, so a no-op there.
    currentByMethod.cash += depInByMethod.cash;
    currentByMethod.momo += depInByMethod.momo;
    currentByMethod.bank += depInByMethod.bank;
    // Per-currency receipts / payments roll-up.
    const receiptsByCcy = {
      usd: ordersUsd + crByCcy.usd + depInByCcy.usd + exchIn.usd,
      fra: ordersFra + crByCcy.fra + depInByCcy.fra + exchIn.fra,
      k:   ordersK   + crByCcy.k   + depInByCcy.k   + exchIn.k,
    };
    const paymentsByCcy = {
      // v1.10.79 â€” AP now contributes per-currency (was apUsd â€” a single
      // sum dumped into USD). apByCcy.k picks up the ALASKAL K32,000 so
      // the K balance card actually drops when a supplier is paid in K.
      usd: pvByCcy.usd + apByCcy.usd + depOutByCcy.usd + exchOut.usd,
      fra: pvByCcy.fra + apByCcy.fra + depOutByCcy.fra + exchOut.fra,
      k:   pvByCcy.k   + apByCcy.k   + depOutByCcy.k   + exchOut.k,
    };
    // Per-currency closing balance = opening + receipts âˆ’ payments.
    // v1.10.25 â€” fold pre-period activity into openingByCcy when `from`
    // is set (mirrors what /stats already does for openingByMethod). Without
    // this, Jul 2's opening tile still reads Jul 1's opening seed, so
    // "Opening" and "Current" on day 2 don't reflect day 1's real close.
    let openingByCcy = getOpeningByCurrency(tenantId);
    if (from) {
      const before = ccyReceiptsPayments(tenantId, slug, ' AND date < ?', [from]);
      openingByCcy = {
        usd: openingByCcy.usd + before.receipts.usd - before.payments.usd,
        fra: openingByCcy.fra + before.receipts.fra - before.payments.fra,
        k:   openingByCcy.k   + before.receipts.k   - before.payments.k,
      };
    }
    const currentByCcy = {
      usd: openingByCcy.usd + receiptsByCcy.usd - paymentsByCcy.usd,
      fra: openingByCcy.fra + receiptsByCcy.fra - paymentsByCcy.fra,
      k:   openingByCcy.k   + receiptsByCcy.k   - paymentsByCcy.k,
    };

    return {
      openingBalance, openingByMethod,
      totalReceipts, totalPV, totalAP, totalPayments,
      totalCapIn, totalCapOut, totalDividend,
      totalLoanIn, totalLoanPrin, totalLoanInt,
      currentBalance, currentByMethod,
      methodFlows: { cash, bank, momo },
      // v1.8.62 â€” per-currency cards for the Kelete Cash Book dashboard.
      openingByCcy, receiptsByCcy, paymentsByCcy, currentByCcy,
      depositsByCcy: { in: depInByCcy, out: depOutByCcy },
    };
  }
}

// Stats â€” per-method receipts, payments, and balances (the cards on the page)
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    res.json(computeCashBookStats({
      tenantId: req.user.tenantId,
      slug: req.query.slug,
      from: req.query.from,
      to: req.query.to,
      isHq: isHqRequest(req),
    }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Set opening balance(s).
// Accepts:
//   { usd, fra, k }                â€” v1.8.62 per-currency (Kelete)
//   { cash, bank, momo }           â€” legacy per-method
//   { amount }                     â€” legacy single Cash opening
router.post('/opening-balance', auth, async (req, res) => {
  try {
    // 2026-09-07 â€” an Administrator password, checked here.
    //
    // This one figure shifts every running balance in the Cash Book, and the
    // only thing in front of it was a confirm dialog in the browser - which
    // stops a misclick and nothing else. Other sensitive screens in this app
    // already ask (Credit Notes, Account Receivables); this was missed.
    // Checking it in the route matters more than the prompt: a check that
    // lives only in the page leaves the endpoint open to anyone with a login.
    const password = String(req.body?.password || '');
    if (!password) {
      return res.status(400).json({ error: 'Administrator password is required to change the opening balance.' });
    }
    // Everyone types it, administrators included â€” this is a confirmation
    // gate on an irreversible figure, not a permission check.
    const admins = db.prepare(
      "SELECT password FROM users WHERE role = 'Administrator' AND deleted_at IS NULL"
    ).all();
    let ok = false;
    for (const a of admins) {
      // eslint-disable-next-line no-await-in-loop
      if (a.password && await bcrypt.compare(password, a.password)) { ok = true; break; }
    }
    if (!ok) return res.status(401).json({ error: 'Wrong administrator password.' });

    const { amount, cash, bank, momo, usd, fra, k } = req.body;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();

    const usingCcy   = usd  !== undefined || fra  !== undefined || k    !== undefined;
    const usingSplit = cash !== undefined || bank !== undefined || momo !== undefined;
    let buckets;
    if (usingCcy) {
      buckets = [
        { ref: 'OB-USD', amount: parseFloat(usd || 0) || 0 },
        { ref: 'OB-FRA', amount: parseFloat(fra || 0) || 0 },
        { ref: 'OB-K',   amount: parseFloat(k   || 0) || 0 },
      ];
    } else if (usingSplit) {
      buckets = [
        { ref: 'OB-CASH', amount: parseFloat(cash || 0) || 0 },
        { ref: 'OB-BANK', amount: parseFloat(bank || 0) || 0 },
        { ref: 'OB-MOMO', amount: parseFloat(momo || 0) || 0 },
      ];
    } else {
      buckets = [{ ref: 'OB-CASH', amount: parseFloat(amount || 0) || 0 }];
    }

    db.transaction(() => {
      db.prepare("DELETE FROM cash_book WHERE type = 'opening' AND tenant_id = ?").run(tenantId);
      const ins = db.prepare(`
        INSERT INTO cash_book (date, description, reference, receipt_amount, payment_amount, balance,
                               type, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (DATE('now'), ?, ?, ?, 0, ?, 'opening', ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      `);
      for (const b of buckets) {
        const label = b.ref === 'OB-BANK' ? 'Opening Bank Balance'
                    : b.ref === 'OB-MOMO' ? 'Opening MoMo Balance'
                    : b.ref === 'OB-USD'  ? 'Opening USD Balance'
                    : b.ref === 'OB-FRA'  ? 'Opening FRA Balance'
                    : b.ref === 'OB-K'    ? 'Opening K Balance'
                    : 'Opening Cash Balance';
        ins.run(label, b.ref, b.amount, b.amount, randomUUID(), tenantId, branchId, deviceId);
      }
    })();

    res.json({
      success: true,
      openingByMethod: getOpeningByMethod(tenantId),
      openingByCcy:    getOpeningByCurrency(tenantId),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// â”€â”€â”€ Cash Transfers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Money moved between methods (Cash <-> Bank <-> Mobile Money). Total cash on
// hand is unchanged; only the per-method breakdown shifts.

const VALID_METHODS = new Set(['Cash', 'Bank', 'Mobile Money']);

// List transfers
router.get('/transfers', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT t.*, (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM cash_transfers t
      LEFT JOIN users u ON u.id = t.created_by
      WHERE t.deleted_at IS NULL AND t.tenant_id = ?
      ORDER BY t.date DESC, t.id DESC
    `).all(req.user.tenantId);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create transfer
router.post('/transfers', auth, (req, res) => {
  try {
    const { date, from_method, to_method, amount, description } = req.body;
    if (!VALID_METHODS.has(from_method)) return res.status(400).json({ error: 'Invalid from_method.' });
    if (!VALID_METHODS.has(to_method))   return res.status(400).json({ error: 'Invalid to_method.' });
    if (from_method === to_method)       return res.status(400).json({ error: 'From and To must be different.' });
    const amt = parseFloat(amount || 0);
    if (!(amt > 0))                       return res.status(400).json({ error: 'Amount must be greater than zero.' });

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const transferNum = syncConfig.generateNumber('TRF', 'cash_transfers');
    const transferDate = date || new Date().toISOString().split('T')[0];

    const info = db.prepare(`
      INSERT INTO cash_transfers (transfer_number, date, from_method, to_method, amount, description, created_by,
                                   sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(transferNum, transferDate, from_method, to_method, amt, description || null, req.user.id,
           randomUUID(), tenantId, branchId, deviceId);
    res.status(201).json(db.prepare('SELECT * FROM cash_transfers WHERE id = ?').get(info.lastInsertRowid));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete transfer (soft delete)
router.delete('/transfers/:id', auth, (req, res) => {
  try {
    db.prepare("UPDATE cash_transfers SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    res.json({ message: 'Transfer deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.computeCashBookStats = computeCashBookStats;
module.exports = router;
