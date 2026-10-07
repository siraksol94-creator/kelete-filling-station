const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { masterDb } = require('../config/masterDb');
const { makePaidStmt } = require('../services/apPaid');

// GET /api/ap-payments
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const { from, to, supplier_id } = req.query;
    let sql = `SELECT ap.*, s.name AS supplier_name_resolved
               FROM ap_payments ap
               LEFT JOIN suppliers s ON s.sync_id = ap.supplier_sync_id
               WHERE ap.deleted_at IS NULL AND ap.tenant_id = ?`;
    const params = [req.user.tenantId];
    if (from) { sql += ' AND ap.date >= ?'; params.push(from); }
    if (to)   { sql += ' AND ap.date <= ?'; params.push(to); }
    // Filter by sync_id derived from requested local id so cross-device
    // records still match.
    if (supplier_id) { sql += ' AND ap.supplier_sync_id = (SELECT sync_id FROM suppliers WHERE id = ?)'; params.push(parseInt(supplier_id)); }
    sql += ' ORDER BY ap.date DESC, ap.id DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ap-payments — accepts split amounts (cash_amount + bank_amount + momo_amount)
// AND the new triple-currency shape (usd_amount + fra_amount + k_amount)
// used by HQ's AP Record Payment modal (v1.10.78).
// Falls back to the legacy single `amount` + `paid_from` shape for older callers.
router.post('/', auth, (req, res) => {
  try {
    const { supplier_id, supplier_name, cash_amount, bank_amount, momo_amount,
            usd_amount, fra_amount, k_amount,
            amount, description, date, paid_from, invoice_attachment } = req.body;
    const cash = parseFloat(cash_amount || 0) || 0;
    const bank = parseFloat(bank_amount || 0) || 0;
    const momo = parseFloat(momo_amount || 0) || 0;
    const usd  = parseFloat(usd_amount  || 0) || 0;
    const fra  = parseFloat(fra_amount  || 0) || 0;
    const kAmt = parseFloat(k_amount    || 0) || 0;
    // v1.10.78 — total resolution priority: triple-currency sum > method sum > legacy `amount`.
    const ccySum   = usd + fra + kAmt;
    const splitSum = cash + bank + momo;
    const total    = ccySum > 0 ? ccySum : (splitSum > 0 ? splitSum : (parseFloat(amount || 0) || 0));
    if (!(total > 0)) return res.status(400).json({ error: 'Amount is required.' });

    // Derive a paid_from label for display when none provided.
    // v1.10.78 — prefer triple-currency label on HQ; fall back to method label.
    const derivedPaidFrom = paid_from || (() => {
      if (ccySum > 0) {
        const used = [usd > 0 && 'USD', fra > 0 && 'FRA', kAmt > 0 && 'K'].filter(Boolean);
        return used.length === 1 ? used[0] : 'Mixed';
      }
      const used = [cash > 0 && 'Cash', bank > 0 && 'Bank', momo > 0 && 'Mobile Money'].filter(Boolean);
      if (used.length === 0) return 'Main cashier';
      if (used.length === 1) return used[0];
      return 'Mixed';
    })();

    // v1.13.30 — when the payment carries a grn_sync_id, enforce that
    // the AP approval chain has reached APPROVED before cash goes out.
    // Skip the check for ad-hoc payments (no grn_sync_id) — those are
    // legacy / one-off supplier payments not tied to a specific GRN.
    const grnSyncId = req.body.grn_sync_id || null;
    if (grnSyncId && masterDb) {
      const snap = masterDb.prepare(
        'SELECT ap_status FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?'
      ).get(grnSyncId);
      // 2026-08-30 — PARTIAL is payable too.
      //
      // This used to demand APPROVED exactly. But the moment a GRN is
      // short-paid, hqGrns.js rewrites its stored status to PARTIAL — so the
      // second instalment was refused with "Only APPROVED rows can be paid"
      // and a partly-paid GRN could never be settled. The approval chain has
      // already been satisfied; PARTIAL is APPROVED plus some money.
      if (snap && !['APPROVED', 'PARTIAL'].includes(snap.ap_status)) {
        return res.status(400).json({
          error: `Cannot pay — GRN status is ${snap.ap_status || 'PENDING'}. Only APPROVED rows can be paid.`,
        });
      }
    }

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const paymentNum = syncConfig.generateNumber('APR', 'ap_payments');
    const supplierSyncId = req.body.supplier_sync_id
      || (supplier_id ? db.prepare('SELECT sync_id FROM suppliers WHERE id = ?').get(supplier_id)?.sync_id : null)
      || null;
    // 2026-08-30 — the payment's own sync_id, needed below to key its
    // allocation row. It used to be generated inline inside the INSERT.
    const paymentSync = randomUUID();
    const info = db.prepare(`
      INSERT INTO ap_payments (payment_number, supplier_id, supplier_sync_id, supplier_name,
                                amount, cash_amount, bank_amount, momo_amount,
                                usd_amount, fra_amount, k_amount,
                                description, date, paid_from, invoice_attachment, created_by,
                                grn_sync_id,
                                sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(paymentNum, supplier_id || null, supplierSyncId, supplier_name || null,
           total, cash, bank, momo,
           usd, fra, kAmt,
           description || null, date || new Date().toISOString().split('T')[0],
           derivedPaidFrom, invoice_attachment || null, req.user.id,
           // 2026-08-30 — the GRN this settles. Was received and thrown away.
           grnSyncId || null,
           paymentSync, tenantId, branchId, deviceId);

    // Record the allocation as well, so a single-GRN payment is visible to the
    // same calculation the batch path feeds. Without this, paid/remaining would
    // count batch payments and quietly ignore ordinary ones.
    if (grnSyncId) {
      try {
        db.prepare(
          'INSERT OR IGNORE INTO ap_payment_allocations ' +
          '  (payment_sync_id, grn_sync_id, amount, sync_id, tenant_id, branch_id, device_id, synced) ' +
          'VALUES (?,?,?,?,?,?,?,0)'
        ).run(paymentSync, grnSyncId, total, randomUUID(), tenantId, branchId || null, deviceId || null);
      } catch (_) {
        // Pre-migration install: the payment row still carries grn_sync_id, and
        // the paid calculation falls back to it, so nothing is lost.
      }
    }
    // 2026-08-30 — PAID only when the GRN is actually settled.
    //
    // This used to set PAID on any payment, whatever the amount. K10,000
    // against a K90,000 GRN marked it fully paid, dropped it out of Ready for
    // Payment and hid the K80,000 still owed. Now the payments for this GRN
    // are summed and compared against what is payable:
    //     paid >= payable  -> PAID
    //     0 < paid < payable -> PARTIAL, stays in Ready for Payment
    // paid_at / paid_by are stamped either way so the card can show who paid
    // what and when, including on a part payment.
    if (grnSyncId && masterDb) {
      try {
        const actorName = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(' ') || req.user?.email || 'user';
        // Allocations, not the payment row — see services/apPaid.js. Reading
        // ap_payments.amount here would miss every GRN settled by a multi-GRN
        // payment, whose row carries the whole amount and no single GRN.
        const paid = makePaidStmt(db)(grnSyncId);
        const payable = parseFloat(
          masterDb.prepare('SELECT final_payable FROM hq_confirmed_grn_totals WHERE grn_sync_id = ?')
            .get(grnSyncId)?.final_payable || 0
        ) || 0;
        // A penny of tolerance: floating-point sums should not leave a GRN
        // one ngwee short of settled for ever.
        const nextStatus = (payable > 0 && paid + 0.01 >= payable) ? 'PAID' : 'PARTIAL';
        masterDb.prepare(`
          UPDATE hq_confirmed_grn_totals
             SET ap_status = ?,
                 paid_at = datetime('now'),
                 paid_by_id = ?, paid_by_name = ?
           WHERE grn_sync_id = ?
        `).run(nextStatus, req.user?.id || null, actorName, grnSyncId);
      } catch (_) { /* non-fatal — payment row already committed */ }
    }
    res.status(201).json(db.prepare('SELECT * FROM ap_payments WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/ap-payments/:id — supports split amounts on edit too.
// POST /api/ap-payments/batch — one payment, several GRNs, one supplier.
//
// 2026-08-30. The money is allocated OLDEST GRN FIRST, filling each one
// completely before moving to the next, so a short payment closes the oldest
// invoices outright and leaves exactly one partial at the end. Spreading it
// evenly would leave several half-paid GRNs and nothing actually settled.
//
// Stored as one ap_payments row per GRN sharing a batch_ref — payment_number
// is UNIQUE and grn_sync_id holds a single GRN, so the batch cannot be one
// row. That shape is also why no new status logic is needed: hqGrns.js already
// derives PAID/PARTIAL from SUM(amount) per GRN.
//
// Overpayment is REFUSED, never held as credit — there is no supplier-credit
// concept in this schema, so the excess would silently become an unexplained
// debit balance.
router.post('/batch', auth, (req, res) => {
  try {
    if (!masterDb) return res.status(503).json({ error: 'HQ archive unavailable on this device.' });

    const { supplier_id, supplier_name, supplier_sync_id,
            cash_amount, bank_amount, momo_amount,
            usd_amount, fra_amount, k_amount, amount,
            description, date, paid_from, invoice_attachment } = req.body;

    const ids = Array.isArray(req.body.grn_sync_ids) ? req.body.grn_sync_ids.filter(Boolean) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'Select at least one GRN to pay.' });

    const cash = parseFloat(cash_amount || 0) || 0;
    const bank = parseFloat(bank_amount || 0) || 0;
    const momo = parseFloat(momo_amount || 0) || 0;
    const usd  = parseFloat(usd_amount  || 0) || 0;
    const fra  = parseFloat(fra_amount  || 0) || 0;
    const kAmt = parseFloat(k_amount    || 0) || 0;
    const ccySum   = usd + fra + kAmt;
    const splitSum = cash + bank + momo;
    const total    = ccySum > 0 ? ccySum : (splitSum > 0 ? splitSum : (parseFloat(amount || 0) || 0));
    if (!(total > 0)) return res.status(400).json({ error: 'Amount is required.' });

    // Load the selected GRNs.
    const placeholders = ids.map(() => '?').join(',');
    const rows = masterDb.prepare(
      'SELECT grn_sync_id, grn_number, invoice_number, ap_batch_number, ' +
      '       supplier_sync_id, supplier_name, supplier_id, ' +
      '       date, final_payable, ap_status ' +
      '  FROM hq_confirmed_grn_totals ' +
      ' WHERE grn_sync_id IN (' + placeholders + ')'
    ).all(...ids);

    if (rows.length !== ids.length) {
      return res.status(400).json({ error: 'One or more selected GRNs could not be found.' });
    }

    // One supplier per batch — supplier is a column on the payment row, so a
    // mixed batch would file another supplier's money under this one.
    const suppliers = [...new Set(rows.map(r => r.supplier_sync_id || 'id:' + r.supplier_id))];
    if (suppliers.length > 1) {
      return res.status(400).json({ error: 'All selected GRNs must belong to the same supplier.' });
    }

    const notPayable = rows.filter(r => !['APPROVED', 'PARTIAL'].includes(r.ap_status));
    if (notPayable.length > 0) {
      return res.status(400).json({
        error: 'Not approved yet: ' + notPayable.map(r => r.grn_number).join(', ')
             + '. Only approved GRNs can be paid.',
      });
    }

    // What each GRN still owes, after anything already paid against it.
    const paidFor = makePaidStmt(db);
    const targets = rows.map(r => {
      const paid = paidFor(r.grn_sync_id);
      const payable = parseFloat(r.final_payable || 0) || 0;
      return { ...r, remaining: Math.max(0, payable - paid) };
    }).filter(t => t.remaining > 0.01);

    if (targets.length === 0) {
      return res.status(400).json({ error: 'The selected GRNs are already fully paid.' });
    }

    const totalRemaining = targets.reduce((n, t) => n + t.remaining, 0);

    // Refuse overpayment and say by how much, so the fix is obvious.
    if (total > totalRemaining + 0.01) {
      const excess = total - totalRemaining;
      return res.status(400).json({
        error: 'Payment is ' + excess.toFixed(2) + ' more than the ' + totalRemaining.toFixed(2)
             + ' outstanding on the selected GRNs. Select another GRN, or reduce the amount.',
        code: 'OVERPAYMENT',
        outstanding: Number(totalRemaining.toFixed(2)),
        excess: Number(excess.toFixed(2)),
      });
    }

    // Oldest first. Fall back to grn_number so the order is deterministic when
    // two GRNs share a date — otherwise the same request could split differently.
    targets.sort((a, b) =>
      String(a.date || '').localeCompare(String(b.date || '')) ||
      String(a.grn_number || '').localeCompare(String(b.grn_number || '')));

    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    let left = total;
    const plan = [];
    for (const t of targets) {
      if (left <= 0.01) break;
      const take = round2(Math.min(t.remaining, left));
      if (take <= 0) continue;
      plan.push({ target: t, take });
      left = round2(left - take);
    }

    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    // 2026-08-30 — reuse the APPROVAL batch number (APB-2026-00001) rather than
    // minting a second, unrelated 'APB-<random>'. There were two different APB
    // codes in play: the one on the approval and the one the payment invented,
    // which meant the reference in the Cash Book matched nothing on screen.
    // Falls back to a generated ref for an ad-hoc selection that was never
    // approved as a batch.
    const sharedBatchNumbers = [...new Set(rows.map(r => r.ap_batch_number).filter(Boolean))];
    const approvalBatchNumber = sharedBatchNumbers.length === 1 ? sharedBatchNumbers[0] : null;
    const batchRef = approvalBatchNumber
      || (ids.length > 1 ? 'APB-' + randomUUID().slice(0, 8).toUpperCase() : null);
    const resolvedSupplierSyncId = supplier_sync_id || rows[0].supplier_sync_id || null;
    const resolvedSupplierName   = supplier_name   || rows[0].supplier_name   || null;
    const resolvedSupplierId     = supplier_id     || rows[0].supplier_id     || null;

    const derivedPaidFrom = paid_from || (() => {
      if (ccySum > 0) {
        const used = [usd > 0 && 'USD', fra > 0 && 'FRA', kAmt > 0 && 'K'].filter(Boolean);
        return used.length === 1 ? used[0] : 'Mixed';
      }
      const used = [cash > 0 && 'Cash', bank > 0 && 'Bank', momo > 0 && 'Mobile Money'].filter(Boolean);
      if (used.length === 0) return 'Main cashier';
      if (used.length === 1) return used[0];
      return 'Mixed';
    })();

    // Split each currency/method component in the same proportion as the
    // allocation, so every child row's parts still add up to its own amount.
    // The last row absorbs the rounding remainder, so the batch's components
    // sum EXACTLY to what was entered rather than drifting a cent per row.
    const parts = { cash, bank, momo, usd, fra, k: kAmt };
    const running = { cash: 0, bank: 0, momo: 0, usd: 0, fra: 0, k: 0 };

    // ONE payment row, however many GRNs it settles.
    //
    // 2026-08-30 — this used to write one ap_payments row per GRN, and both
    // the AP Payments list and the Cash Book ledger list ap_payments row by
    // row, so a single K44,000 payment appeared twice in both. The payment is
    // now one record and the per-GRN split lives in ap_payment_allocations,
    // which nothing displays — it only answers "is this GRN paid?".
    //
    // Note what disappears with it: the currency pro-rating. There is one row
    // now, so the cash/bank/usd/fra components are simply the amounts entered.
    // No share-of-total arithmetic, and no rounding remainder to chase.
    const insert = db.prepare(
      'INSERT INTO ap_payments (payment_number, supplier_id, supplier_sync_id, supplier_name, ' +
      '                          amount, cash_amount, bank_amount, momo_amount, ' +
      '                          usd_amount, fra_amount, k_amount, ' +
      '                          description, date, paid_from, invoice_attachment, created_by, ' +
      '                          grn_sync_id, batch_ref, ' +
      '                          sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) ' +
      "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))"
    );
    const insertAlloc = db.prepare(
      'INSERT INTO ap_payment_allocations ' +
      '  (payment_sync_id, grn_sync_id, amount, sync_id, tenant_id, branch_id, device_id, synced) ' +
      'VALUES (?,?,?,?,?,?,?,0)'
    );

    // What the accountant reads in the Cash Book: which invoices this settled.
    // Capped, because a ten-GRN batch would otherwise flood the description
    // column — the allocations hold the full detail either way.
    const NAMED = 4;
    const named = plan.slice(0, NAMED).map(({ target: t }) =>
      t.invoice_number ? t.grn_number + ' (Inv ' + t.invoice_number + ')' : t.grn_number
    ).join(' / ');
    const more = plan.length > NAMED ? ' +' + (plan.length - NAMED) + ' more' : '';
    const countPart = plan.length > 1 ? ' - ' + plan.length + ' GRNs' : '';
    const batchPart = approvalBatchNumber ? ' - ' + approvalBatchNumber : '';
    const desc = description || (named + more + countPart + batchPart);

    const paymentNum   = syncConfig.generateNumber('APR', 'ap_payments');
    const paymentSync  = randomUUID();

    const run = db.transaction(() => {
      insert.run(paymentNum, resolvedSupplierId, resolvedSupplierSyncId, resolvedSupplierName,
                 total, cash, bank, momo,
                 usd, fra, kAmt,
                 desc, date || new Date().toISOString().split('T')[0],
                 derivedPaidFrom, invoice_attachment || null, req.user.id,
                 // grn_sync_id stays set when exactly one GRN is settled, so a
                 // single-invoice payment still looks the way it always did to
                 // anything reading that column. Null for a true multi-GRN
                 // payment, where no single GRN would be the honest answer.
                 plan.length === 1 ? plan[0].target.grn_sync_id : null,
                 batchRef,
                 paymentSync, tenantId, branchId || null, deviceId || null);

      return plan.map(p => {
        insertAlloc.run(paymentSync, p.target.grn_sync_id, p.take,
                        randomUUID(), tenantId, branchId || null, deviceId || null);
        return {
          grn_sync_id: p.target.grn_sync_id,
          grn_number:  p.target.grn_number,
          payment_number: paymentNum,
          allocated: p.take,
          remaining_after: round2(p.target.remaining - p.take),
          status: (p.take + 0.01 >= p.target.remaining) ? 'PAID' : 'PARTIAL',
        };
      });
    });

    const allocations = run();

    // Stamp each GRN. hqGrns.js recomputes this on read anyway, but writing it
    // now means the Ready-for-Payment list is right on the very next request
    // instead of correcting itself one refresh later.
    const stamp = masterDb.prepare('UPDATE hq_confirmed_grn_totals SET ap_status = ? WHERE grn_sync_id = ?');
    for (const a of allocations) {
      try { stamp.run(a.status, a.grn_sync_id); } catch (_) { /* recomputed on read */ }
    }

    res.status(201).json({
      batch_ref: batchRef,
      supplier_name: resolvedSupplierName,
      total_paid: round2(total),
      allocations,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', auth, (req, res) => {
  try {
    const { cash_amount, bank_amount, momo_amount, amount, date, description, paid_from, invoice_attachment } = req.body;
    const cash = parseFloat(cash_amount || 0) || 0;
    const bank = parseFloat(bank_amount || 0) || 0;
    const momo = parseFloat(momo_amount || 0) || 0;
    const splitSum = cash + bank + momo;
    const total    = splitSum > 0 ? splitSum : (parseFloat(amount || 0) || 0);
    if (!(total > 0)) return res.status(400).json({ error: 'Amount is required.' });

    const derivedPaidFrom = paid_from || (() => {
      const used = [cash > 0 && 'Cash', bank > 0 && 'Bank', momo > 0 && 'Mobile Money'].filter(Boolean);
      if (used.length === 1) return used[0];
      if (used.length > 1)   return 'Mixed';
      return null;
    })();

    // invoice_attachment: pass null to clear, omit to keep existing.
    const keepAttachment = invoice_attachment === undefined;
    const sql = keepAttachment
      ? `UPDATE ap_payments SET amount=?, cash_amount=?, bank_amount=?, momo_amount=?, date=?, description=?, paid_from=?, synced=0, updated_at=datetime('now') WHERE id=? AND deleted_at IS NULL`
      : `UPDATE ap_payments SET amount=?, cash_amount=?, bank_amount=?, momo_amount=?, date=?, description=?, paid_from=?, invoice_attachment=?, synced=0, updated_at=datetime('now') WHERE id=? AND deleted_at IS NULL`;
    const args = keepAttachment
      ? [total, cash, bank, momo, date, description || null, derivedPaidFrom, req.params.id]
      : [total, cash, bank, momo, date, description || null, derivedPaidFrom, invoice_attachment || null, req.params.id];
    db.prepare(sql).run(...args);
    res.json(db.prepare('SELECT * FROM ap_payments WHERE id=?').get(req.params.id));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/ap-payments/:id
router.delete('/:id', auth, (req, res) => {
  try {
    db.prepare("UPDATE ap_payments SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    res.json({ message: 'Payment deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
