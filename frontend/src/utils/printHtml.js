// printHtml — render a complete HTML document (the same string previously
// passed to window.open + document.write) and route to one of three paths:
//
//   1. Desktop / Electron — hidden iframe + iframe.contentWindow.print().
//      Native print dialog, no popup.
//   2. Mobile browser (Chrome on Android, Safari on iOS) — generate a PDF
//      via html2pdf and trigger the browser's download. User picks Open /
//      Share / Print from the download notification.
//   3. Capacitor APK — Android's WebView ignores <a download> clicks, so we
//      generate the PDF bytes, write them via @capacitor/filesystem to
//      Documents/, then open the OS share sheet via @capacitor/share. From
//      there the user can save, open in a viewer, or send to a printer.
//
// The Mobile Print Mode toggle in System Settings overrides path 2 with
// path 1's print-dialog behaviour for phones that prefer it.

import { isMobileApp } from './platform';
import { isTerminal58 } from './receipt58';
import { rasterToEscPos, bytesToBase64, HEAD_DOTS_58 } from './escposRaster';

const PHONE_BREAKPOINT = 768;
export const MOBILE_PRINT_MODE_KEY = 'kelete.mobilePrintMode';

const isPhone = () =>
  typeof window !== 'undefined' && window.innerWidth <= PHONE_BREAKPOINT;

// 2026-09-23 — the APK defaults to the print dialog, not a PDF.
//
// Same reason as getDeviceType() in receipt58.js: this is a per-device setting
// nobody had touched on the handhelds that went out to the depots, so they all
// took the 'pdf' default — downloading a file instead of driving the terminal's
// built-in printer. A device that HAS been set keeps its choice, 'pdf'
// included; only an untouched APK changes.
export const readMobilePrintMode = () => {
  try {
    const v = window.localStorage.getItem(MOBILE_PRINT_MODE_KEY);
    if (v === 'print' || v === 'pdf') return v;
    return isMobileApp() ? 'print' : 'pdf';
  } catch (_) {
    return 'pdf';
  }
};

// Pull a filename out of the receipt HTML's <title>, or default to "receipt".
const filenameFromHtml = (html) => {
  try {
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const raw = (m && m[1]) || 'receipt';
    return raw.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 60) || 'receipt';
  } catch (_) {
    return 'receipt';
  }
};

// ── Shared helper: render the full HTML inside a hidden, off-screen iframe ──
// Returns the iframe + a cleanup function. The receipt's own <style> rules
// (`body { width: 80mm; … }`) apply correctly inside the iframe's document,
// which is what fixes the "blank PDF" bug from v1.4.89.
// 2026-09-10 — a 58mm receipt (utils/receipt58.js, marked data-paper="58")
// is laid out 48mm wide, the width a 58mm roll actually prints. Its PDF page
// is made that width too, so it prints 1:1 instead of sitting in the corner of
// an 80mm page and being shrunk to fit. Every other receipt keeps 80mm.
const pageWidthMm = (html) => (/<html[^>]*data-paper="58"/i.test(html) ? 48 : 80);

function renderInIframe(html, widthMm = 80) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    `position:fixed;top:0;left:-10000px;width:${widthMm}mm;height:auto;min-height:200mm;border:0;background:#fff;`;
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow.document;
  doc.open();
  doc.write(html);
  doc.close();

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    try { iframe.remove(); } catch (_) {}
  };

  return { iframe, doc, cleanup };
}

// ── Silent printing: Kelete APK + POS small terminal ────────────────────────
//
// 2026-09-10. On the KI-POS the built-in printer is paired as the Bluetooth
// device "vBtPrinter". The APK's KeletePrint plugin can write to it
// directly, so there is no print window at all: the receipt is drawn here as
// a 384-dot image (the width a 58mm head prints), turned into ESC/POS by
// escposRaster.js, and handed to the plugin. The plugin reports the outcome
// through window.__keletePrintDone; any failure — Bluetooth off, permission
// refused, no printer, an older APK — falls back to the print window.
let silentSeq = 0;
const silentPending = {};
if (typeof window !== 'undefined') {
  window.__keletePrintDone = (id, ok, message) => {
    const job = silentPending[id];
    if (!job) return;
    delete silentPending[id];
    clearTimeout(job.timer);
    if (ok) job.resolve();
    else job.reject(new Error(message || 'print failed'));
  };
}

const canPrintSilently = () =>
  typeof window !== 'undefined'
  && window.KeleteAndroid
  && typeof window.KeleteAndroid.sendRaw === 'function'
  && isTerminal58();

async function renderReceiptRaster(html) {
  const html2canvas = (await import('html2canvas')).default;
  const { doc, cleanup } = renderInIframe(html, pageWidthMm(html));
  try {
    // Let the iframe lay out and the QR image decode before it is drawn.
    await new Promise((r) => setTimeout(r, 250));
    const body = doc.body;
    const cssWidth = body.getBoundingClientRect().width || 1;
    const shot = await html2canvas(body, {
      scale: HEAD_DOTS_58 / cssWidth,
      backgroundColor: '#ffffff',
      windowWidth: body.scrollWidth,
      windowHeight: body.scrollHeight,
      logging: false,
    });
    // Exactly the head's width: the scale can land a dot either side.
    const c = document.createElement('canvas');
    c.width = HEAD_DOTS_58;
    c.height = Math.max(1, Math.round((shot.height * HEAD_DOTS_58) / shot.width));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(shot, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height);
  } finally {
    cleanup();
  }
}

async function printSilently(html) {
  const img = await renderReceiptRaster(html);
  const base64 = bytesToBase64(rasterToEscPos(img));
  const id = ++silentSeq;
  await new Promise((resolve, reject) => {
    // A job that never reports back is treated as failed, so the cashier
    // still gets the print window rather than nothing.
    const timer = setTimeout(() => {
      delete silentPending[id];
      reject(new Error('the printer did not answer'));
    }, 30000);
    silentPending[id] = { resolve, reject, timer };
    window.KeleteAndroid.sendRaw(base64, id);
  });
}

// ── PDF generation (returns a Blob) ─────────────────────────────────────────
// Used by both the mobile-browser download path and the Capacitor share path.
async function buildPdfBlob(html) {
  // Lazy-import so desktop bundles never pay the ~600 KB library cost.
  const html2pdf = (await import('html2pdf.js')).default;

  const widthMm = pageWidthMm(html);
  const { iframe, doc, cleanup } = renderInIframe(html, widthMm);

  // Let the iframe finish layout / image decoding before we snapshot it.
  await new Promise((r) => setTimeout(r, 250));

  // Measure the iframe body so the PDF page height matches the content
  // (otherwise an 80×297mm page wastes a lot of space for a 10-line receipt).
  const body = doc.body;
  // 80mm @ 96dpi ≈ 302px. Compute height from the rendered body, capped to
  // avoid pathological multi-page generation.
  const heightPx = Math.max(body.scrollHeight || 0, 200);
  // Convert px → mm (96 dpi → 1mm = 3.7795px) and clamp to PDF max ~ 5000mm.
  const heightMm = Math.min(Math.max(heightPx / 3.7795, 60), 5000);

  try {
    const pdf = await html2pdf()
      .set({
        margin: 0,
        filename: `${filenameFromHtml(html)}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: 2,
          backgroundColor: '#ffffff',
          // Critical: tell html2canvas to render the IFRAME's document, not
          // the parent page. Without this, computed styles fall back to the
          // parent's CSS and the body styles never apply.
          windowWidth: body.scrollWidth,
          windowHeight: body.scrollHeight,
        },
        jsPDF: { unit: 'mm', format: [widthMm, heightMm], orientation: 'portrait' },
      })
      .from(body)
      .outputPdf('blob');
    return pdf;
  } finally {
    cleanup();
  }
}

// Public — true when the device is a phone AND the Mobile Print Mode
// setting is "PDF Download". UI surfaces (e.g. a "Download PDF" button
// in the Sales Report view modal) gate themselves on this.
export const shouldShowMobilePdfButton = () =>
  isPhone() && readMobilePrintMode() === 'pdf';

// True only when we can actually call Capacitor plugins from this JS context.
// isMobileApp() looks at user-agent — but the thin-shell APK redirects to the
// live tenant URL, where window.Capacitor is undefined and any plugin call
// throws "not implemented". So gate plugin paths on this stronger check.
const isCapacitorBridgeReachable = () =>
  typeof window !== 'undefined' &&
  typeof window.Capacitor !== 'undefined' &&
  typeof window.Capacitor.isPluginAvailable === 'function' &&
  window.Capacitor.isPluginAvailable('Filesystem') &&
  window.Capacitor.isPluginAvailable('Share');

// Public — always run the PDF path regardless of platform/setting. Used by
// the explicit "Download PDF" button. Tries Capacitor first when the bridge
// is reachable, otherwise falls back to the browser <a download> path so
// the user at least gets a downloadable file in mobile Chrome / Safari.
export async function downloadPdf(html) {
  try {
    if (isCapacitorBridgeReachable()) {
      await sharePdfFromApk(html);
    } else {
      await downloadPdfInBrowser(html);
    }
  } catch (err) {
    // If the Capacitor path errored (e.g. bridge was reported reachable but
    // the actual write/share failed), try the browser path as a last resort
    // before bubbling the error up.
    try {
      await downloadPdfInBrowser(html);
      return;
    } catch (_) {}
    alert(`PDF failed: ${err?.message || err}`);
    throw err;
  }
}

// ── Path 2: Mobile browser — download the PDF ────────────────────────────
async function downloadPdfInBrowser(html) {
  const blob = await buildPdfBlob(html);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${filenameFromHtml(html)}.pdf`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { a.remove(); } catch (_) {}
    URL.revokeObjectURL(url);
  }, 1000);
}

// ── Path 3: Capacitor APK — save to filesystem + share ───────────────────
async function sharePdfFromApk(html) {
  const blob = await buildPdfBlob(html);
  // Read the blob as base64 for Filesystem.writeFile.
  const base64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const r = fr.result || '';
      const i = String(r).indexOf(',');
      resolve(i >= 0 ? String(r).slice(i + 1) : String(r));
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });

  // Lazy-import Capacitor plugins so the browser bundle doesn't pull them.
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const { Share } = await import('@capacitor/share');

  const filename = `${filenameFromHtml(html)}.pdf`;
  const written = await Filesystem.writeFile({
    path: filename,
    data: base64,
    directory: Directory.Cache,
  });

  try {
    await Share.share({
      title: filename,
      url: written.uri,
      dialogTitle: 'Share receipt',
    });
  } catch (_) {
    // User dismissed the share sheet — file is still saved at written.uri.
  }
}

// ── Path 1b: phone in Print Dialog mode — print from the page itself ─────
//
// 2026-09-10 — the hidden-iframe print below froze Android Chrome on a KI-POS
// handheld, while the same receipt printed fine from laptop Chrome and the
// Sales Report's Print Report (a normal page in a new tab) printed fine on
// the handheld itself.
//
// The difference is timing. printViaIframe deletes its frame on
// `afterprint`. Desktop Chrome fires that when the print dialog closes;
// Android Chrome opens its print screen in the background and fires it
// straight away, so the frame was gone while Android was still building the
// preview, and the preview waited for it forever.
//
// So on a phone the receipt is printed from the page itself: its body goes
// into a container that is hidden on screen and is the only thing shown in
// print. Nothing is removed afterwards — the next print simply replaces it.
// No new tab either: a tab opened after a network call (a sale being saved
// and signed) is blocked as a popup.
function printInPage(html) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const receiptCss = Array.from(parsed.querySelectorAll('style'))
    .map((s) => s.textContent)
    .join('\n');

  let root = document.getElementById('rs-print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'rs-print-root';
    document.body.appendChild(root);
  }
  let style = document.getElementById('rs-print-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'rs-print-style';
    document.head.appendChild(style);
  }

  // The receipt's own CSS (page size, body width, fonts) applies only while
  // printing, so it cannot touch the screen. Everything else on the page is
  // hidden in print; the visibility override beats pages that hide all of
  // `body *` in their own print CSS (Sales Report does, for its View window).
  style.textContent = `
    @media screen { #rs-print-root { display: none !important; } }
    @media print {
      body > *:not(#rs-print-root) { display: none !important; }
      #rs-print-root { display: block !important; position: static !important; }
      #rs-print-root, #rs-print-root * { visibility: visible !important; }
      ${receiptCss}
    }`;
  root.innerHTML = parsed.body.innerHTML;

  // A moment for the QR image to decode before the page is printed.
  setTimeout(() => { try { window.print(); } catch (_) {} }, 250);
}

// ── Path 1: Desktop / Electron — hidden iframe + print dialog ────────────
function printViaIframe(html) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText =
    'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);

  let removed = false;
  const cleanup = () => {
    if (removed) return;
    removed = true;
    try { iframe.remove(); } catch (_) {}
  };

  iframe.onload = () => {
    try {
      const cw = iframe.contentWindow;
      cw.focus();
      if (cw && 'onafterprint' in cw) cw.onafterprint = cleanup;
      cw.print();
    } catch (_) {
      cleanup();
    }
    setTimeout(cleanup, 60_000);
  };

  if ('srcdoc' in iframe) {
    iframe.srcdoc = html;
  } else {
    iframe.onload = () => {
      try {
        const d = iframe.contentDocument || iframe.contentWindow.document;
        d.open(); d.write(html); d.close();
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (_) {}
      setTimeout(cleanup, 60_000);
    };
    iframe.src = 'about:blank';
  }
}

export default function printHtml(html) {
  if (typeof document === 'undefined') return;

  // 2026-08-30 — on an Electron till, print SILENTLY.
  //
  // printViaIframe ends in contentWindow.print(), which is the native print
  // dialog — the header of this file says so plainly ("Native print dialog").
  // So every receipt made the cashier pick a printer and press Print, on a
  // machine with one job and one printer.
  //
  // The silent path already existed (main.js 'print-silent' →
  // webContents.print({ silent: true, deviceName })) but only PrintPreview.js
  // ever called it; the receipts went through here and never reached it.
  // Fixing the deviceName it used (v1.13.163) therefore changed nothing
  // visible, because nothing was calling it.
  //
  // Falls back to the dialog if the silent print fails — a cashier who cannot
  // print at all is worse than one who has to click.
  if (typeof window !== 'undefined' && window.electronAPI?.printSilent) {
    try {
      Promise.resolve(window.electronAPI.printSilent(html))
        .then((r) => { if (!r || r.success === false) printViaIframe(html); })
        .catch(() => printViaIframe(html));
    } catch (_) {
      printViaIframe(html);
    }
    return;
  }

  // Silent first: the APK on a POS small terminal prints straight to the
  // built-in printer. If that fails for any reason, the print window below.
  if (canPrintSilently()) {
    printSilently(html).catch(() => {
      try { window.KeleteAndroid.printHtml(html, filenameFromHtml(html)); } catch (_) {}
    });
    return;
  }

  // 2026-09-10 — inside the Kelete APK. The site runs in the app's built-in
  // browser, which has no print window of its own and ignores downloads, so
  // none of the paths below does anything there: pressing Print did nothing.
  // The APK's KeletePrint plugin (frontend/capacitor-plugins/kelete-print)
  // puts window.KeleteAndroid on the page, and handing it the receipt opens
  // Android's print window, the same one Chrome shows. Mobile Print Mode does
  // not apply here: this is the only thing that prints inside the APK.
  if (typeof window !== 'undefined' && window.KeleteAndroid
      && typeof window.KeleteAndroid.printHtml === 'function') {
    try {
      window.KeleteAndroid.printHtml(html, filenameFromHtml(html));
      return;
    } catch (_) { /* an older APK or a failed call: fall through */ }
  }

  // Capacitor APK with reachable bridge — share via OS share sheet.
  // (The thin-shell APK loses the bridge on the redirected tenant URL,
  //  so we can only reach plugins from the bootstrap page itself.)
  if (isCapacitorBridgeReachable()) {
    sharePdfFromApk(html).catch(() => downloadPdfInBrowser(html).catch(() => {}));
    return;
  }

  if (isPhone() && readMobilePrintMode() === 'pdf') {
    downloadPdfInBrowser(html).catch(() => {});
    return;
  }

  // Phone in Print Dialog mode: the hidden iframe freezes Android Chrome.
  // See printInPage above. Desktop keeps the iframe, which works there.
  if (isPhone()) {
    printInPage(html);
    return;
  }

  printViaIframe(html);
}
