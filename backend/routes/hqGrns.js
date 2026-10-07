/**
 * hqGrns.js â€” HQ-side review of branch GRNs that were generated from a
 * HQ PO (v1.9.7 procurement flow).
 *
 * Lifecycle recap:
 *   1. HQ creates PO at /api/hq/purchases (lines target branches).
 *   2. Branch sees PO in "Incoming Stock" queue â†’ clicks "Accept &
 *      Generate GRN" â†’ opens a normal GRN form with PO# pre-filled.
 *   3. Branch fills the GRN with invoice qty + credit notes, saves.
 *      The GRN is stored at the branch DB with hq_status='PENDING_HQ_CONFIRM';
 *      the parent PO line flips from AWAITING_GRN â†’ GRN_SUBMITTED in
 *      master.db. NO stock has moved yet â€” that's HQ's job.
 *   4. HQ opens /api/hq/grns/awaiting (this file's GET endpoint), sees
 *      every branch's pending GRN, opens the full doc, and either:
 *         /confirm  â†’ posts stock at branch location='sales', updates
 *                     the linked PO lines to CONFIRMED, locks supplier AP.
 *         /reject   â†’ resets hq_status, sends the GRN back to the branch
 *                     for re-entry (PO line flips back to AWAITING_GRN
 *                     so branch can create a fresh GRN).
 *
 * Auth: hqAuth (JWT), same model as routes/hq.js + routes/hqPurchases.js.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { listTenants, isRegistered, masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');

// 2026-08-28 â€” stock movements written from HQ were ORPHANED on the server.
//
// The inserts below stamped tenant_id/branch_id from grn.tenant_id etc, but
// hq_grns has no such columns, so every one was NULL. The branch pull filters
// `WHERE tenant_id = ?`, and NULL never matches â€” so a GRN confirmed at HQ
// updated products.current_stock (that row already had its tenant_id and
// synced fine) while the MOVEMENT never reached the branch. Symptom: the till
// showed the right stock number but its Bin Card was missing the receipt, so
// the movements did not add up to the balance.
//
// Same bug Kelete hit and fixed in v1.10.287. Take the ids from the branch's
// own database, which is the one being written to.
//
// device_id is deliberately left NULL: the pull excludes rows whose device_id
// matches the requesting device, so stamping the branch's own device here
// would hide the movement from the very till that needs it.
function branchSyncIds(branchDb) {
  let tenantId = null, branchId = null;
  try {
    tenantId = branchDb.prepare(
      'SELECT tenant_id FROM business_settings WHERE tenant_id IS NOT NULL LIMIT 1'
    ).get()?.tenant_id || null;
  } catch (_) { /* settings row not readable â€” leave null */ }
  try {
    branchId = branchDb.prepare(
      "SELECT value FROM sync_config WHERE key = 'branch_id' LIMIT 1"
    ).get()?.value || null;
  } catch (_) { /* no sync_config on this DB */ }
  return { tenantId, branchId };
}

const { conversionToBase } = require('../config/unitsHelper');
const dbProxy = require('../config/database');
const { makePaidStmt } = require('../services/apPaid');
const { recomputeGrnPayable: recomputePayable } = require('../services/grnPayable');
const vsdc = require('../services/vsdcClient');

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

// GET /api/hq/grns/awaiting
// Lists every branch's GRNs that are sitting at hq_status='PENDING_HQ_CONFIRM',
// grouped/sorted newest first. One row per GRN with summary totals + the
// originating PO# so HQ can quickly fan through the queue.
router.get('/awaiting', hqAuth, (req, res) => {
  try {
    const tenants = listTenants();
    const rows = [];
    for (const t of tenants) {
      try {
        const db = getTenantDb(t.slug);
        const grns = db.prepare(`
          SELECT g.id, g.grn_number, g.sync_id, g.date, g.total_items, g.total_amount,
                 g.notes, g.linked_purchase_sync_id, g.linked_purchase_number,
                 g.created_at, g.created_by,
                 TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS created_by_name,
                 s.name AS supplier_name
            FROM grn g
            LEFT JOIN users u     ON u.id = g.created_by
            LEFT JOIN suppliers s ON s.id = g.supplier_id
           WHERE g.deleted_at IS NULL
             AND g.hq_status = 'PENDING_HQ_CONFIRM'
           ORDER BY g.created_at DESC
        `).all();
        for (const g of grns) rows.push({ ...g, branch_slug: t.slug, branch_name: t.business_name || t.slug });
      } catch (e) {
        console.error(`[hq.grns.awaiting] ${t.slug}:`, e.message);
      }
    }
    rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    res.json({ grns: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.10.0 â€” /receipt/:syncId + /awaiting-generation are declared here so
// they win over the wildcard /:slug/:syncId below (Express matches in
// order â€” a 2-segment specific must precede a 2-segment wildcard, else
// the wildcard swallows "receipt" as if it were a branch slug).
router.get('/awaiting-generation', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.json({ purchases: [] });
    const rows = masterDb.prepare(`
      SELECT p.*,
             (SELECT COUNT(*) FROM hq_purchase_items i
               WHERE i.purchase_sync_id = p.sync_id
                 AND i.status = 'RECEIPT_REPORTED') AS reported_count,
             (SELECT COUNT(*) FROM hq_purchase_items i
               WHERE i.purchase_sync_id = p.sync_id) AS items_count,
             (SELECT COUNT(*) FROM hq_purchase_receipt_extras e
               WHERE e.purchase_sync_id = p.sync_id) AS extras_count
        FROM hq_purchases p
       WHERE p.confirmed_at_branch IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM hq_purchase_items i
            WHERE i.purchase_sync_id = p.sync_id
              AND i.status = 'RECEIPT_REPORTED'
         )
       ORDER BY p.confirmed_at_branch DESC
    `).all();
    res.json({ purchases: rows });
  } catch (error) {
    console.error('[hq.grns.awaiting-generation]', error);
    res.status(500).json({ error: error.message });
  }
});

// â”€â”€â”€ AP APPROVAL CHAIN (v1.13.30) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Kelete's payable workflow: Store Manager confirms GRN â†’ Accounts
// clerk checks â†’ Finance Head approves â†’ Main Cashier records payment.
// Declared BEFORE /:slug/:syncId (same reason as /hq/:syncId below):
// /ap/queue would otherwise be caught by that generic route with
// slug='ap', syncId='queue'.
// POST /api/hq/grns/ap/approve-batch â€” approve several GRNs of ONE supplier
// as a single payment batch.
//
// 2026-08-30. Approving invoices in a run is how AP actually works, and it is
// what shrinks Ready for Payment from one row per invoice to one row per
// decision. The batch is a GROUPING only: PAID/PARTIAL is still derived per
// GRN from SUM(ap_payments.amount), because a part-paid batch cannot say which
// invoice was settled and the per-GRN answer is what reconciles to the
// supplier ledger.
//
// Not called a voucher â€” payment_vouchers is an existing, unrelated
// general cash-out table, and a second PV series would break reconciliation.
// â”€â”€â”€ Standalone credit notes: the same stages a GRN walks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// 2026-08-31. A credit that belongs to no invoice now goes
//   Awaiting Check -> Awaiting Confirmation -> Ready for Payment -> Applied
// exactly as a GRN does, ending APPLIED rather than PAID because a credit is
// consumed against a payment rather than paid out.
//
// These live in the tenant DB (dbProxy), not master: AP is HQ-only, so they
// are raised on the HQ host and sit in its own supplier_credit_notes.
//
// Each step re-asserts the status it expects inside the UPDATE, so two people
// acting at once cannot skip a stage â€” the second one changes no rows and is
// told why.
function cnActor(req) {
  return [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ')
      || req.user?.email || 'user';
}

function loadStandaloneCredit(syncId) {
  return dbProxy.prepare(
    `SELECT * FROM supplier_credit_notes
      WHERE sync_id = ?
        AND (grn_sync_id IS NULL OR grn_sync_id = '')
        AND (deleted_at IS NULL OR deleted_at = '')`
  ).get(syncId);
}

// POST /api/hq/grns/ap/credit/:syncId/check   body: { grn_sync_id }
//
// 2026-08-31 â€” checking a standalone credit is where it gets ATTACHED to a
// GRN, because a person decides which invoice it belongs against. Splitting
// it across GRNs by formula would have been a guess dressed as a fact; asking
// the checker is both simpler and true.
//
// Once attached it stops being standalone: it leaves this queue and lives
// inside its GRN's payable, exactly like a credit raised at Generate GRN.
router.post('/ap/credit/:syncId/check', hqAuth, (req, res) => {
  try {
    const cn = loadStandaloneCredit(req.params.syncId);
    if (!cn) return res.status(404).json({ error: 'Credit note not found' });
    if ((cn.ap_status || 'PENDING') !== 'PENDING') {
      return res.status(400).json({ error: `Cannot check â€” status is ${cn.ap_status}.` });
    }
    const grnSyncId = String(req.body?.grn_sync_id || '').trim();
    if (!grnSyncId) {
      return res.status(400).json({ error: 'Choose which GRN this credit note applies to.' });
    }
    const grn = masterDb && masterDb.prepare(
      'SELECT grn_sync_id, grn_number, supplier_sync_id, supplier_id, ap_status, items_subtotal FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?'
    ).get(grnSyncId);
    if (!grn) return res.status(404).json({ error: 'That GRN could not be found.' });

    // Same supplier, or the credit would reduce a debt owed to someone else.
    const cnSup  = cn.supplier_sync_id || `id:${cn.supplier_id}`;
    const grnSup = grn.supplier_sync_id || `id:${grn.supplier_id}`;
    if (cnSup !== grnSup) {
      return res.status(400).json({ error: 'The credit note and the GRN belong to different suppliers.' });
    }
    // A settled GRN cannot absorb a credit â€” the money has already moved.
    if (['PAID'].includes(grn.ap_status)) {
      return res.status(400).json({
        error: `${grn.grn_number} is already paid. Attach the credit to an unpaid GRN, or leave it for the supplier to offset.`,
      });
    }
    // Never more than the GRN is worth, or the payable would go negative and
    // the supplier would appear to owe US on that invoice.
    const existing = dbProxy.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM supplier_credit_notes
        WHERE grn_sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')`
    ).get(grnSyncId)?.t || 0;
    const subtotal = parseFloat(grn.items_subtotal) || 0;
    const wouldBe  = (parseFloat(existing) || 0) + (parseFloat(cn.amount) || 0);
    if (wouldBe > subtotal + 0.01) {
      return res.status(400).json({
        error: `That would credit ${wouldBe.toFixed(2)} against a GRN worth ${subtotal.toFixed(2)}. `
             + 'Attach it to a larger GRN, or split the credit note.',
      });
    }

    dbProxy.transaction(() => {
      dbProxy.prepare(
        `UPDATE supplier_credit_notes
            SET grn_sync_id = ?, ap_status = 'CHECKED', checked_at = datetime('now'),
                checked_by_id = ?, checked_by_name = ?, updated_at = datetime('now'), synced = 0
          WHERE sync_id = ? AND ap_status = 'PENDING'`
      ).run(grnSyncId, req.user?.id || null, cnActor(req), req.params.syncId);
    })();
    const totals = recomputePayable(dbProxy, masterDb, grnSyncId);

    res.json({ ok: true, status: 'CHECKED', attached_to: grn.grn_number, ...(totals || {}) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/hq/grns/ap/credit/:syncId/confirm-review   (and /unconfirm-review)
router.post('/ap/credit/:syncId/confirm-review', hqAuth, (req, res) => {
  try {
    const cn = loadStandaloneCredit(req.params.syncId);
    if (!cn) return res.status(404).json({ error: 'Credit note not found' });
    if ((cn.ap_status || 'PENDING') !== 'CHECKED') {
      return res.status(400).json({ error: `Cannot confirm â€” status is ${cn.ap_status}.` });
    }
    dbProxy.prepare(
      `UPDATE supplier_credit_notes
          SET review_confirmed_at = datetime('now'),
              review_confirmed_by_id = ?, review_confirmed_by_name = ?,
              updated_at = datetime('now'), synced = 0
        WHERE sync_id = ?`
    ).run(req.user?.id || null, cnActor(req), req.params.syncId);
    res.json({ ok: true, confirmed: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/ap/credit/:syncId/unconfirm-review', hqAuth, (req, res) => {
  try {
    const cn = loadStandaloneCredit(req.params.syncId);
    if (!cn) return res.status(404).json({ error: 'Credit note not found' });
    if ((cn.ap_status || 'PENDING') !== 'CHECKED') {
      return res.status(400).json({ error: 'Already approved â€” nothing to unconfirm.' });
    }
    dbProxy.prepare(
      `UPDATE supplier_credit_notes
          SET review_confirmed_at = NULL, review_confirmed_by_id = NULL,
              review_confirmed_by_name = NULL, updated_at = datetime('now'), synced = 0
        WHERE sync_id = ?`
    ).run(req.params.syncId);
    res.json({ ok: true, confirmed: false });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/hq/grns/ap/credit/approve-batch â€” mirrors the GRN batch approve.
router.post('/ap/credit/approve-batch', hqAuth, (req, res) => {
  try {
    const ids = Array.isArray(req.body?.credit_sync_ids) ? req.body.credit_sync_ids.filter(Boolean) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'Select at least one credit note.' });

    const rows = ids.map(id => loadStandaloneCredit(id)).filter(Boolean);
    if (rows.length !== ids.length) {
      return res.status(400).json({ error: 'One or more credit notes could not be found.' });
    }
    // Same rule as a GRN: nothing is approved without having been opened and
    // confirmed. Enforced here, not just greyed out in the UI.
    const unreviewed = rows.filter(r => !r.review_confirmed_at);
    if (unreviewed.length > 0) {
      return res.status(400).json({
        error: 'Not confirmed yet: ' + unreviewed.map(r => r.credit_note_number).join(', ')
             + '. Open each one and confirm it before approving.',
      });
    }
    const wrong = rows.filter(r => (r.ap_status || 'PENDING') !== 'CHECKED');
    if (wrong.length > 0) {
      return res.status(400).json({
        error: 'Cannot approve ' + wrong.map(r => `${r.credit_note_number} (${r.ap_status})`).join(', ') + '.',
      });
    }

    const actor = cnActor(req);
    const upd = dbProxy.prepare(
      `UPDATE supplier_credit_notes
          SET ap_status = 'APPROVED', approved_at = datetime('now'),
              approved_by_id = ?, approved_by_name = ?,
              updated_at = datetime('now'), synced = 0
        WHERE sync_id = ? AND ap_status = 'CHECKED'`
    );
    const run = dbProxy.transaction(() => {
      let n = 0;
      for (const r of rows) n += upd.run(req.user?.id || null, actor, r.sync_id).changes;
      return n;
    });
    const changed = run();
    if (changed !== rows.length) {
      return res.status(409).json({ error: 'Some credit notes changed status while you were approving. Refresh and try again.' });
    }
    res.json({ ok: true, count: changed });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/hq/grns/ap/credit/:syncId/send-back â€” one stage back, like a GRN.
router.post('/ap/credit/:syncId/send-back', hqAuth, (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required.' });
    const cn = loadStandaloneCredit(req.params.syncId);
    if (!cn) return res.status(404).json({ error: 'Credit note not found' });
    const current = cn.ap_status || 'PENDING';
    if (!['CHECKED', 'APPROVED'].includes(current)) {
      return res.status(400).json({ error: `Nothing to send back â€” status is ${current}.` });
    }
    const backTo = current === 'APPROVED' ? 'CHECKED' : 'PENDING';
    // Sending back also clears the review, or it would return pre-confirmed
    // and be approved on the strength of a look at the version before the fix.
    const clear = current === 'APPROVED'
      ? 'approved_at = NULL, approved_by_id = NULL, approved_by_name = NULL, '
      : 'checked_at = NULL, checked_by_id = NULL, checked_by_name = NULL, ';
    dbProxy.prepare(
      `UPDATE supplier_credit_notes
          SET ap_status = ?, ${clear}
              review_confirmed_at = NULL, review_confirmed_by_id = NULL, review_confirmed_by_name = NULL,
              sent_back_at = datetime('now'), sent_back_by_name = ?, sent_back_reason = ?,
              updated_at = datetime('now'), synced = 0
        WHERE sync_id = ?`
    ).run(backTo, cnActor(req), reason, req.params.syncId);
    res.json({ ok: true, status: backTo });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/hq/grns/ap/:grnSyncId/confirm-review  (and /unconfirm-review)
// 2026-08-31 â€” Finance marks a GRN as reviewed, one at a time.
//
// The button lives inside the detail modal deliberately: confirming is only a
// real control if you had to open the thing to do it. Approval itself stays a
// batch action, so there is one way to approve rather than two doing the same
// job.
//
// The row stays CHECKED throughout â€” this is a marker, not a status.
router.post('/ap/:grnSyncId/confirm-review', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'master.db unavailable' });
    const row = masterDb.prepare('SELECT ap_status FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?').get(req.params.grnSyncId);
    if (!row) return res.status(404).json({ error: 'GRN snapshot not found' });
    if ((row.ap_status || 'PENDING') !== 'CHECKED') {
      return res.status(400).json({ error: `Cannot confirm â€” status is ${row.ap_status || 'PENDING'}. Only checked GRNs await approval.` });
    }
    const actorName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || req.user?.email || 'user';
    masterDb.prepare(`
      UPDATE hq_confirmed_grn_totals
         SET review_confirmed_at      = datetime('now'),
             review_confirmed_by_id   = ?,
             review_confirmed_by_name = ?
       WHERE grn_sync_id = ?
    `).run(req.user?.id || null, actorName, req.params.grnSyncId);
    res.json({ ok: true, confirmed: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/ap/:grnSyncId/unconfirm-review', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'master.db unavailable' });
    // Undo is allowed only while it is still unapproved â€” after that the batch
    // approval is the record and this marker no longer decides anything.
    const row = masterDb.prepare('SELECT ap_status FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?').get(req.params.grnSyncId);
    if (!row) return res.status(404).json({ error: 'GRN snapshot not found' });
    if ((row.ap_status || 'PENDING') !== 'CHECKED') {
      return res.status(400).json({ error: 'Already approved â€” nothing to unconfirm.' });
    }
    masterDb.prepare(`
      UPDATE hq_confirmed_grn_totals
         SET review_confirmed_at = NULL, review_confirmed_by_id = NULL, review_confirmed_by_name = NULL
       WHERE grn_sync_id = ?
    `).run(req.params.grnSyncId);
    res.json({ ok: true, confirmed: false });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/ap/approve-batch', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'master.db unavailable' });

    const ids = Array.isArray(req.body?.grn_sync_ids) ? req.body.grn_sync_ids.filter(Boolean) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'Select at least one GRN to approve.' });

    const placeholders = ids.map(() => '?').join(',');
    const rows = masterDb.prepare(
      'SELECT grn_sync_id, grn_number, supplier_sync_id, supplier_id, supplier_name, ' +
      '       final_payable, ap_status, review_confirmed_at ' +
      '  FROM hq_confirmed_grn_totals ' +
      ' WHERE grn_sync_id IN (' + placeholders + ')'
    ).all(...ids);

    if (rows.length !== ids.length) {
      return res.status(400).json({ error: 'One or more selected GRNs could not be found.' });
    }

    // One supplier per batch â€” the batch exists to become one payment, and a
    // payment row carries a single supplier.
    const suppliers = [...new Set(rows.map(r => r.supplier_sync_id || 'id:' + r.supplier_id))];
    if (suppliers.length > 1) {
      return res.status(400).json({ error: 'All selected GRNs must belong to the same supplier.' });
    }

    // Enforced server-side too: the UI greys the checkbox, but the rule is
    // that nothing is approved without having been opened and confirmed.
    const unreviewed = rows.filter(r => !r.review_confirmed_at);
    if (unreviewed.length > 0) {
      return res.status(400).json({
        error: 'Not confirmed yet: ' + unreviewed.map(r => r.grn_number).join(', ')
             + '. Open each one and confirm it before approving.',
      });
    }
    const wrong = rows.filter(r => (r.ap_status || 'PENDING') !== 'CHECKED');
    if (wrong.length > 0) {
      return res.status(400).json({
        error: 'Cannot approve ' + wrong.map(r => r.grn_number + ' (' + (r.ap_status || 'PENDING') + ')').join(', ')
             + '. Only checked GRNs can be approved.',
      });
    }

    const actorName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || req.user?.email || 'user';
    const batchRef = randomUUID();
    // Human-facing number. Counted from existing DISTINCT batches so it stays
    // stable and readable; the ref above is what rows actually join on.
    let seq = 0;
    try {
      seq = masterDb.prepare(
        'SELECT COUNT(DISTINCT ap_batch_ref) AS n FROM hq_confirmed_grn_totals WHERE ap_batch_ref IS NOT NULL'
      ).get()?.n || 0;
    } catch (_) { /* first run, before the column exists on an old mirror */ }
    const batchNumber = 'APB-' + new Date().getUTCFullYear() + '-' + String(seq + 1).padStart(5, '0');

    // A single-GRN "batch" is left unstamped, so it renders as an ordinary row
    // rather than a batch of one that the user never asked for.
    const stampBatch = ids.length > 1;

    const upd = masterDb.prepare(
      "UPDATE hq_confirmed_grn_totals " +
      "   SET ap_status = 'APPROVED', " +
      "       approved_at = datetime('now'), " +
      "       approved_by_id = ?, approved_by_name = ?, " +
      "       ap_batch_ref = ?, ap_batch_number = ? " +
      " WHERE grn_sync_id = ? AND ap_status = 'CHECKED'"
    );

    const run = masterDb.transaction(() => {
      let n = 0;
      for (const r of rows) {
        const info = upd.run(req.user?.id || null, actorName,
                             stampBatch ? batchRef : null,
                             stampBatch ? batchNumber : null,
                             r.grn_sync_id);
        n += info.changes;
      }
      return n;
    });
    const changed = run();

    // The WHERE re-asserts CHECKED inside the transaction, so a row approved by
    // someone else between the read and the write is skipped rather than
    // silently re-approved under this batch.
    if (changed !== rows.length) {
      return res.status(409).json({
        error: 'Some GRNs changed status while you were approving. Refresh and try again.',
      });
    }

    res.json({
      ok: true,
      status: 'APPROVED',
      count: changed,
      batch_ref:    stampBatch ? batchRef : null,
      batch_number: stampBatch ? batchNumber : null,
      total: rows.reduce((n, r) => n + (parseFloat(r.final_payable) || 0), 0),
      supplier_name: rows[0].supplier_name || null,
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/ap/:grnSyncId/check', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'master.db unavailable' });
    const { grnSyncId } = req.params;
    const row = masterDb.prepare('SELECT ap_status FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?').get(grnSyncId);
    if (!row) return res.status(404).json({ error: 'GRN snapshot not found' });
    const currentStatus = row.ap_status || 'PENDING';
    if (currentStatus !== 'PENDING') {
      return res.status(400).json({ error: `Cannot Check â€” current status is ${currentStatus}. Only PENDING rows can be Checked.` });
    }
    const actorName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || req.user?.email || 'user';
    masterDb.prepare(`
      UPDATE hq_confirmed_grn_totals
         SET ap_status = 'CHECKED',
             checked_at = datetime('now'),
             checked_by_id = ?, checked_by_name = ?
       WHERE grn_sync_id = ?
    `).run(req.user?.id || null, actorName, grnSyncId);
    res.json({ ok: true, status: 'CHECKED' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/ap/:grnSyncId/approve', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'master.db unavailable' });
    const { grnSyncId } = req.params;
    const row = masterDb.prepare('SELECT ap_status FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?').get(grnSyncId);
    if (!row) return res.status(404).json({ error: 'GRN snapshot not found' });
    const currentStatus = row.ap_status || 'PENDING';
    if (currentStatus !== 'CHECKED') {
      return res.status(400).json({ error: `Cannot Approve â€” current status is ${currentStatus}. Only CHECKED rows can be Approved.` });
    }
    const actorName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || req.user?.email || 'user';
    masterDb.prepare(`
      UPDATE hq_confirmed_grn_totals
         SET ap_status = 'APPROVED',
             approved_at = datetime('now'),
             approved_by_id = ?, approved_by_name = ?
       WHERE grn_sync_id = ?
    `).run(req.user?.id || null, actorName, grnSyncId);
    res.json({ ok: true, status: 'APPROVED' });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Send-Back â€” dormant per user's Option A choice, wired in case we
// enable the button in the UI later.
router.post('/ap/:grnSyncId/send-back', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'master.db unavailable' });
    const { grnSyncId } = req.params;
    const reason = ((req.body && req.body.reason) || '').toString().trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required for Send-Back.' });
    const row = masterDb.prepare('SELECT ap_status FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?').get(grnSyncId);
    if (!row) return res.status(404).json({ error: 'GRN snapshot not found' });
    const currentStatus = row.ap_status || 'PENDING';
    if (!['CHECKED', 'APPROVED'].includes(currentStatus)) {
      return res.status(400).json({ error: `Cannot reject â€” current status is ${currentStatus}. Only rows awaiting approval or ready for payment can be sent back.` });
    }

    // 2026-08-30 â€” go back ONE step, not to the beginning.
    //
    // This used to drop everything to PENDING and wipe both the check and the
    // approval. So Finance rejecting an approved GRN also undid Accounts'
    // check, and that work had to be redone for a problem that was never
    // theirs. Now each stage returns to the one before it and only its own
    // stamp is cleared:
    //     APPROVED -> CHECKED   (clears approval, keeps the check)
    //     CHECKED  -> PENDING   (clears the check)
    const backTo = currentStatus === 'APPROVED' ? 'CHECKED' : 'PENDING';
    // 2026-08-30 â€” leaving APPROVED also leaves the payment batch.
    //
    // A batch is a set of invoices approved together for one payment; a GRN
    // sent back is no longer approved, so keeping it in the batch would show
    // the cashier a total including money nobody authorised. The remaining
    // members keep the batch and its number, and the total simply shrinks.
    // A batch reduced to one GRN still renders as a normal row, since the
    // grouping is display-only.
    // 2026-08-31 â€” a send-back also clears Finance's review. Otherwise a GRN
    // pushed back for a correction would return already confirmed, and be
    // approved on the strength of a review of the version before the fix.
    const clearReview = 'review_confirmed_at = NULL, review_confirmed_by_id = NULL, '
                      + 'review_confirmed_by_name = NULL';
    const clearStamps = currentStatus === 'APPROVED'
      ? 'approved_at = NULL, approved_by_id = NULL, approved_by_name = NULL, '
        + 'ap_batch_ref = NULL, ap_batch_number = NULL, ' + clearReview
      : 'checked_at = NULL, checked_by_id = NULL, checked_by_name = NULL, ' + clearReview;

    const actorName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || req.user?.email || 'user';
    masterDb.prepare(`
      UPDATE hq_confirmed_grn_totals
         SET ap_status = ?,
             sent_back_at = datetime('now'),
             sent_back_by_id = ?, sent_back_by_name = ?,
             sent_back_reason = ?, sent_back_from_stage = ?,
             ${clearStamps}
       WHERE grn_sync_id = ?
    `).run(backTo, req.user?.id || null, actorName, reason, currentStatus, grnSyncId);
    res.json({ ok: true, status: backTo });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/hq/grns/ap/reject-reasons
// 2026-08-30 â€” the reasons already used, most recent first, so a rejection can
// be picked from a list rather than retyped. The same handful recur ("invoice
// does not match the delivery", "wrong supplier"), and retyping them by hand
// produces near-duplicates that are useless to search or report on later.
router.get('/ap/reject-reasons', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.json({ reasons: [] });
    const rows = masterDb.prepare(`
      SELECT sent_back_reason AS reason, MAX(sent_back_at) AS last_used
        FROM hq_confirmed_grn_totals
       WHERE sent_back_reason IS NOT NULL AND TRIM(sent_back_reason) != ''
       GROUP BY LOWER(TRIM(sent_back_reason))
       ORDER BY last_used DESC
       LIMIT 20
    `).all();
    res.json({ reasons: rows.map(r => r.reason) });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// GET /api/hq/grns/ap/queue â€” rows for the AP page, filtered by stage.
// GET /api/hq/grns/ap/:grnSyncId/pending-credits
//
// 2026-09-06 â€” the credits a depot has raised against this delivery and
// nobody has agreed yet. The Confirm Delivery modal lists them so the Store
// Manager settles them and the delivery in one place, instead of being sent
// to the Credit Notes page and back. That page still works; this is the same
// decision reachable from where it is being made.
router.get('/ap/:grnSyncId/pending-credits', hqAuth, (req, res) => {
  try {
    const rows = (dbProxy.defaultDb || dbProxy).prepare(
      `SELECT sync_id, credit_note_number, reason, amount, date,
              raised_by_branch, raised_by_name, notes
         FROM supplier_credit_notes
        WHERE proposed_grn_sync_id = ? AND branch_confirmed_at IS NULL
          AND (deleted_at IS NULL OR deleted_at = '')
        ORDER BY id ASC`
    ).all(String(req.params.grnSyncId || '').trim());
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/hq/grns/ap/:grnSyncId/confirm-delivery
// Body: { invoice_attachment }
//
// 2026-09-06 â€” the Store Manager's confirmation, the stage in front of the AP
// queue. Every GRN waits here from the moment it is generated while the depot
// finishes offloading and raises whatever credits the truck produced.
// Confirming says "this delivery and its credits are what the supplier says
// they are", and only then does Accounts see it.
//
// The invoice scan is REQUIRED here. It used to be demanded from the depot,
// who is standing on an offloading bay with a driver waiting and often has no
// invoice yet - so it was skipped or faked. The Store Manager receives it by
// WhatsApp once offloading is done, which is also the signal that the depot
// has finished counting. The person who can satisfy the requirement is now
// the one being asked.
router.post('/ap/:grnSyncId/confirm-delivery', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(500).json({ error: 'master.db unavailable' });

    // Checked here, not only in the browser. Hiding a button stops a mistake;
    // it does not stop the endpoint being called. Confirming and checking are
    // meant to be two people, and that separation is worth nothing if either
    // of them can reach the other's action directly.
    if (String(req.user?.role || '') !== 'Administrator') {
      let perms = [];
      try {
        const u = (dbProxy.defaultDb || dbProxy)
          .prepare('SELECT permissions FROM users WHERE id = ? AND deleted_at IS NULL')
          .get(req.user?.id);
        perms = JSON.parse(u?.permissions || '[]');
        if (!Array.isArray(perms)) perms = [];
      } catch (_) { perms = []; }
      const allowed = perms.includes('All') || perms.includes('Full Access')
        || perms.some(p => String(p).startsWith('APConfirm'));
      if (!allowed) {
        return res.status(403).json({ error: 'You do not have permission to confirm deliveries.' });
      }
    }
    const grnSyncId = String(req.params.grnSyncId || '').trim();
    const attachment = String(req.body?.invoice_attachment || '').trim();

    const row = masterDb.prepare(
      'SELECT grn_number, ap_status FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?'
    ).get(grnSyncId);
    if (!row) return res.status(404).json({ error: 'GRN not found.' });
    if (String(row.ap_status || 'PENDING') !== 'UNCONFIRMED') {
      return res.status(400).json({ error: `${row.grn_number} is already past confirmation (${row.ap_status}).` });
    }

    // Existing attachment counts â€” one may already have come from the depot,
    // or from an earlier confirmation before a credit pulled this GRN back.
    const existing = masterDb.prepare(
      'SELECT invoice_attachment FROM hq_grns WHERE sync_id = ?'
    ).get(grnSyncId)?.invoice_attachment || null;
    const finalAttachment = attachment || existing;
    if (!finalAttachment) {
      return res.status(400).json({ error: 'Attach the supplier invoice before confirming.' });
    }

    // A credit still waiting to be confirmed means the payable is not settled,
    // so the delivery cannot be released. Named individually - "there are
    // unconfirmed credits" leaves the operator hunting for which.
    let pending = [];
    try {
      pending = (dbProxy.defaultDb || dbProxy).prepare(
        `SELECT credit_note_number, amount FROM supplier_credit_notes
          WHERE proposed_grn_sync_id = ? AND branch_confirmed_at IS NULL
            AND (deleted_at IS NULL OR deleted_at = '')`
      ).all(grnSyncId);
    } catch (_) { pending = []; }
    if (pending.length > 0) {
      return res.status(409).json({
        error: 'Confirm or reject the credit note'
             + (pending.length > 1 ? 's ' : ' ')
             + pending.map(c => c.credit_note_number).join(', ')
             + ' first â€” they change what is payable on this GRN.',
        pending_credits: pending,
      });
    }

    const who = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ')
             || req.user?.email || 'HQ';
    masterDb.prepare(
      `UPDATE hq_confirmed_grn_totals
          SET ap_status = 'PENDING',
              delivery_confirmed_at = datetime('now'),
              delivery_confirmed_by_id = ?,
              delivery_confirmed_by_name = ?
        WHERE grn_sync_id = ? AND ap_status = 'UNCONFIRMED'`
    ).run(req.user?.id || null, who, grnSyncId);

    if (attachment) {
      try {
        masterDb.prepare('UPDATE hq_grns SET invoice_attachment = ? WHERE sync_id = ?')
          .run(attachment, grnSyncId);
      } catch (_) { /* the status change is what matters */ }
    }
    res.json({ ok: true, grn_number: row.grn_number, invoice_attachment: finalAttachment });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/ap/queue', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.json({ rows: [] });
    // 2026-08-30 â€” PARTIAL belongs with the unpaid work, not with Paid.
    //
    // A part-paid GRN is still owed money, so it stays in Ready for Payment
    // alongside APPROVED. Asking for APPROVED returns both, so the cashier
    // sees everything still outstanding in one place.
    const statusFilter = (req.query.status || '').toUpperCase();
    const allowed = ['UNCONFIRMED', 'PENDING', 'CHECKED', 'APPROVED', 'PARTIAL', 'PAID'];
    // status=ALL returns every stage including PAID. Note the no-status
    // default is NOT the same thing: it deliberately omits PAID, because the
    // page's own default view is the outstanding work queue.
    const clause = statusFilter === 'ALL'
      ? ''
      : statusFilter === 'APPROVED'
        ? " AND ap_status IN ('APPROVED','PARTIAL')"
        : allowed.includes(statusFilter)
          ? ' AND ap_status = ?'
          : " AND ap_status IN ('UNCONFIRMED','PENDING','CHECKED','APPROVED','PARTIAL')";
    const params = (statusFilter !== 'APPROVED' && statusFilter !== 'ALL' && allowed.includes(statusFilter))
      ? [statusFilter] : [];
    const rows = masterDb.prepare(`
      SELECT grn_sync_id, grn_number, branch_slug, branch_name,
             supplier_id, supplier_sync_id, supplier_name,
             po_number, date, items_count, items_subtotal, cn_total,
             final_payable, invoice_number,
             confirmed_by_name, confirmed_at,
             ap_status, checked_at, checked_by_name,
             approved_at, approved_by_name,
             sent_back_at, sent_back_by_name, sent_back_reason, sent_back_from_stage,
             paid_at, paid_by_name,
             ap_batch_ref, ap_batch_number,
             review_confirmed_at, review_confirmed_by_name,
             delivery_confirmed_at, delivery_confirmed_by_name
        FROM hq_confirmed_grn_totals
       WHERE 1=1${clause}
       ORDER BY confirmed_at DESC
       LIMIT 500
    `).all(...params);

    // 2026-08-30 â€” attach what has actually been paid against each GRN, and
    // correct any status that predates the PARTIAL rule.
    //
    // Payments live in the tenant DB (ap_payments) while the GRN totals live
    // in master, so this cannot be a JOIN. Summing per row is fine at the
    // 500-row ceiling above.
    //
    // The repair matters: before today ANY payment stamped a GRN as PAID, so
    // short-paid GRNs are sitting in the Paid tab looking settled. Recomputing
    // here moves them back where they belong the moment the page is opened,
    // rather than needing a migration to guess at history.
    // dbProxy, not db â€” this file imports the database as dbProxy (line 62).
    const paidFor = makePaidStmt(dbProxy);  // allocations - see services/apPaid.js
    const fixStmt = masterDb.prepare(
      'UPDATE hq_confirmed_grn_totals SET ap_status = ? WHERE grn_sync_id = ?'
    );
    const out = rows.map(r => {
      let paid = 0;
      try { paid = paidFor(r.grn_sync_id); } catch (_) {}
      const payable   = parseFloat(r.final_payable || 0) || 0;
      const remaining = Math.max(0, payable - paid);
      let ap_status = r.ap_status;
      if (paid > 0 && payable > 0) {
        const should = (paid + 0.01 >= payable) ? 'PAID' : 'PARTIAL';
        if (ap_status !== should && (ap_status === 'PAID' || ap_status === 'PARTIAL' || ap_status === 'APPROVED')) {
          try { fixStmt.run(should, r.grn_sync_id); ap_status = should; } catch (_) {}
        }
      }
      return { ...r, ap_status, paid_amount: paid, remaining_amount: remaining };
    });

    // 2026-08-30 â€” re-apply the tab filter AFTER the correction above.
    //
    // The WHERE clause selected on the STORED status. A GRN wrongly stamped
    // PAID is therefore fetched for the Paid tab, corrected to PARTIAL on the
    // way out, and rendered under Paid wearing a "Partially Paid" badge â€” the
    // repair working, in the wrong list. It would move on the next refresh
    // once the stored value caught up, which is worse than either being
    // right: it looks like the page cannot make up its mind.
    const wanted = statusFilter === 'ALL' ? allowed
                 : statusFilter === 'APPROVED' ? ['APPROVED', 'PARTIAL']
                 : allowed.includes(statusFilter) ? [statusFilter]
                 : ['PENDING', 'CHECKED', 'APPROVED', 'PARTIAL'];
    const grnRows = out.filter(r => wanted.includes(r.ap_status));

    // 2026-08-31 â€” standalone credit notes join the queue as their own rows.
    //
    // A credit that belongs to no invoice used to lower the supplier's balance
    // the moment it was saved and then sit there unusable: payments are
    // matched GRN by GRN, so it reduced a total while every GRN still showed
    // its full amount, and nobody ever checked it.
    //
    // It now appears here beside the GRNs, walks the same stages, and can be
    // ticked alongside them so a payment nets out:
    //     GRN1 + GRN2 - SCN001
    //
    // Read from the tenant DB rather than master. AP is HQ-only, so these are
    // raised on the HQ host and live in its own supplier_credit_notes; the
    // paid-amount lookup above already reads the same connection.
    //
    // ATTACHED credits are deliberately excluded (grn_sync_id IS NOT NULL):
    // they are already inside their GRN's payable, and listing them again
    // would deduct the same money twice.
    let creditRows = [];
    try {
      const creditWanted = wanted.filter(w => w !== 'PARTIAL');   // a credit is whole or applied
      if (creditWanted.length > 0) {
        const ph = creditWanted.map(() => '?').join(',');
        creditRows = dbProxy.prepare(
          `SELECT cn.sync_id            AS credit_sync_id,
                  cn.credit_note_number AS credit_note_number,
                  cn.reason, cn.notes, cn.date,
                  cn.amount, cn.ap_status,
                  cn.supplier_id, cn.supplier_sync_id,
                  cn.checked_at, cn.checked_by_name,
                  cn.review_confirmed_at, cn.review_confirmed_by_name,
                  cn.approved_at, cn.approved_by_name,
                  cn.applied_at,
                  s.name AS supplier_name
             FROM supplier_credit_notes cn
             LEFT JOIN suppliers s ON s.sync_id = cn.supplier_sync_id
            WHERE (cn.grn_sync_id IS NULL OR cn.grn_sync_id = '')
              AND (cn.deleted_at IS NULL OR cn.deleted_at = '')
              AND cn.applied_at IS NULL
              AND cn.ap_status IN (${ph})
            ORDER BY cn.date DESC, cn.id DESC`
        ).all(...creditWanted).map(c => ({
          ...c,
          // Shaped like a GRN row so the page can render one list. row_type is
          // what tells them apart; is_credit keeps the sign explicit at every
          // call site rather than relying on a negative amount.
          row_type:       'CREDIT',
          is_credit:      1,
          grn_sync_id:    c.credit_sync_id,      // the page keys rows on this
          grn_number:     c.credit_note_number,
          final_payable:  parseFloat(c.amount) || 0,
          items_subtotal: parseFloat(c.amount) || 0,
          cn_total:       0,
          paid_amount:    0,
          remaining_amount: parseFloat(c.amount) || 0,
          confirmed_by_name: c.checked_by_name || null,
          confirmed_at:      c.date || null,
        }));
      }
    } catch (_) { /* pre-migration DB â€” the queue is still valid without them */ }

    res.json({ rows: [...grnRows, ...creditRows] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// POST /api/hq/grns/hq/:syncId/void   { reason }
//
// 2026-09-17 â€” Void GRN, for a GRN generated by mistake. HQ Administrator only.
// Undoes everything /generate did, or refuses without touching anything:
//
//   Refused when  AP has approved it (APPROVED / PARTIAL / PAID, or in a
//                 payment batch) or any payment is recorded against it
//                 Â· a credit note was raised against it AFTER generation
//                 Â· the depot no longer holds the stock (already sold)
//   Depot         the GRN's stock movements (receipt, in-transit damage, and
//                 the returns of credit notes made with it) are removed,
//                 current_stock follows, and the average-cost blend is
//                 reversed (exact when nothing else moved the item since)
//   HQ (master)   hq_grns + hq_confirmed_grn_totals marked voided (ap_status
//                 'VOIDED'); the credit notes made with it deleted; the
//                 purchase lines it confirmed CANCELLED, and the purchase
//                 too once nothing on it is left open
//   HQ book       the GRN and its credit notes removed from the supplier
//                 balance (Account Payables)
//   ZRA           a Return (sarTyCd 03) stock-out for the GRN's lines, when
//                 the purchase was sent to ZRA
//
// The GRN is never erased: it stays in the Archive marked VOIDED.
router.post('/hq/:syncId/void', hqAuth, async (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'master.db unavailable' });
    if (req.user?.role !== 'Administrator') {
      return res.status(403).json({ error: 'Only an HQ Administrator can void a GRN.' });
    }
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ error: 'A reason (at least 3 characters) is required.' });

    const syncId = req.params.syncId;
    const grn = masterDb.prepare(`SELECT * FROM hq_grns WHERE sync_id = ? AND deleted_at IS NULL`).get(syncId);
    if (!grn) return res.status(404).json({ error: 'GRN not found. Only GRNs generated at HQ can be voided.' });
    if (grn.voided_at) return res.status(400).json({ error: `GRN ${grn.grn_number} is already voided.` });

    // â”€â”€ AP: not approved, not in a batch, nothing paid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const totals = masterDb.prepare('SELECT * FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?').get(syncId);
    const apStatus = totals?.ap_status || 'UNCONFIRMED';
    if (['APPROVED', 'PARTIAL', 'PAID'].includes(apStatus) || totals?.ap_batch_ref) {
      return res.status(400).json({ error: `Cannot void: AP has already approved this GRN (${apStatus}). Finance must send it back first.` });
    }
    const paid = makePaidStmt(dbProxy)(syncId);
    if (paid > 0.004) {
      return res.status(400).json({ error: `Cannot void: K${paid.toLocaleString()} has already been paid against this GRN.` });
    }

    // â”€â”€ Credit notes: made with the GRN (voided with it) vs raised later â”€â”€
    const genCns = masterDb.prepare(
      `SELECT * FROM hq_supplier_credit_notes WHERE grn_sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')`
    ).all(syncId);
    const genCnIds = new Set(genCns.map(c => c.sync_id));
    const hqDb = require('../config/database').defaultDb;
    let laterCns = [];
    try {
      let rows;
      try {
        rows = hqDb.prepare(
          `SELECT sync_id, credit_note_number FROM supplier_credit_notes
            WHERE (grn_sync_id = ? OR proposed_grn_sync_id = ?) AND (deleted_at IS NULL OR deleted_at = '')`
        ).all(syncId, syncId);
      } catch (_) {
        rows = hqDb.prepare(
          `SELECT sync_id, credit_note_number FROM supplier_credit_notes
            WHERE grn_sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')`
        ).all(syncId);
      }
      laterCns = rows.filter(c => !genCnIds.has(c.sync_id));
    } catch (_) { laterCns = []; }
    if (laterCns.length > 0) {
      return res.status(400).json({
        error: `Cannot void: credit note ${laterCns.map(c => c.credit_note_number).join(', ')} was raised against this GRN afterwards. Delete it first, then void.`,
      });
    }

    const branchSlug = grn.branch_slug;
    if (!branchSlug || !isRegistered(branchSlug)) {
      return res.status(400).json({ error: `Depot ${branchSlug || '(none)'} is not registered.` });
    }
    const branchDb = getTenantDb(branchSlug);
    const purchase = grn.po_sync_id
      ? masterDb.prepare('SELECT * FROM hq_purchases WHERE sync_id = ?').get(grn.po_sync_id)
      : null;
    const items = masterDb.prepare('SELECT * FROM hq_grn_items WHERE grn_sync_id = ?').all(syncId);

    // â”€â”€ Depot stock movements to undo â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const refIds = [syncId, ...genCns.map(c => c.sync_id)];
    const movs = branchDb.prepare(
      `SELECT id, product_sync_id, quantity FROM stock_movements
        WHERE reference_sync_id IN (${refIds.map(() => '?').join(',')})
          AND reference_type IN ('hq_grn', 'hq_grn_damage', 'credit_note')
          AND deleted_at IS NULL`
    ).all(...refIds);
    const net = new Map();   // product_sync_id â†’ base qty the depot loses
    for (const m of movs) {
      if (!m.product_sync_id) continue;
      net.set(m.product_sync_id, (net.get(m.product_sync_id) || 0) + (parseFloat(m.quantity) || 0));
    }

    // Refuse if the stock is no longer there (sold / moved on).
    const stockAt = branchDb.prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS s FROM stock_movements
        WHERE product_sync_id = ? AND location = 'sales' AND deleted_at IS NULL`
    );
    const prodName = branchDb.prepare('SELECT name FROM products WHERE sync_id = ?');
    const shortages = [];
    for (const [ps, n] of net) {
      if (n <= 0.0001) continue;
      const have = parseFloat(stockAt.get(ps)?.s) || 0;
      if (have - n < -0.0001) {
        shortages.push({ product_name: prodName.get(ps)?.name || ps, needed: Number(n.toFixed(2)), in_stock: Number(have.toFixed(2)) });
      }
    }
    if (shortages.length > 0) {
      return res.status(400).json({
        error: `Cannot void: some of this GRN's stock has already left ${grn.branch_name || branchSlug} (sold or moved).`,
        shortages,
      });
    }

    // What the receipt blended into the average cost, per product (base units,
    // same conversion and currency rule as /generate).
    const poCurrency = String(purchase?.cost_currency || '').toUpperCase();
    const poRate     = parseFloat(purchase?.fx_rate_used || 0) || 0;
    const toUsd = (unitPrice) => {
      const c = parseFloat(unitPrice || 0) || 0;
      if (c <= 0) return 0;
      if (!poCurrency || poCurrency === 'USD') return c;
      return poRate > 0 ? c / poRate : c;
    };
    const prodRow = branchDb.prepare(
      'SELECT id, sync_id, name, unit, alt_unit, conversion_factor, units_json, current_stock, avg_cost_price FROM products WHERE sync_id = ?'
    );
    const received = new Map();   // product_sync_id â†’ { qty, value }
    for (const it of items) {
      const qty = parseFloat(it.quantity) || 0;
      if (!it.product_sync_id || qty <= 0) continue;
      const prod = prodRow.get(it.product_sync_id);
      if (!prod) continue;
      const conv = conversionToBase(prod, it.unit || prod.unit);
      const base = qty * conv;
      const cpBase = conv > 0 ? toUsd(it.unit_price) / conv : toUsd(it.unit_price);
      const r = received.get(it.product_sync_id) || { qty: 0, value: 0 };
      r.qty += base; r.value += base * cpBase;
      received.set(it.product_sync_id, r);
    }

    // â”€â”€ 1. Depot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const stockChanges = [];
    branchDb.transaction(() => {
      const upd = branchDb.prepare(
        `UPDATE products SET current_stock = ?, avg_cost_price = ?, updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`
      );
      for (const ps of new Set([...net.keys(), ...received.keys()])) {
        const p = prodRow.get(ps);
        if (!p) continue;
        const cur = parseFloat(p.current_stock) || 0;
        const avg = p.avg_cost_price == null ? null : parseFloat(p.avg_cost_price);
        const n = net.get(ps) || 0;
        const r = received.get(ps) || { qty: 0, value: 0 };
        let newAvg = avg;
        // Take out the received value; the damaged / returned units were
        // removed at the average, so they come back in at it.
        if (avg != null && r.qty > 0) {
          const units = cur - n;
          const value = cur * avg - r.value + (r.qty - n) * avg;
          if (units > 0.0001 && value > 0) newAvg = Math.round((value / units) * 10000) / 10000;
        }
        upd.run(cur - n, newAvg, ps);
        stockChanges.push({ product_name: p.name || ps, removed: Number(n.toFixed(2)) });
      }
      if (movs.length > 0) {
        branchDb.prepare(
          `UPDATE stock_movements SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0
            WHERE id IN (${movs.map(() => '?').join(',')})`
        ).run(...movs.map(m => m.id));
      }
    })();

    // â”€â”€ 2. HQ (master) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const actorName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ')
      || req.user?.name || req.user?.email || 'HQ';
    let purchaseCancelled = false;
    masterDb.transaction(() => {
      masterDb.prepare(
        `UPDATE hq_grns SET voided_at = datetime('now'), voided_by_id = ?, voided_by_name = ?, void_reason = ? WHERE sync_id = ?`
      ).run(req.user?.id || null, actorName, reason, syncId);
      masterDb.prepare(
        `UPDATE hq_confirmed_grn_totals
            SET ap_status = 'VOIDED', voided_at = datetime('now'), voided_by_id = ?, voided_by_name = ?, void_reason = ?
          WHERE grn_sync_id = ?`
      ).run(req.user?.id || null, actorName, reason, syncId);
      for (const cn of genCns) {
        masterDb.prepare(`UPDATE hq_supplier_credit_notes SET deleted_at = datetime('now') WHERE sync_id = ?`).run(cn.sync_id);
      }
      if (grn.po_sync_id) {
        masterDb.prepare(
          `UPDATE hq_purchase_items SET status = 'CANCELLED', variance_notes = ?
            WHERE purchase_sync_id = ? AND linked_grn_sync_id = ?`
        ).run(`GRN ${grn.grn_number} voided: ${reason}`, grn.po_sync_id, syncId);
        const open = masterDb.prepare(
          `SELECT COUNT(*) AS n FROM hq_purchase_items WHERE purchase_sync_id = ? AND status <> 'CANCELLED'`
        ).get(grn.po_sync_id).n;
        if (open === 0) {
          masterDb.prepare(
            `UPDATE hq_purchases SET status = 'CANCELLED', total_amount = 0, updated_at = datetime('now') WHERE sync_id = ?`
          ).run(grn.po_sync_id);
          purchaseCancelled = true;
        }
      }
    })();

    // â”€â”€ 3. HQ book: out of the supplier balance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const warnings = [];
    const softDelete = (sql, ...args) => {
      try { hqDb.prepare(sql).run(...args); }
      catch (e) { warnings.push(`HQ book: ${e.message}`); }
    };
    softDelete(`UPDATE grn SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE sync_id = ? AND deleted_at IS NULL`, syncId);
    softDelete(`UPDATE grn_items SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE grn_sync_id = ? AND deleted_at IS NULL`, syncId);
    for (const cn of genCns) {
      softDelete(`UPDATE supplier_credit_notes SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE sync_id = ? AND deleted_at IS NULL`, cn.sync_id);
      softDelete(`UPDATE supplier_credit_note_items SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE credit_note_sync_id = ? AND deleted_at IS NULL`, cn.sync_id);
    }

    // â”€â”€ 4. ZRA: Return (03) for what was reported as purchased â”€â”€â”€â”€â”€â”€â”€â”€
    let zra = { skipped: true, reason: 'the purchase was not sent to ZRA' };
    if (purchase && purchase.zra_status === 'SIGNED') {
      const lines = items
        .filter(i => i.product_sync_id && (parseFloat(i.quantity) || 0) > 0)
        .map(i => ({ product_sync_id: i.product_sync_id, quantity: parseFloat(i.quantity), unit: i.unit || null }));
      if (lines.length === 0) {
        zra = { skipped: true, reason: 'no lines to return' };
      } else {
        try {
          const branchTenantId = branchDb.prepare('SELECT tenant_id FROM business_settings LIMIT 1').get()?.tenant_id || branchSlug;
          const out = await dbProxy.runWithDb(branchDb, () => vsdc.saveNonSaleStockChain(
            branchTenantId,
            (purchase.id || 0) * 1000000 + Date.now() % 1000000,
            { remark: `Void ${grn.grn_number} (${purchase.purchase_number}): ${reason}`.slice(0, 400) },
            lines,
            vsdc.SAR_TY_CD.RETURN
          ));
          zra = out?.skipped
            ? { skipped: true, reason: out.reason || 'ZRA off' }
            : { ok: !(out && (out.ok === false || out.error)), detail: out };
        } catch (e) {
          zra = { ok: false, error: e.message };
        }
      }
      try {
        masterDb.prepare('UPDATE hq_grns SET void_zra_result = ? WHERE sync_id = ?')
          .run(JSON.stringify(zra).slice(0, 4000), syncId);
      } catch (_) { /* record only */ }
    }

    res.json({
      ok: true,
      grn_number: grn.grn_number,
      purchase_cancelled: purchaseCancelled,
      stock: stockChanges,
      credit_notes_voided: genCns.map(c => c.credit_note_number),
      zra,
      warnings,
    });
  } catch (error) {
    console.error('[hq.grns.void] failed:', error.stack || error);
    res.status(500).json({ error: error.message });
  }
});

// v1.10.3 â€” Full doc for a v1.10.0 HQ-generated GRN. Reads master.db only
// (no branch DB round-trip). Declared above the /:slug/:syncId wildcard so
// Express matches "/hq/<uuid>" here instead of treating "hq" as a slug.
router.get('/hq/:syncId', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(404).json({ error: 'master.db unavailable' });
    const syncId = req.params.syncId;
    const grn = masterDb.prepare(`SELECT * FROM hq_grns WHERE sync_id = ? AND deleted_at IS NULL`).get(syncId);
    if (!grn) return res.status(404).json({ error: 'HQ GRN not found.' });
    const items = masterDb.prepare(
      `SELECT * FROM hq_grn_items WHERE grn_sync_id = ? ORDER BY id ASC`
    ).all(syncId);
    // v1.10.114 â€” damaged_quantity isn't stored on hq_grn_items (only on
    // stock_movements at generate-time with reference_type='hq_grn_damage'),
    // so cross-DB read from the destination branch's stock_movements is
    // required to surface it. Group by product_sync_id, sum abs(quantity)
    // in BASE units. Frontend divides by the item's conv to display in
    // line units. Silent-skip if branch DB unavailable (won't break archive).
    let damageByProduct = {};
    try {
      if (grn.branch_slug && isRegistered(grn.branch_slug)) {
        const branchDb = getTenantDb(grn.branch_slug);
        const rows = branchDb.prepare(`
          SELECT dmg.product_sync_id,
                 SUM(ABS(dmg.quantity)) AS damaged_base,
                 gin.qty_base
            FROM stock_movements dmg
            LEFT JOIN (
              SELECT product_sync_id, SUM(quantity) AS qty_base
                FROM stock_movements
               WHERE reference_type = 'hq_grn'
                 AND reference_sync_id = ?
                 AND deleted_at IS NULL
               GROUP BY product_sync_id
            ) gin ON gin.product_sync_id = dmg.product_sync_id
           WHERE dmg.reference_type = 'hq_grn_damage'
             AND dmg.reference_sync_id = ?
             AND dmg.deleted_at IS NULL
           GROUP BY dmg.product_sync_id, gin.qty_base
        `).all(syncId, syncId);
        for (const r of rows) damageByProduct[r.product_sync_id] = {
          damaged_base: parseFloat(r.damaged_base) || 0,
          in_base:      parseFloat(r.qty_base)     || 0,
        };
      }
    } catch (e) { /* branch DB open failed â€” non-fatal */ }
    let credit_notes = [];
    try {
      credit_notes = masterDb.prepare(`
        SELECT id, sync_id, credit_note_number, reason, amount, vat_amount, notes, date, reference,
               supplier_name, created_by_name, created_at
          FROM hq_supplier_credit_notes
         WHERE grn_sync_id = ? AND deleted_at IS NULL
         ORDER BY id ASC
      `).all(syncId);
      // v1.13.34 â€” attach line items so the AP Approvals detail modal
      // can show CN item breakdown (goods returned / crates / bottles).
      // 2026-08-31 â€” a FREE credit note attached at check time lives in the
      // tenant table, not master, so it moved the GRN's payable without ever
      // appearing in this list: the row would read "- CN 66,322" with nothing
      // beneath it to explain the figure. Both kinds are listed now, tagged so
      // the screen can say which is which.
      credit_notes = credit_notes.map(c => ({ ...c, is_free_credit: 0 }));
      // 2026-09-05 â€” HQ's book holds a COPY of every GRN credit note as well
      // as any genuinely separate one attached at check time. Listing the
      // table wholesale printed each ordinary credit twice. Only rows master
      // does not already have are free credits.
      const masterCnIds = new Set(credit_notes.map(c => c.sync_id));
      const masterCnNums = new Set(credit_notes.map(c => c.credit_note_number));
      try {
        const free = dbProxy.prepare(
          `SELECT id, sync_id, credit_note_number, reason, amount, notes, date,
                  checked_by_name, checked_at
             FROM supplier_credit_notes
            WHERE grn_sync_id = ? AND (deleted_at IS NULL OR deleted_at = '')
            ORDER BY id ASC`
        ).all(syncId)
         // sync_id matches for anything mirrored from 2026-09-05 on; the
         // number matches for rows the backfill re-pointed. Either is proof
         // it is the same credit note.
         .filter(c => !masterCnIds.has(c.sync_id) && !masterCnNums.has(c.credit_note_number))
         .map(c => ({
          ...c,
          is_free_credit: 1,
          items: [],
          created_by_name: c.checked_by_name || null,
          created_at: c.checked_at || c.date || null,
        }));
        credit_notes = [...credit_notes, ...free];
      } catch (_) { /* pre-migration branch â€” master's list still stands */ }

      if (credit_notes.length) {
        const itemStmt = masterDb.prepare(`
          SELECT product_sync_id, product_name, quantity, unit, unit_conv,
                 unit_value, discount, total_price
            FROM hq_supplier_credit_note_items
           WHERE credit_note_sync_id = ?
           ORDER BY id ASC
        `);
        for (const cn of credit_notes) {
          // A free credit note has no line items in master â€” it was raised on
          // the Credit Notes page, not minted from a GRN.
          if (cn.is_free_credit) continue;
          try { cn.items = itemStmt.all(cn.sync_id) || []; }
          catch { cn.items = []; }
        }
      }
    } catch { /* table may not exist on old DBs */ }
    res.json({ grn: { ...grn, grn_sync_id: grn.sync_id }, items, credit_notes, damage_by_product: damageByProduct });
  } catch (error) {
    console.error('[hq.grns.hq-detail]', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/receipt/:syncId', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.status(404).json({ error: 'master.db unavailable' });
    const syncId = req.params.syncId;
    const purchase = masterDb.prepare(`SELECT * FROM hq_purchases WHERE sync_id = ?`).get(syncId);
    if (!purchase) return res.status(404).json({ error: 'PO not found.' });
    const items = masterDb.prepare(
      `SELECT * FROM hq_purchase_items WHERE purchase_sync_id = ? ORDER BY id ASC`
    ).all(syncId);
    const extras = masterDb.prepare(
      `SELECT * FROM hq_purchase_receipt_extras WHERE purchase_sync_id = ? ORDER BY id ASC`
    ).all(syncId);
    // v1.13.35 â€” Read-only surface of the branch-authored CN drafts so
    // the HQ Generate GRN modal can show them alongside items. HQ can't
    // edit â€” CN authoring is branch-only now.
    let credit_notes = [];
    try {
      credit_notes = masterDb.prepare(`
        SELECT id, sync_id, reason, amount, vat_amount, notes,
               created_by_name, created_at
          FROM hq_receipt_credit_notes
         WHERE purchase_sync_id = ?
         ORDER BY id ASC
      `).all(syncId);
      if (credit_notes.length) {
        const itemStmt = masterDb.prepare(`
          SELECT product_sync_id, product_name, quantity, unit, unit_conv,
                 unit_value, discount, total_price
            FROM hq_receipt_credit_note_items
           WHERE credit_note_sync_id = ?
           ORDER BY id ASC
        `);
        for (const cn of credit_notes) {
          try { cn.items = itemStmt.all(cn.sync_id) || []; }
          catch { cn.items = []; }
        }
      }
    } catch (e) { /* drafts table may not exist on older builds */ }
    res.json({ purchase, items, extras, credit_notes });
  } catch (error) {
    console.error('[hq.grns.receipt]', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/grns/:slug/:syncId
// Full GRN doc (header + line items) for the HQ review modal. The branch
// slug is in the path so we know which tenant DB to open without scanning
// every branch.
router.get('/:slug/:syncId', hqAuth, (req, res) => {
  try {
    const { slug, syncId } = req.params;
    if (!isRegistered(slug)) return res.status(404).json({ error: `Branch "${slug}" not registered.` });
    const db = getTenantDb(slug);
    const grn = db.prepare(`
      SELECT g.*,
             TRIM(COALESCE(u.first_name,'') || ' ' || COALESCE(u.last_name,'')) AS created_by_name,
             s.name AS supplier_name
        FROM grn g
        LEFT JOIN users u     ON u.id = g.created_by
        LEFT JOIN suppliers s ON s.id = g.supplier_id
       WHERE g.sync_id = ? AND g.deleted_at IS NULL
    `).get(syncId);
    if (!grn) return res.status(404).json({ error: 'GRN not found.' });
    const items = db.prepare(`
      SELECT gi.*, p.name AS product_name, p.code AS product_code, p.unit AS product_base_unit
        FROM grn_items gi
        LEFT JOIN products p ON p.id = gi.product_id
       WHERE gi.grn_sync_id = ? AND gi.deleted_at IS NULL
       ORDER BY gi.id ASC
    `).all(syncId);
    // v1.9.14 â€” also return credit notes attached to this GRN so the
    // HQ See Details modal can show them. supplier_credit_notes was
    // linked via grn_sync_id in v1.9.13.
    let credit_notes = [];
    try {
      credit_notes = db.prepare(`
        SELECT id, credit_note_number, reason, amount, notes, date, reference
          FROM supplier_credit_notes
         WHERE grn_sync_id = ? AND deleted_at IS NULL
         ORDER BY id ASC
      `).all(syncId);
    } catch { /* table may not have the column yet on very old DBs */ }
    // v1.10.114 â€” damage-per-product from stock_movements (same tag used
    // by the /hq/:syncId endpoint). Branch DB is already open, so this is
    // a straight local query, no cross-DB hop.
    let damageByProduct = {};
    try {
      const rows = db.prepare(`
        SELECT product_sync_id, SUM(ABS(quantity)) AS damaged_base
          FROM stock_movements
         WHERE reference_type = 'hq_grn_damage'
           AND reference_sync_id = ?
           AND deleted_at IS NULL
         GROUP BY product_sync_id
      `).all(syncId);
      for (const r of rows) damageByProduct[r.product_sync_id] = parseFloat(r.damaged_base) || 0;
    } catch (e) { /* stock_movements columns may differ on old DBs */ }
    res.json({ grn: { ...grn, branch_slug: slug }, items, credit_notes, damage_by_product: damageByProduct });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/grns/:slug/:syncId/confirm
// HQ approves the branch GRN. Two side-effects, both in the BRANCH tenant DB:
//   (a) Post a stock_movement per GRN line at location='sales' (Kelete has
//       no store layer; product current_stock is incremented in the same
//       transaction so the sales floor shows the new stock immediately).
//   (b) Flip the parent PO line(s) at master.db from GRN_SUBMITTED â†’
//       CONFIRMED, stamping the HQ confirmer.
// Marking grn.hq_status='CONFIRMED' is the third step (in branch DB).
// All three are wrapped so a failure at any step rolls back cleanly.
router.post('/:slug/:syncId/confirm', hqAuth, async (req, res) => {
  try {
    const { slug, syncId } = req.params;
    const { notes } = req.body || {};
    if (!isRegistered(slug)) return res.status(404).json({ error: `Branch "${slug}" not registered.` });
    const db = getTenantDb(slug);

    const grn = db.prepare(`SELECT * FROM grn WHERE sync_id = ? AND deleted_at IS NULL`).get(syncId);
    if (!grn) return res.status(404).json({ error: 'GRN not found.' });
    if (grn.hq_status !== 'PENDING_HQ_CONFIRM') {
      return res.status(400).json({ error: `GRN hq_status is ${grn.hq_status} â€” only PENDING_HQ_CONFIRM GRNs can be confirmed.` });
    }

    const items = db.prepare(`SELECT * FROM grn_items WHERE grn_sync_id = ? AND deleted_at IS NULL`).all(syncId);
    if (items.length === 0) return res.status(400).json({ error: 'GRN has no line items.' });

    const confirmerName = req.user.firstName || req.user.email || 'HQ';
    // 2026-09-04 â€” this route takes the branch from the URL, so the confirmer
    // may be an HQ user OR a user of the branch itself. It used to write NULL
    // unconditionally, because an HQ id does not exist in the branch's users
    // table and created_by REFERENCES users(id) would fail. But the common
    // case is a depot confirming its own delivery, and that person DOES exist
    // here â€” so their name was being thrown away for a problem they did not
    // have. Resolve it: real id when the confirmer exists in this branch,
    // NULL when they don't. Either way the HQ-side identity is preserved on
    // the master row (confirmed_by + confirmed_by_name).
    const confirmedByLocal = (() => {
      try {
        return db.prepare('SELECT 1 FROM users WHERE id = ? LIMIT 1').get(req.user.id)
          ? req.user.id : null;
      } catch (_) { return null; }
    })();

    db.transaction(() => {
      // Per-line stock movements at sales floor + current_stock bump.
      // Same pattern as legacy GRN POST but always location='sales',
      // and created_by=NULL because HQ users don't exist in branch users.
      const movementCreatedAt = (grn.date || new Date().toISOString().slice(0,10)) + ' ' + new Date().toTimeString().slice(0,8);
      // Ownership for the movements below â€” see branchSyncIds().
      const __ids = branchSyncIds(db);
      for (const it of items) {
        const prod = db.prepare(`
          SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json, container_product_sync_id
            FROM products WHERE sync_id = ? AND deleted_at IS NULL
        `).get(it.product_sync_id);
        if (!prod) continue; // line points at a deleted product â€” skip rather than crash

        const baseQty = parseFloat(it.quantity) * conversionToBase(prod, it.unit || prod.unit);
        db.prepare(`
          UPDATE products SET current_stock = current_stock + ?,
                              updated_at    = datetime('now'),
                              synced        = 0
           WHERE sync_id = ?
        `).run(baseQty, prod.sync_id);

        db.prepare(`
          INSERT INTO stock_movements
            (product_id, product_sync_id, location, movement_type, quantity,
             reference_id, reference_type, reference_sync_id, notes,
             created_by, sync_id, tenant_id, branch_id, device_id,
             synced, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'))
        `).run(
          prod.id, prod.sync_id, 'sales', 'grn', baseQty,
          grn.id, 'grn', grn.sync_id,
          `HQ-confirmed GRN ${grn.grn_number}${notes ? ' â€” ' + notes : ''}`,
          confirmedByLocal,
          randomUUID(), __ids.tenantId, __ids.branchId, null,
          movementCreatedAt
        );

        // Container settlement (returnables) â€” same as legacy GRN POST.
        const recv = parseFloat(it.containers_received || 0);
        const ret  = parseFloat(it.containers_returned || 0);
        const delta = recv - ret;
        if (it.container_product_sync_id && Math.abs(delta) > 0.001) {
          const cprod = db.prepare(`SELECT id FROM products WHERE sync_id = ?`).get(it.container_product_sync_id);
          db.prepare(`
            INSERT INTO stock_movements
              (product_id, product_sync_id, location, movement_type, quantity,
               reference_id, reference_type, reference_sync_id, notes,
               created_by, sync_id, tenant_id, branch_id, device_id,
               synced, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'))
          `).run(
            cprod?.id || null, it.container_product_sync_id, 'sales', 'grn', delta,
            grn.id, 'grn', grn.sync_id,
            `Container settlement via ${grn.grn_number}`,
            confirmedByLocal,
            randomUUID(), __ids.tenantId, __ids.branchId, null,
            movementCreatedAt
          );
        }
      }

      // Mark the GRN as confirmed at the branch.
      db.prepare(`
        UPDATE grn
           SET hq_status            = 'CONFIRMED',
               hq_confirmed_by      = ?,
               hq_confirmed_by_name = ?,
               hq_confirmed_at      = datetime('now'),
               updated_at           = datetime('now'),
               synced               = 0
         WHERE sync_id = ?
      `).run(req.user.id || null, confirmerName, syncId);
    })();

    // v1.9.14 â€” write the HQ snapshot row so HQ reports + AP run on
    // master.db alone. Full GRN doc stays at the branch; HQ pulls via
    // the existing GET /api/hq/grns/:slug/:syncId when a user clicks
    // "See Details". Pull CN total from supplier_credit_notes by GRN
    // link so the snapshot's payable matches what HQ owes the supplier.
    if (masterDb) {
      try {
        const cnTotal = db.prepare(`
          SELECT COALESCE(SUM(amount), 0) AS t
            FROM supplier_credit_notes
           WHERE grn_sync_id = ? AND deleted_at IS NULL
        `).get(grn.sync_id)?.t || 0;
        const itemsSubtotal = parseFloat(grn.total_amount) || 0;
        const finalPayable  = Math.max(0, itemsSubtotal - (parseFloat(cnTotal) || 0));
        // Branch + supplier display names (denormalised so HQ pages don't
        // have to re-join).
        const branchName    = (listTenants().find(t => t.slug === slug)?.business_name) || slug;
        const supplierName  = grn.supplier_name || (db.prepare('SELECT name FROM suppliers WHERE id = ?').get(grn.supplier_id)?.name) || null;
        const poNumber      = grn.linked_purchase_number || null;
        masterDb.prepare(`
          INSERT OR REPLACE INTO hq_confirmed_grn_totals (
            grn_sync_id, grn_number, branch_slug, branch_name,
            supplier_id, supplier_sync_id, supplier_name,
            po_sync_id, po_number, date, items_count,
            items_subtotal, cn_total, final_payable,
            invoice_number, confirmed_by, confirmed_by_name, confirmed_at, notes
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?)
        `).run(
          grn.sync_id, grn.grn_number, slug, branchName,
          grn.supplier_id || null, grn.supplier_sync_id || null, supplierName,
          grn.linked_purchase_sync_id || null, poNumber, grn.date || null,
          parseInt(grn.total_items) || items.length,
          itemsSubtotal, cnTotal, finalPayable,
          grn.supplier_invoice_number || null,
          req.user.id || null, confirmerName, notes || null
        );
      } catch (err) {
        // Snapshot is best-effort: branch stock + master.db PO status are
        // already committed above. Drift can be fixed manually with a
        // re-run. Don't fail the confirm response over a snapshot hiccup.
        console.error('[hq.grns.confirm] snapshot insert failed:', err.message);
      }
    }

    // Flip the parent PO line(s) at master.db. Done outside the branch
    // transaction because masterDb is a separate connection.
    if (masterDb && grn.linked_purchase_sync_id) {
      try {
        masterDb.prepare(`
          UPDATE hq_purchase_items
             SET status              = 'CONFIRMED',
                 confirmed_by        = ?,
                 confirmed_by_name   = ?,
                 confirmed_at        = datetime('now'),
                 confirm_notes       = ?
           WHERE purchase_sync_id = ?
             AND status = 'GRN_SUBMITTED'
             AND linked_grn_sync_id = ?
        `).run(req.user.id || null, confirmerName, notes || null, grn.linked_purchase_sync_id, grn.sync_id);

        // Auto-promote header.
        const headerRow = masterDb.prepare(`SELECT id, purchase_id FROM hq_purchase_items WHERE linked_grn_sync_id = ? LIMIT 1`).get(grn.sync_id);
        if (headerRow?.purchase_id) {
          const cnt = masterDb.prepare(`
            SELECT SUM(CASE WHEN status IN ('AWAITING_GRN','GRN_SUBMITTED') THEN 1 ELSE 0 END) AS open,
                   SUM(CASE WHEN status = 'CONFIRMED' THEN 1 ELSE 0 END) AS confirmed
              FROM hq_purchase_items WHERE purchase_id = ?
          `).get(headerRow.purchase_id);
          if ((cnt.open || 0) === 0) {
            // 2026-08-28 â€” do NOT set updated_at here. hq_purchases is master-synced
            // and the touch trigger stamps updated_at + synced=0 itself; setting it
            // manually makes the trigger skip, so synced stays 1 and this status
            // change never reaches the branches. See masterDb.js CONTRACT block.
            masterDb.prepare(`UPDATE hq_purchases SET status = ? WHERE id = ?`)
              .run((cnt.confirmed || 0) > 0 ? 'COMPLETED' : 'CANCELLED', headerRow.purchase_id);
          }
        }
      } catch (err) {
        // Branch-side stock is already committed at this point. Log and
        // continue â€” HQ Purchases status drift is recoverable manually.
        console.error('[hq.grns.confirm] master.db update failed (branch stock already posted):', err.message);
      }
    }

    // â”€â”€ Phase 2 (Â§5.11): ZRA chain fires HERE for ZRA-pulled POs â”€â”€â”€â”€â”€
    // The linked HQ Purchase carries zra_reg_ty_cd='A' if it originated
    // from /api/zra/purchases/:id/approve â€” a VSDC-supplier pull. In
    // that case Â§5.11's savePurchase â†’ saveStockItems â†’ saveStockMaster
    // chain fires now, because stock has PHYSICALLY LANDED at the
    // branch (the transaction above just bumped current_stock). This
    // is the only point in Red Sea's 4-step flow where ZRA's stock
    // view can accurately reflect reality; firing at any earlier step
    // would report phantom stock.
    //
    // Runs in the destination branch's DB context (dbProxy.runWithDb)
    // so vsdcClient reads that branch's zra_config and writes to its
    // own audit log. HQ has no VSDC device of its own â€” the branch
    // device proxies the fiscal write, per project-kelete HQ VSDC
    // DEVICE decision (Pattern A).
    //
    // Non-fatal on failure: local stock is already committed above.
    // hq_purchases.zra_status = 'FAILED' captures the failure for
    // retry; zra_status = 'SIGNED' + zra_pchs_invc_no on success.
    let zraResult = { skipped: true, reason: 'not from ZRA pull' };
    if (masterDb && grn.linked_purchase_sync_id) {
      try {
        const hq = masterDb.prepare(
          'SELECT * FROM hq_purchases WHERE sync_id = ?'
        ).get(grn.linked_purchase_sync_id);
        if (hq?.zra_reg_ty_cd === 'A' && hq.zra_status !== 'SIGNED') {
          zraResult = await fireZraChainForConfirmedGrn(hq, grn, items, db, slug, req.user);
        } else if (hq?.zra_status === 'SIGNED') {
          zraResult = { skipped: true, reason: 'ZRA chain already fired for this PO' };
        }
      } catch (e) {
        console.error('[hq.grns.confirm] ZRA chain failed:', e.message);
        zraResult = { ok: false, error: e.message };
      }
    }

    res.json({
      ok: true,
      grn: db.prepare(`SELECT * FROM grn WHERE sync_id = ?`).get(syncId),
      zra: zraResult,
    });
  } catch (error) {
    console.error('[hq.grns.confirm] CRASH:', error.stack || error);
    res.status(500).json({ error: error.message });
  }
});

// â”€â”€ Phase 2 (Â§5.11) helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Fire savePurchase + saveStockItems + saveStockMaster for a just-
// confirmed HQ GRN whose linked HQ Purchase originated from a ZRA
// pull. Called from /:slug/:syncId/confirm above.
//
// hq             â€” hq_purchases row (with zra_reg_ty_cd='A')
// grn            â€” the branch GRN row that just got confirmed
// grnItems       â€” grn_items rows for this GRN
// toDb           â€” destination branch's tenant DB (for VSDC config)
// toSlug         â€” destination slug (fallback tenant id)
// user           â€” req.user (for audit log actor)
async function fireZraChainForConfirmedGrn(hq, grn, grnItems, toDb, toSlug, user) {
  const branchTenantId = toDb.prepare(
    'SELECT tenant_id FROM business_settings LIMIT 1'
  ).get()?.tenant_id || toSlug;

  // Look up the ZRA classification snapshot we cached at approve time.
  // Match by product_sync_id so branch's actually-received qty (from
  // grn_items) pairs with the correct ZRA line data.
  const hqItems = masterDb.prepare(
    `SELECT * FROM hq_purchase_items
       WHERE purchase_sync_id = ?
         AND (linked_grn_sync_id IS NULL OR linked_grn_sync_id = ?)`
  ).all(hq.sync_id, grn.sync_id);
  if (hqItems.length === 0) {
    return { skipped: true, reason: 'no matching hq_purchase_items for this GRN' };
  }

  // 2026-08-26 â€” the branch's own products row, as a fallback source for
  // the ZRA item code. hq_purchase_items.zra_* is only populated for
  // ZRA-pulled POs; a manual PO leaves it NULL, and products created
  // after the one-time ZM-code backfill have no zra_item_cd either â€” they
  // are registered under products.code. Without this the lines below sent
  // a NULL itemCd. See vsdcClient.itemCodeFor for the full write-up.
  const prodBySync = (() => {
    const ids = hqItems.map(h => h.product_sync_id).filter(Boolean);
    if (!ids.length) return new Map();
    const ph = ids.map(() => '?').join(',');
    const rows = toDb.prepare(
      `SELECT sync_id, code, zra_item_cd, zra_item_cls_cd, zra_pkg_unit_cd,
              zra_qty_unit_cd, zra_vat_cat_cd, zra_excise_ty_cd
         FROM products WHERE sync_id IN (${ph})`
    ).all(...ids);
    return new Map(rows.map(r => [r.sync_id, r]));
  })();

  // Assemble savePurchase itemList using RECEIVED qty from the GRN
  // (branch counted what physically arrived) not dispatched qty.
  const zraItems = [];
  const movementLines = [];
  for (const hi of hqItems) {
    const gi = grnItems.find(x => x.product_sync_id === hi.product_sync_id);
    const qty = gi ? (parseFloat(gi.quantity) || 0) : (parseFloat(hi.received_qty) || 0);
    if (qty <= 0) continue;
    const prod = prodBySync.get(hi.product_sync_id);
    const zraItemCd = vsdc.itemCodeFor(hi, prod);
    if (!zraItemCd) continue;   // nothing ZRA can key this line to
    zraItems.push({
      product_id:       null,
      product_code:     zraItemCd,
      product_name:     hi.product_name,
      quantity:         qty,
      cost_price:       parseFloat(hi.cost_price) || 0,
      zra_item_cd:      zraItemCd,
      // Same fallback for the rest of the classification: a manual PO
      // carries no snapshot, so read the branch's product row instead.
      zra_item_cls_cd:  hi.zra_item_cls_cd  || prod?.zra_item_cls_cd  || null,
      zra_pkg_unit_cd:  hi.zra_pkg_unit_cd  || prod?.zra_pkg_unit_cd  || null,
      zra_qty_unit_cd:  hi.zra_qty_unit_cd  || prod?.zra_qty_unit_cd  || null,
      zra_vat_cat_cd:   hi.zra_vat_cat_cd   || prod?.zra_vat_cat_cd   || 'A',
      zra_excise_ty_cd: hi.zra_excise_ty_cd || prod?.zra_excise_ty_cd || null,
    });
    movementLines.push({
      product_sync_id: hi.product_sync_id,
      quantity:        qty,
      unit:            gi?.unit || hi.unit || null,
    });
  }
  if (zraItems.length === 0) {
    return { skipped: true, reason: 'no positive-qty lines to send' };
  }

  // grn.id=null on the shim so vsdcClient's `UPDATE grn WHERE id=?`
  // no-ops â€” we don't want to overwrite the branch's just-confirmed
  // GRN row. All ZRA state persists on hq_purchases in master.db.
  const grnShim = {
    id:                    null,
    zra_pchs_invc_no:      null,
    zra_spplr_tpin:        hq.zra_spplr_tpin,
    zra_spplr_bhf_id:      hq.zra_spplr_bhf_id,
    zra_reg_ty_cd:         'A',
    supplier_name:         hq.supplier_name,
    supplier_invoice_no:   hq.invoice_number,
  };

  return await dbProxy.runWithDb(toDb, async () => {
    const purchaseRes = await vsdc.savePurchase(branchTenantId, grnShim, zraItems, {
      actor: String(user?.id || 'hq-confirm'),
    });
    if (purchaseRes.skipped) return { skipped: true, reason: purchaseRes.reason };
    if (!purchaseRes.ok) {
      masterDb.prepare(
        `UPDATE hq_purchases SET zra_status='FAILED' WHERE id=?`
      ).run(hq.id);
      return { ok: false, stage: 'savePurchase', error: purchaseRes.error, resultCd: purchaseRes.resultCd };
    }
    masterDb.prepare(
      `UPDATE hq_purchases SET zra_pchs_invc_no=?, zra_status='SIGNED' WHERE id=?`
    ).run(purchaseRes.pchsInvcNo || null, hq.id);

    // Stock chain â€” saveNonSaleStockChain computes per-line VAT and
    // fires both saveStockItems + saveStockMaster. sarTyCd='02' =
    // PURCHASE (stock IN) per Â§6.14. sarNo unique per hq_purchase
    // to avoid collisions with tenant-side sales sarNo sequences.
    const stockRes = await vsdc.saveNonSaleStockChain(
      branchTenantId,
      hq.id * 1000000 + (grn.id % 1000000),
      { remark: `HQ Purchase ${hq.purchase_number} confirmed at ${toSlug} (GRN ${grn.grn_number})` },
      movementLines,
      vsdc.SAR_TY_CD.PURCHASE
    );
    return { ok: true, pchsInvcNo: purchaseRes.pchsInvcNo, stockChain: stockRes };
  });
}

// POST /api/hq/grns/:slug/:syncId/reject
// HQ sends the GRN back to the branch for re-entry. Branch's GRN gets
// hq_status='REJECTED' (visible on their GRN list with the reason).
// Parent PO line(s) at master.db flip back from GRN_SUBMITTED â†’
// AWAITING_GRN so the branch can create a fresh GRN from the PO again.
// The rejected GRN itself is NOT deleted â€” it stays as an audit record.
//
// Body: { reason } â€” required, surfaced on the branch GRN list.
router.post('/:slug/:syncId/reject', hqAuth, (req, res) => {
  try {
    const { slug, syncId } = req.params;
    const reason = ((req.body && req.body.reason) || '').toString().trim();
    if (!reason) return res.status(400).json({ error: 'A rejection reason is required.' });
    if (!isRegistered(slug)) return res.status(404).json({ error: `Branch "${slug}" not registered.` });
    const db = getTenantDb(slug);

    const grn = db.prepare(`SELECT * FROM grn WHERE sync_id = ? AND deleted_at IS NULL`).get(syncId);
    if (!grn) return res.status(404).json({ error: 'GRN not found.' });
    if (grn.hq_status !== 'PENDING_HQ_CONFIRM') {
      return res.status(400).json({ error: `GRN hq_status is ${grn.hq_status} â€” only PENDING_HQ_CONFIRM GRNs can be rejected.` });
    }

    db.prepare(`
      UPDATE grn
         SET hq_status        = 'REJECTED',
             hq_reject_reason = ?,
             updated_at       = datetime('now'),
             synced           = 0
       WHERE sync_id = ?
    `).run(reason, syncId);

    if (masterDb && grn.linked_purchase_sync_id) {
      try {
        masterDb.prepare(`
          UPDATE hq_purchase_items
             SET status              = 'AWAITING_GRN',
                 linked_grn_sync_id  = NULL,
                 received_by         = NULL,
                 received_by_name    = NULL,
                 received_at         = NULL,
                 confirm_notes       = ?
           WHERE purchase_sync_id = ?
             AND status = 'GRN_SUBMITTED'
             AND linked_grn_sync_id = ?
        `).run(`HQ rejected GRN ${grn.grn_number}: ${reason}`, grn.linked_purchase_sync_id, grn.sync_id);
      } catch (err) {
        console.error('[hq.grns.reject] master.db reset failed:', err.message);
      }
    }

    res.json({ ok: true });
  } catch (error) {
    console.error('[hq.grns.reject] CRASH:', error.stack || error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/grns/archive
// v1.9.14 â€” HQ-wide list of CONFIRMED GRNs, served entirely from the
// master.db snapshot table. Supports filters via query string:
//   ?branch=slug      one branch only (default: all)
//   ?supplier=syncId  one supplier only (default: all)
//   ?from=YYYY-MM-DD  inclusive lower bound on date
//   ?to=YYYY-MM-DD    inclusive upper bound on date
//   ?limit=N          row cap (default 500, max 2000)
// Returns rows + roll-up totals so the page header can show
// "X GRNs / $Y payable" without a second query.
// 2026-09-26 â€” Product Received Breakdown, the HQ twin of the branch report
// at grn.js:463. Two steps: a row per product across a date range, then every
// GRN behind one product.
//
// Reads hq_grns + hq_grn_items, so it reports what depots actually CONFIRMED
// receiving, which is the question this page exists to answer. It does not
// read hq_purchase_items: a purchase line is what HQ dispatched, and the two
// differ by exactly the variance this report would otherwise hide.
//
// LIMITATION, stated rather than hidden: /archive above UNIONs hq_grns with
// legacy hq_confirmed_grn_totals, and only the first has item rows in master.
// A legacy GRN therefore contributes nothing here. It cannot -- its lines
// were never copied to master -- so the alternative is not a better number,
// it is the same gap without the note.
const GRN_ITEM_JOIN = `
  FROM hq_grn_items i
  JOIN hq_grns g ON g.sync_id = i.grn_sync_id
 WHERE g.deleted_at IS NULL`;

// GET /api/hq/grns/product-report?from&to&q&branch
router.get('/product-report', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.json({ rows: [] });
    const from   = String(req.query.from   || '').slice(0, 10);
    const to     = String(req.query.to     || '').slice(0, 10);
    const q      = String(req.query.q      || '').trim();
    const branch = String(req.query.branch || '').trim();

    const conds = [];
    const params = [];
    if (from)   { conds.push('substr(g.date, 1, 10) >= ?'); params.push(from); }
    if (to)     { conds.push('substr(g.date, 1, 10) <= ?'); params.push(to);   }
    if (q)      { conds.push('i.product_name LIKE ?');      params.push(`%${q}%`); }
    if (branch && branch !== 'all') { conds.push('g.branch_slug = ?'); params.push(branch); }
    const where = conds.length ? ` AND ${conds.join(' AND ')}` : '';

    const rows = masterDb.prepare(`
      SELECT i.product_sync_id,
             i.product_name,
             i.unit,
             SUM(i.quantity)                         AS qty_received,
             COUNT(DISTINCT i.grn_sync_id)           AS grn_count,
             SUM(i.total_price)                      AS total_cost,
             SUM(COALESCE(i.discount_amount, 0))     AS total_discount,
             MIN(substr(g.date, 1, 10))              AS first_received,
             MAX(substr(g.date, 1, 10))              AS last_received
      ${GRN_ITEM_JOIN}${where}
      GROUP BY i.product_sync_id, i.product_name, i.unit
      ORDER BY i.product_name
    `).all(...params);
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/hq/grns/product-breakdown?product_sync_id&from&to&branch
router.get('/product-breakdown', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.json({ rows: [] });
    const psid = String(req.query.product_sync_id || '').trim();
    if (!psid) return res.status(400).json({ error: 'product_sync_id is required' });
    const from   = String(req.query.from   || '').slice(0, 10);
    const to     = String(req.query.to     || '').slice(0, 10);
    const branch = String(req.query.branch || '').trim();

    const conds = ['i.product_sync_id = ?'];
    const params = [psid];
    if (from)   { conds.push('substr(g.date, 1, 10) >= ?'); params.push(from); }
    if (to)     { conds.push('substr(g.date, 1, 10) <= ?'); params.push(to);   }
    if (branch && branch !== 'all') { conds.push('g.branch_slug = ?'); params.push(branch); }

    const rows = masterDb.prepare(`
      SELECT g.grn_number,
             g.sync_id                 AS grn_sync_id,
             substr(g.date, 1, 10)     AS date,
             g.supplier_name,
             -- The invoice the DEPOT stamped at Confirm Received. The PO's own
             -- invoice_number is typed at HQ and is NULL on most rows; reading
             -- it is what makes a GRN show "Invoice â€”" when it plainly has one.
             g.supplier_invoice_number,
             g.branch_name,
             g.branch_slug,
             i.unit,
             i.quantity,
             i.unit_price,
             COALESCE(i.discount_amount, 0) AS discount_amount,
             i.total_price
      ${GRN_ITEM_JOIN} AND ${conds.join(' AND ')}
      ORDER BY g.date ASC, g.id ASC
    `).all(...params);
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/archive', hqAuth, (req, res) => {
  try {
    if (!masterDb) return res.json({ grns: [], totals: { count: 0, subtotal: 0, cn: 0, payable: 0 } });
    const { branch, supplier, from, to } = req.query || {};
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);

    // v1.10.3 â€” UNION legacy + new-flow GRNs. Legacy live in
    // hq_confirmed_grn_totals (branch-generated, HQ-confirmed); new-flow
    // live in hq_grns (HQ-generated end-to-end). Both feed the same page.
    // 2026-09-04 â€” the supplier filter returned nothing for every supplier.
    // Both arms keyed on supplier_sync_id, and the GRN generator writes that
    // column as a literal NULL (see the hq_confirmed_grn_totals insert in
    // this file) - so the legacy arm matched no row, and the new arm's
    // name lookup found none either and fell through to `1 = 0`.
    //
    // supplier_id and supplier_name ARE populated on every row, so resolve
    // whatever the dropdown sent - it sends `sync_id || id` - back to a real
    // supplier and match on those. sync_id is still accepted for genuinely
    // legacy rows that carry one.
    let supRow = null;
    if (supplier && supplier !== 'all') {
      try {
        const hqDb = require('../config/database').defaultDb;
        supRow = hqDb.prepare(
          'SELECT id, sync_id, name FROM suppliers WHERE sync_id = ? OR CAST(id AS TEXT) = ? LIMIT 1'
        ).get(String(supplier), String(supplier)) || null;
      } catch (_) { supRow = null; }
    }
    // Matches a row by any identifier we actually hold for it. Written once
    // and used by both arms so they can never drift apart again.
    const supplierClause = (col_sync) => {
      const parts = [];
      const params = [];
      if (col_sync) { parts.push('supplier_sync_id = ?'); params.push(String(supplier)); }
      if (supRow) {
        if (supRow.id != null) { parts.push('supplier_id = ?');   params.push(supRow.id); }
        if (supRow.name)       { parts.push('supplier_name = ?'); params.push(supRow.name); }
      } else {
        // Unknown identifier: fall back to treating it as a name, which is
        // what an older client or a hand-built URL is most likely sending.
        parts.push('supplier_name = ?'); params.push(String(supplier));
      }
      return { sql: '(' + parts.join(' OR ') + ')', params };
    };

    const legacyWhere = ['1=1'];
    const legacyParams = [];
    if (branch && branch !== 'all')     { legacyWhere.push('branch_slug = ?');      legacyParams.push(branch); }
    if (supplier && supplier !== 'all') {
      const c = supplierClause(true);
      legacyWhere.push(c.sql); legacyParams.push(...c.params);
    }
    if (from) { legacyWhere.push('date >= ?'); legacyParams.push(from); }
    if (to)   { legacyWhere.push('date <= ?'); legacyParams.push(to); }
    const legacyRows = masterDb.prepare(`
      SELECT
        grn_sync_id, grn_number, branch_slug, branch_name,
        supplier_id, supplier_sync_id, supplier_name,
        po_sync_id, po_number, date, items_count,
        items_subtotal, cn_total, final_payable,
        invoice_number, NULL AS invoice_attachment,
        confirmed_by, confirmed_by_name, confirmed_at, notes,
        voided_at, voided_by_name, void_reason,
        'legacy' AS source
      FROM hq_confirmed_grn_totals
      WHERE ${legacyWhere.join(' AND ')}
      ORDER BY confirmed_at DESC
      LIMIT ?
    `).all(...legacyParams, limit);

    const newWhere = ['deleted_at IS NULL'];
    const newParams = [];
    if (branch && branch !== 'all')     { newWhere.push('branch_slug = ?');  newParams.push(branch); }
    // hq_grns has no supplier_sync_id column at all, so this arm matches on
    // supplier_id / supplier_name only.
    if (supplier && supplier !== 'all') {
      const c = supplierClause(false);
      newWhere.push(c.sql); newParams.push(...c.params);
    }
    if (from) { newWhere.push('date >= ?'); newParams.push(from); }
    if (to)   { newWhere.push('date <= ?'); newParams.push(to); }
    const newRows = masterDb.prepare(`
      SELECT
        g.sync_id AS grn_sync_id, g.grn_number, g.branch_slug, g.branch_name,
        g.supplier_id, NULL AS supplier_sync_id, g.supplier_name,
        g.po_sync_id, g.po_number, g.date,
        (SELECT COUNT(*) FROM hq_grn_items WHERE grn_sync_id = g.sync_id) AS items_count,
        g.items_subtotal, g.cn_total, g.final_payable,
        g.supplier_invoice_number AS invoice_number, g.invoice_attachment,
        g.generated_by_hq AS confirmed_by,
        g.generated_by_hq_name AS confirmed_by_name,
        g.generated_at AS confirmed_at,
        g.notes,
        g.voided_at, g.voided_by_name, g.void_reason,
        'hq' AS source
      FROM hq_grns g
      WHERE ${newWhere.join(' AND ')}
      ORDER BY g.generated_at DESC
      LIMIT ?
    `).all(...newParams, limit);

    // Merge, dedupe by grn_sync_id (new-flow wins), sort by confirmed_at DESC.
    const bySyncId = new Map();
    for (const r of legacyRows) bySyncId.set(r.grn_sync_id, r);
    for (const r of newRows)    bySyncId.set(r.grn_sync_id, r);
    const grnsRaw = Array.from(bySyncId.values())
      .sort((a, b) => String(b.confirmed_at || '').localeCompare(String(a.confirmed_at || '')))
      .slice(0, limit);

    // 2026-08-30 â€” payment state per GRN, so the Archive can say Not Paid /
    // Partially Paid / Paid. It showed nothing at all before: the state lives
    // on hq_confirmed_grn_totals.ap_status, which this query never read, and
    // the amounts live in the tenant ap_payments table, which master.db cannot
    // join to. Summed per row instead, bounded by the same limit.
    // dbProxy, not db â€” this file imports the database as dbProxy (line 62).
    const paidFor = makePaidStmt(dbProxy);  // allocations - see services/apPaid.js
    const grns = grnsRaw.map(g => {
      let paid = 0;
      try { paid = paidFor(g.grn_sync_id); } catch (_) {}
      const payable   = parseFloat(g.final_payable || 0) || 0;
      const remaining = Math.max(0, payable - paid);
      const payment_status = paid <= 0            ? 'NOT_PAID'
                           : (paid + 0.01 >= payable && payable > 0) ? 'PAID'
                           : 'PARTIAL';
      return { ...g, paid_amount: paid, remaining_amount: remaining, payment_status };
    });

    // 2026-09-17 â€” a voided GRN is listed (marked) but counts for nothing.
    const totals = grns.filter(g => !g.voided_at).reduce((acc, g) => {
      acc.count    += 1;
      acc.subtotal += parseFloat(g.items_subtotal) || 0;
      acc.cn       += parseFloat(g.cn_total)       || 0;
      acc.payable  += parseFloat(g.final_payable)  || 0;
      return acc;
    }, { count: 0, subtotal: 0, cn: 0, payable: 0 });
    res.json({ grns, totals });
  } catch (error) {
    console.error('[hq.grns.archive] failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// â”€â”€ v1.10.0 â€” HQ generates the GRN from a branch's confirmed receipt â”€â”€â”€â”€â”€â”€â”€â”€
// (GET /awaiting-generation and /receipt/:syncId are declared near the top
// of this file so they win over the /:slug/:syncId wildcard.)

// POST /api/hq/grns/generate
// Body: {
//   purchase_sync_id,
//   date,
//   notes?,
//   items: [{ product_sync_id, product_name, unit, quantity, unit_price,
//             expiry_date?, is_extra, po_expected_qty? }],
//   credit_notes: [{ reason, amount, notes? }]   // optional in v1.10.0
// }
// Side-effects:
//   1. Inserts hq_grns + hq_grn_items at master.db
//   2. Posts +qty stock_movements + current_stock at the branch tenant DB
//      (location='sales' â€” Kelete's no-store model)
//   3. Updates linked hq_purchase_items.status = 'CONFIRMED', stamps audit
//   4. Persists CNs at hq_supplier_credit_notes if provided
router.post('/generate', hqAuth, async (req, res) => {
  try {
    if (!masterDb) return res.status(500).json({ error: 'master.db unavailable' });
    const {
      purchase_sync_id,
      date,
      notes,
      items,
    } = req.body || {};
    if (!purchase_sync_id) return res.status(400).json({ error: 'purchase_sync_id required' });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'At least one item is required.' });
    }

    // v1.13.35 â€” CN authoring moved to branch. HQ Generate GRN no longer
    // accepts credit_notes in the payload; instead we materialise them
    // from the branch draft table. Legacy payload-supplied CNs are still
    // honoured if this route is called by an older client.
    let credit_notes = Array.isArray(req.body?.credit_notes) ? req.body.credit_notes : null;
    if (!credit_notes) {
      credit_notes = [];
      try {
        const cnHdrs = masterDb.prepare(`
          SELECT sync_id, reason, amount, vat_amount, notes
            FROM hq_receipt_credit_notes
           WHERE purchase_sync_id = ?
           ORDER BY id ASC
        `).all(purchase_sync_id);
        const cnItemStmt = masterDb.prepare(`
          SELECT product_sync_id, product_name, quantity, unit, unit_conv, unit_value, discount
            FROM hq_receipt_credit_note_items
           WHERE credit_note_sync_id = ?
           ORDER BY id ASC
        `);
        for (const hdr of cnHdrs) {
          const items = cnItemStmt.all(hdr.sync_id) || [];
          credit_notes.push({
            reason: hdr.reason,
            amount: hdr.amount,
            vat_amount: hdr.vat_amount,
            notes:  hdr.notes,
            items,
          });
        }
      } catch { /* draft tables missing on old DB â€” treat as no CNs */ }
    }

    const purchase = masterDb.prepare(`SELECT * FROM hq_purchases WHERE sync_id = ?`).get(purchase_sync_id);
    if (!purchase) return res.status(404).json({ error: 'PO not found.' });
    if (!purchase.confirmed_at_branch) {
      return res.status(400).json({ error: 'Branch has not confirmed receipt for this PO yet.' });
    }
    if (!purchase.supplier_invoice_number) {
      return res.status(400).json({ error: 'Branch did not record a supplier invoice number.' });
    }

    const branchSlug = purchase.confirmed_branch_slug || '';
    if (!branchSlug || !isRegistered(branchSlug)) {
      return res.status(400).json({ error: 'Branch tenant not registered or missing.' });
    }
    const branchName = (listTenants().find(t => t.slug === branchSlug)?.business_name) || branchSlug;

    const grnSyncId = randomUUID();
    const grnNumber = `GRN-${new Date().getFullYear()}-${String(Date.now()).slice(-8)}`;
    const grnDate = date || new Date().toISOString().slice(0, 10);
    const validItems = items.filter(i => parseFloat(i.quantity) > 0);
    const itemsSubtotal = validItems.reduce((s, i) =>
      s + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0), 0);
    // v1.10.67 â€” cnTotal recomputed server-side per CN. Stock-affecting
    // reasons ignore c.amount and use Î£ qty Ã— unit_value from items[]
    // instead; money-only reasons take c.amount. Prevents a malformed
    // client payload from booking a mismatched final_payable.
    const cnTotal = Array.isArray(credit_notes)
      ? credit_notes.reduce((s, c) => {
          const reason = String(c?.reason || 'Other');
          const stockR = reason === 'Crate Return' || reason === 'Bottle Return' || reason === 'Goods Return';
          if (stockR) {
            const items = Array.isArray(c.items) ? c.items : [];
            // 2026-08-30 â€” net of each line's discount, plus the note's VAT.
            return s + items.reduce((a, i) =>
              a + ((parseFloat(i.quantity) || 0) * (parseFloat(i.unit_value) || 0))
                - (parseFloat(i.discount) || 0), 0)
              + (Math.abs(parseFloat(c.vat_amount || 0)) || 0);
          }
          return s + (Math.abs(parseFloat(c.amount || 0)) || 0);
        }, 0)
      : 0;
    const finalPayable = Math.max(0, itemsSubtotal - cnTotal);

    const generatorId   = req.user?.id || null;
    const generatorName = req.user?.firstName || req.user?.email || 'HQ';

    // v1.10.67 â€” filled inside the master tx below with per-CN metadata
    // for stock-affecting reasons; walked over outside the tx to post
    // negative stock_movements on the branch tenant DB.
    const returnCnBundle = [];

    // 2026-09-05 â€” exactly what master booked for each credit note, so the
    // HQ mirror below copies it instead of working the figure out again.
    //
    // It used to recompute, with a different formula: goods value only, no
    // VAT and no line discount. So one Goods Return existed as two different
    // amounts - K5,684.50 in master and K5,188.30 in HQ's book - and the GRN
    // detail screen, which lists both tables, showed them as two separate
    // credit notes. Same number, same amount, one credit note.
    const cnMirror = [];

    masterDb.transaction(() => {
      // 1. Insert hq_grns + hq_grn_items
      const info = masterDb.prepare(`
        INSERT INTO hq_grns
          (grn_number, sync_id, date, branch_slug, branch_name,
           supplier_id, supplier_name, po_sync_id, po_number,
           supplier_invoice_number, invoice_attachment,
           items_subtotal, cn_total, final_payable, notes,
           confirmed_by_branch, confirmed_by_branch_name, confirmed_at_branch,
           generated_by_hq, generated_by_hq_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        grnNumber, grnSyncId, grnDate, branchSlug, branchName,
        purchase.supplier_id || null, purchase.supplier_name || null,
        purchase_sync_id, purchase.purchase_number,
        purchase.supplier_invoice_number, purchase.invoice_attachment || null,
        itemsSubtotal, cnTotal, finalPayable, notes || null,
        purchase.confirmed_by_branch, purchase.confirmed_by_branch_name, purchase.confirmed_at_branch,
        generatorId, generatorName
      );
      const grnId = info.lastInsertRowid;

      const insItem = masterDb.prepare(`
        INSERT INTO hq_grn_items
          (sync_id, grn_id, grn_sync_id, product_sync_id, product_name, unit,
           quantity, unit_price, total_price, base_price, vat_amount, discount_amount,
           expiry_date, is_extra, po_expected_qty)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const it of validItems) {
        const qty   = parseFloat(it.quantity) || 0;
        const price = parseFloat(it.unit_price) || 0;
        insItem.run(
          randomUUID(), grnId, grnSyncId,
          it.product_sync_id || null,
          it.product_name || '',
          it.unit || null,
          qty, price, qty * price,
          parseFloat(it.base_price) || 0,
          parseFloat(it.vat_amount) || 0,
          parseFloat(it.discount_amount) || 0,
          it.expiry_date || null,
          it.is_extra ? 1 : 0,
          it.po_expected_qty != null ? parseFloat(it.po_expected_qty) : null
        );
      }

      // 2. Update PO lines â†’ CONFIRMED, copy the GRN link onto them
      masterDb.prepare(`
        UPDATE hq_purchase_items
           SET status              = 'CONFIRMED',
               linked_grn_sync_id  = ?,
               linked_grn_number   = ?,
               confirmed_by        = ?,
               confirmed_by_name   = ?,
               confirmed_at        = datetime('now')
         WHERE purchase_sync_id = ?
           AND status = 'RECEIPT_REPORTED'
      `).run(grnSyncId, grnNumber, generatorId, generatorName, purchase_sync_id);

      // 2026-08-29 â€” tell the header it is finished. Without this the lines
      // went CONFIRMED and the purchase stayed OPEN for ever: every Kelete
      // purchase on the live VPS was OPEN, none COMPLETED. Looked up by
      // sync_id, not the integer id, because those do not survive a copy.
      try {
        const hdr = masterDb.prepare('SELECT id FROM hq_purchases WHERE sync_id = ?').get(purchase_sync_id);
        if (hdr?.id) require('./hqPurchases').maybeCompleteHeader(hdr.id);
      } catch (e) {
        console.error('[hqGrns] header completion failed:', e.message);
      }

      // 3. CNs (if any)
      // v1.10.67 â€” Stock-affecting reasons (Crate Return, Bottle Return,
      // Goods Return) now carry an items[] array; each item row goes into
      // hq_supplier_credit_note_items and the branch tenant DB gets a
      // negative stock_movement (posted outside the master tx below, same
      // pattern as the main GRN item post). Money-only reasons (Discount,
      // Damaged, Short, Other) skip item persistence and just carry
      // cn.amount. Mirrors routes/grn.js:259-320 on the branch side.
      // returnCnBundle (declared above the tx) collects per-CN metadata
      // that the branch stock post walks over further down, outside the
      // master tx.
      if (Array.isArray(credit_notes)) {
        const insCn = masterDb.prepare(`
          INSERT INTO hq_supplier_credit_notes
            (credit_note_number, sync_id, date, supplier_id, supplier_sync_id, supplier_name,
             reason, reference, amount, vat_amount, notes, grn_sync_id, branch_slug,
             created_by, created_by_name)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        const insCnItem = masterDb.prepare(`
          INSERT INTO hq_supplier_credit_note_items
            (sync_id, credit_note_id, credit_note_sync_id, product_sync_id, product_name,
             quantity, unit, unit_conv, unit_value, discount, total_price)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `);
        for (const cn of credit_notes) {
          const reason = String(cn?.reason || 'Other');
          const reasonHasStock = reason === 'Crate Return' || reason === 'Bottle Return' || reason === 'Goods Return';
          const validCnItems = reasonHasStock && Array.isArray(cn.items)
            ? cn.items.filter(i => i.product_sync_id && parseFloat(i.quantity) > 0)
            : [];
          // Server-authoritative amount: for stock-affecting CNs we recompute
          // from the items so the client can't send a mismatched total.
          const cnVat = Math.abs(parseFloat(cn?.vat_amount || 0)) || 0;
          const amt = reasonHasStock
            ? validCnItems.reduce((s, i) =>
                s + (parseFloat(i.quantity) * parseFloat(i.unit_value || 0))
                  - (parseFloat(i.discount) || 0), 0) + cnVat
            : Math.abs(parseFloat(cn?.amount || 0)) || 0;
          if (amt < 0.001) continue;
          if (reasonHasStock && validCnItems.length === 0) continue;
          const cnNumber = `SCN-${new Date().getFullYear()}-${randomUUID().slice(0, 8).toUpperCase()}`;
          const cnSyncId = randomUUID();
          const cnInfo = insCn.run(
            cnNumber, cnSyncId, grnDate,
            purchase.supplier_id || null, null, purchase.supplier_name || null,
            reason,
            grnNumber, amt, cnVat, cn.notes || null,
            grnSyncId, branchSlug,
            generatorId, generatorName
          );
          const cnId = cnInfo.lastInsertRowid;
          // The mirror gets master's number, id, amount and VAT verbatim.
          // Sharing the sync_id is what lets every screen tell that the two
          // rows are one credit note.
          cnMirror.push({
            cnNumber, cnSyncId, reason, amt, cnVat,
            notes: cn.notes || null,
            items: reasonHasStock ? validCnItems : [],
          });
          if (reasonHasStock) {
            for (const i of validCnItems) {
              const qty = parseFloat(i.quantity) || 0;
              const unitVal = parseFloat(i.unit_value || 0) || 0;
              // 2026-08-30 â€” net of the line's discount, matching the amount
              // booked on the header above. unit_value stays the pre-discount
              // price so returned stock is valued as the purchase valued it.
              const lineDisc = parseFloat(i.discount) || 0;
              const linePrice = (qty * unitVal) - lineDisc;
              insCnItem.run(
                randomUUID(), cnId, cnSyncId,
                i.product_sync_id, i.product_name || '',
                qty, i.unit || null,
                parseFloat(i.unit_conv) > 0 ? parseFloat(i.unit_conv) : 1,
                unitVal, lineDisc, linePrice
              );
            }
            returnCnBundle.push({
              cnNumber,
              cnSyncId,
              reason,
              items: validCnItems.map(i => ({
                product_sync_id: i.product_sync_id,
                product_name: i.product_name,
                quantity: parseFloat(i.quantity) || 0,
                unit: i.unit || null,
              })),
            });
          }
        }
      }
    })();

    // v1.13.32 â€” mirror the new-flow GRN into hq_confirmed_grn_totals so
    // the AP Approvals page (which reads that table) picks it up. Legacy
    // /confirm already writes here; /generate previously didn't, which
    // meant every HQ-generated GRN was invisible to the approval chain.
    // ap_status defaults to 'PENDING' via the column default (v1.13.30).
    let supplierSyncIdForGrn = null;
    try {
      supplierSyncIdForGrn = require('../config/database').defaultDb
        .prepare('SELECT sync_id FROM suppliers WHERE id = ? LIMIT 1')
        .get(purchase.supplier_id)?.sync_id || null;
    } catch (_) { /* leave null â€” the filter no longer depends on it */ }

    try {
      const genActorName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || req.user?.email || 'system';
      masterDb.prepare(`
        INSERT OR REPLACE INTO hq_confirmed_grn_totals (
          grn_sync_id, grn_number, branch_slug, branch_name,
          supplier_id, supplier_sync_id, supplier_name,
          po_sync_id, po_number, date, items_count,
          items_subtotal, cn_total, final_payable,
          invoice_number, confirmed_by, confirmed_by_name, confirmed_at, notes,
          ap_status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),?,'UNCONFIRMED')
      `).run(
        grnSyncId, grnNumber, branchSlug, branchName,
        // 2026-09-04 â€” carry the supplier's sync_id instead of a hard NULL.
        // Every HQ-generated GRN wrote NULL here, which broke the Archive's
        // supplier filter outright; new rows now carry it, and the filter no
        // longer depends on them doing so.
        purchase.supplier_id || null, supplierSyncIdForGrn, purchase.supplier_name || null,
        purchase_sync_id, purchase.purchase_number, grnDate,
        validItems.length,
        itemsSubtotal, cnTotal, finalPayable,
        purchase.supplier_invoice_number || null,
        req.user?.id || null, genActorName, notes || null
      );
      // 2026-09-06 â€” UNCONFIRMED above, not the table's PENDING default. A
      // delivery is provisional from the moment the GRN exists: stock is live
      // and selling has started, but the truck is still being offloaded and
      // the credits it will produce are not known yet. Accounts must not see
      // a payable that is still moving.
    } catch (err) {
      console.error('[hq.grns.generate] hq_confirmed_grn_totals write failed:', err.message);
    }

    // v1.10.75 â€” HQ TENANT DB MIRROR. Every GRN + CN also lives in hq.db
    // (grn, grn_items, supplier_credit_notes, supplier_credit_note_items)
    // so HQ Suppliers page and Account Payables page share ONE source
    // of truth. Master tables (hq_grns / hq_grn_items / hq_supplier_*)
    // remain as an audit trail but no code path reads them for AP anymore.
    // Wrapped in try/catch â€” failure logs but doesn't roll back the
    // master GRN; a hq.db backfill script can repair later.
    try {
      // v1.10.76 â€” HQ uses kelete.db (defaultDb), not tenants/hq.db.
      // See routes/hqSuppliers.js:22-38 for the rationale.
      const hqDb = require('../config/database').defaultDb;
      const HQ_TENANT_ID = 'local-only';
      if (hqDb) {
        // Resolve supplier_id in hq.db (v1.10.75 migration preserved IDs
        // where possible, but fall back to name lookup for cross-tenant safety).
        let hqSupplierId = null;
        let hqSupplierSyncId = null;
        if (purchase.supplier_name) {
          const supRow = hqDb.prepare(
            `SELECT id, sync_id FROM suppliers WHERE LOWER(name) = LOWER(?) LIMIT 1`
          ).get(purchase.supplier_name);
          if (supRow) { hqSupplierId = supRow.id; hqSupplierSyncId = supRow.sync_id; }
        }
        // 1. grn row â€” total_amount = final_payable (AP-owed after CNs).
        // v1.10.79 â€” cost_currency (K default) propagates from the PO so
        // the Account Payables page can render the outstanding balance in
        // the right currency instead of the tenant's primary symbol.
        const grnCcy = String(purchase.cost_currency || 'K').toUpperCase();
        hqDb.prepare(`
          INSERT INTO grn (grn_number, date, supplier_id, supplier_sync_id, supplier_name,
                            total_items, total_amount, notes, invoice_attachment, supplier_invoice_number,
                            created_by, status, linked_purchase_sync_id, linked_purchase_number,
                            hq_status, sync_id, tenant_id, branch_id, device_id,
                            cost_currency,
                            synced, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
        `).run(
          grnNumber, grnDate,
          hqSupplierId, hqSupplierSyncId, purchase.supplier_name || null,
          validItems.length, finalPayable, notes || null,
          purchase.invoice_attachment || null, purchase.supplier_invoice_number,
          generatorId, 'Completed',
          purchase_sync_id, purchase.purchase_number,
          'CONFIRMED', grnSyncId, HQ_TENANT_ID, null, null,
          grnCcy
        );
        // 2. grn_items
        const insHqItem = hqDb.prepare(`
          INSERT INTO grn_items (grn_id, grn_sync_id, product_id, product_sync_id,
                                  quantity, unit, unit_price, total_price, expiry_date,
                                  sync_id, tenant_id, branch_id, device_id,
                                  synced, created_at, updated_at)
          VALUES ((SELECT id FROM grn WHERE sync_id = ?),?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
        `);
        const findHqProduct = hqDb.prepare(`SELECT id FROM products WHERE sync_id = ? LIMIT 1`);
        for (const it of validItems) {
          const q = parseFloat(it.quantity) || 0;
          const p = parseFloat(it.unit_price) || 0;
          const prod = it.product_sync_id ? findHqProduct.get(it.product_sync_id) : null;
          insHqItem.run(
            grnSyncId, grnSyncId,
            prod?.id || null, it.product_sync_id || null,
            q, it.unit || null, p, q * p, it.expiry_date || null,
            randomUUID(), HQ_TENANT_ID, null, null
          );
        }
        // 3. supplier_credit_notes + items (for both money-only + stock-affecting).
        if (Array.isArray(credit_notes) && credit_notes.length > 0) {
          // Tenant supplier_credit_notes has no supplier_name column
          // (name comes from JOIN with suppliers). Drop it from the INSERT.
          const insHqCn = hqDb.prepare(`
            INSERT INTO supplier_credit_notes (credit_note_number, date, supplier_id, supplier_sync_id,
                                                reason, reference, amount, notes,
                                                grn_sync_id, created_by, sync_id, tenant_id, branch_id, device_id,
                                                synced, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
          `);
          const insHqCnItem = hqDb.prepare(`
            INSERT INTO supplier_credit_note_items (credit_note_id, credit_note_sync_id, product_id, product_sync_id,
                                                     quantity, unit_value, total_price, unit, unit_conv,
                                                     sync_id, tenant_id, branch_id, device_id,
                                                     synced, created_at, updated_at)
            VALUES ((SELECT id FROM supplier_credit_notes WHERE sync_id = ?),?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
          `);
          // Straight copy of what master booked â€” same number, same sync_id,
          // same amount. Nothing is recalculated here: a second formula is
          // how the two books came to disagree in the first place.
          for (const cn of cnMirror) {
            const { cnNumber, cnSyncId, reason, amt, notes } = cn;
            const stockR = reason === 'Crate Return' || reason === 'Bottle Return' || reason === 'Goods Return';
            const validCnItems = cn.items || [];
            insHqCn.run(
              cnNumber, grnDate,
              hqSupplierId, hqSupplierSyncId,
              reason, grnNumber, amt, notes,
              grnSyncId, generatorId,
              cnSyncId, HQ_TENANT_ID, null, null
            );
            if (stockR) {
              for (const i of validCnItems) {
                const q = parseFloat(i.quantity) || 0;
                const uv = parseFloat(i.unit_value) || 0;
                const prod = findHqProduct.get(i.product_sync_id);
                insHqCnItem.run(
                  cnSyncId, cnSyncId,
                  prod?.id || null, i.product_sync_id,
                  q, uv, q * uv, i.unit || null,
                  parseFloat(i.unit_conv) > 0 ? parseFloat(i.unit_conv) : 1,
                  randomUUID(), HQ_TENANT_ID, null, null
                );
              }
            }
          }
        }
      }
    } catch (hqMirrorErr) {
      console.error('[hq.grns.generate] hq.db mirror failed:', hqMirrorErr.message);
    }

    // 4. Post stock to branch tenant DB (outside master tx â€” different connection)
    // v1.10.55 â€” WAC redesign push 3: blend delivery cost into the branch's
    // avg_cost_price. Delivery CP is derived from the PO's declared FX rate
    // (captured at PO Create time in v1.10.54). Formula per user's
    // 2026-07-03 memo:
    //   new_wac = (existing_qty Ã— existing_avg + received_qty Ã— delivery_cp)
    //             / (existing_qty + received_qty)
    // Never overwrites â€” always blends. Old stock keeps its historical avg
    // in the numerator. If existing avg is NULL (product never received
    // any stock), we seed it with the delivery CP.
    const poCurrency = String(purchase.cost_currency || '').toUpperCase();
    const poRate     = parseFloat(purchase.fx_rate_used || 0) || 0;
    const toUsd = (unitPrice) => {
      const c = parseFloat(unitPrice || 0) || 0;
      if (c <= 0) return 0;
      if (!poCurrency || poCurrency === 'USD') return c;
      return poRate > 0 ? c / poRate : c;
    };
    try {
      const branchDb = getTenantDb(branchSlug);
      const branchMovementAt = grnDate + ' ' + new Date().toTimeString().slice(0, 8);
      // v1.10.55 â€” atomic UPDATE that bumps current_stock AND blends
      // avg_cost_price in one statement. Uses the pre-update snapshot of
      // both fields (SQLite evaluates the row RHS before applying the SET).
      const updWithWac = branchDb.prepare(`
        UPDATE products
           SET current_stock  = current_stock + ?,
               avg_cost_price = CASE
                 WHEN avg_cost_price IS NULL OR current_stock <= 0
                   THEN ?
                 ELSE ROUND(
                   (current_stock * avg_cost_price + ? * ?)
                   / (current_stock + ?), 4)
               END,
               updated_at     = datetime('now'),
               synced         = 0
         WHERE sync_id = ?
      `);
      // Ownership for the movements below â€” see branchSyncIds().
      const __bids = branchSyncIds(branchDb);
      const insMov = branchDb.prepare(`
        INSERT INTO stock_movements
          (product_id, product_sync_id, location, movement_type, quantity,
           reference_id, reference_type, reference_sync_id, notes,
           created_by, sync_id, tenant_id, branch_id, device_id,
           synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,datetime('now'))
      `);
      // v1.10.103 â€” decrement helper for damage-out step below. Same shape
      // as updWithWac but only current_stock moves; avg_cost_price stays
      // untouched (option A: supplier billed us for the full quantity, WAC
      // blends the full received amount, damage is a separate P&L loss).
      const decStock = branchDb.prepare(`
        UPDATE products
           SET current_stock = current_stock - ?,
               updated_at    = datetime('now'),
               synced        = 0
         WHERE sync_id = ?
      `);
      for (const it of validItems) {
        if (!it.product_sync_id) continue; // extra items without a known product â€” skip stock posting
        const qty = parseFloat(it.quantity) || 0;
        if (qty <= 0) continue;
        const prod = branchDb.prepare(`
          SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
            FROM products WHERE sync_id = ? AND deleted_at IS NULL
        `).get(it.product_sync_id);
        if (!prod) continue;
        // v1.10.66 â€” convert line qty (e.g. 100 crates) into base units
        // (bottles) using the product's units_json conversion. Prior
        // versions posted the raw qty as if it were already in base
        // units, which meant a "100 crates" GRN only added 100 bottles
        // to stock and blended the WAC as $320/bottle instead of $13.33.
        // Same helper as transfers.js /receive and routes/grn.js.
        const conv = conversionToBase(prod, it.unit || prod.unit);
        const baseQty = qty * conv;
        // delivery cost is per-LINE-unit ($320/crate). Convert to per
        // BASE unit for the WAC blend since current_stock + avg_cost_price
        // are both denominated in base units.
        const deliveryCpUsdPerLineUnit = toUsd(it.unit_price);
        const deliveryCpUsdPerBase = conv > 0 ? deliveryCpUsdPerLineUnit / conv : deliveryCpUsdPerLineUnit;
        updWithWac.run(
          baseQty,                     // current_stock += baseQty
          deliveryCpUsdPerBase,        // seed value when avg was NULL or stock was 0
          baseQty, deliveryCpUsdPerBase, // numerator: received_base Ã— cp_per_base
          baseQty,                     // denominator adjust: + baseQty
          prod.sync_id
        );
        insMov.run(
          prod.id, prod.sync_id, 'sales', 'grn', baseQty,
          null, 'hq_grn', grnSyncId,
          `HQ-generated GRN ${grnNumber}`,
          null,
          randomUUID(), __bids.tenantId, __bids.branchId, null,
          branchMovementAt
        );

        // v1.10.103 â€” in-flow damage. If any of the received qty was
        // damaged in transit, book it as a separate stock-out AFTER the
        // WAC blend so:
        //   1. WAC absorbs the full delivery cost (supplier billed us for
        //      the full qty).
        //   2. current_stock nets down to the actually-saleable amount.
        //   3. Damage flows into daily_profit_summary.damages as a P&L
        //      loss â€” profitHelper.js:111 reads stock_movements with
        //      location='sales' AND movement_type='sales_return'. The
        //      existing damage queue (hqDamages.js) uses the same tag,
        //      so this reuses the same pipeline: cost = |qty| Ã— WAC hits
        //      the damages column on daily_profit_summary.
        const damagedLine = Math.max(0, parseFloat(it.damaged_quantity) || 0);
        if (damagedLine > 0) {
          const damagedBase = damagedLine * conv;
          insMov.run(
            prod.id, prod.sync_id, 'sales', 'sales_return', -damagedBase,
            null, 'hq_grn_damage', grnSyncId,
            `Damaged in transit on HQ-generated GRN ${grnNumber} (${damagedLine} ${it.unit || prod.unit})`,
            null,
            randomUUID(), __bids.tenantId, __bids.branchId, null,
            branchMovementAt
          );
          decStock.run(damagedBase, prod.sync_id);
        }
      }
      // v1.10.67 â€” negative stock movements for Crate Return / Bottle Return
      // / Goods Return CNs. Mirrors routes/grn.js:290-317 on the branch side.
      // WAC intentionally left alone (Option B, user 2026-07-03) â€” Liquor
      // branches don't touch avg_cost_price on returns either. Consequence:
      // if you return goods above current WAC (e.g. supplier price rose
      // since last delivery), the residual stock keeps the pre-return WAC.
      // Fine for typical crate/bottle returns; if this becomes a real
      // issue we can switch to Option A later without breaking the schema.
      for (const bundle of returnCnBundle) {
        for (const bi of bundle.items) {
          if (!bi.product_sync_id) continue;
          const bqty = parseFloat(bi.quantity) || 0;
          if (bqty <= 0) continue;
          const bprod = branchDb.prepare(`
            SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
              FROM products WHERE sync_id = ? AND deleted_at IS NULL
          `).get(bi.product_sync_id);
          if (!bprod) continue;
          const bconv = conversionToBase(bprod, bi.unit || bprod.unit);
          const bBaseQty = bqty * bconv;
          // Only decrement current_stock â€” WAC untouched.
          branchDb.prepare(`
            UPDATE products
               SET current_stock = current_stock - ?,
                   updated_at    = datetime('now'),
                   synced        = 0
             WHERE sync_id = ?
          `).run(bBaseQty, bprod.sync_id);
          insMov.run(
            bprod.id, bprod.sync_id, 'sales', 'credit_note', -bBaseQty,
            null, 'credit_note', bundle.cnSyncId,
            `${bundle.reason} via ${bundle.cnNumber}`,
            null,
            randomUUID(), __bids.tenantId, __bids.branchId, null,
            branchMovementAt
          );
        }
      }
    } catch (err) {
      console.error('[hq.grns.generate] stock post failed:', err.message);
      // Don't roll back the master tx â€” the GRN is recorded; stock can be
      // backfilled if needed. Surface a warning to the caller.
    }

    // v1.13.35 â€” Purge the branch-authored CN drafts now that they've
    // been persisted as real hq_supplier_credit_notes rows tied to this
    // GRN. Safe if drafts don't exist.
    try {
      masterDb.prepare(`
        DELETE FROM hq_receipt_credit_note_items
         WHERE credit_note_sync_id IN (
           SELECT sync_id FROM hq_receipt_credit_notes WHERE purchase_sync_id = ?
         )
      `).run(purchase_sync_id);
      masterDb.prepare(`DELETE FROM hq_receipt_credit_notes WHERE purchase_sync_id = ?`).run(purchase_sync_id);
    } catch (err) {
      console.error('[hq.grns.generate] CN draft cleanup failed:', err.message);
    }

    // â”€â”€ Phase 2 (Â§5.11 + Â§5.12 T06A) / Phase 3 (Â§5.11 T07A) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // In Kelete's v1.10.0 procurement flow, /generate is the FINAL step
    // where stock physically posts to the branch sales floor. That's
    // the only correct moment to fire ZRA's savePurchase +
    // saveStockItems + saveStockMaster chain â€” before stock arrives
    // ZRA would see phantom qty, after it's already posted our audit
    // trail is complete.
    //
    // v1.13.156 â€” T07A gap fix. Previously this ONLY fired when
    // zra_reg_ty_cd='A' (a ZRA-pulled, Smart-Invoice-registered
    // supplier â€” T06A). Manually-entered purchases (non-Smart-Invoice
    // supplier â€” T07A) always had zra_reg_ty_cd NULL and silently
    // never registered with ZRA at all, even though T07A's own
    // verification requires "purchase details are saved on the CIS
    // AND transmitted to Smart Invoice." Now both paths fire the same
    // chain â€” regTyCd differs ('A' vs 'M') and classification data
    // comes from a different source (see fireZraChainForGeneratedGrn).
    //
    // Runs in the destination branch's DB context via dbProxy.runWithDb
    // so vsdcClient reads that branch's zra_config and writes to its
    // own audit log. HQ has no VSDC device â€” the branch device proxies.
    let zraResult = { skipped: true, reason: 'not from ZRA pull' };
    if (purchase.zra_status === 'SIGNED') {
      zraResult = { skipped: true, reason: 'ZRA chain already fired for this PO' };
    } else {
      const regTyCd = purchase.zra_reg_ty_cd === 'A' ? 'A' : 'M';
      try {
        zraResult = await fireZraChainForGeneratedGrn(
          purchase, grnNumber, grnSyncId, validItems, branchSlug, req.user, regTyCd
        );
      } catch (e) {
        console.error('[hq.grns.generate] ZRA chain failed:', e.message);
        zraResult = { ok: false, error: e.message };
      }
    }

    res.status(201).json({
      success: true,
      grn_sync_id: grnSyncId,
      grn_number: grnNumber,
      branch_slug: branchSlug,
      zra: zraResult,
    });
  } catch (error) {
    console.error('[hq.grns.generate] CRASH:', error.stack || error);
    res.status(500).json({ error: error.message });
  }
});

// â”€â”€ Phase 2/3 (Â§5.11 T06A + T07A) helper for the /generate flow â”€â”€â”€â”€â”€â”€â”€â”€
// Fires savePurchase + saveStockItems + saveStockMaster against the
// destination branch's VSDC device. Called at the end of /generate for
// EVERY HQ Purchase (both ZRA-pulled and manually-entered), not signed
// yet.
//
// purchase    â€” hq_purchases row
// grnNumber   â€” the fresh GRN- number just created
// grnSyncId   â€” the fresh GRN sync_id just created
// validItems  â€” the items[] payload passed into /generate (matches
//               hq_grn_items rows already inserted, has product_sync_id,
//               product_name, unit, quantity, unit_price)
// branchSlug  â€” destination branch slug
// user        â€” req.user (for audit log actor)
// regTyCd     â€” 'A' (ZRA-pulled, Smart-Invoice supplier â€” T06A) or
//               'M' (manually entered, non-Smart-Invoice supplier â€”
//               T07A). Determines both the savePurchase flag AND
//               where per-line ZRA classification data comes from.
async function fireZraChainForGeneratedGrn(purchase, grnNumber, grnSyncId, validItems, branchSlug, user, regTyCd = 'A') {
  const branchDb = getTenantDb(branchSlug);
  const branchTenantId = branchDb.prepare(
    'SELECT tenant_id FROM business_settings LIMIT 1'
  ).get()?.tenant_id || branchSlug;

  // regTyCd='A': classification snapshot was cached on hq_purchase_items
  // at ZRA-pull-approve time (copied from the supplier's own ZRA-side
  // item registration).
  const hqItems = masterDb.prepare(
    'SELECT * FROM hq_purchase_items WHERE purchase_sync_id = ?'
  ).all(purchase.sync_id);
  const bySync = new Map(hqItems.map(h => [h.product_sync_id, h]));

  // v1.13.156 â€” regTyCd='M': manual POs never carry a ZRA-pull
  // snapshot (hq_purchase_items.zra_* stays NULL for them), so fall
  // back to the DESTINATION BRANCH's own products table â€” those
  // fields were captured at T04A item registration and are the
  // authoritative classification for that product regardless of which
  // supplier it's being bought from this time.
  //
  // 2026-08-26 â€” this lookup is now loaded for BOTH regTyCd values, and
  // selects `code` as well. Two reasons, both from a live miss:
  //
  //   * A ZRA-pulled PO ('A') can still contain a line whose cached
  //     snapshot lacks an item code, and previously had no fallback
  //     source at all because this block was gated on 'M'.
  //   * `code` is needed because products created after the one-time
  //     ZM-code backfill never get zra_item_cd populated â€” it stays
  //     NULL and every other ZRA call falls back to products.code
  //     (`product.zra_item_cd || product.code` in saveItem, saveSales
  //     and the stock chain). This function was the lone exception.
  const syncIds = validItems.map(v => v.product_sync_id).filter(Boolean);
  let productsBySync = new Map();
  if (syncIds.length) {
    const placeholders = syncIds.map(() => '?').join(',');
    const rows = branchDb.prepare(
      `SELECT sync_id, code, zra_item_cd, zra_item_cls_cd, zra_pkg_unit_cd,
              zra_qty_unit_cd, zra_vat_cat_cd, zra_excise_ty_cd
         FROM products WHERE sync_id IN (${placeholders})`
    ).all(...syncIds);
    productsBySync = new Map(rows.map(r => [r.sync_id, r]));
  }

  const zraItems = [];
  const movementLines = [];
  for (const vi of validItems) {
    if (!vi.product_sync_id) continue;   // extras with no product â€” skip
    const qty = parseFloat(vi.quantity) || 0;
    if (qty <= 0) continue;
    const hi   = bySync.get(vi.product_sync_id);
    const prod = productsBySync.get(vi.product_sync_id);
    if (!hi && !prod) continue;           // no classification source at all â€” skip
    // 2026-08-26 â€” `|| prod?.code` added. Without it this skipped every
    // line whose product had no zra_item_cd, zraItems came back empty,
    // and the whole chain returned "no classification data" WITHOUT
    // firing a single VSDC call â€” a silent no-op, not an error. Any
    // product created after the one-time ZM-code backfill hits this
    // (they keep zra_item_cd NULL and rely on the code fallback that
    // saveItem/saveSales/the stock chain already use), so purchases of
    // newly-added items never reached ZRA while local stock still rose.
    const zraItemCd  = vsdc.itemCodeFor(hi, prod);
    if (!zraItemCd) continue;             // ZRA requires an item code â€” nothing to send
    zraItems.push({
      product_id:       null,
      product_code:     zraItemCd,
      product_name:     vi.product_name || hi?.product_name,
      quantity:         qty,
      cost_price:       parseFloat(vi.unit_price) || parseFloat(hi?.cost_price) || 0,
      zra_item_cd:      zraItemCd,
      zra_item_cls_cd:  hi?.zra_item_cls_cd  || prod?.zra_item_cls_cd  || null,
      zra_pkg_unit_cd:  hi?.zra_pkg_unit_cd  || prod?.zra_pkg_unit_cd  || null,
      zra_qty_unit_cd:  hi?.zra_qty_unit_cd  || prod?.zra_qty_unit_cd  || null,
      zra_vat_cat_cd:   hi?.zra_vat_cat_cd   || prod?.zra_vat_cat_cd   || 'A',
      zra_excise_ty_cd: hi?.zra_excise_ty_cd || prod?.zra_excise_ty_cd || null,
    });
    movementLines.push({
      product_sync_id: vi.product_sync_id,
      quantity:        qty,
      unit:            vi.unit || hi?.unit || null,
    });
  }
  if (zraItems.length === 0) {
    return { skipped: true, reason: 'no positive-qty lines with ZRA classification data to send' };
  }

  const grnShim = {
    id:                    null,
    zra_pchs_invc_no:      null,
    // v1.13.156 â€” manual (regTyCd='M') suppliers have no ZRA-side TPIN/
    // branch to reference; savePurchase's own default already falls
    // back to 'M' when this is null, but we set it explicitly so the
    // intent is unambiguous in the request body.
    zra_spplr_tpin:        purchase.zra_spplr_tpin || null,
    zra_spplr_bhf_id:      purchase.zra_spplr_bhf_id || null,
    zra_reg_ty_cd:         regTyCd,
    supplier_name:         purchase.supplier_name,
    supplier_invoice_no:   purchase.invoice_number,
  };

  return await dbProxy.runWithDb(branchDb, async () => {
    const purchaseRes = await vsdc.savePurchase(branchTenantId, grnShim, zraItems, {
      actor: String(user?.id || 'hq-generate'),
    });
    if (purchaseRes.skipped) return { skipped: true, reason: purchaseRes.reason };
    if (!purchaseRes.ok) {
      masterDb.prepare(
        `UPDATE hq_purchases SET zra_status='FAILED' WHERE id=?`
      ).run(purchase.id);
      return { ok: false, stage: 'savePurchase', error: purchaseRes.error, resultCd: purchaseRes.resultCd };
    }
    masterDb.prepare(
      `UPDATE hq_purchases SET zra_pchs_invc_no=?, zra_status='SIGNED' WHERE id=?`
    ).run(purchaseRes.pchsInvcNo || null, purchase.id);

    // saveNonSaleStockChain handles per-line VAT + fires both
    // saveStockItems and saveStockMaster. sarTyCd='02' = PURCHASE.
    // sarNo unique per hq_purchase (id Ã— 1000000) to avoid collisions
    // with tenant-side sales sarNo sequences.
    const stockRes = await vsdc.saveNonSaleStockChain(
      branchTenantId,
      purchase.id * 1000000 + Date.now() % 1000000,
      { remark: `HQ Purchase ${purchase.purchase_number} â†’ ${grnNumber} at ${branchSlug}` },
      movementLines,
      vsdc.SAR_TY_CD.PURCHASE
    );
    return { ok: true, pchsInvcNo: purchaseRes.pchsInvcNo, stockChain: stockRes };
  });
}

module.exports = router;
