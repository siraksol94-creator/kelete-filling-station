import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const BASE_DOMAIN = 'keletezm.com';
function buildVpsUrl(slug) {
  return `https://${slug.trim().toLowerCase()}.${BASE_DOMAIN}`;
}

function toBranchCode(branchId) {
  if (!branchId || branchId === 'local-only') return null;
  return branchId.replace(/-/g, '').substring(0, 8).toUpperCase();
}

const Setup = ({ onComplete, startAtCreateAdmin = false }) => {
  const navigate = useNavigate();
  const { loginWithToken } = useAuth();

  // 'choose' | 'newBranch' | 'createAdmin' | 'joinBranch' | 'joinSyncing'
  const [mode, setMode] = useState(startAtCreateAdmin ? 'createAdmin' : 'choose');

  // New Branch Step 1
  const [slug, setSlug]             = useState('');
  const [branchName, setBranchName] = useState('');
  const [licenseKey, setLicenseKey] = useState('');

  // Create Admin (Step 2)
  const [firstName, setFirstName]         = useState('');
  const [lastName, setLastName]           = useState('');
  const [adminEmail, setAdminEmail]       = useState('');
  const [adminPhone, setAdminPhone]       = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword]   = useState(false);
  const [showConfirm, setShowConfirm]     = useState(false);
  const [adminPermissions, setAdminPermissions] = useState([]);
  // v1.8.42 â€” state for the "Refresh from VPS" recovery action.
  const [refreshState, setRefreshState] = useState('idle'); // 'idle' | 'running' | 'done' | 'error'
  const [refreshMsg, setRefreshMsg] = useState('');

  const ALL_PERMISSIONS = ['POS','Sales','Stock','GRN','SIV','Reports','Accounting','Customers','Suppliers','Full Access'];
  const togglePermission = (perm) => {
    setAdminPermissions(prev =>
      prev.includes(perm) ? prev.filter(p => p !== perm) : [...prev, perm]
    );
  };

  // Join Branch
  const [joinSlug, setJoinSlug]             = useState('');
  const [branchCode, setBranchCode]         = useState('');
  const [joinLicenseKey, setJoinLicenseKey] = useState('');

  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  // Already configured (existing PC opening setup again)
  const [alreadyConfigured, setAlreadyConfigured] = useState(false);
  const [existingBranchCode, setExistingBranchCode] = useState(null);
  const [identity, setIdentity] = useState(null);
  const [subdomain, setSubdomain] = useState(null);
  const [updateStatus, setUpdateStatus] = useState('idle');

  useEffect(() => {
    if (startAtCreateAdmin) return;
    fetch('/api/sync/status')
      .then(r => r.json())
      .then(data => {
        if (data.isConfigured && data.tenantId && data.tenantId !== 'local-only') {
          setAlreadyConfigured(true);
          setExistingBranchCode(toBranchCode(data.branchId));
          const vpsUrl = data.vpsUrl || `https://keletezm.com`;
          const slug = vpsUrl.replace('https://','').split('.')[0];
          setSubdomain(slug);
          fetch(`${vpsUrl}/api/sync/identity?tenantId=${data.tenantId}&branchId=${data.branchId}`)
            .then(r => r.json())
            .then(setIdentity)
            .catch(() => {});
        }
      })
      .catch(() => {});
  }, [startAtCreateAdmin]);

  // â”€â”€ New Branch Step 1 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleNewBranch = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const vpsUrl = buildVpsUrl(slug);
      const r = await fetch(`${vpsUrl}/api/sync/register`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ branchName: branchName.trim(), licenseKey: licenseKey.trim() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Registration failed');
      await fetch('/api/sync/configure', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tenantId: data.tenantId, branchId: data.branchId, vpsUrl }),
      });
      setMode('createAdmin');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // â”€â”€ Create Admin Account (Step 2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleCreateAdmin = async (e) => {
    e.preventDefault();
    if (adminPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (adminPassword.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const r = await fetch('/api/auth/register-first', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ firstName, lastName, email: adminEmail, password: adminPassword, phone: adminPhone, permissions: adminPermissions }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to create account');
      loginWithToken(data.token, data.user);
      onComplete();
      navigate('/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // â”€â”€ Join Branch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleJoinBranch = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const vpsUrl = buildVpsUrl(joinSlug);
      const r = await fetch(`${vpsUrl}/api/sync/join-branch`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ branchCode: branchCode.trim(), licenseKey: joinLicenseKey.trim() }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Failed to join branch');
      await fetch('/api/sync/configure', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tenantId: data.tenantId, branchId: data.branchId, vpsUrl }),
      });
      // Trigger force-resync to pull all branch data (including users) from VPS
      fetch('/api/sync/force-resync', { method: 'POST' }).catch(() => {});
      setMode('joinSyncing');
      // Poll until users are pulled into local DB, then navigate to login
      const pollLogin = setInterval(async () => {
        try {
          const s = await fetch('/api/auth/account-status');
          const d = await s.json();
          if (d.hasUsers) {
            clearInterval(pollLogin);
            onComplete();
            navigate('/login');
          }
        } catch (_) {}
      }, 2000);
      // Safety fallback: navigate after 60 seconds regardless
      setTimeout(() => { clearInterval(pollLogin); onComplete(); navigate('/login'); }, 60000);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  };

  // â”€â”€ Styles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const pageStyle = {
    minHeight: '100vh', display: 'flex', alignItems: 'center',
    justifyContent: 'center',
    background: 'linear-gradient(135deg, #fff1f1 0%, #fdf2f8 100%)',
  };
  const cardStyle = {
    background: '#fff', borderRadius: 16, padding: '48px 40px',
    width: '100%', maxWidth: 440,
    boxShadow: '0 20px 60px rgba(0,0,0,0.1)',
  };
  const inputStyle = {
    width: '100%', padding: '10px 12px', border: '1px solid #d1d5db',
    borderRadius: 8, fontSize: 14, outline: 'none', boxSizing: 'border-box',
  };
  const labelStyle = {
    display: 'block', fontSize: 13, fontWeight: 500, color: '#374151', marginBottom: 6,
  };
  const primaryBtn = (disabled) => ({
    width: '100%', padding: '12px', background: disabled ? '#9ca3af' : '#dc2626',
    color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer', marginBottom: 12,
  });
  const secondaryBtn = {
    width: '100%', padding: '10px', background: 'transparent',
    color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 8,
    fontSize: 14, cursor: 'pointer',
  };

  const logo = (
    <div style={{ textAlign: 'center', marginBottom: 32 }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>ðŸ·</div>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111827' }}>Kelete</h1>
      <p style={{ margin: '6px 0 0', color: '#6b7280', fontSize: 14 }}>Cloud Sync Setup</p>
    </div>
  );

  // â”€â”€ Already configured â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (alreadyConfigured) {
    const rowStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f3f4f6' };
    const keyStyle = { fontSize: 13, color: '#6b7280', fontWeight: 500 };
    const valStyle = { fontSize: 13, color: '#111827', fontWeight: 600, textAlign: 'right' };
    return (
      <div style={pageStyle}>
        <div style={{ ...cardStyle, maxWidth: 480 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>âœ…</div>
            <h2 style={{ margin: '0 0 4px', color: '#111827' }}>Cloud Sync Active</h2>
            <p style={{ color: '#6b7280', fontSize: 13, margin: 0 }}>This device is registered and syncing with the cloud.</p>
          </div>
          <div style={{ background: '#f9fafb', borderRadius: 10, padding: '4px 16px', marginBottom: 20 }}>
            <div style={rowStyle}><span style={keyStyle}>Business Email</span><span style={valStyle}>{identity?.email ?? 'â€”'}</span></div>
            <div style={rowStyle}><span style={keyStyle}>Subdomain</span><span style={valStyle}>{subdomain || 'â€”'}</span></div>
            <div style={rowStyle}><span style={keyStyle}>Branch</span><span style={valStyle}>{identity?.branchName ?? 'â€”'}</span></div>
            <div style={rowStyle}>
              <span style={keyStyle}>License Expires</span>
              <span style={{ ...valStyle, color: identity?.isExpired ? '#dc2626' : identity?.daysRemaining <= 14 ? '#d97706' : '#111827' }}>
                {identity?.expiresAt ? `${identity.expiresAt.substring(0, 10)} (${identity.daysRemaining}d remaining)` : 'â€”'}
              </span>
            </div>
            <div style={{ ...rowStyle, borderBottom: 'none' }}><span style={keyStyle}>Max Branches</span><span style={valStyle}>{identity?.maxBranches ?? 'â€”'}</span></div>
          </div>
          {existingBranchCode && (
            <div style={{ background: '#fff1f1', border: '1px solid #fecaca', borderRadius: 10, padding: '14px 20px', marginBottom: 24, textAlign: 'center' }}>
              <div style={{ fontSize: 12, color: '#dc2626', fontWeight: 600, marginBottom: 4 }}>BRANCH CODE â€” share when adding a new PC to this branch</div>
              <div style={{ fontSize: 32, fontFamily: 'monospace', fontWeight: 700, letterSpacing: '6px', color: '#991b1b' }}>{existingBranchCode}</div>
            </div>
          )}
          {/* v1.8.42 â€” recovery action. Clears the "synced=0" flag on
              every local row, which unblocks the PROTECT-on-pull rule
              so the next sync cycle overwrites local with VPS state.
              Use when local data drifted (e.g. orders show wrong status
              that's correct on web). Discards any unpushed local edits. */}
          <div style={{ marginBottom: 12, padding: '12px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 4 }}>âš  Recovery: Refresh from VPS</div>
            <div style={{ fontSize: 11, color: '#78350f', marginBottom: 8, lineHeight: 1.4 }}>
              Use only if this PC's data is out of sync with the website. Clears pending sync flags so the next pull overwrites local data with VPS as truth. <strong>Any unpushed local edits will be lost.</strong>
            </div>
            <button
              onClick={async () => {
                if (refreshState === 'running') return;
                if (!window.confirm('This will discard any local changes not yet pushed to the cloud, and overwrite this PCâ€™s data with what the cloud has.\n\nProceed?')) return;
                setRefreshState('running'); setRefreshMsg('');
                try {
                  const { clearPendingSyncFlags } = await import('../services/api');
                  const res = await clearPendingSyncFlags();
                  setRefreshState('done');
                  setRefreshMsg(`Cleared ${res.data?.recordsCleared ?? 0} pending flag${res.data?.recordsCleared === 1 ? '' : 's'}. Next sync (~30s) will pull fresh data from VPS.`);
                } catch (e) {
                  setRefreshState('error');
                  setRefreshMsg(e?.response?.data?.error || e.message || 'Refresh failed.');
                }
              }}
              disabled={refreshState === 'running'}
              style={{ width: '100%', padding: '10px', background: refreshState === 'running' ? '#fcd34d' : '#d97706', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: refreshState === 'running' ? 'not-allowed' : 'pointer' }}>
              {refreshState === 'running' ? 'Refreshingâ€¦' : 'Refresh from VPS (Clear Pending)'}
            </button>
            {refreshMsg && (
              <div style={{ marginTop: 8, fontSize: 11, color: refreshState === 'error' ? '#b91c1c' : '#15803d', fontWeight: 600 }}>{refreshMsg}</div>
            )}
          </div>

          <button onClick={() => navigate('/dashboard')} style={{ width: '100%', padding: '12px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: 'pointer', marginBottom: 10 }}>
            Go to Dashboard
          </button>
          <button
            onClick={() => {
              if (!window.electronAPI) return;
              setUpdateStatus('checking');
              const handler = () => { setUpdateStatus('latest'); window.electronAPI.removeUpdateNotAvailableListener(handler); setTimeout(() => setUpdateStatus('idle'), 4000); };
              window.electronAPI.onUpdateNotAvailable(handler);
              window.electronAPI.checkForUpdates().catch(() => { setUpdateStatus('idle'); window.electronAPI.removeUpdateNotAvailableListener(handler); });
              setTimeout(() => { setUpdateStatus(s => s === 'checking' ? 'idle' : s); window.electronAPI.removeUpdateNotAvailableListener(handler); }, 15000);
            }}
            disabled={updateStatus === 'checking'}
            style={{ width: '100%', padding: '10px', background: 'transparent', color: updateStatus === 'latest' ? '#16a34a' : '#6b7280', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, cursor: updateStatus === 'checking' ? 'not-allowed' : 'pointer' }}
          >
            {updateStatus === 'checking' ? 'Checking for updates...' : updateStatus === 'latest' ? 'âœ“ You are on the latest version' : 'Check for Updates'}
          </button>
        </div>
      </div>
    );
  }

  // â”€â”€ Choose mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (mode === 'choose') {
    return (
      <div style={pageStyle}>
        <div style={{ ...cardStyle, maxWidth: 500 }}>
          {logo}
          <p style={{ textAlign: 'center', color: '#6b7280', fontSize: 14, marginBottom: 28 }}>
            How do you want to set up this PC?
          </p>
          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            <button onClick={() => setMode('newBranch')} style={{ flex: 1, padding: '20px 16px', border: '2px solid #fecaca', borderRadius: 12, background: '#fff1f1', cursor: 'pointer', textAlign: 'center' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>ðŸª</div>
              <div style={{ fontWeight: 700, color: '#dc2626', fontSize: 15 }}>New Branch</div>
              <div style={{ fontSize: 12, color: '#ef4444', marginTop: 4 }}>First PC for a new branch</div>
            </button>
            <button onClick={() => setMode('joinBranch')} style={{ flex: 1, padding: '20px 16px', border: '2px solid #bbf7d0', borderRadius: 12, background: '#f0fdf4', cursor: 'pointer', textAlign: 'center' }}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>ðŸ”—</div>
              <div style={{ fontWeight: 700, color: '#15803d', fontSize: 15 }}>Join Branch</div>
              <div style={{ fontSize: 12, color: '#16a34a', marginTop: 4 }}>Add this PC to an existing branch</div>
            </button>
          </div>
          <p style={{ textAlign: 'center', fontSize: 11, color: '#9ca3af', marginTop: 16, marginBottom: 0 }}>
            You can update sync settings later from Settings â†’ Cloud Sync
          </p>
        </div>
      </div>
    );
  }

  // â”€â”€ New Branch Step 1 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (mode === 'newBranch') {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          {logo}
          <div style={{ background: '#fff1f1', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 16px', marginBottom: 24, fontSize: 13, color: '#dc2626' }}>
            Step 1 of 2 â€” Register this device as a new branch
          </div>
          <form onSubmit={handleNewBranch}>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Your Subdomain</label>
              <input type="text" required value={slug} onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="kelete" style={inputStyle} />
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Lowercase letters, numbers and hyphens only</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Branch Name</label>
              <input type="text" required value={branchName} onChange={e => setBranchName(e.target.value)} placeholder="e.g. Main Branch, City Centre" style={inputStyle} />
            </div>
            <div style={{ marginBottom: 24 }}>
              <label style={labelStyle}>License Key</label>
              <input type="text" required value={licenseKey} onChange={e => setLicenseKey(e.target.value.toUpperCase())} placeholder="KELETE-XXXX-XXXX-XXXX" style={{ ...inputStyle, fontFamily: 'monospace', letterSpacing: '1px' }} />
            </div>
            {error && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#dc2626' }}>{error}</div>}
            <button type="submit" disabled={loading} style={primaryBtn(loading)}>
              {loading ? 'Registering...' : 'Register & Enable Sync'}
            </button>
            <button type="button" onClick={() => { setMode('choose'); setError(''); }} style={secondaryBtn}>Back</button>
          </form>
        </div>
      </div>
    );
  }

  // â”€â”€ Create Admin (Step 2) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (mode === 'createAdmin') {
    const pwInputStyle = { ...inputStyle, paddingRight: 44 };
    const eyeBtn = { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#6b7280', padding: 0 };
    const readonlyStyle = { ...inputStyle, background: '#f3f4f6', color: '#6b7280', cursor: 'default' };
    const chipStyle = (active) => ({
      display: 'inline-block', padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 500, cursor: 'pointer', margin: '3px',
      background: active ? '#dc2626' : '#f3f4f6', color: active ? '#fff' : '#374151',
      border: active ? '1px solid #dc2626' : '1px solid #e5e7eb',
    });
    return (
      <div style={pageStyle}>
        <div style={{ ...cardStyle, maxWidth: 500 }}>
          {logo}
          <div style={{ background: '#fff1f1', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 16px', marginBottom: 24, fontSize: 13, color: '#dc2626' }}>
            {startAtCreateAdmin ? 'Create your Administrator account to continue' : 'Step 2 of 2 â€” Create your Administrator account'}
          </div>
          <form onSubmit={handleCreateAdmin}>
            {/* Name row */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>First Name *</label>
                <input type="text" required value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="John" style={inputStyle} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Last Name *</label>
                <input type="text" required value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Doe" style={inputStyle} />
              </div>
            </div>
            {/* Username */}
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Username *</label>
              <input type="text" required value={adminEmail} onChange={e => setAdminEmail(e.target.value)} placeholder="e.g. solomon or admin" style={inputStyle} />
            </div>
            {/* Phone */}
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Phone</label>
              <input type="text" value={adminPhone} onChange={e => setAdminPhone(e.target.value)} placeholder="e.g. +251 912 345 678" style={inputStyle} />
            </div>
            {/* Password */}
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Password *</label>
              <div style={{ position: 'relative' }}>
                <input type={showPassword ? 'text' : 'password'} required value={adminPassword} onChange={e => setAdminPassword(e.target.value)} placeholder="Min. 6 characters" style={pwInputStyle} />
                <button type="button" style={eyeBtn} onClick={() => setShowPassword(v => !v)}>{showPassword ? 'ðŸ™ˆ' : 'ðŸ‘ï¸'}</button>
              </div>
            </div>
            {/* Confirm Password */}
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Confirm Password *</label>
              <div style={{ position: 'relative' }}>
                <input type={showConfirm ? 'text' : 'password'} required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} placeholder="Repeat password" style={pwInputStyle} />
                <button type="button" style={eyeBtn} onClick={() => setShowConfirm(v => !v)}>{showConfirm ? 'ðŸ™ˆ' : 'ðŸ‘ï¸'}</button>
              </div>
            </div>
            {/* Role â€” read-only */}
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Role</label>
              <input type="text" value="Administrator" readOnly style={readonlyStyle} />
            </div>
            {/* Permissions */}
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Permissions</label>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: '10px 12px', background: '#fafafa' }}>
                {ALL_PERMISSIONS.map(p => (
                  <span key={p} style={chipStyle(adminPermissions.includes(p))} onClick={() => togglePermission(p)}>{p}</span>
                ))}
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Click to toggle. Leave empty for no module restrictions.</div>
            </div>
            {/* Status â€” read-only */}
            <div style={{ marginBottom: 24 }}>
              <label style={labelStyle}>Status</label>
              <input type="text" value="Active" readOnly style={{ ...readonlyStyle, color: '#16a34a' }} />
            </div>
            {error && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#dc2626' }}>{error}</div>}
            <button type="submit" disabled={loading} style={primaryBtn(loading)}>
              {loading ? 'Creating Account...' : 'Create Account & Continue'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // â”€â”€ Join Branch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (mode === 'joinBranch') {
    return (
      <div style={pageStyle}>
        <div style={cardStyle}>
          {logo}
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 16px', marginBottom: 24, fontSize: 13, color: '#15803d' }}>
            Enter the Branch Code shown on a PC already registered to this branch.
          </div>
          <form onSubmit={handleJoinBranch}>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Your Subdomain</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                <input type="text" required value={joinSlug} onChange={e => setJoinSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} placeholder="mybusiness" style={{ ...inputStyle, borderRadius: '8px 0 0 8px', flex: 1 }} />
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Same subdomain as the other PC in this branch</div>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Branch Code</label>
              <input type="text" required value={branchCode} onChange={e => setBranchCode(e.target.value.toUpperCase())} placeholder="e.g. A1B2C3D4" maxLength={8} style={{ ...inputStyle, fontFamily: 'monospace', letterSpacing: '4px', fontSize: 18, textAlign: 'center' }} />
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>8-character code â€” find it on the other PC under Settings â†’ Cloud Sync</div>
            </div>
            <div style={{ marginBottom: 24 }}>
              <label style={labelStyle}>License Key</label>
              <input type="text" required value={joinLicenseKey} onChange={e => setJoinLicenseKey(e.target.value.toUpperCase())} placeholder="KELETE-XXXX-XXXX-XXXX" style={{ ...inputStyle, fontFamily: 'monospace', letterSpacing: '1px' }} />
            </div>
            {error && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#dc2626' }}>{error}</div>}
            <button type="submit" disabled={loading} style={primaryBtn(loading)}>
              {loading ? 'Joining...' : 'Join Branch'}
            </button>
            <button type="button" onClick={() => { setMode('choose'); setError(''); }} style={secondaryBtn}>Back</button>
          </form>
        </div>
      </div>
    );
  }

  // â”€â”€ Join Syncing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (mode === 'joinSyncing') {
    return (
      <div style={pageStyle}>
        <div style={{ ...cardStyle, textAlign: 'center' }}>
          {logo}
          <div style={{ fontSize: 40, marginBottom: 20 }}>â³</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: '#1f2937', marginBottom: 10 }}>Syncing Branch Data</h2>
          <p style={{ fontSize: 14, color: '#6b7280', marginBottom: 24, lineHeight: 1.6 }}>
            Please wait while your branch data is being downloaded from the cloud.<br />
            You will be taken to the login screen automatically.
          </p>
          <div style={{ width: '100%', height: 6, background: '#f3f4f6', borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ height: '100%', background: '#dc2626', borderRadius: 99, animation: 'progress 6s linear forwards' }} />
          </div>
          <style>{`@keyframes progress { from { width: 0% } to { width: 100% } }`}</style>
        </div>
      </div>
    );
  }

  return null;
};

export default Setup;
