// Cashier — 3-station workflow station (kassumbalesa1, workflow_mode='three_station').
//
// Left pane:   Pending Payments queue (orders status='PENDING_PAYMENT').
// Right pane:  Selected order details + Sirak-POS-style payment panel.
//
// Payment math mirrors Sirak-POS Cashier.js exactly — the reference build the
// user explicitly told us to copy:
//   paidFRAasUSD     = paidFRA / sellRate
//   totalAmountPaid  = paidUSD + paidFRAasUSD
//   unpaidBalance    = max(0, totalDue - totalAmountPaid)
//   changeUSD        = max(0, totalAmountPaid - totalDue)
//   changeFRA        = changeUSD * buyRate
//   totalChangeGiven = givenUSD + givenFRA / buyRate
//   netRemaining     = changeUSD - totalChangeGiven
//
// FX rates: read from Accounting → Currency Rates (table fx_rates). Falls
// back to SELL=2900, BUY=2600 when no rate has been saved yet so existing
// terminals don't break the moment they upgrade. Snapshot stored on the
// order at collect-payment time so old receipts always replay correctly.
import React, { useEffect, useState } from 'react';
import { FiRefreshCw, FiClock, FiUser, FiShoppingCart } from 'react-icons/fi';
import {
  getCashierInbox,
  getCashierPaymentHistory,
  getOrder,
  collectOrderPayment,
  editOrderPayment,
  getSettings,
  getCurrentFxRate,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import printHtml from '../utils/printHtml';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';

const FALLBACK_SELL   = 2900;
const FALLBACK_BUY    = 2600;
const FALLBACK_SELL_K = 25;   // placeholder until set in Currency Rates
const FALLBACK_BUY_K  = 23;

const fmtFRA = (n) => Math.round(parseFloat(n || 0)).toLocaleString('en-US');
const fmtK   = (n) => Math.round(parseFloat(n || 0)).toLocaleString('en-US');

export default function Cashier() {
  const { user } = useAuth();
  // v1.7.0: currency_mode='USD+FRA+K' enables a third K (Kwacha) input row.
  // 'USD+FRA' = FRA only (legacy). 'K' = USD-only at Cashier.
  const { currencyMode, symbol: curSym, isLiquorStyle } = useCurrency();
  // v1.13.5 — fmtUSD used to be a global that hardcoded '$'. On K-only
  // (Liquor-style) branches curSym is 'K', so every money render on this
  // page (Subtotal / Total / Change / Unit / History rows) now uses the
  // branch's own primary symbol. Name stays fmtUSD for a low-risk drop-in.
  const fmtUSD = (n) => `${curSym}${parseFloat(n || 0).toFixed(2)}`;
  const hasFra = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const hasK   = currencyMode === 'USD+FRA+K';
  const [inbox, setInbox] = useState([]);
  const [loadingInbox, setLoadingInbox] = useState(false);
  // v1.8.86 — Pending / History tabs. 'pending' shows the live queue + payment
  // form. 'history' shows past paid orders in the same 3-column layout but
  // with all inputs disabled and a Reconciliation box added.
  const [mode, setMode] = useState('pending'); // 'pending' | 'history'
  const [history, setHistory] = useState([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  // v1.8.87 — admin post-payment edit. editForm shadows the order's mutable
  // payment fields while editing; cleared on Save/Cancel/order change.
  const [editing, setEditing] = useState(false);
  const [editForm, setEditForm] = useState(null);
  const [editReason, setEditReason] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [crWarning, setCRWarning] = useState(null); // { cr_date, cr_cashier_name }
  const [selected, setSelected] = useState(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [amountPaidUSD, setAmountPaidUSD] = useState('');
  const [amountPaidFRA, setAmountPaidFRA] = useState('');
  const [amountPaidK,   setAmountPaidK]   = useState('');
  const [changeGivenUSD, setChangeGivenUSD] = useState('');
  const [changeGivenFRA, setChangeGivenFRA] = useState('');
  const [changeGivenK,   setChangeGivenK]   = useState('');
  // v1.8.68 — which drawer holds the over-payment the cashier KEPT (no change
  // physically returned). Defaulted from the currency the customer paid most in.
  const [keptCcy, setKeptCcy] = useState('');
  const [confirm, setConfirm] = useState(null);   // { ...calc }
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  const [biz, setBiz] = useState({ name: 'Kelete', phone: '', address: '' });
  // Live FX rates — refreshed on mount + when opening a new order so a
  // mid-shift rate change is picked up without a hard reload. K rates
  // default to the FALLBACK_*_K constants until the admin sets them in
  // Accounting → Currency Rates.
  const [fxRate, setFxRate] = useState({ sell: FALLBACK_SELL, buy: FALLBACK_BUY, sellK: FALLBACK_SELL_K, buyK: FALLBACK_BUY_K });
  const SELL_RATE   = fxRate.sell;
  const BUY_RATE    = fxRate.buy;
  const SELL_RATE_K = fxRate.sellK;
  const BUY_RATE_K  = fxRate.buyK;

  const refreshFxRate = async () => {
    try {
      const r = await getCurrentFxRate();
      if (r.data) {
        setFxRate(prev => ({
          sell:  parseFloat(r.data.sell_rate)  > 0 ? parseFloat(r.data.sell_rate)  : prev.sell,
          buy:   parseFloat(r.data.buy_rate)   > 0 ? parseFloat(r.data.buy_rate)   : prev.buy,
          sellK: parseFloat(r.data.sell_rate_k)> 0 ? parseFloat(r.data.sell_rate_k): prev.sellK,
          buyK:  parseFloat(r.data.buy_rate_k) > 0 ? parseFloat(r.data.buy_rate_k) : prev.buyK,
        }));
      }
    } catch { /* keep fallback */ }
  };
  useEffect(() => { refreshFxRate(); }, []);

  useEffect(() => {
    getSettings().then(r => {
      const b = r.data?.business || {};
      setBiz({
        name:    b.business_name    || 'Kelete',
        phone:   b.business_phone   || '',
        address: b.business_address || '',
      });
    }).catch(() => {});
  }, []);

  const refreshInbox = async () => {
    setLoadingInbox(true);
    try {
      const res = await getCashierInbox();
      setInbox(Array.isArray(res.data) ? res.data : []);
    } catch { /* ignore */ }
    setLoadingInbox(false);
  };

  useEffect(() => {
    refreshInbox();
    // Poll every 5s so newly-confirmed orders from the Sales station appear
    // automatically. Light enough on a small queue.
    const id = setInterval(refreshInbox, 5000);
    return () => clearInterval(id);
  }, []);

  // v1.8.86 — fetch payment history when user switches to the History tab.
  // No polling here — past orders don't change, so one fetch per open is enough.
  const refreshHistory = async () => {
    setLoadingHistory(true);
    try {
      const res = await getCashierPaymentHistory(50);
      setHistory(Array.isArray(res.data) ? res.data : []);
    } catch { /* ignore */ }
    setLoadingHistory(false);
  };
  useEffect(() => {
    if (mode === 'history') {
      refreshHistory();
      setSelected(null); // drop the live-selected order when switching tabs
    } else {
      setSelected(null);
    }
    // v1.8.87 — leaving History (or switching orders) drops any in-flight edit.
    setEditing(false);
    setEditForm(null);
    setEditReason('');
  }, [mode]);

  const openOrder = async (id) => {
    setLoadingDetail(true);
    setAmountPaidUSD(''); setAmountPaidFRA(''); setAmountPaidK('');
    setChangeGivenUSD(''); setChangeGivenFRA(''); setChangeGivenK(''); setKeptCcy('');
    // v1.8.87 — selecting a new order discards any in-flight edit on the previous one.
    setEditing(false); setEditForm(null); setEditReason('');
    refreshFxRate();
    try {
      const res = await getOrder(id);
      setSelected(res.data);
    } catch { setSelected(null); }
    setLoadingDetail(false);
  };

  // v1.8.87 — Edit Payment handlers (admin-only, 7-day window enforced server-side).
  const isAdmin = user?.role === 'Administrator';
  const withinEditWindow = (() => {
    if (!selected?.paid_at) return false;
    const paidMs = new Date(selected.paid_at + (selected.paid_at.includes('T') ? '' : 'Z')).getTime();
    return (Date.now() - paidMs) <= 7 * 24 * 60 * 60 * 1000;
  })();
  const canEdit = mode === 'history' && !!selected && isAdmin && withinEditWindow;

  // v1.8.97 — Edit mode now populates the SAME live state the Pending Payment
  // form uses (amountPaidUSD/FRA/K, changeGivenUSD/FRA/K, fxRate, keptCcy).
  // The Pending right-panel JSX re-renders with live computePayment() driving
  // change owed / unpaid balance / kept ccy picker — admin sees the math react
  // as they type, identical to the live cashier flow. On Save, we read those
  // same live values + the order's stored FX rates back out and PUT them.
  const startEdit = () => {
    if (!selected) return;
    // Seed live form state with the order's stored values.
    setAmountPaidUSD(String(selected.cash_received ?? 0));
    setAmountPaidFRA(String(selected.fra_received  ?? 0));
    setAmountPaidK(  String(selected.k_received    ?? 0));
    setChangeGivenUSD(String(selected.usd_change_given ?? 0));
    setChangeGivenFRA(String(selected.fra_change_given ?? 0));
    setChangeGivenK(  String(selected.k_change_given   ?? 0));
    setKeptCcy(selected.overpaid_kept_ccy || '');
    // Snapshot FX rates from the order so the math reproduces faithfully.
    // Falls back to live rates if a particular rate wasn't stored.
    setFxRate(prev => ({
      sell:  parseFloat(selected.selling_rate_used)   > 0 ? parseFloat(selected.selling_rate_used)   : prev.sell,
      buy:   parseFloat(selected.buying_rate_used)    > 0 ? parseFloat(selected.buying_rate_used)    : prev.buy,
      sellK: parseFloat(selected.selling_rate_k_used) > 0 ? parseFloat(selected.selling_rate_k_used) : prev.sellK,
      buyK:  parseFloat(selected.buying_rate_k_used)  > 0 ? parseFloat(selected.buying_rate_k_used)  : prev.buyK,
    }));
    setEditReason('');
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setEditReason('');
    // Reset live form so the read-only panel re-renders clean.
    setAmountPaidUSD(''); setAmountPaidFRA(''); setAmountPaidK('');
    setChangeGivenUSD(''); setChangeGivenFRA(''); setChangeGivenK('');
    setKeptCcy('');
    refreshFxRate();
  };
  const saveEdit = async () => {
    if (!selected) return;
    if (editReason.trim().length < 3) {
      setToast({ type: 'error', text: 'Reason must be at least 3 characters' });
      setTimeout(() => setToast(null), 3000);
      return;
    }
    // Read the same live state Pending uses → build the payload.
    const payload = {
      cash_received:        parseFloat(amountPaidUSD)   || 0,
      fra_received:         parseFloat(amountPaidFRA)   || 0,
      k_received:           parseFloat(amountPaidK)     || 0,
      usd_change_given:     parseFloat(changeGivenUSD)  || 0,
      fra_change_given:     parseFloat(changeGivenFRA)  || 0,
      k_change_given:       parseFloat(changeGivenK)    || 0,
      overpaid_kept_ccy:    keptCcy || null,
      overpaid_kept_amt:    parseFloat(selected.overpaid_kept_amt) || 0,
      selling_rate_used:    SELL_RATE   || 0,
      buying_rate_used:     BUY_RATE    || 0,
      selling_rate_k_used:  SELL_RATE_K || 0,
      buying_rate_k_used:   BUY_RATE_K  || 0,
      reason:               editReason.trim(),
    };
    setEditSaving(true);
    try {
      const res = await editOrderPayment(selected.id, payload);
      setSelected(res.data.order || selected);
      cancelEdit();
      if (res.data.cr_exists) {
        setCRWarning({ cr_date: res.data.cr_date, cr_cashier_name: res.data.cr_cashier_name });
      } else {
        setToast({ type: 'success', text: 'Payment updated' });
        setTimeout(() => setToast(null), 3000);
      }
      refreshHistory();
    } catch (err) {
      setToast({ type: 'error', text: err.response?.data?.error || 'Save failed' });
      setTimeout(() => setToast(null), 4000);
    }
    setEditSaving(false);
  };

  // Sirak math, extended with K (v1.7.0). Three foreign-cash buckets:
  //   paidFRAasUSD = paidFRA / sellRate
  //   paidKasUSD   = paidK   / sellRateK
  //   totalAmountPaid = paidUSD + paidFRAasUSD + paidKasUSD
  // Change displays in all currencies (read-only); cashier picks which
  // currency to physically hand back.
  const computePayment = () => {
    if (!selected) return null;
    const totalDue = parseFloat(selected.total_amount || 0);
    const paidUSD  = parseFloat(amountPaidUSD || 0) || 0;
    const paidFRA  = parseFloat(amountPaidFRA || 0) || 0;
    const paidK    = parseFloat(amountPaidK   || 0) || 0;
    const paidFRAasUSD    = SELL_RATE   > 0 ? paidFRA / SELL_RATE   : 0;
    const paidKasUSD      = SELL_RATE_K > 0 ? paidK   / SELL_RATE_K : 0;
    const totalAmountPaid = paidUSD + paidFRAasUSD + paidKasUSD;
    const unpaidBalance   = Math.max(0, totalDue - totalAmountPaid);
    const unpaidBalanceFRA= SELL_RATE   > 0 ? unpaidBalance * SELL_RATE   : 0;
    const unpaidBalanceK  = SELL_RATE_K > 0 ? unpaidBalance * SELL_RATE_K : 0;
    // v1.8.72 — attribute over-payment to the SOURCE currency. Priority order:
    // USD pays first, then FRA fills the gap, then K. Whatever's left over in
    // each currency is the over-payment in THAT currency (no FX round-trip,
    // so the 1:1 "give me back what I gave you" rule holds).
    let _rem = totalDue;
    const _usdUsed = Math.min(paidUSD, _rem);
    const overUSD  = paidUSD - _usdUsed;
    _rem -= _usdUsed;
    let overFRA = 0;
    if (_rem > 0 && paidFRA > 0 && SELL_RATE > 0) {
      const fraNeeded = _rem * SELL_RATE;
      if (paidFRA >= fraNeeded) { overFRA = paidFRA - fraNeeded; _rem = 0; }
      else                      { _rem -= paidFRA / SELL_RATE; }
    } else if (paidFRA > 0) {
      overFRA = paidFRA;
    }
    let overK = 0;
    if (_rem > 0 && paidK > 0 && SELL_RATE_K > 0) {
      const kNeeded = _rem * SELL_RATE_K;
      if (paidK >= kNeeded) { overK = paidK - kNeeded; _rem = 0; }
      else                  { _rem -= paidK / SELL_RATE_K; }
    } else if (paidK > 0) {
      overK = paidK;
    }
    // Legacy USD-equivalent change (kept for places that still use it: receipt
    // headline, isOverpaid flag, given-vs-owed comparison).
    const changeUSD       = Math.max(0, totalAmountPaid - totalDue);
    const changeFRA       = BUY_RATE   > 0 ? changeUSD * BUY_RATE   : 0;
    const changeK         = BUY_RATE_K > 0 ? changeUSD * BUY_RATE_K : 0;
    const isOverpaid      = changeUSD > 0.001;
    const givenUSD        = parseFloat(changeGivenUSD || 0) || 0;
    const givenFRA        = parseFloat(changeGivenFRA || 0) || 0;
    const givenK          = parseFloat(changeGivenK   || 0) || 0;
    const totalChangeGiven = givenUSD
                           + (BUY_RATE   > 0 ? givenFRA / BUY_RATE   : 0)
                           + (BUY_RATE_K > 0 ? givenK   / BUY_RATE_K : 0);
    const netRemaining    = changeUSD - totalChangeGiven;
    const netRemainingFRA = BUY_RATE   > 0 ? netRemaining * BUY_RATE   : 0;
    const netRemainingK   = BUY_RATE_K > 0 ? netRemaining * BUY_RATE_K : 0;
    return {
      totalDue, paidUSD, paidFRA, paidK, paidFRAasUSD, paidKasUSD, totalAmountPaid,
      unpaidBalance, unpaidBalanceFRA, unpaidBalanceK,
      changeUSD, changeFRA, changeK, isOverpaid,
      // v1.8.72 — per-source-currency over-payment (no FX round-trip).
      overUSD, overFRA, overK,
      givenUSD, givenFRA, givenK, totalChangeGiven,
      netRemaining, netRemainingFRA, netRemainingK,
    };
  };

  const handleConfirm = () => {
    const data = computePayment();
    if (!data) return;
    setConfirm(data);
  };

  const processPayment = async () => {
    if (!selected || !confirm) return;
    setSubmitting(true);
    try {
      await collectOrderPayment(selected.id, {
        paid_usd:     confirm.paidUSD,
        paid_fra:     confirm.paidFRA,
        paid_k:       confirm.paidK,
        given_usd:    confirm.givenUSD,
        given_fra:    confirm.givenFRA,
        given_k:      confirm.givenK,
        buy_rate:     BUY_RATE,
        sell_rate:    SELL_RATE,
        buy_rate_k:   BUY_RATE_K,
        sell_rate_k:  SELL_RATE_K,
        // v1.8.68 — which drawer the over-payment was kept in (when cashier
        // didn't physically return the change). Backend defaults to the
        // currency the customer paid in if this is blank.
        // v1.8.72 — send the NATIVE amount so backend doesn't round-trip
        // through USD (which loses 4 FRA per $0.11 to the sell/buy spread).
        // v1.8.74 — use EFFECTIVE ccy (clicked OR default-highlighted).
        // v1.8.78 — default always FRA (most common at Kelete) unless cashier
        // explicitly clicked USD or K. Native amount comes from per-currency
        // attribution so FRA over/under always lands native (no FX loss).
        overpaid_kept_ccy: confirm.netRemaining > 0.005
          ? (keptCcy || (hasFra ? 'FRA' : hasK ? 'K' : 'USD'))
          : '',
        overpaid_kept_amt: (() => {
          if (confirm.netRemaining <= 0.005) return 0;
          const ccy = keptCcy || (hasFra ? 'FRA' : hasK ? 'K' : 'USD');
          // v1.8.79 — when converting the USD-leftover to FRA/K storage, use
          // the BUY rate. Buy rate is what the frontend already used to display
          // "Change ≈ FRA 148,200" so this keeps the math consistent: 148,200
          // owed − 148,000 given = 200 stored (was 203 at sell rate).
          if (ccy === 'FRA') {
            return confirm.overFRA > 0.5 ? confirm.overFRA
                 : (BUY_RATE > 0 ? confirm.netRemaining * BUY_RATE : 0);
          }
          if (ccy === 'K') {
            return confirm.overK > 0.5 ? confirm.overK
                 : (BUY_RATE_K > 0 ? confirm.netRemaining * BUY_RATE_K : 0);
          }
          if (ccy === 'USD') {
            return confirm.overUSD > 0.001 ? confirm.overUSD : confirm.netRemaining;
          }
          return 0;
        })(),
      });

      // Snapshot for the printed receipt BEFORE we clear state.
      const cashierName = user ? `${user.first_name || ''} ${user.last_name || ''}`.trim() : 'Cashier';
      try {
        printHtml(renderCashierReceipt({
          biz,
          order: selected,
          calc: confirm,
          cashierName,
          when: new Date(),
          sellRate:  SELL_RATE,
          buyRate:   BUY_RATE,
          sellRateK: SELL_RATE_K,
          buyRateK:  BUY_RATE_K,
          isLiquorStyle,
          curSym,
        }));
      } catch (_) { /* non-fatal — payment is already recorded */ }

      setSelected(null);
      setConfirm(null);
      setAmountPaidUSD(''); setAmountPaidFRA('');
      setChangeGivenUSD(''); setChangeGivenFRA('');
      setToast({ text: 'Payment recorded — order moved to Dispatch.', type: 'success' });
      setTimeout(() => setToast(null), 3000);
      refreshInbox();
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Payment failed';
      setToast({ text: msg, type: 'error' });
      setTimeout(() => setToast(null), 4500);
    }
    setSubmitting(false);
  };

  const calc = computePayment();
  // v1.8.49 — credit-at-Cashier. If the order has a registered customer
  // (set on the Sales/Reception screen), the cashier can take partial /
  // zero payment — the unpaid portion lives on the customer's outstanding.
  // Walk-ins still need to pay in full (10¢ rounding tolerance).
  const hasRegisteredCustomer = !!(selected && selected.customer_id);
  const creditAvailable = hasRegisteredCustomer
    ? Math.max(0, parseFloat(selected.customer_credit_limit || 0) - parseFloat(selected.customer_outstanding || 0))
    : 0;
  const wouldExceedLimit = hasRegisteredCustomer && !!calc
    && parseFloat(selected.customer_credit_limit || 0) > 0
    && (parseFloat(selected.customer_outstanding || 0) + calc.unpaidBalance) > parseFloat(selected.customer_credit_limit || 0) + 0.001;
  const onHold = hasRegisteredCustomer && selected.customer_credit_status === 'OnHold';
  // v1.8.97 — OVER-CHANGE GUARD. Block save when cashier types change-given
  // amounts whose USD-eq sum exceeds the actual change owed by more than
  // the $0.10 rounding tolerance. Catches the "cashier gave back too much
  // FRA on top of the correct USD" mistake (real incident: ORD-0039 lost
  // 3,500 FRA to a $1.56 over-change). Applies in both Pending and Edit
  // modes since computePayment is the same engine.
  const overChangeUSD = calc ? (calc.totalChangeGiven - calc.changeUSD) : 0;
  const isOverChange  = overChangeUSD > 0.10;

  // Walk-in: require any payment + must cover the full total (within 10¢).
  // Registered customer: any payment OR full credit (0) is allowed,
  // provided the customer isn't on hold and isn't over-limit.
  const canConfirm = !!selected && !!calc && !onHold && !wouldExceedLimit && !isOverChange && (
    hasRegisteredCustomer
      ? true                                                     // partial / full / 0 all OK
      : (calc.paidUSD > 0 || calc.paidFRA > 0 || calc.paidK > 0) // walk-in: must enter something
  );

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Cashier</h1>
          <p>Collect payment on orders sent from Sales</p>
        </div>
        <button onClick={refreshInbox}
          style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <FiRefreshCw /> Refresh
        </button>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 20, zIndex: 999,
          padding: '12px 18px', borderRadius: 8, color: '#fff', fontWeight: 600,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
        }}>{toast.text}</div>
      )}

      {/* v1.8.86 — Mode tabs (Pending / History). History is read-only. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, borderBottom: '1px solid #e5e7eb' }}>
        {[
          { key: 'pending', label: 'Pending Payments', count: inbox.length, color: '#0ea5e9' },
          { key: 'history', label: 'Payment History',  count: null,         color: '#7c3aed' },
        ].map(t => {
          const active = mode === t.key;
          return (
            <button key={t.key} onClick={() => setMode(t.key)}
              style={{
                padding: '10px 18px',
                background: 'transparent',
                border: 'none',
                borderBottom: active ? `3px solid ${t.color}` : '3px solid transparent',
                color: active ? t.color : '#64748b',
                fontWeight: active ? 700 : 500,
                fontSize: 13,
                cursor: 'pointer',
                marginBottom: -1,
                display: 'inline-flex', alignItems: 'center', gap: 8,
              }}>
              {t.label}
              {t.count !== null && (
                <span style={{ fontSize: 11, background: active ? t.color : '#e5e7eb', color: active ? '#fff' : '#64748b', padding: '1px 8px', borderRadius: 999, fontWeight: 700 }}>
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 16, height: 'calc(100vh - 240px)' }}>
        {/* ── LEFT: Inbox queue OR History list ──────────────────────── */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, overflowY: 'auto' }}>
          {mode === 'pending' ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 15, color: '#0f172a' }}>Pending Payments</h3>
                <span style={{ fontSize: 12, color: '#64748b', background: '#f1f5f9', padding: '2px 8px', borderRadius: 12 }}>
                  {inbox.length}
                </span>
              </div>
              {loadingInbox && inbox.length === 0 ? (
                <p style={{ color: '#64748b', fontSize: 13 }}>Loading…</p>
              ) : inbox.length === 0 ? (
                <p style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>No pending payments</p>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {inbox.map(o => (
                    <div key={o.id}
                      onClick={() => openOrder(o.id)}
                      style={{
                        padding: '10px 12px',
                        border: `1.5px solid ${selected?.id === o.id ? '#2563eb' : '#e5e7eb'}`,
                        background: selected?.id === o.id ? '#eff6ff' : '#fff',
                        borderRadius: 8, cursor: 'pointer',
                      }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{fmtInvoiceNo(o.order_number)}</span>
                        <span style={{ fontWeight: 700, fontSize: 14, color: '#0ea5e9' }}>{fmtUSD(o.total_amount)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b' }}>
                        <span><FiUser size={10} style={{ verticalAlign: 'middle' }} /> {o.customer_name || 'Walk-in'}</span>
                        <span>{o.item_count} item{o.item_count === 1 ? '' : 's'}</span>
                      </div>
                      {o.sales_at && (
                        <div style={{ marginTop: 4, fontSize: 10, color: '#94a3b8' }}>
                          <FiClock size={10} style={{ verticalAlign: 'middle' }} /> {new Date(o.sales_at).toLocaleString()}
                          {o.sales_by_name ? ` · by ${o.sales_by_name}` : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ margin: 0, fontSize: 15, color: '#0f172a' }}>Past Payments</h3>
                <span style={{ fontSize: 12, color: '#64748b', background: '#f1f5f9', padding: '2px 8px', borderRadius: 12 }}>
                  {history.length}
                </span>
              </div>
              {loadingHistory && history.length === 0 ? (
                <p style={{ color: '#64748b', fontSize: 13 }}>Loading…</p>
              ) : history.length === 0 ? (
                <p style={{ color: '#94a3b8', fontSize: 13, fontStyle: 'italic' }}>No past payments</p>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {history.map(o => (
                    <div key={o.id}
                      onClick={() => openOrder(o.id)}
                      style={{
                        padding: '10px 12px',
                        border: `1.5px solid ${selected?.id === o.id ? '#7c3aed' : '#e5e7eb'}`,
                        background: selected?.id === o.id ? '#faf5ff' : '#fff',
                        borderRadius: 8, cursor: 'pointer',
                      }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <span style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{fmtInvoiceNo(o.order_number)}</span>
                        <span style={{ fontWeight: 700, fontSize: 14, color: '#7c3aed' }}>{fmtUSD(o.total_amount)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748b' }}>
                        <span><FiUser size={10} style={{ verticalAlign: 'middle' }} /> {o.customer_name || 'Walk-in'}</span>
                        <span>{o.item_count} item{o.item_count === 1 ? '' : 's'}</span>
                      </div>
                      {o.paid_at && (
                        <div style={{ marginTop: 4, fontSize: 10, color: '#94a3b8' }}>
                          <FiClock size={10} style={{ verticalAlign: 'middle' }} /> {new Date(o.paid_at).toLocaleString()}
                          {o.cashier_name ? ` · by ${o.cashier_name}` : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── RIGHT: Order detail + payment ──────────────────────────── */}
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, overflowY: 'auto' }}>
          {!selected ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#94a3b8', flexDirection: 'column' }}>
              <FiShoppingCart size={48} style={{ marginBottom: 12, opacity: 0.4 }} />
              <p style={{ fontStyle: 'italic' }}>Select an order from the queue to collect payment</p>
            </div>
          ) : loadingDetail ? (
            <p style={{ color: '#64748b' }}>Loading order…</p>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
              {/* Left half: order + items */}
              <div>
                <h3 style={{ margin: '0 0 4px 0', fontSize: 16, color: '#0f172a' }}>
                  Order {fmtInvoiceNo(selected.order_number)}
                  {hasRegisteredCustomer && (
                    <span style={{ marginLeft: 8, padding: '2px 8px', background: '#fef3c7', color: '#92400e', borderRadius: 999, fontSize: 10, fontWeight: 700, verticalAlign: 'middle' }}>
                      CREDIT-ELIGIBLE
                    </span>
                  )}
                  {onHold && (
                    <span style={{ marginLeft: 6, padding: '2px 8px', background: '#fee2e2', color: '#b91c1c', borderRadius: 999, fontSize: 10, fontWeight: 700, verticalAlign: 'middle' }}>
                      ON HOLD
                    </span>
                  )}
                </h3>
                <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>
                  Customer: <strong>{selected.customer_name || 'Walk-in'}</strong>
                  {hasRegisteredCustomer && parseFloat(selected.customer_credit_limit || 0) > 0 && (
                    <> · Limit {fmtUSD(selected.customer_credit_limit)} · Outstanding {fmtUSD(selected.customer_outstanding || 0)} · Available {fmtUSD(creditAvailable)}</>
                  )}
                </p>
                {hasRegisteredCustomer && calc && calc.unpaidBalance > 0.10 && (
                  <div style={{ marginTop: 8, padding: '8px 10px', background: wouldExceedLimit ? '#fee2e2' : '#fef3c7', border: `1px solid ${wouldExceedLimit ? '#fecaca' : '#fde68a'}`, borderRadius: 6, fontSize: 12, color: wouldExceedLimit ? '#991b1b' : '#92400e', fontWeight: 600 }}>
                    {wouldExceedLimit
                      ? `⚠ Would exceed credit limit. Available is only ${fmtUSD(creditAvailable)}.`
                      : `Will create credit of ${fmtUSD(calc.unpaidBalance)} on this customer's account.`}
                  </div>
                )}
                <div style={{ marginTop: 14, border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                  <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead style={{ background: '#f8fafc' }}>
                      <tr>
                        <th style={thStyle}>Item</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Qty</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Price</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(selected.items || []).map((it, i) => {
                        // v1.10.14 — mirror Sales Report treatment of reversed
                        // items: full reversal → strike-through + VOID badge;
                        // partial reversal → net qty + amber "reversed X" chip.
                        const origQty = parseFloat(it.quantity || 0);
                        const rq      = parseFloat(it.reversed_quantity || 0);
                        const partial = !it.reversed && rq > 0;
                        const netQty  = partial ? Math.max(0, origQty - rq) : origQty;
                        const unitPx  = parseFloat(it.unit_price || 0);
                        const netTotal = it.reversed ? 0 : unitPx * netQty;
                        const strike = it.reversed ? { textDecoration: 'line-through' } : {};
                        return (
                          <tr key={i} style={{ borderTop: '1px solid #f1f5f9', opacity: it.reversed ? 0.5 : 1 }}>
                            <td style={{ ...tdStyle, ...strike }}>
                              {it.product_name}
                              {!!it.reversed && (
                                <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#dc2626', background: '#fee2e2', borderRadius: 4, padding: '1px 6px', verticalAlign: 'middle' }}>
                                  VOID
                                </span>
                              )}
                              {partial && (
                                <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#b45309', background: '#fef3c7', borderRadius: 4, padding: '1px 6px', verticalAlign: 'middle' }}>
                                  was {origQty} — reversed {rq}
                                </span>
                              )}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', ...strike, fontWeight: partial ? 700 : 400 }}>
                              {netQty.toFixed(2)} {it.unit || ''}
                            </td>
                            <td style={{ ...tdStyle, textAlign: 'right', ...strike }}>{fmtUSD(unitPx)}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', ...strike, fontWeight: partial ? 700 : 400 }}>{fmtUSD(netTotal)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ marginTop: 12, fontSize: 13 }}>
                  <div style={totalsRow}><span>Subtotal</span><span>{fmtUSD(selected.subtotal)}</span></div>
                  {parseFloat(selected.discount || 0) > 0 && (
                    <div style={totalsRow}><span>Discount</span><span>−{fmtUSD(selected.discount)}</span></div>
                  )}
                  <div style={{ ...totalsRow, fontWeight: 700, color: '#0f172a', borderTop: '1px solid #e5e7eb', marginTop: 6, paddingTop: 6 }}>
                    <span>Total Due</span><span>{fmtUSD(selected.total_amount)}</span>
                  </div>
                </div>
              </div>

              {/* v1.8.97 — Right half:
                  • Pending mode → live payment form
                  • History + editing=true → SAME live payment form (admin edit)
                  • History + editing=false → read-only summary panel
                  Reusing the Pending JSX for edit means computePayment runs
                  live as the admin types — same UX as the cashier flow. */}
              {(mode === 'pending' || (mode === 'history' && editing)) ? (
              <div>
                <h3 style={{ margin: '0 0 10px 0', fontSize: 16, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8 }}>
                  Payment
                  {editing && (
                    <span style={{ fontSize: 10, background: '#fef3c7', color: '#92400e', padding: '2px 8px', borderRadius: 4, fontWeight: 700, letterSpacing: 0.5 }}>EDITING</span>
                  )}
                </h3>
                <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '12px 14px', marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: '#0369a1', fontWeight: 600 }}>Total Due</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: '#0c4a6e', lineHeight: 1.1 }}>{fmtUSD(selected.total_amount)}</div>
                  {hasFra && (
                    <div style={{ fontSize: 11, color: '#0369a1', marginTop: 2 }}>
                      or {fmtFRA(parseFloat(selected.total_amount) * SELL_RATE)} FRA (sell {SELL_RATE.toLocaleString()})
                      {hasK && <> · or {fmtK(parseFloat(selected.total_amount) * SELL_RATE_K)} K (sell {SELL_RATE_K.toLocaleString()})</>}
                    </div>
                  )}
                </div>

                {/* v1.6.3 + v1.7.0: per-invoice FX rate override. K row only
                    appears when currency_mode='USD+FRA+K'. */}
                {hasFra && (
                <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: 10, marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: '#92400e', fontWeight: 700, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>FX Rate for this invoice</span>
                    <button type="button" onClick={refreshFxRate}
                      style={{ background: 'transparent', border: '1px solid #fde68a', color: '#92400e', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', fontSize: 10, fontWeight: 600 }}>
                      Reset to default
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <div>
                      <label style={{ ...lblStyle, color: '#92400e' }}>Sell rate (paid in FRA)</label>
                      <input type="number" min="0" step="0.01" value={fxRate.sell}
                        onChange={e => setFxRate(r => ({ ...r, sell: parseFloat(e.target.value) || 0 }))}
                        style={inputStyle} />
                    </div>
                    <div>
                      <label style={{ ...lblStyle, color: '#92400e' }}>Buy rate (change in FRA)</label>
                      <input type="number" min="0" step="0.01" value={fxRate.buy}
                        onChange={e => setFxRate(r => ({ ...r, buy: parseFloat(e.target.value) || 0 }))}
                        style={inputStyle} />
                    </div>
                  </div>
                  {hasK && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8, borderTop: '1px dashed #fde68a', paddingTop: 8 }}>
                      <div>
                        <label style={{ ...lblStyle, color: '#92400e' }}>Sell rate (paid in K)</label>
                        <input type="number" min="0" step="0.01" value={fxRate.sellK}
                          onChange={e => setFxRate(r => ({ ...r, sellK: parseFloat(e.target.value) || 0 }))}
                          style={inputStyle} />
                      </div>
                      <div>
                        <label style={{ ...lblStyle, color: '#92400e' }}>Buy rate (change in K)</label>
                        <input type="number" min="0" step="0.01" value={fxRate.buyK}
                          onChange={e => setFxRate(r => ({ ...r, buyK: parseFloat(e.target.value) || 0 }))}
                          style={inputStyle} />
                      </div>
                    </div>
                  )}
                </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: hasK ? '1fr 1fr 1fr' : (hasFra ? '1fr 1fr' : '1fr'), gap: 10 }}>
                  <div>
                    <label style={lblStyle}>Amount Paid ($)</label>
                    <input type="number" min="0" step="0.01" value={amountPaidUSD}
                      onChange={e => setAmountPaidUSD(e.target.value)} placeholder="0.00" style={inputStyle} />
                  </div>
                  {hasFra && (
                    <div>
                      <label style={lblStyle}>Amount Paid (FRA)</label>
                      <input type="number" min="0" step="1" value={amountPaidFRA}
                        onChange={e => setAmountPaidFRA(e.target.value)} placeholder="0" style={inputStyle} />
                    </div>
                  )}
                  {hasK && (
                    <div>
                      <label style={lblStyle}>Amount Paid (K)</label>
                      <input type="number" min="0" step="1" value={amountPaidK}
                        onChange={e => setAmountPaidK(e.target.value)} placeholder="0" style={inputStyle} />
                    </div>
                  )}
                </div>

                {calc && (calc.paidUSD > 0 || calc.paidFRA > 0 || calc.paidK > 0) && (
                  <div style={{ marginTop: 12 }}>
                    {calc.isOverpaid ? (() => {
                      // v1.8.74 — practical-handback rule (Option B):
                      //   Source currency of the over-payment → NATIVE (1:1, no FX)
                      //   All OTHER currencies → BUY rate (real currency exchange)
                      // So when overpaid in FRA, the FRA row shows the exact FRA the
                      // customer overpaid (no spread loss), and the USD/K rows show
                      // what the cashier would actually count out if converting.
                      const usdNative = calc.overUSD || 0;
                      const fraNative = calc.overFRA || 0;
                      const kNative   = calc.overK   || 0;
                      // Headline (USD): source-currency native if all over-payment is
                      // in USD; otherwise sum of non-USD over at BUY rate.
                      const headlineUSD = usdNative
                                        + (BUY_RATE   > 0 ? fraNative / BUY_RATE   : 0)
                                        + (BUY_RATE_K > 0 ? kNative   / BUY_RATE_K : 0);
                      // Sub-line FRA: native if FRA overpaid, else headline × BUY_RATE.
                      const fraEquiv = fraNative > 0.5
                        ? fraNative
                        : (BUY_RATE > 0 ? headlineUSD * BUY_RATE : 0);
                      // Sub-line K: native if K overpaid, else headline × BUY_RATE_K.
                      const kEquiv = kNative > 0.5
                        ? kNative
                        : (BUY_RATE_K > 0 ? headlineUSD * BUY_RATE_K : 0);
                      // Rate label per sub-line: "native" if that currency is the
                      // source, else "buy" to make the conversion explicit.
                      const fraLabel = fraNative > 0.5 ? 'native' : `buy ${BUY_RATE.toLocaleString()}`;
                      const kLabel   = kNative   > 0.5 ? 'native' : `buy ${BUY_RATE_K.toLocaleString()}`;
                      return (
                        <div style={{ background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: 8, padding: '10px 12px' }}>
                          <div style={{ fontSize: 11, color: '#047857', fontWeight: 600 }}>Change</div>
                          <div style={{ fontSize: 20, fontWeight: 800, color: '#065f46' }}>{fmtUSD(headlineUSD)}</div>
                          {hasFra && (
                            <div style={{ fontSize: 12, color: '#047857', fontWeight: 600, marginTop: 4 }}>
                              ≈ FRA {fmtFRA(fraEquiv)} ({fraLabel})
                              {hasK && <> · ≈ K {fmtK(kEquiv)} ({kLabel})</>}
                            </div>
                          )}
                        </div>
                      );
                    })() : (
                      <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px' }}>
                        <div style={{ fontSize: 11, color: '#b91c1c', fontWeight: 600 }}>Unpaid Balance</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: '#991b1b' }}>{fmtUSD(calc.unpaidBalance)}</div>
                        {hasFra && (
                          <div style={{ fontSize: 12, color: '#b91c1c', fontWeight: 600, marginTop: 4 }}>
                            ≈ FRA {fmtFRA(calc.unpaidBalanceFRA)} (sell {SELL_RATE.toLocaleString()})
                            {hasK && <> · ≈ K {fmtK(calc.unpaidBalanceK)} (sell {SELL_RATE_K.toLocaleString()})</>}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {calc?.isOverpaid && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 6 }}>Change Given</div>
                    <div style={{ display: 'grid', gridTemplateColumns: hasK ? '1fr 1fr 1fr' : (hasFra ? '1fr 1fr' : '1fr'), gap: 10 }}>
                      <div>
                        <label style={lblStyle}>Given ($)</label>
                        <input type="number" min="0" step="0.01" value={changeGivenUSD}
                          onChange={e => setChangeGivenUSD(e.target.value)}
                          placeholder="0.00" style={inputStyle} />
                      </div>
                      {hasFra && (
                      <div>
                        <label style={lblStyle}>Given (FRA)</label>
                        <input type="number" min="0" step="1" value={changeGivenFRA}
                          onChange={e => setChangeGivenFRA(e.target.value)}
                          placeholder="0" style={inputStyle} />
                      </div>
                      )}
                      {hasK && (
                      <div>
                        <label style={lblStyle}>Given (K)</label>
                        <input type="number" min="0" step="1" value={changeGivenK}
                          onChange={e => setChangeGivenK(e.target.value)}
                          placeholder="0" style={inputStyle} />
                      </div>
                      )}
                    </div>
                    {/* v1.8.68 — when cashier overpaid and is keeping some change, ask which drawer.
                        v1.8.78 — always default to FRA (most common at Kelete). User can
                        still click USD or K to override. Falls back if branch has no FRA. */}
                    {calc.netRemaining > 0.005 && (() => {
                      const defaultCcy = keptCcy
                        || (hasFra ? 'FRA' : hasK ? 'K' : 'USD');
                      // v1.8.80 — headline amount follows the picker selection
                      // so cashier sees the exact amount in the drawer's currency.
                      // USD stays as a secondary "≈" reference.
                      let headlineText;
                      if (defaultCcy === 'FRA') {
                        const fraAmt = calc.overFRA > 0.5
                          ? calc.overFRA
                          : (BUY_RATE > 0 ? calc.netRemaining * BUY_RATE : 0);
                        headlineText = `FRA ${fmtFRA(fraAmt)} (≈ ${fmtUSD(calc.netRemaining)})`;
                      } else if (defaultCcy === 'K') {
                        const kAmt = calc.overK > 0.5
                          ? calc.overK
                          : (BUY_RATE_K > 0 ? calc.netRemaining * BUY_RATE_K : 0);
                        headlineText = `K ${fmtK(kAmt)} (≈ ${fmtUSD(calc.netRemaining)})`;
                      } else {
                        const usdAmt = calc.overUSD > 0.001 ? calc.overUSD : calc.netRemaining;
                        headlineText = fmtUSD(usdAmt);
                      }
                      return (
                        <div style={{ marginTop: 10, padding: '10px 12px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8 }}>
                          <div style={{ fontSize: 11, color: '#92400e', fontWeight: 600, marginBottom: 6 }}>
                            Customer over-paid by {headlineText} — kept in drawer:
                          </div>
                          <div style={{ display: 'flex', gap: 8 }}>
                            {['USD', 'FRA', 'K'].map(c => {
                              const active = defaultCcy === c;
                              return (
                                <button key={c} type="button" onClick={() => setKeptCcy(c)}
                                  style={{
                                    flex: 1, padding: '8px 10px', borderRadius: 6,
                                    border: active ? '2px solid #d97706' : '1px solid #fcd34d',
                                    background: active ? '#fef3c7' : '#fff',
                                    color: '#78350f', fontWeight: 700, fontSize: 12, cursor: 'pointer',
                                  }}>
                                  {c}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                    {(calc.givenUSD > 0 || calc.givenFRA > 0 || calc.givenK > 0) && (() => {
                      const exact     = Math.abs(calc.netRemaining) < 0.01;
                      const overpaid  = calc.netRemaining < -0.01;
                      // v1.8.78 — the picker (above) already conveys "kept in [ccy] drawer"
                      // when netRemaining > 0. So skip this redundant "Still owed" red box
                      // for that case — only show for exact / overpaid-back outcomes.
                      if (!exact && !overpaid) return null;
                      const bg        = exact ? '#ecfdf5' : '#fef2f2';
                      const border    = exact ? '#a7f3d0' : '#fecaca';
                      const labelClr  = exact ? '#047857' : '#b91c1c';
                      const amtClr    = '#991b1b';
                      const label     = exact ? 'Exact change given' : 'Overpaid to customer';
                      const absAmt    = Math.abs(calc.netRemaining);
                      const absAmtFra = Math.abs(calc.netRemainingFRA);
                      const absAmtK   = Math.abs(calc.netRemainingK);
                      return (
                        <div style={{ marginTop: 10, padding: '10px 12px', background: bg, border: `1px solid ${border}`, borderRadius: 8 }}>
                          <div style={{ fontSize: 11, color: labelClr, fontWeight: 600 }}>{label}</div>
                          {!exact && (
                            <div style={{ fontSize: 16, fontWeight: 800, color: amtClr }}>
                              {fmtUSD(absAmt)}{' '}
                              {hasFra && <span style={{ fontSize: 11, fontWeight: 600 }}>(FRA {fmtFRA(absAmtFra)}{hasK && <> · K {fmtK(absAmtK)}</>})</span>}
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* v1.8.97 — over-change warning banner. Fires before the
                    button is disabled so cashier sees WHY they can't save. */}
                {isOverChange && (
                  <div style={{ marginTop: 12, padding: '10px 12px', background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', fontSize: 12, fontWeight: 600 }}>
                    ⚠ Change returned ({fmtUSD(calc.totalChangeGiven)}) exceeds change owed ({fmtUSD(calc.changeUSD)}) by {fmtUSD(overChangeUSD)} —
                    that's shop loss. Adjust the change-given amounts before saving.
                  </div>
                )}

                {/* v1.8.97 — in Edit mode, add Reason field + Save/Cancel. */}
                {editing && (
                  <div style={{ marginTop: 14 }}>
                    <label style={{ ...lblStyle, color: '#374151' }}>
                      Reason <span style={{ color: '#dc2626' }}>*</span>{' '}
                      <span style={{ fontWeight: 400, color: '#9ca3af' }}>(min 3 chars)</span>
                    </label>
                    <input type="text" value={editReason}
                      placeholder="e.g. typo, wrong currency, wrong rate"
                      onChange={e => setEditReason(e.target.value)}
                      style={inputStyle} maxLength={200} />
                  </div>
                )}

                {editing ? (
                  <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                    <button onClick={cancelEdit} disabled={editSaving}
                      style={{ flex: 1, padding: '12px', background: '#fff', border: '1px solid #e5e7eb', color: '#374151', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                      Cancel
                    </button>
                    <button onClick={saveEdit}
                      disabled={editSaving || editReason.trim().length < 3 || isOverChange}
                      style={{
                        flex: 2, padding: '12px',
                        background: (editSaving || editReason.trim().length < 3 || isOverChange) ? '#cbd5e1' : 'linear-gradient(135deg,#f59e0b,#d97706)',
                        border: 'none', color: '#fff', borderRadius: 8, fontSize: 14, fontWeight: 700,
                        cursor: editSaving ? 'wait' : 'pointer',
                      }}>
                      {editSaving ? 'Saving…' : 'Save Edit'}
                    </button>
                  </div>
                ) : (
                  <button onClick={handleConfirm}
                    disabled={!canConfirm || submitting}
                    style={{
                      marginTop: 18, width: '100%', padding: '14px',
                      background: canConfirm ? 'linear-gradient(135deg,#16a34a,#15803d)' : '#cbd5e1',
                      color: '#fff', border: 'none', borderRadius: 8,
                      fontSize: 15, fontWeight: 700, cursor: canConfirm ? 'pointer' : 'not-allowed',
                    }}>
                    Confirm Payment →
                  </button>
                )}
              </div>
              ) : (
              // ─────── HISTORY MODE: read-only payment panel ───────
              // Pulls stored values straight off the order row (no recompute);
              // adds a Reconciliation box that shows the change owed / returned
              // / ± kept in drawer math behind the Sales Report ± column.
              <div>
                <h3 style={{ margin: '0 0 10px 0', fontSize: 16, color: '#0f172a', display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    Payment
                    <span style={{ fontSize: 10, background: editing ? '#fef3c7' : '#e5e7eb', color: editing ? '#92400e' : '#64748b', padding: '2px 8px', borderRadius: 4, fontWeight: 700, letterSpacing: 0.5 }}>
                      {editing ? 'EDITING' : 'READ-ONLY'}
                    </span>
                  </span>
                  {/* v1.8.87 — Edit Payment button (admin only, within 7-day window) */}
                  {canEdit && !editing && (
                    <button onClick={startEdit}
                      style={{ padding: '4px 12px', background: '#fff', border: '1px solid #f59e0b', color: '#b45309', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>
                      ✎ Edit Payment
                    </button>
                  )}
                </h3>

                {/* Total Due — never editable (would require recomputing items) */}
                <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '12px 14px', marginBottom: 14 }}>
                  <div style={{ fontSize: 11, color: '#0369a1', fontWeight: 600 }}>Total Due</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: '#0c4a6e', lineHeight: 1.1 }}>{fmtUSD(selected.total_amount)}</div>
                </div>

                {/* FX Rate — editable when editing.
                    v1.10.108 — box now ALWAYS renders in Payment History so
                    cashier/audit can see exactly what rate was stamped on the
                    order at save time (including zeros). Previously it was
                    hidden when both FRA rates were 0, which made zero-rate
                    orders indistinguishable from tri-currency ones. */}
                {(
                  <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: 10, marginBottom: 10 }}>
                    <div style={{ fontSize: 11, color: '#92400e', fontWeight: 700, marginBottom: 6 }}>
                      FX Rate {editing ? '(editing)' : '(locked — stored on this order)'}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12, color: '#78350f' }}>
                      {editing ? (
                        <>
                          <div><label style={{ ...lblStyle, color: '#92400e' }}>Sell FRA</label>
                            <input type="number" min="0" step="0.01" value={editForm.selling_rate_used}
                              onChange={e => setEditForm({ ...editForm, selling_rate_used: e.target.value })}
                              style={inputStyle} /></div>
                          <div><label style={{ ...lblStyle, color: '#92400e' }}>Buy FRA</label>
                            <input type="number" min="0" step="0.01" value={editForm.buying_rate_used}
                              onChange={e => setEditForm({ ...editForm, buying_rate_used: e.target.value })}
                              style={inputStyle} /></div>
                          {hasK && (
                            <>
                              <div><label style={{ ...lblStyle, color: '#92400e' }}>Sell K</label>
                                <input type="number" min="0" step="0.01" value={editForm.selling_rate_k_used}
                                  onChange={e => setEditForm({ ...editForm, selling_rate_k_used: e.target.value })}
                                  style={inputStyle} /></div>
                              <div><label style={{ ...lblStyle, color: '#92400e' }}>Buy K</label>
                                <input type="number" min="0" step="0.01" value={editForm.buying_rate_k_used}
                                  onChange={e => setEditForm({ ...editForm, buying_rate_k_used: e.target.value })}
                                  style={inputStyle} /></div>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <div>Sell FRA: <strong>{(parseFloat(selected.selling_rate_used) || 0).toLocaleString()}</strong></div>
                          <div>Buy FRA: <strong>{(parseFloat(selected.buying_rate_used) || 0).toLocaleString()}</strong></div>
                          <div>Sell K: <strong>{(parseFloat(selected.selling_rate_k_used) || 0).toLocaleString()}</strong></div>
                          <div>Buy K: <strong>{(parseFloat(selected.buying_rate_k_used)  || 0).toLocaleString()}</strong></div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* Amount Paid — editable when editing */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Amount Paid</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    {editing ? (
                      <>
                        <div><label style={roLbl}>USD</label>
                          <input type="number" min="0" step="0.01" value={editForm.cash_received}
                            onChange={e => setEditForm({ ...editForm, cash_received: e.target.value })}
                            style={inputStyle} /></div>
                        <div><label style={roLbl}>FRA</label>
                          <input type="number" min="0" step="1" value={editForm.fra_received}
                            onChange={e => setEditForm({ ...editForm, fra_received: e.target.value })}
                            style={inputStyle} /></div>
                        <div><label style={roLbl}>K</label>
                          <input type="number" min="0" step="1" value={editForm.k_received}
                            onChange={e => setEditForm({ ...editForm, k_received: e.target.value })}
                            style={inputStyle} /></div>
                      </>
                    ) : (
                      <>
                        <div style={roBox}><span style={roLbl}>USD</span><strong>{fmtUSD(selected.cash_received)}</strong></div>
                        <div style={roBox}><span style={roLbl}>FRA</span><strong>{fmtFRA(selected.fra_received)}</strong></div>
                        <div style={roBox}><span style={roLbl}>K</span><strong>{fmtK(selected.k_received)}</strong></div>
                      </>
                    )}
                  </div>
                </div>

                {/* Change Returned — editable when editing */}
                <div style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Change Returned</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    {editing ? (
                      <>
                        <div><label style={roLbl}>USD</label>
                          <input type="number" min="0" step="0.01" value={editForm.usd_change_given}
                            onChange={e => setEditForm({ ...editForm, usd_change_given: e.target.value })}
                            style={inputStyle} /></div>
                        <div><label style={roLbl}>FRA</label>
                          <input type="number" min="0" step="1" value={editForm.fra_change_given}
                            onChange={e => setEditForm({ ...editForm, fra_change_given: e.target.value })}
                            style={inputStyle} /></div>
                        <div><label style={roLbl}>K</label>
                          <input type="number" min="0" step="1" value={editForm.k_change_given}
                            onChange={e => setEditForm({ ...editForm, k_change_given: e.target.value })}
                            style={inputStyle} /></div>
                      </>
                    ) : (
                      <>
                        <div style={roBox}><span style={roLbl}>USD</span><strong>{fmtUSD(selected.usd_change_given)}</strong></div>
                        <div style={roBox}><span style={roLbl}>FRA</span><strong>{fmtFRA(selected.fra_change_given)}</strong></div>
                        <div style={roBox}><span style={roLbl}>K</span><strong>{fmtK(selected.k_change_given)}</strong></div>
                      </>
                    )}
                  </div>
                </div>

                {/* Reconciliation box — uses editForm when editing so user sees the math live */}
                {(() => {
                  const src = editing ? editForm : selected;
                  const totalDue = parseFloat(selected.total_amount) || 0;
                  const paidUSD  = parseFloat(src.cash_received) || 0;
                  const paidFRA  = parseFloat(src.fra_received)  || 0;
                  const paidK    = parseFloat(src.k_received)    || 0;
                  const sellFRA  = parseFloat(src.selling_rate_used)   || 0;
                  const sellK    = parseFloat(src.selling_rate_k_used) || 0;
                  const buyFRA   = parseFloat(src.buying_rate_used)    || 0;
                  const buyK     = parseFloat(src.buying_rate_k_used)  || 0;
                  const totalPaidUSDeq = paidUSD + (sellFRA > 0 ? paidFRA / sellFRA : 0) + (sellK > 0 ? paidK / sellK : 0);
                  const changeOwed = Math.max(0, totalPaidUSDeq - totalDue);
                  const givenUSD = parseFloat(src.usd_change_given) || 0;
                  const givenFRA = parseFloat(src.fra_change_given) || 0;
                  const givenK   = parseFloat(src.k_change_given)   || 0;
                  const totalGivenUSDeq = givenUSD + (buyFRA > 0 ? givenFRA / buyFRA : 0) + (buyK > 0 ? givenK / buyK : 0);
                  const keptCcy = (src.overpaid_kept_ccy || '').toUpperCase();
                  const keptAmt = parseFloat(src.overpaid_kept_amt) || 0;
                  const keptDisplay = keptCcy === 'USD' ? fmtUSD(keptAmt)
                                    : keptCcy === 'FRA' ? `${fmtFRA(keptAmt)} FRA`
                                    : keptCcy === 'K'   ? `${fmtK(keptAmt)} K`
                                    : '—';
                  // v1.8.88 — absorbed shortage: when totalPaidUSDeq < totalDue
                  // (walk-in handed over slightly less than owed, shop ate the gap).
                  // Mutually exclusive with "Kept in drawer" — a payment is either
                  // over OR under, never both. Threshold 0.005 ignores FP dust.
                  // v1.8.89 — source-currency attribution (K → FRA → USD priority)
                  // so the displayed loss lives in the same drawer the cashier
                  // can physically count. Matches the Cash Report aggregate +
                  // Sales Report ± column. Mirror image of the "+keptDisplay"
                  // logic above (kept uses overpaid_kept_ccy stored on order).
                  const shortageUSD = Math.max(0, totalDue - totalPaidUSDeq);
                  let absorbedDisplay = '';
                  if (shortageUSD > 0.005) {
                    if (paidK > 0 && sellK > 0) {
                      absorbedDisplay = `${fmtK(shortageUSD * sellK)} K`;
                    } else if (paidFRA > 0 && sellFRA > 0) {
                      absorbedDisplay = `${fmtFRA(shortageUSD * sellFRA)} FRA`;
                    } else {
                      absorbedDisplay = fmtUSD(shortageUSD);
                    }
                  }
                  return (
                    <div style={{ background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                      <div style={{ fontSize: 11, color: '#475569', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>Reconciliation {editing ? '(live preview)' : ''}</div>
                      <div style={{ fontSize: 12, color: '#475569', display: 'grid', rowGap: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Total paid (USD-equiv)</span><strong>{fmtUSD(totalPaidUSDeq)}</strong></div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Change owed</span><strong>{fmtUSD(changeOwed)}</strong></div>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Change returned (USD-eq)</span><strong>{fmtUSD(totalGivenUSDeq)}</strong></div>
                        {keptAmt > 0 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #e5e7eb', paddingTop: 4, marginTop: 2 }}>
                            <span style={{ fontWeight: 700, color: '#16a34a' }}>± Kept in drawer</span>
                            <strong style={{ color: '#16a34a' }}>+{keptDisplay}</strong>
                          </div>
                        )}
                        {keptAmt < 0.005 && shortageUSD > 0.005 && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px dashed #e5e7eb', paddingTop: 4, marginTop: 2 }}>
                            <span style={{ fontWeight: 700, color: '#dc2626' }}>± Absorbed (shortage)</span>
                            <strong style={{ color: '#dc2626' }}>−{absorbedDisplay}</strong>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Editing: Reason field + Save / Cancel — replaces the Paid badge */}
                {editing ? (
                  <div style={{ marginTop: 18 }}>
                    <label style={{ ...lblStyle, color: '#374151' }}>Reason <span style={{ color: '#dc2626' }}>*</span> <span style={{ fontWeight: 400, color: '#9ca3af' }}>(min 3 chars)</span></label>
                    <input type="text" value={editReason}
                      placeholder="e.g. typo, wrong currency, wrong rate"
                      onChange={e => setEditReason(e.target.value)}
                      style={inputStyle} maxLength={200} />
                    <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
                      <button onClick={cancelEdit} disabled={editSaving}
                        style={{ flex: 1, padding: '12px', background: '#fff', border: '1px solid #e5e7eb', color: '#374151', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                        Cancel
                      </button>
                      {/* v1.10.94 — was missing isOverChange guard, so the
                          Payment History "Edit Payment" flow let cashiers save
                          change-given amounts whose USD-eq exceeded change owed
                          by more than $0.10 (real incident on ORD-BDF6A1-0107:
                          $40 paid on $36 due → $4 change owed → cashier saved
                          $4 USD + FRA 9,000 = $8 total, an unrecoverable $4
                          overpayment). Same guard the Pending-payment Save Edit
                          button uses at line 968. */}
                      <button onClick={saveEdit} disabled={editSaving || editReason.trim().length < 3 || isOverChange}
                        style={{ flex: 2, padding: '12px', background: (editSaving || editReason.trim().length < 3 || isOverChange) ? '#cbd5e1' : 'linear-gradient(135deg,#f59e0b,#d97706)', border: 'none', color: '#fff', borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: editSaving ? 'wait' : 'pointer' }}
                        title={isOverChange ? 'Change returned exceeds change owed — reduce the given amounts first.' : ''}>
                        {editSaving ? 'Saving…' : 'Save Changes'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{
                    marginTop: 18, width: '100%', padding: '14px',
                    background: '#dcfce7', border: '1px solid #86efac',
                    color: '#15803d', borderRadius: 8,
                    fontSize: 14, fontWeight: 700, textAlign: 'center',
                  }}>
                    ✓ Paid · Confirmed
                    {selected.paid_at && (
                      <div style={{ fontSize: 11, fontWeight: 500, marginTop: 4 }}>
                        {new Date(selected.paid_at).toLocaleString()}
                        {selected.cashier_name ? ` · by ${selected.cashier_name}` : ''}
                      </div>
                    )}
                    {!canEdit && isAdmin && !!selected.paid_at && (
                      <div style={{ fontSize: 10, fontWeight: 500, marginTop: 6, color: '#64748b' }}>
                        Outside 7-day edit window
                      </div>
                    )}
                  </div>
                )}
              </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* v1.8.87 — CR refresh warning after a payment edit on a day whose
          Sales CR was already saved. We don't auto-fix the CR — instead we
          nudge the user to re-open Cash Report and Save again so the CR
          picks up the corrected amounts. */}
      {crWarning && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 250, padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: 'min(480px, 95vw)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }}>
            <div style={{ background: 'linear-gradient(135deg, #b45309, #92400e)', padding: '16px 22px', color: '#fff' }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>⚠ Cash Report needs re-saving</div>
              <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>Payment edited successfully — but the day's CR holds the OLD amounts.</div>
            </div>
            <div style={{ padding: '20px 22px' }}>
              <p style={{ margin: '0 0 12px 0', fontSize: 13.5, color: '#374151', lineHeight: 1.55 }}>
                A Cash Receipt was already saved for <strong>{crWarning.cr_date}</strong>
                {crWarning.cr_cashier_name ? <> (cashier <strong>{crWarning.cr_cashier_name}</strong>)</> : null}.
                It still shows the old totals.
              </p>
              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 14px', fontSize: 12.5, color: '#78350f', lineHeight: 1.55 }}>
                <strong>To fix it:</strong>
                <ol style={{ margin: '6px 0 0 18px', padding: 0 }}>
                  <li>Open <strong>Cash Report</strong></li>
                  <li>Pick date <strong>{crWarning.cr_date}</strong> {crWarning.cr_cashier_name ? <>and cashier <strong>{crWarning.cr_cashier_name}</strong></> : null}</li>
                  <li>Click <strong>Edit</strong>, then <strong>Save Report</strong></li>
                  <li>Confirm the CR update when prompted</li>
                </ol>
              </div>
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setCRWarning(null)}
                style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: '#b45309', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                OK, got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm modal */}
      {confirm && selected && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: 'min(440px, 92vw)', padding: 22 }}>
            <h3 style={{ margin: '0 0 14px 0' }}>Confirm Payment</h3>
            <div style={confirmRow}><span>Order</span><strong>{fmtInvoiceNo(selected.order_number)}</strong></div>
            <div style={confirmRow}><span>Customer</span><strong>{selected.customer_name || 'Walk-in'}</strong></div>
            <hr style={hrStyle} />
            <div style={confirmRow}><span>Total Due</span><strong>{fmtUSD(confirm.totalDue)}</strong></div>
            <div style={confirmRow}><span>Paid ($)</span><strong>{fmtUSD(confirm.paidUSD)}</strong></div>
            {confirm.paidFRA > 0 && (
              <div style={confirmRow}><span>Paid (FRA)</span><strong>FRA {fmtFRA(confirm.paidFRA)} <span style={{ color: '#64748b', fontWeight: 500 }}>(={fmtUSD(confirm.paidFRAasUSD)})</span></strong></div>
            )}
            <div style={{ ...confirmRow, fontWeight: 700 }}><span>Total Paid</span><strong>{fmtUSD(confirm.totalAmountPaid)}</strong></div>
            <hr style={hrStyle} />
            {confirm.isOverpaid ? (
              <>
                {/* v1.8.74 — Option B: source currency native, others at BUY rate.
                    Matches the Change card on the Pay panel. */}
                {(() => {
                  const usdNative = confirm.overUSD || 0;
                  const fraNative = confirm.overFRA || 0;
                  const kNative   = confirm.overK   || 0;
                  const headlineUSD = usdNative
                                    + (BUY_RATE   > 0 ? fraNative / BUY_RATE   : 0)
                                    + (BUY_RATE_K > 0 ? kNative   / BUY_RATE_K : 0);
                  const fraEquiv = fraNative > 0.5 ? fraNative : (BUY_RATE > 0 ? headlineUSD * BUY_RATE : 0);
                  return (
                    <div style={confirmRow}>
                      <span>Change</span>
                      <strong>{fmtUSD(headlineUSD)} <span style={{ color: '#64748b', fontWeight: 500 }}>(FRA {fmtFRA(fraEquiv)})</span></strong>
                    </div>
                  );
                })()}
                {(confirm.givenUSD > 0 || confirm.givenFRA > 0) && (
                  <>
                    {confirm.givenUSD > 0 && <div style={confirmRow}><span>Change Given ($)</span><strong>{fmtUSD(confirm.givenUSD)}</strong></div>}
                    {confirm.givenFRA > 0 && <div style={confirmRow}><span>Change Given (FRA)</span><strong>FRA {fmtFRA(confirm.givenFRA)}</strong></div>}
                  </>
                )}
                {(() => {
                  const exact    = Math.abs(confirm.netRemaining) < 0.01;
                  const overpaid = confirm.netRemaining < -0.01;
                  // v1.8.72 — when picker is set, netRemaining > 0 means the over-payment
                  // is being KEPT in the chosen drawer, not "still owed". Show the chosen
                  // currency + the amount in that currency.
                  // v1.8.74 — use the EFFECTIVE picker selection (clicked OR default-
                  // highlighted) so the label is correct even when cashier accepts the
                  // default without clicking the button.
                  // v1.8.78 — default to FRA (most common at Kelete) when no explicit pick.
                  const effectiveCcy = keptCcy
                    || (hasFra ? 'FRA' : hasK ? 'K' : 'USD');
                  const kept     = !exact && !overpaid && !!effectiveCcy;
                  const bg       = exact ? '#ecfdf5' : overpaid ? '#fef2f2' : kept ? '#fffbeb' : '#fef3c7';
                  const label    = exact ? 'Exact Change'
                                   : overpaid ? 'Overpaid customer'
                                   : kept ? `Kept in ${effectiveCcy} drawer`
                                   : 'Still owed';
                  const colour   = overpaid ? '#991b1b' : kept ? '#92400e' : undefined;
                  let amountText;
                  if (exact) amountText = fmtUSD(0);
                  else if (kept) {
                    // v1.8.79 — display matches the payload: native source-currency
                    // over-payment when present; otherwise convert USD-leftover at
                    // BUY rate (matches the "Change ≈ FRA X" headline rate so the
                    // subtraction is clean: 148,200 owed − 148,000 given = 200).
                    if (effectiveCcy === 'USD') {
                      amountText = fmtUSD(confirm.overUSD || confirm.netRemaining);
                    } else if (effectiveCcy === 'FRA') {
                      const fraAmt = confirm.overFRA > 0.5
                        ? confirm.overFRA
                        : (BUY_RATE > 0 ? confirm.netRemaining * BUY_RATE : 0);
                      amountText = `FRA ${fmtFRA(fraAmt)}`;
                    } else if (effectiveCcy === 'K') {
                      const kAmt = confirm.overK > 0.5
                        ? confirm.overK
                        : (BUY_RATE_K > 0 ? confirm.netRemaining * BUY_RATE_K : 0);
                      amountText = `K ${fmtK(kAmt)}`;
                    } else amountText = fmtUSD(confirm.netRemaining);
                  } else if (overpaid) {
                    // v1.8.81 — cashier over-changed (shop loss). Show the overshoot in
                    // its SOURCE currency: detect which currency was returned in excess
                    // (USD-first → FRA → K consumption). Native amount as headline,
                    // USD-equivalent as reference (matches the picker-header pattern).
                    const changeOwedUSD = parseFloat(confirm.changeUSD || 0);
                    const usdGiven = parseFloat(confirm.givenUSD || 0);
                    const fraGiven = parseFloat(confirm.givenFRA || 0);
                    const kGiven   = parseFloat(confirm.givenK   || 0);
                    const usdOverAbs = Math.abs(confirm.netRemaining);
                    let rem = changeOwedUSD;
                    const usdConsumed = Math.min(usdGiven, rem); rem -= usdConsumed;
                    let fraOver = 0;
                    if (BUY_RATE > 0 && fraGiven > 0) {
                      const fraOwedFRA = rem > 0 ? rem * BUY_RATE : 0;
                      fraOver = Math.max(0, fraGiven - fraOwedFRA);
                      rem -= Math.min(fraGiven / BUY_RATE, rem);
                    }
                    let kOver = 0;
                    if (BUY_RATE_K > 0 && kGiven > 0) {
                      const kOwedK = rem > 0 ? rem * BUY_RATE_K : 0;
                      kOver = Math.max(0, kGiven - kOwedK);
                    }
                    const usdOver = Math.max(0, usdGiven - usdConsumed);
                    const fraOverAsUSD = BUY_RATE   > 0 ? fraOver / BUY_RATE   : 0;
                    const kOverAsUSD   = BUY_RATE_K > 0 ? kOver   / BUY_RATE_K : 0;
                    if (fraOverAsUSD >= kOverAsUSD && fraOverAsUSD >= usdOver && fraOver > 0.5) {
                      amountText = `FRA ${fmtFRA(fraOver)} (≈ ${fmtUSD(usdOverAbs)})`;
                    } else if (kOverAsUSD >= usdOver && kOver > 0.5) {
                      amountText = `K ${fmtK(kOver)} (≈ ${fmtUSD(usdOverAbs)})`;
                    } else {
                      amountText = fmtUSD(usdOverAbs);
                    }
                  } else amountText = fmtUSD(Math.abs(confirm.netRemaining));
                  return (
                    <div style={{ ...confirmRow, marginTop: 8, padding: '10px 12px', background: bg, borderRadius: 8, flexDirection: 'column', alignItems: 'stretch' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <span style={{ fontWeight: 700, color: colour }}>{label}</span>
                        <strong style={{ color: colour }}>{amountText}</strong>
                      </div>
                      {overpaid && (
                        <div style={{ fontSize: 10, color: '#991b1b', marginTop: 4, opacity: 0.8 }}>
                          Shop loss — recorded in Under-Payments
                        </div>
                      )}
                    </div>
                  );
                })()}
              </>
            ) : (() => {
              // v1.8.82 — distinguish three under-paid scenarios:
              //   • Within $0.10 tolerance walk-in → silently absorbed (shop loss)
              //   • Registered customer with shortfall > tolerance → becomes credit
              //   • Walk-in with shortfall > tolerance → blocked by backend anyway
              // For absorbed-tolerance case, label as a shop loss (matches the
              // Under-Payments line in Cash Report) instead of the confusing
              // "Unpaid Balance" red box that implied the customer still owes.
              const absorbed = !hasRegisteredCustomer && confirm.unpaidBalance <= 0.10;
              if (absorbed) {
                return (
                  <div style={{ ...confirmRow, padding: '10px 12px', background: '#fef2f2', borderRadius: 8, flexDirection: 'column', alignItems: 'stretch' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 700, color: '#b91c1c' }}>Shortage (within tolerance)</span>
                      <strong style={{ color: '#991b1b' }}>−{fmtUSD(confirm.unpaidBalance)}</strong>
                    </div>
                    <div style={{ fontSize: 10, color: '#991b1b', marginTop: 4, opacity: 0.8 }}>
                      Shop loss — recorded in Under-Payments
                    </div>
                  </div>
                );
              }
              return (
                <div style={{ ...confirmRow, padding: '10px 12px', background: '#fef2f2', borderRadius: 8 }}>
                  <span style={{ fontWeight: 700, color: '#b91c1c' }}>Unpaid Balance</span>
                  <strong style={{ color: '#991b1b' }}>−{fmtUSD(confirm.unpaidBalance)}</strong>
                </div>
              );
            })()}
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              <button onClick={() => setConfirm(null)}
                style={{ flex: 1, padding: '12px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
                Cancel
              </button>
              <button onClick={processPayment}
                disabled={submitting || (!hasRegisteredCustomer && !confirm.isOverpaid && confirm.unpaidBalance > 0.10)}
                style={{ flex: 1, padding: '12px',
                         background: submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                         color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                {submitting ? 'Processing…' : 'Yes, Process Payment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Dual-currency 80mm thermal receipt — built once on confirm + sent via
// printHtml (iframe + print dialog on Electron / desktop, PDF download on
// mobile, share-sheet on Capacitor APK). FRA rows only appear when the
// payment actually involved FRA cash or FRA change — keeps USD-only sales
// from showing useless "FRA: 0" lines.
function renderCashierReceipt({ biz, order, calc, cashierName, when, sellRate: _sell, buyRate: _buy, sellRateK: _sellK, buyRateK: _buyK, isLiquorStyle = false, curSym = '$' }) {
  const fmt = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtFra = (n) => Math.round(parseFloat(n || 0)).toLocaleString('en-US');
  const div = '='.repeat(42);
  const da  = '-'.repeat(42);
  // v1.10.59 — Liquor style shows per-item PRICE + TOTAL in the 2-line
  // format ESC/POS already prints; Kelete stays Name + Qty only per the
  // dual-currency redesign.
  const itemsRows = (order.items || []).map(it => {
    const qty = parseFloat(it.quantity || 0);
    const safeName = String(it.product_name).replace(/</g, '&lt;');
    const qtyStr = qty % 1 === 0 ? qty.toFixed(0) : qty.toFixed(2);
    if (isLiquorStyle) {
      const unitPx = parseFloat(it.unit_price || 0);
      const gross  = qty * unitPx;
      const lineDisc = parseFloat(it.discount || 0);
      const lineDiscTotal = qty * lineDisc;
      const discRow = lineDisc > 0
        ? `<tr><td colspan="4" style="padding-left:6px;font-size:10px;">discount ${qtyStr} x -${curSym}${fmt(lineDisc)}<span style="float:right;">-${curSym}${fmt(lineDiscTotal)}</span></td></tr>`
        : '';
      return `<tr><td colspan="4" style="font-weight:700;padding-top:2px;">${safeName}</td></tr>
        <tr>
          <td></td>
          <td style="text-align:right;white-space:nowrap;padding-left:8px;">${qtyStr} ${it.unit || ''}</td>
          <td style="text-align:right;white-space:nowrap;">${curSym}${fmt(unitPx)}</td>
          <td style="text-align:right;white-space:nowrap;">${curSym}${fmt(gross)}</td>
        </tr>${discRow}`;
    }
    return `<tr>
              <td>${safeName}</td>
              <td style="text-align:right; white-space:nowrap;">${qtyStr} ${it.unit || ''}</td>
            </tr>`;
  }).join('');
  const usedFra = (calc.paidFRA > 0.0001) || (calc.givenFRA > 0.0001);
  const usedK   = (calc.paidK   > 0.0001) || (calc.givenK   > 0.0001);
  const sellRate  = _sell;
  const buyRate   = _buy;
  const sellRateK = _sellK || 0;
  const buyRateK  = _buyK  || 0;
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  /* 2026-08-30 — 72mm, NOT 80mm. 80mm is the width of the PAPER; the print
     head only covers 72mm. The driver says so itself: its paper setting
     reads "ZPrinter Paper(80(72) x 3276mm)" — 80mm roll, 72mm printable.
     Declaring 80mm made Chrome lay the receipt out 8mm wider than the
     printer can reach, and the driver simply dropped the overhang. Every
     line lost the same three or four characters off the right: Walk-i(n),
     ZM(W), INV0060001067/9(0), 77.3(7). It read as a table problem, but the
     header and totals were clipped too — the canvas was just too wide.
     Matching the canvas to the print head means nothing can fall off. */
  @page { size: 72mm auto; margin: 0; }
  html, body { height: auto; margin: 0; padding: 0; overflow-x: hidden; }
  * { box-sizing: border-box; }
  /* 2026-09-01 — was padding: 2mm all round. The left edge printed off
     the paper: RED SEA came out as ED SEA, Cashier as ashier. The page
     is exactly 72mm (box-sizing is border-box above), so nothing is
     overflowing — the print head simply starts a couple of millimetres
     right of where the browser puts x=0. Moving the padding from the
     right side to the left shifts the content across without making
     the content area any narrower: 4 + 0 is the same 4mm as 2 + 2.
     If the left is STILL clipped, raise the 4mm. If the right now
     clips instead, lower it. */
  body { width: 72mm; max-width: 72mm; padding: 2mm 0 2mm 4mm; font-family: 'Courier New', Courier, monospace; font-size: 11px; color: #000; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  /* 2026-08-30 — see the note in the tax-invoice templates: width:100% on a
     table is only a suggestion under table-layout:auto, so an unbreakable
     value (an invoice number, a TPIN) stretches the table past the paper and
     carries every right-aligned figure off the edge with it. */
  /* 2026-08-30 — tables stop at 86% of the body. The remaining 14% is
     deliberately never printed on.
     Four earlier attempts tried to make the content FIT inside 100% —
     narrower page, narrower columns, smaller font, wrapping cells. But 100%
     is where the loss happens: a right-aligned value sits on the print
     head's last dot, and that dot is unreliable. It is why even 77.37 came
     out as 77.3 while the centred lines beside it printed in full.
     The reference receipt this was compared against does the same thing —
     its item table visibly stops well short of the edge. Leaving slack means
     an overflow eats into the margin instead of falling off the paper, and
     the Total column — the number that matters most and was always last in
     the row — is no longer the one closest to the cut. */
  table { width: 86%; max-width: 86%; }
  table tr > td:last-child { overflow-wrap: anywhere; word-break: break-word; }
  td { padding: 1px 0; vertical-align: top; }
  .c { text-align: center; }
  .divider { text-align: center; font-size: 10px; overflow: hidden; white-space: nowrap; margin: 3px 0; }
  .grand { font-size: 16px; font-weight: 800; }
  .amt { font-size: 13px; font-weight: 700; }
  .sub { color: #444; font-weight: 500; font-size: 10px; }
</style>
</head>
<body>
  <div class="c" style="font-size:14px;font-weight:700;letter-spacing:1px;">${biz.name || 'Kelete'}</div>
  ${biz.address ? `<div class="c" style="font-size:11px;">${String(biz.address).replace(/\n/g, '<br/>')}</div>` : ''}
  ${biz.phone ? `<div class="c" style="font-size:11px;">Tel: ${biz.phone}</div>` : ''}
  <div class="divider">${div}</div>
  <div class="c" style="font-weight:700;font-size:12px;">SALES RECEIPT</div>
  ${usedK ? `<div class="c" style="font-size:10px;">(USD + FRA + K payment)</div>` : usedFra ? `<div class="c" style="font-size:10px;">(USD + FRA payment)</div>` : ''}
  <div class="divider">${div}</div>
  <table>
    <tr><td>Receipt #:</td><td></td><td style="text-align:right;">${fmtInvoiceNo(order.order_number || '')}</td></tr>
    <tr><td>Date &amp; Time:</td><td></td><td style="text-align:right;">${when.toLocaleDateString('en-GB')} ${when.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false})}</td></tr>
    <tr><td>Customer:</td><td></td><td style="text-align:right;">${order.customer_name || 'Walk-in'}</td></tr>
    <tr><td>Cashier:</td><td></td><td style="text-align:right;">${cashierName}</td></tr>
  </table>
  <div class="divider">${div}</div>
  <table>
    ${isLiquorStyle ? '' : `<tr style="font-size:10px;">
      <td style="font-weight:700;">ITEM</td>
      <td style="text-align:right;font-weight:700;">QTY</td>
    </tr>`}
    ${itemsRows}
  </table>
  <div class="divider">${da}</div>
  <table>
    <tr><td>Subtotal</td><td></td><td></td><td style="text-align:right;">$${fmt(order.subtotal)}</td></tr>
    ${parseFloat(order.discount || 0) > 0 ? `<tr><td>Discount</td><td></td><td></td><td style="text-align:right;">-$${fmt(order.discount)}</td></tr>` : ''}
  </table>
  <div class="divider">${div}</div>
  <table>
    <tr class="grand"><td>TOTAL DUE</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.totalDue)}</td></tr>
  </table>
  <div class="divider">${div}</div>
  <table>
    <tr class="amt"><td>Cash Paid ($)</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.paidUSD)}</td></tr>
    ${calc.paidFRA > 0.0001 ? `
      <tr><td>Cash Paid (FRA)</td><td></td><td></td><td style="text-align:right;">FRA ${fmtFra(calc.paidFRA)}</td></tr>
      <tr><td class="sub">  at sell rate ${sellRate.toLocaleString()}</td><td></td><td></td><td style="text-align:right;" class="sub">≈ $${fmt(calc.paidFRAasUSD)}</td></tr>
    ` : ''}
    ${calc.paidK > 0.0001 ? `
      <tr><td>Cash Paid (K)</td><td></td><td></td><td style="text-align:right;">K ${fmtFra(calc.paidK)}</td></tr>
      <tr><td class="sub">  at sell rate ${sellRateK.toLocaleString()}</td><td></td><td></td><td style="text-align:right;" class="sub">≈ $${fmt(calc.paidKasUSD)}</td></tr>
    ` : ''}
    <tr class="amt"><td>Total Paid ($)</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.totalAmountPaid)}</td></tr>
  </table>
  ${calc.unpaidBalance > 0.10 ? `
    <div class="divider">${da}</div>
    <table>
      <tr class="grand" style="color:#000;"><td>BALANCE ON CREDIT</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.unpaidBalance)}</td></tr>
      ${usedFra ? `<tr><td class="sub">  ≈ at sell rate ${sellRate.toLocaleString()}</td><td></td><td></td><td style="text-align:right;" class="sub">FRA ${fmtFra(calc.unpaidBalanceFRA)}</td></tr>` : ''}
      ${usedK   ? `<tr><td class="sub">  ≈ at K sell rate ${sellRateK.toLocaleString()}</td><td></td><td></td><td style="text-align:right;" class="sub">K ${fmtFra(calc.unpaidBalanceK)}</td></tr>` : ''}
    </table>
  ` : ''}
  <div class="divider">${da}</div>
  ${calc.isOverpaid ? `
    <table>
      <tr class="amt"><td>*** CHANGE ***</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.changeUSD)}</td></tr>
      ${usedFra ? `<tr><td class="sub">  ≈ at buy rate ${buyRate.toLocaleString()}</td><td></td><td></td><td style="text-align:right;" class="sub">FRA ${fmtFra(calc.changeFRA)}</td></tr>` : ''}
      ${usedK   ? `<tr><td class="sub">  ≈ at K buy rate ${sellRateK ? buyRateK.toLocaleString() : '—'}</td><td></td><td></td><td style="text-align:right;" class="sub">K ${fmtFra(calc.changeK)}</td></tr>` : ''}
    </table>
    ${(calc.givenUSD > 0.0001 || calc.givenFRA > 0.0001 || calc.givenK > 0.0001) ? `
      <div class="divider">${da}</div>
      <table>
        ${calc.givenUSD > 0.0001 ? `<tr><td>Change Given ($)</td><td></td><td></td><td style="text-align:right;">$${fmt(calc.givenUSD)}</td></tr>` : ''}
        ${calc.givenFRA > 0.0001 ? `<tr><td>Change Given (FRA)</td><td></td><td></td><td style="text-align:right;">FRA ${fmtFra(calc.givenFRA)}</td></tr>` : ''}
        ${calc.givenK   > 0.0001 ? `<tr><td>Change Given (K)</td><td></td><td></td><td style="text-align:right;">K ${fmtFra(calc.givenK)}</td></tr>` : ''}
      </table>
    ` : ''}
  ` : ''}
  <div class="divider">${div}</div>
  <div class="c" style="margin-top:4px;">Thank you for your purchase!</div>
  <div class="c">Please come again.</div>
</body></html>`;
}

const thStyle = { padding: '8px 10px', fontSize: 11, color: '#64748b', fontWeight: 600, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const tdStyle = { padding: '8px 10px', color: '#0f172a' };
const totalsRow = { display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: '#475569' };
const lblStyle = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inputStyle = { width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' };
const confirmRow = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', color: '#0f172a', fontSize: 13 };
const hrStyle = { border: 'none', borderTop: '1px solid #e2e8f0', margin: '10px 0' };
// v1.8.86 — read-only payment cells in the History tab.
const roBox = { background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: '#0f172a', display: 'flex', flexDirection: 'column', gap: 2 };
const roLbl = { fontSize: 10, color: '#94a3b8', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 };
