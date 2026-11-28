// UX-3 — this week's takings as stacked bars: fuel and shop (plain SVG, no
// chart library). Each bar has a tooltip; a text summary is read out to
// screen readers.
import React, { useEffect, useState } from 'react';
import { trendBars, niceMax } from './stationMetrics';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (ymd) => { const [y, m, d] = String(ymd).split('-').map(Number); return DAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] || ymd; };
// Axis labels stay short so they fit on a phone: 50,000 → 50k; 1,200,000 → 1.2m.
const axis = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}m` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : Math.round(n).toLocaleString('en-ZM'));
const k = (n) => `${(Number(n || 0) < 0 ? '−' : '')}K${Math.round(Math.abs(Number(n || 0))).toLocaleString('en-ZM')}`;

// On a phone the chart is drawn narrower (not just scaled down), so its
// labels stay readable.
function useNarrow() {
  const [q] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(max-width: 640px)') : null));
  const [narrow, setNarrow] = useState(!!(q && q.matches));
  useEffect(() => {
    if (!q) return undefined;
    const f = (e) => setNarrow(e.matches);
    if (q.addEventListener) q.addEventListener('change', f); else q.addListener(f);
    return () => { if (q.removeEventListener) q.removeEventListener('change', f); else q.removeListener(f); };
  }, [q]);
  return narrow;
}

export default function TrendBars({ rows, height = 190, today }) {
  const narrow = useNarrow();
  const bars = trendBars(rows);
  if (!bars.length) return <div className="k-muted" style={{ padding: 24, textAlign: 'center' }}>No sales this week yet.</div>;
  const max = niceMax(bars.map((b) => b.total), 100);
  const W = narrow ? 340 : 560, H = narrow ? 220 : height, padL = narrow ? 44 : 52, padB = 26, padT = 10;
  const plotH = H - padB - padT, slot = (W - padL) / bars.length, bw = Math.min(46, slot * 0.6);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const summary = bars.map((b) => `${dayName(b.date)} ${k(b.total)} (fuel ${k(b.fuel)}, shop ${k(b.shop)})`).join('; ');
  return (
    <figure className="k-trend" aria-label={`Takings this week: ${summary}`} role="img">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(max * t)} y2={y(max * t)} stroke="#e2e8f0" />
            <text x={padL - 8} y={y(max * t) + 4} fontSize="11" textAnchor="end" fill="#475569">{t === 0 ? '0' : axis(max * t)}</text>
          </g>
        ))}
        {bars.map((b, i) => {
          const x = padL + i * slot + (slot - bw) / 2;
          const isToday = b.date === today;
          return (
            <g key={b.date}>
              <title>{`${dayName(b.date)} ${b.date}: ${k(b.total)} — fuel ${k(b.fuel)}, shop ${k(b.shop)}`}</title>
              <rect x={x} y={y(b.total)} width={bw} height={Math.max(0, y(b.fuel) - y(b.total))} rx="3" fill="#6d28d9" />
              <rect x={x} y={y(b.fuel)} width={bw} height={Math.max(0, y(0) - y(b.fuel))} rx="3" fill="#0e7490" />
              <rect x={x + bw * 0.12} y={y(b.total)} width={bw * 0.18} height={Math.max(0, y(0) - y(b.total))} fill="#fff" opacity=".18" />
              <text x={x + bw / 2} y={H - 8} fontSize={narrow ? 10.5 : 11.5} textAnchor="middle" fill={isToday ? '#0f172a' : '#475569'} fontWeight={isToday ? 800 : 500}>{isToday ? 'Today' : dayName(b.date)}</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="k-trend-legend">
        <span><i style={{ background: '#0e7490' }} aria-hidden="true" />Fuel</span>
        <span><i style={{ background: '#6d28d9' }} aria-hidden="true" />Shop</span>
      </figcaption>
    </figure>
  );
}
