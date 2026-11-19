// UX-4 — animated weather icons (original artwork, SVG + CSS): the sun turns,
// clouds drift, rain falls, lightning flickers. MET symbol codes in, picture out.
import React from 'react';

import { kindOf, labelOf } from './weatherKind';
export { kindOf, labelOf };

const Cloud = ({ x = 0, y = 0, s = 1, fill = '#f8fafc', cls = 'k-wx-cloud' }) => (
  <g className={cls} transform={`translate(${x} ${y}) scale(${s})`}>
    <path d="M14 34 Q4 34 4 25 Q4 16 14 16 Q17 6 28 6 Q40 6 42 18 Q52 18 52 26 Q52 34 42 34 Z" fill={fill} stroke="#94a3b8" strokeWidth="1.4" />
  </g>
);

export default function WeatherIcon({ symbol, size = 64 }) {
  const k = kindOf(symbol);
  const sun = (
    <g className="k-wx-sun">
      <g className="k-wx-rays">{Array.from({ length: 8 }).map((_, i) => <rect key={i} x="30.5" y="2" width="3" height="9" rx="1.5" fill="#f59e0b" transform={`rotate(${i * 45} 32 32)`} />)}</g>
      <circle cx="32" cy="32" r="13" fill="url(#k-wx-sun)" />
    </g>
  );
  const moon = <path className="k-wx-moon" d="M40 14 A18 18 0 1 0 50 44 A14 14 0 1 1 40 14 Z" fill="#fde68a" stroke="#d97706" strokeWidth="1.2" />;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={`k-wx k-wx-${k}`}>
      <defs><radialGradient id="k-wx-sun" cx=".4" cy=".4" r=".7"><stop offset="0" stopColor="#fef3c7" /><stop offset=".55" stopColor="#fbbf24" /><stop offset="1" stopColor="#f59e0b" /></radialGradient></defs>
      {k === 'sun' && sun}
      {k === 'night' && moon}
      {k === 'partly' && <><g transform="translate(-8 -8)">{sun}</g><Cloud x={10} y={24} s={0.95} /></>}
      {k === 'night-partly' && <><g transform="translate(-10 -10) scale(.8)">{moon}</g><Cloud x={10} y={24} s={0.95} /></>}
      {(k === 'cloud' || k === 'fog') && <><Cloud x={2} y={10} s={0.8} fill="#e2e8f0" cls="k-wx-cloud k-wx-slow" /><Cloud x={8} y={20} /></>}
      {k === 'fog' && [44, 50, 56].map((y, i) => <rect key={y} className="k-wx-fog" x="8" y={y} width="48" height="3" rx="1.5" fill="#94a3b8" style={{ animationDelay: `${i * 0.4}s` }} />)}
      {(k === 'rain' || k === 'thunder' || k === 'sleet') && (
        <>
          <Cloud x={4} y={6} fill="#cbd5e1" />
          {[16, 26, 36, 46].map((x, i) => <line key={x} className="k-wx-drop" x1={x} y1="44" x2={x - 3} y2="52" stroke={k === 'sleet' ? '#94a3b8' : '#2563eb'} strokeWidth="2.4" strokeLinecap="round" style={{ animationDelay: `${i * 0.22}s` }} />)}
        </>
      )}
      {k === 'thunder' && <path className="k-wx-bolt" d="M34 36 L26 50 L33 50 L29 62 L42 44 L35 44 L39 36 Z" fill="#facc15" stroke="#b45309" strokeWidth="1" />}
    </svg>
  );
}
