// Supplier Credit Notes — money the supplier owes you.
//
// Two sources, surfaced via the `reason` field:
//   - 'Discount' / 'Other'        → real income event. Profit Report counts
//                                   these as "Supplier Rebates" (positive
//                                   line under Gross Profit).
//   - 'Crate Return' / 'Bottle    → deposit refund. NOT income. Reduces AP
//      Return'                      balance + posts negative stock movements
//                                   for the returned empties. Profit Report
//                                   IGNORES these.
//
// All credit notes reduce the supplier's outstanding balance (the AP page's
// `balance` aggregate subtracts SUM(supplier_credit_notes.amount)).

const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { recalculateDailyProfit } = require('../config/profitHelper');
const { isSingleLocationMode, returnLocation } = require('../config/autoSivHelper');
const { randomUUID } = require('crypto');
const { masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
// 2026-08-31 — a GRN's stored payable has to follow its credit notes.
// cn_total was written once at branch confirm and these two routes never
// touched it, so deleting a K66,322 credit corrected the supplier ledger
// while leaving that GRN showing a payable K66,322 too low — underpaid, with
// nothing to flag it.
const { recomputeGrnPayable } = require('../services/grnPayable');
const { getHostSlug, isHqRequest } = require('../middleware/hqPush');

// HQ's list filters on tenant_id, so a depot's note has to carry HQ's — not
// the depot's, or it lands in HQ's table and is still filtered out of view.
function hqTenantId(hqDb) {
  try {
    return hqDb.prepare('SELECT tenant_id FROM business_settings LIMIT 1').get()?.tenant_id || null;
  } catch (_) { return null; }
}

// GET /api/credit-notes/linkable-grns[?supplier_sync_id=…]
//
// 2026-09-04 — a depot confirms Incoming Stock the moment the truck arrives so
// it can start selling, and only finds the breakages once offloading is done.
// By then the credit note has nowhere to attach: the Credit Notes page sends
// grn_sync_id = null, and the branch's own GRN table is empty because HQ owns
// all procurement. So the branch phoned HQ and HQ raised it — for damage the
// branch is the only one who saw.
//
// This is the picker that lets them raise it themselves: the HQ GRNs actually
// delivered to THIS branch, still unpaid. On HQ it lists every branch's, so
// nothing HQ could do before is lost.
//
// PAID is excluded on purpose. Once the payable is settled a late credit means
// we have overpaid, and that is a supplier-balance matter rather than a line
// on a closed invoice — the same reasoning as the confirm-review guard, which
// says "attach the credit to an unpaid GRN, or leave it for the supplier to
// offset".
router.get('/linkable-grns', auth, (req, res) => {
  try {
    if (!masterDb) return res.json({ rows: [] });
    const hq = isHqRequest(req);
    const slug = getHostSlug(req);
    const supplier = String(req.query.supplier_sync_id || '').trim();

    // 2026-09-17 — a voided GRN can't take a credit note either.
    const where = ["COALESCE(ap_status,'PENDING') NOT IN ('PAID','VOIDED')"];
    const args = [];
    if (!hq) { where.push('branch_slug = ?'); args.push(slug); }
    // 2026-09-06 — match on any identifier the row actually holds, not just
    // supplier_sync_id. The GRN generator wrote that column as a hard NULL
    // until 2026-09-05, so every earlier GRN is invisible to a sync_id
    // filter: picking ZAMBIAN BREWERIES at Chipata offered one invoice out of
    // two, and PEPSI offered none at all. supplier_id and supplier_name are
    // populated on every row.
    if (supplier) {
      let sup = null;
      try {
        sup = require('../config/database').defaultDb
          .prepare('SELECT id, name FROM suppliers WHERE sync_id = ? LIMIT 1').get(supplier) || null;
      } catch (_) { sup = null; }
      const parts = ['supplier_sync_id = ?'];
      args.push(supplier);
      if (sup?.id != null) { parts.push('supplier_id = ?');   args.push(sup.id); }
      if (sup?.name)       { parts.push('supplier_name = ?'); args.push(sup.name); }
      where.push('(' + parts.join(' OR ') + ')');
    }

    const rows = masterDb.prepare(
      `SELECT grn_sync_id, grn_number, branch_slug, branch_name,
              supplier_sync_id, supplier_name, invoice_number, date,
              items_subtotal, cn_total, final_payable,
              COALESCE(ap_status,'PENDING') AS ap_status
         FROM hq_confirmed_grn_totals
        WHERE ${where.join(' AND ')}
        ORDER BY date DESC, grn_number DESC
        LIMIT 300`
    ).all(...args);

    // 2026-09-14 — the supplier's invoice number (what the form lists by), and
    // the credit notes already raised against each invoice — agreed or still
    // pending — so the form can flag an invoice that has one and the same
    // credit is not entered twice. Every note sits in HQ's book: a depot's are
    // written there and the ones made at GRN generation are mirrored there.
    try {
      const invStmt = masterDb.prepare(
        'SELECT supplier_invoice_number FROM hq_grns WHERE sync_id = ? AND deleted_at IS NULL');
      const hqBook = require('../config/database').defaultDb;
      const cnStmt = hqBook.prepare(`
        SELECT credit_note_number, amount, grn_sync_id, proposed_grn_sync_id
          FROM supplier_credit_notes
         WHERE (grn_sync_id = ? OR proposed_grn_sync_id = ?)
           AND (deleted_at IS NULL OR deleted_at = '')
         ORDER BY date, id`);
      for (const r of rows) {
        r.supplier_invoice_number = invStmt.get(r.grn_sync_id)?.supplier_invoice_number || r.invoice_number || null;
        const notes = cnStmt.all(r.grn_sync_id, r.grn_sync_id).map(n => ({
          number: n.credit_note_number,
          amount: Number(n.amount) || 0,
          pending: !n.grn_sync_id && !!n.proposed_grn_sync_id,
        }));
        r.credit_notes = notes;
        r.cn_count = notes.length;
        r.cn_amount = Math.round(notes.reduce((s, n) => s + n.amount, 0) * 100) / 100;
      }
    } catch (_) { /* the picker still works without the flags */ }

    res.json({ rows, scope: hq ? 'all' : slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/credit-notes/grn-lines?grn_sync_id=…
//
// 2026-09-11 — the lines on the invoice a credit note is against, so the form
// can offer them first and price them as billed. The price is the line's VAT
// inclusive total ÷ qty: an HQ GRN line's unit_price is the PO line's
// cost_price, which hqPurchases.js computes as (base total + VAT − discount)
// ÷ qty. Not rebuilt from base/VAT/discount here — those land as 0 on a new
// GRN until a restart back-fills them. A product on two lines (an extra, say)
// is merged into one at the weighted price.
router.get('/grn-lines', auth, (req, res) => {
  try {
    const grnSyncId = String(req.query.grn_sync_id || '').trim();
    if (!masterDb || !grnSyncId) return res.json({ lines: [] });
    const hdr = masterDb.prepare(
      'SELECT branch_slug FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?'
    ).get(grnSyncId);
    if (!hdr) return res.status(404).json({ error: 'Invoice not found.' });
    if (!isHqRequest(req) && hdr.branch_slug !== getHostSlug(req)) {
      return res.status(403).json({ error: 'That invoice was delivered to another branch.' });
    }
    let rows = masterDb.prepare(
      `SELECT product_sync_id, product_name, unit, quantity, total_price
         FROM hq_grn_items
        WHERE grn_sync_id = ? AND quantity > 0`
    ).all(grnSyncId);
    // A GRN the branch confirmed itself (the v1.9.14 path) keeps its lines in
    // the branch's own grn table; HQ's snapshot row holds totals only.
    if (rows.length === 0) {
      try {
        rows = getTenantDb(hdr.branch_slug).prepare(
          `SELECT COALESCE(gi.product_sync_id, p.sync_id) AS product_sync_id,
                  p.name AS product_name, gi.unit, gi.quantity, gi.total_price
             FROM grn_items gi
             JOIN grn g ON g.id = gi.grn_id
             LEFT JOIN products p ON p.id = gi.product_id
            WHERE g.sync_id = ? AND gi.quantity > 0`
        ).all(grnSyncId);
      } catch (_) { rows = []; }
    }
    const merged = new Map();
    for (const r of rows) {
      const name = String(r.product_name || '').trim();
      const key = `${r.product_sync_id || name.toLowerCase()}|${r.unit || ''}`;
      const m = merged.get(key) || { product_sync_id: r.product_sync_id || null, product_name: name, unit: r.unit || null, quantity: 0, total: 0 };
      m.quantity += parseFloat(r.quantity) || 0;
      m.total    += parseFloat(r.total_price) || 0;
      merged.set(key, m);
    }
    const lines = [...merged.values()].map(m => ({
      product_sync_id: m.product_sync_id,
      product_name:    m.product_name,
      unit:            m.unit,
      quantity:        m.quantity,
      unit_price:      m.quantity > 0 ? m.total / m.quantity : 0,
    }));
    res.json({ lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/credit-notes/last-invoice-prices[?branch_slug=…]
//
// 2026-09-11 — for an item returned that is NOT on the chosen invoice, or
// when no invoice is chosen: its price on the most recent invoice that
// delivered it to this branch, VAT inclusive ÷ qty as above. A depot always
// gets its own branch; HQ passes the branch of the invoice it is working on,
// or gets the latest across every branch.
router.get('/last-invoice-prices', auth, (req, res) => {
  try {
    if (!masterDb) return res.json({ prices: [] });
    const slug = isHqRequest(req) ? String(req.query.branch_slug || '').trim() : getHostSlug(req);
    const where = ['g.deleted_at IS NULL', 'i.quantity > 0'];
    const args = [];
    if (slug) { where.push('g.branch_slug = ?'); args.push(slug); }
    const prices = masterDb.prepare(`
      SELECT product_sync_id, product_name, unit, unit_price, date, grn_number, invoice_number
        FROM (
          SELECT i.product_sync_id, TRIM(i.product_name) AS product_name, i.unit,
                 i.total_price / i.quantity AS unit_price,
                 g.date, g.grn_number, g.supplier_invoice_number AS invoice_number,
                 ROW_NUMBER() OVER (
                   PARTITION BY COALESCE(i.product_sync_id, LOWER(TRIM(i.product_name)))
                   ORDER BY g.date DESC, g.id DESC, i.id DESC
                 ) AS rn
            FROM hq_grn_items i
            JOIN hq_grns g ON g.id = i.grn_id
           WHERE ${where.join(' AND ')}
        )
       WHERE rn = 1
    `).all(...args);
    res.json({ prices });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/credit-notes/:syncId/confirm
//
// 2026-09-04 — HQ agreeing to a credit a depot raised. This is the ONLY thing
// that reduces a payable: the depot states which GRN it means, and until
// someone at HQ confirms it, proposed_grn_sync_id is just a claim.
//
// Confirming promotes it to grn_sync_id and recomputes the GRN's payable —
// after which the credit is indistinguishable from one raised at delivery
// time, which is the point. The GRN keeps whatever AP stage it was already
// at; nothing in the Accounts / Finance / Cashier chain changes, the figure
// they are working with is simply lower.
router.post('/:syncId/confirm', auth, (req, res) => {
  if (!isHqRequest(req)) return res.status(403).json({ error: 'HQ confirms credit notes.' });
  try {
    const syncId = String(req.params.syncId || '').trim();
    const cn = db.prepare(
      `SELECT * FROM supplier_credit_notes
        WHERE sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')`
    ).get(syncId);
    if (!cn) return res.status(404).json({ error: 'Credit note not found.' });
    if (cn.branch_confirmed_at) return res.status(400).json({ error: 'Already confirmed.' });
    // 2026-09-06 — a free credit (no invoice named) is confirmed here too. It
    // has no payable to recompute, so confirming simply lets it count against
    // the supplier's balance. Until then it is a claim, the same as one
    // attached to a GRN — the path with LESS paperwork used to have LESS
    // control, which was backwards.
    if (!cn.proposed_grn_sync_id) {
      const whoFree = req.user.firstName || req.user.email || 'HQ';
      db.prepare(
        `UPDATE supplier_credit_notes
            SET branch_confirmed_at = datetime('now'),
                branch_confirmed_by_name = ?,
                updated_at = datetime('now'), synced = 0
          WHERE sync_id = ? AND branch_confirmed_at IS NULL`
      ).run(whoFree, syncId);
      return res.json({ ok: true, free_credit: true });
    }

    const snap = masterDb && masterDb.prepare(
      'SELECT grn_number, supplier_sync_id, items_subtotal, ap_status FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?'
    ).get(cn.proposed_grn_sync_id);
    if (!snap) return res.status(400).json({ error: 'That GRN no longer exists.' });
    if (String(snap.ap_status || 'PENDING') === 'PAID') {
      return res.status(400).json({
        error: `${snap.grn_number} is already paid. Leave this credit for the supplier to offset instead.`,
      });
    }
    // Same supplier, or the credit would reduce a debt owed to someone else.
    if (snap.supplier_sync_id && cn.supplier_sync_id && snap.supplier_sync_id !== cn.supplier_sync_id) {
      return res.status(400).json({ error: `${snap.grn_number} belongs to a different supplier.` });
    }
    // Never more than the GRN is worth, or the payable would go negative and
    // the supplier would appear to owe US on that invoice.
    const already = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM supplier_credit_notes
        WHERE grn_sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')`
    ).get(cn.proposed_grn_sync_id)?.t || 0;
    const subtotal = parseFloat(snap.items_subtotal) || 0;
    if ((parseFloat(already) || 0) + (parseFloat(cn.amount) || 0) > subtotal + 0.01) {
      return res.status(400).json({
        error: `That would credit more than ${snap.grn_number} is worth (${subtotal.toFixed(2)}). `
             + 'Split the credit note or attach it to a larger GRN.',
      });
    }

    const who = req.user.firstName || req.user.email || 'HQ';
    db.prepare(
      `UPDATE supplier_credit_notes
          SET grn_sync_id = proposed_grn_sync_id,
              branch_confirmed_at = datetime('now'),
              branch_confirmed_by_name = ?,
              updated_at = datetime('now'), synced = 0
        WHERE sync_id = ? AND branch_confirmed_at IS NULL`
    ).run(who, syncId);

    const out = recomputeGrnPayable(db, masterDb, cn.proposed_grn_sync_id);
    res.json({ ok: true, grn_number: snap.grn_number, ...(out || {}) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// In single-location mode, all stock effectively lives at the 'sales' counter
// (every GRN is auto-SIV'd to sales). Credit-note returns must therefore
// deduct from 'sales', not 'store' — deducting from store leaves it negative
// and leaves the sales counter over-counting. In dual-location mode the
// goods physically come out of the store warehouse before leaving, so 'store'
// is correct there.
function stockLocation(db, tenantId) {
  return isSingleLocationMode(db, tenantId) ? 'sales' : 'store';
}

// 'Crate Return'  -> empties going back to supplier (deposit refund). Items
//                    are crate/bottle products. Profit Report ignores it.
// 'Goods Return'  -> the actual purchased goods going back (damaged, wrong,
//                    excess). Items are beverage / regular products at their
//                    avg cost price. Profit Report also ignores it (cost &
//                    cash net to zero; it's a reversal, not income).
// 'Discount' / 'Other' -> pure cash-side credit. No stock movement. Counts
//                         as Supplier Rebate in the Profit Report.
// 'Bottle Return' kept for backward-compat with rows created before the
// crate+bottle merge; treated like a Crate Return everywhere.
const VALID_REASONS = ['Discount', 'Crate Return', 'Goods Return', 'Bottle Return', 'Other'];
const reasonHasStock = (reason) =>
  reason === 'Crate Return' || reason === 'Bottle Return' || reason === 'Goods Return';

// 2026-09-14 — what the list and the View show about each credit note's GRN:
// its number (and whether the link is still only proposed), the depot and the
// supplier's invoice number. All of it lives in master.db, a separate file, so
// it is looked up per GRN (cached for the page) rather than joined.
//   depot   — the depot that raised the note, else the depot the GRN was
//             delivered to
//   invoice — what the depot typed at Confirm Received (hq_grns), falling back
//             to the number kept with the GRN totals
function enrichCreditNotes(rows) {
  if (!masterDb || !rows || !rows.length) return rows;
  try {
    const grnStmt = masterDb.prepare(
      'SELECT grn_number, branch_slug, branch_name, invoice_number FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?');
    const invStmt = masterDb.prepare(
      'SELECT supplier_invoice_number FROM hq_grns WHERE sync_id = ? AND deleted_at IS NULL');
    const nameStmt = masterDb.prepare('SELECT business_name FROM tenants WHERE slug = ?');
    // 2026-09-18 — a note raised at goods-receive (1-10 Sept) holds its lines
    // at the BASE price, with the note's VAT on the header and a discount per
    // line. A note raised on the Credit Notes page holds the value already
    // including VAT, so its lines add up on their own and these are 0.
    //
    // Without this the older notes read as if they were wrong: 10 x K252.28
    // next to a total of K3,439.048, with nothing on screen to explain the
    // K346.25. Both live only in master, so they are carried out with the row.
    const vatStmt = masterDb.prepare(
      'SELECT vat_amount FROM hq_supplier_credit_notes WHERE sync_id = ? AND deleted_at IS NULL');
    const grns = new Map();
    const names = new Map();
    const grnOf = (id) => {
      if (!grns.has(id)) {
        const g = grnStmt.get(id) || null;
        if (g) g.supplier_invoice_number = invStmt.get(id)?.supplier_invoice_number || g.invoice_number || null;
        grns.set(id, g);
      }
      return grns.get(id);
    };
    const nameOf = (slug) => {
      if (!names.has(slug)) names.set(slug, nameStmt.get(slug)?.business_name || null);
      return names.get(slug);
    };
    for (const r of rows) {
      const id = r.grn_sync_id || r.proposed_grn_sync_id;
      const g = id ? grnOf(id) : null;
      r.linked_grn_number = g?.grn_number || null;
      // Pending until HQ agrees it — the screen says which.
      r.linked_is_proposed = !r.grn_sync_id && !!r.proposed_grn_sync_id;
      r.supplier_invoice_number = g?.supplier_invoice_number || null;
      const slug = r.raised_by_branch || g?.branch_slug || null;
      r.depot_slug = slug;
      r.depot_name = slug ? (nameOf(slug) || g?.branch_name || slug) : null;
      try { r.vat_amount = Math.abs(parseFloat(vatStmt.get(r.sync_id)?.vat_amount) || 0); }
      catch (_) { r.vat_amount = 0; }
    }
  } catch (_) { /* the rows still stand without these */ }
  return rows;
}

// ── List ─────────────────────────────────────────────────────────────────────
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to, supplier_id, reason } = req.query;
    let sql = `
      SELECT cn.*, s.name AS supplier_name,
             (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM supplier_credit_notes cn
      LEFT JOIN suppliers s ON s.sync_id = cn.supplier_sync_id
      LEFT JOIN users u ON u.id = cn.created_by
      WHERE cn.deleted_at IS NULL AND cn.tenant_id = ?
    `;
    const params = [req.user.tenantId];
    if (from)         { sql += ' AND cn.date >= ?'; params.push(from); }
    if (to)           { sql += ' AND cn.date <= ?'; params.push(to); }
    if (supplier_id)  { sql += ' AND cn.supplier_id = ?'; params.push(parseInt(supplier_id)); }
    if (reason)       { sql += ' AND cn.reason = ?'; params.push(reason); }
    sql += ' ORDER BY cn.date DESC, cn.id DESC';
    let rows = db.prepare(sql).all(...params);

    // 2026-09-07 — a depot sees the credit notes it raised.
    //
    // Those rows are written into HQ's book, not the depot's, so that HQ can
    // see them at all - and the side effect was that the depot went blind to
    // its own notes. Its list read "No credit notes yet" while several were
    // sitting at HQ waiting to be agreed, with no way to tell whether one had
    // been accepted and no way to take a mistake back.
    //
    // Matched on raised_by_branch, which the create already stamps. Deduped by
    // sync_id, because a legacy note may exist in both books.
    if (!isHqRequest(req)) {
      try {
        const slug = getHostSlug(req);
        const hqDb = db.defaultDb;
        if (slug && hqDb && hqDb !== db) {
          let hqSql = `
            SELECT cn.*, s.name AS supplier_name
              FROM supplier_credit_notes cn
              LEFT JOIN suppliers s ON s.sync_id = cn.supplier_sync_id
             WHERE cn.deleted_at IS NULL AND cn.raised_by_branch = ?`;
          const hqParams = [slug];
          if (from)        { hqSql += ' AND cn.date >= ?'; hqParams.push(from); }
          if (to)          { hqSql += ' AND cn.date <= ?'; hqParams.push(to); }
          if (supplier_id) { hqSql += ' AND cn.supplier_id = ?'; hqParams.push(parseInt(supplier_id)); }
          if (reason)      { hqSql += ' AND cn.reason = ?'; hqParams.push(reason); }
          hqSql += ' ORDER BY cn.date DESC, cn.id DESC';
          const mine = hqDb.prepare(hqSql).all(...hqParams).map(r => ({ ...r, raised_here: 1 }));
          const seen = new Set(rows.map(r => r.sync_id));
          rows = [...rows, ...mine.filter(r => !seen.has(r.sync_id))]
            .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
        }
      } catch (_) { /* the depot's own list still stands */ }
    }

    // 2026-09-07 — the GRN each credit belongs to, resolved for the list.
    //
    // The screen was showing `reference`, a free-text box. Credits minted at
    // GRN generation happen to have the GRN number typed into it, so they
    // looked right; one raised on this page shows whatever the operator typed,
    // and usually that is nothing - so a credit that IS attached to an invoice
    // read as attached to nothing.
    //
    // The real link is grn_sync_id (agreed) or proposed_grn_sync_id (still a
    // claim). Those live in master.db, a separate file, so this cannot be a
    // JOIN - the ids are collected and looked up once for the whole page.
    // 2026-09-14 — plus the depot and the supplier's invoice number (enrichCreditNotes).
    enrichCreditNotes(rows);

    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Stats ────────────────────────────────────────────────────────────────────
router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const total      = db.prepare("SELECT COUNT(*) AS cnt FROM supplier_credit_notes WHERE deleted_at IS NULL AND tenant_id = ?").get(tenantId);
    const thisMonth  = db.prepare("SELECT COUNT(*) AS cnt FROM supplier_credit_notes WHERE deleted_at IS NULL AND tenant_id = ? AND strftime('%Y-%m', date) = strftime('%Y-%m','now')").get(tenantId);
    const totalValue = db.prepare("SELECT COALESCE(SUM(amount),0) AS sum FROM supplier_credit_notes WHERE deleted_at IS NULL AND tenant_id = ?").get(tenantId);
    const byReason   = db.prepare(`
      SELECT reason, COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS sum
      FROM supplier_credit_notes
      WHERE deleted_at IS NULL AND tenant_id = ?
      GROUP BY reason
    `).all(tenantId);

    // 2026-09-07 — a depot's own notes are in HQ's book, so the cards read
    // zero over a list with rows in it. Counted the same way the list is
    // built, or the two contradict each other on the same screen.
    const out = {
      totalCreditNotes: total.cnt,
      thisMonth:        thisMonth.cnt,
      totalValue:       totalValue.sum,
      byReason,
    };
    if (!isHqRequest(req)) {
      try {
        const slug = getHostSlug(req);
        const hqDb = db.defaultDb;
        if (slug && hqDb && hqDb !== db) {
          const w = "deleted_at IS NULL AND raised_by_branch = ?";
          out.totalCreditNotes += hqDb.prepare(`SELECT COUNT(*) AS cnt FROM supplier_credit_notes WHERE ${w}`).get(slug).cnt;
          out.thisMonth        += hqDb.prepare(`SELECT COUNT(*) AS cnt FROM supplier_credit_notes WHERE ${w} AND strftime('%Y-%m', date) = strftime('%Y-%m','now')`).get(slug).cnt;
          out.totalValue       += hqDb.prepare(`SELECT COALESCE(SUM(amount),0) AS sum FROM supplier_credit_notes WHERE ${w}`).get(slug).sum;
          const mine = hqDb.prepare(
            `SELECT reason, COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS sum
               FROM supplier_credit_notes WHERE ${w} GROUP BY reason`
          ).all(slug);
          for (const r of mine) {
            const hit = out.byReason.find(x => x.reason === r.reason);
            if (hit) { hit.cnt += r.cnt; hit.sum += r.sum; }
            else out.byReason.push(r);
          }
        }
      } catch (_) { /* the local figures still stand */ }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single (with items if applicable) ────────────────────────────────────────
router.get('/:id', auth, readOnlyGuard, (req, res) => {
  try {
    let row = db.prepare(`
      SELECT cn.*, s.name AS supplier_name,
             (u.first_name || ' ' || u.last_name) AS created_by_name
      FROM supplier_credit_notes cn
      LEFT JOIN suppliers s ON s.sync_id = cn.supplier_sync_id
      LEFT JOIN users u ON u.id = cn.created_by
      WHERE cn.id = ? AND cn.tenant_id = ?
    `).get(req.params.id, req.user.tenantId);

    // 2026-09-07 — a depot's own note lives in HQ's book, so View and the
    // By-Supplier drill-down were reporting "Credit note not found" for rows
    // the depot could see in its own list. The list learned to read both
    // books; this had not.
    let src = db;
    if (!row && !isHqRequest(req) && db.defaultDb && db.defaultDb !== db) {
      const slug = getHostSlug(req);
      const alt = db.defaultDb.prepare(`
        SELECT cn.*, s.name AS supplier_name
          FROM supplier_credit_notes cn
          LEFT JOIN suppliers s ON s.sync_id = cn.supplier_sync_id
         WHERE cn.id = ? AND cn.deleted_at IS NULL AND cn.raised_by_branch = ?
      `).get(req.params.id, slug);
      if (alt) { row = alt; src = db.defaultDb; }
    }
    if (!row) return res.status(404).json({ error: 'Credit note not found.' });

    // Line items follow the header. The depot's copy of the product names is
    // the better one when the header came from HQ, so fall back to it.
    let items = src.prepare(`
      SELECT cni.*, p.name AS product_name, p.unit AS product_unit
      FROM supplier_credit_note_items cni
      LEFT JOIN products p ON p.sync_id = cni.product_sync_id
      WHERE cni.credit_note_sync_id = ? AND cni.deleted_at IS NULL
    `).all(row.sync_id);
    if (src !== db && items.length === 0) {
      items = db.prepare(`
        SELECT cni.*, p.name AS product_name, p.unit AS product_unit
        FROM supplier_credit_note_items cni
        LEFT JOIN products p ON p.sync_id = cni.product_sync_id
        WHERE cni.credit_note_sync_id = ? AND cni.deleted_at IS NULL
      `).all(row.sync_id);
    }
    enrichCreditNotes([row]);
    // 2026-09-18 — the line discounts, for the same reason as the VAT above:
    // an older note's lines are pre-discount, so without these the breakdown
    // on screen cannot add up to the note's total. 0 on every newer note.
    try {
      if (masterDb) {
        const disc = new Map();
        for (const d of masterDb.prepare(
          'SELECT product_sync_id, discount FROM hq_supplier_credit_note_items WHERE credit_note_sync_id = ?')
          .all(row.sync_id)) {
          if (d.product_sync_id) disc.set(d.product_sync_id, parseFloat(d.discount) || 0);
        }
        if (disc.size) items = items.map(i => ({ ...i, discount: disc.get(i.product_sync_id) || 0 }));
      }
    } catch (_) { /* pre-migration master — the note shows without discounts */ }
    res.json({ ...row, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create ───────────────────────────────────────────────────────────────────
router.post('/', auth, (req, res) => {
  try {
    // v1.9.16 — accept grn_sync_id so credit notes raised from inside the
    // GRN form get linked back to the parent GRN. HQ Confirm GRN sums by
    // grn_sync_id to compute final payable. Standalone CN page sends null.
    const { supplier_id, reason, reference, amount, notes, items, date, grn_sync_id } = req.body || {};
    // 2026-09-06 — a sync_id identifies the supplier now, not a local row id.
    // Suppliers are HQ-only, so a depot's list is empty and it could never
    // fill this in; and its own row ids would be meaningless in HQ's book
    // anyway, which is where a depot's credit note is written. Picking the
    // invoice supplies the sync_id, and the id is resolved below in whichever
    // database the row actually lands in.
    const supplierSyncIn = String(req.body.supplier_sync_id || '').trim();
    if (!supplier_id && !supplierSyncIn) {
      return res.status(400).json({ error: 'Supplier is required — choose the invoice, or pick a supplier.' });
    }
    if (!VALID_REASONS.includes(reason)) return res.status(400).json({ error: 'Invalid reason.' });

    const usesStock = reasonHasStock(reason);
    const validItems = usesStock ? (items || []).filter(i => i.product_id && parseFloat(i.quantity) > 0) : [];
    if (usesStock && validItems.length === 0) {
      return res.status(400).json({ error: 'At least one product line is required for crate / bottle returns.' });
    }
    // For Discount / Other the amount comes directly from the form.
    // For Crate / Bottle Return the amount is the sum of (qty * unit_value).
    const finalAmount = usesStock
      ? validItems.reduce((s, i) => s + parseFloat(i.quantity) * parseFloat(i.unit_value || 0), 0)
      : parseFloat(amount || 0);
    if (!(finalAmount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero.' });

    const result = db.transaction(() => {
      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();
      const cnNumber = syncConfig.generateNumber('CN', 'supplier_credit_notes');
      const cnSyncId = randomUUID();
      const cnDate   = date || new Date().toISOString().split('T')[0];
      const movementCreatedAt = cnDate + ' ' + new Date().toTimeString().slice(0, 8);

      const supplier = supplier_id
        ? db.prepare('SELECT sync_id, name FROM suppliers WHERE id = ?').get(supplier_id)
        : null;
      const supplierSyncId = supplierSyncIn || supplier?.sync_id || null;

      // 2026-09-04 — where the ROW goes depends on who raised it.
      //
      // AP is HQ-only and HQ's Credit Notes page reads its own table filtered
      // by tenant_id, so a note written at the branch is raised and then
      // invisible — nobody at HQ ever sees it. A depot's note therefore goes
      // into HQ's book. The STOCK movement below stays local, because fifteen
      // broken boxes left the depot's shelf, not HQ's.
      //
      // grn_sync_id is deliberately NOT set for a depot's note. It states the
      // GRN it means in proposed_grn_sync_id, and HQ confirming is what
      // promotes that to grn_sync_id and reduces the payable. Writing it here
      // would net the invoice the moment the depot pressed Save, leaving
      // nothing for HQ to agree to.
      //
      // created_by is NULL on the HQ row: user ids are per branch, and a
      // depot's id does not exist in HQ's users table — the same foreign key
      // that broke transfer receives. The person is kept as raised_by_name.
      const fromBranch = !isHqRequest(req);
      const cnDb = fromBranch ? (db.defaultDb || db) : db;

      // The id has to belong to cnDb, not to whoever posted. A depot's id in
      // HQ's table is the same foreign-key mistake that broke transfer
      // receives; the sync_id is the thing both books agree on.
      let supplierIdForRow = null;
      try {
        supplierIdForRow = (supplierSyncId
          ? cnDb.prepare('SELECT id FROM suppliers WHERE sync_id = ? LIMIT 1').get(supplierSyncId)?.id
          : null) || (fromBranch ? null : supplier_id) || null;
      } catch (_) { supplierIdForRow = fromBranch ? null : supplier_id; }

      const info = cnDb.prepare(`
        INSERT INTO supplier_credit_notes (credit_note_number, date, supplier_id, supplier_sync_id,
                                            reason, reference, amount, notes, grn_sync_id, created_by,
                                            proposed_grn_sync_id, raised_by_branch, raised_by_name,
                                            sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `).run(cnNumber, cnDate, supplierIdForRow, supplierSyncId,
             reason, reference || null, finalAmount, notes || null,
             fromBranch ? null : (grn_sync_id || null),
             fromBranch ? null : req.user.id,
             fromBranch ? (grn_sync_id || null) : null,
             fromBranch ? getHostSlug(req) : null,
             fromBranch ? (req.user.firstName || req.user.email || 'branch') : null,
             cnSyncId,
             fromBranch ? hqTenantId(cnDb) : tenantId,
             branchId, deviceId);
      const cnId = info.lastInsertRowid;

      // Items + stock movements only for crate/bottle/goods returns.
      if (usesStock) {
        for (const i of validItems) {
          const prod = db.prepare('SELECT sync_id FROM products WHERE id = ?').get(i.product_id);
          const productSyncId = i.product_sync_id || prod?.sync_id || null;
          const qty = parseFloat(i.quantity);
          const unitVal = parseFloat(i.unit_value || 0);
          const linePrice = qty * unitVal;
          const unitName = i.unit || null;
          const unitConv = parseFloat(i.unit_conv) > 0 ? parseFloat(i.unit_conv) : 1;
          // Stock leaves in BASE units (qty * conv), so a "1 Crate" return of a
          // 12-pack drops 12 base units. unit_value already reflects per-picked-unit.
          const baseQty = qty * unitConv;

          // The lines follow the CN row, not the stock: cnId is a rowid in
          // cnDb, so writing them anywhere else would point at nothing.
          // product_id is a BRANCH id and means nothing in HQ's products
          // table — product_sync_id is the portable key and carries the truth.
          cnDb.prepare(`
            INSERT INTO supplier_credit_note_items (credit_note_id, credit_note_sync_id, product_id, product_sync_id,
                                                     quantity, unit_value, total_price, unit, unit_conv,
                                                     sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
          `).run(cnId, cnSyncId, fromBranch ? null : i.product_id, productSyncId,
                 qty, unitVal, linePrice, unitName, unitConv,
                 randomUUID(), fromBranch ? hqTenantId(cnDb) : tenantId, branchId, deviceId);

          db.prepare(`
            INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity,
                                         reference_id, reference_type, notes, created_by,
                                         sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)
          `).run(i.product_id, productSyncId, returnLocation(db, tenantId, productSyncId, baseQty), 'credit_note', -baseQty,
                 cnId, 'credit_note', `${reason} via ${cnNumber}`, req.user.id,
                 randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, cnSyncId);
          // v1.10.24 — decrement products.current_stock alongside the movement.
          if (productSyncId) {
            db.prepare(
              `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
            ).run(baseQty, productSyncId);
          }
        }
      }

      const saved = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(cnId);
      // Only Discount + Other affect Gross Profit; recalc anyway — it's cheap
      // and keeps the daily_profit_summary accurate for the saved date.
      // 2026-09-06 — a credit raised against a delivery makes its payable
      // provisional again, so the GRN goes back to Awaiting Confirmation and
      // the Store Manager looks at it once more before Accounts does. PAID is
      // left alone: that credit has to be offset on the next invoice, and the
      // confirm route already refuses it.
      if (fromBranch && grn_sync_id && masterDb) {
        try {
          masterDb.prepare(
            `UPDATE hq_confirmed_grn_totals
                SET ap_status = 'UNCONFIRMED'
              WHERE grn_sync_id = ?
                AND ap_status IN ('PENDING','CHECKED','APPROVED')`
          ).run(grn_sync_id);
        } catch (_) { /* the credit still stands; the queue self-corrects */ }
      }
      recalculateDailyProfit(db, cnDate, tenantId);
      return saved;
    })();
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update ───────────────────────────────────────────────────────────────────
// Strategy: soft-delete the existing items + stock movements, then re-insert
// from the new payload. Parent row keeps its number/sync_id.
router.put('/:id', auth, (req, res) => {
  try {
    const { supplier_id, reason, reference, amount, notes, items, date } = req.body || {};
    {
      // Same rule as delete: once confirmed the figure is agreed, so it stops
      // being editable.
      const existing = db.prepare(
        'SELECT credit_note_number, branch_confirmed_at FROM supplier_credit_notes WHERE id = ? AND deleted_at IS NULL'
      ).get(parseInt(req.params.id));
      if (existing && existing.branch_confirmed_at) {
        return res.status(409).json({
          error: `${existing.credit_note_number} is confirmed and cannot be edited. Raise a reversing credit note instead.`,
        });
      }
    }
    const id = parseInt(req.params.id);
    // Captured BEFORE the write: if the credit is moved to another GRN, both
    // the old and the new one need recomputing.
    const priorGrn = (() => {
      try { return db.prepare('SELECT grn_sync_id FROM supplier_credit_notes WHERE id = ?').get(id)?.grn_sync_id || null; }
      catch (_) { return null; }
    })();
    if (!VALID_REASONS.includes(reason)) return res.status(400).json({ error: 'Invalid reason.' });

    const usesStock = reasonHasStock(reason);
    const validItems = usesStock ? (items || []).filter(i => i.product_id && parseFloat(i.quantity) > 0) : [];
    if (usesStock && validItems.length === 0) {
      return res.status(400).json({ error: 'At least one product line is required for crate / bottle returns.' });
    }

    // 2026-09-18 — a credit note minted from a GRN carries two figures the
    // tenant book has no column for: the note's VAT, on the header, and a
    // discount per line. Both live in master.db, and both are part of the
    // agreed credit — SCN-2026-09D536EE is 10 × 252.28 less 81 discount plus
    // 570 of empties plus 427.248 VAT = 3,439.048, which is exactly the
    // VAT-inclusive invoice price.
    //
    // Recomputing the amount from qty × unit_value alone therefore DELETED the
    // VAT and handed the discount back the moment anyone pressed Save Changes
    // on such a note — K346.25 off this one note. The stored figures are
    // correct; it was the edit that broke them. So they are read back from
    // master and folded in here, and the note keeps its agreed value.
    const cnSyncForVat = (() => {
      try { return db.prepare('SELECT sync_id FROM supplier_credit_notes WHERE id = ?').get(id)?.sync_id || null; }
      catch (_) { return null; }
    })();
    let masterVat = 0;
    const masterDiscount = new Map();
    if (cnSyncForVat && masterDb) {
      try {
        const mh = masterDb.prepare(
          'SELECT vat_amount FROM hq_supplier_credit_notes WHERE sync_id = ? AND deleted_at IS NULL').get(cnSyncForVat);
        if (mh) {
          masterVat = Math.abs(parseFloat(mh.vat_amount) || 0);
          const mi = masterDb.prepare(
            'SELECT product_sync_id, discount FROM hq_supplier_credit_note_items WHERE credit_note_sync_id = ?')
            .all(cnSyncForVat);
          for (const r of mi) {
            if (r.product_sync_id) masterDiscount.set(r.product_sync_id, parseFloat(r.discount) || 0);
          }
        }
      } catch (_) { /* pre-migration master — the note keeps today's behaviour */ }
    }
    // The discount belongs to the line, so it follows the line: still there
    // while the product is on the note, gone with it when the line is removed.
    // It is NOT scaled when a quantity changes — the discount the supplier
    // granted is a figure off their invoice, not a rate, and inventing a rate
    // for it would change the agreed credit.
    const discountFor = (i) => {
      const syncId = i.product_sync_id
        || (() => { try { return db.prepare('SELECT sync_id FROM products WHERE id = ?').get(i.product_id)?.sync_id || null; } catch (_) { return null; } })();
      return syncId && masterDiscount.has(syncId) ? masterDiscount.get(syncId) : 0;
    };

    const finalAmount = usesStock
      ? validItems.reduce((s, i) =>
          s + parseFloat(i.quantity) * parseFloat(i.unit_value || 0) - discountFor(i), 0) + masterVat
      : parseFloat(amount || 0);
    if (!(finalAmount > 0)) return res.status(400).json({ error: 'Amount must be greater than zero.' });

    const result = db.transaction(() => {
      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();
      const cn = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL').get(id, tenantId);
      if (!cn) throw Object.assign(new Error('Credit note not found.'), { status: 404 });

      const supplier = db.prepare('SELECT sync_id FROM suppliers WHERE id = ?').get(supplier_id);
      const supplierSyncId = req.body.supplier_sync_id || supplier?.sync_id || null;
      const editDate = date || cn.date;
      const movementCreatedAt = editDate + ' ' + new Date().toTimeString().slice(0, 8);

      // v1.10.24 — roll old credit_note movements off current_stock before soft-deleting.
      const oldCnMoves = db.prepare(
        `SELECT product_sync_id, SUM(quantity) AS net FROM stock_movements
          WHERE reference_sync_id = ? AND reference_type = 'credit_note' AND deleted_at IS NULL
          GROUP BY product_sync_id`
      ).all(cn.sync_id);
      for (const r of oldCnMoves) {
        if (r.product_sync_id) {
          db.prepare(
            `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(r.net, r.product_sync_id);
        }
      }
      // Soft-delete previous items + movements (so sync carries the deletion).
      db.prepare("UPDATE supplier_credit_note_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE credit_note_sync_id=? AND deleted_at IS NULL").run(cn.sync_id);
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='credit_note' AND deleted_at IS NULL").run(cn.sync_id);

      db.prepare(`
        UPDATE supplier_credit_notes
        SET supplier_id=?, supplier_sync_id=?, reason=?, reference=?, amount=?, notes=?, date=?,
            synced=0, updated_at=datetime('now')
        WHERE id=?
      `).run(supplier_id, supplierSyncId, reason, reference || null, finalAmount, notes || null, editDate, id);

      if (usesStock) {
        for (const i of validItems) {
          const prod = db.prepare('SELECT sync_id FROM products WHERE id = ?').get(i.product_id);
          const productSyncId = i.product_sync_id || prod?.sync_id || null;
          const qty = parseFloat(i.quantity);
          const unitVal = parseFloat(i.unit_value || 0);
          const linePrice = qty * unitVal;
          const unitName = i.unit || null;
          const unitConv = parseFloat(i.unit_conv) > 0 ? parseFloat(i.unit_conv) : 1;
          const baseQty = qty * unitConv;

          db.prepare(`
            INSERT INTO supplier_credit_note_items (credit_note_id, credit_note_sync_id, product_id, product_sync_id,
                                                     quantity, unit_value, total_price, unit, unit_conv,
                                                     sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
          `).run(id, cn.sync_id, i.product_id, productSyncId, qty, unitVal, linePrice, unitName, unitConv,
                 randomUUID(), tenantId, branchId, deviceId);

          db.prepare(`
            INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type, quantity,
                                         reference_id, reference_type, notes, created_by,
                                         sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at, reference_sync_id)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'),?)
          `).run(i.product_id, productSyncId, returnLocation(db, tenantId, productSyncId, baseQty), 'credit_note', -baseQty,
                 id, 'credit_note', `${reason} via ${cn.credit_note_number}`, req.user.id,
                 randomUUID(), tenantId, branchId, deviceId, movementCreatedAt, cn.sync_id);
          // v1.10.24 — decrement products.current_stock alongside the movement.
          if (productSyncId) {
            db.prepare(
              `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
            ).run(baseQty, productSyncId);
          }
        }
      }

      const updated = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ?').get(id);
      // Edits can move the date or amount → recalc both the old and new dates.
      recalculateDailyProfit(db, cn.date,  tenantId);
      if (editDate !== cn.date) recalculateDailyProfit(db, editDate, tenantId);
      return updated;
    })();
    // After the transaction, so a recompute failure cannot roll back a good
    // edit. Both GRNs: the one it was on, and the one it is on now.
    const nowGrn = (() => {
      try { return db.prepare('SELECT grn_sync_id FROM supplier_credit_notes WHERE id = ?').get(id)?.grn_sync_id || null; }
      catch (_) { return null; }
    })();
    for (const g of new Set([priorGrn, nowGrn].filter(Boolean))) {
      recomputeGrnPayable(db, masterDb, g);
    }
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── Delete (soft-delete + cascade) ───────────────────────────────────────────
router.delete('/:id', auth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    let deletedGrn = null;

    // 2026-09-07 — the row may live in HQ's book while its stock movements are
    // here. A depot cancelling its own note has to delete over there and put
    // the stock back on this shelf, so the two are handled separately.
    const fromBranch = !isHqRequest(req);
    const slug = fromBranch ? getHostSlug(req) : null;
    let cnDb = db;
    let cn = db.prepare('SELECT * FROM supplier_credit_notes WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!cn && fromBranch && db.defaultDb && db.defaultDb !== db) {
      cnDb = db.defaultDb;
      cn = cnDb.prepare('SELECT * FROM supplier_credit_notes WHERE id = ? AND deleted_at IS NULL').get(id);
      // Only its own, and only while HQ has not agreed it. Once confirmed the
      // payable has already moved and a depot pulling it back would change
      // what a supplier is owed without anyone at HQ knowing.
      if (cn && cn.raised_by_branch !== slug) {
        return res.status(403).json({ error: 'That credit note belongs to another depot.' });
      }
      if (cn && cn.branch_confirmed_at) {
        return res.status(409).json({
          error: 'HQ has already confirmed this credit note, so it cannot be cancelled here. Ask HQ to reverse it.',
        });
      }
    }
    if (!cn) return res.status(404).json({ error: 'Credit note not found.' });
    // 2026-09-07 — confirmed means agreed with the supplier and already off
    // the payable. Deleting it would move money nobody looked at again, so it
    // is refused for everyone, HQ included. Correct a bad one with a
    // reversing entry rather than by making it disappear.
    if (cn.branch_confirmed_at) {
      return res.status(409).json({
        error: `${cn.credit_note_number} is confirmed and cannot be deleted. Raise a reversing credit note instead.`,
      });
    }
    const cnRow = cn;
    const cnStore = cnDb;

    db.transaction(() => {
      const cn = { sync_id: cnRow.sync_id, date: cnRow.date, tenant_id: cnRow.tenant_id, grn_sync_id: cnRow.grn_sync_id };
      deletedGrn = cn.grn_sync_id || null;

      // v1.10.24 — roll deleted credit_note movements off current_stock.
      const oldCnDelMoves = db.prepare(
        `SELECT product_sync_id, SUM(quantity) AS net FROM stock_movements
          WHERE reference_sync_id = ? AND reference_type = 'credit_note' AND deleted_at IS NULL
          GROUP BY product_sync_id`
      ).all(cn.sync_id);
      for (const r of oldCnDelMoves) {
        if (r.product_sync_id) {
          db.prepare(
            `UPDATE products SET current_stock = current_stock - ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
          ).run(r.net, r.product_sync_id);
        }
      }
      // Movements and their items are always local — the goods left this shelf.
      db.prepare("UPDATE stock_movements SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE reference_sync_id=? AND reference_type='credit_note' AND deleted_at IS NULL").run(cn.sync_id);
      db.prepare("UPDATE supplier_credit_note_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE credit_note_sync_id=? AND deleted_at IS NULL").run(cn.sync_id);
      // The header may not be. Keyed on sync_id, since the row id belongs to
      // whichever book it is in.
      cnStore.prepare("UPDATE supplier_credit_notes SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE sync_id=?").run(cn.sync_id);
      if (cnStore !== db) {
        cnStore.prepare("UPDATE supplier_credit_note_items SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE credit_note_sync_id=? AND deleted_at IS NULL").run(cn.sync_id);
      }
      recalculateDailyProfit(db, cn.date, cn.tenant_id);
    })();
    // The GRN this credit was against gets its payable back. Without this the
    // credit vanished from the ledger while the GRN kept the reduced figure.
    if (deletedGrn) recomputeGrnPayable(db, masterDb, deletedGrn);
    res.json({ message: 'Credit note deleted.' });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
