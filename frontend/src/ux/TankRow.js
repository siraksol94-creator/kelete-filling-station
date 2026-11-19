// UX-4 — a row of tanks where plumbed tanks (same group_code, e.g. T1 + T3)
// sit together in one soft bay, joined at the base by a glass pipe. Fuel
// drifts slowly through the pipe from the fuller tank toward the emptier
// one — the way connected tanks settle — and sways gently when they're level.
// Decorative parts are aria-hidden; each group has a plain-words label.
import React from 'react';
import Tank3D from './Tank3D';
import { groupTanks, groupLabel } from './tankGroups';

const L = (n) => `${Math.round(Number(n) || 0).toLocaleString('en-ZM')} L`;
let uid = 0;

function Pipe({ tanks, links, width, gap }) {
  const id = React.useMemo(() => `kp${(uid += 1)}`, []);
  const n = tanks.length;
  const W = n * width + (n - 1) * gap;
  const h = Math.max(12, Math.round(width * 0.16));          // tube thickness
  const H = h + 14;
  const y = Math.round(width * 1.33 - H / 2);                 // at the tank bases (drawing units 133 of 150)
  const color = tanks[0].color || '#0e7490';
  return (
    <svg className="k-pipe" width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ top: y }} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${id}-fuel`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity=".55" />
          <stop offset=".5" stopColor={color} />
          <stop offset="1" stopColor="#0f172a" stopOpacity=".55" />
        </linearGradient>
        <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".95" />
          <stop offset=".35" stopColor="#e2e8f0" stopOpacity=".5" />
          <stop offset="1" stopColor="#94a3b8" stopOpacity=".7" />
        </linearGradient>
        <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".5" stopColor="#fff" stopOpacity=".55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {links.map((lk, i) => {
        const x1 = i * (width + gap) + width * 0.82;
        const x2 = (i + 1) * (width + gap) + width * 0.18;
        const len = x2 - x1;
        const cy = H / 2;
        const dur = lk.dir === 'still' ? 7 : 6.5 - 3.5 * lk.strength;
        const cls = `k-pipe-flow k-pipe-${lk.dir}`;
        return (
          <g key={i}>
            <clipPath id={`${id}-c${i}`}><rect x={x1} y={cy - h / 2 + 2} width={len} height={h - 4} rx={(h - 4) / 2} /></clipPath>
            {/* soft shadow under the pipe */}
            <ellipse cx={x1 + len / 2} cy={cy + h / 2 + 4} rx={len / 2} ry="2.6" fill="#0f172a" opacity=".12" />
            {/* glass tube and the fuel in it */}
            <rect x={x1} y={cy - h / 2} width={len} height={h} rx={h / 2} fill={`url(#${id}-glass)`} stroke="#64748b" strokeOpacity=".55" />
            <rect x={x1} y={cy - h / 2 + 2} width={len} height={h - 4} rx={(h - 4) / 2} fill={`url(#${id}-fuel)`} />
            <g clipPath={`url(#${id}-c${i})`}>
              <g className={cls} style={{ '--k-pipe-len': `${len}px`, animationDuration: `${dur}s` }}>
                <rect x={x1 - len} y={cy - h / 2} width={len * 0.6} height={h} fill={`url(#${id}-sheen)`} />
                <rect x={x1 - len * 0.1} y={cy - h / 2} width={len * 0.45} height={h} fill={`url(#${id}-sheen)`} opacity=".7" />
                <circle cx={x1 - len * 0.7} cy={cy - 1} r="1.6" fill="#fff" opacity=".8" />
                <circle cx={x1 - len * 0.35} cy={cy + 1.5} r="1.1" fill="#fff" opacity=".7" />
                <circle cx={x1 + len * 0.15} cy={cy - 0.5} r="1.3" fill="#fff" opacity=".75" />
              </g>
            </g>
            {/* top highlight on the glass */}
            <rect x={x1 + h / 2} y={cy - h / 2 + 1.5} width={Math.max(0, len - h)} height="1.6" rx=".8" fill="#fff" opacity=".85" />
            {/* collars where the pipe meets each tank */}
            <rect x={x1 - 2} y={cy - h / 2 - 2.5} width="6" height={h + 5} rx="2" fill="#475569" />
            <rect x={x2 - 4} y={cy - h / 2 - 2.5} width="6" height={h + 5} rx="2" fill="#475569" />
            {/* the valve, open */}
            <g transform={`translate(${x1 + len / 2} ${cy})`}>
              <rect x="-2" y={-h / 2 - 7} width="4" height="7" fill="#475569" />
              <rect className="k-pipe-valve" x="-8" y={-h / 2 - 10} width="16" height="4" rx="2" fill="#b91c1c" />
            </g>
          </g>
        );
      })}
    </svg>
  );
}

export default function TankRow({ tanks, width = 118, mini = false }) {
  const items = groupTanks(tanks);
  const gap = mini ? 20 : 30;
  const tankEl = (t) => (
    mini
      ? <div key={t.id || t.code} className="k-mini-tank"><Tank3D tank={t} width={width} showLabel={false} /><span>{t.code}</span></div>
      : <Tank3D key={t.id || t.code} tank={t} width={width} />
  );
  return (
    <div className={`k-tanks${mini ? ' k-tanks-mini' : ''}`}>
      {items.map((it) => {
        if (it.kind === 'single') return tankEl(it.tank);
        const name = groupLabel(it);
        return (
          <div key={`g-${it.code}`} className="k-tank-link" role="group"
            aria-label={`${name}: connected tanks, ${L(it.volume)} of ${L(it.capacity)} together`}>
            <div className="k-tank-link-row" style={{ gap }}>
              <Pipe tanks={it.tanks} links={it.links} width={width} gap={gap} />
              {it.tanks.map(tankEl)}
            </div>
            <div className="k-tank-link-label">
              <span className="k-tank-link-chip"><span className="k-tank-link-ico" aria-hidden="true">⇄</span>{name} · connected</span>
              {!mini && <span className="k-tank-link-total">Together {L(it.volume)} of {L(it.capacity)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
