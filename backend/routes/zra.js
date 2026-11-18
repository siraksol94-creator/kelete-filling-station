// ZRA Smart Invoice (VSDC) integration routes.
//
// Config / init lives here + Step 3 code+item-class+notices sync.
// Sale-time signing, item registration, credit notes, stock and purchase
// upload land in later steps.
//
// Every VSDC round-trip goes through services/vsdcClient.js so tpin/bhfId
// injection, timeouts and audit logging are consistent.
const router = require('express').Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { randomUUID } = require('crypto');
const crypto = require('crypto');   // timingSafeEqual for the VSDC proxy secret
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const vsdc = require('../services/vsdcClient');
const syncConfig = require('../config/syncConfig');
const { masterDb, listTenants, isRegistered } = require('../config/masterDb');
const { retryOrder: zraRetryOrder } = require('../services/zraRetryQueue');

// ─── ZRA supplier → local supplier ────────────────────────────────────────
//
// 2026-08-30. A pulled purchase arrives with only the supplier's TPIN and
// their ZRA-registered name. hqGrns.js resolves the supplier for a GRN by
// exact name match against the local suppliers table:
//
//     SELECT id, sync_id FROM suppliers WHERE LOWER(name) = LOWER(?)
//
// so a ZRA name with no local counterpart produced a GRN with no supplier
// link, which reached AP Approvals as an orphan — a name on screen with
// nothing behind it to reconcile against the supplier ledger.
//
// Resolving it here, at approval, fixes the whole chain without touching it:
// once a local supplier with that exact name exists and is stamped on the
// purchase, the existing name match downstream links it by itself.
//
// Order of preference, strongest identity first:
//   1. A remembered mapping for this TPIN.
//   2. A local supplier carrying the same TPIN.
//   3. A local supplier with the same name (the rule the GRN step uses).
//   4. Create one from the ZRA details.
// Whatever is chosen is remembered against the TPIN, so it happens once.
//
// IMPORTANT: reads and writes defaultDb, not the request-scoped proxy. HQ's
// supplier list lives in backend/kelete.db, and hqGrns.js looks it up with
// require('../config/database').defaultDb. Using the proxy here would create
// the supplier in a database the GRN step never looks at, and the orphan
// would persist while appearing fixed.
// `preview: true` answers the same question WITHOUT writing anything — no
// supplier created, no mapping remembered. The purchase modal uses it to show
// the operator what approval is going to do, since the supplier link used to
// happen invisibly and there was no way to tell a match from a new record.
function resolveZraSupplier({ tpin, name, userId, preview }) {
  const { defaultDb } = require('../config/database');
  if (!defaultDb) return null;

  const cleanTpin = (tpin || '').toString().trim() || null;
  const cleanName = (name || '').toString().trim() || null;
  if (!cleanTpin && !cleanName) return null;

  const rememberStmt = () => defaultDb.prepare(`
    INSERT INTO zra_supplier_map (spplr_tpin, spplr_nm, action, supplier_id, supplier_sync_id, supplier_name, created_by)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(spplr_tpin) DO UPDATE SET
      spplr_nm         = excluded.spplr_nm,
      action           = excluded.action,
      supplier_id      = excluded.supplier_id,
      supplier_sync_id = excluded.supplier_sync_id,
      supplier_name    = excluded.supplier_name,
      updated_at       = datetime('now')
  `);

  const remember = (action, sup) => {
    if (preview) return;                  // preview never writes
    if (!cleanTpin) return;               // nothing to key the memory on
    try {
      rememberStmt().run(cleanTpin, cleanName, action, sup.id, sup.sync_id, sup.name, userId || null);
    } catch (_) { /* remembering is an optimisation, never fail the approval */ }
  };

  // 1. Remembered.
  if (cleanTpin) {
    try {
      const m = defaultDb.prepare('SELECT supplier_id, supplier_sync_id, supplier_name FROM zra_supplier_map WHERE spplr_tpin = ?').get(cleanTpin);
      if (m && m.supplier_name) {
        // Confirm it still exists — a supplier deleted since being mapped
        // would otherwise re-orphan every future purchase silently.
        const still = defaultDb.prepare('SELECT id, sync_id, name FROM suppliers WHERE id = ? OR sync_id = ? LIMIT 1')
          .get(m.supplier_id || -1, m.supplier_sync_id || '');
        if (still) return { id: still.id, sync_id: still.sync_id, name: still.name, how: 'REMEMBERED' };
      }
    } catch (_) { /* table may not exist yet on an un-migrated install */ }
  }

  // 2. Same TPIN.
  if (cleanTpin) {
    try {
      const byTpin = defaultDb.prepare("SELECT id, sync_id, name FROM suppliers WHERE tpin = ? AND (deleted_at IS NULL OR deleted_at = '') LIMIT 1").get(cleanTpin);
      if (byTpin) { remember('MAP', byTpin); return { ...byTpin, how: 'TPIN' }; }
    } catch (_) { /* older schema without tpin or deleted_at */ }
  }

  // 3. Same name — matching hqGrns.js exactly, so what links here links there.
  if (cleanName) {
    try {
      const byName = defaultDb.prepare('SELECT id, sync_id, name FROM suppliers WHERE LOWER(name) = LOWER(?) LIMIT 1').get(cleanName);
      if (byName) {
        // Stamp the TPIN on to it while we know it, so the stronger match
        // above wins next time even if they rename themselves at ZRA.
        if (cleanTpin) {
          try { defaultDb.prepare("UPDATE suppliers SET tpin = ? WHERE id = ? AND (tpin IS NULL OR tpin = '')").run(cleanTpin, byName.id); } catch (_) {}
        }
        remember('MAP', byName);
        return { ...byName, how: 'NAME' };
      }
    } catch (_) { /* fall through to create */ }
  }

  // 4. Create. An unmapped supplier is exactly what causes the orphan, so
  //    the default is to make one rather than leave the purchase dangling.
  if (!cleanName) return null;
  if (preview) return { id: null, sync_id: null, name: cleanName, how: 'WILL_CREATE' };
  try {
    const { randomUUID } = require('crypto');
    const syncConfig = require('../config/syncConfig');
    const syncId = randomUUID();
    let tenantId = null, branchId = null, deviceId = null;
    try {
      tenantId = syncConfig.getTenantId({}) || null;
      const cfg = syncConfig.getConfig() || {};
      branchId = cfg.branchId || null;
      deviceId = cfg.deviceId || null;
    } catch (_) { /* best effort — the row is still usable without them */ }

    const cols = defaultDb.prepare('PRAGMA table_info(suppliers)').all().map(c => c.name);
    const has  = (c) => cols.includes(c);

    const names  = ['name', 'status'];
    const vals   = [cleanName, 'Active'];
    const push = (col, val) => { if (has(col)) { names.push(col); vals.push(val); } };
    push('tpin', cleanTpin);
    push('type', 'Supplier');
    push('sync_id', syncId);
    push('tenant_id', tenantId);
    push('branch_id', branchId);
    push('device_id', deviceId);
    push('synced', 0);

    const info = defaultDb.prepare(
      `INSERT INTO suppliers (${names.join(', ')}) VALUES (${names.map(() => '?').join(',')})`
    ).run(...vals);

    const created = { id: info.lastInsertRowid, sync_id: syncId, name: cleanName };
    remember('CREATE', created);
    return { ...created, how: 'CREATED' };
  } catch (e) {
    console.error('[zra.supplier] could not create supplier:', e.message);
    return null;
  }
}


const { getTenantDb } = require('../config/tenantDb');

// v1.13.37 — 30 MB in-memory upload cap for the UNSPSC Excel importer.
// The official ZRA sheet is ~17 MB × 40 k rows.
const xlsxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

// Which business_settings columns hold ZRA state. Kept in one place so
// the GET, PUT and Init responses stay in sync.
const ZRA_CONFIG_COLS = [
  'zra_enabled', 'zra_env', 'zra_vsdc_url',
  'zra_tpin', 'zra_bhf_id', 'zra_dvc_srl_no',
  // v1.13.102 — T11A offline-block toggle. Editable via PUT /settings
  // (unlike zra_enabled, which is auto-set by Initialize Device).
  'zra_block_offline_sales',
  // v1.13.154 — HQ-device proxy branch. Only meaningful on HQ's own
  // row (HQ has no VSDC device by default — Pattern A); branches
  // ignore this since resolveHqZraProxy checks their OWN device first.
  'zra_proxy_branch_slug',
  // 2026-08-27 — shared secret an Electron till presents to the VSDC
  // proxy. Editable so a compromised value can be rotated: change it
  // here and on the till. Auto-generated at migration time, so it is
  // never blank and never a shipped default.
  'zra_proxy_secret',
];
const ZRA_INIT_COLS = [
  'zra_sdc_id', 'zra_mrc_no', 'zra_taxpr_nm', 'zra_vat_ty_cd',
  'zra_last_invc_no', 'zra_last_sale_invc_no', 'zra_last_pchs_invc_no',
  'zra_last_sale_rcpt_no', 'zra_last_train_invc_no',
  'zra_last_profrm_invc_no', 'zra_last_copy_invc_no',
  'zra_initialized_at',
];
const ALL_ZRA_COLS = [...ZRA_CONFIG_COLS, ...ZRA_INIT_COLS];

// ─── Config / Init ──────────────────────────────────────────────────────

// Resolve a business_settings row from a presented proxy secret.
//
// 2026-08-27 — the proxy and device-identity endpoints have no logged-in
// user to scope by tenant, so they originally read `business_settings
// LIMIT 1`. A tenant DB can hold MORE THAN ONE settings row (garden.db
// has two), and LIMIT 1 without ORDER BY returns whichever SQLite feels
// like — so a correctly-pasted secret was compared against a different
// row's value and rejected as invalid.
//
// Match against EVERY row instead and return the one that owns the
// secret; that row is then the authoritative config for this call.
// Comparison stays timing-safe, and the length pre-check matters because
// timingSafeEqual throws on mismatched buffer lengths.
function resolveBySecret(presented) {
  if (!presented) return null;
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT id, tenant_id, zra_vsdc_url, zra_proxy_secret,
              zra_sdc_id, zra_mrc_no, zra_taxpr_nm, zra_vat_ty_cd,
              zra_last_invc_no, zra_last_sale_invc_no, zra_last_pchs_invc_no,
              zra_last_sale_rcpt_no, zra_last_train_invc_no, zra_last_copy_invc_no
         FROM business_settings`
    ).all();
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

// ─── VSDC proxy for Electron tills ─────────────────────────────────────
//
// POST /api/zra/vsdc-proxy/*
//
// 2026-08-27 — lets an Electron desktop obtain a SIGNED receipt without
// installing Tomcat locally.
//
// Electron runs its own backend against its own SQLite, so a sale there
// is created locally — for it to be fiscalised at the till, Electron must
// reach VSDC. But VSDC lives on the VPS at localhost:8080 and the spec is
// explicit that the port stays firewalled so only the POS can reach it.
// Exposing it publicly is not an option.
//
// This forwards an authenticated VSDC call from the desktop to the VPS's
// own VSDC and returns the reply verbatim. The till gets its signature
// and QR in one round trip; VSDC itself stays private.
//
// Set the Electron install's zra_vsdc_url to:
//   https://<host>/api/zra/vsdc-proxy
// and its vsdcClient calls resolve to /api/zra/vsdc-proxy/trnsSales/saveSales
// etc., which map 1:1 onto the real VSDC paths.
//
// Guard rails:
//   * `auth` — same session/token as every other endpoint. No anonymous
//     access; this is not an open relay.
//   * The destination is ALWAYS this tenant's configured zra_vsdc_url.
//     The caller supplies only the VSDC sub-path, never a host, so it
//     cannot be pointed at an arbitrary target (SSRF).
//   * Sub-path is whitelisted by shape (letters, digits, / and -) so a
//     traversal like ../ cannot escape the VSDC context.
// NOTE: deliberately NOT behind `auth`. vsdcClient is machine-to-machine
// — it fires mid-sale and carries no user session — so a JWT-gated proxy
// would 401 every call. It authenticates on the branch's shared secret
// (business_settings.zra_proxy_secret) instead, sent as
// X-VSDC-Proxy-Secret. Compared with a timing-safe equality check so the
// secret cannot be recovered byte-by-byte.
router.post(/^\/vsdc-proxy\/(.+)$/, async (req, res) => {
  try {
    const subPath = String(req.params[0] || '').trim();
    if (!/^[A-Za-z0-9/_-]+$/.test(subPath)) {
      return res.status(400).json({ error: 'Invalid VSDC path' });
    }

    // Resolve the branch from the secret itself — the caller is a till,
    // not a logged-in user, so there is no req.user to trust. Only a
    // holder of this branch's secret can drive this branch's VSDC.
    const presented = String(req.get('X-VSDC-Proxy-Secret') || '');
    if (!presented) return res.status(401).json({ error: 'Missing proxy secret' });

    const row = resolveBySecret(presented);
    if (!row) return res.status(401).json({ error: 'Invalid proxy secret' });

    const cfg = { zra_vsdc_url: row.zra_vsdc_url };
    if (!cfg?.zra_vsdc_url) {
      return res.status(400).json({ error: 'No VSDC URL configured for this tenant' });
    }
    // Refuse to forward to ourselves — a misconfigured install pointing
    // its VSDC URL back at the proxy would otherwise loop.
    if (/\/vsdc-proxy(\/|$)/.test(String(cfg.zra_vsdc_url))) {
      return res.status(400).json({ error: 'VSDC URL on this host points at the proxy itself — set it to the real local VSDC.' });
    }
    const base = String(cfg.zra_vsdc_url).replace(/\/+$/, '');
    const url  = `${base}/${subPath}`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(25_000),
    });
    const text = await upstream.text();
    // Pass the reply through untouched — the caller's own vsdcClient
    // parses resultCd and logs to its audit table exactly as it would
    // against a local VSDC.
    res.status(upstream.status).type('application/json').send(text);
  } catch (error) {
    // A connection-level failure must look like one to the caller, so its
    // offline guard and retry logic behave the same as they would if it
    // had reached VSDC directly.
    res.status(502).json({ error: `VSDC unreachable via proxy: ${error.message}` });
  }
});

// GET /api/zra/device-identity — the device identity this branch already
// holds, for a till that cannot register its own.
//
// 2026-08-27 — ZRA registers a device ONCE (spec 5.1: "only called once
// for any new device registration"); a second selectInitInfo returns 902
// "This device is installed". An Electron till is not a new device — it
// is the SAME device as the VPS (same TPIN + bhfId + serial), reaching
// the same VSDC through the proxy. So it must COPY the identity rather
// than request one.
//
// Authenticated on the proxy secret, exactly like the proxy itself: the
// caller is a machine mid-setup, not a logged-in user.
router.get('/device-identity', (req, res) => {
  try {
    const presented = String(req.get('X-VSDC-Proxy-Secret') || '');
    if (!presented) return res.status(401).json({ error: 'Missing proxy secret' });
    const row = resolveBySecret(presented);
    if (!row) return res.status(401).json({ error: 'Invalid proxy secret' });
    // Never echo the secret back, and drop internal ids.
    const { zra_proxy_secret, id, tenant_id, zra_vsdc_url, ...identity } = row;
    res.json({ ok: true, identity });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/settings', auth, readOnlyGuard, (req, res) => {
  try {
    const row = db.prepare(
      `SELECT ${ALL_ZRA_COLS.join(', ')} FROM business_settings WHERE tenant_id = ? LIMIT 1`
    ).get(req.user.tenantId) || {};
    res.json(row);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.put('/settings', auth, (req, res) => {
  try {
    const { zra_enabled, zra_env, zra_vsdc_url,
            zra_tpin, zra_bhf_id, zra_dvc_srl_no,
            zra_block_offline_sales, zra_proxy_branch_slug,
            zra_proxy_secret } = req.body;
    if (zra_env && !['sandbox', 'production'].includes(zra_env)) {
      return res.status(400).json({ error: 'zra_env must be sandbox or production' });
    }
    // v1.13.93 — zra_enabled is no longer editable via this endpoint.
    // ZRA compliance means every sale MUST route through VSDC; the flag
    // is auto-set to 1 by POST /initialize once the device is
    // successfully registered with VSDC and can only be flipped back to
    // 0 by direct DB access (a break-glass channel that leaves a trail).
    // Reject any request that tries to toggle it via the UI so an
    // operator can't accidentally disable fiscal reporting.
    if (zra_enabled !== undefined) {
      return res.status(400).json({
        error: 'zra_enabled cannot be changed here. It is set automatically by Initialize Device.',
      });
    }
    const sets = [];
    const vals = [];
    if (zra_env         !== undefined) { sets.push('zra_env=?');         vals.push(zra_env); }
    if (zra_vsdc_url    !== undefined) { sets.push('zra_vsdc_url=?');    vals.push(zra_vsdc_url); }
    if (zra_tpin        !== undefined) { sets.push('zra_tpin=?');        vals.push(zra_tpin); }
    if (zra_bhf_id      !== undefined) { sets.push('zra_bhf_id=?');      vals.push(zra_bhf_id); }
    if (zra_dvc_srl_no  !== undefined) { sets.push('zra_dvc_srl_no=?');  vals.push(zra_dvc_srl_no); }
    if (zra_block_offline_sales !== undefined) {
      sets.push('zra_block_offline_sales=?');
      vals.push(zra_block_offline_sales ? 1 : 0);
    }
    // 2026-08-27 — VSDC proxy secret. Adding the column to
    // ZRA_CONFIG_COLS was not enough: this handler destructures each
    // field explicitly, so an un-destructured one is silently dropped and
    // the field appeared to clear itself on save.
    //
    // A BLANK submission is ignored rather than written. The input shows
    // a placeholder when empty, so saving an untouched form would
    // otherwise wipe a working secret and lock the till out. Clearing it
    // deliberately is not something the UI needs to offer — rotating
    // means typing a new value.
    if (zra_proxy_secret !== undefined && String(zra_proxy_secret).trim() !== '') {
      sets.push('zra_proxy_secret=?');
      vals.push(String(zra_proxy_secret).trim());
    }
    // v1.13.154 — empty string is valid here (means "no proxy, use my
    // own device" once HQ registers one directly). Only reject
    // non-string types.
    if (zra_proxy_branch_slug !== undefined) {
      sets.push('zra_proxy_branch_slug=?');
      vals.push(String(zra_proxy_branch_slug || '').trim().toLowerCase());
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });

    const existing = db.prepare('SELECT id FROM business_settings WHERE tenant_id = ? LIMIT 1').get(req.user.tenantId);
    if (!existing) return res.status(400).json({ error: 'business_settings row missing — save Company Profile first' });
    sets.push("updated_at=datetime('now')");
    db.prepare(`UPDATE business_settings SET ${sets.join(', ')} WHERE id=?`).run(...vals, existing.id);
    const row = db.prepare(
      `SELECT ${ALL_ZRA_COLS.join(', ')} FROM business_settings WHERE id = ?`
    ).get(existing.id);
    res.json(row);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/initialize', auth, async (req, res) => {
  try {
    const cfg = db.prepare(
      `SELECT zra_vsdc_url, zra_tpin, zra_bhf_id, zra_dvc_srl_no
         FROM business_settings WHERE tenant_id = ? LIMIT 1`
    ).get(req.user.tenantId);
    if (!cfg || !cfg.zra_vsdc_url || !cfg.zra_tpin || !cfg.zra_bhf_id || !cfg.zra_dvc_srl_no) {
      return res.status(400).json({
        error: 'Save VSDC URL, TPIN, Branch ID and Device Serial No first, then click Initialize.',
      });
    }
    // 2026-08-27 — a device registers with ZRA exactly ONCE. When this
    // install is a till reaching a VSDC that was already initialised
    // elsewhere (Electron through the proxy), selectInitInfo answers 902
    // "This device is installed" — correct, not an error. Re-raising it
    // left zra_enabled at 0 and the till could never fiscalise.
    //
    // On 902, copy the identity the proxy host already holds instead of
    // demanding a fresh registration.
    let info;
    try {
      // 2026-09-03 — 120s, not the 20s default. This call is ONE-SHOT: VSDC
      // returns the SDC ID exactly once and answers 902 forever after, so a
      // timeout here loses the identity permanently. That is precisely what
      // happened to HQ (branch 041) — the first press against a Tomcat
      // started minutes earlier took longer than 20s on a cold JVM, VSDC
      // registered the device and created siData/1001710705_041, and we gave
      // up before the reply arrived. The registration stands; the SDC ID is
      // gone and not recoverable from the box (TAXPAYER_INFO is empty).
      const parsed = await vsdc.post(req.user.tenantId, '/initializer/selectInitInfo', {
        dvcSrlNo: cfg.zra_dvc_srl_no,
      }, { timeoutMs: 120_000 });
      info = parsed.data?.info || parsed.data || {};
    } catch (e) {
      const viaProxy = /\/vsdc-proxy(\/|$)/.test(String(cfg.zra_vsdc_url || ''));
      // A direct-URL install has no proxy host to copy the identity from, and
      // VSDC will not reissue it. Say so plainly instead of surfacing the raw
      // 902 — the operator's next move is to ask ZRA for the SDC ID, or to
      // deactivate and re-register the device on the portal. Pressing the
      // button again only produces another 902.
      if (e.resultCd === '902' && !viaProxy) {
        throw new Error(
          'This device is already registered with ZRA, but VSDC only issues its ' +
          'SDC ID once and will not repeat it. Ask ZRA for the SDC ID for TPIN ' +
          `${cfg.zra_tpin} branch ${cfg.zra_bhf_id} serial ${cfg.zra_dvc_srl_no}, ` +
          'or deactivate and re-register the device on the ZRA portal. ' +
          'Pressing Initialize again will not help.'
        );
      }
      if (e.resultCd !== '902' || !viaProxy) throw e;
      const secretRow = db.prepare('SELECT zra_proxy_secret FROM business_settings LIMIT 1').get();
      const host = String(cfg.zra_vsdc_url).replace(/\/api\/zra\/vsdc-proxy\/?$/, '');
      const r = await fetch(`${host}/api/zra/device-identity`, {
        headers: { 'X-VSDC-Proxy-Secret': String(secretRow?.zra_proxy_secret || '') },
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) {
        throw new Error(`Device already registered on ZRA, but its identity could not be copied from the proxy host (HTTP ${r.status}). Check the proxy secret matches.`);
      }
      const body = await r.json();
      const id = body.identity || {};
      info = {
        sdcId:            id.zra_sdc_id,
        mrcNo:            id.zra_mrc_no,
        taxprNm:          id.zra_taxpr_nm,
        vatTyCd:          id.zra_vat_ty_cd,
        lastInvcNo:       id.zra_last_invc_no,
        lastSaleInvcNo:   id.zra_last_sale_invc_no,
        lastPchsInvcNo:   id.zra_last_pchs_invc_no,
        lastSaleRcptNo:   id.zra_last_sale_rcpt_no,
        lastTrainInvcNo:  id.zra_last_train_invc_no,
        lastCopyInvcNo:   id.zra_last_copy_invc_no,
      };
    }
    const sets = [];
    const vals = [];
    const push = (col, v) => { if (v !== undefined && v !== null) { sets.push(`${col}=?`); vals.push(v); } };
    push('zra_sdc_id',              info.sdcId);
    push('zra_mrc_no',              info.mrcNo);
    push('zra_taxpr_nm',            info.taxprNm);
    push('zra_vat_ty_cd',           info.vatTyCd);
    push('zra_last_invc_no',        info.lastInvcNo);
    push('zra_last_sale_invc_no',   info.lastSaleInvcNo);
    push('zra_last_pchs_invc_no',   info.lastPchsInvcNo);
    push('zra_last_sale_rcpt_no',   info.lastSaleRcptNo);
    push('zra_last_train_invc_no',  info.lastTrainInvcNo);
    push('zra_last_profrm_invc_no', info.lastProfrmInvcNo);
    push('zra_last_copy_invc_no',   info.lastCopyInvcNo);
    sets.push("zra_initialized_at=datetime('now')");
    sets.push('zra_enabled=1');
    sets.push("updated_at=datetime('now')");
    db.prepare(`UPDATE business_settings SET ${sets.join(', ')} WHERE tenant_id=?`).run(...vals, req.user.tenantId);

    const row = db.prepare(
      `SELECT ${ALL_ZRA_COLS.join(', ')} FROM business_settings WHERE tenant_id = ? LIMIT 1`
    ).get(req.user.tenantId);
    res.json({ ok: true, settings: row });
  } catch (error) {
    res.status(500).json({ error: error.message, resultCd: error.resultCd });
  }
});

// ─── Sync — Codes / Item Classes / Notices ──────────────────────────────

// POST /api/zra/sync/codes — pull the VSDC master code list (currency,
// tax types, packaging units, quantity units, etc). Upserts into
// zra_codes. Uses zra_sync_state to remember the last lastReqDt for
// incremental pulls.
router.post('/sync/codes', auth, async (req, res) => {
  try {
    const endpoint = '/code/selectCodes';
    const lastReqDt = req.body?.full === true ? vsdc.EPOCH_REQ_DT : vsdc.lastReqDtFor(endpoint);
    let parsed;
    try {
      parsed = await vsdc.post(req.user.tenantId, endpoint, { lastReqDt });
    } catch (e) {
      if (e.resultCd === '001') {
        vsdc.bumpSyncState(endpoint, '001', 'no new data');
        return res.json({ ok: true, inserted: 0, updated: 0, note: 'No new codes since last sync.' });
      }
      throw e;
    }

    // Response shape (VSDC Spec §5.2): { data: { clsList: [ { cdCls, cdClsNm, dtlList: [ { cd, cdNm, ...} ] } ] } }
    const clsList = parsed.data?.clsList || [];
    const upsert = db.prepare(
      `INSERT INTO zra_codes (cd_cls, cd, cd_nm, cd_desc, use_yn, user_dfn_cd1, user_dfn_cd2, user_dfn_cd3, srt_ord, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))
       ON CONFLICT(cd_cls, cd) DO UPDATE SET
         cd_nm = excluded.cd_nm,
         cd_desc = excluded.cd_desc,
         use_yn = excluded.use_yn,
         user_dfn_cd1 = excluded.user_dfn_cd1,
         user_dfn_cd2 = excluded.user_dfn_cd2,
         user_dfn_cd3 = excluded.user_dfn_cd3,
         srt_ord = excluded.srt_ord,
         updated_at = datetime('now')`
    );
    let count = 0;
    const tx = db.transaction((rows) => {
      for (const r of rows) { upsert.run(...r); count++; }
    });
    const rows = [];
    for (const cls of clsList) {
      for (const dtl of (cls.dtlList || [])) {
        rows.push([
          cls.cdCls || null,
          dtl.cd || null,
          dtl.cdNm || null,
          dtl.cdDesc || null,
          dtl.useYn || 'Y',
          dtl.userDfnCd1 || null,
          dtl.userDfnCd2 || null,
          dtl.userDfnCd3 || null,
          dtl.srtOrd ?? null,
        ]);
      }
    }
    tx(rows);
    vsdc.bumpSyncState(endpoint, '000', null);
    res.json({ ok: true, upserted: count });
  } catch (error) {
    vsdc.bumpSyncState('/code/selectCodes', error.resultCd || 'ERR', error.message);
    res.status(500).json({ error: error.message, resultCd: error.resultCd });
  }
});

// POST /api/zra/sync/item-classes — pull UNSPSC classification. Large
// dataset (~40k rows) — VSDC returns in batches of 1000. We loop until
// resultCd=001 (nothing more). ?full=true resets the bookmark.
router.post('/sync/item-classes', auth, async (req, res) => {
  try {
    const endpoint = '/itemClass/selectItemsClass';
    let lastReqDt = req.body?.full === true ? vsdc.EPOCH_REQ_DT : vsdc.lastReqDtFor(endpoint);
    let batches = 0, upserted = 0;
    const upsert = db.prepare(
      `INSERT INTO zra_item_classes (item_cls_cd, item_cls_nm, item_cls_lvl, tax_ty_cd, mjr_tg_yn, use_yn, updated_at)
       VALUES (?,?,?,?,?,?, datetime('now'))
       ON CONFLICT(item_cls_cd) DO UPDATE SET
         item_cls_nm  = excluded.item_cls_nm,
         item_cls_lvl = excluded.item_cls_lvl,
         tax_ty_cd    = excluded.tax_ty_cd,
         mjr_tg_yn    = excluded.mjr_tg_yn,
         use_yn       = excluded.use_yn,
         updated_at   = datetime('now')`
    );
    // Cap total batches to protect against a runaway loop. ~40k rows /
    // 1000 per batch = 40 pages, plenty of headroom.
    const MAX_BATCHES = 100;
    while (batches < MAX_BATCHES) {
      let parsed;
      try {
        parsed = await vsdc.post(req.user.tenantId, endpoint, { lastReqDt });
      } catch (e) {
        if (e.resultCd === '001') break;
        throw e;
      }
      const list = parsed.data?.itemClsList || [];
      if (!list.length) break;
      const tx = db.transaction((rows) => {
        for (const r of rows) { upsert.run(...r); upserted++; }
      });
      tx(list.map(x => [
        x.itemClsCd || null,
        x.itemClsNm || null,
        x.itemClsLvl ?? null,
        x.taxTyCd || null,
        x.mjrTgYn || null,
        x.useYn || 'Y',
      ]));
      batches++;
      // Advance the bookmark to the maximum useUpdDt in this batch, if
      // VSDC supplies it — otherwise just keep looping with the same
      // lastReqDt until we get 001 or hit MAX_BATCHES.
      const maxTs = list.reduce((m, x) => x.useUpdDt && x.useUpdDt > m ? x.useUpdDt : m, lastReqDt);
      if (maxTs === lastReqDt) break; // no progress → done
      lastReqDt = maxTs;
    }
    vsdc.bumpSyncState(endpoint, '000', batches === MAX_BATCHES ? 'hit MAX_BATCHES cap' : null);
    res.json({ ok: true, batches, upserted });
  } catch (error) {
    vsdc.bumpSyncState('/itemClass/selectItemsClass', error.resultCd || 'ERR', error.message);
    res.status(500).json({ error: error.message, resultCd: error.resultCd });
  }
});

// POST /api/zra/sync/notices — pull latest ZRA-published notices.
// Optional feature; small (a few rows per pull) so we always incremental.
router.post('/sync/notices', auth, async (req, res) => {
  try {
    const endpoint = '/notices/selectNotices';
    const lastReqDt = req.body?.full === true ? vsdc.EPOCH_REQ_DT : vsdc.lastReqDtFor(endpoint);
    let parsed;
    try {
      parsed = await vsdc.post(req.user.tenantId, endpoint, { lastReqDt });
    } catch (e) {
      if (e.resultCd === '001') {
        vsdc.bumpSyncState(endpoint, '001', 'no new data');
        return res.json({ ok: true, inserted: 0, note: 'No new notices.' });
      }
      throw e;
    }
    const list = parsed.data?.noticeList || [];
    const upsert = db.prepare(
      `INSERT INTO zra_notices (notice_no, title, cont, dtl_url, reg_dt, inserted_at)
       VALUES (?,?,?,?,?, datetime('now'))
       ON CONFLICT(notice_no) DO UPDATE SET
         title = excluded.title, cont = excluded.cont, dtl_url = excluded.dtl_url, reg_dt = excluded.reg_dt`
    );
    const tx = db.transaction((rows) => { for (const r of rows) upsert.run(...r); });
    tx(list.map(n => [n.noticeNo, n.title, n.cont, n.dtlUrl || null, n.regDt || null]));
    vsdc.bumpSyncState(endpoint, '000', null);
    res.json({ ok: true, upserted: list.length });
  } catch (error) {
    vsdc.bumpSyncState('/notices/selectNotices', error.resultCd || 'ERR', error.message);
    res.status(500).json({ error: error.message, resultCd: error.resultCd });
  }
});

// POST /api/zra/sync/all — convenience wrapper: run all three syncs in
// sequence. Continues on individual failures so one endpoint being down
// doesn't block the others.
router.post('/sync/all', auth, async (req, res) => {
  const full = req.body?.full === true;
  const results = { codes: null, itemClasses: null, notices: null };
  const runOne = async (key, path, handler) => {
    try {
      results[key] = await handler();
    } catch (e) {
      results[key] = { error: e.message, resultCd: e.resultCd };
    }
  };
  await runOne('codes',       '/code/selectCodes',           () => syncCodes(req.user.tenantId, { full }));
  await runOne('itemClasses', '/itemClass/selectItemsClass', () => syncItemClasses(req.user.tenantId, { full }));
  await runOne('notices',     '/notices/selectNotices',      () => syncNotices(req.user.tenantId, { full }));
  res.json(results);
});

// Extracted helpers so /sync/all can reuse them. Each returns a small
// summary object; callers surface errors via try/catch.
async function syncCodes(tenantId, { full = false } = {}) {
  const endpoint = '/code/selectCodes';
  const lastReqDt = full ? vsdc.EPOCH_REQ_DT : vsdc.lastReqDtFor(endpoint);
  let parsed;
  try { parsed = await vsdc.post(tenantId, endpoint, { lastReqDt }); }
  catch (e) {
    if (e.resultCd === '001') { vsdc.bumpSyncState(endpoint, '001', 'no new data'); return { upserted: 0, note: 'no new data' }; }
    vsdc.bumpSyncState(endpoint, e.resultCd || 'ERR', e.message); throw e;
  }
  const clsList = parsed.data?.clsList || [];
  const upsert = db.prepare(
    `INSERT INTO zra_codes (cd_cls, cd, cd_nm, cd_desc, use_yn, user_dfn_cd1, user_dfn_cd2, user_dfn_cd3, srt_ord, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(cd_cls, cd) DO UPDATE SET
       cd_nm=excluded.cd_nm, cd_desc=excluded.cd_desc, use_yn=excluded.use_yn,
       user_dfn_cd1=excluded.user_dfn_cd1, user_dfn_cd2=excluded.user_dfn_cd2,
       user_dfn_cd3=excluded.user_dfn_cd3, srt_ord=excluded.srt_ord, updated_at=datetime('now')`
  );
  let count = 0;
  const rows = [];
  for (const cls of clsList)
    for (const dtl of (cls.dtlList || []))
      rows.push([cls.cdCls || null, dtl.cd || null, dtl.cdNm || null, dtl.cdDesc || null,
                 dtl.useYn || 'Y', dtl.userDfnCd1 || null, dtl.userDfnCd2 || null, dtl.userDfnCd3 || null,
                 dtl.srtOrd ?? null]);
  const tx = db.transaction((rs) => { for (const r of rs) { upsert.run(...r); count++; } });
  tx(rows);
  vsdc.bumpSyncState(endpoint, '000', null);
  return { upserted: count };
}

async function syncItemClasses(tenantId, { full = false } = {}) {
  const endpoint = '/itemClass/selectItemsClass';
  let lastReqDt = full ? vsdc.EPOCH_REQ_DT : vsdc.lastReqDtFor(endpoint);
  let batches = 0, upserted = 0;
  const upsert = db.prepare(
    `INSERT INTO zra_item_classes (item_cls_cd, item_cls_nm, item_cls_lvl, tax_ty_cd, mjr_tg_yn, use_yn, updated_at)
     VALUES (?,?,?,?,?,?, datetime('now'))
     ON CONFLICT(item_cls_cd) DO UPDATE SET
       item_cls_nm=excluded.item_cls_nm, item_cls_lvl=excluded.item_cls_lvl,
       tax_ty_cd=excluded.tax_ty_cd, mjr_tg_yn=excluded.mjr_tg_yn,
       use_yn=excluded.use_yn, updated_at=datetime('now')`
  );
  const MAX_BATCHES = 100;
  while (batches < MAX_BATCHES) {
    let parsed;
    try { parsed = await vsdc.post(tenantId, endpoint, { lastReqDt }); }
    catch (e) {
      if (e.resultCd === '001') break;
      vsdc.bumpSyncState(endpoint, e.resultCd || 'ERR', e.message); throw e;
    }
    const list = parsed.data?.itemClsList || [];
    if (!list.length) break;
    const tx = db.transaction((rs) => { for (const r of rs) { upsert.run(...r); upserted++; } });
    tx(list.map(x => [x.itemClsCd, x.itemClsNm, x.itemClsLvl ?? null, x.taxTyCd || null, x.mjrTgYn || null, x.useYn || 'Y']));
    batches++;
    const maxTs = list.reduce((m, x) => x.useUpdDt && x.useUpdDt > m ? x.useUpdDt : m, lastReqDt);
    if (maxTs === lastReqDt) break;
    lastReqDt = maxTs;
  }
  vsdc.bumpSyncState(endpoint, '000', batches === MAX_BATCHES ? 'hit MAX_BATCHES cap' : null);
  return { batches, upserted };
}

async function syncNotices(tenantId, { full = false } = {}) {
  const endpoint = '/notices/selectNotices';
  const lastReqDt = full ? vsdc.EPOCH_REQ_DT : vsdc.lastReqDtFor(endpoint);
  let parsed;
  try { parsed = await vsdc.post(tenantId, endpoint, { lastReqDt }); }
  catch (e) {
    if (e.resultCd === '001') { vsdc.bumpSyncState(endpoint, '001', 'no new data'); return { upserted: 0, note: 'no new data' }; }
    vsdc.bumpSyncState(endpoint, e.resultCd || 'ERR', e.message); throw e;
  }
  const list = parsed.data?.noticeList || [];
  const upsert = db.prepare(
    `INSERT INTO zra_notices (notice_no, title, cont, dtl_url, reg_dt, inserted_at)
     VALUES (?,?,?,?,?, datetime('now'))
     ON CONFLICT(notice_no) DO UPDATE SET title=excluded.title, cont=excluded.cont, dtl_url=excluded.dtl_url, reg_dt=excluded.reg_dt`
  );
  const tx = db.transaction((rs) => { for (const r of rs) upsert.run(...r); });
  tx(list.map(n => [n.noticeNo, n.title, n.cont, n.dtlUrl || null, n.regDt || null]));
  vsdc.bumpSyncState(endpoint, '000', null);
  return { upserted: list.length };
}

// ─── Read APIs for cached data ──────────────────────────────────────────
// Consumed by the product form dropdowns and diagnostics UI.

router.get('/codes', auth, readOnlyGuard, (req, res) => {
  try {
    const cls = req.query.cls;
    if (cls) {
      const rows = db.prepare(
        `SELECT cd, cd_nm, cd_desc, srt_ord FROM zra_codes
          WHERE cd_cls = ? AND use_yn = 'Y'
          ORDER BY srt_ord IS NULL, srt_ord, cd`
      ).all(cls);
      return res.json(rows);
    }
    // No cls filter: return summary counts per class (useful for a
    // diagnostics screen — "we have 42 packaging codes cached").
    const rows = db.prepare(
      `SELECT cd_cls, COUNT(*) AS n FROM zra_codes GROUP BY cd_cls ORDER BY cd_cls`
    ).all();
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/item-classes', auth, readOnlyGuard, (req, res) => {
  try {
    const search = (req.query.search || '').trim();
    const level  = req.query.level ? parseInt(req.query.level, 10) : null;
    const limit  = Math.min(parseInt(req.query.limit, 10) || 50, 500);
    const clauses = ["use_yn = 'Y'"];
    const params = [];
    if (level) { clauses.push('item_cls_lvl = ?'); params.push(level); }
    if (search) {
      clauses.push('(item_cls_cd LIKE ? OR item_cls_nm LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const rows = db.prepare(
      `SELECT item_cls_cd, item_cls_nm, item_cls_lvl, tax_ty_cd
         FROM zra_item_classes WHERE ${clauses.join(' AND ')}
        ORDER BY item_cls_cd LIMIT ?`
    ).all(...params, limit);
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/notices', auth, readOnlyGuard, (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT notice_no, title, cont, dtl_url, reg_dt FROM zra_notices ORDER BY reg_dt DESC, notice_no DESC LIMIT 50`
    ).all();
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ─── Pending fiscalisation queue ───────────────────────────────────────
//
// ── Push sales that were never sent to ZRA ─────────────────────────────────
// v1.13.175
//
// Red Sea traded on 1-2 September with ZRA not yet connected: the branches
// could not stop selling while waiting for ZRA to approve fifteen devices.
// ZRA was told in writing that the sales would be pushed on connection.
//
// Those orders are zra_status='PENDING'. That matters: the minute-by-minute
// retry sweep only looks for 'FAILED', so it cannot see them and cannot
// interfere with this. The two paths stay separate on purpose.
//
// WHY A BUTTON AND NOT THE SWEEP. The sweep pushes 5 orders a minute while
// the tills keep selling, so ZRA would receive invoice 1 dated 1 Sept,
// invoice 2 dated today, invoice 3 dated 1 Sept... The invoice numbers would
// zigzag through dates, because a number is allocated at PUSH time, not at
// sale time. Draining the backlog in one go, with the tills quiet, gives
// ZRA 1..N in date order and today's trading continuing cleanly after it.
//
// Orders go oldest first and STRICTLY ONE AT A TIME - allocInvcNo reads and
// writes zra_last_invc_no, so pushing in parallel would interleave numbers.
// A batch stops at the first hard failure rather than firing the rest at a
// server that has already objected once.

const pendingPushSql = `
     FROM orders
    WHERE zra_status = 'PENDING'
      AND deleted_at IS NULL
      AND COALESCE(status, '') != 'Reversed'
      AND tenant_id = ?`;

// GET /api/zra/push-pending — what is waiting, without sending anything.
router.get('/push-pending', auth, readOnlyGuard, (req, res) => {
  try {
    const t = req.user.tenantId;
    const summary = db.prepare(
      `SELECT COUNT(*) AS cnt, MIN(created_at) AS oldest, MAX(created_at) AS newest,
              COALESCE(SUM(total_amount), 0) AS total ${pendingPushSql}`
    ).get(t);
    // Reversed orders are deliberately excluded above. Report them so the
    // decision is visible rather than silent: the sale happened and was then
    // undone, and whether ZRA should see both legs is not ours to assume.
    const reversed = db.prepare(
      `SELECT COUNT(*) AS cnt FROM orders
        WHERE zra_status = 'PENDING' AND deleted_at IS NULL
          AND COALESCE(status, '') = 'Reversed' AND tenant_id = ?`
    ).get(t);
    const signed = db.prepare(
      `SELECT COUNT(*) AS cnt FROM orders
        WHERE zra_status = 'SIGNED' AND deleted_at IS NULL AND tenant_id = ?`
    ).get(t);
    res.json({
      ok: true,
      pending:        summary.cnt || 0,
      oldest:         summary.oldest || null,
      newest:         summary.newest || null,
      total_amount:   summary.total || 0,
      reversed_excluded: reversed.cnt || 0,
      already_signed: signed.cnt || 0,
      enabled:        vsdc.isEnabled(t),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/zra/push-pending  { limit }
//
// Pushes up to `limit` orders and returns what happened, so the browser can
// call it again and show progress. Batching keeps a 124-order backlog from
// sitting in one HTTP request until it times out.
router.post('/push-pending', auth, async (req, res) => {
  try {
    const t = req.user.tenantId;
    if (!vsdc.isEnabled(t)) {
      return res.status(400).json({ error: 'ZRA is not connected for this branch yet.' });
    }
    const limit = Math.min(Math.max(parseInt(req.body?.limit, 10) || 10, 1), 50);
    const rows = db.prepare(
      `SELECT id, order_number, created_at, total_amount ${pendingPushSql}
        ORDER BY created_at ASC, id ASC LIMIT ?`
    ).all(t, limit);

    const done = [];
    let stopped = null;
    for (const row of rows) {
      // created_at is stored UTC by SQLite's datetime('now'); the VSDC date
      // helpers format in UTC too, so this needs no timezone conversion. The
      // 910 incident at the top of vsdcClient.js was exactly a local-vs-UTC
      // date disagreement - do not "fix" this by using local time.
      const saleDate = new Date(String(row.created_at).replace(' ', 'T') + 'Z');
      let r;
      try {
        r = await zraRetryOrder(t, row.id, {
          saleDate: isNaN(saleDate.getTime()) ? undefined : saleDate,
        });
      } catch (e) {
        r = { ok: false, error: e.message, resultCd: e.resultCd };
      }
      const ok = !!r?.ok;
      done.push({
        id: row.id, order_number: row.order_number, created_at: row.created_at,
        ok, error: ok ? null : (r?.error || r?.reason || 'refused by ZRA'),
        result_code: r?.resultCd || null,
      });
      if (!ok) {
        // Stop the batch. Firing the remaining orders at a server that has
        // just objected turns one problem into fifty.
        stopped = done[done.length - 1];
        break;
      }
    }

    const left = db.prepare(`SELECT COUNT(*) AS cnt ${pendingPushSql}`).get(t);
    res.json({
      ok: !stopped,
      attempted: done.length,
      signed:    done.filter(d => d.ok).length,
      remaining: left.cnt || 0,
      stopped_on: stopped,
      orders: done,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/zra/pending-fiscalisation
//
// 2026-08-27 — built for the offline-Electron design. A till selling
// while disconnected issues a PROVISIONAL receipt and the order syncs up
// as zra_status='FAILED'; zraRetryQueue then fiscalises it once VSDC is
// reachable again. That is fine for a short outage, but ZRA rejects
// sales submitted too late (921/922), so a queue that quietly ages is a
// compliance risk: the customer already holds a receipt.
//
// Red Sea's own policy is that a branch reconnects within 24h, and ZRA's
// tolerance is believed to be about the same — which leaves no margin.
// This surfaces the age of the OLDEST unfiscalised order so someone can
// act at 12h rather than discovering it at 23h. Threshold is a query
// param so it can be tightened once ZRA confirms their real limit.
router.get('/pending-fiscalisation', auth, readOnlyGuard, (req, res) => {
  try {
    const warnHours = parseFloat(req.query.warn_hours) || 12;
    const rows = db.prepare(
      `SELECT id, order_number, created_at, zra_error_code, zra_error_message,
              COALESCE(zra_retry_count, 0) AS retries,
              ROUND((julianday('now') - julianday(created_at)) * 24, 2) AS age_hours
         FROM orders
        WHERE zra_status = 'FAILED'
          AND deleted_at IS NULL
        ORDER BY created_at ASC
        LIMIT 200`
    ).all();
    const oldest = rows.length ? rows[0].age_hours : 0;
    res.json({
      ok: true,
      pending: rows.length,
      oldest_age_hours: oldest,
      warn_hours: warnHours,
      // breached = someone needs to act NOW, not at the deadline.
      breached: rows.length > 0 && oldest >= warnHours,
      orders: rows.slice(0, 50),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/sync-state', auth, readOnlyGuard, (req, res) => {
  try {
    const state = db.prepare(
      `SELECT endpoint, last_req_dt, last_pulled_at, last_result_cd, last_error FROM zra_sync_state ORDER BY endpoint`
    ).all();
    const counts = {
      codes:        db.prepare('SELECT COUNT(*) AS n FROM zra_codes').get().n,
      itemClasses:  db.prepare('SELECT COUNT(*) AS n FROM zra_item_classes').get().n,
      notices:      db.prepare('SELECT COUNT(*) AS n FROM zra_notices').get().n,
    };
    res.json({ state, counts });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// v1.13.37 — Bulk import the UNSPSC classification list from the Excel
// file ZRA publishes (`UNSPSC-Classification-Codes.xlsx`). Lets Kelete
// populate zra_item_classes without waiting for the VSDC WAR install +
// its ~40 k-row paginated sync. Same target table as /sync/item-classes,
// so downstream code (Item Details dropdown, tax label mapping) works
// identically once populated.
//
// Auto-detects columns by header substring so the exact ZRA sheet
// layout doesn't have to be hard-coded. Expected columns:
//   - Code / Class Code / Item Class Code       → item_cls_cd  (8-digit UNSPSC)
//   - Name / Description / Item Class Name      → item_cls_nm
//   - Level (optional; derived from code length if absent)
//   - Tax Type / VAT Cat / vatCatCd (optional)  → tax_ty_cd
//
// Runs the entire insert in one transaction — 40 k rows takes ~1 s.
router.post('/import-item-classes', auth, xlsxUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: 'Excel has no sheets.' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false });
    if (rows.length === 0) return res.status(400).json({ error: 'Sheet is empty.' });

    // v1.13.40 — Two supported layouts:
    //
    //   A. "Wide" UNSPSC (official ZRA sheet): each row carries all four
    //      levels. Columns: Segment / Segment Title / Family / Family
    //      Title / Class / Class Title / Commodity / Commodity Title.
    //      We emit one record per level per row, deduped via ON CONFLICT.
    //
    //   B. "Long" one-code-per-row: single Code + Name columns.
    //      Kept as a fallback for third-party sheets.
    //
    // Pick the layout by looking for Segment + Family + Class +
    // Commodity code columns first. Fall back to Code/Name if any of
    // those four is missing.
    const headers = Object.keys(rows[0]);
    const lowered = new Map(headers.map(h => [h.toLowerCase().replace(/\s+/g, ''), h]));
    // Match exactly on lower/no-space form so "Class" doesn't also match "Item Class Code".
    const findExact = (candidates) => {
      for (const c of candidates) {
        const key = c.toLowerCase().replace(/\s+/g, '');
        if (lowered.has(key)) return lowered.get(key);
      }
      return null;
    };
    const findContains = (needles) => {
      for (const needle of needles) {
        const found = headers.find(h => h.toLowerCase().replace(/\s+/g, '').includes(needle));
        if (found) return found;
      }
      return null;
    };

    // ── Layout A detection ────────────────────────────────────────
    const segCol   = findExact(['Segment']);
    const segNmCol = findExact(['Segment Title', 'Segment Name']);
    const famCol   = findExact(['Family']);
    const famNmCol = findExact(['Family Title', 'Family Name']);
    const clsCol   = findExact(['Class']);
    const clsNmCol = findExact(['Class Title', 'Class Name']);
    const comCol   = findExact(['Commodity']);
    const comNmCol = findExact(['Commodity Title', 'Commodity Name']);
    const isWide = !!(segCol && famCol && clsCol && comCol && segNmCol && famNmCol && clsNmCol && comNmCol);

    // ── Layout B fallback ─────────────────────────────────────────
    const codeCol  = findContains(['itemclasscode', 'classcode', 'unspsccode', 'code']);
    const nameCol  = findContains(['itemclassname', 'classname', 'description', 'title', 'name']);
    const levelCol = findContains(['level', 'lvl']);
    const taxCol   = findContains(['taxtype', 'vatcat', 'taxcat', 'tax']);

    if (!isWide && (!codeCol || !nameCol)) {
      return res.status(400).json({
        error: `Couldn't find UNSPSC columns. Expected either (Segment + Family + Class + Commodity + their Titles) OR (Code + Name). Detected headers: ${headers.join(', ')}`,
      });
    }

    const insStmt = db.prepare(`
      INSERT INTO zra_item_classes (item_cls_cd, item_cls_nm, item_cls_lvl, tax_ty_cd, use_yn, updated_at)
      VALUES (?, ?, ?, ?, 'Y', datetime('now'))
      ON CONFLICT(item_cls_cd) DO UPDATE SET
        item_cls_nm  = excluded.item_cls_nm,
        item_cls_lvl = COALESCE(excluded.item_cls_lvl, item_cls_lvl),
        tax_ty_cd    = COALESCE(excluded.tax_ty_cd, tax_ty_cd),
        use_yn       = 'Y',
        updated_at   = datetime('now')
    `);

    // Normalise + validate a UNSPSC code cell. Rows that come from
    // sheets with numeric formatting lose leading zeros; pad to 8.
    // Non-numeric cells (blanks, header repeats) are silently skipped.
    const normCode = (raw) => {
      let s = String(raw ?? '').trim();
      if (!s) return null;
      // Strip decimal noise ("50000000.0")
      s = s.replace(/\.0+$/, '');
      if (!/^\d+$/.test(s)) return null;
      if (s.length < 8) s = s.padStart(8, '0');
      if (s.length > 8) return null;
      return s;
    };

    let inserted = 0, skipped = 0;
    const importMany = db.transaction((rowsIn) => {
      if (isWide) {
        for (const r of rowsIn) {
          const pairs = [
            { code: normCode(r[segCol]),   nm: String(r[segNmCol] || '').trim(), lvl: 1 },
            { code: normCode(r[famCol]),   nm: String(r[famNmCol] || '').trim(), lvl: 2 },
            { code: normCode(r[clsCol]),   nm: String(r[clsNmCol] || '').trim(), lvl: 3 },
            { code: normCode(r[comCol]),   nm: String(r[comNmCol] || '').trim(), lvl: 4 },
          ];
          let anyGood = false;
          for (const p of pairs) {
            if (!p.code || !p.nm) continue;
            insStmt.run(p.code, p.nm, p.lvl, null);
            anyGood = true;
          }
          if (anyGood) inserted++; else skipped++;
        }
      } else {
        for (const r of rowsIn) {
          const code = normCode(r[codeCol]);
          if (!code) { skipped++; continue; }
          const name = String(r[nameCol] ?? '').trim();
          if (!name) { skipped++; continue; }
          let level = null;
          if (levelCol) {
            const lv = parseInt(r[levelCol], 10);
            if (Number.isFinite(lv) && lv >= 1 && lv <= 4) level = lv;
          }
          if (level == null) {
            if (code.endsWith('000000')) level = 1;
            else if (code.endsWith('0000')) level = 2;
            else if (code.endsWith('00')) level = 3;
            else level = 4;
          }
          const tax = taxCol ? (String(r[taxCol] || '').trim() || null) : null;
          insStmt.run(code, name, level, tax);
          inserted++;
        }
      }
    });
    importMany(rows);

    // Count distinct records that actually landed in the table.
    const finalCount = db.prepare('SELECT COUNT(*) AS n FROM zra_item_classes').get()?.n || 0;

    // Stamp sync_state so the UI's "last pulled" surface reflects this
    // import even though it bypassed VSDC.
    try {
      db.prepare(`
        INSERT INTO zra_sync_state (endpoint, last_req_dt, last_pulled_at, last_result_cd, last_error)
        VALUES ('/itemClass/selectItemsClass', strftime('%Y%m%d%H%M%S','now'), datetime('now'), 'IMPORT-XLSX', NULL)
        ON CONFLICT(endpoint) DO UPDATE SET
          last_req_dt    = excluded.last_req_dt,
          last_pulled_at = datetime('now'),
          last_result_cd = 'IMPORT-XLSX',
          last_error     = NULL
      `).run();
    } catch { /* ignore — table may be absent on very old DBs */ }

    res.json({
      ok: true,
      inserted,
      skipped,
      total: rows.length,
      final_count: finalCount,
      sheet: sheetName,
      layout: isWide ? 'wide-unspsc' : 'long',
      columns_used: isWide
        ? { segment: segCol, family: famCol, class: clsCol, commodity: comCol }
        : { code: codeCol, name: nameCol, level: levelCol, tax: taxCol },
      note: `${finalCount.toLocaleString()} classes now in zra_item_classes.`,
    });
  } catch (error) {
    console.error('[zra.import-item-classes]', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── VSDC-supplier purchase pull (T06A) ─────────────────────────────────
//
// v1.13.80 — Three-step flow:
//   1. POST /api/zra/purchases/pull  — fetch new supplier invoices from
//      /trnsPurchase/selectTrnsPurchaseSales, upsert into
//      zra_pending_purchases (dedup on spplr_tpin + spplr_invc_no).
//   2. GET  /api/zra/purchases       — list rows, filterable by ?status=.
//   3. POST /api/zra/purchases/:id/approve — call /trnsPurchase/savePurchase
//      with regTyCd='A' using the cached raw_json. On success, stamp the
//      row APPROVED with the allocated pchsInvcNo.
//   4. POST /api/zra/purchases/:id/reject  — local audit only; ZRA already
//      has the supplier's side, so a reject is a bookkeeping mark.
//
// NOT wired this bump: creating a local GRN row from an approved
// purchase. Follow-up — for now the approval lands in ZRA + our audit
// log; the operator books the physical GRN through the existing UI.

// v1.13.153 — HQ-device proxy resolver. All 4 purchase-pull endpoints
// below need a live VSDC channel; when the calling tenant has none
// (HQ, by default — Pattern A), proxy through business_settings.
// zra_proxy_branch_slug instead. This is read-through: any tenant that
// DOES have its own device (a branch, or HQ if ever registered
// directly) uses itself and ignores the proxy setting entirely.
async function resolveHqZraProxy(req) {
  const own = vsdc.getConfig(req.user.tenantId);
  if (own?.zra_enabled && own?.zra_sdc_id) {
    return { ok: true, tenantId: req.user.tenantId, run: (fn) => fn() };
  }
  const row = db.prepare('SELECT zra_proxy_branch_slug FROM business_settings LIMIT 1').get();
  const proxySlug = String(row?.zra_proxy_branch_slug || '').trim().toLowerCase();
  if (!proxySlug) {
    return { ok: false, reason: 'No ZRA device on this tenant and no proxy branch configured.' };
  }
  if (!isRegistered(proxySlug)) {
    return { ok: false, reason: `Configured proxy branch "${proxySlug}" is not a registered tenant.` };
  }
  let branchDb;
  try { branchDb = getTenantDb(proxySlug); }
  catch (e) { return { ok: false, reason: `Cannot open proxy branch DB: ${e.message}` }; }
  const branchTenantId = branchDb.prepare('SELECT tenant_id FROM business_settings LIMIT 1').get()?.tenant_id || proxySlug;
  return { ok: true, tenantId: branchTenantId, proxiedVia: proxySlug, run: (fn) => db.runWithDb(branchDb, fn) };
}

router.post('/purchases/pull', auth, async (req, res) => {
  try {
    const proxy = await resolveHqZraProxy(req);
    if (!proxy.ok) return res.json({ ok: true, skipped: true, reason: proxy.reason, inserted: 0, updated: 0 });

    const out = await proxy.run(async () => {
      const endpoint = '/trnsPurchase/selectTrnsPurchaseSales';
      const lastReqDt = req.body?.full === true ? vsdc.EPOCH_REQ_DT : vsdc.lastReqDtFor(endpoint);
      const result = await vsdc.selectTrnsPurchaseSales(proxy.tenantId, lastReqDt);
      if (result.skipped) return { body: { ok: true, ...result, inserted: 0, updated: 0 } };
      if (!result.ok) {
        vsdc.bumpSyncState(endpoint, result.resultCd || 'ERR', result.error);
        return { status: 500, body: { error: result.error, resultCd: result.resultCd } };
      }
      const upsert = db.prepare(`
        INSERT INTO zra_pending_purchases (
          spplr_tpin, spplr_nm, spplr_bhf_id, spplr_invc_no, spplr_sdc_id,
          rcpt_ty_cd, pmt_ty_cd, sales_dt, stock_rls_dt,
          tot_item_cnt, tot_taxbl_amt, tot_tax_amt, tot_amt,
          raw_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(spplr_tpin, spplr_invc_no)
          WHERE spplr_tpin IS NOT NULL AND spplr_invc_no IS NOT NULL
        DO UPDATE SET
          spplr_nm     = excluded.spplr_nm,
          spplr_bhf_id = excluded.spplr_bhf_id,
          spplr_sdc_id = excluded.spplr_sdc_id,
          rcpt_ty_cd   = excluded.rcpt_ty_cd,
          pmt_ty_cd    = excluded.pmt_ty_cd,
          sales_dt     = excluded.sales_dt,
          stock_rls_dt = excluded.stock_rls_dt,
          tot_item_cnt = excluded.tot_item_cnt,
          tot_taxbl_amt= excluded.tot_taxbl_amt,
          tot_tax_amt  = excluded.tot_tax_amt,
          tot_amt      = excluded.tot_amt,
          raw_json     = excluded.raw_json
        WHERE status = 'NEW'   -- never trample an APPROVED/REJECTED decision
      `);
      let inserted = 0;
      const tx = db.transaction((rows) => {
        for (const r of rows) {
          upsert.run(
            r.spplrTpin || null, r.spplrNm || null, r.spplrBhfId || null,
            r.spplrInvcNo != null ? String(r.spplrInvcNo) : null,
            r.spplrSdcId || null,
            r.rcptTyCd || null, r.pmtTyCd || null,
            r.salesDt || null, r.stockRlsDt || null,
            r.totItemCnt ?? null,
            r.totTaxblAmt ?? null, r.totTaxAmt ?? null, r.totAmt ?? null,
            JSON.stringify(r)
          );
          inserted++;
        }
      });
      tx(result.saleList || []);
      vsdc.bumpSyncState(endpoint, '000', null);
      return { body: { ok: true, pulled: result.saleList?.length || 0, upserted: inserted, proxied_via: proxy.proxiedVia || null } };
    });
    res.status(out.status || 200).json(out.body);
  } catch (error) {
    vsdc.bumpSyncState('/trnsPurchase/selectTrnsPurchaseSales', error.resultCd || 'ERR', error.message);
    res.status(500).json({ error: error.message, resultCd: error.resultCd });
  }
});

router.get('/purchases', auth, readOnlyGuard, async (req, res) => {
  try {
    const proxy = await resolveHqZraProxy(req);
    if (!proxy.ok) return res.json([]);
    const rows = await proxy.run(async () => {
      const status = (req.query.status || '').toUpperCase();
      const clauses = [];
      const params = [];
      if (['NEW', 'APPROVED', 'REJECTED'].includes(status)) {
        clauses.push('status = ?'); params.push(status);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return db.prepare(
        `SELECT id, spplr_tpin, spplr_nm, spplr_bhf_id, spplr_invc_no, spplr_sdc_id,
                rcpt_ty_cd, pmt_ty_cd, sales_dt, stock_rls_dt,
                tot_item_cnt, tot_taxbl_amt, tot_tax_amt, tot_amt,
                status, approved_pchs_invc_no, grn_id, grn_number, match_summary,
                error, pulled_at, decided_at
           FROM zra_pending_purchases ${where}
          ORDER BY pulled_at DESC, id DESC
          LIMIT 500`
      ).all(...params);
    });
    res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/purchases/:id', auth, readOnlyGuard, async (req, res) => {
  try {
    const proxy = await resolveHqZraProxy(req);
    if (!proxy.ok) return res.status(404).json({ error: proxy.reason });
    const out = await proxy.run(async () => {
      const row = db.prepare('SELECT * FROM zra_pending_purchases WHERE id = ?').get(req.params.id);
      if (!row) return null;
      let items = [];
      try { items = JSON.parse(row.raw_json || '{}')?.itemList || []; } catch { /* keep empty */ }

      // 2026-08-26 — annotate each line with how it should map to one of
      // our products. Supplier item codes live in the SUPPLIER's ZRA
      // namespace, so they never match ours; the operator's decision is
      // remembered in zra_supplier_item_map and replayed here.
      //
      // suggestion levels, strongest first:
      //   'saved'     — mapped before for this supplier+code. Trust it.
      //   'name'      — exact case-insensitive name hit in hq_products.
      //                 PRE-FILLED BUT FLAGGED: the UI must show this as
      //                 needing confirmation, never as already-decided.
      //                 Supplier naming is not authoritative for us.
      //   null        — no idea, operator must choose.
      const maps = db.prepare(
        'SELECT * FROM zra_supplier_item_map WHERE spplr_tpin = ?'
      ).all(row.spplr_tpin || '');
      const byCode = new Map(maps.map(m => [String(m.spplr_item_cd), m]));

      items = items.map(it => {
        const saved = byCode.get(String(it.itemCd || ''));
        if (saved) {
          return {
            ...it,
            map_action:      saved.action,
            map_product_sync_id: saved.product_sync_id || null,
            map_product_name:    saved.product_name || null,
            map_suggestion:  'saved',
          };
        }
        let guess = null;
        if (it.itemNm) {
          try {
            guess = masterDb.prepare(
              `SELECT sync_id, name FROM hq_products
                WHERE LOWER(name) = LOWER(?) AND status != 'Deleted'
                ORDER BY id ASC LIMIT 1`
            ).get(String(it.itemNm).trim());
          } catch (_) { guess = null; }
        }
        return {
          ...it,
          map_action:      guess ? 'MAP' : null,
          map_product_sync_id: guess?.sync_id || null,
          map_product_name:    guess?.name || null,
          map_suggestion:  guess ? 'name' : null,
        };
      });

      // 2026-08-30 — tell the operator what will happen to the SUPPLIER.
      // The link is resolved at approval, which meant there was no way to
      // tell "this matches a supplier you already have" from "this is about
      // to create a new one" until after the fact. preview: true resolves it
      // without writing anything.
      let supplier_match = null;
      try {
        supplier_match = resolveZraSupplier({
          tpin: row.spplr_tpin, name: row.spplr_nm, preview: true,
        });
      } catch (_) { /* preview only — never block the invoice from opening */ }

      return { ...row, item_list: items, supplier_match };
    });
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.json(out);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// v1.13.139 — approve creates an HQ Purchase (master.db) with pre-filled
// data from the pulled VSDC invoice. NO ZRA calls fire here — per spec
// §5.11 the savePurchase + saveStockItems + saveStockMaster chain fires
// atomically when HQ confirms received qty in the 3-step Flow A. This
// keeps ZRA's stock view in sync with physical reality (stock arrives
// AT branch confirm, not at HQ-clicks-approve).
//
// Body: { destination_slug: string }  — which branch these goods ship to.
//   All lines route to the same branch (per ZRA-pulled invoice = one
//   supplier delivery). Per-line destinations can be added later.
router.post('/purchases/:id/approve', auth, async (req, res) => {
  try {
    // v1.13.153 — the pending-purchase cache row lives wherever it was
    // pulled TO (usually the proxy branch, since HQ has no device of
    // its own). Everything else in this handler (masterDb hq_purchases
    // creation, destination branchDb product matching) is unaffected —
    // only the bare `db.*` calls against zra_pending_purchases need to
    // resolve to the right physical DB.
    const proxy = await resolveHqZraProxy(req);
    if (!proxy.ok) return res.status(400).json({ error: proxy.reason });
    return await proxy.run(async () => {
    const row = db.prepare('SELECT * FROM zra_pending_purchases WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.status !== 'NEW') return res.status(400).json({ error: `Row is ${row.status}, not NEW` });

    const destination_slug = String(req.body?.destination_slug || '').toLowerCase();
    if (!destination_slug) return res.status(400).json({ error: 'destination_slug is required' });
    if (!isRegistered(destination_slug)) {
      return res.status(400).json({ error: `Destination "${destination_slug}" is not a registered branch` });
    }
    const destName = (() => {
      try {
        const t = listTenants().find(t => t.slug === destination_slug);
        if (!t) return destination_slug;
        try {
          const bdb = getTenantDb(destination_slug);
          const r = bdb.prepare('SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1').get();
          if (r?.business_name) return r.business_name;
        } catch (_) {}
        return t.business_name || destination_slug;
      } catch (_) { return destination_slug; }
    })();

    let raw = {};
    try { raw = JSON.parse(row.raw_json || '{}'); } catch { /* empty */ }
    const rawItems = raw.itemList || [];
    if (rawItems.length === 0) return res.status(400).json({ error: 'Pulled invoice has no line items' });

    let branchDb;
    try { branchDb = getTenantDb(destination_slug); }
    catch (e) { return res.status(400).json({ error: `Cannot open destination DB: ${e.message}` }); }

    // 2026-08-26 — per-line mapping, supplied by the operator.
    //
    // Supplier item codes belong to the SUPPLIER's ZRA namespace
    // (Chambishi's ZM2BGU23755 vs our ZM2NTBX0000023 for the same
    // bottle), so the old "match on zra_item_cd, else on name" guess
    // essentially never hit. Every line fell through to auto-create,
    // silently filling the catalogue with duplicates under the
    // supplier's naming — which is the actual damage this replaces.
    //
    // req.body.line_map: [{ itemCd, action: 'MAP'|'CREATE'|'IGNORE',
    //                       product_sync_id? }]
    // The UI requires a decision per line before enabling Approve, so a
    // missing entry is a client bug, not a normal state — reject rather
    // than silently falling back to the old guessing behaviour.
    const lineMap = new Map(
      (Array.isArray(req.body?.line_map) ? req.body.line_map : [])
        .map(l => [String(l.itemCd || ''), l])
    );

    const undecided = [];
    const decided = [];
    for (const it of rawItems) {
      const key = String(it.itemCd || '');
      const d = lineMap.get(key);
      if (!d || !d.action) { undecided.push(it.itemNm || key || '(unnamed line)'); continue; }
      if (d.action === 'MAP' && !d.product_sync_id) {
        undecided.push(it.itemNm || key || '(unnamed line)');
        continue;
      }
      decided.push({ it, ...d });
    }
    if (undecided.length) {
      return res.status(400).json({
        error: `Every line must be mapped before approving. Undecided: ${undecided.slice(0, 5).join(', ')}`
             + (undecided.length > 5 ? ` and ${undecided.length - 5} more` : ''),
        code: 'LINES_UNMAPPED',
      });
    }

    const kept = decided.filter(d => d.action !== 'IGNORE');
    if (kept.length === 0) {
      return res.status(400).json({ error: 'All lines were set to Ignore — nothing to bring onto a purchase order.' });
    }

    // Remember the decisions so the next invoice from this supplier
    // maps itself. CREATE and IGNORE are stored too — a deliberate
    // "this really is new" or "never import this" should not re-prompt
    // on every delivery.
    try {
      const upsert = db.prepare(`
        INSERT INTO zra_supplier_item_map
          (spplr_tpin, spplr_item_cd, spplr_item_nm, action, product_sync_id, product_name, created_by)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(spplr_tpin, spplr_item_cd) DO UPDATE SET
          action          = excluded.action,
          product_sync_id = excluded.product_sync_id,
          product_name    = excluded.product_name,
          spplr_item_nm   = excluded.spplr_item_nm,
          updated_at      = datetime('now')
      `);
      db.transaction(() => {
        for (const d of decided) {
          if (!d.it.itemCd) continue;
          let pname = null;
          if (d.action === 'MAP' && d.product_sync_id) {
            pname = branchDb.prepare(
              'SELECT name FROM products WHERE sync_id = ? LIMIT 1'
            ).get(d.product_sync_id)?.name || null;
          }
          upsert.run(row.spplr_tpin || '', String(d.it.itemCd), d.it.itemNm || null,
                     d.action, d.product_sync_id || null, pname, req.user?.id || null);
        }
      })();
    } catch (_) { /* mapping memory is best-effort — never block the approve */ }

    // Resolve each kept line to a product on the DESTINATION branch.
    // MAP    → the operator's chosen sync_id.
    // CREATE → fresh sync_id; hqPurchases.js Confirm auto-creates the
    //          product from the line snapshot at receive time.
    const matches = kept.map(d => {
      const p = d.action === 'MAP' && d.product_sync_id
        ? branchDb.prepare(
            `SELECT id, sync_id, name, unit, code,
                    zra_item_cd, zra_item_cls_cd, zra_pkg_unit_cd,
                    zra_qty_unit_cd, zra_vat_cat_cd, zra_excise_ty_cd, zra_rrp
               FROM products WHERE sync_id = ? AND (deleted_at IS NULL) LIMIT 1`
          ).get(d.product_sync_id)
        : null;
      return {
        it: d.it, product: p, action: d.action,
        mapped_sync_id: d.product_sync_id || null,
        receive_qty:  d.receive_qty,
        receive_unit: d.receive_unit,
      };
    });
    const matchedCount = matches.filter(m => m.product).length;
    const ignoredCount = decided.length - kept.length;
    const unmatchedNames = matches.filter(m => !m.product).map(m => m.it.itemNm || m.it.itemCd).filter(Boolean);
    const matchSummary = `${matchedCount}/${kept.length} mapped at ${destination_slug}`
      + (ignoredCount ? ` · ${ignoredCount} ignored` : '') +
      (unmatchedNames.length ? ` — unmatched: ${unmatchedNames.slice(0, 5).join(', ')}${unmatchedNames.length > 5 ? '…' : ''}` : '');

    // Build HQ Purchase line items. Every ZRA line becomes an
    // hq_purchase_items row with status AWAITING_GRN, ready for the
    // destination branch to enter received_qty. Product sync_id comes
    // from the branch match when we found one; otherwise mint a fresh
    // UUID so the branch's Confirm handler auto-creates the product
    // from the line snapshot (mirrors POST /api/hq/purchases path).
    //
    // Phase 2 (§5.11): also snapshot the ZRA classification data
    // (itemCd, itemClsCd, pkgUnitCd, qtyUnitCd, vatCatCd, exciseTxCatCd)
    // so hqPurchases.js Confirm can rebuild the savePurchase +
    // saveStockItems itemList without a second pull from ZRA.
    const clean = matches.map(({ it, product, action, mapped_sync_id, receive_qty, receive_unit }) => {
      const qty  = parseFloat(it.qty) || 0;
      const cost = parseFloat(it.prc) || 0;
      // 2026-08-26 — receive in OUR unit, not the supplier's.
      //
      // The supplier invoices in their packaging (20 EA); we may stock
      // the same goods as Box. Previously the raw qty was kept while the
      // unit silently became ours, so "20 EA" was booked as "20 Box" —
      // out by the whole conversion factor, and that wrong figure went
      // to ZRA as well. The operator now states what physically arrived
      // in our own units.
      //
      // Money is anchored to the INVOICE: line_total stays the
      // supplier's figure (qty x prc, what we actually owe), and unit
      // cost is derived from it so cost x qty still reconciles no matter
      // which unit was chosen.
      // 2026-08-31 — the pulled line carries VAT and a discount; we were
      // dropping both.
      //
      // ZRA's purchase itemList gives prc, taxAmt and dcAmt per line, but only
      // prc was read. So a ZRA-approved purchase valued stock at BASE, while
      // the same delivery typed by hand valued it at base + VAT - discount.
      // The same goods cost two different amounts depending on how they were
      // entered, and AP was short by the VAT.
      //
      // dcAmt / taxAmt are line totals in the supplier's own quantity, which is
      // what we owe regardless of the unit we receive in.
      // 2026-08-31 — `prc` is VAT-INCLUSIVE. Proved against real CHAMBISHI
      // pulls, not assumed:
      //
      //     qty 20 x prc 317.00 = 6,340.00
      //     splyAmt 6,340.00    totAmt 6,340.00
      //     taxblAmt 5,465.52 + vatAmt 874.48 = 6,340.00
      //     6,340 / 1.16 = 5,465.52
      //
      // So vatAmt is the VAT already CONTAINED in qty x prc, and the ex-VAT
      // base is taxblAmt — not qty x prc. An earlier version of this read prc
      // as the base and ADDED vatAmt, which would have overstated every future
      // ZRA purchase by its own VAT.
      //
      // Field naming is confirmed too: the pull carries vatAmt, and the spec's
      // taxAmt is absent entirely. Both are still accepted in case a future
      // firmware uses the spec name.
      const vatAmt  = parseFloat(it.taxAmt ?? it.vatAmt) || 0;
      const discAmt = parseFloat(it.dcAmt ?? it.discountAmt ?? it.dcAmtC) || 0;
      const gross   = qty * cost;                       // = totAmt, what we owe
      const lineTotal = parseFloat(it.totAmt) || gross;
      // Base is DERIVED from the total, not taken from taxblAmt.
      //
      // Where ZRA is self-consistent the two are identical — CHAMBISHI's
      // 6,340 - 874.48 gives exactly its taxblAmt of 5,465.52. But some pulls
      // are not: Red Sea's own self-invoices report taxblAmt 56,001.72 and
      // vatAmt 8,960.28, which sum to 64,962 against a totAmt of 62,200.
      // Trusting taxblAmt there would leave base + VAT disagreeing with the
      // amount owed, and every screen showing Total Base / VAT / Amount Due
      // would visibly fail to add up. Deriving it holds that invariant
      // whatever the supplier reports.
      const baseTotal = lineTotal - vatAmt + discAmt;
      const recvQty   = parseFloat(receive_qty) > 0 ? parseFloat(receive_qty) : qty;
      const recvUnit  = (receive_unit || '').trim() || product?.unit || it.qtyUnitCd || 'pcs';
      const unitCost  = recvQty > 0 ? lineTotal / recvQty : cost;
      // Base per OUR unit, so qty x base_price still equals the invoice's base
      // after a unit conversion — the same anchoring the line total uses.
      const basePerUnit = recvQty > 0 ? baseTotal / recvQty : cost;
      return {
        // 2026-08-26 — honour the operator's mapped sync_id even when the
        // branch has no row for it yet (an HQ product that hasn't been
        // pushed to this depot). Minting a fresh UUID there would create
        // a duplicate of the very product they just mapped to; reusing
        // the mapped sync_id lets hqPurchases.js Confirm materialise it
        // as the SAME product. Only a CREATE decision mints a new id.
        product_sync_id:  product?.sync_id || (action === 'MAP' ? mapped_sync_id : null) || randomUUID(),
        product_name:     product?.name || it.itemNm || `Item ${it.itemCd || ''}`,
        unit:             recvUnit,
        dispatched_qty:   recvQty,
        cost_price:       +unitCost.toFixed(4),
        base_price:       +basePerUnit.toFixed(4),
        vat_amount:       +vatAmt.toFixed(4),
        discount_amount:  +discAmt.toFixed(4),
        line_total:       +lineTotal.toFixed(4),
        // 2026-08-26 — when the line is MAPPED to one of our products,
        // the ZRA classification must be OURS, not the supplier's.
        //
        // it.itemCd is the supplier's code in the SUPPLIER's ZRA
        // namespace (Chambishi's ZM2BGU23755). Storing that here meant
        // Generate GRN later reported a purchase to ZRA under an item
        // code registered to a different taxpayer — rejected at best,
        // and a purchase booked against an item we do not own at worst.
        //
        // Only an unmapped/CREATE line keeps the supplier's values, and
        // only because there is nothing of ours to use yet; the product
        // gets created from this snapshot at receipt.
        zra_item_cd:      product?.zra_item_cd || product?.code || it.itemCd || null,
        zra_item_cls_cd:  product?.zra_item_cls_cd  || it.itemClsCd || null,
        zra_pkg_unit_cd:  product?.zra_pkg_unit_cd  || it.pkgUnitCd || null,
        zra_qty_unit_cd:  product?.zra_qty_unit_cd  || it.qtyUnitCd || null,
        zra_vat_cat_cd:   product?.zra_vat_cat_cd   || it.vatCatCd || 'A',
        zra_excise_ty_cd: product?.zra_excise_ty_cd || it.exciseTxCatCd || null,
        zra_rrp:          product?.zra_rrp != null ? parseFloat(product.zra_rrp)
                          : (it.rrp != null ? parseFloat(it.rrp) : null),
      };
    });
    const totalAmount = clean.reduce((s, c) => s + c.line_total, 0);

    // Next HQP-YYYY-NNNNN number, same shape as hqPurchases.js.
    const nextPurchaseNumber = () => {
      const seq = (masterDb.prepare(`SELECT COUNT(*) AS n FROM hq_purchases`).get()?.n || 0) + 1;
      const yr  = new Date().getFullYear();
      return `HQP-${yr}-${String(seq).padStart(5, '0')}`;
    };

    const purchaseNumber = nextPurchaseNumber();
    const purchaseSyncId = randomUUID();
    const createdBy      = req.user?.id || null;
    const createdByName  = req.user?.firstName || req.user?.email || 'HQ';
    const grnDate = raw.salesDt
      ? String(raw.salesDt).replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3')
      : new Date().toISOString().slice(0, 10);
    // 2026-08-30 — link the supplier NOW, not "later".
    //
    // This used to write supplier_id: null with the comment "HQ supplier link
    // is a later concern". Later never came: the GRN step matches suppliers by
    // name, found nothing for the ZRA name, and the purchase reached AP as an
    // orphan with no ledger link. Resolving (or creating) the supplier here
    // makes the existing downstream name match succeed on its own.
    const zraSupplier = resolveZraSupplier({
      tpin: row.spplr_tpin,
      name: row.spplr_nm,
      userId: createdBy,
    });

    const notesText = `Auto-created from ZRA purchase pull #${row.id} — ${matchSummary}` +
      (row.spplr_invc_no ? ` · Supplier Invoice ${row.spplr_invc_no}` : '') +
      (zraSupplier
        ? ` · Supplier ${zraSupplier.how === 'CREATED' ? 'created' : 'matched'}: ${zraSupplier.name}`
        : '');

    let newPurchaseId;
    masterDb.transaction(() => {
      const info = masterDb.prepare(`
        INSERT INTO hq_purchases (purchase_number, sync_id, supplier_id, supplier_name, invoice_number,
                                  date, total_amount, notes, status,
                                  cost_currency, fx_rate_used,
                                  created_by, created_by_name,
                                  zra_pending_purchase_id, zra_spplr_tpin, zra_spplr_bhf_id, zra_reg_ty_cd)
        VALUES (?,?,?,?,?,?,?,?,'OPEN',?,?,?,?,?,?,?,?)
      `).run(
        purchaseNumber, purchaseSyncId,
        // Resolved above. The NAME matters as much as the id: hqGrns.js links
        // the GRN's supplier by exact name, so storing the local supplier's
        // spelling (not ZRA's) is what makes that match land.
        zraSupplier ? zraSupplier.id : null,
        (zraSupplier ? zraSupplier.name : row.spplr_nm) || null, row.spplr_invc_no || null,
        grnDate, totalAmount, notesText,
        'K', null,                                  // Kelete is ZMW-only
        createdBy, createdByName,
        // Phase 2 — ZRA cross-reference so hqPurchases.js Confirm knows
        // this PO originated from a VSDC pull and should fire the ZRA
        // savePurchase + saveStockItems + saveStockMaster chain on final
        // approval. regTyCd='A' = auto (i.e., approved from an existing
        // VSDC-supplier invoice, per §5.11 spec).
        row.id, row.spplr_tpin || null, row.spplr_bhf_id || null, 'A'
      );
      newPurchaseId = info.lastInsertRowid;

      const insItem = masterDb.prepare(`
        INSERT INTO hq_purchase_items (purchase_id, purchase_sync_id, sync_id,
                                       product_sync_id, product_name, unit,
                                       dispatched_qty, cost_price, cost_price_usd, line_total,
                                       base_price, vat_amount, discount_amount,
                                       destination_slug, destination_name, status,
                                       zra_item_cd, zra_item_cls_cd, zra_pkg_unit_cd,
                                       zra_qty_unit_cd, zra_vat_cat_cd, zra_excise_ty_cd, zra_rrp)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'AWAITING_GRN',?,?,?,?,?,?,?)
      `);
      for (const it of clean) {
        insItem.run(
          newPurchaseId, purchaseSyncId, randomUUID(),
          it.product_sync_id, it.product_name, it.unit,
          it.dispatched_qty, it.cost_price, null, it.line_total,
          it.base_price, it.vat_amount, it.discount_amount,
          destination_slug, destName,
          it.zra_item_cd, it.zra_item_cls_cd, it.zra_pkg_unit_cd,
          it.zra_qty_unit_cd, it.zra_vat_cat_cd, it.zra_excise_ty_cd, it.zra_rrp
        );
      }
    })();

    // Mark the pending row APPROVED with the linked HQ purchase. From
    // here it flows through Flow A: branch submits GRN → HQ confirms →
    // stock bumps at branch. ZRA calls (savePurchase + saveStockItems +
    // saveStockMaster) fire at HQ Confirm (deferred).
    db.prepare(`UPDATE zra_pending_purchases
                   SET status = 'APPROVED',
                       hq_purchase_id     = ?,
                       hq_purchase_number = ?,
                       match_summary      = ?,
                       error              = NULL,
                       decided_at         = datetime('now'),
                       decided_by         = ?
                 WHERE id = ?`)
      .run(newPurchaseId, purchaseNumber, matchSummary, req.user?.id || null, row.id);

    const fresh = db.prepare('SELECT * FROM zra_pending_purchases WHERE id = ?').get(row.id);
    const hqPurchase = masterDb.prepare('SELECT * FROM hq_purchases WHERE id = ?').get(newPurchaseId);
    return res.json({ ...fresh, hq_purchase: hqPurchase });
    }); // end proxy.run
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/purchases/:id/reject', auth, async (req, res) => {
  try {
    const proxy = await resolveHqZraProxy(req);
    if (!proxy.ok) return res.status(400).json({ error: proxy.reason });
    return await proxy.run(async () => {
      const row = db.prepare('SELECT * FROM zra_pending_purchases WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'NEW') return res.status(400).json({ error: `Row is ${row.status}, not NEW` });
      const reason = (req.body?.reason || '').trim() || null;
      db.prepare(`UPDATE zra_pending_purchases
                     SET status = 'REJECTED',
                         error = ?,
                         decided_at = datetime('now'),
                         decided_by = ?
                   WHERE id = ?`).run(reason, req.user?.id || null, row.id);
      res.json(db.prepare('SELECT * FROM zra_pending_purchases WHERE id = ?').get(row.id));
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ─── Item registry reconciliation ───────────────────────────────────────
//
// POST /api/zra/items/reconcile
// Pull the full items list from VSDC and compare against the local
// products table (matching on zra_item_cd). Returns:
//   { total_on_zra, matched, missing_locally, missing_on_zra, tax_mismatches:[{ ... }] }
// Nothing is auto-fixed — this is a read-only reconciliation. Ops
// decide whether to bulk-retry saveItem for missing_on_zra rows, or
// investigate mismatches (usually a category-code correction on our side).
router.post('/items/reconcile', auth, async (req, res) => {
  try {
    const endpoint = '/items/selectItems';
    // 2026-08-26 — same defect as /stock/reconcile had: this defaulted to
    // an INCREMENTAL pull and then bumped sync state on every click, so
    // the next click asked "what changed since seconds ago", got nothing,
    // and the page reported "ZRA: 0 · Matched: 0 · Missing on ZRA: 67" —
    // which reads as "ZRA has none of our items" when it actually means
    // "we asked ZRA the wrong question". A registry COMPARISON needs
    // ZRA's whole catalogue; a delta is meaningless here by construction.
    const lastReqDt = req.body?.full === false ? vsdc.lastReqDtFor(endpoint) : vsdc.EPOCH_REQ_DT;
    const result = await vsdc.selectItems(req.user.tenantId, lastReqDt);
    if (result.skipped) return res.json({ ok: true, ...result });
    if (!result.ok) {
      vsdc.bumpSyncState(endpoint, result.resultCd || 'ERR', result.error);
      return res.status(502).json({ error: result.error, resultCd: result.resultCd });
    }
    const zraItems = result.itemList || [];
    // Build a map of ZRA's view keyed by itemCd.
    const zraByCd = new Map();
    for (const it of zraItems) {
      if (it.itemCd) zraByCd.set(String(it.itemCd), it);
    }
    // Pull the local products that HAVE been pushed (zra_item_cd is set).
    // If zra_item_cd is null the product was never pushed — that's a
    // different problem (surface it separately as "unregistered locally").
    const localRows = db.prepare(
      `SELECT id, name, code, zra_item_cd, zra_item_cls_cd, zra_vat_cat_cd, zra_registered_at
         FROM products
        WHERE deleted_at IS NULL`
    ).all();
    const missingOnZra = [];
    const taxMismatches = [];
    const matched = [];
    const unregistered = [];
    for (const p of localRows) {
      // 2026-08-26 — was `if (!p.zra_item_cd) → unregistered`. That is
      // wrong: only the ORIGINAL catalogue got zra_item_cd from the
      // one-time ZM-code backfill. Products created since are registered
      // with ZRA under products.code (saveItem sends
      // `zra_item_cd || code`), so this reported perfectly-registered
      // items as "never pushed" — a false alarm that sent us chasing a
      // registration gap that did not exist.
      //
      // Registration status now comes from zra_registered_at, which
      // saveItem actually stamps, and matching uses the same code
      // fallback the send path uses.
      const itemCd = vsdc.itemCodeFor(p);
      if (!itemCd || !p.zra_registered_at) {
        unregistered.push({ id: p.id, name: p.name, code: p.code });
        continue;
      }
      const z = zraByCd.get(String(itemCd));
      if (!z) {
        missingOnZra.push({ id: p.id, name: p.name, itemCd, registered_at: p.zra_registered_at });
        continue;
      }
      // Match — check for tax-category drift. ZRA uses `taxTyCd` for the
      // VAT category on the selectItems response; local column is
      // zra_vat_cat_cd. Class-code drift (zra_item_cls_cd vs itemClsCd)
      // is the other frequent culprit.
      const localTax = (p.zra_vat_cat_cd || '').toUpperCase();
      const zraTax  = String(z.taxTyCd || z.vatCatCd || '').toUpperCase();
      const localCls = String(p.zra_item_cls_cd || '');
      const zraCls   = String(z.itemClsCd || '');
      if ((localTax && zraTax && localTax !== zraTax) ||
          (localCls && zraCls && localCls !== zraCls)) {
        taxMismatches.push({
          id: p.id, name: p.name, itemCd,
          local: { vatCatCd: localTax, itemClsCd: localCls },
          zra:   { taxTyCd:  zraTax,  itemClsCd: zraCls  },
        });
      } else {
        matched.push(p.id);
      }
      zraByCd.delete(String(itemCd));
    }
    // Whatever's left in zraByCd exists on ZRA but not in our local DB —
    // usually items registered from a different device or bhfId, worth
    // showing so the operator can investigate.
    const missingLocally = Array.from(zraByCd.values()).map(z => ({
      itemCd: z.itemCd, itemNm: z.itemNm, taxTyCd: z.taxTyCd || z.vatCatCd,
    }));
    // Deliberately NOT bumping sync state — this is a read-only
    // diagnostic, not a sync. Advancing last_req_dt made every
    // subsequent check pull an empty delta (see comment above).
    res.json({
      ok: true,
      zra_result_note: result.note || null,
      total_on_zra: zraItems.length,
      total_local: localRows.length,
      matched: matched.length,
      unregistered_locally: unregistered.length,
      missing_on_zra: missingOnZra.length,
      missing_locally: missingLocally.length,
      tax_mismatches: taxMismatches.length,
      details: {
        unregistered: unregistered.slice(0, 50),
        missing_on_zra: missingOnZra.slice(0, 50),
        missing_locally: missingLocally.slice(0, 50),
        tax_mismatches: taxMismatches.slice(0, 50),
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message, resultCd: error.resultCd });
  }
});

// ─── Single item lookup (support/debug) ─────────────────────────────────
//
// GET /api/zra/items/:itemCd — pull ONE item straight from VSDC.
// Handy when a specific product fails at sale time and support wants to
// see what tax type / class code ZRA has for it, without going through
// the full reconciliation report.
router.get('/items/:itemCd', auth, readOnlyGuard, async (req, res) => {
  try {
    const result = await vsdc.selectItem(req.user.tenantId, req.params.itemCd);
    if (result.skipped) return res.json(result);
    if (!result.ok) return res.status(502).json({ error: result.error, resultCd: result.resultCd });
    res.json({ itemCd: req.params.itemCd, exists: result.exists, item: result.item || null });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ─── Manufacturer RRP sync (MTV Category B accuracy) ───────────────────
//
// POST /api/zra/rrp/sync
// Pull the latest RRPs from VSDC and merge into products.zra_rrp by
// matching on zra_item_cd. Any local product whose itemCd is in the
// response gets its RRP updated. Products we don't sell (RRPs for
// items not in our catalogue) are ignored — no error, no orphan rows.
//
// Business context: for MTV Category B goods (beer, spirits, cigarettes,
// sugar, oil, soft drinks) VAT = max(actual net, RRP × qty) × 16/116.
// Manufacturers change RRPs periodically; without this sync we'd
// under-declare VAT on any post-RRP-change sale until someone
// manually updated products.zra_rrp. Recommended to schedule daily.
router.post('/rrp/sync', auth, async (req, res) => {
  try {
    const endpoint = '/items/selectRrpItems';
    const lastReqDt = req.body?.full === true ? vsdc.EPOCH_REQ_DT : vsdc.lastReqDtFor(endpoint);
    const result = await vsdc.selectRrpItems(req.user.tenantId, lastReqDt);
    if (result.skipped) return res.json({ ok: true, ...result, updated: 0 });
    if (!result.ok) {
      vsdc.bumpSyncState(endpoint, result.resultCd || 'ERR', result.error);
      return res.status(502).json({ error: result.error, resultCd: result.resultCd });
    }
    const rrpList = result.rrpList || [];
    // v1.13.149 — match on COALESCE(zra_item_cd, code), same fallback
    // vsdcClient.saveItem uses when building itemCd for registration
    // (`product.zra_item_cd || product.code`). New products never get
    // zra_item_cd auto-generated (no code path sets it), so they
    // register under their plain `code` — matching only on zra_item_cd
    // silently failed to update RRP for every such product, including
    // the very item Sirak just registered live during UAT-2 T04A
    // testing (T04A-TEST-01).
    const updateStmt = db.prepare(
      // 2026-09-02 — zra_mfr_item_cd first. ZRA keys RRPs by the
      // manufacturer's item code, which is why this matched 0 of 580.
      // NULL for every product until the mapping is filled, so the
      // COALESCE falls through to today's behaviour meanwhile.
      `UPDATE products SET zra_rrp = ? WHERE COALESCE(zra_mfr_item_cd, zra_item_cd, code) = ? AND deleted_at IS NULL`
    );
    let updated = 0, unmatched = 0;
    const unmatchedList = [];
    const tx = db.transaction((rows) => {
      for (const r of rows) {
        const cd  = String(r.itemCd || '').trim();
        const rrp = parseFloat(r.rrp);
        if (!cd || !Number.isFinite(rrp) || rrp <= 0) continue;
        const info = updateStmt.run(rrp, cd);
        if (info.changes > 0) updated++;
        else { unmatched++; if (unmatchedList.length < 25) unmatchedList.push({ itemCd: cd, rrp }); }
      }
    });
    tx(rrpList);
    vsdc.bumpSyncState(endpoint, '000', null);
    res.json({
      ok: true,
      pulled: rrpList.length,
      updated,
      unmatched,
      unmatched_sample: unmatchedList,
    });
  } catch (error) {
    vsdc.bumpSyncState('/items/selectRrpItems', error.resultCd || 'ERR', error.message);
    res.status(500).json({ error: error.message, resultCd: error.resultCd });
  }
});

// ─── Stock reconciliation pull ─────────────────────────────────────────
//
// POST /api/zra/stock/reconcile
// Pull ZRA's stock ledger and compare against local products.current_stock.
// Returns per-item deltas > tolerance so the operator can investigate any
// drift before it becomes a "missing stock = unrecorded sales" tax
// assessment. Read-only — no auto-correction.
router.post('/stock/reconcile', auth, async (req, res) => {
  try {
    const endpoint = '/stock/selectStockItems';
    // 2026-08-26 — was defaulting to lastReqDtFor() (incremental). Two
    // problems with that here: (1) a drift COMPARISON is meaningless
    // against a delta — you need ZRA's whole current picture to compare
    // local stock against; (2) the bumpSyncState('000') below stored
    // "now" on every click, so the NEXT click asked "what changed in the
    // last few seconds" and got nothing. That self-poisoning loop is why
    // "Items on ZRA" kept reading 0 even after the lastReqDt epoch fix.
    // Always pull full unless a caller explicitly opts into incremental.
    const lastReqDt = req.body?.full === false ? vsdc.lastReqDtFor(endpoint) : vsdc.STOCK_ITEMS_DEFAULT_REQ_DT;
    const tolerance = parseFloat(req.body?.tolerance) || 0.001;
    const result = await vsdc.selectStockItems(req.user.tenantId, lastReqDt);
    if (result.skipped) return res.json({ ok: true, ...result });
    if (!result.ok) {
      vsdc.bumpSyncState(endpoint, result.resultCd || 'ERR', result.error);
      return res.status(502).json({ error: result.error, resultCd: result.resultCd });
    }
    // 2026-08-26 — Corrected against a REAL sandbox response (captured in
    // the audit log; the spec's own response table for this endpoint is a
    // copy-paste of the Import Item response and cannot be trusted).
    //
    // Actual shape:
    //   data.stockList[] = one entry PER STOCK MOVEMENT RECORD, carrying
    //     { custTpin, custBhfId, sarNo, ocrnDt, totItemCnt, totTaxblAmt,
    //       totTaxAmt, totAmt, remark, itemList[] }
    //   and itemList[] = { itemSeq, itemCd, itemClsCd, itemNm, pkgUnitCd,
    //       pkg, qtyUnitCd, qty, prc, splyAmt, taxblAmt, vatCatCd, ... }
    //
    // Two consequences, both of which invalidated the original code:
    //   1. itemCd lives on itemList[], NOT on the stockList row. The old
    //      `if (!s.itemCd) continue` therefore skipped EVERY row, which is
    //      why this check always reported "Items on ZRA: 0".
    //   2. There is no rsdQty field anywhere in this response. This
    //      endpoint returns the MOVEMENT LEDGER, not residual stock
    //      levels. The old "local current_stock vs ZRA rsdQty" comparison
    //      was asking a question this endpoint cannot answer.
    //
    // Residual stock is something we PUSH (saveStockMaster rsdQty) and can
    // only be read back from the portal's Stock Inventory page — there is
    // no select* counterpart for it. So this diagnostic now reports what
    // ZRA's movement ledger actually holds per item, and no longer
    // pretends to compute a residual drift.
    const zraQtyByCd = new Map();   // itemCd -> summed movement qty
    const zraRecsByCd = new Map();  // itemCd -> movement record count
    let movementRecords = 0;
    for (const rec of (result.stockList || [])) {
      movementRecords++;
      for (const it of (rec.itemList || [])) {
        if (!it.itemCd) continue;
        const cd = String(it.itemCd);
        zraQtyByCd.set(cd, (zraQtyByCd.get(cd) || 0) + (parseFloat(it.qty) || 0));
        zraRecsByCd.set(cd, (zraRecsByCd.get(cd) || 0) + 1);
      }
    }
    // 2026-08-26 — was `AND zra_item_cd IS NOT NULL`, which silently
    // excluded every product created after the one-time ZM-code backfill
    // (they carry only products.code). Those items could never be
    // reported as drifted because they were never looked at — the exact
    // blind spot that let a GRN go unreported to ZRA unnoticed. Select
    // `code` too and resolve via vsdc.itemCodeFor, matching the send path.
    const localRows = db.prepare(
      `SELECT id, name, code, zra_item_cd, current_stock
         FROM products
        WHERE deleted_at IS NULL AND COALESCE(zra_item_cd, code) IS NOT NULL`
    ).all();
    // Report per item: local current_stock alongside the movement volume
    // ZRA has on file. NOTE these are different units of meaning — a
    // residual vs a sum of movements — so this is presented for
    // investigation, never auto-corrected.
    const drifts = [];
    for (const p of localRows) {
      const cd = vsdc.itemCodeFor(p);
      if (!cd) continue;
      const localQty = parseFloat(p.current_stock) || 0;
      if (!zraQtyByCd.has(cd)) {
        drifts.push({ id: p.id, name: p.name, itemCd: cd, local: localQty, zra: null, delta: null, note: 'no movement records on ZRA' });
      } else {
        drifts.push({
          id: p.id, name: p.name, itemCd: cd,
          local: localQty,
          zra_movement_qty: zraQtyByCd.get(cd),
          zra_movement_records: zraRecsByCd.get(cd),
        });
      }
    }
    // Deliberately NOT bumping sync state here — this is a read-only
    // diagnostic, not a sync. Advancing last_req_dt made every
    // subsequent check pull an empty delta (see comment above).
    res.json({
      ok: true,
      pulled: movementRecords,
      unique_items_on_zra: zraQtyByCd.size,
      matched_local: localRows.length,
      // Surface what ZRA actually answered so an empty list is
      // distinguishable from a silently-swallowed 001.
      zra_result_note: result.note || null,
      zra_result_cd: result.resultCd || null,
      drift_count: drifts.length,
      drifts: drifts.slice(0, 100),
    });
  } catch (error) {
    res.status(500).json({ error: error.message, resultCd: error.resultCd });
  }
});

// ─── Stock reconciliation — apply correction (DISABLED) ────────────────
//
// POST /api/zra/stock/reconcile/apply
//
// 2026-08-26 — DISABLED after verifying a real sandbox response.
//
// This endpoint was written on the assumption that
// /stock/selectStockItems returns a per-item RESIDUAL quantity (rsdQty),
// so that local products.current_stock minus ZRA rsdQty would yield a
// correctable drift. A captured live response proved that wrong: the
// endpoint returns the MOVEMENT LEDGER — stockList[] of movement records,
// each with a nested itemList[] carrying per-movement qty — and contains
// no rsdQty field at all.
//
// That means the delta this endpoint computed was derived from
// parseFloat(undefined) || 0, i.e. it treated ZRA as holding ZERO of
// every item. Had the parsing bug above it not also been silently
// skipping every row, this would have fired large bogus Adjustment
// In/Out movements against the live fiscal ledger for the entire
// catalogue. It is left disabled rather than deleted so the reasoning
// survives with the code.
//
// Residual stock is push-only (saveStockMaster rsdQty) — there is no
// select* counterpart to read it back, so a genuine residual
// reconciliation cannot be built on this endpoint. Any future correction
// must be driven from ZRA's movement ledger vs our own stock_movements
// ledger, comparing like with like.
router.post('/stock/reconcile/apply', auth, async (req, res) => {
  res.status(410).json({
    error: 'Disabled: this correction was based on a residual (rsdQty) field that /stock/selectStockItems does not return. '
         + 'Firing it would push bogus adjustments to the live fiscal ledger. See the comment block in routes/zra.js.',
  });
});

// ─── Import declarations queue (§5.8 T05A) ─────────────────────────────
//
// 2026-08-26 — Rebuilt to mirror the ZRA Purchase Queue (T06A) above,
// per user request, so both ZRA-sourced inbound flows behave identically:
//
//   1. POST /api/zra/imports/pull        — fetch declarations from
//      /imports/selectImportItems, upsert into zra_pending_imports
//      (dedup on taskCd + dclNo + itemSeq). Status NEW.
//   2. GET  /api/zra/imports             — list rows, filterable by ?status=.
//   3. GET  /api/zra/imports/:id         — single row + parsed raw_json.
//   4. POST /api/zra/imports/:id/approve — transmit approval to ZRA, then
//      create an HQ Purchase for the destination branch. Stock does NOT
//      move here.
//   5. POST /api/zra/imports/:id/reject  — transmit rejection to ZRA and
//      mark the row locally.
//
// TWO deliberate differences from the purchase queue, both forced by spec:
//
//   * BOTH decisions hit ZRA. /imports/updateImportItems must be called
//     with imptItemSttsCd '3' (approved) or '4' (rejected) — ZRA is
//     waiting on our answer for an import declaration. A purchase-queue
//     reject is local-only because ZRA already holds the supplier's side.
//   * QUANTITY IS EDITABLE. T05A Test Procedure step 3 ("the user updates
//     the quantities accordingly") — the declared customs qty may differ
//     from what physically arrived, so approve accepts an approved_qty
//     and the HQ Purchase is built from THAT, not the declared figure.
//
// Everything else matches T06A: pull-to-queue, destination branch picker,
// product matching on the destination branch, HQ Purchase creation with
// AWAITING_GRN lines, and stock deferred until the branch confirms
// receipt and HQ generates the GRN (which is where savePurchase +
// saveStockItems + saveStockMaster fire).
//
// Red Sea sources 100% locally, so this realistically stays empty — but
// the endpoints are MANDATORY per spec and must be provably callable.
router.post('/imports/pull', auth, async (req, res) => {
  try {
    const proxy = await resolveHqZraProxy(req);
    if (!proxy.ok) return res.status(400).json({ error: proxy.reason });
    return await proxy.run(async () => {
      const endpoint = '/imports/selectImportItems';
      // Full pull by default — same reasoning as the reconcile
      // diagnostics: an incremental delta plus a sync-state bump makes
      // every subsequent pull return nothing.
      const lastReqDt = req.body?.full === false ? vsdc.lastReqDtFor(endpoint) : vsdc.EPOCH_REQ_DT;
      const result = await vsdc.selectImportItems(proxy.tenantId, lastReqDt);
      if (result.skipped) return res.json({ ok: true, ...result, pulled: 0, inserted: 0 });
      if (!result.ok) {
        return res.status(502).json({ error: result.error, resultCd: result.resultCd });
      }
      const list = result.importList || [];
      let inserted = 0;
      const ins = db.prepare(`
        INSERT INTO zra_pending_imports (
          task_cd, dcl_de, dcl_no, item_seq, hs_cd, item_cd, item_cls_cd, item_nm,
          orgn_nat_cd, expt_nat_cd, pkg, pkg_unit_cd, qty, qty_unit_cd,
          tot_wt, net_wt, spplr_nm, agnt_nm,
          invc_fcur_amt, invc_fcur_cd, invc_fcur_excrt, dcl_ref_num,
          impt_item_stts_cd, raw_json, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'NEW')
        ON CONFLICT DO NOTHING
      `);
      db.transaction(() => {
        for (const it of list) {
          const info = ins.run(
            it.taskCd ?? null, it.dclDe ?? null, it.dclNo ?? null, it.itemSeq ?? null,
            it.hsCd ?? null, it.itemCd ?? null, it.itemClsCd ?? null, it.itemNm ?? null,
            it.orgnNatCd ?? null, it.exptNatCd ?? null,
            it.pkg ?? null, it.pkgUnitCd ?? null, it.qty ?? null, it.qtyUnitCd ?? null,
            it.totWt ?? null, it.netWt ?? null, it.spplrNm ?? null, it.agntNm ?? null,
            it.invcFcurAmt ?? null, it.invcFcurCd ?? null, it.invcFcurExcrt ?? null,
            it.dclRefNum ?? null, it.imptItemSttsCd ?? null,
            JSON.stringify(it),
          );
          if (info.changes) inserted++;
        }
      })();
      res.json({
        ok: true,
        pulled: list.length,
        inserted,
        duplicates: list.length - inserted,
        zra_result_note: result.note || null,
        proxied_via: proxy.proxiedVia || null,
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message, resultCd: error.resultCd });
  }
});

// List — mirrors GET /api/zra/purchases.
router.get('/imports', auth, readOnlyGuard, async (req, res) => {
  try {
    const proxy = await resolveHqZraProxy(req);
    if (!proxy.ok) return res.status(400).json({ error: proxy.reason });
    return await proxy.run(async () => {
      const status = String(req.query.status || '').toUpperCase();
      const where = status && status !== 'ALL' ? 'WHERE status = ?' : '';
      const rows = status && status !== 'ALL'
        ? db.prepare(`SELECT * FROM zra_pending_imports ${where} ORDER BY id DESC LIMIT 500`).all(status)
        : db.prepare('SELECT * FROM zra_pending_imports ORDER BY id DESC LIMIT 500').all();
      const counts = db.prepare(
        `SELECT status, COUNT(*) AS n FROM zra_pending_imports GROUP BY status`
      ).all().reduce((a, r) => { a[r.status] = r.n; return a; }, {});
      res.json({ imports: rows, counts });
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/imports/:id', auth, readOnlyGuard, async (req, res) => {
  try {
    const proxy = await resolveHqZraProxy(req);
    if (!proxy.ok) return res.status(400).json({ error: proxy.reason });
    return await proxy.run(async () => {
      const row = db.prepare('SELECT * FROM zra_pending_imports WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      let raw = {};
      try { raw = JSON.parse(row.raw_json || '{}'); } catch { /* empty */ }
      res.json({ ...row, raw });
    });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// Shared by approve + reject: transmit the decision to ZRA.
// imptItemSttsCd per spec §5.8 — '3' approved, '4' rejected.
async function transmitImportDecision(tenantId, row, decision, actor) {
  return vsdc.updateImportItems(tenantId, {
    taskCd: row.task_cd,
    dclDe:  row.dcl_de,
    items: [{
      itemSeq:        row.item_seq,
      hsCd:           row.hs_cd || null,
      itemClsCd:      row.item_cls_cd || null,
      itemCd:         row.item_cd,
      imptItemSttsCd: decision === 'approve' ? '3' : '4',
      remark:         null,
    }],
    actor: String(actor || 'system'),
  });
}

router.post('/imports/:id/approve', auth, async (req, res) => {
  try {
    const proxy = await resolveHqZraProxy(req);
    if (!proxy.ok) return res.status(400).json({ error: proxy.reason });
    return await proxy.run(async () => {
      const row = db.prepare('SELECT * FROM zra_pending_imports WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'NEW') return res.status(400).json({ error: `Row is ${row.status}, not NEW` });

      const destination_slug = String(req.body?.destination_slug || '').toLowerCase();
      if (!destination_slug) return res.status(400).json({ error: 'destination_slug is required' });
      if (!isRegistered(destination_slug)) {
        return res.status(400).json({ error: `Destination "${destination_slug}" is not a registered branch` });
      }

      // T05A step 3 — the operator may correct the declared quantity to
      // what actually arrived. Falls back to the declared figure.
      const approvedQty = req.body?.approved_qty != null
        ? parseFloat(req.body.approved_qty)
        : (parseFloat(row.qty) || 0);
      if (!(approvedQty > 0)) return res.status(400).json({ error: 'Approved quantity must be greater than zero' });

      const destName = (() => {
        try {
          const t = listTenants().find(t => t.slug === destination_slug);
          if (!t) return destination_slug;
          try {
            const bdb = getTenantDb(destination_slug);
            const r = bdb.prepare('SELECT business_name FROM business_settings ORDER BY id ASC LIMIT 1').get();
            if (r?.business_name) return r.business_name;
          } catch (_) {}
          return t.business_name || destination_slug;
        } catch (_) { return destination_slug; }
      })();

      // Transmit to ZRA FIRST. Unlike the purchase queue (where approval
      // is purely internal until GRN), ZRA is blocking on this answer —
      // so if it fails there is nothing to record locally either.
      const updateRes = await transmitImportDecision(proxy.tenantId, row, 'approve', req.user?.id);
      if (updateRes.skipped) return res.status(400).json({ error: `ZRA call skipped: ${updateRes.reason}` });
      if (!updateRes.ok) {
        db.prepare('UPDATE zra_pending_imports SET error = ? WHERE id = ?')
          .run(`[${updateRes.resultCd || 'ERR'}] ${updateRes.error || 'updateImportItems failed'}`, row.id);
        return res.status(502).json({ error: updateRes.error, resultCd: updateRes.resultCd });
      }

      // Match to a product on the DESTINATION branch — same rules as the
      // purchase queue: itemCd first, then name. An unmatched line still
      // proceeds on a fresh sync_id; hqPurchases.js Confirm auto-creates
      // the product from the line snapshot at receive time.
      let branchDb;
      try { branchDb = getTenantDb(destination_slug); }
      catch (e) { return res.status(400).json({ error: `Cannot open destination DB: ${e.message}` }); }
      let product = row.item_cd ? branchDb.prepare(
        `SELECT id, sync_id, name, unit FROM products
          WHERE zra_item_cd = ? AND (deleted_at IS NULL) LIMIT 1`
      ).get(row.item_cd) : null;
      if (!product && row.item_nm) {
        product = branchDb.prepare(
          `SELECT id, sync_id, name, unit FROM products
            WHERE LOWER(name) = LOWER(?) AND (deleted_at IS NULL)
            ORDER BY id ASC LIMIT 1`
        ).get(row.item_nm);
      }
      const matchSummary = product
        ? `matched "${product.name}" at ${destination_slug}`
        : `no local match at ${destination_slug} — will be auto-created on receipt`;

      // Unit cost from the customs value where available. invcFcurAmt is
      // a FOREIGN-currency total for the line, so convert with the
      // declared rate and divide by qty. Where the declaration carries no
      // usable value we leave 0 rather than invent one — the branch
      // enters the real landed cost at GRN, which is what feeds WAC.
      const fcurAmt = parseFloat(row.invc_fcur_amt) || 0;
      const fcurRate = parseFloat(row.invc_fcur_excrt) || 0;
      const declaredQty = parseFloat(row.qty) || 0;
      const unitCost = (fcurAmt > 0 && fcurRate > 0 && declaredQty > 0)
        ? +((fcurAmt * fcurRate) / declaredQty).toFixed(4)
        : 0;

      const purchaseSyncId = randomUUID();
      // Same HQP-YYYY-NNNNN sequence as every other HQ purchase, so an
      // import-sourced PO is not a special case downstream.
      const purchaseNumber = (() => {
        const seq = (masterDb.prepare('SELECT COUNT(*) AS n FROM hq_purchases').get()?.n || 0) + 1;
        return `HQP-${new Date().getFullYear()}-${String(seq).padStart(5, '0')}`;
      })();
      // hq_purchases.date is NOT NULL. Use the declaration date where
      // ZRA supplied one (yyyyMMdd), else today.
      const purchaseDate = row.dcl_de
        ? String(row.dcl_de).replace(/^(\d{4})(\d{2})(\d{2}).*/, '$1-$2-$3')
        : new Date().toISOString().slice(0, 10);
      const lineTotal = +(approvedQty * unitCost).toFixed(4);
      const notesText = `Auto-created from ZRA import declaration ${row.dcl_no || '—'} `
        + `(task ${row.task_cd || '—'}, item ${row.item_seq}) — ${matchSummary}`
        + (approvedQty !== declaredQty ? ` · qty adjusted ${declaredQty} → ${approvedQty}` : '');
      let newPurchaseId = null;
      masterDb.transaction(() => {
        const info = masterDb.prepare(`
          INSERT INTO hq_purchases (purchase_number, sync_id, supplier_id, supplier_name, invoice_number,
                                    date, total_amount, notes, status,
                                    cost_currency, fx_rate_used,
                                    created_by, created_by_name,
                                    zra_pending_purchase_id, zra_spplr_tpin, zra_spplr_bhf_id, zra_reg_ty_cd)
          VALUES (?,?,?,?,?,?,?,?,'OPEN',?,?,?,?,?,?,?,?)
        `).run(
          purchaseNumber, purchaseSyncId,
          null,
          row.spplr_nm || row.agnt_nm || 'Import declaration',
          row.dcl_no || null,
          purchaseDate, lineTotal, notesText,
          'K', null,
          req.user?.id || null, req.user?.firstName || req.user?.email || 'HQ',
          // zra_reg_ty_cd left NULL deliberately. On the purchase queue
          // 'A' tells hqGrns.js to fire /trnsPurchase/savePurchase at GRN
          // time — but an import is NOT a domestic supplier purchase and
          // ZRA already holds the declaration, so sending savePurchase
          // here would misreport it. Per the spec's own dependency note
          // an approved import should chain saveStockItems +
          // saveStockMaster with sarTyCd '01' (IMPORT_INCOMING) instead.
          // That GRN-time branch is NOT wired: this path cannot be
          // exercised (Red Sea sources 100% locally, ZRA returns no
          // declarations), so it is left explicitly undefined rather
          // than guessed at. Define it with real data before relying on
          // it — see the T05A notes above.
          null, null, null, null
        );
        newPurchaseId = info.lastInsertRowid;
        masterDb.prepare(`
          INSERT INTO hq_purchase_items (purchase_id, purchase_sync_id, sync_id,
                                         product_sync_id, product_name, unit,
                                         dispatched_qty, cost_price, cost_price_usd, line_total,
                                         base_price, vat_amount, discount_amount,
                                         destination_slug, destination_name, status,
                                         zra_item_cd, zra_item_cls_cd, zra_pkg_unit_cd,
                                         zra_qty_unit_cd, zra_vat_cat_cd, zra_excise_ty_cd, zra_rrp)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'AWAITING_GRN',?,?,?,?,?,?,?)
        `).run(
          newPurchaseId, purchaseSyncId, randomUUID(),
          product?.sync_id || randomUUID(),
          row.item_nm || row.item_cd || 'Imported item',
          product?.unit || row.qty_unit_cd || null,
          approvedQty, unitCost, null, lineTotal,
          // An import declaration carries no VAT or discount line — duty and
          // VAT are settled separately with customs — so base is the cost and
          // the other two are genuinely zero rather than unknown.
          unitCost, 0, 0,
          destination_slug, destName,
          row.item_cd || null, row.item_cls_cd || null, row.pkg_unit_cd || null,
          row.qty_unit_cd || null, null, null, null
        );
      })();

      db.prepare(`UPDATE zra_pending_imports
                     SET status = 'APPROVED',
                         approved_qty = ?,
                         destination_slug = ?,
                         destination_name = ?,
                         hq_purchase_id = ?,
                         hq_purchase_number = ?,
                         match_summary = ?,
                         impt_item_stts_cd = '3',
                         error = NULL,
                         decided_at = datetime('now'),
                         decided_by = ?
                   WHERE id = ?`)
        .run(approvedQty, destination_slug, destName, newPurchaseId, purchaseNumber,
             matchSummary, req.user?.id || null, row.id);

      const fresh = db.prepare('SELECT * FROM zra_pending_imports WHERE id = ?').get(row.id);
      const hqPurchase = masterDb.prepare('SELECT * FROM hq_purchases WHERE id = ?').get(newPurchaseId);
      res.json({ ...fresh, hq_purchase: hqPurchase, zra: updateRes });
    });
  } catch (error) {
    res.status(500).json({ error: error.message, resultCd: error.resultCd });
  }
});

router.post('/imports/:id/reject', auth, async (req, res) => {
  try {
    const proxy = await resolveHqZraProxy(req);
    if (!proxy.ok) return res.status(400).json({ error: proxy.reason });
    return await proxy.run(async () => {
      const row = db.prepare('SELECT * FROM zra_pending_imports WHERE id = ?').get(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.status !== 'NEW') return res.status(400).json({ error: `Row is ${row.status}, not NEW` });
      const reason = (req.body?.reason || '').trim() || null;

      // Unlike the purchase queue, a reject MUST reach ZRA — the
      // declaration stays pending on their side until we answer.
      const updateRes = await transmitImportDecision(proxy.tenantId, row, 'reject', req.user?.id);
      if (updateRes.skipped) return res.status(400).json({ error: `ZRA call skipped: ${updateRes.reason}` });
      if (!updateRes.ok) {
        db.prepare('UPDATE zra_pending_imports SET error = ? WHERE id = ?')
          .run(`[${updateRes.resultCd || 'ERR'}] ${updateRes.error || 'updateImportItems failed'}`, row.id);
        return res.status(502).json({ error: updateRes.error, resultCd: updateRes.resultCd });
      }

      db.prepare(`UPDATE zra_pending_imports
                     SET status = 'REJECTED',
                         impt_item_stts_cd = '4',
                         error = ?,
                         decided_at = datetime('now'),
                         decided_by = ?
                   WHERE id = ?`).run(reason, req.user?.id || null, row.id);
      res.json({ ...db.prepare('SELECT * FROM zra_pending_imports WHERE id = ?').get(row.id), zra: updateRes });
    });
  } catch (error) { res.status(500).json({ error: error.message, resultCd: error.resultCd }); }
});

// ─── Branch list pull ──────────────────────────────────────────────────
//
// GET /api/zra/branches — pull the branch office list ZRA has for our
// TPIN. Handy when opening a new branch: retrieve the ZRA-issued bhfId
// so it can be entered into business_settings.zra_bhf_id on the new
// depot's Kelete instance. Read-only.
router.get('/branches', auth, readOnlyGuard, async (req, res) => {
  try {
    const result = await vsdc.selectBranches(req.user.tenantId);
    if (result.skipped) return res.json(result);
    if (!result.ok) return res.status(502).json({ error: result.error, resultCd: result.resultCd });
    res.json({ branches: result.branchList || [] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ─── Invoice recovery lookup ────────────────────────────────────────────
//
// GET /api/zra/invoices/:invcNo
// Query VSDC's /trnsSales/selectInvoice to check whether a sale invoice
// number (allocated locally, then sent to VSDC via saveSales) is present
// on ZRA's side. Used two ways:
//   1. Reconciliation UI — operator can look up any invoice to confirm
//      its fiscal state without digging through zra_audit_log.
//   2. Retry-loop guard — before re-sending a failed/timed-out saveSales,
//      the retry queue calls this first so we don't create a duplicate
//      when the first call actually landed on ZRA's side after the
//      response was lost.
router.get('/invoices/:invcNo', auth, readOnlyGuard, async (req, res) => {
  try {
    const invcNo = Number(req.params.invcNo);
    if (!Number.isFinite(invcNo) || invcNo <= 0) {
      return res.status(400).json({ error: 'invcNo must be a positive integer' });
    }
    const result = await vsdc.selectInvoice(req.user.tenantId, invcNo);
    if (result.skipped) return res.json(result);
    if (!result.ok) return res.status(502).json({ error: result.error, resultCd: result.resultCd });
    res.json({ invcNo, exists: result.exists, data: result.data || null });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ─── Customer TPIN lookup ───────────────────────────────────────────────
//
// GET /api/zra/customer-lookup/:tpin
// Called from the POS Pay modal when the cashier types a buyer's TPIN.
// Returns { exists, customer: { tpin, name, address, ... } } so the UI
// can auto-fill and validate the customer legal name before saveSales.
// This is what turns "cashier types any 10 digits" into "cashier types
// the buyer's TPIN and gets the ZRA-registered name back."
router.get('/customer-lookup/:tpin', auth, readOnlyGuard, async (req, res) => {
  try {
    const tpin = String(req.params.tpin || '').trim();
    const result = await vsdc.selectCustomer(req.user.tenantId, tpin);

    // v1.13.157 — merge with our own customers table on EVERY lookup,
    // not just when ZRA is disabled. ZRA's own customer registry is
    // often thin (many TPINs have a name on file but no address) — a
    // buyer we've sold to before locally may have an address ZRA never
    // captured. ZRA's field wins when both sources have a value;
    // ours fills in whatever ZRA leaves blank. Read-only — never
    // writes here (persistence happens at order-create time instead,
    // see routes/orders.js).
    let local = null;
    try {
      local = db.prepare(
        "SELECT name, address, phone, tpin FROM customers WHERE tpin = ? AND (deleted_at IS NULL) LIMIT 1"
      ).get(tpin);
    } catch (_) { /* best-effort */ }

    if (result.skipped) {
      if (local) {
        return res.json({
          tpin, exists: true, source: 'local',
          customer: { name: local.name || '', address: local.address || '', phone: local.phone || '' },
        });
      }
      return res.json(result);
    }
    if (!result.ok) {
      // 2026-09-03 — production VSDC refuses the whole select* family with
      // 901 "It is not valid device", so this lookup now fails for every
      // branch. A failed lookup must not strand the cashier: fall back to
      // our own customers table exactly as the `skipped` path above does.
      //
      // When we have nothing locally either, say the lookup was
      // UNAVAILABLE rather than returning an error the UI renders as
      // "TPIN not registered". Those two mean different things — one is
      // the buyer's problem, the other is ours — and conflating them puts
      // a false claim about the buyer's tax status on the cashier's screen.
      if (local) {
        return res.json({
          tpin, exists: true, source: 'local',
          customer: { name: local.name || '', address: local.address || '', phone: local.phone || '' },
        });
      }
      return res.json({
        tpin, exists: false, unavailable: true, customer: null,
        error: result.error, resultCd: result.resultCd,
      });
    }

    if (!result.exists) {
      // ZRA has never heard of this TPIN — fall back entirely to our
      // own record if we have one (e.g. a customer we registered
      // ourselves that hasn't been pushed to ZRA yet).
      if (local) {
        return res.json({
          tpin, exists: true, source: 'local',
          customer: { name: local.name || '', address: local.address || '', phone: local.phone || '' },
        });
      }
      return res.json({ tpin, exists: false, customer: null });
    }

    // ZRA found the TPIN — merge, ZRA's field wins per-attribute.
    const merged = {
      name:    result.customer.name    || local?.name    || '',
      address: result.customer.address || local?.address || '',
      phone:   result.customer.phone   || local?.phone   || '',
    };
    const usedLocalForAnything = (!result.customer.address && local?.address) || (!result.customer.name && local?.name);
    res.json({ tpin, exists: true, source: usedLocalForAnything ? 'merged' : 'zra', customer: merged });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// v1.13.144 — legacy /audit-log removed here (returned no bodies and
// won the Express route match against the v1.13.144 handler below).
// The comprehensive version follows.

// v1.13.144 — In-app ZRA audit log viewer for UAT / ops. Reviewer can
// see every VSDC request+response without SSHing to the VPS. Filters:
//   ?endpoint=/trnsSales/saveSales   (exact match)
//   ?result_cd=000                   (exact match; use 'error' to catch !='000')
//   ?from=YYYY-MM-DD                 (inclusive)
//   ?to=YYYY-MM-DD                   (inclusive)
//   ?limit=50&offset=0
// Row shape: id, endpoint, result_cd, result_msg, http_status,
// duration_ms, cis_invc_no, created_at, request_body, response_body.
router.get('/audit-log', auth, readOnlyGuard, (req, res) => {
  try {
    const where = ['1=1'];
    const params = [];
    if (req.query.endpoint) { where.push('endpoint = ?'); params.push(String(req.query.endpoint)); }
    if (req.query.result_cd === 'error') {
      where.push("result_cd != '000' AND result_cd IS NOT NULL");
    } else if (req.query.result_cd) {
      where.push('result_cd = ?');
      params.push(String(req.query.result_cd));
    }
    if (req.query.from) { where.push('date(created_at) >= ?'); params.push(String(req.query.from)); }
    if (req.query.to)   { where.push('date(created_at) <= ?'); params.push(String(req.query.to)); }
    const limit  = Math.min(parseInt(req.query.limit, 10)  || 50, 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const rows = db.prepare(`
      SELECT id, endpoint, result_cd, result_msg, http_status, duration_ms,
             cis_invc_no, request_body, response_body,
             -- 2026-08-28 — return the RAW timestamp and let the browser do
             -- the one and only conversion. Sending ONLY the 'localtime'
             -- version double-shifted every row: SQLite turned UTC into
             -- local and dropped the marker, then the viewer saw a bare
             -- timestamp, assumed UTC, and added the offset a second time
             -- (14:00Z displayed as 18:00 in a UTC+2 branch).
             -- created_at_local is kept for older clients; the viewer
             -- prefers created_at.
             created_at,
             datetime(created_at, 'localtime') AS created_at_local
        FROM zra_audit_log
       WHERE ${where.join(' AND ')}
       ORDER BY id DESC
       LIMIT ? OFFSET ?
    `).all(...params, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM zra_audit_log WHERE ${where.join(' AND ')}`).get(...params).n;
    // Distinct endpoints for the filter dropdown — capped at 200.
    const endpoints = db.prepare(`SELECT DISTINCT endpoint FROM zra_audit_log ORDER BY endpoint LIMIT 200`).all().map(r => r.endpoint);
    res.json({ rows, total, endpoints, limit, offset });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
