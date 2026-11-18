// Discount approval requests.
//
// Async approval workflow: non-admin cashier creates a 'pending' row from POS,
// an Administrator approves or rejects from the Approvals page, the cashier's
// POS polls /:syncId every few seconds and applies the discount when the
// status flips to 'approved'.
//
// Admins skip this entire flow client-side and apply discounts directly.
// The 'Administrator' role check on approve/reject is the hard gate.

const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// Look up the user's display name for the row snapshot. We snapshot rather
// than JOIN at read time so the request remains readable even if the user
// is later renamed or removed.
function displayName(userId) {
  const u = db.prepare('SELECT first_name, last_name, email FROM users WHERE id = ?').get(userId) || {};
  return `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email || 'User';
}

// ── Create ───────────────────────────────────────────────────────────────────
router.post('/', auth, (req, res) => {
  try {
    const {
      target, product_name, product_sync_id, unit,
      quantity, unit_price, subtotal, discount_amount,
      // v1.8.98 — Change Price flow: when new_price is set, this is a price-
      // change request (not a discount). discount_amount becomes derived from
      // (unit_price - new_price) * quantity (signed: + when shop loses,
      // − when shop gains from a surcharge). change_reason is required.
      new_price, change_reason,
    } = req.body;
    if (!['line', 'cart'].includes(target)) return res.status(400).json({ error: 'target must be "line" or "cart".' });

    const hasNewPrice = new_price !== undefined && new_price !== null && new_price !== '';
    let amt;
    if (hasNewPrice) {
      // Price-change request (target must be 'line' — cart-level price change isn't supported)
      if (target !== 'line') return res.status(400).json({ error: 'Price change is only valid for line items.' });
      const np = parseFloat(new_price);
      if (!isFinite(np) || np <= 0) return res.status(400).json({ error: 'new_price must be > 0.' });
      const up = parseFloat(unit_price) || 0;
      const qty = parseFloat(quantity) || 0;
      if (Math.abs(np - up) < 0.0001) return res.status(400).json({ error: 'new_price equals original price — nothing to approve.' });
      // v1.9.4 — reason is now OPTIONAL (used to require >= 3 chars). The
      // approver still sees the field; cashier can leave it blank when no
      // explanation is needed (e.g. quick VIP discounts during a rush).
      amt = (up - np) * qty; // signed; can be negative for surcharges
    } else {
      // Legacy discount request
      amt = parseFloat(discount_amount) || 0;
      if (!(amt > 0)) return res.status(400).json({ error: 'discount_amount must be > 0.' });
    }

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const requesterName = displayName(req.user.id);
    const syncId = randomUUID();

    const info = db.prepare(`
      INSERT INTO discount_requests
      (requested_by, requester_name, target, product_name, product_sync_id, unit,
       quantity, unit_price, subtotal, discount_amount,
       new_price, change_reason, status,
       sync_id, tenant_id, branch_id, device_id, synced)
      VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?, 'pending', ?,?,?,?, 0)
    `).run(
      req.user.id, requesterName, target,
      target === 'cart' ? null : (product_name || null),
      target === 'cart' ? null : (product_sync_id || null),
      target === 'cart' ? null : (unit || null),
      target === 'cart' ? 0 : (parseFloat(quantity) || 0),
      target === 'cart' ? 0 : (parseFloat(unit_price) || 0),
      target === 'cart' ? (parseFloat(subtotal) || 0) : 0,
      amt,
      hasNewPrice ? parseFloat(new_price) : null,
      hasNewPrice ? (change_reason || '').trim() : null,
      syncId, tenantId, branchId, deviceId
    );
    const row = db.prepare('SELECT * FROM discount_requests WHERE id = ?').get(info.lastInsertRowid);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── List ─────────────────────────────────────────────────────────────────────
// Query params:
//   status  default 'pending' — one of pending|approved|rejected|all
//   from    YYYY-MM-DD (inclusive) — filters by DATE(created_at)
//   to      YYYY-MM-DD (inclusive)
//   limit   default 200, hard cap 500
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const status = (req.query.status || 'pending').toString();
    const limit  = Math.min(parseInt(req.query.limit) || 200, 500);
    const valid  = ['pending', 'approved', 'rejected', 'all'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status filter.' });
    const from = (req.query.from || '').toString().trim();
    const to   = (req.query.to   || '').toString().trim();
    let sql = `SELECT * FROM discount_requests WHERE tenant_id = ? AND deleted_at IS NULL`;
    const params = [req.user.tenantId];
    if (status !== 'all') { sql += ' AND status = ?'; params.push(status); }
    if (from) { sql += ' AND DATE(created_at) >= ?'; params.push(from); }
    if (to)   { sql += ' AND DATE(created_at) <= ?'; params.push(to);   }
    sql += ` ORDER BY datetime(created_at) DESC LIMIT ${limit}`;
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pending count (drives sidebar badge) ────────────────────────────────────
router.get('/pending-count', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(
      `SELECT COUNT(*) AS c FROM discount_requests WHERE tenant_id = ? AND status = 'pending' AND deleted_at IS NULL`
    ).get(req.user.tenantId);
    res.json({ count: row.c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single (cashier polls by sync_id) ────────────────────────────────────────
router.get('/:syncId', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(
      'SELECT * FROM discount_requests WHERE sync_id = ? AND tenant_id = ? AND deleted_at IS NULL'
    ).get(req.params.syncId, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Not found.' });
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Approve / Reject (Administrator only) ────────────────────────────────────
function setVerdict(req, res, verdict) {
  if (req.user.role !== 'Administrator') {
    return res.status(403).json({ error: 'Only administrators can ' + verdict + ' discount requests.' });
  }
  const row = db.prepare(
    'SELECT * FROM discount_requests WHERE sync_id = ? AND tenant_id = ? AND deleted_at IS NULL'
  ).get(req.params.syncId, req.user.tenantId);
  if (!row) return res.status(404).json({ error: 'Request not found.' });
  if (row.status !== 'pending') return res.status(400).json({ error: `Request already ${row.status}.` });
  const approverName = displayName(req.user.id);
  const reason = verdict === 'reject' ? ((req.body?.reason || '').toString().trim() || null) : null;
  db.prepare(`
    UPDATE discount_requests
       SET status = ?, approver_id = ?, approver_name = ?, approved_at = datetime('now'),
           rejection_reason = ?, updated_at = datetime('now'), synced = 0
     WHERE sync_id = ?
  `).run(
    verdict === 'approve' ? 'approved' : 'rejected',
    req.user.id, approverName, reason, req.params.syncId
  );
  const updated = db.prepare('SELECT * FROM discount_requests WHERE sync_id = ?').get(req.params.syncId);
  res.json(updated);
}

router.put('/:syncId/approve', auth, (req, res) => {
  try { setVerdict(req, res, 'approve'); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/:syncId/reject', auth, (req, res) => {
  try { setVerdict(req, res, 'reject'); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cancel (requester can withdraw a still-pending request) ─────────────────
router.delete('/:syncId', auth, (req, res) => {
  try {
    const row = db.prepare(
      'SELECT * FROM discount_requests WHERE sync_id = ? AND tenant_id = ? AND deleted_at IS NULL'
    ).get(req.params.syncId, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Request not found.' });
    if (row.status !== 'pending') return res.status(400).json({ error: `Already ${row.status} — cannot cancel.` });
    if (row.requested_by !== req.user.id && req.user.role !== 'Administrator') {
      return res.status(403).json({ error: 'Only the requester or an admin can cancel.' });
    }
    db.prepare(`UPDATE discount_requests SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE sync_id = ?`).run(req.params.syncId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
