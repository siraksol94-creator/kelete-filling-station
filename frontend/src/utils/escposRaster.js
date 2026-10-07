// escposRaster — a rendered receipt image, as ESC/POS printer commands.
//
// 2026-09-10. Silent printing on the KI-POS handheld sends bytes straight to
// its built-in printer, which Android sees as the Bluetooth device
// "vBtPrinter". The receipt is drawn as an image exactly as wide as the print
// head — 384 dots on a 58mm roll, 8 dots per mm across the 48mm it prints —
// and sent as a raster, so the paper looks like the print-window output, QR
// code included, whatever fonts the printer itself carries.
//
// Pure functions, no DOM, so they can be checked outside a browser.

export const HEAD_DOTS_58 = 384;

// img: { width, height, data } — RGBA, the shape canvas getImageData returns.
// Returns a Uint8Array: initialise, the image in bands, then a paper feed.
export function rasterToEscPos(img, opts = {}) {
  const threshold = opts.threshold ?? 160; // luminance below this prints black
  const band = opts.band ?? 128;           // rows per GS v 0 command; small bands suit small printer buffers
  const feed = opts.feed ?? 4;             // blank lines after, to clear the tear bar
  const { width, data } = img;
  const bytesPerRow = Math.ceil(width / 8);

  // One pass to turn pixels into dots, and to find the last row with ink:
  // the receipt's bottom padding is blank paper, so it is not sent.
  const dots = new Uint8Array(bytesPerRow * img.height);
  let lastInk = -1;
  for (let y = 0; y < img.height; y++) {
    let rowHasInk = false;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      // Composite over white: a transparent pixel is paper, not ink.
      const r = data[i] * a + 255 * (1 - a);
      const g = data[i + 1] * a + 255 * (1 - a);
      const b = data[i + 2] * a + 255 * (1 - a);
      if (0.299 * r + 0.587 * g + 0.114 * b < threshold) {
        dots[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
        rowHasInk = true;
      }
    }
    if (rowHasInk) lastInk = y;
  }
  const height = lastInk + 1;

  const bands = Math.ceil(height / band);
  const out = new Uint8Array(2 + bands * 8 + bytesPerRow * height + 3);
  let o = 0;
  out[o++] = 0x1b; out[o++] = 0x40;          // ESC @      initialise
  for (let y0 = 0; y0 < height; y0 += band) {
    const rows = Math.min(band, height - y0);
    out[o++] = 0x1d; out[o++] = 0x76; out[o++] = 0x30; out[o++] = 0x00; // GS v 0, normal size
    out[o++] = bytesPerRow & 0xff; out[o++] = (bytesPerRow >> 8) & 0xff;
    out[o++] = rows & 0xff;        out[o++] = (rows >> 8) & 0xff;
    out.set(dots.subarray(y0 * bytesPerRow, (y0 + rows) * bytesPerRow), o);
    o += rows * bytesPerRow;
  }
  out[o++] = 0x1b; out[o++] = 0x64; out[o++] = feed & 0xff; // ESC d n   feed n lines
  return out;
}

export function bytesToBase64(bytes) {
  let s = '';
  const CHUNK = 0x8000; // fromCharCode takes its arguments on the stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}
