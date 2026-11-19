// UX-3 — a 3D-looking fuel tank (original artwork; SVG with lighting).
// Glass-walled cylinder, fuel in the grade's colour with a lit surface that
// ripples gently, a red dashed low-level line, the % on the tank.
// Decorative parts are aria-hidden; the label carries the facts.
import React from 'react';
import { tankStatus } from './stationMetrics';

let uid = 0;

// A filled wave: crests along `y`, filled down to `bottom`. It is wider than
// the tank so it can roll sideways (CSS moves it by one wavelength and loops).
function wave(y, amp, len, bottom) {
  let d = `M-60 ${bottom} L-60 ${y}`;
  for (let x = -60; x < 160; x += len) d += ` q${len / 4} ${-amp} ${len / 2} 0 t${len / 2} 0`;
  return `${d} L160 ${bottom} Z`;
}
export default function Tank3D({ tank, width = 96, showLabel = true }) {
  const st = tankStatus(tank);
  const id = React.useMemo(() => `kt${(uid += 1)}`, []);
  const color = tank.color || '#0e7490';
  const W = 100, H = 150, top = 16, bot = 132, rx = 40, ry = 9, cx = 50;
  const h = bot - top;
  const level = bot - h * st.pct;
  const lowY = st.lowPct != null ? bot - h * st.lowPct : null;
  const tone = st.level === 'low' ? '#b91c1c' : st.level === 'watch' ? '#b45309' : '#0f172a';
  const label = `${tank.code}${tank.grade ? ` · ${tank.grade}` : ''}: ${Math.round(st.pct * 100)}% — ${Math.round(st.litres).toLocaleString('en-ZM')} of ${Math.round(st.capacity).toLocaleString('en-ZM')} L${st.level === 'low' ? ' — LOW' : ''}`;
  return (
    <figure className={`k-tank3d k-tank-${st.level}`} style={{ width }} aria-label={label} role="img">
      <svg viewBox={`0 0 ${W} ${H}`} width={width} aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`${id}-glass`} x1="0" x2="1">
            <stop offset="0" stopColor="#94a3b8" stopOpacity=".55" /><stop offset=".22" stopColor="#f8fafc" stopOpacity=".9" />
            <stop offset=".6" stopColor="#e2e8f0" stopOpacity=".6" /><stop offset="1" stopColor="#64748b" stopOpacity=".7" />
          </linearGradient>
          <linearGradient id={`${id}-fuel`} x1="0" x2="1">
            <stop offset="0" stopColor={color} stopOpacity=".95" /><stop offset=".3" stopColor={color} stopOpacity=".7" />
            <stop offset=".75" stopColor={color} stopOpacity=".88" /><stop offset="1" stopColor="#0f172a" stopOpacity=".55" />
          </linearGradient>
          <radialGradient id={`${id}-surf`} cx=".4" cy=".4" r=".7">
            <stop offset="0" stopColor="#fff" stopOpacity=".75" /><stop offset="1" stopColor={color} stopOpacity=".9" />
          </radialGradient>
          <clipPath id={`${id}-clip`}><path d={`M${cx - rx} ${top} V${bot} A${rx} ${ry} 0 0 0 ${cx + rx} ${bot} V${top} Z`} /></clipPath>
          <clipPath id={`${id}-below`}><rect x={cx - rx} y={level + 2} width={rx * 2} height={Math.max(0, bot + ry - level)} /></clipPath>
        </defs>
        {/* shadow */}
        <ellipse cx={cx} cy={bot + 9} rx={rx + 6} ry="5" fill="#0f172a" opacity=".12" />
        {/* back wall */}
        <path d={`M${cx - rx} ${top} V${bot} A${rx} ${ry} 0 0 0 ${cx + rx} ${bot} V${top}`} fill={`url(#${id}-glass)`} />
        {/* fuel — fills up on arrival, two waves roll across the top, bubbles rise, light shimmers */}
        {st.pct > 0.003 && (
          <g clipPath={`url(#${id}-clip)`}>
            <g className="k-tank-fill" style={{ transformOrigin: `${cx}px ${bot + ry}px` }}>
              <ellipse className="k-tank-surface" cx={cx} cy={level} rx={rx} ry={ry} fill={`url(#${id}-surf)`} />
              <path className="k-wave k-wave-back" d={wave(level - 1, 2.6, 36, bot + ry)} fill={color} opacity=".55" />
              <path className="k-wave k-wave-front" d={wave(level + 1.5, 2, 28, bot + ry)} fill={`url(#${id}-fuel)`} />
              <g clipPath={`url(#${id}-below)`}>
                {[0, 1, 2, 3].map((i) => (
                  <circle key={i} className="k-bubble" cx={cx - 24 + i * 15} cy={bot - 4} r={1.3 + (i % 2) * 0.8} fill="#fff" opacity=".7"
                    style={{ animationDelay: `${i * 0.85}s`, '--rise': `${-(bot - level - 6)}px` }} />
                ))}
                <rect className="k-shimmer" x={cx - rx} y={level} width="10" height={bot - level + ry} fill="#fff" opacity=".18" />
              </g>
            </g>
          </g>
        )}
        {/* low-level line */}
        {lowY != null && (
          <g className={st.level === 'low' ? 'k-low-pulse' : ''}>
            <line x1={cx - rx} x2={cx + rx} y1={lowY} y2={lowY} stroke="#b91c1c" strokeWidth="1.6" strokeDasharray="4 3" />
            <text x={cx + rx - 2} y={lowY - 3} fontSize="7" fontWeight="800" fill="#b91c1c" textAnchor="end" fontFamily="Inter, system-ui, sans-serif">LOW</text>
          </g>
        )}
        {/* glass highlight + rim */}
        <path d={`M${cx - rx + 9} ${top + 8} V${bot - 4}`} stroke="#fff" strokeOpacity=".55" strokeWidth="5" strokeLinecap="round" />
        <path d={`M${cx - rx} ${top} V${bot} A${rx} ${ry} 0 0 0 ${cx + rx} ${bot} V${top}`} fill="none" stroke="#475569" strokeWidth="1.6" />
        <ellipse cx={cx} cy={top} rx={rx} ry={ry} fill="#cbd5e1" stroke="#475569" strokeWidth="1.6" />
        <ellipse cx={cx} cy={top} rx={rx - 9} ry={ry - 3} fill="#e2e8f0" />
        <rect x={cx - 7} y={top - 7} width="14" height="7" rx="2" fill="#475569" />
        {/* % on the tank */}
        <g>
          <rect x={cx - 19} y={(top + bot) / 2 - 9} width="38" height="18" rx="9" fill="rgba(15,23,42,.82)" />
          <text x={cx} y={(top + bot) / 2 + 4.5} fontSize="12" fontWeight="800" fill="#fff" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">{Math.round(st.pct * 100)}%</text>
        </g>
      </svg>
      {showLabel && (
        <figcaption>
          <span className="k-tank-name"><strong>{tank.code}</strong>{tank.grade && <> · {tank.grade}</>}</span>
          <span className="k-tank-litres" style={{ color: tone }}>{Math.round(st.litres).toLocaleString('en-ZM')} L</span>
          {tank.days_cover != null && (
            <span className={`k-tank-cover ${tank.days_cover <= 2 ? 'k-cover-short' : tank.days_cover <= 4 ? 'k-cover-watch' : ''}`}
              title={`At last week's average of ${Math.round(tank.avg_daily_litres).toLocaleString('en-ZM')} L a day (all ${tank.grade || ''} tanks together)`}>
              ≈ {tank.days_cover < 10 ? tank.days_cover.toFixed(1) : Math.round(tank.days_cover)} days left
            </span>
          )}
          {st.level === 'low' && <span className="k-tank-flag">Low</span>}
        </figcaption>
      )}
    </figure>
  );
}
