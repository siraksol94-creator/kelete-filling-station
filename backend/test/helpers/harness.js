// D5 — test harness. REQUIRE THIS FIRST in every test file, before any app
// module, because the app reads its configuration from the environment at
// load time.
//
// Every test file runs in its own process (node --test default), so each gets:
//   • a fresh temporary folder holding ALL its databases, uploads and
//     backups — deleted when the process exits;
//   • KELETE_NO_AUTOSTART=1, so loading the server never listens on a fixed
//     port or starts background jobs (sync, ZRA retry, backups);
//   • a NETWORK GUARD: any outbound connection to anything other than this
//     machine throws. Tests cannot reach keletezm.com, the licence server,
//     ZRA, Firebase or any live system, even by mistake.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Every temporary folder is removed when the process ends — normally, on an
// uncaught error, or when a parent test stops it with a signal (sync suite).
const tempDirs = new Set();
let cleanupInstalled = false;
function cleanupAll() {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} }
  tempDirs.clear();
}
function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('exit', cleanupAll);
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { cleanupAll(); process.exit(128 + (os.constants.signals[sig] || 0)); });
  }
}

function makeTempDir(label = 'kelete-test') {
  installCleanup();
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  tempDirs.add(d);
  return d;
}

// Addresses this machine owns (loopback + its own interfaces).
function localAddresses() {
  const out = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) out.add(n.address);
  }
  return out;
}

let guardInstalled = false;
function installNetworkGuard() {
  if (guardInstalled) return;
  guardInstalled = true;
  const allowed = localAddresses();
  const hostOf = (args) => {
    const a = args[0];
    if (a && typeof a === 'object') return a.path ? null : (a.host || a.hostname || 'localhost');
    if (typeof a === 'string' && !/^\d+$/.test(a)) return null; // unix socket path
    return typeof args[1] === 'string' ? args[1] : 'localhost';
  };
  const check = (host) => {
    if (host === null) return;
    const h = String(host).replace(/^\[|\]$/g, '');
    if (!allowed.has(h)) {
      throw new Error(`[test network guard] outbound connection to "${h}" blocked — tests must not reach external systems`);
    }
  };
  const net = require('net');
  const tls = require('tls');
  for (const [mod, fn] of [[net, 'connect'], [net, 'createConnection'], [tls, 'connect']]) {
    const orig = mod[fn];
    mod[fn] = function guarded(...args) { check(hostOf(args)); return orig.apply(this, args); };
  }
  for (const m of [require('http'), require('https')]) {
    const orig = m.Agent.prototype.createConnection;
    m.Agent.prototype.createConnection = function guarded(opts, ...rest) { check(hostOf([opts])); return orig.call(this, opts, ...rest); };
  }
}

// Configure the environment for one test process. `till: true` makes the app
// behave as an Electron till (ELECTRON_USER_DATA set) — without Electron.
function setupEnv({ till = false } = {}) {
  const dir = makeTempDir();
  const env = {
    KELETE_NO_AUTOSTART: '1',
    NODE_ENV: 'test',
    DB_PATH: path.join(dir, 'kelete.db'),
    MASTER_DB_PATH: path.join(dir, 'master.db'),
    TENANTS_DIR: path.join(dir, 'tenants'),
    UPLOADS_DIR: path.join(dir, 'uploads'),
    CHAT_FILES_DIR: path.join(dir, 'chat-files'),
    KELETE_BACKUP_DIR: path.join(dir, 'backups'),
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    ADMIN_PASSWORD: crypto.randomBytes(16).toString('hex'),
    // Anything that would phone home points at a closed local port.
    VPS_URL: 'http://127.0.0.1:9',
    CB_ACTIVATE_URL: 'http://127.0.0.1:9/activate',
  };
  for (const k of ['ELECTRON_USER_DATA', 'KELETE_ALLOW_REMOTE_UI', 'KELETE_BIND_HOST', 'PORT', 'TENANT_PORT']) delete process.env[k];
  Object.assign(process.env, env);
  if (till) {
    process.env.ELECTRON_USER_DATA = path.join(dir, 'userData');
    fs.mkdirSync(process.env.ELECTRON_USER_DATA, { recursive: true });
    delete process.env.JWT_SECRET; // a till generates its own (S3)
    delete process.env.DB_PATH;    // a till keeps kelete.db in userData
  }
  installNetworkGuard();
  return { dir };
}

module.exports = { setupEnv, makeTempDir, installNetworkGuard, localAddresses };
