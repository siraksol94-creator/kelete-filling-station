// UX-4 — what today's weather means for fuel at the station. Pure functions,
// unit-tested. Advice is practical and calm; numbers are rules of thumb and
// say so ("about").
//
// Physics used (rules of thumb, at normal ambient temperatures):
//   petrol expands/contracts about 0.00095 of its volume per °C,
//   diesel about 0.00083, paraffin about 0.00090.
// Underground tanks change temperature slowly, so the biggest effect at a
// station is at DELIVERY: fuel that arrives warmer than the tank shrinks as
// it cools, and reads less on the dip afterwards.

const COEFF = { petrol: 0.00095, diesel: 0.00083, paraffin: 0.0009 };

function gradeKind(name) {
  const n = String(name || '').toLowerCase();
  if (/diesel|dsl|ago|gasoil/.test(n)) return 'diesel';
  if (/paraffin|kerosene|ik\b/.test(n)) return 'paraffin';
  return 'petrol';
}

// Litres a delivery of `litres` loses (or gains, if negative) as it cools by `deltaC`.
function shrinkage(litres, deltaC, kind = 'petrol') {
  return Math.round((Number(litres) || 0) * (Number(deltaC) || 0) * (COEFF[kind] || COEFF.petrol));
}

const fmt = (n) => Math.round(n).toLocaleString('en-ZM');

// weather: { now: { temp, humidity, wind }, today: { max, min, rain_mm, thunder, symbol } }
// tanks:   [{ grade, capacity }]  (optional, to size the delivery example)
function adviceFor(weather, tanks = []) {
  const out = [];
  const now = (weather && weather.now) || {};
  const today = (weather && weather.today) || {};
  const max = Number(today.max), min = Number(today.min);
  const hasMax = Number.isFinite(max), hasMin = Number.isFinite(min);
  const rain = Number(today.rain_mm) || 0;
  const swing = hasMax && hasMin ? max - min : 0;

  // A delivery-sized example from the station's own biggest petrol (else any) tank.
  const petrolTank = tanks.filter((t) => gradeKind(t.grade) === 'petrol').sort((a, b) => b.capacity - a.capacity)[0]
    || tanks.slice().sort((a, b) => b.capacity - a.capacity)[0];
  const load = petrolTank ? Math.min(30000, Math.max(5000, Math.round((petrolTank.capacity || 0) / 1000) * 1000)) : 30000;
  const kind = petrolTank ? gradeKind(petrolTank.grade) : 'petrol';

  if (hasMax && max >= 35) {
    out.push({ key: 'heat-people', level: 'warn', icon: 'people', title: `Very hot (${Math.round(max)}°C)`,
      text: 'Make sure attendants have water and shade, and rotate who works in the sun.' });
  }
  if (hasMax && max >= 30) {
    out.push({ key: 'hot', level: 'watch', icon: 'heat', title: `Hot day (up to ${Math.round(max)}°C)`,
      text: `Petrol evaporates faster: keep fill-point caps and dip hatches closed. Don't fill containers or tanks to the brim — fuel expands in the heat. A ${fmt(load)} L ${kind} delivery that arrives about 10°C warmer than the tank can read about ${fmt(shrinkage(load, 10, kind))} L less once it cools — that's temperature, not theft.` });
  }
  if (hasMin && min <= 8) {
    out.push({ key: 'cold', level: 'info', icon: 'cold', title: `Cold night (down to ${Math.round(min)}°C)`,
      text: 'Fuel contracts in the cold, so early-morning dips read a little lower than afternoon ones. Compare dips taken at the same time of day.' });
  }
  if (swing >= 14) {
    out.push({ key: 'swing', level: 'info', icon: 'swing', title: `Big temperature swing (${Math.round(swing)}°C)`,
      text: 'Dip at the same time every day so readings compare fairly; small differences between morning and afternoon are normal.' });
  }
  if (today.thunder) {
    out.push({ key: 'thunder', level: 'warn', icon: 'thunder', title: 'Thunderstorms possible',
      text: 'Do not offload a tanker during lightning. Follow your safety procedure for pausing fuelling if lightning is close.' });
  }
  if (rain >= 1 || /rain|sleet|shower/.test(String(today.symbol || ''))) {
    out.push({ key: 'rain', level: 'watch', icon: 'rain', title: rain >= 10 ? `Heavy rain (about ${Math.round(rain)} mm)` : 'Rain expected',
      text: 'Check that fill-point lids and spill boxes are closed so water can\'t get into the tanks. Use water-finding paste on the dip stick after rain. Keep the forecourt free of slippery spills.' });
  }
  if (Number(now.humidity) >= 85 && swing >= 10) {
    out.push({ key: 'condensation', level: 'info', icon: 'drop', title: 'Humid with a big swing',
      text: 'Condensation can form inside partly empty tanks. Keeping tanks fuller and checking for water helps.' });
  }
  if (Number(now.wind) >= 10) {
    out.push({ key: 'wind', level: 'info', icon: 'wind', title: `Strong wind (${Math.round(now.wind)} m/s)`,
      text: 'Keep nozzles holstered between sales and watch for blown debris near the pumps.' });
  }
  if (!out.length) {
    out.push({ key: 'calm', level: 'ok', icon: 'ok', title: 'Mild conditions', text: 'No weather effects to watch for today. Normal operations.' });
  }
  return out;
}

module.exports = { adviceFor, shrinkage, gradeKind, COEFF };
