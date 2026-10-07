/**
 * push.js â€” send a notification to someone's phone.
 *
 * 2026-09-18. The app could only ever chime while a till was looking at it:
 * the chime is Web Audio inside the page, and Android's WebView does not
 * implement the web Notification API, so nothing reached the tray and nothing
 * at all happened once the app was closed. This is Firebase Cloud Messaging,
 * the same arrangement Church-POS runs on, which wakes the phone even when the
 * app is not running.
 *
 * Nothing here decides WHO to tell â€” that is services/notify.js, which also
 * writes the in-app bell entry. Routes call notify.js, never this file
 * directly, or a depot with no phone would get nothing at all.
 *
 * â”€â”€ The credential â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 * backend/firebase-service-account.json, which is gitignored: it is a private
 * key with full access to the Firebase project. It is NOT deployed by CI (the
 * VPS pulls from git, and this file is not in git), so it is put on the server
 * by hand, once:
 *
 *     /var/www/kelete-pos-tenant/backend/firebase-service-account.json
 *
 * Without it every send is a silent no-op and a line is logged at boot. That is
 * deliberate: a missing credential must never stop a depot selling.
 */
const fs = require('fs');
const path = require('path');
const db = require('../config/database');

const CRED_PATH = process.env.FIREBASE_CREDENTIALS
  || path.join(__dirname, '..', 'firebase-service-account.json');

let messaging = null;
let initTried = false;

function init() {
  if (initTried) return messaging;
  initTried = true;
  try {
    if (!fs.existsSync(CRED_PATH)) {
      console.log('[push] firebase-service-account.json not found â€” push disabled.');
      return null;
    }
    const admin = require('firebase-admin');
    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert(require(CRED_PATH)) });
    messaging = admin.messaging(app);
    console.log('[push] Firebase ready.');
  } catch (e) {
    console.warn('[push] could not start Firebase:', e.message);
    messaging = null;
  }
  return messaging;
}

const isOn = () => !!init();

// â”€â”€ Tokens â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Every function takes the book to read, because a token belongs with the user
// it is for and users live per depot: a depot's users are in that depot's
// database, HQ's are in HQ's own. A depot raising an expense request has ITS
// book open while the people to be told are at HQ, so the caller says which.
// Passing nothing means the book this request is already on.
const bookOr = (book) => book || db;

// One row per device per user. A phone handed to another cashier registers
// again under that user, and a token can only belong to one user at a time â€”
// otherwise the previous owner keeps getting the alerts.
function saveToken(book, { token, userId, slug, platform }) {
  const b = bookOr(book);
  const t = String(token || '').trim();
  if (!t || !userId) return false;
  b.prepare('DELETE FROM push_tokens WHERE token = ?').run(t);
  b.prepare(
    `INSERT INTO push_tokens (token, user_id, branch_slug, platform, created_at, last_seen_at)
     VALUES (?,?,?,?, datetime('now'), datetime('now'))`
  ).run(t, userId, slug || null, platform || 'android');
  return true;
}

function removeToken(book, token) {
  const b = bookOr(book);
  const t = String(token || '').trim();
  if (!t) return false;
  try { b.prepare('DELETE FROM push_tokens WHERE token = ?').run(t); } catch (_) { return false; }
  return true;
}

function tokensForUsers(book, userIds) {
  const b = bookOr(book);
  const ids = (userIds || []).filter(Boolean);
  if (ids.length === 0) return [];
  const marks = ids.map(() => '?').join(',');
  try {
    return b.prepare(`SELECT token FROM push_tokens WHERE user_id IN (${marks})`)
      .all(...ids).map(r => r.token);
  } catch (_) { return []; }        // book without the table yet
}

// â”€â”€ Sending â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// `channelId` picks the Android notification channel, which is what decides the
// sound and whether it is allowed to interrupt. The channels are created by the
// app on login â€” see frontend/src/utils/pushNotifications.js.
async function sendToTokens(book, tokens, { title, body, data, channelId }) {
  const m = init();
  const list = [...new Set((tokens || []).filter(Boolean))];
  if (!m || list.length === 0) return { sent: 0, failed: 0, skipped: !m };

  // Values must be strings â€” FCM rejects a payload with numbers in `data`.
  const payloadData = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v !== null && v !== undefined) payloadData[k] = String(v);
  }

  const res = await m.sendEachForMulticast({
    tokens: list,
    notification: { title, body },
    data: payloadData,
    android: {
      priority: 'high',
      notification: {
        channelId: channelId || 'kelete-alerts-v1',
        sound: 'default',
        defaultVibrateTimings: true,
      },
    },
  });

  // A phone that was reinstalled, or had its app data cleared, leaves a token
  // behind that can never be delivered to. FCM says so explicitly, and those
  // rows are dropped â€” otherwise every future send carries dead weight.
  res.responses.forEach((r, i) => {
    const code = r.error?.code || '';
    if (/registration-token-not-registered|invalid-argument|invalid-registration-token/.test(code)) {
      try { removeToken(book, list[i]); } catch (_) {}
    }
  });

  return { sent: res.successCount, failed: res.failureCount };
}

module.exports = { isOn, saveToken, removeToken, tokensForUsers, sendToTokens };
