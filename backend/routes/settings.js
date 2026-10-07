const router = require('express').Router();
const db = require('../config/database');
const { auth, readOnlyGuard } = require('../middleware/auth');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

router.get('/', auth, readOnlyGuard, (req, res) => {
  try {
    const user = db.prepare(
      'SELECT id, first_name, last_name, email, phone, address, role FROM users WHERE id = ? AND tenant_id = ?'
    ).get(req.user.id, req.user.tenantId);
    const business = db.prepare('SELECT * FROM business_settings WHERE tenant_id = ? LIMIT 1').get(req.user.tenantId) || {};
    res.json({ user, business });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// v1.13.4 â€” public read of the branch's business_name so the Login page
// can display it before the user has a JWT. Only exposes business_name,
// nothing sensitive. Tenant middleware has already routed us to the
// correct DB by hostname.
router.get('/business/public', (req, res) => {
  try {
    const row = db.prepare('SELECT business_name FROM business_settings WHERE deleted_at IS NULL LIMIT 1').get();
    res.json({ business_name: row?.business_name || '' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/profile', auth, (req, res) => {
  try {
    const { firstName, lastName, email, phone, address } = req.body;
    db.prepare(
      "UPDATE users SET first_name=?, last_name=?, email=?, phone=?, address=?, updated_at=datetime('now'), synced=0 WHERE id=?"
    ).run(firstName, lastName, email, phone, address, req.user.id);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Normalise an incoming currencies array. Accepts [{ code, symbol, is_primary }] or null.
// Guarantees: at least one entry, exactly one primary, dedupes by code.
function normaliseCurrencies(input) {
  let arr = Array.isArray(input) ? input : null;
  if (!arr || arr.length === 0) {
    // 2026-09-13 â€” Red Sea is Kwacha only. The old USD/$ default is what gave
    // new branches (Bankers, Buwach) "$" on every receipt and report.
    arr = [{ code: 'ZMW', symbol: 'K', is_primary: true }];
  }
  const seen = new Set();
  const cleaned = [];
  for (const c of arr) {
    const code = (c.code || '').toString().trim().toUpperCase();
    const symbol = (c.symbol || '').toString().trim();
    if (!code || !symbol) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    cleaned.push({ code, symbol, is_primary: !!c.is_primary });
  }
  if (cleaned.length === 0) cleaned.push({ code: 'USD', symbol: '$', is_primary: true });
  // Force exactly one primary.
  let primaryIdx = cleaned.findIndex(c => c.is_primary);
  if (primaryIdx === -1) primaryIdx = 0;
  cleaned.forEach((c, i) => { c.is_primary = i === primaryIdx; });
  return cleaned;
}

router.put('/business', auth, (req, res) => {
  try {
    const { business_name, business_phone, business_email, business_address, tax_rate, single_location_mode, block_oversell, currencies,
            receipt_printer_type, receipt_printer_name, receipt_printer_ip, receipt_printer_port,
            default_crate_deposit, currency_mode, workflow_mode,
            legacy_procurement_enabled,
            // v1.9.26 â€” payment_methods is the third dial alongside
            // currency_mode + workflow_mode. 'cash_only' (Kelete-style:
            // Cash only at the till) | 'cash_momo_bank' (Liquor-style:
            // Cash + MoMo + Bank). Independent of currency / workflow.
            payment_methods,
            // 2026-09-11 â€” which methods this branch's screens show.
            shown_payment_methods,
            // 2026-09-11 â€” Cash Report save â†’ PENDING deposits to HQ.
            auto_deposit_enabled,
            // 2026-09-15 â€” System Settings â†’ Deposit to ('' = HQ).
            deposit_to_slug,
            // 2026-09-18 â€” System Settings â†’ Maximum expenses per day.
            daily_expense_limit } = req.body;
    // Only update currencies if the caller explicitly sent them; otherwise leave whatever's stored.
    const currenciesJson = currencies !== undefined ? JSON.stringify(normaliseCurrencies(currencies)) : null;
    const existing = db.prepare('SELECT * FROM business_settings LIMIT 1').get();
    let row;
    if (existing) {
      // Fully partial update â€” only fields the caller actually sent get included in SET.
      // Two pages share this endpoint (Profile saves company identity; System Settings
      // saves currencies/printer/etc). Without partial semantics, each page would clobber
      // the other's columns by sending undefined.
      const sets = [];
      const vals = [];
      if (business_name    !== undefined) { sets.push('business_name=?');         vals.push(business_name); }
      if (business_phone   !== undefined) { sets.push('business_phone=?');        vals.push(business_phone); }
      if (business_email   !== undefined) { sets.push('business_email=?');        vals.push(business_email); }
      if (business_address !== undefined) { sets.push('business_address=?');      vals.push(business_address); }
      if (tax_rate         !== undefined) { sets.push('tax_rate=?');              vals.push(tax_rate); }
      if (single_location_mode !== undefined) {
        const slm = (single_location_mode === true || single_location_mode === 1 || single_location_mode === '1') ? 1 : 0;
        sets.push('single_location_mode=?'); vals.push(slm);
      }
      if (block_oversell !== undefined) {
        const bo = (block_oversell === true || block_oversell === 1 || block_oversell === '1') ? 1 : 0;
        sets.push('block_oversell=?'); vals.push(bo);
      }
      if (currenciesJson !== null) { sets.push('currencies_json=?'); vals.push(currenciesJson); }
      if (receipt_printer_type !== undefined) {
        sets.push('receipt_printer_type=?');
        vals.push(String(receipt_printer_type).toLowerCase() === 'lan' ? 'lan' : 'usb');
      }
      if (receipt_printer_name !== undefined) { sets.push('receipt_printer_name=?'); vals.push(receipt_printer_name || null); }
      if (receipt_printer_ip   !== undefined) { sets.push('receipt_printer_ip=?');   vals.push(receipt_printer_ip   || null); }
      if (receipt_printer_port !== undefined) { sets.push('receipt_printer_port=?'); vals.push(parseInt(receipt_printer_port) || 9100); }
      if (default_crate_deposit !== undefined) { sets.push('default_crate_deposit=?'); vals.push(parseFloat(default_crate_deposit) || 0); }
      // currency_mode is a per-branch feature gate. 'K' = Kwacha only (lusaka1,
      // mansa1); 'USD+FRA' = dual currency, unlocks FX rate inputs, dual-
      // currency payment modal, USD+FRA receipt lines (kassumbalesa1).
      // Anything else is normalised to 'K' to avoid bad string slipping through.
      // v1.7.0: now accepts a third value 'USD+FRA+K' (triple-currency
      // cash acceptance â€” items still priced in USD).
      if (currency_mode !== undefined) {
        const raw = String(currency_mode || 'K').toUpperCase();
        const cm = ['USD+FRA+K', 'USD+FRA'].includes(raw) ? raw : 'K';
        sets.push('currency_mode=?'); vals.push(cm);
      }
      // workflow_mode is a per-branch UI gate.
      //   'single_pos'    = one cashier does everything (default)
      //   'two_station'   = Sales â†’ Cashier (stock deducts on payment, no Dispatch) â€” v1.6.3
      //   'three_station' = Sales â†’ Cashier â†’ Dispatch with the full state machine
      //   'pos_dispatch'  = one operator writes+pays at POS, dispatcher hands
      //                     over goods separately. Order posts as PAID, stock
      //                     deducts on Dispatch confirm. (v1.13.25 â€” Kelete)
      // Anything else falls back to 'single_pos' so a bad value can't break the page.
      if (workflow_mode !== undefined) {
        const raw = String(workflow_mode || 'single_pos').toLowerCase();
        const wm = ['three_station', 'two_station', 'pos_dispatch'].includes(raw) ? raw : 'single_pos';
        sets.push('workflow_mode=?'); vals.push(wm);
      }
      // v1.9.26 â€” payment_methods controls which method columns appear on
      // the POS Pay modal. 'cash_only' = Kelete 3-currency cash branches
      // (no MoMo, no Bank). 'cash_momo_bank' = Liquor-style branches that
      // accept all three. Anything else falls back to cash_momo_bank.
      if (payment_methods !== undefined) {
        const raw = String(payment_methods || 'cash_momo_bank').toLowerCase();
        const pm = ['cash_only', 'cash_momo_bank'].includes(raw) ? raw : 'cash_momo_bank';
        sets.push('payment_methods=?'); vals.push(pm);
      }
      // 2026-09-11 â€” which payment methods the screens show. Cash is always
      // on; Mobile Money and Bank can be hidden. Hiding only: no record,
      // total or ledger changes.
      if (shown_payment_methods !== undefined) {
        const keys = String(shown_payment_methods || '').toLowerCase().split(',').map(s => s.trim());
        const shown = ['cash', 'momo', 'bank'].filter(k => k === 'cash' || keys.includes(k));
        sets.push('shown_payment_methods=?'); vals.push(shown.join(','));
      }
      if (auto_deposit_enabled !== undefined) {
        const ad = (auto_deposit_enabled === true || auto_deposit_enabled === 1 || auto_deposit_enabled === '1') ? 1 : 0;
        sets.push('auto_deposit_enabled=?'); vals.push(ad);
      }
      // 2026-09-15 â€” where this depot's deposits go. Administrators only; must
      // be HQ ('') or another registered depot.
      if (deposit_to_slug !== undefined && req.user?.role === 'Administrator') {
        const want = String(deposit_to_slug || '').toLowerCase().trim();
        const own = String(req.headers['x-tenant'] || req.hostname || '').toLowerCase().split('.')[0];
        let ok = !want;
        try { ok = ok || (want !== own && require('../config/masterDb').isRegistered(want)); } catch (_) { ok = false; }
        if (!ok) return res.status(400).json({ error: 'Deposit to must be HQ or another depot.' });
        sets.push('deposit_to_slug=?'); vals.push(want || null);
      }
      // 2026-09-18 â€” the most this depot may pay out in expenses in one day.
      // Administrators only; 0 (or blank) means no limit.
      if (daily_expense_limit !== undefined && req.user?.role === 'Administrator') {
        const lim = Math.max(0, parseFloat(daily_expense_limit) || 0);
        sets.push('daily_expense_limit=?'); vals.push(lim);
      }
      // legacy_procurement_enabled re-exposes the legacy GRN + Suppliers
      // sidebar entries on a branch (hidden by v1.3.2 lockdown). Useful
      // for branch launch / migration; HQ-side ignores it.
      if (legacy_procurement_enabled !== undefined) {
        const lp = (legacy_procurement_enabled === true || legacy_procurement_enabled === 1 || legacy_procurement_enabled === '1') ? 1 : 0;
        sets.push('legacy_procurement_enabled=?'); vals.push(lp);
      }
      if (sets.length === 0) return res.json(existing); // nothing to update
      sets.push("updated_at=datetime('now')", 'synced=0');
      vals.push(existing.id);
      db.prepare(`UPDATE business_settings SET ${sets.join(', ')} WHERE id=?`).run(...vals);
      row = db.prepare('SELECT * FROM business_settings WHERE id = ?').get(existing.id);
    } else {
      const slm = (single_location_mode === true || single_location_mode === 1 || single_location_mode === '1') ? 1 : 0;
      const printerType = String(receipt_printer_type || 'usb').toLowerCase() === 'lan' ? 'lan' : 'usb';
      const printerName = receipt_printer_name || null;
      const printerIp   = receipt_printer_ip   || null;
      const printerPort = parseInt(receipt_printer_port) || 9100;
      const tenantId = syncConfig.getTenantId(req);
      const { branchId, deviceId } = syncConfig.getConfig();
      const info = db.prepare(
        `INSERT INTO business_settings (business_name, business_phone, business_email, business_address, tax_rate, single_location_mode, currencies_json,
                                        receipt_printer_type, receipt_printer_name, receipt_printer_ip, receipt_printer_port,
                                        sync_id, tenant_id, branch_id, device_id, synced)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
      ).run(business_name || null, business_phone || null, business_email || null, business_address || null, tax_rate || null, slm,
            currenciesJson || JSON.stringify(normaliseCurrencies(null)),
            printerType, printerName, printerIp, printerPort,
            randomUUID(), tenantId, branchId, deviceId);
      row = db.prepare('SELECT * FROM business_settings WHERE id = ?').get(info.lastInsertRowid);
    }
    res.json(row);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// â”€â”€â”€ HQ phone-app passcode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 2026-09-18 â€” every depot has a licence key the phone app now checks against
// master.db, but HQ has none (tenant 'local-only'), so HQ used to be the one
// site the app opened with no question asked. An Administrator sets a passcode
// here and the app asks about it at POST /api/sync/verify-hq-passcode.
//
// The code itself is never returned â€” only whether one is set. Blank clears it.
// HQ's host only: the passcode belongs to HQ's own book, so a depot must not
// be able to set or clear it even with an Administrator logged in.
function hqOnly(req, res) {
  if (!require('../middleware/hqPush').isHqRequest(req)) {
    res.status(404).json({ error: 'Not found.' });
    return false;
  }
  if (req.user?.role !== 'Administrator') {
    res.status(403).json({ error: 'Administrators only.' });
    return false;
  }
  return true;
}

router.get('/app-passcode', auth, (req, res) => {
  try {
    if (!hqOnly(req, res)) return;
    res.json({ isSet: require('../services/appPasscode').isSet() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/app-passcode', auth, (req, res) => {
  try {
    if (!hqOnly(req, res)) return;
    const code = String(req.body?.code ?? '').trim();
    if (code && code.length < 4) return res.status(400).json({ error: 'The passcode must be at least 4 characters.' });
    res.json({ isSet: require('../services/appPasscode').setCode(code) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/settings/drawer-port â€” get configured cash drawer port
//
// 2026-08-30 â€” also returns `printer`, the RECEIPT printer name, because
// Electron's silent print was reading `port` and getting it wrong.
//
// These are two different settings. System Settings > Receipt Printer saves
// business_settings.receipt_printer_name ("POS-80 11.3.0.1 Dereje" on the
// Garden till); the legacy drawer port is a separate value defaulting to the
// bare string 'POS-80'. Electron asked for the drawer port and handed it to
// webContents.print as deviceName. No installed printer is called exactly
// 'POS-80' â€” the machine has 'POS-80 11.3.0.1' and 'POS-80 11.3.0.1 Dereje'
// â€” so the silent print failed and the app fell back to the print dialog.
// The cashier had to pick a printer for every receipt.
//
// `port` keeps its old meaning and value so nothing that reads it changes.
router.get('/drawer-port', (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM sync_config WHERE key = 'drawer_port'").get();
    let printer = null;
    try {
      printer = db.prepare(
        'SELECT receipt_printer_name FROM business_settings WHERE receipt_printer_name IS NOT NULL LIMIT 1'
      ).get()?.receipt_printer_name || null;
    } catch (_) { /* column absent on an old DB â€” fall through to the port */ }
    res.json({ port: row?.value || 'POS-80', printer });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/settings/drawer-port â€” save cash drawer port
router.put('/drawer-port', auth, (req, res) => {
  try {
    const { port } = req.body;
    if (!port || !port.trim()) return res.status(400).json({ error: 'Port is required.' });
    const existing = db.prepare("SELECT value FROM sync_config WHERE key = 'drawer_port'").get();
    if (existing) {
      db.prepare("UPDATE sync_config SET value = ? WHERE key = 'drawer_port'").run(port.trim());
    } else {
      db.prepare("INSERT INTO sync_config (key, value) VALUES ('drawer_port', ?)").run(port.trim());
    }
    res.json({ port: port.trim() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/open-drawer â€” fires the ESC/POS drawer kick via the configured transport.
// Now routes through escpos.js: USB â†’ Windows Print Spooler, LAN â†’ TCP socket to printer:9100.
router.post('/open-drawer', async (req, res) => {
  try {
    const { CMD, sendToPrinter } = require('../utils/escpos');
    const result = await sendToPrinter(db, CMD.DRAWER_KICK);
    if (!result.ok) return res.status(500).json({ error: 'Failed to open drawer: ' + (result.error || 'unknown') });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/print-receipt â€” build the receipt bytes and send via the configured transport.
//
// Canonical receipt design (must match the on-screen modal in POS.js so the two
// surfaces never drift):
//   - Business header: name, address (if set), phone (if set)
//   - Title "SALES RECEIPT"
//   - Receipt # / Date & Time (single row) / Customer / Served by
//   - Per item: name on its own line, then qty/price/gross-line-total. If the
//     line carries a discount, an indented sub-row "discount {qty} x -K{u}"
//     with the signed total on the right.
//   - Pre-discount Subtotal, signed Discount line, then TOTAL.
//   - Payment split shown when cash/momo/bank are provided separately.
//
// Business name/phone/address and the currency symbol are read from
// business_settings â€” the route is the source of truth, callers don't need
// to pass them.
router.post('/print-receipt', async (req, res) => {
  try {
    const { CMD, sendToPrinter } = require('../utils/escpos');
    const { orderNumber, dateTime, customerName, servedBy, items,
            total, amountReceived, cashReceived, momoReceived, bankReceived, change,
            is_reprint } = req.body;

    // â”€â”€ Authoritative business + currency info from settings â”€â”€
    const biz = db.prepare(
      'SELECT business_name, business_phone, business_address, currencies_json FROM business_settings LIMIT 1'
    ).get() || {};
    const businessName    = biz.business_name    || 'Kelete';
    const businessPhone   = biz.business_phone   || '';
    const businessAddress = biz.business_address || '';
    let cur = 'K';
    try {
      const arr = JSON.parse(biz.currencies_json || '[]');
      const primary = arr.find(c => c.is_primary) || arr[0];
      if (primary?.symbol) cur = primary.symbol;
    } catch { /* default 'K' */ }

    // v1.10.60 â€” Column width dropped from 42 â†’ 40 chars to leave a safer
    // horizontal margin on 80mm thermal printers whose mechanical printable
    // area is ~72mm (42 chars at 12-dot Font A = 71mm, which was clipping
    // the leftmost + rightmost characters on some units).
    const W = 40;
    const eq = '='.repeat(W);
    const da = '-'.repeat(W);
    const center = (str) => {
      const s = String(str).substring(0, W);
      const pad = Math.floor((W - s.length) / 2);
      return ' '.repeat(pad) + s;
    };
    const cols = (left, right) => {
      const l = String(left).substring(0, W - String(right).length - 1);
      return l + ' '.repeat(W - l.length - String(right).length) + String(right);
    };
    const fmt = (n) => parseFloat(n || 0).toFixed(2);

    const lines = [];
    lines.push(center(businessName));
    if (businessAddress) {
      // Long addresses get wrapped onto multiple centered lines.
      String(businessAddress).split(/\r?\n/).forEach(ln => {
        const t = ln.trim();
        if (!t) return;
        for (let i = 0; i < t.length; i += W) lines.push(center(t.substring(i, i + W)));
      });
    }
    if (businessPhone) lines.push(center('Tel: ' + businessPhone));
    lines.push(eq);
    // v1.13.37 â€” ZRA checklist #24: reprints are marked COPY / DUPLICATE.
    if (is_reprint) {
      lines.push(center('*** COPY / DUPLICATE ***'));
      lines.push(center('Not the original tax invoice'));
    } else {
      lines.push(center('SALES RECEIPT'));
    }
    lines.push(eq);
    lines.push(cols('Receipt #:',  orderNumber  || ''));
    lines.push(cols('Date & Time:', dateTime    || ''));
    lines.push(cols('Customer:',   customerName || 'Walk-in'));
    lines.push(cols('Served by:',  servedBy     || 'Staff'));
    lines.push(eq);

    // â”€â”€ Items: gross line totals + per-line discount sub-row â”€â”€
    // Lines sold in a non-default unit are flagged with ` **` after the
    // product name and a single explanatory legend is appended at the
    // very bottom of the receipt (only if at least one line carries the
    // flag â€” receipts with all default-unit lines stay clean).
    let grossSubtotal = 0;
    let lineDiscSum   = 0;
    let hasAltUnit    = false;
    (items || []).forEach(item => {
      const qty       = parseFloat(item.quantity)    || 0;
      const unitPrice = parseFloat(item.unit_price)  || 0;
      const lineDisc  = parseFloat(item.discount)    || 0;       // per-unit discount
      const gross     = qty * unitPrice;
      const discTotal = qty * lineDisc;
      grossSubtotal += gross;
      lineDiscSum   += discTotal;
      const isAlt = !!item.is_alt_unit;
      if (isAlt) hasAltUnit = true;

      const nameLine = String(item.product_name) + (isAlt ? ' **' : '');
      lines.push(nameLine.substring(0, W));
      const qtyStr = `  ${qty.toFixed(2)} ${item.unit || ''}`;
      const right  = `${cur}${fmt(unitPrice)}  ${cur}${fmt(gross)}`;
      lines.push(qtyStr + ' '.repeat(Math.max(1, W - qtyStr.length - right.length)) + right);
      if (lineDisc > 0) {
        // Indented sub-row showing the discount math, signed total on the right.
        const left  = `    discount ${qty.toFixed(2)} x -${cur}${fmt(lineDisc)}`;
        const r     = `-${cur}${fmt(discTotal)}`;
        lines.push(left + ' '.repeat(Math.max(1, W - left.length - r.length)) + r);
      }
    });

    lines.push(da);

    // Cart-level discount (e.g. a manager applies a flat extra discount in addition to per-line ones).
    const cartDisc  = parseFloat(req.body.discount || 0);
    const totalDisc = lineDiscSum + cartDisc;

    lines.push(cols('Subtotal:', `${cur}${fmt(grossSubtotal)}`));
    if (totalDisc > 0) lines.push(cols('Discount:', `-${cur}${fmt(totalDisc)}`));
    lines.push(eq);
    lines.push(cols('TOTAL:', `${cur}${fmt(total)}`));
    lines.push(eq);

    // â”€â”€ Payment / change â”€â”€
    const cash   = parseFloat(cashReceived || 0);
    const momo   = parseFloat(momoReceived || 0);
    const bank   = parseFloat(bankReceived || 0);
    const hasSplit = (cash + momo + bank) > 0.001;
    if (hasSplit) {
      if (cash > 0) lines.push(cols('Cash:', `${cur}${fmt(cash)}`));
      if (momo > 0) lines.push(cols('MoMo:', `${cur}${fmt(momo)}`));
      if (bank > 0) lines.push(cols('Bank:', `${cur}${fmt(bank)}`));
      lines.push(cols('Total Received:', `${cur}${fmt(amountReceived)}`));
    } else {
      lines.push(cols('Amt Received:', `${cur}${fmt(amountReceived)}`));
    }
    if (parseFloat(amountReceived || 0) >= parseFloat(total || 0)) {
      lines.push(cols('*** CHANGE ***:', `${cur}${fmt(change)}`));
    } else {
      const due = parseFloat(total || 0) - parseFloat(amountReceived || 0);
      lines.push(cols('*** BALANCE DUE ***:', `${cur}${fmt(due)}`));
    }
    lines.push(eq);
    lines.push(center('Thank you for your purchase!'));
    lines.push(center('Please come again.'));
    if (hasAltUnit) {
      // Legend for the ** flag on alt-unit lines, only when something used it.
      lines.push('');
      lines.push(center('** sold in alternate unit (not default)'));
    }

    const text = lines.join('\n') + '\n\n\n\n\n\n';
    // v1.10.60 â€” BOLD_ON wraps the whole body. Without this the printer
    // runs its head in single-strike mode, which prints thin/grey on
    // thermal paper. ESC E 1 (BOLD_ON) tells it to double-strike each
    // dot for solid black. BOLD_OFF closes it before the cut so it
    // doesn't leak into whatever ticket comes next.
    const ticket = CMD.INIT + CMD.LEFT_MARGIN_24 + CMD.BOLD_ON + CMD.DRAWER_KICK + text + CMD.BOLD_OFF + CMD.CUT;
    const result = await sendToPrinter(db, ticket);
    if (!result.ok) return res.status(500).json({ error: 'Failed to print: ' + (result.error || 'unknown') });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/print-report â€” build the report bytes and send via the configured transport.
router.post('/print-report', async (req, res) => {
  try {
    const { CMD, sendToPrinter } = require('../utils/escpos');
    const { businessName, dateLabel, totalOrders, filteredCount, totalRevenue, totalDiscount, products } = req.body;

    // v1.10.60 â€” W dropped 42 â†’ 40 for the same safer-margin reason as
    // /print-receipt. The product name col shrinks 20 â†’ 18 to keep 18+6+7+9=40.
    const W = 40;
    const eq = '='.repeat(W);
    const da = '-'.repeat(W);
    const center = (str) => {
      const s = String(str).substring(0, W);
      const pad = Math.floor((W - s.length) / 2);
      return ' '.repeat(pad) + s;
    };
    const cols = (left, right) => {
      const l = String(left).substring(0, W - String(right).length - 1);
      return l + ' '.repeat(W - l.length - String(right).length) + String(right);
    };

    const lines = [];
    lines.push(center(businessName || 'BUTCHERY PRO'));
    lines.push(eq);
    lines.push(center('SALES REPORT'));
    lines.push(center(dateLabel || ''));
    lines.push(eq);
    lines.push(cols('Total Orders:', `${totalOrders} (${filteredCount} incl. void)`));
    lines.push(cols('Total Revenue:', `K${parseFloat(totalRevenue || 0).toFixed(2)}`));
    lines.push(cols('Total Discounts:', `K${parseFloat(totalDiscount || 0).toFixed(2)}`));
    lines.push(eq);

    // Column headers
    const col1W = 18, col2W = 6, col3W = 7, col4W = 9;
    lines.push('PRODUCT'.padEnd(col1W) + 'QTY'.padStart(col2W) + 'PRICE'.padStart(col3W) + 'TOTAL'.padStart(col4W));
    lines.push(da);

    let grandTotal = 0;
    (products || []).forEach(p => {
      const name = String(p.product_name).substring(0, col1W).padEnd(col1W);
      const qty = parseFloat(p.total_qty).toFixed(2).padStart(col2W);
      const price = `K${parseFloat(p.avg_price).toFixed(2)}`.padStart(col3W);
      const total = `K${parseFloat(p.total_revenue).toFixed(2)}`.padStart(col4W);
      lines.push(name + qty + price + total);
      grandTotal += parseFloat(p.total_revenue);
    });

    lines.push(da);
    lines.push(cols('GRAND TOTAL:', `K${grandTotal.toFixed(2)}`));
    lines.push(eq);

    const now = new Date();
    lines.push(center('Printed: ' + now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })));

    const text = lines.join('\n') + '\n\n\n\n\n\n';
    // v1.10.60 â€” BOLD_ON around the body so the report prints solid black
    // instead of single-strike grey. Same fix as /print-receipt.
    const ticket = CMD.INIT + CMD.LEFT_MARGIN_24 + CMD.BOLD_ON + text + CMD.BOLD_OFF + CMD.CUT;
    const result = await sendToPrinter(db, ticket);
    if (!result.ok) return res.status(500).json({ error: 'Failed to print report: ' + (result.error || 'unknown') });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/settings/print-count-worksheet â€” thermal stock-count worksheet.
// Silent print via the existing receipt printer (same transport as
// /print-receipt and /open-drawer). Caller sends the products with their
// system qty + breakdown text; this route lays them out at 42-char width
// with blank "Counted" boxes for hand-writing during the physical count.
router.post('/print-count-worksheet', async (req, res) => {
  try {
    const { CMD, sendToPrinter } = require('../utils/escpos');
    const { location, countDate, cashier, products, notes } = req.body;

    // Authoritative business header â€” same source as /print-receipt.
    const biz = db.prepare(
      'SELECT business_name, business_phone, business_address FROM business_settings LIMIT 1'
    ).get() || {};
    const businessName    = biz.business_name    || 'Kelete';
    const businessPhone   = biz.business_phone   || '';
    const businessAddress = biz.business_address || '';

    // v1.10.60 â€” W dropped 42 â†’ 40 for the same safer-margin reason as
    // /print-receipt. Dynamic name/sku field math still works.
    const W = 40;
    const eq = '='.repeat(W);
    const da = '-'.repeat(W);
    const center = (str) => {
      const s = String(str).substring(0, W);
      const pad = Math.floor((W - s.length) / 2);
      return ' '.repeat(pad) + s;
    };
    const cols = (left, right) => {
      const l = String(left).substring(0, W - String(right).length - 1);
      return l + ' '.repeat(W - l.length - String(right).length) + String(right);
    };

    const lines = [];

    // Header
    lines.push(center(businessName));
    if (businessAddress) {
      String(businessAddress).split(/\r?\n/).forEach(ln => {
        const t = ln.trim();
        if (!t) return;
        for (let i = 0; i < t.length; i += W) lines.push(center(t.substring(i, i + W)));
      });
    }
    if (businessPhone) lines.push(center('Tel: ' + businessPhone));
    lines.push(eq);
    lines.push(center('STOCK RECONCILIATION'));
    lines.push(center('COUNT WORKSHEET'));
    lines.push(eq);
    lines.push(cols('Location:',  location || 'Sales Floor'));
    lines.push(cols('Date:',      countDate || ''));
    if (cashier) lines.push(cols('Cashier:', cashier));
    lines.push(cols('Items to count:', String((products || []).length)));
    lines.push(eq);
    lines.push('');

    // Items â€” each gets the name + SKU on one line, system qty (and base
    // breakdown when the display qty isn't already in base units), then a
    // blank counted box.
    (products || []).forEach((p, idx) => {
      const num = `#${idx + 1} `;
      const name = String(p.product_name || '');
      const sku  = String(p.sku || '');
      // Try to fit "#N  Name                      SKU" on one line.
      const nameWidth = W - num.length - sku.length - 1;
      const trimmedName = name.length > nameWidth ? name.substring(0, nameWidth) : name;
      const gap = ' '.repeat(Math.max(1, W - num.length - trimmedName.length - sku.length));
      lines.push(num + trimmedName + gap + sku);

      // System qty â€” display line first
      const sysDisplay = String(p.system_display || '').trim();
      const sysBase    = String(p.system_base    || '').trim();
      if (sysDisplay) {
        lines.push('    System:  ' + sysDisplay);
        if (sysBase && sysBase !== sysDisplay) {
          lines.push('           = ' + sysBase);
        }
      } else if (sysBase) {
        lines.push('    System:  ' + sysBase);
      }
      // Counted box â€” wide blank for hand-written entry
      lines.push('    Counted: _____________________ ______');
      lines.push('                  (physical qty)  (unit)');
      lines.push('');
    });

    // Notes section
    lines.push(eq);
    lines.push('NOTES (anomalies, damages, expiries):');
    if (notes) {
      // Existing notes from the on-screen field â€” wrap to width
      const wrapAt = W - 2;
      String(notes).split(/\r?\n/).forEach(ln => {
        const t = ln.trim();
        if (!t) return;
        for (let i = 0; i < t.length; i += wrapAt) lines.push('  ' + t.substring(i, i + wrapAt));
      });
      lines.push('');
    }
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push(eq);

    // Sign-off block
    lines.push('Counted by:');
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push('Signature:');
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push('Time finished:');
    lines.push('  ' + '_'.repeat(W - 4));
    lines.push(eq);

    const now = new Date();
    lines.push(center('Printed: ' + now.toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })));

    const text = lines.join('\n') + '\n\n\n\n\n\n';
    // v1.10.60 â€” same BOLD_ON / BOLD_OFF wrap as /print-receipt and
    // /print-report so the worksheet prints solid black instead of grey.
    const ticket = CMD.INIT + CMD.LEFT_MARGIN_24 + CMD.BOLD_ON + text + CMD.BOLD_OFF + CMD.CUT;
    const result = await sendToPrinter(db, ticket);
    if (!result.ok) return res.status(500).json({ error: 'Failed to print worksheet: ' + (result.error || 'unknown') });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
