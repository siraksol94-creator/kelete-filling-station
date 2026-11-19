// UX-4 — MET Norway symbol code → which picture to draw (pure; tested in CI).
export function kindOf(symbol) {
  const s = String(symbol || '');
  if (/thunder/.test(s)) return 'thunder';
  if (/snow|sleet/.test(s)) return 'sleet';
  if (/rain|shower/.test(s)) return 'rain';
  if (/fog/.test(s)) return 'fog';
  if (/^cloudy/.test(s)) return 'cloud';
  if (/partlycloudy|fair/.test(s)) return /night/.test(s) ? 'night-partly' : 'partly';
  if (/clearsky/.test(s)) return /night/.test(s) ? 'night' : 'sun';
  return 'partly';
}

const LABELS = { thunder: 'Thunderstorm', sleet: 'Sleet', rain: 'Rain', fog: 'Fog', cloud: 'Cloudy', partly: 'Partly cloudy', 'night-partly': 'Partly cloudy', night: 'Clear night', sun: 'Sunny' };
export const labelOf = (symbol) => LABELS[kindOf(symbol)];
