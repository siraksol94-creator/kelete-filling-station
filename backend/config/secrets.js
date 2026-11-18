// S3 (security remediation) — one place that supplies the token-signing secret.
//
// Before: eleven files each did `process.env.JWT_SECRET || 'kelete-pro-secret-key-2026'`
// (and routes/admin.js fell back to 'dev-secret'). The Windows installer
// deliberately leaves .env out and electron/main.js never sets JWT_SECRET, so
// EVERY till signed logins with that public string — anyone who has seen this
// source could forge an Administrator token for any till.
//
// Now:
//   • VPS / web / local dev  → JWT_SECRET must be set in backend/.env. If it is
//     missing, or is one of the known public placeholders, the server refuses
//     to start with a clear message instead of running insecurely.
//   • Electron till          → a random secret is generated on first start and
//     kept in the till's own user-data folder (never synced, never in the
//     installer). Every later start reuses it. Effect of the first start after
//     upgrading: users on that till are logged out once and log in again.
//
// A short-but-custom secret is accepted with a warning, not refused, so that an
// existing live .env cannot take the server down on deploy; rotate it at a
// quiet time (logs everyone out once — tokens last 24h anyway).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KNOWN_PUBLIC_VALUES = new Set([
  'kelete-pro-secret-key-2026',
  'dev-secret',
  'your_jwt_secret_here',
  'changeme',
  'change-me',
  'secret',
]);
const MIN_RECOMMENDED_LENGTH = 32;

let cached = null;

function tillSecretFile() {
  return path.join(process.env.ELECTRON_USER_DATA, 'jwt-secret');
}

function loadOrCreateTillSecret() {
  const file = tillSecretFile();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= MIN_RECOMMENDED_LENGTH) return existing;
  } catch (_) { /* first start on this till — create below */ }
  const fresh = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 'wx' = fail if the file appeared in the meantime; then just read it back.
  try {
    fs.writeFileSync(file, fresh, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return fresh;
  } catch (e) {
    if (e.code === 'EEXIST') return fs.readFileSync(file, 'utf8').trim();
    throw e;
  }
}

function getJwtSecret() {
  if (cached) return cached;

  const fromEnv = (process.env.JWT_SECRET || '').trim();
  if (fromEnv) {
    if (KNOWN_PUBLIC_VALUES.has(fromEnv)) {
      throw new Error('[secrets] JWT_SECRET is set to a publicly known placeholder. Set a long random value in backend/.env (e.g. `openssl rand -hex 32`).');
    }
    if (fromEnv.length < MIN_RECOMMENDED_LENGTH) {
      console.warn(`[secrets] JWT_SECRET is shorter than ${MIN_RECOMMENDED_LENGTH} characters. Replace it with a long random value at a quiet time.`);
    }
    cached = fromEnv;
    return cached;
  }

  if (process.env.ELECTRON_USER_DATA) {
    cached = loadOrCreateTillSecret();
    return cached;
  }

  throw new Error('[secrets] JWT_SECRET is not set. Add a long random value to backend/.env (e.g. `openssl rand -hex 32`). The server will not start without it.');
}

// Separate key for the licence-admin panel tokens (routes/admin.js), derived
// from the main secret so a token from one can never be replayed on the other.
function getAdminPanelSecret() {
  return crypto.createHmac('sha256', getJwtSecret()).update('kelete-admin-panel-v1').digest('hex');
}

// Constant-time comparison for shared passwords such as ADMIN_PASSWORD.
function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8');
  const y = Buffer.from(String(b ?? ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = { getJwtSecret, getAdminPanelSecret, safeEqual };
