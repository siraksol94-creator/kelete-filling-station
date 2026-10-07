// receipt58 â€” the till receipt for a small handheld POS terminal (58mm roll).
//
// 2026-09-10. Red Sea is putting the system on phone-sized terminals with a
// built-in 58mm printer. The existing receipt is laid out for the depot tills'
// 80mm printers and stays exactly as it is: this file adds a second layout,
// chosen per device by System Settings â†’ Device type.
//
//   PC                  â†’ the existing 80mm receipt (default, unchanged)
//   POS small terminal  â†’ this 58mm receipt
//
// Per device, not per branch: a depot can run a PC till and a handheld side by
// side, each printing on its own paper.
//
// The callers pass the figures they have ALREADY computed for the 80mm layout
// (VAT, VAT Excl, totals), so the two layouts can never disagree on a number.
//
// 2026-09-10 â€” made compact on the paper, at Red Sea's request: address and
// TPIN share a line; each item is its name, then qty x price and a bold total;
// no tax category, no per-item VAT Excl / VAT and no column titles; Buyer TPIN
// and Buyer Name only for a named customer or a walk-in who gave a TPIN.
// VAT still prints in the totals and the ZRA block is unchanged. The 80mm
// receipt, which ZRA saw at UAT, keeps every column.

import { isMobileApp } from './platform';

export const DEVICE_TYPE_KEY = 'kelete.deviceType';

// 2026-09-23 â€” a handheld defaults to its own receipt.
//
// The setting is per device and lives in that browser's localStorage, so it can
// only be set ON the terminal. A batch went out to the depots with nobody having
// touched it, and every one of them fell to the 'pc' default â€” printing the 80mm
// layout on a 58mm roll, with no way to correct it remotely.
//
// So when NOTHING has been chosen and we are inside the Kelete APK, start on the
// 58mm receipt. A device that has been set explicitly keeps whatever it was
// given, including 'pc' â€” a depot may legitimately run the APK on a tablet next
// to an 80mm printer, and that choice must outlive this default.
export const getDeviceType = () => {
  try {
    const saved = localStorage.getItem(DEVICE_TYPE_KEY);
    if (saved === 'terminal58' || saved === 'pc') return saved;
    return isMobileApp() ? 'terminal58' : 'pc';
  } catch (_) {
    return 'pc';
  }
};

export const setDeviceType = (v) => {
  try { localStorage.setItem(DEVICE_TYPE_KEY, v === 'terminal58' ? 'terminal58' : 'pc'); } catch (_) {}
};

export const isTerminal58 = () => getDeviceType() === 'terminal58';

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const qtyStr = (q) => {
  const n = parseFloat(q || 0);
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(2);
};

// Long enough to cross 48mm at any size; the overflow is clipped. The 80mm
// receipt draws its dividers from characters too, so the two read alike.
const EQ = '='.repeat(64);
const DA = '-'.repeat(64);

// r = {
//   title,                         <title>, also the PDF's file name
//   bizLines: ['RED SEA IMPORT & EXPORT', '(Z) LIMITED'],
//   address, tpin, phone,          header, in that order after the name
//   bands:    ['*** TAX INVOICE ***', { text, sub: true }, â€¦]
//             title block, in print order: strings are bold bands,
//             { sub: true } entries are small note lines
//   subs:     ['Reverses invoice â€¦', â€¦]    small lines under the title
//   meta:     [{ label, value, mono, bold }]
//   lines:    [{ name, qty, price, total, â€¦ }]   price = what one unit sold for
//   money:    formatter for amounts (the caller's rcptMoney)
//   totals:   [{ label, value, strong }]
//   empties:  { voucher, qty } | null
//   qrDataUrl,                     '' on an unsigned receipt
//   fiscal:   [{ label, value }] | null   the ZRA block under the QR
//   fiscalTail: ['Cash Sales', 'CUSTOMER TPIN â€¦']
//   footer,
// }
export function buildReceipt58(r) {
  const money = r.money || ((n) => parseFloat(n || 0).toFixed(2));

  const kv = (m) => `
    <div class="kv${m.bold ? ' b' : ''}"><span>${esc(m.label)}</span><span class="${m.mono ? 'mono' : ''}">${esc(m.value)}</span></div>`;

  // With no column titles, "120" alone says nothing; "120 x 285.00" reads on
  // its own.
  const items = (r.lines || []).map((l) => {
    const q = parseFloat(l.qty || 0);
    const price = l.price != null ? l.price : (q ? l.total / q : 0);
    return `
    <div class="it">
      <div class="nm">${esc(l.name)}</div>
      <div class="ln"><span>${qtyStr(l.qty)} x ${money(price)}</span><span>${money(l.total)}</span></div>
    </div>`;
  }).join('');

  const totals = (r.totals || []).map((t) => `
    <div class="kv amt${t.strong ? ' due' : ''}"><span>${esc(t.label)}</span><span>${esc(t.value)}</span></div>`).join('');

  const empties = r.empties ? `
    <div class="rule">${DA}</div>
    <div class="b">EMPTIES</div>
    <div class="kv ind"><span>Voucher</span><span>${esc(r.empties.voucher)}</span></div>
    <div class="kv ind"><span>Returned</span><span class="b">${esc(r.empties.qty)}</span></div>` : '';

  const fiscal = r.fiscal ? `
    ${r.qrDataUrl ? `<div class="rule">${EQ}</div><div class="qr"><img src="${r.qrDataUrl}" alt="QR" /></div>` : ''}
    <div class="rule">${EQ}</div>
    <div class="fisc">
      ${r.fiscal.map((f) => `<div class="kv"><span>${esc(f.label)}</span><span>${esc(f.value)}</span></div>`).join('')}
      ${(r.fiscalTail || []).map((t, i) => `<div${i === 0 ? ' style="margin-top:2px"' : ''}>${esc(t)}</div>`).join('')}
    </div>` : '';

  return `<!DOCTYPE html>
<html data-paper="58">
<head>
<meta charset="UTF-8">
<title>${esc(r.title || 'receipt')}</title>
<style>
  /* A 58mm roll prints 48mm: the same rule the 80mm receipt found the hard
     way (80mm roll, 72mm printable). The canvas is the print head's width,
     so nothing can fall off the side. */
  @page { size: 48mm auto; margin: 0; }
  html, body { margin: 0; padding: 0; overflow-x: hidden; }
  * { box-sizing: border-box; }
  /* Padding is the number to tune on the terminal, as it was on the 80mm
     printers: if the left edge clips, raise the left; if the right-hand
     digit clips, raise the right. */
  body {
    width: 48mm; max-width: 48mm;
    padding: 1.5mm 1.5mm 2mm 1.5mm;
    font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;
    font-size: 10px; line-height: 1.25; color: #000; font-weight: 400;
  }
  .b { font-weight: 800; }
  .biz { text-align: center; font-weight: 800; font-size: 11.5px; letter-spacing: .3px; line-height: 1.2; }
  .hd { text-align: center; font-size: 9.5px; }
  .rule { overflow: hidden; white-space: nowrap; line-height: 1; margin: 2px 0; font-size: 9px; }
  .band { text-align: center; font-weight: 800; font-size: 11.5px; letter-spacing: 1.5px; }
  .sub { text-align: center; font-size: 9px; }
  /* Label left, value right. A value too long to sit beside its label wraps
     onto the next line, still right-aligned, instead of being squeezed or cut. */
  .kv { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; column-gap: 2mm; }
  .kv > span:first-child { white-space: nowrap; }
  .kv > span:last-child { margin-left: auto; text-align: right; min-width: 0; overflow-wrap: anywhere; }
  .kv.b > span:last-child { font-weight: 800; }
  .kv.ind > span:first-child { padding-left: 2mm; }
  /* No monospace in the top block: Invoice # in Courier at 9px read as a
     different size from everything around it. One font, one size. */
  /* Items: two lines each. Name, then qty x price and the line total.
       MOSI LAGER 375ml RGB x12
         120 x 285.00         34,200.00   */
  .it { margin-top: 2px; }
  .it .nm { overflow-wrap: anywhere; }
  .ln { display: flex; justify-content: space-between; column-gap: 2mm; padding-left: 3mm; font-variant-numeric: tabular-nums; }
  .ln > span:last-child { text-align: right; font-weight: 800; }
  .amt { font-size: 10.5px; font-variant-numeric: tabular-nums; }
  .due { font-weight: 800; font-size: 12.5px; margin: 1px 0; }
  .qr { text-align: center; margin: 3px 0; }
  .qr img { width: 30mm; height: 30mm; }
  /* The ZRA block runs smaller so each detail fits label and value on one
     line; anything longer than usual wraps rather than being cut.
     2026-09-11 â€” values in the same font as their labels. They were in
     Courier New, which Android does not have: it substitutes a thin
     typewriter face that the terminal's printer barely marked. 6.6px is the
     largest size at which the longest line, "Security Data:" and its 26
     characters, still fits on one line of the 48mm roll. */
  .fisc { font-size: 6.6px; line-height: 1.35; }
  .fisc .kv { column-gap: 1.2mm; }
  .thanks { text-align: center; font-size: 9.5px; margin-top: 3px; }
</style>
</head>
<body>
  ${(r.bizLines || []).map((l) => `<div class="biz">${esc(l)}</div>`).join('')}
  ${(r.address || r.tpin) ? `<div class="hd">${[
      r.address ? esc(String(r.address).replace(/\s*\n\s*/g, ', ').toUpperCase()) : '',
      r.tpin ? `TPIN: ${esc(r.tpin)}` : '',
    ].filter(Boolean).join(' Â· ')}</div>` : ''}
  ${r.phone ? `<div class="hd">Tel: ${esc(r.phone)}</div>` : ''}

  <div class="rule">${EQ}</div>
  ${(r.bands || []).map((b) => (typeof b === 'string'
    ? `<div class="band">${esc(b)}</div>`
    // { text, sub: true } is a small note line. Mixed in with the bands so a
    // reprint keeps the 80mm order: title, COPY / DUPLICATE, notes, REVERSED.
    : `<div class="${b.sub ? 'sub' : 'band'}">${esc(b.text)}</div>`)).join('')}
  ${(r.subs || []).map((s) => `<div class="sub">${esc(s)}</div>`).join('')}
  <div class="rule">${EQ}</div>

  ${(r.meta || []).map(kv).join('')}

  <div class="rule">${EQ}</div>
  ${items}
  <div class="rule">${DA}</div>

  ${totals}
  ${empties}
  ${fiscal}

  <div class="rule">${EQ}</div>
  <div class="thanks">${esc(r.footer || 'Thank you for your purchase.')}</div>
</body>
</html>`;
}
