// UX-4 — "Use this device's location" for the station weather. Pure helpers
// (tested in CI) plus a small promise wrapper around the browser's
// geolocation, which shows the device's own permission prompt.
import ZAMBIA_TOWNS from './zambiaTowns';

const rad = (d) => (d * Math.PI) / 180;
export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// A name for the spot: "Kabwe" when within 25 km of a listed town,
// "Near Kabwe" within 120 km, otherwise "Station".
export function nameForSpot(lat, lon, towns = ZAMBIA_TOWNS) {
  let best = null;
  for (const t of towns) {
    const d = distanceKm({ lat, lon }, t);
    if (!best || d < best.km) best = { town: t.name, km: d };
  }
  if (!best) return { label: 'Station', km: null };
  if (best.km <= 25) return { label: best.town, km: best.km };
  if (best.km <= 120) return { label: `Near ${best.town}`, km: best.km };
  return { label: 'Station', km: best.km };
}

// What to tell the person when the device can't or won't share its location.
// code: 1 denied, 2 unavailable, 3 timeout, 'insecure', 'unsupported'.
export function locationProblem(code) {
  switch (code) {
    case 1: return 'Location access is blocked for this site. Allow it in the browser (the padlock or settings icon next to the address), then try again — or pick the town from the list.';
    case 2: return "This device couldn't work out where it is. Pick the town from the list instead.";
    case 3: return 'Finding the location took too long. Try again outdoors or near a window, or pick the town from the list.';
    case 'insecure': return 'Browsers only share location over a secure (https) connection or on this computer itself. Pick the town from the list instead.';
    default: return "This device or browser can't share its location. Pick the town from the list instead.";
  }
}

// Ask the device. Resolves { lat, lon, accuracy } or rejects with { code }.
export function askDeviceLocation(nav = typeof navigator !== 'undefined' ? navigator : null, win = typeof window !== 'undefined' ? window : null) {
  return new Promise((resolve, reject) => {
    if (win && win.isSecureContext === false) { reject({ code: 'insecure' }); return; }
    if (!nav || !nav.geolocation) { reject({ code: 'unsupported' }); return; }
    nav.geolocation.getCurrentPosition(
      (p) => resolve({ lat: Math.round(p.coords.latitude * 1e4) / 1e4, lon: Math.round(p.coords.longitude * 1e4) / 1e4, accuracy: p.coords.accuracy }),
      (e) => reject({ code: e && e.code }),
      { enableHighAccuracy: false, timeout: 15000, maximumAge: 10 * 60 * 1000 },
    );
  });
}

// The permission's current state, if the browser says: 'granted' | 'prompt' | 'denied' | null.
export async function locationPermission(nav = typeof navigator !== 'undefined' ? navigator : null) {
  try {
    if (!nav || !nav.permissions || !nav.permissions.query) return null;
    const s = await nav.permissions.query({ name: 'geolocation' });
    return s && s.state ? s.state : null;
  } catch (_) { return null; }
}
