// HqCashPosition â€” each depot's cash, as its own Cash Book sees it, in cards.
//
// 2026-09-13 (v5) â€” one simple sum per depot:
//   Opening + In âˆ’ Out âˆ’ Deposited = Balance
// In / Out / Opening come from the depot Cash Book's own calculation
// (computeCashBookStats, run against each depot's database). Deposited is
// every deposit sent to HQ, confirmed or not, so the balance drops the moment
// a depot sends cash â€” the depot's own screen only drops it once HQ confirms.
// What customers still owe is shown under the balance, not in it.
// Backend: GET /api/hq/cash-position.
import React, { useEffect, useMemo, useState } from 'react';
import { getHqCashPosition } from '../services/api';

const NAVY = '#13306b';
const NAVY_DEEP = '#0b1f4a';
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e6e9f0';

const K = (n) => {
  const v = Number(n) || 0;
  const s = `K${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return v < -0.004 ? `âˆ’${s}` : s;
};

const localDay = (d = new Date()) => {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// "Kelete Distribution - BANKERS (KABWE)" / "Bankers Kabwe Depo" â†’ "Bankers (Kabwe)"
const shortName = (name, slug) => String(name || slug || '')
  .split(/\s+-\s+/).pop()
  .replace(/\s+Depo$/i, '')
  .toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

// 2026-09-15 â€” sent_to_hq is now only what went to HQ; deposits between depots
// (System Settings â†’ Deposit to) are sent_to_depots / received_from_depots.
const SUM_KEYS = ['opening', 'receipts', 'payments', 'sent_to_hq', 'sent_to_depots', 'received_from_depots', 'other', 'cash_left', 'pending_count', 'ar_owed', 'owing_customers'];

export default function HqCashPosition() {
  // '' = open-ended: no From = from day one, no To = up to now.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [depot, setDepot] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const params = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const res = await getHqCashPosition(params);
      setData(res.data);
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Could not load the cash position');
    }
    setLoading(false);
  };

  useEffect(() => {
    setLoading(true);
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
    // eslint-disable-next-line
  }, [from, to]);

  const all = data?.depots || [];
  const list = all.filter((d) => !depot || d.slug === depot);
  const t = useMemo(() => {
    const s = Object.fromEntries(SUM_KEYS.map((k) => [k, 0]));
    for (const d of list) if (!d.error) for (const k of SUM_KEYS) s[k] += Number(d[k]) || 0;
    return s;
  }, [list]);
  const sorted = [...list].sort((a, b) =>
    (a.error ? 1 : 0) - (b.error ? 1 : 0) || (Number(b.cash_left) || 0) - (Number(a.cash_left) || 0));

  return (
    <div className="page-content">
      <div className="page-header">
        <div className="desk-only">
          <h1>HQ Cash Position</h1>
          <p>Cash at each depot after everything deposited to HQ</p>
        </div>
        {/* 2026-09-13 â€” From / To. No refresh button: the page reloads every 60s
            and whenever a date changes. */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="nowrap-row" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: '#fff', border: `1px solid ${LINE}`, borderRadius: 10, padding: '4px 8px' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: MUTED }}>From</span>
            <input type="date" value={from} max={to || localDay()} onChange={(e) => setFrom(e.target.value)}
              style={{ padding: '4px 6px', border: from ? `1.5px solid ${NAVY}` : `1px solid ${LINE}`, borderRadius: 7, fontSize: 13, color: from ? INK : MUTED, maxWidth: 145 }} />
            <span style={{ fontSize: 12.5, fontWeight: 600, color: MUTED }}>To</span>
            <input type="date" value={to} min={from || undefined} max={localDay()} onChange={(e) => setTo(e.target.value)}
              style={{ padding: '4px 6px', border: to ? `1.5px solid ${NAVY}` : `1px solid ${LINE}`, borderRadius: 7, fontSize: 13, color: to ? INK : MUTED, maxWidth: 145 }} />
          </div>
          {(from || to) && (
            <button type="button" onClick={() => { setFrom(''); setTo(''); }}
              style={{ padding: '8px 12px', background: '#fff', color: NAVY, border: `1px solid ${LINE}`, borderRadius: 10, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
              All time
            </button>
          )}
        </div>
      </div>

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 10, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {loading && !data ? (
        <p style={{ color: MUTED }}>Loadingâ€¦</p>
      ) : data && (
        <>
          {/* â”€â”€ Stats for all depots (or the one picked) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
              2026-09-13 â€” tiles in the order the money moves:
              Opening + Money in = Total available âˆ’ Expenses âˆ’ Deposited = Cash balance. */}
          <div style={{ fontSize: 13, color: MUTED, margin: '0 2px 10px' }}>
            {depot ? shortName(list[0]?.name, depot) : 'All depots'} Â· {
              data.from && data.to ? `${data.from} â†’ ${data.to}`
              : data.from ? `${data.from} â†’ now`
              : data.to ? `up to the end of ${data.to}`
              : 'all time, up to now'}
          </div>
          <div className="tiles-2up" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 28 }}>
            <Tile label="Opening balance" value={K(t.opening)} note={data.from ? `At the start of ${data.from}` : 'Carried in'} />
            <Tile label="Money in" value={K(t.receipts)} note="Cash receipts (CR)" tone="in" />
            <Tile label="Total available" value={K(t.opening + t.receipts)} note="Opening + money in" />
            <Tile label="Expenses" value={K(t.payments)} note="Payments (PV Â· AP)" tone="out" />
            <Tile label="Deposited to HQ" value={K(t.sent_to_hq)}
              note={t.pending_count > 0 ? `${t.pending_count} waiting for HQ to confirm` : 'All confirmed'} />
            <Tile label="Cash balance" value={K(t.cash_left)} tone="main" negative={t.cash_left < -0.004}
              note={!depot && t.sent_to_depots - t.received_from_depots > 0.5
                ? `Held at the depots Â· ${K(t.sent_to_depots - t.received_from_depots)} on the way between depots`
                : 'Held at the depots'} />
            <Tile label="Customers owe" value={K(t.ar_owed)}
              note={`${t.owing_customers} customer${t.owing_customers === 1 ? '' : 's'} Â· not in the balance`} />
          </div>

          {/* â”€â”€ Depot cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
          <div className="nowrap-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, margin: '0 2px 12px' }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: INK }}>Depots</span>
            <select value={depot} onChange={(e) => setDepot(e.target.value)}
              style={{ padding: '6px 10px', border: `1px solid ${LINE}`, borderRadius: 8, fontSize: 13, background: '#fff', color: INK }}>
              <option value="">All depots ({all.length})</option>
              {all.map((d) => <option key={d.slug} value={d.slug}>{shortName(d.name, d.slug)}</option>)}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
            {sorted.map((d) => {
              if (d.error) {
                return (
                  <div key={d.slug} style={card}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: INK }}>{shortName(d.name, d.slug)}</div>
                    <div style={{ fontSize: 13, color: '#b91c1c' }}>Could not read this depot's books</div>
                  </div>
                );
              }
              const neg = d.cash_left < -0.004;
              // 2026-09-15 â€” deposits to HQ and to another depot on their own lines.
              const toDepots = Number(d.sent_to_depots) || 0;
              const showHqLine = (Number(d.sent_to_hq) || 0) > 0.004 || !(toDepots > 0.004);
              const pendingChip = d.pending_count > 0 && (
                <span style={{ marginLeft: 7, fontSize: 11, fontWeight: 600, color: '#a16207' }}>
                  {d.pending_count} pending
                </span>
              );
              return (
                <div key={d.slug} style={card}>
                  <div style={{ fontWeight: 700, fontSize: 15.5, color: INK }}>{shortName(d.name, d.slug)}</div>

                  <div style={{ display: 'grid', gap: 7 }}>
                    <Line label="Opening" value={K(d.opening)} />
                    <Line label="In" value={`+ ${K(d.receipts)}`} color="#15803d" />
                    {(Number(d.received_from_depots) || 0) > 0.004 && (
                      <Line label={`From ${(d.received_from || []).map(n => shortName(n)).join(', ') || 'depots'}`}
                        value={`+ ${K(d.received_from_depots)}`} color="#15803d" />
                    )}
                    <Line label="Out" value={`âˆ’ ${K(d.payments)}`} />
                    {showHqLine && (
                      <Line label={<>Deposited to HQ{pendingChip}</>} value={`âˆ’ ${K(d.sent_to_hq)}`} />
                    )}
                    {toDepots > 0.004 && (
                      <Line label={<>Deposited to {d.deposit_to_name ? shortName(d.deposit_to_name) : 'depot'}{!showHqLine && pendingChip}</>}
                        value={`âˆ’ ${K(toDepots)}`} />
                    )}
                    {Math.abs(d.other) > 0.5 && <Line label="Other" value={K(d.other)} />}
                  </div>

                  <div className="nowrap-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, borderTop: `1px solid ${LINE}`, paddingTop: 12 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: MUTED }}>Balance</span>
                    <span style={{ fontSize: 21, fontWeight: 800, letterSpacing: -0.3, color: neg ? '#b91c1c' : NAVY, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {K(d.cash_left)}
                    </span>
                  </div>

                  {d.ar_owed > 0.004 && (
                    <div className="nowrap-row" style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, color: MUTED, marginTop: -4 }}>
                      <span>Customers owe</span>
                      <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{K(d.ar_owed)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <p style={{ marginTop: 16, fontSize: 12, color: '#94a3b8' }}>
            Balance = Opening + In âˆ’ Out âˆ’ Deposited. Deposited counts every deposit sent, to HQ or to another depot, confirmed or not,
            so a depot's own Cash Book shows more until it is confirmed. Deposited to HQ above counts only what was sent to HQ. Updated {new Date(data.as_of).toLocaleTimeString()}.
          </p>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, note, tone, negative }) {
  const main = tone === 'main';
  const valueColor = main ? (negative ? '#ffc2c5' : '#fff') : tone === 'in' ? '#15803d' : INK;
  return (
    <div style={{
      background: main ? `linear-gradient(145deg, ${NAVY_DEEP}, ${NAVY})` : '#fff',
      border: main ? `1px solid ${NAVY}` : `1px solid ${LINE}`,
      borderRadius: 14, padding: '14px 16px', minWidth: 0,
      display: 'grid', gap: 4, alignContent: 'start',
      boxShadow: main ? '0 6px 18px rgba(19, 48, 107, 0.22)' : '0 1px 2px rgba(15, 23, 42, 0.04)',
    }}>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: main ? 'rgba(255,255,255,0.8)' : MUTED }}>{label}</span>
      <span className="tile-value" style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.3, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: valueColor }}>
        {value}
      </span>
      {note && <span style={{ fontSize: 11.5, color: main ? 'rgba(255,255,255,0.7)' : '#94a3b8' }}>{note}</span>}
    </div>
  );
}

function Line({ label, value, color }) {
  return (
    <div className="nowrap-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, fontSize: 14 }}>
      <span style={{ color: MUTED }}>{label}</span>
      <span style={{ color: color || INK, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  );
}

const card = {
  background: '#fff', border: `1px solid ${LINE}`, borderRadius: 16,
  padding: '16px 18px', display: 'grid', gap: 14, alignContent: 'start',
  boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
};
