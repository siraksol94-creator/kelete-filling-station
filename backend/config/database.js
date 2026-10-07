const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('async_hooks');
const { initTenantDb } = require('./migrations');

// â”€â”€â”€ AsyncLocalStorage: one DB per request context â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const als = new AsyncLocalStorage();
const dbPool = new Map(); // dbPath â†’ Database instance

function openDb(dbPath) {
  if (!dbPool.has(dbPath)) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const d = new Database(dbPath);
    d.pragma('journal_mode = WAL');
    d.pragma('foreign_keys = ON');
    // Keep WAL file small so checkpoints don't pause the DB.
    // 1000 pages â‰ˆ 4MB before SQLite auto-checkpoints.
    d.pragma('wal_autocheckpoint = 1000');
    d.pragma('synchronous = NORMAL');
    dbPool.set(dbPath, d);
    console.log(`[db] Opened: ${dbPath}`);
  }
  return dbPool.get(dbPath);
}

// â”€â”€â”€ Default DB (Electron / local dev / VPS single-tenant) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let defaultDbPath;
if (process.env.DB_PATH) {
  defaultDbPath = process.env.DB_PATH;
} else if (process.env.ELECTRON_USER_DATA) {
  defaultDbPath = path.join(process.env.ELECTRON_USER_DATA, 'kelete.db');
} else {
  defaultDbPath = path.join(__dirname, '..', 'kelete.db');
}

const defaultDb = openDb(defaultDbPath);
initTenantDb(defaultDb);
console.log('Connected to SQLite database');

// â”€â”€â”€ Proxy: all property accesses go to the current-request DB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Helpers (openDb, defaultDb, runWithDb) live on the proxy's own target object
// so they don't get intercepted and forwarded to the underlying DB.
const _helpers = {};

const HELPER_KEYS = new Set(['openDb', 'defaultDb', 'runWithDb']);

const proxy = new Proxy(_helpers, {
  get(target, prop) {
    if (HELPER_KEYS.has(prop)) return target[prop];
    const db = als.getStore() || defaultDb;
    const val = db[prop];
    return typeof val === 'function' ? val.bind(db) : val;
  },
  set(target, prop, value) {
    target[prop] = value; // helpers and any external assignments go on target
    return true;
  }
});

proxy.openDb = openDb;
proxy.defaultDb = defaultDb;
proxy.runWithDb = (db, fn) => als.run(db, fn);

module.exports = proxy;
