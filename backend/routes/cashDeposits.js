/**
 * cashDeposits.js â€” Branch â†’ HQ Cash Deposit workflow.
 *
 * Branch records a physical cash deposit being sent to HQ; HQ confirms
 * when the cash arrives. On confirm we move the money in BOTH ledgers:
 *   - Branch tenant DB: payment_vouchers entry  (cash OUT, category 'HQ Deposit')
 *   - HQ tenant DB:     cash_receipts entry      (cash IN,  payment_method 'Deposit')
 *
 * Deposit row lives in master.db so both sides read the same record
 * without cross-DB joins (same pattern as stock_transfers).
 *
 * State machine on cash_deposits.status:
 *   PENDING    â€” branch sent, HQ hasn't confirmed yet
 *   CONFIRMED  â€” HQ acknowledged receipt, ledger entries written
 *   REJECTED   â€” HQ rejected (cash didn't arrive / wrong amount). No ledgers move.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { listTenants, isRegistered, masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const { depositTargetFor } = require('../services/depositTarget');
const { getHostSlug } = require('../middleware/hqPush');

// 2026-09-15 â€” who may confirm, reject or re-date a deposit: the side it was
// sent to. A deposit with to_slug went to that depot (the sender's System
// Settings â†’ Deposit to), and only that depot's address may act on it. One
// without went to HQ, and a depot's address may not act on it.
const HQ_HOST_SLUGS = new Set(['hq', 'kelete', 'keletedistributionzm', 'www']);
function receiverRefusal(req, row) {
  const caller = String(getHostSlug(req) || '').toLowerCase();
  const to = String(row.to_slug || '').toLowerCase();
  if (to) return caller === to ? null : `Only ${row.to_name || to} can do this â€” the deposit was sent to them.`;
  if (caller && !HQ_HOST_SLUGS.has(caller) && isRegistered(caller)) return 'Only HQ can do this â€” the deposit was sent to HQ.';
  return null;
}

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

function branchName(slug) {
  try {
    const t = listTenants().find(t => t.slug === slug);
    if (!t) return slug;
    try {
      const db = getTenantDb(slug);
      const row = db.prepare('SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1').get();
      if (row?.business_name) return row.business_name;
    } catch (_) { /* fall through */ }
    return t.business_name || slug;
  } catch (_) { return slug; }
}

// Pick the HQ tenant slug. Kelete's setup: the bare host (keletezm.com) is
// HQ itself â€” its tenant DB is registered with a known slug. Fall back
// to 'hq' if the convention changes.
function getHqSlug() {
  try {
    const t = listTenants().find(t => t.slug === 'hq');
    if (t) return 'hq';
    // Sometimes HQ is registered with the bare-host slug
    const bare = listTenants().find(t => /^(kelete|keletedistributionzm|hq)$/i.test(t.slug));
    return bare ? bare.slug : 'hq';
  } catch (_) { return 'hq'; }
}

function nextDepositNumber() {
  const seq = (masterDb.prepare('SELECT COUNT(*) AS n FROM cash_deposits').get()?.n || 0) + 1;
  const yyyymmdd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `DEP-${yyyymmdd}-${String(seq).padStart(4, '0')}`;
}

// â”€â”€â”€ POST /cash-deposits â€” branch records a new deposit being sent â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/', hqAuth, (req, res) => {
  try {
    const { from_slug, currency, amount, notes, deposit_date, attachment, from_method } = req.body;
    if (!from_slug || !isRegistered(from_slug)) return res.status(400).json({ error: 'Unknown source branch' });
    const ccy = String(currency || '').toUpperCase();
    if (!['USD', 'FRA', 'K'].includes(ccy)) return res.status(400).json({ error: 'currency must be USD, FRA, or K' });
    const amt = parseFloat(amount || 0) || 0;
    if (!(amt > 0)) return res.status(400).json({ error: 'amount must be > 0' });

    // v1.10.48 â€” from_method: physical drawer on Liquor branches
    // ('Cash' | 'Mobile Money' | 'Bank'). Optional; NULL on Kelete
    // tri-currency deposits (they're currency-anchored). Frontend gate
    // decides when to send it based on isLiquorStyle.
    const VALID_METHODS = new Set(['Cash', 'Mobile Money', 'Bank']);
    const method = VALID_METHODS.has(from_method) ? from_method : null;

    // v1.8.59 â€” no FX rate stored. Physical deposit is just raw currency;
    // any conversion at HQ is a separate Currency Exchange concern.
    // v1.8.60 â€” accept optional deposit_date (defaults to today) and
    // attachment path (uploaded separately via /api/attachments).
    const looksLikeDate = typeof deposit_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(deposit_date);
    const depDate = looksLikeDate ? deposit_date : new Date().toISOString().slice(0, 10);
    const syncId = randomUUID();
    const depositNumber = nextDepositNumber();
    const fromName = branchName(from_slug);
    // 2026-09-15 â€” HQ, or the depot picked in the sender's System Settings â†’ Deposit to.
    const target = depositTargetFor(from_slug);

    masterDb.prepare(`
      INSERT INTO cash_deposits (deposit_number, sync_id, from_slug, from_name,
                                 currency, amount, amount_usd, sell_rate, notes,
                                 deposit_date, attachment, from_method, to_slug, to_name,
                                 status, created_by, created_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING', ?, ?)
    `).run(
      depositNumber, syncId, from_slug, fromName,
      ccy, amt, 0, null, notes || null,
      depDate, attachment || null, method,
      target ? target.slug : null, target ? target.name : null,
      req.user.id, [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || null
    );
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE sync_id = ?').get(syncId);
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// â”€â”€â”€ GET /cash-deposits â€” list deposits â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Query: ?from_slug=kassumbalesa1 (branch's own outgoing list)
//        no params + caller is HQ â†’ returns ALL deposits (used by HQ inbox)
//        ?status=PENDING to filter
// 2026-09-15 â€” ?to_slug=kabwe  deposits sent TO that depot (its incoming list)
//              ?to=hq          only deposits sent to HQ (the HQ inbox)
// GET /cash-deposits/target?slug= â€” where that depot's deposits go now.
router.get('/target', hqAuth, (req, res) => {
  const slug = String(req.query.slug || getHostSlug(req) || '').toLowerCase();
  res.json({ slug, to: depositTargetFor(slug) });
});

router.get('/', hqAuth, (req, res) => {
  try {
    const { from_slug, status, to_slug } = req.query;
    const where = [];
    const params = [];
    if (from_slug) { where.push('from_slug = ?'); params.push(from_slug); }
    if (to_slug)   { where.push('to_slug = ?');   params.push(String(to_slug).toLowerCase()); }
    if (String(req.query.to || '').toLowerCase() === 'hq') where.push("COALESCE(to_slug, '') = ''");
    if (status)    { where.push('status = ?');    params.push(status); }
    const sql = `SELECT * FROM cash_deposits ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
    const rows = masterDb.prepare(sql).all(...params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// â”€â”€â”€ PUT /cash-deposits/:id/confirm â€” HQ confirms the cash arrived â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// v1.8.59 â€” REWRITE. A deposit is cash MOVEMENT between drawers, not P&L.
// We no longer write a payment_voucher (= expense, hits profit) on the
// branch or a cash_receipt (= income, hits profit) on HQ â€” those caused
// phantom profit deltas on both sides.
//
// Instead we just flip the master.db row to CONFIRMED. The Cash Report
// daily aggregation already subtracts confirmed-today outgoing deposits
// from the branch's per-currency Expected, and adds incoming deposits to
// the HQ's per-currency Expected, so drawer reconciliation still works
// â€” without inventing income/expense events.
router.put('/:id/confirm', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    if (row.status !== 'PENDING') return res.status(400).json({ error: `Deposit is already ${row.status}` });
    const refusal = receiverRefusal(req, row);
    if (refusal) return res.status(403).json({ error: refusal });
    const confirmedByName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || null;
    // v1.10.82 â€” HQ can override deposit_date at confirm time. Cash Book
    // shows the deposit under whatever date HQ picks here (fallback:
    // confirmed_at, then created_at â€” see routes/cashBook.js:402).
    // Guard: only YYYY-MM-DD strings; anything else falls back to the
    // existing deposit_date.
    const bodyDate = typeof req.body?.deposit_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.deposit_date)
      ? req.body.deposit_date
      : null;
    if (bodyDate) {
      masterDb.prepare(`
        UPDATE cash_deposits
           SET status = 'CONFIRMED',
               deposit_date = ?,
               confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now')
         WHERE id = ?
      `).run(bodyDate, req.user.id, confirmedByName, req.params.id);
    } else {
      masterDb.prepare(`
        UPDATE cash_deposits
           SET status = 'CONFIRMED',
               confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now')
         WHERE id = ?
      `).run(req.user.id, confirmedByName, req.params.id);
    }
    const updated = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    // 2026-09-18 â€” tell the depot that sent the money. Until it is confirmed
    // the cash is in neither drawer as far as anyone can prove, so this is the
    // moment they have been waiting for. Fire-and-forget.
    notifyDeposit(updated, 'confirmed', confirmedByName);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2026-09-18 â€” whoever sent the deposit gets told what happened to it, on the
// phone. Deposits live in master.db but the PEOPLE live in the sending depot's
// own book, which is what from_slug names.
function notifyDeposit(row, verdict, who, reason) {
  try {
    if (!row?.from_slug) return;
    const { notifyBranchRoles } = require('../services/notify');
    const money = `K${Number(row.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    notifyBranchRoles(row.from_slug, ['Administrator', 'Manager', 'Cashier'], {
      title: verdict === 'confirmed' ? 'Deposit confirmed' : 'Deposit rejected',
      body: verdict === 'confirmed'
        ? `${money} Â· ${row.deposit_number} received${who ? ' by ' + who : ''}.`
        : `${money} Â· ${row.deposit_number} was rejected${reason ? ': ' + reason : ''}.`,
      data: { type: 'deposit-' + verdict, deposit_number: row.deposit_number },
      channelId: 'kelete-approvals-v1',
    }).catch(() => {});
  } catch (_) { /* never block the confirmation */ }
}

// â”€â”€â”€ PUT /cash-deposits/:id/reject â€” HQ rejects (no ledger writes) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.put('/:id/reject', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    if (row.status !== 'PENDING') return res.status(400).json({ error: `Deposit is already ${row.status}` });
    const refusal = receiverRefusal(req, row);
    if (refusal) return res.status(403).json({ error: refusal });
    const confirmedByName = [req.user.first_name, req.user.last_name].filter(Boolean).join(' ') || null;
    masterDb.prepare(`
      UPDATE cash_deposits
         SET status = 'REJECTED',
             confirmed_by = ?, confirmed_by_name = ?, confirmed_at = datetime('now'),
             reject_reason = ?
       WHERE id = ?
    `).run(req.user.id, confirmedByName, req.body?.reason || null, req.params.id);
    const updated = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    notifyDeposit(updated, 'rejected', confirmedByName, req.body?.reason || null);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// â”€â”€â”€ PUT /cash-deposits/:id/date â€” edit accounting date of a CONFIRMED row â”€â”€
//
// v1.10.84 â€” HQ can move a CONFIRMED deposit to a different accounting
// date. Cash Book UNIONs directly from master.cash_deposits so the
// deposit re-lands on the new date automatically on both sides
// (branch's outgoing deduction shifts, HQ's incoming credit shifts).
//
// Only the accounting date changes; amount/currency/status stay put.
// Only CONFIRMED rows are editable through this endpoint â€” PENDING rows
// use the existing /confirm flow which already accepts a date, and
// REJECTED rows have no ledger effect so editing them is pointless.
router.put('/:id/date', hqAuth, (req, res) => {
  try {
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    if (row.status !== 'CONFIRMED') {
      return res.status(400).json({ error: `Only CONFIRMED deposits can have their date edited (current: ${row.status}).` });
    }
    const refusal = receiverRefusal(req, row);
    if (refusal) return res.status(403).json({ error: refusal });
    const newDate = req.body?.deposit_date;
    if (typeof newDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
      return res.status(400).json({ error: 'deposit_date must be YYYY-MM-DD.' });
    }
    masterDb.prepare('UPDATE cash_deposits SET deposit_date = ? WHERE id = ?').run(newDate, req.params.id);
    const updated = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// â”€â”€â”€ DELETE /cash-deposits/:id â€” remove a deposit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// v1.8.60 â€” allow deleting deposits to clean up mistakes / cancelled records.
// Branch can delete its own PENDING deposits; HQ can delete anything.
// CONFIRMED deposits should NOT be silently deleted by branches because
// HQ may have already balanced its drawer against them â€” gate behind HQ.
// 2026-08-28 â€” SOFT delete with an audit trail (ported from Kelete v1.10.143).
//
// This used to remove the row outright. On a CONFIRMED deposit that silently
// reverses cash on both sides â€” the branch's books show money that was
// physically handed over as still on hand â€” and leaves nothing to say who
// removed it or why. For cash moving between a branch and HQ that is the one
// record you most want.
//
// The row stays, tagged with who/when/why. Balance maths already excludes it:
// every Cash Book query filters `deleted_at IS NULL`, which is what the
// column was added for.
router.delete('/:id', hqAuth, (req, res) => {
  try {
    const reason = String(req.body?.reason || '').trim();
    if (reason.length < 3) {
      return res.status(400).json({ error: 'A reason (at least 3 characters) is required for the audit trail.' });
    }
    const row = masterDb.prepare('SELECT * FROM cash_deposits WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Deposit not found' });
    if (row.deleted_at) return res.status(400).json({ error: 'This deposit is already deleted.' });

    const who = [req.user?.first_name, req.user?.last_name].filter(Boolean).join(' ')
             || req.user?.firstName || req.user?.email || null;
    masterDb.prepare(`
      UPDATE cash_deposits
         SET deleted_at      = datetime('now'),
             deleted_by      = ?,
             deleted_by_name = ?,
             delete_reason   = ?
       WHERE id = ?
    `).run(req.user?.id ?? null, who, reason, req.params.id);
    res.json({ message: 'Deposit deleted', ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
