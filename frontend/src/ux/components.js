// UX-1 — small shared building blocks. No new packages; styling lives in
// ux/kelete-ux.css (class names start with "k-").
import React, { useEffect, useState } from 'react';
import { FiCheck, FiCircle, FiAlertTriangle, FiX } from 'react-icons/fi';
import { varianceState, formatKwacha } from './fuelProgress';
import { comboLabel } from './hotkeys';

// Placeholder blocks while data loads (no spinner). Announced to screen readers once.
export function Skeleton({ rows = 4, height = 16, className = '' }) {
  return (
    <div className={`k-skeleton-group ${className}`} role="status" aria-live="polite" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="k-skeleton" style={{ height, width: `${92 - ((i * 17) % 30)}%` }} />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 4 }) {
  return (
    <div className="k-skeleton-cards" role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="k-skeleton-card">
          <div className="k-skeleton" style={{ height: 12, width: '45%' }} />
          <div className="k-skeleton" style={{ height: 26, width: '70%', marginTop: 10 }} />
        </div>
      ))}
    </div>
  );
}

export function ProgressBar({ value, max = 100, label, tone = 'accent' }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
  return (
    <div className="k-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}>
      <div className={`k-progress-fill k-tone-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

// A list of things to do, ticked as they're done.
export function Checklist({ items, compact = false }) {
  return (
    <ul className={`k-checklist ${compact ? 'k-checklist-compact' : ''}`}>
      {items.map((it) => (
        <li key={it.key} className={it.done ? 'k-done' : (it.warn ? 'k-warn' : '')}>
          <span className="k-check-icon" aria-hidden="true">{it.done ? <FiCheck /> : (it.warn ? <FiAlertTriangle /> : <FiCircle />)}</span>
          <span>{it.label}</span>
          <span className="k-sr-only">{it.done ? ' — done' : ' — to do'}</span>
        </li>
      ))}
    </ul>
  );
}

// Meters → Cash → Approved, as small connected steps.
export function StepTrail({ steps }) {
  return (
    <ol className="k-steps" aria-label="Shift progress">
      {steps.map((s) => (
        <li key={s.key} className={s.done ? 'k-step-done' : ''}>
          <span className="k-step-dot" aria-hidden="true">{s.done ? <FiCheck /> : null}</span>
          <span className="k-step-label">{s.label}</span>
          <span className="k-sr-only">{s.done ? ' done' : ' not yet'}</span>
        </li>
      ))}
    </ol>
  );
}

// Variance: always the full signed amount. "Balanced" adds a tick; a shortage
// stays red and prominent. Nothing here hides or softens a number.
export function VarianceBadge({ variance, size = 'md' }) {
  const v = varianceState(variance);
  return (
    <span className={`k-variance k-variance-${v.state} k-variance-${size}`} title={`Variance ${formatKwacha(v.amount)}`}>
      {v.state === 'balanced' && <FiCheck aria-hidden="true" />}
      {v.state === 'short' && <FiAlertTriangle aria-hidden="true" />}
      <span>{v.label}</span>
      {v.state === 'balanced' && <span className="k-variance-amount">{formatKwacha(v.amount)}</span>}
    </span>
  );
}

export function Kbd({ combo }) {
  return <kbd className="k-kbd">{comboLabel(combo)}</kbd>;
}

// "?" opens a list of the shortcuts available on this screen.
export function ShortcutHelp({ bindings, open, onClose, title = 'Keyboard shortcuts' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);
  if (!open) return null;
  const shown = (bindings || []).filter((b) => b && b.label && b.enabled !== false);
  return (
    <div className="k-help-backdrop" onClick={onClose}>
      <div className="k-help" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="k-help-head"><strong>{title}</strong><button type="button" className="k-icon-btn" onClick={onClose} aria-label="Close"><FiX /></button></div>
        <table className="k-help-table"><tbody>
          {shown.map((b) => <tr key={b.combo + b.label}><td><Kbd combo={b.combo} /></td><td>{b.label}</td></tr>)}
          <tr><td><Kbd combo="?" /></td><td>Show this list</td></tr>
        </tbody></table>
      </div>
    </div>
  );
}

// A small hint button in a page header: "⌨ Shortcuts (?)".
export function ShortcutHint({ onClick }) {
  return <button type="button" className="k-hint-btn" onClick={onClick} title="Keyboard shortcuts (?)">⌨ <span className="k-hide-sm">Shortcuts</span> <kbd className="k-kbd">?</kbd></button>;
}

export function useToggle(initial = false) {
  const [v, setV] = useState(initial);
  return [v, () => setV((x) => !x), setV];
}

// A strip of headline numbers at the top of a screen.
export function SummaryStrip({ items }) {
  return (
    <div className="k-summary">
      {items.map((it) => (
        <div key={it.key} className={`k-summary-item ${it.tone ? `k-tone-text-${it.tone}` : ''}`}>
          <div className="k-summary-label">{it.label}</div>
          <div className="k-summary-value">{it.value}</div>
          {it.hint && <div className="k-summary-hint">{it.hint}</div>}
        </div>
      ))}
    </div>
  );
}
