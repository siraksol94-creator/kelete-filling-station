const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

const { ledgerRows, ledgerTotals, supplierStatement, hasTable } = require('../services/supplierLedger');

// 2026-11-28 — Suppliers rebuild. One cleaner for create and edit: name is
// required and unique (ignoring case and spaces) among living suppliers;
// "supplies" is fuel / shop / both; status Active or Inactive. A field left
// out of an edit keeps what the supplier had, so older screens can't wipe it.
const SUPPLIES = new Set(['fuel', 'shop', 'both']);
const FIELDS = ['name', 'type', 'phone', 'email', 'address', 'contact_person', 'supplies', 'tpin', 'bank_name', 'bank_account', 'payment_terms', 'status'];
function cleanSupplier(body, existing, tenantId) {
  const out = {};
  for (const f of FIELDS) {
    const v = body[f] === undefined ? (existing ? existing[f] : null) : body[f];
    out[f] = v === null || v === undefined ? null : String(v).trim() || null;
  }
  if (!out.name) return { error: 'Give the supplier a name.' };
  if (out.supplies) {
    out.supplies = out.supplies.toLowerCase();
    if (!SUPPLIES.has(out.supplies)) return { error: 'Supplies must be fuel, shop or both.' };
  }
  out.status = out.status === 'Inactive' ? 'Inactive' : 'Active';
  if (out.tpin && !/^\d{10}$/.test(out.tpin)) return { error: 'A TPIN is 10 digits.' };
  const clash = db.prepare(`SELECT id, name FROM suppliers WHERE deleted_at IS NULL AND tenant_id = ?
                               AND LOWER(TRIM(name)) = LOWER(?) AND id != ?`).get(tenantId, out.name, existing ? existing.id : -1);
  if (clash) return { error: `There is already a supplier called "${clash.name}".`, code: 'DUPLICATE_NAME' };
  return { row: out };
}

// 2026-11-28 — balances come from the same ledger as Account Payables
// (services/supplierLedger.js): GRNs + fuel deliveries - payments (incl. 1Card
// offsets) - credit notes. `outstanding` > 0: we owe them; < 0: in credit.
router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const ledger = new Map(ledgerRows(db, req.user.tenantId, { activeOnly: false }).map((r) => [r.id, r]));
    const rows = db.prepare('SELECT * FROM suppliers WHERE deleted_at IS NULL AND tenant_id = ? ORDER BY name').all(req.user.tenantId);
    res.json(rows.map((s) => {
      const l = ledger.get(s.id) || {};
      return {
        ...s,
        total_purchases: l.total_purchases || 0,
        fuel_purchases: l.fuel_purchases || 0,
        total_paid: l.total_paid || 0,
        offset_1card: l.offset_1card || 0,
        total_credits: l.total_credits || 0,
        outstanding: l.balance || 0,
        last_purchase_date: l.last_purchase_date || null,
      };
    }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/stats', auth, readOnlyGuard, (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const t = ledgerTotals(ledgerRows(db, tenantId, { activeOnly: false }));
    const active = db.prepare("SELECT COUNT(*) AS cnt FROM suppliers WHERE deleted_at IS NULL AND tenant_id = ? AND status = 'Active'").get(tenantId);
    res.json({ totalSuppliers: t.suppliers, activeAccounts: active.cnt, outstanding: t.outstanding, owed: t.owed, inCredit: t.inCredit });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Statement: every purchase, payment, 1Card offset and credit note, with a
// running balance. ?from / ?to (YYYY-MM-DD) give an opening balance.
router.get('/:id/statement', auth, readOnlyGuard, (req, res) => {
  try {
    const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined);
    const st = supplierStatement(db, req.user.tenantId, parseInt(req.params.id, 10), { from: ymd(req.query.from), to: ymd(req.query.to) });
    if (!st) return res.status(404).json({ error: 'Supplier not found.' });
    res.json(st);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', auth, (req, res) => {
  try {
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const c = cleanSupplier(req.body || {}, null, tenantId);
    if (c.error) return res.status(c.code ? 409 : 400).json({ error: c.error, code: c.code });
    const r = c.row;
    const info = db.prepare(
      "INSERT INTO suppliers (name, type, phone, email, address, contact_person, supplies, tpin, bank_name, bank_account, payment_terms, status, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))"
    ).run(r.name, r.type, r.phone, r.email, r.address, r.contact_person, r.supplies, r.tpin, r.bank_name, r.bank_account, r.payment_terms, r.status, randomUUID(), tenantId, branchId, deviceId);
    const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', auth, (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Supplier not found.' });
    const c = cleanSupplier(req.body || {}, existing, existing.tenant_id);
    if (c.error) return res.status(c.code ? 409 : 400).json({ error: c.error, code: c.code });
    const r = c.row;
    db.prepare(
      "UPDATE suppliers SET name=?, type=?, phone=?, email=?, address=?, contact_person=?, supplies=?, tpin=?, bank_name=?, bank_account=?, payment_terms=?, status=?, updated_at=datetime('now'), synced=0 WHERE id=?"
    ).run(r.name, r.type, r.phone, r.email, r.address, r.contact_person, r.supplies, r.tpin, r.bank_name, r.bank_account, r.payment_terms, r.status, req.params.id);
    const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(req.params.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', auth, (req, res) => {
  try {
    const supplier = db.prepare('SELECT sync_id FROM suppliers WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found.' });

    const grnCount = db.prepare('SELECT COUNT(*) AS cnt FROM grn WHERE supplier_sync_id = ? AND deleted_at IS NULL').get(supplier.sync_id);
    const apCount  = db.prepare('SELECT COUNT(*) AS cnt FROM ap_payments WHERE supplier_sync_id = ? AND deleted_at IS NULL').get(supplier.sync_id);

    let fuelCount = { cnt: 0 };
    if (hasTable(db, 'fuel_deliveries')) {
      try { fuelCount = db.prepare('SELECT COUNT(*) AS cnt FROM fuel_deliveries WHERE supplier_id = ?').get(req.params.id); } catch (_) { /* older schema */ }
    }
    if (grnCount.cnt > 0 || apCount.cnt > 0 || fuelCount.cnt > 0) {
      return res.status(400).json({ error: 'This supplier has GRNs, fuel deliveries or payments, so it can\'t be deleted. Mark it Inactive instead.' });
    }

    db.prepare("UPDATE suppliers SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    res.json({ message: 'Supplier deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
