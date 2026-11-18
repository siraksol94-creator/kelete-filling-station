import React, { useState, useEffect } from 'react';
import { getAccountPayables, getAccountPayableStats, getSupplierBreakdown, updateApPayment, deleteApPayment, getSettings, getApPayments } from '../services/api';
import ExportButtons from '../components/ExportButtons';
import ApPaymentFormModal from '../components/ApPaymentFormModal';
import { FiDollarSign, FiAlertCircle, FiUsers, FiTrendingDown, FiX, FiChevronRight, FiPrinter, FiEdit2, FiSave, FiTrash2 } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { matchTokens } from '../utils/tokenSearch';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { useLanguage } from '../context/LanguageContext';

const getStatusBadge = (status) => {
  const map = { 'Paid': 'badge-green', 'Partial': 'badge-orange', 'Unpaid': 'badge-red', 'No Purchases': 'badge-gray' };
  return map[status] || 'badge-gray';
};

const AccountPayables = () => {
  const { symbol: curSym } = useCurrency();
  const { t } = useLanguage();
  const [stats, setStats] = useState({ totalPurchases: 0, totalPaid: 0, outstanding: 0, suppliers: 0, unpaidCount: 0 });
  const [payables, setPayables] = useState([]);
  const [businessInfo, setBusinessInfo] = useState({});
  const [showListPrint, setShowListPrint] = useState(false);
  const [payModal, setPayModal] = useState(null);
  // form/saving/error are owned by the shared ApPaymentFormModal component.
  const [breakdown, setBreakdown] = useState(null);
  const [loadingBreakdown, setLoadingBreakdown] = useState(false);
  const [editingPayment, setEditingPayment] = useState(null); // { id, amount, date, description, paid_from }
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(!!breakdown || !!payModal);
  const [toast, setToast] = useState(null);
  const [tab, setTab] = useState('payables');     // payables | payments
  const [apPayments, setApPayments] = useState([]);
  const [paymentSearch, setPaymentSearch] = useState('');
  // Date filter — default to first..last day of the current month (period view)
  const _today = new Date();
  const _firstOfMonth = `${_today.getFullYear()}-${String(_today.getMonth() + 1).padStart(2, '0')}-01`;
  const _todayStr = _today.toISOString().split('T')[0];
  // Default to All Time so suppliers with older-than-current-month GRNs don't
  // silently disappear from the list and the Outstanding total reflects what
  // they actually owe (not just this-month activity). User can still narrow
  // via the date pickers or the "This Month" button.
  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');

  const { hasPermission, user: authUser } = useAuth();

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchData = async () => {
    try {
      const params = { from: filterFrom || undefined, to: filterTo || undefined };
      const [statsRes, payablesRes, paymentsRes] = await Promise.all([
        getAccountPayableStats(params), getAccountPayables(params), getApPayments(params),
      ]);
      if (statsRes.data) setStats(statsRes.data);
      setPayables(payablesRes.data || []);
      setApPayments(Array.isArray(paymentsRes.data) ? paymentsRes.data : []);
    } catch (err) { /* use defaults */ }
  };

  useEffect(() => {
    fetchData();
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
  }, [filterFrom, filterTo]); // eslint-disable-line

  // Opening the Record Payment modal — the modal component owns its own
  // form state. We just pass the supplier context in.
  const openPayModal = (supplier) => setPayModal(supplier);
  const handlePaymentSaved = () => {
    fetchData();
    showToast('Payment recorded successfully.');
  };

  const openBreakdown = async (supplier) => {
    setLoadingBreakdown(true);
    setBreakdown({ supplier, grns: [], payments: [] });
    try {
      const res = await getSupplierBreakdown(supplier.id);
      setBreakdown(res.data);
    } catch (e) { /* keep empty */ }
    setLoadingBreakdown(false);
  };

  const handleSaveEdit = async () => {
    if (!editingPayment.amount || parseFloat(editingPayment.amount) <= 0) { setEditError('Enter a valid amount.'); return; }
    if (!window.confirm('Are you sure you want to update this record?')) return;
    setEditSaving(true);
    setEditError('');
    try {
      await updateApPayment(editingPayment.id, {
        amount: parseFloat(editingPayment.amount),
        date: editingPayment.date,
        description: editingPayment.description,
        paid_from: editingPayment.paid_from,
      });
      setEditingPayment(null);
      // Refresh breakdown
      const res = await getSupplierBreakdown(breakdown.supplier.id || breakdown.supplier.supplier_id);
      setBreakdown(res.data);
      fetchData();
      showToast('Payment updated successfully.');
    } catch (err) {
      setEditError(err.response?.data?.error || 'Failed to update payment.');
    } finally {
      setEditSaving(false);
    }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDeletePayment = (paymentId) => {
    setPendingDelete({
      subject: 'AP payment',
      perform: async () => {
        try {
          await deleteApPayment(paymentId);
          const res = await getSupplierBreakdown(breakdown.supplier.id || breakdown.supplier.supplier_id);
          setBreakdown(res.data);
          fetchData();
          showToast('Payment deleted.', 'error');
        } catch (err) {
          alert(err.response?.data?.error || 'Failed to delete payment.');
        }
      },
    });
  };

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';

  const handleBreakdownPrint = () => {
    if (!breakdown) return;
    const fmt = (v) => parseFloat(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
    const supplierName = breakdown.supplier?.supplier_name || breakdown.supplier?.name || '';
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';

    const totalPurchases = breakdown.grns?.reduce((s, g) => s + parseFloat(g.total_amount) + parseFloat(g.cn_amount || 0), 0) || 0;
    const totalPaid = breakdown.payments?.reduce((s, p) => s + parseFloat(p.amount), 0) || 0;
    const totalCredits = breakdown.credits?.reduce((s, c) => s + parseFloat(c.amount), 0) || 0;
    // Display convention: positive = we paid more than we owed (advance to supplier),
    // negative = we still owe. Same formula as the AP supplier list.
    const balance = totalPaid + totalCredits - totalPurchases;

    const cnRows = (breakdown.credits || []).map((c, i) => `
      <tr style="border-bottom:1px solid #ddd;background:${i % 2 === 1 ? '#f9f9f9' : '#fff'}">
        <td style="padding:8px 12px">${c.credit_note_number}</td>
        <td style="padding:8px 12px">${formatDate(c.date)}</td>
        <td style="padding:8px 12px">${c.reason}</td>
        <td style="padding:8px 12px">${c.reference || '—'}</td>
        <td style="padding:8px 12px;text-align:right;font-weight:600">K${fmt(c.amount)}</td>
      </tr>`).join('');

    const grnRows = (breakdown.grns || []).map((g, i) => `
      <tr style="border-bottom:1px solid #ddd;background:${i % 2 === 1 ? '#f9f9f9' : '#fff'}">
        <td style="padding:8px 12px">${g.grn_number}</td>
        <td style="padding:8px 12px">${formatDate(g.date)}</td>
        <td style="padding:8px 12px;text-align:right;font-weight:600">K${fmt(parseFloat(g.total_amount) + parseFloat(g.cn_amount || 0))}</td>
      </tr>`).join('');

    const pmtRows = (breakdown.payments || []).map((p, i) => `
      <tr style="border-bottom:1px solid #ddd;background:${i % 2 === 1 ? '#f9f9f9' : '#fff'}">
        <td style="padding:8px 12px">${p.payment_number}</td>
        <td style="padding:8px 12px">${formatDate(p.date)}</td>
        <td style="padding:8px 12px">${p.description || '—'}</td>
        <td style="padding:8px 12px;text-align:right;font-weight:600">K${fmt(p.amount)}</td>
      </tr>`).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AP Breakdown — ${supplierName}</title>
      <style>@page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:8px 12px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10.5px;background:#f0f0f0;text-align:left}
      tfoot td{padding:9px 12px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
      </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:8px;letter-spacing:3px;text-transform:uppercase;margin-bottom:6px">Account Payables</div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${biz}</div>
          <div style="font-size:10px">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Supplier Breakdown</div>
          <div style="font-size:15px;font-weight:700">${supplierName}</div>
          <div style="font-size:9px;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>

      <h3 style="font-size:11px;font-weight:700;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1.5px solid #000;padding-bottom:4px">Purchases (GRN)</h3>
      ${breakdown.grns?.length === 0 ? '<p style="font-size:12px;margin-bottom:16px">No purchases yet.</p>' : `
      <div style="border:1.5px solid #000;margin-bottom:20px">
        <table style="font-size:11.5px">
          <thead><tr><th>GRN #</th><th>Date</th><th style="text-align:right">Amount</th></tr></thead>
          <tbody>${grnRows}</tbody>
          <tfoot><tr>
            <td colspan="2" style="text-align:right">Total Purchases:</td>
            <td style="text-align:right">K${fmt(totalPurchases)}</td>
          </tr></tfoot>
        </table>
      </div>`}

      <h3 style="font-size:11px;font-weight:700;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1.5px solid #000;padding-bottom:4px">Payments Made (AP)</h3>
      ${breakdown.payments?.length === 0 ? '<p style="font-size:12px;margin-bottom:16px">No payments yet.</p>' : `
      <div style="border:1.5px solid #000;margin-bottom:20px">
        <table style="font-size:11.5px">
          <thead><tr><th>Ref #</th><th>Date</th><th>Description</th><th style="text-align:right">Amount</th></tr></thead>
          <tbody>${pmtRows}</tbody>
          <tfoot><tr>
            <td colspan="3" style="text-align:right">Total Paid:</td>
            <td style="text-align:right">K${fmt(totalPaid)}</td>
          </tr></tfoot>
        </table>
      </div>`}

      ${breakdown.credits?.length > 0 ? `
      <h3 style="font-size:11px;font-weight:700;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1.5px solid #000;padding-bottom:4px">Credit Notes</h3>
      <div style="border:1.5px solid #000;margin-bottom:20px">
        <table style="font-size:11.5px">
          <thead><tr><th>CN #</th><th>Date</th><th>Reason</th><th>Reference</th><th style="text-align:right">Amount</th></tr></thead>
          <tbody>${cnRows}</tbody>
          <tfoot><tr>
            <td colspan="4" style="text-align:right">Total Credits:</td>
            <td style="text-align:right">K${fmt(totalCredits)}</td>
          </tr></tfoot>
        </table>
      </div>` : ''}

      ${breakdown.grn_credits?.length > 0 ? `
      <h3 style="font-size:11px;font-weight:700;margin-bottom:2px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1.5px solid #000;padding-bottom:4px">Returns already deducted from the GRNs above</h3>
      <div style="font-size:9.5px;color:#444;margin:4px 0 8px">For reference only - each GRN is listed at its value after these credits.</div>
      <div style="border:1px solid #666;margin-bottom:20px">
        <table style="font-size:11px;color:#444">
          <thead><tr><th>CN #</th><th>Date</th><th>Reason</th><th>GRN</th><th style="text-align:right">Amount</th></tr></thead>
          <tbody>${(breakdown.grn_credits || []).map((c, i) => `
            <tr style="background:${i % 2 ? '#fafafa' : '#fff'}">
              <td style="padding:8px 12px">${c.credit_note_number || ''}</td>
              <td style="padding:8px 12px">${formatDate(c.date)}</td>
              <td style="padding:8px 12px">${c.reason || ''}</td>
              <td style="padding:8px 12px">${c.reference || '-'}</td>
              <td style="padding:8px 12px;text-align:right">K${fmt(c.amount)}</td>
            </tr>`).join('')}</tbody>
        </table>
      </div>` : ''}

      <div style="border:2px solid #000;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;margin-bottom:24px">
        <div>
          <span style="font-weight:700;font-size:14px">${balance > 0.01 ? 'Over Paid:' : balance < -0.01 ? 'Outstanding:' : 'Outstanding Balance:'}</span>
          ${totalCredits > 0.01 ? `<div style="font-size:9.5px;margin-top:3px;color:#444">Purchases ${curSym}${fmt(totalPurchases)} − Paid ${curSym}${fmt(totalPaid)} − Credits ${curSym}${fmt(totalCredits)}</div>` : ''}
        </div>
        <span style="font-weight:800;font-size:18px;color:${balance > 0.01 ? '#16a34a' : balance < -0.01 ? '#dc2626' : '#000'}">${balance < 0 ? '−' : ''}${curSym}${fmt(Math.abs(balance))}</span>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:32px;margin-bottom:16px">
        ${[['Prepared By',''],['Checked By',''],['Printed By',printedBy]].map(([label,name])=>`
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px">${biz} — Confidential</span>
        <span style="font-size:9px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  const handlePrint = () => {
    const fmt = (v) => parseFloat(v||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
    const printedAt = new Date().toLocaleString('en-US',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ');
    const printedBy = [authUser?.first_name, authUser?.last_name].filter(Boolean).join(' ') || '—';
    const rows = payables.map((p,idx) => `
      <tr style="border-bottom:1px solid #ddd;background:${idx%2===1?'#f9f9f9':'#fff'}">
        <td style="padding:8px 10px;font-size:10.5px">${idx+1}</td>
        <td style="padding:8px 10px;font-weight:700">${p.supplier_name}</td>
        <td style="padding:8px 10px">${p.phone||'—'}</td>
        <td style="padding:8px 10px;text-align:center">${p.grn_count}</td>
        <td style="padding:8px 10px;text-align:right">${curSym}${fmt(p.total_purchases)}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:600">${curSym}${fmt(p.total_paid)}</td>
        <td style="padding:8px 10px;text-align:right;color:${parseFloat(p.total_credits||0)>0?'#0369a1':'#9ca3af'}">${parseFloat(p.total_credits||0)>0?(curSym+fmt(p.total_credits)):'—'}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:700">${curSym}${fmt(Math.abs(parseFloat(p.balance) || 0))}${parseFloat(p.balance) > 0.01 ? ' (owed)' : parseFloat(p.balance) < -0.01 ? ' (advance)' : ''}</td>
        <td style="padding:8px 10px">${p.status}</td>
      </tr>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:8px 10px;font-weight:700;color:#000;border-bottom:1.5px solid #000;font-size:10.5px;background:#f0f0f0;text-align:left}
      tfoot td{padding:10px 10px;font-weight:700;background:#f0f0f0;border-top:2px solid #000}
    </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:12px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:21px;font-weight:800;letter-spacing:0.3px;margin-bottom:4px">${biz}</div>
          <div style="font-size:10px">${addr}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;margin-bottom:4px">Account Payables</div>
          <div style="font-size:15px;font-weight:700">Supplier Ledger</div>
          <div style="font-size:9px;margin-top:3px">Printed: ${printedAt}</div>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:16px">
        ${[
          ['Total Purchases','K'+fmt(stats.totalPurchases)],
          ['Total Paid','K'+fmt(stats.totalPaid)],
          ...(parseFloat(stats.totalCredits||0) > 0 ? [['Credits','K'+fmt(stats.totalCredits)]] : []),
          ['Outstanding','K'+fmt(stats.outstanding)],
          ['Suppliers',stats.suppliers]
        ].map(([lbl,val])=>`
          <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:600;margin-bottom:4px">${lbl}</div>
            <div style="font-size:15px;font-weight:800">${val}</div>
          </div>`).join('')}
      </div>
      <div style="border:1.5px solid #000;margin-bottom:16px">
        <table style="font-size:11.5px">
          <thead><tr>
            <th style="width:28px">#</th><th>Supplier</th><th>Phone</th><th>GRNs</th>
            <th style="text-align:right">Purchases</th><th style="text-align:right">Paid</th>
            <th style="text-align:right">Credits</th>
            <th style="text-align:right">Balance</th><th>Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>
            <td colspan="4">TOTAL — ${payables.length} Supplier${payables.length!==1?'s':''}</td>
            <td style="text-align:right">K${fmt(stats.totalPurchases)}</td>
            <td style="text-align:right">K${fmt(stats.totalPaid)}</td>
            <td style="text-align:right">K${fmt(stats.totalCredits||0)}</td>
            <td style="text-align:right;font-size:13px">K${fmt(stats.outstanding)}</td>
            <td></td>
          </tr></tfoot>
        </table>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:32px;margin-bottom:16px">
        ${[['Prepared By',''],['Checked By',''],['Printed By',printedBy]].map(([label,name])=>`
          <div>
            <div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;font-weight:700;margin-bottom:6px">${label}</div>
            <div style="font-size:11px;font-weight:600;min-height:18px;margin-bottom:6px">${name}</div>
            <div style="height:32px;border-bottom:1.5px solid #000;margin-bottom:4px"></div>
            <div style="font-size:9px;text-align:center">Name / Signature / Date</div>
          </div>`).join('')}
      </div>
      <div style="border-top:1px solid #bbb;padding-top:8px;display:flex;justify-content:space-between">
        <span style="font-size:9px">${biz} — Confidential</span>
        <span style="font-size:9px">Printed: ${printedAt}</span>
      </div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('accountPayablesTitle')}</h1>
          <p>{t('accountPayablesSubtitle')}</p>
        </div>
        <button onClick={handlePrint} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#7c3aed', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
          <FiPrinter size={15} /> {t('print')}
        </button>
      </div>

      {/* Top stat cards. Outstanding is split into TWO cards (what we still owe vs what we've overpaid)
          so a tenant with both situations doesn't see a confusing net number like "−5,000 Outstanding". */}
      {(() => {
        // backend `p.balance` convention: positive = we still owe; negative = we overpaid.
        const outstandingOnly = payables.reduce((s, p) => s + Math.max(0,  parseFloat(p.balance) || 0), 0);
        const overPaidOnly    = payables.reduce((s, p) => s + Math.max(0, -(parseFloat(p.balance) || 0)), 0);
        return (
          // 2026-08-30 — matched to HQ Suppliers: plain white cards, colour on
          // the label and the one figure that matters, rather than four full
          // gradient blocks competing for attention.
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 14 }}>
            <RollupCard icon={<FiDollarSign />}   label={t('totalPurchases')} color="#0ea5e9"
              value={hasPermission('AccountPayables:View') ? `${curSym}${stats.totalPurchases.toLocaleString()}` : 'N/A'} />
            <RollupCard icon={<FiTrendingDown />} label={t('totalPaid')}      color="#047857"
              value={hasPermission('AccountPayables:View') ? `${curSym}${stats.totalPaid.toLocaleString()}` : 'N/A'} />
            <RollupCard icon={<FiAlertCircle />}  label={t('outstanding')}    color={outstandingOnly > 0.01 ? '#b91c1c' : '#0f172a'} highlight
              value={hasPermission('AccountPayables:View') ? `${outstandingOnly > 0.01 ? '−' : ''}${curSym}${outstandingOnly.toLocaleString()}` : 'N/A'} />
            {overPaidOnly > 0.01 && (
              <RollupCard icon={<FiTrendingDown />} label={t('overPaid')} color="#047857"
                value={hasPermission('AccountPayables:View') ? `${curSym}${overPaidOnly.toLocaleString()}` : 'N/A'} />
            )}
            {parseFloat(stats.totalCredits || 0) > 0.01 && (
              <RollupCard icon={<FiTrendingDown />} label="Credit Notes" color="#0ea5e9"
                value={hasPermission('AccountPayables:View') ? `${curSym}${parseFloat(stats.totalCredits).toLocaleString()}` : 'N/A'} />
            )}
            <RollupCard icon={<FiUsers />} label={t('suppliers')} color="#0f172a"
              value={hasPermission('AccountPayables:View') ? String(stats.suppliers) : 'N/A'} />
          </div>
        );
      })()}

      {/* ── Date Filter Bar ─────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        padding: '12px 16px', background: '#f8fafc',
        border: '1px solid #e5e7eb', borderRadius: 10,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#6b7280' }}>{t('filterByDate')}:</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('from')}</span>
          <input type="date" value={filterFrom} max={filterTo || _todayStr}
            onChange={e => setFilterFrom(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>{t('to')}</span>
          <input type="date" value={filterTo} min={filterFrom || undefined} max={_todayStr}
            onChange={e => setFilterTo(e.target.value)}
            style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #d1d5db', fontSize: 13, background: '#fff', color: '#374151', cursor: 'pointer' }} />
        </div>
        {/* Quick presets */}
        <button onClick={() => { setFilterFrom(_firstOfMonth); setFilterTo(_todayStr); }}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #bfdbfe', fontSize: 12, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 600 }}>
          {t('thisMonth')}
        </button>
        <button onClick={() => { setFilterFrom(''); setFilterTo(''); }}
          style={{ padding: '5px 12px', borderRadius: 7, border: '1px solid #e5e7eb', fontSize: 12, background: '#fff', color: '#6b7280', cursor: 'pointer' }}>
          {t('allTime')}
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af' }}>
          {filterFrom || filterTo
            ? `${filterFrom || '—'} ${t('to')} ${filterTo || '—'}`
            : t('showingAllTime')}
        </span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { key: 'payables', label: t('payables') },
          { key: 'payments', label: t('payments') },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: '10px 18px', background: 'none', border: 'none',
              borderBottom: tab === t.key ? '3px solid #1d4ed8' : '3px solid transparent',
              color: tab === t.key ? '#1d4ed8' : '#6b7280',
              fontWeight: tab === t.key ? 700 : 500, fontSize: 13.5,
              cursor: 'pointer', marginBottom: -2,
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'payables' && (
      <>
      {/* v1.13.43 — universal export (ZRA #30) */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <ExportButtons
          rows={payables}
          filename="account-payables"
          sheetName="Payables"
          columns={[
            { key: 'name',            label: 'Supplier' },
            { key: 'phone',           label: 'Phone' },
            { key: 'grn_count',       label: 'GRNs' },
            { key: 'total_purchases', label: 'Total Purchases', format: v => Number(v || 0).toFixed(2) },
            { key: 'total_paid',      label: 'Total Paid',      format: v => Number(v || 0).toFixed(2) },
            { key: 'total_credits',   label: 'Credits',         format: v => Number(v || 0).toFixed(2) },
            { key: 'balance',         label: 'Balance',         format: v => Number(v || 0).toFixed(2) },
            { key: 'last_grn_date',   label: 'Last GRN' },
            { key: 'status',          label: 'Status' },
          ]}
          pdfOptions={{ title: 'Account Payables — Supplier Ledger' }}
        />
      </div>
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('supplier')}</th><th>{t('phone')}</th><th>GRNs</th><th>{t('totalPurchases')}</th>
              <th>{t('totalPaid')}</th><th>Credits</th><th>{t('balance')}</th><th>{t('lastGRN')}</th><th>{t('status')}</th><th>{t('action')}</th>
            </tr>
          </thead>
          <tbody>
            {payables.length === 0 ? (
              <tr><td colSpan="10" style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>{t('noSuppliersInLedger')}</td></tr>
            ) : payables.map(p => (
              <tr key={p.id}>
                <td>
                  <button onClick={() => openBreakdown(p)} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 600, color: '#2563eb', fontSize: 14, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    {p.supplier_name} <FiChevronRight size={13} />
                  </button>
                </td>
                <td style={{ color: '#6b7280' }}>{p.phone || '—'}</td>
                <td style={{ textAlign: 'center' }}>{p.grn_count}</td>
                {(() => {
                  // v1.10.79 — display each supplier's totals in THEIR
                  // currency (returned per-row by the backend). Falls
                  // back to the tenant's primary symbol if the currency
                  // field isn't present (older clients / edge case).
                  const ccy = String(p.currency || '').toUpperCase();
                  const sym = ccy === 'K' ? 'K' : ccy === 'FRA' ? '' : ccy === 'USD' ? '$' : curSym;
                  const suffix = ccy === 'FRA' ? ' FRA' : '';
                  const digits = ccy === 'K' || ccy === 'FRA' ? 0 : 2;
                  const fmtCcy = (v) => `${sym}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;
                  const bal = -parseFloat(p.balance || 0);
                  return (
                    <>
                      <td>{fmtCcy(parseFloat(p.total_purchases))}</td>
                      <td style={{ color: '#16a34a' }}>{fmtCcy(parseFloat(p.total_paid))}</td>
                      <td style={{ color: parseFloat(p.total_credits || 0) > 0 ? '#0369a1' : '#9ca3af' }}>
                        {parseFloat(p.total_credits || 0) > 0 ? fmtCcy(parseFloat(p.total_credits)) : '—'}
                      </td>
                      <td style={{ color: bal > 0.01 ? '#16a34a' : bal < -0.01 ? '#dc2626' : '#374151', fontWeight: 600 }}>
                        {bal < 0 ? '−' : ''}{fmtCcy(bal)}
                      </td>
                    </>
                  );
                })()}
                <td>{formatDate(p.last_grn_date)}</td>
                <td><span className={`badge ${getStatusBadge(p.status)}`}>{p.status}</span></td>
                <td>
                  <button
                    onClick={() => openPayModal(p)}
                    style={{ padding: '5px 14px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
                  >
                    {t('pay')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </>
      )}

      {tab === 'payments' && (
        <>
          <div style={{ marginBottom: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="text" placeholder={t('searchBySupplierOrRef')} value={paymentSearch}
              onChange={e => setPaymentSearch(e.target.value)}
              style={{ flex: 1, padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
            {/* v1.13.43 — universal export (ZRA #30) */}
            <ExportButtons
              rows={apPayments}
              filename="ap-payments"
              sheetName="Payments"
              columns={[
                { key: 'date',             label: 'Date' },
                { key: 'payment_number',   label: 'Reference' },
                { key: 'supplier_name_resolved', label: 'Supplier', format: (v, r) => v || r.supplier_name || '' },
                { key: 'paid_from',        label: 'Paid From' },
                { key: 'description',      label: 'Description' },
                { key: 'amount',           label: 'Amount', format: v => Number(v || 0).toFixed(2) },
              ]}
              pdfOptions={{ title: 'AP Payments' }}
            />
          </div>
          <div className="data-table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('date')}</th><th>{t('reference')}</th><th>{t('supplier')}</th>
                  <th>{t('paidFrom')}</th><th>{t('description')}</th>
                  <th style={{ textAlign: 'right' }}>{t('amount')}</th>
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const rows = apPayments.filter(p => matchTokens(
                    paymentSearch,
                    p.supplier_name_resolved, p.supplier_name,
                    p.payment_number, p.description
                  ));
                  if (rows.length === 0) {
                    return <tr><td colSpan="6" style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No payments recorded.</td></tr>;
                  }
                  const total = rows.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
                  return <>
                    {rows.map(p => (
                      <tr key={p.id}>
                        <td>{formatDate(p.date)}</td>
                        <td style={{ color: '#6b7280', fontSize: 12 }}>{p.payment_number || '—'}</td>
                        <td style={{ fontWeight: 600 }}>{p.supplier_name_resolved || p.supplier_name || '—'}</td>
                        <td style={{ color: '#6b7280' }}>{p.paid_from || '—'}</td>
                        <td style={{ color: '#6b7280' }}>{p.description || '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>K{parseFloat(p.amount).toLocaleString()}</td>
                      </tr>
                    ))}
                    <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                      <td colSpan="5">TOTAL — {rows.length} payment(s)</td>
                      <td style={{ textAlign: 'right', color: '#16a34a' }}>K{total.toLocaleString()}</td>
                    </tr>
                  </>;
                })()}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Breakdown Modal */}
      {breakdown && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 640, maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 24px', borderBottom: '1px solid #e5e7eb', position: 'sticky', top: 0, background: '#fff', zIndex: 1 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{breakdown.supplier?.supplier_name || breakdown.supplier?.name}</h2>
                <p style={{ margin: '2px 0 0', fontSize: 12, color: '#6b7280' }}>Supplier account breakdown</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={handleBreakdownPrint} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 7, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  <FiPrinter size={13} /> Print
                </button>
                <button onClick={() => setBreakdown(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
              </div>
            </div>

            <div style={{ padding: '18px 24px' }}>
              {loadingBreakdown ? (
                <div style={{ textAlign: 'center', color: '#6b7280', padding: 32 }}>Loading...</div>
              ) : (
                <>
                  {/* GRNs */}
                  <h3 style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 10 }}>Purchases (GRN)</h3>
                  {breakdown.grns?.length === 0 ? (
                    <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 18 }}>No purchases yet.</p>
                  ) : (
                    <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 20 }}>
                      <thead>
                        <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600 }}>GRN #</th>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600 }}>Date</th>
                          <th style={{ textAlign: 'right', padding: '7px 10px', fontWeight: 600 }}>Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdown.grns.map(g => (
                          <tr key={g.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '7px 10px', color: '#6b7280' }}>{g.grn_number}</td>
                            <td style={{ padding: '7px 10px' }}>{formatDate(g.date)}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600 }}>K{(parseFloat(g.total_amount) + parseFloat(g.cn_amount || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                          </tr>
                        ))}
                        <tr style={{ background: '#f0fdf4', fontWeight: 700 }}>
                          <td colSpan="2" style={{ padding: '7px 10px', textAlign: 'right' }}>Total Purchases:</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: '#dc2626' }}>K{breakdown.grns.reduce((s, g) => s + parseFloat(g.total_amount) + parseFloat(g.cn_amount || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        </tr>
                      </tbody>
                    </table>
                  )}

                  {/* Payments */}
                  <h3 style={{ fontSize: 14, fontWeight: 700, color: '#374151', marginBottom: 10 }}>Payments Made (AP)</h3>
                  {breakdown.payments?.length === 0 ? (
                    <p style={{ fontSize: 13, color: '#9ca3af', marginBottom: 18 }}>No payments yet.</p>
                  ) : (
                    <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 20 }}>
                      <thead>
                        <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600 }}>Ref #</th>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600 }}>Date</th>
                          <th style={{ textAlign: 'left', padding: '7px 10px', fontWeight: 600 }}>Description</th>
                          <th style={{ textAlign: 'right', padding: '7px 10px', fontWeight: 600 }}>Amount</th>
                          <th style={{ padding: '7px 10px' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {breakdown.payments.map(p => (
                          editingPayment?.id === p.id ? (
                            <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6', background: '#fffbeb' }}>
                              <td style={{ padding: '7px 10px', color: '#6b7280', fontSize: 12 }}>{p.payment_number}</td>
                              <td style={{ padding: '4px 6px' }}>
                                <input type="date" value={editingPayment.date} onChange={e => setEditingPayment(ep => ({ ...ep, date: e.target.value }))}
                                  style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, width: '100%' }} />
                              </td>
                              <td style={{ padding: '4px 6px' }}>
                                <input type="text" value={editingPayment.description} onChange={e => setEditingPayment(ep => ({ ...ep, description: e.target.value }))}
                                  style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, width: '100%' }} />
                              </td>
                              <td style={{ padding: '4px 6px' }}>
                                <input type="number" value={editingPayment.amount} onChange={e => setEditingPayment(ep => ({ ...ep, amount: e.target.value }))}
                                  style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, width: 80, textAlign: 'right' }} />
                              </td>
                              <td style={{ padding: '4px 6px', whiteSpace: 'nowrap' }}>
                                <button onClick={handleSaveEdit} disabled={editSaving} style={{ background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 12, marginRight: 4 }}>
                                  {editSaving ? '...' : <FiSave size={12} />}
                                </button>
                                <button onClick={() => { setEditingPayment(null); setEditError(''); }} style={{ background: '#f3f4f6', border: 'none', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 12 }}>
                                  <FiX size={12} />
                                </button>
                              </td>
                            </tr>
                          ) : (
                          <tr key={p.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '7px 10px', color: '#6b7280' }}>{p.payment_number}</td>
                            <td style={{ padding: '7px 10px' }}>{formatDate(p.date)}</td>
                            <td style={{ padding: '7px 10px', color: '#6b7280' }}>{p.description || '—'}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: '#16a34a', fontWeight: 600 }}>K{parseFloat(p.amount).toLocaleString()}</td>
                            <td style={{ padding: '7px 10px', whiteSpace: 'nowrap' }}>
                              {hasPermission('AccountPayables:Edit') && (
                              <button onClick={() => { setEditingPayment({ id: p.id, amount: p.amount, date: p.date, description: p.description || '', paid_from: p.paid_from || '' }); setEditError(''); }}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', marginRight: 6 }}>
                                <FiEdit2 size={13} />
                              </button>
                              )}
                              {hasPermission('AccountPayables:Delete') && (
                              <button onClick={() => handleDeletePayment(p.id)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626' }}>
                                <FiTrash2 size={13} />
                              </button>
                              )}
                            </td>
                          </tr>
                          )
                        ))}
                        <tr style={{ background: '#f0fdf4', fontWeight: 700 }}>
                          <td colSpan="3" style={{ padding: '7px 10px', textAlign: 'right' }}>Total Paid:</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', color: '#16a34a' }}>K{breakdown.payments.reduce((s, p) => s + parseFloat(p.amount), 0).toLocaleString()}</td>
                        </tr>
                      </tbody>
                    </table>
                  )}

                  {editError && <div style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{editError}</div>}

                  {/* Credit Notes section — supplier discounts + crate/bottle returns.
                      Same effect on the balance as payments. Shown as a third section
                      so the user can see exactly how the supplier credited them. */}
                  {breakdown.credits && breakdown.credits.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 8, color: '#0369a1' }}>Credit Notes</h3>
                      <table className="phone-cards" style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                        <thead>
                          <tr style={{ background: '#f0f9ff' }}>
                            <th style={{ padding: '7px 10px', textAlign: 'left', color: '#0369a1' }}>CN #</th>
                            <th style={{ padding: '7px 10px', textAlign: 'left', color: '#0369a1' }}>Date</th>
                            <th style={{ padding: '7px 10px', textAlign: 'left', color: '#0369a1' }}>Reason</th>
                            <th style={{ padding: '7px 10px', textAlign: 'left', color: '#0369a1' }}>Reference</th>
                            <th style={{ padding: '7px 10px', textAlign: 'right', color: '#0369a1' }}>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {breakdown.credits.map(cn => (
                            <tr key={cn.id} style={{ borderBottom: '1px solid #e0f2fe' }}>
                              <td style={{ padding: '7px 10px', fontWeight: 500 }}>{cn.credit_note_number}</td>
                              <td style={{ padding: '7px 10px' }}>{formatDate(cn.date)}</td>
                              <td style={{ padding: '7px 10px' }}>
                                <span style={{ padding: '1px 8px', borderRadius: 8, fontSize: 11, fontWeight: 700,
                                  background: cn.reason === 'Discount' ? '#dcfce7' : '#dbeafe',
                                  color: cn.reason === 'Discount' ? '#166534' : '#1d4ed8' }}>{cn.reason}</span>
                              </td>
                              <td style={{ padding: '7px 10px', color: '#6b7280' }}>{cn.reference || '—'}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right', color: '#0369a1', fontWeight: 600 }}>
                                {curSym}{parseFloat(cn.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            </tr>
                          ))}
                          <tr style={{ background: '#f0f9ff', fontWeight: 700 }}>
                            <td colSpan="4" style={{ padding: '7px 10px', textAlign: 'right' }}>Total Credits:</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', color: '#0369a1' }}>
                              {curSym}{breakdown.credits.reduce((s, c) => s + parseFloat(c.amount), 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Balance — reconciles Purchases − Paid − Credits.
                      Same arithmetic the AP supplier-list row uses, so the two
                      always match. The "(includes K… in credits)" hint makes it
                      obvious why Outstanding moved when the user adds a CN. */}
                  {(() => {
                    // Gross: total_amount is final_payable, cn_amount is what was
                    // taken off it. Adding it back lets the credit notes below be
                    // deducted once, in view, instead of silently inside each GRN.
                    const totalPurchases = breakdown.grns?.reduce((s, g) => s + parseFloat(g.total_amount) + parseFloat(g.cn_amount || 0), 0) || 0;
                    const totalPaid = breakdown.payments?.reduce((s, p) => s + parseFloat(p.amount), 0) || 0;
                    const totalCredits = breakdown.credits?.reduce((s, c) => s + parseFloat(c.amount), 0) || 0;
                    // Convention: balance > 0 = supplier paid in advance (we owe negative);
                    // balance < 0 = we still owe.
                    const balance = totalPaid + totalCredits - totalPurchases;
                    return (
                      <div style={{ background: balance > 0.01 ? '#f0fdf4' : balance < -0.01 ? '#fef2f2' : '#f9fafb', border: `1px solid ${balance > 0.01 ? '#bbf7d0' : balance < -0.01 ? '#fecaca' : '#e5e7eb'}`, borderRadius: 8, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>
                            {balance > 0.01 ? 'Over Paid:' : balance < -0.01 ? 'Outstanding:' : 'Outstanding Balance:'}
                          </span>
                          {totalCredits > 0.01 && (
                            <div style={{ fontSize: 11, color: '#0369a1', marginTop: 3 }}>
                              Purchases {curSym}{totalPurchases.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} − Paid {curSym}{totalPaid.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} − Credits {curSym}{totalCredits.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </div>
                          )}
                        </div>
                        <span style={{ fontWeight: 700, fontSize: 16, color: balance > 0.01 ? '#16a34a' : balance < -0.01 ? '#dc2626' : '#374151' }}>{balance < 0 ? '−' : ''}{curSym}{Math.abs(balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                      </div>
                    );
                  })()}
                </>
              )}
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Payment Modal — shared component, also used by GRN.js */}
      <ApPaymentFormModal
        open={!!payModal}
        supplier={payModal}
        onClose={() => setPayModal(null)}
        onSaved={handlePaymentSaved}
      />
      {/* ── AP List Print Overlay ───────────────────────────────────── */}
      {false && showListPrint && (
        <div className="pv-print-overlay" style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.85)', zIndex: 1000, display: 'flex', flexDirection: 'column', alignItems: 'center', overflowY: 'auto', paddingTop: 60, paddingBottom: 40 }}>
          <div className="no-print" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 52, background: '#0f172a', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px', zIndex: 1001, borderBottom: '1px solid #1e293b' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPrinter size={16} style={{ color: '#64748b' }} />
              <span style={{ color: '#94a3b8', fontSize: 13, fontWeight: 500 }}>Print Preview — Account Payables ({payables.length} suppliers)</span>
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => window.print()} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '7px 20px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}><FiPrinter size={14} /> Print</button>
              <button onClick={() => setShowListPrint(false)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, border: '1px solid #334155', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 13 }}><FiX size={14} /> Close</button>
            </div>
          </div>

          <div id="ap-list-document" style={{ width: 794, background: '#fff', margin: '0 auto', boxShadow: '0 25px 60px rgba(0,0,0,0.5)', fontFamily: '"Segoe UI", Arial, sans-serif', fontSize: 12, color: '#1a1a2e', flexShrink: 0 }}>
            {/* Header */}
            <div style={{ background: 'linear-gradient(135deg, #991b1b 0%, #dc2626 100%)', padding: '28px 44px 22px', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.3, marginBottom: 5 }}>{businessInfo.business_name || 'Business Name'}</div>
                <div style={{ fontSize: 11, opacity: 0.75 }}>{[businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join('  |  ')}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', opacity: 0.65, marginBottom: 6 }}>Account Payables</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Supplier Ledger</div>
                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 4 }}>Printed: {new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            </div>
            {/* Rainbow divider */}
            <div style={{ height: 4, background: 'linear-gradient(90deg, #f59e0b, #dc2626, #a855f7)' }} />

            <div style={{ padding: '26px 44px 36px' }}>
              {/* Stat chips */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 24 }}>
                {[
                  { label: 'Total Purchases', value: curSym + parseFloat(stats.totalPurchases).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
                  { label: 'Total Paid',       value: curSym + parseFloat(stats.totalPaid).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),      bg: '#f0fdf4', color: '#16a34a', border: '#bbf7d0' },
                  { label: 'Outstanding',      value: curSym + parseFloat(stats.outstanding).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),    bg: '#fef2f2', color: '#dc2626', border: '#fecaca' },
                  { label: 'Suppliers',        value: stats.suppliers,                                                                                  bg: '#f8fafc', color: '#374151', border: '#e2e8f0' },
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
                    <tr style={{ background: '#fef2f2' }}>
                      {['#', 'Supplier', 'Phone', 'GRNs', 'Purchases', 'Paid', 'Balance', 'Status'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: i >= 4 && i <= 6 ? 'right' : 'left', fontWeight: 600, color: '#dc2626', borderBottom: '1px solid #fecaca', fontSize: 10.5, whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {payables.map((p, idx) => (
                      <tr key={p.id} style={{ borderBottom: '1px solid #f1f5f9', background: idx % 2 === 1 ? '#fafafa' : '#fff' }}>
                        <td style={{ padding: '8px 12px', color: '#9ca3af', fontSize: 10.5 }}>{idx + 1}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 700 }}>{p.supplier_name}</td>
                        <td style={{ padding: '8px 12px', color: '#6b7280' }}>{p.phone || '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'center' }}>{p.grn_count}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>{curSym}{parseFloat(p.total_purchases).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: '#16a34a', fontWeight: 600 }}>{curSym}{parseFloat(p.total_paid).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                        {/* Flip the sign for display: positive (paid more than owed) → green; negative (we still owe) → red. */}
                        {(() => {
                          const bal = -parseFloat(p.balance || 0);
                          return (
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: bal > 0.01 ? '#16a34a' : bal < -0.01 ? '#dc2626' : '#374151' }}>
                              {bal < 0 ? '−' : ''}{curSym}{Math.abs(bal).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                          );
                        })()}
                        <td style={{ padding: '8px 12px', color: '#6b7280' }}>{p.status}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#fef2f2', borderTop: '2px solid #fca5a5' }}>
                      <td colSpan={4} style={{ padding: '10px 12px', fontWeight: 700, fontSize: 11.5, color: '#dc2626' }}>TOTAL — {payables.length} Supplier{payables.length !== 1 ? 's' : ''}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700 }}>{curSym}{parseFloat(stats.totalPurchases).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#16a34a' }}>K{parseFloat(stats.totalPaid).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, fontSize: 13, color: '#dc2626' }}>K{parseFloat(stats.outstanding).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12, display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>{businessInfo.business_name || 'Business'} — Confidential</span>
                <span style={{ fontSize: 9.5, color: '#cbd5e1' }}>Printed: {new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              </div>
            </div>
          </div>
        </div>
      )}
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


// 2026-08-30 — same card as HQ Suppliers (RollupCard there), so Account
// Payables and HQ Suppliers read as one system rather than two designs.
// White, thin border, colour reserved for the label and for the single
// highlighted figure.
function RollupCard({ icon, label, value, color, highlight }) {
  return (
    <div style={{ background: '#fff', border: `1px solid ${highlight ? color : '#e5e7eb'}`, borderRadius: 10, padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color, fontSize: 12, fontWeight: 600 }}>
        {icon} <span>{label}</span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: highlight ? color : '#0f172a', marginTop: 4 }}>{value}</div>
    </div>
  );
}

export default AccountPayables;
