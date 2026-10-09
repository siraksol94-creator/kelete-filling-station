// FX Rates — per-branch history of USD↔FRA conversion rates.
//
// Used only by dual-currency branches (currency_mode='USD+FRA'). The Cashier
// reads the latest effective row via GET /current; the manager adds new rows
// from Accounting → Currency Rates. Old rows are kept for audit and so old
// receipts replay with the rate that was in effect when the order was paid.
//
// Permission gate: 'FxRates' page perm (admin always; others granted via the
// Users page perm catalog, same pattern as Cashier / Dispatch).
const router = require('express').Router();
const https = require('https');
const db = require('../config/database');
const { auth, readOnlyGuard, requirePagePerm } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');

// In-memory cache for the BCC live rate. open.er-api.com refreshes daily,
// so a 30-minute server-side cache is more than enough and protects the
// upstream from rapid Refresh-button mashing.
//
// open.er-api.com is the source the user picked for the card. It only
// publishes "latest" (no historical endpoint), so the chart still uses
// fawazahmed0 for past 6 days — but today's chart point is filled from
// THIS cache so the card and the most-recent chart bar always agree.
const LIVE_TTL_MS = 30 * 60 * 1000;
let liveCache = null; // { fetchedAt, payload }

function fetchLiveUsdCdf() {
  return new Promise((resolve, reject) => {
    const req = https.get('https://open.er-api.com/v6/latest/USD', {
      timeout: 6000,
      headers: { 'User-Agent': 'kelete-pos/1.0' },
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.result !== 'success' || !j.rates || !j.rates.CDF) {
            return reject(new Error('Unexpected response from open.er-api.com'));
          }
          resolve({
            source: 'open.er-api.com (BCC official)',
            base: 'USD',
            quote: 'CDF',
            rate: parseFloat(j.rates.CDF),
            time_last_update: j.time_last_update_utc || null,
            time_next_update: j.time_next_update_utc || null,
          });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Live rate request timed out')); });
    req.on('error', reject);
  });
}

// fawazahmed0/currency-api hosts daily snapshots from 2024-03-06 onwards.
// jsdelivr URL pattern, no auth required:
//   https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@YYYY-MM-DD/v1/currencies/usd.json
// Historical entries never change so we cache them forever (process lifetime).
const historyCache = new Map(); // 'YYYY-MM-DD' -> { rate, fetchedAt }
const HISTORY_TODAY_TTL_MS = 30 * 60 * 1000;

function fetchUsdCdfOnDate(date) {
  return new Promise((resolve, reject) => {
    const url = `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${date}/v1/currencies/usd.json`;
    const tryGet = (u, hopsLeft) => {
      const req = https.get(u, { timeout: 6000, headers: { 'User-Agent': 'kelete-pos/1.0' } }, (res) => {
        // jsdelivr 301-redirects to a versioned URL on the actual CDN
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hopsLeft > 0) {
          res.resume();
          return tryGet(res.headers.location, hopsLeft - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${date}`));
        }
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            const r = j?.usd?.cdf;
            if (typeof r !== 'number') return reject(new Error(`No CDF for ${date}`));
            resolve(r);
          } catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => { req.destroy(new Error(`Timeout on ${date}`)); });
      req.on('error', reject);
    };
    tryGet(url, 3);
  });
}

// ─── List all rates (most recent first) ──────────────────────────────────────
// v1.8.2: optional `since` query (YYYY-MM-DD) to fetch rates effective from
// that date onwards — used by the chart's 1d / 7d / 1m tabs.
router.get('/', auth, readOnlyGuard, requirePagePerm('FxRates'), (req, res) => {
  try {
    const since = (req.query.since || '').slice(0, 10);
    const params = [req.user.tenantId];
    let where = 'deleted_at IS NULL AND tenant_id = ?';
    if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
      where += ' AND effective_date >= ?';
      params.push(since);
    }
    const rows = db.prepare(`
      SELECT id, sync_id, effective_date, effective_at, sell_rate, buy_rate,
             sell_rate_k, buy_rate_k,
             notes, set_by, set_by_name, created_at, updated_at
      FROM fx_rates
      WHERE ${where}
      ORDER BY COALESCE(effective_at, effective_date || ' 00:00:00') DESC, id DESC
    `).all(...params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Current effective rate (used by Cashier / POS) ──────────────────────────
// v1.8.2: picks the latest rate whose effective_at <= NOW() (or effective_date
// if no effective_at set). Rates can now flip mid-day; this returns whatever
// is in force right now.
router.get('/current', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(`
      SELECT id, sync_id, effective_date, effective_at, sell_rate, buy_rate,
             sell_rate_k, buy_rate_k,
             notes, set_by_name
      FROM fx_rates
      WHERE deleted_at IS NULL AND tenant_id = ?
        AND COALESCE(effective_at, effective_date || ' 00:00:00') <= datetime('now')
      ORDER BY COALESCE(effective_at, effective_date || ' 00:00:00') DESC, id DESC
      LIMIT 1
    `).get(req.user.tenantId);
    res.json(row || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Add a new rate ──────────────────────────────────────────────────────────
// v1.7.0: optional sell_rate_k / buy_rate_k for K (third currency). Both are
// optional — branches on USD+FRA mode just omit them.
router.post('/', auth, requirePagePerm('FxRates'), (req, res) => {
  try {
    const effective_date = (req.body.effective_date || '').slice(0, 10);
    // v1.8.2: optional intra-day timestamp. Accept either:
    //   effective_at  — full 'YYYY-MM-DD HH:MM' / 'YYYY-MM-DDTHH:MM' string, OR
    //   effective_time — 'HH:MM' (combined with effective_date)
    // Falls back to NOW() when neither is provided.
    // v1.8.81 — TIMEZONE FIX: SELECT in /current compares against SQLite's
    // datetime('now') which is UTC, but we previously stored effective_at as
    // a local-time string. That made every just-saved rate appear "future"
    // by the UTC offset (~2h for Lusaka), so the Cashier fell back to the
    // hardcoded 2900/2600 defaults until UTC caught up.
    // Now: always store effective_at in UTC.
    //
    // localTimeToUtcStr interprets the input as server-local time and
    // returns UTC. When backend runs in the same TZ as the user (typical
    // for keletezm.com deployed in Lusaka), user-supplied times convert
    // correctly. The auto-now path uses UTC directly regardless.
    const localTimeToUtcStr = (localTimeStr) => {
      const s = String(localTimeStr).replace('T', ' ');
      const [datePart, timePart = '00:00:00'] = s.split(' ');
      const [y, m, d] = datePart.split('-').map(Number);
      const [hh, mm, ss = 0] = timePart.split(':').map(Number);
      return new Date(y, m - 1, d, hh, mm, ss || 0)
        .toISOString().slice(0, 19).replace('T', ' ');
    };
    let effective_at;
    if (req.body.effective_at) {
      // v1.8.82 — frontend now sends UTC directly (computed in the browser
      // where the user's local tz is known). Store as-is. No double conversion.
      let utcStr = String(req.body.effective_at).replace('T', ' ').slice(0, 19);
      if (utcStr.length === 16) utcStr += ':00';
      effective_at = utcStr;
    } else if (req.body.effective_time) {
      // Legacy path for older clients — assumes server tz matches user tz
      // (correct when both are on the same machine, broken across regions).
      effective_at = localTimeToUtcStr(`${effective_date} ${String(req.body.effective_time).slice(0, 5)}:00`);
    } else {
      // Auto NOW — use UTC directly so it matches SQLite datetime('now')
      effective_at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    }
    const sell = parseFloat(req.body.sell_rate);
    const buy  = parseFloat(req.body.buy_rate);
    const sellK = req.body.sell_rate_k !== undefined && req.body.sell_rate_k !== '' ? parseFloat(req.body.sell_rate_k) : null;
    const buyK  = req.body.buy_rate_k  !== undefined && req.body.buy_rate_k  !== '' ? parseFloat(req.body.buy_rate_k)  : null;
    const notes = req.body.notes ? String(req.body.notes).trim() : null;
    if (!effective_date || !/^\d{4}-\d{2}-\d{2}$/.test(effective_date)) {
      return res.status(400).json({ error: 'effective_date (YYYY-MM-DD) is required' });
    }
    if (!isFinite(sell) || sell <= 0) return res.status(400).json({ error: 'sell_rate must be > 0' });
    if (!isFinite(buy)  || buy  <= 0) return res.status(400).json({ error: 'buy_rate must be > 0' });
    if (sellK !== null && (!isFinite(sellK) || sellK <= 0)) return res.status(400).json({ error: 'sell_rate_k must be > 0 if provided' });
    if (buyK  !== null && (!isFinite(buyK)  || buyK  <= 0)) return res.status(400).json({ error: 'buy_rate_k must be > 0 if provided'  });

    const cfg = syncConfig.getConfig() || {};
    const result = db.prepare(`
      INSERT INTO fx_rates
        (sync_id, effective_date, effective_at, sell_rate, buy_rate, sell_rate_k, buy_rate_k, notes,
         set_by, set_by_name, tenant_id, branch_id, device_id, synced)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      randomUUID(), effective_date, effective_at, sell, buy, sellK, buyK, notes,
      req.user.id, req.user.name || req.user.email || null,
      req.user.tenantId, cfg.branchId || null, cfg.deviceId || null,
    );
    const row = db.prepare('SELECT * FROM fx_rates WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Soft-delete a rate ──────────────────────────────────────────────────────
router.delete('/:id', auth, requirePagePerm('FxRates'), (req, res) => {
  try {
    const row = db.prepare('SELECT id FROM fx_rates WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL')
      .get(req.params.id, req.user.tenantId);
    if (!row) return res.status(404).json({ error: 'Rate not found' });
    db.prepare("UPDATE fx_rates SET deleted_at = datetime('now'), updated_at = datetime('now'), synced = 0 WHERE id = ?")
      .run(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Live BCC rate (reference only — POS/Cashier do NOT use this) ───────────
// Returns the upstream rate verbatim plus a fetchedAt stamp so the UI can
// show "updated 14:05". Cached in-memory for 30min to be polite to the
// free public API.
// Returns today's value AND mirrors it into historyCache for the chart so
// /live-history's most-recent point uses the exact same number this card
// just displayed (single source of truth for "today").
router.get('/live', auth, readOnlyGuard, async (req, res) => {
  try {
    const fresh = liveCache && (Date.now() - liveCache.fetchedAt) < LIVE_TTL_MS;
    if (!fresh) {
      const payload = await fetchLiveUsdCdf();
      liveCache = { fetchedAt: Date.now(), payload };
      const todayStr = new Date().toISOString().slice(0, 10);
      historyCache.set(todayStr, { rate: payload.rate, fetchedAt: Date.now() });
    }
    res.json({
      ...liveCache.payload,
      cached: !!liveCache && (Date.now() - liveCache.fetchedAt) > 100,
      fetchedAt: new Date(liveCache.fetchedAt).toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Failed to fetch live rate' });
  }
});

// ─── Live rate history (last N days) ────────────────────────────────────────
// Used by the Currency Rates chart. Returns an array of {date, rate} from
// today going back days-1 days. Missing/failed days come back as rate:null
// so the chart can break the line rather than failing the whole request.
router.get('/live-history', auth, readOnlyGuard, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 7, 30));
    const today = new Date();
    const todayStr = today.toISOString().slice(0, 10);
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const series = await Promise.all(dates.map(async (date) => {
      const cached = historyCache.get(date);
      const isToday = date === todayStr;
      if (cached && (!isToday || (Date.now() - cached.fetchedAt) < HISTORY_TODAY_TTL_MS)) {
        return { date, rate: cached.rate };
      }
      try {
        // TODAY uses the same upstream as the Live Market Rate card
        // (open.er-api.com) so the card and the chart's last point agree
        // exactly. Past days come from fawazahmed0 because open.er-api.com
        // doesn't expose a historical endpoint.
        let rate;
        if (isToday) {
          const payload = await fetchLiveUsdCdf();
          rate = payload.rate;
          liveCache = { fetchedAt: Date.now(), payload };
        } else {
          rate = await fetchUsdCdfOnDate(date);
        }
        historyCache.set(date, { rate, fetchedAt: Date.now() });
        return { date, rate };
      } catch {
        return { date, rate: null };
      }
    }));
    res.json({
      source: 'open.er-api.com (today) + fawazahmed0/currency-api (past days)',
      base: 'USD',
      quote: 'CDF',
      days,
      series,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
