const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

const { ledgerRows, ledgerTotals } = require('../services/supplierLedger');

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

router.post('/', auth, (req, res) => {
  try {
    const { name, type, phone, email, address, contact_person } = req.body;
    const tenantId = syncConfig.getTenantId(req);
    const { branchId, deviceId } = syncConfig.getConfig();
    const info = db.prepare(
      "INSERT INTO suppliers (name, type, phone, email, address, contact_person, sync_id, tenant_id, branch_id, device_id, synced, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))"
    ).run(name, type, phone, email, address, contact_person, randomUUID(), tenantId, branchId, deviceId);
    const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', auth, (req, res) => {
  try {
    const { name, type, phone, email, address, contact_person } = req.body;
    db.prepare(
      "UPDATE suppliers SET name=?, type=?, phone=?, email=?, address=?, contact_person=?, updated_at=datetime('now'), synced=0 WHERE id=?"
    ).run(name, type, phone, email, address, contact_person, req.params.id);
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

    if (grnCount.cnt > 0 || apCount.cnt > 0) {
      return res.status(400).json({ error: 'Cannot delete this supplier. They have existing GRN or payment records.' });
    }

    db.prepare("UPDATE suppliers SET deleted_at=datetime('now'), updated_at=datetime('now'), synced=0 WHERE id=?").run(req.params.id);
    res.json({ message: 'Supplier deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
