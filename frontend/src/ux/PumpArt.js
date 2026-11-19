// UX-8 — a fuel dispenser drawn in 3D-ish SVG (original artwork): a lit
// canopy band with the pump code, a price screen listing each grade's price
// per litre, and one hose per nozzle in its grade colour, hanging from its
// holster. Decorative (aria-hidden); the nozzle list beside it carries the facts.
// Also: <MeterDigits value /> — a totaliser that reads like the pump's own.
import React from 'react';

let uid = 0;

export default function PumpArt({ code, nozzles = [], width = 150, live = false }) {
  const id = React.useMemo(() => `kpa${(uid += 1)}`, []);
  const n = Math.max(1, Math.min(4, nozzles.length || 1));
  const W = 150, H = 230;
  const grades = [];
  for (const z of nozzles) if (z.grade_name && !grades.find((g) => g.name === z.grade_name)) grades.push({ name: z.grade_name, color: z.grade_color || '#64748b', price: Number(z.price_per_litre) || 0 });
  const slots = Array.from({ length: n }, (_, i) => 26 + ((W - 52) * (i + 0.5)) / n);
  return (
    <svg className={`k-pump${live ? ' is-live' : ''}`} width={width} height={(width * H) / W} viewBox={`0 0 ${W} ${H}`} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-body`} x1="0" x2="1">
          <stop offset="0" stopColor="#1e293b" /><stop offset=".55" stopColor="#334155" /><stop offset="1" stopColor="#0f172a" />
        </linearGradient>
        <linearGradient id={`${id}-side`} x1="0" x2="1">
          <stop offset="0" stopColor="#0b1220" /><stop offset="1" stopColor="#1e293b" />
        </linearGradient>
        <linearGradient id={`${id}-screen`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#052e2b" /><stop offset="1" stopColor="#022c22" />
        </linearGradient>
      </defs>
      <ellipse cx="75" cy="222" rx="66" ry="6" fill="#0f172a" opacity=".18" />
      {/* island plinth */}
      <path d="M12 206 h126 l-8 12 h-110 z" fill="#cbd5e1" /><rect x="12" y="200" width="126" height="7" rx="2" fill="#e2e8f0" />
      {/* side face for depth */}
      <path d="M118 30 l14 -8 v170 l-14 8 z" fill={`url(#${id}-side)`} />
      <path d="M32 30 l14 -8 h86 l-14 8 z" fill="#475569" />
      {/* body */}
      <rect x="18" y="30" width="100" height="172" rx="10" fill={`url(#${id}-body)`} />
      <rect x="18" y="30" width="100" height="22" rx="10" fill="#b91c1c" />
      <rect x="18" y="44" width="100" height="8" fill="#b91c1c" />
      <text x="68" y="46" textAnchor="middle" className="k-pump-code">{code}</text>
      <rect className="k-pump-glow" x="22" y="52" width="92" height="2.5" fill="#fbbf24" opacity=".85" />
      {/* price screen */}
      <rect x="28" y="62" width="80" height={14 + 14 * Math.max(1, grades.length)} rx="5" fill={`url(#${id}-screen)`} stroke="#0f766e" strokeWidth="1" />
      {(grades.length ? grades : [{ name: '—', color: '#64748b', price: 0 }]).slice(0, 4).map((g, i) => (
        <g key={g.name}>
          <rect x="33" y={70 + i * 14} width="5" height="9" rx="1.5" fill={g.color} />
          <text x="42" y={78 + i * 14} className="k-pump-lcd-name">{g.name.slice(0, 6).toUpperCase()}</text>
          <text x="104" y={78 + i * 14} textAnchor="end" className="k-pump-lcd">{g.price ? g.price.toFixed(2) : '--.--'}</text>
        </g>
      ))}
      {/* holsters and hoses */}
      {slots.map((x, i) => {
        const z = nozzles[i] || {};
        const c = z.grade_color || '#64748b';
        return (
          <g key={i}>
            <path d={`M${x} 150 C ${x - 4} 176, ${x + 18} 186, ${x + 10} 204`} fill="none" stroke="#0b1220" strokeWidth="5.5" strokeLinecap="round" />
            <path d={`M${x} 150 C ${x - 4} 176, ${x + 18} 186, ${x + 10} 204`} fill="none" stroke={c} strokeWidth="3" strokeLinecap="round" opacity=".9" />
            <rect x={x - 8} y="132" width="16" height="22" rx="3" fill="#0b1220" stroke="#475569" />
            <rect x={x - 5} y="128" width="10" height="9" rx="2" fill={c} />
            <text x={x} y="146" textAnchor="middle" className="k-pump-noz">{(z.code || '').slice(0, 3)}</text>
          </g>
        );
      })}
      {/* highlight */}
      <rect x="24" y="58" width="5" height="138" rx="2.5" fill="#fff" opacity=".07" />
    </svg>
  );
}

// 012,345.67 L — the meter's totaliser, digit by digit (fixed width).
export function MeterDigits({ value, label }) {
  const v = Number(value) || 0;
  const [whole, frac] = Math.abs(v).toFixed(2).split('.');
  const padded = whole.padStart(7, '0');
  return (
    <span className="k-meter" role="img" aria-label={`${label ? `${label}: ` : ''}${v.toLocaleString('en-ZM', { minimumFractionDigits: 2 })} litres`}>
      {padded.split('').map((d, i) => <b key={i} className={i < padded.length - whole.length ? 'is-pad' : ''}>{d}</b>)}
      <i>.</i>
      {frac.split('').map((d, i) => <b key={`f${i}`} className="is-frac">{d}</b>)}
      <em>L</em>
    </span>
  );
}
