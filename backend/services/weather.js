// UX-4 — weather for the station's location, from MET Norway's
// Locationforecast 2.0 (free for commercial use under CC BY 4.0; requires an
// identifying User-Agent with contact details and responsible caching).
// https://docs.api.met.no/doc/TermsOfService
//
// One request per location per 30 minutes at most (or longer if MET's Expires
// header says so), shared by every screen. Failure never breaks anything:
// the Dashboard just shows that weather isn't available.
const https = require('https');

const URL_BASE = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const MIN_REFRESH_MS = 30 * 60 * 1000;
const cache = new Map();   // "lat,lon" → { at, expires, data, lastModified }

function defaultFetch(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy(new Error('weather request timed out')));
    req.on('error', reject);
  });
}

// Zambia keeps UTC+2 all year.
const localDay = (iso) => new Date(Date.parse(iso) + 2 * 3600 * 1000).toISOString().slice(0, 10);

// MET compact JSON → what the screen needs.
function summarise(json, today) {
  const ts = (json && json.properties && json.properties.timeseries) || [];
  if (!ts.length) return null;
  const first = ts[0];
  const det = (first.data && first.data.instant && first.data.instant.details) || {};
  const sym = (p) => (p && p.summary && p.summary.symbol_code) || null;
  const byDay = new Map();
  for (const t of ts) {
    const day = localDay(t.time);
    const d = byDay.get(day) || { date: day, max: -Infinity, min: Infinity, rain_mm: 0, symbols: [] };
    const temp = t.data && t.data.instant && t.data.instant.details && t.data.instant.details.air_temperature;
    if (Number.isFinite(temp)) { d.max = Math.max(d.max, temp); d.min = Math.min(d.min, temp); }
    const n1 = t.data && t.data.next_1_hours;
    if (n1 && n1.details && Number.isFinite(n1.details.precipitation_amount)) d.rain_mm += n1.details.precipitation_amount;
    const s = sym(n1) || sym(t.data && t.data.next_6_hours);
    if (s) d.symbols.push(s);
    byDay.set(day, d);
  }
  const days = [...byDay.values()].filter((d) => d.date >= today).slice(0, 4).map((d) => {
    const worst = d.symbols.find((s) => /thunder/.test(s)) || d.symbols.find((s) => /heavyrain|rain|sleet/.test(s))
      || d.symbols[Math.floor(d.symbols.length / 2)] || null;
    return { date: d.date, max: Number.isFinite(d.max) ? Math.round(d.max * 10) / 10 : null, min: Number.isFinite(d.min) ? Math.round(d.min * 10) / 10 : null,
      rain_mm: Math.round(d.rain_mm * 10) / 10, symbol: worst, thunder: d.symbols.some((s) => /thunder/.test(s)) };
  });
  return {
    now: { temp: det.air_temperature, humidity: det.relative_humidity, wind: det.wind_speed, cloud: det.cloud_area_fraction,
      symbol: sym(first.data && first.data.next_1_hours) || sym(first.data && first.data.next_6_hours) },
    today: days[0] || null,
    days,
    updated_at: json.properties.meta && json.properties.meta.updated_at,
  };
}

// lat/lon rounded to 4 decimals (MET asks for no more).
async function forecast({ lat, lon, contact, today, fetcher = defaultFetch, now = Date.now() }) {
  const la = Math.round(Number(lat) * 1e4) / 1e4, lo = Math.round(Number(lon) * 1e4) / 1e4;
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return { available: false, reason: 'no-location' };
  if (!contact) return { available: false, reason: 'no-contact' };
  const key = `${la},${lo}`;
  const hit = cache.get(key);
  if (hit && now < hit.expires) return { available: true, ...summarise(hit.data, today), fetched_at: new Date(hit.at).toISOString(), cached: true };
  const headers = { 'User-Agent': `KeleteERP/1.0 ${contact}`, Accept: 'application/json' };
  if (hit && hit.lastModified) headers['If-Modified-Since'] = hit.lastModified;
  try {
    const r = await fetcher(`${URL_BASE}?lat=${la}&lon=${lo}`, headers);
    const exp = Date.parse(r.headers && r.headers.expires);
    const expires = Math.max(now + MIN_REFRESH_MS, Number.isFinite(exp) ? exp : 0);
    if (r.status === 304 && hit) { hit.expires = expires; hit.at = now; return { available: true, ...summarise(hit.data, today), fetched_at: new Date(now).toISOString() }; }
    if (r.status !== 200 && r.status !== 203) throw new Error(`weather service answered ${r.status}`);
    const data = JSON.parse(r.body);
    cache.set(key, { at: now, expires, data, lastModified: r.headers && r.headers['last-modified'] });
    return { available: true, ...summarise(data, today), fetched_at: new Date(now).toISOString() };
  } catch (e) {
    // Serve the last good forecast if there is one, marked as old.
    if (hit) return { available: true, stale: true, ...summarise(hit.data, today), fetched_at: new Date(hit.at).toISOString() };
    return { available: false, reason: 'unreachable', detail: String(e.message || e).slice(0, 120) };
  }
}

module.exports = { forecast, summarise, _cache: cache };
