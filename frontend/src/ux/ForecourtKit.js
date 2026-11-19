// UX-7 — the Forecourt kit: the pieces every Fuel Station screen shares so
// they read as one product with the menu, the Dashboard and the sign-in.
//   <PageHero icon title subtitle date actions />  the page header
//   <EmptyState art title text action />          nothing here yet, and what to do
//   <Ring value max label sub tone />               a progress ring (work done, never money)
//   const [dialog, ui] = useDialog();               in-app confirm / alert
//     if (!(await ui.confirm({ title, text, okLabel, danger }))) return;
//     await ui.alert({ title, text });
//     return <>…{dialog}</>;
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { FiAlertTriangle, FiInfo, FiX } from 'react-icons/fi';
import { fmtDay } from './forecourt';

export function PageHero({ icon, title, subtitle, date, actions, children }) {
  return (
    <header className="k-fc-hero k-page-header">
      <div className="k-fc-hero-main">
        {icon && <span className="k-fc-hero-icon" aria-hidden="true">{icon}</span>}
        <div>
          <h2 className="k-fc-title">{title}</h2>
          {(subtitle || date) && (
            <p className="k-fc-sub">
              {date && <span className="k-fc-date">{fmtDay(date)}</span>}
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="k-fc-actions">{actions}</div>}
      {children}
    </header>
  );
}

export function EmptyState({ art, title, text, action }) {
  return (
    <div className="k-fc-empty">
      {art && <div className="k-fc-empty-art" aria-hidden="true">{art}</div>}
      <h3>{title}</h3>
      {text && <p>{text}</p>}
      {action}
    </div>
  );
}

// A ring that fills as work gets done (dips taken, steps finished).
export function Ring({ value, max, label, sub, size = 88, tone }) {
  const pct = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const r = (size - 12) / 2, c = 2 * Math.PI * r;
  const done = max > 0 && value >= max;
  const t = tone || (done ? 'ok' : 'accent');
  return (
    <div className={`k-fc-ring k-fc-ring-${t}`} style={{ width: size }} role="img"
      aria-label={`${label || 'Progress'}: ${value} of ${max}${done ? ', complete' : ''}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="k-fc-ring-track" />
        <circle cx={size / 2} cy={size / 2} r={r} className="k-fc-ring-fill"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      <div className="k-fc-ring-text">
        <strong>{done ? '✓' : `${value}/${max}`}</strong>
        {sub && <span>{sub}</span>}
      </div>
    </div>
  );
}

function Dialog({ kind, title, text, okLabel, cancelLabel, danger, onDone }) {
  const okRef = useRef(null);
  useEffect(() => { const t = setTimeout(() => okRef.current && okRef.current.focus(), 30); return () => clearTimeout(t); }, []);
  const cancel = () => onDone(false);
  return ReactDOM.createPortal(
    <div className="k-help-backdrop" onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
      <div className="k-pw-dialog k-fc-dialog" role={kind === 'confirm' ? 'alertdialog' : 'dialog'} aria-modal="true"
        aria-labelledby="k-fc-dlg-title" aria-describedby="k-fc-dlg-text">
        <div className="k-pw-head">
          <span className={`k-pw-icon${danger ? ' k-fc-icon-danger' : ''}`} aria-hidden="true">{danger ? <FiAlertTriangle /> : <FiInfo />}</span>
          <h2 id="k-fc-dlg-title">{title}</h2>
          <button type="button" className="k-icon-btn" onClick={cancel} aria-label="Close"><FiX /></button>
        </div>
        <p id="k-fc-dlg-text" className="k-fc-dialog-text">{text}</p>
        <div className="k-pw-actions">
          {kind === 'confirm' && <button type="button" className="k-btn k-btn-quiet" onClick={cancel}>{cancelLabel || 'Cancel'}</button>}
          <button ref={okRef} type="button" className={`k-btn ${danger ? 'k-btn-danger' : 'k-btn-primary'}`} onClick={() => onDone(true)}>
            {okLabel || (kind === 'confirm' ? 'OK' : 'OK')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// In-app replacements for window.confirm / window.alert: same question,
// same two choices, but styled, keyboard-friendly and never blocked.
export function useDialog() {
  const [req, setReq] = useState(null);
  const open = useCallback((kind, opts) => new Promise((resolve) => {
    const o = typeof opts === 'string' ? { text: opts } : (opts || {});
    setReq({ kind, title: o.title || (kind === 'confirm' ? 'Please confirm' : 'Notice'), ...o, resolve });
  }), []);
  const ui = React.useMemo(() => ({
    confirm: (o) => open('confirm', o),
    alert: (o) => open('alert', o).then(() => undefined),
  }), [open]);
  const dialog = req ? <Dialog {...req} onDone={(v) => { const r = req.resolve; setReq(null); r(v); }} /> : null;
  return [dialog, ui];
}
