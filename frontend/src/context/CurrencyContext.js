// Global currency provider. Loads the tenant's configured currencies from settings once,
// then exposes them via the useCurrency() hook so every page can render a price using the
// primary symbol without round-tripping to the server.
//
//   const { symbol, primary, currencies, money } = useCurrency();
//   money(12.5)  // â†’ "$12.50"  (uses primary symbol + 2 decimals)
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { getSettings } from '../services/api';

const DEFAULTS = [{ code: 'ZMW', symbol: 'K', is_primary: true }];

// 2026-09-11 â€” the payment methods a branch SHOWS (System Settings â†’ Payment
// methods shown). Hiding only: records keep their method and every total
// stays the same. Keys are 'cash' | 'momo' | 'bank'.
export const ALL_METHODS = ['cash', 'momo', 'bank'];
export const methodKeyOf = (m) => {
  const s = String(m || '').toLowerCase();
  if (ALL_METHODS.includes(s)) return s;
  if (s.includes('mobile') || s.includes('momo')) return 'momo';
  if (s.includes('bank')) return 'bank';
  if (s.includes('cash')) return 'cash';
  return null;
};
// Cash is always shown; only Mobile Money and Bank can be hidden.
const parseShownMethods = (raw) => {
  if (raw == null || raw === '') return ALL_METHODS;
  const keys = String(raw).toLowerCase().split(',').map(x => x.trim());
  return ALL_METHODS.filter(k => k === 'cash' || keys.includes(k));
};

const CurrencyContext = createContext({
  currencies: DEFAULTS,
  primary: DEFAULTS[0],
  symbol: 'K',
  money: (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  // Per-branch feature gates loaded from business_settings:
  //   workflowMode â€” 'single_pos' | 'three_station' (drives Cashier/Dispatch sidebar)
  //   currencyMode â€” 'K' | 'USD+FRA' (drives dual-currency UI)
  //   legacyProcurementEnabled â€” re-exposes GRN + Suppliers on branch sidebar
  //                              (off by default since v1.3.2 lockdown)
  workflowMode: 'single_pos',
  currencyMode: 'K',
  // v1.9.26 â€” third dial. 'cash_only' (Kelete multi-currency cash) vs
  // 'cash_momo_bank' (Liquor-style). Used to gate the Pay modal columns
  // and the Cash Report cashier panels.
  paymentMethods: 'cash_momo_bank',
  shownMethods: ALL_METHODS,
  methodShown: () => true,
  // 2026-09-11 â€” System Settings â†’ Auto deposit (Cash Report â†’ HQ deposits).
  autoDeposit: false,
  legacyProcurementEnabled: false,
  refresh: () => {},
});

function parseCurrencies(raw) {
  if (!raw) return DEFAULTS;
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(arr) && arr.length) return arr;
  } catch { /* fall through */ }
  return DEFAULTS;
}

export const CurrencyProvider = ({ children }) => {
  const [currencies, setCurrencies] = useState(DEFAULTS);
  const [workflowMode, setWorkflowMode] = useState('single_pos');
  const [currencyMode, setCurrencyMode] = useState('K');
  const [paymentMethods, setPaymentMethods] = useState('cash_momo_bank');
  const [shownMethods, setShownMethods] = useState(ALL_METHODS);
  const [autoDeposit, setAutoDeposit] = useState(false);
  const [legacyProcurementEnabled, setLegacyProcurementEnabled] = useState(false);

  const refresh = useCallback(async () => {
    // Skip the API call when the user isn't logged in â€” otherwise the 401 response
    // triggers the auto-logout interceptor and we land in a redirect loop on /login.
    if (!localStorage.getItem('token')) return;
    try {
      const res = await getSettings();
      const biz = res.data?.business || {};
      setCurrencies(parseCurrencies(biz.currencies_json));
      const wm = String(biz.workflow_mode || 'single_pos').toLowerCase();
      setWorkflowMode(['three_station', 'two_station', 'pos_dispatch'].includes(wm) ? wm : 'single_pos');
      // v1.7.0: third value 'USD+FRA+K' enables triple-currency cash at till.
      const cm = String(biz.currency_mode || 'K').toUpperCase();
      setCurrencyMode(['USD+FRA+K', 'USD+FRA'].includes(cm) ? cm : 'K');
      const pm = String(biz.payment_methods || 'cash_momo_bank').toLowerCase();
      setPaymentMethods(['cash_only', 'cash_momo_bank'].includes(pm) ? pm : 'cash_momo_bank');
      setLegacyProcurementEnabled(!!parseInt(biz.legacy_procurement_enabled || 0, 10));
      setShownMethods(parseShownMethods(biz.shown_payment_methods));
      setAutoDeposit(!!parseInt(biz.auto_deposit_enabled || 0, 10));
    } catch { /* keep defaults */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const primary = currencies.find(c => c.is_primary) || currencies[0] || DEFAULTS[0];
  const symbol = primary.symbol;
  const money = (n) => `${symbol}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <CurrencyContext.Provider value={{
      currencies, primary, symbol, money,
      workflowMode, currencyMode, paymentMethods,
      // v1.9.27 â€” one switch every Liquor-vs-Kelete page reads. True for
      // K-only branches that accept Cash + MoMo + Bank (Mansa, Lusaka);
      // false for Kelete multi-currency cash branches (Kassumbalesa).
      isLiquorStyle: currencyMode === 'K' && paymentMethods === 'cash_momo_bank',
      // methodShown('momo') or methodShown('Mobile Money'). A label that is
      // none of the three (e.g. 'Credit') is always shown.
      shownMethods,
      autoDeposit,
      methodShown: (m) => { const k = methodKeyOf(m); return !k || shownMethods.includes(k); },
      legacyProcurementEnabled,
      refresh,
    }}>
      {children}
    </CurrencyContext.Provider>
  );
};

export const useCurrency = () => useContext(CurrencyContext);
