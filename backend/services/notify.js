/**
 * notify.js — who to tell, and telling them.
 *
 * 2026-09-18. Routes call THIS, never services/push.js directly. push.js knows
 * how to reach a phone; this knows which people a thing concerns and which
 * book they live in, and it is where a second channel (an in-app inbox, an
 * email) would be added later without touching a single trigger site.
 *
 * Every call is fire-and-forget: a notification that cannot be sent must never
 * fail the thing that caused it. A depot confirming a delivery does not care
 * that Firebase is unreachable, and an exception here would roll back its GRN.
 * So every helper resolves, and problems are logged.
 *
 * Which book: a depot's users are in that depot's database, HQ's are in HQ's
 * own (kelete.db / defaultDb). A depot raising an expense request has ITS book
 * open while the people to tell are at HQ, so the book is chosen per call
 * rather than taken from the request.
 */
const db = require('../config/database');
const push = require('./push');

const HQ_BOOK = () => db.defaultDb;
function branchBook(slug) {
  try { return require('../config/tenantDb').getTenantDb(slug); }
  catch (_) { return null; }
}

// Administrator is spelled out because it is a role, not a permission, and
// role names are stored as typed on the Users screen.
function userIdsWithRoles(book, roles) {
  if (!book) return [];
  const list = (roles || []).filter(Boolean);
  if (list.length === 0) return [];
  const marks = list.map(() => '?').join(',');
  try {
    return book.prepare(
      `SELECT id FROM users
        WHERE role IN (${marks})
          AND (deleted_at IS NULL OR deleted_at = '')
          AND (status IS NULL OR LOWER(status) != 'inactive')`
    ).all(...list).map(r => r.id);
  } catch (_) { return []; }
}

async function deliver(book, userIds, payload) {
  try {
    if (!push.isOn()) return { skipped: true };
    const tokens = push.tokensForUsers(book, userIds);
    if (tokens.length === 0) return { sent: 0 };
    return await push.sendToTokens(book, tokens, payload);
  } catch (e) {
    console.warn('[notify]', e.message);
    return { error: e.message };
  }
}

// ── Who ──────────────────────────────────────────────────────────────────────

// Everyone at HQ holding one of these roles.
function notifyHqRoles(roles, payload) {
  const book = HQ_BOOK();
  return deliver(book, userIdsWithRoles(book, roles), payload);
}

// Everyone at one depot holding one of these roles. Roles omitted = everyone
// with an account there, which is what a delivery arriving means.
function notifyBranchRoles(slug, roles, payload) {
  const book = branchBook(slug);
  if (!book) return Promise.resolve({ skipped: true });
  const ids = (roles && roles.length)
    ? userIdsWithRoles(book, roles)
    : (() => {
        try {
          return book.prepare(
            `SELECT id FROM users
              WHERE (deleted_at IS NULL OR deleted_at = '')
                AND (status IS NULL OR LOWER(status) != 'inactive')`).all().map(r => r.id);
        } catch (_) { return []; }
      })();
  return deliver(book, ids, payload);
}

// One named person, in the book they belong to.
function notifyUser(book, userId, payload) {
  return deliver(book || db, [userId].filter(Boolean), payload);
}

module.exports = { notifyHqRoles, notifyBranchRoles, notifyUser };
