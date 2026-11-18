/**
 * search.js — GET /api/search/notes?q=…
 *
 * 2026-09-18. "Find the document where someone wrote ALLAN" could not be asked
 * before: the box is called `notes` on a GRN, `description` on a payment
 * voucher, `comment` on a cash report and `reason` on a stock adjustment.
 * services/noteSources.js maps those names once; this walks that list.
 *
 * Deliberately defensive about schema: every table and column is checked
 * against the database actually open before it is queried, and a source that
 * does not fit is skipped rather than failing the whole search. Depot books
 * differ in age, and one missing column must not take the search down.
 *
 * Permissions are NOT applied here — each hit carries the `page` key it
 * belongs to and the client drops what the user cannot open. That keeps one
 * definition of who sees what (the Users screen) instead of a second copy.
 */
const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const { masterDb } = require('../config/masterDb');
const { getHostSlug, isHqRequest } = require('../middleware/hqPush');
const { SOURCES } = require('../services/noteSources');

// What a book actually has. Cached per connection — the schema does not move
// while the server is up, and this runs on every keystroke.
const shapeCache = new WeakMap();
function columnsOf(book, table) {
  let byTable = shapeCache.get(book);
  if (!byTable) { byTable = new Map(); shapeCache.set(book, byTable); }
  if (byTable.has(table)) return byTable.get(table);
  let cols = null;
  try {
    const rows = book.prepare(`PRAGMA table_info(${table})`).all();
    cols = rows.length ? new Set(rows.map(r => r.name)) : null;
  } catch (_) { cols = null; }
  byTable.set(table, cols);
  return cols;
}

const PER_SOURCE = 5;      // a few from each, so one chatty table can't fill the list
const TOTAL      = 30;

router.get('/notes', auth, (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;
    const slug = getHostSlug(req);
    const onHq = isHqRequest(req);
    const results = [];

    for (const s of SOURCES) {
      if (results.length >= TOTAL) break;
      const book = s.db === 'master' ? masterDb : db;
      if (!book) continue;
      const cols = columnsOf(book, s.table);
      if (!cols) continue;                                   // table not on this book

      const noteCols = s.cols.filter(c => cols.has(c));
      if (noteCols.length === 0) continue;

      // Only select what this book actually has, so an older depot still works.
      const num  = s.number && cols.has(s.number) ? s.number : null;
      const date = s.date   && cols.has(s.date)   ? s.date   : null;
      const amt  = s.amount && cols.has(s.amount) ? s.amount : null;

      const where = [`(${noteCols.map(c => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`];
      const args  = noteCols.map(() => like);
      if (cols.has('deleted_at')) where.push('(deleted_at IS NULL OR deleted_at = \'\')');
      // master.db holds every depot's rows in one table, so a depot may only
      // see its own. HQ sees all of them.
      if (s.db === 'master' && s.branchCol && cols.has(s.branchCol) && !onHq && slug) {
        where.push(`${s.branchCol} = ?`);
        args.push(slug);
      }

      const select = [
        'rowid AS row_id',
        num  ? `${num} AS number`   : `NULL AS number`,
        date ? `${date} AS date`    : `NULL AS date`,
        amt  ? `${amt} AS amount`   : `NULL AS amount`,
        // The first of this document's note columns that has anything in it.
        // COALESCE needs two arguments or SQLite throws, and most documents
        // have exactly one note column — which silently returned nothing at all
        // until a test asked for a payment voucher and got none.
        (noteCols.length === 1
          ? `NULLIF(${noteCols[0]}, '')`
          : `COALESCE(${noteCols.map(c => `NULLIF(${c}, '')`).join(', ')})`) + ' AS note',
      ].join(', ');

      let rows = [];
      try {
        rows = book.prepare(
          `SELECT ${select} FROM ${s.table} WHERE ${where.join(' AND ')}` +
          (date ? ` ORDER BY ${date} DESC` : '') +
          ` LIMIT ${PER_SOURCE}`
        ).all(...args);
      } catch (_) { continue; }        // a shape we did not expect — skip, don't fail

      for (const r of rows) {
        results.push({
          type:   s.label,
          page:   s.page,
          path:   s.path,
          number: r.number || null,
          date:   r.date ? String(r.date).slice(0, 10) : null,
          amount: r.amount === null || r.amount === undefined ? null : parseFloat(r.amount),
          note:   String(r.note || '').slice(0, 160),
        });
      }
    }

    // Newest first across every kind, so the answer reads like a timeline.
    results.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    res.json({ results: results.slice(0, TOTAL) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
