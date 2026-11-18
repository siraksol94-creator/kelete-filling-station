// ChangePasswordModal — a signed-in user changes their own password.
// Opened from the sidebar footer, next to Logout. Asks for the current
// password, the new one and the new one again. Backend: POST /api/auth/change-password.
import React, { useState } from 'react';
import { FiX, FiEye, FiEyeOff, FiCheckCircle } from 'react-icons/fi';
import Portal from '../utils/Portal';
import { changePassword } from '../services/api';

const NAVY = '#13306b';

export default function ChangePasswordModal({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!current || !next || !confirm) return setError('Fill in all three fields.');
    if (next.length < 4) return setError('The new password must be at least 4 characters.');
    if (next !== confirm) return setError('The new passwords do not match.');
    if (next === current) return setError('The new password must be different from the current one.');
    setSaving(true);
    try {
      await changePassword({ currentPassword: current, newPassword: next });
      setDone(true);
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not change the password. Try again.');
    }
    setSaving(false);
  };

  const input = (value, setValue, autoComplete, autoFocus, bad) => (
    <input
      type={show ? 'text' : 'password'}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      style={{
        width: '100%', padding: '10px 12px', fontSize: 14, borderRadius: 8, boxSizing: 'border-box',
        border: `1.5px solid ${bad ? '#fca5a5' : '#d1d5db'}`, outline: 'none', color: '#0f172a',
      }}
    />
  );

  return (
    <Portal>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.55)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
           onClick={(e) => { if (e.target === e.currentTarget && !saving) onClose(); }}>
        <form onSubmit={submit}
              style={{ width: '100%', maxWidth: 400, background: '#fff', borderRadius: 14, boxShadow: '0 24px 64px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #eef1f5' }}>
            <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: '#0f172a' }}>Change password</h3>
            <button type="button" onClick={onClose} disabled={saving} aria-label="Close"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', display: 'inline-flex', padding: 4 }}>
              <FiX size={18} />
            </button>
          </div>

          {done ? (
            <div style={{ padding: '26px 20px 20px', textAlign: 'center' }}>
              <FiCheckCircle size={40} color="#16a34a" />
              <p style={{ margin: '12px 0 4px', fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Your password has been changed</p>
              <p style={{ margin: '0 0 18px', fontSize: 13, color: '#64748b' }}>Use the new password the next time you log in.</p>
              <button type="button" onClick={onClose}
                style={{ padding: '10px 22px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                Done
              </button>
            </div>
          ) : (
            <>
              <div style={{ padding: '18px 20px', display: 'grid', gap: 14 }}>
                <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                  Current password
                  {input(current, setCurrent, 'current-password', true)}
                </label>
                <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                  New password
                  {input(next, setNext, 'new-password', false)}
                </label>
                <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 600, color: '#374151' }}>
                  Confirm new password
                  {input(confirm, setConfirm, 'new-password', false, mismatch)}
                  {mismatch && <span style={{ fontSize: 12, fontWeight: 500, color: '#b91c1c' }}>The new passwords do not match.</span>}
                </label>
                <button type="button" onClick={() => setShow((s) => !s)}
                  style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', padding: 0, color: NAVY, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  {show ? <FiEyeOff size={14} /> : <FiEye size={14} />} {show ? 'Hide passwords' : 'Show passwords'}
                </button>
                {error && (
                  <div style={{ padding: '9px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, color: '#b91c1c' }}>
                    {error}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 20px', borderTop: '1px solid #eef1f5', background: '#fff' }}>
                <button type="button" onClick={onClose} disabled={saving}
                  style={{ padding: '10px 16px', background: '#fff', color: '#374151', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                  Cancel
                </button>
                <button type="submit" disabled={saving}
                  style={{ padding: '10px 18px', background: NAVY, color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.75 : 1 }}>
                  {saving ? 'Saving…' : 'Change password'}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </Portal>
  );
}
