/**
 * transfers.js — cross-branch stock transfers.
 *
 * Universal — works whether the caller is on a per-branch subdomain
 * (kassumbalesa1.keletezm.com) or the HQ host (keletezm.com). The transfer
 * rows live in master.db so source AND destination read the same record
 * without cross-DB joins. Per-branch stock is updated by opening each
 * branch's tenant DB on demand via getTenantDb(slug).
 *
 * State machine on stock_transfers.status:
 *   PENDING   — source dispatched, NO stock movement yet (in transit).
 *               v1.9.22 — source no longer decrements at creation. The
 *               sent-qty leaves source's books only when the destination
 *               confirms (or partially confirms) receipt. This keeps the
 *               source's Sales Bin Card honest while goods are in flight.
 *               Trade-off: source can sell from this stock during transit;
 *               availability check at create time subtracts pending
 *               outgoing transfers to prevent over-promising.
 *   RECEIVED  — destination confirmed. Source posts transfer_out (-sentQty),
 *               destination posts transfer_in (+recvQty), variance for
 *               the difference (lost / damaged in transit).
 *   CANCELLED — source aborted before destination received. No stock
 *               movement at all (nothing was deducted to reverse).
 *
 * Auth: hqAuth (JWT only) — every Kelete admin can move stock between
 * branches they're an admin on. Per-role gates can be added later.
 */
const express = require('express');
const router  = express.Router();
const jwt = require('jsonwebtoken');
const { randomUUID } = require('crypto');
const crypto = require('crypto');
const { listTenants, isRegistered, masterDb } = require('../config/masterDb');
const { getTenantDb } = require('../config/tenantDb');
const { conversionToBase } = require('../config/unitsHelper');
const dbProxy = require('../config/database');
const vsdc = require('../services/vsdcClient');

// 2026-08-28 — a till forwarding a transfer cannot present a JWT the VPS will
// accept: the two sign with different secrets (a packaged till ships no .env,
// so it falls back to the built-in default while the VPS has a real one). The
// forwarded token came back 401, and the browser's 401 handler logged the
// operator out mid-receive.
//
// So accept a second credential for machine-to-machine calls: the branch's
// shared secret, the same one the VSDC proxy already authenticates with
// (business_settings.zra_proxy_secret) and compared the same way — length
// check first, then timingSafeEqual against every row.
//
// The secret proves WHICH MACHINE is calling. The operator's name rides along
// in X-Branch-Actor for the audit trail only; it grants nothing on its own.
function resolveBranchSecret(presented) {
  if (!presented) return null;
  let rows = [];
  try {
    rows = dbProxy.prepare('SELECT id, tenant_id, zra_proxy_secret FROM business_settings').all();
  } catch (_) { return null; }
  const a = Buffer.from(presented);
  for (const r of rows) {
    const expected = String(r.zra_proxy_secret || '');
    if (!expected || expected.length !== presented.length) continue;
    try {
      if (crypto.timingSafeEqual(a, Buffer.from(expected))) return r;
    } catch (_) { /* length guard above should prevent this */ }
  }
  return null;
}

function hqAuth(req, res, next) {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET || 'kelete-pro-secret-key-2026');
      return next();
    } catch (_) { /* not a token we signed — try the branch secret below */ }
  }
  const row = resolveBranchSecret(req.header('X-Branch-Secret'));
  if (row) {
    const actor = String(req.header('X-Branch-Actor') || '').slice(0, 80);
    req.user = { id: null, firstName: actor || 'Branch till', email: actor || 'branch-till', viaBranchSecret: true };
    return next();
  }
  return res.status(401).json({ error: token ? 'Invalid token' : 'Access denied' });
}


// 2026-08-29 — same orphan bug fixed in hqGrns.js (v1.13.157), and it is here
// too: both stock_movements inserts below stamped tenant_id NULL. The branch
// pull filters `WHERE tenant_id = ?` and NULL matches nothing, so a transfer
// confirmed on the VPS produced a movement the branch could never receive.
//
// Symptom seen on a real till: the web Sales Bin Card showed transfer_in 120
// and a closing balance of 1,099; the same card on the till showed neither —
// three movements instead of four, closing 979. The movement existed, owned
// by nobody.
//
// Ownership comes from the branch database being written to. device_id stays
// NULL on purpose: the pull excludes rows whose device_id matches the asking
// device, so stamping the branch's own device would hide the movement from
// the very till that needs it.
function branchSyncIds(branchDb) {
  let tenantId = null, branchId = null;
  try {
    tenantId = branchDb.prepare(
      'SELECT tenant_id FROM business_settings WHERE tenant_id IS NOT NULL LIMIT 1'
    ).get()?.tenant_id || null;
  } catch (_) { /* unreadable — leave null */ }
  try {
    branchId = branchDb.prepare(
      "SELECT value FROM sync_config WHERE key = 'branch_id' LIMIT 1"
    ).get()?.value || null;
  } catch (_) { /* no sync_config on this DB */ }
  return { tenantId, branchId };
}

function branchName(slug) {
  try {
    const t = listTenants().find(t => t.slug === slug);
    if (!t) return slug;
    // Also try the branch's own business_settings.business_name for a
    // friendlier display label — falls back to the master tenant name.
    try {
      const db = getTenantDb(slug);
      const row = db.prepare('SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1').get();
      if (row?.business_name) return row.business_name;
    } catch (_) { /* fall through */ }
    return t.business_name || slug;
  } catch (_) { return slug; }
}

function nextTransferNumber() {
  const yr = new Date().getFullYear();
  // 2026-09-04 — was COUNT(*) + 1, which breaks the moment a row is deleted:
  // the count drops while the numbers already issued do not, so the next
  // document reuses one that exists and the UNIQUE constraint rejects it.
  // Deleting five stale test rows today was enough to do it. Take the highest
  // number actually issued this year instead — deletions cannot lower it, and
  // a number is never reused.
  const row = masterDb.prepare(
    `SELECT MAX(CAST(substr(transfer_number, ?) AS INTEGER)) AS n
       FROM stock_transfers
      WHERE transfer_number LIKE ?`
  ).get(10, `TRF-${yr}-%`);
  const seq = (Number(row?.n) || 0) + 1;
  return `TRF-${yr}-${String(seq).padStart(5, '0')}`;
}

// GET /api/transfers/source-products?slug=
// Products at a given branch with their current total on-hand stock.
//
// v1.8.92 — was reading products.current_stock (cached column). That column
// drifts (manual edits, sync gaps, reversal bugs) and got out of sync with
// reality — Stock Reconciliation showed 22,398 Bottle of SAVANNA 330ML
// while this endpoint reported 300 (a 75x gap). Now we compute on-hand
// from stock_movements like Reconciliation does, summed across ALL
// locations (sales + store + anywhere) because for an inter-branch
// transfer the total physical stock at the branch is what's transferable.
// Returns the same `current_stock` field name so the frontend doesn't
// need to change.
router.get('/source-products', hqAuth, (req, res) => {
  try {
    const slug = String(req.query.slug || '').toLowerCase();
    if (!slug || !isRegistered(slug)) return res.status(400).json({ error: 'Unknown source branch' });
    const db = getTenantDb(slug);
    // v1.13.54 — expose p.avg_cost_price so the Send Transfer modal's
    // wacOf() picks up the real blended WAC. Without this the modal only
    // saw p.cost_price (static hint), which is often 0 for transferred-in
    // products — hence "K0.00" totals even when avg_cost_price was correct.
    const products = db.prepare(`
      SELECT p.id, p.sync_id, p.name, p.unit, p.alt_unit, p.conversion_factor,
             p.units_json, p.default_unit,
             p.cost_price, p.avg_cost_price, p.selling_price,
             COALESCE(bal.balance, 0) AS current_stock,
             p.min_stock
        FROM products p
        LEFT JOIN (
          SELECT product_sync_id, SUM(quantity) AS balance
            FROM stock_movements
           WHERE deleted_at IS NULL AND product_sync_id IS NOT NULL
           GROUP BY product_sync_id
        ) bal ON bal.product_sync_id = p.sync_id
       WHERE p.deleted_at IS NULL AND p.status != 'Inactive'
       ORDER BY p.name COLLATE NOCASE ASC
    `).all();
    res.json({ products });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/transfers/outgoing?slug=&status=&from=YYYY-MM-DD&to=YYYY-MM-DD
// Transfers SENT from the named branch. Both PENDING and RECEIVED so the
// operator can see their full send history; status filter narrows it.
// v1.9.22 — date range filter added so the History tabs can scope to a
// date window (and avoid hitting the LIMIT 500 ceiling on busy branches).
router.get('/outgoing', hqAuth, (req, res) => {
  try {
    const slug   = String(req.query.slug || '').toLowerCase();
    const status = String(req.query.status || '').toUpperCase();
    const from   = String(req.query.from || '').trim();
    const to     = String(req.query.to   || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    let sql = `SELECT * FROM stock_transfers WHERE from_slug = ?`;
    const params = [slug];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (from)   { sql += ' AND DATE(created_at) >= ?'; params.push(from); }
    if (to)     { sql += ' AND DATE(created_at) <= ?'; params.push(to); }
    sql += ' ORDER BY created_at DESC LIMIT 500';
    const rows = masterDb.prepare(sql).all(...params).map(parseItems);
    res.json({ transfers: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/transfers/incoming?slug=&status=&from=YYYY-MM-DD&to=YYYY-MM-DD
// Transfers headed TO the named branch. Default filter status=PENDING so
// the operator sees only what needs receiving; pass status= '' for all.
router.get('/incoming', hqAuth, (req, res) => {
  try {
    const slug   = String(req.query.slug || '').toLowerCase();
    // NOTE: a MISSING status means PENDING here (the receiving queue's
    // default), while an EMPTY string means no filter. Callers wanting every
    // row must send status='' explicitly — sending undefined gets them the
    // pending queue instead. This caught out the History "All" tab.
    const status = req.query.status === undefined ? 'PENDING' : String(req.query.status).toUpperCase();
    const from   = String(req.query.from || '').trim();
    const to     = String(req.query.to   || '').trim();
    if (!slug) return res.status(400).json({ error: 'slug is required' });
    let sql = `SELECT * FROM stock_transfers WHERE to_slug = ?`;
    const params = [slug];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (from)   { sql += ' AND DATE(created_at) >= ?'; params.push(from); }
    if (to)     { sql += ' AND DATE(created_at) <= ?'; params.push(to); }
    sql += ' ORDER BY created_at DESC LIMIT 500';
    const rows = masterDb.prepare(sql).all(...params).map(parseItems);
    res.json({ transfers: rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function parseItems(row) {
  try { row.items = JSON.parse(row.items_json || '[]'); }
  catch { row.items = []; }
  delete row.items_json;
  return row;
}

// POST /api/transfers
// Body: { from_slug, to_slug, items: [{product_sync_id, product_name,
//         unit, quantity, cost_price?}], notes? }
// Source stock is decremented IMMEDIATELY — the transfer represents stock
// already on the truck. If receive never happens the source can cancel
// and we'll restore the stock (see /cancel below).

// ─── Till → server forwarding ────────────────────────────────────────────
//
// 2026-08-28 — a transfer touches TWO branches: the sender's stock goes down
// and the receiver's goes up. The VPS holds every branch's book side by side,
// so it can write both — which is exactly why this works from a browser: the
// browser only sends a message, the VPS does the work.
//
// An Electron till runs its own copy of this server and holds ONE book. It
// cannot post the other branch's half, and must never invent a database to
// write it into. So when a till needs the other side, it does what the
// browser does — hands the job to the VPS and returns the answer.
//
// Same code path as the web, therefore the same numbers, the same variance
// rows and the same HQ confirmation. Only the messenger differs.
const IS_TILL = !!process.env.ELECTRON_USER_DATA;

function branchSecret() {
  try {
    return dbProxy.defaultDb.prepare(
      'SELECT zra_proxy_secret FROM business_settings WHERE zra_proxy_secret IS NOT NULL LIMIT 1'
    ).get()?.zra_proxy_secret || null;
  } catch (_) { return null; }
}

function vpsBaseUrl() {
  try {
    const row = dbProxy.defaultDb.prepare("SELECT value FROM sync_config WHERE key = 'vps_url' LIMIT 1").get();
    return (row && row.value) ? String(row.value).replace(/\/+$/, '') : null;
  } catch (_) { return null; }
}

// Returns true if it handled the request (forwarded or reported offline).
async function forwardToServer(req, res) {
  if (!IS_TILL) return false;
  const base = vpsBaseUrl();
  if (!base) {
    res.status(503).json({ error: 'No server address configured on this computer.' });
    return true;
  }
  const url = base + '/api/transfers' + req.originalUrl.split('/api/transfers')[1];
  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        // The VPS will not accept our JWT (different signing secret), so
        // authenticate as this MACHINE with the branch's shared secret and
        // pass the operator's name purely for the audit trail.
        ...(branchSecret() ? { 'X-Branch-Secret': branchSecret() } : {}),
        'X-Branch-Actor': String(req.user?.firstName || req.user?.email || '').slice(0, 80),
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await upstream.text();
    let body; try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) }; }
    // Never pass a 401 straight through. The browser treats 401 as "your
    // session expired" and logs the operator out — which is what happened
    // when the forwarded token was rejected: a red error and a sudden logout
    // in the middle of receiving a delivery. An upstream refusal is a problem
    // with THIS COMPUTER's credentials, not with who is signed in, so report
    // it as a server-side fault and leave the session alone.
    if (upstream.status === 401 || upstream.status === 403) {
      return res.status(502).json({
        error: 'The server did not accept this computer. Its ZRA proxy secret '
             + 'may be missing or may not match the branch. Check Settings > '
             + 'ZRA Configuration, or do this transfer on the web.',
        code: 'BRANCH_NOT_AUTHORISED',
      });
    }
    res.status(upstream.status).json(body);
  } catch (e) {
    // No connection. Say so plainly rather than half-writing a transfer:
    // the other branch's book is only reachable through the server.
    res.status(503).json({
      error: 'This needs an internet connection — moving stock between branches '
           + 'is done by the server, which holds both branches\' records. '
           + 'Please try again once you are back online.',
      code: 'TRANSFER_NEEDS_SERVER',
    });
  }
  return true;
}

router.post('/', hqAuth, async (req, res) => {
  try {
    if (await forwardToServer(req, res)) return;
    const { from_slug, to_slug, items, notes,
            cost_currency, fx_rate_used } = req.body || {};
    const fromSlug = String(from_slug || '').toLowerCase();
    const toSlug   = String(to_slug   || '').toLowerCase();
    // v1.10.54 — WAC redesign push 2: FX rate at Send time.
    // One rate per whole transfer, per user's 2026-07-03 memo. Backend
    // just accepts + stores; the frontend gates the requirement based on
    // whether the destination is a tri-currency branch.
    const VALID_CCY = new Set(['USD', 'FRA', 'K']);
    const ccy  = cost_currency ? String(cost_currency).toUpperCase() : null;
    const rate = fx_rate_used  ? parseFloat(fx_rate_used) : null;
    if (ccy && !VALID_CCY.has(ccy)) {
      return res.status(400).json({ error: 'cost_currency must be one of USD, FRA, K' });
    }
    if (ccy && ccy !== 'USD' && !(rate > 0)) {
      return res.status(400).json({ error: `fx_rate_used > 0 is required when cost_currency is ${ccy}` });
    }
    // Convert helper: local cost → USD equivalent using this transfer's
    // rate. USD stays 1:1. Stored on each item inside items_json so read
    // paths can pull the pre-computed USD value without re-doing math.
    const toUsd = (localCost) => {
      const c = parseFloat(localCost || 0) || 0;
      if (c <= 0) return 0;
      if (!ccy || ccy === 'USD') return c;
      return rate > 0 ? c / rate : null;
    };
    if (!fromSlug || !toSlug) return res.status(400).json({ error: 'from_slug and to_slug are required' });
    if (fromSlug === toSlug)  return res.status(400).json({ error: 'Source and destination must differ' });
    if (!isRegistered(fromSlug)) return res.status(400).json({ error: `Source branch "${fromSlug}" not registered` });
    if (!isRegistered(toSlug))   return res.status(400).json({ error: `Destination branch "${toSlug}" not registered` });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'At least one item required' });

    // Validate + normalise items.
    const cleanItems = [];
    let totalValue = 0;
    for (const it of items) {
      const psid = String(it.product_sync_id || '').trim();
      const name = String(it.product_name    || '').trim();
      const qty  = parseFloat(it.quantity);
      if (!psid || !name || !(qty > 0)) {
        return res.status(400).json({ error: `Invalid item: needs product_sync_id, product_name, and quantity > 0` });
      }
      const cost = parseFloat(it.cost_price || 0) || 0;
      cleanItems.push({
        product_sync_id: psid,
        product_name:    name,
        unit:            it.unit || null,
        quantity:        qty,
        cost_price:      cost,
        // v1.10.54 — USD equivalent baked in at Send time so /receive
        // can blend WAC without re-consulting rate math. Same value
        // regardless of whether destination is tri-currency; on K-only
        // destinations it's ignored during blend (cost stays in K).
        cost_price_usd:  toUsd(cost),
      });
      totalValue += qty * cost;
    }

    const fromDb = getTenantDb(fromSlug);
    const transferSyncId = randomUUID();
    const transferNumber = nextTransferNumber();
    const createdBy      = req.user.id || null;
    const createdByName  = req.user.firstName || req.user.email || 'HQ';

    // v1.9.22 — Availability check at create time. We no longer decrement
    // source stock here (the deduction is deferred to /receive), but we
    // still need to block sending qty the source can't actually ship.
    // Available = live bin balance − qty already locked in other PENDING
    // outgoing transfers for the same product. Otherwise a source could
    // create 5 PENDINGs for the same 100 units and over-promise 500.
    const liveStockStmt = fromDb.prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS balance
         FROM stock_movements
        WHERE product_sync_id = ? AND deleted_at IS NULL`
    );
    const pendingOutgoingRows = masterDb.prepare(
      `SELECT items_json FROM stock_transfers
        WHERE from_slug = ? AND status = 'PENDING'`
    ).all(fromSlug);
    // Sum base-qty already promised per product across all PENDING outgoing.
    const pendingByPsid = new Map();
    for (const row of pendingOutgoingRows) {
      let parsed = [];
      try { parsed = JSON.parse(row.items_json || '[]'); } catch { /* skip */ }
      for (const it of parsed) {
        const psid = it.product_sync_id;
        if (!psid) continue;
        const prodRow = fromDb.prepare(
          'SELECT unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?'
        ).get(psid);
        const baseQty = parseFloat(it.quantity) * conversionToBase(prodRow || {}, it.unit);
        pendingByPsid.set(psid, (pendingByPsid.get(psid) || 0) + baseQty);
      }
    }
    for (const it of cleanItems) {
      const prod = fromDb.prepare(
        'SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?'
      ).get(it.product_sync_id);
      if (!prod) {
        return res.status(400).json({ error: `Product not found at source: ${it.product_name}` });
      }
      const baseQty   = parseFloat(it.quantity) * conversionToBase(prod, it.unit);
      const liveStock = parseFloat(liveStockStmt.get(prod.sync_id).balance) || 0;
      const promised  = pendingByPsid.get(prod.sync_id) || 0;
      const available = liveStock - promised;
      if (available < baseQty - 0.0001) {
        return res.status(400).json({
          error: `Insufficient stock for ${it.product_name} (have ${liveStock}, ${promised > 0 ? `already in pending transfers: ${promised}, ` : ''}available: ${available}, need ${baseQty})`,
        });
      }
    }

    // Master row only — source stock_movements posted at /receive time.
    masterDb.prepare(`
      INSERT INTO stock_transfers (transfer_number, sync_id, from_slug, from_name, to_slug, to_name,
                                   items_json, total_items, total_value, notes,
                                   cost_currency, fx_rate_used,
                                   status, created_by, created_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING', ?, ?)
    `).run(
      transferNumber, transferSyncId,
      fromSlug, branchName(fromSlug),
      toSlug,   branchName(toSlug),
      JSON.stringify(cleanItems),
      cleanItems.length,
      totalValue,
      notes || null,
      ccy, rate,
      createdBy, createdByName
    );

    const row = parseItems(masterDb.prepare('SELECT * FROM stock_transfers WHERE sync_id = ?').get(transferSyncId));
    // 2026-09-18 — wake the depot the stock is going to. Until they receive
    // it, it is in neither branch's sellable stock, so a transfer nobody
    // notices is stock nobody can sell. Fire-and-forget: the transfer stands.
    try {
      const { notifyBranchRoles } = require('../services/notify');
      notifyBranchRoles(toSlug, null, {
        title: 'Stock on the way',
        body: `${branchName(fromSlug)} sent ${cleanItems.length} item${cleanItems.length === 1 ? '' : 's'} · ${transferNumber}`,
        data: { type: 'transfer-incoming', transfer_number: transferNumber },
        channelId: 'kelete-alerts-v1',
      }).catch(() => {});
    } catch (_) { /* never block the transfer */ }
    res.status(201).json(row);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// PUT /api/transfers/:id/receive
// Destination confirms arrival. For each item, find the product at the
// destination by sync_id (or auto-create using the snapshot from the
// transfer), increment current_stock by RECEIVED qty (not sent qty),
// and log a transfer_in movement.
//
// v1.8.64 — Per-line receive: body.received_lines = [{
//   product_sync_id, received_qty, reason ('OK'|'Short'|'Damaged'|'Lost'), notes
// }]. When received_qty < sent_qty (or reason != 'OK'), a
// transfer_variance row is recorded in master.db.
//
// v1.9.22 — Source-side decrement moved here from /create. On receive:
//   - Source: post transfer_out (-sentQty) — the sent qty has left the
//     source's books; variance is tracked separately as "lost in transit".
//   - Destination: post transfer_in (+recvQty).
//   - Variance: sentQty − recvQty (lost / damaged in transit). Owned by no
//     branch's bin, surfaced in master.transfer_variances for HQ to chase.
//
// Backwards-compat: if received_lines is absent, fall back to receiving
// every item at the sent qty (the old behavior).
router.put('/:id/receive', hqAuth, async (req, res) => {
  try {
    if (await forwardToServer(req, res)) return;
    const row = masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Transfer not found' });
    if (row.status !== 'PENDING') return res.status(400).json({ error: `Transfer is ${row.status}, not PENDING` });

    const toSlug = row.to_slug;
    const fromSlug = row.from_slug;
    if (!isRegistered(toSlug)) return res.status(400).json({ error: 'Destination branch no longer registered' });

    let items = [];
    try { items = JSON.parse(row.items_json || '[]'); } catch { /* empty */ }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Transfer has no items' });
    }

    // Build a lookup of per-line receive overrides, keyed by product_sync_id.
    const recvLines = Array.isArray(req.body?.received_lines) ? req.body.received_lines : [];
    const recvByPsid = new Map();
    for (const r of recvLines) {
      if (r && r.product_sync_id) recvByPsid.set(r.product_sync_id, r);
    }

    const toDb = getTenantDb(toSlug);
    const __toIds = branchSyncIds(toDb);        // see branchSyncIds()
    const receivedBy = req.user.id || null;
    const receivedByName = req.user.firstName || req.user.email || 'Branch';

    // 2026-09-04 — user ids are PER BRANCH. "sham sham" is id 8 at garden and
    // id 4 at buseko, so writing the receiver's own id into the SOURCE
    // branch's stock_movements hit created_by REFERENCES users(id) and rolled
    // the whole receive back: FOREIGN KEY constraint failed. It only worked
    // for operators whose id happened to exist in both books — sirak is 1
    // everywhere, which is why it failed on some tills and not others.
    //
    // Resolving the receiver's id in each database would have fixed the
    // error, but it would still be wrong: the source's stock went OUT because
    // the SENDER sent it. Each half is now authored by whoever actually did
    // it, and both ids are already local to their own book —
    //   source  transfer_out  ->  row.created_by  (sender, a source-branch id)
    //   dest    transfer_in   ->  req.user.id     (receiver, a dest id)
    // so no cross-branch lookup is needed at all.
    //
    // The one exception is an HQ admin sending on a branch's behalf via the
    // branch switcher: created_by is then their HQ id, which may not exist in
    // the source. userExistsIn() catches that and writes NULL — the column is
    // nullable, and an unattributed movement beats a receive that cannot
    // complete. The sender's name survives on stock_transfers.created_by_name
    // either way.
    const userExistsIn = (db, id) => {
      if (!id) return false;
      try { return !!db.prepare('SELECT 1 FROM users WHERE id = ? LIMIT 1').get(id); }
      catch (_) { return false; }
    };
    // Receiver, as known to the DESTINATION branch. Declared HERE, after the
    // helper and after receivedBy — it referenced both from above them on
    // first write, which is a temporal dead zone and threw
    // "Cannot access 'userExistsIn' before initialization" on every receive.
    const receivedByLocal = userExistsIn(toDb, receivedBy) ? receivedBy : null;
    let anyVariance = false;
    const varianceInserts = []; // { sync_id, ...row } — pushed to master.db after the tenant tx

    // v1.9.22 — Source-side deduction (deferred from /create). Posts the
    // sentQty as transfer_out so the source's Sales Bin Card finally
    // reflects what physically left. Skipped silently if the source
    // branch isn't registered anymore (rare, but don't block receive).
    //
    // Legacy guard: pre-v1.9.22 PENDING transfers already posted the
    // transfer_out at create time. We detect that via reference_sync_id
    // = row.sync_id on stock_movements and skip the source deduction
    // here to avoid double-counting.
    if (isRegistered(fromSlug)) {
      const fromDb = getTenantDb(fromSlug);
      const __fromIds = branchSyncIds(fromDb);   // see branchSyncIds()
      // Whoever pressed Send, as known to the SOURCE branch's own users table.
      const sentBy = userExistsIn(fromDb, row.created_by) ? row.created_by : null;
      const alreadyPosted = fromDb.prepare(
        `SELECT 1 FROM stock_movements
          WHERE reference_sync_id = ? AND movement_type = 'transfer_out'
            AND deleted_at IS NULL LIMIT 1`
      ).get(row.sync_id);
      if (alreadyPosted) {
        // Pre-v1.9.22 transfer — source bin already reflects the deduction.
        // Skip re-posting at /receive to preserve the legacy total.
      } else {
      fromDb.transaction(() => {
        const movStmt = fromDb.prepare(`
          INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                       quantity, reference_type, reference_sync_id,
                                       notes, created_by, sync_id, tenant_id, branch_id, device_id,
                                       synced, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
        `);
        const upd = fromDb.prepare(`
          UPDATE products SET current_stock = current_stock - ?,
                              updated_at    = datetime('now'),
                              synced        = 0
           WHERE sync_id = ?
        `);
        for (const it of items) {
          const prod = fromDb.prepare(
            'SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE sync_id = ?'
          ).get(it.product_sync_id);
          if (!prod) continue; // product no longer at source — skip, variance will catch the gap
          const sentBaseQty = (parseFloat(it.quantity) || 0) * conversionToBase(prod, it.unit);
          if (sentBaseQty <= 0) continue;
          movStmt.run(
            prod.id, prod.sync_id, 'sales', 'transfer_out',
            -sentBaseQty, 'transfer', row.sync_id,
            `Transfer ${row.transfer_number} → ${row.to_name || toSlug} (confirmed)`,
            sentBy,
            randomUUID(), __fromIds.tenantId, __fromIds.branchId, null
          );
          upd.run(sentBaseQty, prod.sync_id);
        }
      })();
      }
    }

    // v1.10.55 — WAC redesign push 3: blend delivery cost into destination
    // avg_cost_price. Delivery CP is derived from the transfer's declared
    // FX rate (captured at Send time in v1.10.54). Same formula as HQ GRN
    // generate — never overwrites, always blends. Storage on items_json
    // already has cost_price_usd pre-computed for tri-currency destinations;
    // K-only destinations fall back to the raw cost_price (native K).
    const trCcy  = String(row.cost_currency || '').toUpperCase();
    const trRate = parseFloat(row.fx_rate_used || 0) || 0;
    const toUsdT = (it) => {
      // Prefer the pre-computed field on the item (stored by v1.10.54).
      const preC = parseFloat(it.cost_price_usd || 0);
      if (preC > 0) return preC;
      const c = parseFloat(it.cost_price || 0) || 0;
      if (c <= 0) return 0;
      if (!trCcy || trCcy === 'USD') return c;
      return trRate > 0 ? c / trRate : c;
    };
    // v1.13.46 — snapshot per-line received data so the View modal can show
    // reality instead of defaulting Received=Sent. Populated inside the loop,
    // written back onto stock_transfers.items_json after the tx.
    const enrichedItems = [];
    toDb.transaction(() => {
      const movStmt = toDb.prepare(`
        INSERT INTO stock_movements (product_id, product_sync_id, location, movement_type,
                                     quantity, reference_type, reference_sync_id,
                                     notes, created_by, sync_id, tenant_id, branch_id, device_id,
                                     synced, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,datetime('now'),datetime('now'))
      `);
      // v1.10.55 — atomic UPDATE bumps current_stock AND blends
      // avg_cost_price in one statement (same shape as hqGrns.js /generate).
      const upd = toDb.prepare(`
        UPDATE products
           SET current_stock  = current_stock + ?,
               avg_cost_price = CASE
                 WHEN avg_cost_price IS NULL OR current_stock <= 0
                   THEN ?
                 ELSE ROUND(
                   (current_stock * avg_cost_price + ? * ?)
                   / (current_stock + ?), 4)
               END,
               updated_at     = datetime('now'),
               synced         = 0
         WHERE sync_id = ?
      `);

      for (const it of items) {
        let prod = toDb.prepare(`
          SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json
            FROM products
           WHERE sync_id = ? AND deleted_at IS NULL
        `).get(it.product_sync_id);

        if (!prod) {
          const baseUnit = it.unit || 'pcs';
          const cost     = parseFloat(it.cost_price || 0) || 0;
          const info = toDb.prepare(`
            INSERT INTO products (name, unit, cost_price, selling_price,
                                  current_stock, min_stock, status,
                                  sync_id, tenant_id, branch_id, device_id, synced,
                                  created_at, updated_at)
            VALUES (?,?,?,?,0,0,'Active',?,?,?,?,0,datetime('now'),datetime('now'))
          `).run(
            it.product_name, baseUnit, cost, cost,
            it.product_sync_id, null, null, null
          );
          prod = toDb.prepare(
            'SELECT id, sync_id, unit, alt_unit, conversion_factor, units_json FROM products WHERE id = ?'
          ).get(info.lastInsertRowid);
        }

        const sentQty = parseFloat(it.quantity) || 0;
        const recvOverride = recvByPsid.get(it.product_sync_id);
        // v1.13.46 — surface the silent fallback in server logs. Falling
        // back to sentQty silently ate real shortages before (e.g. product
        // resync mismatch → lookup fails → variance never recorded).
        if (!recvOverride) {
          console.warn(`[transfers.receive] no receive-line override for product ${it.product_sync_id} on ${row.transfer_number}; falling back to sent (${sentQty} ${it.unit || ''}). Product sync mismatch?`);
        }
        const recvQty = recvOverride && recvOverride.received_qty !== undefined
          ? Math.max(0, parseFloat(recvOverride.received_qty) || 0)
          : sentQty;  // fallback: receive full
        const reason  = recvOverride?.reason || (recvQty === sentQty ? 'OK' : 'Short');
        const notes   = recvOverride?.notes || null;
        const variance = sentQty - recvQty;
        // v1.13.46 — stash the real received values so we can persist them
        // onto items_json after the tx (see below).
        enrichedItems.push({
          ...it,
          received_qty:   recvQty,
          receive_reason: reason,
          receive_notes:  notes,
        });

        // Only stock-increment for the RECEIVED quantity (not the sent).
        if (recvQty > 0) {
          const baseQty = recvQty * conversionToBase(prod, it.unit);
          movStmt.run(
            prod.id, prod.sync_id, 'sales', 'transfer_in',
            baseQty, 'transfer', row.sync_id,
            `Transfer ${row.transfer_number} ← ${row.from_name || fromSlug}` +
              (variance > 0 ? ` · short ${variance} ${it.unit || ''} (${reason})` : ''),
            receivedByLocal,
            randomUUID(), __toIds.tenantId, __toIds.branchId, null
          );
          // v1.10.55 — WAC blend at destination: baseQty × delivery_cp_usd
          // added to the weighted mean of existing stock. cost_price on
          // items_json is per BASE unit (transfer create normalises to base
          // there too, or Send modal converts before submit).
          const deliveryCpUsd = toUsdT(it);
          upd.run(
            baseQty,
            deliveryCpUsd,
            baseQty, deliveryCpUsd,
            baseQty,
            prod.sync_id
          );
        }

        // Record the variance for HQ to investigate.
        if (variance > 0.0001 || reason === 'Damaged' || reason === 'Lost') {
          anyVariance = true;
          varianceInserts.push({
            sync_id: randomUUID(),
            transfer_sync_id: row.sync_id,
            transfer_number:  row.transfer_number,
            from_slug:        row.from_slug,
            to_slug:          row.to_slug,
            product_sync_id:  it.product_sync_id,
            product_name:     it.product_name,
            unit:             it.unit,
            sent_qty:         sentQty,
            received_qty:     recvQty,
            variance_qty:     variance,
            reason,
            notes,
          });
        }
      }
    })();

    // Persist variances in master.db (outside the tenant transaction).
    if (varianceInserts.length > 0) {
      const vStmt = masterDb.prepare(`
        INSERT INTO transfer_variances (sync_id, transfer_sync_id, transfer_number,
                                         from_slug, to_slug, product_sync_id, product_name, unit,
                                         sent_qty, received_qty, variance_qty,
                                         reason, notes, received_by, received_by_name)
        VALUES (?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?)
      `);
      const tx = masterDb.transaction(() => {
        for (const v of varianceInserts) {
          vStmt.run(v.sync_id, v.transfer_sync_id, v.transfer_number,
                    v.from_slug, v.to_slug, v.product_sync_id, v.product_name, v.unit,
                    v.sent_qty, v.received_qty, v.variance_qty,
                    v.reason, v.notes, receivedBy, receivedByName);
        }
      });
      tx();
    }

    // v1.13.46 — write received_qty/reason/notes back onto items_json so
    // the View modal shows what was actually received (was defaulting
    // received=sent because items_json only ever held send-time data).
    masterDb.prepare(`
      UPDATE stock_transfers
         SET status = ?,
             received_by = ?,
             received_by_name = ?,
             received_at = datetime('now'),
             items_json = ?
       WHERE id = ?
    `).run(anyVariance ? 'RECEIVED_WITH_VARIANCE' : 'RECEIVED',
           receivedBy, receivedByName, JSON.stringify(enrichedItems), req.params.id);

    const out = parseItems(masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id));

    // v1.13.78 — ZRA stock chain (sarTyCd=04 Stock Movement) on BOTH sides
    // of the transfer. Source branch reports the outbound line (uses the
    // sent qty from items_json), destination branch reports the inbound
    // (uses the received qty captured on enrichedItems). Each side is
    // fired inside its own runWithDb so vsdcClient's ALS-scoped product
    // lookups + current_stock snapshots hit the right branch DB.
    let zraFrom = { skipped: true, reason: 'not-attempted' };
    let zraTo   = { skipped: true, reason: 'not-attempted' };
    // Reuse the same DB references the /receive handler already opened.
    // Source may be gone (unregistered) — guard.
    const fromDbForZra = isRegistered(fromSlug) ? getTenantDb(fromSlug) : null;
    const fromTenantId = fromDbForZra
      ? fromDbForZra.prepare('SELECT tenant_id FROM business_settings ORDER BY id ASC LIMIT 1').get()?.tenant_id
      : null;
    const toTenantId   = toDb.prepare('SELECT tenant_id FROM business_settings ORDER BY id ASC LIMIT 1').get()?.tenant_id;
    try {
      if (fromDbForZra && fromTenantId) {
        const sourceLines = items.map(it => ({
          product_sync_id: it.product_sync_id,
          quantity:        parseFloat(it.quantity) || 0,   // absolute sent qty
          unit:            it.unit || null,
        }));
        await dbProxy.runWithDb(fromDbForZra, async () => {
          zraFrom = await vsdc.saveNonSaleStockChain(
            fromTenantId,
            row.id * 10 + 1,                 // source-side sarNo (destination uses +2)
            { customer_name: `Transfer → ${row.to_name || toSlug}`, remark: row.transfer_number || null },
            sourceLines,
            vsdc.SAR_TY_CD.STOCK_MOVEMENT_OUT
          );
        });
      }
      if (toTenantId) {
        const destLines = enrichedItems
          .map(it => ({
            product_sync_id: it.product_sync_id,
            quantity:        parseFloat(it.received_qty ?? it.quantity) || 0,
            unit:            it.unit || null,
          }))
          .filter(l => l.quantity > 0);
        await dbProxy.runWithDb(toDb, async () => {
          zraTo = await vsdc.saveNonSaleStockChain(
            toTenantId,
            row.id * 10 + 2,                 // destination-side sarNo
            { customer_name: `Transfer ← ${row.from_name || fromSlug}`, remark: row.transfer_number || null },
            destLines,
            vsdc.SAR_TY_CD.STOCK_MOVEMENT_IN
          );
        });
      }
    } catch (_) { /* stock-chain failure doesn't undo the receive */ }

    res.json({ ...out, zra: { from: zraFrom, to: zraTo } });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// GET /api/transfers/:id/variances — list variance lines for one transfer
router.get('/:id/variances', hqAuth, (req, res) => {
  try {
    const t = masterDb.prepare('SELECT sync_id FROM stock_transfers WHERE id = ?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Transfer not found' });
    const rows = masterDb.prepare(
      'SELECT * FROM transfer_variances WHERE transfer_sync_id = ? ORDER BY id ASC'
    ).all(t.sync_id);
    res.json({ variances: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/transfers/:id/cancel — source aborts a PENDING transfer.
// v1.9.22 — Pure status flip now. Source never decremented (deferred to
// /receive), so there's nothing to reverse. Destination never saw it.
router.put('/:id/cancel', hqAuth, async (req, res) => {
  try {
    if (await forwardToServer(req, res)) return;
    const row = masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Transfer not found' });
    if (row.status !== 'PENDING') return res.status(400).json({ error: `Transfer is ${row.status}, not PENDING` });

    masterDb.prepare(`UPDATE stock_transfers SET status='CANCELLED' WHERE id=?`).run(req.params.id);

    const out = parseItems(masterDb.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(req.params.id));
    res.json(out);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

module.exports = router;
