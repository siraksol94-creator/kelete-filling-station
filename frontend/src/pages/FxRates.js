// FxRates — Accounting → Currency Rates.
//
// Per-branch USD↔FRA rate management. Only useful when the branch is in
// dual-currency mode (USD+FRA); on a USD-only branch the page renders a
// "not applicable" notice rather than a form, so the sidebar entry isn't
// confusing if someone wires it up there too.
//
// Daily flow: manager opens the page, types today's Sell + Buy, hits Save.
// POS / Cashier auto-pick up the latest effective row on the next render.
// Old rows stay around (soft-deleted only) so backdated receipts replay
// with the rate that was in effect on the order's date.
import React, { useEffect, useMemo, useState } from 'react';
import { FiRefreshCw, FiPlus, FiTrash2, FiDollarSign, FiGlobe, FiTrendingUp } from 'react-icons/fi';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { getFxRates, createFxRate, deleteFxRate, getLiveFxRate, getLiveFxRateHistory } from '../services/api';
import { useCurrency } from '../context/CurrencyContext';

const todayISO = () => new Date().toISOString().slice(0, 10);
const fmtRate = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });


export default function FxRates() {
  const { currencyMode } = useCurrency();
  // v1.7.0: 'USD+FRA' = dual (FRA only), 'USD+FRA+K' = triple (also Kwacha).
  const isDual  = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const hasK    = currencyMode === 'USD+FRA+K';
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  // Live BCC reference rate from open.er-api.com. Cashier does NOT use it
  // — it's just a sanity check for the manager when typing the manual rate.
  const [live, setLive] = useState(null);   // { rate, source, fetchedAt, error? }
  const [liveLoading, setLiveLoading] = useState(false);
  // 7-day live BCC history, for the chart. [{date:'YYYY-MM-DD', rate:Number|null}]
  const [liveHistory, setLiveHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  // v1.7.0: optional K rate fields. Only saved when currency_mode includes K.
  // v1.8.2: effective_time (HH:MM) for intra-day rate changes.
  const [form, setForm] = useState({
    effective_date: todayISO(),
    effective_time: new Date().toTimeString().slice(0, 5),
    sell_rate: '',
    buy_rate: '',
    sell_rate_k: '',
    buy_rate_k: '',
    notes: '',
  });
  const [saving, setSaving] = useState(false);
  // v1.8.2 — chart period selector: '1d' | '7d' | '1m'
  const [chartPeriod, setChartPeriod] = useState('7d');

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getFxRates();
      setRows(r.data || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  const refreshLive = async () => {
    setLiveLoading(true);
    try {
      const r = await getLiveFxRate();
      setLive({ ...r.data, error: null });
    } catch (err) {
      setLive({ error: err?.response?.data?.error || 'Failed to fetch live rate' });
    }
    setLiveLoading(false);
  };

  const refreshHistory = async (period) => {
    setHistoryLoading(true);
    // v1.8.2 — days per chart period. '1d' uses 1 (intra-day plot),
    // '7d' 7, '1m' 30.
    const p = period || chartPeriod;
    const days = p === '1d' ? 1 : p === '1m' ? 30 : 7;
    try {
      const r = await getLiveFxRateHistory(days);
      setLiveHistory(r.data?.series || []);
    } catch { setLiveHistory([]); }
    setHistoryLoading(false);
  };

  useEffect(() => { if (isDual) { refresh(); refreshLive(); refreshHistory(); } /* eslint-disable-next-line */ }, [isDual]);
  // v1.8.2 — re-fetch history when the user flips the chart period tab.
  useEffect(() => { if (isDual) refreshHistory(chartPeriod); /* eslint-disable-next-line */ }, [chartPeriod]);

  // Build the 7-day chart series. For each date we surface:
  //   - sell / buy : the manual rate effective on that date (most-recent
  //     fx_rates row with effective_date <= date). Null when nothing has
  //     been saved on or before that date.
  //   - live       : the BCC official rate fetched per-day from
  //     fawazahmed0/currency-api. Null when that day's snapshot failed.
  // Both null-axes render a broken (gappy) line rather than dropping to 0.
  const chartData = useMemo(() => {
    const rowsAsc = [...rows].sort((a, b) =>
      (a.effective_date < b.effective_date ? -1 : a.effective_date > b.effective_date ? 1 : a.id - b.id));
    return liveHistory.map(({ date, rate }) => {
      const manual = [...rowsAsc].reverse().find(r => r.effective_date <= date);
      return {
        date,
        label: date.slice(5), // MM-DD
        sell: manual ? parseFloat(manual.sell_rate) : null,
        buy:  manual ? parseFloat(manual.buy_rate)  : null,
        live: rate || null,
      };
    });
  }, [rows, liveHistory]);

  const save = async (e) => {
    e.preventDefault();
    const sell = parseFloat(form.sell_rate);
    const buy = parseFloat(form.buy_rate);
    const sellK = hasK && form.sell_rate_k !== '' ? parseFloat(form.sell_rate_k) : null;
    const buyK  = hasK && form.buy_rate_k  !== '' ? parseFloat(form.buy_rate_k)  : null;
    if (!form.effective_date) return flash('Effective date is required', 'error');
    if (!isFinite(sell) || sell <= 0) return flash('Sell rate must be > 0', 'error');
    if (!isFinite(buy)  || buy  <= 0) return flash('Buy rate must be > 0', 'error');
    if (sellK !== null && (!isFinite(sellK) || sellK <= 0)) return flash('Sell rate (K) must be > 0', 'error');
    if (buyK  !== null && (!isFinite(buyK)  || buyK  <= 0)) return flash('Buy rate (K) must be > 0', 'error');
    if (buy >= sell) {
      // Cashier change is given via Buy rate, so Buy < Sell is the normal
      // direction. Warn but allow — operator may have a real reason.
      if (!window.confirm('Buy rate is not lower than Sell rate. Continue?')) return;
    }
    setSaving(true);
    try {
      // v1.8.82 — convert the form's LOCAL date+time to a UTC effective_at
      // string before sending. Server stores as-is so the comparison against
      // SQLite datetime('now') (UTC) works regardless of server timezone.
      // Replaces the legacy effective_time path which assumed server tz ==
      // user tz (broke for UTC servers serving Lusaka users).
      const [_y, _m, _d] = form.effective_date.split('-').map(Number);
      const [_hh, _mm] = (form.effective_time || '00:00').split(':').map(Number);
      const effective_at_utc = new Date(_y, _m - 1, _d, _hh, _mm, 0)
        .toISOString().slice(0, 19).replace('T', ' ');
      await createFxRate({
        effective_date: form.effective_date,
        effective_at:   effective_at_utc,
        sell_rate: sell,
        buy_rate: buy,
        sell_rate_k: sellK,
        buy_rate_k:  buyK,
        notes: form.notes || null,
      });
      flash('Rate saved', 'success');
      setForm({
        effective_date: todayISO(),
        effective_time: new Date().toTimeString().slice(0, 5),
        sell_rate: '', buy_rate: '', sell_rate_k: '', buy_rate_k: '', notes: '',
      });
      await refresh();
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to save', 'error');
    }
    setSaving(false);
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this rate? Cashier will fall back to the next-most-recent rate.')) return;
    try {
      await deleteFxRate(id);
      flash('Deleted', 'success');
      await refresh();
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to delete', 'error');
    }
  };

  if (!isDual) {
    return (
      <div className="page-content">
        <div className="page-header"><div><h1>Currency Rates</h1></div></div>
        <div style={{ padding: 18, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, color: '#475569' }}>
          This branch operates in single currency ({currencyMode}). Currency rates are only used by branches running in <b>USD + FRA</b> mode.
        </div>
      </div>
    );
  }

  const savedCurrent = rows.find(r => r.effective_date <= todayISO()) || rows[0];
  const isFallback = !savedCurrent;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Currency Rates</h1>
          <p>USD ↔ FRA — set here, read by POS &amp; Cashier</p>
        </div>
        <button onClick={refresh}
          style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> Refresh
        </button>
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, padding: '10px 16px', background: toast.type === 'error' ? '#ef4444' : '#16a34a', color: '#fff', borderRadius: 6, zIndex: 1000, boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
          {toast.text}
        </div>
      )}

      {/* Current effective rate banner. When no manual rate has been saved
          the cards show "—" so the manager isn't misled into thinking a
          fallback number is "the" rate. POS/Cashier still fall back
          internally (separate concern) until an actual row is added. */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 18, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase' }}>
            Current Sell Rate
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'baseline', gap: 6 }}>
            {isFallback ? '—' : fmtRate(savedCurrent.sell_rate)}
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>FRA / USD</span>
          </div>
        </div>
        <div>
          <div style={{ color: '#64748b', fontSize: 11, fontWeight: 600, letterSpacing: 0.4, textTransform: 'uppercase' }}>
            Current Buy Rate
          </div>
          <div style={{ fontSize: 26, fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'baseline', gap: 6 }}>
            {isFallback ? '—' : fmtRate(savedCurrent.buy_rate)}
            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 500 }}>FRA / USD</span>
          </div>
        </div>
        {!isFallback && (
          <div style={{ gridColumn: '1 / -1', fontSize: 11, color: '#94a3b8' }}>
            In effect since {savedCurrent.effective_date}{savedCurrent.set_by_name ? ` · set by ${savedCurrent.set_by_name}` : ''}{savedCurrent.notes ? ` · ${savedCurrent.notes}` : ''}
          </div>
        )}
        {isFallback && (
          <div style={{ gridColumn: '1 / -1', fontSize: 12, color: '#64748b' }}>
            No manual rate set yet. Add a row below to start.
          </div>
        )}
      </div>

      {/* Live BCC reference rate (read-only, not used by POS/Cashier) */}
      <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 12, padding: 16, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ color: '#1e40af', fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
              <FiGlobe size={12} /> Live Market Rate (BCC official)
            </div>
            {live?.error ? (
              <div style={{ fontSize: 13, color: '#b91c1c', marginTop: 6 }}>{live.error}</div>
            ) : live?.rate ? (
              <>
                <div style={{ fontSize: 22, fontWeight: 800, color: '#0f172a', marginTop: 4, display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  {fmtRate(live.rate)}
                  <span style={{ fontSize: 12, color: '#475569', fontWeight: 500 }}>CDF / USD</span>
                </div>
                <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>
                  Source: {live.source}{live.time_last_update ? ` · ${new Date(live.time_last_update).toLocaleString()}` : ''}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: '#475569', marginTop: 6 }}>{liveLoading ? 'Fetching…' : '—'}</div>
            )}
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, fontStyle: 'italic' }}>
              Reference only — this is the central-bank official rate. Street/parallel rate is typically higher. POS &amp; Cashier always use the manual rate above.
            </div>
          </div>
          <button onClick={refreshLive} disabled={liveLoading}
            style={{ padding: '6px 12px', background: '#1e40af', color: '#fff', border: 'none', borderRadius: 6, cursor: liveLoading ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, fontWeight: 600 }}>
            <FiRefreshCw size={12} /> {liveLoading ? '…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* v1.8.2 — rate chart with 1d / 7d / 1m period tabs. */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <h3 style={{ margin: 0, fontSize: 14, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 6 }}>
            <FiTrendingUp /> Rate history — {chartPeriod === '1d' ? 'today' : chartPeriod === '1m' ? 'last 30 days' : 'last 7 days'}
          </h3>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {[
              { key: '1d', label: '1D' },
              { key: '7d', label: '7D' },
              { key: '1m', label: '1M' },
            ].map(p => (
              <button key={p.key} onClick={() => setChartPeriod(p.key)}
                style={{
                  padding: '4px 12px',
                  background: chartPeriod === p.key ? '#0ea5e9' : 'transparent',
                  color: chartPeriod === p.key ? '#fff' : '#0ea5e9',
                  border: '1px solid #bae6fd', borderRadius: 6,
                  cursor: 'pointer', fontSize: 11, fontWeight: 700,
                }}>
                {p.label}
              </button>
            ))}
            <button onClick={() => refreshHistory(chartPeriod)} disabled={historyLoading}
              style={{ padding: '4px 10px', background: 'transparent', color: '#0ea5e9', border: '1px solid #bae6fd', borderRadius: 6, cursor: historyLoading ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600 }}>
              <FiRefreshCw size={11} /> {historyLoading ? '…' : 'Refresh'}
            </button>
          </div>
        </div>
        {chartData.length === 0 ? (
          <div style={{ padding: 20, color: '#94a3b8', fontSize: 13 }}>
            {historyLoading ? 'Fetching live history…' : 'No data yet.'}
          </div>
        ) : (
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#64748b' }} />
                <YAxis tick={{ fontSize: 11, fill: '#64748b' }}
                  tickFormatter={(v) => v ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : ''}
                  domain={['auto', 'auto']} />
                <Tooltip
                  formatter={(v) => v == null ? '—' : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  labelStyle={{ fontWeight: 700 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="sell" name="Manual Sell"
                  stroke="#16a34a" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
                <Line type="monotone" dataKey="buy" name="Manual Buy"
                  stroke="#0ea5e9" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
                <Line type="monotone" dataKey="live" name="Live BCC"
                  stroke="#f59e0b" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 3 }} connectNulls={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 8, fontStyle: 'italic' }}>
          Manual lines snap to the last saved rate on or before each day (so an unchanged rate shows as a flat line). Live BCC is the central-bank official snapshot for that date.
        </div>
      </div>

      {/* Add new rate */}
      <form onSubmit={save} style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 18 }}>
        <h3 style={{ margin: '0 0 12px 0', fontSize: 14, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 6 }}>
          <FiDollarSign /> Add new rate
        </h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <div>
            <label style={lblStyle}>Effective date</label>
            <input type="date" value={form.effective_date}
              onChange={e => setForm({ ...form, effective_date: e.target.value })}
              style={inputStyle} required />
          </div>
          {/* v1.8.2 — intra-day timestamp. Rates can change multiple times
              per day; the Cashier picks whichever was in force at sale time. */}
          <div>
            <label style={lblStyle}>Effective time</label>
            <input type="time" value={form.effective_time}
              onChange={e => setForm({ ...form, effective_time: e.target.value })}
              style={inputStyle} required />
          </div>
          <div>
            <label style={lblStyle}>Sell rate (FRA / USD)</label>
            <input type="text" inputMode="decimal" pattern="[0-9]*\.?[0-9]*"
              value={form.sell_rate}
              onChange={e => setForm({ ...form, sell_rate: e.target.value.replace(/[^0-9.]/g, '') })}
              placeholder="e.g. 2900" style={inputStyle} required />
          </div>
          <div>
            <label style={lblStyle}>Buy rate (FRA / USD)</label>
            <input type="text" inputMode="decimal" pattern="[0-9]*\.?[0-9]*"
              value={form.buy_rate}
              onChange={e => setForm({ ...form, buy_rate: e.target.value.replace(/[^0-9.]/g, '') })}
              placeholder="e.g. 2600" style={inputStyle} required />
          </div>
          {hasK && (
            <>
              <div>
                <label style={lblStyle}>Sell rate (K / USD)</label>
                <input type="text" inputMode="decimal" pattern="[0-9]*\.?[0-9]*"
                  value={form.sell_rate_k}
                  onChange={e => setForm({ ...form, sell_rate_k: e.target.value.replace(/[^0-9.]/g, '') })}
                  placeholder="e.g. 25" style={inputStyle} />
              </div>
              <div>
                <label style={lblStyle}>Buy rate (K / USD)</label>
                <input type="text" inputMode="decimal" pattern="[0-9]*\.?[0-9]*"
                  value={form.buy_rate_k}
                  onChange={e => setForm({ ...form, buy_rate_k: e.target.value.replace(/[^0-9.]/g, '') })}
                  placeholder="e.g. 23" style={inputStyle} />
              </div>
            </>
          )}
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={lblStyle}>Notes (optional)</label>
            <input type="text" value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
              placeholder="e.g. CB rate of the day" style={inputStyle} />
          </div>
        </div>
        <div style={{ marginTop: 12, fontSize: 11, color: '#64748b' }}>
          Sell rate is used when a customer pays in FRA. Buy rate is used when change is given in FRA.
        </div>
        <button type="submit" disabled={saving}
          style={{ marginTop: 12, padding: '8px 16px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: saving ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
          <FiPlus /> {saving ? 'Saving…' : 'Save Rate'}
        </button>
      </form>

      {/* History table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #f1f5f9', fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
          History
        </div>
        {loading ? (
          <div style={{ padding: 18, color: '#64748b' }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 18, color: '#64748b' }}>No rates saved yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                <th style={thStyle}>Effective</th>
                <th style={thStyle}>Time</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Sell FRA</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Buy FRA</th>
                {hasK && <th style={{ ...thStyle, textAlign: 'right' }}>Sell K</th>}
                {hasK && <th style={{ ...thStyle, textAlign: 'right' }}>Buy K</th>}
                <th style={thStyle}>Notes</th>
                <th style={thStyle}>Set by</th>
                <th style={thStyle}>Saved</th>
                <th style={{ ...thStyle, width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9', fontSize: 13 }}>
                  <td style={tdStyle}>{r.effective_date}</td>
                  <td style={{ ...tdStyle, color: '#475569', fontFamily: 'monospace' }}>
                    {(() => {
                      // v1.8.82 — effective_at is now stored as UTC; convert to
                      // local for display so the cashier sees the time they typed.
                      if (!r.effective_at || r.effective_at.length < 16) return '—';
                      const d = new Date(r.effective_at.replace(' ', 'T') + 'Z');
                      if (isNaN(d)) return r.effective_at.slice(11, 16);
                      const hh = String(d.getHours()).padStart(2, '0');
                      const mm = String(d.getMinutes()).padStart(2, '0');
                      return `${hh}:${mm}`;
                    })()}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{fmtRate(r.sell_rate)}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{fmtRate(r.buy_rate)}</td>
                  {hasK && <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{r.sell_rate_k ? fmtRate(r.sell_rate_k) : '—'}</td>}
                  {hasK && <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{r.buy_rate_k ? fmtRate(r.buy_rate_k) : '—'}</td>}
                  <td style={tdStyle}>{r.notes || '—'}</td>
                  <td style={tdStyle}>{r.set_by_name || '—'}</td>
                  <td style={{ ...tdStyle, color: '#94a3b8', fontSize: 11 }}>
                    {r.created_at ? new Date(r.created_at + 'Z').toLocaleString() : '—'}
                  </td>
                  <td style={tdStyle}>
                    <button onClick={() => remove(r.id)} title="Delete"
                      style={{ background: 'transparent', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4 }}>
                      <FiTrash2 />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const lblStyle = { display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.4 };
const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' };
const thStyle = { textAlign: 'left', padding: '10px 14px', fontWeight: 700 };
const tdStyle = { padding: '10px 14px', color: '#0f172a' };
