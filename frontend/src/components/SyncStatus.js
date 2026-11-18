import React, { useState, useEffect, useRef, useCallback } from 'react';

const STATE_CONFIG = {
  synced:   { color: '#22c55e', label: 'Synced' },
  syncing:  { color: '#f59e0b', label: 'Syncing...' },
  checking: { color: '#f59e0b', label: 'Checking...' },
  offline:  { color: '#ef4444', label: 'Offline' },
  error:    { color: '#ef4444', label: 'Sync Error' },
  idle:     { color: '#9ca3af', label: 'Local Only' },
  unknown:  { color: '#9ca3af', label: '...' },
};

const POLL_INTERVAL = 5_000;

const SyncStatus = () => {
  const [status, setStatus] = useState({ state: 'unknown', lastSynced: null, error: null });
  const [showTooltip, setShowTooltip] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const tooltipRef = useRef(null);

  const forceResync = useCallback(async () => {
    setResyncing(true);
    try {
      await fetch('/api/sync/force-resync', { method: 'POST' });
    } catch (e) {}
    setResyncing(false);
  }, []);

  useEffect(() => {
    let prevLastSynced = null;
    const fetch_status = () => {
      fetch('/api/sync/current-status')
        .then(r => r.json())
        .then(data => {
          setStatus(data);
          if (data.lastSynced && prevLastSynced !== null && data.lastSynced !== prevLastSynced) {
            window.dispatchEvent(new CustomEvent('sync-complete'));
          }
          prevLastSynced = data.lastSynced;
        })
        .catch(() => {});
    };
    fetch_status();
    const timer = setInterval(fetch_status, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, []);

  const cfg = STATE_CONFIG[status.state] || STATE_CONFIG.unknown;

  const formatTime = (iso) => {
    if (!iso) return null;
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div
      ref={tooltipRef}
      style={{ position: 'relative' }}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, cursor: 'default',
        padding: '5px 10px', borderRadius: 20, background: '#f9fafb',
        border: '1px solid #e5e7eb',
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%',
          background: cfg.color, display: 'inline-block',
          boxShadow: status.state === 'syncing' || status.state === 'checking'
            ? `0 0 0 3px ${cfg.color}33` : 'none',
        }} />
        <span style={{ fontSize: 12, color: '#374151', fontWeight: 500 }}>{cfg.label}</span>
      </div>

      {showTooltip && (
        <div style={{
          position: 'absolute', top: '110%', right: 0, zIndex: 1000,
          background: '#1f2937', color: '#f9fafb', fontSize: 11,
          padding: '6px 10px', borderRadius: 6, whiteSpace: 'nowrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          minWidth: 160,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>Cloud Sync</div>
          {status.lastSynced && (
            <div style={{ color: '#d1d5db' }}>Last synced: {formatTime(status.lastSynced)}</div>
          )}
          {status.error && (
            <div style={{ color: '#fca5a5', marginTop: 2 }}>Error: {status.error}</div>
          )}
          {status.state === 'idle' && (
            <div style={{ color: '#d1d5db' }}>Not registered — go to Setup</div>
          )}
          {status.state !== 'idle' && (
            <button
              onClick={forceResync}
              disabled={resyncing}
              style={{
                marginTop: 6, width: '100%', padding: '3px 0',
                background: resyncing ? '#374151' : '#3b82f6',
                color: '#fff', border: 'none', borderRadius: 4,
                cursor: resyncing ? 'not-allowed' : 'pointer', fontSize: 11,
              }}
            >
              {resyncing ? 'Marking...' : 'Force Resync All'}
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default SyncStatus;
