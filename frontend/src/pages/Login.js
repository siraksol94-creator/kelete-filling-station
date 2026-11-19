import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { isHqHost, setHqBranch } from '../services/api';
import { isMobileApp } from '../utils/platform';
import keleteLogo from '../assets/kelete-logo.png';
import ForecourtArt from '../ux/ForecourtArt';
import { FuelCar } from '../ux/FuelLoader';

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
  const [capsOn, setCapsOn] = useState(false);   // UX-2: warn when Caps Lock is on in the password box
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

  // UX-2 — the website sign-in: forecourt panel + form; one column on phones.
  // Same fields, same login call and messages as before.
  const station = businessName || (hq ? 'Kelete HQ' : 'Kelete');
  const caps = (e) => setCapsOn(!!(e.getModifierState && e.getModifierState('CapsLock')));
  return (
    <div className="k-login">
      <section className="k-login-brand" aria-label="About Kelete">
        <div className="k-login-brand-inner">
          <div className="k-login-kicker">{hq ? 'Head Office' : 'Station management'}</div>
          <h1 className="k-login-station">{station}</h1>
          <p className="k-login-tag">Forecourt, shop and accounts — every shift, litre and kwacha in one place.</p>
          <ForecourtArt />
          <ul className="k-login-points">
            <li><span aria-hidden="true">⛽</span> Shifts &amp; meter readings</li>
            <li><span aria-hidden="true">💵</span> Cash reconciliation</li>
            <li><span aria-hidden="true">🛢️</span> Tank dips &amp; deliveries</li>
          </ul>
        </div>
      </section>
      <main className="k-login-main">
        <form className="k-login-form" onSubmit={handleSubmit} noValidate={false}>
          <div className="k-login-mobile-brand" aria-hidden="true"><FuelCar width={42} /> <span>{station}</span></div>
          <h2>Sign in</h2>
          <p className="k-login-sub">Welcome back. Use the username and password your administrator gave you.</p>
          {error && <div className="login-error" role="alert">{error}</div>}
          <label className="k-login-field">
            <span>Username</span>
            <input type="text" value={email} onChange={e => setEmail(e.target.value)} placeholder="Your username"
              autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck="false" autoFocus required />
          </label>
          <label className="k-login-field">
            <span>Password</span>
            <span className="k-login-pw">
              <input type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                onKeyUp={caps} onKeyDown={caps} placeholder="Your password" autoComplete="current-password" required
                aria-describedby={capsOn ? 'k-caps' : undefined} />
              <button type="button" onClick={() => setShowPassword(v => !v)} aria-pressed={showPassword}
                aria-label={showPassword ? 'Hide password' : 'Show password'}>{showPassword ? 'Hide' : 'Show'}</button>
            </span>
            {capsOn && <span id="k-caps" className="k-login-caps" role="status">Caps Lock is on</span>}
          </label>
          <button type="submit" className="k-login-submit" disabled={loading}>
            {loading ? <><FuelCar width={30} className="k-login-car" /> Signing in…</> : 'Sign in'}
          </button>
          <p className="k-login-foot">Trouble signing in? Ask your station administrator to reset your password.</p>
        </form>
      </main>
    </div>
  );
};

export default Login;
