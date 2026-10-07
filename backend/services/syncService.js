'use strict';
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const masterDb = require('../config/masterDb').masterDb;

const logFile = path.join(os.tmpdir(), 'kelete-startup.log');
function slog(msg) {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] [Sync] ${msg}\n`); } catch (e) {}
}

const SYNC_TABLES = [
  'users', 'categories', 'main_categories', 'units', 'products', 'customers', 'suppliers',
  'orders', 'order_items', 'grn', 'grn_items', 'siv', 'siv_items',
  'production', 'production_inputs', 'production_outputs',
  'sales_returns', 'sales_return_items',
  'stock_movements', 'cash_receipts', 'payment_vouchers', 'cash_book',
  // 2026-08-27 â€” business_settings REMOVED from sync.
  //
  // These rows describe a MACHINE, not shared business data: VSDC URL,
  // device serial, SDC ID, proxy secret, receipt-printer type/IP. Syncing
  // them means one install overwrites another's connection details.
  //
  // It bit us live: an Electron till pushed its settings row to the VPS,
  // and because the VPS's original row predates sync (no sync_id) there
  // was nothing to match on â€” so it INSERTED a second row. garden.db
  // ended up with two, the ZRA page began reading the till's empty one,
  // and Garden showed NOT INITIALISED with its real config still sitting
  // untouched in row 1. Had the till's row matched instead, its
  // localhost/proxy VSDC URL would have overwritten the VPS's and
  // stopped fiscalisation outright.
  //
  // Each install keeps its own settings. Anything genuinely shared
  // (products, prices, orders) travels through its own table.
  'cash_reports', 'stock_adjustments', 'daily_actual_balance',
  'ap_payments', 'ap_payment_allocations', 'daily_profit_summary',
  // Kelete-specific tables added during the credit-sales / reconciliation rework
  'customer_payments', 'stock_reconciliations', 'stock_reconciliation_items',
  'daily_cost_snapshot', 'pv_types',
  // Supplier Credit Notes (Discount / Crate Return / Goods Return / Other) â€”
  // KEEP IN SYNC with sync.js SYNC_TABLES. Missing them here meant CNs
  // created on Electron never pushed to VPS, and CNs created on web never
  // pulled to Electron (the exact Sidan Hub failure mode).
  'supplier_credit_notes', 'supplier_credit_note_items',
  // Owner equity ledgers â€” same Sidan Hub gotcha applies, keep both lists in sync.
  'capital_account', 'dividend_account',
  // Shareholders + Loans liability ledger â€” sync these too or per-shareholder
  // reporting and Loan outstanding balances drift cross-device.
  'shareholders', 'loans', 'loan_transactions',
  // Cash Book transfers between methods â€” KEEP IN SYNC with sync.js list.
  'cash_transfers',
  // Stock count audit trail â€” KEEP IN SYNC with sync.js list.
  'stock_count_sessions', 'stock_count_items',
  // Discount approval requests â€” admin verdict needs to reach the cashier's
  // PC even if approver is on another device. KEEP IN SYNC with sync.js.
  'discount_requests',
  // Phase 1 multi-currency (Kelete's whole reason for forking from Liquor).
  // KEEP IN SYNC with sync.js list â€” adding to only one will cause one-way
  // sync gaps that are hard to spot later.
  'branches', 'product_branch_prices',
  // v1.8.33 â€” KEEP IN SYNC with sync.js list. currency_exchanges = drawer
  // FX swaps that feed Cash Report Expected; fx_rates = the rate table
  // every receipt + cashier pay modal reads from. Both MUST sync.
  'currency_exchanges', 'fx_rates',
];

const DEFAULT_VPS_URL = (process.env.VPS_URL || 'https://keletezm.com').replace(/\/$/, '');
function getVpsUrl() {
  const stored = _syncConfig ? _syncConfig.get('vps_url') : null;
  return (stored || DEFAULT_VPS_URL).replace(/\/$/, '');
}
// Returns the URL this PC should sync TO.
// - Mother / unconfigured: VPS URL (legacy direct-to-VPS behavior)
// - Child:                 Mother PC URL on the LAN
// If lan_role is 'child' but mother_ip is empty, falls back to VPS (safe default â€” never breaks).
function getSyncTargetUrl() {
  if (!_syncConfig) return DEFAULT_VPS_URL;
  const lan = _syncConfig.getLanConfig();
  if (lan.role === 'child' && lan.motherIp) {
    const ip = lan.motherIp.trim();
    return ip.startsWith('http') ? ip.replace(/\/$/, '') : `http://${ip}:5000`;
  }
  return getVpsUrl();
}
function getSyncIntervalMs() {
  if (!_syncConfig) return 30_000;
  const lan = _syncConfig.getLanConfig();
  return lan.role === 'child' && lan.motherIp ? 3_000 : 30_000;
}
const HEALTH_TIMEOUT  = 5_000;
const REQUEST_TIMEOUT = 20_000;

let _db         = null;
let _syncConfig = null;
let _timer      = null;
let _status     = { state: 'idle', lastSynced: null, error: null };

// â”€â”€â”€ HTTP helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function request(url, method = 'GET', body = null, timeoutMs = REQUEST_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json' };
    // For child PCs syncing to Mother on the LAN, attach the shared sync key.
    // Mother validates this header; VPS ignores it (no harm).
    if (_syncConfig) {
      const lan = _syncConfig.getLanConfig();
      if (lan.role === 'child' && lan.lanSyncKey) {
        headers['X-Lan-Sync-Key'] = lan.lanSyncKey;
      }
    }
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers,
      timeout:  timeoutMs,
    };
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// â”€â”€â”€ Internet / VPS check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function isOnline() {
  try {
    const r = await request(`${getSyncTargetUrl()}/api/health`, 'GET', null, HEALTH_TIMEOUT);
    return r.status === 200;
  } catch {
    return false;
  }
}

// â”€â”€â”€ Push local unsynced records â†’ VPS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function push() {
  const { tenantId, branchId, deviceId } = _syncConfig.getConfig();
  if (!tenantId || tenantId === 'local-only') return;

  const records = {};
  for (const table of SYNC_TABLES) {
    try {
      const cols = _db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.includes('sync_id') || !cols.includes('synced')) continue;
      const rows = _db.prepare(`SELECT * FROM ${table} WHERE synced = 0`).all();
      if (rows.length > 0) records[table] = rows;
    } catch { /* table might not exist */ }
  }

  if (Object.keys(records).length === 0) { slog('push: nothing to push'); return; }

  slog('push: sending ' + JSON.stringify(Object.entries(records).map(([t,r]) => `${t}:${r.length}`)));
  const result = await request(
    `${getSyncTargetUrl()}/api/sync/push`,
    'POST',
    { tenantId, branchId, deviceId, records }
  );
  slog('push: response ' + result.status + ' ' + JSON.stringify(result.body).substring(0, 200));

  if (result.status === 200) {
    _db.transaction(() => {
      for (const [table, rows] of Object.entries(records)) {
        for (const row of rows) {
          if (!row.sync_id) continue;
          try {
            _db.prepare(`UPDATE ${table} SET synced = 1 WHERE sync_id = ?`).run(row.sync_id);
          } catch { /* ignore */ }
        }
      }
    })();
  }
}

// â”€â”€â”€ Pull VPS records â†’ local DB (merge by sync_id) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// v1.8.90 â€” added `opts.force`. When true:
//   â€¢ since=0 (full history pull, not just incremental)
//   â€¢ PROTECT rule is BYPASSED â€” incoming rows overwrite local even if local
//     synced=0. Used by Force Resync to unstick a diverged client.
async function pull(opts = {}) {
  const { tenantId, lastPullTime, deviceId } = _syncConfig.getConfig();
  if (!tenantId || tenantId === 'local-only') return { ok: false, reason: 'local-only' };

  const since = opts.force ? '' : lastPullTime;

  // Send our own deviceId so the server excludes records we originated
  // (prevents "echo" loop where each push triggers a pull-back of the same record).
  const result = await request(
    `${getSyncTargetUrl()}/api/sync/pull?tenantId=${encodeURIComponent(tenantId)}&since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(deviceId || '')}`
  );

  slog('pull: since=' + lastPullTime + ' status=' + result.status);
  if (result.status !== 200 || !result.body || !result.body.records) {
    slog('pull: failed or empty response');
    return;
  }
  const pulled = Object.entries(result.body.records).map(([t,r]) => `${t}:${r.length}`);
  slog('pull: received ' + (pulled.length ? JSON.stringify(pulled) : 'nothing'));

  _db.pragma('foreign_keys = OFF');

  // BATCHED: process records in chunks so the event loop isn't blocked for long.
  // Each batch runs in its own short SQLite transaction; we yield between batches
  // so the backend can still respond to API calls from the frontend.
  const BATCH_SIZE = 200;

  const hasUpdatedAt = (cols) => cols.includes('updated_at');

  const processBatch = (table, cols, batch) => {
    const tableHasUpdatedAt = hasUpdatedAt(cols);
    _db.transaction(() => {
      for (const row of batch) {
        if (!row.sync_id) continue;
        try {
          // v1.9.1 â€” read updated_at too so we can timestamp-resolve conflicts.
          const selectCols = tableHasUpdatedAt ? 'id, synced, updated_at' : 'id, synced';
          const existing = _db.prepare(`SELECT ${selectCols} FROM ${table} WHERE sync_id = ?`).get(row.sync_id);

          if (!existing) {
            // New record â€” insert it (mark synced=1 so we don't push it back)
            const insertCols = cols.filter(c => c !== 'id' && row[c] !== undefined && row[c] !== null);
            if (insertCols.length === 0) { slog(`pull: SKIP [${table}] no cols for sync_id=${row.sync_id}`); continue; }
            const placeholders = insertCols.map(() => '?').join(', ');
            const ins = _db.prepare(
              `INSERT OR IGNORE INTO ${table} (${insertCols.join(', ')}) VALUES (${placeholders})`
            ).run(...insertCols.map(c => row[c]));
            if (ins.changes === 0) slog(`pull: IGNORED [${table}] sync_id=${row.sync_id} cols=${insertCols.join(',')}`);
            _db.prepare(`UPDATE ${table} SET synced = 1 WHERE sync_id = ?`).run(row.sync_id);
          } else if (existing.synced === 0 && !opts.force) {
            // v1.9.1 â€” TIMESTAMP-AWARE PROTECT.
            // The old rule blocked every pull whenever local.synced=0. That
            // was too aggressive: a trivial local write (e.g. last_login
            // bump on user row) would lock the row forever, so legitimate
            // server updates (admin edited permissions on the web) never
            // arrived. The real intent was: "don't overwrite a row the
            // user is mid-editing offline." Now we only block when LOCAL
            // is genuinely newer than the incoming version. If incoming is
            // newer (or equal), the server has the fresher state and we
            // accept it â€” including a refresh of synced=0 â†’ 1 because the
            // local change was already superseded.
            const localTs    = tableHasUpdatedAt ? (existing.updated_at || '') : '';
            const incomingTs = tableHasUpdatedAt ? (row.updated_at || '')      : '';
            if (tableHasUpdatedAt && incomingTs && localTs && localTs > incomingTs) {
              slog(`pull: PROTECT [${table}] sync_id=${row.sync_id} â€” local(${localTs}) newer than incoming(${incomingTs}), skipping`);
              continue;
            }
            // Incoming wins (newer or equal, or no timestamp column to compare).
            const updateCols = cols.filter(c => c !== 'id' && c !== 'sync_id' && row[c] !== undefined);
            if (updateCols.length === 0) continue;
            const setClause = [...updateCols.map(c => `${c} = ?`), 'synced = 1'].join(', ');
            _db.prepare(`UPDATE ${table} SET ${setClause} WHERE sync_id = ?`).run(
              ...updateCols.map(c => row[c]), row.sync_id
            );
            slog(`pull: TIMESTAMP-WIN [${table}] sync_id=${row.sync_id} â€” incoming(${incomingTs}) overrode local(${localTs}, synced=0)`);
          } else {
            // Existing record is clean (or force=true) â€” overwrite with incoming version
            const updateCols = cols.filter(c => c !== 'id' && c !== 'sync_id' && row[c] !== undefined);
            if (updateCols.length === 0) continue;
            const setClause = [...updateCols.map(c => `${c} = ?`), 'synced = 1'].join(', ');
            _db.prepare(`UPDATE ${table} SET ${setClause} WHERE sync_id = ?`).run(
              ...updateCols.map(c => row[c]), row.sync_id
            );
            if (opts.force && existing.synced === 0) {
              slog(`pull: FORCE OVERWRITE [${table}] sync_id=${row.sync_id} â€” local synced=0 was discarded`);
            }
          }
        } catch (rowErr) { slog(`pull: row error [${table}] ${rowErr.message}`); }
      }
    })();
  };

  // Process each table in batches; yield event loop between batches so
  // frontend API calls aren't blocked during a large initial pull.
  for (const [table, rows] of Object.entries(result.body.records)) {
    if (!SYNC_TABLES.includes(table)) continue;
    let cols;
    try {
      cols = _db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    } catch { continue; }
    if (!cols.includes('sync_id')) continue;

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      processBatch(table, cols, batch);
      // Yield: lets pending API requests and timers run before next batch
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  _db.pragma('foreign_keys = ON');

  if (result.body.serverTime) {
    _syncConfig.updateLastPullTime(result.body.serverTime);
  }
  // v1.8.90 â€” return a summary so the Force Resync endpoint can show counts.
  const totalRows = Object.values(result.body.records).reduce((s, r) => s + r.length, 0);
  return { ok: true, tables: pulled, total: totalRows };
}

// â”€â”€â”€ One full sync cycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â•â•â• master.db sync â€” client side â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
//
// Companion to /api/sync/master/{slug,pull,push} in routes/sync.js.
// KEEP THIS LIST IN STEP with MASTER_SYNC_TABLES there â€” adding a table to
// only one side produces a one-way gap that is very hard to spot later.
// Kelete shipped exactly that (v1.10.249): hq_purchase_receipt_extras was
// missing here, so extras a branch recorded on receipt never left the till
// and quietly disappeared from the GRN.
const MASTER_SYNC_TABLES = [
  'cash_deposits',
  'stock_transfers',
  'transfer_variances',
  'hq_purchases',
  'hq_purchase_items',
  'hq_purchase_receipt_extras',
  'hq_grns',
  'hq_grn_items',
  'hq_supplier_credit_notes',
  'hq_supplier_credit_note_items',
];

// A till stores tenantId + branchId, never its own slug â€” but every master
// call is scoped by slug. Ask the server once, then cache it in sync_config.
async function ensureBranchSlug() {
  if (!_syncConfig) return null;
  const cached = _syncConfig.get('branch_slug');
  if (cached) return cached;
  const { branchId } = _syncConfig.getConfig();
  if (!branchId) return null;
  try {
    const result = await request(
      `${getSyncTargetUrl()}/api/sync/master/slug?branchId=${encodeURIComponent(branchId)}`
    );
    if (result.status === 200 && result.body && result.body.slug) {
      _syncConfig.set('branch_slug', result.body.slug);
      slog(`master: resolved branch slug = ${result.body.slug}`);
      return result.body.slug;
    }
    slog(`master: slug lookup returned ${result.status}`);
  } catch (e) {
    slog(`master: slug lookup failed â€” ${e.message}`);
  }
  return null;
}

// Pull the branch registry (tenants + branches) and replace the local copy.
//
// 2026-08-28 â€” a till with an empty registry cannot transfer at all:
// isRegistered() reads tenants, so sending failed with "Unknown source
// branch" and receiving with "Destination branch no longer registered",
// and the destination dropdown was empty. These two tables are HQ-owned
// reference data with no sync_id, so they are replaced wholesale rather
// than tracked row by row â€” a branch never writes them.
async function pullMasterRegistry() {
  if (!masterDb) return;
  const result = await request(`${getSyncTargetUrl()}/api/sync/master/registry`);
  if (result.status !== 200) {
    const snip = typeof result.body === 'string'
      ? result.body.substring(0, 200)
      : JSON.stringify(result.body).substring(0, 200);
    throw new Error(`master registry: HTTP ${result.status} â€” ${snip}`);
  }
  const tenants  = result.body && result.body.tenants;
  const branches = result.body && result.body.branches;
  if (!Array.isArray(tenants) || !Array.isArray(branches)) {
    throw new Error('master registry: unexpected response shape');
  }
  // Never wipe a working registry because of an empty or half-built answer.
  // Replacing it with nothing would break every transfer on this till.
  if (tenants.length === 0) { slog('master registry: empty response â€” keeping local copy'); return; }

  masterDb.pragma('foreign_keys = OFF');
  try {
    masterDb.transaction(() => {
      masterDb.prepare('DELETE FROM tenants').run();
      const ti = masterDb.prepare(
        'INSERT INTO tenants (slug, business_name, email, is_active, created_at) VALUES (?,?,?,?,?)'
      );
      for (const t of tenants) ti.run(t.slug, t.business_name, t.email, t.is_active, t.created_at);

      masterDb.prepare('DELETE FROM branches').run();
      const bi = masterDb.prepare(
        'INSERT INTO branches (tenant_id, branch_id, branch_name, slug, created_at) VALUES (?,?,?,?,?)'
      );
      for (const b of branches) bi.run(b.tenant_id, b.branch_id, b.branch_name, b.slug, b.created_at);
    })();
  } finally {
    masterDb.pragma('foreign_keys = ON');
  }
  slog(`master registry: ${tenants.length} tenant(s), ${branches.length} branch(es)`);
}

// Send this branch's master.db changes up. Runs BEFORE pullMaster so local
// work reaches HQ before HQ's copy overwrites it.
async function pushMaster() {
  if (!masterDb) return;                       // VPS-only features disabled
  const slug = await ensureBranchSlug();
  if (!slug) return;                           // cannot scope without it

  const records = {};
  for (const table of MASTER_SYNC_TABLES) {
    try {
      const cols = masterDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.includes('sync_id') || !cols.includes('synced')) continue;
      const rows = masterDb.prepare(`SELECT * FROM ${table} WHERE synced = 0`).all();
      if (rows.length > 0) records[table] = rows;
    } catch { /* table absent on this mirror */ }
  }
  if (Object.keys(records).length === 0) { slog('master push: nothing to push'); return; }

  slog('master push: sending ' + JSON.stringify(Object.entries(records).map(([t, r]) => `${t}:${r.length}`)));
  const result = await request(`${getSyncTargetUrl()}/api/sync/master/push`, 'POST', { slug, records });

  // Throw on non-200 so the sync badge reflects reality. Kelete's first cut
  // returned silently here and the badge stayed green while nothing went up.
  if (result.status !== 200) {
    const snip = typeof result.body === 'string'
      ? result.body.substring(0, 200)
      : JSON.stringify(result.body).substring(0, 200);
    throw new Error(`master push: HTTP ${result.status} â€” ${snip}`);
  }

  // 2026-08-28 â€” improvement on Kelete: it ignored `rejected` entirely, so a
  // row the server refused (wrong branch, or an edit older than HQ's) was
  // dropped in silence and the operator's change simply never appeared.
  // Surface it. Scope mismatches are a bug and must be loud; stale
  // timestamps are the expected outcome of a real conflict, so they are
  // logged but do not fail the cycle.
  const rejected = Array.isArray(result.body && result.body.rejected) ? result.body.rejected : [];
  if (rejected.length) {
    for (const r of rejected) slog(`master push: REJECTED [${r.table}] ${r.sync_id} â€” ${r.reason}`);
    const serious = rejected.filter(r => r.reason !== 'stale-timestamp');
    if (serious.length) {
      throw new Error(
        `master push: server refused ${serious.length} row(s) â€” ` +
        serious.slice(0, 3).map(r => `${r.table}/${r.reason}`).join(', ')
      );
    }
  }

  // Mark them acked. Changing `synced` trips the touch trigger's WHEN guard
  // so the row is NOT re-flagged by its own acknowledgement.
  //
  // 2026-08-28 â€” only rows the server ACCEPTED. Kelete acks everything it
  // sent, so a refused row is marked done and never retried: the operator's
  // change is gone with nothing left pointing at it. Leaving a refused row
  // at synced=0 means the next cycle tries again, and if it is genuinely
  // stale the newer server copy arrives on the following pull and settles it.
  const refused = new Set(rejected.map(r => `${r.table} ${r.sync_id}`));
  masterDb.transaction(() => {
    for (const [table, rows] of Object.entries(records)) {
      for (const row of rows) {
        if (!row.sync_id) continue;
        if (refused.has(`${table} ${row.sync_id}`)) continue;
        try { masterDb.prepare(`UPDATE ${table} SET synced = 1 WHERE sync_id = ?`).run(row.sync_id); }
        catch { /* ignore */ }
      }
    }
  })();
}

// Bring this branch's master.db rows down. The server's copy is
// authoritative here â€” anything of ours that mattered went up in pushMaster
// a moment ago and was accepted or explicitly rejected above.
async function pullMaster(opts = {}) {
  if (!masterDb) return;
  const slug = await ensureBranchSlug();
  if (!slug) return;

  const since = opts.force ? '' : (_syncConfig.get('last_master_pull_time') || '');
  const url = `${getSyncTargetUrl()}/api/sync/master/pull`
            + `?slug=${encodeURIComponent(slug)}&since=${encodeURIComponent(since)}`;
  const result = await request(url);

  if (result.status !== 200) {
    const snip = typeof result.body === 'string'
      ? result.body.substring(0, 200)
      : JSON.stringify(result.body).substring(0, 200);
    throw new Error(`master pull: HTTP ${result.status} â€” ${snip}`);
  }
  if (!result.body || !result.body.records) throw new Error('master pull: empty response body');

  masterDb.pragma('foreign_keys = OFF');
  try {
    for (const [table, rows] of Object.entries(result.body.records)) {
      if (!MASTER_SYNC_TABLES.includes(table)) continue;
      let cols;
      try { cols = masterDb.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name); }
      catch { continue; }
      if (!cols.includes('sync_id')) continue;

      masterDb.transaction(() => {
        for (const row of rows) {
          if (!row.sync_id) continue;
          try {
            const existing = masterDb.prepare(`SELECT id FROM ${table} WHERE sync_id = ?`).get(row.sync_id);
            if (!existing) {
              // Carry updated_at + synced=1 in the payload so the INSERT
              // trigger's `WHEN NEW.updated_at IS NULL` guard skips this row
              // â€” a pulled row is already in sync, it must not be re-flagged.
              const insertCols = cols.filter(c => c !== 'id' && row[c] !== undefined);
              if (!insertCols.includes('synced')) insertCols.push('synced');
              row.synced = 1;
              const placeholders = insertCols.map(() => '?').join(', ');
              masterDb.prepare(
                `INSERT OR IGNORE INTO ${table} (${insertCols.join(', ')}) VALUES (${placeholders})`
              ).run(...insertCols.map(c => row[c]));
            } else {
              const updateCols = cols.filter(c => c !== 'id' && c !== 'sync_id' && row[c] !== undefined);
              if (updateCols.length === 0) continue;
              const hasSynced = updateCols.includes('synced');
              const setClause = hasSynced
                ? updateCols.map(c => `${c} = ?`).join(', ')
                : [...updateCols.map(c => `${c} = ?`), 'synced = 1'].join(', ');
              masterDb.prepare(`UPDATE ${table} SET ${setClause} WHERE sync_id = ?`).run(
                ...updateCols.map(c => (c === 'synced' ? 1 : row[c])),
                row.sync_id
              );
            }
          } catch (rowErr) {
            slog(`master pull: row error [${table}] ${rowErr.message}`);
          }
        }
      })();
      await new Promise(resolve => setImmediate(resolve));
    }
  } finally {
    masterDb.pragma('foreign_keys = ON');
  }

  if (result.body.serverTime) _syncConfig.set('last_master_pull_time', result.body.serverTime);
  const total = Object.values(result.body.records).reduce((s, r) => s + r.length, 0);
  if (total > 0) slog(`master pull: applied ${total} row(s)`);
}

async function runCycle() {
  try {
    const { tenantId } = _syncConfig.getConfig();
    if (!tenantId || tenantId === 'local-only') {
      _status = { state: 'idle', lastSynced: null, error: null };
      return;
    }

    _status = { ..._status, state: 'checking' };

    const online = await isOnline();
    if (!online) {
      _status = { ..._status, state: 'offline', error: null };
      return;
    }

    _status = { ..._status, state: 'syncing', error: null };
    await push();
    await pull();
    // master.db bridge â€” deposits, inter-branch transfers, HQ purchases and
    // their GRNs. Push first: local work must reach HQ before HQ's copy is
    // applied over the top of it.
    // Registry first: pushMaster/pullMaster are scoped by slug, and the
    // slug lookup needs the branch list to exist.
    await pullMasterRegistry();
    await pushMaster();
    await pullMaster();

    const now = new Date().toISOString();
    _status = { state: 'synced', lastSynced: now, error: null };
    _syncConfig.set('last_synced', now);
    _syncConfig.set('sync_error', '');
    console.log('[SyncService] Cycle complete:', now);
  } catch (err) {
    console.error('[SyncService] Error:', err.message);
    _status = { ..._status, state: 'error', error: err.message };
    try { _syncConfig.set('sync_error', err.message); } catch { /* ignore */ }
  }
}

// â”€â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _currentIntervalMs = 0;
let _running = false;

// Self-rescheduling loop â€” never starts a new cycle until the previous one
// finishes. Prevents pile-up of overlapping runCycle() calls when sync gets
// slow, which was causing accumulating freezes on long-running Mother PCs.
async function loopOnce() {
  if (_running) return;
  _running = true;
  try {
    await runCycle();
  } catch (e) {
    slog('loopOnce error: ' + e.message);
  } finally {
    _running = false;
    const next = getSyncIntervalMs();
    _currentIntervalMs = next;
    _timer = setTimeout(loopOnce, next);
  }
}

function start(db, syncConfig) {
  if (_timer) return;
  _db         = db;
  _syncConfig = syncConfig;

  _currentIntervalMs = getSyncIntervalMs();
  // First cycle after 8s (give server time to finish startup)
  _timer = setTimeout(loopOnce, 8_000);

  const cfg = syncConfig.getConfig();
  slog(`started â€” tenantId=${cfg.tenantId} branchId=${cfg.branchId} interval=${_currentIntervalMs/1000}s target=${getSyncTargetUrl()}`);
  console.log(`[SyncService] Started â€” interval: ${_currentIntervalMs / 1000}s, target: ${getSyncTargetUrl()}`);
}

// Called when LAN config changes â€” next cycle will pick up the new interval
function reload() {
  // loopOnce reads getSyncIntervalMs() at the end of every cycle, so the
  // new interval is automatically picked up on the next tick. Nothing to do.
  slog('reload called â€” new interval will apply on next cycle');
}

function stop() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _currentIntervalMs = 0;
}

function getStatus() {
  return { ..._status, target: getSyncTargetUrl(), intervalMs: _currentIntervalMs };
}

// v1.9.4 â€” kick a sync cycle on demand. Used by /api/sync/run-now so the
// POS Change Price flow doesn't have to wait up to 30s for the next scheduled
// tick to push the request (or to pull the admin's verdict back). Returns
// immediately; the actual cycle is fire-and-forget. Rate-limited internally
// by `_running` (set by loopOnce) so a flood of triggers can't pile up.
function runNow() {
  if (!_db || !_syncConfig) return false; // sync engine not started (VPS mode)
  if (_running) return false;             // a cycle is already in flight
  setImmediate(loopOnce);
  return true;
}

module.exports = { start, stop, reload, getStatus, pull, runNow, pullMaster, pushMaster, pullMasterRegistry };
