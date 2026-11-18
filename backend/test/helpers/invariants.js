// D5 — data-integrity checks run after tests that change data.
// Each returns a list of violations (empty = healthy).

const near = (a, b) => Math.abs(Number(a || 0) - Number(b || 0)) < 0.0001;

// tanks.current_volume must equal the sum of that tank's ledger rows.
function tankLedger(db) {
  return db.prepare(`
    SELECT t.id, t.code, t.current_volume AS cached,
           COALESCE((SELECT SUM(m.litres) FROM tank_movements m WHERE m.tank_id = t.id), 0) AS ledger
      FROM tanks t
  `).all().filter(r => !near(r.cached, r.ledger))
    .map(r => `tank ${r.code}: cached ${r.cached} != ledger ${r.ledger}`);
}

// products.current_stock must equal the sum of live stock movements, for
// products that have movements.
function productStock(db) {
  return db.prepare(`
    SELECT p.name, p.current_stock AS cached, SUM(sm.quantity) AS moved
      FROM products p JOIN stock_movements sm ON sm.product_sync_id = p.sync_id AND sm.deleted_at IS NULL
     WHERE p.deleted_at IS NULL
     GROUP BY p.id
  `).all().filter(r => !near(r.cached, r.moved))
    .map(r => `product ${r.name}: cached ${r.cached} != movements ${r.moved}`);
}

// order lines that reports cannot join (missing order_sync_id).
function unlinkedOrderLines(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE order_sync_id IS NULL').get().n;
}

// audit_log must never shrink and its guards must be in place.
function auditIntact(db, previousCount = 0) {
  const out = [];
  const n = db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n;
  if (n < previousCount) out.push(`audit_log shrank from ${previousCount} to ${n}`);
  for (const t of ['trg_audit_log_no_update', 'trg_audit_log_no_delete']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(t)) out.push(`missing ${t}`);
  }
  return out;
}

module.exports = { tankLedger, productStock, unlinkedOrderLines, auditIntact };
