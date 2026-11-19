// UX-4 — the sign-in 3D scene stays smooth on slow tills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adjustScale, bufferSize, dropCentre, easeFill, QUALITY } from '../../src/ux/login3dQuality';

test('fewer pixels when slow, more when there is headroom, within limits', () => {
  assert.equal(adjustScale(0.6, 45), 0.5);
  assert.equal(adjustScale(QUALITY.min, 80), QUALITY.min);
  assert.equal(adjustScale(0.6, 8), 0.65);
  assert.equal(adjustScale(QUALITY.max, 5), QUALITY.max);
  assert.equal(adjustScale(0.6, 20), 0.6);
  assert.equal(adjustScale(0.6, NaN), 0.6);
});

test('buffer never exceeds ~1.1 million pixels', () => {
  const { w, h } = bufferSize(3840, 2160, 2, 0.85);
  assert.ok(w * h <= 1100000 * 1.01, `${w}x${h}`);
  assert.deepEqual(bufferSize(1000, 500, 1, 0.5), { w: 500, h: 250 });
});

test('drop beside the form on wide screens, centred on phones; fuel eases', () => {
  assert.equal(dropCentre(1440), 0.36);
  assert.equal(dropCentre(390), 0.5);
  const f = easeFill(0, 0.55, 0.1);
  assert.ok(f > 0 && f < 0.55);
  assert.ok(Math.abs(easeFill(0.2, 0.9, 10) - 0.9) < 1e-9);
});
