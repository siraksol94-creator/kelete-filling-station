/**
 * hqSuppliers.js â€” HQ-level supplier master + AP tracking.
 *
 * AP per supplier is computed live from the source tables, never stored:
 *   purchases = SUM(hq_purchases.total_amount  WHERE supplier matches)
 *   payments  = SUM(hq_supplier_payments.amount WHERE supplier matches)
 *   balance   = purchases - payments   (positive = HQ owes supplier)
 *
 * Matching is a UNION: rows linked by supplier_id (preferred) + rows whose
 * supplier_name matches the master name case-insensitively (fallback for
 * legacy purchases entered before the master existed). This means renaming
 * a supplier here AFTER you have legacy purchases will detach those â€” fix
 * is to also re-save the affected purchase row, which is rare.
 *
 * Auth: hqAuth (JWT only).
 */
const bcrypt = require('bcrypt');
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const { masterDb } = require('../config/masterDb');
const db = require('../config/database');

// v1.10.76 â€” On this deploy HQ runs as the single-tenant "bare host"
// (keletezm.com, no subdomain), which means the tenant middleware
// doesn't fire and all HQ requests hit backend/kelete.db (the
// defaultDb). Earlier v1.10.72â€“75 wrote to tenants/hq.db instead â€”
// wrong file, empty on this deploy. Point every HQ tenant read/write
// at db.defaultDb explicitly so it's stable regardless of any
// AsyncLocalStorage routing.
function getHqDb() {
  return db.defaultDb;
}
// HQ_TENANT_ID â€” the tenant_id value AR / AP / Cash Book pages filter
// by. On this deploy every existing row in kelete.db has
// tenant_id='local-only' (auth.js falls back to that string when
// sync_config is empty), so we use it verbatim for every new HQ row.
const HQ_TENANT_ID = 'local-only';

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

function nextPaymentNumber() {
  // v1.10.72 â€” count HSP-prefixed payments in hq.db.ap_payments (single
  // source of truth). Falls back to master.hq_supplier_payments count
  // when the tenant DB isn't available yet â€” keeps numbering monotonic
  // across the migration window.
  let seq = 0;
  try {
    const hqDb = getHqDb();
    if (hqDb) {
      seq = hqDb.prepare(`SELECT COUNT(*) AS n FROM ap_payments WHERE payment_number LIKE 'HSP-%'`).get()?.n || 0;
    }
  } catch (_) { /* fall through */ }
  if (seq === 0) {
    // Migration fallback â€” respect the old counter so we don't collide.
    seq = masterDb.prepare(`SELECT COUNT(*) AS n FROM hq_supplier_payments`).get()?.n || 0;
  }
  const yr = new Date().getFullYear();
  return `HSP-${yr}-${String(seq + 1).padStart(5, '0')}`;
}

// Aggregate purchases + payments + credit_notes for one supplier.
// v1.10.52 â€” was reading `hq_purchases.total_amount` which committed AP
// the moment HQ typed a PO â€” even before the branch confirmed receipt
// and before HQ generated a GRN. It also ignored supplier credit notes.
// Now mirrors Liquor AP (routes/accountPayables.js):
//   purchases = SUM(hq_grns.final_payable)             â† goods actually received
//   payments  = SUM(hq_supplier_payments.amount)
//   credits   = SUM(hq_supplier_credit_notes.amount)   â† now included
//   balance   = purchases âˆ’ payments âˆ’ credits
// hq_grns.final_payable already nets the invoice against the GRN-time CNs,
// but standalone CNs recorded later against the same supplier still need
// to be deducted separately.
// v1.10.75 â€” everything (purchases + payments + CNs) now reads from
// HQ tenant DB. Master.hq_* tables kept as a frozen audit trail; no
// code path reads them here anymore. Aligns with the memoised
// architecture: Suppliers/AP is HQ-only, HQ IS a tenant.
function getBalances(supplierId, supplierName) {
  const hqDb = getHqDb();
  if (!hqDb) {
    return { purchase_count: 0, purchases_total: 0, payment_count: 0, payments_total: 0,
             credit_count: 0, credits_total: 0, balance: 0, currency: 'K' };
  }
  const purchases = hqDb.prepare(`
    SELECT COALESCE(SUM(total_amount), 0) AS s, COUNT(*) AS c
      FROM grn
     WHERE deleted_at IS NULL
       AND (supplier_id = ? OR LOWER(COALESCE(supplier_name,'')) = LOWER(?))
  `).get(supplierId, supplierName);
  // v1.10.79 â€” supplier currency = the majority cost_currency across the
  // supplier's GRNs. NULL rows count as 'K' (legacy default from the
  // migration script). If a supplier has no GRNs yet, default to 'K'.
  const ccyRow = hqDb.prepare(`
    SELECT COALESCE(NULLIF(UPPER(cost_currency), ''), 'K') AS ccy, COUNT(*) AS c
      FROM grn
     WHERE deleted_at IS NULL
       AND (supplier_id = ? OR LOWER(COALESCE(supplier_name,'')) = LOWER(?))
     GROUP BY COALESCE(NULLIF(UPPER(cost_currency), ''), 'K')
     ORDER BY c DESC
     LIMIT 1
  `).get(supplierId, supplierName);
  const currency = ccyRow ? ccyRow.ccy : 'K';
  const payments = hqDb.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c
      FROM ap_payments
     WHERE deleted_at IS NULL
       AND (supplier_id = ? OR LOWER(COALESCE(supplier_name,'')) = LOWER(?))
  `).get(supplierId, supplierName);
  // 2026-09-05 â€” every credit note, and separately the part already netted
  // into grn.total_amount (which holds final_payable = subtotal âˆ’ cn_total).
  // Purchases are then reported GROSS and every credit deducted once, so this
  // page reads the same way as GRN Archive and Account Payables:
  //     purchases 12,049,571.63 âˆ’ credits 150,181.78 = 11,899,389.85
  // Tenant supplier_credit_notes has no supplier_name column â€” filter by
  // supplier_id only. The migration script always populates it.
  const credits = hqDb.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS s, COUNT(*) AS c,
           COALESCE(SUM(CASE WHEN grn_sync_id IS NOT NULL THEN amount ELSE 0 END), 0) AS attached
      FROM supplier_credit_notes
     WHERE deleted_at IS NULL
       -- A depot's credit counts once HQ has confirmed it, not before.
       AND (raised_by_branch IS NULL OR branch_confirmed_at IS NOT NULL)
       AND supplier_id = ?
  `).get(supplierId);
  const grossPurchases = purchases.s + credits.attached;
  return {
    purchase_count:  purchases.c,
    purchases_total: grossPurchases,
    payment_count:   payments.c,
    payments_total:  payments.s,
    credit_count:    credits.c,
    credits_total:   credits.s,
    balance:         grossPurchases - payments.s - credits.s,
    currency,
  };
}

// v1.10.75 â€” helpers for the CRUD/list/detail routes. Every read AND write
// now targets HQ's tenant DB (hq.db) so Account Payables and HQ Suppliers
// share one source of truth.
function requireHqDb(res) {
  const hqDb = getHqDb();
  if (!hqDb) {
    res.status(500).json({ error: 'HQ tenant DB not accessible.' });
    return null;
  }
  return hqDb;
}

// GET /api/hq/suppliers â€” list with AP balance per row.
router.get('/', hqAuth, (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    const suppliers = hqDb.prepare(`
      SELECT * FROM suppliers WHERE COALESCE(status, 'Active') != 'Deleted' AND deleted_at IS NULL
       ORDER BY name COLLATE NOCASE ASC
    `).all();
    const enriched = suppliers.map(s => ({ ...s, ...getBalances(s.id, s.name) }));
    res.json({ suppliers: enriched });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/hq/suppliers/:id â€” detail with purchases + payments + credits history.
router.get('/:id', hqAuth, (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    const s = hqDb.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });
    const balances = getBalances(s.id, s.name);
    // Purchases list from hq.db.grn (migrated from master.hq_grns). Column
    // aliasing preserves the frontend response shape verbatim.
    const purchases = hqDb.prepare(`
      SELECT id, grn_number AS purchase_number, date,
             total_amount,
             COALESCE(status, 'Completed') AS status,
             supplier_invoice_number AS invoice_number,
             (SELECT first_name || ' ' || last_name FROM users u WHERE u.id = grn.created_by) AS created_by_name,
             linked_purchase_number AS po_number,
             COALESCE(NULLIF(UPPER(cost_currency), ''), 'K') AS currency
        FROM grn
       WHERE deleted_at IS NULL
         AND (supplier_id = ? OR LOWER(COALESCE(supplier_name,'')) = LOWER(?))
       ORDER BY date DESC, id DESC
       LIMIT 200
    `).all(s.id, s.name);
    // Payments list â€” same shape as the frontend expects (v1.10.72
    // aliasing kept: date â†’ payment_date, paid_from â†’ payment_method).
    const payments = hqDb.prepare(`
      SELECT id,
             payment_number,
             amount,
             date AS payment_date,
             paid_from AS payment_method,
             NULL AS reference,
             description AS notes,
             (SELECT first_name || ' ' || last_name FROM users u WHERE u.id = ap_payments.created_by) AS created_by_name
        FROM ap_payments
       WHERE deleted_at IS NULL
         AND (supplier_id = ? OR LOWER(COALESCE(supplier_name,'')) = LOWER(?))
       ORDER BY date DESC, id DESC
       LIMIT 200
    `).all(s.id, s.name);
    const credits = hqDb.prepare(`
      SELECT id, credit_note_number, date, amount, reason, reference, notes,
             (SELECT first_name || ' ' || last_name FROM users u WHERE u.id = supplier_credit_notes.created_by) AS created_by_name,
             grn_sync_id
        FROM supplier_credit_notes
       WHERE deleted_at IS NULL
         AND supplier_id = ?
       ORDER BY date DESC, id DESC
       LIMIT 200
    `).all(s.id);
    res.json({ supplier: { ...s, ...balances }, purchases, payments, credits });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/suppliers â€” create.
router.post('/', hqAuth, (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    // 2026-08-30 â€” tpin. The column already existed and was being written by
    // the ZRA supplier resolver and the orphan backfill, but no route read or
    // wrote it, so it could not be seen or corrected from anywhere.
    const { name, phone, email, address, contact_person, notes, tpin } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const cleanTpin = (tpin || '').toString().trim() || null;
    const dup = hqDb.prepare(
      `SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?) AND COALESCE(status,'Active') != 'Deleted' AND deleted_at IS NULL`
    ).get(name.trim());
    if (dup) return res.status(400).json({ error: 'A supplier with this name already exists' });
    const info = hqDb.prepare(`
      INSERT INTO suppliers (name, phone, email, address, contact_person, tpin, status,
                              sync_id, tenant_id, branch_id, device_id, synced,
                              created_at, updated_at)
      VALUES (?,?,?,?,?,?, 'Active', ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    `).run(name.trim(), phone || null, email || null, address || null, contact_person || null,
           cleanTpin,
           randomUUID(), HQ_TENANT_ID, null, null);
    const row = hqDb.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(info.lastInsertRowid);
    res.status(201).json({ ...row, ...getBalances(row.id, row.name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/hq/suppliers/:id â€” edit.
router.put('/:id', hqAuth, (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    const s = hqDb.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });
    const { name, phone, email, address, contact_person, notes, status, tpin } = req.body || {};
    // Undefined means "not sent" â€” keep what is there. An empty string is a
    // deliberate clear. Distinguishing them matters: an older client that does
    // not send tpin must not wipe one the ZRA resolver recorded.
    const nextTpin = (tpin === undefined) ? s.tpin : ((tpin || '').toString().trim() || null);
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (name.trim().toLowerCase() !== s.name.toLowerCase()) {
      const dup = hqDb.prepare(
        `SELECT id FROM suppliers WHERE LOWER(name) = LOWER(?) AND id != ? AND COALESCE(status,'Active') != 'Deleted' AND deleted_at IS NULL`
      ).get(name.trim(), req.params.id);
      if (dup) return res.status(400).json({ error: 'Another supplier already uses this name' });
    }
    hqDb.prepare(`
      UPDATE suppliers
         SET name = ?, phone = ?, email = ?, address = ?, contact_person = ?,
             tpin = ?, status = ?, updated_at = datetime('now'), synced = 0
       WHERE id = ?
    `).run(name.trim(), phone || null, email || null, address || null, contact_person || null,
           nextTpin, (status === 'Inactive' ? 'Inactive' : 'Active'), req.params.id);
    const row = hqDb.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    res.json({ ...row, ...getBalances(row.id, row.name) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/hq/suppliers/:id â€” soft delete (kept for AP history).
// Everything on record against one supplier. Used to refuse a delete rather
// than to describe it - a supplier who has ever been transacted with cannot
// be removed, only left alone.
//
// 2026-09-05 â€” the old check looked at purchases and payments only, so a
// supplier carrying credit notes, empty returns or HQ purchases deleted
// clean away. It also soft-deleted anything with history, which is how
// CHAMBISHI METALS PLC came to be a deleted supplier still holding a live
// K30,000 payment in the Cash Book.
function supplierHistory(hqDb, s) {
  const found = [];
  const count = (db, sql, ...args) => {
    try { return db.prepare(sql).get(...args)?.n || 0; } catch (_) { return 0; }
  };
  const add = (label, n) => { if (n > 0) found.push(`${n} ${label}`); };

  add('GRN(s)', count(hqDb,
    `SELECT COUNT(*) AS n FROM grn WHERE deleted_at IS NULL
      AND (supplier_id = ? OR supplier_sync_id = ?)`, s.id, s.sync_id || ''));
  add('payment(s)', count(hqDb,
    `SELECT COUNT(*) AS n FROM ap_payments WHERE deleted_at IS NULL
      AND (supplier_id = ? OR supplier_sync_id = ?)`, s.id, s.sync_id || ''));
  add('credit note(s)', count(hqDb,
    `SELECT COUNT(*) AS n FROM supplier_credit_notes WHERE deleted_at IS NULL
      AND (supplier_id = ? OR supplier_sync_id = ?)`, s.id, s.sync_id || ''));
  add('empty return(s)', count(hqDb,
    `SELECT COUNT(*) AS n FROM empty_returns WHERE deleted_at IS NULL
      AND (supplier_id = ? OR supplier_sync_id = ?)`, s.id, s.sync_id || ''));
  add('ZRA supplier mapping', count(hqDb,
    `SELECT COUNT(*) AS n FROM zra_supplier_map
      WHERE supplier_id = ? OR supplier_sync_id = ?`, s.id, s.sync_id || ''));

  // master.db matches on name â€” hq_purchases has no supplier_sync_id.
  if (masterDb && s.name) {
    add('HQ purchase(s)', count(masterDb,
      `SELECT COUNT(*) AS n FROM hq_purchases
        WHERE supplier_id = ? OR UPPER(TRIM(COALESCE(supplier_name,''))) = UPPER(TRIM(?))`,
      s.id, s.name));
    add('HQ GRN(s)', count(masterDb,
      `SELECT COUNT(*) AS n FROM hq_grns WHERE deleted_at IS NULL
        AND (supplier_id = ? OR UPPER(TRIM(COALESCE(supplier_name,''))) = UPPER(TRIM(?)))`,
      s.id, s.name));
  }
  return found;
}

// DELETE /api/hq/suppliers/:id
// Body: { password } â€” an Administrator's password, checked HERE rather than
// in the browser. A confirm dialog only stops an accident; the check has to
// be server-side or the endpoint is still one curl away from wiping a
// supplier.
router.delete('/:id', hqAuth, async (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    const s = hqDb.prepare(`SELECT * FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });

    const password = String(req.body?.password || '');
    if (!password) return res.status(400).json({ error: 'Administrator password is required to delete a supplier.' });
    const admins = hqDb.prepare(
      `SELECT password FROM users WHERE role = 'Administrator' AND deleted_at IS NULL`
    ).all();
    let ok = false;
    for (const a of admins) {
      // eslint-disable-next-line no-await-in-loop
      if (a.password && await bcrypt.compare(password, a.password)) { ok = true; break; }
    }
    if (!ok) return res.status(401).json({ error: 'Wrong administrator password.' });

    const history = supplierHistory(hqDb, s);
    if (history.length > 0) {
      return res.status(409).json({
        error: `"${s.name}" cannot be deleted â€” ${history.join(', ')} on record. `
             + 'Deleting would leave those documents pointing at a supplier that no longer exists.',
        history,
      });
    }

    // Nothing references it, so it goes properly rather than being hidden.
    hqDb.prepare(`DELETE FROM suppliers WHERE id = ?`).run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/hq/suppliers/:id/payments â€” record a payment to this supplier.
router.post('/:id/payments', hqAuth, (req, res) => {
  try {
    const hqDb = requireHqDb(res); if (!hqDb) return;
    const s = hqDb.prepare(`SELECT id, name, sync_id FROM suppliers WHERE id = ?`).get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Supplier not found' });
    const { amount, payment_date, payment_method, reference, notes } = req.body || {};
    const amt = parseFloat(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'amount must be > 0' });
    if (!payment_date) return res.status(400).json({ error: 'payment_date is required' });
    const method = ['Cash', 'Bank', 'Mobile Money'].includes(payment_method) ? payment_method : 'Cash';
    const createdBy = req.user.id || null;
    const paymentNum = nextPaymentNumber();
    const cashAmt = method === 'Cash'         ? amt : 0;
    const bankAmt = method === 'Bank'         ? amt : 0;
    const momoAmt = method === 'Mobile Money' ? amt : 0;
    const description = notes
      ? notes
      : (reference ? `${s.name} Â· ${reference}` : s.name);
    hqDb.prepare(`
      INSERT INTO ap_payments (payment_number, supplier_id, supplier_sync_id, supplier_name,
                                amount, cash_amount, bank_amount, momo_amount,
                                description, date, paid_from, created_by,
                                sync_id, tenant_id, branch_id, device_id,
                                synced, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
    `).run(
      paymentNum, s.id, s.sync_id, s.name,
      amt, cashAmt, bankAmt, momoAmt,
      description, payment_date, method, createdBy,
      randomUUID(), HQ_TENANT_ID, null, null
    );
    res.status(201).json({ success: true, balance: getBalances(s.id, s.name).balance });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/hq/supplier-payments/:id â€” reverse a payment.
// v1.10.72 â€” payments live in HQ tenant DB now. Soft-delete via
// deleted_at so Cash Book's WHERE deleted_at IS NULL drops the row
// while keeping the audit trail.
router.delete('/payments/:id', hqAuth, (req, res) => {
  try {
    const hqDb = getHqDb();
    if (!hqDb) return res.status(500).json({ error: 'HQ tenant DB not accessible.' });
    const p = hqDb.prepare(`SELECT * FROM ap_payments WHERE id = ? AND deleted_at IS NULL`).get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    hqDb.prepare(`
      UPDATE ap_payments
         SET deleted_at = datetime('now'),
             updated_at = datetime('now'),
             synced     = 0
       WHERE id = ?
    `).run(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
