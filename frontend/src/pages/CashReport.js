import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import { FiSave, FiCalendar, FiEdit2, FiPlus, FiPrinter, FiEye, FiX, FiTrash2 } from 'react-icons/fi';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import PaymentVoucherFormModal from '../components/PaymentVoucherFormModal';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { getPaymentVouchers, getSettings, createCashReceipt, updateCashReceipt, checkSalesCashReceipt, getSalesCashiers, getCurrencyExchangesNet, getCurrentFxRate, deleteCashReport, getExpenseRequests } from '../services/api';
import CurrencyExchangePanel from '../components/CurrencyExchangePanel';
import useDepositTarget from '../utils/useDepositTarget';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:5300/api';

// v1.10.35 — mobile detection for the per-cashier reconciliation grid.
// Same shape as POS.js's local hook so behaviour matches other pages.
const useIsMobile = (breakpoint = 768) => {
  const [isMobile, setIsMobile] = useState(
    typeof window !== 'undefined' && window.innerWidth <= breakpoint
  );
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return isMobile;
};

const getStatus = (diff) => {
  if (diff === 0) return 'OK';
  if (diff > 0 && diff < 10) return 'Slight Surplus';
  if (diff >= 10) return 'Surplus';
  if (diff < 0 && diff > -10) return 'Slight Short';
  return 'Short';
};

const CashReport = () => {
  const { user: authUser } = useAuth();
  const { symbol: curSym, currencyMode, isLiquorStyle, methodShown, autoDeposit } = useCurrency();
  // 2026-09-11 — Auto deposit (System Settings): saving, editing or deleting
  // this report also moves deposits to HQ, so the page says so first. The
  // server only does it online, so a desktop till is not told it will.
  const autoDepositOn = !!autoDeposit && !(typeof navigator !== 'undefined' && /Electron/i.test(navigator.userAgent || ''));
  // 2026-09-18 — where this depot's cash actually goes: HQ, or the depot named
  // in System Settings → Deposit to.
  const depositTo = useDepositTarget();
  const kFmt = (v) => `${curSym}${(parseFloat(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const depositLines = (u, f, k) => [['Cash', u], ['Mobile Money', f], ['Bank', k]]
    .filter(([, v]) => (parseFloat(v) || 0) > 0)
    .map(([m, v]) => `${m} ${kFmt(v)}`);
  // 2026-09-11 — "Cash + MoMo + Bank", less what this branch hides.
  const methodsLabel = ['Cash', methodShown('momo') && 'MoMo', methodShown('bank') && 'Bank'].filter(Boolean).join(' + ');
  const hasMoney = (...vals) => vals.some(v => Math.abs(parseFloat(v) || 0) > 0.004);
  const isMobile = useIsMobile();
  // v1.9.26 — currency_mode gates per-currency panels.
  // v1.9.30 — Cash Report method-axis lands: Liquor branches render
  // Cash / MoMo / Bank counter panels reading the new cash_net /
  // momo_net / bank_net rollups from /cash-reports/daily. Currency
  // panels are hidden on Liquor branches (kept on Kelete).
  const showUSDccy = !isLiquorStyle && (currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K');
  const showFRAccy = !isLiquorStyle && (currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K');
  const showKccy   = !isLiquorStyle && (currencyMode === 'USD+FRA+K' || currencyMode === 'K');
  const { t } = useLanguage();
  // v1.10.43 — local-date, not UTC. Was defaulting Cash Report to UTC
  // "today", which at 00:16 Lusaka time on Jul 3 (= 22:16 UTC Jul 2) still
  // showed "2026-07-02" while Sales Report — using local time — was
  // already on Jul 3. Same builder Sales Report uses (SalesReport.js:12).
  const _t = new Date();
  const today = `${_t.getFullYear()}-${String(_t.getMonth()+1).padStart(2,'0')}-${String(_t.getDate()).padStart(2,'0')}`;
  const [date, setDate] = useState(today);
  const [reports, setReports] = useState([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [editMode, setEditMode] = useState(false);
  // v1.10.9 — admin-gated delete of the saved cash report for the selected day.
  const [savedReportId, setSavedReportId] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Cashier selector for the form (who this report is for)
  const [selectedCashier, setSelectedCashier] = useState('');
  const [allUsers, setAllUsers] = useState([]); // all system users for the form dropdown
  const [salesCashiers, setSalesCashiers] = useState([]); // users who made sales on selected date
  const [allSalesCashiers, setAllSalesCashiers] = useState([]); // all users who ever made sales (for history filter)

  // History filter
  const [filterMonth, setFilterMonth] = useState(new Date().getMonth() + 1); // 1–12, 0 = all
  const [filterYear, setFilterYear]   = useState(new Date().getFullYear());   // 0 = all
  const [filterUser, setFilterUser] = useState('all');
  const [availableUsers, setAvailableUsers] = useState([]); // [{ cashier_id, full_name }]

  // v1.8.1 — triple-currency Cash Report. usd_received / fra_received /
  // k_received each hold NET cash in that currency (received minus change
  // given), in that currency's own units. Legacy keys cash/mobile_money/bank
  // are still echoed in saves for backwards compat (zeroed on the server).
  const [form, setForm] = useState({
    initial_change: '0',
    usd_received: '', fra_received: '', k_received: '',
    expenses: '',
    pending: '', total: '', after_change: '', expected: '',
    difference: '', status: 'OK', comment: ''
  });

  const [dailyRevenue, setDailyRevenue] = useState(0);
  const [daySummary, setDaySummary] = useState({ totalExpected: 0, totalCash: 0 });
  // v1.8.22 — per-currency totals across ALL cashiers for the selected date.
  // Drives the top KPI bar above the form (Liquor-style summary but split
  // into USD/FRA/K instead of a single $ figure).
  const [daySummaryByCcy, setDaySummaryByCcy] = useState({
    usd: { expected: 0, received: 0 },
    fra: { expected: 0, received: 0 },
    k:   { expected: 0, received: 0 },
  });
  // v1.8.6 — net per-currency impact of drawer exchanges for this date+cashier.
  // Bump exchangeRefreshKey to force the CurrencyExchangePanel to re-load
  // (after every save) without remounting the whole report.
  const [exchangeNet, setExchangeNet] = useState({ usd_net: 0, fra_net: 0, k_net: 0 });
  // v1.8.84 — all-cashier exchange net for the day, used by the top KPI bar
  // (Total cash in needs to subtract exchange inflow across the whole team).
  const [exchangeNetAll, setExchangeNetAll] = useState({ usd_net: 0, fra_net: 0, k_net: 0 });
  const [exchangeRefreshKey, setExchangeRefreshKey] = useState(0);
  // v1.8.10 — current FX rates so Total can convert FRA/K into USD before
  // comparing against Expected (which is the order total_amount sum in USD).
  const [fxRate, setFxRate] = useState({ sell: 0, sellK: 0 });
  // v1.8.11 — per-currency Expected. Snapshot of what the POS says was
  // received per currency (net of change), independent of what the cashier
  // typed into the form. Difference per currency = counted − expected.
  const [expectedByCcy, setExpectedByCcy] = useState({ usd: 0, fra: 0, k: 0 });
  // v1.9.30 — method-axis expected for Liquor-style branches (Mansa/Lusaka).
  // Read from the new cash_net / momo_net / bank_net fields the backend
  // returns alongside the per-currency ones.
  const [expectedByMethod, setExpectedByMethod] = useState({ cash: 0, momo: 0, bank: 0 });
  // v1.8.68 — over-collections kept by cashier (per source currency + per-order rows).
  // v1.8.76 — also tracks under-payments (walk-in tolerance shortages, USD-equivalent).
  const [overpaidByCcy,  setOverpaidByCcy]  = useState({ usd: 0, fra: 0, k: 0 });
  const [underpaidByCcy, setUnderpaidByCcy] = useState({ usd: 0, fra: 0, k: 0 });
  const [overpaidRows,   setOverpaidRows]   = useState([]); // mixed OVER + UNDER rows
  // v1.8.14 — per-currency expenses paid out of the cash drawer today.
  // Subtracted from each currency's Expected so the diff stays accurate
  // (USD expenses don't deplete FRA drawer, etc.).
  const [expensesByCcy, setExpensesByCcy] = useState({ usd: 0, fra: 0, k: 0 });
  // v1.8.20 — POS-snapshot of today's credit (issued unpaid balance).
  // Independent of form.pending which is editable by the cashier.
  const [creditExpected, setCreditExpected] = useState(0);
  // v1.8.23 — stale-fetch guard. Each loadDate call bumps this counter and
  // captures its own number; the call only commits state if its number is
  // still the latest. Without this, an earlier loadDate (cid='' on mount)
  // would lose its race with the later one (cid='Nahom') and overwrite
  // Nahom's values with the all-cashier auto-fill.
  const loadSeq = useRef(0);

  // Expenses list modal
  const [showExpenses, setShowExpenses] = useState(false);
  const [expensesList, setExpensesList] = useState([]);

  // Print preview
  const [showPrintPreview, setShowPrintPreview] = useState(false);
  const [printExpenses, setPrintExpenses] = useState([]);
  const [businessInfo, setBusinessInfo] = useState({});

  // Voucher modal state — form lives inside the shared PaymentVoucherFormModal.
  const [showVoucher, setShowVoucher] = useState(false);
  // 2026-09-21 — opened from the green "Approved — save the voucher" card,
  // for an expense that was raised HERE. It used to land on the Payment
  // Voucher page instead, which is not where the cashier was working and not
  // where the voucher belongs, so her own expense never came back to her
  // report. The link carries the date and the cashier it was raised for.
  const [voucherPrefill, setVoucherPrefill] = useState(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const syncId = q.get('req');
    if (!syncId) return;
    const wantDate = q.get('date');
    const wantCashier = q.get('cashier');
    if (wantDate) setDate(wantDate);
    if (wantCashier) setSelectedCashier(String(wantCashier));
    getExpenseRequests({ status: 'approved' })
      .then(r => {
        const hit = (r.data?.rows || []).find(x => x.sync_id === syncId);
        if (hit) { setVoucherPrefill(hit); setShowVoucher(true); }
      })
      .catch(() => {});
  // eslint-disable-next-line
  }, []);
  // v1.8.18 — currency hint for the PV modal so the right amount input
  // gets focused when the user clicks + on a specific currency card.
  const [voucherDefaultCcy, setVoucherDefaultCcy] = useState(null);

  // CR auto-creation confirmation
  const [showCRConfirm, setShowCRConfirm] = useState(false);

  useModalScrollLock(showVoucher || showExpenses || showCRConfirm);
  const [existingCR, setExistingCR] = useState(null);   // { id, receipt_number, amount }
  const [pendingCRData, setPendingCRData] = useState(null);
  const [crSaving, setCRSaving] = useState(false);

  const getToken = () => localStorage.getItem('token');

  const fetchReports = async () => {
    try {
      const res = await fetch(`${API_BASE}/cash-reports`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      const data = await res.json();
      setReports(Array.isArray(data) ? data : []);
    } catch (err) { setReports([]); }
  };

  const fetchUsers = async () => {
    try {
      // For filter dropdown — who has submitted cash reports
      const res = await fetch(`${API_BASE}/cash-reports/users`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      const data = await res.json();
      setAvailableUsers(Array.isArray(data) ? data : []);
      // For form dropdown — all system users
      const usersRes = await fetch(`${API_BASE}/users`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      const usersData = await usersRes.json();
      setAllUsers(Array.isArray(usersData) ? usersData : []);
    } catch (err) { setAvailableUsers([]); }
  };

  const fetchDaily = async (d, cashierId) => {
    try {
      const cid = cashierId !== undefined ? cashierId : selectedCashier;
      // Convert the selected LOCAL date into a UTC datetime range so orders
      // (stored in UTC) get bucketed by the cashier's local "today", not the UTC date.
      const p = (n) => String(n).padStart(2, '0');
      const toSqliteUTC = (dt) => `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
      const startLocal = new Date(`${d}T00:00:00`);
      const endLocal   = new Date(`${d}T23:59:59`);
      const fromUtc = toSqliteUTC(startLocal);
      const toUtc   = toSqliteUTC(endLocal);
      // v1.8.67 — HQ Deposit math removed from Cash Report (cashier till)
      // because deposits flow cashier → manager → HQ in real ops. Cash
      // Book still surfaces deposit movements at the accounting level.
      const qs = `date=${d}&cashier_id=${cid}&from_utc=${encodeURIComponent(fromUtc)}&to_utc=${encodeURIComponent(toUtc)}`;
      const res = await fetch(`${API_BASE}/cash-reports/daily?${qs}`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      const data = await res.json();
      return data;
    } catch (err) { return null; }
  };

  const fetchSalesCashiers = async (d) => {
    try {
      // v1.10.43 — pass the same LOCAL-day → UTC bounds we use for /daily
      // so a cashier whose sale time crossed local midnight (e.g. 12:47 AM
      // local Lusaka = 22:47 UTC previous day) still appears in the
      // dropdown for their local day. Without this the /sales-cashiers
      // endpoint's naive DATE(created_at) match drops them silently.
      const p = (n) => String(n).padStart(2, '0');
      const toSqliteUTC = (dt) => `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
      const fromUtc = toSqliteUTC(new Date(`${d}T00:00:00`));
      const toUtc   = toSqliteUTC(new Date(`${d}T23:59:59`));
      const res = await getSalesCashiers(d, null, null, fromUtc, toUtc);
      const list = res.data || [];
      setSalesCashiers(list);
      if (list.length > 0) {
        const firstId = String(list[0].id);
        setSelectedCashier(firstId);
        return firstId;
      } else {
        setSelectedCashier('');
        return '';
      }
    } catch { setSalesCashiers([]); setSelectedCashier(''); return ''; }
  };

  const loadDate = async (d, cashierId) => {
    // v1.8.23 — claim a sequence number for this call. Any setState below
    // is guarded by a check that this is still the latest call. Stale
    // results (e.g. the pre-Nahom load that lost the race) get dropped.
    const seq = ++loadSeq.current;
    const isLatest = () => seq === loadSeq.current;

    setDate(d);
    setMessage('');

    const cid = cashierId !== undefined ? cashierId : selectedCashier;
    const daily = await fetchDaily(d, cid);
    if (!isLatest()) return; // stale: a newer loadDate has already started

    // v1.8.68 — per-order over-collection rows for the panel.
    try {
      const startLocal = `${d} 00:00:00`;
      const endLocal   = `${d} 23:59:59`;
      const fromUtcS = toSqliteUTC(startLocal);
      const toUtcS   = toSqliteUTC(endLocal);
      const opqs = `date=${d}&cashier_id=${cid || 0}&from_utc=${encodeURIComponent(fromUtcS)}&to_utc=${encodeURIComponent(toUtcS)}`;
      const opRes = await fetch(`${API_BASE}/cash-reports/overpaid?${opqs}`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      if (isLatest()) {
        const list = opRes.ok ? await opRes.json() : [];
        setOverpaidRows(Array.isArray(list) ? list : []);
      }
    } catch { if (isLatest()) setOverpaidRows([]); }

    if (daily) {
      setDailyRevenue(parseFloat(daily.total_revenue || 0));
      // v1.8.11 — snapshot per-currency expected from POS (orders).
      // On Liquor style, read from cash_net/momo_net/bank_net so the snapshot
      // subtracts change_amount (matches the top card). Legacy usd_received
      // only subtracts usd_change_given, which is 0 on K-only branches, so
      // the saved expected inflates by the change given. See history-diff bug.
      setExpectedByCcy({
        usd: parseFloat((isLiquorStyle ? daily.cash_net : daily.usd_received) || 0) || 0,
        fra: parseFloat((isLiquorStyle ? daily.momo_net : daily.fra_received) || 0) || 0,
        k:   parseFloat((isLiquorStyle ? daily.bank_net : daily.k_received)   || 0) || 0,
      });
      // v1.9.30 — method-axis expected (Cash / MoMo / Bank) for Liquor branches.
      setExpectedByMethod({
        cash: parseFloat(daily.cash_net || 0) || 0,
        momo: parseFloat(daily.momo_net || 0) || 0,
        bank: parseFloat(daily.bank_net || 0) || 0,
      });
      // v1.8.14 — per-currency expenses for that date+cashier.
      setExpensesByCcy({
        usd: parseFloat(daily.usd_expenses || 0) || 0,
        fra: parseFloat(daily.fra_expenses || 0) || 0,
        k:   parseFloat(daily.k_expenses   || 0) || 0,
      });
      // v1.8.68 — over-collections snapshot for the "Over-Collections" panel.
      setOverpaidByCcy({
        usd: parseFloat(daily.usd_overpaid_kept || 0) || 0,
        fra: parseFloat(daily.fra_overpaid_kept || 0) || 0,
        k:   parseFloat(daily.k_overpaid_kept   || 0) || 0,
      });
      // v1.8.76 — under-payments (walk-in tolerance shortages).
      // v1.8.77 — per-currency attribution (source-currency, same as over-payments).
      setUnderpaidByCcy({
        usd: parseFloat(daily.usd_underpaid || 0) || 0,
        fra: parseFloat(daily.fra_underpaid || 0) || 0,
        k:   parseFloat(daily.k_underpaid   || 0) || 0,
      });
      // v1.8.20 — POS snapshot of credit issued today (so the card can show
      // Counted vs Expected the same way the cash cards do).
      setCreditExpected(parseFloat(daily.credit_sales || 0) + parseFloat(daily.pending || 0));
    }

    const saved = reports.find(r => r.date && r.date.split('T')[0] === d && String(r.cashier_id ?? 0) === String(cid));
    setSavedReportId(saved?.id || null);
    if (saved) {
      // v1.8.13 — restore the per-currency Expected snapshot stored at save
      // time. Falls back to current /daily figure for legacy rows.
      // Same Liquor-style fallback as the un-saved branch above.
      setExpectedByCcy({
        usd: parseFloat(saved.usd_expected || (isLiquorStyle ? daily?.cash_net : daily?.usd_received) || 0) || 0,
        fra: parseFloat(saved.fra_expected || (isLiquorStyle ? daily?.momo_net : daily?.fra_received) || 0) || 0,
        k:   parseFloat(saved.k_expected   || (isLiquorStyle ? daily?.bank_net : daily?.k_received)   || 0) || 0,
      });
      // v1.9.30 — method-axis expected for Liquor branches.
      setExpectedByMethod({
        cash: parseFloat(daily?.cash_net || 0) || 0,
        momo: parseFloat(daily?.momo_net || 0) || 0,
        bank: parseFloat(daily?.bank_net || 0) || 0,
      });
      setForm({
        initial_change: saved.initial_change || '0',
        // v1.8.1: prefer new triple-currency fields, fall back to legacy
        // cash/mobile_money/bank columns (where the same values were stored
        // before the rename).
        usd_received: saved.usd_received || saved.cash || '',
        fra_received: saved.fra_received || saved.mobile_money || '',
        k_received:   saved.k_received   || saved.bank || '',
        expenses: saved.expenses || '',
        pending: saved.pending || '',
        total: saved.total || '',
        after_change: '',
        expected: saved.expected || '',
        difference: saved.difference || '',
        status: saved.status || 'OK',
        comment: saved.comment || ''
      });
      setEditMode(false);
    } else {
      if (daily) {
        const issuedToday = parseFloat(daily.credit_sales || 0) + parseFloat(daily.pending || 0);
        // v1.8.21 — Counted auto-fill = POS net − expenses + exchange net
        // (the actual drawer balance per currency). Fetch exchanges inline so
        // the initial fill reflects them right away (no race with the
        // exchangeRefreshKey useEffect).
        const cidNum = parseInt(cid) || 0;
        let exNet = { usd_net: 0, fra_net: 0, k_net: 0 };
        try {
          const r = await getCurrencyExchangesNet({ scope: 'drawer', date: d, cashier_id: cidNum });
          exNet = r.data || exNet;
        } catch { /* keep zeros */ }
        if (!isLatest()) return; // stale: a newer loadDate has already started
        // v1.9.32 — on Liquor branches, auto-fill the three counter inputs
        // from the method-axis rollups (cash_net / momo_net / bank_net).
        // The legacy fra_received / k_received columns are always 0 on
        // Mansa/Lusaka because the walk-in modal writes to momo_received /
        // bank_received instead. Using them would auto-fill MoMo and Bank
        // with 0 even when the day had per-method sales.
        const usdDrawer = isLiquorStyle
          ? (parseFloat(daily.cash_net || 0) || 0)
          : ((parseFloat(daily.usd_received || 0) || 0) - (parseFloat(daily.usd_expenses || 0) || 0) + (parseFloat(exNet.usd_net || 0) || 0));
        const fraDrawer = isLiquorStyle
          ? (parseFloat(daily.momo_net || 0) || 0)
          : ((parseFloat(daily.fra_received || 0) || 0) - (parseFloat(daily.fra_expenses || 0) || 0) + (parseFloat(exNet.fra_net || 0) || 0));
        const kDrawer = isLiquorStyle
          ? (parseFloat(daily.bank_net || 0) || 0)
          : ((parseFloat(daily.k_received || 0) || 0) - (parseFloat(daily.k_expenses || 0) || 0) + (parseFloat(exNet.k_net || 0) || 0));
        setForm(prev => ({
          ...prev,
          usd_received: usdDrawer ? usdDrawer.toFixed(2) : '',
          fra_received: fraDrawer ? fraDrawer.toFixed(isLiquorStyle ? 2 : 0) : '',
          k_received:   kDrawer   ? kDrawer.toFixed(isLiquorStyle ? 2 : 0)   : '',
          expenses:     daily.expenses     ? parseFloat(daily.expenses).toFixed(2)     : '',
          pending:      issuedToday ? issuedToday.toFixed(2) : '',
          initial_change: '0',
          after_change: '',
          comment: '',
          status: 'OK'
        }));
      }
      setEditMode(true);
    }
  };

  useEffect(() => {
    fetchReports();
    fetchUsers();
    fetchSalesCashiers(today);
    getSalesCashiers().then(r => setAllSalesCashiers(r.data || [])).catch(() => {});
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
    // v1.8.10 — load current FX so Total computes in USD-equivalent.
    getCurrentFxRate()
      .then(r => setFxRate({
        sell:  parseFloat(r.data?.sell_rate)   > 0 ? parseFloat(r.data.sell_rate)   : 0,
        sellK: parseFloat(r.data?.sell_rate_k) > 0 ? parseFloat(r.data.sell_rate_k) : 0,
      }))
      .catch(() => {});
  }, []);
  // v1.8.6 — refetch the net drawer-exchange impact for this date+cashier.
  // Bumped by the panel after every save; also re-runs on date/cashier change.
  useEffect(() => {
    if (!date) return;
    const cid = selectedCashier ? parseInt(selectedCashier) : 0;
    getCurrencyExchangesNet({ scope: 'drawer', date, cashier_id: cid })
      .then(r => setExchangeNet(r.data || { usd_net: 0, fra_net: 0, k_net: 0 }))
      .catch(() => setExchangeNet({ usd_net: 0, fra_net: 0, k_net: 0 }));
  }, [date, selectedCashier, exchangeRefreshKey]);
  // v1.8.84 — all-cashier exchange net for the top KPI bar (no cashier_id filter).
  useEffect(() => {
    if (!date) return;
    getCurrencyExchangesNet({ scope: 'drawer', date })
      .then(r => setExchangeNetAll(r.data || { usd_net: 0, fra_net: 0, k_net: 0 }))
      .catch(() => setExchangeNetAll({ usd_net: 0, fra_net: 0, k_net: 0 }));
  }, [date, exchangeRefreshKey]);
  // v1.8.18 — re-run loadDate whenever the auto-selected cashier resolves.
  // fetchSalesCashiers(today) is async; on first mount it eventually fires
  // setSelectedCashier(firstId). Before that, loadDate would run with cid=''
  // which the backend treats as 'all cashiers' — so the form initially
  // showed everyone's totals while the dropdown read 'Nahom'. Adding
  // selectedCashier to deps + passing it explicitly fixes the race.
  useEffect(() => { if (reports.length >= 0) loadDate(date, selectedCashier); }, [reports, selectedCashier]); // eslint-disable-line
  useEffect(() => {
    fetchDaily(date, '0').then(all => {
      const totalExpected = parseFloat(all?.total_revenue || 0);
      // After Change was dropped from the UI (it's always identical to Total
      // since the initial-change float input is hidden). Read r.total directly
      // so this KPI is correct even for legacy reports whose saved
      // after_change was a stale 0.
      const totalCash = reports
        .filter(r => r.date && r.date.split('T')[0] === date)
        .reduce((s, r) => s + parseFloat(r.total || 0), 0);
      setDaySummary({ totalExpected, totalCash });
      // v1.8.22 — per-currency aggregate across ALL cashiers for the day.
      // Expected = POS net per currency for the whole team (from /daily
      // with cashier_id=0). Received = sum of saved cash reports'
      // per-currency counted values for this date.
      const reportsForDay = reports.filter(r => r.date && r.date.split('T')[0] === date);
      const sumCol = (col) => reportsForDay.reduce((s, r) => s + (parseFloat(r[col] || 0) || 0), 0);
      // v1.8.84 — also surface counted + expenses per currency so the top KPI
      // bar can compute Total cash in = counted + expenses − exchange_net.
      setDaySummaryByCcy({
        usd: { expected: parseFloat(all?.usd_received || 0) || 0, counted: sumCol('usd_received'), expenses: parseFloat(all?.usd_expenses || 0) || 0 },
        fra: { expected: parseFloat(all?.fra_received || 0) || 0, counted: sumCol('fra_received'), expenses: parseFloat(all?.fra_expenses || 0) || 0 },
        k:   { expected: parseFloat(all?.k_received   || 0) || 0, counted: sumCol('k_received'),   expenses: parseFloat(all?.k_expenses   || 0) || 0 },
        // v1.9.30 — method-axis rollups for Liquor branches.
        // v1.10.32 — counted now sums the per-method columns the save
        // handler writes (cash / mobile_money / bank). Expenses reuse
        // the currency columns via the Liquor mapping: Cash → usd_amount
        // (usd_expenses), MoMo → fra_amount, Bank → k_amount.
        cash: { expected: parseFloat(all?.cash_net || 0) || 0, counted: sumCol('cash'),         expenses: parseFloat(all?.usd_expenses || 0) || 0 },
        momo: { expected: parseFloat(all?.momo_net || 0) || 0, counted: sumCol('mobile_money'), expenses: parseFloat(all?.fra_expenses || 0) || 0 },
        bank: { expected: parseFloat(all?.bank_net || 0) || 0, counted: sumCol('bank'),         expenses: parseFloat(all?.k_expenses   || 0) || 0 },
      });
    }).catch(() => {});
  }, [date, reports]); // eslint-disable-line

  // v1.8.11 — no more USD-equivalent total. Each currency reconciles
  // independently: counted − expected, status per currency. The single
  // total/after_change/difference/status fields stay in form state for
  // backwards compatibility with the POST handler + history table.
  // total = sum of counted in their own units (purely informational).
  useEffect(() => {
    const ic   = parseFloat(form.initial_change) || 0;
    const usd  = parseFloat(form.usd_received)   || 0;
    const fra  = parseFloat(form.fra_received)   || 0;
    const k    = parseFloat(form.k_received)     || 0;
    const exp  = parseFloat(form.expenses)       || 0;
    const pend = parseFloat(form.pending)        || 0;
    const total = usd + pend + exp; // legacy single value, USD bucket only
    const after_change = total - ic;
    const expected = dailyRevenue;
    const diff     = after_change - expected;
    const status   = getStatus(diff);
    setForm(prev => ({ ...prev, total: total.toFixed(2), after_change: after_change.toFixed(2), expected: expected.toFixed(2), difference: diff.toFixed(2), status }));
  }, [form.initial_change, form.usd_received, form.fra_received, form.k_received, form.expenses, form.pending, dailyRevenue]); // eslint-disable-line

  const handleSave = async () => {
    if (!selectedCashier) { setMessage('Please select a cashier before saving.'); return; }
    // 2026-09-11 — with Auto deposit on, saving is not only saving: say what
    // goes to HQ (or how this report's deposits change) and let them stop.
    if (autoDepositOn) {
      const lines = depositLines(form.usd_received, form.fra_received, form.k_received);
      const isUpdate = !!savedReportId;
      if (lines.length || isUpdate) {
        const body = lines.length ? lines.map(l => `   • ${l}`).join('\n') : '   • nothing counted';
        // 2026-09-18 — a depot that deposits to another depot (System Settings
        // → Deposit to) must not be told its money is going to HQ.
        const to = depositTo.label;
        const msg = isUpdate
          ? `Auto deposit is on for this depot.\n\nSaving will also UPDATE this report's deposits to ${to} to:\n${body}\n\nA method with nothing counted has its deposit removed. ${to} still has to confirm them.\n\nSave and update the deposits?`
          : `Auto deposit is on for this depot.\n\nSaving this Cash Report will also SEND this money to ${to} as deposits:\n${body}\n\n${to} has to confirm them in ${to} Deposits.\n\nSave and send?`;
        if (!window.confirm(msg)) return;
      }
    }
    setSaving(true);
    setMessage('');
    try {
      const ic   = parseFloat(form.initial_change) || 0;
      const usd  = parseFloat(form.usd_received)   || 0;
      const fra  = parseFloat(form.fra_received)   || 0;
      const kAmt = parseFloat(form.k_received)     || 0;
      const exp  = parseFloat(form.expenses)       || 0;
      // v1.8.54 — credit is no longer counted manually; force pending to
      // mirror the system's creditExpected so the saved snapshot matches
      // the on-screen card (which always reads Counted = Expected).
      const pend = parseFloat(creditExpected || 0)  || 0;
      // v1.8.10 — convert FRA/K to USD before summing (same as auto-calc).
      const fraAsUsd = fxRate.sell  > 0 ? fra / fxRate.sell  : 0;
      const kAsUsd   = fxRate.sellK > 0 ? kAmt / fxRate.sellK : 0;
      const total       = usd + fraAsUsd + kAsUsd + pend + exp;
      const afterChange = total - ic;
      const expected    = dailyRevenue;
      const difference  = afterChange - expected;

      const res = await fetch(`${API_BASE}/cash-reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({
          date,
          cashier_id: parseInt(selectedCashier) || 0,
          initial_change: ic,
          usd_received: usd,
          fra_received: fra,
          k_received:   kAmt,
          // v1.8.13 — snapshot per-currency Expected so the saved row carries
          // its own reconciliation (no need to re-derive from orders later).
          usd_expected: parseFloat(expectedByCcy.usd) || 0,
          fra_expected: parseFloat(expectedByCcy.fra) || 0,
          k_expected:   parseFloat(expectedByCcy.k)   || 0,
          // v1.8.26 — snapshot per-currency expenses paid out of drawer.
          usd_expenses: parseFloat(expensesByCcy.usd) || 0,
          fra_expenses: parseFloat(expensesByCcy.fra) || 0,
          k_expenses:   parseFloat(expensesByCcy.k)   || 0,
          // v1.10.32 — on Liquor-style branches, ALSO write the per-method
          // counted values into cash_reports.cash / mobile_money / bank so
          // the "ALL CASHIERS" top bar can sum them across cashiers. Same
          // mapping used everywhere else on Liquor: Cash→usd_received,
          // MoMo→fra_received, Bank→k_received. Kelete branches send 0s
          // (no method concept there).
          ...(isLiquorStyle ? { cash: usd, mobile_money: fra, bank: kAmt } : { cash: 0, mobile_money: 0, bank: 0 }),
          expenses: exp,
          pending: pend,
          total,
          after_change: afterChange,
          expected,
          difference,
          status: getStatus(difference),
          comment: form.comment
        })
      });
      if (res.ok) {
        // 2026-09-11 — what the auto deposit did, if this depot has it on.
        const savedRow = await res.json().catch(() => null);
        const dep = savedRow?.auto_deposits || null;
        setMessage('Report saved successfully!');
        setEditMode(false);
        await fetchReports();

        // v1.8.84 — CR books "Total cash in" per currency, not "Counted".
        //   Total cash in = Counted + Expenses − exch_net   (sales-only inflow)
        // Counted is after expenses have left the drawer, so booking Counted
        // would double-deduct the PVs when Cash Book later subtracts them.
        // The Difference (Total cash in − Expected sales) stays on the Cash
        // Report only — never written to any ledger.
        const usdCounted = parseFloat(form.usd_received) || 0;
        const fraCounted = parseFloat(form.fra_received) || 0;
        const kCounted   = parseFloat(form.k_received)   || 0;
        const usdAmt = usdCounted + (parseFloat(expensesByCcy.usd) || 0) - (parseFloat(exchangeNet.usd_net) || 0);
        const fraAmt = fraCounted + (parseFloat(expensesByCcy.fra) || 0) - (parseFloat(exchangeNet.fra_net) || 0);
        const kAmt2  = kCounted   + (parseFloat(expensesByCcy.k)   || 0) - (parseFloat(exchangeNet.k_net)   || 0);
        const paymentMethod = 'Cash';
        const status = form.status || computedStatus;
        const cashier = selectedCashier !== '0' ? allUsers.find(u => String(u.id) === String(selectedCashier)) : null;
        const receivedFrom = cashier ? `Sales / ${cashier.first_name}` : 'Sales';
        // v1.10.44 — on Liquor branches all three amount slots are the same
        // currency (Cash → usd_amount, MoMo → fra_amount, Bank → k_amount, all
        // in K). `amount` and the legacy method columns must reflect the
        // FULL total, not just the Cash portion, or the Cash Book ledger
        // shows only the Cash slice (e.g. K6,700 instead of K33,105) and
        // its Mobile Money tile stays at K0 because momo_amount was never
        // written. Kelete tri-currency branches keep amount=usd_only
        // (USD-anchored, one-currency-per-CR model).
        const totalAmt = isLiquorStyle ? (usdAmt + fraAmt + kAmt2) : usdAmt;
        const crData = {
          date,
          payment_method: paymentMethod,
          received_from: receivedFrom,
          amount:       totalAmt,
          usd_amount:   usdAmt,
          fra_amount:   fraAmt,
          k_amount:     kAmt2,
          // Liquor: send explicit method splits so backend deriveCRSplits
          // doesn't collapse everything into Cash based on payment_method.
          ...(isLiquorStyle ? { cash_amount: usdAmt, momo_amount: fraAmt, bank_amount: kAmt2 } : {}),
          description:  form.comment ? `${status} — ${form.comment}` : status,
        };

        // Auto-upsert the Cash Book entry (no more "Update?" modal). User
        // reports too many Cash Reports were saved without the modal ever
        // being confirmed, leaving Cash Book empty. Now: if a Sales CR
        // for today+cashier exists we UPDATE it silently; otherwise create.
        // Errors are surfaced so schema drift / server errors are visible.
        try {
          const checkRes = await checkSalesCashReceipt(date, receivedFrom);
          if (checkRes.data?.exists && checkRes.data?.id) {
            await updateCashReceipt(checkRes.data.id, crData);
            setMessage('Report saved and Cash Book entry updated.');
          } else {
            await createCashReceipt(crData);
            setMessage('Report saved and Cash Book entry created.');
          }
        } catch (crErr) {
          const msg = crErr?.response?.data?.error || crErr?.message || 'unknown error';
          setMessage(`Report saved, but Cash Book entry was NOT written: ${msg}`);
          console.error('[CashReport] createCashReceipt failed:', crErr);
        }
        if (dep?.error) {
          setMessage(m => `${m} Deposit to ${depositTo.label} was NOT written: ${dep.error}`);
        } else if (dep) {
          // "Deposit to Kabwe: Cash K56,383.00 sent · Mobile Money removed"
          const said = (Array.isArray(dep.items) ? dep.items : []).map(i =>
            i.action === 'removed' ? `${i.method} removed` : `${i.method} ${kFmt(i.amount)} ${i.action}`);
          if (said.length) setMessage(m => `${m} Deposit to ${depositTo.label}: ${said.join(' · ')} — waiting for ${depositTo.label} to confirm.`);
        }
      } else {
        const err = await res.json();
        setMessage(err.error || 'Failed to save.');
      }
    } catch (err) {
      setMessage('Failed to save report.');
    }
    setSaving(false);
  };

  const handleConfirmUpdateCR = async () => {
    if (!existingCR || !pendingCRData) return;
    setCRSaving(true);
    try {
      await updateCashReceipt(existingCR.id, pendingCRData);
      setMessage('Report saved and Cash Receipt updated successfully!');
    } catch (err) {
      setMessage('Report saved. Failed to update Cash Receipt.');
    } finally {
      setCRSaving(false);
      setShowCRConfirm(false);
      setExistingCR(null);
      setPendingCRData(null);
    }
  };

  const handleAbortUpdateCR = () => {
    setShowCRConfirm(false);
    setExistingCR(null);
    setPendingCRData(null);
  };

  // ── Expenses list helper ───────────────────────────────────────────
  // v1.8.18 — optional currencyFilter ('USD'|'FRA'|'K') filters the
  // modal client-side to PVs that paid out of that currency's drawer.
  // No backend filter param; we just slice the response.
  const [expensesFilterCcy, setExpensesFilterCcy] = useState(null);
  const openExpensesList = async (currencyFilter = null) => {
    setExpensesFilterCcy(currencyFilter || null);
    try {
      const res = await getPaymentVouchers({ date, paid_from: 'Cash Drawer', cashier_id: parseInt(selectedCashier) || 0 });
      setExpensesList(res.data || []);
    } catch { setExpensesList([]); }
    setShowExpenses(true);
  };

  // ── Print preview helper ───────────────────────────────────────────
  const openPrintPreview = async () => {
    let expenses = [];
    try {
      const res = await getPaymentVouchers({ date, paid_from: 'Cash Drawer', cashier_id: parseInt(selectedCashier) || 0 });
      expenses = res.data || [];
    } catch { expenses = []; }

    // Build print HTML
    const fmtV = (v) => parseFloat(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    const printedAt = new Date().toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const biz = businessInfo;
    const bizName = biz.business_name || 'Business Name';
    const addr = [biz.business_address,biz.business_phone,biz.business_email].filter(Boolean).join('  |  ');
    const printedBy = [authUser?.firstName, authUser?.lastName].filter(Boolean).join(' ') || '—';
    const cashierName = salesCashiers.find(c => String(c.id) === String(selectedCashier));
    const preparedBy = cashierName ? `${cashierName.first_name} ${cashierName.last_name}` : '—';
    const diff = parseFloat(form.difference)||0;
    const status = computedStatus;
    const expenseRows = expenses.map((v,i)=>`<tr style="border-bottom:1px solid #ddd;background:${i%2===1?'#f9f9f9':'#fff'}">
      <td style="padding:7px 14px;font-family:monospace;font-size:11px">${v.voucher_number}</td>
      <td style="padding:7px 14px">${v.category}</td>
      <td style="padding:7px 14px;font-weight:500">${v.paid_to}</td>
      <td style="padding:7px 14px">${v.description||'—'}</td>
      <td style="padding:7px 14px;text-align:right;font-weight:700;font-family:monospace">${curSym}${fmtV(v.amount)}</td>
    </tr>`).join('');
    const expTotal = expenses.reduce((s,v)=>s+parseFloat(v.amount||0),0);
    const expenseSection = expenses.length>0 ? `
      <div style="border:1.5px solid #000;margin-bottom:20px">
        <div style="background:#000;padding:8px 14px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#fff">Expenses — Cash Drawer</span>
          <span style="font-size:10px;color:#fff;font-weight:600">${expenses.length} voucher${expenses.length>1?'s':''}</span>
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:11.5px">
          <thead><tr style="background:#f0f0f0;border-bottom:1.5px solid #000">
            <th style="padding:7px 14px;text-align:left;font-weight:700;font-size:10.5px">Voucher No.</th>
            <th style="padding:7px 14px;text-align:left;font-weight:700;font-size:10.5px">Category</th>
            <th style="padding:7px 14px;text-align:left;font-weight:700;font-size:10.5px">Paid To</th>
            <th style="padding:7px 14px;text-align:left;font-weight:700;font-size:10.5px">Description</th>
            <th style="padding:7px 14px;text-align:right;font-weight:700;font-size:10.5px">Amount</th>
          </tr></thead>
          <tbody>${expenseRows}</tbody>
          <tfoot><tr style="background:#f0f0f0;border-top:2px solid #000">
            <td colspan="4" style="padding:9px 14px;font-weight:700;text-align:right;font-size:12px">Total Expenses</td>
            <td style="padding:9px 14px;text-align:right;font-weight:800;font-size:13px;font-family:monospace">${curSym}${fmtV(expTotal)}</td>
          </tr></tfoot>
        </table>
      </div>` : '';
    const commentSection = form.comment
      ? `<div style="border:1.5px solid #000;padding:12px 14px;margin-bottom:20px">
          <div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;font-weight:700;margin-bottom:6px">Comments / Notes</div>
          <div style="font-size:12px;line-height:1.6">${form.comment}</div>
        </div>`
      : `<div style="margin-bottom:20px">
          <div style="font-size:9px;letter-spacing:1px;text-transform:uppercase;font-weight:700;margin-bottom:8px">Comments / Notes</div>
          <div style="border-bottom:1px solid #000;height:24px"></div>
        </div>`;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:14px;font-weight:700;letter-spacing:0.6px;color:#000;margin-bottom:2px">RED SEA IMPORT &amp; EXPORT (Z) LIMITED</div>
          <div style="font-size:18px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${bizName}</div>
          <div style="font-size:10px;line-height:1.7">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Daily Cash Report</div>
          <div style="font-size:15px;font-weight:700">${formatDateLong(date)}</div>
          ${preparedBy !== '—' ? `<div style="font-size:10px;margin-top:4px">Cashier: <strong>${preparedBy}</strong></div>` : ''}
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
        <div style="border:1.5px solid #000">
          <div style="background:#000;padding:8px 14px">
            <span style="font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#fff">Cash Breakdown</span>
          </div>
          <table>
            <tbody>
              ${[['Initial Change (Float)',form.initial_change,false],
                 ['Cash',form.usd_received,false],
                 // 2026-09-11 — a hidden method prints only if money sits on it.
                 ...((methodShown('momo') || hasMoney(form.fra_received)) ? [['Mobile Money',form.fra_received,false]] : []),
                 ...((methodShown('bank') || hasMoney(form.k_received)) ? [['Bank',form.k_received,false]] : []),
                 ['Credit Sales',form.pending,false],
                 ['Expenses (Cash Drawer)',form.expenses,true]
              ].map(([label,val,italic],i,arr)=>`<tr style="border-bottom:${i<arr.length-1?'1px solid #ddd':'2px solid #000'}">
                <td style="padding:9px 14px;font-size:12px;font-style:${italic?'italic':'normal'}">${label}</td>
                <td style="padding:9px 14px;text-align:right;font-weight:500;font-family:monospace;font-size:12px">${italic?'−':''}${curSym}${fmtV(val)}</td>
              </tr>`).join('')}
            </tbody>
            <tfoot>
              <tr style="background:#f0f0f0;border-top:1px solid #000"><td style="padding:9px 14px;font-weight:700;font-size:12.5px">Total</td><td style="padding:9px 14px;text-align:right;font-weight:700;font-size:13px;font-family:monospace">${curSym}${fmtV(form.total)}</td></tr>
              <tr style="background:#e8e8e8;border-top:1px solid #000"><td style="padding:10px 14px;font-weight:700;font-size:12px">Cash on Hand (After Change)</td><td style="padding:10px 14px;text-align:right;font-weight:800;font-size:14px;font-family:monospace">${curSym}${fmtV(form.total)}</td></tr>
            </tfoot>
          </table>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <div style="border:1.5px solid #000">
            <div style="background:#000;padding:8px 14px">
              <span style="font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#fff">Reconciliation</span>
            </div>
            <table>
              <tbody>
                <tr style="border-bottom:1px solid #ddd"><td style="padding:9px 14px;font-size:12px">Expected Revenue</td><td style="padding:9px 14px;text-align:right;font-weight:600;font-family:monospace;font-size:12px">${curSym}${fmtV(form.expected)}</td></tr>
                <tr style="border-bottom:2px solid #000"><td style="padding:9px 14px;font-size:12px">Cash on Hand</td><td style="padding:9px 14px;text-align:right;font-weight:600;font-family:monospace;font-size:12px">${curSym}${fmtV(form.total)}</td></tr>
              </tbody>
              <tfoot><tr style="background:#f0f0f0">
                <td style="padding:10px 14px;font-weight:700;font-size:13px">Difference</td>
                <td style="padding:10px 14px;text-align:right;font-weight:800;font-size:14px;font-family:monospace">${diff>=0?'+':'−'}${curSym}${fmtV(Math.abs(diff))}</td>
              </tr></tfoot>
            </table>
          </div>
          <div style="border:2px solid #000;padding:16px;text-align:center;flex:1;display:flex;flex-direction:column;justify-content:center">
            <div style="font-size:9px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;font-weight:700">Report Status</div>
            <div style="font-size:26px;font-weight:900;letter-spacing:3px;text-transform:uppercase;margin-bottom:6px">${status}</div>
            <div style="font-size:11.5px;font-weight:500">${diff!==0?(diff<0?'Cash short by':'Surplus of')+' <strong>'+curSym+fmtV(Math.abs(diff))+'</strong>':'Fully balanced'}</div>
          </div>
        </div>
      </div>
      ${expenseSection}
      ${commentSection}
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:32px;padding-top:16px;border-top:2px solid #000">
        ${[['Prepared by (Cashier)',preparedBy],['Checked by',''],['Printed by',printedBy]].map(([label,name])=>`
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;margin-top:16px;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px">${bizName} — Confidential</span>
        <span style="font-size:9px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(()=>{ w.print(); w.close(); },300); }
  };

  // ── Voucher modal helpers ──────────────────────────────────────────
  const openVoucherForm = (currency = null) => { setVoucherDefaultCcy(currency); setShowVoucher(true); };

  // Called by PaymentVoucherFormModal after a successful save.
  // v1.8.20 — refresh ALL daily-derived state so the new expense flows into
  // every per-currency card immediately (not just the legacy single field).
  // v1.8.21 — also refresh the Counted auto-fill since adding an expense
  // changes the expected drawer balance.
  const handleVoucherSaved = async () => {
    const daily = await fetchDaily(date);
    if (daily) {
      const cidNum = parseInt(selectedCashier) || 0;
      let exNet = { usd_net: 0, fra_net: 0, k_net: 0 };
      try {
        const r = await getCurrencyExchangesNet({ scope: 'drawer', date, cashier_id: cidNum });
        exNet = r.data || exNet;
      } catch {}
      const usdDrawer = (parseFloat(daily.usd_received || 0) || 0) - (parseFloat(daily.usd_expenses || 0) || 0) + (parseFloat(exNet.usd_net || 0) || 0);
      const fraDrawer = (parseFloat(daily.fra_received || 0) || 0) - (parseFloat(daily.fra_expenses || 0) || 0) + (parseFloat(exNet.fra_net || 0) || 0);
      const kDrawer   = (parseFloat(daily.k_received   || 0) || 0) - (parseFloat(daily.k_expenses   || 0) || 0) + (parseFloat(exNet.k_net   || 0) || 0);
      setForm(prev => ({
        ...prev,
        expenses: daily.expenses || '',
        usd_received: usdDrawer ? usdDrawer.toFixed(2) : '',
        fra_received: fraDrawer ? fraDrawer.toFixed(0) : '',
        k_received:   kDrawer   ? kDrawer.toFixed(0)   : '',
      }));
      setExpensesByCcy({
        usd: parseFloat(daily.usd_expenses || 0) || 0,
        fra: parseFloat(daily.fra_expenses || 0) || 0,
        k:   parseFloat(daily.k_expenses   || 0) || 0,
      });
      setExpectedByCcy({
        usd: parseFloat(daily.usd_received || 0) || 0,
        fra: parseFloat(daily.fra_received || 0) || 0,
        k:   parseFloat(daily.k_received   || 0) || 0,
      });
      setExchangeNet(exNet);
      setCreditExpected(parseFloat(daily.credit_sales || 0) + parseFloat(daily.pending || 0));
    }
    setEditMode(true);
  };
  // ──────────────────────────────────────────────────────────────────

  const formatDate = (d) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const formatDateLong = (d) => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Always derive status from the live difference — never trust the saved status field
  const computedDiff = parseFloat(form.difference) || 0;
  const computedStatus = getStatus(computedDiff);

  const statusColor = (s) => {
    if (s === 'OK') return '#16a34a';
    if (s === 'Surplus') return '#2563eb';
    if (s === 'Slight Surplus') return '#0891b2';
    if (s === 'Slight Short') return '#d97706';
    return '#dc2626';
  };
  const statusBadge = (s) => {
    if (s === 'OK') return 'badge-green';
    if (s === 'Surplus' || s === 'Slight Surplus') return 'badge-blue';
    if (s === 'Slight Short') return 'badge-yellow';
    return 'badge-red';
  };
  const statusBg = (s) => {
    if (s === 'OK') return '#f0fdf4';
    if (s === 'Surplus') return '#eff6ff';
    if (s === 'Slight Surplus') return '#ecfeff';
    if (s === 'Slight Short') return '#fffbeb';
    return '#fef2f2';
  };
  const statusBorder = (s) => {
    if (s === 'OK') return '#86efac';
    if (s === 'Surplus') return '#93c5fd';
    if (s === 'Slight Surplus') return '#a5f3fc';
    if (s === 'Slight Short') return '#fde68a';
    return '#fca5a5';
  };

  const inputStyle = (editable) => ({
    background: editable ? '#fff' : '#f3f4f6',
    fontWeight: editable ? 400 : 600,
  });

  const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Derive unique years from saved reports for the year dropdown
  const availableYears = [...new Set(
    reports.map(r => r.date ? new Date(r.date + 'T12:00:00').getFullYear() : null).filter(Boolean)
  )].sort((a, b) => b - a);
  if (availableYears.length === 0) availableYears.push(new Date().getFullYear());

  // Apply month / year / device filter to history
  const filteredReports = reports.filter(r => {
    if (!r.date) return false;
    const d = new Date(r.date + 'T12:00:00');
    const okMonth  = filterMonth === 0 || (d.getMonth() + 1) === filterMonth;
    const okYear   = filterYear  === 0 || d.getFullYear()    === filterYear;
    const okUser = filterUser === 'all' || String(r.cashier_id ?? 0) === String(filterUser);
    return okMonth && okYear && okUser;
  });

  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  return (
    <div className="page-content">
      {/* ── Page Header ─────────────────────────────────────────── */}
      <div className="page-header no-print">
        <div>
          <h1>{t('cashReport')}</h1>
          <p>{t('cashReportSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 12px' }}>
            <FiCalendar style={{ color: '#9ca3af' }} />
            <input type="date" value={date} onChange={async e => {
              const d = e.target.value;
              const firstId = await fetchSalesCashiers(d);
              loadDate(d, firstId);
            }} style={{ border: 'none', outline: 'none', fontSize: 14 }} />
          </div>
          <select
            value={selectedCashier}
            onChange={e => { setSelectedCashier(e.target.value); loadDate(date, e.target.value); }}
            style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, background: '#fff', color: '#374151' }}
          >
            {salesCashiers.length === 0 && <option value="">{t('noSalesToday')}</option>}
            {salesCashiers.map(u => (
              <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
            ))}
          </select>
          <button
            onClick={openPrintPreview}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '9px 18px', borderRadius: 8, border: '1.5px solid #e5e7eb',
              background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 500, color: '#374151',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#6b7280'; e.currentTarget.style.background = '#f9fafb'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#e5e7eb'; e.currentTarget.style.background = '#fff'; }}
          >
            <FiPrinter size={16} /> {t('print')}
          </button>
        </div>
      </div>

      {/* v1.8.22 — Top KPI bar: 3 cards (USD / FRA / K) showing today's
          totals across ALL cashiers. Liquor-style summary but per-currency
          instead of a single $ figure. Drives off daySummaryByCcy which
          aggregates POS net (expected) + sum of saved cash report counted
          per currency.
          v1.10.38 — Liquor branches (Lusaka, Mansa) collapse the three
          per-method tiles into three roll-up totals (Total Expected /
          Total Cash Received / Difference), matching the legacy Liquor
          Cash Report top strip. Per-method reconciliation cards below
          already carry the drilldown; the top tiles are now for a
          bird's-eye view instead of duplicating the drilldown numbers. */}
      <div className="no-print" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
        {isLiquorStyle ? (() => {
          const num = (v) => parseFloat(v || 0) || 0;
          const methods = ['cash', 'momo', 'bank'];
          const totalIn = (m) => num(daySummaryByCcy[m]?.counted) + num(daySummaryByCcy[m]?.expenses) - num(exchangeNetAll[`${m}_net`]);
          const totalExpected = methods.reduce((s, m) => s + num(daySummaryByCcy[m]?.expected), 0);
          const totalReceived = methods.reduce((s, m) => s + totalIn(m), 0);
          const diff          = totalReceived - totalExpected;
          const isOk          = Math.abs(diff) < 0.01;
          const status        = isOk ? '✓ Balanced' : diff > 0 ? 'Over' : 'Short';
          const fmt           = (n) => `${curSym}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          // Difference tile colour swaps with sign so the state reads at a glance.
          const diffBg = isOk
            ? 'linear-gradient(135deg,#16a34a,#15803d)'
            : diff > 0
              ? 'linear-gradient(135deg,#16a34a,#15803d)'
              : 'linear-gradient(135deg,#dc2626,#b91c1c)';
          const diffShadow = isOk || diff > 0 ? '#16a34a40' : '#dc262640';
          const tiles = [
            { key: 'expected', label: 'Total Expected',       big: fmt(totalExpected), sub: methodsLabel,                 bg: 'linear-gradient(135deg,#2563eb,#1d4ed8)', shadow: '#2563eb40' },
            { key: 'received', label: 'Total Cash Received',  big: fmt(totalReceived), sub: methodsLabel,                 bg: 'linear-gradient(135deg,#16a34a,#15803d)', shadow: '#16a34a40' },
            { key: 'diff',     label: 'Difference',           big: `${diff > 0 ? '+' : diff < 0 ? '-' : ''}${fmt(Math.abs(diff))}`, sub: status, bg: diffBg, shadow: diffShadow },
          ];
          return tiles.map(t => (
            <div key={t.key} style={{ borderRadius: 12, padding: '14px 18px', background: t.bg, color: '#fff', boxShadow: `0 4px 16px ${t.shadow}`, position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', right: -10, top: -10, width: 60, height: 60, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
              <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                {t.label}
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, whiteSpace: 'nowrap', marginBottom: 4 }}>{t.big}</div>
              <div style={{ fontSize: 11, opacity: 0.85 }}>{t.sub}</div>
            </div>
          ));
        })() : (
          [
            { ccy: 'USD',  symbol: '$',    dec: 2, label: 'USD',  color: '#16a34a', bg: 'linear-gradient(135deg,#16a34a,#15803d)', show: showUSDccy },
            { ccy: 'FRA',  symbol: '',     dec: 0, label: 'FRA',  color: '#7c3aed', bg: 'linear-gradient(135deg,#7c3aed,#6d28d9)', show: showFRAccy },
            { ccy: 'K',    symbol: '',     dec: 0, label: 'K',    color: '#ea580c', bg: 'linear-gradient(135deg,#ea580c,#c2410c)', show: showKccy },
          ].filter(c => c.show).map(c => {
            const key      = c.ccy.toLowerCase();
            const expected = parseFloat(daySummaryByCcy[key]?.expected || 0) || 0;
            const counted  = parseFloat(daySummaryByCcy[key]?.counted  || 0) || 0;
            const expenses = parseFloat(daySummaryByCcy[key]?.expenses || 0) || 0;
            const exch     = parseFloat(exchangeNetAll[`${key}_net`] || 0) || 0;
            // v1.8.84 — Total cash in = Counted + Expenses − exch_net (sales-only inflow).
            const totalIn  = counted + expenses - exch;
            const diff     = totalIn - expected;
            const eps      = c.dec === 2 ? 0.01 : 1;
            const isOk     = Math.abs(diff) < eps;
            const status   = isOk ? '✓ Balanced' : diff > 0 ? 'Over' : 'Short';
            const fmt      = (n) => `${c.symbol}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: c.dec, maximumFractionDigits: c.dec })}`;
            return (
              <div key={c.ccy} style={{ borderRadius: 12, padding: '14px 18px', background: c.bg, color: '#fff', boxShadow: `0 4px 16px ${c.color}40`, position: 'relative', overflow: 'hidden' }}>
                <div style={{ position: 'absolute', right: -10, top: -10, width: 60, height: 60, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
                <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.85, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
                  {c.label} — All Cashiers
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ opacity: 0.9, fontSize: 11 }}>Total cash in</span>
                    <strong style={{ fontSize: 18, whiteSpace: 'nowrap' }}>{fmt(totalIn)}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', opacity: 0.75 }}>
                    <span style={{ fontSize: 11 }}>Expected sales</span>
                    <span style={{ fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}>{fmt(expected)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                    <strong style={{ background: 'rgba(255,255,255,0.22)', padding: '3px 10px', borderRadius: 6, fontSize: 12 }}>
                      {status} {!isOk ? ` ${diff > 0 ? '+' : ''}${fmt(diff)}` : ''}
                    </strong>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* v1.8.11 — old single-currency Top bar disabled. */}
      {false && (() => {
        const diff = daySummary.totalCash - daySummary.totalExpected;
        const diffColor = diff === 0 ? '#6b7280' : diff > 0 ? '#16a34a' : '#dc2626';
        const fmtS = (v) => Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return (
          <div className="no-print" style={{
            display: 'flex', gap: 0, marginBottom: 16,
            border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden',
            background: '#f9fafb', fontSize: 13,
          }}>
            {[
              { label: t('totalExpectedAll'), value: `${curSym}${fmtS(daySummary.totalExpected)}`, color: '#374151', bg: '#f9fafb' },
              { label: t('totalCashReceived'), value: `${curSym}${fmtS(daySummary.totalCash)}`, color: '#374151', bg: '#f9fafb' },
              { label: t('difference'), value: `${diff >= 0 ? '+' : '−'}${curSym}${fmtS(diff)}`, color: diffColor, bg: diff === 0 ? '#f9fafb' : diff > 0 ? '#f0fdf4' : '#fef2f2' },
            ].map((item, i, arr) => (
              <div key={item.label} style={{
                flex: 1, padding: '8px 16px',
                borderRight: i < arr.length - 1 ? '1px solid #e5e7eb' : 'none',
                background: item.bg,
              }}>
                <div style={{ fontSize: 11, color: '#9ca3af', fontWeight: 500, marginBottom: 2 }}>{item.label}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: item.color }}>{item.value}</div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* ── Cash Report Form ─────────────────────────────────────── */}
      <div className="card" id="cash-report-print" style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h3 style={{ fontSize: 16, fontWeight: 600 }}>{t('reportFor')} {formatDate(date)}</h3>
          <div style={{ display: 'flex', gap: 8 }} className="no-print">
            {!editMode && (
              <button className="btn btn-secondary" onClick={() => setEditMode(true)}>
                <FiEdit2 /> {t('edit')}
              </button>
            )}
            {/* v1.10.9 — Admin-only delete of the saved snapshot. After delete,
                the bottom per-currency cards fall back to live daily figures. */}
            {!editMode && savedReportId && (
              <button
                className="btn"
                onClick={() => setPendingDelete({
                  id: savedReportId,
                  subject: `saved cash report for ${formatDate(date)}${autoDepositOn ? ` — its deposits to ${depositTo.label} that are still waiting are removed too` : ''}`,
                  actionLabel: 'Delete saved report',
                })}
                style={{ background: '#fff', color: '#dc2626', border: '1px solid #fecaca' }}
                title="Delete the saved snapshot — requires admin password"
              >
                <FiTrash2 /> Delete saved
              </button>
            )}
            {editMode && (
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                <FiSave /> {saving ? 'Saving...' : 'Save Report'}
              </button>
            )}
          </div>
        </div>

        {message && (
          <div style={{ color: message.includes('success') ? '#16a34a' : '#dc2626', marginBottom: 12, fontSize: 13 }}>
            {message}
          </div>
        )}

        {/* v1.9.33 — lowered min-width from 320px to 240px so all four
            cards (3 method + Credit Sales) sit on one row on a normal
            laptop viewport. Below ~1000px content width the grid
            gracefully falls back to 2 columns.
            v1.10.35 — force a single full-width column on mobile so
            USD + K stop getting clipped off-screen on tri-currency
            Kelete phones (only FRA was visibly rendering before).
            v1.10.36 — v1.10.35's JS-only breakpoint wasn't enough: some
            ancestor was letting the grid container inherit a width
            wider than the viewport (from horizontal-overflow content
            elsewhere on the page), so auto-fit still committed to
            multiple columns and USD + K were pushed off-screen inside
            the parent's overflow. Now: className + inline media-query
            style forces `grid-template-columns: 1fr` at <=767px, and
            `min-width: 0` on the grid + children breaks intrinsic
            width propagation from any wide descendant. */}
        {/* v1.10.37 — real diagnosis (finally):
            Report History table below has 13 columns, no mobile scroll
            wrapper, forces .page-content wider than the viewport. My grid
            inherits that oversized parent width, and `max-width: 100%`
            from index.css:1885 caps to the OVERSIZED parent, not the
            viewport — so auto-fit still commits to 3 columns and USD + K
            sit off-screen inside the horizontal overflow. FRA (middle) is
            what a phone screen happens to land on.
            Fix: 100vw is VIEWPORT-relative, not parent-relative. It caps
            the grid to the actual screen width no matter how wide any
            ancestor stretches. */}
        <style>{`
          @media (max-width: 767px) {
            .cash-report-cards-grid {
              grid-template-columns: 1fr !important;
              max-width: 100vw !important;
              min-width: 0 !important;
              box-sizing: border-box !important;
            }
            .cash-report-cards-grid > * {
              min-width: 0 !important;
              max-width: 100% !important;
            }
          }
        `}</style>
        <div className="cash-report-cards-grid" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 16, marginBottom: 16, minWidth: 0 }}>
          {/* v1.8.18 — per-currency reconciliation cards with view/+ icons
              for that currency's expenses inside the card. No more shared
              'Expenses Paid From Drawer' row below — each card owns its
              own currency's PV view + add. */}
          {/* v1.9.30 — Liquor branches show 3 method counter cards
              (Cash / MoMo / Bank); Kelete branches keep the per-currency
              cards (gated by currency_mode). Counter form keys still
              re-use the legacy *_received columns — backend repurposes
              them as method buckets on Liquor branches. */}
          {[
            { key: 'usd_received', label: 'USD Cash ($)',  ccy: 'USD',  symbol: '$',     dec: 2, posExp: expectedByCcy.usd,    exp: expensesByCcy.usd, exch: exchangeNet.usd_net, step: '0.01', color: '#16a34a', bg: '#f0fdf4', show: showUSDccy },
            { key: 'fra_received', label: 'FRA Cash',      ccy: 'FRA',  symbol: '',      dec: 0, posExp: expectedByCcy.fra,    exp: expensesByCcy.fra, exch: exchangeNet.fra_net, step: '1',    color: '#7c3aed', bg: '#faf5ff', show: showFRAccy },
            { key: 'k_received',   label: 'K Cash',        ccy: 'K',    symbol: '',      dec: 0, posExp: expectedByCcy.k,      exp: expensesByCcy.k,   exch: exchangeNet.k_net,   step: '1',    color: '#ea580c', bg: '#fff7ed', show: showKccy   },
            // v1.10.31 — Liquor cards now surface expenses. Storage mapping
            // (matches PaymentVoucherFormModal): Cash → usd_amount, MoMo →
            // fra_amount, Bank → k_amount. Previously `exp: 0` hid every PV
            // saved from this page from the "+ Expenses paid" line, so a
            // cashier who registered a K5,000 expense saw nothing move.
            { key: 'usd_received', label: 'Cash',          ccy: 'CASH', symbol: curSym,  dec: 2, posExp: expectedByMethod.cash, exp: expensesByCcy.usd, exch: 0, step: '0.01', color: '#16a34a', bg: '#f0fdf4', show: isLiquorStyle },
            // 2026-09-11 — a hidden method's card shows only if money sits on it.
            { key: 'fra_received', label: 'Mobile Money',  ccy: 'MOMO', symbol: curSym,  dec: 2, posExp: expectedByMethod.momo, exp: expensesByCcy.fra, exch: 0, step: '0.01', color: '#ea580c', bg: '#fff7ed', show: isLiquorStyle && (methodShown('momo') || hasMoney(expectedByMethod.momo, expensesByCcy.fra, form.fra_received)) },
            { key: 'k_received',   label: 'Bank',          ccy: 'BANK', symbol: curSym,  dec: 2, posExp: expectedByMethod.bank, exp: expensesByCcy.k,   exch: 0, step: '0.01', color: '#2563eb', bg: '#eff6ff', show: isLiquorStyle && (methodShown('bank') || hasMoney(expectedByMethod.bank, expensesByCcy.k, form.k_received)) },
          ].filter(c => c.show).map(c => {
            const counted     = parseFloat(form[c.key] || 0) || 0;
            const exch        = parseFloat(c.exch || 0) || 0;
            // v1.8.84 — new model: Total cash in = Counted + Expenses − exch_net.
            // (Reverses the drawer-side exchange to recover sales-only inflow.)
            // Diff = Total cash in − Expected sales (POS net). Same numerical
            // diff as before, just framed as "what we reconstructed from cash"
            // vs "what POS says we sold".
            const totalCashIn = counted + c.exp - exch;
            const diff        = totalCashIn - c.posExp;
            const eps         = c.dec === 2 ? 0.01 : 1;
            const isOk        = Math.abs(diff) < eps;
            const status      = isOk ? 'OK' : diff > 0 ? 'Over' : 'Short';
            const fmt         = (n) => `${c.symbol}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: c.dec, maximumFractionDigits: c.dec })}`;
            const exchAdj     = -exch; // sign flipped for display: drawer +exch → −exchAdj on sales side
            const footerBg    = isOk ? '#dcfce7' : diff > 0 ? '#fef3c7' : '#fee2e2';
            const footerBorder= isOk ? '#86efac' : diff > 0 ? '#fde68a' : '#fecaca';
            const footerColor = isOk ? '#15803d' : diff > 0 ? '#a16207' : '#991b1b';
            return (
              <div key={c.key} style={{
                background: '#fff',
                border: `1px solid ${c.color}30`,
                borderRadius: 12,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
              }}>
                {/* Header strip — solid currency color */}
                <div style={{
                  background: c.color, color: '#fff',
                  padding: '10px 14px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span style={{ fontWeight: 800, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {c.label}
                  </span>
                  <div className="no-print" style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={() => openExpensesList(c.ccy)}
                      title={`View ${c.ccy} expenses`}
                      style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid rgba(255,255,255,0.5)', background: 'rgba(255,255,255,0.15)', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <FiEye size={13} />
                    </button>
                    <button
                      onClick={() => openVoucherForm(c.ccy)}
                      disabled={!selectedCashier}
                      title={!selectedCashier ? 'Select a cashier first' : `Add ${c.ccy} expense voucher`}
                      style={{ width: 26, height: 26, borderRadius: 6, border: '1px solid rgba(255,255,255,0.5)', background: selectedCashier ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.3)', color: selectedCashier ? c.color : '#fff', cursor: selectedCashier ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
                      <FiPlus size={14} />
                    </button>
                  </div>
                </div>

                {/* Body */}
                <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Counted input — the only editable field */}
                  <div>
                    <label style={{ fontSize: 10, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>Cashier counted</label>
                    <input type="number" value={form[c.key]}
                      onChange={e => setForm({ ...form, [c.key]: e.target.value })}
                      disabled={!editMode} placeholder={c.dec === 2 ? '0.00' : '0'} step={c.step}
                      style={{ ...inputStyle(editMode), marginTop: 4, fontSize: 18, fontWeight: 700, color: '#111827' }} />
                  </div>

                  {/* Breakdown → Total cash in (bookable to CR).
                      v1.8.86 — 2-col grid pulled left (maxWidth 260) so the
                      number sits closer to the label instead of stuck at the
                      card's right edge. Dead space on right is intentional. */}
                  <div style={{
                    fontSize: 12, color: '#475569',
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    columnGap: 16,
                    rowGap: 6,
                    maxWidth: 260,
                  }}>
                    <span>+ Expenses paid</span>
                    <span style={{ color: c.exp > 0 ? '#374151' : '#9ca3af', fontWeight: 600, whiteSpace: 'nowrap', textAlign: 'right' }}>{fmt(c.exp)}</span>

                    <span>± Drawer exchanges</span>
                    <span style={{ color: exch !== 0 ? '#7c3aed' : '#9ca3af', fontWeight: 600, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {exchAdj > 0 ? '+' : ''}{fmt(exchAdj)}
                    </span>

                    <div style={{ gridColumn: '1 / span 2', borderTop: '1px solid #e5e7eb', marginTop: 2 }} />

                    <span style={{ fontWeight: 700, fontSize: 13, color: '#111827', paddingTop: 4 }}>= Total cash in</span>
                    <span style={{ fontWeight: 800, fontSize: 17, color: c.color, whiteSpace: 'nowrap', textAlign: 'right', paddingTop: 4 }}>{fmt(totalCashIn)}</span>

                    <span style={{ color: '#9ca3af', fontSize: 11, paddingTop: 2 }}>Expected sales (POS)</span>
                    <span style={{ color: '#9ca3af', fontWeight: 500, fontSize: 12, whiteSpace: 'nowrap', textAlign: 'right', paddingTop: 2 }}>{fmt(c.posExp)}</span>
                  </div>
                </div>

                {/* Footer Diff strip — full-width rounded bottom.
                    v1.8.86 — inner pair wrapped in maxWidth: 260 so status +
                    diff value pull left, matching the breakdown above. */}
                <div style={{
                  background: footerBg,
                  borderTop: `1px solid ${footerBorder}`,
                  padding: '10px 16px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', maxWidth: 260 }}>
                    <span style={{ fontSize: 11, color: footerColor, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {isOk ? '✓ Balanced' : status}
                    </span>
                    <span style={{ color: footerColor, fontWeight: 800, fontSize: 14, whiteSpace: 'nowrap' }}>
                      {diff > 0 ? '+' : ''}{fmt(diff)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}

          {/* v1.8.18 — standalone Expenses row removed. Each currency's view/+
              now lives INSIDE the per-currency card above for clearer linkage
              (USD card → USD expenses, FRA card → FRA expenses, etc.). */}

          {/* v1.8.85 — Credit Sales card, redesigned to match the cash-card
              template. Read-only mirror of POS credit issued today; no diff
              (always balances by definition); no expenses/exchanges (not
              physical cash). Red across the board to signal "owed, not held". */}
          {(() => {
            const counted = creditExpected;
            // v1.9.32 — use the branch's primary currency symbol so the
            // Credit Sales card reads K… on Mansa/Lusaka and $… on
            // Kassumbalesa instead of always hardcoding $.
            const fmt     = (n) => `${curSym}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            return (
              <div style={{
                background: '#fff',
                border: '1px solid #fecaca',
                borderRadius: 12,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
              }}>
                {/* Header strip — red */}
                <div style={{
                  background: '#dc2626', color: '#fff',
                  padding: '10px 14px',
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                }}>
                  <span style={{ fontWeight: 800, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    Credit Sales ({curSym})
                  </span>
                  <span style={{ fontSize: 9, opacity: 0.95, background: 'rgba(255,255,255,0.2)', padding: '3px 8px', borderRadius: 4, fontWeight: 700, letterSpacing: 0.4 }}>
                    AUTO · READ-ONLY
                  </span>
                </div>

                {/* Body */}
                <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <div>
                    <label style={{ fontSize: 10, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>From POS orders</label>
                    <div style={{
                      marginTop: 4, padding: '8px 12px',
                      border: '1px solid #e5e7eb',
                      borderRadius: 6,
                      background: '#f9fafb',
                      fontSize: 18, fontWeight: 700, color: '#111827',
                    }}>
                      {fmt(counted)}
                    </div>
                  </div>

                  {/* v1.8.86 — pulled-left layout to match cash cards (Option C). */}
                  <div>
                    <div style={{
                      fontSize: 12, color: '#475569',
                      display: 'grid',
                      gridTemplateColumns: '1fr auto',
                      columnGap: 16,
                      rowGap: 6,
                      maxWidth: 260,
                      borderTop: '1px solid #e5e7eb',
                      paddingTop: 8,
                    }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: '#111827' }}>= Becomes receivable</span>
                      <span style={{ fontWeight: 800, fontSize: 17, color: '#dc2626', whiteSpace: 'nowrap', textAlign: 'right' }}>{fmt(counted)}</span>
                    </div>
                    <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af', lineHeight: 1.45 }}>
                      Credit owed by customers from today's sales. Not cash — does not affect any drawer.
                    </div>
                  </div>
                </div>

                {/* Footer — red strip, mirrors cash card pulled-left layout */}
                <div style={{
                  background: '#fef2f2',
                  borderTop: '1px solid #fecaca',
                  padding: '10px 16px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', maxWidth: 260 }}>
                    <span style={{ fontSize: 11, color: '#991b1b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      📋 Receivable (AR)
                    </span>
                    <span style={{ color: '#991b1b', fontWeight: 800, fontSize: 14, whiteSpace: 'nowrap' }}>
                      {fmt(counted)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}
          {/* v1.8.11 — single Total/Expected/Difference/Status fields removed.
              Reconciliation lives under each currency card above. The form
              still saves total/expected/difference/status for backwards
              compat (USD-only bucket; FRA/K reconcile per-currency only). */}
          {/* 2026-09-15 — the whole row, not "span 2". On a phone the grid is one
              column; span 2 made the browser add a second one, so Cash and Bank
              were squeezed into a thin left column beside Mobile Money and Credit. */}
          <div className="form-group" style={{ gridColumn: '1 / -1' }}>
            <label>Comment</label>
            <input value={form.comment}
              onChange={e => setForm({ ...form, comment: e.target.value })}
              disabled={!editMode} placeholder="Optional notes..."
              style={inputStyle(editMode)} />
          </div>
        </div>
      </div>

      {/* v1.8.76 — Customer Over / Under Payments (drawer net). Combines:
          • Over-Collections kept in drawer (per source currency, native amount)
          • Under-Payments silently absorbed (walk-in tolerance shortages, USD-attributed)
          Shows NET drift per currency so the shop sees daily gain/loss explicitly.
          v1.10.81 — HIDDEN on Liquor tenants. The panel was designed for
          Kassumbalesa's 3-station flow where the cashier explicitly types
          "Change USD / Change FRA" and any leftover is the real drawer surplus.
          Liquor POS's Pay modal is a single read-only "Change" line — the
          cashier hands cash to the customer, nothing is kept. Rendering the
          panel there would show fabricated "shop gain" from the backend's
          fallback (given_* fields never sent → whole change counted as
          kept). Reference Liquor project doesn't have the panel at all. */}
      {!isLiquorStyle && (overpaidRows.length > 0
        || overpaidByCcy.usd > 0 || overpaidByCcy.fra > 0 || overpaidByCcy.k > 0
        || underpaidByCcy.usd > 0 || underpaidByCcy.fra > 0 || underpaidByCcy.k > 0
       ) && (() => {
        // v1.8.77 — net per currency = over − under (both per source currency)
        const netUSD = (overpaidByCcy.usd || 0) - (underpaidByCcy.usd || 0);
        const netFRA = (overpaidByCcy.fra || 0) - (underpaidByCcy.fra || 0);
        const netK   = (overpaidByCcy.k   || 0) - (underpaidByCcy.k   || 0);
        // ≈ USD equivalent of net drift (FRA/K converted at sell rate from the latest row that has one)
        const sampleRow = overpaidRows.find(r => parseFloat(r.selling_rate_used) > 0);
        const sampleK   = overpaidRows.find(r => parseFloat(r.selling_rate_k_used) > 0);
        const sellRate  = sampleRow ? parseFloat(sampleRow.selling_rate_used)   : 0;
        const sellRateK = sampleK   ? parseFloat(sampleK.selling_rate_k_used)   : 0;
        const netUSDeq = netUSD
                      + (sellRate  > 0 ? netFRA / sellRate  : 0)
                      + (sellRateK > 0 ? netK   / sellRateK : 0);
        const fmtN = (n, dec, sym) => {
          const s = n >= 0 ? '+' : '−';
          const a = Math.abs(n);
          return `${s}${sym}${a.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
        };
        const colorFor = (n) => Math.abs(n) < 0.005 ? '#6b7280' : (n > 0 ? '#16a34a' : '#dc2626');
        return (
          <div style={{ marginTop: 16, padding: '14px 18px', background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 8 }}>
              💰 Customer Over / Under Payments (drawer net)
            </div>
            {/* Summary lines */}
            <div style={{ fontSize: 12, color: '#78350f', display: 'grid', gap: 4, marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid #fde68a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Over-Collections (kept in drawer):</span>
                <span>
                  USD <strong>+${(overpaidByCcy.usd || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                  {' · '}FRA <strong>+{(overpaidByCcy.fra || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
                  {' · '}K <strong>+{(overpaidByCcy.k || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Under-Payments (absorbed):</span>
                <span>
                  USD <strong style={{ color: underpaidByCcy.usd > 0 ? '#dc2626' : '#78350f' }}>−${(underpaidByCcy.usd || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                  {' · '}FRA <strong style={{ color: underpaidByCcy.fra > 0.5 ? '#dc2626' : '#78350f' }}>−{(underpaidByCcy.fra || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
                  {' · '}K <strong style={{ color: underpaidByCcy.k > 0.5 ? '#dc2626' : '#78350f' }}>−{(underpaidByCcy.k || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, paddingTop: 4, borderTop: '1px dashed #fde68a' }}>
                <span>NET drift today:</span>
                <span>
                  USD <span style={{ color: colorFor(netUSD) }}>{fmtN(netUSD, 2, '$')}</span>
                  {' · '}FRA <span style={{ color: colorFor(netFRA) }}>{fmtN(netFRA, 0, '')}</span>
                  {' · '}K <span style={{ color: colorFor(netK) }}>{fmtN(netK, 0, '')}</span>
                  {Math.abs(netUSDeq) > 0.005 && (
                    <span style={{ marginLeft: 10, color: colorFor(netUSDeq), fontStyle: 'italic' }}>
                      ≈ {fmtN(netUSDeq, 2, '$')} {netUSDeq > 0 ? 'shop gain' : 'shop loss'}
                    </span>
                  )}
                </span>
              </div>
            </div>
            {/* Per-order rows */}
            {overpaidRows.length > 0 && (
              <div style={{ overflow: 'auto' }}>
                <table className="phone-cards" style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fef3c7', color: '#78350f' }}>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>Order</th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>Customer</th>
                      <th style={{ padding: '6px 8px', textAlign: 'left' }}>Cashier</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Sale</th>
                      <th style={{ padding: '6px 8px', textAlign: 'right' }}>Kept / Absorbed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overpaidRows.map(r => {
                      const amt = parseFloat(r.amt || 0);
                      const ccy = r.ccy || '—';
                      const sym = ccy === 'USD' ? '$' : '';
                      const dec = ccy === 'USD' ? 2 : 0;
                      const isOver = r.direction === 'OVER';
                      const sign  = isOver ? '+' : '−';
                      const arrow = isOver ? '↑' : '↓';
                      const colour = isOver ? '#16a34a' : '#dc2626';
                      return (
                        <tr key={`${r.direction}-${r.id}`} style={{ borderTop: '1px solid #fde68a' }}>
                          <td style={{ padding: '6px 8px', color: '#374151' }}>{fmtInvoiceNo(r.order_number)}</td>
                          <td style={{ padding: '6px 8px', color: '#374151' }}>{r.customer_name || '—'}</td>
                          <td style={{ padding: '6px 8px', color: '#374151' }}>{r.cashier_name || '—'}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#6b7280' }}>${parseFloat(r.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 700, color: colour }}>{ccy} {sign}{sym}{amt.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })} {arrow}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })()}

      {/* v1.8.6 — Currency Exchanges for this date+cashier (drawer scope).
          v1.9.32 — Hidden on Liquor branches (Mansa/Lusaka) — K-only
          branches have no USD↔FRA exchanges to track. */}
      {!isLiquorStyle && (
        <CurrencyExchangePanel
          scope="drawer"
          date={date}
          cashierId={selectedCashier ? parseInt(selectedCashier) : 0}
          user={authUser}
          title="Currency Exchanges (Drawer)"
          drawerBalance={{
            USD: (parseFloat(form.usd_received || 0) || 0) + (parseFloat(exchangeNet.usd_net || 0) || 0),
            FRA: (parseFloat(form.fra_received || 0) || 0) + (parseFloat(exchangeNet.fra_net || 0) || 0),
            K:   (parseFloat(form.k_received   || 0) || 0) + (parseFloat(exchangeNet.k_net   || 0) || 0),
          }}
          onChanged={() => { setExchangeRefreshKey(k => k + 1); handleVoucherSaved(); }}
        />
      )}
      {(exchangeNet.usd_net || exchangeNet.fra_net || exchangeNet.k_net) && (
        <div style={{ marginTop: 10, padding: '10px 14px', background: '#f5f3ff', border: '1px solid #ddd6fe', borderRadius: 10, fontSize: 12, color: '#5b21b6' }}>
          <strong>Net drawer impact:</strong>{' '}
          USD <span style={{ fontWeight: 700, color: exchangeNet.usd_net >= 0 ? '#16a34a' : '#dc2626' }}>
            {exchangeNet.usd_net >= 0 ? '+' : ''}${parseFloat(exchangeNet.usd_net).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
          {' · '}
          FRA <span style={{ fontWeight: 700, color: exchangeNet.fra_net >= 0 ? '#16a34a' : '#dc2626' }}>
            {exchangeNet.fra_net >= 0 ? '+' : ''}{parseFloat(exchangeNet.fra_net).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
          {' · '}
          K <span style={{ fontWeight: 700, color: exchangeNet.k_net >= 0 ? '#16a34a' : '#dc2626' }}>
            {exchangeNet.k_net >= 0 ? '+' : ''}{parseFloat(exchangeNet.k_net).toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
          <span style={{ color: '#7c3aed', marginLeft: 8 }}>
            (v1.8.21 — now correctly factored into each currency card's Expected line)
          </span>
        </div>
      )}

      {/* ── History Filter Bar ───────────────────────────────────── */}
      <div className="no-print" style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        padding: '12px 16px', background: '#f8fafc',
        border: '1px solid #e5e7eb', borderRadius: 10,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginRight: 4 }}>Filter History:</span>

        {/* Month */}
        <select
          value={filterMonth}
          onChange={e => setFilterMonth(Number(e.target.value))}
          style={{
            padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db',
            fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer',
          }}
        >
          <option value={0}>All Months</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={i + 1}>{m}</option>
          ))}
        </select>

        {/* Year */}
        <select
          value={filterYear}
          onChange={e => setFilterYear(Number(e.target.value))}
          style={{
            padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db',
            fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer',
          }}
        >
          <option value={0}>All Years</option>
          {availableYears.map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>

        {/* Cashier */}
        {allSalesCashiers.length > 1 && (
          <select
            value={filterUser}
            onChange={e => setFilterUser(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }}
          >
            <option value="all">All</option>
            {allSalesCashiers.map(u => (
              <option key={u.id} value={u.id}>{u.first_name} {u.last_name}</option>
            ))}
          </select>
        )}

        {/* Clear */}
        {(filterMonth !== 0 || filterYear !== 0 || filterUser !== 'all') && (
          <button
            onClick={() => { setFilterMonth(0); setFilterYear(0); setFilterUser('all'); }}
            style={{
              padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb',
              fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer',
            }}
          >
            Clear
          </button>
        )}

        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {filteredReports.length} report{filteredReports.length !== 1 ? 's' : ''}
          {(filterMonth !== 0 || filterYear !== 0) && (
            <> — {filterMonth !== 0 ? MONTHS[filterMonth - 1] : ''}{filterMonth !== 0 && filterYear !== 0 ? ' ' : ''}{filterYear !== 0 ? filterYear : ''}</>
          )}
        </span>
      </div>

      {/* ── Summary Strip ────────────────────────────────────────── */}
      {/* On Liquor style: 3 flat tiles (Total Expected / Total Cash on Hand /
          Total Difference), matching the reference Liquor project. On
          Kelete tri-ccy style: keep the 3 gradient per-currency cards. */}
      {filteredReports.length > 0 && isLiquorStyle && (() => {
        const totalExpected    = filteredReports.reduce((s, r) => s + parseFloat(r.expected || 0), 0);
        // v1.13.20 — same live-compute as the row-level rowTotal below so
        // the tile matches the sum of the Total column in Report History.
        // The stored r.total is buggy on legacy rows (drops MoMo + Bank).
        const totalAfterChange = filteredReports.reduce((s, r) => {
          const usdR = parseFloat(r.usd_received || r.cash || 0);
          const fraR = parseFloat(r.fra_received || r.mobile_money || 0);
          const kR   = parseFloat(r.k_received   || r.bank || 0);
          const pend = parseFloat(r.pending || 0);
          const exp  = (parseFloat(r.usd_expenses || r.expenses || 0) || 0)
                     + (parseFloat(r.fra_expenses || 0) || 0)
                     + (parseFloat(r.k_expenses   || 0) || 0);
          return s + usdR + fraR + kR + pend + exp;
        }, 0);
        const totalDifference  = totalAfterChange - totalExpected;
        const diffStatus = getStatus(totalDifference);
        const summaryCards = [
          { label: 'Total Expected Cash', value: totalExpected,    color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
          { label: 'Total Cash on Hand',  value: totalAfterChange, color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
          { label: 'Total Difference',    value: totalDifference,
            color: totalDifference < 0 ? '#dc2626' : totalDifference > 0 ? '#16a34a' : '#6b7280',
            bg:    totalDifference < 0 ? '#fef2f2' : totalDifference > 0 ? '#f0fdf4' : '#f9fafb',
            border:totalDifference < 0 ? '#fecaca' : totalDifference > 0 ? '#bbf7d0' : '#e5e7eb',
            badge: diffStatus },
        ];
        return (
          <div className="no-print" style={{ display: 'flex', gap: 16, marginBottom: 20 }}>
            {summaryCards.map(card => (
              <div key={card.label} style={{
                flex: 1, padding: '18px 22px', borderRadius: 12,
                background: card.bg, border: `1.5px solid ${card.border}`,
                boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
              }}>
                <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 600, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 6 }}>
                  {card.label}
                </div>
                <div style={{ fontSize: 22, fontWeight: 700, color: card.color, letterSpacing: -0.5 }}>
                  {curSym}{Math.abs(card.value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  {card.badge && (
                    <span style={{
                      marginLeft: 10, fontSize: 11, fontWeight: 600,
                      padding: '2px 10px', borderRadius: 20,
                      background: card.color + '1a', color: card.color, verticalAlign: 'middle'
                    }}>{card.badge}</span>
                  )}
                </div>
                {card.label === 'Total Difference' && totalDifference !== 0 && (
                  <div style={{ fontSize: 11, color: card.color, marginTop: 4 }}>
                    {totalDifference < 0 ? '▼ Short' : '▲ Surplus'} by {curSym}{Math.abs(totalDifference).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </div>
                )}
              </div>
            ))}
          </div>
        );
      })()}
      {filteredReports.length > 0 && !isLiquorStyle && (() => {
        const sumCol = (col) => filteredReports.reduce((s, r) => s + (parseFloat(r[col] || 0) || 0), 0);
        const expU = sumCol('usd_expected');
        const expF = sumCol('fra_expected');
        const expK = sumCol('k_expected');
        const gotU = sumCol('usd_received') + filteredReports.reduce((s, r) => parseFloat(r.usd_received || 0) > 0 ? s : s + (parseFloat(r.cash || 0) || 0), 0);
        const gotF = sumCol('fra_received') + filteredReports.reduce((s, r) => parseFloat(r.fra_received || 0) > 0 ? s : s + (parseFloat(r.mobile_money || 0) || 0), 0);
        const gotK = sumCol('k_received')   + filteredReports.reduce((s, r) => parseFloat(r.k_received   || 0) > 0 ? s : s + (parseFloat(r.bank || 0) || 0), 0);
        const diffU = gotU - expU;
        const diffF = gotF - expF;
        const diffK = gotK - expK;
        const fmtU = (n) => `$${Math.abs(parseFloat(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const fmtN = (n) => Math.abs(Math.round(parseFloat(n || 0))).toLocaleString('en-US');
        const diffBadge = (d, eps) => Math.abs(d) < eps ? 'OK' : (d < 0 ? 'Short' : 'Surplus');
        const signed = (d, fmt) => `${d > 0 ? '+' : d < 0 ? '−' : ''}${fmt(d)}`;
        const Line = ({ label, val }) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, lineHeight: 1.7 }}>
            <span style={{ opacity: 0.9 }}>{label}</span><strong>{val}</strong>
          </div>
        );
        const Card = ({ ccy, bg, expected, received, diff, fmt, eps }) => (
          <div style={{ borderRadius: 14, padding: '14px 18px', background: bg, color: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,0.1)', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', right: -10, top: -10, width: 60, height: 60, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
            <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.9, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>{ccy} — PERIOD TOTALS</div>
            <Line label="Expected" val={fmt(expected)} />
            <Line label="On Hand"  val={fmt(received)} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, lineHeight: 1.7, marginTop: 4, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.2)' }}>
              <span style={{ opacity: 0.9 }}>Diff</span>
              <span>
                <strong>{signed(diff, fmt)}</strong>
                <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: 'rgba(255,255,255,0.22)' }}>{diffBadge(diff, eps)}</span>
              </span>
            </div>
          </div>
        );
        return (
          <div className="no-print" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginBottom: 20 }}>
            <Card ccy="USD" bg="linear-gradient(135deg,#22c55e,#15803d)" expected={expU} received={gotU} diff={diffU} fmt={fmtU} eps={0.01} />
            <Card ccy="FRA" bg="linear-gradient(135deg,#8b5cf6,#6d28d9)" expected={expF} received={gotF} diff={diffF} fmt={fmtN} eps={1} />
            <Card ccy="K"   bg="linear-gradient(135deg,#f97316,#c2410c)" expected={expK} received={gotK} diff={diffK} fmt={fmtN} eps={1} />
          </div>
        );
      })()}

      <div className="data-table-container no-print">
        <h3 style={{ padding: '12px 16px', fontSize: 15, fontWeight: 600, borderBottom: '1px solid #e5e7eb' }}>Report History</h3>
        <table className="data-table">
          <thead>
            {/* Report History columns.
                Liquor style → Bank | MoMo | Cash | Expenses | Credit |
                               Total | Expected | Diff | Status  (like reference Liquor).
                Kelete style  → per-currency columns (unchanged). */}
            <tr>
              <th>Date</th><th>Cashier</th>
              {isLiquorStyle ? (
                <>
                  {/* 2026-09-11 — a hidden method's column shows only if a row has money on it. */}
                  {(methodShown('bank') || filteredReports.some(x => hasMoney(x.k_received || x.bank))) && <th style={{ color: '#2563eb' }}>Bank ({curSym})</th>}
                  {(methodShown('momo') || filteredReports.some(x => hasMoney(x.fra_received || x.mobile_money))) && <th style={{ color: '#ea580c' }}>MoMo ({curSym})</th>}
                  <th style={{ color: '#16a34a' }}>Cash ({curSym})</th>
                  <th style={{ color: '#dc2626' }}>Expenses ({curSym})</th>
                  <th>Credit Sales</th>
                  <th>Total ({curSym})</th>
                  <th>Expected ({curSym})</th>
                  <th>Difference</th>
                  <th>Status</th>
                  <th>Comment</th>
                </>
              ) : (
                <>
                  <th style={{ color: '#16a34a' }}>USD ($)</th><th>Diff $</th>
                  <th style={{ color: '#7c3aed' }}>FRA</th><th>Diff FRA</th>
                  <th style={{ color: '#ea580c' }}>K</th><th>Diff K</th>
                  <th style={{ color: '#16a34a' }}>Exp $</th>
                  <th style={{ color: '#7c3aed' }}>Exp FRA</th>
                  <th style={{ color: '#ea580c' }}>Exp K</th>
                  <th>Credit Sales</th>
                  <th>Comment</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {filteredReports.length === 0 ? (
              <tr><td colSpan={isLiquorStyle ? 12 : 13} style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No reports found for the selected period.</td></tr>
            ) : filteredReports.map(r => {
              const usdR = parseFloat(r.usd_received || r.cash || 0);
              const fraR = parseFloat(r.fra_received || r.mobile_money || 0);
              const kR   = parseFloat(r.k_received   || r.bank || 0);
              const usdE = parseFloat(r.usd_expected || 0);
              const fraE = parseFloat(r.fra_expected || 0);
              const kE   = parseFloat(r.k_expected   || 0);
              const usdD = usdR - usdE;
              const fraD = fraR - fraE;
              const kD   = kR   - kE;
              // v1.8.26 — per-currency expense from new columns; fall back to
              // legacy single `expenses` for the USD bucket on old rows.
              const usdEx = parseFloat(r.usd_expenses || r.expenses || 0) || 0;
              const fraEx = parseFloat(r.fra_expenses || 0) || 0;
              const kEx   = parseFloat(r.k_expenses   || 0) || 0;
              const diffColor = (d, eps) => Math.abs(d) < eps ? '#16a34a' : d > 0 ? '#d97706' : '#dc2626';
              const sign = (d) => d > 0 ? '+' : '';
              const dash = <span style={{ color: '#cbd5e1' }}>—</span>;
              const fmtK = (n) => `${curSym}${parseFloat(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
              const totalExp = usdEx + fraEx + kEx;
              // v1.13.20 — compute rowTotal live using the reference Liquor
              // formula (Cash + MoMo + Bank + Credit Sales + Expenses).
              // The stored r.total is populated by an auto-calc effect that
              // uses the drop-MoMo/Bank formula (`usd + pend + exp`), so
              // rows saved before Kelete's save-time correction landed
              // (or where auto-calc won the race) had wrong totals. Live
              // computation heals every legacy row on display without
              // touching the DB.
              const rowTotal    = usdR + fraR + kR + parseFloat(r.pending || 0) + totalExp;
              const rowExpected = parseFloat(r.expected || 0) || 0;
              const rowDiff     = rowTotal - rowExpected;
              const rowStatus   = getStatus(rowDiff);
              return (
                <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => { const cid = r.cashier_id ? String(r.cashier_id) : ''; setSelectedCashier(cid); loadDate(r.date.split('T')[0], cid); }}>
                  <td style={{ fontWeight: 500 }}>{formatDate(r.date)}</td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>{r.cashier_name || '—'}</td>
                  {isLiquorStyle ? (
                    <>
                      {(methodShown('bank') || filteredReports.some(x => hasMoney(x.k_received || x.bank))) && <td>{fmtK(kR)}</td>}
                      {(methodShown('momo') || filteredReports.some(x => hasMoney(x.fra_received || x.mobile_money))) && <td>{fmtK(fraR)}</td>}
                      <td>{fmtK(usdR)}</td>
                      <td style={{ color: totalExp > 0 ? '#dc2626' : '' }}>{totalExp > 0 ? fmtK(totalExp) : dash}</td>
                      <td>{fmtK(parseFloat(r.pending || 0))}</td>
                      <td style={{ fontWeight: 600 }}>{fmtK(rowTotal)}</td>
                      <td style={{ fontWeight: 500 }}>{fmtK(rowExpected)}</td>
                      <td style={{ fontWeight: 600, color: statusColor(rowStatus) }}>{sign(rowDiff)}{fmtK(rowDiff)}</td>
                      <td><span className={`badge ${statusBadge(rowStatus)}`}>{rowStatus}</span></td>
                      <td style={{ color: '#6b7280', fontSize: 12, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.comment || '—'}</td>
                    </>
                  ) : (
                    <>
                      <td>${usdR.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td style={{ fontWeight: 600, color: diffColor(usdD, 0.01) }}>{sign(usdD)}${usdD.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td>{fraR.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                      <td style={{ fontWeight: 600, color: diffColor(fraD, 1) }}>{sign(fraD)}{fraD.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                      <td>{kR.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                      <td style={{ fontWeight: 600, color: diffColor(kD, 1) }}>{sign(kD)}{kD.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                      <td style={{ color: usdEx > 0 ? '#dc2626' : '' }}>{usdEx > 0 ? `$${usdEx.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : dash}</td>
                      <td style={{ color: fraEx > 0 ? '#dc2626' : '' }}>{fraEx > 0 ? fraEx.toLocaleString(undefined, { maximumFractionDigits: 0 }) : dash}</td>
                      <td style={{ color: kEx > 0 ? '#dc2626' : '' }}>{kEx > 0 ? kEx.toLocaleString(undefined, { maximumFractionDigits: 0 }) : dash}</td>
                      <td>{curSym}{parseFloat(r.pending || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td style={{ color: '#6b7280', fontSize: 12, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.comment || '—'}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── New Payment Voucher Modal (shared component) ───────────────
           Paid From is locked to "Cash Drawer" since this modal is the
           cashier's end-of-day expense entry. Cashier ID is attached so
           the voucher is correctly tagged to this shift. */}
      {/* v1.8.24 — defaultPaidTo pre-fills with the currently selected
          cashier's name. Cashier is editable in the modal if the actual
          payee is someone else. */}
      <PaymentVoucherFormModal
        open={showVoucher}
        onClose={() => { setShowVoucher(false); setVoucherDefaultCcy(null); setVoucherPrefill(null); }}
        // An approved request opens here filled in, keeping the cashier and
        // the paid-from it was raised with.
        prefill={voucherPrefill}
        onSaved={handleVoucherSaved}
        // 2026-09-18 — over the depot's daily expense limit: the voucher goes
        // to HQ instead, and the corner card tracks it.
        onRequested={() => { setMessage('Sent to HQ for approval — the voucher is not saved yet.'); window.dispatchEvent(new Event('pv:refresh')); }}
        defaultPaidFrom="Cash Drawer"
        lockPaidFrom
        defaultDate={date}
        defaultCurrency={voucherDefaultCcy}
        defaultPaidTo={(() => {
          const c = salesCashiers.find(u => String(u.id) === String(selectedCashier));
          return c ? `${c.first_name || ''} ${c.last_name || ''}`.trim() : '';
        })()}
        extraPayload={{ cashier_id: parseInt(selectedCashier) || 0 }}
      />


      {/* ── Expenses List Modal ──────────────────────────────────── */}
      {showExpenses && (() => {
        // v1.8.18 — currency filter. When opened from a USD card, show only
        // PVs that hit the USD drawer (usd_amount > 0 OR legacy cash_amount).
        // Pick the column matching the active currency; row total displayed
        // is THAT currency's amount (not the legacy USD-converted `amount`).
        const colFor = (ccy) => ccy === 'USD' ? ['usd_amount', 'cash_amount']
                              : ccy === 'FRA' ? ['fra_amount', 'bank_amount']
                              : ccy === 'K'   ? ['k_amount',   'momo_amount']
                              : null;
        const valFor = (v, ccy) => {
          const cols = colFor(ccy);
          if (!cols) return parseFloat(v.amount || 0);
          const newV = parseFloat(v[cols[0]] || 0);
          return newV > 0 ? newV : parseFloat(v[cols[1]] || 0);
        };
        const filtered = expensesFilterCcy
          ? expensesList.filter(v => valFor(v, expensesFilterCcy) > 0)
          : expensesList;
        const ccyLabel = expensesFilterCcy === 'USD' ? 'USD ($)' : expensesFilterCcy === 'FRA' ? 'FRA' : expensesFilterCcy === 'K' ? 'K' : 'All';
        const ccySym   = expensesFilterCcy === 'USD' ? '$' : '';
        const ccyDec   = expensesFilterCcy === 'USD' ? 2 : 0;
        const fmtA     = (n) => `${ccySym}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: ccyDec, maximumFractionDigits: ccyDec })}`;
        const totalFiltered = filtered.reduce((s, v) => s + (expensesFilterCcy ? valFor(v, expensesFilterCcy) : parseFloat(v.amount || 0)), 0);
        return (
        <Portal>
        <div className="modal-overlay" onClick={() => setShowExpenses(false)}>
          <div className="modal" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Cash Drawer Expenses — {ccyLabel} — {formatDate(date)}</h3>
              <button className="modal-close" onClick={() => setShowExpenses(false)}>×</button>
            </div>
            <div className="modal-body" style={{ padding: 0 }}>
              {filtered.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#9ca3af', padding: '32px 0' }}>
                  No {expensesFilterCcy ? expensesFilterCcy + ' ' : ''}expenses recorded for this date.
                </p>
              ) : (
                <table className="data-table" style={{ fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th>Voucher No.</th><th>Category</th><th>Paid To</th><th>Description</th><th style={{ textAlign: 'right' }}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(v => (
                      <tr key={v.id}>
                        <td style={{ fontWeight: 500 }}>{v.voucher_number}</td>
                        <td><span className="badge badge-gray">{v.category}</span></td>
                        <td>{v.paid_to}</td>
                        <td style={{ color: '#6b7280' }}>{v.description || '—'}</td>
                        <td style={{ textAlign: 'right', color: '#dc2626', fontWeight: 600 }}>
                          {expensesFilterCcy ? fmtA(valFor(v, expensesFilterCcy)) : `$${parseFloat(v.amount).toLocaleString()}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ fontWeight: 700, borderTop: '2px solid #e5e7eb', background: '#f9fafb' }}>
                      <td colSpan={4} style={{ textAlign: 'right' }}>Total</td>
                      <td style={{ textAlign: 'right', color: '#dc2626' }}>
                        {expensesFilterCcy ? fmtA(totalFiltered) : `$${totalFiltered.toLocaleString()}`}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowExpenses(false)}>Close</button>
            </div>
          </div>
        </div>
        </Portal>
        );
      })()}

      {/* ── Print Preview ─────────────────────────────────────────── */}
      {false && showPrintPreview && (
        <div
          className="print-preview-overlay"
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(15,23,42,0.85)',
            zIndex: 1000, display: 'flex', flexDirection: 'column',
            alignItems: 'center', overflowY: 'auto',
            paddingTop: 60, paddingBottom: 40,
          }}
        >
          {/* ── Preview Toolbar ── */}
          <div
            className="no-print"
            style={{
              position: 'fixed', top: 0, left: 0, right: 0, height: 52,
              background: '#0f172a', display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', padding: '0 24px', zIndex: 1001,
              borderBottom: '1px solid #1e293b',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={16} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>
                Print Preview — Cash Report for {formatDateLong(date)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => window.print()}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  padding: '7px 20px', borderRadius: 8, border: 'none',
                  background: '#2563eb', color: '#fff', cursor: 'pointer',
                  fontSize: 13, fontWeight: 600,
                }}
              >
                <FiPrinter size={14} /> Print
              </button>
              <button
                onClick={() => setShowPrintPreview(false)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '7px 16px', borderRadius: 8,
                  border: '1px solid #334155',
                  background: 'transparent', color: '#94a3b8',
                  cursor: 'pointer', fontSize: 13,
                }}
              >
                <FiX size={14} /> Close
              </button>
            </div>
          </div>

          {/* ── A4 Print Document ── */}
          <div
            id="print-document"
            style={{
              width: 794,
              background: '#ffffff',
              margin: '0 auto',
              boxShadow: '0 25px 60px rgba(0,0,0,0.5)',
              fontFamily: '"Segoe UI", Arial, sans-serif',
              fontSize: 12,
              color: '#1a1a2e',
              flexShrink: 0,
            }}
          >
            {/* ── Document Header ── */}
            <div style={{
              background: 'linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%)',
              padding: '30px 44px 24px',
              color: '#fff',
              display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
            }}>
              <div>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>
                  {businessInfo.business_name || 'Business Name'}
                </div>
                <div style={{ fontSize: 11, opacity: 0.75, lineHeight: 1.7 }}>
                  {[businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email]
                    .filter(Boolean).join('  |  ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{
                  fontSize: 10, letterSpacing: 2, textTransform: 'uppercase',
                  opacity: 0.65, marginBottom: 6,
                }}>
                  Daily Cash Report
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.3 }}>
                  {formatDateLong(date)}
                </div>
              </div>
            </div>

            {/* ── Thin accent bar ── */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #ef4444, #8b5cf6)' }} />

            {/* ── Body ── */}
            <div style={{ padding: '30px 44px 36px' }}>

              {/* ── Two-column: Breakdown + Reconciliation ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>

                {/* Left — Cash Breakdown */}
                <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{
                    background: '#f8fafc', padding: '10px 18px',
                    borderBottom: '1px solid #e2e8f0',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: '#2563eb', display: 'inline-block', flexShrink: 0,
                    }} />
                    <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#475569' }}>
                      Cash Breakdown
                    </span>
                  </div>
                  <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {[
                        { label: 'Initial Change (Float)', value: form.initial_change, color: '#374151' },
                        { label: 'Cash', value: form.usd_received, color: '#374151' },
                        // 2026-09-11 — a hidden method shows only if money sits on it.
                        ...((methodShown('momo') || hasMoney(form.fra_received)) ? [{ label: 'Mobile Money', value: form.fra_received, color: '#374151' }] : []),
                        ...((methodShown('bank') || hasMoney(form.k_received)) ? [{ label: 'Bank', value: form.k_received, color: '#374151' }] : []),
                        { label: 'Credit Sales (On Account)', value: form.pending, color: '#374151' },
                        { label: 'Expenses (Cash Drawer)', value: form.expenses, color: '#dc2626', italic: true },
                      ].map((row, i, arr) => (
                        <tr key={i} style={{ borderBottom: i < arr.length - 1 ? '1px solid #f1f5f9' : '2px solid #e2e8f0' }}>
                          <td style={{ padding: '9px 18px', color: row.color, fontSize: 12, fontStyle: row.italic ? 'italic' : 'normal' }}>
                            {row.label}
                          </td>
                          <td style={{ padding: '9px 18px', textAlign: 'right', fontWeight: 500, color: row.color, fontFamily: 'monospace', fontSize: 12 }}>
                            {row.color === '#dc2626' ? '−' : ''}${fmt(row.value)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#f8fafc' }}>
                        <td style={{ padding: '10px 18px', fontWeight: 700, fontSize: 12.5 }}>Total</td>
                        <td style={{ padding: '10px 18px', textAlign: 'right', fontWeight: 700, fontSize: 13, fontFamily: 'monospace' }}>
                          ${fmt(form.total)}
                        </td>
                      </tr>
                      <tr style={{ background: '#eff6ff' }}>
                        <td style={{ padding: '11px 18px', fontWeight: 700, color: '#1d4ed8', fontSize: 12 }}>
                          Cash on Hand (After Change)
                        </td>
                        <td style={{ padding: '11px 18px', textAlign: 'right', fontWeight: 800, color: '#1d4ed8', fontSize: 14, fontFamily: 'monospace' }}>
                          ${fmt(form.total)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Right — Reconciliation + Status */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Reconciliation table */}
                  <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{
                      background: '#f8fafc', padding: '10px 18px',
                      borderBottom: '1px solid #e2e8f0',
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: '#10b981', display: 'inline-block', flexShrink: 0,
                      }} />
                      <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#475569' }}>
                        Reconciliation
                      </span>
                    </div>
                    <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        <tr style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '9px 18px', color: '#374151', fontSize: 12 }}>Expected Revenue</td>
                          <td style={{ padding: '9px 18px', textAlign: 'right', fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>
                            ${fmt(form.expected)}
                          </td>
                        </tr>
                        <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                          <td style={{ padding: '9px 18px', color: '#374151', fontSize: 12 }}>Cash on Hand</td>
                          <td style={{ padding: '9px 18px', textAlign: 'right', fontWeight: 600, fontFamily: 'monospace', fontSize: 12 }}>
                            ${fmt(form.total)}
                          </td>
                        </tr>
                      </tbody>
                      <tfoot>
                        <tr style={{
                          background: statusBg(computedStatus),
                        }}>
                          <td style={{ padding: '11px 18px', fontWeight: 700, fontSize: 13 }}>Difference</td>
                          <td style={{
                            padding: '11px 18px', textAlign: 'right',
                            fontWeight: 800, fontSize: 14,
                            color: statusColor(computedStatus),
                            fontFamily: 'monospace',
                          }}>
                            {computedDiff >= 0 ? '+' : '−'}{curSym}{fmt(Math.abs(computedDiff))}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* Status card */}
                  <div style={{
                    padding: '18px 20px', borderRadius: 10, textAlign: 'center',
                    background: statusBg(computedStatus),
                    border: `2px solid ${statusBorder(computedStatus)}`,
                    flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center',
                  }}>
                    <div style={{ fontSize: 10, letterSpacing: 1.5, textTransform: 'uppercase', color: '#64748b', marginBottom: 8, fontWeight: 600 }}>
                      Report Status
                    </div>
                    <div style={{
                      fontSize: 26, fontWeight: 900, letterSpacing: 3,
                      color: statusColor(computedStatus), textTransform: 'uppercase',
                      marginBottom: 6,
                    }}>
                      {computedStatus}
                    </div>
                    {computedDiff !== 0 ? (
                      <div style={{ fontSize: 11.5, color: statusColor(computedStatus), fontWeight: 500 }}>
                        {computedDiff < 0 ? 'Cash short by' : 'Surplus of'}&nbsp;
                        <strong>{curSym}{fmt(Math.abs(computedDiff))}</strong>
                      </div>
                    ) : (
                      <div style={{ fontSize: 11.5, color: '#16a34a', fontWeight: 500 }}>
                        Fully balanced
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── Expenses Breakdown ── */}
              {printExpenses.length > 0 && (
                <div style={{ border: '1px solid #fed7aa', borderRadius: 10, overflow: 'hidden', marginBottom: 22 }}>
                  <div style={{
                    background: '#fff7ed', padding: '10px 18px',
                    borderBottom: '1px solid #fed7aa',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%',
                        background: '#f97316', display: 'inline-block',
                      }} />
                      <span style={{ fontWeight: 700, fontSize: 10.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#c2410c' }}>
                        Expenses Breakdown — Cash Drawer
                      </span>
                    </div>
                    <span style={{ fontSize: 10.5, color: '#c2410c', fontWeight: 600 }}>
                      {printExpenses.length} voucher{printExpenses.length > 1 ? 's' : ''}
                    </span>
                  </div>
                  <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                    <thead>
                      <tr style={{ background: '#fafaf9' }}>
                        {['Voucher No.', 'Category', 'Paid To', 'Description'].map(h => (
                          <th key={h} style={{ padding: '7px 18px', textAlign: 'left', fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb', fontSize: 10.5, letterSpacing: 0.3 }}>{h}</th>
                        ))}
                        <th style={{ padding: '7px 18px', textAlign: 'right', fontWeight: 600, color: '#6b7280', borderBottom: '1px solid #e5e7eb', fontSize: 10.5, letterSpacing: 0.3 }}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {printExpenses.map((v, i) => (
                        <tr key={v.id} style={{ borderBottom: '1px solid #f3f4f6', background: i % 2 === 1 ? '#fffbf7' : '#fff' }}>
                          <td style={{ padding: '8px 18px', fontWeight: 600, color: '#374151', fontFamily: 'monospace', fontSize: 11 }}>{v.voucher_number}</td>
                          <td style={{ padding: '8px 18px', color: '#374151' }}>{v.category}</td>
                          <td style={{ padding: '8px 18px', fontWeight: 500 }}>{v.paid_to}</td>
                          <td style={{ padding: '8px 18px', color: '#9ca3af' }}>{v.description || '—'}</td>
                          <td style={{ padding: '8px 18px', textAlign: 'right', color: '#dc2626', fontWeight: 700, fontFamily: 'monospace' }}>
                            ${fmt(v.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#fff7ed', borderTop: '2px solid #fed7aa' }}>
                        <td colSpan={4} style={{ padding: '10px 18px', fontWeight: 700, textAlign: 'right', color: '#9a3412', fontSize: 12 }}>
                          Total Expenses
                        </td>
                        <td style={{ padding: '10px 18px', textAlign: 'right', fontWeight: 800, color: '#dc2626', fontSize: 13, fontFamily: 'monospace' }}>
                          ${fmt(printExpenses.reduce((s, v) => s + parseFloat(v.amount || 0), 0))}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {/* ── Comments ── */}
              {form.comment ? (
                <div style={{
                  border: '1px solid #e2e8f0', borderRadius: 10,
                  padding: '14px 18px', marginBottom: 26, background: '#f8fafc',
                }}>
                  <div style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>
                    Comments / Notes
                  </div>
                  <div style={{ fontSize: 12.5, color: '#374151', lineHeight: 1.6 }}>{form.comment}</div>
                </div>
              ) : (
                <div style={{ marginBottom: 26 }}>
                  <div style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700, marginBottom: 8 }}>
                    Comments / Notes
                  </div>
                  <div style={{ borderBottom: '1px solid #cbd5e1', height: 24 }} />
                </div>
              )}

              {/* ── Signatures ── */}
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48,
                paddingTop: 20, borderTop: '1.5px solid #e2e8f0',
              }}>
                {['Prepared by (Cashier)', 'Approved by (Manager)'].map(label => (
                  <div key={label}>
                    <div style={{ fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 700, marginBottom: 22 }}>
                      {label}
                    </div>
                    {['Name', 'Signature', 'Date'].map(field => (
                      <div key={field} style={{ marginBottom: 20 }}>
                        <div style={{ borderBottom: '1px solid #94a3b8', paddingBottom: 2, marginBottom: 4, minHeight: 20 }}>&nbsp;</div>
                        <div style={{ fontSize: 9.5, color: '#94a3b8', letterSpacing: 0.3 }}>{field}</div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {/* ── Document Footer ── */}
              <div style={{
                borderTop: '1px solid #f1f5f9', marginTop: 20, paddingTop: 12,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>
                  {businessInfo.business_name || 'Business'} — Confidential
                </span>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>
                  Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── CR Duplicate Confirmation Modal ─────────────────────── */}
      {showCRConfirm && existingCR && pendingCRData && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', overflow: 'hidden' }}>

            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%)', padding: '18px 24px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: '50%', background: 'rgba(255,255,255,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>
                ⚠
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>Cash Receipt Already Exists</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2 }}>{formatDate(date)}</div>
              </div>
            </div>

            {/* Body */}
            <div style={{ padding: '22px 24px' }}>
              <p style={{ margin: '0 0 16px', fontSize: 13.5, color: '#374151', lineHeight: 1.6 }}>
                A Cash Receipt from <strong>Sales</strong> already exists for <strong>{formatDate(date)}</strong>:
              </p>
              {/* v1.8.86 — triple-currency breakdown so the user sees what's
                  actually being replaced per drawer, not just USD-equivalent.
                  v1.10.33 — on Liquor-style branches (Lusaka, Mansa) the three
                  columns are physical METHODS (Cash / Mobile Money / Bank)
                  all in the branch currency, not USD/FRA/K. Storage still
                  uses the usd/fra/k columns — same mapping as the PV modal
                  and the Cash Report cards. */}
              {(() => {
                const fmtUSD = (n) => `$${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                const fmtInt = (n) => parseFloat(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
                const fmtK   = (n) => `${curSym}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                const rowLabels = isLiquorStyle
                  ? [{ label: 'Cash', slot: 'usd', fmt: fmtK }, { label: 'Mobile Money', slot: 'fra', fmt: fmtK }, { label: 'Bank', slot: 'k', fmt: fmtK }]
                  : [{ label: 'USD', slot: 'usd', fmt: fmtUSD }, { label: 'FRA', slot: 'fra', fmt: fmtInt }, { label: 'K', slot: 'k', fmt: fmtInt }];
                const Row = ({ label, valueColor, usd, fra, k }) => {
                  const values = { usd, fra, k };
                  return (
                    <div style={{ fontSize: 12, display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <div style={{ color: '#6b7280', fontSize: 11, fontWeight: 600, marginBottom: 2 }}>{label}</div>
                      {rowLabels.map(r => (
                        <div key={r.slot} style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#6b7280' }}>{r.label}</span>
                          <span style={{ fontWeight: 700, color: valueColor, fontFamily: 'monospace' }}>{r.fmt(values[r.slot])}</span>
                        </div>
                      ))}
                    </div>
                  );
                };
                return (
                  <>
                    <div style={{ padding: '12px 16px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 9, marginBottom: 16 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed #bfdbfe' }}>
                        <span style={{ fontWeight: 700, color: '#1d4ed8', fontFamily: 'monospace', fontSize: 13 }}>{existingCR.receipt_number}</span>
                        <span style={{ fontSize: 10, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Current</span>
                      </div>
                      <Row label="" valueColor="#1d4ed8"
                           usd={existingCR.usd_amount || existingCR.amount}
                           fra={existingCR.fra_amount}
                           k={existingCR.k_amount} />
                    </div>
                    <p style={{ margin: '0 0 6px', fontSize: 13.5, color: '#374151', lineHeight: 1.6 }}>
                      Do you want to update it with the new amount?
                    </p>
                    <div style={{ padding: '12px 16px', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 8 }}>
                      <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px dashed #86efac', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 11, color: '#15803d', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>New</span>
                        <span style={{ fontSize: 11, color: '#6b7280' }}><em>{pendingCRData.description}</em></span>
                      </div>
                      <Row label="" valueColor="#15803d"
                           usd={pendingCRData.usd_amount}
                           fra={pendingCRData.fra_amount}
                           k={pendingCRData.k_amount} />
                    </div>
                  </>
                );
              })()}
            </div>

            {/* Footer */}
            <div style={{ padding: '14px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                onClick={handleAbortUpdateCR}
                disabled={crSaving}
                style={{ padding: '9px 20px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
              >
                No, Keep Existing
              </button>
              <button
                onClick={handleConfirmUpdateCR}
                disabled={crSaving}
                style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: crSaving ? '#9ca3af' : '#1d4ed8', color: '#fff', cursor: crSaving ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}
              >
                {crSaving ? 'Updating…' : 'Yes, Update'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Print styles ─────────────────────────────────────────── */}
      <style>{`
        @media print {
          .no-print { display: none !important; }

          /* When preview is open: print only the document */
          .print-preview-overlay {
            position: fixed !important;
            top: 0 !important; left: 0 !important;
            right: 0 !important; bottom: 0 !important;
            background: #fff !important;
            padding: 0 !important;
            overflow: visible !important;
            display: block !important;
          }
          #print-document {
            box-shadow: none !important;
            width: 100% !important;
            margin: 0 !important;
          }
        }
      `}</style>

      {/* v1.10.9 — Admin password gate for deleting a saved cash report. */}
      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={pendingDelete?.subject || ''}
        actionLabel={pendingDelete?.actionLabel || 'Delete'}
        onConfirm={async () => {
          if (!pendingDelete?.id || deleting) return;
          setDeleting(true);
          try {
            await deleteCashReport(pendingDelete.id);
            setPendingDelete(null);
            await fetchReports();
            await loadDate(date, selectedCashier);
            setMessage(`Saved cash report deleted — Expected values are now live from POS.${autoDepositOn ? ` Its deposits to ${depositTo.label} that were still waiting were removed too.` : ''}`);
            setTimeout(() => setMessage(''), 4000);
          } catch (err) {
            setMessage(err?.response?.data?.error || 'Delete failed.');
          } finally {
            setDeleting(false);
          }
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

export default CashReport;
