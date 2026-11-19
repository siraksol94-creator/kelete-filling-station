// UX-2 — the fuelling-car loader (original artwork, plain SVG + CSS).
//
//   <FuelLoader />                     — card-sized, with a rotating message
//   <FuelLoader size="lg" message="…"/> — full-screen start-up
//   <FuelCar />                        — the little car on its own (activity bar)
//
// Respects "reduce motion": the picture stays still and the text still says
// what is happening. Screen readers hear the message once (role="status").
import React, { useEffect, useState } from 'react';

const MESSAGES = [
  'Fuelling up your figures…',
  'Reading the meters…',
  'Dipping the tanks…',
  'Counting the litres…',
  'Topping up the totals…',
];

export function FuelCar({ width = 34, className = '' }) {
  return (
    <svg className={`k-fuelcar ${className}`} width={width} viewBox="0 0 64 32" aria-hidden="true" focusable="false">
      <path d="M6 22 L10 13 Q12 9 17 9 L37 9 Q42 9 46 13 L52 18 L58 19 Q61 20 61 23 L61 25 L6 25 Z" fill="var(--k-car, #b91c1c)" />
      <path d="M18 12 L26 12 L26 17 L13 17 Z M29 12 L36 12 Q40 12 43 16 L43 17 L29 17 Z" fill="#e0f2fe" />
      <circle cx="18" cy="25" r="5" fill="#111827" /><circle cx="18" cy="25" r="2" fill="#9ca3af" />
      <circle cx="48" cy="25" r="5" fill="#111827" /><circle cx="48" cy="25" r="2" fill="#9ca3af" />
      <rect x="57" y="20" width="4" height="2" rx="1" fill="#fde68a" />
    </svg>
  );
}

export default function FuelLoader({ size = 'md', message, rotate = true }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (message || !rotate) return undefined;
    const id = setInterval(() => setI((n) => (n + 1) % MESSAGES.length), 1800);
    return () => clearInterval(id);
  }, [message, rotate]);
  const text = message || MESSAGES[i];
  const w = size === 'lg' ? 260 : size === 'sm' ? 140 : 200;
  return (
    <div className={`k-fuel-loader k-fuel-loader-${size}`} role="status" aria-live="polite">
      <svg width={w} viewBox="0 0 240 120" aria-hidden="true" focusable="false">
        {/* forecourt */}
        <rect x="0" y="100" width="240" height="4" rx="2" fill="#cbd5e1" />
        {/* pump */}
        <rect x="18" y="26" width="46" height="74" rx="7" fill="#0e7490" />
        <rect x="24" y="33" width="34" height="20" rx="3" fill="#ecfeff" />
        <g className="k-pump-digits" fontFamily="ui-monospace, Menlo, Consolas, monospace" fontSize="11" fontWeight="700" fill="#0f172a">
          <text x="41" y="47" textAnchor="middle" className="k-d1">12.40</text>
          <text x="41" y="47" textAnchor="middle" className="k-d2">25.85</text>
          <text x="41" y="47" textAnchor="middle" className="k-d3">39.10</text>
        </g>
        <rect x="26" y="60" width="30" height="5" rx="2.5" fill="#164e63" />
        <rect x="14" y="96" width="54" height="6" rx="3" fill="#164e63" />
        <rect x="64" y="40" width="7" height="16" rx="3" fill="#164e63" />
        {/* hose with flowing fuel */}
        <path d="M71 50 C 98 50, 104 90, 128 74" fill="none" stroke="#0f172a" strokeWidth="5" strokeLinecap="round" />
        <path className="k-fuel-flow" d="M71 50 C 98 50, 104 90, 128 74" fill="none" stroke="#fbbf24" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="4 7" />
        {/* car */}
        <g className="k-car-bob">
          <path d="M120 88 L127 70 Q130 63 139 63 L176 63 Q184 63 190 70 L200 80 L212 82 Q218 84 218 89 L218 94 L120 94 Z" fill="var(--k-car, #b91c1c)" />
          <path d="M141 68 L156 68 L156 78 L133 78 Z M160 68 L174 68 Q181 68 186 75 L187 78 L160 78 Z" fill="#e0f2fe" />
          <rect x="124" y="73" width="7" height="5" rx="1.5" fill="#7f1d1d" />
          <circle cx="141" cy="94" r="9" fill="#111827" /><circle cx="141" cy="94" r="3.5" fill="#cbd5e1" />
          <circle cx="196" cy="94" r="9" fill="#111827" /><circle cx="196" cy="94" r="3.5" fill="#cbd5e1" />
          <rect x="212" y="85" width="6" height="3" rx="1.5" fill="#fde68a" />
          {/* fuel gauge filling up */}
          <g transform="translate(150 40)">
            <rect x="0" y="0" width="44" height="10" rx="5" fill="#fff" stroke="#0f172a" strokeWidth="1.5" />
            <rect className="k-gauge-fill" x="2" y="2" width="40" height="6" rx="3" fill="#16a34a" />
            <path d="M-8 2 h4 v6 h-4 z M-6 0 v2" fill="#0f172a" />
          </g>
        </g>
      </svg>
      <div className="k-fuel-loader-text">{text}</div>
    </div>
  );
}
