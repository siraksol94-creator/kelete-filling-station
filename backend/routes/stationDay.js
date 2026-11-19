// UX-10 — GET /api/station-day?date=YYYY-MM-DD : the station's day as work
// done (shifts closed, cash counted, tanks dipped, approved) and the dip
// streak. Read-only; any signed-in user who can open the fuel screens.
const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const bt = require('../config/businessTime');
const { stationDay } = require('../services/stationDay');

router.get('/', auth, (req, res) => {
  try {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? req.query.date : bt.businessDate();
    res.json(stationDay(db, date) || { date, steps: [], sealed: false, dip_streak: 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
