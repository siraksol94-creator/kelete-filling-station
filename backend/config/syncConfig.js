const crypto = require('crypto');
const db = require('./database'); // Proxy: routes to the request-scoped tenant DB.

// init() used to cache a single DB reference, which broke the VPS path:
// server-tenant.js never calls init, so _db stayed null, nextSeq always
// returned 1, and every numbered doc (GRN/SIV/Orders/...) collided on the
// second save with "UNIQUE constraint failed". The proxy fixes that — every
// get/set now hits the current request's tenant DB automatically.
function init() {
  // Backwards-compat shim: still seed device_id + install_date on Electron
  // startup. On the VPS this is also called per-tenant the first time
  // generateNumber() runs (via ensureDeviceId below), so each tenant DB
  // gets its own device shortcode.
  if (!get('device_id')) {
    set('device_id', crypto.randomUUID());
  }
  if (!get('install_date')) {
    set('install_date', new Date().toISOString());
  }
}

function ensureDeviceId() {
  if (!get('device_id')) set('device_id', crypto.randomUUID());
}

function get(key) {
  const row = db.prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

function set(key, value) {
  db.prepare('INSERT OR REPLACE INTO sync_config (key, value) VALUES (?, ?)').run(key, String(value));
}

function getConfig() {
  return {
    tenantId:     get('tenant_id'),
    branchId:     get('branch_id'),
    deviceId:     get('device_id'),

    lastPullTime: get('last_pull_time') || '1970-01-01T00:00:00.000Z',
    isConfigured: !!get('tenant_id'),
  };
}

function setRegistration(tenantId, branchId) {
  set('tenant_id', tenantId);
  set('branch_id', branchId);
}

function updateLastPullTime(isoString) {
  set('last_pull_time', isoString);
}

// Returns an ever-increasing integer per table, stored in sync_config.
// Survives restarts; safe for offline multi-device unique number generation.
function nextSeq(tableName) {
  const key = `seq_${tableName}`;
  const next = parseInt(get(key) || '0') + 1;
  set(key, next);
  return next;
}

// Convention map: number column for each table. Used by generateNumber to
// look at the actual DB and self-heal if sync_config.seq_xxx drifts below
// what already exists (e.g. after a restore or after sync pulls in records
// with higher sequences from another device).
const NUMBER_COLUMNS = {
  grn:                   'grn_number',
  siv:                   'siv_number',
  orders:                'order_number',
  cash_receipts:         'receipt_number',
  payment_vouchers:      'voucher_number',
  ap_payments:           'payment_number',
  sales_returns:         'return_number',
  empty_returns:         'return_number',
  cash_transfers:        'transfer_number',
  stock_adjustments:     'adjustment_number',
  production:            'production_number',
  supplier_credit_notes: 'credit_note_number',
  capital_account:       'entry_number',
  dividend_account:      'entry_number',
  loans:                 'loan_number',
  loan_transactions:     'transaction_number',
  // v1.13.67 — customer-side empty deposit voucher (bearer ticket).
  empty_vouchers:        'voucher_number',
};

// Generates a unique document number like  ORD-2024-A1B2C3-0001
// prefix  : 'ORD', 'GRN', etc.
// table   : used for the per-device sequence counter AND collision check against the DB
function generateNumber(prefix, table) {
  ensureDeviceId(); // Make sure this tenant DB has a stable device shortcode.
  const cfg = getConfig();
  const shortCode = cfg.deviceId
    ? cfg.deviceId.replace(/-/g, '').substring(0, 6).toUpperCase()
    : 'LOCAL1';
  const year = new Date().getFullYear();
  const numberCol = NUMBER_COLUMNS[table];

  // Self-heal: find the highest seq already in the table for this device's prefix.
  // Bring the sync_config counter forward if it's behind. Prevents UNIQUE constraint
  // failures when sync_config drifts (sync pulled higher seqs in, DB was restored, etc).
  if (numberCol) {
    try {
      const prefixPattern = `${prefix}-${year}-${shortCode}-`;
      const row = db.prepare(
        `SELECT ${numberCol} AS num FROM ${table} WHERE ${numberCol} LIKE ? ORDER BY ${numberCol} DESC LIMIT 1`
      ).get(prefixPattern + '%');
      if (row && row.num) {
        const seqStr = String(row.num).split('-').pop();
        const dbSeq = parseInt(seqStr, 10);
        const storedSeq = parseInt(get(`seq_${table}`) || '0', 10);
        if (!isNaN(dbSeq) && dbSeq >= storedSeq) {
          set(`seq_${table}`, dbSeq);  // counter is now equal to dbSeq; nextSeq() below adds 1
        }
      }
    } catch { /* table/column may not exist on this DB — fall through to plain increment */ }
  }

  const seq = String(nextSeq(table)).padStart(4, '0');
  return `${prefix}-${year}-${shortCode}-${seq}`;
}

// Returns tenantId from JWT (req.user) if available, otherwise falls back to sync_config.
// This ensures web version (VPS) uses the correct tenantId from the logged-in user's token.
function getTenantId(req) {
  return (req && req.user && req.user.tenantId) || get('tenant_id');
}

// LAN architecture: Mother PC <-> Child PC sync configuration
function getLanConfig() {
  return {
    role:        get('lan_role') || 'child',          // 'mother' | 'child' (default: child = legacy direct-to-VPS)
    motherIp:    get('mother_ip') || '',
    lanSyncKey:  get('lan_sync_key') || '',
  };
}

function setLanConfig({ role, motherIp, lanSyncKey }) {
  if (role !== undefined)        set('lan_role', role);
  if (motherIp !== undefined)    set('mother_ip', motherIp);
  if (lanSyncKey !== undefined)  set('lan_sync_key', lanSyncKey);
}

module.exports = { init, get, set, getConfig, setRegistration, updateLastPullTime, generateNumber, getTenantId, getLanConfig, setLanConfig };
