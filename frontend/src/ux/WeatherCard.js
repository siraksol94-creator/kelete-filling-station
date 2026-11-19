// UX-4 — the station's weather and what it means for fuel (Dashboard).
// Data and advice come from the server (/api/weather, MET Norway). If there is
// no internet, or no location set, the card says so and nothing else changes.
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FiMapPin, FiAlertTriangle, FiInfo, FiCheckCircle, FiEye } from 'react-icons/fi';
import { getWeather, setWeatherLocation } from '../services/api';
import WeatherIcon, { labelOf } from './WeatherIcon';
import ZAMBIA_TOWNS from './zambiaTowns';
import { askDeviceLocation, locationPermission, locationProblem, nameForSpot } from './deviceLocation';

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayName = (ymd, i) => (i === 0 ? 'Today' : DAY[new Date(`${ymd}T12:00:00Z`).getUTCDay()]);
const t = (n) => (n == null || !Number.isFinite(Number(n)) ? '–' : `${Math.round(Number(n))}°`);
const LEVEL_ICON = { warn: <FiAlertTriangle />, watch: <FiEye />, info: <FiInfo />, ok: <FiCheckCircle /> };

function LocationPicker({ onSaved, onCancel }) {
  const [town, setTown] = useState('Lusaka');
  const [custom, setCustom] = useState({ lat: '', lon: '' });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  // "Use this device's location": the device asks the person first.
  const [here, setHere] = useState(null);        // { lat, lon, label, km, accuracy }
  const [locating, setLocating] = useState(false);
  const [perm, setPerm] = useState(null);
  useEffect(() => { locationPermission().then(setPerm); }, []);
  const useDevice = async () => {
    setErr(''); setLocating(true);
    try {
      const p = await askDeviceLocation();
      const n = nameForSpot(p.lat, p.lon);
      setHere({ ...p, label: n.label, km: n.km });
      setTown('__device');
    } catch (ex) { setErr(locationProblem(ex && ex.code)); }
    finally { setLocating(false); locationPermission().then(setPerm); }
  };
  const save = async (e) => {
    e.preventDefault(); setErr(''); setSaving(true);
    try {
      const pick = ZAMBIA_TOWNS.find((x) => x.name === town);
      const body = town === '__device' && here ? { town: here.label, lat: here.lat, lon: here.lon }
        : town === '__custom' ? { town: 'Station', lat: Number(custom.lat), lon: Number(custom.lon) } : { town: pick.name, lat: pick.lat, lon: pick.lon };
      await setWeatherLocation(body);
      onSaved();
    } catch (ex) { setErr(ex.response?.data?.error || 'Could not save the location.'); }
    finally { setSaving(false); }
  };
  return (
    <form className="k-wx-picker" onSubmit={save}>
      <div className="k-wx-geo">
        <button type="button" className="k-wx-geo-btn" onClick={useDevice} disabled={locating} aria-describedby="k-wx-geo-note">
          <span className={`k-wx-geo-pin${locating ? ' is-finding' : ''}`} aria-hidden="true" />
          {locating ? 'Finding this device…' : "Use this device's location"}
        </button>
        <span id="k-wx-geo-note" className="k-wx-geo-note">
          {perm === 'denied' ? 'Location is blocked for this site — allow it in the browser settings to use this.'
            : perm === 'granted' ? 'Location access is allowed on this device.'
            : 'Your device will ask before sharing its location. Only the station\'s coordinates are saved.'}
        </span>
      </div>
      {town === '__device' && here && (
        <div className="k-wx-geo-found" role="status">
          <strong>{here.label}</strong>
          <span>{here.lat.toFixed(4)}, {here.lon.toFixed(4)}{here.accuracy ? ` · within about ${here.accuracy >= 1000 ? `${Math.round(here.accuracy / 1000)} km` : `${Math.round(here.accuracy)} m`}` : ''}</span>
        </div>
      )}
      <div className="k-wx-or" aria-hidden="true"><span>or choose a town</span></div>
      <label className="k-login-field" style={{ marginBottom: 8 }}>
        <span>Where is the station?</span>
        <select value={town} onChange={(e) => setTown(e.target.value)} style={{ width: '100%', minHeight: 42, borderRadius: 10, border: '1.5px solid #64748b', padding: '0 10px', fontSize: 15 }}>
          {here && <option value="__device">This device — {here.label}</option>}
          {ZAMBIA_TOWNS.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
          <option value="__custom">Other — type coordinates</option>
        </select>
      </label>
      {town === '__custom' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label className="k-login-field"><span>Latitude</span><input inputMode="decimal" value={custom.lat} onChange={(e) => setCustom({ ...custom, lat: e.target.value })} placeholder="-15.4167" required /></label>
          <label className="k-login-field"><span>Longitude</span><input inputMode="decimal" value={custom.lon} onChange={(e) => setCustom({ ...custom, lon: e.target.value })} placeholder="28.2833" required /></label>
        </div>
      )}
      {err && <div className="k-field-error" role="alert">{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
        <button type="submit" className="k-btn k-btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save location'}</button>
        {onCancel && <button type="button" className="k-btn k-btn-quiet" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

export default function WeatherCard() {
  const navigate = useNavigate();
  const [w, setW] = useState(null);
  const [allAdvice, setAllAdvice] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = () => getWeather().then((r) => setW(r.data)).catch(() => setW({ configured: true, available: false }));
  useEffect(() => { load(); const id = setInterval(load, 30 * 60 * 1000); return () => clearInterval(id); }, []);

  if (!w) return <div className="k-empty">Checking the sky…</div>;
  if (!w.configured || editing) {
    return w.can_set
      ? <><p className="k-muted" style={{ margin: '0 0 8px' }}>Set the station's location once to see the weather and what it means for your fuel.</p><LocationPicker onSaved={() => { setEditing(false); load(); }} onCancel={editing ? () => setEditing(false) : null} /></>
      : <div className="k-empty">Weather appears here once an Administrator sets the station's location.</div>;
  }
  if (!w.available && w.reason === 'no-contact') {
    // MET Norway asks every app to say who to contact; we use the business email.
    return (
      <div className="k-empty">
        {w.town ? <><strong>{w.town}</strong> is saved. </> : null}
        The weather service needs a contact email first.{' '}
        {w.can_set
          ? <>Add the <strong>Business Email</strong> under <button type="button" className="k-linkish" onClick={() => navigate('/settings/profile')}>Profile → Business Information</button>, then come back.</>
          : 'Ask an Administrator to add the business email under Profile → Business Information.'}
      </div>
    );
  }
  if (!w.available) {
    return <div className="k-empty">Weather isn't available right now (no internet connection to the weather service). Everything else works as normal.</div>;
  }
  const now = w.now || {};
  return (
    <div className="k-wx-card">
      <div className="k-wx-now">
        <WeatherIcon symbol={now.symbol} size={76} />
        <div>
          <div className="k-wx-temp">{t(now.temp)}<span>C</span></div>
          <div className="k-wx-desc">{labelOf(now.symbol)}{w.today && <> · H {t(w.today.max)} L {t(w.today.min)}</>}</div>
          <div className="k-muted"><FiMapPin aria-hidden="true" /> {w.town || 'Station'}{w.stale && ' · last known forecast'}
            {w.can_set && <button type="button" className="k-link-btn" onClick={() => setEditing(true)} style={{ padding: '0 0 0 6px', minHeight: 0 }}>change</button>}</div>
        </div>
      </div>
      <ol className="k-wx-days" aria-label="Forecast">
        {(w.days || []).slice(0, 4).map((d, i) => (
          <li key={d.date}>
            <span className="k-wx-dname">{dayName(d.date, i)}</span>
            <WeatherIcon symbol={d.symbol} size={30} />
            <span className="k-wx-range"><strong>{t(d.max)}</strong> {t(d.min)}</span>
            {d.rain_mm >= 1 && <span className="k-wx-rain">{Math.round(d.rain_mm)} mm</span>}
          </li>
        ))}
      </ol>
      <div className="k-wx-advice-title">What it means for the fuel</div>
      <ul className="k-wx-advice">
        {(allAdvice ? (w.advice || []) : (w.advice || []).slice(0, 3)).map((a) => (
          <li key={a.key} className={`k-wx-${a.level}`}>
            <span className="k-wx-adv-ico" aria-hidden="true">{LEVEL_ICON[a.level] || <FiInfo />}</span>
            <div><strong>{a.title}</strong><span>{a.text}</span></div>
          </li>
        ))}
      </ul>
      {(w.advice || []).length > 3 && (
        <button type="button" className="k-link-btn" onClick={() => setAllAdvice((v) => !v)} aria-expanded={allAdvice} style={{ justifySelf: 'start' }}>
          {allAdvice ? 'Show less' : `Show all ${w.advice.length}`}
        </button>
      )}
      <div className="k-wx-source">Weather data: {w.source}</div>
    </div>
  );
}
