// Capital Account — owner equity ledger (Injection / Drawing).
// Hits the Cash Book as inflow/outflow but is EXCLUDED from the Profit Report.
import React, { useEffect, useMemo, useState } from 'react';
import {
  getCapitalEntries, getCapitalStats, getCapitalEntry,
  createCapitalEntry, updateCapitalEntry, deleteCapitalEntry,
  getShareholders, getSettings,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiPlus, FiTrendingUp, FiTrendingDown, FiDollarSign, FiEye, FiEdit2, FiTrash2, FiX, FiPrinter } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import InvoiceAttachment from '../components/InvoiceAttachment';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const todayStr = new Date().toISOString().split('T')[0];

const formatDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const TYPE_STYLE = {
  Injection: { bg: '#dcfce7', color: '#166534', border: '#86efac' },
  Drawing:   { bg: '#fee2e2', color: '#991b1b', border: '#fecaca' },
};

const CapitalAccount = () => {
  const { hasPermission } = useAuth();
  const { symbol: curSym, methodShown } = useCurrency();
  const [stats, setStats]       = useState({ totalInjection: 0, totalDrawing: 0, netCapital: 0, count: 0, thisMonth: 0 });
  const [entries, setEntries]   = useState([]);
  const [toast, setToast]       = useState(null);
  const [businessInfo, setBusinessInfo] = useState({});

  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo,   setFilterTo]   = useState('');
  const [filterType, setFilterType] = useState('All');
  const [filterShareholder, setFilterShareholder] = useState('All');
  const [shareholders, setShareholders] = useState([]);

  const [showForm, setShowForm]     = useState(false);
  const [editId, setEditId]         = useState(null);
  const [viewEntry, setViewEntry]   = useState(null);
  const [saving, setSaving]         = useState(false);
  const [error, setError]           = useState('');

  const [form, setForm] = useState({
    type: 'Injection', shareholder_id: '', owner_name: '', date: todayStr,
    cash_amount: '', bank_amount: '', momo_amount: '',
    description: '', invoice_attachment: null,
  });

  useModalScrollLock(showForm || !!viewEntry);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchAll = async () => {
    try {
      const [listRes, statsRes] = await Promise.all([
        getCapitalEntries({
          from: filterFrom || undefined,
          to: filterTo || undefined,
          type: filterType !== 'All' ? filterType : undefined,
          shareholder_id: filterShareholder !== 'All' ? filterShareholder : undefined,
        }),
        getCapitalStats(),
      ]);
      setEntries(listRes.data || []);
      setStats(statsRes.data || { totalInjection: 0, totalDrawing: 0, netCapital: 0, count: 0, thisMonth: 0 });
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load capital entries.', 'error'); }
  };

  useEffect(() => {
    fetchAll();
    getSettings().then(r => setBusinessInfo(r.data?.business || {})).catch(() => {});
    getShareholders().then(r => setShareholders(r.data || [])).catch(() => {});
  }, []); // eslint-disable-line

  useEffect(() => { fetchAll(); }, [filterFrom, filterTo, filterType, filterShareholder]); // eslint-disable-line

  const resetForm = () => {
    setForm({
      type: 'Injection', shareholder_id: '', owner_name: '', date: todayStr,
      cash_amount: '', bank_amount: '', momo_amount: '',
      description: '', invoice_attachment: null,
    });
    setEditId(null);
    setError('');
  };

  const openNew = () => { resetForm(); setShowForm(true); };

  const openEdit = async (entry) => {
    try {
      const res = await getCapitalEntry(entry.id);
      const d = res.data;
      setEditId(d.id);
      setForm({
        type:           d.type || 'Injection',
        shareholder_id: d.shareholder_id ? String(d.shareholder_id) : '',
        owner_name:     d.owner_name || '',
        date:           d.date,
        cash_amount:    d.cash_amount > 0 ? String(d.cash_amount) : '',
        bank_amount:    d.bank_amount > 0 ? String(d.bank_amount) : '',
        momo_amount:    d.momo_amount > 0 ? String(d.momo_amount) : '',
        description:    d.description || '',
        invoice_attachment: d.invoice_attachment || null,
      });
      setError('');
      setShowForm(true);
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load entry.', 'error'); }
  };

  const save = async () => {
    setError('');
    const cash = parseFloat(form.cash_amount) || 0;
    const bank = parseFloat(form.bank_amount) || 0;
    const momo = parseFloat(form.momo_amount) || 0;
    if (cash + bank + momo <= 0) return setError('Total amount must be greater than 0.');
    setSaving(true);
    try {
      // owner_name is set from the selected shareholder so legacy display + filter still works.
      const selectedShareholder = shareholders.find(s => String(s.id) === String(form.shareholder_id));
      const payload = {
        type:           form.type,
        shareholder_id: form.shareholder_id ? parseInt(form.shareholder_id) : null,
        owner_name:     selectedShareholder?.name || form.owner_name.trim() || null,
        date:           form.date,
        cash_amount:    cash,
        bank_amount:    bank,
        momo_amount:    momo,
        description:    form.description.trim() || null,
        invoice_attachment: form.invoice_attachment,
      };
      if (editId) await updateCapitalEntry(editId, payload);
      else        await createCapitalEntry(payload);
      setShowForm(false);
      resetForm();
      await fetchAll();
      showToast(editId ? 'Capital entry updated.' : 'Capital entry saved.');
    } catch (e) { setError(e.response?.data?.error || 'Save failed.'); }
    finally { setSaving(false); }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDelete = (entry) => {
    setPendingDelete({
      subject: `Capital entry ${entry.entry_number} — reverses Cash Book effect`,
      perform: async () => {
        try {
          await deleteCapitalEntry(entry.id);
          setViewEntry(null);
          await fetchAll();
          showToast('Capital entry deleted.', 'error');
        } catch (e) { showToast(e.response?.data?.error || 'Delete failed.', 'error'); }
      },
    });
  };

  const openView = async (entry) => {
    try {
      const res = await getCapitalEntry(entry.id);
      setViewEntry(res.data);
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load entry.', 'error'); }
  };

  const filteredTotal = useMemo(
    () => entries.reduce((s, r) => s + parseFloat(r.amount || 0) * (r.type === 'Drawing' ? -1 : 1), 0),
    [entries],
  );

  const handlePrint = () => {
    const fmt = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const printedAt = new Date().toLocaleString();
    const biz = businessInfo.business_name || 'Business Name';
    const addr = [businessInfo.business_address, businessInfo.business_phone].filter(Boolean).join(' | ');
    const rows = entries.map((r, i) => `
      <tr style="background:${i%2 ? '#f9f9f9' : '#fff'}">
        <td style="padding:6px 9px">${i+1}</td>
        <td style="padding:6px 9px;font-weight:600">${r.entry_number}</td>
        <td style="padding:6px 9px">${formatDate(r.date)}</td>
        <td style="padding:6px 9px">${r.type}</td>
        <td style="padding:6px 9px">${r.owner_name || '—'}</td>
        <td style="padding:6px 9px;text-align:right;font-weight:700;color:${r.type==='Injection'?'#16a34a':'#dc2626'}">${r.type==='Drawing'?'-':'+'}${curSym}${fmt(r.amount)}</td>
        <td style="padding:6px 9px">${r.description || '—'}</td>
      </tr>`).join('');
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Capital Account — ${printedAt}</title>
      <style>@page{size:A4 portrait;margin:14mm}*{box-sizing:border-box;margin:0;padding:0}
      body{font-family:Arial,sans-serif;font-size:12px;color:#000}
      table{width:100%;border-collapse:collapse}
      th{padding:7px 9px;font-weight:700;background:#f0f0f0;border-bottom:1.5px solid #000;text-align:left;font-size:10.5px}
      </style></head><body>
      <div style="border-bottom:3px solid #000;padding-bottom:10px;margin-bottom:14px">
        <div style="font-size:8px;letter-spacing:3px;text-transform:uppercase">Equity Ledger</div>
        <div style="font-size:20px;font-weight:800">${biz} — Capital Account</div>
        <div style="font-size:10px">${addr} · Printed ${printedAt}</div>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:14px">
        <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
          <div style="font-size:9px;text-transform:uppercase;font-weight:600">Injections</div>
          <div style="font-size:14px;font-weight:800;color:#16a34a">+${curSym}${fmt(stats.totalInjection)}</div>
        </div>
        <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
          <div style="font-size:9px;text-transform:uppercase;font-weight:600">Drawings</div>
          <div style="font-size:14px;font-weight:800;color:#dc2626">-${curSym}${fmt(stats.totalDrawing)}</div>
        </div>
        <div style="flex:1;padding:10px 12px;border:1.5px solid #000;text-align:center">
          <div style="font-size:9px;text-transform:uppercase;font-weight:600">Net Capital</div>
          <div style="font-size:14px;font-weight:800">${curSym}${fmt(stats.netCapital)}</div>
        </div>
      </div>
      <table>
        <thead><tr><th>#</th><th>Entry #</th><th>Date</th><th>Type</th><th>Owner</th><th style="text-align:right">Amount</th><th>Description</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </body></html>`;
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  const canEdit = hasPermission('CapitalAccount:Edit') || hasPermission('CapitalAccount:Add');
  const canDelete = hasPermission('CapitalAccount:Delete');

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Capital Account</h1>
          <p>Owner equity ledger — injections (money in) and drawings (money out)</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={handlePrint}><FiPrinter /> Print</button>
          {hasPermission('CapitalAccount:Add') && (
            <button className="btn btn-primary" onClick={openNew}><FiPlus /> New Entry</button>
          )}
        </div>
      </div>

      {/* Stat cards */}
      <div className="stats-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#16a34a,#15803d)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>Total Injections</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{curSym}{parseFloat(stats.totalInjection).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#dc2626,#991b1b)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>Total Drawings</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{curSym}{parseFloat(stats.totalDrawing).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#1e40af,#1e3a8a)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>Net Capital</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{curSym}{parseFloat(stats.netCapital).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#6b21a8,#581c87)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase' }}>Entries</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{stats.count}</div>
          <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{stats.thisMonth} this month</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, padding: 12, background: '#f9fafb', borderRadius: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Filter by Date:</span>
        <span style={{ fontSize: 12, color: '#6b7280' }}>From</span>
        <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }} />
        <span style={{ fontSize: 12, color: '#6b7280' }}>To</span>
        <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }} />
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff' }}>
          <option value="All">All Types</option>
          <option value="Injection">Injection</option>
          <option value="Drawing">Drawing</option>
        </select>
        <select value={filterShareholder} onChange={e => setFilterShareholder(e.target.value)} style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff' }}>
          <option value="All">All Shareholders</option>
          {shareholders.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: '#6b7280' }}>
          {entries.length} entry{entries.length !== 1 ? 'ies' : ''} · Net <strong style={{ color: filteredTotal >= 0 ? '#16a34a' : '#dc2626' }}>{curSym}{filteredTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong>
        </div>
      </div>

      {/* List */}
      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>ENTRY #</th><th>DATE</th><th>TYPE</th><th>OWNER</th>
              <th style={{ textAlign: 'right' }}>AMOUNT</th>
              <th>DESCRIPTION</th><th style={{ textAlign: 'center' }}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No capital entries.</td></tr>
            ) : entries.map(r => {
              const ts = TYPE_STYLE[r.type] || TYPE_STYLE.Injection;
              return (
                <tr key={r.id}>
                  <td style={{ fontWeight: 600 }}>{r.entry_number}</td>
                  <td>{formatDate(r.date)}</td>
                  <td><span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: ts.bg, color: ts.color, border: `1px solid ${ts.border}` }}>{r.type}</span></td>
                  <td>{r.owner_name || '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: r.type === 'Injection' ? '#16a34a' : '#dc2626' }}>
                    {r.type === 'Drawing' ? '−' : '+'}{curSym}{parseFloat(r.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                  <td style={{ color: '#6b7280', fontSize: 12 }}>{r.description || '—'}</td>
                  <td style={{ textAlign: 'center' }}>
                    <button onClick={() => openView(r)} title="View" style={{ background: 'none', border: 'none', color: '#0369a1', cursor: 'pointer', padding: 4 }}><FiEye /></button>
                    {canEdit && <button onClick={() => openEdit(r)} title="Edit" style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', padding: 4 }}><FiEdit2 /></button>}
                    {canDelete && <button onClick={() => handleDelete(r)} title="Delete" style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4 }}><FiTrash2 /></button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Form modal */}
      {showForm && (
        <Portal>
          <div className="modal-overlay" onClick={() => setShowForm(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>{editId ? 'Edit Capital Entry' : 'New Capital Entry'}</h3>
                <button className="modal-close" onClick={() => setShowForm(false)}>×</button>
              </div>
              <div className="modal-body">
                {error && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{error}</div>}

                <div className="form-row">
                  <div className="form-group">
                    <label>Type</label>
                    <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })}>
                      <option value="Injection">Injection (money IN)</option>
                      <option value="Drawing">Drawing (money OUT)</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Date</label>
                    <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
                  </div>
                </div>

                <div className="form-group">
                  <label>Shareholder *</label>
                  <select value={form.shareholder_id} onChange={e => setForm({ ...form, shareholder_id: e.target.value })}>
                    <option value="">— Select shareholder —</option>
                    {shareholders.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {shareholders.length === 0 && (
                    <small style={{ color: '#92400e', fontSize: 11, display: 'block', marginTop: 4 }}>
                      No shareholders yet — add them on the Shareholders page first.
                    </small>
                  )}
                </div>

                {/* Method split — same UX as AP/CR/PV */}
                <div className="form-group">
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                    Amount (split across methods)
                  </label>
                  {/* 2026-09-11 — MoMo / Bank follow System Settings → Payment methods shown. */}
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${1 + ((methodShown('bank') || parseFloat(form.bank_amount || 0) > 0) ? 1 : 0) + ((methodShown('momo') || parseFloat(form.momo_amount || 0) > 0) ? 1 : 0)}, 1fr)`, gap: 10 }}>
                    {[
                      { key: 'cash_amount', label: 'Cash', color: '#16a34a' },
                      { key: 'bank_amount', label: 'Bank', color: '#2563eb' },
                      { key: 'momo_amount', label: 'MoMo', color: '#f59e0b' },
                    ].filter(f => methodShown(f.label) || parseFloat(form[f.key] || 0) > 0).map((f) => (
                      <div key={f.key}>
                        <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                        <input type="number" min="0" step="0.01"
                          value={form[f.key]}
                          onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                          placeholder="0.00"
                          style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(form[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(form[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 13, marginTop: 8 }}>
                    <span style={{ color: '#6b7280' }}>Total</span>
                    <span style={{ fontWeight: 800, color: '#1d4ed8' }}>
                      {curSym}{(parseFloat(form.cash_amount || 0) + parseFloat(form.bank_amount || 0) + parseFloat(form.momo_amount || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                <div className="form-group">
                  <label>Description</label>
                  <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Purpose / notes" />
                </div>

                <div className="form-group">
                  <label>Invoice / Proof Attachment</label>
                  <InvoiceAttachment value={form.invoice_attachment} onChange={p => setForm({ ...form, invoice_attachment: p })} kind="pv" />
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={save} disabled={saving}>
                  {saving ? 'Saving...' : editId ? 'Update Entry' : 'Save Entry'}
                </button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {/* View modal */}
      {viewEntry && (
        <Portal>
          <div className="modal-overlay" onClick={() => setViewEntry(null)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>{viewEntry.entry_number}</h3>
                <button className="modal-close" onClick={() => setViewEntry(null)}>×</button>
              </div>
              <div className="modal-body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                  <div><strong style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>Type</strong><div style={{ marginTop: 4 }}><span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, ...(TYPE_STYLE[viewEntry.type] || TYPE_STYLE.Injection), border: `1px solid ${(TYPE_STYLE[viewEntry.type] || TYPE_STYLE.Injection).border}` }}>{viewEntry.type}</span></div></div>
                  <div><strong style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>Date</strong><div style={{ marginTop: 4 }}>{formatDate(viewEntry.date)}</div></div>
                  <div><strong style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>Owner</strong><div style={{ marginTop: 4 }}>{viewEntry.owner_name || '—'}</div></div>
                  <div><strong style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>Total</strong><div style={{ marginTop: 4, fontWeight: 700, color: viewEntry.type === 'Injection' ? '#16a34a' : '#dc2626' }}>{viewEntry.type === 'Drawing' ? '−' : '+'}{curSym}{parseFloat(viewEntry.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div>
                </div>
                <div style={{ background: '#f9fafb', padding: 12, borderRadius: 8, marginBottom: 12 }}>
                  <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700, marginBottom: 6 }}>Method split</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span>Cash: <strong>{curSym}{parseFloat(viewEntry.cash_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></span>
                    <span>Bank: <strong>{curSym}{parseFloat(viewEntry.bank_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></span>
                    <span>MoMo: <strong>{curSym}{parseFloat(viewEntry.momo_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</strong></span>
                  </div>
                </div>
                {viewEntry.description && <div style={{ marginBottom: 12, padding: '10px 12px', background: '#f9fafb', borderLeft: '3px solid #9ca3af', fontSize: 13 }}>{viewEntry.description}</div>}
                <div style={{ fontSize: 11, color: '#9ca3af' }}>Created by {viewEntry.created_by_name || '—'} on {formatDate(viewEntry.created_at?.split(' ')[0])}</div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setViewEntry(null)}>Close</button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {toast && <Toast message={toast.msg} type={toast.type} onClose={() => setToast(null)} />}

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

export default CapitalAccount;
