// UX-4 — the Dashboard's Shop & stock section. Fuel is kept out of it (fuel
// credit tickets and fuel products belong to the station section above).
import React from 'react';
import { FiShoppingBag, FiPackage, FiAward, FiAlertCircle, FiPieChart, FiChevronRight } from 'react-icons/fi';

const K = (n) => `${(Number(n || 0) < 0 ? '−' : '')}K${Math.abs(Number(n || 0)).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const K0 = (n) => `${(Number(n || 0) < 0 ? '−' : '')}K${Math.round(Math.abs(Number(n || 0))).toLocaleString('en-ZM')}`;
// K138,300 → K138k; K1,284,500 → K1.3m (only for the small donut centre).
const compactK = (n) => { const v = Number(n || 0); return v >= 1e6 ? `K${(v / 1e6).toFixed(1)}m` : v >= 1e4 ? `K${Math.round(v / 1e3)}k` : `K${Math.round(v)}`; };
const PALETTE = ['#0e7490', '#b91c1c', '#7c3aed', '#b45309', '#15803d', '#1d4ed8', '#be185d', '#475569'];

function Card({ icon, title, action, onAction, className = '', children }) {
  return (
    <section className={`k-cockpit-card ${className}`}>
      <header>
        <h3><span className="k-cockpit-ico" aria-hidden="true">{icon}</span>{title}</h3>
        {action && <button type="button" className="k-link-btn" onClick={onAction}>{action}<FiChevronRight aria-hidden="true" /></button>}
      </header>
      {children}
    </section>
  );
}

// A small area chart of the week's shop sales.
function Sparkline({ points }) {
  if (!points.length) return null;
  const W = 220, H = 54, max = Math.max(1, ...points.map((p) => p.total));
  const step = points.length > 1 ? W / (points.length - 1) : W;
  const xy = points.map((p, i) => [i * step, H - 4 - (p.total / max) * (H - 10)]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return (
    <svg className="k-spark" viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="k-spark-g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#6d28d9" stopOpacity=".35" /><stop offset="1" stopColor="#6d28d9" stopOpacity="0" /></linearGradient></defs>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="url(#k-spark-g)" />
      <path d={line} fill="none" stroke="#6d28d9" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
      {xy.length > 0 && <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="3.5" fill="#6d28d9" stroke="#fff" strokeWidth="1.5" />}
    </svg>
  );
}

// A donut with a little depth (shadow ring underneath).
function Donut({ parts, size = 132, label, sub }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const r = 46, c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img"
      aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
      <ellipse cx="60" cy="104" rx="40" ry="6" fill="#0f172a" opacity=".08" />
      <circle cx="60" cy="58" r={r} fill="none" stroke="#e2e8f0" strokeWidth="16" />
      {total > 0 && parts.map((p) => {
        const len = (p.value / total) * c;
        const el = <circle key={p.label} className="k-donut-seg" cx="60" cy="58" r={r} fill="none" stroke={p.color} strokeWidth="16"
          strokeDasharray={`${Math.max(0, len - 1.5)} ${c}`} strokeDashoffset={-acc} transform="rotate(-90 60 58)" />;
        acc += len;
        return el;
      })}
      <circle cx="60" cy="58" r="37" fill="none" stroke="#fff" strokeOpacity=".5" strokeWidth="2" />
      <text x="60" y="56" textAnchor="middle" fontSize="20" fontWeight="800" fill="#0f172a" fontFamily="Inter, system-ui, sans-serif">{label}</text>
      {sub && <text x="60" y="72" textAnchor="middle" fontSize="9.5" fontWeight="700" fill="#475569" fontFamily="Inter, system-ui, sans-serif">{sub}</text>}
    </svg>
  );
}

const MEDALS = [
  { fill: '#fbbf24', ring: '#b45309', label: '1st' },
  { fill: '#e2e8f0', ring: '#64748b', label: '2nd' },
  { fill: '#f0a868', ring: '#9a3412', label: '3rd' },
];
function Rank({ i }) {
  const m = MEDALS[i];
  if (!m) return <span className="k-rank-plain">{i + 1}</span>;
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-label={m.label} role="img">
      <circle cx="14" cy="15" r="11" fill={m.ring} />
      <circle cx="14" cy="13.5" r="10" fill={m.fill} />
      <circle cx="11" cy="10" r="3" fill="#fff" opacity=".55" />
      <text x="14" y="18" textAnchor="middle" fontSize="11" fontWeight="900" fill="#0f172a" fontFamily="Inter, system-ui, sans-serif">{i + 1}</text>
    </svg>
  );
}

export default function ShopStock({ data, onNavigate = () => {}, showWeekTotal }) {
  const shop = data.shop;
  if (!shop) return null;
  const st = shop.stock;
  const topMax = Math.max(1, ...shop.top7.map((t) => t.revenue));
  const catTotal = shop.categories30.reduce((a, c) => a + c.total, 0);
  const weekShop = shop.week.reduce((a, d) => a + d.total, 0);
  return (
    <div className="k-cockpit-grid k-shopstock">
      <Card icon={<FiShoppingBag />} title="Shop today" className="k-span-4">
        <div className="k-big">{K(shop.today.sales)}</div>
        <div className="k-shop-facts">
          <div><strong>{shop.today.orders}</strong><span>sale{shop.today.orders === 1 ? '' : 's'}</span></div>
          <div><strong>{K(shop.today.basket)}</strong><span>average basket</span></div>
        </div>
        <Sparkline points={shop.week} />
        <div className="k-muted">Shop this week {K0(showWeekTotal != null ? showWeekTotal : weekShop)}</div>
      </Card>

      <Card icon={<FiPackage />} title="Stock health" action="Inventory" onAction={() => onNavigate('/stock/inventory')} className="k-span-4">
        <div className="k-donut-row">
          <Donut label={String(st.total)} sub="items" parts={[
            { label: 'healthy', value: st.healthy, color: '#15803d' },
            { label: 'running low', value: st.low, color: '#d97706' },
            { label: 'out of stock', value: st.out, color: '#b91c1c' },
          ]} />
          <ul className="k-legend">
            <li><i style={{ background: '#15803d' }} aria-hidden="true" /><strong>{st.healthy}</strong> healthy</li>
            <li><i style={{ background: '#d97706' }} aria-hidden="true" /><strong>{st.low}</strong> running low</li>
            <li><i style={{ background: '#b91c1c' }} aria-hidden="true" /><strong>{st.out}</strong> out of stock</li>
          </ul>
        </div>
        <div className="k-shop-facts">
          <div><strong>{K0(st.atCost)}</strong><span>shop stock at cost</span></div>
          <div><strong>{K0(st.atRetail)}</strong><span>at selling price</span></div>
        </div>
      </Card>

      <Card icon={<FiAward />} title="Top sellers · 7 days" className="k-span-4">
        {shop.top7.length === 0 ? <div className="k-empty">No shop sales in the last 7 days.</div> : (
          <ol className="k-top">
            {shop.top7.map((t, i) => (
              <li key={t.name}>
                <Rank i={i} />
                <div className="k-top-body">
                  <div className="k-top-name"><span>{t.name}</span><strong>{K0(t.revenue)}</strong></div>
                  <div className="k-top-bar"><div style={{ width: `${(t.revenue / topMax) * 100}%` }} /></div>
                  <div className="k-muted" style={{ fontSize: 12 }}>{t.units.toLocaleString('en-ZM')} sold</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card icon={<FiAlertCircle />} title="Running low" action="Receive stock" onAction={() => onNavigate('/stock/grn')} className="k-span-6">
        {shop.runningLow.length === 0 ? <div className="k-empty">Nothing below its minimum — shelves look healthy.</div> : (
          <ul className="k-shelf">
            {shop.runningLow.map((p) => {
              const pct = p.min > 0 ? Math.max(0, Math.min(1, p.stock / p.min)) : 0;
              return (
                <li key={p.name}>
                  <div className="k-shelf-top"><span>{p.name}</span>
                    {p.stock <= 0 ? <span className="k-pill-out">Out</span> : <span className="k-muted">{p.stock} of min {p.min}{p.unit ? ` ${p.unit}` : ''}</span>}
                  </div>
                  <div className="k-shelf-bar" role="img" aria-label={`${p.name}: ${p.stock} in stock, minimum ${p.min}`}>
                    <div className={pct === 0 ? 'k-shelf-empty' : 'k-shelf-fill'} style={{ width: `${Math.max(pct * 100, pct === 0 ? 100 : 4)}%` }} />
                    <i className="k-shelf-min" aria-hidden="true" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card icon={<FiPieChart />} title="Sales by category · 30 days" className="k-span-6">
        {shop.categories30.length === 0 ? <div className="k-empty">No category sales in the last 30 days.</div> : (
          <div className="k-donut-row">
            <Donut label={compactK(catTotal)} sub="30 days" parts={shop.categories30.map((c, i) => ({ label: c.category, value: c.total, color: PALETTE[i % PALETTE.length] }))} />
            <ul className="k-legend">
              {shop.categories30.map((c, i) => (
                <li key={c.category}><i style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden="true" />
                  <span className="k-legend-name">{c.category}</span>
                  <strong>{catTotal ? Math.round((c.total / catTotal) * 100) : 0}%</strong></li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
