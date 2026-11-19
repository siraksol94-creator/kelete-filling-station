// UX-4 — station weather and what it means for fuel. The weather service is
// replaced by a fake here: no network, invented forecast.
const { setupEnv } = require('./helpers/harness');
setupEnv();

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');
const { seedStaff, seedFuel, createUser, login } = require('./helpers/fixtures');
const { adviceFor, shrinkage, gradeKind } = require('../services/weatherAdvice');
const { summarise, _cache } = require('../services/weather');

// A MET-shaped forecast: today hot with thunder in the afternoon (times in UTC; Zambia is UTC+2).
function met(today, { max = 36, min = 17, thunder = true } = {}) {
  const ts = [];
  for (let h = 0; h < 30; h++) {
    const t = new Date(Date.parse(`${today}T00:00:00Z`) - 2 * 3600e3 + h * 3600e3);
    const local = (h % 24);
    const temp = min + (max - min) * Math.max(0, Math.sin(((local - 6) / 24) * 2 * Math.PI));
    ts.push({ time: t.toISOString(), data: {
      instant: { details: { air_temperature: Math.round(temp * 10) / 10, relative_humidity: 40, wind_speed: 3, cloud_area_fraction: 20 } },
      next_1_hours: { summary: { symbol_code: thunder && local === 15 ? 'heavyrainandthunder' : 'clearsky_day' }, details: { precipitation_amount: thunder && local === 15 ? 12 : 0 } },
    } });
  }
  return { properties: { meta: { updated_at: `${today}T00:00:00Z` }, timeseries: ts } };
}

let app, staff, calls, mode, viewer;
const today = require('../config/businessTime').businessDate();
before(async () => {
  app = await startApp(); staff = await seedStaff(app);
  await seedFuel(app, staff.tokens.owner);
  // A Manager with all-screen access sees the Dashboard (where the weather card is) but is not an Administrator.
  await createUser(app.db, { email: 'viewer', role: 'Manager', permissions: ['All'] });
  viewer = await login(app, 'viewer');
  if (!app.db.prepare('SELECT 1 FROM business_settings LIMIT 1').get()) app.db.prepare("INSERT INTO business_settings (business_name) VALUES ('Test Station')").run();
  app.db.prepare("UPDATE business_settings SET business_email = 'ops@station.example'").run();
  calls = [];
  mode = 'ok';
  app.module.app.set('weatherFetcher', async (url, headers) => {
    calls.push({ url, headers });
    if (mode === 'down') throw new Error('offline');
    return { status: 200, headers: {}, body: JSON.stringify(met(today)) };
  });
});
after(async () => { await app.close(); });

describe('location', () => {
  test('not set: the card says so, and only Administrators are offered to set it', async () => {
    const a = (await app.request('GET', '/api/weather', { token: staff.tokens.owner })).body;
    assert.deepEqual(a, { configured: false, can_set: true });
    const c = (await app.request('GET', '/api/weather', { token: viewer })).body;
    assert.equal(c.can_set, false);
    assert.equal(calls.length, 0, 'nothing fetched without a location');
  });
  test('the weather sits on the Dashboard: someone without Dashboard access is refused', async () => {
    assert.equal((await app.request('GET', '/api/weather', { token: staff.tokens.cashier })).status, 403);
  });
  test('only Administrators can set it; bad coordinates are refused', async () => {
    assert.equal((await app.request('PUT', '/api/weather/location', { token: viewer, body: { town: 'Lusaka', lat: -15.4167, lon: 28.2833 } })).status, 403);
    assert.equal((await app.request('PUT', '/api/weather/location', { token: staff.tokens.owner, body: { town: 'X', lat: 200, lon: 0 } })).status, 400);
    const r = await app.request('PUT', '/api/weather/location', { token: staff.tokens.owner, body: { town: 'Lusaka', lat: -15.41672, lon: 28.28331 } });
    assert.equal(r.status, 200, r.text);
  });
});

describe('forecast and advice', () => {
  let w;
  before(async () => { w = (await app.request('GET', '/api/weather', { token: viewer })).body; });
  test('asks MET Norway with an identifying User-Agent and coordinates to 4 decimals', () => {
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/api\.met\.no\/weatherapi\/locationforecast\/2\.0\/compact\?lat=-15\.4167&lon=28\.2833$/);
    assert.match(calls[0].headers['User-Agent'], /^KeleteERP\/1\.0 ops@station\.example$/);
  });
  test('summarises today and credits the source', () => {
    assert.equal(w.available, true);
    assert.equal(w.town, 'Lusaka');
    assert.equal(w.today.date, today);
    assert.ok(w.today.max >= 35 && w.today.min <= 18, JSON.stringify(w.today));
    assert.equal(w.today.thunder, true);
    assert.equal(w.source, 'MET Norway (CC BY 4.0)');
  });
  test('advice for a very hot, stormy day', () => {
    const keys = w.advice.map((a) => a.key);
    for (const k of ['heat-people', 'hot', 'thunder', 'rain', 'swing']) assert.ok(keys.includes(k), `${k} in ${keys}`);
    assert.match(w.advice.find((a) => a.key === 'hot').text, /30,000 L petrol delivery .* about 285 L less/);
  });
  test('cached: a second look within 30 minutes asks nobody', async () => {
    await app.request('GET', '/api/weather', { token: staff.tokens.owner });
    assert.equal(calls.length, 1);
  });
  test('service down: the last good forecast is served, marked stale; with none, "not available"', async () => {
    for (const v of _cache.values()) v.expires = 0;
    mode = 'down';
    const s = (await app.request('GET', '/api/weather', { token: staff.tokens.owner })).body;
    assert.equal(s.available, true);
    assert.equal(s.stale, true);
    _cache.clear();
    const n = (await app.request('GET', '/api/weather', { token: staff.tokens.owner })).body;
    assert.equal(n.available, false);
    assert.deepEqual(n.advice, []);
    mode = 'ok';
  });
});

describe('rules', () => {
  test('expansion rule of thumb', () => {
    assert.equal(shrinkage(30000, 10, 'petrol'), 285);
    assert.equal(shrinkage(30000, 10, 'diesel'), 249);
    assert.equal(gradeKind('Diesel 50ppm'), 'diesel');
    assert.equal(gradeKind('Unleaded 95'), 'petrol');
    assert.equal(gradeKind('Paraffin'), 'paraffin');
  });
  test('cold night, humidity and wind; calm days say so', () => {
    const cold = adviceFor({ now: { humidity: 90, wind: 12 }, today: { max: 24, min: 6 } }).map((a) => a.key);
    assert.deepEqual(cold, ['cold', 'swing', 'condensation', 'wind']);
    assert.deepEqual(adviceFor({ now: {}, today: { max: 26, min: 18 } }).map((a) => a.key), ['calm']);
    assert.deepEqual(adviceFor(null).map((a) => a.key), ['calm']);
  });
  test('the delivery example uses the station\'s own tank size', () => {
    const a = adviceFor({ now: {}, today: { max: 31, min: 20 } }, [{ grade: 'Petrol', capacity: 15000 }]);
    assert.match(a.find((x) => x.key === 'hot').text, /15,000 L petrol delivery .* about 143 L less/);
  });
  test('summarise copes with an empty answer', () => {
    assert.equal(summarise({}, today), null);
  });
});
