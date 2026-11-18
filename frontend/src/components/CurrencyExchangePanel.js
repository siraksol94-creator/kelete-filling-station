// v1.8.6 — Reusable Currency Exchange ledger panel.
// Used in Cash Report (scope='drawer') and Cash Book (scope='book').
//
// Renders:
//   - Heading + "Add Exchange" button (admin/manager only)
//   - List of exchanges for the active filter
//   - Add Exchange modal (FROM → TO with auto-computed rate)
//
// Append-only: there's no delete UI. To undo a mistake the user records a
// reverse exchange (FRA → USD), keeping both rows visible for audit.
import React, { useEffect, useState } from 'react';
import { FiPlus, FiRepeat, FiX } from 'react-icons/fi';
import { getCurrencyExchanges, createCurrencyExchange } from '../services/api';

const CURRENCIES = ['USD', 'FRA', 'K'];
const fmt = (n, dec) => parseFloat(n || 0).toLocaleString(undefined, {
  minimumFractionDigits: dec, maximumFractionDigits: dec,
});
const symFor = (c) => c === 'USD' ? '$' : '';
const decFor = (c) => c === 'USD' ? 2 : 0;

export default function CurrencyExchangePanel({
  scope,             // 'drawer' or 'book'
  date,              // YYYY-MM-DD (drawer scope) — optional for book
  from, to,          // YYYY-MM-DD range (book scope) — optional
  cashierId,         // drawer scope — number, 0 = all
  user,              // current user from useAuth — used to check role
  onChanged,         // optional callback after a new exchange is saved
  title,             // display title (default 'Currency Exchanges')
  drawerBalance,     // v1.8.8: optional { USD, FRA, K } — when supplied,
                     //   modal shows live drawer balance + soft warns
                     //   if FROM amount exceeds available. Save still allowed.
  openSignal,        // v1.8.63: increment this from the parent to open the
                     //   Add Exchange modal externally (e.g. Cash Book header
                     //   button while the user is still on the Ledger tab).
  hideHeader,        // v1.8.63: when true, render only the modal logic and
                     //   the list — skip the built-in title + Add button.
                     //   Parent supplies its own trigger UI.
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState('');

  // v1.8.63 — open the modal whenever openSignal changes to a non-zero value.
  useEffect(() => {
    if (openSignal && canRecord) { setShowAdd(true); setError(''); }
  // eslint-disable-next-line
  }, [openSignal]);

  const role = String(user?.role || '').toLowerCase();
  const canRecord = role === 'administrator' || role === 'admin' || role === 'manager';

  const refresh = async () => {
    setLoading(true);
    try {
      const params = { scope };
      if (date) params.date = date;
      if (from) params.from = from;
      if (to)   params.to   = to;
      if (scope === 'drawer' && cashierId !== undefined) params.cashier_id = cashierId;
      const r = await getCurrencyExchanges(params);
      setRows(Array.isArray(r.data) ? r.data : []);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load exchanges');
      setRows([]);
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [scope, date, from, to, cashierId]);

  // v1.8.63 — `hideHeader` mode skips visible panel chrome (header + list)
  // and renders only the modal. Used when the parent wants just the
  // "Add Exchange" workflow without the inline ledger.
  if (hideHeader) {
    return (
      <>
        {showAdd && (
          <AddExchangeModal
            scope={scope}
            defaultDate={date || from || new Date().toISOString().slice(0, 10)}
            cashierId={cashierId}
            drawerBalance={drawerBalance}
            onClose={() => setShowAdd(false)}
            onSaved={() => { setShowAdd(false); refresh(); if (onChanged) onChanged(); }}
          />
        )}
      </>
    );
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, marginTop: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #f1f5f9' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FiRepeat color="#7c3aed" />
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{title || 'Currency Exchanges'}</h3>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>· {rows.length} entr{rows.length === 1 ? 'y' : 'ies'}</span>
        </div>
        {canRecord && (
          <button onClick={() => { setShowAdd(true); setError(''); }}
            style={{ padding: '6px 12px', borderRadius: 6, border: '1.5px solid #7c3aed', background: '#7c3aed', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <FiPlus size={13} /> Add Exchange
          </button>
        )}
      </div>

      {error && <div style={{ padding: '8px 16px', color: '#dc2626', fontSize: 12 }}>{error}</div>}

      <div style={{ padding: '0 8px 8px' }}>
        {loading ? (
          <div style={{ padding: 18, color: '#94a3b8', fontSize: 13 }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 18, color: '#94a3b8', fontSize: 13 }}>No exchanges yet.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc', color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                <th style={th}>Time</th>
                <th style={{ ...th, textAlign: 'right' }}>From</th>
                <th style={{ ...th, textAlign: 'right' }}>To</th>
                <th style={{ ...th, textAlign: 'right' }}>Rate</th>
                {scope === 'drawer' && <th style={th}>Cashier</th>}
                <th style={th}>Notes</th>
                <th style={th}>By</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                  <td style={td}>{r.date}{r.time ? ' ' + String(r.time).slice(0, 5) : ''}</td>
                  <td style={{ ...td, textAlign: 'right', color: '#dc2626', fontWeight: 600 }}>
                    −{symFor(r.from_currency)}{fmt(r.from_amount, decFor(r.from_currency))} {r.from_currency}
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: '#16a34a', fontWeight: 600 }}>
                    +{symFor(r.to_currency)}{fmt(r.to_amount, decFor(r.to_currency))} {r.to_currency}
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: '#64748b', fontFamily: 'monospace' }}>
                    {/* v1.8.22 — canonical street-rate display: always show
                        'X foreign per 1 USD' (the format cashiers can verify
                        against today's posted rate). DB stores rate as
                        to_amount/from_amount; invert when foreign->USD so
                        we get foreign/USD. FRA<->K (no USD) stays as stored. */}
                    {(() => {
                      const raw = parseFloat(r.rate);
                      if (!(raw > 0)) return '—';
                      const fromUsd = r.from_currency === 'USD';
                      const toUsd   = r.to_currency   === 'USD';
                      let val, label;
                      if (fromUsd && !toUsd) {
                        // USD -> foreign: raw is already foreign/USD ✓
                        val = raw; label = `${r.to_currency}/USD`;
                      } else if (!fromUsd && toUsd) {
                        // foreign -> USD: invert to canonical foreign/USD
                        val = 1 / raw; label = `${r.from_currency}/USD`;
                      } else {
                        val = raw; label = `${r.to_currency}/${r.from_currency}`;
                      }
                      return (<>
                        {val.toLocaleString(undefined, { maximumFractionDigits: val < 1 ? 6 : 2 })}
                        <div style={{ fontSize: 10, color: '#94a3b8', fontFamily: 'inherit' }}>{label}</div>
                      </>);
                    })()}
                  </td>
                  {scope === 'drawer' && <td style={{ ...td, color: '#475569' }}>{r.cashier_name || '—'}</td>}
                  <td style={{ ...td, color: '#475569' }}>{r.notes || '—'}</td>
                  <td style={{ ...td, color: '#94a3b8', fontSize: 11 }}>{r.created_by_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showAdd && (
        <AddExchangeModal
          scope={scope}
          defaultDate={date || new Date().toISOString().slice(0, 10)}
          cashierId={cashierId}
          drawerBalance={drawerBalance}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); refresh(); if (onChanged) onChanged(); }}
        />
      )}
    </div>
  );
}

function AddExchangeModal({ scope, defaultDate, cashierId, drawerBalance, onClose, onSaved }) {
  // v1.8.19 — default direction is FRA -> USD (customer brings FRA, takes
  // USD back is the common street case). Any other direction prompts
  // "are you sure?" so accidental wrong-direction entries get caught.
  const [form, setForm] = useState({
    from_currency: 'FRA', from_amount: '',
    to_currency:   'USD', to_amount: '',
    notes: '',
    date: defaultDate,
    time: new Date().toTimeString().slice(0, 5),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // v1.8.19 — store raw digits only (no commas) in form state. Display with
  // thousand-separator commas via formatThousands(); strip on input via
  // stripCommas() before storing. type='text' inputMode='decimal' so we
  // can render commas (type='number' rejects them).
  const stripCommas = (s) => String(s ?? '').replace(/,/g, '');
  const formatThousands = (raw) => {
    const s = stripCommas(raw);
    if (s === '' || s === '-') return s;
    const [intPart, decPart] = s.split('.');
    const cleanedInt = intPart.replace(/[^0-9]/g, '');
    const grouped = cleanedInt ? parseInt(cleanedInt, 10).toLocaleString('en-US') : '';
    return decPart !== undefined ? `${grouped}.${decPart.replace(/[^0-9]/g, '')}` : grouped;
  };
  const onAmountChange = (key) => (e) => {
    setForm({ ...form, [key]: stripCommas(e.target.value) });
  };

  // v1.8.19 — confirm prompt when direction isn't the canonical FRA -> USD.
  const isCanonical = (from, to) => from === 'FRA' && to === 'USD';
  const changeCurrency = (side, value) => {
    const next = { ...form, [side]: value };
    if (!isCanonical(next.from_currency, next.to_currency)
        && (next.from_currency !== next.to_currency)
        && !window.confirm(`Are you sure? The usual direction is FRA → USD.\nYou're picking ${next.from_currency} → ${next.to_currency}.`)) {
      return; // user cancelled — keep previous selection
    }
    setForm(next);
  };

  const fromAmt = parseFloat(form.from_amount || 0) || 0;
  const toAmt   = parseFloat(form.to_amount   || 0) || 0;
  const rate    = fromAmt > 0 ? toAmt / fromAmt : 0;

  // v1.8.19 — canonical street-rate display: always 'X foreign per 1 USD'
  // (e.g. "2,900 FRA per 1 USD") regardless of FROM/TO direction so the
  // cashier can verify against today's posted street rate. For FRA <-> K
  // (no USD involved) we keep the natural direction.
  const rateDisplay = (() => {
    if (fromAmt <= 0 || toAmt <= 0) return { value: 0, label: `${form.to_currency} per 1 ${form.from_currency}` };
    const fromIsUsd = form.from_currency === 'USD';
    const toIsUsd   = form.to_currency   === 'USD';
    if (fromIsUsd && !toIsUsd) {
      return { value: toAmt / fromAmt, label: `${form.to_currency} per 1 USD` };
    }
    if (!fromIsUsd && toIsUsd) {
      return { value: fromAmt / toAmt, label: `${form.from_currency} per 1 USD` };
    }
    return { value: toAmt / fromAmt, label: `${form.to_currency} per 1 ${form.from_currency}` };
  })();

  const submit = async () => {
    setError('');
    if (form.from_currency === form.to_currency) return setError('From and To currencies must differ.');
    if (fromAmt <= 0) return setError('From amount must be > 0.');
    if (toAmt   <= 0) return setError('To amount must be > 0.');
    setSaving(true);
    try {
      await createCurrencyExchange({
        scope,
        date: form.date,
        time: form.time,
        from_currency: form.from_currency,
        from_amount:   fromAmt,
        to_currency:   form.to_currency,
        to_amount:     toAmt,
        cashier_id:    scope === 'drawer' ? (cashierId || 0) : null,
        notes:         form.notes || null,
      });
      onSaved();
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to save');
    }
    setSaving(false);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 540, padding: 18, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>New Currency Exchange — {scope === 'drawer' ? 'Drawer (till)' : 'Cash Book'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><FiX /></button>
        </div>
        <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 10px', fontSize: 11.5, color: '#78350f', marginBottom: 12 }}>
          Exchanges are append-only. To undo a mistake, record a reverse exchange — both rows stay visible for audit.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <label style={lbl}>Date</label>
            <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} style={inp} />
          </div>
          <div>
            <label style={lbl}>Time</label>
            <input type="time" value={form.time} onChange={e => setForm({ ...form, time: e.target.value })} style={inp} />
          </div>
        </div>

        {/* v1.8.8 — live drawer balance badges (drawer scope only). */}
        {drawerBalance && (
          <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#1e40af', marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 4 }}>
            <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 10, letterSpacing: 0.5 }}>Drawer balance</span>
            <span>
              USD <strong>${fmt(drawerBalance.USD || 0, 2)}</strong>
              {'  ·  '}
              FRA <strong>{fmt(drawerBalance.FRA || 0, 0)}</strong>
              {'  ·  '}
              K <strong>{fmt(drawerBalance.K || 0, 0)}</strong>
            </span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 10 }}>
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#b91c1c', marginBottom: 6, textTransform: 'uppercase' }}>From (taken out)</div>
            <select value={form.from_currency} onChange={e => changeCurrency('from_currency', e.target.value)} style={inp}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="text" inputMode="decimal"
              value={formatThousands(form.from_amount)}
              onChange={onAmountChange('from_amount')}
              placeholder="0" style={{ ...inp, marginTop: 6, fontFamily: 'monospace', fontSize: 15 }} />
            {drawerBalance && (
              <div style={{ fontSize: 11, color: '#7c2d12', marginTop: 4 }}>
                Available: <strong>{fmt(drawerBalance[form.from_currency] || 0, form.from_currency === 'USD' ? 2 : 0)}</strong> {form.from_currency}
              </div>
            )}
          </div>
          <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#047857', marginBottom: 6, textTransform: 'uppercase' }}>To (received)</div>
            <select value={form.to_currency} onChange={e => changeCurrency('to_currency', e.target.value)} style={inp}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input type="text" inputMode="decimal"
              value={formatThousands(form.to_amount)}
              onChange={onAmountChange('to_amount')}
              placeholder="0" style={{ ...inp, marginTop: 6, fontFamily: 'monospace', fontSize: 15 }} />
          </div>
        </div>

        {/* v1.8.8 — soft warning when FROM amount exceeds drawer balance.
            Save stays enabled (Option B). Hidden when no drawerBalance prop. */}
        {drawerBalance && fromAmt > 0 && fromAmt > (parseFloat(drawerBalance[form.from_currency] || 0) + 0.001) && (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: '#92400e', marginBottom: 10 }}>
            ⚠ {form.from_currency} amount exceeds drawer.
            {' '}Available: <strong>{fmt(drawerBalance[form.from_currency] || 0, form.from_currency === 'USD' ? 2 : 0)} {form.from_currency}</strong>
            {' · '}Short by: <strong>{fmt(fromAmt - parseFloat(drawerBalance[form.from_currency] || 0), form.from_currency === 'USD' ? 2 : 0)} {form.from_currency}</strong>.
            <br />Save anyway if the cashier brought outside cash; otherwise reduce the amount.
          </div>
        )}

        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '8px 10px', fontSize: 12, color: '#475569', marginBottom: 10 }}>
          Effective rate: <strong>{rateDisplay.value > 0
            ? rateDisplay.value.toLocaleString(undefined, { maximumFractionDigits: rateDisplay.value < 1 ? 6 : 2 })
            : '—'}</strong>{' '}({rateDisplay.label})
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Notes (optional)</label>
          <input type="text" value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })}
            placeholder="e.g. customer requested FRA in change" style={inp} />
        </div>

        {error && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={saving} style={{ padding: '8px 14px', borderRadius: 6, border: '1.5px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Cancel</button>
          <button onClick={submit} disabled={saving} style={{ padding: '8px 16px', borderRadius: 6, border: 'none', background: '#7c3aed', color: '#fff', cursor: saving ? 'wait' : 'pointer', fontSize: 13, fontWeight: 700 }}>
            {saving ? 'Saving…' : 'Save Exchange'}
          </button>
        </div>
      </div>
    </div>
  );
}

const lbl = { display: 'block', fontSize: 11, color: '#475569', fontWeight: 600, marginBottom: 3, textTransform: 'uppercase', letterSpacing: 0.4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' };
const th  = { textAlign: 'left', padding: '8px 12px', fontWeight: 700 };
const td  = { padding: '8px 12px', color: '#0f172a' };
