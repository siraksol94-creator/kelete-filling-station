// UX-3 — a dial for litres sold today per grade (original artwork, SVG).
// All dials on a screen share one scale (max) so they compare fairly.
import React from 'react';

const polar = (cx, cy, r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];

export default function GradeGauge({ grade, max, size = 150 }) {
  const litres = Math.max(0, Number(grade.litres) || 0);
  const frac = max > 0 ? Math.min(1, litres / max) : 0;
  const color = grade.color || '#0e7490';
  const cx = 60, cy = 58, r = 46;
  const a0 = Math.PI, a1 = Math.PI + Math.PI * frac;
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const [xe, ye] = polar(cx, cy, r, 2 * Math.PI);
  const [nx, ny] = polar(cx, cy, r - 12, a1);
  const fmtL = (n) => Math.round(n).toLocaleString('en-ZM');
  return (
    <figure className="k-gauge" style={{ width: size }} role="img"
      aria-label={`${grade.name}: ${fmtL(litres)} litres today, K ${Number(grade.amount || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2 })}`}>
      <svg viewBox="0 0 120 74" width={size} aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={`kg-${grade.grade_id}`} x1="0" x2="1"><stop offset="0" stopColor={color} stopOpacity=".55" /><stop offset="1" stopColor={color} /></linearGradient>
        </defs>
        <path d={`M${x0} ${y0} A${r} ${r} 0 0 1 ${xe} ${ye}`} fill="none" stroke="#e2e8f0" strokeWidth="11" strokeLinecap="round" />
        {frac > 0.002 && <path className="k-gauge-arc" d={`M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`} fill="none" stroke={`url(#kg-${grade.grade_id})`} strokeWidth="11" strokeLinecap="round" />}
        {[0, 0.25, 0.5, 0.75, 1].map((t) => { const [a, b] = polar(cx, cy, r + 8, Math.PI + Math.PI * t); const [c, d] = polar(cx, cy, r + 4, Math.PI + Math.PI * t); return <line key={t} x1={a} y1={b} x2={c} y2={d} stroke="#94a3b8" strokeWidth="1.2" />; })}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#0f172a" strokeWidth="2.6" strokeLinecap="round" className="k-gauge-needle" />
        <circle cx={cx} cy={cy} r="5" fill="#0f172a" /><circle cx={cx} cy={cy} r="2" fill="#f8fafc" />
      </svg>
      <figcaption>
        <span className="k-gauge-value">{fmtL(litres)} <small>L</small></span>
        <span className="k-gauge-name"><i style={{ background: color }} aria-hidden="true" />{grade.name}</span>
        <span className="k-gauge-amount">K {Number(grade.amount || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      </figcaption>
    </figure>
  );
}
