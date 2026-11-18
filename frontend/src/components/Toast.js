import React, { useEffect } from 'react';

const Toast = ({ message, type = 'success', onClose }) => {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [message, onClose]);

  if (!message) return null;

  const bg = type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#2563eb';
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';

  return (
    <div style={{
      position: 'fixed', bottom: 28, right: 28, zIndex: 9999,
      background: bg, color: '#fff',
      padding: '13px 20px', borderRadius: 10,
      boxShadow: '0 4px 24px rgba(0,0,0,0.22)',
      fontSize: 14, fontWeight: 600,
      display: 'flex', alignItems: 'center', gap: 10,
      maxWidth: 380, animation: 'fadeInUp 0.2s ease',
    }}>
      <span style={{ fontSize: 16 }}>{icon}</span>
      {message}
    </div>
  );
};

export default Toast;
