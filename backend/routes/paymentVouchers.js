const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { recalculateDailyProfit } = require('../config/profitHelper');

// 2026-09-11 — the Cash Book's per-method columns for a PV, from its three
// slots. On a Kwacha-only book the slots ARE the methods (usd_amount = Cash,
// fra_amount = Mobile Money, k_amount = Bank). Returned in column order:
// cash_amount, bank_amount, momo_amount. These were always written as 0, so a
// new PV was missing from the Cash Book until a restart's paid_from guess
// booked it — as Cash, whatever it was paid with. On a multi-currency book
// the slots are currencies, so the columns stay 0 as before.
function methodColumns(usd, fra, k) {
  try {
    const bs = db.prepare('SELECT currency_mode FROM business_settings LIMIT 1').get();
    if (bs && String(bs.currency_mode || 'K').toUpperCase() !== 'K') return [0, 0, 0];
  } catch (_) { /* no settings row yet — a Kelete book is Kwacha */ }
  return [usd, k, fra];
}

// Derive per-method splits from the voucher's paid_from string. Substring match
// (paid_from is free text like "Main cashier", "Bank — FNB", "MTN MoMo") so
// we lower-case and look for any of the recognised keywords. Same rules the
// migration backfill uses. Unknown / empty → Cash bucket (most common case).
function derivePVSplits(paid_from, amount) {
  const amt = parseFloat(amount) || 0;
  const pf  = (paid_from || '').toLowerCase();
  if (pf.includes('bank') || pf.includes('cheque'))  return { cash: 0, bank: amt, momo: 0 };
  if (pf.includes('mobile') || pf.includes('momo'))  return { cash: 0, bank: 0,   momo: amt };
  return { cash: amt, bank: 0, momo: 0 }; // matches 'Main cashier', 'Cash', 'Drawer', empty, etc.
}

// ─── 2026-09-18 — daily expense limit ──────────────────────────────────────
//
// A depot may pay out only so much in expenses per day (System Settings →
// Maximum expenses per day, K5,000 by default). A voucher that would take the
// day over it is refused; the depot sends it to HQ for approval instead
// (pv_expense_requests below), and once HQ approves, that voucher saves once.
// HQ's own book has no limit.
const HQ_HOST_SLUGS = new Set(['hq', 'kelete', 'keletedistributionzm', 'www']);
function isHqBook(req) {
  try {
    const host = String(req.headers['x-tenant'] || req.hostname || '').toLowerCase();
    return HQ_HOST_SLUGS.has(host.split('.')[0]);
  } catch (_) { return false; }
}
function dailyLimit() {
  try {
    const v = parseFloat(db.prepare('SELECT daily_expense_limit FROM business_settings LIMIT 1').get()?.daily_expense_limit);
    return isFinite(v) && v > 0 ? v : 0;
  } catch (_) { return 0; }   // column not added yet — no limit
}
function expensesOn(date, tenantId, excludeId) {
  try {
    const row = db.prepare(
      `SELECT COALESCE(SUM(amount), 0) AS t FROM payment_vouchers
        WHERE deleted_at IS NULL AND tenant_id = ? AND date = ?${excludeId ? ' AND id != ?' : ''}`
    ).get(...(excludeId ? [tenantId, date, excludeId] : [tenantId, date]));
    return parseFloat(row?.t) || 0;
  } catch (_) { return 0; }
}
function openRequest(status) {
  try {
    return db.prepare(
      `SELECT * FROM pv_expense_requests WHERE status = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`
    ).get(status) || null;
  } catch (_) { return null; }   // table not created yet
}
const money = (n) => `K${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Returns an error object to refuse with, or { approved } to let it through.
function checkDailyLimit(req, { date, newTotal, excludeId, isEdit }) {
  if (isHqBook(req)) return { ok: true };
  const limit = dailyLimit();
  if (limit <= 0) return { ok: true };
  // One voucher may wait for approval at a time: while it does, nothing new
  // is raised, so the day's figure HQ approved against cannot move.
  if (!isEdit) {
    const pending = openRequest('pending');
    if (pending) {
      return {
        error: `There is a payment voucher of ${money(pending.amount)} still waiting for HQ approval. Ask the administrator to approve it, then you can add another expense.`,
        pending_request: true,
        status: 409,
      };
    }
  }
  const already = expensesOn(date, req.user.tenantId, excludeId);
  const wouldBe = already + newTotal;
  if (wouldBe <= limit + 0.001) return { ok: true };
  // An approval from HQ covers this one voucher, up to the amount approved.
  const approved = openRequest('approved');
  if (approved && String(approved.date) === String(date) && newTotal <= (parseFloat(approved.amount) || 0) + 0.01) {
    return { ok: true, approved };
  }
  return {
    error: `This depot has already paid ${money(already)} in expenses on ${date}. This voucher of ${money(newTotal)} would make ${money(wouldBe)}, over the daily limit of ${money(limit)}.`,
    needs_approval: true,
    day_total: already,
    would_be: wouldBe,
    limit,
    status: 409,
  };
}

router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { date, paid_from, cashier_id } = req.query;
    let q = 'SELECT * FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?';
    const params = [req.user.tenantId];
    if (date)      { params.push(date);      q += ' AND date = ?'; }
    // 2026-09-21 — matched the same way Cash Report matches them, or the
    // "Expenses paid" figure and the list behind it disagree. A voucher raised
    // on the Payment Voucher page saves "Cash drawer"; one raised from Cash
    // Report saves "Cash Drawer", and a voucher belonging to the drawer rather
    // than to one cashier carries cashier_id 0. See routes/cashReport.js.
    if (paid_from) { params.push(String(paid_from).trim().toLowerCase()); q += ' AND LOWER(TRIM(paid_from)) = ?'; }
    if (cashier_id !== undefined) { params.push(parseInt(cashier_id)); q += ' AND cashier_id = ?'; }
    q += ' ORDER BY date DESC';
    const rows = db.prepare(q).all(...params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    // v1.8.25 — per-currency totals. Prefer the new usd/fra/k columns and
    // fall back to legacy cash/bank/momo only when the new ones are 0
    // (mirrors the cashReport.js v1.8.17 fix to avoid double-counting
    // transition rows where both columns happen to be populated).
    const usdExpr = `COALESCE(SUM(CASE WHEN COALESCE(usd_amount,0) > 0 THEN usd_amount ELSE COALESCE(cash_amount,0) END), 0)`;
    const fraExpr = `COALESCE(SUM(CASE WHEN COALESCE(fra_amount,0) > 0 THEN fra_amount ELSE COALESCE(bank_amount,0) END), 0)`;
    const kExpr   = `COALESCE(SUM(CASE WHEN COALESCE(k_amount,  0) > 0 THEN k_amount   ELSE COALESCE(momo_amount,0) END), 0)`;
    const totalsRow = (whereExtra, params) => db.prepare(
      `SELECT ${usdExpr} AS usd, ${fraExpr} AS fra, ${kExpr} AS k
       FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?${whereExtra}`
    ).get(...params);
    const today = totalsRow(" AND date = DATE('now')", [tenantId]);
    const month = totalsRow(" AND date >= date('now', 'start of month')", [tenantId]);
    const all   = totalsRow('', [tenantId]);
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM payment_vouchers WHERE deleted_at IS NULL AND tenant_id = ?').get(tenantId);
    res.json({
      // Legacy USD-only fields kept for back-compat with anything still reading them.
      todayPayments: parseFloat(today.usd) || 0,
      thisMonth:     parseFloat(month.usd) || 0,
      totalVouchers: count.cnt,
      avgPayment:    count.cnt > 0 ? Math.round((parseFloat(all.usd) || 0) / count.cnt) : 0,
      // v1.8.25 — per-currency breakdowns.
      today: { usd: parseFloat(today.usd) || 0, fra: parseFloat(today.fra) || 0, k: parseFloat(today.k) || 0 },
      month: { usd: parseFloat(month.usd) || 0, fra: parseFloat(month.fra) || 0, k: parseFloat(month.k) || 0 },
      total: { usd: parseFloat(all.usd)   || 0, fra: parseFloat(all.fra)   || 0, k: parseFloat(all.k)   || 0 },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', auth, (req, res) => {
  try {
    const { paid_to, description, category, amount, date, paid_from, cashier_id, invoice_attachment,
            cash_amount, bank_amount, momo_amount,
            usd_amount, fra_amount, k_amount } = req.body;
    const voucherNum = syncConfig.generateNumber('PV', 'payment_vouchers');
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const cashierId = cashier_id !== undefined ? parseInt(cashier_id) : 0;
    const resolvedPaidFrom = paid_from || 'Main cashier';
    // v1.8.5 — triple-currency. Each in its own currency. Legacy
    // cash/bank/momo still accepted but zeroed when usd/fra/k are sent.
    const usdAmt = parseFloat(usd_amount ?? cash_amount ?? 0) || 0;
    const fraAmt = parseFloat(fra_amount ?? bank_amount ?? 0) || 0;
    const kAmt   = parseFloat(k_amount   ?? momo_amount ?? 0) || 0;
    const sumSplits = usdAmt + fraAmt + kAmt;
    // For the legacy total `amount` column we use whatever the caller sent
    // (the USD-equivalent header), falling back to USD-only if missing.
    const totalAmount = parseFloat(amount) > 0 ? parseFloat(amount) : (sumSplits > 0 ? usdAmt : 0);
    const pvDate = date || new Date().toISOString().split('T')[0];
    // 2026-09-18 — the day's expense limit (and HQ's approval, if any).
    const gate = checkDailyLimit(req, { date: pvDate, newTotal: totalAmount, isEdit: false });
    if (gate.error) {
      const { status, ...body } = gate;
      return res.status(status || 409).json(body);
    }
    const info = db.prepare(
      `INSERT INTO payment_vouchers (voucher_number, paid_to, description, category, amount,
                                     cash_amount, bank_amount, momo_amount,
                                     usd_amount, fra_amount, k_amount,
                                     date, paid_from, cashier_id, invoice_attachment, created_by,
                                     sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
       VALUES (?,?,?,?,?, ?,?,?, ?,?,?, ?,?,?,?,?, ?,?,?,?, 0,datetime('now'),datetime('now'))`
    ).run(voucherNum, paid_to, description, category, totalAmount,
          ...methodColumns(usdAmt, fraAmt, kAmt),
          usdAmt, fraAmt, kAmt,
          pvDate,
          resolvedPaidFrom,
          cashierId,
          invoice_attachment || null,
          req.user.id,
          randomUUID(), tenantId, branchId, deviceId);
    const row = db.prepare('SELECT * FROM payment_vouchers WHERE id = ?').get(info.lastInsertRowid);
    // An HQ approval is good for one voucher only.
    if (gate.approved) {
      try {
        db.prepare(
          `UPDATE pv_expense_requests SET status = 'used', used_at = datetime('now'), used_voucher_id = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(row.id, gate.approved.id);
      } catch (_) { /* recorded only */ }
    }
    recalculateDailyProfit(db, row.date, req.user.tenantId);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', auth, (req, res) => {
  try {
    const { paid_to, description, category, amount, date, paid_from, invoice_attachment,
            cash_amount, bank_amount, momo_amount,
            usd_amount, fra_amount, k_amount } = req.body;
    const pvDate = date || new Date().toISOString().split('T')[0];
    const resolvedPaidFrom = paid_from || 'Main cashier';
    // v1.8.5 — triple-currency. Same merge as POST.
    const usdAmt = parseFloat(usd_amount ?? cash_amount ?? 0) || 0;
    const fraAmt = parseFloat(fra_amount ?? bank_amount ?? 0) || 0;
    const kAmt   = parseFloat(k_amount   ?? momo_amount ?? 0) || 0;
    const sumSplits = usdAmt + fraAmt + kAmt;
    const totalAmount = parseFloat(amount) > 0 ? parseFloat(amount) : (sumSplits > 0 ? usdAmt : 0);
    // 2026-09-18 — an edit counts against the same daily limit, with this
    // voucher's old amount left out of the day's total.
    const gateEdit = checkDailyLimit(req, {
      date: pvDate, newTotal: totalAmount, excludeId: parseInt(req.params.id, 10), isEdit: true,
    });
    if (gateEdit.error) {
      const { status, ...body } = gateEdit;
      return res.status(status || 409).json(body);
    }
    // invoice_attachment: pass null to clear, omit to keep existing
    const keepAttachment = invoice_attachment === undefined;
    const sql = keepAttachment
      ? `UPDATE payment_vouchers
            SET paid_to=?, description=?, category=?, amount=?,
                cash_amount=?, bank_amount=?, momo_amount=?,
                usd_amount=?, fra_amount=?, k_amount=?,
                date=?, paid_from=?, updated_at=datetime('now'), synced=0
          WHERE id=?`
      : `UPDATE payment_vouchers
            SET paid_to=?, description=?, category=?, amount=?,
                cash_amount=?, bank_amount=?, momo_amount=?,
                usd_amount=?, fra_amount=?, k_amount=?,
                date=?, paid_from=?, invoice_attachment=?, updated_at=datetime('now'), synced=0
          WHERE id=?`;
    const args = keepAttachment
      ? [paid_to, description, category, totalAmount,
         ...methodColumns(usdAmt, fraAmt, kAmt),
         usdAmt, fraAmt, kAmt,
         pvDate, resolvedPaidFrom, req.params.id]
      : [paid_to, description, category, totalAmount,
         ...methodColumns(usdAmt, fraAmt, kAmt),
         usdAmt, fraAmt, kAmt,
         pvDate, resolvedPaidFrom, invoice_attachment || null, req.params.id];
    const info = db.prepare(sql).run(...args);
    if (info.changes === 0) return res.status(404).json({ error: 'Voucher not found' });
    const row = db.prepare('SELECT * FROM payment_vouchers WHERE id = ?').get(req.params.id);
    recalculateDailyProfit(db, pvDate, req.user.tenantId);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Expense approval requests (depot side) ────────────────────────────────

// GET /api/payment-vouchers/expense-requests?status=open|pending|approved|all
// 'open' (the default) = what the depot still has to deal with: waiting,
// approved but not yet saved, or rejected and not yet dismissed.
router.get('/expense-requests', auth, readOnlyGuard, (req, res) => {
  try {
    const status = String(req.query.status || 'open').toLowerCase();
    const where = ['deleted_at IS NULL'];
    if (status === 'open') where.push("status IN ('pending','approved','rejected')");
    else if (status !== 'all') { where.push('status = ?'); }
    const args = (status === 'open' || status === 'all') ? [] : [status];
    const rows = db.prepare(
      `SELECT * FROM pv_expense_requests WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 50`
    ).all(...args);
    res.json({ rows, daily_limit: dailyLimit() });
  } catch (error) {
    res.json({ rows: [], daily_limit: 0 });   // table not created yet
  }
});

// POST /api/payment-vouchers/expense-requests — the depot asks HQ to allow a
// voucher that is over the day's limit. The voucher itself is NOT saved.
router.post('/expense-requests', auth, (req, res) => {
  try {
    const { paid_to, description, category, amount, date, paid_from, cashier_id, invoice_attachment,
            usd_amount, fra_amount, k_amount, reason } = req.body || {};
    const why = String(reason || '').trim();
    if (why.length < 3) return res.status(400).json({ error: 'A reason (at least 3 characters) is required.' });
    const usdAmt = parseFloat(usd_amount || 0) || 0;
    const fraAmt = parseFloat(fra_amount || 0) || 0;
    const kAmt   = parseFloat(k_amount   || 0) || 0;
    const total  = parseFloat(amount) > 0 ? parseFloat(amount) : (usdAmt + fraAmt + kAmt);
    if (!(total > 0)) return res.status(400).json({ error: 'Amount must be more than 0.' });
    const pvDate = date || new Date().toISOString().split('T')[0];
    if (openRequest('pending')) {
      return res.status(409).json({ error: 'There is already a payment voucher waiting for HQ approval.' });
    }
    const syncId = randomUUID();
    db.prepare(
      `INSERT INTO pv_expense_requests
         (sync_id, status, date, paid_to, description, category, paid_from, amount,
          usd_amount, fra_amount, k_amount, cashier_id, invoice_attachment,
          day_total_before, daily_limit, reason, requested_by, requester_name, tenant_id)
       VALUES (?, 'pending', ?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?,?,?)`
    ).run(
      syncId, pvDate, paid_to || null, description || null, category || null,
      paid_from || 'Main cashier', total,
      usdAmt, fraAmt, kAmt,
      cashier_id !== undefined ? parseInt(cashier_id) : null,
      invoice_attachment || null,
      expensesOn(pvDate, req.user.tenantId), dailyLimit(), why,
      req.user.id || null,
      [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.name || req.user.email || 'user',
      req.user.tenantId
    );
    // 2026-09-18 — wake HQ's Administrators. Until one of them answers, this
    // depot cannot raise any expense at all, so a request sitting unseen stops
    // the depot working. Fire-and-forget: the request is saved either way.
    try {
      const { notifyHqRoles } = require('../services/notify');
      const who = String(req.headers['x-tenant'] || req.hostname || '').toLowerCase().split('.')[0] || 'A depot';
      const money = `K${total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      notifyHqRoles(['Administrator'], {
        title: 'Expense needs approval',
        body: `${who.toUpperCase()} · ${money} · ${paid_to || description || 'expense'} — over the daily limit`,
        data: { type: 'expense-request', slug: who, sync_id: syncId },
        channelId: 'kelete-approvals-v1',
      }).catch(() => {});
    } catch (_) { /* never block the request */ }
    res.status(201).json(db.prepare('SELECT * FROM pv_expense_requests WHERE sync_id = ?').get(syncId));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/payment-vouchers/expense-requests/:syncId — the depot withdraws
// a waiting request, or clears a rejected one off its screen.
router.delete('/expense-requests/:syncId', auth, (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM pv_expense_requests WHERE sync_id = ? AND deleted_at IS NULL').get(req.params.syncId);
    if (!row) return res.status(404).json({ error: 'Request not found.' });
    if (row.status === 'approved') {
      return res.status(400).json({ error: 'This voucher has been approved — save it, or ask HQ before removing it.' });
    }
    db.prepare("UPDATE pv_expense_requests SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(row.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const pv = db.prepare('SELECT date FROM payment_vouchers WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    const info = db.prepare("UPDATE payment_vouchers SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=? AND deleted_at IS NULL").run(req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Voucher not found' });
    if (pv) recalculateDailyProfit(db, pv.date, req.user.tenantId);
    res.json({ message: 'Payment voucher deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
