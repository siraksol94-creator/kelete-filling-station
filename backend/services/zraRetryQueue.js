// zraRetryQueue.js — v1.13.94
//
// Background retry for orders whose ZRA saveSales attempt failed at
// sale time (VSDC unreachable, WAR crashed, network flap). Runs on
// a setInterval from server-tenant.js, sweeps every registered
// tenant DB, and re-fires saveSales for any orders still stuck in
// zra_status='FAILED'.
//
// Design choices
//   * Cap per-tick to BATCH_SIZE so a big backlog doesn't flood the
//     local VSDC WAR when it's just come back online.
//   * Cap total attempts per order at MAX_RETRIES so a permanently
//     bad order (e.g. product deleted after sale) doesn't spin
//     forever. Ops can retry manually via the endpoint below.
//   * ALS-wrap each tenant iteration so the ambient db proxy points
//     at the branch DB — every downstream helper (vsdc, product
//     lookups, stock snapshots) works with no extra wiring.
//   * Skip tenants where ZRA isn't enabled — no point trying.

const dbProxy = require('../config/database');
const { listTenants } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const vsdc = require('./vsdcClient');

const BATCH_SIZE  = 5;    // orders per tenant per tick
const TICK_MS     = 60_000;

// 2026-09-22 — MAX_RETRIES was 20. With graceMs 0 on the VPS that is one
// attempt a minute, so the queue gave up on an order after TWENTY MINUTES.
// A VPS incident that morning left VSDC unreachable for about six hours and
// stranded 374 tax invoices: every one burned its 20 attempts in the first
// twenty minutes and was abandoned for the rest of the day. They only
// recovered because the retry counter was reset by hand, three times.
//
// A cap is still wanted — a genuinely broken order (product deleted after the
// sale, say) must not spin for ever. So the cap stays, but it is now high
// enough to outlive a real outage, and the attempts spread out instead of
// hammering ZRA once a minute for days:
//
//   attempts   1-20   every tick (1 min)  — a blip recovers within minutes
//   attempts  21-60   every 5 minutes     — a long outage keeps trying
//   attempts  61+     every 30 minutes    — a stubborn one, checked hourly-ish
//
// That is ~20 minutes fast, ~3 hours medium, then days of slow attempts before
// the ceiling. An outage of any plausible length now heals by itself.
const MAX_RETRIES = 500;

// How long an order must wait between attempts, by how many it has already
// had. Returned as SQL so it can be applied in the same WHERE that picks the
// batch — the alternative is reading every failed order into node to filter.
const BACKOFF_SQL = `
  COALESCE(zra_last_attempt_at, '1970-01-01') <= datetime('now',
    CASE WHEN COALESCE(zra_retry_count, 0) < 20 THEN '-0 minutes'
         WHEN COALESCE(zra_retry_count, 0) < 60 THEN '-5 minutes'
         ELSE '-30 minutes' END)`;

// Retry ONE order — extracted so the manual endpoint can call it too.
// Assumes the ambient db proxy is scoped to the branch that owns the
// order (caller wraps in runWithDb when needed).
async function retryOrder(tenantId, orderId, opts = {}) {
  const db = dbProxy;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').get(orderId);
  if (!order) return { ok: false, reason: 'order not found' };
  if (order.zra_status === 'SIGNED') return { skipped: true, reason: 'already signed' };

  const zraItems = db.prepare(
    `SELECT oi.*, p.name AS product_name, p.code AS product_code,
            p.zra_item_cd, p.zra_item_cls_cd, p.zra_pkg_unit_cd,
            p.zra_qty_unit_cd, p.zra_vat_cat_cd, p.zra_excise_ty_cd, p.zra_rrp
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? AND (oi.deleted_at IS NULL)`
  ).all(orderId);
  if (zraItems.length === 0) return { ok: false, reason: 'no items to send' };

  // v1.13.139 — Look up the original cashier so ZRA's portal 'User' column
  // stays attributed to whoever rang the sale, not to the retry worker.
  // Falls back to 'System retry' (readable) if the original cashier row is
  // missing/deleted.
  const cashier = order.cashier_user_id
    ? db.prepare('SELECT id, first_name, last_name FROM users WHERE id = ?').get(order.cashier_user_id)
    : null;
  const actorId = cashier ? String(cashier.id) : 'system';
  const actorNm = cashier
    ? `${cashier.first_name || ''} ${cashier.last_name || ''}`.trim() || String(cashier.id)
    : 'System retry';
  // opts.saleDate is passed only by the backfill; the minute-by-minute sweep
  // leaves it undefined and behaves exactly as before.
  const zra = await vsdc.saveSales(tenantId, order, zraItems,
    { actor: actorId, actorNm, saleDate: opts.saleDate });

  if (zra.ok && zra.itemList) {
    // Stock chain follows same as the sale path.
    const snapshots = zraItems.map(it => ({
      itemCd: it.zra_item_cd || it.product_code || String(it.product_id),
      rsdQty: parseFloat(db.prepare('SELECT current_stock FROM products WHERE id = ?').get(it.product_id)?.current_stock || 0) || 0,
    }));
    try {
      zra.stockChain = await vsdc.saveSaleStockChain(tenantId, order, zra.itemList, snapshots, { isCredit: false });
      // 2026-08-28 — tick the flag. Without it the second sweep further
      // down THIS SAME tick sees a SIGNED order with no chain recorded
      // and sends the whole chain again, two seconds later. ZRA took both
      // (same sarNo, so most likely an overwrite rather than a double
      // count) but it should never have been sent twice.
      db.prepare('UPDATE orders SET zra_stock_chain_done = 1 WHERE id = ?').run(order.id);
    } catch (_) { /* non-fatal — flag stays 0 so the stock sweep retries */ }
  }
  return zra;
}

// Re-send ONLY the stock chain for an order that is already SIGNED.
//
// 2026-08-27 — companion to the deferred stock chain in orders.js. The
// invoice is fine; just saveStockItems + saveStockMaster need re-firing.
// Rebuilds the itemList the same way saveSales does so ZRA receives the
// identical lines. rsdQty is today's current_stock — the true residual
// now, which is what saveStockMaster is meant to carry.
async function retryStockChain(tenantId, orderId) {
  const db = dbProxy;
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL').get(orderId);
  if (!order) return { ok: false, reason: 'order not found' };
  if (order.zra_stock_chain_done) return { skipped: true, reason: 'already done' };
  if (order.zra_status !== 'SIGNED') return { skipped: true, reason: 'not signed' };

  const items = db.prepare(
    `SELECT oi.*, p.name AS product_name, p.code AS product_code,
            p.zra_item_cd, p.zra_item_cls_cd, p.zra_pkg_unit_cd,
            p.zra_qty_unit_cd, p.zra_vat_cat_cd, p.zra_excise_ty_cd, p.zra_rrp
       FROM order_items oi
       LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = ? AND (oi.deleted_at IS NULL)`
  ).all(order.id);
  if (items.length === 0) return { skipped: true, reason: 'no items' };

  // saveStockItems consumes VSDC-SHAPED lines (qty/prc/taxblAmt/vatAmt),
  // not raw order_items (quantity/unit_price). Build that shape from the
  // per-line fiscal SNAPSHOT written at sale time, so what ZRA receives
  // here matches what the invoice already reported — even if the
  // product's VAT category or RRP has been edited since.
  const vsdcItems = items.map((it, idx) => {
    const qty    = parseFloat(it.quantity) || 0;
    const prc    = parseFloat(it.unit_price) || 0;
    const totInc = qty * (prc - (parseFloat(it.discount) || 0));
    const taxbl  = it.zra_vat_taxbl_amt != null && it.zra_vat_taxbl_amt !== ''
      ? Number(it.zra_vat_taxbl_amt) : totInc;
    const vat    = it.zra_vat_amt != null && it.zra_vat_amt !== ''
      ? Number(it.zra_vat_amt) : 0;
    return {
      itemSeq:       idx + 1,
      itemCd:        vsdc.itemCodeFor(it) || String(it.product_id),
      itemClsCd:     it.zra_item_cls_cd || null,
      itemNm:        it.product_name,
      pkgUnitCd:     it.zra_pkg_unit_cd || 'NT',
      pkg:           1,
      qtyUnitCd:     it.zra_qty_unit_cd || 'U',
      qty,
      prc,
      splyAmt:       Number(totInc.toFixed(4)),
      // 2026-08-27 — the field is dcAmt, NOT totDcAmt. saveStockItems
      // maps `totDcAmt: it.dcAmt`, so setting totDcAmt here left it
      // undefined on the wire and VSDC rejected the call with
      // 910 "[<itemList><totDcAmt> : must not be null]". Both are set so
      // the shape survives either reading.
      dcAmt:         0,
      totDcAmt:      0,
      taxblAmt:      Number(taxbl.toFixed(4)),
      vatCatCd:      (it.zra_vat_cat_snap || it.zra_vat_cat_cd || 'A'),
      exciseTxCatCd: it.zra_excise_ty_cd || null,
      vatAmt:        Number(vat.toFixed(4)),
      taxAmt:        Number(vat.toFixed(4)),
      totAmt:        Number(totInc.toFixed(4)),
    };
  });

  const snapshots = vsdcItems.map((v, i) => ({
    itemCd: v.itemCd,
    rsdQty: parseFloat(db.prepare('SELECT current_stock FROM products WHERE id = ?').get(items[i].product_id)?.current_stock || 0) || 0,
  }));

  const res = await vsdc.saveSaleStockChain(tenantId, order, vsdcItems, snapshots, { isCredit: false });
  if (res?.ok !== false) {
    db.prepare('UPDATE orders SET zra_stock_chain_done = 1 WHERE id = ?').run(order.id);
    return { ok: true };
  }
  return { ok: false, reason: res?.error || 'stock chain failed' };
}

// Called every TICK_MS from server startup.
// 2026-08-28 — graceMs: how long an order must have sat untouched before
// THIS process will retry it.
//
// Sales are rung on the Electron till, and the till is now the owner of
// its own retries (graceMs 0 — it acts at once). The VPS runs the same
// worker with a 30-minute grace, so it only steps in for a till that has
// gone quiet — switched off, crashed, uninstalled. That removes the race
// where both machines re-sent the same sale a minute apart and ZRA
// answered 924 "invoice number already exists" to the loser.
//
// zra_last_attempt_at is bumped on every saveSales attempt and syncs with
// the order, so a till that is actively retrying keeps its own orders out
// of the VPS's reach without either side having to coordinate.
async function tick(opts = {}) {
  const graceMs = Number(opts.graceMs || 0);
  const graceMin = Math.max(0, Math.round(graceMs / 60000));
  const graceSql = graceMin > 0
    ? `AND COALESCE(zra_last_attempt_at, updated_at, created_at) <= datetime('now', '-${graceMin} minutes')`
    : '';
  let tenants = [];
  try { tenants = listTenants(); } catch (_) { tenants = []; }

  // 2026-08-28 — listTenants() reads master.db, and an Electron till has no
  // usable master.db: the path resolves into the install tree, which the
  // installer wipes on every update. So it returns [] and this whole sweep
  // did nothing — the till could never retry its own sales, which is
  // exactly the job it was just given.
  //
  // A till is a single tenant anyway. When there is no tenant registry,
  // fall back to the local database, which IS that one tenant.
  if (!tenants.length) {
    try {
      const local = dbProxy.defaultDb;
      const row = local.prepare('SELECT tenant_id FROM business_settings WHERE tenant_id IS NOT NULL LIMIT 1').get();
      if (row && row.tenant_id) {
        tenants = [{ slug: '(local)', tenant_id: row.tenant_id, __localDb: local }];
      }
    } catch (_) { /* no settings row yet — nothing to sweep */ }
  }
  if (!tenants.length) return;

  for (const t of tenants) {
    let db;
    if (t.__localDb) db = t.__localDb;
    else { try { db = getTenantDb(t.slug); } catch (_) { continue; } }
    // Cheap skip: if ZRA isn't enabled on this tenant, don't waste a query.
    try {
      const cfg = db.prepare(
        `SELECT zra_enabled FROM business_settings WHERE tenant_id = ? LIMIT 1`
      ).get(t.tenant_id);
      if (!cfg || !cfg.zra_enabled) continue;
    } catch (_) { continue; }

    await dbProxy.runWithDb(db, async () => {
      const rows = db.prepare(`
        SELECT id FROM orders
         WHERE zra_status = 'FAILED'
           AND deleted_at IS NULL
           -- 924_MISMATCH is not a transient failure and retrying cannot fix
           -- it: ZRA holds that invoice number for a DIFFERENT sale, and
           -- vsdcClient deliberately refuses to attach someone else's receipt
           -- (see its SAFETY GUARD). Left in the queue it would retry to the
           -- ceiling and bury a problem that needs a person to look at it.
           AND COALESCE(zra_error_code, '') <> '924_MISMATCH'
           AND COALESCE(zra_retry_count, 0) < ?
           AND ${BACKOFF_SQL}
           ${graceSql}
         ORDER BY id ASC
         LIMIT ?
      `).all(MAX_RETRIES, BATCH_SIZE);

      for (const r of rows) {
        try {
          const result = await retryOrder(t.tenant_id, r.id);
          if (result?.ok) {
            console.log(`[zra-retry] ${t.slug} order#${r.id} → SIGNED`);
          }
        } catch (e) {
          console.error(`[zra-retry] ${t.slug} order#${r.id} threw:`, e.message);
        }
      }

      // 2026-08-27 — orders that fiscalised but whose STOCK CHAIN never
      // finished. Since the sale response stopped waiting for
      // saveStockItems/saveStockMaster (orders.js), a crash between the
      // response and the chain would otherwise leave the sale signed with
      // its stock never reported to ZRA — and nothing else retries a
      // chain for an already-signed order.
      //
      // Deliberately NOT gated on zra_retry_count: that counter belongs
      // to saveSales attempts, and burning it here could strand an order
      // whose invoice is perfectly fine.
      const stockRows = db.prepare(`
        SELECT id FROM orders
         WHERE zra_status = 'SIGNED'
           AND COALESCE(zra_stock_chain_done, 0) = 0
           AND deleted_at IS NULL
           ${graceSql}
         ORDER BY id ASC
         LIMIT ?
      `).all(BATCH_SIZE);

      for (const r of stockRows) {
        try {
          const res = await retryStockChain(t.tenant_id, r.id);
          if (res?.ok) console.log(`[zra-retry] ${t.slug} order#${r.id} stock chain → done`);
        } catch (e) {
          console.error(`[zra-retry] ${t.slug} order#${r.id} stock chain threw:`, e.message);
        }
      }
    });
  }
}

let timer = null;
function start(opts = {}) {
  if (timer) return;
  const graceMs = Number(opts.graceMs || 0);
  const run = () => tick({ graceMs }).catch(e => console.error('[zra-retry] tick failed:', e.message));
  // Small stagger so the first tick doesn't race the boot-time HQ
  // mirror sweep on the same event loop.
  setTimeout(() => {
    run();
    timer = setInterval(run, TICK_MS);
  }, 15_000);
  const who = graceMs > 0
    ? `safety net — only orders untouched for ${Math.round(graceMs / 60000)}m`
    : 'primary owner — retries immediately';
  console.log(`[zra-retry] queue armed (${who}) — polling every ${TICK_MS / 1000}s (batch ${BATCH_SIZE}, max ${MAX_RETRIES} attempts per order)`);
}

module.exports = { start, tick, retryOrder, BATCH_SIZE, MAX_RETRIES, TICK_MS };
