// UX-7 — per tank, for the Tanks screen: space left, the last dip, the last
// delivery and roughly how many days the fuel lasts at last week's pace.
// Read-only; nothing here changes a tank, a dip or a delivery.
const { stationToday } = require('./stationOverview');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const has = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);

function tankInsights(db, today) {
  const out = {};
  if (!has(db, 'tanks')) return { today, tanks: out };
  const tanks = db.prepare('SELECT id, capacity_litres, current_volume FROM tanks').all();
  for (const t of tanks) {
    out[t.id] = {
      space_left: Math.max(0, Math.round((num(t.capacity_litres) - num(t.current_volume)) * 10) / 10),
      avg_daily_litres: null, days_cover: null, last_dip: null, last_delivery: null,
    };
  }
  try {
    for (const t of stationToday(db, today).tanks || []) {
      if (out[t.id]) { out[t.id].avg_daily_litres = t.avg_daily_litres ?? null; out[t.id].days_cover = t.days_cover ?? null; }
    }
  } catch (_) { /* no sales history yet */ }
  if (has(db, 'tank_dips')) {
    const dips = db.prepare(`
      SELECT d.tank_id, d.dip_date, d.measured_litres, d.book_litres, d.variance, d.posted_adjustment_id
        FROM tank_dips d
       WHERE d.id = (SELECT d2.id FROM tank_dips d2 WHERE d2.tank_id = d.tank_id ORDER BY d2.dip_date DESC, d2.id DESC LIMIT 1)`).all();
    for (const d of dips) {
      if (out[d.tank_id]) out[d.tank_id].last_dip = { date: d.dip_date, measured: num(d.measured_litres), book: num(d.book_litres), variance: num(d.variance), posted: d.posted_adjustment_id != null };
    }
  }
  if (has(db, 'fuel_deliveries')) {
    const dels = db.prepare(`
      SELECT f.tank_id, f.delivery_date, f.litres_delivered, f.delivery_number
        FROM fuel_deliveries f
       WHERE f.id = (SELECT f2.id FROM fuel_deliveries f2 WHERE f2.tank_id = f.tank_id ORDER BY f2.delivery_date DESC, f2.id DESC LIMIT 1)`).all();
    for (const f of dels) {
      if (out[f.tank_id]) out[f.tank_id].last_delivery = { date: f.delivery_date, litres: num(f.litres_delivered), number: f.delivery_number };
    }
  }
  return { today, tanks: out };
}

module.exports = { tankInsights };
