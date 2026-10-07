import React, { useState, useEffect } from 'react';
import { getCashBook, getCashBookStats, setOpeningBalance, getSettings, getSalesRangeSummary, createCashTransfer, isHqHost, getBranchSlug, getCurrentFxRate } from '../services/api';
import ExportButtons from '../components/ExportButtons';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { useAuth } from '../context/AuthContext';
import CurrencyExchangePanel from '../components/CurrencyExchangePanel';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import { FiTrendingUp, FiTrendingDown, FiDollarSign, FiEdit2, FiSave, FiX, FiPrinter, FiFilter, FiRefreshCw } from 'react-icons/fi';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import HQDeposits from './HQDeposits';
import useDepositTarget from '../utils/useDepositTarget';
const CashBook = () => {
  const { hasPermission, user: authUser } = useAuth();
  // v1.8.6 â€” tab toggle between the ledger view and the Exchanges ledger.
  const [activeTab, setActiveTab] = useState('ledger');
  const { symbol: curSym, currencyMode, isLiquorStyle, methodShown } = useCurrency();
  // 2026-09-18 â€” what to call the deposits tab: HQ, or the depot this one
  // sends its cash to (System Settings â†’ Deposit to).
  const depositTo = useDepositTarget();
  // v1.13.46 â€” Kelete is single-K across HQ and every branch, so the
  // Kelete-era `onHq â†’ force USD+FRA+K` override no longer applies.
  // business_settings on HQ + branches all resolve to currency_mode=K,
  // payment_methods=cash_momo_bank (isLiquorStyle=true), giving the
  // correct single-K Cash / MoMo / Bank ledger everywhere.
  const onHq = isHqHost();
  // v1.9.26 â€” Cash Book columns + opening-balance editors gate on the
  // branch's currency_mode. K-only branches see one K column only.
  const showUSDccy = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const showFRAccy = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const showKccy   = currencyMode === 'USD+FRA+K' || currencyMode === 'K';
  const { t } = useLanguage();
  const [stats, setStats] = useState({
    openingBalance: 0, openingByMethod: { cash: 0, bank: 0, momo: 0 },
    totalReceipts: 0, totalPV: 0, totalAP: 0, totalPayments: 0,
    currentBalance: 0, currentByMethod: { cash: 0, bank: 0, momo: 0 },
  });
  const [entries, setEntries] = useState([]);
  // v1.10.18 â€” live FX so Cash & Cash Equivalents can convert FRA + K to
  // USD-equivalent instead of naively summing raw numbers.
  const [fx, setFx] = useState({ buyFRA: 0, sellFRA: 0, buyK: 0, sellK: 0 });
  const [businessInfo, setBusinessInfo] = useState({});
  const [showListPrint, setShowListPrint] = useState(false);
  const [openingBal, setOpeningBal] = useState(0);
  // v1.8.62 â€” per-currency opening balance editor (USD / FRA / K).
  const [editingOB, setEditingOB] = useState(false);
  // v1.9.27 â€” keys differ by branch profile: Kelete uses usd/fra/k,
  // Liquor (Mansa/Lusaka) uses cash/momo/bank. Single state object holds
  // both; the editor + save read the right pair based on isLiquorStyle.
  const [obInput, setObInput] = useState({ usd: '', fra: '', k: '', cash: '', momo: '', bank: '' });
  // v1.8.62 â€” active currency filter for the ledger ('all' | 'usd' | 'fra' | 'k').
  // Clicking a currency card sets this; ledger filters rows that touch that
  // currency and the Balance column switches to that currency's running total.
  const [activeCcy, setActiveCcy] = useState('all');
  const [savingOB, setSavingOB] = useState(false);
  const todayStr = new Date().toISOString().split('T')[0];
  const [from, setFrom] = useState(todayStr);
  const [to, setTo] = useState(todayStr);
  const [rangeSummary, setRangeSummary] = useState({ net_profit: 0, gross_profit: 0, total_revenue: 0 });

  // Cash transfer modal
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferForm, setTransferForm] = useState({ from_method: 'Cash', to_method: 'Bank', amount: '', date: todayStr, description: '' });
  const [savingTransfer, setSavingTransfer] = useState(false);
  const [transferError, setTransferError] = useState('');

  // v1.8.59 â€” HQ Deposit moved to its own page (Accounting â†’ HQ Deposits)
  // to keep Cash Book focused on ledger view and to avoid conflating
  // a transfer workflow with the per-method opening balance + range
  // summary that lives here.

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(editingOB || showTransfer);

  const fetchData = async (f, t) => {
    try {
      const params = {};
      if (f) params.from = f;
      if (t) params.to = t;
      // v1.8.61 â€” slug so backend can include HQ Deposits from master.db
      // (out for branch, in for HQ).
      const slug = isHqHost() ? 'hq' : (getBranchSlug() || (typeof window !== 'undefined' ? window.location.hostname.split('.')[0] : ''));
      if (slug) params.slug = slug;
      const [statsRes, entriesRes, rangeRes] = await Promise.all([
        getCashBookStats(params),
        getCashBook(params),
        getSalesRangeSummary(f || null, t || null),
      ]);
      if (statsRes.data) {
        setStats(statsRes.data);
        setOpeningBal(statsRes.data.openingBalance);
      }
      if (entriesRes.data) {
        setEntries(entriesRes.data.entries || []);
      }
      if (rangeRes.data) {
        setRangeSummary(rangeRes.data);
      }
    } catch (err) { /* use defaults */ }
  };

  useEffect(() => {
    fetchData(todayStr, todayStr);
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
    // v1.10.18 â€” fetch today's latest FX rate for USD-equivalent card.
    getCurrentFxRate().then(r => {
      const d = r.data || {};
      setFx({
        buyFRA:  parseFloat(d.buy_rate     ?? d.buyRate     ?? d.buy_rate_fra   ?? 0) || 0,
        sellFRA: parseFloat(d.sell_rate    ?? d.sellRate    ?? d.sell_rate_fra  ?? 0) || 0,
        buyK:    parseFloat(d.buy_rate_k   ?? d.buyRateK    ?? 0) || 0,
        sellK:   parseFloat(d.sell_rate_k  ?? d.sellRateK   ?? 0) || 0,
      });
    }).catch(() => {});
  }, []); // eslint-disable-line

  const handleFilter = () => fetchData(from, to);
  const handleClearFilter = () => { setFrom(''); setTo(''); fetchData('', ''); };

  const handleSaveTransfer = async () => {
    setTransferError('');
    const amt = parseFloat(transferForm.amount || 0);
    if (!(amt > 0)) { setTransferError('Enter an amount greater than zero.'); return; }
    if (transferForm.from_method === transferForm.to_method) { setTransferError('From and To must be different.'); return; }
    setSavingTransfer(true);
    try {
      await createCashTransfer({
        date:         transferForm.date,
        from_method:  transferForm.from_method,
        to_method:    transferForm.to_method,
        amount:       amt,
        description:  transferForm.description || null,
      });
      setShowTransfer(false);
      await fetchData(from, to);
    } catch (err) {
      setTransferError(err.response?.data?.error || 'Failed to save transfer.');
    } finally {
      setSavingTransfer(false);
    }
  };

  // 2026-09-07 â€” an Administrator password before the opening balance moves.
  // It used to be a confirm dialog and nothing else, at branch and at HQ, while
  // this one figure shifts every running balance on the page. Held here until
  // the save, because the route checks it too - proving it to the browser
  // alone leaves the endpoint open.
  const [obPrompt, setObPrompt] = useState(false);

  const handleSaveOB = async () => setObPrompt(true);

  const doSaveOB = async (password) => {
    setObPrompt(false);
    setSavingOB(true);
    try {
      // v1.9.27 â€” send the per-method opening balances on Liquor branches
      // and the per-currency opening balances on Kelete branches. Backend
      // accepts both shapes.
      const payload = isLiquorStyle
        ? {
            cash: parseFloat(obInput.cash || 0) || 0,
            momo: parseFloat(obInput.momo || 0) || 0,
            bank: parseFloat(obInput.bank || 0) || 0,
          }
        : {
            usd: parseFloat(obInput.usd || 0) || 0,
            fra: parseFloat(obInput.fra || 0) || 0,
            k:   parseFloat(obInput.k   || 0) || 0,
          };
      await setOpeningBalance(payload, password);
      setEditingOB(false);
      await fetchData(from, to);
    } catch (err) {
      window.alert(err?.response?.data?.error || 'Could not save the opening balance.');
    }
    setSavingOB(false);
  };

  const openEditOB = () => {
    if (!window.confirm('Editing opening balances will affect all running balances in the Cash Book. Do you want to continue?')) return;
    setObInput({
      usd:  String(stats.openingByCcy?.usd     || 0),
      fra:  String(stats.openingByCcy?.fra     || 0),
      k:    String(stats.openingByCcy?.k       || 0),
      cash: String(stats.openingByMethod?.cash || 0),
      momo: String(stats.openingByMethod?.momo || 0),
      bank: String(stats.openingByMethod?.bank || 0),
    });
    setEditingOB(true);
  };

  const formatDate = (d) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  const totals = entries.reduce((acc, e) => ({
    receipts: acc.receipts + parseFloat(e.receipt_amount || 0),
    payments: acc.payments + parseFloat(e.payment_amount || 0)
  }), { receipts: 0, payments: 0 });

  const handlePrint = () => {
    const fmt2 = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmt0 = (v) => parseFloat(v || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const fmtUSD = (v) => `$${fmt2(v)}`;
    const fmtFRA = (v) => `F ${fmt0(v)}`;
    const fmtK   = (v) => `K ${fmt0(v)}`;

    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const dateLabel = from && to && from !== to ? `${formatDate(from)} â€” ${formatDate(to)}` : from ? formatDate(from) : 'All Dates';
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');

    // v1.10.85 â€” multi-currency print. HQ (and any USD+FRA / USD+FRA+K
    // tenant) shows per-currency stat cards + a Ccy-tagged ledger with
    // per-currency running balances. Single-currency tenants (K-only
    // Liquor, USD-only Sirak) fall through to the previous layout so
    // nothing changes for them.
    const ccyList = [
      showUSDccy && { key: 'usd', label: 'USD', fmt: fmtUSD },
      showFRAccy && { key: 'fra', label: 'FRA', fmt: fmtFRA },
      showKccy   && { key: 'k',   label: 'K',   fmt: fmtK },
    ].filter(Boolean);
    const isMultiCcy = ccyList.length > 1;

    let html;
    if (isMultiCcy) {
      // Per-currency roll-ups â€” same reduce shape the on-screen chip strip
      // uses at line 651-667 so print totals match what the operator sees.
      const openingByCcy = stats.openingByCcy || { usd: 0, fra: 0, k: 0 };
      const perCcy = entries.reduce((acc, e) => {
        const usd_in  = parseFloat(e.usd_in  || 0) || 0;
        const usd_out = parseFloat(e.usd_out || 0) || 0;
        const fra_in  = parseFloat(e.fra_in  || 0) || 0;
        const fra_out = parseFloat(e.fra_out || 0) || 0;
        const k_in    = parseFloat(e.k_in    || 0) || 0;
        const k_out   = parseFloat(e.k_out   || 0) || 0;
        if (e.type === 'CR') { acc.receipts.usd += usd_in;  acc.receipts.fra += fra_in;  acc.receipts.k += k_in; }
        if (e.type === 'PV') { acc.payments.usd += usd_out; acc.payments.fra += fra_out; acc.payments.k += k_out; }
        if (e.type === 'AP') { acc.ap.usd       += usd_out; acc.ap.fra       += fra_out; acc.ap.k       += k_out; }
        return acc;
      }, { receipts: { usd: 0, fra: 0, k: 0 }, payments: { usd: 0, fra: 0, k: 0 }, ap: { usd: 0, fra: 0, k: 0 } });
      const profitByCcy = {
        usd: perCcy.receipts.usd - perCcy.payments.usd - perCcy.ap.usd,
        fra: perCcy.receipts.fra - perCcy.payments.fra - perCcy.ap.fra,
        k:   perCcy.receipts.k   - perCcy.payments.k   - perCcy.ap.k,
      };
      const currentByCcy = {
        usd: openingByCcy.usd + profitByCcy.usd,
        fra: openingByCcy.fra + profitByCcy.fra,
        k:   openingByCcy.k   + profitByCcy.k,
      };

      // Six stat cards, each stacked USD / FRA / K.
      const cards = [
        { label: 'Opening Balance',     bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe', data: openingByCcy },
        { label: 'Total Receipts (CR)', bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0', data: perCcy.receipts },
        { label: 'Total Payments (PV)', bg: '#fef2f2', color: '#dc2626', border: '#fecaca', data: perCcy.payments },
        { label: 'Total AP (COGS)',     bg: '#faf5ff', color: '#7c3aed', border: '#e9d5ff', data: perCcy.ap },
        { label: 'Profit',              bg: '#f8fafc', color: '#111827', border: '#e2e8f0', data: profitByCcy, signColor: true },
        { label: 'Current Balance',     bg: '#f8fafc', color: '#111827', border: '#e2e8f0', data: currentByCcy },
      ];
      const chips = cards.map(c => {
        const lines = ccyList.map(ccy => {
          const v = c.data[ccy.key];
          const clr = c.signColor ? (v >= 0 ? '#16a34a' : '#dc2626') : c.color;
          return `<div style="font-size:13.5px;font-weight:700;color:${clr};line-height:1.35">${ccy.fmt(v)}</div>`;
        }).join('');
        return `<div style="padding:10px 14px;border-radius:10px;background:${c.bg};border:1.5px solid ${c.border}">
          <div style="font-size:9.5px;letter-spacing:0.8px;text-transform:uppercase;color:#64748b;font-weight:600;margin-bottom:6px">${c.label}</div>
          ${lines}
        </div>`;
      }).join('');

      // Running per-currency balance walks the entries; each entry emits
      // one sub-row per currency that has activity (usually just one).
      const balance = { usd: openingByCcy.usd, fra: openingByCcy.fra, k: openingByCcy.k };
      const totIn   = { usd: 0, fra: 0, k: 0 };
      const totOut  = { usd: 0, fra: 0, k: 0 };
      const obRows = ccyList.map(ccy => `<tr style="background:#eff6ff">
        <td style="padding:6px 10px;color:#6b7280;border-top:1px solid #e5e7eb">â€”</td>
        <td style="padding:6px 10px;font-weight:700;border-top:1px solid #e5e7eb">Opening Balance</td>
        <td style="padding:6px 10px;color:#9ca3af;font-size:10px;border-top:1px solid #e5e7eb"></td>
        <td style="padding:6px 10px;font-weight:700;color:#1d4ed8;border-top:1px solid #e5e7eb">OB</td>
        <td style="padding:6px 10px;text-align:center;color:#374151;font-weight:600;border-top:1px solid #e5e7eb">${ccy.label}</td>
        <td style="padding:6px 10px;text-align:right;color:#1d4ed8;font-weight:700;border-top:1px solid #e5e7eb">${ccy.fmt(openingByCcy[ccy.key])}</td>
        <td style="padding:6px 10px;border-top:1px solid #e5e7eb"></td>
        <td style="padding:6px 10px;text-align:right;font-weight:700;border-top:1px solid #e5e7eb">${ccy.fmt(openingByCcy[ccy.key])}</td>
      </tr>`).join('');

      const rows = entries.map((e, idx) => {
        const isAP = e.type === 'AP', isPV = e.type === 'PV';
        const tc = isAP ? '#7c3aed' : isPV ? '#dc2626' : '#16a34a';
        const bg = idx % 2 === 1 ? '#fafafa' : '#fff';
        const subs = [];
        for (const ccy of ccyList) {
          const inv  = parseFloat(e[`${ccy.key}_in`]  || 0) || 0;
          const outv = parseFloat(e[`${ccy.key}_out`] || 0) || 0;
          if (inv === 0 && outv === 0) continue;
          balance[ccy.key] += inv - outv;
          totIn[ccy.key]  += inv;
          totOut[ccy.key] += outv;
          subs.push(`<tr style="background:${bg}">
            <td style="padding:6px 10px;color:#374151;border-top:1px solid #f1f5f9">${formatDate(e.date)}</td>
            <td style="padding:6px 10px;border-top:1px solid #f1f5f9">${e.description || ''}</td>
            <td style="padding:6px 10px;color:#9ca3af;font-size:10px;border-top:1px solid #f1f5f9">${e.reference || ''}</td>
            <td style="padding:6px 10px;font-weight:700;color:${tc};border-top:1px solid #f1f5f9">${e.type}</td>
            <td style="padding:6px 10px;text-align:center;color:#374151;font-weight:600;border-top:1px solid #f1f5f9">${ccy.label}</td>
            <td style="padding:6px 10px;text-align:right;color:#16a34a;font-weight:500;border-top:1px solid #f1f5f9">${inv > 0 ? ccy.fmt(inv) : ''}</td>
            <td style="padding:6px 10px;text-align:right;color:#dc2626;font-weight:500;border-top:1px solid #f1f5f9">${outv > 0 ? ccy.fmt(outv) : ''}</td>
            <td style="padding:6px 10px;text-align:right;font-weight:600;border-top:1px solid #f1f5f9">${ccy.fmt(balance[ccy.key])}</td>
          </tr>`);
        }
        return subs.join('');
      }).join('');

      const totalRows = ccyList.map((ccy, i) => `<tr style="background:#eff6ff;${i === 0 ? 'border-top:2px solid #bfdbfe' : ''}">
        <td colspan="4" style="padding:8px 10px;font-weight:700;font-size:11.5px;color:#1d4ed8">${i === 0 ? 'TOTALS' : ''}</td>
        <td style="padding:8px 10px;text-align:center;color:#1d4ed8;font-weight:700">${ccy.label}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:800;font-size:12.5px;color:#16a34a">${ccy.fmt(totIn[ccy.key])}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:800;font-size:12.5px;color:#dc2626">${ccy.fmt(totOut[ccy.key])}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:800;font-size:12.5px">${ccy.fmt(balance[ccy.key])}</td>
      </tr>`).join('');

      html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        @page{size:A4 portrait;margin:0}*{box-sizing:border-box;margin:0;padding:0}
        body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#1a1a2e}
      </style></head><body><div style="width:794px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#1e3a5f 0%,#1d4ed8 100%);padding:28px 44px 22px;color:#fff;display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:5px">${biz}</div>
            <div style="font-size:11px;opacity:0.75">${addr}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:0.65;margin-bottom:6px">Cash Book</div>
            <div style="font-size:15px;font-weight:700">${dateLabel}</div>
            <div style="font-size:10px;opacity:0.6;margin-top:4px">Printed: ${printedAt}</div>
          </div>
        </div>
        <div style="height:4px;background:linear-gradient(90deg,#f59e0b,#1d4ed8,#a855f7)"></div>
        <div style="padding:26px 44px 36px">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px">${chips}</div>
          <div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
            <table style="width:100%;border-collapse:collapse;font-size:10.5px">
              <thead><tr style="background:#eff6ff">
                <th style="padding:8px 10px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10px">Date</th>
                <th style="padding:8px 10px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10px">Description</th>
                <th style="padding:8px 10px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10px">Reference</th>
                <th style="padding:8px 10px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10px">Type</th>
                <th style="padding:8px 10px;text-align:center;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10px">Ccy</th>
                <th style="padding:8px 10px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10px">Receipts</th>
                <th style="padding:8px 10px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10px">Payments</th>
                <th style="padding:8px 10px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10px">Balance</th>
              </tr></thead>
              <tbody>${obRows}${rows}</tbody>
              <tfoot>${totalRows}</tfoot>
            </table>
          </div>
          <div style="border-top:1px solid #f1f5f9;padding-top:12px;display:flex;justify-content:space-between">
            <span style="font-size:9.5px;color:#cbd5e1">${biz} â€” Confidential</span>
            <span style="font-size:9.5px;color:#cbd5e1">Printed: ${printedAt}</span>
          </div>
        </div>
      </div></body></html>`;
    } else {
      // Single-currency layout â€” unchanged from prior (used by Liquor
      // K-only and USD-only tenants where per-currency splitting adds no
      // information).
      const fmt = fmt2;
      const profit = (stats.totalReceipts || 0) - (stats.totalPV || 0) - (stats.totalAP || 0);
      const chip = (label, value, bg, color, border) =>
        `<div style="padding:12px 16px;border-radius:10px;background:${bg};border:1.5px solid ${border};text-align:center">
          <div style="font-size:9.5px;letter-spacing:0.8px;text-transform:uppercase;color:#64748b;font-weight:600;margin-bottom:6px">${label}</div>
          <div style="font-size:16px;font-weight:800;color:${color}">${value}</div>
        </div>`;
      const chips = [
        chip('Opening Balance',    curSym+fmt(openingBal),          '#eff6ff','#1d4ed8','#bfdbfe'),
        chip('Total Receipts (CR)',curSym+fmt(stats.totalReceipts), '#f0fdf4','#16a34a','#bbf7d0'),
        chip('Total Payments (PV)',curSym+fmt(stats.totalPV),       '#fef2f2','#dc2626','#fecaca'),
        chip('Total AP (COGS)',    curSym+fmt(stats.totalAP),       '#faf5ff','#7c3aed','#e9d5ff'),
        chip('Profit',             curSym+fmt(profit),              profit>=0?'#f0fdf4':'#fef2f2', profit>=0?'#16a34a':'#dc2626', profit>=0?'#bbf7d0':'#fecaca'),
        chip('Current Balance',    curSym+fmt(stats.currentBalance),'#f8fafc','#374151','#e2e8f0'),
      ].join('');
      const obRow = `<tr style="border-bottom:1px solid #f1f5f9;background:#eff6ff">
        <td style="padding:8px 12px;color:#6b7280">â€”</td>
        <td style="padding:8px 12px;font-weight:700">Opening Balance</td>
        <td style="padding:8px 12px;color:#9ca3af;font-size:10px">OB</td>
        <td style="padding:8px 12px;font-weight:700;color:#1d4ed8">OB</td>
        <td style="padding:8px 12px;text-align:right;font-weight:700;color:#1d4ed8">${curSym}${fmt(openingBal)}</td>
        <td style="padding:8px 12px"></td>
        <td style="padding:8px 12px;text-align:right;font-weight:700">${curSym}${fmt(openingBal)}</td>
      </tr>`;
      const rows = entries.map((e, idx) => {
        const isAP = e.type==='AP', isPV = e.type==='PV';
        const tc = isAP?'#7c3aed':isPV?'#dc2626':'#16a34a';
        return `<tr style="border-bottom:1px solid #f1f5f9;background:${idx%2===1?'#fafafa':'#fff'}">
          <td style="padding:8px 12px;color:#374151">${formatDate(e.date)}</td>
          <td style="padding:8px 12px">${e.description||''}</td>
          <td style="padding:8px 12px;color:#9ca3af;font-size:10px">${e.reference||''}</td>
          <td style="padding:8px 12px;font-weight:700;color:${tc}">${e.type}</td>
          <td style="padding:8px 12px;text-align:right;color:#16a34a;font-weight:500">${parseFloat(e.receipt_amount)>0?curSym+fmt(e.receipt_amount):''}</td>
          <td style="padding:8px 12px;text-align:right;color:#dc2626;font-weight:500">${parseFloat(e.payment_amount)>0?curSym+fmt(e.payment_amount):''}</td>
          <td style="padding:8px 12px;text-align:right;font-weight:600">${curSym}${fmt(e.balance)}</td>
        </tr>`;
      }).join('');
      html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        @page{size:A4 portrait;margin:0}*{box-sizing:border-box;margin:0;padding:0}
        body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#1a1a2e}
      </style></head><body><div style="width:794px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#1e3a5f 0%,#1d4ed8 100%);padding:28px 44px 22px;color:#fff;display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:5px">${biz}</div>
            <div style="font-size:11px;opacity:0.75">${addr}</div>
          </div>
          <div style="text-align:right">
            <div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:0.65;margin-bottom:6px">Cash Book</div>
            <div style="font-size:15px;font-weight:700">${dateLabel}</div>
            <div style="font-size:10px;opacity:0.6;margin-top:4px">Printed: ${printedAt}</div>
          </div>
        </div>
        <div style="height:4px;background:linear-gradient(90deg,#f59e0b,#1d4ed8,#a855f7)"></div>
        <div style="padding:26px 44px 36px">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px">${chips}</div>
          <div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
            <table style="width:100%;border-collapse:collapse;font-size:11.5px">
              <thead><tr style="background:#eff6ff">
                <th style="padding:8px 12px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Date</th>
                <th style="padding:8px 12px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Description</th>
                <th style="padding:8px 12px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Reference</th>
                <th style="padding:8px 12px;text-align:left;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Type</th>
                <th style="padding:8px 12px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Receipts</th>
                <th style="padding:8px 12px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Payments</th>
                <th style="padding:8px 12px;text-align:right;font-weight:600;color:#1d4ed8;border-bottom:1px solid #bfdbfe;font-size:10.5px">Balance</th>
              </tr></thead>
              <tbody>${obRow}${rows}</tbody>
              <tfoot><tr style="background:#eff6ff;border-top:2px solid #bfdbfe">
                <td colspan="4" style="padding:10px 12px;font-weight:700;font-size:11.5px;color:#1d4ed8">TOTALS</td>
                <td style="padding:10px 12px;text-align:right;font-weight:800;font-size:13px;color:#16a34a">${curSym}${fmt(totals.receipts)}</td>
                <td style="padding:10px 12px;text-align:right;font-weight:800;font-size:13px;color:#dc2626">${curSym}${fmt(totals.payments)}</td>
                <td style="padding:10px 12px;text-align:right;font-weight:800;font-size:13px">${curSym}${fmt(stats.currentBalance)}</td>
              </tr></tfoot>
            </table>
          </div>
          <div style="border-top:1px solid #f1f5f9;padding-top:12px;display:flex;justify-content:space-between">
            <span style="font-size:9.5px;color:#cbd5e1">${biz} â€” Confidential</span>
            <span style="font-size:9.5px;color:#cbd5e1">Printed: ${printedAt}</span>
          </div>
        </div>
      </div></body></html>`;
    }

    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };
  const _handlePrint = () => {
    const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const bizName = businessInfo.business_name || 'Business Name';
    const printedAt = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const dateLabel = from && to && from !== to ? `${formatDate(from)} â€” ${formatDate(to)}` : from ? formatDate(from) : 'All Dates';
    const profit = (stats.totalReceipts || 0) - (stats.totalPV || 0) - (stats.totalAP || 0);
    const obRow = `<tr><td>â€”</td><td><b>Opening Balance</b></td><td></td><td style="text-align:center">OB</td><td style="text-align:right;font-weight:600;color:#2563eb">${curSym}${fmt(openingBal)}</td><td></td><td style="text-align:right;font-weight:600">${curSym}${fmt(openingBal)}</td></tr>`;
    const rows = entries.map(e => {
      const isAP = e.type === 'AP';
      const isPV = e.type === 'PV';
      const typeColor = isAP ? '#7c3aed' : isPV ? '#dc2626' : '#16a34a';
      return `<tr>
        <td>${formatDate(e.date)}</td>
        <td>${e.description || ''}</td>
        <td style="font-size:10px;color:#6b7280">${e.reference || ''}</td>
        <td style="text-align:center;font-weight:700;color:${typeColor}">${e.type}</td>
        <td style="text-align:right;color:#16a34a;font-weight:500">${parseFloat(e.receipt_amount) > 0 ? curSym + fmt(e.receipt_amount) : ''}</td>
        <td style="text-align:right;color:#dc2626;font-weight:500">${parseFloat(e.payment_amount) > 0 ? curSym + fmt(e.payment_amount) : ''}</td>
        <td style="text-align:right;font-weight:600">${curSym}${fmt(e.balance)}</td>
      </tr>`;
    }).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:15mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;font-size:11px;color:#1f2937}
      .hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:12px;border-bottom:3px solid #1e3a5f;margin-bottom:16px}
      .hdr-left .biz{font-size:20px;font-weight:900;color:#1e3a5f;letter-spacing:0.3px}
      .hdr-left .sub{font-size:10px;color:#6b7280;margin-top:4px}
      .hdr-right{text-align:right}
      .hdr-right .title{font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#6b7280;margin-bottom:4px}
      .hdr-right .dates{font-size:13px;font-weight:700;color:#1e3a5f}
      .hdr-right .printed{font-size:9px;color:#9ca3af;margin-top:3px}
      .stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:16px}
      .stat{border:1.5px solid #d1d5db;border-radius:6px;padding:8px 12px}
      .stat-lbl{font-size:9px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;margin-bottom:3px}
      .stat-val{font-size:13px;font-weight:800}
      table{width:100%;border-collapse:collapse;font-size:10.5px}
      th{border:1px solid #d1d5db;padding:7px 9px;text-align:left;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:0.5px}
      td{border:1px solid #e5e7eb;padding:6px 9px}
      .tot-row td{font-weight:700;border-top:2px solid #1e3a5f}
      .ft{margin-top:16px;display:flex;justify-content:space-between;font-size:9px;color:#9ca3af}
    </style></head><body>
      <div class="hdr">
        <div class="hdr-left">
          <div class="biz">${bizName}</div>
          <div class="sub">Cash Book Report</div>
        </div>
        <div class="hdr-right">
          <div class="title">Cash Book</div>
          <div class="dates">${dateLabel}</div>
          <div class="printed">Printed: ${printedAt}</div>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><div class="stat-lbl">Opening Balance</div><div class="stat-val" style="color:#2563eb">${curSym}${fmt(openingBal)}</div></div>
        <div class="stat"><div class="stat-lbl">Total Receipts (CR)</div><div class="stat-val" style="color:#16a34a">${curSym}${fmt(stats.totalReceipts)}</div></div>
        <div class="stat"><div class="stat-lbl">Total Payments (PV)</div><div class="stat-val" style="color:#dc2626">${curSym}${fmt(stats.totalPV)}</div></div>
        <div class="stat"><div class="stat-lbl">Total AP (COGS)</div><div class="stat-val" style="color:#7c3aed">${curSym}${fmt(stats.totalAP)}</div></div>
        <div class="stat"><div class="stat-lbl">Profit</div><div class="stat-val" style="color:${profit >= 0 ? '#16a34a' : '#dc2626'}">${curSym}${fmt(profit)}</div></div>
        <div class="stat"><div class="stat-lbl">Current Balance</div><div class="stat-val">${curSym}${fmt(stats.currentBalance)}</div></div>
      </div>
      <table>
        <thead><tr><th>Date</th><th>Description</th><th>Reference</th><th style="text-align:center">Type</th><th style="text-align:right">Receipts</th><th style="text-align:right">Payments</th><th style="text-align:right">Balance</th></tr></thead>
        <tbody>${obRow}${rows}</tbody>
        <tfoot><tr class="tot-row"><td colspan="4" style="text-align:right">TOTALS</td><td style="text-align:right;color:#16a34a">${curSym}${fmt(totals.receipts)}</td><td style="text-align:right;color:#dc2626">${curSym}${fmt(totals.payments)}</td><td style="text-align:right">${curSym}${fmt(stats.currentBalance)}</td></tr></tfoot>
      </table>
      <div class="ft"><span>${bizName} â€” Confidential</span><span>Printed: ${printedAt}</span></div>
    </body></html>`;
    const w = window.open('', '_blank');
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => w.print(), 300);
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('cashBookTitle')}</h1>
          <p>{t('cashBookSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={() => { setTransferError(''); setTransferForm(f => ({ ...f, amount: '', description: '', date: todayStr })); setShowTransfer(true); }}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
          >
            <FiRefreshCw size={15} /> {t('transfer')}
          </button>
          {/* 2026-09-17 â€” the Exchange button is gone at HQ and at every depot.
              Red Sea trades in Kwacha only, so there is nothing to convert. */}
          <button
            onClick={handlePrint}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}
          >
            <FiPrinter size={15} /> {t('print')}
          </button>
        </div>
      </div>

      {/* v1.8.6 â€” Tab strip: Ledger (existing entries view) vs Exchanges.
          v1.9.27 â€” Exchanges hidden on Liquor-style K-only branches â€”
          they have no USDâ†”FRA conversions to track. */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { key: 'ledger',    label: 'Ledger',      show: true },
          { key: 'exchanges', label: 'Exchanges',   show: !isLiquorStyle },
          // HQ Deposits mounted as a tab â€” same page reused so branch
          // and HQ see the appropriate view (Send / Inbox).
          // v1.13.92 â€” reverted v1.13.91 hide.
          // 2026-09-18 â€” named after where this depot's cash actually goes
          // (System Settings â†’ Deposit to), not always HQ.
          { key: 'deposits',  label: `${depositTo.label} Deposits`, show: true },
        ].filter(t => t.show).map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            style={{
              padding: '10px 22px', border: 'none', background: 'none',
              cursor: 'pointer', fontSize: 14, fontWeight: 700,
              color: activeTab === tab.key ? '#2563eb' : '#6b7280',
              borderBottom: activeTab === tab.key ? '3px solid #2563eb' : '3px solid transparent',
              marginBottom: -2, transition: 'color 0.15s',
            }}>
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'exchanges' && (
        <CurrencyExchangePanel
          scope="book"
          from={from}
          to={to}
          user={authUser}
          title="Currency Exchanges (Cash Book)"
        />
      )}

      {/* HQ Deposits reused as a tab â€” Send + own history for branches,
          Inbox with Confirm/Reject for HQ. */}
      {activeTab === 'deposits' && (
        <HQDeposits />
      )}

      {/* 2026-09-17 â€” the hidden panel that opened the Exchange modal went with
          the button above. The Exchanges tab still shows past exchanges. */}

      {activeTab === 'ledger' && (<>

      {/* Date Filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>{t('from')}:</label>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>{t('to')}:</label>
        <input type="date" value={to} onChange={e => setTo(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
        <button onClick={handleFilter}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: 'none', backgroundColor: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <FiFilter size={13} /> {t('filter')}
        </button>
        {(from || to) && (
          <button onClick={handleClearFilter}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 6, border: '1px solid #d1d5db', backgroundColor: '#fff', color: '#6b7280', cursor: 'pointer', fontSize: 13 }}>
            <FiX size={13} /> {t('clear')}
          </button>
        )}
      </div>

      {/* v1.8.62 â€” Four cards. Cash & Cash Equivalents is the umbrella
          (clears filter); USD / FRA / K cards are clickable to filter the
          ledger to that currency, with active-state highlight. */}
      <div className="stat-cards">
        {/* v1.10.18 â€” was 'Cash & Cash Equivalents' summing raw numbers across
            currencies (nonsense). Now labelled 'USD & USD Equivalent' and
            actually converts FRA + K to USD using today's live buy rate.
            Falls back to raw USD only when no rate is available.
            v1.10.39 â€” HQ (keletezm.com) books itself in Kwacha, so the
            "USD & USD Equivalent" anchor is the wrong question there.
            On HQ this tile now shows "K & K Equivalent": convert USD and
            FRA to K instead. Branches (Kassumbalesa etc.) are unchanged. */}
        {(() => {
          const usdNow  = stats.currentByCcy?.usd || 0;
          const fraNow  = stats.currentByCcy?.fra || 0;
          const kNow    = stats.currentByCcy?.k   || 0;
          const usdOpen = stats.openingByCcy?.usd || 0;
          const fraOpen = stats.openingByCcy?.fra || 0;
          const kOpen   = stats.openingByCcy?.k   || 0;

          if (isLiquorStyle) {
            // v1.10.50 â€” Liquor branches (Mansa, Lusaka) render this as
            // "Cash & Cash Equivalent" to match the old Liquor system.
            // v1.10.51 â€” read currentByMethod (same source the three
            // method tiles below use) instead of currentByCcy. On Kelete
            // POS, every sale hits BOTH orders.cash_received and
            // cash_receipts.usd_amount â€” currentByCcy counts both and
            // double-counts POS sales, so a "no filter" view drifted
            // above the three-tile sum by whatever the POS orders total
            // was. currentByMethod reads only cash_receipts, matches the
            // ledger balance exactly, and is invariant to date filter.
            const cashNow  = stats.currentByMethod?.cash || 0;
            const momoNow  = stats.currentByMethod?.momo || 0;
            const bankNow  = stats.currentByMethod?.bank || 0;
            const cashOpen = stats.openingByMethod?.cash || 0;
            const momoOpen = stats.openingByMethod?.momo || 0;
            const bankOpen = stats.openingByMethod?.bank || 0;
            const cashEqNow  = cashNow  + momoNow  + bankNow;
            const cashEqOpen = cashOpen + momoOpen + bankOpen;
            const fmtCE = (n) => `${curSym}${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            return (
              <div
                className={`stat-card purple ${activeCcy === 'all' ? 'active-filter' : ''}`}
                onClick={() => setActiveCcy('all')}
                style={{ cursor: 'pointer', outline: activeCcy === 'all' ? '3px solid #fbbf24' : 'none' }}
              >
                <div className="stat-icon"><FiDollarSign /></div>
                <div>
                  <div className="stat-label">Cash &amp; Cash Equivalent</div>
                  <div className="stat-value">
                    {hasPermission('CashBook:View') ? fmtCE(cashEqNow) : 'N/A'}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
                    {t('opening')} {fmtCE(cashEqOpen)}
                  </div>
                  <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2, fontStyle: 'italic' }}>
                    Cash + Mobile Money + Bank
                  </div>
                </div>
              </div>
            );
          }

          if (onHq) {
            // K-anchored: K + USDÃ—sellK + FRAÃ—(sellK / buyFRA)
            // sellK  = 1 USD sells for X K   â†’ USD_native Ã— sellK  = K
            // buyFRA = 1 USD buys  X FRA     â†’ FRA / buyFRA         = USD, then Ã— sellK â†’ K
            const usdToK = fx.sellK > 0 ? fx.sellK : 0;
            const fraToK = (fx.sellK > 0 && fx.buyFRA > 0) ? (fx.sellK / fx.buyFRA) : 0;
            const kEqNow  = kNow  + usdNow  * usdToK + fraNow  * fraToK;
            const kEqOpen = kOpen + usdOpen * usdToK + fraOpen * fraToK;
            const fmtK = (n) => `K${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const rateLabel = [
              fx.sellK  > 0 && `1 USD = ${fx.sellK.toLocaleString()} K`,
              fraToK    > 0 && `1 FRA â‰ˆ ${fraToK.toFixed(4)} K`,
            ].filter(Boolean).join(' Â· ');
            return (
              <div
                className={`stat-card purple ${activeCcy === 'all' ? 'active-filter' : ''}`}
                onClick={() => setActiveCcy('all')}
                style={{ cursor: 'pointer', outline: activeCcy === 'all' ? '3px solid #fbbf24' : 'none' }}
              >
                <div className="stat-icon"><FiDollarSign /></div>
                <div>
                  <div className="stat-label">K &amp; K Equivalent</div>
                  <div className="stat-value">
                    {hasPermission('CashBook:View') ? `â‰ˆ ${fmtK(kEqNow)}` : 'N/A'}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
                    {t('opening')} â‰ˆ {fmtK(kEqOpen)}
                  </div>
                  {rateLabel && (
                    <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2, fontStyle: 'italic' }}>
                      @ {rateLabel}
                    </div>
                  )}
                </div>
              </div>
            );
          }

          // Branch (USD-anchored) â€” unchanged.
          const usdEqNow  = usdNow  + (fx.buyFRA > 0 ? fraNow  / fx.buyFRA : 0) + (fx.buyK > 0 ? kNow  / fx.buyK : 0);
          const usdEqOpen = usdOpen + (fx.buyFRA > 0 ? fraOpen / fx.buyFRA : 0) + (fx.buyK > 0 ? kOpen / fx.buyK : 0);
          const fmt = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          const rateLabel = [
            fx.buyFRA > 0 && `1 USD = ${fx.buyFRA.toLocaleString()} FRA`,
            fx.buyK   > 0 && `1 USD = ${fx.buyK.toLocaleString()} K`,
          ].filter(Boolean).join(' Â· ');
          return (
            <div
              className={`stat-card purple ${activeCcy === 'all' ? 'active-filter' : ''}`}
              onClick={() => setActiveCcy('all')}
              style={{ cursor: 'pointer', outline: activeCcy === 'all' ? '3px solid #fbbf24' : 'none' }}
            >
              <div className="stat-icon"><FiDollarSign /></div>
              <div>
                <div className="stat-label">USD &amp; USD Equivalent</div>
                <div className="stat-value">
                  {hasPermission('CashBook:View') ? `â‰ˆ ${fmt(usdEqNow)}` : 'N/A'}
                </div>
                <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
                  {t('opening')} â‰ˆ {fmt(usdEqOpen)}
                </div>
                {rateLabel && (
                  <div style={{ fontSize: 10, opacity: 0.7, marginTop: 2, fontStyle: 'italic' }}>
                    @ {rateLabel}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* v1.9.27 â€” Liquor-style branches render Cash on Hand / Mobile
            Money / Cash at Bank cards using stats.currentByMethod (already
            on the response). Kelete multi-currency branches keep per-
            currency cards (gated by v1.9.26 currency_mode). */}
        {isLiquorStyle ? (
          [
            { key: 'cash', label: 'Cash on Hand', defaultClass: 'green'  },
            { key: 'momo', label: 'Mobile Money', defaultClass: 'orange' },
            { key: 'bank', label: 'Cash at Bank', defaultClass: 'purple' },
          // 2026-09-11 â€” a hidden method is left out unless it holds money.
          ].filter(m => methodShown(m.key)
              || Math.abs(stats.currentByMethod?.[m.key] || 0) > 0.004
              || Math.abs(stats.openingByMethod?.[m.key] || 0) > 0.004).map(m => {
            const bal  = stats.currentByMethod?.[m.key] || 0;
            const open = stats.openingByMethod?.[m.key] || 0;
            const isNegative = bal < -0.001;
            const fmtBal  = `${curSym}${bal.toLocaleString(undefined,  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const fmtOpen = `${curSym}${open.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            return (
              <div key={m.key} className={`stat-card ${isNegative ? 'red' : m.defaultClass}`}>
                <div className="stat-icon"><FiDollarSign /></div>
                <div>
                  <div className="stat-label">{m.label}</div>
                  <div className="stat-value">{hasPermission('CashBook:View') ? fmtBal : 'N/A'}</div>
                  <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{t('opening')} {fmtOpen}</div>
                </div>
              </div>
            );
          })
        ) : (
          [
            { key: 'usd', label: 'USD ($)', defaultClass: 'green',  symbol: '$',  raw: false, show: showUSDccy },
            { key: 'fra', label: 'FRA',     defaultClass: 'purple', symbol: '',   raw: true,  show: showFRAccy },
            { key: 'k',   label: 'K',       defaultClass: 'orange', symbol: '',   raw: true,  show: showKccy   },
          ].filter(m => m.show).map(m => {
            const bal  = stats.currentByCcy?.[m.key] || 0;
            const open = stats.openingByCcy?.[m.key] || 0;
            const isNegative = bal < -0.001;
            const fmtBal = m.raw
              ? `${Math.round(bal).toLocaleString()} ${m.label.replace(' ($)', '')}`
              : `${m.symbol}${bal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const fmtOpen = m.raw
              ? `${Math.round(open).toLocaleString()} ${m.label.replace(' ($)', '')}`
              : `${m.symbol}${open.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            const isActive = activeCcy === m.key;
            return (
              <div key={m.key}
                className={`stat-card ${isNegative ? 'red' : m.defaultClass} ${isActive ? 'active-filter' : ''}`}
                onClick={() => setActiveCcy(isActive ? 'all' : m.key)}
                style={{ cursor: 'pointer', outline: isActive ? '3px solid #fbbf24' : 'none' }}
              >
                <div className="stat-icon"><FiDollarSign /></div>
                <div>
                  <div className="stat-label">{m.label}{isActive && <span style={{ fontSize: 10, marginLeft: 6, opacity: 0.85 }}>Â· active</span>}</div>
                  <div className="stat-value">{hasPermission('CashBook:View') ? fmtBal : 'N/A'}</div>
                  <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{t('opening')} {fmtOpen}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Activity strip â€” compact secondary cards. Opening Balance + period totals.
          Opening Balance is editable only when no date filter is active (i.e. after Clear) â€” matches Butchery behavior
          for adjusting the install-time opening. Day-to-day, opening keeps reflecting yesterday's running balance. */}
      {/* v1.10.17 â€” on Kelete (per-currency) branches, aggregate CR / PV / AP
          per currency from the ledger rows so the tiles show USD / FRA / K
          separately instead of collapsing to a single USD-equivalent number
          that mixed currencies via FX. Liquor branches keep the combined
          $-value since they're single-currency operational. */}
      {(() => {
        const perCcy = entries.reduce((acc, e) => {
          const usd_in  = parseFloat(e.usd_in  || 0) || 0;
          const usd_out = parseFloat(e.usd_out || 0) || 0;
          const fra_in  = parseFloat(e.fra_in  || 0) || 0;
          const fra_out = parseFloat(e.fra_out || 0) || 0;
          const k_in    = parseFloat(e.k_in    || 0) || 0;
          const k_out   = parseFloat(e.k_out   || 0) || 0;
          if (e.type === 'CR') { acc.receipts.usd += usd_in;  acc.receipts.fra += fra_in;  acc.receipts.k += k_in; }
          if (e.type === 'PV') { acc.payments.usd += usd_out; acc.payments.fra += fra_out; acc.payments.k += k_out; }
          if (e.type === 'AP') { acc.ap.usd       += usd_out; acc.ap.fra       += fra_out; acc.ap.k       += k_out; }
          return acc;
        }, {
          receipts: { usd: 0, fra: 0, k: 0 },
          payments: { usd: 0, fra: 0, k: 0 },
          ap:       { usd: 0, fra: 0, k: 0 },
        });
        const fmtUSD = (n) => `$${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const fmtFRA = (n) => `${(parseFloat(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} FRA`;
        const fmtK   = (n) => `${(parseFloat(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })} K`;
        const strip = [
          { key: 'opening',  label: t('openingBalance'),  color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe',
            byCcy: stats.openingByCcy || { usd: 0, fra: 0, k: 0 },
            single: stats.openingBalance },
          { key: 'receipts', label: t('receiptsCR'),      color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0',
            byCcy: perCcy.receipts, single: stats.totalReceipts },
          { key: 'payments', label: t('paymentsPV'),      color: '#dc2626', bg: '#fef2f2', border: '#fecaca',
            byCcy: perCcy.payments, single: stats.totalPV },
          { key: 'ap',       label: t('supplierPaidAP'),  color: '#7c3aed', bg: '#faf5ff', border: '#e9d5ff',
            byCcy: perCcy.ap, single: stats.totalAP },
        ];
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 18 }}>
            {strip.map(c => {
              const canEditOpening = c.key === 'opening' && !from && !to && hasPermission('CashBook:Edit');
              const showBreakdown  = !isLiquorStyle && hasPermission('CashBook:View');
              return (
                <div key={c.key} style={{ background: c.bg, border: `1.5px solid ${c.border}`, borderRadius: 10, padding: '10px 14px', position: 'relative' }}>
                  <div style={{ fontSize: 10.5, letterSpacing: 0.5, textTransform: 'uppercase', color: '#64748b', fontWeight: 600 }}>{c.label}</div>
                  {showBreakdown ? (
                    <div style={{ marginTop: 3, display: 'grid', rowGap: 2 }}>
                      {showUSDccy && (
                        <div style={{ fontSize: 14, fontWeight: 800, color: c.color }}>{fmtUSD(c.byCcy.usd)}</div>
                      )}
                      {showFRAccy && (
                        <div style={{ fontSize: 13, fontWeight: 700, color: c.color, opacity: 0.85 }}>{fmtFRA(c.byCcy.fra)}</div>
                      )}
                      {showKccy && (
                        <div style={{ fontSize: 13, fontWeight: 700, color: c.color, opacity: 0.85 }}>{fmtK(c.byCcy.k)}</div>
                      )}
                    </div>
                  ) : (
                    <div style={{ fontSize: 18, fontWeight: 800, color: c.color, marginTop: 3 }}>
                      {hasPermission('CashBook:View')
                        ? `${curSym}${parseFloat(c.single || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : 'N/A'}
                    </div>
                  )}
                  {canEditOpening && (
                    <button onClick={openEditOB}
                      title="Edit opening balances (USD / FRA / K)"
                      style={{ position: 'absolute', top: 8, right: 8, background: '#fff', border: `1px solid ${c.border}`, borderRadius: 6, padding: '4px 6px', cursor: 'pointer', color: c.color }}>
                      <FiEdit2 size={12} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        );
      })()}

      {/* Opening Balance editor modal â€” three inputs */}
      <AdminPasswordPrompt
        open={obPrompt}
        subject="the Cash Book opening balance"
        actionLabel="Confirm & Save"
        onConfirm={({ password }) => doSaveOB(password)}
        onCancel={() => setObPrompt(false)}
      />

      {editingOB && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460, boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
              <h3 style={{ margin: 0 }}>Opening Balances</h3>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Starting balance per currency (USD / FRA / K) â€” used as the base for the Cash Book.</div>
            </div>
            <div style={{ padding: 22, display: 'grid', gap: 12 }}>
              {/* v1.9.27 â€” Liquor branches edit Cash / MoMo / Bank
                  openings; Kelete branches keep per-currency editors. */}
              {(isLiquorStyle ? [
                { key: 'cash', label: 'Cash on Hand', color: '#16a34a', show: true },
                { key: 'momo', label: 'Mobile Money', color: '#ea580c', show: methodShown('momo') || Math.abs(stats.openingByMethod?.momo || 0) > 0.004 },
                { key: 'bank', label: 'Cash at Bank', color: '#7c3aed', show: methodShown('bank') || Math.abs(stats.openingByMethod?.bank || 0) > 0.004 },
              ] : [
                { key: 'usd', label: 'USD ($)', color: '#16a34a', show: showUSDccy },
                { key: 'fra', label: 'FRA',     color: '#7c3aed', show: showFRAccy },
                { key: 'k',   label: 'K',       color: '#ea580c', show: showKccy   },
              ]).filter(f => f.show).map(f => (
                <div key={f.key}>
                  <label style={{ fontSize: 12, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 4, display: 'block' }}>{f.label}</label>
                  <input type="number" min="0" step="0.01"
                    value={obInput[f.key]}
                    onChange={e => setObInput(prev => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder="0.00"
                    style={{ width: '100%', padding: '9px 12px', border: `2px solid ${parseFloat(obInput[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, boxSizing: 'border-box' }} />
                </div>
              ))}
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setEditingOB(false)} style={{ padding: '8px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleSaveOB} disabled={savingOB}
                style={{ padding: '8px 18px', background: '#1d4ed8', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>
                {savingOB ? 'Savingâ€¦' : 'Save'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* v1.13.43 â€” universal export (ZRA checklist #30) */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <ExportButtons
          rows={entries}
          filename="cash-book"
          sheetName="CashBook"
          columns={[
            { key: 'date',        label: 'Date' },
            { key: 'description', label: 'Description' },
            { key: 'reference',   label: 'Reference' },
            { key: 'type',        label: 'Type' },
            { key: 'usd_amount',  label: 'USD',   format: v => Number(v || 0).toFixed(2) },
            { key: 'fra_amount',  label: 'FRA',   format: v => Number(v || 0).toFixed(2) },
            { key: 'k_amount',    label: 'K',     format: v => Number(v || 0).toFixed(2) },
            { key: 'balance',     label: 'Balance', format: v => Number(v || 0).toFixed(2) },
          ]}
          pdfOptions={{ title: 'Cash Book' }}
        />
      </div>
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('date')}</th><th>{t('description')}</th><th>{t('reference')}</th><th>{t('type')}</th>
              {/* v1.9.27 â€” Liquor branches show single Receipts/Payments
                  columns; Kelete branches keep per-currency columns gated
                  by v1.9.26 currency_mode. */}
              {isLiquorStyle ? (
                <>
                  {/* v1.10.47 â€” headers renamed to IN / OUT (simpler, and
                      accurate now that inflow/outflow sum every column). */}
                  <th style={{ textAlign: 'right' }}>IN</th>
                  <th style={{ textAlign: 'right' }}>OUT</th>
                </>
              ) : (
                <>
                  {showUSDccy && <th style={{ textAlign: 'right' }}>USD ($)</th>}
                  {showFRAccy && <th style={{ textAlign: 'right' }}>FRA</th>}
                  {showKccy && <th style={{ textAlign: 'right' }}>K</th>}
                </>
              )}
              <th style={{ textAlign: 'right' }}>{t('balance')}</th>
            </tr>
          </thead>
          <tbody>
            {/* Opening Balance row â€” shows per-currency openings if any. */}
            {(() => {
              const obUsd = stats.openingByCcy?.usd || 0;
              const obFra = stats.openingByCcy?.fra || 0;
              const obK   = stats.openingByCcy?.k   || 0;
              // v1.10.25 â€” Balance cell now mirrors the transaction rows
              // below: single-line when a currency filter is active, 3-stacked
              // (USD / FRA / K) when 'all' is selected. Previously the 'all'
              // fallback used the legacy `openingBal` number, which lumped raw
              // USD + FRA + K into one $-amount and disagreed with both the
              // USD-Equivalent tile above and the per-row balances below.
              const fmtUsd = (n) => `${curSym}${(parseFloat(n)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
              const fmtRaw = (n) => Math.round(parseFloat(n)||0).toLocaleString();
              const renderBalance = () => {
                if (activeCcy === 'usd') return fmtUsd(obUsd);
                if (activeCcy === 'fra') return `${fmtRaw(obFra)} FRA`;
                if (activeCcy === 'k')   return `${fmtRaw(obK)} K`;
                if (isLiquorStyle) return fmtUsd(openingBal);
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.25 }}>
                    {showUSDccy && <span>{fmtUsd(obUsd)}</span>}
                    {showFRAccy && <span style={{ fontWeight: 500, color: '#2563eb' }}>{fmtRaw(obFra)} FRA</span>}
                    {showKccy   && <span style={{ fontWeight: 500, color: '#7c3aed' }}>{fmtRaw(obK)} K</span>}
                  </div>
                );
              };
              return (
                <tr style={{ background: '#f0f9ff' }}>
                  <td style={{ fontWeight: 500 }}>â€”</td>
                  <td style={{ fontWeight: 600 }}>{t('openingBalance')}</td>
                  <td style={{ color: '#9ca3af', fontSize: 12 }}>OB</td>
                  <td></td>
                  {isLiquorStyle ? (
                    <>
                      <td style={{ color: openingBal > 0 ? '#16a34a' : '#cbd5e1', fontWeight: 600, textAlign: 'right' }}>
                        {openingBal > 0 ? `${curSym}${openingBal.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}` : 'â€”'}
                      </td>
                      <td style={{ color: '#cbd5e1', textAlign: 'right' }}>â€”</td>
                    </>
                  ) : (
                    <>
                      {showUSDccy && <td style={{ color: obUsd ? '#16a34a' : '#cbd5e1', fontWeight: 600, textAlign: 'right' }}>{obUsd ? `${curSym}${obUsd.toLocaleString()}` : 'â€”'}</td>}
                      {showFRAccy && <td style={{ color: obFra ? '#2563eb' : '#cbd5e1', fontWeight: 600, textAlign: 'right' }}>{obFra ? `${Math.round(obFra).toLocaleString()} FRA` : 'â€”'}</td>}
                      {showKccy && <td style={{ color: obK ? '#7c3aed' : '#cbd5e1', fontWeight: 600, textAlign: 'right' }}>{obK ? `${Math.round(obK).toLocaleString()} K` : 'â€”'}</td>}
                    </>
                  )}
                  <td style={{ fontWeight: 600, textAlign: 'right' }}>{renderBalance()}</td>
                </tr>
              );
            })()}
            {entries.filter(e => {
              // v1.8.62 â€” filter rows by active currency. 'all' = no filter.
              if (activeCcy === 'all') return true;
              const inAmt  = parseFloat(e[`${activeCcy}_in`]  || 0);
              const outAmt = parseFloat(e[`${activeCcy}_out`] || 0);
              return inAmt !== 0 || outAmt !== 0;
            }).map(e => {
              const isAP = e.type === 'AP';
              const isCR = e.type === 'CR';
              const isDepIn  = e.type === 'DEP-IN';
              const isDepOut = e.type === 'DEP-OUT';
              const rowBg = isAP ? '#faf5ff' : isCR ? '#f0fdf4' : isDepIn ? '#ecfeff' : isDepOut ? '#fffbeb' : {};
              const fmtUsd = (n) => `$${parseFloat(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
              const fmtRaw = (n) => Math.round(parseFloat(n||0)).toLocaleString();
              const usdNet = parseFloat(e.usd_in || 0) - parseFloat(e.usd_out || 0);
              const fraNet = parseFloat(e.fra_in || 0) - parseFloat(e.fra_out || 0);
              const kNet   = parseFloat(e.k_in   || 0) - parseFloat(e.k_out   || 0);
              return (
                <tr key={e.id} style={typeof rowBg === 'string' ? { background: rowBg } : rowBg}>
                  <td>{formatDate(e.date)}</td>
                  <td style={{ fontWeight: 500 }}>{e.description}</td>
                  <td style={{ color: '#9ca3af', fontSize: 12 }}>{e.reference}</td>
                  <td>
                    <span style={{
                      display: 'inline-block', padding: '2px 7px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                      background: isAP ? '#ede9fe' : isCR ? '#dcfce7' : (isDepIn || isDepOut) ? '#fef3c7' : '#fee2e2',
                      color: isAP ? '#7c3aed' : isCR ? '#16a34a' : (isDepIn || isDepOut) ? '#92400e' : '#dc2626'
                    }}>
                      {e.type}
                    </span>
                  </td>
                  {isLiquorStyle ? (() => {
                    // v1.9.27 â€” Liquor view: receipts (inflow) and
                    // payments (outflow) as two separate columns.
                    // v1.10.47 â€” was reading receipt_amount/payment_amount
                    // which the backend leaves at 0 for non-USD deposits
                    // (cashBook.js:329). Result: K DEP-OUT / DEP-IN rows
                    // showed "â€”" in the OUT / IN column even though the
                    // running balance did drop. Now read the per-currency
                    // in/out fields directly and sum them â€” on K-only
                    // Liquor all three columns are K anyway, so the sum
                    // is the receipt total in K.
                    const inflow  = (parseFloat(e.usd_in  || 0) || 0)
                                  + (parseFloat(e.fra_in  || 0) || 0)
                                  + (parseFloat(e.k_in    || 0) || 0);
                    const outflow = (parseFloat(e.usd_out || 0) || 0)
                                  + (parseFloat(e.fra_out || 0) || 0)
                                  + (parseFloat(e.k_out   || 0) || 0);
                    const fmtK = (n) => `${curSym}${parseFloat(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
                    return (
                      <>
                        <td style={{ textAlign: 'right', color: inflow > 0 ? '#16a34a' : '#cbd5e1', fontWeight: inflow > 0 ? 600 : 400 }}>
                          {inflow > 0 ? `+${fmtK(inflow)}` : 'â€”'}
                        </td>
                        <td style={{ textAlign: 'right', color: outflow > 0 ? '#dc2626' : '#cbd5e1', fontWeight: outflow > 0 ? 600 : 400 }}>
                          {outflow > 0 ? `-${fmtK(outflow)}` : 'â€”'}
                        </td>
                      </>
                    );
                  })() : (
                    <>
                      {showUSDccy && (
                        <td style={{ textAlign: 'right', color: usdNet > 0 ? '#16a34a' : usdNet < 0 ? '#dc2626' : '#cbd5e1', fontWeight: usdNet !== 0 ? 600 : 400 }}>
                          {usdNet !== 0 ? `${usdNet > 0 ? '+' : '-'}${fmtUsd(Math.abs(usdNet))}` : 'â€”'}
                        </td>
                      )}
                      {showFRAccy && (
                        <td style={{ textAlign: 'right', color: fraNet > 0 ? '#2563eb' : fraNet < 0 ? '#dc2626' : '#cbd5e1', fontWeight: fraNet !== 0 ? 600 : 400 }}>
                          {fraNet !== 0 ? `${fraNet > 0 ? '+' : '-'}${fmtRaw(Math.abs(fraNet))} FRA` : 'â€”'}
                        </td>
                      )}
                      {showKccy && (
                        <td style={{ textAlign: 'right', color: kNet > 0 ? '#7c3aed' : kNet < 0 ? '#dc2626' : '#cbd5e1', fontWeight: kNet !== 0 ? 600 : 400 }}>
                          {kNet !== 0 ? `${kNet > 0 ? '+' : '-'}${fmtRaw(Math.abs(kNet))} K` : 'â€”'}
                        </td>
                      )}
                    </>
                  )}
                  <td style={{ fontWeight: 600, textAlign: 'right' }}>
                    {(() => {
                      // v1.10.20 â€” Balance column now shows a per-currency
                      // stack (USD-only on 'usd', FRA-only on 'fra', etc.)
                      // instead of falling back to the naive USD+FRA_raw+K_raw
                      // e.balance sum. On the 'all' umbrella view, stack all
                      // three lines so every row communicates the true state
                      // of each drawer after that entry â€” matches the layout
                      // of the USD/FRA/K movement columns to the left.
                      const fmtUsd = (n) => `${curSym}${(parseFloat(n)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
                      const fmtRaw = (n) => Math.round(parseFloat(n)||0).toLocaleString();
                      // v1.10.47 â€” on Liquor branches all three balance
                      // columns are K (Cash â†’ usd_amount, MoMo â†’ fra_amount,
                      // Bank â†’ k_amount by the Liquor storage mapping).
                      // Sum them for a real running K total. Previously we
                      // showed only balance_k which never moved for CR rows
                      // (their amounts land in usd_amount/fra_amount), so
                      // the ledger appeared stuck at -K41,960 after any
                      // K DEP-OUT.
                      if (isLiquorStyle) {
                        const bAll = (parseFloat(e.balance_usd)||0)
                                   + (parseFloat(e.balance_fra)||0)
                                   + (parseFloat(e.balance_k)  ||0);
                        return `${curSym}${bAll.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
                      }
                      if (activeCcy === 'fra') return `${fmtRaw(e.balance_fra)} FRA`;
                      if (activeCcy === 'k')   return `${fmtRaw(e.balance_k)} K`;
                      if (activeCcy === 'usd') return fmtUsd(e.balance_usd);
                      // 'all' â€” three lines, only the currencies this branch uses.
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.25 }}>
                          {showUSDccy && <span>{fmtUsd(e.balance_usd)}</span>}
                          {showFRAccy && <span style={{ fontWeight: 500, color: '#2563eb' }}>{fmtRaw(e.balance_fra)} FRA</span>}
                          {showKccy   && <span style={{ fontWeight: 500, color: '#7c3aed' }}>{fmtRaw(e.balance_k)} K</span>}
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              );
            })}
            {entries.length === 0 && (
              <tr><td colSpan="8" style={{ textAlign: 'center', color: '#9ca3af', padding: 24 }}>No transactions yet. Create Cash Receipts, Payment Vouchers, or AP Payments.</td></tr>
            )}
            {/* v1.8.61 â€” per-currency totals row. Sum in / out separately
                across all entries, then display net per currency. */}
            {(() => {
              // v1.8.62 â€” totals row. Closing balance per currency comes
              // from stats.currentByCcy (true per-currency, no FX cross-
              // conversion). Active-currency Balance cell uses the matching
              // currentByCcy value; 'all' falls back to currentBalance.
              const t = entries.reduce((a, e) => {
                a.usd += parseFloat(e.usd_in || 0) - parseFloat(e.usd_out || 0);
                a.fra += parseFloat(e.fra_in || 0) - parseFloat(e.fra_out || 0);
                a.k   += parseFloat(e.k_in   || 0) - parseFloat(e.k_out   || 0);
                return a;
              }, { usd: 0, fra: 0, k: 0 });
              const fmtUsd = (n) => `$${parseFloat(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
              const fmtRaw = (n) => Math.round(parseFloat(n||0)).toLocaleString();
              // v1.10.20 â€” 'all' view now stacks USD / FRA / K closing
              // balances (matching the per-row Balance column). Filtered
              // views (activeCcy === 'usd' / 'fra' / 'k') stay single-line.
              // The old stats.currentBalance mixed FRA + K raw numbers with
              // USD and missed HQ deposits, showing e.g. $226,245 when the
              // real USD in the till was $20,555.
              const closeBal = activeCcy === 'fra' ? (stats.currentByCcy?.fra || 0)
                              : activeCcy === 'k'   ? (stats.currentByCcy?.k   || 0)
                              : (stats.currentByCcy?.usd || 0);
              const closeAll = {
                usd: stats.currentByCcy?.usd || 0,
                fra: stats.currentByCcy?.fra || 0,
                k:   stats.currentByCcy?.k   || 0,
              };
              const fmtClose = activeCcy === 'fra' ? `${Math.round(closeBal).toLocaleString()} FRA`
                              : activeCcy === 'k'   ? `${Math.round(closeBal).toLocaleString()} K`
                              : `${curSym}${(closeBal||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
              return (
                <tr style={{ background: '#f9fafb', fontWeight: 700, borderTop: '2px solid #e5e7eb' }}>
                  <td colSpan="4" style={{ textAlign: 'right' }}>TOTALS:</td>
                  {isLiquorStyle ? (() => {
                    // v1.9.27 â€” Liquor totals: sum receipts and payments.
                    // v1.10.47 â€” sum per-currency in/out fields (same
                    // reason as the row cells above â€” receipt_amount /
                    // payment_amount are 0 for non-USD deposits).
                    const totIn  = entries.reduce((a, e) => a
                      + (parseFloat(e.usd_in  || 0) || 0)
                      + (parseFloat(e.fra_in  || 0) || 0)
                      + (parseFloat(e.k_in    || 0) || 0), 0);
                    const totOut = entries.reduce((a, e) => a
                      + (parseFloat(e.usd_out || 0) || 0)
                      + (parseFloat(e.fra_out || 0) || 0)
                      + (parseFloat(e.k_out   || 0) || 0), 0);
                    const fmtK = (n) => `${curSym}${parseFloat(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
                    return (
                      <>
                        <td style={{ textAlign: 'right', color: '#16a34a' }}>+{fmtK(totIn)}</td>
                        <td style={{ textAlign: 'right', color: '#dc2626' }}>-{fmtK(totOut)}</td>
                      </>
                    );
                  })() : (
                    <>
                      {showUSDccy && <td style={{ textAlign: 'right', color: t.usd >= 0 ? '#16a34a' : '#dc2626' }}>{t.usd >= 0 ? '+' : '-'}{fmtUsd(Math.abs(t.usd))}</td>}
                      {showFRAccy && <td style={{ textAlign: 'right', color: t.fra >= 0 ? '#2563eb' : '#dc2626' }}>{t.fra >= 0 ? '+' : '-'}{fmtRaw(Math.abs(t.fra))} FRA</td>}
                      {showKccy && <td style={{ textAlign: 'right', color: t.k   >= 0 ? '#7c3aed' : '#dc2626' }}>{t.k   >= 0 ? '+' : '-'}{fmtRaw(Math.abs(t.k))} K</td>}
                    </>
                  )}
                  <td style={{ textAlign: 'right', color: closeBal >= 0 ? '#16a34a' : '#dc2626' }}>
                    {isLiquorStyle ? (() => {
                      // v1.10.47 â€” sum all three currentByCcy slots for
                      // the Liquor closing total (all K on Liquor).
                      const closeK = (closeAll.usd || 0) + (closeAll.fra || 0) + (closeAll.k || 0);
                      return (
                        <span style={{ color: closeK >= 0 ? '#16a34a' : '#dc2626' }}>
                          {curSym}{closeK.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
                        </span>
                      );
                    })() : activeCcy === 'all' ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, lineHeight: 1.25 }}>
                        {showUSDccy && <span style={{ color: closeAll.usd >= 0 ? '#16a34a' : '#dc2626' }}>{fmtUsd(closeAll.usd)}</span>}
                        {showFRAccy && <span style={{ color: closeAll.fra >= 0 ? '#2563eb' : '#dc2626' }}>{fmtRaw(closeAll.fra)} FRA</span>}
                        {showKccy   && <span style={{ color: closeAll.k   >= 0 ? '#7c3aed' : '#dc2626' }}>{fmtRaw(closeAll.k)} K</span>}
                      </div>
                    ) : fmtClose}
                  </td>
                </tr>
              );
            })()}
          </tbody>
        </table>
      </div>
      {/* â”€â”€ CashBook List Print Overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {false && showListPrint && (() => {
        const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const profit = (stats.totalReceipts || 0) - (stats.totalPV || 0) - (stats.totalAP || 0);
        const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const dateLabel = from && to && from !== to ? `${formatDate(from)} â€” ${formatDate(to)}` : from ? formatDate(from) : 'All Dates';
        return (
          <div className="pv-print-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.85)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}>
            <div className="no-print" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 1001, borderBottom: '1px solid #1e293b' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <FiPrinter size={16} style={{ color: '#64748b' }} />
                <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Print Preview â€” Cash Book ({entries.length} entries)</span>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#1d4ed8', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}><FiPrinter size={14} /> Print</button>
                <button onClick={() => setShowListPrint(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}><FiX size={14} /> Close</button>
              </div>
            </div>

            <div id="cb-list-document" style={{ width: 794, background: '#fff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}>
              {/* Header */}
              <div style={{ background: 'linear-gradient(135deg, #1e3a5f 0%, #1d4ed8 100%)', padding: '28px 44px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>{businessInfo.business_name || 'Business Name'}</div>
                  <div style={{ fontSize: 11, opacity: 0.75 }}>{[businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ')}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.65, marginBottom: 6 }}>Cash Book</div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{dateLabel}</div>
                  <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>Printed: {printedAt}</div>
                </div>
              </div>
              {/* Rainbow divider */}
              <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #1d4ed8, #a855f7)' }} />

              <div style={{ padding: '26px 44px 36px' }}>
                {/* Stat chips â€” 3 cols x 2 rows */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 24 }}>
                  {[
                    { label: 'Opening Balance',   value: curSym + fmt(openingBal),          bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
                    { label: 'Total Receipts (CR)',value: curSym + fmt(stats.totalReceipts), bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' },
                    { label: 'Total Payments (PV)',value: curSym + fmt(stats.totalPV),       bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
                    { label: 'Total AP (COGS)',    value: curSym + fmt(stats.totalAP),       bg: '#faf5ff', color: '#7c3aed', border: '#e9d5ff' },
                    { label: 'Profit',             value: curSym + fmt(profit),              bg: profit >= 0 ? '#f0fdf4' : '#fef2f2', color: profit >= 0 ? '#16a34a' : '#dc2626', border: profit >= 0 ? '#bbf7d0' : '#fecaca' },
                    { label: 'Current Balance',    value: curSym + fmt(stats.currentBalance),bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
                  ].map(chip => (
                    <div key={chip.label} style={{ padding: '12px 16px', borderRadius: 10, background: chip.bg, border: `1.5px solid ${chip.border}`, textAlign: 'center' }}>
                      <div style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 600, marginBottom: 6 }}>{chip.label}</div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: chip.color }}>{chip.value}</div>
                    </div>
                  ))}
                </div>

                {/* Table */}
                <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, overflow: 'hidden', marginBottom: 20 }}>
                  <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                    <thead>
                      <tr style={{ background: '#eff6ff' }}>
                        {['Date', 'Description', 'Reference', 'Type', 'Receipts', 'Payments', 'Balance'].map((h, i) => (
                          <th key={h} style={{ padding: '8px 12px', textAlign: i >= 4 ? 'right' : 'left', fontWeight: 600, color: '#1d4ed8', borderBottom: '1px solid #bfdbfe', fontSize: 10.5, whiteSpace: 'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      <tr style={{ borderBottom: '1px solid #f1f5f9', background: '#eff6ff' }}>
                        <td style={{ padding: '8px 12px', color: '#6b7280' }}>â€”</td>
                        <td style={{ padding: '8px 12px', fontWeight: 700 }}>Opening Balance</td>
                        <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10 }}>OB</td>
                        <td style={{ padding: '8px 12px', fontWeight: 700, color: '#1d4ed8' }}>OB</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: '#1d4ed8' }}>{curSym}{fmt(openingBal)}</td>
                        <td style={{ padding: '8px 12px' }} />
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700 }}>{curSym}{fmt(openingBal)}</td>
                      </tr>
                      {entries.map((e, idx) => {
                        const isAP = e.type === 'AP'; const isPV = e.type === 'PV';
                        const typeColor = isAP ? '#7c3aed' : isPV ? '#dc2626' : '#16a34a';
                        return (
                          <tr key={e.id || idx} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                            <td style={{ padding: '8px 12px', color: '#374151' }}>{formatDate(e.date)}</td>
                            <td style={{ padding: '8px 12px' }}>{e.description || ''}</td>
                            <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10 }}>{e.reference || ''}</td>
                            <td style={{ padding: '8px 12px', fontWeight: 700, color: typeColor }}>{e.type}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#16a34a', fontWeight: 500 }}>{parseFloat(e.receipt_amount) > 0 ? curSym + fmt(e.receipt_amount) : ''}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#dc2626', fontWeight: 500 }}>{parseFloat(e.payment_amount) > 0 ? curSym + fmt(e.payment_amount) : ''}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600 }}>{curSym}{fmt(e.balance)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#eff6ff', borderTop: '2px solid #bfdbfe' }}>
                        <td colSpan={4} style={{ padding: '10px 12px', fontWeight: 700, fontSize: 11.5, color: '#1d4ed8' }}>TOTALS</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13, color: '#16a34a' }}>{curSym}{fmt(totals.receipts)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13, color: '#dc2626' }}>{curSym}{fmt(totals.payments)}</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13 }}>{curSym}{fmt(stats.currentBalance)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>

                <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>{businessInfo.business_name || 'Business'} â€” Confidential</span>
                  <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>Printed: {printedAt}</span>
                </div>
              </div>
            </div>
          </div>
        );
      })()}
      </>)}{/* end activeTab === 'ledger' wrapper (v1.8.6) */}

      {/* Cash Transfer Modal â€” moves money between Cash / Bank / Mobile Money buckets */}
      {showTransfer && (
        <Portal>
        <div className="modal-overlay" onClick={() => setShowTransfer(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
            <div className="modal-header">
              <h2>Cash Transfer</h2>
              <button className="modal-close" onClick={() => setShowTransfer(false)}><FiX /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0, marginBottom: 14 }}>
                Move money between cash buckets. Your total cash on hand stays the same â€” only the breakdown shifts.
              </p>

              {(() => {
                const methodKey = (m) => m === 'Cash' ? 'cash' : m === 'Bank' ? 'bank' : 'momo';
                const fmt = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const fromCur  = parseFloat(stats.currentByMethod?.[methodKey(transferForm.from_method)] || 0);
                const toCur    = parseFloat(stats.currentByMethod?.[methodKey(transferForm.to_method)]   || 0);
                const amt      = parseFloat(transferForm.amount || 0) || 0;
                const fromAfter = fromCur - amt;
                const toAfter   = toCur   + amt;
                const showAfter = amt > 0;
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>From *</label>
                      <select value={transferForm.from_method} onChange={e => setTransferForm({ ...transferForm, from_method: e.target.value })}>
                        <option value="Cash">Cash</option>
                        {(methodShown('bank') || transferForm.from_method === 'Bank') && <option value="Bank">Bank</option>}
                        {(methodShown('momo') || transferForm.from_method === 'Mobile Money') && <option value="Mobile Money">Mobile Money</option>}
                      </select>
                      <small style={{ color: '#6b7280', fontSize: 11, display: 'block', marginTop: 4 }}>
                        Current: <strong>{curSym}{fmt(fromCur)}</strong>
                      </small>
                      {showAfter && (
                        <small style={{ color: fromAfter < 0 ? '#dc2626' : '#0f766e', fontSize: 11, fontWeight: 600, display: 'block', marginTop: 2 }}>
                          After: {curSym}{fmt(fromAfter)} {fromAfter < 0 ? 'âš  overdraft' : ''}
                        </small>
                      )}
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>To *</label>
                      <select value={transferForm.to_method} onChange={e => setTransferForm({ ...transferForm, to_method: e.target.value })}>
                        <option value="Cash">Cash</option>
                        {(methodShown('bank') || transferForm.to_method === 'Bank') && <option value="Bank">Bank</option>}
                        {(methodShown('momo') || transferForm.to_method === 'Mobile Money') && <option value="Mobile Money">Mobile Money</option>}
                      </select>
                      <small style={{ color: '#6b7280', fontSize: 11, display: 'block', marginTop: 4 }}>
                        Current: <strong>{curSym}{fmt(toCur)}</strong>
                      </small>
                      {showAfter && (
                        <small style={{ color: '#0f766e', fontSize: 11, fontWeight: 600, display: 'block', marginTop: 2 }}>
                          After: {curSym}{fmt(toAfter)}
                        </small>
                      )}
                    </div>
                  </div>
                );
              })()}

              <div className="form-group">
                <label>Amount ({curSym}) *</label>
                <input type="number" min="0" step="0.01" placeholder="0.00"
                  value={transferForm.amount}
                  onChange={e => setTransferForm({ ...transferForm, amount: e.target.value })} />
              </div>

              <div className="form-group">
                <label>Date</label>
                <input type="date" max={todayStr}
                  value={transferForm.date}
                  onChange={e => setTransferForm({ ...transferForm, date: e.target.value })} />
              </div>

              <div className="form-group">
                <label>Description (optional)</label>
                <input type="text" placeholder="e.g. ATM withdrawal, MoMo cash-in"
                  value={transferForm.description}
                  onChange={e => setTransferForm({ ...transferForm, description: e.target.value })} />
              </div>

              {transferError && (
                <div style={{ background: '#fee2e2', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 12 }}>{transferError}</div>
              )}

              <div style={{ padding: '10px 14px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 12, color: '#1e40af', lineHeight: 1.5, marginBottom: 14 }}>
                <strong>Effect:</strong> {transferForm.from_method} {curSym}{(parseFloat(parseFloat(transferForm.amount || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} â†’ {transferForm.to_method}.
                Cash Book total unchanged; per-method cards on top will reflect the move.
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button onClick={() => setShowTransfer(false)} style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
                <button onClick={handleSaveTransfer} disabled={savingTransfer}
                  style={{ padding: '10px 28px', background: savingTransfer ? '#9ca3af' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: savingTransfer ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 600 }}>
                  <FiSave style={{ marginRight: 4, verticalAlign: 'middle' }} />
                  {savingTransfer ? 'Saving...' : 'Save Transfer'}
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

    </div>
  );
};

export default CashBook;
