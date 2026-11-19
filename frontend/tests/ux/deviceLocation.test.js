// UX-4 — device location for the weather: naming the spot, clear messages,
// and the permission prompt only when asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceKm, nameForSpot, locationProblem, askDeviceLocation, locationPermission } from '../../src/ux/deviceLocation';

test('distance and naming the spot', () => {
  const d = distanceKm({ lat: -15.4167, lon: 28.2833 }, { lat: -14.4469, lon: 28.4464 });
  assert.ok(d > 100 && d < 115, `Lusaka–Kabwe ≈ 109 km, got ${d}`);
  assert.equal(nameForSpot(-14.45, 28.45).label, 'Kabwe');
  assert.equal(nameForSpot(-14.95, 28.35).label.startsWith('Near '), true);
  assert.equal(nameForSpot(0, 0).label, 'Station');
});

test('messages for every way it can fail', () => {
  for (const c of [1, 2, 3, 'insecure', 'unsupported', undefined]) assert.match(locationProblem(c), /town/);
  assert.match(locationProblem(1), /blocked/);
});

test('asks the device, rounds to 4 decimals; refuses on insecure pages and without geolocation', async () => {
  const nav = { geolocation: { getCurrentPosition: (ok, _bad, opts) => { assert.equal(opts.enableHighAccuracy, false); ok({ coords: { latitude: -15.416712, longitude: 28.283349, accuracy: 30 } }); } } };
  assert.deepEqual(await askDeviceLocation(nav, { isSecureContext: true }), { lat: -15.4167, lon: 28.2833, accuracy: 30 });
  await assert.rejects(askDeviceLocation(nav, { isSecureContext: false }), (e) => e.code === 'insecure');
  await assert.rejects(askDeviceLocation({}, { isSecureContext: true }), (e) => e.code === 'unsupported');
  const denied = { geolocation: { getCurrentPosition: (_ok, bad) => bad({ code: 1 }) } };
  await assert.rejects(askDeviceLocation(denied, {}), (e) => e.code === 1);
});

test('permission state when the browser says, otherwise null', async () => {
  assert.equal(await locationPermission({ permissions: { query: async () => ({ state: 'prompt' }) } }), 'prompt');
  assert.equal(await locationPermission({}), null);
  assert.equal(await locationPermission({ permissions: { query: async () => { throw new Error('x'); } } }), null);
});
