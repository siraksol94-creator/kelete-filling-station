/**
 * notifications.js â€” sidebar badge counts for the currently-selected
 * branch. One round-trip returns:
 *   - cashier_pending      (orders status='PENDING_PAYMENT' in that branch)
 *   - dispatch_pending     (orders status='PAID' in that branch)
 *   - incoming_stock       (hq_purchase_items pending for that branch
 *                           â€” lives in master.db, joined on destination_slug)
 *   - incoming_transfers   (stock_transfers PENDING with to_slug=this branch
 *                           â€” also in master.db, for the inter-branch flow)
 *
 * Designed to be cheap + polled every 30s from the sidebar. Each count is
 * a single COUNT(*) with an index already in place. Errors per source are
 * swallowed individually so one broken branch can't blank the others.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { masterDb, isRegistered, listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');

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

function safeCount(fn) { try { return fn() || 0; } catch { return 0; } }

router.get('/badges', hqAuth, (req, res) => {
  try {
    const slug = String(req.query.slug || '').toLowerCase();

    // HQ-scope counts (returned regardless of slug so HQ sidebar badges
    // are always live whether or not a branch is currently picked).
    const hqPendingGrn = safeCount(() => masterDb.prepare(
      `SELECT COUNT(*) AS n FROM hq_purchase_items WHERE status = 'GRN_SUBMITTED'`
    ).get()?.n);
    // Damages live per-branch â€” sum PENDING rows across every registered
    // tenant. Cheap (1 COUNT per branch, 3 branches today).
    let hqPendingDamages = 0;
    try {
      for (const t of listTenants()) {
        try {
          const db = getTenantDb(t.slug);
          hqPendingDamages += safeCount(() => db.prepare(
            `SELECT COUNT(*) AS n FROM sales_returns WHERE deleted_at IS NULL AND status = 'PENDING'`
          ).get()?.n);
        } catch (_) { /* skip broken branch */ }
      }
    } catch (_) { /* listTenants failure â†’ 0 */ }

    if (!slug || !isRegistered(slug)) {
      return res.json({
        cashier_pending: 0, dispatch_pending: 0,
        incoming_stock: 0, incoming_transfers: 0,
        hq_pending_grn:     hqPendingGrn,
        hq_pending_damages: hqPendingDamages,
      });
    }

    const db = getTenantDb(slug);
    const cashier  = safeCount(() => db.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE deleted_at IS NULL AND status = 'PENDING_PAYMENT'`
    ).get()?.n);
    const dispatch = safeCount(() => db.prepare(
      `SELECT COUNT(*) AS n FROM orders WHERE deleted_at IS NULL AND status = 'PAID'`
    ).get()?.n);

    // Branch's "Incoming Stock" badge counts only the AWAITING_GRN rows
    // (action items for the branch). GRN_SUBMITTED lines are read-only
    // for the branch until HQ confirms / rejects.
    const incomingStock = safeCount(() => masterDb.prepare(
      `SELECT COUNT(*) AS n FROM hq_purchase_items WHERE destination_slug = ? AND status = 'AWAITING_GRN'`
    ).get(slug)?.n);

    const incomingTransfers = safeCount(() => masterDb.prepare(
      `SELECT COUNT(*) AS n FROM stock_transfers WHERE to_slug = ? AND status = 'PENDING'`
    ).get(slug)?.n);

    res.json({
      cashier_pending:     cashier,
      dispatch_pending:    dispatch,
      incoming_stock:      incomingStock,
      incoming_transfers:  incomingTransfers,
      hq_pending_grn:      hqPendingGrn,
      hq_pending_damages:  hqPendingDamages,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2026-09-15 â€” what is waiting for this depot to receive, with enough detail
// for the on-screen notice: HQ deliveries (one row per purchase, lines still
// AWAITING_GRN) and inter-branch transfers still PENDING. Polled every 10s.
router.get('/incoming', hqAuth, (req, res) => {
  try {
    const slug = String(req.query.slug || '').toLowerCase();

    // 2026-09-19 â€” HQ's own version of the same notice. A depot confirming a
    // delivery puts it in HQ's Generate GRN queue, and until someone there
    // generates it there is no GRN and no payable: the supplier's invoice is
    // sitting in a drawer with nothing in the system to match it to. HQ had
    // neither a notice nor a working badge for that (the badge was asked for
    // with an empty slug and skipped), so it was only ever found by chance.
    //
    // One row per purchase, like the depot's â€” a delivery, not a line.
    if (String(req.query.scope || '').toLowerCase() === 'hq') {
      let grns = [];
      try {
        grns = masterDb.prepare(`
          SELECT p.id, p.purchase_number, p.supplier_name, p.date,
                 i.destination_slug AS slug, COUNT(i.id) AS lines,
                 MAX(i.received_at) AS confirmed_at
            FROM hq_purchase_items i
            JOIN hq_purchases p ON p.id = i.purchase_id
           WHERE i.status = 'GRN_SUBMITTED'
           GROUP BY p.id, i.destination_slug
           ORDER BY confirmed_at DESC, p.id DESC`).all();
      } catch (_) { grns = []; }
      const nameOf = (s) => {
        try { return listTenants().find(t => t.slug === s)?.business_name || s; }
        catch (_) { return s; }
      };
      return res.json({
        stock: [], transfers: [],
        grns: grns.map(g => ({ ...g, branch_name: nameOf(g.slug) })),
      });
    }

    if (!slug || !isRegistered(slug)) return res.json({ stock: [], transfers: [] });
    let stock = [];
    try {
      stock = masterDb.prepare(`
        SELECT p.id, p.purchase_number, p.supplier_name, p.date, COUNT(i.id) AS lines
          FROM hq_purchase_items i
          JOIN hq_purchases p ON p.id = i.purchase_id
         WHERE i.destination_slug = ? AND i.status = 'AWAITING_GRN'
         GROUP BY p.id
         ORDER BY p.date DESC, p.id DESC`).all(slug);
    } catch (_) { stock = []; }
    let transfers = [];
    try {
      transfers = masterDb.prepare(`
        SELECT id, transfer_number, from_slug, from_name, total_items, created_at
          FROM stock_transfers
         WHERE to_slug = ? AND status = 'PENDING'
         ORDER BY created_at DESC, id DESC`).all(slug);
    } catch (_) { transfers = []; }
    res.json({ stock, transfers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// â”€â”€â”€ Push registration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// 2026-09-18. The phone says where to reach it. Called on every login in the
// APK, not once at install: Firebase reissues a token whenever it feels like
// it, and a stale one silently delivers nothing. So this is an upsert.
//
// The token is written to the book the user belongs to, which is the one this
// request is already on â€” a depot's users live in that depot's database, HQ's
// in HQ's own. See services/push.js.
router.post('/push-token', hqAuth, (req, res) => {
  try {
    const pushSvc = require('../services/push');
    const token = String(req.body?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Token is required.' });
    const slug = String(req.headers['x-tenant'] || req.hostname || '').toLowerCase().split('.')[0];
    pushSvc.saveToken(null, {
      token,
      userId: req.user?.id,
      slug,
      platform: String(req.body?.platform || 'android'),
    });
    res.json({ ok: true, pushEnabled: pushSvc.isOn() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Logging out on a shared till must stop that phone getting the next
// cashier's alerts.
router.delete('/push-token', hqAuth, (req, res) => {
  try {
    const pushSvc = require('../services/push');
    pushSvc.removeToken(null, String(req.body?.token || req.query?.token || ''));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
