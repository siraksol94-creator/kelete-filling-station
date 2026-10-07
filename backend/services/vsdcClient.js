// Shared VSDC HTTP client. All ZRA-facing route files funnel through this
// so timeouts, retries, audit logging, tpin/bhfId injection and error
// handling stay in one place.
//
// VSDC is a local Java WAR â€” REST/JSON, POST-only, no auth headers.
// See project_kelete_zra.md for the deployment recap.
const db = require('../config/database');

// Bootstrap timestamp: "20000101000000" (yyyyMMddHHmmss) â€” VSDC uses this
// as the "give me everything since epoch" marker on incremental endpoints.
const EPOCH_REQ_DT = '20000101000000';

// VSDC validates every monetary field as <18 digits>.<4 digits> and hard-
// rejects longer values with 910 "Request parameter error". Summing float
// line amounts drifts past 4dp (e.g. 17 lines summed to 512601.3792000001),
// so every header roll-up must be pushed back through this before sending.
const round4 = (n) => Number((Number(n) || 0).toFixed(4));

// The item code ZRA knows a product by.
//
// 2026-08-26 â€” `products.zra_item_cd` is NOT reliably populated. A
// one-time script backfilled ZM-format codes for the ORIGINAL catalogue;
// every product created since leaves that column NULL and is registered
// with ZRA under its plain `products.code` instead â€” saveItem has always
// sent `product.zra_item_cd || product.code`.
//
// Code written after that backfill quietly assumed zra_item_cd is always
// set. The damage was silent: a GRN for a newly-created product skipped
// every line, sent nothing to ZRA, and still increased local stock (see
// hqGrns.js) â€” while the drift diagnostics reported those same products
// as "never registered" when they were registered all along.
//
// Use this everywhere an itemCd is needed, so the rule lives in one
// place. Accepts any row carrying zra_item_cd / code (a products row, a
// joined order/GRN line, or an hq_purchase_items snapshot).
const itemCodeFor = (...rows) => {
  for (const r of rows) {
    if (!r) continue;
    const cd = r.zra_item_cd || r.code || r.product_code || null;
    if (cd) return String(cd);
  }
  return null;
};

// yyyyMMddHHmmss for the current instant. VSDC's spec format.
// 2026-08-30 â€” every VSDC timestamp is built in UTC, NOT the machine's local
// time.
//
// These used to read getFullYear()/getHours(), i.e. whatever timezone the
// computer happened to sit in. The VPS runs UTC and a till runs Zambian time
// (UTC+2), so for the two hours after local midnight the till stamped
// TOMORROW'S date while the VPS stamped today's. ZRA accepted the VPS and
// refused the till:
//
//   910 [<salesDt>] must be a valid date and should not exceeding
//       180 days behind or future dates.
//
// Seen live at 00:27 local: till sent 20260830, VPS sent 20260829, same
// instant. "Works on the web, fails on the desktop" â€” and only after
// midnight, which is exactly when nobody is around to report it.
//
// UTC makes the stamp identical on every machine regardless of where it is,
// and matches what ZRA has been accepting from the VPS all along.
const nowReqDt = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
       + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

// Read the ZRA config for this tenant. Throws if VSDC isn't initialized â€”
// callers should surface that as a 400 to the operator.
function getConfig(tenantId) {
  const cfg = db.prepare(
    `SELECT zra_enabled, zra_env, zra_vsdc_url, zra_tpin, zra_bhf_id, zra_dvc_srl_no,
            zra_sdc_id, zra_initialized_at, zra_proxy_secret
       FROM business_settings WHERE tenant_id = ? LIMIT 1`
  ).get(tenantId);
  if (!cfg) throw new Error('business_settings row missing');
  if (!cfg.zra_vsdc_url || !cfg.zra_tpin || !cfg.zra_bhf_id) {
    throw new Error('ZRA not configured â€” set VSDC URL, TPIN and Branch ID first');
  }
  return cfg;
}

// The read-side of zra_sync_state â€” returns "20000101000000" on first run.
function lastReqDtFor(endpoint) {
  const row = db.prepare('SELECT last_req_dt FROM zra_sync_state WHERE endpoint = ?').get(endpoint);
  return row?.last_req_dt || EPOCH_REQ_DT;
}

function bumpSyncState(endpoint, resultCd, error) {
  db.prepare(
    `INSERT INTO zra_sync_state (endpoint, last_req_dt, last_pulled_at, last_result_cd, last_error)
     VALUES (?, ?, datetime('now'), ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       last_req_dt   = excluded.last_req_dt,
       last_pulled_at = excluded.last_pulled_at,
       last_result_cd = excluded.last_result_cd,
       last_error     = excluded.last_error`
  ).run(endpoint, nowReqDt(), resultCd ?? null, error ?? null);
}

// One place that writes to zra_audit_log so every VSDC call is traceable.
// Used by /api/zra routes and later by product/order/GRN save hooks.
function logAudit({ endpoint, cis_invc_no, request_body, response_body,
                    result_cd, result_msg, http_status, duration_ms }) {
  try {
    // 2026-08-28 â€” write created_at as an explicit ISO-8601 UTC string
    // instead of leaning on the column default.
    //
    // The viewer renders a stored "YYYY-MM-DD HH:MM:SS" by appending 'Z'
    // (i.e. assuming UTC) and converting to the reader's timezone. That
    // matched the VPS, whose clock runs UTC, but an Electron till was
    // landing two hours ahead and rolling into the next day â€” its stored
    // value was already local, so the +2 was applied a second time.
    //
    // An ISO string carries its own 'Z', so the viewer's
    // /[TZ]/ test passes it straight through and no assumption about the
    // writer's clock is made at all. Correct on both platforms, and the
    // ambiguity that caused this cannot recur.
    db.prepare(
      `INSERT INTO zra_audit_log
         (endpoint, cis_invc_no, request_body, response_body,
          result_cd, result_msg, http_status, duration_ms, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(endpoint, cis_invc_no ?? null,
          request_body ?? null, response_body ?? null,
          result_cd ?? null, result_msg ?? null,
          http_status ?? null, duration_ms ?? null,
          new Date().toISOString());
  } catch (e) {
    console.warn('[vsdcClient] audit log insert failed:', e.message);
  }
}

// Low-level: POST arbitrary JSON to a VSDC endpoint and return parsed
// response. Adds tpin/bhfId to the body if missing. Records audit log
// on both success and failure. Timeout defaults to 20s â€” VSDC is local
// so anything longer means the JVM is stuck.
async function post(tenantId, path, extraBody = {}, opts = {}) {
  const cfg = getConfig(tenantId);
  const base = cfg.zra_vsdc_url.replace(/\/+$/, '');
  const url  = base + (path.startsWith('/') ? path : '/' + path);
  const body = { tpin: cfg.zra_tpin, bhfId: cfg.zra_bhf_id, ...extraBody };
  const requestBody = JSON.stringify(body);

  const startedAt = Date.now();
  let httpStatus = 0, responseBody = null, parsed = null;
  let resultCd = null, resultMsg = null;
  const timeoutMs = opts.timeoutMs ?? 20_000;

  // 2026-08-27 â€” when the configured VSDC URL points at the VPS proxy
  // (Electron tills, which have no local Tomcat), attach the branch's
  // shared secret. A real VSDC never sees this header and ignores it, so
  // it is safe to send unconditionally â€” but it is only populated when
  // the URL actually looks like our proxy, so the secret is not leaked
  // to an unrelated host someone might configure by mistake.
  const headers = { 'Content-Type': 'application/json' };
  if (/\/vsdc-proxy(\/|$)/.test(base) && cfg.zra_proxy_secret) {
    headers['X-VSDC-Proxy-Secret'] = cfg.zra_proxy_secret;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
    httpStatus = res.status;
    responseBody = await res.text();
    try { parsed = JSON.parse(responseBody); }
    catch { throw new Error(`Non-JSON response (HTTP ${httpStatus}): ${responseBody.slice(0, 300)}`); }
    resultCd  = parsed.resultCd || null;
    resultMsg = parsed.resultMsg || null;
    if (resultCd !== '000') {
      // 001 = "no result" â€” not an error for incremental sync (means
      // nothing new since lastReqDt). Callers decide how to treat it.
      const err = new Error(`VSDC ${path} -> ${resultCd} ${resultMsg || ''}`.trim());
      err.resultCd = resultCd; err.resultMsg = resultMsg; err.parsed = parsed;
      throw err;
    }
    return parsed;
  } catch (e) {
    e.resultCd = e.resultCd || resultCd;
    e.resultMsg = e.resultMsg || resultMsg;
    e.httpStatus = httpStatus;
    throw e;
  } finally {
    logAudit({
      endpoint: path,
      cis_invc_no: opts.cisInvcNo,
      request_body: requestBody,
      response_body: responseBody,
      result_cd: resultCd,
      result_msg: resultMsg,
      http_status: httpStatus,
      duration_ms: Date.now() - startedAt,
    });
  }
}

// Convenience: is ZRA both configured AND enabled for this tenant?
// Every "call VSDC after a business event" hook (product save, POS pay,
// GRN confirm, etc.) uses this to skip cleanly when the operator hasn't
// turned ZRA on yet â€” no need to sprinkle try/catch everywhere.
function isEnabled(tenantId) {
  try {
    const cfg = db.prepare(
      `SELECT zra_enabled, zra_vsdc_url, zra_tpin, zra_bhf_id
         FROM business_settings WHERE tenant_id = ? LIMIT 1`
    ).get(tenantId);
    return !!(cfg && cfg.zra_enabled && cfg.zra_vsdc_url && cfg.zra_tpin && cfg.zra_bhf_id);
  } catch { return false; }
}

// v1.13.101 â€” T11A offline-block support. Two helpers:
//   isBlockOfflineOn(tenantId) â€” reads the config toggle.
//   diagnoseVsdc(tenantId)      â€” probes the configured VSDC and returns
//                                 { ok, code, message }. Distinguishes a
//                                 real outage from wrong settings on this
//                                 desktop (bad URL, bad proxy secret,
//                                 TPIN/branch ID ZRA rejects) so the
//                                 cashier is told what to actually fix.
//   pingVsdc(tenantId)          â€” boolean wrapper over diagnoseVsdc.
//                                 Used by /orders POST as a pre-flight
//                                 when the toggle is on.
function isBlockOfflineOn(tenantId) {
  try {
    const cfg = db.prepare(
      `SELECT zra_block_offline_sales
         FROM business_settings WHERE tenant_id = ? LIMIT 1`
    ).get(tenantId);
    return !!(cfg && cfg.zra_block_offline_sales);
  } catch { return false; }
}

// T11A health check â€” is VSDC actually able to fiscalise right now?
//
// 2026-08-26 â€” REWRITTEN after a live compliance failure. The previous
// implementation did GET on the base URL and returned true for ANY HTTP
// response, on the reasoning that "the servlet container answered, so
// it's reachable". That is not the same question. Tomcat stayed up while
// the VSDC application inside it was absent, so the base URL returned a
// 404 HTML error page â€” the ping read that as healthy, the offline guard
// stood down, and INV-2026-C1DCF1-0057 was invoiced with no fiscal
// receipt (orders.zra_error_message: "Non-JSON response (HTTP 404)").
// T11A requires the invoice NOT be created when VSDC is unavailable, so
// a container that answers but cannot fiscalise must count as OFFLINE.
//
// The check now proves VSDC itself is responding: POST a cheap read-only
// call and require a JSON body carrying a resultCd. HTML, 404s, empty
// bodies and connection failures all read as offline. Any resultCd is
// accepted â€” even 001 "no data" â€” because the question is "can VSDC
// answer?", not "does VSDC have data?".
//
// /code/selectCodes is used because it is read-only, has no side effects
// and is cheap when asked for a narrow window.
const PING_CACHE_MS = 5000;
const pingCache = new Map();   // tenantId -> { at, dx }

// 2026-08-28 â€” the old ping returned a bare boolean, so every failure
// reached the cashier as "VSDC is offline" no matter what actually went
// wrong. A wrong proxy secret, a wrong URL and a genuinely dead Tomcat
// are three different problems with three different fixes, and two of
// them are settings on THIS desktop rather than a service outage.
//
// Worse, a wrong TPIN / branch ID used to PASS: VSDC answers, the answer
// carries a resultCd, so the old check called it healthy and the sale
// only failed later at fiscalisation. That is now caught up front.
//
// diagnoseVsdc returns { ok, code, message }. `code` is for logs/tests,
// `message` is shown to the cashier verbatim.
async function diagnoseVsdc(tenantId) {
  const cached = pingCache.get(tenantId);
  if (cached && (Date.now() - cached.at) < PING_CACHE_MS) return cached.dx;

  const done = (dx) => { pingCache.set(tenantId, { at: Date.now(), dx }); return dx; };

  let cfg;
  try {
    cfg = db.prepare(
      `SELECT zra_vsdc_url, zra_tpin, zra_bhf_id, zra_proxy_secret
         FROM business_settings WHERE tenant_id = ? LIMIT 1`
    ).get(tenantId);
  } catch (e) {
    return done({ ok: false, code: 'CONFIG_UNREADABLE',
      message: 'Could not read the ZRA settings on this computer. Please contact support.' });
  }

  if (!cfg || !cfg.zra_vsdc_url) {
    return done({ ok: false, code: 'NOT_CONFIGURED',
      message: 'No ZRA VSDC address is set on this computer. Open Settings > ZRA Configuration and enter the VSDC URL.' });
  }

  const base = String(cfg.zra_vsdc_url).replace(/\/+$/, '');
  const viaProxy = /\/vsdc-proxy(\/|$)/.test(base);

  let res, text;
  try {
    const headers = { 'Content-Type': 'application/json' };
    // This does its OWN fetch rather than going through post(), so the
    // proxy secret has to be attached separately. Missing it meant the
    // proxy answered 401, the check read that as "VSDC offline", and the
    // T11A guard blocked every sale on a till whose VSDC was fine.
    if (viaProxy && cfg.zra_proxy_secret) {
      headers['X-VSDC-Proxy-Secret'] = cfg.zra_proxy_secret;
    }
    res = await fetch(base + '/code/selectCodes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tpin: cfg.zra_tpin,
        bhfId: cfg.zra_bhf_id,
        lastReqDt: nowReqDt(),   // narrow window â€” expect 001, that's fine
      }),
      signal: AbortSignal.timeout(3000),
    });
    text = await res.text();
  } catch (e) {
    // Nothing answered at all: DNS failure, connection refused, timeout.
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return done({ ok: false, code: timedOut ? 'TIMEOUT' : 'UNREACHABLE',
      message: viaProxy
        ? (timedOut
            ? 'The ZRA server did not respond in time. Check this computer\'s internet connection, then try again.'
            : 'Cannot reach the ZRA server at ' + base + '. Check this computer\'s internet connection and that the VSDC URL in Settings > ZRA Configuration is correct.')
        : (timedOut
            ? 'The local VSDC service did not respond in time. Check that it is running, then try again.'
            : 'Cannot reach the local VSDC service at ' + base + '. Check that it is running and that the VSDC URL in Settings > ZRA Configuration is correct.') });
  }

  // The proxy refuses anything whose secret does not match the branch it
  // is addressed to. Pointing a till at the bare domain (HQ) instead of
  // its own branch subdomain lands here.
  if (res.status === 401 || res.status === 403) {
    return done({ ok: false, code: 'PROXY_REJECTED',
      message: 'The ZRA server rejected this computer\'s credentials. The settings on this desktop do not match the server. Check the VSDC URL and Proxy Secret in Settings > ZRA Configuration.' });
  }

  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }

  // A real VSDC reply always carries resultCd. Tomcat's 404 page, an
  // nginx error page or an empty body will not survive this.
  if (!parsed || !parsed.resultCd) {
    return done({ ok: false, code: 'NOT_VSDC',
      message: 'The address in Settings > ZRA Configuration answered, but it is not the VSDC service (HTTP ' + res.status + '). Check the VSDC URL.' });
  }

  // 000 = OK, 001 = no data in the requested window. Anything else means
  // VSDC is alive and is REJECTING us â€” almost always a wrong TPIN or
  // branch ID on this desktop.
  const rc = String(parsed.resultCd);
  if (rc !== '000' && rc !== '001') {
    return done({ ok: false, code: 'REJECTED',
      message: 'ZRA rejected this computer\'s details (' + rc + ': ' + (parsed.resultMsg || 'no message') + '). Check the TPIN and Branch ID in Settings > ZRA Configuration match the ones registered with ZRA.' });
  }

  return done({ ok: true, code: 'OK', message: '' });
}

// 2026-08-28 â€” classify a fiscalisation failure so the cashier is told
// whether waiting will fix it.
//
// With block-offline OFF the sale goes through and the receipt says
// "PENDING FISCALISATION - the retry queue will re-send automatically".
// That is true for a network blip. It is WRONG for a wrong TPIN or URL:
// retrying cannot help, it will fail forever, and nobody is told to go
// and correct the settings. The distinction is already in the error:
// ZRA answering AT ALL means the connection is fine.
function classifyFailure(e) {
  // A resultCd means the request reached ZRA and ZRA refused it. The link
  // works; the details we sent do not.
  if (e && e.resultCd) {
    return { kind: 'SETTINGS',
      hint: `ZRA rejected this sale (${e.resultCd}: ${e.resultMsg || 'no message'}). `
          + 'Check the TPIN and Branch ID in Settings > ZRA Configuration match the ones registered with ZRA.' };
  }
  const st = e && e.httpStatus;
  if (st === 401 || st === 403) {
    return { kind: 'SETTINGS',
      hint: "The ZRA server rejected this computer's credentials. The settings on this desktop do not match the server. "
          + 'Check the VSDC URL and Proxy Secret in Settings > ZRA Configuration.' };
  }
  if (st === 404) {
    return { kind: 'SETTINGS',
      hint: 'The address in Settings > ZRA Configuration answered, but it is not the VSDC service. Check the VSDC URL.' };
  }
  if (st && st >= 400) {
    return { kind: 'SETTINGS',
      hint: `The ZRA server answered HTTP ${st}. Check the VSDC URL in Settings > ZRA Configuration.` };
  }
  // Nothing answered: genuinely unreachable. Waiting IS the right advice.
  return { kind: 'OFFLINE',
    hint: 'Could not reach the ZRA service. This will be sent automatically once the connection is back.' };
}

// Boolean wrapper â€” kept so existing/simple callers keep working.
async function pingVsdc(tenantId) {
  const dx = await diagnoseVsdc(tenantId);
  return dx.ok;
}

// Item registration hook. Called from products POST / PUT after the local
// row is saved. If ZRA is off, resolves immediately with { skipped: true }.
// Errors are captured and stored on products.zra_last_error but never
// thrown â€” the local product save is authoritative and must not block on
// VSDC being reachable.
async function saveItem(tenantId, product, { isUpdate = false, actor = 'system' } = {}) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const path = isUpdate ? '/items/updateItem' : '/items/saveItem';
  const body = {
    itemCd:      product.zra_item_cd || product.code,
    itemClsCd:   product.zra_item_cls_cd || null,
    itemTyCd:    product.zra_item_ty_cd || '2',              // 2 = finished (default for FMCG)
    itemNm:      product.name,
    orgnNatCd:   product.zra_orgn_nat_cd || 'ZM',
    pkgUnitCd:   product.zra_pkg_unit_cd || 'NT',            // NT = other/unspecified
    qtyUnitCd:   product.zra_qty_unit_cd || 'U',             // U  = pieces
    dftPrc:      parseFloat(product.selling_price) || 0,
    vatCatCd:    product.zra_vat_cat_cd || null,
    exciseTxCatCd: product.zra_excise_ty_cd || null,
    useYn:       product.zra_use_yn || 'Y',
    regrNm:      actor, regrId: actor,
    modrNm:      actor, modrId: actor,
    isrcAplcbYn: 'N',
  };
  try {
    const parsed = await post(tenantId, path, body);
    db.prepare(
      `UPDATE products SET zra_registered_at=datetime('now'), zra_last_error=NULL WHERE id=?`
    ).run(product.id);
    return { ok: true, resultCd: parsed.resultCd };
  } catch (e) {
    db.prepare(
      `UPDATE products SET zra_last_error=? WHERE id=?`
    ).run((e.resultCd ? `[${e.resultCd}] ` : '') + (e.message || 'unknown'), product.id);
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// VAT rate for each ZRA VAT category. Used to compute tax breakdowns
// during saveSales. Non-standard rates (F=10% service, TL/IPL/etc.) are
// left null â€” those categories aren't in use by a distributor today.
const VAT_RATES = {
  A: 16,     // Standard
  B: 16,     // Minimum Taxable Value (still 16% on RRP)
  C1: 0,     // Exports
  C2: 0,     // LPO
  C3: 0,     // Zero-rated by nature
  D: 0,      // Exempt
  RVAT: 16,  // Reverse VAT (imported services)
  E: 0,      // Disbursement
  F: 10,     // Service Charge
  TOT: 0,    // Turnover tax (line VAT = 0, treated separately)
};

// yyyyMMdd for a Date (VSDC's salesDt format).
const yyyymmdd = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  // UTC â€” see the note on nowReqDt above.
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};

// yyyyMMddHHmmss for a Date (VSDC's cfmDt format).
const yyyymmddhhmmss = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  // UTC â€” see the note on nowReqDt above.
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
       + `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

// Map Kelete payment method â†’ VSDC pmtTyCd (spec table 6.6).
// Fallback to 01 (Cash) so a sale always posts even with an unmapped
// method â€” VSDC will accept the numeric code and the audit trail on our
// side keeps the human-readable label separately.
function pmtTyCd(paymentMethod) {
  const p = String(paymentMethod || '').toLowerCase();
  if (p.includes('credit'))       return '02'; // Credit
  if (p.includes('cash'))         return '01'; // Cash
  if (p.includes('bank') || p.includes('card'))  return '05'; // Bank Card
  if (p.includes('momo') || p.includes('mobile')) return '04'; // Mobile Money
  if (p.includes('chq') || p.includes('cheque')) return '03'; // Cheque
  return '01';
}

// Sales invoice hook. Called from orders.js after the row is committed
// locally. Responsibility split:
//   - vsdcClient owns the VSDC-facing payload shape + response persistence
//   - orders.js decides WHEN to call (post-commit, post-payment)
// Skips cleanly when ZRA is off; captures failures on orders.zra_status
// and orders.zra_error_message without throwing. Local sale wins.
//
// Params:
//   tenantId  â€” active tenant
//   order     â€” orders row (must include id, total_amount, discount, payment_method, cash_received/momo_received/bank_received)
//   items     â€” order_items rows joined to products (must include product_name, quantity, unit_price, discount, zra_* columns from products)
//   opts.rcptTyCd    â€” 'S' sale (default) / 'R' credit / 'D' debit
//   opts.salesTyCd   â€” 'N' normal (default) / 'C' copy (for reprint) / 'T' training
//   opts.cisInvcNo   â€” override; if omitted we allocate the next number
//   opts.orgInvoice  â€” { orgInvcNo, orgSdcId } for credit/debit notes
//   opts.rfdRsnCd    â€” reason for credit note (01â€“07)
//   opts.dbtRsnCd    â€” reason for debit note (01â€“04)
//   opts.skipOrderPersist â€” v1.13.38: caller owns persistence (used for
//                            debit notes which live in debit_notes, not
//                            orders). Skips the pre-emptive cisInvcNo
//                            stamp + fiscal-field writes to orders.
// How many times a credit/debit note may step past a taken number
// before giving up. The high-water allocation should make one enough;
// this only covers a genuine race between two machines.
const NOTE_RENUMBER_TRIES = 5;

// 2026-08-28 â€” allocating from business_settings.zra_last_invc_no ALONE is
// not safe once more than one machine can issue an invoice. That column
// does not sync (it lives in business_settings, which describes a machine
// and was deliberately taken out of sync), so an Electron till and the
// VPS each keep their own count and drift apart. Sales are safe â€” only
// the till rings them â€” but a credit note issued from the web takes its
// number from the web's counter, which stopped moving when selling moved
// to the till, and every number it hands out is one ZRA already has.
//
// Orders DO sync, so the highest number we have actually used is visible
// in every database. Take the counter and that high-water mark, whichever
// is greater, and step past it. Self-correcting from any machine.
function invcHighWaterMark() {
  let high = 0;
  const probes = [
    'SELECT MAX(zra_cis_invc_no)    AS n FROM orders',
    'SELECT MAX(zra_cn_cis_invc_no) AS n FROM orders',
    'SELECT MAX(zra_cis_invc_no)    AS n FROM debit_notes',
  ];
  for (const q of probes) {
    // Each probe is guarded on its own: a table or column missing on an
    // older DB must not cost us the marks the other probes DID find.
    try {
      const n = Number(db.prepare(q).get()?.n || 0);
      if (n > high) high = n;
    } catch (_) { /* table/column not present on this DB */ }
  }
  return high;
}

function allocInvcNo(tenantId) {
  const tx = db.transaction(() => {
    const cur  = db.prepare('SELECT zra_last_invc_no FROM business_settings WHERE tenant_id = ? LIMIT 1').get(tenantId);
    const next = Math.max(Number(cur?.zra_last_invc_no || 0), invcHighWaterMark()) + 1;
    db.prepare('UPDATE business_settings SET zra_last_invc_no = ? WHERE tenant_id = ?').run(next, tenantId);
    return next;
  });
  return tx();
}

// opts.saleDate â€” v1.13.175. A sale pushed to ZRA days after it happened
// must carry the day it HAPPENED, not the day it was pushed. Set only by the
// "Push to ZRA" backfill; every ordinary sale leaves it unset and still
// stamps the moment of sale, so the live path is byte-for-byte unchanged.
//
// ZRA accepts up to 180 days back - their own 910 message says so, quoted at
// the top of this file. Sending today's date instead would tell them a 1
// September sale happened on the day of the push, which is precisely the
// mismatch an audit looks for.
async function saveSales(tenantId, order, items, opts = {}) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };

  // Allocate a cisInvcNo. Rules:
  //  - opts.cisInvcNo wins (caller override).
  //  - Sales (rcptTyCd 'S'/'T') may reuse order.zra_cis_invc_no so retries
  //    of a failed original submission carry the same number (that's what
  //    the 924-recovery path below counts on).
  //  - Credit/Debit notes ('R'/'D') MUST get a fresh cisInvcNo â€” reusing
  //    the original sale's number makes ZRA reject with 924 "CIS Invoice
  //    number already exists" (fixed here after silently losing every
  //    credit note through 2026-08-08).
  const isNoteType = opts.rcptTyCd === 'R' || opts.rcptTyCd === 'D';
  let cisInvcNo = opts.cisInvcNo ?? (isNoteType ? null : order.zra_cis_invc_no);
  if (!cisInvcNo) cisInvcNo = allocInvcNo(tenantId);

  const rcptTyCd  = opts.rcptTyCd  || 'S';
  const salesTyCd = opts.salesTyCd || 'N';
  const now = new Date();
  // v1.13.139 â€” split registrant ID and display name so ZRA's portal
  // 'User' column shows the cashier's real name (regrNm) instead of
  // just their numeric ID. Falls back to actor when no name provided
  // (keeps stock/non-user callsites working).
  const actor   = opts.actor   || 'system';
  const actorNm = opts.actorNm || actor;

  // Build item lines. For each product we compute tax-exclusive amounts
  // using its own vat_cat_cd + VAT_RATES. Missing vat_cat_cd defaults to
  // A (standard 16%) â€” the safest fallback for FMCG.
  //
  // v1.13.75 â€” MTV support (cat B):
  //   ZRA-declared items (mostly ZB beer/spirits) carry a Recommended
  //   Retail Price on products.zra_rrp (VAT-inclusive per unit). When
  //   the cashier sells at or above RRP, VAT is 16% of the actual net
  //   price â€” no boost. When they sell BELOW RRP, VAT is computed on
  //   the RRP Ã— qty instead, so the manufacturer's declared minimum
  //   tax always gets collected. Non-cat-B items ignore rrp entirely.
  //
  // v1.13.129 â€” Invoice immutability: when the order_item row carries a
  // fiscal snapshot (zra_vat_cat_snap / zra_rrp_snap / zra_vat_rate /
  // zra_vat_taxbl_amt / zra_vat_amt), we send THOSE numbers to VSDC
  // instead of recomputing from the current products row. This makes
  // the receipt, the VAT report and the ZRA transmission a single
  // frozen record: even if the operator later edits the product's RRP
  // or VAT category, an on-line retry (zraRetryQueue) sends what the
  // customer was actually charged â€” never a drift-corrected figure.
  // Non-snapshot lines (synthetic debit-note charges, legacy pre-
  // migration orders) fall back to the live recompute path unchanged.
  // LPO override â€” T08A #6. When the order carries an LPO number the
  // whole invoice is zero-rated LPO (Cat C2). Overrides every line's
  // vat_cat_cd, forces rate=0, and disables MTV/RRP boosting. The LPO
  // number itself rides on the header lpoNumber field further down.
  const isLpo = !!(order.lpo_number && String(order.lpo_number).trim());
  const perCatTotals = {};   // { A: { taxbl: 12345.67, tax: 1975.31 }, ... }
  const itemList = items.map((it, idx) => {
    const qty     = parseFloat(it.quantity)   || 0;
    const prcInc  = parseFloat(it.unit_price) || 0;  // tax-inclusive line price
    const dcRt    = 0;
    const dcAmt   = (parseFloat(it.discount) || 0) * qty;
    const grossInc = qty * prcInc;
    const netInc   = grossInc - dcAmt;
    // v1.13.129 â€” Prefer frozen snapshot from order_items. Snapshot
    // columns are populated by POST /orders at sale time; fall back to
    // the product master + recompute for lines that predate the
    // snapshot migration or that arrive from synthetic paths (DN adj).
    const cat = isLpo ? 'C2' : String(it.zra_vat_cat_snap || it.zra_vat_cat_cd || 'A').toUpperCase();
    // LPO forces rate=0 regardless of the product's snapshot rate. Reading
    // it.zra_vat_rate here (which stores the product's usual 16% for Cat A)
    // would produce vatTaxblAmt=netInc/1.16 + vatAmtâ‰ 0 under a C2 label â€”
    // which ZRA rejects with 910 "Wrong Amount computation at taxAmtC2".
    const rate = isLpo ? 0 : (
      it.zra_vat_rate != null && it.zra_vat_rate !== ''
        ? Number(it.zra_vat_rate)
        : (VAT_RATES[cat] ?? 16)
    );
    // MTV base (used only when we need to recompute â€” snapshot already
    // baked this in). Line-level Math.max â€” a partial-line discount that
    // pulls the line below RRP Ã— qty still triggers the boost.
    const rrpUnit = parseFloat(it.zra_rrp_snap != null && it.zra_rrp_snap !== ''
      ? it.zra_rrp_snap
      : it.zra_rrp) || 0;
    const rrpInc  = cat === 'B' && rrpUnit > 0 ? rrpUnit * qty : 0;
    const baseInc = cat === 'B' ? Math.max(netInc, rrpInc) : netInc;
    // LPO â€” ignore the frozen snapshot when the whole invoice was
    // reclassified to C2 at sale time. The snapshot was taken assuming
    // the product's usual Cat A/B math, so keeping it would send Cat A
    // taxbl/vat numbers under vatCatCd='C2' â†’ ZRA 910 "Wrong amount".
    const hasSnap = !isLpo
                 && it.zra_vat_taxbl_amt != null && it.zra_vat_taxbl_amt !== ''
                 && it.zra_vat_amt      != null && it.zra_vat_amt      !== '';
    const taxblAmt = hasSnap
      ? Number(it.zra_vat_taxbl_amt)
      : (rate > 0 ? baseInc / (1 + rate / 100) : baseInc);
    const vatAmt = hasSnap
      ? Number(it.zra_vat_amt)
      : (baseInc - taxblAmt);
    perCatTotals[cat] = perCatTotals[cat] || { taxbl: 0, tax: 0 };
    perCatTotals[cat].taxbl += taxblAmt;
    perCatTotals[cat].tax   += vatAmt;
    // v1.13.131 â€” Cat B MTV consistency fix. ZRA's per-line validator
    // requires vatTaxblAmt === splyAmt / (1 + rate/100). Prior to this
    // we sent splyAmt=grossInc (sale Ã— qty) but vatTaxblAmt=baseInc/1.16
    // (RRP-based) â€” the two never reconciled on Cat B undersells and
    // ZRA replied 910 "Wrong Amount computation". Same story for the
    // per-line totAmt vs the header totAmt.
    //
    // Fix: for every line, use `baseInc` as the fiscal supply figure
    // (splyAmt + totAmt). baseInc collapses to netInc for non-Cat-B
    // items and for Cat B items sold at/above RRP, so no behaviour
    // change there. It only diverges for Cat B undersells â€” exactly
    // where the MTV boost is meant to kick in.
    //
    // Also emit `rrp` per line for Cat B items with an RRP > 0. Spec
    // Â§5.8 sample MTV request carries this field; without it ZRA logs
    // the same 910 with a missing `rrp` complaint.
    const line = {
      itemSeq:     idx + 1,
      itemCd:      it.zra_item_cd || it.product_code || String(it.product_id),
      itemClsCd:   it.zra_item_cls_cd || null,
      itemNm:      it.product_name,
      bcd:         null,
      pkgUnitCd:   it.zra_pkg_unit_cd || 'NT',
      pkg:         1,
      qtyUnitCd:   it.zra_qty_unit_cd || 'U',
      qty:         Number(qty.toFixed(2)),
      prc:         Number(prcInc.toFixed(4)),
      splyAmt:     Number(baseInc.toFixed(4)),
      dcRt:        dcRt,
      dcAmt:       Number(dcAmt.toFixed(4)),
      isrccCd:     null,
      isrccNm:     null,
      isrcRt:      null,
      isrcAmt:     null,
      vatCatCd:    cat,
      iplCatCd:    null,
      tlCatCd:     null,
      exciseTxCatCd: it.zra_excise_ty_cd || null,
      vatTaxblAmt: Number(taxblAmt.toFixed(4)),
      exciseTaxblAmt: 0,
      iplTaxblAmt:    0,
      tlTaxblAmt:     0,
      taxblAmt:    Number(taxblAmt.toFixed(4)),
      vatAmt:      Number(vatAmt.toFixed(4)),
      iplAmt:      0,
      tlAmt:       0,
      exciseTxAmt: 0,
      // v1.13.132 â€” MTV mechanic per ZRA spec Â§5.9 sample. Line totAmt is
      // the SALE-based amount the customer actually paid (netInc), NOT the
      // RRP-boosted supply figure. splyAmt stays boosted so the fiscal VAT
      // base is correct; totAmt reflects the receipt total. ZRA's per-line
      // validator checks totAmt = qty Ã— prc âˆ’ dcAmt, so mis-sending baseInc
      // here triggers 910 "Wrong Amount computation at totAmt" on Cat B
      // undersells. Non-Cat-B and at/above-RRP lines are unaffected because
      // baseInc collapses to netInc there.
      totAmt:      Number(netInc.toFixed(4)),
    };
    if (cat === 'B' && rrpUnit > 0) {
      line.rrp = Number(rrpUnit.toFixed(4));
    }
    return line;
  });

  // Header per-category rollups. Spec (p.47â€“55) needs every category the
  // header field set covers, even the ones with zero. We only emit the
  // ones we actually use in the mapping table and let VSDC treat the rest
  // as absent â€” the spec allows partial category presence.
  const num = (n) => Number((n || 0).toFixed(4));
  const cat = (k) => perCatTotals[k] || { taxbl: 0, tax: 0 };
  const totTaxblAmt = Object.values(perCatTotals).reduce((s, c) => s + c.taxbl, 0);
  const totTaxAmt   = Object.values(perCatTotals).reduce((s, c) => s + c.tax,   0);
  // v1.13.132 â€” Header totAmt is the SALE-based total the customer paid,
  // NOT taxbl + tax (which for Cat B MTV is the RRP-boosted figure). The
  // spec Â§5.9 MTV sample proves this: taxblAmtB + taxAmtB = 250 but header
  // totAmt = 200. Header totAmt is the sum of each line's totAmt (sale).
  const totAmt      = itemList.reduce((s, l) => s + (parseFloat(l.totAmt) || 0), 0);

  const body = {
    invcNo:      cisInvcNo,
    orgInvcNo:   opts.orgInvoice?.orgInvcNo ?? 0,
    orgSdcId:    opts.orgInvoice?.orgSdcId  ?? null,
    cisInvcNo,
    custTpin:    order.customer_tpin || null,
    custNm:      order.customer_name || null,
    salesTyCd,           // N / C / T
    rcptTyCd,            // S / R / D
    pmtTyCd:     pmtTyCd(order.payment_method),
    salesSttsCd: '02',   // 02 = waiting/registered
    cfmDt:       yyyymmddhhmmss(now),
    salesDt:     yyyymmdd(now),
    stockRlsDt:  yyyymmddhhmmss(now),
    cnclReqDt:   null,
    cnclDt:      null,
    rfdDt:       rcptTyCd === 'R' ? yyyymmddhhmmss(now) : null,
    rfdRsnCd:    rcptTyCd === 'R' ? (opts.rfdRsnCd || '07') : null,
    dbtRsnCd:    rcptTyCd === 'D' ? (opts.dbtRsnCd || '04') : null,
    totItemCnt:  itemList.length,

    taxblAmtA: num(cat('A').taxbl),  taxRtA: 16, taxAmtA: num(cat('A').tax),
    taxblAmtB: num(cat('B').taxbl),  taxRtB: 16, taxAmtB: num(cat('B').tax),
    taxblAmtC1: num(cat('C1').taxbl), taxRtC1: 0, taxAmtC1: 0,
    taxblAmtC2: num(cat('C2').taxbl), taxRtC2: 0, taxAmtC2: 0,
    taxblAmtC3: num(cat('C3').taxbl), taxRtC3: 0, taxAmtC3: 0,
    taxblAmtD:  num(cat('D').taxbl),  taxRtD:  0, taxAmtD:  0,
    taxblAmtRvat: num(cat('RVAT').taxbl), taxRtRvat: 16, taxAmtRvat: num(cat('RVAT').tax),
    taxblAmtE:  num(cat('E').taxbl),  taxRtE:  0, taxAmtE:  0,
    taxblAmtF:  num(cat('F').taxbl),  taxRtF:  10, taxAmtF:  num(cat('F').tax),
    taxblAmtIpl1: 0, taxRtIpl1: 0, taxAmtIpl1: 0,
    taxblAmtIpl2: 0, taxRtIpl2: 0, taxAmtIpl2: 0,
    taxblAmtTl:  0, taxRtTl:  0, taxAmtTl:  0,
    taxblAmtEcm: 0, taxRtEcm: 0, taxAmtEcm: 0,
    taxblAmtExeeg: 0, taxRtExeeg: 0, taxAmtExeeg: 0,
    taxblAmtTot: num(cat('TOT').taxbl), taxRtTot: 0, taxAmtTot: 0,

    totTaxblAmt: num(totTaxblAmt),
    totTaxAmt:   num(totTaxAmt),
    totAmt:      num(totAmt),
    prchrAcptcYn: 'N',
    remark:      null,
    regrId:      actor, regrNm: actorNm,
    modrId:      actor, modrNm: actorNm,
    saleCtyCd:   '1',
    currencyTyCd: order.zra_currency_ty_cd || 'ZMW',
    exchangeRt:   parseFloat(order.zra_exchange_rt || 1) || 1,
    destnCountryCd: null,
    dbtRsnCd:    rcptTyCd === 'D' ? (opts.dbtRsnCd || '04') : null,
    invcAdjustReason: null,
    // LPO â€” T08A #6. Header field carries the buyer's LPO certificate
    // number; ZRA cross-checks it against TaxOnline before signing.
    // Combined with cat='C2' on every line (forced above via isLpo).
    lpoNumber:   isLpo ? String(order.lpo_number).trim() : null,
    // v1.13.71 â€” Cart-level discount (order.discount) sent as cashDcAmt.
    // Per-line item discounts already flow through item.dcAmt above.
    // orders.discount is the "extra" cart discount cashier added on top
    // of any per-line percentages, so it maps naturally onto cashDcAmt.
    // dcRt kept at 0 (same pattern as per-line dcRt=0 at l.269) â€” VSDC
    // treats the amount as authoritative when the rate is zero.
    cashDcRt:    0,
    cashDcAmt:   Number((Math.abs(parseFloat(order.discount) || 0)).toFixed(4)),
    itemList,
  };

  // Persist cisInvcNo up front so a retry uses the same number (VSDC
  // rejects duplicates with 924, but re-sending the SAME cisInvcNo on
  // retry is required by the spec).
  if (!opts.skipOrderPersist) {
    db.prepare(
      `UPDATE orders SET zra_cis_invc_no=?, zra_last_attempt_at=datetime('now'),
                         zra_retry_count = COALESCE(zra_retry_count,0)+1,
                         synced=0, updated_at=datetime('now')
         WHERE id=?`
    ).run(cisInvcNo, order.id);
  }

  try {
    // 2026-08-28 â€” a credit/debit note is not bound to any particular
    // number: any unused one will do. So when ZRA says 924 "already
    // exists" for a note, step the counter past whatever is in the way
    // and send again, rather than failing the note outright. This is what
    // makes reversals safe from ANY machine â€” the web's counter can be
    // far behind the till's and it corrects itself on the first attempt.
    //
    // Sales deliberately do NOT do this: a sale must keep the number it
    // was first stamped with, or a retry would issue the same sale twice
    // under two numbers. For a sale, 924 means "an earlier attempt at
    // THIS sale got through", and the recovery path below is correct.
    let parsed;
    for (let attempt = 0; ; attempt++) {
      try {
        parsed = await post(tenantId, '/trnsSales/saveSales', body, { cisInvcNo });
        break;
      } catch (e) {
        const canRenumber = e.resultCd === '924'
          && isNoteType
          && opts.cisInvcNo == null      // caller pinned the number â€” respect it
          && attempt < NOTE_RENUMBER_TRIES;
        if (!canRenumber) throw e;
        cisInvcNo      = allocInvcNo(tenantId);
        body.invcNo    = cisInvcNo;      // both carry the number on the wire
        body.cisInvcNo = cisInvcNo;
      }
    }
    const data = parsed.data || {};
    if (!opts.skipOrderPersist) {
      db.prepare(
        `UPDATE orders SET
           zra_rcpt_no=?, zra_intrl_data=?, zra_rcpt_sign=?,
           zra_sdc_id=?, zra_mrc_no=?, zra_vsdc_rcpt_pbct_date=?,
           zra_qr_code_url=?, zra_status='SIGNED',
           zra_error_code=NULL, zra_error_message=NULL,
           -- 2026-08-27 â€” synced=0 so the fiscal fields REACH THE VPS.
           -- The order row is pushed at creation and flagged synced=1;
           -- fiscalisation lands afterwards, and without re-flagging the
           -- row sync never sends it again. An Electron till therefore
           -- held the receipt number and signature locally while the VPS
           -- (and the web Sales Report) showed a blank ZRA RECEIPT
           -- forever â€” the fiscal record never left the till.
           --
           -- updated_at must move too. sync.js REJECTS an incoming row
           -- whose updated_at <= the server's copy (a guard added after a
           -- stale push destroyed a reversal). Flagging synced=0 alone
           -- meant the row was pushed and then silently discarded as
           -- stale, because fiscalisation had not changed its timestamp.
           synced=0, updated_at=datetime('now')
         WHERE id=?`
      ).run(
        data.rcptNo ?? null,
        data.intrlData ?? null,
        data.rcptSign ?? null,
        data.sdcId ?? cfg.zra_sdc_id ?? null,
        data.mrcNo ?? cfg.zra_mrc_no ?? null,
        data.vsdcRcptPbctDate ?? null,
        data.qrCodeUrl ?? null,
        order.id,
      );
    }
    // Bump last_sale_invc_no so business_settings mirrors VSDC.
    if (data.rcptNo) {
      db.prepare('UPDATE business_settings SET zra_last_sale_invc_no=? WHERE tenant_id=?')
        .run(data.rcptNo, tenantId);
    }
    return { ok: true, cisInvcNo, rcptNo: data.rcptNo, qrCodeUrl: data.qrCodeUrl,
             sdcId: data.sdcId, intrlData: data.intrlData, rcptSign: data.rcptSign,
             mrcNo: data.mrcNo ?? cfg.zra_mrc_no ?? null,
             vsdcRcptPbctDate: data.vsdcRcptPbctDate,
             itemList /* exposed so the caller can chain saveSaleStockChain
                         without re-computing the VSDC-shape item rows */ };
  } catch (e) {
    // Duplicate-recovery: VSDC returns '924' when the cisInvcNo is
    // already on file. That happens whenever a previous attempt reached
    // ZRA but our fetch() lost the response (timeout, network flap,
    // container restart mid-reply). Instead of leaving the order FAILED
    // and losing the receipt data, call /trnsSales/selectInvoice to
    // fetch the already-signed record and hydrate the order with it.
    // See project_kelete_zra.md â€” this closes the classic silent-duplicate
    // gap that would otherwise inflate VAT filings on every retry.
    if (e.resultCd === '924' && !opts.skipOrderPersist) {
      try {
        const recover = await selectInvoice(tenantId, cisInvcNo);
        if (recover.ok && recover.exists) {
          const rd = recover.data || {};
          // 2026-08-28 â€” SAFETY GUARD. Recovery assumes 924 means "an
          // earlier attempt at THIS order got through". If two machines
          // ever hand out the same number, that assumption breaks and the
          // invoice coming back belongs to a DIFFERENT sale â€” stamping it
          // here would put another customer's receipt number, signature
          // and QR code on this order. So check the totals agree before
          // trusting it. Tolerance is one ngwee for rounding.
          const claimed  = Number(rd.totAmt ?? rd.totAmtIncl ?? NaN);
          const expected = Number(order.total_amount ?? NaN);
          const mismatch = Number.isFinite(claimed) && Number.isFinite(expected)
            && Math.abs(claimed - expected) > 0.01;
          if (mismatch) {
            db.prepare(
              `UPDATE orders SET zra_status='FAILED',
                     zra_error_code='924_MISMATCH',
                     zra_error_message=?,
                     synced=0, updated_at=datetime('now')
                 WHERE id=?`
            ).run(
              `Invoice ${cisInvcNo} already exists at ZRA but its total (${claimed}) `
              + `does not match this sale (${expected}). Not attaching it. `
              + `Another machine may have used this number.`,
              order.id,
            );
            return { ok: false, cisInvcNo, error: 'duplicate number belongs to a different sale',
                     resultCd: '924' };
          }
          db.prepare(
            `UPDATE orders SET
               zra_rcpt_no=?, zra_intrl_data=?, zra_rcpt_sign=?,
               zra_sdc_id=?, zra_mrc_no=?, zra_vsdc_rcpt_pbct_date=?,
               zra_qr_code_url=?, zra_status='SIGNED',
               zra_error_code=NULL, zra_error_message=NULL,
               synced=0, updated_at=datetime('now')
             WHERE id=?`
          ).run(
            rd.rcptNo ?? null,
            rd.intrlData ?? null,
            rd.rcptSign ?? null,
            rd.sdcId ?? cfg.zra_sdc_id ?? null,
            rd.mrcNo ?? cfg.zra_mrc_no ?? null,
            rd.vsdcRcptPbctDate ?? null,
            rd.qrCodeUrl ?? null,
            order.id,
          );
          return { ok: true, cisInvcNo, recovered: true,
                   rcptNo: rd.rcptNo, qrCodeUrl: rd.qrCodeUrl,
                   sdcId: rd.sdcId, intrlData: rd.intrlData, rcptSign: rd.rcptSign,
                   mrcNo: rd.mrcNo ?? cfg.zra_mrc_no ?? null,
                   vsdcRcptPbctDate: rd.vsdcRcptPbctDate, itemList };
        }
      } catch (_) { /* fall through to FAILED */ }
    }
    const cls = classifyFailure(e);
    if (!opts.skipOrderPersist) {
      // 2026-08-27 â€” a CONNECTION failure must not consume a retry.
      //
      // zra_retry_count is incremented before the call (so cisInvcNo is
      // persisted even if we crash mid-flight), and zraRetryQueue gives
      // up on an order after MAX_RETRIES. That is right for a genuine
      // rejection â€” a permanently bad order should not spin forever â€”
      // but wrong when VSDC was simply unreachable: nothing was
      // evaluated, so nothing should be held against the order.
      //
      // This matters for the offline-Electron design: a till selling
      // while disconnected would burn all 20 attempts locally against an
      // unreachable VSDC, and zra_retry_count SYNCS â€” so by the time the
      // order reached the VPS the queue would skip it as exhausted and
      // the invoice would sit unfiscalised with nothing retrying it.
      //
      // A ZRA rejection always carries a resultCd; a fetch()-level throw
      // (ECONNREFUSED, timeout, non-JSON error page) does not. Roll the
      // counter back in that case only.
      if (!e.resultCd) {
        db.prepare(
          `UPDATE orders SET zra_retry_count = MAX(COALESCE(zra_retry_count,1) - 1, 0), synced=0, updated_at=datetime('now') WHERE id=?`
        ).run(order.id);
      }
      const cls = classifyFailure(e);
      db.prepare(
        `UPDATE orders SET zra_status='FAILED', zra_error_code=?, zra_error_kind=?,
                zra_error_message=?, synced=0, updated_at=datetime('now') WHERE id=?`
      ).run(
        e.resultCd || null,
        cls.kind,
        // Operator-facing hint first, raw detail kept after it for support.
        `${cls.hint} [${e.message || 'unknown'}]`.slice(0, 500),
        order.id,
      );
    }
    return { ok: false, cisInvcNo, error: e.message, resultCd: e.resultCd,
             errorKind: cls.kind, hint: cls.hint };
  }
}

// â”€â”€â”€ Stock Save / Stock Master â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Per VSDC spec + Developer Self-Checklist item 27â€“29, every sale, GRN
// and import approval must be followed by /stock/saveStockItems (record
// the movement) and /stockMaster/saveStockMaster (snapshot remaining
// qty per item). Ledger stays consistent with ZRA's view.

// sarTyCd values per VSDC API spec v1.0.8 section 6.14. Direction is
// encoded in the code â€” 04/13 for stock-movement in/out, 06/16 for
// adjustment in/out, 15 for disposal (Discarding). Earlier revisions
// used a single ADJUSTMENT ('14') and DISPOSAL ('16'), which mapped to
// Processing-Outgoing and Adjustment-Outgoing on the ZRA portal â€” the
// wrong categories entirely. Fixed at T10A UAT prep.
const SAR_TY_CD = {
  IMPORT_INCOMING:    '01',
  PURCHASE:           '02',
  RETURN:             '03',
  STOCK_MOVEMENT_IN:  '04',
  ADJUSTMENT_IN:      '06',
  SALE:               '11',
  SALE_CANCELLATION:  '12',
  STOCK_MOVEMENT_OUT: '13',
  DISPOSAL:           '15',
  ADJUSTMENT_OUT:     '16',
};

// POST /stock/saveStockItems â€” record ONE movement (sale, purchase, etc).
// `items` is the same shape used in saveSales itemList[]. sarTyCd picks
// the movement type. Returns the raw parsed response.
async function saveStockItems(tenantId, order, items, sarTyCd) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  const now = new Date();
  const body = {
    sarNo:      order.id,                       // unique per movement
    orgSarNo:   0,
    regTyCd:    'A',                            // A = automatic
    custTpin:   order.customer_tpin || null,
    custNm:     order.customer_name || null,
    custBhfId:  cfg.zra_bhf_id,
    sarTyCd,
    ocrnDt:     yyyymmdd(now),
    totItemCnt: items.length,
    // 2026-08-26 â€” round the header roll-ups to 4dp. VSDC validates these
    // as <18 digits>.<4 digits> and rejects anything longer with 910
    // "Request parameter error". Summing many float lines drifts past 4dp
    // (17 opening-balance lines produced totTaxAmt 512601.3792000001 and
    // were rejected outright). saveSales and savePurchase already round
    // their equivalents via num(); this was the one path that did not, so
    // it only ever surfaced on multi-line stock movements â€” a single-line
    // transfer never accumulated enough error to show.
    totTaxblAmt: round4(items.reduce((s, it) => s + (parseFloat(it.taxblAmt || it.vatTaxblAmt) || 0), 0)),
    totTaxAmt:   round4(items.reduce((s, it) => s + (parseFloat(it.vatAmt) || 0), 0)),
    totAmt:      round4(items.reduce((s, it) => s + (parseFloat(it.totAmt) || 0), 0)),
    remark:     null,
    regrId: 'system', regrNm: 'system', modrId: 'system', modrNm: 'system',
    itemList: items.map((it, idx) => ({
      itemSeq:     idx + 1,
      itemCd:      it.itemCd,
      itemClsCd:   it.itemClsCd,
      itemNm:      it.itemNm,
      bcd:         null,
      pkgUnitCd:   it.pkgUnitCd,
      pkg:         it.pkg || 1,
      qtyUnitCd:   it.qtyUnitCd,
      qty:         it.qty,
      itemExprDt:  null,
      prc:         it.prc,
      splyAmt:     it.splyAmt,
      totDcAmt:    it.dcAmt,
      taxblAmt:    it.taxblAmt,
      vatCatCd:    it.vatCatCd,
      iplCatCd:    null,
      tlCatCd:     null,
      exciseTxCatCd: it.exciseTxCatCd || null,
      vatAmt:      it.vatAmt,
      iplAmt:      0, tlAmt: 0, exciseTxAmt: 0,
      taxAmt:      it.vatAmt || 0,
      totAmt:      it.totAmt,
    })),
  };
  try {
    const parsed = await post(tenantId, '/stock/saveStockItems', body);
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// POST /stockMaster/saveStockMaster â€” snapshot each item's current qty.
// Called after saveStockItems. In practice we send the moved items only;
// VSDC updates its remaining-qty view for those. Full-catalog snapshots
// live behind a Sync button in a later commit.
async function saveStockMaster(tenantId, stockItems) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  // 2026-08-26 â€” de-duplicate by itemCd.
  //
  // rsdQty is an ABSOLUTE residual ("this item now stands at N"), so the
  // same itemCd twice in one payload is meaningless by definition â€” and
  // VSDC rejects it with a bare 999 "unknown error" that names nothing.
  //
  // It happens legitimately: a supplier invoice can list the same
  // product on two lines, or two lines can be mapped to one of our
  // products. Every caller builds its snapshot list per LINE, so the
  // duplicate only surfaces here. Fixed centrally rather than in each
  // caller. Last write wins â€” callers snapshot the same post-transaction
  // current_stock for every line of a given product, so the entries are
  // identical anyway.
  const byCode = new Map();
  for (const s of (stockItems || [])) {
    if (!s || !s.itemCd) continue;
    byCode.set(String(s.itemCd), Number((parseFloat(s.rsdQty) || 0).toFixed(2)));
  }
  const body = {
    stockItemList: Array.from(byCode, ([itemCd, rsdQty]) => ({ itemCd, rsdQty })),
    regrId: 'system', regrNm: 'system', modrId: 'system', modrNm: 'system',
  };
  if (body.stockItemList.length === 0) {
    return { skipped: true, reason: 'no resolvable item codes to snapshot' };
  }
  try {
    const parsed = await post(tenantId, '/stockMaster/saveStockMaster', body);
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// Convenience: after a sale, call saveStockItems + saveStockMaster in
// sequence. Wraps the two calls so orders.js has a one-liner. The stock
// items posted are the sold ones with sarTyCd=SALE (or SALE_CANCELLATION
// for credit notes). `productSnapshots` = [{ itemCd, rsdQty }] with the
// AFTER-sale on-hand quantity read from products.current_stock.
async function saveSaleStockChain(tenantId, order, items, productSnapshots, { isCredit = false } = {}) {
  const sarTy = isCredit ? SAR_TY_CD.SALE_CANCELLATION : SAR_TY_CD.SALE;
  const stockRes  = await saveStockItems(tenantId, order, items, sarTy);
  const masterRes = productSnapshots.length ? await saveStockMaster(tenantId, productSnapshots) : { skipped: true, reason: 'no snapshots' };
  return { stock: stockRes, master: masterRes };
}

// v1.13.78 â€” Convenience for non-sale stock movements (adjustments,
// disposals/damages, inter-branch transfers). Callers pass raw movement
// lines (product_sync_id + qty); this helper looks up the product's ZRA
// classification + cost basis and builds the vsdc itemList shape that
// /stock/saveStockItems expects, then follows with saveStockMaster on
// the post-movement current_stock snapshot so ZRA's residual-qty view
// matches ours.
//
//   tenantId       â€” ZRA config lookup key (business_settings.tenant_id).
//                    IMPORTANT: this helper does DB reads via the ALS-scoped
//                    proxy. When called from an HQ route that opens a
//                    specific branch DB, wrap the call in
//                    db.runWithDb(branchDb, () => saveNonSaleStockChain(...))
//                    so the product lookups + snapshots hit the branch.
//   sarNo          â€” unique per-movement id (adjustment/transfer/damage id).
//   headerMeta     â€” { customer_tpin, customer_name, remark } (optional).
//   movementLines  â€” [{ product_sync_id, quantity, unit }].
//                    quantity is signed â€” negative for outbound, positive for
//                    inbound. Absolute value is sent to VSDC; sign only
//                    picks the direction that the caller already applied
//                    to products.current_stock.
//   sarTyCd        â€” one of SAR_TY_CD.ADJUSTMENT_IN / ADJUSTMENT_OUT /
//                    DISPOSAL / STOCK_MOVEMENT_IN / STOCK_MOVEMENT_OUT.
async function saveNonSaleStockChain(tenantId, sarNo, headerMeta, movementLines, sarTyCd) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const lines = Array.isArray(movementLines) ? movementLines.filter(l => l && l.product_sync_id) : [];
  if (lines.length === 0) return { skipped: true, reason: 'no lines' };

  // Look each line's product up on the CURRENT ALS db. Callers passing
  // via db.runWithDb hit the branch DB; direct callers hit the request's
  // tenant DB.
  const items = [];
  const snapshots = [];
  for (const l of lines) {
    const p = db.prepare(
      `SELECT id, sync_id, code, name, current_stock,
              cost_price, avg_cost_price, selling_price,
              zra_item_cd, zra_item_cls_cd, zra_pkg_unit_cd,
              zra_qty_unit_cd, zra_vat_cat_cd, zra_excise_ty_cd, zra_rrp
         FROM products WHERE sync_id = ? LIMIT 1`
    ).get(l.product_sync_id);
    if (!p) continue;
    const qty  = Math.abs(parseFloat(l.quantity) || 0);
    if (qty <= 0) continue;
    // Cost basis: prefer WAC (avg_cost_price), fall back to cost_price,
    // fall back to selling_price so VSDC never sees a zero-value line
    // (which would blow the totTaxblAmt roll-up).
    const cost = parseFloat(p.avg_cost_price || p.cost_price || p.selling_price || 0) || 0;
    const cat  = (p.zra_vat_cat_cd || 'A').toUpperCase();
    const rate = VAT_RATES[cat] ?? 16;
    const totInc  = qty * cost;
    const taxbl   = rate > 0 ? totInc / (1 + rate / 100) : totInc;
    const vat     = totInc - taxbl;
    items.push({
      itemCd:      p.zra_item_cd || p.code || String(p.id),
      itemClsCd:   p.zra_item_cls_cd || null,
      itemNm:      p.name,
      pkgUnitCd:   p.zra_pkg_unit_cd || 'NT',
      pkg:         1,
      qtyUnitCd:   p.zra_qty_unit_cd || 'U',
      qty:         Number(qty.toFixed(2)),
      prc:         Number(cost.toFixed(4)),
      splyAmt:     Number(totInc.toFixed(4)),
      dcAmt:       0,
      taxblAmt:    Number(taxbl.toFixed(4)),
      vatCatCd:    cat,
      exciseTxCatCd: p.zra_excise_ty_cd || null,
      vatAmt:      Number(vat.toFixed(4)),
      totAmt:      Number(totInc.toFixed(4)),
    });
    snapshots.push({
      itemCd: p.zra_item_cd || p.code || String(p.id),
      rsdQty: parseFloat(p.current_stock || 0) || 0,
    });
  }
  if (items.length === 0) return { skipped: true, reason: 'no resolvable products' };

  const orderShim = {
    id:            sarNo,
    customer_tpin: headerMeta?.customer_tpin || null,
    customer_name: headerMeta?.customer_name || null,
  };
  const stockRes  = await saveStockItems(tenantId, orderShim, items, sarTyCd);
  const masterRes = snapshots.length ? await saveStockMaster(tenantId, snapshots) : { skipped: true, reason: 'no snapshots' };
  return { ok: stockRes.ok !== false, stock: stockRes, master: masterRes };
}

// â”€â”€â”€ Purchase pull from VSDC-registered suppliers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// v1.13.80 â€” /trnsPurchase/selectTrnsPurchaseSales. Fetches the list of
// invoices where OUR TPIN is the buyer and the supplier is itself a
// VSDC user (Zambian Breweries et al). Kelete then decides per row
// whether to APPROVE (register locally via savePurchase regTyCd='A')
// or REJECT (internal audit only â€” ZRA already recorded the supplier's
// side).
//
// Response shape (per VSDC spec): parsed.data.saleList[] with header
// fields (spplrTpin, spplrNm, spplrBhfId, spplrInvcNo, salesDt,
// stockRlsDt, totItemCnt, totTaxblAmt, totTaxAmt, totAmt, rcptTyCd,
// pmtTyCd, spplrSdcId) plus itemList[] carrying the line detail.
// 001 = "no result" (no invoices since lastReqDt) â€” treat as success.
async function selectTrnsPurchaseSales(tenantId, lastReqDt) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  try {
    const parsed = await post(tenantId, '/trnsPurchase/selectTrnsPurchaseSales', {
      lastReqDt: lastReqDt || EPOCH_REQ_DT,
    });
    return { ok: true, saleList: parsed.data?.saleList || [], parsed };
  } catch (e) {
    if (e.resultCd === '001') return { ok: true, saleList: [], note: 'no new purchases' };
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// â”€â”€â”€ Purchase (GRN confirmed) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// POST /trnsPurchase/savePurchase.
// Two paths per spec:
//   1. Supplier IS a VSDC user â€” regTyCd='A' (auto) and we approve an
//      already-fetched purchase (via selectTrnsPurchaseSales). Fields
//      then come from what VSDC handed us.
//   2. Supplier is NOT on Smart Invoice â€” regTyCd='M' (manual) and we
//      construct the purchase ourselves from GRN data.
// Step 6 wires path #2 only â€” the far more common case for Kelete's
// current suppliers. Path #1 lands with the daily purchase pull cron.
async function savePurchase(tenantId, grn, items, opts = {}) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  // Backfill overrides the clock. `now` feeds cfmDt, salesDt, stockRlsDt and
  // rfdDt and nothing else in this function, so this is the whole change.
  const now = (opts.saleDate instanceof Date && !isNaN(opts.saleDate.getTime()))
    ? opts.saleDate
    : new Date();

  // Allocate purchase invoice number.
  let pchsInvcNo = opts.pchsInvcNo ?? grn.zra_pchs_invc_no;
  if (!pchsInvcNo) {
    const tx = db.transaction(() => {
      const cur = db.prepare('SELECT zra_last_pchs_invc_no FROM business_settings WHERE tenant_id = ? LIMIT 1').get(tenantId);
      const next = (cur?.zra_last_pchs_invc_no || 0) + 1;
      db.prepare('UPDATE business_settings SET zra_last_pchs_invc_no = ? WHERE tenant_id = ?').run(next, tenantId);
      return next;
    });
    pchsInvcNo = tx();
  }

  // Same per-VAT-category rollup as saveSales, but "purchase side".
  const perCatTotals = {};
  const itemList = items.map((it, idx) => {
    const qty     = parseFloat(it.quantity) || 0;
    const prcInc  = parseFloat(it.cost_price) || 0;
    const grossInc = qty * prcInc;
    const cat     = (it.zra_vat_cat_cd || 'A').toUpperCase();
    const rate    = VAT_RATES[cat] ?? 16;
    const taxblAmt = rate > 0 ? grossInc / (1 + rate / 100) : grossInc;
    const vatAmt   = grossInc - taxblAmt;
    perCatTotals[cat] = perCatTotals[cat] || { taxbl: 0, tax: 0 };
    perCatTotals[cat].taxbl += taxblAmt;
    perCatTotals[cat].tax   += vatAmt;
    return {
      itemSeq:     idx + 1,
      itemCd:      it.zra_item_cd || it.product_code || String(it.product_id),
      itemClsCd:   it.zra_item_cls_cd || null,
      itemNm:      it.product_name,
      bcd:         null,
      spplrItemClsCd: null,
      spplrItemCd:    null,
      spplrItemNm:    null,
      pkgUnitCd:   it.zra_pkg_unit_cd || 'NT',
      pkg:         1,
      qtyUnitCd:   it.zra_qty_unit_cd || 'U',
      qty:         Number(qty.toFixed(2)),
      prc:         Number(prcInc.toFixed(4)),
      splyAmt:     Number(grossInc.toFixed(4)),
      dcRt:        0, dcAmt: 0,
      taxblAmt:    Number(taxblAmt.toFixed(4)),
      vatCatCd:    cat,
      iplCatCd:    null,
      tlCatCd:     null,
      exciseTxCatCd: it.zra_excise_ty_cd || null,
      vatAmt:      Number(vatAmt.toFixed(4)),
      iplAmt:      0, tlAmt: 0, exciseTxAmt: 0,
      taxAmt:      Number(vatAmt.toFixed(4)),
      totAmt:      Number(grossInc.toFixed(4)),
      itemExprDt:  null,
    };
  });
  const num = (n) => Number((n || 0).toFixed(4));
  const cat = (k) => perCatTotals[k] || { taxbl: 0, tax: 0 };
  const totTaxbl = Object.values(perCatTotals).reduce((s, c) => s + c.taxbl, 0);
  const totTax   = Object.values(perCatTotals).reduce((s, c) => s + c.tax,   0);

  const body = {
    invcNo:      pchsInvcNo,
    orgInvcNo:   0,
    spplrTpin:   grn.zra_spplr_tpin || (grn.supplier_tpin || null),
    spplrBhfId:  grn.zra_spplr_bhf_id || null,
    spplrNm:     grn.supplier_name || null,
    spplrInvcNo: grn.supplier_invoice_no || null,
    regTyCd:     grn.zra_reg_ty_cd || 'M',
    pchsTyCd:    'N',                              // N = Normal
    rcptTyCd:    'P',                              // P = Purchase
    pmtTyCd:     '01',                             // 01 = Cash (default)
    pchsSttsCd:  '02',                             // 02 = registered
    cfmDt:       yyyymmddhhmmss(now),
    pchsDt:      yyyymmdd(now),
    wrhsDt:      null, cnclReqDt: null, cnclDt: null, rfdDt: null,
    totItemCnt:  itemList.length,

    taxblAmtA: num(cat('A').taxbl),  taxRtA: 16, taxAmtA: num(cat('A').tax),
    taxblAmtB: num(cat('B').taxbl),  taxRtB: 16, taxAmtB: num(cat('B').tax),
    taxblAmtC1: num(cat('C1').taxbl), taxRtC1: 0, taxAmtC1: 0,
    taxblAmtC2: num(cat('C2').taxbl), taxRtC2: 0, taxAmtC2: 0,
    taxblAmtC3: num(cat('C3').taxbl), taxRtC3: 0, taxAmtC3: 0,
    taxblAmtD:  num(cat('D').taxbl),  taxRtD:  0, taxAmtD:  0,
    taxblAmtRvat: num(cat('RVAT').taxbl), taxRtRvat: 16, taxAmtRvat: num(cat('RVAT').tax),
    taxblAmtE:  num(cat('E').taxbl),  taxRtE:  0, taxAmtE: 0,
    taxblAmtF:  num(cat('F').taxbl),  taxRtF: 10, taxAmtF: num(cat('F').tax),
    taxblAmtIpl1: 0, taxRtIpl1: 0, taxAmtIpl1: 0,
    taxblAmtIpl2: 0, taxRtIpl2: 0, taxAmtIpl2: 0,
    taxblAmtTl:  0, taxRtTl:  0, taxAmtTl:  0,
    taxblAmtEcm: 0, taxRtEcm: 0, taxAmtEcm: 0,
    taxblAmtExeeg: 0, taxRtExeeg: 0, taxAmtExeeg: 0,
    taxblAmtTot: num(cat('TOT').taxbl), taxRtTot: 0, taxAmtTot: 0,

    totTaxblAmt: num(totTaxbl),
    totTaxAmt:   num(totTax),
    totAmt:      num(totTaxbl + totTax),
    remark:      null,
    regrId: opts.actor || 'system', regrNm: opts.actor || 'system',
    modrId: opts.actor || 'system', modrNm: opts.actor || 'system',
    itemList,
  };

  db.prepare(
    `UPDATE grn SET zra_pchs_invc_no=?, zra_status='PENDING' WHERE id=?`
  ).run(pchsInvcNo, grn.id);

  try {
    const parsed = await post(tenantId, '/trnsPurchase/savePurchase', body);
    db.prepare(
      `UPDATE grn SET zra_status='SIGNED', zra_error_code=NULL, zra_error_message=NULL WHERE id=?`
    ).run(grn.id);
    return { ok: true, pchsInvcNo, parsed };
  } catch (e) {
    db.prepare(
      `UPDATE grn SET zra_status='FAILED', zra_error_code=?, zra_error_message=? WHERE id=?`
    ).run(e.resultCd || null, e.message?.slice(0, 500) || 'unknown', grn.id);
    return { ok: false, pchsInvcNo, error: e.message, resultCd: e.resultCd };
  }
}

// â”€â”€â”€ Invoice recovery lookup (duplicate prevention) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// POST /trnsSales/selectInvoice. Given a sale invoice number that WE
// allocated (invcNo, from business_settings.zra_last_sale_invc_no), ask
// VSDC whether that invoice landed on their side.
//
// Purpose: the classic VSDC race â€” saveSales times out mid-response, we
// don't know if ZRA saved it or not, we retry, and now there are two
// receipts on ZRA's side for one physical sale. Wrapping saveSales with
// a selectInvoice pre-check lets us skip retries when the previous call
// silently succeeded.
//
// Return shape:
//   { ok: true, exists: true,  data: {...VSDC response.data...} }
//   { ok: true, exists: false }               // invoice not found on ZRA
//   { ok: false, error, resultCd }            // network / other failure
//
// VSDC returns resultCd '001' for "no result" on select-style endpoints,
// which is the "not found" case here. Anything else non-'000' is a real
// error and surfaces to the caller.
// 2026-08-28 â€” this used to send { invcNo } only, and ZRA rejected every
// call with 910:
//   "Validation error for fields: ['invcSdcId': must not be empty,
//     'cisInvcNo': must not be null]"
// so 924-recovery could never succeed and a stuck order retried forever.
// The two field names come from that rejection message itself, which
// names exactly what it wants. invcSdcId is this branch's SDC ID â€” the
// device that signed the invoice we are asking about.
//
// NOTE: the request shape here is derived from ZRA's own error text, not
// from the spec (whose response tables have been wrong before). If this
// still returns 910, capture the real request/response from the audit log
// before changing it again.
async function selectInvoice(tenantId, cisInvcNo) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  try {
    const parsed = await post(tenantId, '/trnsSales/selectInvoice', {
      cisInvcNo: Number(cisInvcNo),
      invcSdcId: cfg.zra_sdc_id,
      invcNo:    Number(cisInvcNo),   // kept: harmless, and some builds read it
    });
    return { ok: true, exists: true, data: parsed.data || {}, parsed };
  } catch (e) {
    if (e.resultCd === '001') return { ok: true, exists: false };
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// â”€â”€â”€ Customer TPIN lookup (checkout validation) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// POST /customers/selectCustomer. Given a TPIN typed by the cashier at
// the pay modal, ask VSDC "is this a real registered taxpayer, and if
// so, what's the registered name/address?"
//
// Purpose: B2B invoices carry the buyer's TPIN + legal name. A cashier
// can't just type any 10-digit number â€” the buyer wouldn't be able to
// claim VAT input and the invoice fails audit. Live lookup catches typos
// before the sale is fiscalised.
//
// Return shape:
//   { ok: true, exists: true, customer: {...} }
//   { ok: true, exists: false }               // TPIN not registered
//   { ok: false, error, resultCd }
async function selectCustomer(tenantId, custTpin) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  const tpin = String(custTpin || '').trim();
  if (!/^\d{10}$/.test(tpin)) {
    return { ok: false, error: 'TPIN must be 10 digits', resultCd: null };
  }
  try {
    const parsed = await post(tenantId, '/customers/selectCustomer', {
      // v1.13.130 â€” spec Â§5.5 says the field is `custmTpin` (no 'r'). Sending
      // `custmrTpin` returned resultCd 910 ("Validation error â€¦ must not be
      // null") from the sandbox VSDC on 2026-08-07 and would silently break
      // every TPIN Verify click in prod. Confirmed via live sandbox call.
      custmTpin: tpin,
    });
    // v1.13.134 â€” ZRA response shape per spec Â§5.5 sample is
    // { data: { custList: [ { custTpin, custNm, adrs, telNo, ... } ] } }
    // â€” an array, not a `custInfo` object. Reading data.custInfo returned
    // undefined and left every Verify with a green tick but "(no name on
    // file)" even after the customer was successfully saved and looked up.
    const info = parsed.data?.custList?.[0] || parsed.data?.custInfo || parsed.data || {};
    // VSDC returns { custNo, custTpin, custNm, adrs, email, telNo, faxNo, useYn, remark }
    return {
      ok: true,
      exists: true,
      customer: {
        tpin:    info.custTpin || tpin,
        name:    info.custNm   || null,
        address: info.adrs     || null,
        email:   info.email    || null,
        phone:   info.telNo    || null,
        active:  (info.useYn || 'Y') === 'Y',
      },
      parsed,
    };
  } catch (e) {
    if (e.resultCd === '001') return { ok: true, exists: false };
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// â”€â”€â”€ Item registry pull-back (reconciliation) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// POST /items/selectItems. Returns the FULL list of items ZRA has on
// file for our TPIN+bhfId. Used to reconcile the local products table:
//   - Which of our items didn't land? (push retry needed)
//   - Did ZRA save any with a different tax/class code than we sent?
//     (surface as a mismatch so the operator can inspect)
//
// Response shape (per spec): parsed.data.itemList[] with itemCd, itemNm,
// itemClsCd, itemTyCd, pkgUnitCd, qtyUnitCd, taxTyCd (== vatCatCd),
// dftPrc, useYn, orgnNatCd, ...  Incremental via lastReqDt; 001 = "no
// new since bookmark" â†’ treated as ok+empty.
async function selectItems(tenantId, lastReqDt) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  try {
    const parsed = await post(tenantId, '/items/selectItems', {
      lastReqDt: lastReqDt || EPOCH_REQ_DT,
    });
    return { ok: true, itemList: parsed.data?.itemList || [], parsed };
  } catch (e) {
    if (e.resultCd === '001') return { ok: true, itemList: [], note: 'no new items' };
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// â”€â”€â”€ Single-item pull (debug helper) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// POST /items/selectItem. Same as selectItems but for one itemCd.
// Powers the "why won't this product scan?" support flow.
async function selectItem(tenantId, itemCd) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  const code = String(itemCd || '').trim();
  if (!code) return { ok: false, error: 'itemCd required' };
  try {
    const parsed = await post(tenantId, '/items/selectItem', { itemCd: code });
    const info = parsed.data?.itemInfo || parsed.data || {};
    return { ok: true, exists: true, item: info, parsed };
  } catch (e) {
    if (e.resultCd === '001') return { ok: true, exists: false };
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// â”€â”€â”€ Manufacturer RRP pull (MTV Category B accuracy) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// POST /items/selectRrpItems. Manufacturers push their Recommended
// Retail Prices via saveRrpItems; distributors/retailers pull them
// here so MTV VAT (max(net, RRP*qty) Ã— 16/116) uses the CURRENT
// official RRP, not a locally-typed guess.
//
// v1.13.150 â€” response key confirmed against a real sandbox call
// (2026-08-26 UAT-2 T04A session): it's `data.itemList[]`, NOT
// `data.rrpList[]` as the earlier comment assumed. Every prior sync
// silently returned an empty array regardless of what ZRA sent back
// â€” "Pulled: 0" on the UI wasn't "no new data", it was this parsing
// bug masking real data. Each item carries { manufacturerTpin,
// manufacturerName, itemCd, itemClsCd, itemNm, orgnNatCd, pkgUnitCd,
// qtyUnitCd, rrp }. This is a GLOBAL feed across every manufacturer
// registered on Smart Invoice, not filtered to our TPIN â€” most rows
// won't match our catalogue; routes/zra.js's UPDATE ... WHERE
// COALESCE(zra_item_cd, code) = ? correctly no-ops on the rest.
// 001 = "no new since bookmark" â†’ ok+empty. Written into
// products.zra_rrp by matching on zra_item_cd (or code fallback) â€”
// the only stable key between our catalogue and ZRA's item registry.
async function selectRrpItems(tenantId, lastReqDt) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  try {
    const parsed = await post(tenantId, '/items/selectRrpItems', {
      lastReqDt: lastReqDt || EPOCH_REQ_DT,
    });
    return { ok: true, rrpList: parsed.data?.itemList || parsed.data?.rrpList || [], parsed };
  } catch (e) {
    if (e.resultCd === '001') return { ok: true, rrpList: [], note: 'no new RRPs' };
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// â”€â”€â”€ Branch user registration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// POST /branches/saveBrancheUser. Every fiscal invoice carries a `userNm`
// (who rang up the sale). ZRA validates that name against the branch's
// registered user list â€” an invoice from an unregistered user is
// audit-flagged. Hooked into routes/users.js on POST/PUT so a new
// cashier is synced to VSDC the moment the user record is saved.
//
// Errors are captured on users.zra_last_error and NEVER thrown â€” the
// local user save is authoritative and must not block on VSDC being
// reachable.
async function saveBranchUser(tenantId, user, { isUpdate = false, actor = 'system' } = {}) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  const body = {
    userId:   String(user.id),
    userNm:   [user.first_name, user.last_name].filter(Boolean).join(' ') || user.email || `user-${user.id}`,
    adrs:     user.address || null,
    cntc:     user.phone || null,
    // authCd '01' = active user account per spec. Terminated users get
    // useYn='N' so the ZRA record still exists (audit trail) but no
    // future invoice can be signed by them.
    authCd:   '01',
    useYn:    (user.status || 'Active').toLowerCase() === 'active' ? 'Y' : 'N',
    regrNm:   actor, regrId: actor,
    modrNm:   actor, modrId: actor,
  };
  try {
    const parsed = await post(tenantId, '/branches/saveBrancheUser', body);
    db.prepare(
      `UPDATE users SET zra_registered_at=datetime('now'), zra_last_error=NULL WHERE id=?`
    ).run(user.id);
    return { ok: true, resultCd: parsed.resultCd, isUpdate };
  } catch (e) {
    db.prepare(
      `UPDATE users SET zra_last_error=? WHERE id=?`
    ).run((e.resultCd ? `[${e.resultCd}] ` : '') + (e.message || 'unknown'), user.id);
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// â”€â”€â”€ Branch customer registration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// POST /branches/saveBrancheCustomers. Pushes a customer master record
// to ZRA. Auditors reconcile "your customer list matches ours" during
// VAT return reviews â€” a customer that appears on your invoices but
// not on ZRA's side is flagged for investigation.
//
// Called from routes/customers.js on POST/PUT. Silent no-op when the
// customer has no TPIN (walk-in / cash-only customers don't need to be
// registered â€” the invoice defaults to '1000000000' at receipt time).
async function saveBranchCustomer(tenantId, customer, { actor = 'system' } = {}) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  const tpin = String(customer.tpin || '').trim();
  if (!/^\d{10}$/.test(tpin)) {
    // No TPIN â†’ nothing to register at ZRA. Not an error, just skip.
    return { skipped: true, reason: 'no TPIN â€” walk-in / cash customer' };
  }
  // ZRA requires a 10-digit mobile number as `custNo`. Skip the push if
  // the local record has no phone â€” silently retrying every save with a
  // bogus custNo just spams the audit log with 910s. The operator can
  // add a phone later and PUT /customers/:id will re-trigger this path.
  const rawPhone = String(customer.phone || '').replace(/\D/g, '');
  const custNo   = rawPhone.length === 10 ? rawPhone
                 : rawPhone.length ===  9 ? '0' + rawPhone           // 977xxxxxxx â†’ 0977xxxxxxx
                 : null;
  if (!custNo) {
    return { skipped: true, reason: 'no 10-digit phone â€” cannot register at ZRA' };
  }
  const body = {
    // v1.13.133 â€” field spelled `custTpin` per ZRA spec Â§5.5 (not
    // `custTin`). Same typo family we fixed in v1.13.130 for the
    // lookup path (custmTpin). Every prior save silently 910'd with
    // "custTin may not be empty" and the customer never made it to
    // ZRA, which is why Verify kept saying "TPIN not registered".
    custNo,                                     // 10-digit mobile
    custTpin: tpin,                             // ZRA field name is custTpin (not custTin)
    custNm:   customer.name || null,
    adrs:     customer.address || null,
    telNo:    customer.phone || null,
    email:    customer.email || null,
    faxNo:    null,
    useYn:    (customer.status || 'Active').toLowerCase() === 'active' ? 'Y' : 'N',
    remark:   customer.type || null,
    regrNm:   actor, regrId: actor,
    modrNm:   actor, modrId: actor,
  };
  try {
    const parsed = await post(tenantId, '/branches/saveBrancheCustomers', body);
    db.prepare(
      `UPDATE customers SET zra_registered_at=datetime('now'), zra_last_error=NULL WHERE id=?`
    ).run(customer.id);
    return { ok: true, resultCd: parsed.resultCd };
  } catch (e) {
    db.prepare(
      `UPDATE customers SET zra_last_error=? WHERE id=?`
    ).run((e.resultCd ? `[${e.resultCd}] ` : '') + (e.message || 'unknown'), customer.id);
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// â”€â”€â”€ Stock pull (reconciliation) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// POST /stock/selectStockItems. Pulls ZRA's view of our current stock
// per item. Used to reconcile against products.current_stock so a silent
// stockMaster push failure doesn't leave ZRA with a stale ledger â€” which
// would look like unrecorded sales at audit time.
//
// Response shape (per spec): parsed.data.stockList[] with itemCd, rsdQty
// (remaining qty), regTyCd, and header snapshot fields.
// 2026-08-26 â€” was defaulting to EPOCH_REQ_DT ('20000101000000'), which
// predates ZRA's Smart Invoice program by over a decade. VSDC-API-Spec
// v1.0.8 p.168 documents THIS endpoint's own natural default as
// '20160523000000' â€” sending our generic year-2000 epoch instead was
// returning resultCd 001 "no result" even though the sandbox portal
// clearly shows real stock data for the same TPIN/branch. Using the
// spec's own stated default here instead.
const STOCK_ITEMS_DEFAULT_REQ_DT = '20160523000000';
async function selectStockItems(tenantId, lastReqDt) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  try {
    const parsed = await post(tenantId, '/stock/selectStockItems', {
      lastReqDt: lastReqDt || STOCK_ITEMS_DEFAULT_REQ_DT,
    });
    // Spec's documented response table for this endpoint (p.168-169)
    // appears to be a copy-paste of the Import Item response, not the
    // real shape â€” keep reading data.stockList (matches our other
    // select* helpers' convention) but log the raw `parsed` so the
    // audit-log viewer shows the true shape once real data comes back.
    return { ok: true, stockList: parsed.data?.stockList || [], parsed };
  } catch (e) {
    if (e.resultCd === '001') return { ok: true, stockList: [], note: 'no stock data', resultCd: e.resultCd };
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// â”€â”€â”€ Import declarations pull (Â§5.8 T05A) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// POST /imports/selectImportItems â€” spec marks this MANDATORY. Red Sea,
// as a purely local-supplier distributor, will always get back an
// empty list (no ASYCUDA declarations exist for this TPIN) â€” but the
// retrieval call itself must be wired regardless of business scope.
async function selectImportItems(tenantId, lastReqDt) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  try {
    const parsed = await post(tenantId, '/imports/selectImportItems', {
      lastReqDt: lastReqDt || EPOCH_REQ_DT,
    });
    // Spec's own JSON Response Sample (p.41) shows the key as
    // data.itemList[] â€” each row carries { taskCd, dclDe, itemSeq,
    // dclNo, hsCd, itemNm, imptItemsttsCd, orgnNatCd, exptNatCd, pkg,
    // pkgUnitCd, qty, qtyUnitCd, totWt, netWt, spplrNm, agntNm,
    // invcFcurAmt, invcFcurCd, invcFcurExcrt, dclRefNum }.
    // imptItemsttsCd on a freshly-declared row reads "2" (pending) in
    // the sample â€” 3/4 (approve/reject) come from our own
    // updateImportItems call below, per that endpoint's JSON sample.
    return { ok: true, importList: parsed.data?.itemList || [], parsed };
  } catch (e) {
    if (e.resultCd === '001') return { ok: true, importList: [], note: 'no import data' };
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// POST /imports/updateImportItems â€” approve or reject each declared
// import line. MANDATORY per spec. Approved lines (imptItemSttsCd='3')
// must subsequently flow into stock via saveStockItems + saveStockMaster
// (SAR_TY_CD.IMPORT_INCOMING='01') â€” that chain is the caller's job
// (routes/zra.js /imports/decide), mirroring the same dependency
// pattern as savePurchase â†’ stock chain elsewhere in this file.
//
// items: [{ itemSeq, hsCd, itemClsCd, itemCd, imptItemSttsCd, remark }]
// imptItemSttsCd: '3' = approved/acknowledged (goes to stock),
//                 '4' = rejected/disregarded (does not go to stock).
// These two values come directly from the spec's own JSON request
// sample (p.44) â€” the full code 6.17 "Import Item status" table isn't
// reproduced in the spec text, so if ZRA ever seeds real import data
// these should be cross-checked against /code/selectCodes cd_cls for
// that class.
async function updateImportItems(tenantId, { taskCd, dclDe, items, actor = 'system' } = {}) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  const importItemList = (items || []).map(it => ({
    itemSeq:       it.itemSeq,
    hsCd:          it.hsCd || null,
    itemClsCd:     it.itemClsCd || null,
    itemCd:        it.itemCd,
    imptItemSttsCd: String(it.imptItemSttsCd),
    remark:        it.remark || null,
    modrNm:        actor,
    modrId:        actor,
  }));
  try {
    const parsed = await post(tenantId, '/imports/updateImportItems', {
      taskCd, dclDe, importItemList,
    });
    return { ok: true, parsed };
  } catch (e) {
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

// â”€â”€â”€ Branch list pull â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// POST /branches/selectBranches. Returns the list of branch offices ZRA
// has registered against our TPIN. Each branch has a bhfId that must be
// stamped on every fiscal invoice from that location â€” this endpoint is
// how we discover the id when opening a new depot.
//
// Response: parsed.data.bhfList[] with { tpin, bhfId, bhfNm, bhfSttsCd,
// prvncNm, dstrtNm, sctrNm, locDesc, mgrNm, mgrTelNo, mgrEmail }.
async function selectBranches(tenantId) {
  if (!isEnabled(tenantId)) return { skipped: true, reason: 'zra disabled' };
  const cfg = getConfig(tenantId);
  if (!cfg.zra_sdc_id) return { skipped: true, reason: 'device not initialized' };
  try {
    const parsed = await post(tenantId, '/branches/selectBranches', {
      lastReqDt: EPOCH_REQ_DT,
    });
    return { ok: true, branchList: parsed.data?.bhfList || parsed.data?.branchList || [], parsed };
  } catch (e) {
    if (e.resultCd === '001') return { ok: true, branchList: [], note: 'no branches' };
    return { ok: false, error: e.message, resultCd: e.resultCd };
  }
}

module.exports = {
  post,
  isEnabled,
  isBlockOfflineOn,
  pingVsdc,
  diagnoseVsdc,
  saveItem,
  saveSales,
  saveStockItems,
  saveStockMaster,
  saveSaleStockChain,
  saveNonSaleStockChain,
  savePurchase,
  selectTrnsPurchaseSales,
  selectInvoice,
  selectCustomer,
  selectItems,
  selectItem,
  selectRrpItems,
  saveBranchUser,
  saveBranchCustomer,
  selectStockItems,
  STOCK_ITEMS_DEFAULT_REQ_DT,
  selectImportItems,
  updateImportItems,
  selectBranches,
  SAR_TY_CD,
  itemCodeFor,
  getConfig,
  lastReqDtFor,
  bumpSyncState,
  logAudit,
  nowReqDt,
  EPOCH_REQ_DT,
};
