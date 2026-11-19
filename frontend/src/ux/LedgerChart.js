// UX-7 — Tank Ledger: the tank's level over the chosen days, as steps, with a
// mark for each movement: ▲ delivery, ▼ sale, ◆ dip / other correction.
// Capacity and the low-alert level are dashed lines. Decorative copy of the
// table below (which stays the record); the chart has a text summary.
import React from 'react';
import { ledgerSeries, ledgerTop, niceTicks } from './ledgerSeries';
import { fmtL, fmtDay } from './forecourt';

const MARK = { delivery: '#15803d', sale: '#b91c1c', dip_adjustment: '#b45309', adjustment: '#b45309', reversal: '#64748b', opening: '#4338ca', start: '#334155' };

export default function LedgerChart({ openingBefore, rows, from, capacity, lowLevel, color = '#0e7490' }) {
  const id = React.useMemo(() => `lc${Math.random().toString(36).slice(2, 8)}`, []);   // hooks before any return
  // Draw at the real width so the text stays at its real size.
  const box = React.useRef(null);
  const [W, setW] = React.useState(760);
  React.useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const set = () => setW(Math.max(300, Math.round(el.clientWidth || 760)));
    set();
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', set); return () => window.removeEventListener('resize', set); }
    const ro = new ResizeObserver(set); ro.observe(el); return () => ro.disconnect();
  }, []);
  const pts = ledgerSeries(openingBefore, rows, from);
  if (pts.length < 2) return <figure className="k-lc" ref={box} />;
  const H = W < 520 ? 180 : 220, L = 46, R = 12, T = 12, B = 26;
  const ticks = niceTicks(ledgerTop(pts, capacity));
  const top = ticks[ticks.length - 1];
  const n = pts.length;
  const x = (i) => L + (i * (W - L - R)) / (n - 1);
  const y = (v) => T + (H - T - B) * (1 - Math.max(0, v) / top);
  let d = `M${x(0)} ${y(pts[0].balance)}`;
  for (let i = 1; i < n; i += 1) d += ` H${x(i)} V${y(pts[i].balance)}`;
  const area = `${d} V${H - B} H${x(0)} Z`;
  // date labels: first, last and where the day changes (thinned to ~6)
  const dayIdx = pts.map((p, i) => (i === 0 || p.date !== pts[i - 1].date ? i : -1)).filter((i) => i >= 0);
  const step = Math.max(1, Math.ceil(dayIdx.length / Math.max(2, Math.floor(W / 130))));
  const labels = dayIdx.filter((_, k) => k % step === 0);
  const last = pts[n - 1];
  return (
    <figure className="k-lc" ref={box}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Level from ${fmtL(pts[0].balance)} on ${fmtDay(pts[0].date)} to ${fmtL(last.balance)} after ${n - 1} movements`}>
        <defs>
          <linearGradient id={`${id}-a`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity=".28" /><stop offset="1" stopColor={color} stopOpacity=".02" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#e2e8f0" />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" className="k-lc-axis">{v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : Math.round(v)}</text>
          </g>
        ))}
        {capacity > 0 && <line x1={L} x2={W - R} y1={y(capacity)} y2={y(capacity)} stroke="#334155" strokeDasharray="6 5" strokeWidth="1.2" />}
        {lowLevel > 0 && <line x1={L} x2={W - R} y1={y(lowLevel)} y2={y(lowLevel)} stroke="#b91c1c" strokeDasharray="4 4" strokeWidth="1.2" />}
        <path d={area} fill={`url(#${id}-a)`} />
        <path d={d} fill="none" stroke={color} strokeWidth="2.4" strokeLinejoin="round" className="k-lc-line" />
        {pts.map((p, i) => {
          if (i === 0) return <circle key={i} cx={x(i)} cy={y(p.balance)} r="3.5" fill="#fff" stroke={MARK.start} strokeWidth="2" />;
          const c = MARK[p.type] || MARK.adjustment, cx = x(i), cy = y(p.balance);
          if (p.type === 'delivery') return <path key={i} d={`M${cx} ${cy - 7} l6 10 h-12 z`} fill={c} stroke="#fff" strokeWidth="1"><title>{`Delivery +${fmtL(p.change)} · ${fmtDay(p.date)}`}</title></path>;
          if (p.type === 'sale') return <path key={i} d={`M${cx} ${cy + 6} l5 -8 h-10 z`} fill={c} opacity=".85"><title>{`Sale ${fmtL(p.change)} · ${fmtDay(p.date)}`}</title></path>;
          return <path key={i} d={`M${cx} ${cy - 6} l6 6 -6 6 -6 -6 z`} fill={c} stroke="#fff" strokeWidth="1"><title>{`${p.type === 'dip_adjustment' ? 'Dip correction' : 'Correction'} ${p.change >= 0 ? '+' : ''}${fmtL(p.change)} · ${fmtDay(p.date)}`}</title></path>;
        })}
        {labels.map((i) => <text key={i} x={x(i)} y={H - 7} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'} className="k-lc-axis">{fmtDay(pts[i].date)}</text>)}
      </svg>
      <figcaption className="k-lc-legend">
        <span><i className="k-lc-k" style={{ color: MARK.delivery }}>▲</i> Delivery</span>
        <span><i className="k-lc-k" style={{ color: MARK.sale }}>▼</i> Sale</span>
        <span><i className="k-lc-k" style={{ color: MARK.dip_adjustment }}>◆</i> Dip / other correction</span>
        {capacity > 0 && <span><i className="k-lc-dash" /> Capacity {fmtL(capacity)}</span>}
        {lowLevel > 0 && <span><i className="k-lc-dash k-lc-dash-low" /> Low alert {fmtL(lowLevel)}</span>}
      </figcaption>
    </figure>
  );
}
