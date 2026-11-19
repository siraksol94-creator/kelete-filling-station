// UX-4 — /api/weather: the station's weather and what it means for fuel.
//   GET  /api/weather            any logged-in user (read-only)
//   PUT  /api/weather/location   Administrators: { town, lat, lon }
const router = require('express').Router();
const db = require('../config/database');
const { auth, adminOnly } = require('../middleware/auth');
const bt = require('../config/businessTime');
const weather = require('../services/weather');
const syncConfig = require('../config/syncConfig');
const { randomUUID } = require('crypto');
const { adviceFor } = require('../services/weatherAdvice');

function settings() {
  const cols = db.prepare('PRAGMA table_info(business_settings)').all().map((c) => c.name);
  if (!cols.includes('weather_lat')) return {};
  return db.prepare('SELECT business_email, weather_town, weather_lat, weather_lon FROM business_settings WHERE deleted_at IS NULL ORDER BY id LIMIT 1').get() || {};
}

router.get('/', auth, async (req, res) => {
  try {
    const s = settings();
    const isAdmin = req.user && req.user.role === 'Administrator';
    if (s.weather_lat == null || s.weather_lon == null) return res.json({ configured: false, can_set: isAdmin });
    const contact = process.env.KELETE_WEATHER_CONTACT || s.business_email || '';
    const w = await weather.forecast({ lat: s.weather_lat, lon: s.weather_lon, contact, today: bt.businessDate(), fetcher: req.app.get('weatherFetcher') || undefined });
    let tanks = [];
    try {
      tanks = db.prepare(`SELECT t.capacity_litres AS capacity, g.name AS grade FROM tanks t LEFT JOIN fuel_grades g ON g.id = t.fuel_grade_id`).all();
    } catch (_) { /* no fuel tables */ }
    res.json({
      configured: true, can_set: isAdmin, town: s.weather_town, lat: s.weather_lat, lon: s.weather_lon,
      ...w,
      advice: w.available ? adviceFor(w, tanks) : [],
      source: 'MET Norway (CC BY 4.0)',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/location', auth, adminOnly, (req, res) => {
  try {
    const { town = '', lat, lon } = req.body || {};
    const la = Number(lat), lo = Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo) || la < -90 || la > 90 || lo < -180 || lo > 180) {
      return res.status(400).json({ error: 'Enter a valid latitude (-90 to 90) and longitude (-180 to 180).' });
    }
    let row = db.prepare('SELECT id FROM business_settings WHERE deleted_at IS NULL ORDER BY id LIMIT 1').get();
    if (!row) {
      // No business settings yet (a fresh install): start the record the
      // same way the Settings screen does — the rest is filled in there.
      const cols = db.prepare('PRAGMA table_info(business_settings)').all().map((c) => c.name);
      const { branchId, deviceId } = syncConfig.getConfig();
      const fields = { sync_id: randomUUID(), tenant_id: syncConfig.getTenantId(req), branch_id: branchId, device_id: deviceId, synced: 0 };
      const use = Object.keys(fields).filter((k) => cols.includes(k));
      const info = use.length
        ? db.prepare(`INSERT INTO business_settings (${use.join(', ')}) VALUES (${use.map(() => '?').join(', ')})`).run(...use.map((k) => fields[k]))
        : db.prepare('INSERT INTO business_settings DEFAULT VALUES').run();
      row = { id: info.lastInsertRowid };
    }
    db.prepare("UPDATE business_settings SET weather_town = ?, weather_lat = ?, weather_lon = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?")
      .run(String(town).slice(0, 80), la, lo, row.id);
    res.json({ ok: true, town: String(town).slice(0, 80), lat: la, lon: lo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
