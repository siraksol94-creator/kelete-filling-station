import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { isHqHost, setHqBranch } from '../services/api';
import { isMobileApp } from '../utils/platform';
import keleteLogo from '../assets/kelete-logo.png';

// v1.5.1: HQ login no longer forces a branch pick. On the bare HQ host
// (keletezm.com) the user just types email + password — authenticated
// against the default DB users table. After login, the sidebar's
// "Active Branch" dropdown still lets HQ admins drop into any branch's
// data when they need to.
const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [businessName, setBusinessName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const hq = isHqHost();

  // v1.13.4 — pull the branch's business_name from the public settings
  // endpoint so the login card shows "Buseko Depo" / "Garden Depo" /
  // "Kelete HQ" per branch instead of the hardcoded Kelete string.
  useEffect(() => {
    let cancelled = false;
    axios.get('/api/settings/business/public')
      .then(r => { if (!cancelled) setBusinessName(r.data?.business_name || ''); })
      .catch(() => { /* keep fallback */ });
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      // Make sure no stale branch is attached to the login request — the
      // axios interceptor reads localStorage hq_branch and would otherwise
      // route auth/login into a per-branch DB.
      if (hq) setHqBranch('');
      await login(email, password);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // 2026-09-11 — the compact login, in the Kelete APK only (phones and the POS
  // small terminal). The website — any browser, whatever its width or Device
  // Type — keeps the card below, as it was. Red Sea asked for the APK only.
  const compact = isMobileApp();
  if (compact) {
    // "Kelete Distribution - LIVINGSTONE" → "LIVINGSTONE Depot". A name
    // without the " - " part is shown as it is.
    const parts = String(businessName || '').split(/\s+-\s+/);
    const depot = parts.length > 1 ? `${parts[parts.length - 1]} Depot` : (businessName || 'Distribution Management');
    return (
      <div className="login-compact">
        <div className="lc-brand">
          <img className="lc-mark" src={keleteLogo} alt="" aria-hidden="true" />
          <h1><span className="r">RED</span> SEA DISTRIBUTION</h1>
          <p>{hq ? 'Head Office' : depot}</p>
        </div>
        {error && <div className="login-error">{error}</div>}
        <form className="lc-form" onSubmit={handleSubmit}>
          <label>
            Username
            <input type="text" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="Your username" autoCapitalize="none" autoCorrect="off" autoComplete="username" required />
          </label>
          <label>
            Password
            <span className="lc-pw">
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                placeholder="Your password" autoComplete="current-password" required />
              <button type="button" onClick={() => setShowPassword(v => !v)}>{showPassword ? 'Hide' : 'Show'}</button>
            </span>
          </label>
          <button type="submit" className="lc-submit" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div className="lc-foot">Red Sea Import &amp; Export (Z) Ltd</div>
      </div>
    );
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <img src={keleteLogo} alt="Red Sea"
            style={{ display: 'block', width: 120, height: 120, objectFit: 'contain', margin: '0 auto 22px' }} />
          <h1>{businessName || (hq ? 'Kelete HQ' : 'Kelete')}</h1>
          <p>{hq ? 'Head Office' : 'Distribution Management'}</p>
        </div>
        {error && <div className="login-error">{error}</div>}
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Username</label>
            <input type="text" value={email} onChange={e => setEmail(e.target.value)} placeholder="Enter your username" required />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" required />
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
