/**
 * hqPurchases.js â€” HQ-managed supplier purchase receipts.
 *
 * HQ has NO physical warehouse (see project memory + the user's clarif).
 * Every supplier purchase is logged here ONCE at HQ with per-line
 * destination_slug; lines sit PENDING in the destination branch's
 * "Incoming Stock" queue until the branch counts what physically arrived
 * and confirms with received_qty (variance captured for damage/short).
 *
 * On confirm we:
 *   - find product at destination by sync_id (fallback: same name),
 *     auto-create if missing â€” using the snapshot from the line.
 *   - increment products.current_stock by received_qty (base units).
 *   - insert a stock_movement (location='sales', movement_type='hq_receipt')
 *     so Bin Card + per-branch stock card reflect the arrival.
 *   - flip line status to RECEIVED, stamp received_by + received_at.
 *   - auto-COMPLETE the header once every line is RECEIVED/CANCELLED.
 *
 * Auth: hqAuth (JWT only) â€” same model as the other HQ routes.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { listTenants, isRegistered, masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const { conversionToBase } = require('../config/unitsHelper');

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

function nextPurchaseNumber() {
  const yr = new Date().getFullYear();
  // 2026-09-04 â€” was COUNT(*) + 1, which breaks the moment a row is deleted:
  // the count drops while the numbers already issued do not, so the next
  // document reuses one that exists and the UNIQUE constraint rejects it.
  // Deleting five stale test rows today was enough to do it. Take the highest
  // number actually issued this year instead â€” deletions cannot lower it, and
  // a number is never reused.
  const row = masterDb.prepare(
    `SELECT MAX(CAST(substr(purchase_number, ?) AS INTEGER)) AS n
       FROM hq_purchases
      WHERE purchase_number LIKE ?`
  ).get(10, `HQP-${yr}-%`);
  const seq = (Number(row?.n) || 0) + 1;
  return `HQP-${yr}-${String(seq).padStart(5, '0')}`;
}

function destinationName(slug) {
  try {
    const t = listTenants().find(t => t.slug === slug);
    if (!t) return slug;
    try {
      const db = getTenantDb(slug);
      const row = db.prepare('SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1').get();
      if (row?.business_name) return row.business_name;
    } catch (_) {}
    return t.business_name || slug;
  } catch (_) { return slug; }
}

// 2026-09-09 â€” a 400 the outer catch can tell apart from a crash. The line
// builder below is shared by three routes and reports bad input by throwing,
// rather than each caller re-checking what it just handed over.
function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

// v1.10.54 â€” FX rate at PO Create (WAC redesign push 2).
// Rate is captured HERE, one rate for the whole PO, per user's
// 2026-07-03 design memo. Validation is soft: if the caller sends
// cost_currency + fx_rate_used they must both be sane, but sending
// neither is fine (frontend gates the requirement based on whether
// any destination line targets a tri-currency branch â€” the backend
// just trusts what it receives).
function parseCurrency({ cost_currency, fx_rate_used }) {
  const VALID_CCY = new Set(['USD', 'FRA', 'K']);
  const ccy  = cost_currency ? String(cost_currency).toUpperCase() : null;
  const rate = fx_rate_used  ? parseFloat(fx_rate_used) : null;
  if (ccy && !VALID_CCY.has(ccy)) {
    throw badRequest('cost_currency must be one of USD, FRA, K');
  }
  if (ccy && ccy !== 'USD' && !(rate > 0)) {
    throw badRequest(`fx_rate_used > 0 is required when cost_currency is ${ccy}`);
  }
  return { ccy, rate };
}

// Validate items + compute the total. Every line must have qty>0 and a
// registered destination_slug â€” HQ can't dispatch to a non-tenant.
//
// 2026-09-09 â€” extracted from POST unchanged so that saving a draft, and
// promoting one to a real purchase, produce byte-identical lines. A draft
// that computed its costs even slightly differently would be a purchase that
// changed the moment it was saved, which is the one thing a draft must not do.
function buildLines(items, ccy, rate) {
  // Convert helper: local cost â†’ USD equivalent, using the PO rate.
  // USD stays 1:1. FRA/K divide by the rate. NULL rate on non-USD
  // shouldn't happen (we validated above) but we guard with 0 â†’ NULL.
  const toUsd = (localCost) => {
    const c = parseFloat(localCost || 0) || 0;
    if (c <= 0) return 0;
    if (!ccy || ccy === 'USD') return c;
    return rate > 0 ? c / rate : null;
  };

  const clean = [];
  let totalAmount = 0;
  for (const it of items) {
    const dest = String(it.destination_slug || '').toLowerCase();
    const name = String(it.product_name || '').trim();
    const qty  = parseFloat(it.dispatched_qty);

    // 2026-08-30 â€” the invoice's own figures, and the cost DERIVED from them.
    //
    // A supplier invoice prints base price, VAT and discount per line. Until
    // now only one number could be recorded, so whoever typed the purchase
    // had to compute (base + VAT - discount) / qty by hand for every line â€”
    // arithmetic done by a person, rounded to 2dp, leaving AP a few kwacha
    // off the amount due.
    //
    // Now those three are captured as printed and the effective unit cost is
    // computed at full precision. cost_price keeps its exact meaning, so
    // stock, WAC, GRN, AP and the ZRA chain are untouched.
    //
    // Older callers send only cost_price and no base_price; they keep
    // working, because base falls back to cost and VAT/discount are 0.
    const basePrice = parseFloat(it.base_price);
    // 2026-09-04 â€” the RRP this line was billed on, stored alongside the
    // figures it explains. Suppliers charge VAT on the RRP rather than on
    // what they bill: a Varun line at base 6,352.62 carries VAT 1,097.38 â€”
    // not 16% of the base (1,016.42) but 16/116 of RRP x qty. Minimum
    // taxable value, the same rule the POS applies when it sells the item.
    //
    // vat_amount is still taken as sent. The form computes it from this RRP,
    // but the operator can override to match a supplier's rounding, and the
    // paper invoice is what actually gets paid. Storing the RRP is what makes
    // that override checkable later, rather than a number with no provenance.
    const rrp       = parseFloat(it.rrp || 0) || 0;
    const vatAmt    = parseFloat(it.vat_amount || 0) || 0;
    const discAmt   = parseFloat(it.discount_amount || 0) || 0;
    const legacyCost = parseFloat(it.cost_price || 0) || 0;
    const base = Number.isFinite(basePrice) && basePrice > 0 ? basePrice : legacyCost;
    const baseTotal = qty * base;
    // Guard the divide: qty is validated > 0 just below, but this runs first.
    const cost = qty > 0 ? (baseTotal + vatAmt - discAmt) / qty : 0;
    if (!name || !(qty > 0)) {
      throw badRequest('Invalid item: needs product_name and dispatched_qty > 0');
    }
    if (!dest || !isRegistered(dest)) {
      throw badRequest(`Destination "${dest}" is not a registered branch`);
    }
    clean.push({
      product_sync_id:  String(it.product_sync_id || '').trim() || randomUUID(),
      product_name:     name,
      unit:             it.unit || null,
      dispatched_qty:   qty,
      base_price:       base,
      rrp,
      vat_amount:       vatAmt,
      discount_amount:  discAmt,
      cost_price:       cost,
      cost_price_usd:   toUsd(cost),
      // = baseTotal + VAT - discount, to the cent. Not qty * rounded cost.
      line_total:       baseTotal + vatAmt - discAmt,
      destination_slug: dest,
      destination_name: destinationName(dest),
    });
    totalAmount += baseTotal + vatAmt - discAmt;
  }
  return { clean, totalAmount };
}

// POST /api/hq/purchases
// Body: { supplier_name, invoice_number, date, notes,
//         items: [{product_sync_id?, product_name, unit, dispatched_qty,
//                  cost_price, destination_slug}] }
//
// product_sync_id is optional â€” when blank we auto-generate one so the
// destination branch creates a matching product on receive. Pre-existing
// branch products can be linked by passing their sync_id.
router.post('/', hqAuth, (req, res) => {
  try {
    const { supplier_id, supplier_name, invoice_number, date, notes, items } = req.body || {};
    // 2026-09-09 â€” a purchase can be parked as a DRAFT: typed at HQ over a
    // day, corrected, and only then raised. A draft is HQ's own working paper
    // â€” it holds a PO number and it shows in this list, but it is not a
    // purchase yet, so no depot sees it, no GRN can be raised against it and
    // AP never counts it. Everything downstream reads line status, and DRAFT
    // is in none of those lists, so nothing had to learn about it.
    const wantDraft = String(req.body?.status || '').toUpperCase() === 'DRAFT';
    if (!date) return res.status(400).json({ error: 'date is required' });
    // A draft is allowed to be empty â€” that is the point of parking one
    // half-typed. A real purchase is not.
    if (!Array.isArray(items) || (items.length === 0 && !wantDraft)) {
      return res.status(400).json({ error: 'At least one item required' });
    }

    const { ccy, rate } = parseCurrency(req.body || {});
    const { clean, totalAmount } = buildLines(items, ccy, rate);

    const syncId = randomUUID();
    const purchaseNumber = nextPurchaseNumber();
    const createdBy     = req.user.id || null;
    const createdByName = req.user.firstName || req.user.email || 'HQ';

    masterDb.transaction(() => {
      const insHdr = masterDb.prepare(`
        INSERT INTO hq_purchases (purchase_number, sync_id, supplier_id, supplier_name, invoice_number,
                                  date, total_amount, notes, status,
                                  cost_currency, fx_rate_used,
                                  created_by, created_by_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        purchaseNumber, syncId,
        supplier_id || null,
        supplier_name || null, invoice_number || null,
        date, totalAmount, notes || null,
        wantDraft ? 'DRAFT' : 'OPEN',
        ccy, rate,
        createdBy, createdByName
      );
      const purchaseId = insHdr.lastInsertRowid;

      const insItem = masterDb.prepare(`
        INSERT INTO hq_purchase_items (purchase_id, purchase_sync_id, sync_id,
                                       product_sync_id, product_name, unit,
                                       dispatched_qty, base_price, rrp, vat_amount, discount_amount,
                                       cost_price, cost_price_usd, line_total,
                                       destination_slug, destination_name, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const it of clean) {
        insItem.run(
          purchaseId, syncId, randomUUID(),
          it.product_sync_id, it.product_name, it.unit,
          it.dispatched_qty, it.base_price, it.rrp, it.vat_amount, it.discount_amount,
          it.cost_price, it.cost_price_usd, it.line_total,
          it.destination_slug, it.destination_name,
          wantDraft ? 'DRAFT' : 'AWAITING_GRN'
        );
      }
    })();

    // 2026-09-19 â€” wake each depot this delivery is going to. They already got
    // a badge and the on-screen notice, but only while someone was looking at
    // the app; a delivery that arrives at the gate before anyone opens it is
    // exactly the case this is for. A draft has not been sent anywhere yet, so
    // it says nothing. One alert per depot, however many lines they are due.
    if (!wantDraft) {
      try {
        const { notifyBranchRoles } = require('../services/notify');
        const byDepot = new Map();
        for (const it of clean) {
          const s = String(it.destination_slug || '').toLowerCase();
          if (!s) continue;
          byDepot.set(s, (byDepot.get(s) || 0) + 1);
        }
        for (const [s, lines] of byDepot) {
          notifyBranchRoles(s, null, {
            title: 'Stock on the way from HQ',
            body: `${lines} item${lines === 1 ? '' : 's'} Â· ${purchaseNumber}${supplier_name ? ' Â· ' + supplier_name : ''}`,
            data: { type: 'incoming-stock', purchase_number: purchaseNumber },
            channelId: 'kelete-alerts-v1',
          }).catch(() => {});
        }
      } catch (_) { /* never block the dispatch */ }
    }

    res.status(201).json(getOne(syncId));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

function getOne(syncIdOrId) {
  const row = typeof syncIdOrId === 'number'
    ? masterDb.prepare(`SELECT * FROM hq_purchases WHERE id = ?`).get(syncIdOrId)
    : masterDb.prepare(`SELECT * FROM hq_purchases WHERE sync_id = ?`).get(syncIdOrId);
  if (!row) return null;
  const items = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE purchase_id = ? ORDER BY id ASC`).all(row.id);
  return { ...row, items };
}

// GET /api/hq/purchases â€” list (HQ side, all branches).
router.get('/', hqAuth, (req, res) => {
  try {
    const status = String(req.query.status || '').toUpperCase();
    // 2026-09-26 â€” from/to filtered HERE, not in the browser. The list is
    // capped at 500 newest below, so a client-side date filter would quietly
    // return nothing for any range older than the most recent 500 purchases
    // and look like the data had gone missing.
    const from = String(req.query.from || '').slice(0, 10);
    const to   = String(req.query.to   || '').slice(0, 10);
    // A discarded draft is kept only to hold its PO number and to carry the
    // discard out to the mirrors â€” it is not a purchase and never shows.
    let sql = `SELECT * FROM hq_purchases WHERE status <> 'DISCARDED'`;
    const params = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    // date is stored as a plain YYYY-MM-DD, so substr keeps this safe if a
    // row ever carries a time component.
    if (from) { sql += ' AND substr(date, 1, 10) >= ?'; params.push(from); }
    if (to)   { sql += ' AND substr(date, 1, 10) <= ?'; params.push(to);   }
    sql += ' ORDER BY date DESC, id DESC LIMIT 500';
    const headers = masterDb.prepare(sql).all(...params);
    // Per-header counts across the new state machine. AWAITING_GRN +
    // GRN_SUBMITTED together = "still open" so the list can show
    // "3 of 5 confirmed" without 500 separate queries.
    const counts = masterDb.prepare(`
      SELECT purchase_id,
             COUNT(*) AS total,
             -- 2026-09-04 â€” the list showed supplier and total but never WHERE
             -- the goods went, which is the thing HQ scans for. Lines normally
             -- share one destination (the form sends them all to the branch
             -- picked at the top), so MIN gives the name; dest_count catches
             -- the older purchases that were split across branches.
             COUNT(DISTINCT destination_slug) AS dest_count,
             MIN(COALESCE(destination_name, destination_slug)) AS dest_name,
             -- 2026-09-09 â€” every branch a purchase touches, so the list's
             -- destination filter matches a split purchase on any one of its
             -- branches rather than only on the name MIN happened to pick.
             GROUP_CONCAT(DISTINCT destination_slug) AS dest_slugs,
             SUM(CASE WHEN status = 'CONFIRMED'     THEN 1 ELSE 0 END) AS confirmed,
             SUM(CASE WHEN status = 'GRN_SUBMITTED' THEN 1 ELSE 0 END) AS awaiting_confirm,
             SUM(CASE WHEN status = 'AWAITING_GRN'  THEN 1 ELSE 0 END) AS awaiting_grn,
             SUM(CASE WHEN status = 'CANCELLED'     THEN 1 ELSE 0 END) AS cancelled
        FROM hq_purchase_items
       GROUP BY purchase_id
    `).all().reduce((acc, r) => { acc[r.purchase_id] = r; return acc; }, {});
    // 2026-09-04 â€” the GRN raised against each purchase. Red Sea tracks a
    // delivery by its supplier invoice number and quotes the GRN number back
    // to Accounts, and the list showed neither, so both had to be found by
    // opening purchases one at a time. One query for the whole page rather
    // than one per row.
    const grnByPo = masterDb.prepare(
      `SELECT po_sync_id, grn_number, supplier_invoice_number
         FROM hq_grns WHERE deleted_at IS NULL AND po_sync_id IS NOT NULL
        ORDER BY generated_at ASC`
    ).all().reduce((acc, r) => { acc[r.po_sync_id] = r; return acc; }, {});

    const enriched = headers.map(h => ({
      ...h,
      grn_number: grnByPo[h.sync_id]?.grn_number || null,
      // The depot's number wins â€” it is read off the paper that came with the
      // goods. HQ's is what the order was raised against, and is the only one
      // available until a depot confirms.
      invoice_display: h.supplier_invoice_number
        || grnByPo[h.sync_id]?.supplier_invoice_number
        || h.invoice_number
        || null,
      items_total:            counts[h.id]?.total            || 0,
      items_confirmed:        counts[h.id]?.confirmed        || 0,
      items_awaiting_confirm: counts[h.id]?.awaiting_confirm || 0,
      items_awaiting_grn:     counts[h.id]?.awaiting_grn     || 0,
      items_cancelled:        counts[h.id]?.cancelled        || 0,
      // Legacy field kept so older clients don't break â€” same as awaiting_grn.
      items_pending:          counts[h.id]?.awaiting_grn     || 0,
      items_received:         counts[h.id]?.confirmed        || 0,
      dest_count:             counts[h.id]?.dest_count       || 0,
      dest_name:              counts[h.id]?.dest_name        || null,
      dest_slugs:             counts[h.id]?.dest_slugs       || '',
    }));
    res.json({ purchases: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/purchases/incoming?slug=
// Branch-facing â€” every line whose destination_slug matches AND is
// still in flight (AWAITING_GRN = branch must enter actual qty;
// GRN_SUBMITTED = waiting for HQ confirmation, branch can see it but
// can't re-submit). Sort by submitted/created time so the freshest
// arrivals float to the top.
router.get('/incoming', hqAuth, (req, res) => {
  try {
    const slug = String(req.query.slug || '').toLowerCase();
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    // v1.13.91 â€” scope=pending (default, back-compat) keeps the live
    // queue behaviour. scope=history returns confirmed / rejected /
    // cancelled lines so the branch can audit past incoming stock.
    const scope = String(req.query.scope || 'pending').toLowerCase();
    // 2026-08-29 â€” RECEIPT_REPORTED belongs in the live queue.
    //
    // Kelete's branch action is submit-grn, which writes GRN_SUBMITTED, so
    // these two lists were right there. Kelete's branch action is Confirm
    // Received (routes/branchReceipts.js), which writes RECEIPT_REPORTED â€”
    // a status neither list had heard of. The moment a branch confirmed a
    // delivery the line dropped out of Pending and appeared in History,
    // even though HQ had not touched it yet. Confirmed on live data:
    // Kelete 0 RECEIPT_REPORTED rows, Kelete's whole flow producing them.
    //
    // Kelete keeps its own path deliberately â€” Confirm Received captures the
    // supplier invoice number and attachment that ZRA reporting needs, and
    // Kelete's submit-grn takes neither.
    const LIVE_STATUSES = "('AWAITING_GRN', 'GRN_SUBMITTED', 'RECEIPT_REPORTED')";
    // 2026-09-09 â€” history is written as NOT IN the live list, so a status
    // invented later lands in it by default. DRAFT did exactly that: a
    // purchase HQ had not raised yet would have appeared in the depot's
    // Incoming Stock history the moment it was parked. Excluded explicitly â€”
    // the pending arm needs no guard, DRAFT simply is not in its list.
    const whereStatus = scope === 'history'
      ? `i.status NOT IN ${LIVE_STATUSES} AND i.status <> 'DRAFT'`
      : `i.status IN ${LIVE_STATUSES}`;
    const rows = masterDb.prepare(`
      SELECT i.*,
             p.purchase_number, p.supplier_name, p.supplier_id, p.invoice_number,
             p.supplier_invoice_number,
             p.date AS purchase_date, p.notes AS purchase_notes,
             p.created_by_name AS hq_user
        FROM hq_purchase_items i
        -- 2026-08-28 â€” join on sync_id, NOT the integer id. purchase_id holds
        -- HQ's row number; on a synced mirror the local hq_purchases row has a
        -- DIFFERENT auto-number, so p.id = i.purchase_id matches the wrong
        -- purchase or none at all. Measured on a real till: of 20 items the
        -- id join matched 12, and SEVEN of those were attached to the wrong
        -- purchase; the sync_id join matched all 20 correctly. The OR arm is
        -- a fallback for any legacy row that never got a sync_id.
        JOIN hq_purchases p
               ON (p.sync_id = i.purchase_sync_id
                   OR (i.purchase_sync_id IS NULL AND p.id = i.purchase_id))
       WHERE i.destination_slug = ? AND ${whereStatus}
       -- 2026-08-30 â€” newest purchase first, but lines in the order they were
       -- entered. This was "p.date DESC, i.id DESC", which reversed every
       -- purchase's lines, so the branch read the screen bottom-up against a
       -- top-down invoice. p.id DESC keeps two purchases from the same date
       -- from interleaving, which i.id DESC had been doing by accident.
       ORDER BY p.date DESC, p.id DESC, i.id ASC
       LIMIT 500
    `).all(slug);
    res.json({ items: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/purchases/awaiting-confirmation
// HQ-facing â€” every line that branches have submitted GRNs for and
// HQ hasn't confirmed yet. Drives the "Confirm GRN" page + the HQ
// notification badge. Includes the destination slug so HQ knows
// which branch counted what.
router.get('/awaiting-confirmation', hqAuth, (req, res) => {
  try {
    const rows = masterDb.prepare(`
      SELECT i.*,
             p.purchase_number, p.supplier_name, p.invoice_number, p.supplier_invoice_number,
             p.date AS purchase_date, p.created_by_name AS hq_user
        FROM hq_purchase_items i
        -- 2026-08-28 â€” join on sync_id, NOT the integer id. purchase_id holds
        -- HQ's row number; on a synced mirror the local hq_purchases row has a
        -- DIFFERENT auto-number, so p.id = i.purchase_id matches the wrong
        -- purchase or none at all. Measured on a real till: of 20 items the
        -- id join matched 12, and SEVEN of those were attached to the wrong
        -- purchase; the sync_id join matched all 20 correctly. The OR arm is
        -- a fallback for any legacy row that never got a sync_id.
        JOIN hq_purchases p
               ON (p.sync_id = i.purchase_sync_id
                   OR (i.purchase_sync_id IS NULL AND p.id = i.purchase_id))
       WHERE i.status = 'GRN_SUBMITTED'
       ORDER BY COALESCE(i.received_at, p.date) DESC, i.id DESC
       LIMIT 500
    `).all();
    res.json({ items: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/purchases/:id â€” detail (HQ side, with items).
// GET /api/hq/purchases/last-price?product_sync_id=â€¦&supplier_id=â€¦
//
// 2026-09-04 â€” what this item last cost from this supplier. The form used to
// prefill Base Price from products.cost_price, which is the LANDED cost â€”
// base plus VAT less discount, blended by WAC â€” and therefore never a figure
// the supplier printed. Operators saw a number that looked authoritative and
// was not the one on the invoice in their hand.
//
// Scoped to the supplier first, because the same water costs different money
// from Zambian Breweries and from Varun; "last paid" only means something
// within one supplier. Falls back to any supplier, then to nothing â€” a blank
// is honest, an inherited price from someone else is not.
//
// Registered above /:id: Express matches in order and 'last-price' would
// otherwise be read as an id.
router.get('/last-price', hqAuth, (req, res) => {
  try {
    const productSyncId = String(req.query.product_sync_id || '').trim();
    const supplierId = req.query.supplier_id ? parseInt(req.query.supplier_id, 10) : null;
    if (!productSyncId) return res.json({});

    const pick = (bySupplier) => masterDb.prepare(
      `SELECT i.base_price, i.rrp, i.discount_amount, i.dispatched_qty, p.date, p.supplier_name
         FROM hq_purchase_items i
         JOIN hq_purchases p ON p.id = i.purchase_id
        WHERE i.product_sync_id = ?
          AND i.base_price > 0
          -- 2026-09-09 â€” a draft is a price nobody has committed to yet, and
          -- half of it may be mid-typing. It must not become "the last price"
          -- that prefills the next purchase.
          AND p.status NOT IN ('DRAFT', 'DISCARDED')
          ${bySupplier ? 'AND p.supplier_id = ?' : ''}
        ORDER BY p.date DESC, i.id DESC
        LIMIT 1`
    ).get(...(bySupplier ? [productSyncId, supplierId] : [productSyncId]));

    const row = (supplierId ? pick(true) : null) || pick(false);
    if (!row) return res.json({});
    res.json({
      base_price: row.base_price,
      rrp: row.rrp || 0,
      // 2026-09-11 â€” the discount per unit on that same line, so the form can
      // remember it the way it remembers the base price. discount_amount is
      // the line total; per unit it follows whatever qty is typed next time.
      base_discount: row.dispatched_qty > 0 ? (parseFloat(row.discount_amount) || 0) / row.dispatched_qty : 0,
      from: row.supplier_name || null,
      date: row.date || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/hq/purchases/trace?q=â€¦
//
// 2026-09-04 â€” "where has this purchase got to?", answered by the number the
// supplier uses. Red Sea deals with suppliers by invoice number, not by our
// PO number, so a search that only matched HQP-2026-00041 was no use on the
// phone to Pepsi.
//
// Matches, in order of confidence: supplier invoice number (on the PO, on the
// GRN), our PO number, our GRN number. A GRN match resolves back to its PO so
// every hit is one purchase with one timeline.
//
// The invoice number can live in three places for the same purchase:
//   hq_purchases.invoice_number          â€” typed at HQ when the PO is raised
//   hq_purchases.supplier_invoice_number â€” stamped by the depot at confirm
//   hq_grns.supplier_invoice_number      â€” copied at GRN generation
// All three are searched. They should agree; when they do not, that is a
// finding rather than an error, and the result carries all three.
//
// Registered above /:id â€” Express matches in order.
router.get('/trace', hqAuth, (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const like = '%' + q + '%';

    // PO sync_ids reached directly, plus those reached via a GRN.
    const direct = masterDb.prepare(
      `SELECT sync_id FROM hq_purchases
        WHERE status <> 'DISCARDED'
          AND (supplier_invoice_number LIKE ? COLLATE NOCASE
               OR invoice_number          LIKE ? COLLATE NOCASE
               OR purchase_number         LIKE ? COLLATE NOCASE)
        ORDER BY date DESC, id DESC LIMIT 25`
    ).all(like, like, like).map(r => r.sync_id);

    const viaGrn = masterDb.prepare(
      `SELECT po_sync_id FROM hq_grns
        WHERE deleted_at IS NULL
          AND (supplier_invoice_number LIKE ? COLLATE NOCASE
               OR grn_number           LIKE ? COLLATE NOCASE)
        ORDER BY generated_at DESC LIMIT 25`
    ).all(like, like).map(r => r.po_sync_id).filter(Boolean);

    const syncIds = [...new Set([...direct, ...viaGrn])].slice(0, 10);
    if (syncIds.length === 0) return res.json({ results: [] });

    const results = syncIds.map((syncId) => {
      const po = masterDb.prepare('SELECT * FROM hq_purchases WHERE sync_id = ?').get(syncId);
      if (!po) return null;

      const lines = masterDb.prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'CONFIRMED' THEN 1 ELSE 0 END) AS confirmed,
                SUM(CASE WHEN status = 'CANCELLED' THEN 1 ELSE 0 END) AS cancelled,
                COUNT(DISTINCT destination_slug) AS dest_count,
                MIN(COALESCE(destination_name, destination_slug)) AS dest_name
           FROM hq_purchase_items WHERE purchase_sync_id = ?`
      ).get(syncId) || {};

      const grn = masterDb.prepare(
        `SELECT * FROM hq_grns WHERE po_sync_id = ? AND deleted_at IS NULL
          ORDER BY generated_at DESC LIMIT 1`
      ).get(syncId);

      const ap = grn ? masterDb.prepare(
        'SELECT * FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?'
      ).get(grn.sync_id) : null;

      // Every stage of the pipeline, done or not. Returning only the completed
      // ones made a purchase sitting in the Accounts queue look finished â€” the
      // list simply stopped at "GRN generated" with no hint that a check, an
      // approval and a payment were still owed. A stage carries done:false and
      // no timestamp instead of being omitted.
      // 2026-09-09 â€” a draft is findable by its invoice number on purpose:
      // if the number someone is chasing is sitting in a half-typed draft,
      // "not found" is the wrong answer. But it has been raised with nobody
      // and sent nowhere, so neither of the first two stages is done.
      const isDraft = po.status === 'DRAFT';
      const steps = [
        {
          key: 'raised', label: isDraft ? 'Draft at HQ â€” not raised yet' : 'Raised at HQ',
          done: !isDraft,
          at: isDraft ? null : (po.created_at || po.date), by: po.created_by_name || null,
          detail: po.purchase_number,
        },
        {
          key: 'sent',
          label: 'Sent to ' + (lines.dest_count > 1 ? (lines.dest_count + ' depots') : (lines.dest_name || 'depot')),
          done: !isDraft, at: isDraft ? null : po.date, by: null,
          detail: (lines.total || 0) + ' line' + ((lines.total || 0) === 1 ? '' : 's'),
        },
        {
          key: 'received', label: 'Received & counted at depot',
          done: !!po.confirmed_at_branch,
          at: po.confirmed_at_branch || null, by: po.confirmed_by_branch_name || null,
          detail: po.confirmed_at_branch && po.supplier_invoice_number
            ? ('Invoice ' + po.supplier_invoice_number) : null,
        },
        {
          key: 'grn', label: 'GRN generated', done: !!grn,
          at: (grn && grn.generated_at) || null, by: (grn && grn.generated_by_hq_name) || null,
          detail: (grn && grn.grn_number) || null,
        },
        {
          key: 'checked', label: 'Checked by Accounts', done: !!(ap && ap.checked_at),
          at: (ap && ap.checked_at) || null, by: (ap && ap.checked_by_name) || null, detail: null,
        },
        {
          key: 'approved', label: 'Approved by Finance', done: !!(ap && ap.approved_at),
          at: (ap && ap.approved_at) || null, by: (ap && ap.approved_by_name) || null, detail: null,
        },
        {
          key: 'paid', label: 'Paid', done: !!(ap && ap.paid_at),
          at: (ap && ap.paid_at) || null, by: (ap && ap.paid_by_name) || null, detail: null,
        },
      ];

      // Send-Back is not a status of its own â€” it rolls ap_status back to
      // PENDING â€” so it gets its own step or it vanishes from the history.
      // Inserted before the stage it was rejected from, which is where it
      // happened in time.
      if (ap && ap.sent_back_at) {
        const rejected = String(ap.sent_back_from_stage || '').toLowerCase();
        const at = steps.findIndex(x => x.key === (rejected === 'approved' ? 'approved' : 'checked'));
        steps.splice(at < 0 ? steps.length : at, 0, {
          key: 'sent_back',
          label: 'Sent back from ' + (ap.sent_back_from_stage || 'AP'),
          done: true, at: ap.sent_back_at, by: ap.sent_back_by_name || null,
          detail: ap.sent_back_reason || null, warn: true,
        });
      }

      // 'SENT' is the fall-through, so a draft claimed to have been sent to a
      // depot while both of its steps read not-done. It gets its own stage.
      const stage = isDraft ? 'DRAFT'
        : (ap && ap.paid_at) ? 'PAID'
        : (ap && ap.approved_at) ? 'APPROVED'
        : (ap && ap.checked_at) ? 'CHECKED'
        : grn ? 'GRN'
        : po.confirmed_at_branch ? 'RECEIVED'
        : 'SENT';

      return {
        purchase_sync_id: po.sync_id,
        purchase_number:  po.purchase_number,
        supplier_name:    po.supplier_name,
        date:             po.date,
        total_amount:     po.total_amount,
        status:           po.status,
        destination:      lines.dest_count > 1 ? (lines.dest_count + ' depots') : (lines.dest_name || null),
        lines_total:      lines.total || 0,
        lines_confirmed:  lines.confirmed || 0,
        // All three numbers, so a mismatch between what HQ raised and what the
        // depot read off the paper is visible rather than averaged away.
        invoice_raised:   po.invoice_number || null,
        invoice_received: po.supplier_invoice_number || null,
        invoice_on_grn:   (grn && grn.supplier_invoice_number) || null,
        grn_number:       (grn && grn.grn_number) || null,
        grn_sync_id:      (grn && grn.sync_id) || null,
        final_payable:    (grn && grn.final_payable != null) ? grn.final_payable : null,
        ap_status:        (ap && ap.ap_status) || null,
        stage,
        steps,
      };
    }).filter(Boolean);

    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', hqAuth, (req, res) => {
  try {
    const out = getOne(parseInt(req.params.id, 10));
    // A discarded draft is kept for its PO number alone. Nothing links to it,
    // but a stale tab from before the discard would otherwise reopen it.
    if (!out || out.status === 'DISCARDED') return res.status(404).json({ error: 'Purchase not found' });
    res.json(out);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Auto-promote a header to COMPLETED once every line is CONFIRMED,
// CANCELLED, or BRANCH_REJECTED (v1.9.7). Called from confirm + cancel
// + branch-reject endpoints. Stays OPEN while anything is still
// AWAITING_GRN or GRN_SUBMITTED.
function maybeCompleteHeader(purchaseId) {
  const cnt = masterDb.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('AWAITING_GRN','GRN_SUBMITTED','RECEIPT_REPORTED') THEN 1 ELSE 0 END) AS open,
      SUM(CASE WHEN status = 'CONFIRMED'       THEN 1 ELSE 0 END) AS confirmed,
      SUM(CASE WHEN status = 'CANCELLED'       THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN status = 'BRANCH_REJECTED' THEN 1 ELSE 0 END) AS branch_rejected
      FROM hq_purchase_items WHERE purchase_id = ?
  `).get(purchaseId);
  if ((cnt.open || 0) === 0) {
    // Header is COMPLETED if at least one line ended up CONFIRMED, else
    // CANCELLED (all lines were cancelled / branch-rejected).
    const next = (cnt.confirmed || 0) > 0 ? 'COMPLETED' : 'CANCELLED';
    // 2026-08-28 â€” no manual updated_at: the master-sync touch trigger owns it.
    // Setting it here would make the trigger skip and this status change would
    // silently never sync. See masterDb.js CONTRACT block.
    masterDb.prepare(`UPDATE hq_purchases SET status = ? WHERE id = ?`).run(next, purchaseId);
  }
}

// PUT /api/hq/purchases/items/:itemId/submit-grn
// Branch action. Records the actual qty that physically arrived; line
// moves AWAITING_GRN â†’ GRN_SUBMITTED. **No stock change at the branch
// yet** â€” that happens when HQ confirms the GRN, because HQ is the only
// place authorised to lock in supplier AP. If branch needs to re-submit
// (HQ rejected), the same endpoint accepts it again from AWAITING_GRN.
router.put('/items/:itemId/submit-grn', hqAuth, (req, res) => {
  try {
    // v1.8.65 â€” reason field aligned with transfer_variances vocabulary.
    // Accepts 'OK' | 'Short' | 'Damaged' | 'Lost'. Defaults to derived
    // value based on received vs dispatched if absent (back-compat).
    const { received_qty, variance_notes, reason } = req.body || {};
    const receivedQty = parseFloat(received_qty);
    if (!(receivedQty >= 0)) return res.status(400).json({ error: 'received_qty must be >= 0' });

    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    if (item.status !== 'AWAITING_GRN') return res.status(400).json({ error: `Line is ${item.status} â€” only AWAITING_GRN lines can submit a GRN` });
    if (!isRegistered(item.destination_slug)) return res.status(400).json({ error: `Destination "${item.destination_slug}" no longer registered` });

    const receivedBy = req.user.id || null;
    const receivedByName = req.user.firstName || req.user.email || 'Branch';
    const dispatched = parseFloat(item.dispatched_qty || 0);
    const allowed = new Set(['OK', 'Short', 'Damaged', 'Lost']);
    const resolvedReason = allowed.has(reason)
      ? reason
      : (Math.abs(receivedQty - dispatched) < 0.0001 ? 'OK' : (receivedQty < dispatched ? 'Short' : 'OK'));

    masterDb.prepare(`
      UPDATE hq_purchase_items
         SET status = 'GRN_SUBMITTED',
             received_qty = ?,
             variance_notes = ?,
             reason = ?,
             received_by = ?,
             received_by_name = ?,
             received_at = datetime('now')
       WHERE id = ?
    `).run(receivedQty, variance_notes || null, resolvedReason, receivedBy, receivedByName, req.params.itemId);

    // 2026-09-19 â€” tell HQ. This line is now sitting in Generate GRN, and
    // until someone there generates it there is no GRN and no payable: the
    // supplier's invoice has nothing in the system to match it to. HQ had no
    // way of knowing except to go and look. Fire-and-forget, one alert per
    // delivery rather than per line â€” the alert only fires on the FIRST line
    // of a purchase to confirm, or a 40-line delivery would buzz 40 times.
    try {
      const stillOpen = masterDb.prepare(
        `SELECT COUNT(*) AS n FROM hq_purchase_items
          WHERE purchase_id = ? AND destination_slug = ? AND status = 'GRN_SUBMITTED'`
      ).get(item.purchase_id, item.destination_slug)?.n;
      if (Number(stillOpen) === 1) {
        const p = masterDb.prepare('SELECT purchase_number, supplier_name FROM hq_purchases WHERE id = ?').get(item.purchase_id);
        const depot = (() => {
          try { return listTenants().find(t => t.slug === item.destination_slug)?.business_name || item.destination_slug; }
          catch (_) { return item.destination_slug; }
        })();
        require('../services/notify').notifyHqRoles(['Administrator', 'Manager', 'Accountant'], {
          title: 'Delivery confirmed â€” GRN needed',
          body: `${depot} confirmed ${p?.purchase_number || 'a delivery'}${p?.supplier_name ? ' Â· ' + p.supplier_name : ''}`,
          data: { type: 'grn-pending', purchase_number: p?.purchase_number || '', slug: item.destination_slug },
          channelId: 'kelete-alerts-v1',
        }).catch(() => {});
      }
    } catch (_) { /* never block the branch's confirmation */ }
    res.json({
      item: masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId),
      purchase_status: masterDb.prepare(`SELECT status FROM hq_purchases WHERE id = ?`).get(item.purchase_id)?.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/items/:itemId/confirm
// HQ action â€” accepts the branch's GRN. This is the ONLY place that
// touches branch stock: products.current_stock bumps + a stock_movement
// row gets minted (movement_type='hq_receipt'). After this point the
// supplier AP is committed and can be paid via /hq/suppliers/:id/payments.
// Body: { confirm_notes? }  (HQ doesn't override the qty â€” if HQ disagrees
// with the branch count it rejects instead.)
router.put('/items/:itemId/confirm', hqAuth, (req, res) => {
  try {
    const { confirm_notes } = req.body || {};
    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    if (item.status !== 'GRN_SUBMITTED') return res.status(400).json({ error: `Line is ${item.status} â€” only GRN_SUBMITTED lines can be confirmed` });

    const toSlug = item.destination_slug;
    if (!isRegistered(toSlug)) return res.status(400).json({ error: `Destination "${toSlug}" no longer registered` });
    const toDb = getTenantDb(toSlug);

    const confirmedBy     = req.user.id || null;
    const confirmedByName = req.user.firstName || req.user.email || 'HQ';
    // v1.8.99 â€” stock_movements.created_by FK references users(id) ON THE
    // BRANCH DB. HQ users don't exist there â†’ FOREIGN KEY constraint failed.
    // Same fix as v1.8.96 Confirm Damages: pass NULL for the branch-side
    // movement's created_by. HQ user identity is preserved on the master
    // hq_purchase_items row (confirmed_by + confirmed_by_name snapshot).
    const branchSideCreatedBy = null;
    const qty = parseFloat(item.received_qty) || 0;

    toDb.transaction(() => {
      // Find product at branch by sync_id (preferred) then name; auto-
      // create from the line snapshot if neither matches. Same logic as
      // the deprecated /receive endpoint â€” moved here so it only fires
      // at confirm time (the whole point of the v1.3.0 state machine).
      let prod = toDb.prepare(`
        SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
          FROM products WHERE sync_id = ? AND deleted_at IS NULL
      `).get(item.product_sync_id);
      if (!prod) {
        prod = toDb.prepare(`
          SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
            FROM products WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL
            ORDER BY id ASC LIMIT 1
        `).get(item.product_name);
      }
      if (!prod) {
        const baseUnit = item.unit || 'pcs';
        const cost     = parseFloat(item.cost_price || 0) || 0;
        const info = toDb.prepare(`
          INSERT INTO products (name, unit, cost_price, selling_price,
                                current_stock, min_stock, status,
                                sync_id, tenant_id, branch_id, device_id, synced,
                                created_at, updated_at)
          VALUES (?,?,?,?,0,0,'Active',?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(item.product_name, baseUnit, cost, cost,
                item.product_sync_id, null, null, null);
        prod = toDb.prepare(
          'SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?'
        ).get(info.lastInsertRowid);
      }

      const baseQty = qty * conversionToBase(prod, item.unit);
      toDb.prepare(`
        UPDATE products SET current_stock = current_stock + ?,
                            updated_at = datetime('now'),
                            synced = 0
         WHERE sync_id = ?
      `).run(baseQty, prod.sync_id);
      toDb.prepare(`
        INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                     quantity, reference_type, reference_sync_id,
                                     notes, created_by, sync_id, tenant_id, branch_id, device_id,
                                     synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(
        prod.id, prod.sync_id, 'sales', 'hq_receipt',
        baseQty, 'hq_purchase', item.sync_id,
        `HQ Purchase confirmed${confirm_notes ? ' â€” ' + confirm_notes : ''}`,
        branchSideCreatedBy,
        randomUUID(), null, null, null
      );
    })();

    masterDb.prepare(`
      UPDATE hq_purchase_items
         SET status = 'CONFIRMED',
             confirmed_by = ?,
             confirmed_by_name = ?,
             confirmed_at = datetime('now'),
             confirm_notes = ?
       WHERE id = ?
    `).run(confirmedBy, confirmedByName, confirm_notes || null, req.params.itemId);

    maybeCompleteHeader(item.purchase_id);

    res.json({
      item: masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId),
      purchase_status: masterDb.prepare(`SELECT status FROM hq_purchases WHERE id = ?`).get(item.purchase_id)?.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/items/:itemId/reject
// HQ action â€” pushes a GRN_SUBMITTED line back to the branch for a recount.
// confirm_notes captures the reason ("recount needed", "supplier delivery
// note says 8 not 10", etc); branch sees it on their Pending GRN screen.
router.put('/items/:itemId/reject', hqAuth, (req, res) => {
  try {
    const { confirm_notes } = req.body || {};
    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    if (item.status !== 'GRN_SUBMITTED') return res.status(400).json({ error: `Line is ${item.status} â€” only GRN_SUBMITTED lines can be rejected` });

    masterDb.prepare(`
      UPDATE hq_purchase_items
         SET status = 'AWAITING_GRN',
             received_qty = NULL,
             received_by = NULL,
             received_by_name = NULL,
             received_at = NULL,
             confirm_notes = ?
       WHERE id = ?
    `).run(confirm_notes || 'Rejected â€” recount requested', req.params.itemId);

    res.json({
      item: masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId),
      purchase_status: masterDb.prepare(`SELECT status FROM hq_purchases WHERE id = ?`).get(item.purchase_id)?.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/:syncId/branch-reject-all
// 2026-08-31 â€” reject the WHOLE delivery, in one transaction.
//
// Rejecting one line of a delivery is not a real operation: a truck arrives
// or it does not. Per-line reject let a branch decline one product and
// confirm the rest, leaving a PO half-rejected and an invoice that matches
// neither side. The branch action is now all-or-nothing; if only some of
// what arrived is wrong, that is a short receipt or a credit note, both of
// which already exist.
//
// The per-line endpoint below stays for HQ tooling and older clients.
//
// Body: { reason } â€” required, surfaced on HQ's incoming view.
router.put('/:syncId/branch-reject-all', hqAuth, (req, res) => {
  try {
    const reason = ((req.body && req.body.reason) || '').toString().trim();
    if (!reason) return res.status(400).json({ error: 'A rejection reason is required.' });

    const purchase = masterDb.prepare('SELECT * FROM hq_purchases WHERE sync_id = ?').get(req.params.syncId);
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

    const slug = (req.query.slug || req.body.slug || '').toString().trim().toLowerCase();
    const lines = masterDb.prepare(
      `SELECT * FROM hq_purchase_items
        WHERE purchase_sync_id = ? AND status = 'AWAITING_GRN'
          ${slug ? 'AND destination_slug = ?' : ''}`
    ).all(...(slug ? [req.params.syncId, slug] : [req.params.syncId]));

    if (lines.length === 0) {
      return res.status(400).json({ error: 'Nothing left to reject on this delivery â€” its lines are no longer awaiting a GRN.' });
    }

    const actor = req.user.firstName || req.user.email || 'branch';
    masterDb.transaction(() => {
      const upd = masterDb.prepare(`
        UPDATE hq_purchase_items
           SET status                  = 'BRANCH_REJECTED',
               branch_rejected_by      = ?,
               branch_rejected_by_name = ?,
               branch_rejected_at      = datetime('now'),
               branch_reject_reason    = ?
         WHERE id = ?
      `);
      let dropped = 0;
      for (const l of lines) {
        upd.run(req.user.id || null, actor, reason, l.id);
        dropped += parseFloat(l.line_total) || 0;
      }
      // Rejected lines don't count toward supplier AP â€” drop their value from
      // the header total in one go, so a partial failure cannot leave the
      // header disagreeing with its lines.
      masterDb.prepare(`
        UPDATE hq_purchases
           SET total_amount = MAX(0, total_amount - ?),
               updated_at   = datetime('now')
         WHERE id = ?
      `).run(dropped, purchase.id);
    })();

    try { maybeCompleteHeader(purchase.id); } catch (_) { /* header status is recomputed on read too */ }
    res.json({ ok: true, rejected: lines.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/items/:itemId/branch-reject
// v1.9.7 â€” branch action. Branch can decline an incoming PO line (wrong
// branch, wrong supplier, item doesn't match what they were expecting,
// etc.) instead of being forced to generate a GRN for it. Status
// becomes BRANCH_REJECTED (terminal) and the rejection appears on the
// HQ Purchases list with the reason so HQ can re-issue the line to a
// different branch or cancel it outright.
//
// Body: { reason }  â€” required, surfaced on HQ's incoming view.
router.put('/items/:itemId/branch-reject', hqAuth, (req, res) => {
  try {
    const reason = ((req.body && req.body.reason) || '').toString().trim();
    if (!reason) return res.status(400).json({ error: 'A rejection reason is required.' });
    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    // Only AWAITING_GRN lines can be branch-rejected. Once a GRN exists
    // (GRN_SUBMITTED / CONFIRMED) the rejection has to come from HQ
    // via the GRN-level reject path.
    if (item.status !== 'AWAITING_GRN') {
      return res.status(400).json({ error: `Line is ${item.status} â€” branch can only reject AWAITING_GRN lines.` });
    }

    masterDb.transaction(() => {
      masterDb.prepare(`
        UPDATE hq_purchase_items
           SET status                  = 'BRANCH_REJECTED',
               branch_rejected_by      = ?,
               branch_rejected_by_name = ?,
               branch_rejected_at      = datetime('now'),
               branch_reject_reason    = ?
         WHERE id = ?
      `).run(req.user.id || null, req.user.firstName || req.user.email || 'branch', reason, req.params.itemId);

      // Rejected lines don't count toward supplier AP â€” drop their value
      // from the header total so HQ AP stays accurate.
      masterDb.prepare(`
        UPDATE hq_purchases
           SET total_amount = MAX(0, total_amount - ?),
               updated_at   = datetime('now')
         WHERE id = ?
      `).run(item.line_total || 0, item.purchase_id);
    })();

    maybeCompleteHeader(item.purchase_id);

    res.json({
      item: masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId),
      purchase_status: masterDb.prepare(`SELECT status FROM hq_purchases WHERE id = ?`).get(item.purchase_id)?.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/items/:itemId/cancel â€” drop a single line that
// hasn't been CONFIRMED yet (AWAITING_GRN or GRN_SUBMITTED â€” both safe,
// no branch stock has moved). Confirmed lines can't be cancelled here
// because they already changed branch stock; you'd need a damages /
// adjustment flow for that.
router.put('/items/:itemId/cancel', hqAuth, (req, res) => {
  try {
    const item = masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId);
    if (!item) return res.status(404).json({ error: 'Line not found' });
    if (!['AWAITING_GRN', 'GRN_SUBMITTED'].includes(item.status)) {
      return res.status(400).json({ error: `Line is ${item.status} â€” only un-confirmed lines can be cancelled` });
    }

    masterDb.transaction(() => {
      masterDb.prepare(`
        UPDATE hq_purchase_items
           SET status = 'CANCELLED',
               variance_notes = COALESCE(NULLIF(variance_notes,''), 'Cancelled at HQ')
         WHERE id = ?
      `).run(req.params.itemId);

      // Header total drops by this line's value so AP stays accurate.
      masterDb.prepare(`
        UPDATE hq_purchases
           SET total_amount = MAX(0, total_amount - ?),
               updated_at   = datetime('now')
         WHERE id = ?
      `).run(item.line_total || 0, item.purchase_id);

      maybeCompleteHeader(item.purchase_id);
    })();

    res.json({
      item:            masterDb.prepare(`SELECT * FROM hq_purchase_items WHERE id = ?`).get(req.params.itemId),
      purchase_status: masterDb.prepare(`SELECT status FROM hq_purchases WHERE id = ?`).get(item.purchase_id)?.status,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/:id/cancel â€” cancel an entire purchase. Rejected
// if any line has already been CONFIRMED (those lines moved real stock at
// a branch; cancellation would need a counter-movement which v1.3 doesn't
// support â€” use the damages workflow for that). AWAITING_GRN +
// GRN_SUBMITTED lines flip to CANCELLED in one go.
router.put('/:id/cancel', hqAuth, (req, res) => {
  try {
    const p = masterDb.prepare(`SELECT * FROM hq_purchases WHERE id = ?`).get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Purchase not found' });
    if (p.status === 'CANCELLED' || p.status === 'COMPLETED') {
      return res.status(400).json({ error: `Purchase is already ${p.status}` });
    }
    const confirmed = masterDb.prepare(`
      SELECT COUNT(*) AS n FROM hq_purchase_items WHERE purchase_id = ? AND status = 'CONFIRMED'
    `).get(req.params.id).n;
    if (confirmed > 0) {
      return res.status(400).json({ error: `Cannot cancel â€” ${confirmed} line(s) already confirmed (stock at branch). Cancel them individually first if you need to.` });
    }
    masterDb.transaction(() => {
      masterDb.prepare(`
        UPDATE hq_purchase_items
           SET status = 'CANCELLED',
               variance_notes = COALESCE(NULLIF(variance_notes,''), 'Cancelled at HQ')
         WHERE purchase_id = ? AND status IN ('AWAITING_GRN', 'GRN_SUBMITTED')
      `).run(req.params.id);
      masterDb.prepare(`
        UPDATE hq_purchases
           SET status = 'CANCELLED', total_amount = 0, updated_at = datetime('now')
         WHERE id = ?
      `).run(req.params.id);
    })();
    res.json(getOne(parseInt(req.params.id, 10)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/purchases/:id
// Save a draft â€” and, with { status: 'OPEN' }, raise it.
//
// 2026-09-09 â€” the only route in this file that rewrites a purchase's lines,
// and it is safe precisely because it refuses to run on anything but a DRAFT.
// A draft has never been seen by a depot, has no GRN, no receipt and no AP
// entry, so there is nothing downstream to keep in step. The instant it is
// raised this route stops answering for it, and every existing rule applies.
router.put('/:id', hqAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const p = masterDb.prepare(`SELECT * FROM hq_purchases WHERE id = ?`).get(id);
    if (!p) return res.status(404).json({ error: 'Purchase not found' });
    if (p.status !== 'DRAFT') {
      return res.status(400).json({ error: `Only a draft can be edited â€” this purchase is ${p.status}.` });
    }

    const { supplier_id, supplier_name, invoice_number, date, notes, items } = req.body || {};
    const promote = String(req.body?.status || 'DRAFT').toUpperCase() === 'OPEN';
    if (!date) return res.status(400).json({ error: 'date is required' });
    if (!Array.isArray(items) || (items.length === 0 && promote)) {
      return res.status(400).json({ error: 'At least one item required' });
    }

    const { ccy, rate } = parseCurrency(req.body || {});
    const { clean, totalAmount } = buildLines(items, ccy, rate);
    const lineStatus = promote ? 'AWAITING_GRN' : 'DRAFT';

    masterDb.transaction(() => {
      // Lines are replaced rather than matched up: the operator can add,
      // remove and reorder rows freely while a purchase is a draft, so there
      // is no stable identity to match on. Nothing references a draft line.
      masterDb.prepare(`DELETE FROM hq_purchase_items WHERE purchase_id = ?`).run(id);
      const insItem = masterDb.prepare(`
        INSERT INTO hq_purchase_items (purchase_id, purchase_sync_id, sync_id,
                                       product_sync_id, product_name, unit,
                                       dispatched_qty, base_price, rrp, vat_amount, discount_amount,
                                       cost_price, cost_price_usd, line_total,
                                       destination_slug, destination_name, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const it of clean) {
        insItem.run(
          id, p.sync_id, randomUUID(),
          it.product_sync_id, it.product_name, it.unit,
          it.dispatched_qty, it.base_price, it.rrp, it.vat_amount, it.discount_amount,
          it.cost_price, it.cost_price_usd, it.line_total,
          it.destination_slug, it.destination_name,
          lineStatus
        );
      }
      // No updated_at here â€” the master-sync trigger owns it, and setting it
      // makes the trigger skip, leaving the change unsynced. See the CONTRACT
      // block in config/masterDb.js.
      masterDb.prepare(`
        UPDATE hq_purchases
           SET supplier_id = ?, supplier_name = ?, invoice_number = ?, date = ?,
               notes = ?, total_amount = ?, cost_currency = ?, fx_rate_used = ?,
               status = ?
         WHERE id = ?
      `).run(
        supplier_id || null, supplier_name || null, invoice_number || null, date,
        notes || null, totalAmount, ccy, rate,
        promote ? 'OPEN' : 'DRAFT',
        id
      );
    })();

    res.json(getOne(id));
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// DELETE /api/hq/purchases/:id â€” discard a draft.
//
// The header is marked DISCARDED and kept; it is not deleted. Two reasons,
// both found by testing the hard delete that was here first:
//
//   The PO number. nextPurchaseNumber() takes MAX of the numbers on file, so
//   deleting the newest row lowers that maximum and the very next purchase is
//   issued the number just thrown away. The comment here used to claim the
//   opposite. Keeping the row keeps the number spent.
//
//   The mirrors. hq_purchases syncs to every branch by trigger, and the
//   triggers fire on INSERT and UPDATE â€” a DELETE propagates nothing. A draft
//   that had already reached a mirror would have stayed there for good, and a
//   later purchase reusing its number would then collide with it on
//   purchase_number UNIQUE. An UPDATE syncs; a DELETE cannot.
//
// The lines are left as they are. DRAFT lines are already excluded everywhere
// a line status is read, so there is nothing further to suppress.
router.delete('/:id', hqAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const p = masterDb.prepare(`SELECT * FROM hq_purchases WHERE id = ?`).get(id);
    if (!p) return res.status(404).json({ error: 'Purchase not found' });
    if (p.status !== 'DRAFT') {
      return res.status(400).json({ error: `Only a draft can be deleted â€” this purchase is ${p.status}. Cancel it instead.` });
    }
    // No updated_at â€” the master-sync trigger owns it (config/masterDb.js).
    masterDb.prepare(`UPDATE hq_purchases SET status = 'DISCARDED' WHERE id = ?`).run(id);
    res.json({ ok: true, purchase_number: p.purchase_number });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2026-08-29 â€” exported so hqGrns.js can call it after Generate GRN.
// Kelete's whole purchase flow ends there, and it was the ONE finishing
// action that never promoted the header: three callers below, none of them
// the button anyone uses. Live data showed it plainly â€” Kelete 109 purchases
// COMPLETED, Kelete 0, with 26 confirmed lines sitting under 18 headers
// still marked OPEN.
module.exports = router;
module.exports.maybeCompleteHeader = maybeCompleteHeader;
