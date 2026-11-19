// UX-2 — forecourt illustration for the sign-in page (original artwork).
// Decorative only (aria-hidden); still under "reduce motion".
import React from 'react';

export default function ForecourtArt({ className = '' }) {
  return (
    <svg className={`k-forecourt ${className}`} viewBox="0 0 480 300" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="kf-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1e293b" /><stop offset="1" stopColor="#0f172a" /></linearGradient>
        <linearGradient id="kf-canopy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#dc2626" /><stop offset="1" stopColor="#991b1b" /></linearGradient>
        <radialGradient id="kf-glow" cx=".5" cy="0" r=".8"><stop offset="0" stopColor="#fde68a" stopOpacity=".55" /><stop offset="1" stopColor="#fde68a" stopOpacity="0" /></radialGradient>
      </defs>
      <rect width="480" height="300" rx="20" fill="url(#kf-sky)" />
      {[[40, 30], [120, 60], [400, 40], [330, 22], [450, 90], [70, 110]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="1.6" fill="#e2e8f0" className="k-star" style={{ animationDelay: `${i * 0.5}s` }} />)}
      {/* canopy */}
      <rect x="60" y="78" width="360" height="26" rx="6" fill="url(#kf-canopy)" />
      <rect x="60" y="100" width="360" height="5" fill="#7f1d1d" />
      <rect x="196" y="84" width="88" height="14" rx="3" fill="#fef3c7" />
      <text x="240" y="95" textAnchor="middle" fontSize="11" fontWeight="800" fill="#7f1d1d" fontFamily="Inter, system-ui, sans-serif" letterSpacing="2">KELETE</text>
      <path d="M90 105 L60 230 L420 230 L390 105 Z" fill="url(#kf-glow)" />
      <rect x="92" y="105" width="8" height="125" fill="#475569" /><rect x="380" y="105" width="8" height="125" fill="#475569" />
      {/* pumps */}
      {[150, 290].map((x) => (
        <g key={x}>
          <rect x={x} y="150" width="40" height="80" rx="6" fill="#0e7490" />
          <rect x={x + 6} y="158" width="28" height="17" rx="3" fill="#ecfeff" />
          <text x={x + 20} y="170.5" textAnchor="middle" fontSize="9" fontWeight="700" fill="#0f172a" fontFamily="ui-monospace, Menlo, Consolas, monospace">K 412</text>
          <rect x={x + 8} y="182" width="24" height="4" rx="2" fill="#164e63" />
          <rect x={x - 4} y="226" width="48" height="6" rx="3" fill="#164e63" />
        </g>
      ))}
      {/* car at pump 2 with hose */}
      <path d="M330 175 C 350 175, 352 205, 340 210" fill="none" stroke="#0f172a" strokeWidth="4" strokeLinecap="round" />
      <path className="k-fuel-flow" d="M330 175 C 350 175, 352 205, 340 210" fill="none" stroke="#fbbf24" strokeWidth="1.8" strokeLinecap="round" strokeDasharray="3 6" />
      <g transform="translate(318 186)">
        <path d="M0 30 L8 14 Q11 8 19 8 L52 8 Q59 8 64 14 L73 23 L84 25 Q89 27 89 31 L89 36 L0 36 Z" fill="#f8fafc" />
        <path d="M20 12 L33 12 L33 21 L13 21 Z M36 12 L50 12 Q56 12 60 18 L61 21 L36 21 Z" fill="#7dd3fc" />
        <circle cx="20" cy="36" r="8" fill="#0f172a" /><circle cx="20" cy="36" r="3" fill="#94a3b8" />
        <circle cx="70" cy="36" r="8" fill="#0f172a" /><circle cx="70" cy="36" r="3" fill="#94a3b8" />
      </g>
      {/* ground */}
      <rect x="0" y="232" width="480" height="68" rx="0" fill="#1e293b" />
      <rect x="0" y="232" width="480" height="3" fill="#334155" />
      {[30, 110, 190, 270, 350, 430].map((x) => <rect key={x} x={x} y="262" width="40" height="4" rx="2" fill="#475569" />)}
      <rect x="0" y="280" width="480" height="20" fill="#0f172a" />
      <rect y="292" width="480" height="8" rx="0" fill="#0f172a" />
    </svg>
  );
}
