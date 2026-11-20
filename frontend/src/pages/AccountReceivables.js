import React, { useState, useEffect, useCallback } from 'react';
import {
  getCustomers, getArStats,
  getCustomerStatement, createCustomerPayment,
  getCustomerPayments, deleteCustomerPayment,
  getSettings, getOrder, getCurrentFxRate, getCustomerAging,
} from '../services/api';
// UX-11 — debt ageing and credit use; the shared page header.
import { PageHero } from '../ux/ForecourtKit';
import { fmtDay } from '../ux/forecourt';
import { ageingTotals, oldestBucket, creditBar } from '../ux/arModel';
import ExportButtons from '../components/ExportButtons';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import {
  FiSearch, FiFileText, FiX, FiRefreshCw,
  FiUsers, FiChevronRight, FiTrash2, FiPrinter, FiPhone, FiCheckCircle,
} from 'react-icons/fi';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { matchTokens } from '../utils/tokenSearch';
import { businessToday } from '../utils/businessDate';

const todayStr = () => businessToday();
// fmt() is defined inside the component now so it can read the tenant's primary currency symbol.

const statusBadge = (status) => {
  const map = {
    'Paid': { bg: '#dcfce7', fg: '#15803d' },
    'Partial': { bg: '#fef3c7', fg: '#b45309' },
    'Unpaid': { bg: '#fee2e2', fg: '#b91c1c' },
    'No Sales': { bg: '#f1f5f9', fg: '#64748b' },
    'OnHold': { bg: '#fee2e2', fg: '#b91c1c' },
  };
  return map[status] || map['No Sales'];
};

const AccountReceivables = () => {
  const { hasPermission, user: authUser } = useAuth();
  const { symbol: curSym, currencyMode, isLiquorStyle, methodShown } = useCurrency();
  const { t } = useLanguage();
  // v1.8.55 — Kelete triple-currency gating + live FX rates for AR receipts.
  const isDual = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const [fxRate, setFxRate] = useState({ sell: 0, buy: 0, sellK: 0, buyK: 0 });
  const SELL_RATE   = fxRate.sell;
  const SELL_RATE_K = fxRate.sellK;
  const hasK        = SELL_RATE_K > 0;
  // Local fmt — uses the tenant's primary currency symbol.
  const fmt = (n) => `${curSym}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const [businessInfo, setBusinessInfo] = useState({});
  const [stats, setStats] = useState({ totalSales: 0, totalReceived: 0, outstanding: 0, customers: 0, owingCount: 0 });
  const [rows, setRows] = useState([]);
  const [payments, setPayments] = useState([]);
  const [aging, setAging] = useState(null);   // UX-11: per-customer debt by age
  const [quick, setQuick] = useState('all');   // UX-11b: quick filter on the receivables list
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('receivables'); // receivables | payments
  const [paymentModal, setPaymentModal] = useState(null);
  // v1.8.55 — triple-currency AR receipts (Kelete). usd/fra/k mirror the
  // Cashier Pay modal. Legacy bank/momo columns are no longer collected
  // from the UI but the backend still accepts them for backwards compat.
  // v1.8.56 — `sell_rate` / `sell_rate_k` are editable per-receipt
  // overrides (default to the current FX rate at open time).
  const [paymentForm, setPaymentForm] = useState({
    usd_amount: '', fra_amount: '', k_amount: '',
    sell_rate: '', sell_rate_k: '',
    payment_date: todayStr(), reference: '', notes: '',
  });
  const [statementModal, setStatementModal] = useState(null);
  // The statement's own date window. Empty = all time; anything before
  // "From" folds into a brought-forward row so the running balance holds.
  const [stFrom, setStFrom] = useState('');
  const [stTo, setStTo]     = useState('');
  // Lightweight modal for viewing a single order's items + payment breakdown from inside AR.
  const [orderDetail, setOrderDetail] = useState(null); // { loading, data?, error? }

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(!!paymentModal || !!statementModal || !!orderDetail);
  const openOrderDetail = async (orderId) => {
    if (!orderId) return;
    setOrderDetail({ loading: true });
    try {
      const res = await getOrder(orderId);
      setOrderDetail({ loading: false, data: res.data });
    } catch (err) {
      setOrderDetail({ loading: false, error: err.response?.data?.error || 'Failed to load order' });
    }
  };
  const [toast, setToast] = useState(null);
  // Date filter. 2026-09-10 — opens on ALL TIME. A month view leaves out every
  // sale and payment from before the 1st, so a customer who bought on credit
  // last month and has not paid read as owing nothing.
  const _today = new Date();
  const _firstOfMonth = `${_today.getFullYear()}-${String(_today.getMonth() + 1).padStart(2, '0')}-01`;
  // Local date. toISOString() is UTC, which gave yesterday before 02:00 here.
  const _todayStr = `${_today.getFullYear()}-${String(_today.getMonth() + 1).padStart(2, '0')}-${String(_today.getDate()).padStart(2, '0')}`;
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  const fetchAll = useCallback(async () => {
    try {
      const params = { from: filterFrom || undefined, to: filterTo || undefined };
      const [customersRes, statsRes, paymentsRes] = await Promise.all([
        getCustomers(params), getArStats(params), getCustomerPayments(params),
      ]);
      const list = (Array.isArray(customersRes.data) ? customersRes.data : []).map(c => {
        const sold        = parseFloat(c.total_sold    || 0);
        const cashAtSale  = parseFloat(c.cash_at_sale  || 0);    // POS-time cash on credit sales
        const arPaid      = parseFloat(c.total_paid    || 0);    // manual AR payments
        const paid        = cashAtSale + arPaid;
        // Display convention: positive = customer paid more than they bought (advance),
        // negative = customer still owes us. That's the flip of the backend's `outstanding`
        // (which is sold − paid). All conditions below reference this flipped value.
        // 2026-09-07 — the balance carried over from the old system counts as
        // owed, the same as an unpaid sale. This page derives its own figure
        // rather than using the backend's `outstanding`, so leaving it out
        // here made a customer owing K92,998 read as K0.00.
        const opening     = parseFloat(c.opening_balance || 0);
        const balance     = paid - sold - opening;
        const owed        = sold + opening;
        let status = 'No Sales';
        if (c.credit_status === 'OnHold')      status = 'OnHold';
        else if (owed === 0)                   status = 'No Sales';
        else if (balance >= -0.01)             status = 'Paid';     // fully paid or advance
        else if (paid > 0)                     status = 'Partial';
        else                                   status = 'Unpaid';
        // v1.8.57 — carry per-currency outstanding for FRA / K display.
        // Backend computes these using each unpaid order's captured sale rate.
        return {
          ...c, _sold: sold, _paid: paid, _balance: balance, _status: status,
          _opening: opening,
          _outstandingFra: parseFloat(c.outstanding_fra || 0),
          _outstandingK:   parseFloat(c.outstanding_k   || 0),
        };
      });
      setRows(list);
      setStats(statsRes.data || { totalSales: 0, totalReceived: 0, outstanding: 0, customers: 0, owingCount: 0 });
      setPayments(Array.isArray(paymentsRes.data) ? paymentsRes.data : []);
    } catch (err) { /* ignore */ }
    // UX-11 — ageing (all debt as of today, by payment terms); optional.
    getCustomerAging().then(r => setAging(Array.isArray(r.data) ? r.data : [])).catch(() => setAging(null));
  }, [filterFrom, filterTo]);

  useEffect(() => {
    fetchAll();
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
    // v1.8.55 — pull current FX rates so the AR receipt can convert FRA/K
    // to USD at the same rates the Cashier uses.
    getCurrentFxRate().then(r => {
      const d = r.data;
      if (d && d.sell_rate > 0 && d.buy_rate > 0) {
        setFxRate({
          sell:  parseFloat(d.sell_rate)   || 0,
          buy:   parseFloat(d.buy_rate)    || 0,
          sellK: parseFloat(d.sell_rate_k || 0) || 0,
          buyK:  parseFloat(d.buy_rate_k  || 0) || 0,
        });
      }
    }).catch(() => {});
    window.addEventListener('sync-complete', fetchAll);
    return () => window.removeEventListener('sync-complete', fetchAll);
  }, [fetchAll]);

  // Print the receivables list — A4 portrait, matches AP's layout for consistency.
  const handlePrint = () => {
    const fmtPlain = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const period = (filterFrom || filterTo)
      ? `${filterFrom || '—'} to ${filterTo || '—'}`
      : 'All Time';
    const rowsHtml = receivablesRows.map((r, idx) => `
      <tr style="border-bottom:1px solid #e2e8f0;background:${idx % 2 === 1 ? '#f8fafc' : '#fff'}">
        <td style="padding:8px 10px;font-size:10.5px">${idx + 1}</td>
        <td style="padding:8px 10px;font-weight:700">${r.name}</td>
        <td style="padding:8px 10px">${r.phone || '—'}</td>
        <td style="padding:8px 10px;text-align:right">${parseFloat(r.credit_limit) > 0 ? '$' + fmtPlain(r.credit_limit) : '—'}</td>
        <td style="padding:8px 10px;text-align:right">${r._opening > 0 ? '$' + fmtPlain(r._opening) : '—'}</td>
        <td style="padding:8px 10px;text-align:right">${curSym}${fmtPlain(r._sold)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:600">${curSym}${fmtPlain(r._paid)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:700">${curSym}${fmtPlain(Math.abs(r._balance))}${r._balance < -0.01 ? ' (owed)' : r._balance > 0.01 ? ' (advance)' : ''}</td>
        <td style="padding:8px 10px">${r._status === 'OnHold' ? 'On Hold' : r._status}</td>
      </tr>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:8px 10px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10.5px;background:#f1f5f9;text-align:left}
      tfoot td{padding:10px 10px;font-weight:700;background:#f1f5f9;border-top:2px solid #000}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${biz}</div>
          <div style="font-size:10px">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Account Receivables</div>
          <div style="font-size:15px;font-weight:700">Customer Ledger</div>
          <div style="font-size:9px;margin-top:3px">Period: ${period}</div>
          <div style="font-size:9px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        ${[
          ['Total Sales', '$' + fmtPlain(stats.totalSales)],
          ['Total Received', '$' + fmtPlain(stats.totalReceived)],
          ['Outstanding', '$' + fmtPlain(stats.outstanding)],
          ['Customers', `${stats.customers} (${stats.owingCount} owing)`],
        ].map(([lbl, val]) => `
          <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
            <div style="font-size:15px;font-weight:800">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:16px">
        <table style="font-size:11.5px">
          <thead><tr>
            <th style="width:28px">#</th><th>Customer</th><th>Phone</th>
            <th style="text-align:right">Credit Limit</th>
            <th style="text-align:right">Opening Balance</th>
            <th style="text-align:right">Total Sales</th><th style="text-align:right">Total Paid</th>
            <th style="text-align:right">Balance</th><th>Status</th>
          </tr></thead>
          <tbody>${rowsHtml || `<tr><td colspan="9" style="padding:24px;text-align:center;color:#475569">No receivables for this period.</td></tr>`}</tbody>
          ${receivablesRows.length > 0 ? `<tfoot><tr>
            <td colspan="4">TOTAL — ${receivablesRows.length} Customer${receivablesRows.length !== 1 ? 's' : ''}</td>
            <td style="text-align:right">${curSym}${fmtPlain(receivablesRows.reduce((s, r) => s + r._opening, 0))}</td>
            <td style="text-align:right">${curSym}${fmtPlain(receivablesRows.reduce((s, r) => s + r._sold, 0))}</td>
            <td style="text-align:right">${curSym}${fmtPlain(receivablesRows.reduce((s, r) => s + r._paid, 0))}</td>
            <td style="text-align:right;font-size:13px">${curSym}${fmtPlain(receivablesRows.reduce((s, r) => s + r._balance, 0))} (net)</td>
            <td></td>
          </tr></tfoot>` : ''}
        </table>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:32px;margin-bottom:16px">
        ${[['Prepared By', ''], ['Checked By', ''], ['Printed By', printedBy]].map(([label, name]) => `
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #cbd5e1;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px">${biz} — Confidential</span>
        <span style="font-size:9px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  // Receivables tab — only customers with a balance (or who have ever transacted)
  // A customer whose only entry is an opening balance has no sales and no
  // payments, so the old filter hid the very rows this was built for.
  const receivablesRows = rows.filter(r => r._sold > 0 || r._paid > 0 || r._opening > 0)
    .filter(r => matchTokens(search, r.name, r.phone, r.email))
    // By name. Sorted by balance the list reshuffled every time a payment
    // landed, so the row you were looking at moved — and with 25 customers
    // there is no scanning for one by size.
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));

  const paymentsRows = payments.filter(p => matchTokens(search, p.customer_name, p.reference, p.payment_number));

  const openPayment = (c) => {
    // v1.8.55 — default to USD pre-filled with the customer's balance.
    // v1.8.56 — pre-fill sell rates from the current live FX rates;
    //          the accountant can override per-receipt if the customer
    //          negotiated a different rate.
    setPaymentForm({
      usd_amount: c._balance < 0 ? Math.abs(c._balance).toFixed(2) : '',
      fra_amount: '',
      k_amount: '',
      sell_rate:   SELL_RATE   > 0 ? String(SELL_RATE)   : '',
      sell_rate_k: SELL_RATE_K > 0 ? String(SELL_RATE_K) : '',
      payment_date: todayStr(),
      reference: '', notes: '',
    });
    setPaymentModal({ customer: c });
  };
  const savePayment = async () => {
    const usd = parseFloat(paymentForm.usd_amount || 0) || 0;
    const fra = parseFloat(paymentForm.fra_amount || 0) || 0;
    const kAmt= parseFloat(paymentForm.k_amount   || 0) || 0;
    // v1.8.56 — use the per-receipt rate from the form (defaults to
    // current live rate but the accountant may override).
    const sellRate  = parseFloat(paymentForm.sell_rate   || 0) || 0;
    const sellRateK = parseFloat(paymentForm.sell_rate_k || 0) || 0;
    const fraAsUsd = sellRate  > 0 ? fra  / sellRate  : 0;
    const kAsUsd   = sellRateK > 0 ? kAmt / sellRateK : 0;
    const totalUsd = usd + fraAsUsd + kAsUsd;
    if (!(totalUsd > 0)) { showToast('Enter at least one currency > 0', 'error'); return; }
    if (!isLiquorStyle && fra > 0 && !(sellRate > 0))  { showToast('FRA Sell rate is required', 'error'); return; }
    if (!isLiquorStyle && kAmt > 0 && !(sellRateK > 0)){ showToast('K Sell rate is required', 'error'); return; }
    try {
      // v1.10.74 — on Liquor branches, the three fields ARE the payment
      // methods (Cash / Mobile Money / Bank) in native K. Send them as
      // legacy cash_amount / bank_amount / momo_amount so the backend
      // labels the payment method correctly (Cash/Bank/Mobile Money
      // instead of the wrong 'USD'/'FRA'/'K') AND the minted cash_receipt
      // populates the columns Cash Book already reads. Kelete keeps the
      // triple-currency shape with FX rates.
      const payload = isLiquorStyle
        ? {
            customer_id: paymentModal.customer.id,
            // Under the Liquor convention Cash → cash_amount,
            // Mobile Money → momo_amount, Bank → bank_amount. The frontend
            // fields still carry those values under the usd_/fra_/k_ keys
            // (kept for schema symmetry with Kelete), but the payload maps
            // them to legacy method columns.
            cash_amount: usd,
            momo_amount: fra,
            bank_amount: kAmt,
            payment_date: paymentForm.payment_date,
            reference:    paymentForm.reference,
            notes:        paymentForm.notes,
          }
        : {
            customer_id: paymentModal.customer.id,
            usd_amount: usd,
            fra_amount: fra,
            k_amount:   kAmt,
            selling_rate_used:   isDual ? sellRate   : null,
            selling_rate_k_used: hasK   ? sellRateK  : null,
            payment_date: paymentForm.payment_date,
            reference:    paymentForm.reference,
            notes:        paymentForm.notes,
          };
      await createCustomerPayment(payload);
      setPaymentModal(null);
      await fetchAll();
      showToast('Payment recorded — Cash Receipt issued');
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };

  const openStatement = async (c) => {
    try {
      const res = await getCustomerStatement(c.id);
      // Each customer opens on all time, not on the last one's window.
      setStFrom(''); setStTo('');
      setStatementModal(res.data);
    } catch (err) { showToast('Failed to load statement', 'error'); }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDeletePayment = (p) => {
    setPendingDelete({
      subject: `Payment ${fmt(p.amount)} from ${p.customer_name} — voids its Cash Receipt`,
      perform: async () => {
        try { await deleteCustomerPayment(p.id); await fetchAll(); showToast('Payment + Cash Receipt deleted'); }
        catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
      },
    });
  };

  // ── UX-11b · the screen, rebuilt (same data, same actions) ────────────
  const ageById = new Map((aging || []).map(a => [a.id, a]));
  const owedOf = (r) => (r._balance < -0.01 ? -r._balance : 0);
  const overdueOf = (a) => (a ? ['1_30', '31_60', '61_90', '90_plus'].reduce((s, k) => s + Math.max(0, Number(a[k]) || 0), 0) : 0);
  const outstandingOnly = rows.reduce((s, r) => s + Math.max(0, -(parseFloat(r._balance) || 0)), 0);
  const customerCreditOnly = rows.reduce((s, r) => s + Math.max(0, (parseFloat(r._balance) || 0)), 0);
  const ages = ageingTotals(aging || []);
  const overdueTotal = ages.buckets.filter(b => b.key !== 'current').reduce((s, b) => s + b.amount, 0);
  const isOver = (r) => { const cb = creditBar(r.credit_limit, owedOf(r)); return !!(cb && cb.over > 0); };
  const QUICK = [
    { key: 'all', label: 'All', test: () => true },
    { key: 'owing', label: 'Owing', test: (r) => owedOf(r) > 0.01 },
    { key: 'overdue', label: 'Overdue', test: (r) => overdueOf(ageById.get(r.id)) > 0.01 },
    { key: 'over', label: 'Over limit', test: isOver },
    { key: 'paid', label: 'Paid up', test: (r) => owedOf(r) <= 0.01 },
  ];
  const quickDef = QUICK.find(q => q.key === quick) || QUICK[0];
  const shownRows = receivablesRows.filter(quickDef.test);
  const chase = rows.filter(r => owedOf(r) > 0.01)
    .map(r => ({ r, a: ageById.get(r.id), ob: oldestBucket(ageById.get(r.id)) }))
    .filter(x => overdueOf(x.a) > 0.01)
    .sort((x, y) => (['current', '1_30', '31_60', '61_90', '90_plus'].indexOf(y.ob?.key) - ['current', '1_30', '31_60', '61_90', '90_plus'].indexOf(x.ob?.key)) || (overdueOf(y.a) - overdueOf(x.a)))
    .slice(0, 5);
  const isMonth = filterFrom === _firstOfMonth && filterTo === _todayStr;
  const isAll = !filterFrom && !filterTo;
  const periodLabel = isAll ? 'all time' : isMonth ? 'this month' : `${filterFrom || '…'} to ${filterTo || '…'}`;
  const initials = (n) => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const hue = (n) => { let h = 0; for (const ch of String(n || '')) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
  const canPay = hasPermission('AccountReceivables:Add') !== false || hasPermission('Customers:Edit') !== false;

  return (
    <div className="page-content k-ar">
      <PageHero icon={<FiUsers />} title={t('accountReceivables')} date={todayStr()}
        subtitle={t('accountReceivablesSubtitle', { count: stats.owingCount })}
        actions={<>
          <button type="button" onClick={fetchAll} className="k-fc-btn-ghost"><FiRefreshCw size={14} /> {t('refresh')}</button>
          <button type="button" onClick={handlePrint} className="k-fc-btn-hero"><FiPrinter size={15} /> {t('print')}</button>
        </>} />

      {toast && (
        <div role="status" className={`k-ar-toast${toast.type === 'error' ? ' is-error' : ''}`}>{toast.msg}</div>
      )}

      {/* Headline figures */}
      <div className="k-ar-kpis">
        <div className="k-ar-kpi is-main">
          <span>{t('outstanding')}</span>
          <strong className="k-fc-num">{fmt(outstandingOnly)}</strong>
          <em>{stats.owingCount} customer{stats.owingCount === 1 ? '' : 's'} owing{aging && ages.total > 0 ? <> · <b className="k-fc-num">{fmt(overdueTotal)}</b> overdue</> : null}</em>
          {ages.total > 0 && (
            <div className="k-ar-kpi-bar" role="img" aria-label={ages.buckets.map(b => `${b.label}: ${fmt(b.amount)}`).join(', ')}>
              {ages.buckets.filter(b => b.amount > 0).map(b => <div key={b.key} style={{ width: `${(b.amount / ages.total) * 100}%`, background: b.color }} />)}
            </div>
          )}
        </div>
        <div className="k-ar-kpi">
          <span>{t('totalReceived')}</span>
          <strong className="k-fc-num">{fmt(stats.totalReceived)}</strong>
          <em>{periodLabel}</em>
        </div>
        <div className="k-ar-kpi">
          <span>{t('totalSales')}</span>
          <strong className="k-fc-num">{fmt(stats.totalSales)}</strong>
          <em>{periodLabel} · {t('allCustomers').toLowerCase()}</em>
        </div>
        <div className="k-ar-kpi">
          <span>{customerCreditOnly > 0.01 ? t('customerCredit') : t('customers')}</span>
          <strong className="k-fc-num">{customerCreditOnly > 0.01 ? fmt(customerCreditOnly) : stats.customers}</strong>
          <em>{customerCreditOnly > 0.01 ? t('paidInAdvance') : `${stats.owingCount} ${t('owing')}`}</em>
        </div>
      </div>

      {/* Debt by age + who to chase first (all debt as of today) */}
      {aging && ages.total > 0 && (
        <div className="k-ar-pair">
          <section className="k-ar-card" aria-label="Debt by age">
            <header><h3>Debt by age</h3><span>as of today, by each customer's payment terms</span></header>
            <ul className="k-ar-ages">
              {ages.buckets.map(b => (
                <li key={b.key} style={{ '--k-age': b.color }}>
                  <span className="k-ar-age-name"><i aria-hidden="true" />{b.label}</span>
                  <span className="k-ar-age-track" aria-hidden="true"><span style={{ width: `${ages.total > 0 ? (b.amount / ages.total) * 100 : 0}%` }} /></span>
                  <strong className="k-fc-num">{fmt(b.amount)}</strong>
                  <em>{b.customers} cust.</em>
                </li>
              ))}
            </ul>
          </section>
          <section className="k-ar-card" aria-label="Chase first">
            <header><h3>Chase first</h3><span>oldest overdue money first</span></header>
            {chase.length === 0 ? (
              <div className="k-ar-clear"><FiCheckCircle aria-hidden="true" /> Nobody is overdue. Well kept.</div>
            ) : (
              <ol className="k-ar-chase">
                {chase.map(({ r, a, ob }) => (
                  <li key={r.id}>
                    <span className="k-ar-ava" style={{ background: `hsl(${hue(r.name)} 45% 30%)` }} aria-hidden="true">{initials(r.name)}</span>
                    <div className="k-ar-chase-who">
                      <button type="button" className="k-ar-link" onClick={() => openStatement(r)}>{r.name}</button>
                      <span>{ob && <span className="k-age-chip" style={{ '--k-age': ob.color }}>{ob.label}</span>}{r.phone && <a href={`tel:${r.phone.replace(/\s+/g, '')}`} className="k-ar-tel"><FiPhone aria-hidden="true" /> {r.phone}</a>}</span>
                    </div>
                    <div className="k-ar-chase-amt">
                      <strong className="k-fc-num">{fmt(overdueOf(a))}</strong>
                      <em>overdue of {fmt(owedOf(r))}</em>
                    </div>
                    {canPay && <button type="button" className="k-ar-pay" onClick={() => openPayment(r)}>Pay</button>}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}

      {/* Toolbar: tabs, period, search, quick filters, export */}
      <div className="k-ar-toolbar">
        <div className="k-ar-toolbar-row">
          <div className="k-fc-tabs" role="tablist" aria-label="Receivables views" style={{ margin: 0 }}>
            {[{ key: 'receivables', label: t('receivables') }, { key: 'payments', label: t('payments') }].map(x => (
              <button key={x.key} type="button" role="tab" aria-selected={tab === x.key} className="k-fc-tab" onClick={() => setTab(x.key)}>{x.label}</button>
            ))}
          </div>
          <div className="k-ar-period">
            <div className="k-fc-quick" role="group" aria-label={t('filterByDate')}>
              <button type="button" className={`k-fc-chip${isMonth ? ' is-on' : ''}`} aria-pressed={isMonth} onClick={() => { setFilterFrom(_firstOfMonth); setFilterTo(_todayStr); }}>{t('thisMonth')}</button>
              <button type="button" className={`k-fc-chip${isAll ? ' is-on' : ''}`} aria-pressed={isAll} onClick={() => { setFilterFrom(''); setFilterTo(''); }}>{t('allTime')}</button>
            </div>
            <label className="k-ar-date"><span>{t('from')}</span><input type="date" value={filterFrom} max={filterTo || _todayStr} onChange={e => setFilterFrom(e.target.value)} /></label>
            <label className="k-ar-date"><span>{t('to')}</span><input type="date" value={filterTo} min={filterFrom || undefined} max={_todayStr} onChange={e => setFilterTo(e.target.value)} /></label>
          </div>
        </div>
        <div className="k-ar-toolbar-row">
          <label className="k-ar-search">
            <FiSearch aria-hidden="true" />
            <input type="text" placeholder={tab === 'receivables' ? t('searchCustomer') : t('searchByCustomerOrRef')} value={search} onChange={e => setSearch(e.target.value)} aria-label={tab === 'receivables' ? t('searchCustomer') : t('searchByCustomerOrRef')} />
          </label>
          {tab === 'receivables' && (
            <div className="k-ar-quick" role="group" aria-label="Show">
              {QUICK.map(q => {
                const n = receivablesRows.filter(q.test).length;
                return <button key={q.key} type="button" aria-pressed={quick === q.key} className={`k-ar-qchip${quick === q.key ? ' is-on' : ''}`} onClick={() => setQuick(q.key)}>{q.label}<b>{n}</b></button>;
              })}
            </div>
          )}
          <div className="k-ar-export">
            {tab === 'receivables' ? (
              <ExportButtons
                rows={shownRows}
                filename="account-receivables"
                sheetName="Receivables"
                columns={[
                  { key: 'name',         label: 'Customer' },
                  { key: 'phone',        label: 'Phone' },
                  { key: 'credit_limit', label: 'Credit Limit', format: v => Number(v || 0).toFixed(2) },
                  // 2026-09-10 — these read the same derived figures the table shows.
                  { key: '_opening',     label: 'Opening Balance', format: v => Number(v || 0).toFixed(2) },
                  { key: '_sold',        label: 'Total Sales',  format: v => Number(v || 0).toFixed(2) },
                  { key: '_paid',        label: 'Total Paid',   format: v => Number(v || 0).toFixed(2) },
                  { key: '_balance',     label: 'Balance',      format: v => Number(v || 0).toFixed(2) },
                  { key: '_status',      label: 'Status' },
                ]}
                pdfOptions={{ title: 'Account Receivables' }}
              />
            ) : (
              <ExportButtons
                rows={payments}
                filename="customer-payments"
                sheetName="Payments"
                columns={[
                  { key: 'date',          label: 'Date' },
                  { key: 'customer_name', label: 'Customer' },
                  { key: 'method',        label: 'Method' },
                  { key: 'reference',     label: 'Reference' },
                  { key: 'notes',         label: 'Notes' },
                  { key: 'amount',        label: 'Amount', format: v => Number(v || 0).toFixed(2) },
                  { key: 'created_by_name', label: 'By' },
                ]}
                pdfOptions={{ title: 'Customer Payments' }}
              />
            )}
          </div>
        </div>
      </div>

      {/* Receivables */}
      {tab === 'receivables' && (
        <div className="k-ar-list">
          <table className="data-table phone-cards k-ar-table">
            <thead>
              <tr>
                <th>{t('customer')}</th>
                <th>{t('creditLimit')}</th>
                <th className="r">{t('totalSales')} / {t('totalPaid')}</th>
                <th className="r">{t('balance')}</th>
                <th>{t('status')}</th>
                <th className="r">{t('action')}</th>
              </tr>
            </thead>
            <tbody>
              {shownRows.length === 0 ? (
                <tr><td colSpan={6} className="k-ar-empty">{receivablesRows.length === 0 ? t('noReceivables') : `No customers match “${quickDef.label}”${search ? ' and your search' : ''}.`}</td></tr>
              ) : shownRows.map(r => {
                const s = statusBadge(r._status);
                const a = ageById.get(r.id);
                const ob = oldestBucket(a);
                const owed = owedOf(r);
                const cb = parseFloat(r.credit_limit) > 0 ? creditBar(r.credit_limit, owed) : null;
                const segs = a ? [['current', '#0e7490'], ['1_30', '#ca8a04'], ['31_60', '#ea580c'], ['61_90', '#dc2626'], ['90_plus', '#7f1d1d']].map(([k, c]) => ({ k, c, v: Math.max(0, Number(a[k]) || 0) })).filter(x => x.v > 0.005) : [];
                const segTotal = segs.reduce((x, y) => x + y.v, 0);
                return (
                  <tr key={r.id}>
                    <td>
                      <div className="k-ar-cust">
                        <span className="k-ar-ava" style={{ background: `hsl(${hue(r.name)} 45% 30%)` }} aria-hidden="true">{initials(r.name)}</span>
                        <div>
                          <button type="button" className="k-ar-link" onClick={() => openStatement(r)}>{r.name} <FiChevronRight size={13} aria-hidden="true" /></button>
                          <div className="k-ar-sub">{r.phone || 'no phone'}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {cb ? (
                        <div className="k-cl k-cl-left">
                          <span className="k-fc-num">{fmt(r.credit_limit)}</span>
                          <div className={`k-cl-bar is-${cb.level}`} role="img" aria-label={`Credit used: ${Math.round(cb.pct * 100)}%${cb.over > 0 ? `, ${fmt(cb.over)} over the limit` : ''}`}><div style={{ width: `${cb.shown * 100}%` }} /></div>
                          <em>{cb.over > 0 ? `${fmt(cb.over)} over` : `${Math.round(cb.pct * 100)}% used`}</em>
                        </div>
                      ) : <span className="k-ar-sub">no limit</span>}
                    </td>
                    <td className="r">
                      <div className="k-ar-stack">
                        <div className="k-fc-num">{fmt(r._sold)}</div>
                        <div className="k-ar-paid k-fc-num">{fmt(r._paid)} paid</div>
                        {/* 2026-09-10 — the balance carried over from the old system; Balance already counts it. */}
                        {r._opening > 0 && <div className="k-ar-sub">+ {fmt(r._opening)} opening</div>}
                      </div>
                    </td>
                    <td className="r"><div className="k-ar-stack">
                      {/* Signed: −K owed (red), +K paid in advance (green). */}
                      <div className={`k-ar-bal k-fc-num${r._balance < -0.01 ? ' is-owed' : r._balance > 0.01 ? ' is-credit' : ''}`}>
                        {r._balance < -0.01 ? '−' : r._balance > 0.01 ? '+' : ''}{fmt(Math.abs(r._balance))}
                      </div>
                      {/* v1.8.57 — FRA / K equivalents at captured sale rates. */}
                      {r._balance < -0.01 && (r._outstandingFra > 0.01 || r._outstandingK > 0.01) && (
                        <div className="k-ar-sub">
                          ≈ {r._outstandingFra > 0.01 && <>FRA {Math.round(r._outstandingFra).toLocaleString()}</>}
                          {r._outstandingFra > 0.01 && r._outstandingK > 0.01 && ' · '}
                          {r._outstandingK > 0.01 && <>K{Math.round(r._outstandingK).toLocaleString()}</>}
                        </div>
                      )}
                      {segTotal > 0 && (
                        <div className="k-ar-mini" role="img" aria-label={`Owed by age: ${segs.map(x => `${x.k.replace('_', '–').replace('current', 'not yet due')} ${fmt(x.v)}`).join(', ')}`}>
                          {segs.map(x => <span key={x.k} style={{ width: `${(x.v / segTotal) * 100}%`, background: x.c }} />)}
                        </div>
                      )}
                    </div></td>
                    <td>
                      <div className="k-ar-stack is-left">
                        <span className="k-ar-status" style={{ background: s.bg, color: s.fg }}>{r._status === 'OnHold' ? 'On Hold' : r._status}</span>
                        {ob && owed > 0.01 && <span className="k-age-chip" style={{ '--k-age': ob.color }} title={`Oldest money owed: ${ob.label}`}>{ob.key === 'current' ? 'not yet due' : ob.label}</span>}
                      </div>
                    </td>
                    <td className="r">
                      <div className="k-ar-actions">
                        <button type="button" className="k-ar-icon" onClick={() => openStatement(r)} title="Statement" aria-label={`Statement for ${r.name}`}><FiFileText /></button>
                        {/* v1.10.92 — gated on AccountReceivables:Add with a Customers:Edit fallback. */}
                        {canPay && (
                          <button type="button" onClick={() => openPayment(r)} className={`k-ar-pay${r._balance < -0.01 ? '' : ' is-down'}`}>
                            {r._balance < -0.01 ? 'Pay' : 'Down Payment'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Payments */}
      {tab === 'payments' && (
        <div className="k-ar-list">
          <table className="data-table phone-cards k-ar-table">
            <thead>
              <tr>
                {['Date', 'Customer', 'Method', 'Reference', 'Notes', 'Amount', 'By', ''].map((h, i) => (
                  <th key={i} className={i === 5 || i === 7 ? 'r' : ''}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paymentsRows.length === 0 ? (
                <tr><td colSpan={8} className="k-ar-empty">No payments recorded.</td></tr>
              ) : paymentsRows.map(p => (
                <tr key={`${p.source || 'manual'}-${p.id}`} className={p.source === 'pos' ? 'is-pos' : ''}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDay((p.payment_date || '').slice(0, 10))}</td>
                  <td><strong>{p.customer_name || '—'}</strong></td>
                  <td>
                    <span className="k-ar-method">{p.payment_method || '—'}</span>
                    {p.source === 'pos' && <span className="k-ar-pos">POS</span>}
                  </td>
                  <td className="k-ar-sub">{p.reference || '—'}</td>
                  <td className="k-ar-sub">{p.notes || '—'}</td>
                  <td className="r"><strong className="k-fc-num" style={{ color: '#15803d' }}>{fmt(p.amount)}</strong></td>
                  <td className="k-ar-sub">{p.created_by_name || '—'}</td>
                  <td className="r">
                    {p.source !== 'pos' && hasPermission('Customers:Edit') !== false && (
                      <button type="button" className="k-ar-icon is-danger" onClick={() => handleDeletePayment(p)} title="Delete payment" aria-label={`Delete payment from ${p.customer_name}`}><FiTrash2 /></button>
                    )}
                    {p.source === 'pos' && <span className="k-ar-sub" style={{ fontStyle: 'italic' }}>via sale</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            {paymentsRows.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={5}><strong>TOTAL</strong></td>
                  <td className="r"><strong className="k-fc-num" style={{ color: '#15803d' }}>{fmt(paymentsRows.reduce((s, p) => s + parseFloat(p.amount || 0), 0))}</strong></td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {/* Payment modal */}
      {paymentModal && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460, boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <h3 style={{ margin: 0 }}>
                  {paymentModal.customer._balance < -0.01 ? 'Record Payment' : 'Receive Down Payment'}
                </h3>
                <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
                  From <strong>{paymentModal.customer.name}</strong>
                  {paymentModal.customer._balance < -0.01 ? (
                    <>
                      {' · owes '}{fmt(Math.abs(paymentModal.customer._balance))}
                      {/* v1.8.57 — show FRA / K equivalents using captured sale rates. */}
                      {(paymentModal.customer._outstandingFra > 0.01 || paymentModal.customer._outstandingK > 0.01) && (
                        <span style={{ color: '#64748b', fontWeight: 500 }}>
                          {' ≈ '}
                          {paymentModal.customer._outstandingFra > 0.01 && <>FRA {Math.round(paymentModal.customer._outstandingFra).toLocaleString()}</>}
                          {paymentModal.customer._outstandingFra > 0.01 && paymentModal.customer._outstandingK > 0.01 && ' · '}
                          {paymentModal.customer._outstandingK > 0.01 && <>K{Math.round(paymentModal.customer._outstandingK).toLocaleString()}</>}
                          {' (at sale-time rate)'}
                        </span>
                      )}
                    </>
                  ) : <> · advance (credit applied to future credit sales)</>}
                </div>
              </div>
              <button onClick={() => setPaymentModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><FiX size={18} /></button>
            </div>
            <div style={{ padding: 22, display: 'grid', gap: 12 }}>
              {/* v1.8.56 — per-receipt FX rate (defaults to live rate, editable).
                  Only shown when FRA or K is enabled for this tenant.
                  v1.10.73 — hidden on Liquor branches (K-only, native, no FX). */}
              {!isLiquorStyle && (isDual || hasK) && (
                <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#92400e', textTransform: 'uppercase', letterSpacing: 0.4 }}>FX Rate for this receipt</div>
                    <button type="button"
                      onClick={() => setPaymentForm({
                        ...paymentForm,
                        sell_rate:   SELL_RATE   > 0 ? String(SELL_RATE)   : '',
                        sell_rate_k: SELL_RATE_K > 0 ? String(SELL_RATE_K) : '',
                      })}
                      style={{ padding: '3px 10px', fontSize: 11, background: '#fff', color: '#92400e', border: '1px solid #fde68a', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>
                      Reset to default
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: isDual && hasK ? '1fr 1fr' : '1fr', gap: 10 }}>
                    {isDual && (
                      <div>
                        <label style={{ fontSize: 11, color: '#92400e', fontWeight: 600, display: 'block', marginBottom: 3 }}>Sell rate (paid in FRA)</label>
                        <input type="number" min="0" step="0.01" value={paymentForm.sell_rate}
                          onChange={e => setPaymentForm({ ...paymentForm, sell_rate: e.target.value })}
                          placeholder={SELL_RATE > 0 ? String(SELL_RATE) : '0'}
                          style={{ width: '100%', padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13, fontWeight: 600, boxSizing: 'border-box' }} />
                      </div>
                    )}
                    {hasK && (
                      <div>
                        <label style={{ fontSize: 11, color: '#92400e', fontWeight: 600, display: 'block', marginBottom: 3 }}>Sell rate (paid in K)</label>
                        <input type="number" min="0" step="0.01" value={paymentForm.sell_rate_k}
                          onChange={e => setPaymentForm({ ...paymentForm, sell_rate_k: e.target.value })}
                          placeholder={SELL_RATE_K > 0 ? String(SELL_RATE_K) : '0'}
                          style={{ width: '100%', padding: '6px 8px', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: 13, fontWeight: 600, boxSizing: 'border-box' }} />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* v1.8.55 — Kelete triple-currency receipt: USD / FRA / K.
                  v1.10.73 — Liquor branches show Cash / Mobile Money / Bank
                  instead (all in native K, no FX). Same field-to-column
                  mapping as CashReceipt.js: Cash→usd_amount,
                  MoMo→fra_amount, Bank→k_amount — keeps the receipt row
                  compatible with the existing customer_payments schema and
                  Cash Book split logic. */}
              <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                Amount Paid{isLiquorStyle ? ' (split across methods)' : ' (split across currencies)'}
              </div>
              {(() => {
                const fields = isLiquorStyle
                  ? [
                      { key: 'usd_amount', label: 'Cash',         color: '#15803d', step: '0.01', placeholder: '0.00', show: true },
                      // 2026-09-11 — MoMo / Bank follow System Settings → Payment methods shown.
                      { key: 'fra_amount', label: 'Mobile Money', color: '#c2410c', step: '0.01', placeholder: '0.00', show: methodShown('momo') },
                      { key: 'k_amount',   label: 'Bank',         color: '#2563eb', step: '0.01', placeholder: '0.00', show: methodShown('bank') },
                    ]
                  : [
                      { key: 'usd_amount', label: 'USD', color: '#15803d', step: '0.01', placeholder: '0.00', show: true },
                      { key: 'fra_amount', label: 'FRA', color: '#2563eb', step: '1',    placeholder: '0',    show: isDual },
                      { key: 'k_amount',   label: 'K',   color: '#7c3aed', step: '1',    placeholder: '0',    show: hasK   },
                    ].filter(f => f.show);
                const cols = `repeat(${fields.length}, 1fr)`;
                return (
                  <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 10 }}>
                    {fields.map((f, i) => (
                      <div key={f.key}>
                        <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                        <input type="number" min="0" step={f.step} autoFocus={i === 0}
                          value={paymentForm[f.key]}
                          onChange={e => setPaymentForm({ ...paymentForm, [f.key]: e.target.value })}
                          placeholder={f.placeholder}
                          style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(paymentForm[f.key] || 0) > 0 ? f.color : '#cbd5e1'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(paymentForm[f.key] || 0) > 0 ? f.color : '#334155', boxSizing: 'border-box' }} />
                      </div>
                    ))}
                  </div>
                );
              })()}
              {(() => {
                const usd = parseFloat(paymentForm.usd_amount || 0) || 0;
                const fra = parseFloat(paymentForm.fra_amount || 0) || 0;
                const kAmt= parseFloat(paymentForm.k_amount   || 0) || 0;
                // v1.10.73 — Liquor: all three fields are native K, just sum
                // them and display with tenant symbol. Kelete: convert
                // FRA + K → USD via the receipt's FX rate.
                if (isLiquorStyle) {
                  const totalK = usd + fra + kAmt;
                  return (
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f8fafc', borderRadius: 6, fontSize: 13 }}>
                      <span style={{ color: '#64748b' }}>Total</span>
                      <span style={{ fontWeight: 800, color: totalK > 0 ? '#1d4ed8' : '#64748b' }}>{fmt(totalK)}</span>
                    </div>
                  );
                }
                const sellRate  = parseFloat(paymentForm.sell_rate   || 0) || 0;
                const sellRateK = parseFloat(paymentForm.sell_rate_k || 0) || 0;
                const fraAsUsd = sellRate  > 0 ? fra  / sellRate  : 0;
                const kAsUsd   = sellRateK > 0 ? kAmt / sellRateK : 0;
                const totalUsd = usd + fraAsUsd + kAsUsd;
                return (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f8fafc', borderRadius: 6, fontSize: 13 }}>
                    <span style={{ color: '#64748b' }}>Total (≈ USD)</span>
                    <span style={{ fontWeight: 800, color: totalUsd > 0 ? '#1d4ed8' : '#64748b' }}>{fmt(totalUsd)}</span>
                  </div>
                );
              })()}
              <div className="form-group">
                <label>Date</label>
                <input type="date" value={paymentForm.payment_date} onChange={e => setPaymentForm({ ...paymentForm, payment_date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Reference (optional)</label>
                <input value={paymentForm.reference} onChange={e => setPaymentForm({ ...paymentForm, reference: e.target.value })} placeholder="invoice / receipt number" />
              </div>
              <div className="form-group">
                <label>Notes</label>
                <input value={paymentForm.notes} onChange={e => setPaymentForm({ ...paymentForm, notes: e.target.value })} />
              </div>
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setPaymentModal(null)} style={{ padding: '8px 16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
              <button onClick={savePayment} style={{ padding: '8px 18px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>Record</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Statement modal — 2026-09-10: one chronological ledger, the same shape
          as Kelete's AP supplier statement. Sales in Debit (+), payments in
          Credit (−), a running balance down the right. It replaced three
          separate boxes (opening balance, orders, payments) that each had their
          own total and never showed the balance moving: you could not see what
          was owed on a given day without doing the sum yourself. */}
      {statementModal && (() => {
        const cust    = statementModal.customer || {};
        const entries = statementModal.entries || [];
        const day     = (d) => String(d || '').slice(0, 10);
        // The opening balance is dated 1970 on the server so it sorts first.
        // That date means "before this system", not a real day, so it prints
        // as a dash.
        const fmtD = (d) => {
          const s = day(d);
          if (!s || s < '1971') return '—';
          const dt = new Date(s + 'T00:00:00');
          return isNaN(dt) ? s : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        };
        const money = (v) => `${curSym}${Math.abs(parseFloat(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const esc   = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        // One event per entry. Within a day: opening, then the sale, then what
        // was paid — so a sale settled at the till reads as sale-then-payment,
        // not the other way round.
        const RANK = { opening: 0, order: 1, payment: 2 };
        const allEvs = entries.map((e, i) => {
          const amt  = parseFloat(e.amount) || 0;
          const base = { key: `${e.type}-${e.id}-${i}`, date: day(e.date), sortKey: `${day(e.date)} ${RANK[e.type] ?? 3} ${e.date || ''}` };
          if (e.type === 'opening') {
            return { ...base, kind: 'OB', doc: '—', orderId: null,
                     reference: 'Opening balance — carried over, before this system',
                     debit: amt > 0 ? amt : 0, credit: amt < 0 ? amt : 0 };
          }
          if (e.type === 'order') {
            return { ...base, kind: 'INV', doc: e.order_number ? fmtInvoiceNo(e.order_number) : '—', orderId: e.id,
                     reference: 'Sale', debit: amt, credit: 0 };
          }
          // Payments arrive negative from the server: they reduce what is owed.
          const pos    = e.source === 'pos';
          const method = e.payment_method || 'Cash';
          return { ...base, kind: 'PAY',
                   doc: pos ? (e.reference ? fmtInvoiceNo(e.reference) : '—') : (e.receipt_number || '—'),
                   orderId: pos ? e.order_id : null,
                   reference: pos ? `Paid at sale · ${method}` : [method, e.reference, e.notes].filter(Boolean).join(' · '),
                   debit: 0, credit: amt };
        }).sort((a, b) => a.sortKey.localeCompare(b.sortKey));

        // Window: everything before "From" becomes the brought-forward figure.
        const inRange = (d) => (!stFrom || d >= stFrom) && (!stTo || d <= stTo);
        const pre = allEvs.filter(e => stFrom && e.date < stFrom);
        const evs = allEvs.filter(e => inRange(e.date));
        const bf  = pre.reduce((s, e) => s + e.debit + e.credit, 0);
        let running = bf;
        const rows = evs.map(e => { running += e.debit + e.credit; return { ...e, balance: running }; });
        const totalDebit  = evs.reduce((s, e) => s + e.debit, 0);
        const totalCredit = evs.reduce((s, e) => s + e.credit, 0);
        const finalBal    = bf + totalDebit + totalCredit;   // positive = customer owes us

        // Age analysis, as of today and over all time regardless of the window.
        // Payments clear the oldest debt first. The opening balance has no real
        // date, so it gets its own bucket rather than being called 120+ days.
        const allBal = allEvs.reduce((s, e) => s + e.debit + e.credit, 0);
        const age = { opening: 0, current: 0, b31_60: 0, b61_90: 0, b91_120: 0, b120plus: 0 };
        if (allBal > 0.01) {
          const debts = allEvs.filter(e => e.debit > 0).map(e => ({ kind: e.kind, date: e.date, remain: e.debit }));
          let pool = -allEvs.reduce((s, e) => s + e.credit, 0);
          for (const d of debts) { if (pool <= 0) break; const take = Math.min(pool, d.remain); d.remain -= take; pool -= take; }
          const now = new Date();
          for (const d of debts) {
            if (d.remain < 0.01) continue;
            if (d.kind === 'OB') { age.opening += d.remain; continue; }
            const days = Math.floor((now - new Date(d.date + 'T00:00:00')) / 86400000);
            if (days <= 30)       age.current  += d.remain;
            else if (days <= 60)  age.b31_60   += d.remain;
            else if (days <= 90)  age.b61_90   += d.remain;
            else if (days <= 120) age.b91_120  += d.remain;
            else                  age.b120plus += d.remain;
          }
        }
        const ageCells = [
          ['Opening b/f', age.opening], ['Current', age.current], ['31-60', age.b31_60],
          ['61-90', age.b61_90], ['91-120', age.b91_120], ['120+', age.b120plus],
        ];

        // Local-date presets. toISOString() would give yesterday's date for
        // the first two hours of every day in Zambia (UTC+2).
        const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const now      = new Date();
        const todayIso = iso(now);
        const som      = iso(new Date(now.getFullYear(), now.getMonth(), 1));
        const prevSom  = iso(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        const prevEom  = iso(new Date(now.getFullYear(), now.getMonth(), 0));
        const windowLabel = stFrom || stTo ? `${stFrom || '—'} to ${stTo || '—'}` : 'All time';

        const balColor = (v) => (v > 0.01 ? '#dc2626' : v < -0.01 ? '#16a34a' : '#334155');
        const signed   = (v) => `${v < -0.01 ? '−' : ''}${money(v)}`;
        const verdict  = finalBal > 0.01 ? 'Customer owes you:' : finalBal < -0.01 ? 'Customer is in credit (advance):' : 'Account is square';
        const pill = (kind) => (
          kind === 'INV' ? { bg: '#fee2e2', fg: '#991b1b' }
          : kind === 'PAY' ? { bg: '#dcfce7', fg: '#166534' }
          : { bg: '#fef3c7', fg: '#92400e' }
        );

        const handleStatementPrint = () => {
          const biz       = businessInfo.business_name || 'Business Name';
          const addr      = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
          const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
          const pillCss   = (k) => { const p = pill(k); return `background:${p.bg};color:${p.fg};padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700`; };

          const bfRow = stFrom && Math.abs(bf) > 0.001 ? `
            <tr style="background:#fefce8;border-bottom:1px solid #fde68a">
              <td colspan="4" style="padding:6px 10px;font-style:italic;color:#a16207">Balance brought forward (before ${esc(fmtD(stFrom))})</td>
              <td></td><td></td>
              <td style="padding:6px 10px;text-align:right;font-weight:700;color:${balColor(bf)}">${signed(bf)}</td>
            </tr>` : '';

          const bodyRows = rows.length === 0
            ? `<tr><td colspan="7" style="padding:20px;text-align:center;color:#94a3b8">No transactions in this window.</td></tr>`
            : rows.map(r => `
              <tr style="border-bottom:1px solid #f1f5f9">
                <td style="padding:5px 9px;color:#334155;white-space:nowrap">${esc(fmtD(r.date))}</td>
                <td style="padding:5px 9px;color:#64748b;font-family:monospace;font-size:9.5px">${esc(r.doc)}</td>
                <td style="padding:5px 9px"><span style="${pillCss(r.kind)}">${r.kind}</span></td>
                <td style="padding:5px 9px;color:${r.kind === 'PAY' ? '#64748b' : '#000'};font-weight:${r.kind === 'PAY' ? '400' : '700'}">${esc(r.reference) || '—'}</td>
                <td style="padding:5px 9px;text-align:right;font-family:monospace;color:${r.debit > 0 ? '#dc2626' : '#cbd5e1'}">${r.debit > 0 ? `+${money(r.debit)}` : ''}</td>
                <td style="padding:5px 9px;text-align:right;font-family:monospace;color:${r.credit < 0 ? '#15803d' : '#cbd5e1'}">${r.credit < 0 ? `−${money(r.credit)}` : ''}</td>
                <td style="padding:5px 9px;text-align:right;font-family:monospace;font-weight:600;color:${balColor(r.balance)}">${signed(r.balance)}</td>
              </tr>`).join('');

          const ageHtml = allBal > 0.01 ? `
            <div style="margin-top:16px;padding:10px 14px;border:1.5px solid #000">
              <div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px">Age analysis (as of today)</div>
              <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px;font-size:10px;text-align:center">
                ${ageCells.map(([l, v]) => `
                  <div style="border:1px solid #e2e8f0;padding:6px;background:${v > 0.01 ? '#fef2f2' : '#fff'}">
                    <div style="font-size:9px;color:#64748b;font-weight:600">${l}</div>
                    <div style="font-size:11px;font-weight:700;color:${v > 0.01 ? '#dc2626' : '#64748b'};font-family:monospace">${money(v)}</div>
                  </div>`).join('')}
              </div>
            </div>` : '';

          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Statement — ${esc(cust.name)}</title>
            <style>@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box;margin:0;padding:0}
            body{font-family:"Segoe UI",Arial,sans-serif;font-size:11px;color:#000}
            table{width:100%;border-collapse:collapse}
            th{padding:6px 10px;font-weight:700;color:#000;border-bottom:2px solid #000;font-size:10px;background:#f1f5f9;text-align:left}
            tfoot td{padding:7px 10px;font-weight:700;background:#f1f5f9;border-top:2px solid #000}
            </style></head><body>
            <div style="border-bottom:3px solid #000;padding-bottom:10px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:flex-start">
              <div>
                <div style="font-size:8px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Statement</div>
                <div style="font-size:18px;font-weight:800;margin-bottom:3px">${esc(biz)}</div>
                <div style="font-size:9.5px">${esc(addr)}</div>
              </div>
              <div style="text-align:right">
                <div style="font-size:8px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Customer</div>
                <div style="font-size:14px;font-weight:700">${esc(cust.name)}</div>
                ${cust.phone ? `<div style="font-size:9px;margin-top:2px">${esc(cust.phone)}</div>` : ''}
                ${cust.tpin ? `<div style="font-size:9px">TPIN: ${esc(cust.tpin)}</div>` : ''}
                <div style="font-size:9px;margin-top:2px">Statement Date: ${esc(fmtD(todayIso))}</div>
                <div style="font-size:9px">Window: ${esc(windowLabel)}</div>
              </div>
            </div>

            <div style="font-size:9px;color:#64748b;margin-bottom:10px">
              Convention: sales and the opening balance in Debit (+), payments in Credit (−). Balance is signed: positive = customer owes you, negative = customer is in credit.
            </div>

            <div style="border:1.5px solid #000;margin-bottom:14px">
              <table>
                <thead>
                  <tr>
                    <th>Date</th><th>Doc #</th><th>Type</th><th>Reference</th>
                    <th style="text-align:right;color:#dc2626">Debit (+)</th>
                    <th style="text-align:right;color:#16a34a">Credit (−)</th>
                    <th style="text-align:right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  ${bfRow}
                  ${bodyRows}
                </tbody>
                <tfoot>
                  <tr>
                    <td colspan="4" style="text-align:right">Totals</td>
                    <td style="text-align:right;color:#dc2626">+${money(totalDebit)}</td>
                    <td style="text-align:right;color:#16a34a">−${money(totalCredit)}</td>
                    <td style="text-align:right;color:${balColor(finalBal)}">${signed(finalBal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div style="border:2px solid #000;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
              <span style="font-weight:700;font-size:13px">${verdict}</span>
              <span style="font-weight:800;font-size:17px;color:${balColor(finalBal)}">${money(finalBal)}</span>
            </div>

            ${ageHtml}

            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-top:26px;margin-bottom:14px">
              ${[['Prepared By', ''], ['Checked By', ''], ['Printed By', printedBy]].map(([label, name]) => `
                <div>
                  <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:5px">${label}</div>
                  <div style="font-size:10px;font-weight:600;min-height:16px;margin-bottom:5px">${esc(name)}</div>
                  <div style="height:28px;border-bottom:1.5px solid #000;margin-bottom:3px"></div>
                  <div style="font-size:8px;text-align:center">Name / Signature / Date</div>
                </div>`).join('')}
            </div>
            <div style="border-top:1px solid #cbd5e1;padding-top:6px;display:flex;justify-content:space-between">
              <span style="font-size:8px">${esc(biz)} — Confidential</span>
              <span style="font-size:8px">Printed: ${esc(printedAt)}</span>
            </div>
          </body></html>`;
          const w = window.open('', '_blank');
          if (!w) return;
          w.document.write(html); w.document.close(); w.focus();
          setTimeout(() => { w.print(); w.close(); }, 300);
        };

        const presetBtn = { padding: '4px 10px', borderRadius: 6, border: '1px solid #bfdbfe', fontSize: 11, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 };
        const th = (align, color) => ({ textAlign: align, padding: '8px 10px', fontWeight: 700, color });
        const docLink = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#2563eb', textDecoration: 'underline', fontFamily: 'var(--k-font-mono)', fontSize: 11 };

        return (
          <Portal>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 1200, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid #e2e8f0', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{cust.name}</h2>
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>Customer account breakdown</p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button onClick={handleStatementPrint}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                    <FiPrinter size={13} /> Print
                  </button>
                  <button onClick={() => setStatementModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><FiX size={20} /></button>
                </div>
              </div>

              <div style={{ padding: '18px 24px' }}>
                {/* Statement header */}
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '14px 16px', marginBottom: 12, fontSize: 12 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div>
                      <div><strong>Statement Date:</strong> {fmtD(todayIso)}</div>
                      <div><strong>Customer:</strong> {cust.name}</div>
                      {cust.phone && <div><strong>Phone:</strong> {cust.phone}</div>}
                      {cust.tpin && <div><strong>TPIN:</strong> {cust.tpin}</div>}
                    </div>
                    <div>
                      <div style={{ color: '#64748b' }}>Convention: sales and the opening balance in Debit (+), payments in Credit (−).</div>
                      <div style={{ color: '#64748b' }}>Balance is signed: positive = customer owes you, negative = customer is in credit.</div>
                    </div>
                  </div>
                </div>

                {/* Statement window */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, padding: '8px 12px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#64748b' }}>Statement window:</span>
                  <span style={{ fontSize: 11, color: '#64748b' }}>From</span>
                  <input type="date" value={stFrom} max={stTo || todayIso} onChange={e => setStFrom(e.target.value)}
                    style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 }} />
                  <span style={{ fontSize: 11, color: '#64748b' }}>To</span>
                  <input type="date" value={stTo} min={stFrom || undefined} max={todayIso} onChange={e => setStTo(e.target.value)}
                    style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', fontSize: 12 }} />
                  <button onClick={() => { setStFrom(som); setStTo(todayIso); }} style={presetBtn}>This Month</button>
                  <button onClick={() => { setStFrom(prevSom); setStTo(prevEom); }} style={presetBtn}>Last Month</button>
                  <button onClick={() => { setStFrom(''); setStTo(''); }}
                    style={{ ...presetBtn, border: '1px solid #e2e8f0', background: '#fff', color: '#64748b', fontWeight: 400 }}>All Time</button>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#64748b' }}>
                    {stFrom || stTo ? windowLabel : 'Showing all time'}
                  </span>
                </div>

                {/* The ledger */}
                <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginBottom: 14 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc', borderBottom: '2px solid #cbd5e1' }}>
                      <th style={th('left')}>Date</th>
                      <th style={th('left')}>Doc #</th>
                      <th style={th('left')}>Type</th>
                      <th style={th('left')}>Reference</th>
                      <th style={th('right', '#dc2626')}>Debit (+)</th>
                      <th style={th('right', '#16a34a')}>Credit (−)</th>
                      <th style={th('right')}>Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stFrom && Math.abs(bf) > 0.001 && (
                      <tr style={{ background: '#fefce8', borderBottom: '1px solid #fde68a' }}>
                        <td colSpan={4} style={{ padding: '6px 10px', fontStyle: 'italic', color: '#a16207' }}>
                          Balance brought forward (before {fmtD(stFrom)})
                        </td>
                        <td colSpan={2}></td>
                        <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'var(--k-font-mono)', fontWeight: 700, color: balColor(bf) }}>{signed(bf)}</td>
                      </tr>
                    )}
                    {rows.length === 0 && (
                      <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: '#64748b' }}>No transactions in this window.</td></tr>
                    )}
                    {rows.map(r => {
                      const p = pill(r.kind);
                      return (
                        <tr key={r.key} style={{ borderBottom: '1px solid #f1f5f9', background: r.kind === 'OB' ? '#fffbeb' : undefined }}>
                          <td style={{ padding: '6px 10px', color: '#334155', whiteSpace: 'nowrap' }}>{fmtD(r.date)}</td>
                          {/* A sale, and a payment taken at the till, open the
                              order. A receipt number is plain text. */}
                          <td style={{ padding: '6px 10px', fontFamily: 'var(--k-font-mono)', fontSize: 11 }}>
                            {r.orderId
                              ? <button onClick={() => openOrderDetail(r.orderId)} title="View order details" style={docLink}>{r.doc}</button>
                              : <span style={{ color: '#64748b' }}>{r.doc}</span>}
                          </td>
                          <td style={{ padding: '6px 10px' }}>
                            <span style={{ background: p.bg, color: p.fg, padding: '1px 7px', borderRadius: 3, fontSize: 10, fontWeight: 700 }}>{r.kind}</span>
                          </td>
                          <td style={{ padding: '6px 10px', color: r.kind === 'PAY' ? '#64748b' : '#0f172a', fontWeight: r.kind === 'PAY' ? 400 : 700 }}>{r.reference || '—'}</td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'var(--k-font-mono)', color: r.debit > 0 ? '#dc2626' : '#cbd5e1' }}>
                            {r.debit > 0 ? `+${money(r.debit)}` : ''}
                          </td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'var(--k-font-mono)', color: r.credit < 0 ? '#15803d' : '#cbd5e1' }}>
                            {r.credit < 0 ? `−${money(r.credit)}` : ''}
                          </td>
                          <td style={{ padding: '6px 10px', textAlign: 'right', fontFamily: 'var(--k-font-mono)', fontWeight: 600, color: balColor(r.balance) }}>
                            {signed(r.balance)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f8fafc', borderTop: '2px solid #cbd5e1', fontWeight: 700 }}>
                      <td colSpan={4} style={{ padding: '8px 10px', textAlign: 'right' }}>Totals</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'var(--k-font-mono)', color: '#dc2626' }}>+{money(totalDebit)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'var(--k-font-mono)', color: '#15803d' }}>−{money(totalCredit)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'var(--k-font-mono)', color: balColor(finalBal) }}>{signed(finalBal)}</td>
                    </tr>
                  </tfoot>
                </table>

                {/* Where the account stands */}
                <div style={{ background: finalBal > 0.01 ? '#fef2f2' : finalBal < -0.01 ? '#f0fdf4' : '#f8fafc',
                              border: `1px solid ${finalBal > 0.01 ? '#fecaca' : finalBal < -0.01 ? '#bbf7d0' : '#e2e8f0'}`,
                              borderRadius: 8, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontWeight: 700, fontSize: 14 }}>{verdict}</span>
                  <span style={{ fontWeight: 800, fontSize: 18, color: balColor(finalBal) }}>{money(finalBal)}</span>
                </div>

                {/* Age analysis — only while the customer owes something */}
                {allBal > 0.01 && (
                  <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Age analysis (as of today)</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8, fontSize: 12 }}>
                      {ageCells.map(([label, val]) => (
                        <div key={label} style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '8px 10px', textAlign: 'center', background: val > 0.01 ? '#fef2f2' : '#fff' }}>
                          <div style={{ fontSize: 10, color: '#64748b', fontWeight: 600 }}>{label}</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: val > 0.01 ? '#dc2626' : '#64748b', fontFamily: 'var(--k-font-mono)' }}>{money(val)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          </Portal>
        );
      })()}

      {/* Order detail modal — opened by clicking an order# anywhere in the AR statement. */}
      {orderDetail && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 640, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 22px', borderBottom: '1px solid #e2e8f0' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{orderDetail.data?.order_number ? fmtInvoiceNo(orderDetail.data.order_number) : 'Order'}</h3>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#64748b' }}>Sale details</p>
              </div>
              <button onClick={() => setOrderDetail(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><FiX size={20} /></button>
            </div>
            <div style={{ padding: '18px 22px' }}>
              {orderDetail.loading && <div style={{ color: '#64748b', fontSize: 13 }}>Loading…</div>}
              {orderDetail.error && <div style={{ color: '#dc2626', fontSize: 13 }}>{orderDetail.error}</div>}
              {orderDetail.data && (() => {
                const o = orderDetail.data;
                const items = o.items || [];
                const c = parseFloat(o.cash_received || 0);
                const b = parseFloat(o.bank_received || 0);
                const m = parseFloat(o.momo_received || 0);
                const tendered = c + b + m;
                const sale = parseFloat(o.total_amount || 0);
                const change = Math.max(0, tendered - sale);
                const credit = Math.max(0, sale - tendered);
                return (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 14, fontSize: 13 }}>
                      <div><span style={{ color: '#64748b' }}>Date: </span><strong>{(o.created_at || '').slice(0, 10)}</strong></div>
                      <div><span style={{ color: '#64748b' }}>Customer: </span><strong>{o.customer_name || 'Walk-in'}</strong></div>
                      <div><span style={{ color: '#64748b' }}>Cashier: </span><strong>{o.created_by_name || '—'}</strong></div>
                      <div><span style={{ color: '#64748b' }}>Status: </span><strong>{o.status || 'Active'}</strong></div>
                    </div>
                    <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 14 }}>
                      <thead>
                        <tr style={{ background: '#f8fafc' }}>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600, borderBottom: '1px solid #e2e8f0' }}>Item</th>
                          <th style={{ textAlign: 'right', padding: '7px 10px', fontWeight: 600, borderBottom: '1px solid #e2e8f0' }}>Qty</th>
                          <th style={{ textAlign: 'left',  padding: '7px 10px', fontWeight: 600, borderBottom: '1px solid #e2e8f0' }}>Unit</th>
                          <th style={{ textAlign: 'right', padding: '7px 10px', fontWeight: 600, borderBottom: '1px solid #e2e8f0' }}>Price</th>
                          <th style={{ textAlign: 'right', padding: '7px 10px', fontWeight: 600, borderBottom: '1px solid #e2e8f0' }}>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((it, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '7px 10px' }}>{it.product_name}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'var(--k-font-mono)' }}>{(parseFloat(parseFloat(it.quantity))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                            <td style={{ padding: '7px 10px', color: '#64748b' }}>{it.unit || '—'}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'var(--k-font-mono)' }}>{fmt(it.unit_price)}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', fontFamily: 'var(--k-font-mono)', fontWeight: 600 }}>{fmt(it.total_price)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {/* Totals + payment breakdown */}
                    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '12px 14px', fontSize: 13 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                        <span style={{ color: '#64748b' }}>Subtotal</span><span>{fmt(o.subtotal)}</span>
                      </div>
                      {parseFloat(o.discount) > 0 && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ color: '#64748b' }}>Discount</span><span>−{fmt(o.discount)}</span>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontWeight: 700, fontSize: 14 }}>
                        <span>Total</span><span>{fmt(sale)}</span>
                      </div>
                      <div style={{ borderTop: '1px dashed #cbd5e1', paddingTop: 8, marginTop: 4 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Payment</div>
                        {c > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#15803d' }}>Cash</span><span>{fmt(c)}</span></div>}
                        {m > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#f59e0b' }}>Mobile Money</span><span>{fmt(m)}</span></div>}
                        {b > 0 && <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: '#2563eb' }}>Bank</span><span>{fmt(b)}</span></div>}
                        {tendered === 0 && <div style={{ color: '#64748b' }}>Full credit — nothing tendered at till</div>}
                        {change > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, color: '#1d4ed8' }}><span>Change given</span><span>{fmt(change)}</span></div>}
                        {credit > 0 && <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, color: '#dc2626', fontWeight: 700 }}><span>On credit (AR)</span><span>{fmt(credit)}</span></div>}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>
            <div style={{ padding: '12px 22px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setOrderDetail(null)} style={{ padding: '8px 18px', background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 7, cursor: 'pointer', fontWeight: 600 }}>Close</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={pendingDelete?.subject || ''}
        actionLabel={pendingDelete?.actionLabel || 'Confirm Delete'}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

export default AccountReceivables;
