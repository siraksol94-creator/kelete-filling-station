// TerminalPay — the Pay window and the quantity window on a POS small terminal.
//
// 2026-09-11. On the KI-POS handheld the standard Pay window is a desktop
// form on a phone screen: small boxes, a letter keyboard that slides up over
// them (type="number" alone does not bring up a number pad on its keyboard),
// and the Complete button pushed out of reach. On a device set to POS small
// terminal (System Settings → Device Type) these replace it.
//
// Nothing about the sale changes. The windows edit the same payModal state
// the standard window edits, apply the same rules — paid in full, a typed
// TPIN verified, an LPO sale needing TPIN and number — and hand checkout the
// same breakdown. Amounts come from a keypad inside the window, so the phone
// keyboard never opens for them; only the buyer's name and address, which
// are text, use it.
import React, { useState } from 'react';
import { useCurrency } from '../context/CurrencyContext';

// 2026-09-11 — the Red Sea logo's colours: navy for structure and for
// whatever is being worked on, red for the main action, green for money in,
// amber for short (red now means "tap here", so it can't also mean "wrong").
const NAVY = '#13306b';
const NAVY_DEEP = '#0b1f4a';
const NAVY_TINT = '#e8edf7';
const RED = '#c8000a';
const METHODS = [
  { key: 'cash', label: 'Cash', color: NAVY, soft: NAVY_TINT },
  { key: 'momo', label: 'MoMo', color: NAVY, soft: NAVY_TINT },
  { key: 'bank', label: 'Bank', color: NAVY, soft: NAVY_TINT },
];

const num = (v) => Math.max(0, parseFloat(v || 0) || 0);
const roundUp = (x, step) => Math.ceil(x / step) * step;
const plain = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

// One keypad press into a money string: digits, one point, two decimals.
// `fresh` means the first press replaces what was there — the amount the
// window pre-filled — instead of appending to it.
function pressMoney(prev, key, fresh) {
  let s = fresh ? '' : String(prev || '');
  if (key === 'del') return s.slice(0, -1);
  if (key === '.') return s.includes('.') ? s : (s || '0') + '.';
  if (s.includes('.') && s.split('.')[1].length >= 2) return s;
  if (s === '0') s = '';
  return (s + key).slice(0, 12);
}

// Quantities: up to three decimals, for part-units.
function pressQty(prev, key, fresh) {
  let s = fresh ? '' : String(prev || '');
  if (key === 'del') return s.slice(0, -1);
  if (key === '.') return s.includes('.') ? s : (s || '0') + '.';
  if (s.includes('.') && s.split('.')[1].length >= 3) return s;
  if (s === '0') s = '';
  return (s + key).slice(0, 9);
}

// TPIN and LPO numbers: digits only.
function pressDigits(prev, key, max) {
  const s = String(prev || '');
  if (key === 'del') return s.slice(0, -1);
  if (key === '.') return s;
  return (s + key).slice(0, max);
}

const S = {
  overlay: { position: 'fixed', inset: 0, zIndex: 1500, background: '#f7f8fb', color: '#0f172a',
             display: 'flex', flexDirection: 'column', fontFamily: 'inherit' },
  bar: { background: NAVY, color: '#fff', padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  back: { background: 'none', border: 'none', color: '#c7d2ee', fontSize: 14, fontWeight: 600, padding: '4px 0', cursor: 'pointer' },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 12px 0', display: 'flex', flexDirection: 'column', gap: 8 },
  card: { background: '#fff', border: '1px solid #e3e7ef', borderRadius: 14, padding: '10px 14px' },
  lbl: { fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', color: '#6b7385' },
  big: { fontSize: 30, fontWeight: 800, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', color: NAVY_DEEP },
  foot: { padding: 12, flexShrink: 0, background: '#f7f8fb' },
};

// ── keypad ───────────────────────────────────────────────────────────────
function Keypad({ onPress, allowDot = true }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', allowDot ? '.' : '', '0', 'del'];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
      {keys.map((k, i) => (
        k === ''
          ? <span key={i} />
          : (
            <button key={i} type="button" onClick={() => onPress(k)}
              style={{
                height: 'clamp(40px, 6.6vh, 54px)', borderRadius: 12,
                border: k === 'del' ? '1px solid #f7cdd3' : '1px solid #e3e6ee',
                background: k === 'del' ? '#fdf0f1' : '#fff',
                color: k === 'del' ? RED : NAVY_DEEP,
                fontSize: k === 'del' ? 18 : 21, fontWeight: 700, cursor: 'pointer',
                boxShadow: '0 1px 0 #d6dbe6', touchAction: 'manipulation',
              }}>
              {k === 'del' ? '⌫' : k}
            </button>
          )
      ))}
    </div>
  );
}

// ── Pay window ───────────────────────────────────────────────────────────
export default function TerminalPayWindow({
  payModal, setPayModal, total, itemCount, hasMoMoBank, zraEnabled,
  selectedCustomer, tpinLookup, setTpinLookup, lookupTpin, onRegisterCustomer,
  money, onCancel, onComplete,
}) {
  // 2026-09-11 — MoMo / Bank also follow System Settings → Payment methods
  // shown. Cash only means no method tiles at all.
  const { methodShown } = useCurrency();
  const methods = METHODS.filter((m) => m.key === 'cash' || (hasMoMoBank && methodShown(m.key)));
  const [active, setActive] = useState('cash');
  const [fresh, setFresh] = useState(true);
  const [sheet, setSheet] = useState(false);
  const [sheetField, setSheetField] = useState('tpin');

  const amounts = { cash: num(payModal.cash), momo: num(payModal.momo), bank: num(payModal.bank) };
  const payNow = amounts.cash + amounts.momo + amounts.bank;
  const change = Math.max(0, payNow - total);
  const short = Math.max(0, total - payNow);
  const enoughPaid = payNow >= total - 0.001;
  const owedByActive = Math.max(0, total - (payNow - amounts[active]));
  const activeMethod = METHODS.find((m) => m.key === active);

  // The same four rules the standard window applies to Complete Sale.
  const tpinRaw = (payModal.buyerTpin || '').trim();
  const tpinUnverified = !!tpinRaw && !['verified', 'skipped', 'unavailable'].includes(tpinLookup?.status);
  const blocker = !enoughPaid ? `A walk-in must pay in full — short by ${money(short)}`
    : tpinUnverified ? 'Verify the Buyer TPIN, or clear it'
    : (payModal.lpoEnabled && !/^\d{10}$/.test(payModal.buyerTpin || '')) ? 'An LPO sale needs a 10-digit Buyer TPIN'
    : (payModal.lpoEnabled && !(payModal.lpoNumber && payModal.lpoNumber.trim())) ? 'An LPO sale needs the LPO number'
    : '';

  const pick = (key) => {
    if (key === active) return;
    if (num(payModal[key]) === 0) {
      const others = payNow - amounts[key];
      if (others >= total - 0.001) {
        // The sale is already covered, so another method only means "pay
        // this way instead": the whole amount moves to it.
        setPayModal((p) => ({ ...p, cash: '0', momo: '0', bank: '0', [key]: total.toFixed(2) }));
      } else {
        // A split: the new method starts at what is still owed, so the last
        // line rarely needs typing.
        setPayModal((p) => ({ ...p, [key]: (total - others).toFixed(2) }));
      }
    }
    setActive(key);
    setFresh(true);
  };

  const press = (key) => {
    if (sheet) {
      if (sheetField === 'tpin') {
        const next = pressDigits(payModal.buyerTpin, key, 10);
        setPayModal((p) => ({ ...p, buyerTpin: next }));
        // Any edit invalidates a previous check; ten digits checks again.
        if (tpinLookup?.status !== 'idle') setTpinLookup({ status: 'idle' });
        if (next.length === 10 && key !== 'del') lookupTpin(next);
      } else {
        setPayModal((p) => ({ ...p, lpoNumber: pressDigits(p.lpoNumber, key, 50) }));
      }
      return;
    }
    setPayModal((p) => ({ ...p, [active]: pressMoney(p[active], key, fresh) }));
    setFresh(false);
  };

  // Exact, then the amount rounded up to the next 500, 1,000 and 10,000.
  const quick = [];
  const addQuick = (v) => { if (v > 0 && !quick.some((q) => Math.abs(q - v) < 0.001)) quick.push(v); };
  addQuick(owedByActive);
  [500, 1000, 10000].forEach((st) => addQuick(roundUp(owedByActive, st)));

  const complete = () => {
    if (blocker) return;
    // The same breakdown the standard window sends on a single-currency
    // branch: an over-payment is reported as kept change, in 'USD', for the
    // amount over — see the keptCcy / keptAmt block in POS.js.
    const over = Math.max(0, payNow - total);
    onComplete({
      cash: amounts.cash, momo: amounts.momo, bank: amounts.bank,
      keptCcy: over > 0.001 ? 'USD' : null,
      keptAmt: over > 0.001 ? over : 0,
    });
  };

  const buyerLabel = selectedCustomer
    ? selectedCustomer.name
    : (payModal.buyerName || (tpinRaw ? `TPIN ${tpinRaw}` : 'Walk-in'));

  return (
    <div style={S.overlay}>
      <div style={S.bar}>
        <button type="button" onClick={onCancel} style={S.back}>‹ Cart</button>
        <span style={{ margin: '0 auto', fontWeight: 700, fontSize: 15 }}>Payment</span>
        <span style={{ width: 48 }} />
      </div>

      <div style={S.body}>
        {/* What's owed */}
        <div style={{ ...S.card, display: 'grid', gap: 2 }}>
          <span style={S.lbl}>Amount due</span>
          <span style={S.big}>{money(total)}</span>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: '#6b7385' }}>
            <span>{itemCount} item{itemCount === 1 ? '' : 's'} · {buyerLabel}</span>
            <button type="button" onClick={() => { setSheet(true); setSheetField('tpin'); }}
              style={{ background: 'none', border: 'none', color: NAVY, fontWeight: 700, fontSize: 12, cursor: 'pointer', padding: 0 }}>
              Buyer / LPO ›
            </button>
          </div>
        </div>

        {/* How it's paid */}
        {methods.length > 1 && (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${methods.length}, 1fr)`, gap: 6 }}>
            {methods.map((m) => {
              const on = m.key === active;
              const has = amounts[m.key] > 0;
              return (
                <button key={m.key} type="button" onClick={() => pick(m.key)}
                  style={{
                    background: on ? m.soft : '#fff',
                    border: `1.5px solid ${on ? m.color : has ? '#c5d1ea' : '#dfe4ee'}`,
                    boxShadow: on ? `inset 0 0 0 1px ${m.color}` : 'none',
                    borderRadius: 12, padding: '7px 4px', cursor: 'pointer',
                    display: 'grid', gap: 1, color: on ? m.color : '#475067',
                  }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{m.label}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: has ? '#334155' : '#9aa3b5' }}>
                    {has ? plain(amounts[m.key]) : '—'}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* The amount being keyed */}
        <div style={{ ...S.card, border: `2px solid ${enoughPaid ? NAVY : '#d97706'}`, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '8px 14px' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: enoughPaid ? NAVY : '#b45309' }}>{activeMethod.label} received</span>
          <span style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>
            {payModal[active] === '' || payModal[active] == null ? '0' : payModal[active]}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(1, quick.length)}, 1fr)`, gap: 6 }}>
          {quick.map((v, i) => (
            <button key={v} type="button"
              onClick={() => { setPayModal((p) => ({ ...p, [active]: v.toFixed(2) })); setFresh(true); }}
              style={{ background: i === 0 ? NAVY_TINT : '#fff', border: `1px solid ${i === 0 ? '#c5d1ea' : '#dfe4ee'}`, borderRadius: 10, padding: '7px 0', fontSize: 12, fontWeight: 700, color: NAVY, cursor: 'pointer', fontVariantNumeric: 'tabular-nums' }}>
              {i === 0 ? 'Exact' : plain(v)}
            </button>
          ))}
        </div>

        {!sheet && <Keypad onPress={press} />}

        {/* What's left over */}
        <div style={{
          borderRadius: 12, padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontWeight: 700, fontVariantNumeric: 'tabular-nums',
          background: enoughPaid ? '#effaf2' : '#fff7ed', color: enoughPaid ? '#166534' : '#9a3412',
          border: `1px solid ${enoughPaid ? '#bfe7cb' : '#fed7aa'}`,
        }}>
          <span>{enoughPaid ? 'Change' : 'Short by'}</span>
          <span style={{ fontSize: 20, fontWeight: 800 }}>{money(enoughPaid ? change : short)}</span>
        </div>
      </div>

      {/* Always in the same place; says why when it can't be pressed. */}
      <div style={S.foot}>
        <button type="button" onClick={complete} disabled={!!blocker}
          style={{
            width: '100%', border: 'none', borderRadius: 14, padding: '12px 14px',
            background: blocker ? '#cbd2dd' : '#16a34a', color: blocker ? '#5b6477' : '#fff',
            cursor: blocker ? 'not-allowed' : 'pointer', display: 'grid', gap: 1,
          }}>
          <span style={{ fontWeight: 800, fontSize: 16 }}>Complete Sale</span>
          <span style={{ fontWeight: 600, fontSize: 11.5 }}>{blocker || `${money(total)} · prints the receipt`}</span>
        </button>
      </div>

      {sheet && (
        <BuyerSheet
          payModal={payModal} setPayModal={setPayModal} zraEnabled={zraEnabled}
          selectedCustomer={selectedCustomer} tpinLookup={tpinLookup} lookupTpin={lookupTpin}
          onRegisterCustomer={onRegisterCustomer}
          field={sheetField} setField={setSheetField} onPress={press}
          onClose={() => setSheet(false)}
        />
      )}
    </div>
  );
}

// ── Buyer / LPO sheet ────────────────────────────────────────────────────
function BuyerSheet({ payModal, setPayModal, zraEnabled, selectedCustomer, tpinLookup, lookupTpin,
                      onRegisterCustomer, field, setField, onPress, onClose }) {
  const tpin = payModal.buyerTpin || '';
  const tpinReady = /^\d{10}$/.test(tpin);
  const box = (on) => ({
    border: `1.5px solid ${on ? NAVY : '#d6dce7'}`, boxShadow: on ? `inset 0 0 0 1px ${NAVY}` : 'none',
    borderRadius: 10, padding: '9px 10px', fontSize: 14, fontWeight: 600, background: '#fff',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer',
  });
  const lbl = { fontSize: 11, fontWeight: 700, letterSpacing: '.05em', textTransform: 'uppercase', color: '#6b7385' };
  const text = { width: '100%', padding: '9px 10px', border: '1.5px solid #d6dce7', borderRadius: 10, fontSize: 14, boxSizing: 'border-box' };
  const register = (
    <button type="button" onClick={onRegisterCustomer}
      style={{ padding: '4px 10px', border: 'none', borderRadius: 7, background: NAVY, color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
      + Register this customer
    </button>
  );

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,.45)' }} />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '92%', overflowY: 'auto', background: '#fff', borderRadius: '20px 20px 0 0', padding: '10px 14px 14px', display: 'grid', gap: 10 }}>
        <div style={{ width: 38, height: 4, borderRadius: 2, background: '#d3d8e2', justifySelf: 'center' }} />
        <div style={{ fontWeight: 800, fontSize: 16 }}>Buyer &amp; LPO</div>

        {selectedCustomer ? (
          // A customer chosen in the cart is the buyer, as in the standard
          // window; it is changed there, not here.
          <div style={{ display: 'grid', gap: 2 }}>
            <span style={lbl}>Buyer</span>
            <span style={{ fontWeight: 700 }}>{selectedCustomer.name}</span>
            <span style={{ fontSize: 12, color: selectedCustomer.tpin ? '#6b7385' : '#b45309' }}>
              {selectedCustomer.tpin ? `TPIN ${selectedCustomer.tpin}` : "No TPIN on file — the receipt will use ZRA's walk-in default"}
            </span>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gap: 4 }}>
              <span style={lbl}>Buyer TPIN <span style={{ textTransform: 'none', fontWeight: 400 }}>(leave blank for walk-in)</span></span>
              <div onClick={() => setField('tpin')} style={box(field === 'tpin')}>
                <span style={{ letterSpacing: 1, color: tpin ? '#0f172a' : '#9aa3b5' }}>{tpin || '10 digits'}</span>
                <button type="button" disabled={!tpinReady || tpinLookup?.status === 'loading'}
                  onClick={(e) => { e.stopPropagation(); lookupTpin(tpin); }}
                  style={{ padding: '4px 10px', border: 'none', borderRadius: 7, background: tpinReady ? NAVY : '#e5e7eb', color: tpinReady ? '#fff' : '#9ca3af', fontSize: 11, fontWeight: 700, cursor: tpinReady ? 'pointer' : 'not-allowed' }}>
                  {tpinLookup?.status === 'loading' ? '…' : 'Verify'}
                </button>
              </div>
              {tpinLookup?.status === 'loading' && <span style={{ fontSize: 11.5, color: '#6b7385' }}>Checking with ZRA…</span>}
              {tpinLookup?.status === 'verified' && (
                <span style={{ fontSize: 11.5, color: '#166534', fontWeight: 700 }}>
                  ✓ {tpinLookup.source === 'local' ? 'Local match' : 'ZRA verified'}: {tpinLookup.name || '(no name on file)'}
                </span>
              )}
              {tpinLookup?.status === 'notfound' && (
                <span style={{ fontSize: 11.5, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: '#b91c1c', fontWeight: 700 }}>✗ TPIN not registered with ZRA</span>{register}
                </span>
              )}
              {tpinLookup?.status === 'unavailable' && (
                <span style={{ fontSize: 11.5, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ color: '#b45309', fontWeight: 700 }}>⚠ Could not check with ZRA — the TPIN will still be sent</span>{register}
                </span>
              )}
              {tpinLookup?.status === 'error' && <span style={{ fontSize: 11.5, color: '#b45309' }}>{tpinLookup.message || 'Lookup failed'}</span>}
            </div>

            {tpin && (
              <>
                <div style={{ display: 'grid', gap: 4 }}>
                  <span style={lbl}>Buyer name</span>
                  <input type="text" maxLength={200} value={payModal.buyerName || ''}
                    onChange={(e) => setPayModal((p) => ({ ...p, buyerName: e.target.value }))}
                    placeholder="e.g. Zambian Breweries Plc" style={text} />
                </div>
                <div style={{ display: 'grid', gap: 4 }}>
                  <span style={lbl}>Buyer address</span>
                  <input type="text" maxLength={200} value={payModal.buyerAddress || ''}
                    onChange={(e) => setPayModal((p) => ({ ...p, buyerAddress: e.target.value }))}
                    placeholder="e.g. Plot 123, Great East Rd" style={text} />
                </div>
              </>
            )}
          </>
        )}

        {zraEnabled && (
          <>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fefce8', border: '1px solid #fde68a', borderRadius: 10, padding: '9px 10px', fontSize: 12.5, fontWeight: 700, color: '#78350f', cursor: 'pointer' }}>
              <input type="checkbox" checked={!!payModal.lpoEnabled}
                onChange={(e) => {
                  const on = e.target.checked;
                  setPayModal((p) => ({ ...p, lpoEnabled: on, lpoNumber: on ? (p.lpoNumber || '') : '' }));
                  if (on) setField('lpo');
                }}
                style={{ width: 18, height: 18 }} />
              LPO sale (zero-rated)
            </label>
            {payModal.lpoEnabled && (
              <div style={{ display: 'grid', gap: 4 }}>
                <span style={lbl}>LPO number <span style={{ color: '#b91c1c' }}>*</span></span>
                <div onClick={() => setField('lpo')} style={box(field === 'lpo')}>
                  <span style={{ color: payModal.lpoNumber ? '#0f172a' : '#9aa3b5' }}>{payModal.lpoNumber || 'e.g. 109506957'}</span>
                </div>
              </div>
            )}
          </>
        )}

        {/* The keypad fills whichever of TPIN or LPO number is outlined. */}
        {(!selectedCustomer || payModal.lpoEnabled) && <Keypad onPress={onPress} allowDot={false} />}

        <button type="button" onClick={onClose}
          style={{ border: 'none', borderRadius: 12, padding: 12, background: RED, color: '#fff', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}>
          Done
        </button>
      </div>
    </div>
  );
}

// ── Quantity window ──────────────────────────────────────────────────────
export function TerminalQtyWindow({ name, unit, unitPrice, value, onChange, onCancel, onSubmit, money }) {
  const [fresh, setFresh] = useState(true);
  const typed = parseFloat(value || 0) || 0;
  const invalid = !value || typed <= 0;
  const set = (v) => { onChange(v); setFresh(false); };
  const step = (d) => set(String(Math.max(1, Math.round((typed + d) * 1000) / 1000)));

  return (
    <div style={S.overlay}>
      <div style={S.bar}>
        <button type="button" onClick={onCancel} style={S.back}>‹ Items</button>
        <span style={{ margin: '0 auto', fontWeight: 700, fontSize: 15 }}>Quantity</span>
        <span style={{ width: 48 }} />
      </div>
      <div style={S.body}>
        <div style={{ ...S.card, display: 'grid', gap: 2 }}>
          <span style={{ fontWeight: 700, fontSize: 15 }}>{name}</span>
          <span style={{ fontSize: 12, color: '#6b7385' }}>{money(unitPrice)} per {unit}</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '56px 1fr 56px', gap: 8 }}>
          <button type="button" onClick={() => step(-1)} style={{ background: '#fff', border: '1px solid #dfe4ee', borderRadius: 12, fontSize: 24, fontWeight: 700, color: NAVY, cursor: 'pointer' }}>−</button>
          <div style={{ background: '#fff', border: `2px solid ${invalid ? '#fcd34d' : NAVY}`, borderRadius: 14, textAlign: 'center', fontSize: 32, fontWeight: 800, padding: '6px 0', fontVariantNumeric: 'tabular-nums' }}>
            {value || '0'}
          </div>
          <button type="button" onClick={() => step(1)} style={{ background: '#fff', border: '1px solid #dfe4ee', borderRadius: 12, fontSize: 24, fontWeight: 700, color: NAVY, cursor: 'pointer' }}>+</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {[1, 10, 50, 100].map((n) => (
            <button key={n} type="button" onClick={() => { onChange(String(n)); setFresh(true); }}
              style={{ background: '#fff', border: '1px solid #dfe4ee', borderRadius: 10, padding: '7px 0', fontSize: 12.5, fontWeight: 700, color: NAVY, cursor: 'pointer' }}>
              {n}
            </button>
          ))}
        </div>
        <Keypad onPress={(k) => set(pressQty(value, k, fresh))} />
        <div style={{ textAlign: 'center', fontSize: 13, color: '#4b5366', fontVariantNumeric: 'tabular-nums' }}>
          Line total <b style={{ color: '#0f172a' }}>{money(typed * unitPrice)}</b>
        </div>
      </div>
      <div style={S.foot}>
        <button type="button" onClick={onSubmit} disabled={invalid}
          style={{ width: '100%', border: 'none', borderRadius: 14, padding: '13px 14px', background: invalid ? '#cbd2dd' : RED, color: invalid ? '#5b6477' : '#fff', fontWeight: 800, fontSize: 16, cursor: invalid ? 'not-allowed' : 'pointer' }}>
          Add to cart{!invalid ? ` · ${value} ${unit}` : ''}
        </button>
      </div>
    </div>
  );
}
