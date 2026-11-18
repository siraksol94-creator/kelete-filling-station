import React, { useState, useEffect, useCallback } from 'react';
import {
  getCustomers, getCustomerStats, createCustomer, updateCustomer, deleteCustomer,
  getCustomerStatement, getCustomerAging, getCustomerInsights,
  getCustomerPayments, createCustomerPayment, updateCustomerPayment, deleteCustomerPayment,
  getOrphanOrders, claimOrphanOrders, lookupZraCustomer,
} from '../services/api';
import { useLanguage } from '../context/LanguageContext';
import fmtInvoiceNo from '../utils/fmtInvoiceNo';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiSearch, FiEdit2, FiTrash2, FiX, FiTrendingUp, FiPlus, FiFileText } from 'react-icons/fi';
import Portal from '../utils/Portal';
import { matchTokens } from '../utils/tokenSearch';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const TYPES = ['Regular', 'Wholesale', 'Retail'];
const typeColors = { Regular: '#16a34a', Wholesale: '#2563eb', Retail: '#9333ea' };
const avatarColors = ['#dc2626', '#2563eb', '#16a34a', '#f59e0b', '#9333ea', '#ec4899'];
const todayStr = () => new Date().toISOString().slice(0, 10);

const emptyForm = {
  name: '', type: 'Regular', phone: '', email: '', address: '', tpin: '',
  credit_limit: '', payment_terms_days: '', credit_status: 'Active',
};

const Customers = () => {
  const { t } = useLanguage();
  const { hasPermission } = useAuth();
  const { symbol: curSym, methodShown } = useCurrency();
  const [stats, setStats] = useState({ totalCustomers: 0, retail: 0, wholesale: 0, totalRevenue: 0 });
  const [customers, setCustomers] = useState([]);
  const [search, setSearch] = useState('');
  // 2026-09-04 — account holders and everyone else are different populations.
  // A customer registered from the POS Pay modal is created OnHold: it exists
  // so a TPIN can go on an invoice, not so they can buy on credit. Splitting
  // them makes "who can actually take credit from us" answerable at a glance,
  // rather than something you infer from a badge in a long list.
  const [creditTab, setCreditTab] = useState('Active');
  const [typeFilter, setTypeFilter] = useState('All');

  // Modals
  const [formModal, setFormModal] = useState(null); // { customer? }
  const [form, setForm] = useState(emptyForm);

  // v1.13.128k — ZRA TPIN lookup for the New/Edit Customer modal.
  // Mirrors the POS Pay-modal behaviour (see POS.js:lookupTpin). Clicking
  // "Verify" calls /api/zra/customer-lookup/:tpin; on success we auto-fill
  // Name + Address ONLY if those fields are still empty (never trample
  // what the operator typed). Silent no-op if VSDC is not configured on
  // this tenant so screens stay usable pre-integration.
  const [tpinLookup, setTpinLookup] = useState({ status: 'idle' });
  const verifyTpinNow = async () => {
    const t = String(form.tpin || '').trim();
    if (!/^\d{10}$/.test(t)) {
      setTpinLookup({ status: 'error', message: 'Enter a 10-digit TPIN first' });
      return;
    }
    setTpinLookup({ status: 'loading' });
    try {
      const res  = await lookupZraCustomer(t);
      const body = res?.data || {};
      if (body.skipped) {
        setTpinLookup({ status: 'idle' });
        return;
      }
      if (body.exists && body.customer) {
        setTpinLookup({
          status: 'verified',
          name:    body.customer.name    || '',
          address: body.customer.address || '',
        });
        setForm(f => ({
          ...f,
          name:    f.name    || body.customer.name    || f.name,
          address: f.address || body.customer.address || f.address,
        }));
      } else {
        setTpinLookup({ status: 'notfound', message: 'TPIN not registered with ZRA' });
      }
    } catch (e) {
      setTpinLookup({ status: 'error', message: e?.response?.data?.error || e?.message || 'Lookup failed' });
    }
  };
  // Reset the lookup badge whenever the modal opens/closes or the TPIN
  // string changes — so a stale "verified" chip doesn't hang around.
  useEffect(() => { setTpinLookup({ status: 'idle' }); }, [formModal]);
  const [paymentModal, setPaymentModal] = useState(null); // { customer }
  const [paymentForm, setPaymentForm] = useState({ cash_amount: '', bank_amount: '', momo_amount: '', payment_date: todayStr(), reference: '', notes: '' });
  const [statementModal, setStatementModal] = useState(null); // { customer, entries, outstanding }

  useModalScrollLock(!!formModal || !!paymentModal || !!statementModal);
  const [agingModal, setAgingModal] = useState(null); // { rows }
  const [insightsModal, setInsightsModal] = useState(null); // insights payload
  const [orphanByCustomer, setOrphanByCustomer] = useState({}); // {customerId: {orphan_count, orphan_total}}
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3500); };

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, customersRes] = await Promise.all([getCustomerStats(), getCustomers()]);
      if (statsRes.data) setStats(statsRes.data);
      const list = Array.isArray(customersRes.data) ? customersRes.data : [];
      setCustomers(list);

      // Find duplicate names (case-insensitive) — only those can have orphan orders worth claiming.
      const nameCounts = {};
      for (const c of list) {
        const k = (c.name || '').toLowerCase().trim();
        nameCounts[k] = (nameCounts[k] || 0) + 1;
      }
      const dupes = list.filter(c => nameCounts[(c.name || '').toLowerCase().trim()] > 1);
      const orphanMap = {};
      await Promise.all(dupes.map(async (c) => {
        try {
          const res = await getOrphanOrders(c.id);
          if (res.data?.orphan_count > 0) orphanMap[c.id] = res.data;
        } catch { /* ignore */ }
      }));
      setOrphanByCustomer(orphanMap);
    } catch (err) { /* keep stale */ }
  }, []);

  const handleClaimOrphans = async (c) => {
    const info = orphanByCustomer[c.id];
    if (!info) return;
    if (!window.confirm(`Link ${info.orphan_count} unassigned order(s) totalling ${curSym}${(parseFloat(parseFloat(info.orphan_total))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} to "${c.name}"?\n\nThis cannot be auto-undone — the other duplicate "${c.name}" customers will lose this history.`)) return;
    try {
      const res = await claimOrphanOrders(c.id);
      showToast(`Claimed ${res.data.claimed} order(s) for ${c.name}`);
      await fetchData();
    } catch (err) { showToast(err.response?.data?.error || 'Claim failed', 'error'); }
  };

  useEffect(() => {
    fetchData();
    window.addEventListener('sync-complete', fetchData);
    return () => window.removeEventListener('sync-complete', fetchData);
  }, [fetchData]);

  const statusOf = (c) => (c.credit_status === 'OnHold' ? 'OnHold' : 'Active');
  const counts = customers.reduce((a, c) => { a[statusOf(c)]++; return a; }, { Active: 0, OnHold: 0 });

  const filtered = customers.filter(c => {
    const matchSearch = matchTokens(search, c.name, c.phone, c.email, c.address);
    const matchType = typeFilter === 'All' || c.type === typeFilter;
    const matchTab = creditTab === 'All' || statusOf(c) === creditTab;
    return matchSearch && matchType && matchTab;
  });

  const getInitials = name => name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
  const fmt = (n) => `${curSym}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // ── Form (create / edit) ──
  const openCreate = () => { setForm(emptyForm); setFormModal({ customer: null }); };
  const openEdit = (c) => {
    setForm({
      name: c.name || '', type: c.type || 'Regular', phone: c.phone || '',
      email: c.email || '', address: c.address || '', tpin: c.tpin || '',
      credit_limit: c.credit_limit ?? '', payment_terms_days: c.payment_terms_days ?? '',
      credit_status: c.credit_status || 'Active',
    });
    setFormModal({ customer: c });
  };
  const saveForm = async () => {
    if (!form.name.trim()) { showToast('Name is required', 'error'); return; }
    // v1.13.142 — Same guard the POS Pay modal uses: reject saves when
    // ZRA rejected the TPIN's format (status='error'). notfound is OK
    // (this IS the new-customer save that will put it in ZRA); verified
    // is also OK (the operator is editing/updating a known customer);
    // idle just means Verify was never clicked — allow so cashiers can
    // save walk-in customers without a TPIN.
    if (form.tpin && tpinLookup.status === 'error') {
      showToast(tpinLookup.message || 'ZRA rejected this TPIN. Fix or clear it before saving.', 'error');
      return;
    }
    try {
      if (formModal.customer) await updateCustomer(formModal.customer.id, form);
      else await createCustomer(form);
      setFormModal(null);
      await fetchData();
      showToast('Saved');
    } catch (err) { showToast(err.response?.data?.error || 'Save failed', 'error'); }
  };
  const handleDelete = (c) => {
    setPendingDelete({
      subject: `Customer: ${c.name}`,
      perform: async () => {
        try {
          await deleteCustomer(c.id);
          await fetchData();
          showToast('Deleted');
        } catch (err) {
          const data = err.response?.data;
          if (data?.needs_cascade) {
            // Secondary confirmation — admin already authenticated above.
            if (!window.confirm(`${data.error}\n\nProceed and delete the ${data.payment_count} payment record(s) too?`)) return;
            try {
              await deleteCustomer(c.id, { cascadePayments: true });
              await fetchData();
              showToast('Customer + payment records deleted');
            } catch (err2) { showToast(err2.response?.data?.error || 'Delete failed', 'error'); }
          } else {
            showToast(data?.error || 'Delete failed', 'error');
          }
        }
      },
    });
  };
  // Admin-password gate shared with other destructive actions.
  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };

  // ── Payment ──
  const openPayment = (c) => {
    setPaymentForm({ cash_amount: '', bank_amount: '', momo_amount: '', payment_date: todayStr(), reference: '', notes: '' });
    setPaymentModal({ customer: c });
  };
  const savePayment = async () => {
    const total = parseFloat(paymentForm.cash_amount || 0) + parseFloat(paymentForm.bank_amount || 0) + parseFloat(paymentForm.momo_amount || 0);
    if (!(total > 0)) { showToast('Enter at least one method > 0', 'error'); return; }
    try {
      await createCustomerPayment({ customer_id: paymentModal.customer.id, ...paymentForm });
      setPaymentModal(null);
      await fetchData();
      showToast('Payment recorded — Cash Receipt issued');
    } catch (err) { showToast(err.response?.data?.error || 'Failed', 'error'); }
  };

  // ── Statement ──
  const openStatement = async (c) => {
    try {
      const res = await getCustomerStatement(c.id);
      setStatementModal(res.data);
    } catch (err) { showToast('Failed to load statement', 'error'); }
  };

  // ── Insights ──
  const openInsights = async (c) => {
    try {
      const res = await getCustomerInsights(c.id);
      setInsightsModal(res.data);
    } catch (err) { showToast('Failed to load insights', 'error'); }
  };

  // ── AR Aging ──
  const openAging = async () => {
    try {
      const res = await getCustomerAging();
      setAgingModal({ rows: res.data || [] });
    } catch (err) { showToast('Failed to load aging report', 'error'); }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>{t('customersTitle') || 'Customers'}</h1>
          <p>{t('customersSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {hasPermission('Customers:View') !== false && (
            <button
              onClick={openAging}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
            >
              <FiFileText size={14} /> Aging Report
            </button>
          )}
          {hasPermission('Customers:Add') !== false && (
            <button
              onClick={openCreate}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 18px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, boxShadow: '0 2px 6px rgba(37,99,235,0.25)' }}
            >
              <FiPlus size={15} /> New Customer
            </button>
          )}
        </div>
      </div>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, padding: '10px 18px', borderRadius: 8, color: '#fff', fontWeight: 600, background: toast.type === 'error' ? '#dc2626' : '#16a34a', boxShadow: '0 4px 14px rgba(0,0,0,0.18)', zIndex: 1100 }}>
          {toast.msg}
        </div>
      )}

      <div className="stat-cards" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="stat-card blue"><div><div className="stat-label">{t('totalCustomers')}</div><div className="stat-value">{stats.totalCustomers}</div></div></div>
        <div className="stat-card green"><div><div className="stat-label">{t('retail')}</div><div className="stat-value">{stats.retail}</div></div></div>
        <div className="stat-card orange"><div><div className="stat-label">{t('wholesale')}</div><div className="stat-value">{stats.wholesale}</div></div></div>
        <div className="stat-card red"><div><div className="stat-label">{t('totalRevenue')}</div><div className="stat-value">{fmt(stats.totalRevenue)}</div></div></div>
      </div>

      {/* Account holders first — it is the smaller, more consequential list. */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: '2px solid #e5e7eb' }}>
        {[
          { key: 'Active', label: 'Account holders', hint: 'can buy on credit', n: counts.Active },
          { key: 'OnHold', label: 'On hold',         hint: 'cash only',        n: counts.OnHold },
          { key: 'All',    label: 'All',             hint: '',                 n: customers.length },
        ].map(tb => (
          <button key={tb.key} onClick={() => setCreditTab(tb.key)}
            title={tb.hint}
            style={{
              padding: '9px 16px', background: 'none', border: 'none',
              borderBottom: creditTab === tb.key ? '3px solid #1d4ed8' : '3px solid transparent',
              color: creditTab === tb.key ? '#1d4ed8' : '#6b7280',
              fontWeight: creditTab === tb.key ? 700 : 500, fontSize: 13.5,
              cursor: 'pointer', marginBottom: -2,
            }}>
            {tb.label} <span style={{ color: '#9ca3af', fontWeight: 600 }}>({tb.n})</span>
          </button>
        ))}
      </div>

      <div className="filter-bar" style={{ display: 'flex', gap: 12, marginBottom: 14 }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <FiSearch style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} />
          <input type="text" placeholder={t('searchByNameOrPhone')} value={search} onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', padding: '10px 12px 10px 36px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
          style={{ padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: '#fff' }}>
          <option value="All">{t('allTypes')}</option>
          {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
        <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ background: '#f9fafb' }}>
              <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>{t('name')}</th>
              <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>{t('type')}</th>
              <th style={{ padding: '11px 14px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>{t('phone')}</th>
              <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>{t('creditLimit')}</th>
              <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>{t('outstanding')}</th>
              <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>{t('usedPct')}</th>
              <th style={{ padding: '11px 14px', textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>{t('status')}</th>
              <th style={{ padding: '11px 14px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #e5e7eb' }}>{t('actions')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>{t('noCustomersYet')}</td></tr>
            ) : filtered.map((c, idx) => {
              const limit = parseFloat(c.credit_limit || 0);
              const outstanding = parseFloat(c.outstanding || 0);
              const usedPct = limit > 0 ? Math.round((outstanding / limit) * 100) : null;
              const overLimit = limit > 0 && outstanding > limit;
              const onHold = c.credit_status === 'OnHold';
              return (
                <tr key={c.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ width: 32, height: 32, borderRadius: '50%', background: avatarColors[idx % avatarColors.length], color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700 }}>{getInitials(c.name)}</div>
                      <div>
                        <div style={{ fontWeight: 600, color: '#111827' }}>{c.name}</div>
                        {c.email && <div style={{ fontSize: 11, color: '#9ca3af' }}>{c.email}</div>}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{ padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: `${typeColors[c.type] || '#6b7280'}22`, color: typeColors[c.type] || '#6b7280' }}>{c.type}</span>
                  </td>
                  <td style={{ padding: '10px 14px', color: '#6b7280' }}>{c.phone || '—'}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>{limit > 0 ? fmt(limit) : <span style={{ color: '#9ca3af' }}>Cash only</span>}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 600, color: outstanding > 0 ? (overLimit ? '#dc2626' : '#b45309') : '#16a34a' }}>{fmt(outstanding)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                    {usedPct == null ? <span style={{ color: '#9ca3af' }}>—</span> : (
                      <span style={{
                        padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                        background: usedPct >= 100 ? '#fee2e2' : usedPct >= 80 ? '#fef3c7' : '#dcfce7',
                        color: usedPct >= 100 ? '#b91c1c' : usedPct >= 80 ? '#b45309' : '#15803d',
                      }}>{usedPct}%</span>
                    )}
                  </td>
                  <td style={{ padding: '10px 14px', textAlign: 'center' }}>
                    {onHold ? (
                      <span style={{ padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#fee2e2', color: '#b91c1c' }}>On Hold</span>
                    ) : (
                      <span style={{ padding: '2px 10px', borderRadius: 10, fontSize: 11, fontWeight: 700, background: '#dcfce7', color: '#15803d' }}>Active</span>
                    )}
                  </td>
                  <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 4 }}>
                      {hasPermission('Customers:Edit') !== false && (
                        <button onClick={() => openEdit(c)} title="Edit"
                          style={{ width: 28, height: 28, background: '#fef3c7', color: '#b45309', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                          <FiEdit2 size={13} />
                        </button>
                      )}
                      {hasPermission('Customers:Delete') !== false && (
                        <button onClick={() => handleDelete(c)} title="Delete"
                          style={{ width: 28, height: 28, background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                          <FiTrash2 size={13} />
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

      {/* ── Form modal ── */}
      {formModal && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ margin: 0 }}>{formModal.customer ? 'Edit Customer' : 'New Customer'}</h3>
              <button onClick={() => setFormModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={18} /></button>
            </div>
            <div style={{ padding: 22, display: 'grid', gap: 12 }}>
              <div className="form-group">
                <label>Name *</label>
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value.toUpperCase() })} placeholder="CUSTOMER NAME" />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="form-group">
                  <label>Type</label>
                  <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                    {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label>Phone</label>
                  <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
                </div>
              </div>
              <div className="form-group">
                <label>Email</label>
                <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Address</label>
                <input value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Buyer TPIN <span style={{ fontWeight: 400, color: '#6b7280' }}>(10-digit — leave blank for walk-in)</span></label>
                {/* v1.13.128k — TPIN + inline Verify button. Mirrors the POS Pay
                    modal so operators get consistent behaviour: type TPIN,
                    click Verify, ZRA auto-fills the Name + Address. */}
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    value={form.tpin}
                    onChange={e => { setForm({ ...form, tpin: e.target.value.replace(/\D/g, '').slice(0, 10) }); setTpinLookup({ status: 'idle' }); }}
                    onBlur={() => { if (/^\d{10}$/.test(form.tpin || '')) verifyTpinNow(); }}
                    placeholder="e.g. 1001710705"
                    inputMode="numeric"
                    maxLength={10}
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    onClick={verifyTpinNow}
                    disabled={tpinLookup.status === 'loading' || !/^\d{10}$/.test(form.tpin || '')}
                    title="Verify TPIN with ZRA"
                    style={{
                      padding: '0 14px',
                      border: '1px solid #d1d5db',
                      background: tpinLookup.status === 'loading' ? '#f3f4f6' : '#fff',
                      color: '#374151',
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: (tpinLookup.status === 'loading' || !/^\d{10}$/.test(form.tpin || '')) ? 'not-allowed' : 'pointer',
                      opacity: (!/^\d{10}$/.test(form.tpin || '')) ? 0.55 : 1,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {tpinLookup.status === 'loading' ? '…' : 'Verify'}
                  </button>
                </div>
                {tpinLookup.status === 'loading' && (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#6b7280' }}>Checking with ZRA…</div>
                )}
                {tpinLookup.status === 'verified' && (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#059669', fontWeight: 600 }}>
                    ✓ Verified with ZRA{tpinLookup.name ? ` — ${tpinLookup.name}` : ''}
                  </div>
                )}
                {tpinLookup.status === 'notfound' && (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#b45309' }}>
                    ⚠ {tpinLookup.message}
                  </div>
                )}
                {tpinLookup.status === 'error' && (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#dc2626' }}>
                    ✕ {tpinLookup.message}
                  </div>
                )}
              </div>
              <div style={{ marginTop: 6, padding: '12px 14px', background: '#f9fafb', borderRadius: 8, border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 10 }}>CREDIT TERMS</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label>Credit Limit ($) — 0 = cash only</label>
                    <input type="number" min="0" step="1" value={form.credit_limit} onChange={e => setForm({ ...form, credit_limit: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>Payment Terms (days)</label>
                    <input type="number" min="0" step="1" value={form.payment_terms_days} onChange={e => setForm({ ...form, payment_terms_days: e.target.value })} />
                  </div>
                </div>
                <div className="form-group" style={{ marginTop: 10 }}>
                  <label>Credit Status</label>
                  <div style={{ display: 'inline-flex', background: '#fff', border: '1px solid #cbd5e1', borderRadius: 8, overflow: 'hidden' }}>
                    {['Active', 'OnHold'].map(s => (
                      <button key={s} type="button" onClick={() => setForm({ ...form, credit_status: s })}
                        style={{
                          padding: '6px 16px', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                          background: form.credit_status === s ? (s === 'Active' ? '#16a34a' : '#dc2626') : '#fff',
                          color: form.credit_status === s ? '#fff' : '#374151',
                        }}>{s === 'OnHold' ? 'On Hold' : s}</button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setFormModal(null)} style={{ padding: '8px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
              <button onClick={saveForm} style={{ padding: '8px 18px', background: '#1e40af', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>Save</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Payment modal ── */}
      {paymentModal && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 460, boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb' }}>
              <h3 style={{ margin: 0 }}>
                {parseFloat(paymentModal.customer.outstanding || 0) > 0.01 ? 'Record Payment' : 'Receive Down Payment'}
              </h3>
              <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
                From <strong>{paymentModal.customer.name}</strong>
                {parseFloat(paymentModal.customer.outstanding || 0) > 0.01
                  ? <> · outstanding {fmt(paymentModal.customer.outstanding)}</>
                  : <> · advance (credit applied to future credit sales)</>}
              </div>
            </div>
            <div style={{ padding: 22, display: 'grid', gap: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5 }}>Amount Paid (split across methods)</div>
              {/* 2026-09-11 — MoMo / Bank follow System Settings → Payment methods shown. */}
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${1 + (methodShown('bank') ? 1 : 0) + (methodShown('momo') ? 1 : 0)}, 1fr)`, gap: 10 }}>
                {[
                  { key: 'cash_amount', label: 'Cash', color: '#16a34a' },
                  { key: 'bank_amount', label: 'Bank', color: '#2563eb' },
                  { key: 'momo_amount', label: 'MoMo', color: '#f59e0b' },
                ].filter(f => methodShown(f.label)).map((f, i) => (
                  <div key={f.key}>
                    <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                    <input type="number" min="0" step="0.01" autoFocus={i === 0}
                      value={paymentForm[f.key]}
                      onChange={e => setPaymentForm({ ...paymentForm, [f.key]: e.target.value })}
                      placeholder="0.00"
                      style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(paymentForm[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(paymentForm[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 13 }}>
                <span style={{ color: '#6b7280' }}>Total</span>
                <span style={{ fontWeight: 800, color: '#1d4ed8' }}>
                  {fmt(parseFloat(paymentForm.cash_amount || 0) + parseFloat(paymentForm.bank_amount || 0) + parseFloat(paymentForm.momo_amount || 0))}
                </span>
              </div>
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
            <div style={{ padding: '14px 22px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setPaymentModal(null)} style={{ padding: '8px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}>Cancel</button>
              <button onClick={savePayment} style={{ padding: '8px 18px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 700 }}>Record</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Statement modal ── */}
      {statementModal && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 720, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0 }}>{statementModal.customer.name} — Statement</h3>
                <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>Outstanding: <strong style={{ color: parseFloat(statementModal.outstanding) > 0 ? '#dc2626' : '#16a34a' }}>{fmt(statementModal.outstanding)}</strong></div>
              </div>
              <button onClick={() => setStatementModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={18} /></button>
            </div>
            <div style={{ padding: 22 }}>
              <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead><tr style={{ background: '#f9fafb' }}>
                  <th style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Date</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Type</th>
                  <th style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Reference</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Amount</th>
                  <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Running</th>
                </tr></thead>
                <tbody>
                  {(statementModal.entries || []).length === 0 ? (
                    <tr><td colSpan={5} style={{ padding: 30, textAlign: 'center', color: '#9ca3af' }}>No transactions.</td></tr>
                  ) : statementModal.entries.map((e, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={{ padding: '7px 10px' }}>{(e.date || '').slice(0, 10)}</td>
                      <td style={{ padding: '7px 10px', textTransform: 'capitalize' }}>
                        <span style={{ padding: '1px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: e.type === 'order' ? '#eff6ff' : '#dcfce7', color: e.type === 'order' ? '#2563eb' : '#15803d' }}>{e.type}</span>
                      </td>
                      <td style={{ padding: '7px 10px', color: '#6b7280' }}>{e.order_number ? fmtInvoiceNo(e.order_number) : (e.reference || '—')}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600, color: parseFloat(e.amount) > 0 ? '#dc2626' : '#16a34a' }}>{fmt(e.amount)}</td>
                      <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700 }}>{fmt(e.running_balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* ── Insights modal ── */}
      {insightsModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 720, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}><FiTrendingUp /> {insightsModal.customer.name} — Insights</h3>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Route-planning data: visit frequency, recency, basket size.</div>
              </div>
              <button onClick={() => setInsightsModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={18} /></button>
            </div>
            <div style={{ padding: 22 }}>
              {insightsModal.order_count === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No orders yet for this customer.</div>
              ) : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
                    <div style={{ padding: 12, background: '#eff6ff', borderRadius: 8 }}>
                      <div style={{ fontSize: 11, color: '#1d4ed8', fontWeight: 700, textTransform: 'uppercase' }}>Orders</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: '#1d4ed8', marginTop: 2 }}>{insightsModal.order_count}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>since {insightsModal.first_order_date || '—'}</div>
                    </div>
                    <div style={{ padding: 12, background: '#dcfce7', borderRadius: 8 }}>
                      <div style={{ fontSize: 11, color: '#15803d', fontWeight: 700, textTransform: 'uppercase' }}>Total Revenue</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: '#15803d', marginTop: 2 }}>{fmt(insightsModal.total_revenue)}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>avg basket {fmt(insightsModal.avg_basket)}</div>
                    </div>
                    <div style={{ padding: 12, background: '#fef3c7', borderRadius: 8 }}>
                      <div style={{ fontSize: 11, color: '#b45309', fontWeight: 700, textTransform: 'uppercase' }}>Last Visit</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: '#b45309', marginTop: 2 }}>
                        {insightsModal.days_since_last == null ? '—' : `${insightsModal.days_since_last}d`}
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>on {insightsModal.last_order_date || '—'}</div>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
                    <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 8 }}>
                      <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>Visits / Revenue (30d)</div>
                      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>{insightsModal.last_30_days.count} · {fmt(insightsModal.last_30_days.revenue)}</div>
                    </div>
                    <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 8 }}>
                      <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>Visits / Revenue (90d)</div>
                      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>{insightsModal.last_90_days.count} · {fmt(insightsModal.last_90_days.revenue)}</div>
                    </div>
                    <div style={{ padding: 10, border: '1px solid #e5e7eb', borderRadius: 8 }}>
                      <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 700, textTransform: 'uppercase' }}>Avg Gap Between Visits</div>
                      <div style={{ fontSize: 15, fontWeight: 700, marginTop: 4 }}>{insightsModal.avg_gap_days == null ? '—' : `${insightsModal.avg_gap_days} days`}</div>
                    </div>
                  </div>

                  <div style={{ fontSize: 13, fontWeight: 700, color: '#374151', marginBottom: 8 }}>Top Products</div>
                  {insightsModal.top_products.length === 0 ? (
                    <div style={{ color: '#9ca3af', fontSize: 13, padding: '12px 0' }}>No line-item data.</div>
                  ) : (
                    <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead><tr style={{ background: '#f9fafb' }}>
                        <th style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Product</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Qty</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Revenue</th>
                      </tr></thead>
                      <tbody>
                        {insightsModal.top_products.map((p, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '7px 10px', fontWeight: 600 }}>{p.product_name}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right' }}>{p.qty}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700 }}>{fmt(p.revenue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── AR Aging modal ── */}
      {agingModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 920, maxHeight: '88vh', overflowY: 'auto', boxShadow: '0 24px 64px rgba(0,0,0,0.35)' }}>
            <div style={{ padding: '18px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ margin: 0 }}>AR Aging Report</h3>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>Customers with outstanding balances grouped by days overdue.</div>
              </div>
              <button onClick={() => setAgingModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={18} /></button>
            </div>
            <div style={{ padding: 18 }}>
              {agingModal.rows.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#9ca3af' }}>No customers with outstanding balances.</div>
              ) : (
                <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead><tr style={{ background: '#f9fafb' }}>
                    <th style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '1px solid #e5e7eb' }}>Customer</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb' }}>Current</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb', color: '#15803d' }}>1–30</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb', color: '#b45309' }}>31–60</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb', color: '#dc2626' }}>61–90</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb', color: '#7f1d1d' }}>90+</th>
                    <th style={{ padding: '8px 10px', textAlign: 'right', borderBottom: '1px solid #e5e7eb', fontWeight: 700 }}>Outstanding</th>
                  </tr></thead>
                  <tbody>
                    {agingModal.rows.map(r => (
                      <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '7px 10px', fontWeight: 600 }}>{r.name}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right' }}>{fmt(r.current)}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right' }}>{fmt(r['1_30'])}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right' }}>{fmt(r['31_60'])}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right' }}>{fmt(r['61_90'])}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right' }}>{fmt(r['90_plus'])}</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 700, color: '#dc2626' }}>{fmt(r.outstanding)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f9fafb', fontWeight: 700 }}>
                      <td style={{ padding: '9px 10px' }}>TOTAL</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right' }}>{fmt(agingModal.rows.reduce((s, r) => s + parseFloat(r.current || 0), 0))}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right' }}>{fmt(agingModal.rows.reduce((s, r) => s + parseFloat(r['1_30'] || 0), 0))}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right' }}>{fmt(agingModal.rows.reduce((s, r) => s + parseFloat(r['31_60'] || 0), 0))}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right' }}>{fmt(agingModal.rows.reduce((s, r) => s + parseFloat(r['61_90'] || 0), 0))}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right' }}>{fmt(agingModal.rows.reduce((s, r) => s + parseFloat(r['90_plus'] || 0), 0))}</td>
                      <td style={{ padding: '9px 10px', textAlign: 'right', color: '#dc2626' }}>{fmt(agingModal.rows.reduce((s, r) => s + parseFloat(r.outstanding || 0), 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
        </div>
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

export default Customers;
