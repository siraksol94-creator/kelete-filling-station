import React, { useState, useEffect } from 'react';
import { getCashReceipts, getCashReceiptStats, createCashReceipt, updateCashReceipt, deleteCashReceipt, getSettings, isHqHost } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';
import { FiPlus, FiDollarSign, FiCalendar, FiFileText, FiEye, FiEdit2, FiPrinter, FiX } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const getPaymentColor = (method) => {
  const map = { 'Cash': 'badge-green', 'Card': 'badge-blue', 'Check': 'badge-purple', 'Transfer': 'badge-orange' };
  return map[method] || 'badge-gray';
};

const todayStr = new Date().toISOString().split('T')[0];

const CashReceipt = () => {
  const { hasPermission } = useAuth();
  const { symbol: curSym, isLiquorStyle: rawLiquorStyle, methodShown } = useCurrency();
  // v1.10.68 â€” HQ is Kelete's Head Office, not a Liquor branch. Regardless
  // of how its tenant settings evaluate (currency_mode='K' +
  // payment_methods='cash_momo_bank' would flip rawLiquorStyle to true),
  // the CR modal here must offer a K / USD / FRA choice with K default â€”
  // HQ collects K by default (branch deposits, transport, etc.) but also
  // needs USD and FRA lanes for cross-currency inflows.
  const onHq = isHqHost();
  // v1.13.46 â€” Kelete HQ is K-only (no tri-currency branches), so drop
  // the Kelete-era `&& !onHq` override that forced multi-currency lanes
  // on the HQ host. Business settings drive isLiquorStyle correctly.
  const isLiquorStyle = rawLiquorStyle;
  const { t } = useLanguage();
  // v1.8.32 â€” per-currency totals. Backend returns today/month/total
  // breakdowns alongside the legacy USD-only fields.
  const [stats, setStats]     = useState({
    todayReceipts: 0, thisMonth: 0, totalReceipts: 0,
    today: { usd: 0, fra: 0, k: 0 },
    month: { usd: 0, fra: 0, k: 0 },
    total: { usd: 0, fra: 0, k: 0 },
  });
  const [receipts, setReceipts] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [formError, setFormError] = useState('');

  // Date filter â€” default to today
  const [filterFrom, setFilterFrom] = useState(todayStr);
  const [filterTo,   setFilterTo]   = useState(todayStr);

  // View / print
  const [viewReceipt, setViewReceipt] = useState(null);
  const [showCRPrint, setShowCRPrint] = useState(false);
  const [showListPrint, setShowListPrint] = useState(false);

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(!!viewReceipt || showForm);
  const [businessInfo, setBusinessInfo] = useState({});

  // Edit
  const [editMode, setEditMode] = useState(false);
  const [editId,   setEditId]   = useState(null);

  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  // v1.8.32 â€” triple-currency form. usd/fra/k each in own currency
  // (same shape as PV modal). Legacy cash/bank/momo dropped from the
  // form state â€” backend still accepts them for old API callers.
  const [form, setForm] = useState({
    received_from: '', description: '',
    usd_amount: '', fra_amount: '', k_amount: '',
    date: todayStr,
  });

  const fetchData = async () => {
    try {
      const [statsRes, receiptsRes] = await Promise.all([getCashReceiptStats(), getCashReceipts()]);
      if (statsRes.data) setStats(statsRes.data);
      setReceipts(receiptsRes.data || []);
    } catch (err) { /* use defaults */ }
  };

  useEffect(() => {
    fetchData();
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
  }, []);

  // Client-side filter
  const filteredReceipts = receipts.filter(r => {
    const d = (r.date || '').split('T')[0];
    if (filterFrom && d < filterFrom) return false;
    if (filterTo   && d > filterTo)   return false;
    return true;
  });

  const filteredTotal = filteredReceipts.reduce((s, r) => s + parseFloat(r.amount || 0), 0);

  const openForm = () => {
    setEditMode(false);
    setEditId(null);
    setForm({ received_from: '', description: '', usd_amount: '', fra_amount: '', k_amount: '', date: todayStr });
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (r) => {
    setEditMode(true);
    setEditId(r.id);
    // v1.8.32 â€” prefer usd/fra/k columns; fall back to legacy
    // cash/bank/momo (treated as USD/FRA/K respectively for old rows
    // that pre-date the triple-currency split), then to legacy amount
    // as a USD bucket so the form is always editable.
    const usd = parseFloat(r.usd_amount || r.cash_amount || 0) || 0;
    const fra = parseFloat(r.fra_amount || r.bank_amount || 0) || 0;
    const k   = parseFloat(r.k_amount   || r.momo_amount || 0) || 0;
    const splitsSum = usd + fra + k;
    const legacy = parseFloat(r.amount || 0) || 0;
    setForm({
      received_from:  r.received_from  || '',
      description:    r.description    || '',
      usd_amount:     splitsSum > 0 ? (usd > 0 ? String(usd) : '') : (legacy > 0 ? String(legacy) : ''),
      fra_amount:     fra > 0 ? String(fra) : '',
      k_amount:       k   > 0 ? String(k)   : '',
      date:           (r.date || todayStr).split('T')[0],
    });
    setFormError('');
    setShowForm(true);
  };

  const handleSave = async () => {
    setFormError('');
    if (!form.received_from.trim()) return setFormError('Received From is required.');
    const usd = parseFloat(form.usd_amount || 0) || 0;
    const fra = parseFloat(form.fra_amount || 0) || 0;
    const k   = parseFloat(form.k_amount   || 0) || 0;
    if (usd <= 0 && fra <= 0 && k <= 0) return setFormError('Enter an amount in at least one currency.');

    if (editMode) {
      if (!window.confirm('Are you sure you want to update this record?')) return;
    }
    setSaving(true);
    try {
      // v1.8.32 â€” payment_method label = the currency used (since CR
      // is one-currency-per-receipt on Kelete). Backend doesn't care
      // about the label; this is just for the list-view badge.
      // v1.10.44 â€” on Liquor branches all three slots are the same
      // currency (K), so a single CR can span Cash + MoMo + Bank at
      // once. Label the receipt with whichever slot is largest so the
      // badge is meaningful; the payload sums for amount + splits.
      const paymentMethod = isLiquorStyle
        ? (usd >= fra && usd >= k ? 'Cash' : fra >= k ? 'Mobile Money' : 'Bank Transfer')
        : (k > 0 && onHq ? 'K' : usd > 0 ? 'USD' : fra > 0 ? 'FRA' : k > 0 ? 'K' : 'Cash');
      // v1.10.44 â€” on Liquor amount = usd+fra+k so the Cash Book ledger
      // sums the full receipt total (not just Cash). Kelete Kassumbalesa
      // keeps amount=usd only (dual-currency receipts book in USD).
      // v1.10.68 â€” At HQ the receipt is single-currency (lock enforced) but
      // could be K, USD, or FRA. Sum works out to the one filled slot,
      // giving the Cash Book stat cards the correct headline number in
      // whatever currency was received.
      const totalAmt = (isLiquorStyle || onHq) ? (usd + fra + k) : usd;
      const payload = {
        received_from:  form.received_from.trim(),
        description:    form.description.trim(),
        payment_method: paymentMethod,
        amount:         totalAmt,
        usd_amount:     usd,
        fra_amount:     fra,
        k_amount:       k,
        // Liquor: send explicit method splits so backend deriveCRSplits
        // doesn't collapse everything into the payment_method's slot.
        ...(isLiquorStyle ? { cash_amount: usd, momo_amount: fra, bank_amount: k } : {}),
        date:           form.date,
      };
      if (editMode) {
        await updateCashReceipt(editId, payload);
        setShowForm(false);
        await fetchData();
        showToast('Cash Receipt updated successfully.');
      } else {
        await createCashReceipt(payload);
        setShowForm(false);
        await fetchData();
        showToast('Cash Receipt saved successfully.');
      }
    } catch (err) {
      setFormError(err.response?.data?.error || 'Failed to save receipt.');
    } finally {
      setSaving(false);
    }
  };

  const formatDate = (d) => new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  const fmt2 = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDelete = (r) => {
    setPendingDelete({
      subject: `Cash Receipt ${r.receipt_number}`,
      perform: async () => {
        try {
          await deleteCashReceipt(r.id);
          setViewReceipt(null);
          await fetchData();
          showToast('Cash Receipt deleted.', 'error');
        } catch (err) {
          alert(err.response?.data?.error || 'Failed to delete receipt.');
        }
      },
    });
  };

  const handlePrint = () => {
    const biz = businessInfo;
    const dateRange = filterFrom || filterTo
      ? `${filterFrom ? formatDate(filterFrom) : 'All'} â€” ${filterTo ? formatDate(filterTo) : 'All'}`
      : 'All Dates';
    const printed = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const chips = [
      { label: 'Period From',  value: filterFrom ? formatDate(filterFrom) : 'All', bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
      { label: 'Period To',    value: filterTo   ? formatDate(filterTo)   : 'All', bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
      { label: 'Receipts',     value: String(filteredReceipts.length),              bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' },
      { label: 'Total Amount', value: '$' + fmt2(filteredTotal),                   bg: '#f0fdf4', color: '#15803d', border: '#86efac' },
    ].map(c => `<div style="padding:12px 16px;border-radius:10px;background:${c.bg};border:1.5px solid ${c.border};text-align:center"><div style="font-size:9.5px;letter-spacing:0.8px;text-transform:uppercase;color:#64748b;font-weight:600;margin-bottom:6px">${c.label}</div><div style="font-size:16px;font-weight:800;color:${c.color}">${c.value}</div></div>`).join('');
    const rows = filteredReceipts.map((r, idx) => `<tr style="border-bottom:1px solid #f1f5f9;background:${idx % 2 === 1 ? '#fafafa' : '#fff'}"><td style="padding:8px 12px;color:#9ca3af;font-size:10.5px">${idx + 1}</td><td style="padding:8px 12px;font-weight:700;font-family:monospace;font-size:11px;color:#16a34a">${r.receipt_number}</td><td style="padding:8px 12px;color:#374151">${formatDate(r.date)}</td><td style="padding:8px 12px;font-weight:500">${r.received_from}</td><td style="padding:8px 12px;color:#6b7280">${r.description || 'â€”'}</td><td style="padding:8px 12px;color:#374151">${r.payment_method}</td><td style="padding:8px 12px;text-align:right;font-weight:700;font-family:monospace;color:#16a34a">$${fmt2(r.amount)}</td></tr>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cash Receipts</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#1a1a2e}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><div style="width:794px;margin:0 auto;background:#fff"><div style="background:linear-gradient(135deg,#14532d 0%,#16a34a 100%);padding:28px 44px 22px;color:#fff;display:flex;justify-content:space-between;align-items:flex-start"><div><div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:5px">${biz.business_name || 'Business Name'}</div><div style="font-size:11px;opacity:0.75">${[biz.business_address, biz.business_phone].filter(Boolean).join('  |  ')}</div></div><div style="text-align:right"><div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;opacity:0.65;margin-bottom:6px">Cash Receipts</div><div style="font-size:15px;font-weight:700">${dateRange}</div><div style="font-size:10px;opacity:0.6;margin-top:4px">Printed: ${printed}</div></div></div><div style="height:4px;background:linear-gradient(90deg,#f59e0b,#16a34a,#2563eb,#a855f7)"></div><div style="padding:26px 44px 36px"><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px">${chips}</div><div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px"><table style="width:100%;border-collapse:collapse;font-size:11.5px"><thead><tr style="background:#f0fdf4"><th style="padding:8px 12px;text-align:left;font-weight:600;color:#16a34a;border-bottom:1px solid #bbf7d0;font-size:10.5px;white-space:nowrap">#</th><th style="padding:8px 12px;text-align:left;font-weight:600;color:#16a34a;border-bottom:1px solid #bbf7d0;font-size:10.5px;white-space:nowrap">Receipt No.</th><th style="padding:8px 12px;text-align:left;font-weight:600;color:#16a34a;border-bottom:1px solid #bbf7d0;font-size:10.5px;white-space:nowrap">Date</th><th style="padding:8px 12px;text-align:left;font-weight:600;color:#16a34a;border-bottom:1px solid #bbf7d0;font-size:10.5px;white-space:nowrap">Received From</th><th style="padding:8px 12px;text-align:left;font-weight:600;color:#16a34a;border-bottom:1px solid #bbf7d0;font-size:10.5px;white-space:nowrap">Description</th><th style="padding:8px 12px;text-align:left;font-weight:600;color:#16a34a;border-bottom:1px solid #bbf7d0;font-size:10.5px;white-space:nowrap">Method</th><th style="padding:8px 12px;text-align:right;font-weight:600;color:#16a34a;border-bottom:1px solid #bbf7d0;font-size:10.5px;white-space:nowrap">Amount</th></tr></thead><tbody>${rows}</tbody><tfoot><tr style="background:#f0fdf4;border-top:2px solid #86efac"><td colspan="6" style="padding:10px 12px;font-weight:700;font-size:11.5px;color:#16a34a">TOTAL â€” ${filteredReceipts.length} Receipt${filteredReceipts.length !== 1 ? 's' : ''}</td><td style="padding:10px 12px;text-align:right;font-weight:800;font-size:13px;font-family:monospace;color:#16a34a">$${fmt2(filteredTotal)}</td></tr></tfoot></table></div><div style="border-top:1px solid #f1f5f9;padding-top:12px;display:flex;justify-content:space-between"><span style="font-size:9.5px;color:#cbd5e1">${biz.business_name || 'Business'} â€” Confidential</span><span style="font-size:9.5px;color:#cbd5e1">Printed: ${printed}</span></div></div></div></body></html>`;
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  const printSingleCR = (r) => {
    const biz = businessInfo;
    const printed = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const cards = [
      { label: 'Received From',  value: r.received_from,        bg: '#f0fdf4', border: '#86efac', color: '#15803d' },
      { label: 'Payment Method', value: r.payment_method,       bg: '#eff6ff', border: '#bfdbfe', color: '#1d4ed8' },
      { label: 'Date',           value: formatDate(r.date),     bg: '#fff7ed', border: '#fed7aa', color: '#c2410c' },
      { label: 'Amount',         value: '$' + fmt2(r.amount),   bg: '#f0fdf4', border: '#86efac', color: '#15803d' },
    ].map(c => `<div style="padding:14px 18px;border-radius:10px;background:${c.bg};border:1.5px solid ${c.border}"><div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;color:#64748b;font-weight:600;margin-bottom:6px">${c.label}</div><div style="font-size:15px;font-weight:700;color:${c.color}">${c.value}</div></div>`).join('');
    const descHtml = r.description ? `<div style="padding:12px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:11.5px;color:#78350f;margin-bottom:24px"><span style="font-weight:700;text-transform:uppercase;font-size:9.5px;letter-spacing:0.8px;margin-right:8px;color:#92400e">Description</span>${r.description}</div>` : '';
    const sigs = ['Received By', 'Authorized By'].map(label => `<div style="text-align:center"><div style="height:36px;border-bottom:1.5px solid #cbd5e1;margin-bottom:6px"></div><div style="font-size:9.5px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#6b7280">${label}</div><div style="font-size:9px;color:#9ca3af;margin-top:2px">Name / Signature / Date</div></div>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cash Receipt ${r.receipt_number}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#1a1a2e}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body><div style="width:600px;margin:0 auto;background:#fff"><div style="background:linear-gradient(135deg,#14532d 0%,#166534 50%,#16a34a 100%);padding:28px 40px 22px;color:#fff;display:flex;justify-content:space-between;align-items:flex-start"><div><div style="font-size:8px;letter-spacing:3px;text-transform:uppercase;opacity:0.6;margin-bottom:8px">Cash Receipt</div><div style="font-size:20px;font-weight:800;letter-spacing:0.3px;margin-bottom:5px">${biz.business_name || 'Business Name'}</div><div style="font-size:10px;opacity:0.7;line-height:1.8">${[biz.business_address, biz.business_phone, biz.business_email].filter(Boolean).join('  Â·  ')}</div></div><div style="text-align:right"><div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;opacity:0.55;margin-bottom:8px">Receipt No.</div><div style="font-size:20px;font-weight:900;letter-spacing:1px;font-family:monospace">${r.receipt_number}</div><div style="margin-top:8px;font-size:11px;opacity:0.8">${formatDate(r.date)}</div></div></div><div style="height:4px;background:linear-gradient(90deg,#f59e0b,#22c55e,#2563eb,#a855f7)"></div><div style="padding:28px 40px 36px"><div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:26px">${cards}</div><div style="border:2px solid #86efac;border-radius:12px;padding:18px 24px;background:#f0fdf4;display:flex;justify-content:space-between;align-items:center;margin-bottom:22px"><div><div style="font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#15803d;font-weight:700;margin-bottom:4px">Total Amount Received</div><div style="font-size:11px;color:#6b7280">${r.payment_method} Â· ${r.received_from}</div></div><div style="font-size:28px;font-weight:900;color:#15803d;font-family:monospace">$${fmt2(r.amount)}</div></div>${descHtml}<div style="display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-top:40px">${sigs}</div></div><div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:10px 40px;display:flex;justify-content:space-between;align-items:center"><span style="font-size:9px;color:#94a3b8">${biz.business_name || 'Business'} â€” Confidential Document</span><span style="font-size:9px;color:#94a3b8">Printed: ${printed}</span></div></div></body></html>`;
    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('cashReceiptTitle')} (CR)</h1>
          <p>{t('cashReceiptsSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={handlePrint} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
            <FiPrinter size={15} /> {t('print')}
          </button>
          {hasPermission('CashReceipt:Add') && (
            <button className="btn btn-primary" onClick={openForm}><FiPlus /> {t('newReceipt')}</button>
          )}
        </div>
      </div>

      {/* v1.8.32 â€” per-currency stat cards. Today / This Month / Total
          render USD/FRA/K. Total Receipts stays as a count. Same shape
          as the PV page (v1.8.25). */}
      {(() => {
        const allowed = hasPermission('CashReceipt:View');
        const fmtU = (n) => `$${fmt2(n)}`;
        const fmtN = (n) => Math.round(parseFloat(n || 0)).toLocaleString('en-US');
        const Line = ({ label, val }) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, lineHeight: 1.6 }}>
            <span style={{ opacity: 0.85 }}>{label}</span><strong>{val}</strong>
          </div>
        );
        // v1.9.27 â€” Liquor-style branches (Mansa/Lusaka) collapse to one
        // single-amount card; Kelete multi-currency branches keep the three
        // USD/FRA/K rows.
        const Card = ({ label, ccyData, bg, icon }) => {
          const single = (parseFloat(ccyData?.usd || 0) || 0)
                       + (parseFloat(ccyData?.fra || 0) || 0)
                       + (parseFloat(ccyData?.k   || 0) || 0);
          return (
            <div style={{ borderRadius: 14, padding: '14px 18px', background: bg, color: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,0.1)', position: 'relative', overflow: 'hidden' }}>
              <div style={{ position: 'absolute', right: -10, top: -10, width: 60, height: 60, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                {icon} <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.9, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
              </div>
              {allowed ? (
                isLiquorStyle ? (
                  <div style={{ fontSize: 22, fontWeight: 800 }}>{curSym}{single.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <Line label="USD" val={fmtU(ccyData?.usd || 0)} />
                    <Line label="FRA" val={fmtN(ccyData?.fra || 0)} />
                    <Line label="K"   val={fmtN(ccyData?.k   || 0)} />
                  </div>
                )
              ) : <div style={{ fontSize: 18, fontWeight: 800 }}>N/A</div>}
            </div>
          );
        };
        return (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, marginBottom: 18 }}>
            <Card label={t('todaysReceipts')} ccyData={stats.today} bg="linear-gradient(135deg,#22c55e,#15803d)" icon={<FiDollarSign size={20} />} />
            <Card label={t('thisMonth')}      ccyData={stats.month} bg="linear-gradient(135deg,#3b82f6,#1d4ed8)" icon={<FiCalendar size={20} />} />
            <div style={{ borderRadius: 14, padding: '14px 18px', background: 'linear-gradient(135deg,#a855f7,#6d28d9)', color: '#fff', boxShadow: '0 4px 16px rgba(0,0,0,0.1)', position: 'relative', overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 14 }}>
              <div style={{ position: 'absolute', right: -10, top: -10, width: 60, height: 60, borderRadius: '50%', background: 'rgba(255,255,255,0.1)' }} />
              <FiFileText size={28} />
              <div>
                <div style={{ fontSize: 11, fontWeight: 700, opacity: 0.9, textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('totalReceipts')}</div>
                <div style={{ fontSize: 28, fontWeight: 800 }}>{allowed ? stats.totalReceipts : 'N/A'}</div>
              </div>
            </div>
            <Card label={t('total')} ccyData={stats.total} bg="linear-gradient(135deg,#f97316,#c2410c)" icon={<FiDollarSign size={20} />} />
          </div>
        );
      })()}

      {/* â”€â”€ Date Filter Bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        padding: '12px 16px', background: '#f8fafc',
        border: '1px solid #e5e7eb', borderRadius: 10,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{t('filterByDate')}:</span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('from')}</span>
          <input
            type="date" value={filterFrom} max={filterTo || todayStr}
            onChange={e => setFilterFrom(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('to')}</span>
          <input
            type="date" value={filterTo} min={filterFrom || undefined} max={todayStr}
            onChange={e => setFilterTo(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }}
          />
        </div>

        {(filterFrom || filterTo) && (
          <button
            onClick={() => { setFilterFrom(''); setFilterTo(''); }}
            style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' }}
          >
            {t('clear')}
          </button>
        )}

        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          {filteredReceipts.length} receipt{filteredReceipts.length !== 1 ? 's' : ''}
          <> &nbsp;Â·&nbsp; Total: <strong style={{ color: '#16a34a' }}>{curSym}{fmt2(filteredTotal)}</strong></>
        </span>
      </div>

      {/* â”€â”€ Receipts Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="data-table-container">
        {filteredReceipts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#6b7280' }}>
            {t('noReceiptsInRange')}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>{t('receiptNumber')}</th><th>{t('date')}</th><th>{t('receivedFrom')}</th><th>{t('description')}</th><th>{t('paymentMethod')}</th>
                {/* v1.8.32 â€” single Amount column split into 3 per-currency.
                    v1.10.45 â€” on Liquor branches all three slots are the
                    same currency, so collapse back to a single AMOUNT
                    column that reads the receipt total. Matches the old
                    Liquor system (Alaskal) layout the user shared. */}
                {isLiquorStyle ? (
                  <th style={{ textAlign: 'right', color: '#16a34a' }}>Amount</th>
                ) : (
                  <>
                    <th style={{ textAlign: 'right', color: '#16a34a' }}>USD ($)</th>
                    <th style={{ textAlign: 'right', color: '#7c3aed' }}>FRA</th>
                    <th style={{ textAlign: 'right', color: '#ea580c' }}>K</th>
                  </>
                )}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredReceipts.map(r => {
                // v1.10.46 â€” on Liquor branches read the currency columns
                // directly (usd/fra/k). Since v1.10.44 we ALSO mirror to the
                // legacy cash/bank/momo columns for the Cash Book tile
                // aggregator, so the old legacy-fallback ternary here would
                // count MoMo twice â€” once as `fra_amount`, once as
                // `momo_amount` â€” turning a K33,105 receipt into K59,510.
                // v1.10.74 â€” on Liquor, an AR-payment CR (minted by
                // customerPayments.js) populates only legacy cash/bank/momo,
                // not the usd/fra/k mirror â€” so the row would render blank
                // if we read usd_amount alone. Fall back to the legacy
                // columns when the mirror is empty. Manual Liquor CRs
                // (from CashReceipt POST) fill BOTH sets, so this fallback
                // is a no-op for them â€” the Cash Book aggregator's
                // double-count fear from v1.10.46 no longer applies because
                // we prefer the mirror when it's non-zero.
                const pf = (v) => parseFloat(v || 0) || 0;
                const ru = pf(r.usd_amount) > 0 ? pf(r.usd_amount) : pf(r.cash_amount);
                const rf = pf(r.fra_amount) > 0 ? pf(r.fra_amount) : pf(isLiquorStyle ? r.momo_amount : r.bank_amount);
                const rk = pf(r.k_amount)   > 0 ? pf(r.k_amount)   : pf(isLiquorStyle ? r.bank_amount : r.momo_amount);
                const dash = <span style={{ color: '#cbd5e1' }}>â€”</span>;
                // v1.10.45 â€” Liquor total = sum of the three slots (all K).
                const liquorTotal = ru + rf + rk;
                return (
                <tr key={r.id}>
                  <td style={{ fontWeight: 500 }}>{r.receipt_number}</td>
                  <td>{formatDate(r.date)}</td>
                  <td>{r.received_from}</td>
                  <td style={{ color: '#6b7280' }}>{r.description || 'â€”'}</td>
                  <td><span className={`badge ${getPaymentColor(r.payment_method)}`}>{r.payment_method}</span></td>
                  {isLiquorStyle ? (
                    <td style={{ textAlign: 'right', color: liquorTotal > 0 ? '#16a34a' : '', fontWeight: liquorTotal > 0 ? 700 : 400 }}>
                      {liquorTotal > 0 ? `${curSym}${fmt2(liquorTotal)}` : dash}
                    </td>
                  ) : (
                    <>
                      <td style={{ textAlign: 'right', color: ru > 0 ? '#16a34a' : '', fontWeight: ru > 0 ? 700 : 400 }}>{ru > 0 ? `$${fmt2(ru)}` : dash}</td>
                      <td style={{ textAlign: 'right', color: rf > 0 ? '#7c3aed' : '', fontWeight: rf > 0 ? 700 : 400 }}>{rf > 0 ? Math.round(rf).toLocaleString('en-US') : dash}</td>
                      <td style={{ textAlign: 'right', color: rk > 0 ? '#ea580c' : '', fontWeight: rk > 0 ? 700 : 400 }}>{rk > 0 ? Math.round(rk).toLocaleString('en-US') : dash}</td>
                    </>
                  )}
                  <td>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => setViewReceipt(r)}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5,
                          padding: '5px 11px', borderRadius: 6, border: '1px solid #e5e7eb',
                          background: '#f9fafb', color: '#6b7280', cursor: 'pointer', fontSize: 12, fontWeight: 500,
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = '#f0fdf4'; e.currentTarget.style.color = '#16a34a'; e.currentTarget.style.borderColor = '#86efac'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.color = '#6b7280'; e.currentTarget.style.borderColor = '#e5e7eb'; }}
                      >
                        <FiEye size={12} /> View
                      </button>
                      {hasPermission('CashReceipt:Edit') && (
                        <button
                          onClick={() => openEdit(r)}
                          title="Edit Receipt"
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 30, height: 30, borderRadius: 6, border: '1px solid #e5e7eb',
                            background: '#f9fafb', color: '#6b7280', cursor: 'pointer',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = '#dbeafe'; e.currentTarget.style.color = '#2563eb'; e.currentTarget.style.borderColor = '#bfdbfe'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.color = '#6b7280'; e.currentTarget.style.borderColor = '#e5e7eb'; }}
                        >
                          <FiEdit2 size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
            <tfoot>
              {/* v1.8.32 â€” per-currency footer totals. */}
              <tr style={{ fontWeight: 700, borderTop: '2px solid #e5e7eb', background: '#f9fafb' }}>
                <td colSpan={5} style={{ padding: '10px 14px', textAlign: 'right', color: '#374151', fontSize: 13 }}>
                  Total ({filteredReceipts.length} receipt{filteredReceipts.length !== 1 ? 's' : ''})
                </td>
                {(() => {
                  // v1.10.46 â€” same currency-column-direct read as the row
                  // cell above. Without this the footer would triple-count
                  // on Liquor (double-count per row Ã— N rows).
                  // v1.10.74 â€” same fallback shape as the row cells above:
                  // prefer usd/fra/k when populated, else fall back to the
                  // legacy cash/bank/momo columns (which is what
                  // customerPayments.js's mintReceipt fills on Liquor AR).
                  const pf = (v) => parseFloat(v || 0) || 0;
                  const pickU = (r) => pf(r.usd_amount) > 0 ? pf(r.usd_amount) : pf(r.cash_amount);
                  const pickF = (r) => pf(r.fra_amount) > 0 ? pf(r.fra_amount) : pf(isLiquorStyle ? r.momo_amount : r.bank_amount);
                  const pickK = (r) => pf(r.k_amount)   > 0 ? pf(r.k_amount)   : pf(isLiquorStyle ? r.bank_amount : r.momo_amount);
                  const tu = filteredReceipts.reduce((s, r) => s + pickU(r), 0);
                  const tf = filteredReceipts.reduce((s, r) => s + pickF(r), 0);
                  const tk = filteredReceipts.reduce((s, r) => s + pickK(r), 0);
                  // v1.10.45 â€” Liquor total = sum across all three slots.
                  if (isLiquorStyle) {
                    return (<>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#16a34a', fontWeight: 700, fontSize: 13 }}>{curSym}{fmt2(tu + tf + tk)}</td>
                      <td></td>
                    </>);
                  }
                  return (<>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#16a34a', fontWeight: 700, fontSize: 13 }}>${fmt2(tu)}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#7c3aed', fontWeight: 700, fontSize: 13 }}>{Math.round(tf).toLocaleString('en-US')}</td>
                    <td style={{ padding: '10px 14px', textAlign: 'right', color: '#ea580c', fontWeight: 700, fontSize: 13 }}>{Math.round(tk).toLocaleString('en-US')}</td>
                    <td></td>
                  </>);
                })()}
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* â”€â”€ View Receipt Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {viewReceipt && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520, boxShadow: '0 20px 60px rgba(0,0,0,0.3)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #14532d 0%, #16a34a 100%)', borderRadius: '14px 14px 0 0', padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <FiFileText size={15} style={{ color: 'rgba(255,255,255,0.8)' }} />
                  <span style={{ fontSize: 11, letterSpacing: 1.5, textTransform: 'uppercase', color: 'rgba(255,255,255,0.7)', fontWeight: 600 }}>Cash Receipt</span>
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', letterSpacing: 0.3 }}>{viewReceipt.receipt_number}</div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 3 }}>
                  {formatDate(viewReceipt.date)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ padding: '4px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: 'rgba(255,255,255,0.2)', color: '#fff', border: '1px solid rgba(255,255,255,0.35)' }}>
                  {viewReceipt.payment_method}
                </span>
                <button onClick={() => setViewReceipt(null)} style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 8, cursor: 'pointer', color: '#fff', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <FiX size={16} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div style={{ padding: '24px 28px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
                {[
                  { label: 'Received From', value: viewReceipt.received_from },
                  { label: 'Date',          value: formatDate(viewReceipt.date) },
                  { label: 'Payment Method', value: viewReceipt.payment_method },
                  { label: 'Amount',         value: `$${fmt2(viewReceipt.amount)}` },
                ].map(info => (
                  <div key={info.label} style={{ padding: '10px 14px', background: '#f8fafc', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                    <div style={{ fontSize: 10.5, color: '#9ca3af', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{info.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{info.value}</div>
                  </div>
                ))}
              </div>

              {/* Payment Breakdown â€” show only when the receipt actually has
                  per-method splits (Mixed receipts, or single-method receipts
                  whose splits were filled in). For single-method legacy
                  receipts where Amount lives only on `amount`, this card is
                  hidden â€” the Method+Amount tiles already say everything. */}
              {(() => {
                const cash = parseFloat(viewReceipt.cash_amount || 0);
                const bank = parseFloat(viewReceipt.bank_amount || 0);
                const momo = parseFloat(viewReceipt.momo_amount || 0);
                const splitSum = cash + bank + momo;
                const hasSplits = splitSum > 0;
                const nonZeroCount = [cash, bank, momo].filter(v => v > 0.001).length;
                // Single-method receipts don't need a breakdown â€” the headline
                // payment-method pill + amount tile already convey it.
                if (!hasSplits || nonZeroCount < 2) return null;
                const amount = parseFloat(viewReceipt.amount || 0);
                const splitMismatch = Math.abs(splitSum - amount) > 0.01;
                const cell = (label, icon, value, accent) => {
                  const dim = value < 0.001;
                  return (
                    <div style={{
                      flex: 1, padding: '10px 12px',
                      background: dim ? '#fafafa' : '#fff',
                      borderRight: '1px solid #e5e7eb',
                      opacity: dim ? 0.4 : 1,
                    }}>
                      <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                        {icon} {label}
                      </div>
                      <div style={{ fontSize: 14, fontWeight: 800, color: dim ? '#9ca3af' : accent, fontFamily: 'monospace' }}>
                        ${fmt2(value)}
                      </div>
                    </div>
                  );
                };
                return (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 10.5, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, paddingLeft: 2 }}>
                      Payment Breakdown
                    </div>
                    <div style={{ display: 'flex', border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                      {cell('Cash', 'ðŸ’µ', cash, '#16a34a')}
                      {/* 2026-09-11 â€” a hidden method shows only if this receipt has money on it. */}
                      {(methodShown('bank') || bank > 0.001) && cell('Bank', 'ðŸ¦', bank, '#2563eb')}
                      {(methodShown('momo') || momo > 0.001) && (
                      <div style={{ flex: 1, padding: '10px 12px', background: momo > 0.001 ? '#fff' : '#fafafa', opacity: momo > 0.001 ? 1 : 0.4 }}>
                        <div style={{ fontSize: 10, color: '#9ca3af', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                          ðŸ“± MoMo
                        </div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: momo > 0.001 ? '#f59e0b' : '#9ca3af', fontFamily: 'monospace' }}>
                          ${fmt2(momo)}
                        </div>
                      </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 11 }}>
                      {splitMismatch && (
                        <span style={{ padding: '2px 8px', background: '#fee2e2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 999, fontWeight: 700 }}>
                          âš  Splits don't match amount
                        </span>
                      )}
                      <span style={{ color: '#6b7280' }}>Total: <strong style={{ color: '#111827' }}>${fmt2(splitSum)}</strong> {!splitMismatch && <span style={{ color: '#16a34a' }}>âœ“</span>}</span>
                    </div>
                  </div>
                );
              })()}

              {viewReceipt.description && (
                <div style={{ padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 13, color: '#78350f' }}>
                  <span style={{ fontWeight: 600 }}>Description: </span>{viewReceipt.description}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '14px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <button
                onClick={() => printSingleCR(viewReceipt)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
                onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.borderColor = '#9ca3af'; }}
                onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.borderColor = '#d1d5db'; }}
              >
                <FiPrinter size={14} /> Print
              </button>
              <div style={{ display: 'flex', gap: 10 }}>
                {hasPermission('CashReceipt:Edit') && (
                  <button
                    onClick={() => { openEdit(viewReceipt); setViewReceipt(null); }}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
                  >
                    <FiEdit2 size={13} /> Edit
                  </button>
                )}
                {hasPermission('CashReceipt:Delete') && (
                  <button
                    onClick={() => handleDelete(viewReceipt)}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 18px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                  >
                    <FiX size={13} /> Delete
                  </button>
                )}
                <button
                  onClick={() => setViewReceipt(null)}
                  style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* â”€â”€ New / Edit Receipt Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {showForm && (
        <Portal>
        {/* v1.8.32 â€” click-outside does NOT close (mirrors PV modal v1.8.24). */}
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>{editMode ? 'Edit Cash Receipt' : 'New Cash Receipt'}</h3>
              <button className="modal-close" onClick={() => setShowForm(false)}>Ã—</button>
            </div>
            <div className="modal-body">
              {formError && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{formError}</div>}
              <div className="form-row">
                <div className="form-group">
                  <label>Date</label>
                  <input type="date" value={form.date} onChange={e => setForm({...form, date: e.target.value})} />
                </div>
                <div className="form-group">
                  <label>Received From</label>
                  <input value={form.received_from} onChange={e => setForm({...form, received_from: e.target.value})} placeholder="Name of payer" />
                </div>
              </div>

              {/* v1.8.32 â€” triple-currency. One CR = one currency. Disable
                  the other two inputs once any one has a value > 0; clear
                  the active one to switch. Mirrors PV modal v1.8.24.
                  v1.10.45 â€” on Liquor branches all three slots are the
                  same currency (K), so a receipt can legitimately span
                  Cash + MoMo + Bank at once. No lock. Labels reflect the
                  physical method the amount landed in; storage columns
                  unchanged (Cashâ†’usd_amount, MoMoâ†’fra_amount,
                  Bankâ†’k_amount). */}
              <div className="form-group">
                <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                  Amount Received{isLiquorStyle ? ' (split across methods)' : ''}
                </label>
                {/* 2026-09-11 â€” MoMo / Bank follow System Settings â†’ Payment
                    methods shown, unless this CR already has money on them. */}
                <div style={{ display: 'grid', gridTemplateColumns: isLiquorStyle
                    ? `repeat(${1 + ((methodShown('momo') || parseFloat(form.fra_amount || 0) > 0) ? 1 : 0) + ((methodShown('bank') || parseFloat(form.k_amount || 0) > 0) ? 1 : 0)}, 1fr)`
                    : '1fr 1fr 1fr', gap: 10 }}>
                  {(isLiquorStyle
                    ? [
                        { key: 'usd_amount', label: 'Cash',         color: '#16a34a', step: '0.01', placeholder: '0.00', prefix: curSym },
                        { key: 'fra_amount', label: 'Mobile Money', color: '#ea580c', step: '0.01', placeholder: '0.00', prefix: curSym },
                        { key: 'k_amount',   label: 'Bank',         color: '#2563eb', step: '0.01', placeholder: '0.00', prefix: curSym },
                      ]
                    : onHq
                      /* v1.10.68 â€” HQ order: K default (leftmost), then USD, then FRA. */
                      ? [
                          { key: 'k_amount',   label: 'K',       color: '#ea580c', step: '1',    placeholder: '0',    prefix: ''  },
                          { key: 'usd_amount', label: 'USD ($)', color: '#16a34a', step: '0.01', placeholder: '0.00', prefix: '$' },
                          { key: 'fra_amount', label: 'FRA',     color: '#7c3aed', step: '1',    placeholder: '0',    prefix: ''  },
                        ]
                      : [
                          { key: 'usd_amount', label: 'USD ($)', color: '#16a34a', step: '0.01', placeholder: '0.00', prefix: '$' },
                          { key: 'fra_amount', label: 'FRA',     color: '#7c3aed', step: '1',    placeholder: '0',    prefix: ''  },
                          { key: 'k_amount',   label: 'K',       color: '#ea580c', step: '1',    placeholder: '0',    prefix: ''  },
                        ]
                  ).filter(f => !isLiquorStyle || methodShown(f.label) || parseFloat(form[f.key] || 0) > 0).map((f) => {
                    const otherKeys = ['usd_amount', 'fra_amount', 'k_amount'].filter(k => k !== f.key);
                    // Kelete keeps the one-currency-per-CR lock. Liquor drops it.
                    // v1.10.70 â€” only lock EMPTY fields when another is filled;
                    // fields that already carry a value stay editable. Without
                    // this, a CR that landed with values in two slots (e.g.
                    // v1.10.68's double-store bug) opened in Edit mode with
                    // every slot locked â€” nothing could be corrected.
                    const selfHasValue = parseFloat(form[f.key] || 0) > 0;
                    const locked = !isLiquorStyle && !selfHasValue && otherKeys.some(k => parseFloat(form[k] || 0) > 0);
                    return (
                      <div key={f.key}>
                        <label style={{ fontSize: 11, color: locked ? '#cbd5e1' : f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}{locked && ' (locked)'}</label>
                        <input type="number" min="0" step={f.step}
                          disabled={locked}
                          value={form[f.key]}
                          onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                          placeholder={f.placeholder}
                          title={locked ? 'Clear the other currency to switch â€” one CR = one currency.' : ''}
                          style={{
                            width: '100%', padding: '8px 10px',
                            border: `2px solid ${locked ? '#e5e7eb' : (parseFloat(form[f.key] || 0) > 0 ? f.color : '#d1d5db')}`,
                            borderRadius: 6, fontSize: 14, fontWeight: 600,
                            color: locked ? '#cbd5e1' : (parseFloat(form[f.key] || 0) > 0 ? f.color : '#374151'),
                            background: locked ? '#f9fafb' : '#fff',
                            cursor: locked ? 'not-allowed' : 'text',
                            boxSizing: 'border-box',
                          }} />
                      </div>
                    );
                  })}
                </div>
                {/* v1.10.45 â€” Liquor total row (all K). Kelete keeps the
                    one-currency-per-CR model so no total row is needed. */}
                {isLiquorStyle && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 13, marginTop: 8 }}>
                    <span style={{ color: '#6b7280' }}>Total</span>
                    <span style={{ fontWeight: 800, color: '#1d4ed8' }}>
                      {curSym}{(
                        (parseFloat(form.usd_amount || 0) || 0)
                        + (parseFloat(form.fra_amount || 0) || 0)
                        + (parseFloat(form.k_amount   || 0) || 0)
                      ).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                )}
              </div>

              <div className="form-group">
                <label>Description</label>
                <input value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="Purpose of payment" />
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving...' : editMode ? 'Update Receipt' : 'Save Receipt'}
              </button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* â”€â”€ Single CR Print Preview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {false && viewReceipt && showCRPrint && (
        <div
          className="print-preview-overlay"
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.88)', zIndex: 2000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}
        >
          {/* Toolbar */}
          <div
            className="no-print"
            style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 2001, borderBottom: '1px solid #1e293b' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={15} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>
                Print Preview â€” {viewReceipt.receipt_number}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                <FiPrinter size={14} /> Print
              </button>
              <button onClick={() => setShowCRPrint(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}>
                <FiX size={14} /> Close
              </button>
            </div>
          </div>

          {/* A4 Document */}
          <div
            id="print-document"
            style={{ width: 600, background: '#fff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}
          >
            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #14532d 0%, #166534 50%, #16a34a 100%)', padding: '28px 40px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 8, letterSpacing: 3, textTransform: 'uppercase', opacity: 0.6, marginBottom: 8 }}>Cash Receipt</div>
                <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>
                  {businessInfo.business_name || 'Business Name'}
                </div>
                <div style={{ fontSize: 10, opacity: 0.7, lineHeight: 1.8 }}>
                  {[businessInfo.business_address, businessInfo.business_phone, businessInfo.business_email].filter(Boolean).join('  Â·  ')}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.55, marginBottom: 8 }}>Receipt No.</div>
                <div style={{ fontSize: 20, fontWeight: 900, letterSpacing: 1, fontFamily: 'monospace' }}>{viewReceipt.receipt_number}</div>
                <div style={{ marginTop: 8, fontSize: 11, opacity: 0.8 }}>{formatDate(viewReceipt.date)}</div>
              </div>
            </div>

            {/* Accent bar */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #22c55e, #2563eb, #a855f7)' }} />

            {/* Body */}
            <div style={{ padding: '28px 40px 36px' }}>

              {/* Detail cards */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 26 }}>
                {[
                  { label: 'Received From',  value: viewReceipt.received_from,   bg: '#f0fdf4', border: '#86efac',  color: '#15803d' },
                  { label: 'Payment Method', value: viewReceipt.payment_method,  bg: '#eff6ff', border: '#bfdbfe',  color: '#1d4ed8' },
                  { label: 'Date',           value: formatDate(viewReceipt.date), bg: '#fff7ed', border: '#fed7aa',  color: '#c2410c' },
                  { label: 'Amount',         value: `$${fmt2(viewReceipt.amount)}`, bg: '#f0fdf4', border: '#86efac', color: '#15803d' },
                ].map(card => (
                  <div key={card.label} style={{ padding: '14px 18px', borderRadius: 10, background: card.bg, border: `1.5px solid ${card.border}` }}>
                    <div style={{ fontSize: 9, letterSpacing: 0.8, textTransform: 'uppercase', color: '#64748b', fontWeight: 600, marginBottom: 6 }}>{card.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: card.color }}>{card.value}</div>
                  </div>
                ))}
              </div>

              {/* Amount highlight */}
              <div style={{ border: '2px solid #86efac', borderRadius: 12, padding: '18px 24px', background: '#f0fdf4', display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }}>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: '#15803d', fontWeight: 700, marginBottom: 4 }}>Total Amount Received</div>
                  <div style={{ fontSize: 11, color: '#6b7280' }}>{viewReceipt.payment_method} Â· {viewReceipt.received_from}</div>
                </div>
                <div style={{ fontSize: 28, fontWeight: 900, color: '#15803d', fontFamily: 'monospace' }}>
                  ${fmt2(viewReceipt.amount)}
                </div>
              </div>

              {/* Description */}
              {viewReceipt.description && (
                <div style={{ padding: '12px 16px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 11.5, color: '#78350f', marginBottom: 24 }}>
                  <span style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: 9.5, letterSpacing: 0.8, marginRight: 8, color: '#92400e' }}>Description</span>
                  {viewReceipt.description}
                </div>
              )}

              {/* Signatures */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 32, marginTop: 40 }}>
                {['Received By', 'Authorized By'].map(label => (
                  <div key={label} style={{ textAlign: 'center' }}>
                    <div style={{ height: 36, borderBottom: '1.5px solid #cbd5e1', marginBottom: 6 }} />
                    <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: '#6b7280' }}>{label}</div>
                    <div style={{ fontSize: 9, color: '#9ca3af', marginTop: 2 }}>Name / Signature / Date</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Footer bar */}
            <div style={{ background: '#f8fafc', borderTop: '1px solid #e2e8f0', padding: '10px 40px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 9, color: '#94a3b8' }}>{businessInfo.business_name || 'Business'} â€” Confidential Document</span>
              <span style={{ fontSize: 9, color: '#94a3b8' }}>
                Printed: {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* â”€â”€ CR List Print Overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {false && showListPrint && (
        <div className="pv-print-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.85)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}>
          <div className="no-print" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 1001, borderBottom: '1px solid #1e293b' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={16} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Print Preview â€” Cash Receipts ({filteredReceipts.length} records)</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}><FiPrinter size={14} /> Print</button>
              <button onClick={() => setShowListPrint(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}><FiX size={14} /> Close</button>
            </div>
          </div>

          <div id="cr-list-document" style={{ width: 794, background: '#fff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}>
            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #14532d 0%, #16a34a 100%)', padding: '28px 44px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>{businessInfo.business_name || 'Business Name'}</div>
                <div style={{ fontSize: 11, opacity: 0.75 }}>{[businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ')}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.65, marginBottom: 6 }}>Cash Receipts</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{filterFrom || filterTo ? `${filterFrom ? formatDate(filterFrom) : 'All'} â€” ${filterTo ? formatDate(filterTo) : 'All'}` : 'All Dates'}</div>
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>Printed: {new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>
            {/* Rainbow divider */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #16a34a, #2563eb, #a855f7)' }} />

            <div style={{ padding: '26px 44px 36px' }}>
              {/* Stat chips */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Period From',    value: filterFrom ? formatDate(filterFrom) : 'All',                                              bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
                  { label: 'Period To',      value: filterTo   ? formatDate(filterTo)   : 'All',                                              bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
                  { label: 'Receipts',       value: filteredReceipts.length,                                                                   bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' },
                  { label: 'Total Amount',   value: '$' + fmt2(filteredTotal),                                                                 bg: '#f0fdf4', color: '#15803d', border: '#86efac' },
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
                    <tr style={{ background: '#f0fdf4' }}>
                      {['#', 'Receipt No.', 'Date', 'Received From', 'Description', 'Method', 'Amount'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: i === 6 ? 'right' : 'left', fontWeight: 600, color: '#16a34a', borderBottom: '1px solid #bbf7d0', fontSize: 10.5, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReceipts.map((r, idx) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                        <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10.5 }}>{idx + 1}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 700, fontFamily: 'monospace', fontSize: 11, color: '#16a34a' }}>{r.receipt_number}</td>
                        <td style={{ padding: '8px 12px', color: '#374151' }}>{formatDate(r.date)}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 500 }}>{r.received_from}</td>
                        <td style={{ padding: '8px 12px', color: '#6b7280' }}>{r.description || 'â€”'}</td>
                        <td style={{ padding: '8px 12px', color: '#374151' }}>{r.payment_method}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, fontFamily: 'monospace', color: '#16a34a' }}>{curSym}{fmt2(r.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f0fdf4', borderTop: '2px solid #86efac' }}>
                      <td colSpan={6} style={{ padding: '10px 12px', fontWeight: 700, fontSize: 11.5, color: '#16a34a' }}>TOTAL â€” {filteredReceipts.length} Receipt{filteredReceipts.length !== 1 ? 's' : ''}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13, fontFamily: 'monospace', color: '#16a34a' }}>{curSym}{fmt2(filteredTotal)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Signatures */}
              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>{businessInfo.business_name || 'Business'} â€” Confidential</span>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>Printed: {new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* â”€â”€ Print styles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
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
      <Toast message={toast?.msg} type={toast?.type} onClose={() => setToast(null)} />

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

export default CashReceipt;
