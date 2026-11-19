// UX-10 — "Station day": the day's work as a ring of four quarters —
// shifts closed, cash counted, every tank dipped, shifts approved. When all
// four are full the day is sealed. Beside it, the station's dip streak.
// It counts work done by the whole station; no money, no person ranked.
import React, { useEffect, useState } from 'react';
import { FiCheck, FiLock, FiDroplet } from 'react-icons/fi';
import { getStationDay } from '../services/fuelApi';
import { ringSegments, dayProgress, arcPath } from './stationDayModel';
import { fmtDay } from './forecourt';

const COLORS = ['#0e7490', '#16a34a', '#b45309', '#7c3aed'];
const HINT = {
  closed: 'Close each shift with its meters',
  cash: 'Enter the cash in Fuel Cash Report',
  dips: 'Dip every tank for each shift',
  approved: 'An Administrator approves each shift',
};

export default function StationDay({ date, refresh = 0, compact = false }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let alive = true;
    getStationDay(date).then((r) => { if (alive) setD(r.data); }).catch(() => { if (alive) setD(null); });
    return () => { alive = false; };
  }, [date, refresh]);
  if (!d || !Array.isArray(d.steps)) return null;
  const segs = ringSegments(d.steps);
  const prog = dayProgress(d.steps);
  const quiet = prog.total === 0;
  const size = compact ? 104 : 124, c = size / 2, r = size / 2 - 10, gap = 6;

  return (
    <section className={`k-sd${d.sealed ? ' is-sealed' : ''}${compact ? ' is-compact' : ''}`} aria-label={`Station day, ${fmtDay(d.date)}`}>
      <div className="k-sd-ring" role="img"
        aria-label={quiet ? 'No shifts yet today' : d.sealed ? 'Day sealed: every step done' : `${prog.done} of ${prog.total} steps done`}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
          {segs.map((s, i) => {
            const a0 = i * 90 + gap / 2, a1 = (i + 1) * 90 - gap / 2;
            return (
              <g key={s.key}>
                <path d={arcPath(c, c, r, a0, a1)} className="k-sd-track" />
                {s.frac > 0 && <path d={arcPath(c, c, r, a0, a0 + (a1 - a0) * Math.max(0.02, s.frac))} className="k-sd-fill" style={{ stroke: COLORS[i], animationDelay: `${i * 120}ms` }} />}
              </g>
            );
          })}
        </svg>
        <div className="k-sd-centre">
          {d.sealed ? <><FiLock aria-hidden="true" /><b>Sealed</b></>
            : quiet ? <><b>—</b><span>no shifts</span></>
            : <><b>{prog.done}/{prog.total}</b><span>steps</span></>}
        </div>
      </div>
      <div className="k-sd-body">
        <div className="k-sd-head">
          <h3>Station day · {fmtDay(d.date)}</h3>
          {d.dip_streak > 0 && (
            <span className="k-sd-streak" title="Days in a row on which every tank was dipped for every shift">
              <FiDroplet aria-hidden="true" /> Dip streak: <b>{d.dip_streak}</b> day{d.dip_streak === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <ul className="k-sd-steps">
          {segs.map((s, i) => (
            <li key={s.key} className={s.complete ? 'is-done' : s.idle ? 'is-idle' : ''} style={{ '--k-sd': COLORS[i] }}>
              <span className="k-sd-tick" aria-hidden="true">{s.complete ? <FiCheck /> : null}</span>
              <span className="k-sd-label">{s.label}</span>
              <span className="k-sd-count">{s.idle ? '—' : `${Math.min(s.done, s.total)} of ${s.total}`}</span>
              {!compact && !s.complete && !s.idle && <span className="k-sd-hint">{HINT[s.key]}</span>}
            </li>
          ))}
        </ul>
        {d.sealed && <div className="k-sd-seal" role="status"><FiLock aria-hidden="true" /> Day sealed — every shift closed, counted, dipped and approved.</div>}
      </div>
    </section>
  );
}
