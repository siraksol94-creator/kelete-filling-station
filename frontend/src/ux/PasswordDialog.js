// UX-3 — a masked password box to replace window.prompt() where a password or
// passcode is asked for (the browser's prompt shows what you type).
//
//   const [dialog, askPassword] = usePasswordDialog();
//   const pwd = await askPassword({ title, label, subject, actionLabel });  // string, or null if cancelled
//   ...
//   return <>{...}{dialog}</>;
//
// It only collects the password; the server checks it, exactly as before.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { FiLock, FiX } from 'react-icons/fi';

function Dialog({ title, label, subject, note, actionLabel, danger, onDone }) {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const ref = useRef(null);
  useEffect(() => { const t = setTimeout(() => ref.current && ref.current.focus(), 30); return () => clearTimeout(t); }, []);
  const cancel = () => onDone(null);
  return ReactDOM.createPortal(
    <div className="k-help-backdrop" onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } }}>
      <form className="k-pw-dialog" role="dialog" aria-modal="true" aria-labelledby="k-pw-title"
        onSubmit={(e) => { e.preventDefault(); if (value) onDone(value); }}>
        <div className="k-pw-head">
          <span className="k-pw-icon" aria-hidden="true"><FiLock /></span>
          <h2 id="k-pw-title">{title}</h2>
          <button type="button" className="k-icon-btn" onClick={cancel} aria-label="Cancel"><FiX /></button>
        </div>
        {subject && <div className={`k-pw-subject ${danger ? 'k-pw-danger' : ''}`}>{subject}</div>}
        {note && <p className="k-muted" style={{ margin: '0 0 10px' }}>{note}</p>}
        <label className="k-login-field" style={{ marginBottom: 6 }}>
          <span>{label}</span>
          <span className="k-login-pw">
            <input ref={ref} type={show ? 'text' : 'password'} value={value} onChange={(e) => setValue(e.target.value)}
              autoComplete="current-password" data-keep-case required />
            <button type="button" onClick={() => setShow((v) => !v)} aria-pressed={show} aria-label={show ? 'Hide' : 'Show'}>{show ? 'Hide' : 'Show'}</button>
          </span>
        </label>
        <div className="k-pw-actions">
          <button type="button" className="k-btn k-btn-quiet" onClick={cancel}>Cancel</button>
          <button type="submit" className={`k-btn ${danger ? 'k-btn-danger' : 'k-btn-primary'}`} disabled={!value}>{actionLabel || 'Confirm'}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export function usePasswordDialog() {
  const [req, setReq] = useState(null);
  const ask = useCallback((opts) => new Promise((resolve) => setReq({ ...opts, resolve })), []);
  const dialog = req ? (
    <Dialog {...req} onDone={(v) => { const r = req.resolve; setReq(null); r(v); }} />
  ) : null;
  return [dialog, ask];
}
