// GET /api/fuel-profit?from=YYYY-MM-DD&to=YYYY-MM-DD — the forecourt's side of
// the Profit Report: litres, sales, cost, margin and margin per litre by grade
// from closed shifts, the shifts' cash short/over, and the credit-ticket fuel
// that already sits inside the shop's revenue. Read-only. Who may call it is
// decided by the permission gate (the Profit Report screen's permissions).
const router = require('express').Router();
const db = require('../config/database');
const { auth } = require('../middleware/auth');
const bt = require('../config/businessTime');
const { fuelProfit } = require('../services/fuelProfit');

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

router.get('/', auth, (req, res) => {
  try {
    const today = bt.businessDate();
    const from = isDate(req.query.from) ? req.query.from : today;
    const to = isDate(req.query.to) ? req.query.to : from;
    if (from > to) return res.status(400).json({ error: '"from" must be on or before "to".' });
    res.json(fuelProfit(db, { from, to }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
