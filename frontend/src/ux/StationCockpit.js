// UX-3 — the station's day at the top of the Dashboard: takings split
// fuel/shop, litres by grade (dials), the tanks (3D), today's shifts and the
// cash variance (in full), and this week's trend.
import React from 'react';
import { FiDroplet, FiDollarSign, FiClock, FiAlertTriangle, FiInfo, FiChevronRight } from 'react-icons/fi';
import Tank3D from './Tank3D';
import GradeGauge from './GradeGauge';
import { ProgressBar, VarianceBadge } from './components';
import { takingsSplit, niceMax, shiftSteps, alerts } from './stationMetrics';

const K = (n) => `K ${Number(n || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const L = (n) => `${Math.round(Number(n || 0)).toLocaleString('en-ZM')} L`;

function Card({ icon, title, action, onAction, children, className = '' }) {
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

export default function StationCockpit({ data, today, onNavigate = () => {} }) {
  const st = data.station;
  const split = takingsSplit(data.todaySales, data.todayFuelSales);
  const gaugeMax = niceMax((st.grades || []).map((g) => g.litres), 100);
  const steps = shiftSteps(st.shifts);
  const al = alerts(st);
  return (
    <div className="k-cockpit">
      <div className="k-cockpit-head">
        <div>
          <div className="k-cockpit-kicker">Station today</div>
          <h2>{new Date(`${today}T12:00:00`).toLocaleDateString('en-ZM', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
        </div>
        {al.length > 0 && (
          <ul className="k-alerts" aria-label="Needs attention">
            {al.map((a, i) => <li key={i} className={`k-alert-${a.tone}`}>{a.tone === 'info' ? <FiInfo aria-hidden="true" /> : <FiAlertTriangle aria-hidden="true" />}{a.text}</li>)}
          </ul>
        )}
      </div>

      <div className="k-cockpit-grid">
        <Card icon={<FiDollarSign />} title="Takings today" className="k-span-4">
          <div className="k-big">{K(split.total)}</div>
          <div className="k-split" role="img" aria-label={`Fuel ${K(split.fuel)}, shop ${K(split.shop)}`}>
            <div className="k-split-fuel" style={{ width: `${split.fuelPct * 100}%` }} />
            <div className="k-split-shop" style={{ width: `${(1 - split.fuelPct) * 100}%` }} />
          </div>
          <dl className="k-split-legend">
            <div><dt><i className="k-dot-fuel" aria-hidden="true" />Fuel</dt><dd>{K(split.fuel)}</dd></div>
            <div><dt><i className="k-dot-shop" aria-hidden="true" />Shop</dt><dd>{K(split.shop)}</dd></div>
          </dl>
          <div className="k-muted" style={{ marginTop: 8 }}>This week {K(data.weeklyRevenue)} · fuel from closed shifts</div>
        </Card>

        <Card icon={<FiDroplet />} title={`Litres today · ${L(st.litres)}`} className="k-span-8">
          {(st.grades || []).length === 0
            ? <div className="k-empty">No meter readings for today yet — they appear as shifts are closed.</div>
            : <div className="k-gauges">{st.grades.map((g) => <GradeGauge key={g.grade_id} grade={g} max={gaugeMax} />)}</div>}
        </Card>

        <Card icon={<FiDroplet />} title="Tanks" action="Tank dips" onAction={() => onNavigate('/fuel/tank-dips')} className="k-span-7">
          {(st.tanks || []).length === 0
            ? <div className="k-empty">No tanks set up yet.</div>
            : <div className="k-tanks">{st.tanks.map((t) => <Tank3D key={t.id} tank={t} />)}</div>}
        </Card>

        <Card icon={<FiClock />} title="Today's shifts" action="Fuel Cash Report" onAction={() => onNavigate('/fuel/cash-report')} className="k-span-5">
          {st.shifts.total === 0 ? <div className="k-empty">No shifts opened today yet.</div> : (
            <>
              <div className="k-panel-row" style={{ marginBottom: 8 }}>
                <span className="k-panel-title">{steps.complete ? <span className="k-ok-text">✓ Every shift closed, counted and approved</span> : `${steps.done} of ${steps.max} steps`}</span>
              </div>
              <ProgressBar value={steps.done} max={steps.max} tone={steps.complete ? 'ok' : 'accent'} label="Today's shift progress" />
              <ul className="k-shift-counts">
                <li><strong>{st.shifts.open}</strong><span>open</span></li>
                <li><strong>{st.shifts.closed}</strong><span>closed</span></li>
                <li><strong>{st.shifts.cash}</strong><span>cash entered</span></li>
                <li><strong>{st.shifts.approved}</strong><span>approved</span></li>
              </ul>
              <div className="k-cash-line">
                <span>Cash variance, {st.cash.reconciled} reconciled shift{st.cash.reconciled === 1 ? '' : 's'}</span>
                {st.cash.reconciled > 0 ? <VarianceBadge variance={st.cash.variance_total} /> : <span className="k-muted">none counted yet</span>}
              </div>
              {st.cash.reconciled > 0 && <div className="k-muted">{st.cash.balanced} of {st.cash.reconciled} balanced to the ngwee</div>}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
