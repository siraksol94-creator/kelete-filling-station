// UX-4 — /api/weather: the station's weather and what it means for fuel.
//   GET  /api/weather            any logged-in user (read-only)
//   PUT  /api/weather/location   Administrators: { town, lat, lon }
const router = require('express').Router();
const db = require('../config/database');
const { auth, adminOnly } = require('../middleware/auth');
const bt = require('../config/businessTime');
const weather = require('../services/weather');
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
    const row = db.prepare('SELECT id FROM business_settings WHERE deleted_at IS NULL ORDER BY id LIMIT 1').get();
    if (!row) return res.status(400).json({ error: 'Business settings are not set up yet.' });
    db.prepare("UPDATE business_settings SET weather_town = ?, weather_lat = ?, weather_lon = ?, updated_at = datetime('now'), synced = 0 WHERE id = ?")
      .run(String(town).slice(0, 80), la, lo, row.id);
    res.json({ ok: true, town: String(town).slice(0, 80), lat: la, lon: lo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
