// UX-8 — a small fuel tanker (original drawing) for the Deliveries screen:
// the timeline marker and the empty state. Decorative.
import React from 'react';

export default function TankerArt({ width = 120, color = '#0e7490', moving = false }) {
  return (
    <svg className={`k-tanker${moving ? ' is-moving' : ''}`} width={width} height={width * 0.5} viewBox="0 0 120 60" aria-hidden="true" focusable="false">
      <ellipse cx="60" cy="56" rx="54" ry="3" fill="#0f172a" opacity=".12" />
      {/* tank barrel */}
      <rect x="6" y="14" width="74" height="28" rx="14" fill="#e2e8f0" stroke="#475569" strokeWidth="1.5" />
      <rect x="10" y="17" width="66" height="6" rx="3" fill="#fff" opacity=".7" />
      <rect x="6" y="30" width="74" height="5" fill={color} opacity=".85" />
      <rect x="30" y="9" width="10" height="6" rx="1.5" fill="#64748b" />
      <rect x="52" y="9" width="10" height="6" rx="1.5" fill="#64748b" />
      {/* cab */}
      <path d="M82 22 h18 l12 12 v10 h-30 z" fill="#b91c1c" stroke="#7f1d1d" strokeWidth="1.2" />
      <path d="M88 25 h10 l8 8 h-18 z" fill="#bae6fd" />
      <rect x="4" y="42" width="110" height="5" rx="2" fill="#334155" />
      {/* wheels */}
      {[20, 38, 96].map((x) => (
        <g key={x} className="k-tanker-wheel" style={{ transformOrigin: `${x}px 48px` }}>
          <circle cx={x} cy="48" r="7" fill="#0f172a" />
          <circle cx={x} cy="48" r="3" fill="#94a3b8" />
          <rect x={x - 0.8} y="42" width="1.6" height="12" fill="#475569" />
        </g>
      ))}
    </svg>
  );
}
