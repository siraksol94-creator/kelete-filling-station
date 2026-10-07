// Shared confirmation modal — asks for any admin password before a sensitive
// action (delete, void, etc). On success calls onConfirm({ adminId, adminName, password })
// so the caller knows who approved. Backend: POST /auth/verify-admin
//
// 2026-09-07 — the password is handed back as well. Verifying here only
// proves it to the browser; an action that must really be gated has to send
// it on and have its own route check it.
import React, { useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { FiX, FiLock, FiAlertTriangle } from 'react-icons/fi';
import { verifyAdmin } from '../services/api';

export default function AdminPasswordPrompt({ open, subject, actionLabel = 'Confirm Delete', onConfirm, onCancel }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      setError('');
      setBusy(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  if (!open) return null;

  const submit = async (e) => {
    if (e) e.preventDefault();
    if (!password) { setError('Enter the admin password.'); return; }
    setBusy(true); setError('');
    try {
      const r = await verifyAdmin({ password });
      if (r.data?.ok) {
        onConfirm({ adminId: r.data.adminId, adminName: r.data.adminName, password });
      } else {
        setError('Invalid admin password.');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Verification failed.');
    } finally {
      setBusy(false);
    }
  };

  return ReactDOM.createPortal((
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onCancel(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <form
        onSubmit={submit}
        style={{ background: '#fff', borderRadius: 12, padding: 24, width: 420, maxWidth: 'calc(100vw - 32px)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#b91c1c' }}>
            <FiLock size={20} />
            <h2 style={{ fontSize: 17, fontWeight: 700, margin: 0, color: '#111827' }}>Admin Authorization Required</h2>
          </div>
          <button type="button" onClick={onCancel} disabled={busy} style={{ background: 'none', border: 'none', cursor: busy ? 'not-allowed' : 'pointer', color: '#6b7280' }}>
            <FiX size={20} />
          </button>
        </div>

        {subject && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#991b1b', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 }}>You're about to delete</div>
            <div style={{ fontSize: 14, color: '#7f1d1d', fontWeight: 600 }}>{subject}</div>
          </div>
        )}

        <p style={{ fontSize: 13, color: '#4b5563', margin: '0 0 12px' }}>
          Enter any administrator's password to confirm.
        </p>

        <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 }}>Admin Password</label>
        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(''); }}
          disabled={busy}
          autoComplete="current-password"
          placeholder="••••••••"
          style={{ width: '100%', padding: '10px 12px', border: `1px solid ${error ? '#dc2626' : '#d1d5db'}`, borderRadius: 8, fontSize: 14, boxSizing: 'border-box', outline: 'none' }}
        />

        {error && (
          <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, color: '#b91c1c', fontSize: 13 }}>
            <FiAlertTriangle size={14} /> {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{ padding: '9px 18px', background: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: busy ? 'not-allowed' : 'pointer' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !password}
            style={{ padding: '9px 18px', background: busy || !password ? '#fca5a5' : '#dc2626', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: busy || !password ? 'not-allowed' : 'pointer' }}
          >
            {busy ? 'Verifying…' : actionLabel}
          </button>
        </div>
      </form>
    </div>
  ), document.body);
}
