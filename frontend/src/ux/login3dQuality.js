// UX-4 — keeps the sign-in 3D scene smooth on slow tills: renders fewer
// pixels when frames are slow and more when there's headroom. Pure (tested).
export const QUALITY = { min: 0.35, max: 0.85, start: 0.6, slowMs: 30, fastMs: 14, step: 0.1 };

// Next render scale from the average frame time (ms) of the last batch.
export function adjustScale(scale, avgMs, q = QUALITY) {
  if (!Number.isFinite(avgMs) || avgMs <= 0) return scale;
  if (avgMs > q.slowMs) return Math.max(q.min, Math.round((scale - q.step) * 100) / 100);
  if (avgMs < q.fastMs) return Math.min(q.max, Math.round((scale + q.step / 2) * 100) / 100);
  return scale;
}

// Drawing-buffer size for a CSS size: device pixels × scale, capped so a huge
// screen never asks the graphics chip for more than ~1.1 million pixels.
export function bufferSize(cssW, cssH, dpr, scale, maxPixels = 1100000) {
  let w = Math.max(1, Math.round(cssW * Math.min(dpr || 1, 2) * scale));
  let h = Math.max(1, Math.round(cssH * Math.min(dpr || 1, 2) * scale));
  const over = (w * h) / maxPixels;
  if (over > 1) { const k = Math.sqrt(over); w = Math.round(w / k); h = Math.round(h / k); }
  return { w, h };
}

// Where the drop sits across the canvas (0…1): left of the form on wide
// screens, centred on narrow ones.
export const dropCentre = (cssW) => (cssW >= 900 ? 0.36 : 0.5);
// …and how far up (in screen heights), leaving room for the headline below.
export const dropLift = (cssW) => (cssW >= 900 ? 0.1 : 0.04);

// Fuel level eases toward its target: fills on arrival, rises while signing in.
export function easeFill(fill, target, dtSec) {
  const k = Math.min(1, Math.max(0, dtSec) * 1.6);
  return fill + (target - fill) * k;
}
