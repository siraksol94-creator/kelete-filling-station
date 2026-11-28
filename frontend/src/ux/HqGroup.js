// UX-4 — the HQ Overview: the group's day at a glance, every branch side by
// side (alphabetical — branches are compared, never ranked), and one tile per
// branch with its takings, its tanks and its shifts. Cash variances are
// shown in full with their sign. Only figures the server sent.
import React from 'react';
import {
  FiDollarSign, FiDroplet, FiBarChart2, FiLayers, FiAlertTriangle, FiInfo, FiPackage,
} from 'react-icons/fi';
import TankRow from './TankRow';
import TrendBars from './TrendBars';
import { kindOfBranch, KIND_LABEL } from './branchType';
import { ProgressBar, VarianceBadge } from './components';
import { shiftSteps } from './stationMetrics';
import { branchBars, forecourtFlags, fuelShare, shortBranch } from './hqMetrics';

const K = (n) => `${(Number(n || 0) < 0 ? '−' : '')}K${Math.abs(Number(n || 0)).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const K0 = (n) => `${(Number(n || 0) < 0 ? '−' : '')}K${Math.round(Math.abs(Number(n || 0))).toLocaleString('en-ZM')}`;
const L = (n) => `${Math.round(Number(n || 0)).toLocaleString('en-ZM')} L`;

function Card({ icon, title, className = '', children, aside }) {
  return (
    <section className={`k-cockpit-card ${className}`}>
      <header>
        <h3><span className="k-cockpit-ico" aria-hidden="true">{icon}</span>{title}</h3>
        {aside}
      </header>
      {children}
    </section>
  );
}

function Split({ fuel, shop }) {
  const total = Math.max(0, fuel) + Math.max(0, shop);
  const f = total > 0 ? Math.max(0, fuel) / total : 0;
  return (
    <div className="k-split" role="img" aria-label={`Fuel ${K(fuel)}, shop ${K(shop)}`}>
      <div className="k-split-fuel" style={{ width: `${f * 100}%` }} />
      <div className="k-split-shop" style={{ width: `${(1 - f) * 100}%` }} />
    </div>
  );
}

// A small station emblem: canopy and pumps for a fuel branch, a shop front
// for a shop-only branch. Decorative.
function BranchEmblem({ fuel }) {
  return (
    <svg className="k-emblem" width="46" height="40" viewBox="0 0 46 40" aria-hidden="true" focusable="false">
      <ellipse cx="23" cy="37" rx="19" ry="2.6" fill="#0f172a" opacity=".12" />
      {fuel ? (
        <>
          <rect x="4" y="6" width="38" height="6" rx="2" fill="#0e7490" />
          <rect x="4" y="11" width="38" height="2" fill="#155e75" />
          <rect x="9" y="13" width="2.4" height="22" fill="#94a3b8" /><rect x="34.6" y="13" width="2.4" height="22" fill="#94a3b8" />
          <rect x="15" y="20" width="6" height="15" rx="1.5" fill="#0e7490" /><rect x="16.2" y="22" width="3.6" height="3" rx=".6" fill="#cffafe" />
          <rect x="25" y="20" width="6" height="15" rx="1.5" fill="#b45309" /><rect x="26.2" y="22" width="3.6" height="3" rx=".6" fill="#fef3c7" />
          <circle className="k-emblem-light" cx="23" cy="9" r="1.4" fill="#fde68a" />
        </>
      ) : (
        <>
          <rect x="7" y="12" width="32" height="23" rx="2" fill="#e2e8f0" stroke="#475569" />
          <path d="M5 12 L9 5 H37 L41 12 Z" fill="#6d28d9" />
          <rect x="11" y="18" width="10" height="9" rx="1" fill="#bae6fd" /><rect x="25" y="18" width="9" height="17" rx="1" fill="#475569" />
        </>
      )}
    </svg>
  );
}

function WeekSpark({ week }) {
  const pts = (week || []).map((d) => Number(d.total) || 0);
  if (pts.length < 2) return null;
  const W = 120, H = 30, max = Math.max(1, ...pts);
  const xy = pts.map((v, i) => [(i * W) / (pts.length - 1), H - 3 - (v / max) * (H - 8)]);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return (
    <svg className="k-week-spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img"
      aria-label={`Takings over the last 7 days: ${pts.map((v) => K0(v)).join(', ')}`}>
      <path d={`${line} L${W} ${H} L0 ${H} Z`} fill="#0e7490" opacity=".12" />
      <path d={line} fill="none" stroke="#0e7490" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={xy[xy.length - 1][0]} cy={xy[xy.length - 1][1]} r="3" fill="#0e7490" stroke="#fff" strokeWidth="1.2" />
    </svg>
  );
}

export function GroupHero({ rollup, branches = [], today }) {
  const share = fuelShare(rollup);
  const branchCount = branches.length;
  // Litres per station, alphabetical, on one scale.
  const stations = branches.filter((b) => !b.error && b.station)
    .map((b) => ({ slug: b.slug, name: shortBranch(b.name, b.slug), litres: Number(b.station.litres) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const maxL = Math.max(1, ...stations.map((x) => x.litres));
  return (
    <div className="k-cockpit">
      <div className="k-cockpit-head">
        <div>
          <div className="k-cockpit-kicker">Group today · {branchCount} branch{branchCount === 1 ? '' : 'es'}</div>
          <h2>{new Date(`${today}T12:00:00`).toLocaleDateString('en-ZM', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
        </div>
      </div>
      <div className="k-cockpit-grid">
        <Card icon={<FiDollarSign />} title="Group takings today" className="k-span-5">
          <div className="k-big">{K(rollup.takings_total)}</div>
          <Split fuel={rollup.takings_fuel} shop={rollup.takings_shop} />
          <dl className="k-split-legend">
            <div><dt><i className="k-dot-fuel" aria-hidden="true" />Fuel · {Math.round(share * 100)}%</dt><dd>{K(rollup.takings_fuel)}</dd></div>
            <div><dt><i className="k-dot-shop" aria-hidden="true" />Shop · {Math.round((1 - share) * 100)}%</dt><dd>{K(rollup.takings_shop)}</dd></div>
          </dl>
          <div className="k-hq-mtd">
            <span>Month to date</span>
            <strong>{K(rollup.mtd_total)}</strong>
            <span className="k-muted">fuel {K0(rollup.mtd_fuel)} · shop {K0(rollup.mtd_shop)}</span>
          </div>
        </Card>

        <Card icon={<FiDroplet />} title="Forecourts" className="k-span-4">
          {rollup.stations > 0 ? (
            <>
              <div className="k-big">{L(rollup.litres_today)}</div>
              <div className="k-muted">sold today across {rollup.stations} station{rollup.stations === 1 ? '' : 's'}</div>
              <ul className="k-hq-chips">
                <li className={rollup.tanks_low ? 'k-chip-danger' : 'k-chip-ok'}>
                  {rollup.tanks_low ? <FiAlertTriangle aria-hidden="true" /> : null}
                  {rollup.tanks_low ? `${rollup.tanks_low} tank${rollup.tanks_low === 1 ? '' : 's'} below low level` : 'No tank below its low level'}
                </li>
                <li className={rollup.shifts_open ? 'k-chip-info' : 'k-chip-ok'}>
                  <FiInfo aria-hidden="true" />{rollup.shifts_open} shift{rollup.shifts_open === 1 ? '' : 's'} open
                </li>
              </ul>
              <div className="k-cash-line">
                <span>Cash variance today, all stations</span>
                <VarianceBadge variance={rollup.cash_variance} />
              </div>
              {stations.length > 1 && (
                <ul className="k-hq-litres" aria-label="Litres sold today by station, alphabetical">
                  {stations.map((x) => (
                    <li key={x.slug}>
                      <span>{x.name}</span>
                      <span className="k-hq-litre-bar" aria-hidden="true"><div style={{ width: `${(x.litres / maxL) * 100}%` }} /></span>
                      <strong>{L(x.litres)}</strong>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : <div className="k-empty">No branch has fuel set up yet.</div>}
        </Card>

        <Card icon={<FiPackage />} title="Held in stock and owed" className="k-span-3">
          <dl className="k-hq-held">
            <div><dt>Fuel in tanks, at cost</dt><dd>{K0(rollup.fuel_stock_value)}</dd></div>
            <div><dt>Shop stock, at cost</dt><dd>{K0(rollup.stock_value)}</dd></div>
            <div><dt>Owed by customers</dt><dd className={rollup.ar_outstanding > 0.001 ? 'k-warn-text' : ''}>{K0(rollup.ar_outstanding)}</dd></div>
          </dl>
        </Card>
      </div>
    </div>
  );
}

export function BranchCompare({ branches, rollup, today }) {
  const bars = branchBars(branches);
  return (
    <div className="k-cockpit-grid" style={{ marginTop: 14 }}>
      <Card icon={<FiLayers />} title="Takings by branch · today" className="k-span-6">
        {bars.length === 0 ? <div className="k-empty">No branch figures yet.</div> : (
          <ul className="k-hq-bars" aria-label="Takings by branch today, alphabetical">
            {bars.map((b) => (
              <li key={b.slug}>
                <div className="k-hq-bar-head"><span>{b.name}</span><strong>{K0(b.total)}</strong></div>
                <div className="k-hq-bar" role="img" aria-label={`${b.name}: fuel ${K(b.fuel)}, shop ${K(b.shop)}`}>
                  <div className="k-split-fuel" style={{ width: `${b.fuelPct * 100}%` }} />
                  <div className="k-split-shop" style={{ width: `${b.shopPct * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="k-trend-legend" style={{ marginTop: 10 }}>
          <span><i style={{ background: '#0e7490' }} aria-hidden="true" />Fuel</span>
          <span><i style={{ background: '#6d28d9' }} aria-hidden="true" />Shop</span>
          <span className="k-muted">Alphabetical · one scale for all</span>
        </div>
      </Card>
      <Card icon={<FiBarChart2 />} title="Group takings this week · fuel and shop" className="k-span-6">
        <TrendBars rows={rollup.week || []} today={today} />
      </Card>
    </div>
  );
}

export function BranchTile({ b }) {
  const name = shortBranch(b.name, b.slug);
  if (b.error) {
    const k = kindOfBranch(b);
    return (
      <section className={`k-cockpit-card k-branch is-${k}`}>
        <header className="k-branch-head">
          <BranchEmblem fuel={k === 'fuel'} />
          <div className="k-branch-title"><h3>{b.name}</h3><span className="k-tag">{b.slug}</span></div>
          <span className={`k-kind k-kind-${k}`}>{KIND_LABEL[k]}</span>
        </header>
        <div className="k-hq-error"><FiAlertTriangle aria-hidden="true" /> {b.error}</div>
      </section>
    );
  }
  const st = b.station;
  const steps = st ? shiftSteps(st.shifts) : null;
  const flags = forecourtFlags(st);
  const t = b.takings || { fuel: 0, shop: b.today.revenue, total: b.today.revenue };
  const kind = kindOfBranch(b);
  return (
    <section className={`k-cockpit-card k-branch is-${kind}`} aria-label={`${b.name} today`}>
      <header className="k-branch-head">
        <BranchEmblem fuel={kind === 'fuel'} />
        <div className="k-branch-title">
          <h3>{b.name}</h3>
          <div className="k-branch-tags">
            <span className="k-tag">{b.slug}</span>
            {b.currency_mode === 'USD+FRA' && <span className="k-tag k-tag-amber">Dual currency</span>}
            {b.workflow_mode === 'three_station' && <span className="k-tag k-tag-blue">3-station</span>}
          </div>
        </div>
        {/* 2026-11-28 — no "Open" link per branch: HQ switches branch with the
            Active Branch picker in the side menu. The badge says what it is. */}
        <span className={`k-kind k-kind-${kind}`}>{KIND_LABEL[kind]}</span>
      </header>

      <div className="k-branch-takings">
        <div>
          <div className="k-branch-label">Takings today</div>
          <div className="k-branch-big">{K(t.total)}</div>
        </div>
        <WeekSpark week={b.week} />
      </div>
      <Split fuel={t.fuel} shop={t.shop} />
      <div className="k-branch-legend">
        {(st || t.fuel > 0) && <span><i className="k-dot-fuel" aria-hidden="true" />Fuel {K0(t.fuel)}</span>}
        <span><i className="k-dot-shop" aria-hidden="true" />Shop {K0(t.shop)}</span>
        <span className="k-muted">MTD {K0(b.mtd_takings ? b.mtd_takings.total : b.mtd.revenue)}</span>
      </div>

      {st && (
        <div className="k-branch-forecourt">
          {(st.tanks || []).length > 0 && (
            <div className="k-branch-tanks"><TankRow tanks={st.tanks} width={56} mini /></div>
          )}
          <div className="k-branch-shifts">
            <div className="k-branch-label">{st.shifts.total === 0 ? 'No shifts opened today' : `Shifts · ${steps.done} of ${steps.max} steps`}</div>
            {st.shifts.total > 0 && <ProgressBar value={steps.done} max={steps.max} tone={steps.complete ? 'ok' : 'accent'} label={`${name} shift progress`} />}
            <div className="k-muted" style={{ marginTop: 4 }}>{L(st.litres)} sold</div>
            {st.cash.reconciled > 0 && <div style={{ marginTop: 6 }}><VarianceBadge variance={st.cash.variance_total} size="sm" /></div>}
          </div>
        </div>
      )}
      {flags.length > 0 && (
        <ul className="k-hq-chips">
          {flags.map((f, i) => <li key={i} className={`k-chip-${f.tone}`}>{f.tone === 'danger' ? <FiAlertTriangle aria-hidden="true" /> : <FiInfo aria-hidden="true" />}{f.text}</li>)}
        </ul>
      )}

      <dl className="k-branch-metrics">
        {b.workflow_mode === 'three_station' && (
          <>
            <div><dt>Awaiting payment</dt><dd className={b.pending_payment > 0 ? 'k-warn-text' : ''}>{b.pending_payment}</dd></div>
            <div><dt>Awaiting dispatch</dt><dd className={b.awaiting_dispatch > 0 ? 'k-warn-text' : ''}>{b.awaiting_dispatch}</dd></div>
          </>
        )}
        <div><dt>Shop stock</dt><dd>{K0(b.stock_value)}</dd></div>
        <div><dt>Low stock</dt><dd className={b.stock_low_count > 0 ? 'k-warn-text' : ''}>{b.stock_low_count}</dd></div>
        <div><dt>Owed (AR)</dt><dd className={b.ar_outstanding > 0.001 ? 'k-warn-text' : ''}>{K0(b.ar_outstanding)}</dd></div>
      </dl>
    </section>
  );
}
