import React, { useState, useEffect, useMemo } from 'react';
import { getSuppliers, getSupplierStats, createSupplier, updateSupplier, deleteSupplier, getSupplierStatement } from '../services/api';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiPlus, FiSearch, FiEdit2, FiTrash2, FiX, FiFileText, FiPrinter } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import ExportButtons from '../components/ExportButtons';
import printHtml from '../utils/printHtml';
import { matchTokens } from '../utils/tokenSearch';
import { useDialog } from '../ux/ForecourtKit';
import { SUPPLIES, SUPPLIES_LABEL, suppliesOf, isActive, supplierFilter, balanceWords } from '../ux/supplierRules';

// 2026-11-28 — Suppliers rebuilt (boss's list: "Supplier Screen needs fixing
// and full functional features"). One list with filters instead of cards;
// balances from the same ledger as Account Payables (GRNs + fuel deliveries
// − payments, 1Card offsets and credit notes), shown in words, never as a
// bare minus; what each supplier supplies (fuel / shop / both), TPIN, bank
// and payment terms; Active / Inactive; a printable statement per supplier.
// Confirmations and errors stay inside the app.

const emptyForm = {
  name: '', supplies: '', type: '', tpin: '', phone: '', email: '', contact_person: '', address: '',
  bank_name: '', bank_account: '', payment_terms: '', status: 'Active',
};
const TERMS = ['Cash on delivery', '7 days', '14 days', '30 days', '60 days'];
const money = (sym) => (n) => `${sym}${Math.abs(Number(n) || 0).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = (d) => {
  if (!d) return '—';
  const x = new Date(String(d).slice(0, 10) + 'T00:00:00');
  return Number.isNaN(x.getTime()) ? String(d) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

const Balance = ({ value, sym = 'K' }) => {
  const b = balanceWords(value, sym);
  return (
    <span className={`k-sup-bal is-${b.tone}`}>
      <b>{b.amount}</b>
      <small>{b.label.toLowerCase()}</small>
    </span>
  );
};

const SuppliesBadge = ({ s }) => {
  const v = suppliesOf(s);
  if (!s.supplies) return <span className="k-kind k-sold-none">Not set</span>;
  return <span className={`k-kind k-sold-${v === 'fuel' ? 'fuel' : v === 'shop' ? 'shop' : 'both'}`}>{SUPPLIES_LABEL[v]}</span>;
};

const Suppliers = () => {
  const { t } = useLanguage();
  const { hasPermission } = useAuth();
  const { symbol: curSym = 'K' } = useCurrency() || {};
  const sym = curSym || 'K';
  const k2 = money(sym);
  const [dialog, ui] = useDialog();
  const [stats, setStats] = useState({});
  const [suppliers, setSuppliers] = useState([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [stmt, setStmt] = useState(null);          // { supplier, data, from, to, loading, error }

  useModalScrollLock(showForm || !!stmt);
  const canView = hasPermission('Suppliers:View');

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchData = async () => {
    try {
      const [statsRes, suppliersRes] = await Promise.all([getSupplierStats(), getSuppliers()]);
      if (statsRes.data) setStats(statsRes.data);
      if (suppliersRes.data) setSuppliers(suppliersRes.data);
    } catch (err) { /* list stays as it was */ }
  };

  useEffect(() => {
    fetchData();
    window.addEventListener('sync-complete', fetchData);
    return () => window.removeEventListener('sync-complete', fetchData);
  }, []);

  const counts = useMemo(() => ({
    all: supplierFilter(suppliers, 'all').length,
    fuel: supplierFilter(suppliers, 'fuel').length,
    shop: supplierFilter(suppliers, 'shop').length,
    owe: supplierFilter(suppliers, 'owe').length,
    inactive: supplierFilter(suppliers, 'inactive').length,
  }), [suppliers]);

  const filtered = useMemo(() => supplierFilter(suppliers, filter)
    .filter((s) => matchTokens(search, s.name, s.phone, s.email, s.address, s.tpin, s.contact_person, s.type))
    .sort((a, b) => (Number(b.outstanding) || 0) - (Number(a.outstanding) || 0) || String(a.name).localeCompare(String(b.name))),
  [suppliers, filter, search]);

  const openAdd = () => { setEditingId(null); setForm(emptyForm); setError(''); setShowForm(true); };
  const openEdit = (s) => {
    setEditingId(s.id);
    const f = {};
    for (const k of Object.keys(emptyForm)) f[k] = s[k] == null ? '' : String(s[k]);
    f.status = isActive(s) ? 'Active' : 'Inactive';
    setForm(f); setError(''); setShowForm(true);
  };

  const handleSave = async () => {
    setError('');
    if (!form.name.trim()) return setError('Give the supplier a name.');
    if (!form.supplies) return setError('Pick what this supplier supplies: fuel, shop goods or both.');
    if (form.tpin.trim() && !/^\d{10}$/.test(form.tpin.trim())) return setError('A TPIN is 10 digits.');
    setSaving(true);
    try {
      if (editingId) await updateSupplier(editingId, form);
      else await createSupplier(form);
      setShowForm(false);
      await fetchData();
      showToast(editingId ? 'Supplier updated.' : 'Supplier added.');
    } catch (err) {
      setError(err.response?.data?.error || 'The supplier could not be saved. Check the connection and try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (s) => {
    setPendingDelete({
      subject: `Supplier: ${s.name}`,
      perform: async () => {
        try { await deleteSupplier(s.id); await fetchData(); showToast('Supplier deleted.', 'error'); }
        catch (err) { await ui.alert({ title: 'Not deleted', text: err.response?.data?.error || 'The supplier could not be deleted.' }); }
      },
    });
  };
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };

  const toggleActive = async (s) => {
    const going = isActive(s) ? 'Inactive' : 'Active';
    const ok = await ui.confirm({
      title: going === 'Inactive' ? `Mark ${s.name} inactive?` : `Make ${s.name} active again?`,
      text: going === 'Inactive'
        ? 'It stays in reports and statements, but is no longer offered when recording 1Card tickets or fuel deliveries.'
        : 'It will be offered again when recording purchases.',
      okLabel: going === 'Inactive' ? 'Mark inactive' : 'Make active',
    });
    if (!ok) return;
    try { await updateSupplier(s.id, { status: going }); await fetchData(); showToast(`${s.name} is now ${going.toLowerCase()}.`); }
    catch (err) { await ui.alert({ title: 'Not changed', text: err.response?.data?.error || 'The supplier could not be changed.' }); }
  };

  const loadStatement = async (supplier, from = '', to = '') => {
    setStmt({ supplier, from, to, loading: true, data: null, error: '' });
    try {
      const r = await getSupplierStatement(supplier.id, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
      setStmt({ supplier, from, to, loading: false, data: r.data, error: '' });
    } catch (err) {
      setStmt({ supplier, from, to, loading: false, data: null, error: err.response?.data?.error || 'The statement could not be loaded.' });
    }
  };

  const printStatement = () => {
    const d = stmt?.data; if (!d) return;
    const b = balanceWords(d.closing, sym);
    const rows = d.lines.map((l) => `<tr><td>${esc(fmtDate(l.date))}</td><td>${esc(l.ref || '')}</td><td>${esc(l.what)}</td>
      <td class="r">${l.owed ? esc(k2(l.owed)) : ''}</td><td class="r">${l.paid ? esc(k2(l.paid)) : ''}</td><td class="r">${esc(k2(l.balance))}${l.balance < 0 ? ' cr' : ''}</td></tr>`).join('');
    printHtml(`<html><head><title>Statement · ${esc(d.supplier.name)}</title><style>
      body{font:12px/1.45 Arial,sans-serif;color:#0f172a;margin:24px} h1{font-size:18px;margin:0}
      table{width:100%;border-collapse:collapse;margin-top:12px} th,td{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:left}
      th{font-size:11px;color:#475569;text-transform:uppercase} .r{text-align:right;white-space:nowrap} .tot td{font-weight:700;border-top:2px solid #0f172a}
    </style></head><body>
      <h1>Supplier statement · ${esc(d.supplier.name)}</h1>
      <div>${d.supplier.tpin ? `TPIN ${esc(d.supplier.tpin)} · ` : ''}${d.supplier.payment_terms ? `Terms: ${esc(d.supplier.payment_terms)} · ` : ''}${d.from || d.to ? `${esc(d.from ? fmtDate(d.from) : 'start')} to ${esc(d.to ? fmtDate(d.to) : 'today')}` : 'All dates'}</div>
      <table><thead><tr><th>Date</th><th>Ref</th><th>What</th><th class="r">Owed</th><th class="r">Paid / credit</th><th class="r">Balance</th></tr></thead><tbody>
      ${d.from ? `<tr><td></td><td></td><td>Opening balance</td><td></td><td></td><td class="r">${esc(k2(d.opening))}${d.opening < 0 ? ' cr' : ''}</td></tr>` : ''}
      ${rows}
      <tr class="tot"><td></td><td></td><td>${esc(b.label)}</td><td class="r">${esc(k2(d.owed))}</td><td class="r">${esc(k2(d.paid))}</td><td class="r">${esc(b.amount)}</td></tr>
      </tbody></table></body></html>`);
  };

  const set = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));
  const chips = [
    ['all', 'All'], ['fuel', 'Fuel'], ['shop', 'Shop'], ['owe', 'We owe money'], ['inactive', 'Inactive'],
  ];

  return (
    <div className="page-content k-sup">
      <div className="page-header">
        <div>
          <h1>{t('suppliersTitle')}</h1>
          <p>Who we buy from, what we owe them, and their statements</p>
        </div>
        {hasPermission('Suppliers:Add') && (
          <button className="btn btn-primary" onClick={openAdd}><FiPlus /> {t('addSupplier')}</button>
        )}
      </div>

      {canView && (
        <section className="k-sup-kpis" aria-label="Supplier totals">
          <div className="k-sup-kpi"><span>Suppliers</span><strong>{counts.all}</strong><em>{counts.fuel} fuel · {counts.shop} shop{counts.inactive ? ` · ${counts.inactive} inactive` : ''}</em></div>
          <div className="k-sup-kpi is-owe"><span>We owe</span><strong>{k2(stats.owed)}</strong><em>to {counts.owe} supplier{counts.owe === 1 ? '' : 's'}</em></div>
          <div className="k-sup-kpi"><span>In credit (paid ahead)</span><strong>{k2(stats.inCredit)}</strong><em>suppliers holding our money</em></div>
        </section>
      )}

      <div className="k-sup-tools">
        <div className="k-sup-chips" role="group" aria-label="Show">
          {chips.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
              {label} <b>{counts[k]}</b>
            </button>
          ))}
        </div>
        <div className="search-input-container" style={{ margin: 0, flex: '1 1 240px' }}>
          <FiSearch style={{ color: '#64748b' }} />
          <input type="text" placeholder="Search name, phone, TPIN, contact…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {canView && (
          <ExportButtons
            rows={filtered}
            filename="suppliers"
            sheetName="Suppliers"
            columns={[
              { key: 'name', label: 'Supplier' },
              { key: 'supplies', label: 'Supplies', format: (v, r) => SUPPLIES_LABEL[suppliesOf(r)] },
              { key: 'tpin', label: 'TPIN' },
              { key: 'phone', label: 'Phone' },
              { key: 'payment_terms', label: 'Terms' },
              { key: 'total_purchases', label: 'Bought', format: (v) => Number(v || 0).toFixed(2) },
              { key: 'outstanding', label: 'Balance (we owe; negative = in credit)', format: (v) => Number(v || 0).toFixed(2) },
              { key: 'status', label: 'Status' },
            ]}
          />
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="k-sup-empty">
          {search ? t('noSuppliersMatch') : filter === 'owe' ? 'We owe nobody money right now.' : filter === 'inactive' ? 'No inactive suppliers.' : t('noSuppliersYet')}
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table k-sup-table">
            <thead>
              <tr>
                <th>Supplier</th><th>Supplies</th><th>TPIN · terms</th>
                <th className="r">Bought</th><th className="r">Balance</th><th>Last purchase</th><th className="r">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id} className={isActive(s) ? '' : 'is-inactive'}>
                  <td>
                    <b>{s.name}</b>{!isActive(s) && <span className="k-sup-off">Inactive</span>}
                    <div className="k-sup-sub">{[s.contact_person, s.phone, s.address].filter(Boolean).join(' · ') || '—'}</div>
                  </td>
                  <td><SuppliesBadge s={s} /></td>
                  <td className="k-sup-sub">{s.tpin || '—'}{s.payment_terms ? ` · ${s.payment_terms}` : ''}</td>
                  <td className="r k-num">{canView ? k2(s.total_purchases) : '—'}</td>
                  <td className="r">{canView ? <Balance sym={sym} value={s.outstanding} /> : '—'}</td>
                  <td className="k-sup-sub">{fmtDate(s.last_purchase_date)}</td>
                  <td className="r">
                    <div className="k-sup-actions">
                      {canView && <button type="button" onClick={() => loadStatement(s)} title="Statement" aria-label={`Statement for ${s.name}`}><FiFileText /> Statement</button>}
                      {hasPermission('Suppliers:Edit') && <button type="button" onClick={() => openEdit(s)} title="Edit" aria-label={`Edit ${s.name}`}><FiEdit2 /></button>}
                      {hasPermission('Suppliers:Edit') && <button type="button" onClick={() => toggleActive(s)} className="txt">{isActive(s) ? 'Deactivate' : 'Activate'}</button>}
                      {hasPermission('Suppliers:Delete') && <button type="button" className="del" onClick={() => handleDelete(s)} title="Delete" aria-label={`Delete ${s.name}`}><FiTrash2 /></button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <Portal>
          <div className="k-sup-overlay" role="dialog" aria-modal="true" aria-labelledby="sup-form-title">
            <div className="k-sup-modal">
              <div className="k-sup-modal-head">
                <div>
                  <h3 id="sup-form-title">{editingId ? 'Edit supplier' : 'New supplier'}</h3>
                  <p>Fields marked * are required</p>
                </div>
                <button type="button" onClick={() => setShowForm(false)} aria-label="Close"><FiX size={20} /></button>
              </div>
              <div className="k-sup-modal-body">
                <div className="k-sup-grid">
                  <label className="span2">Name *<input type="text" placeholder="e.g. Engen Zambia" value={form.name} onChange={set('name')} autoFocus /></label>
                  <fieldset className="span2">
                    <legend>Supplies *</legend>
                    <div className="k-sup-seg" role="radiogroup">
                      {SUPPLIES.map((v) => (
                        <label key={v} className={form.supplies === v ? `on is-${v}` : ''}>
                          <input type="radio" name="sup-supplies" value={v} checked={form.supplies === v} onChange={set('supplies')} />
                          {v === 'fuel' ? 'Fuel' : v === 'shop' ? 'Shop goods' : 'Both'}
                        </label>
                      ))}
                    </div>
                    <small>Fuel suppliers are the ones offered for 1Card tickets and fuel deliveries.</small>
                  </fieldset>
                  <label>TPIN<input type="text" inputMode="numeric" maxLength={10} placeholder="10 digits" value={form.tpin} onChange={set('tpin')} /></label>
                  <label>Kind of goods<input type="text" placeholder="e.g. Bakery, Lubricants" value={form.type} onChange={set('type')} /></label>
                  <label>Phone<input type="tel" placeholder="+260 97 …" value={form.phone} onChange={set('phone')} /></label>
                  <label>Email<input type="email" placeholder="accounts@supplier.co.zm" value={form.email} onChange={set('email')} /></label>
                  <label>Contact person<input type="text" value={form.contact_person} onChange={set('contact_person')} /></label>
                  <label>Address<input type="text" placeholder="Street, town" value={form.address} onChange={set('address')} /></label>
                  <label>Bank<input type="text" placeholder="e.g. Zanaco, Cairo Road" value={form.bank_name} onChange={set('bank_name')} /></label>
                  <label>Account number<input type="text" value={form.bank_account} onChange={set('bank_account')} /></label>
                  <label>Payment terms
                    <input type="text" list="sup-terms" placeholder="e.g. 30 days" value={form.payment_terms} onChange={set('payment_terms')} />
                    <datalist id="sup-terms">{TERMS.map((x) => <option key={x} value={x} />)}</datalist>
                  </label>
                  {editingId && (
                    <label>Status
                      <select value={form.status} onChange={set('status')}>
                        <option value="Active">Active</option>
                        <option value="Inactive">Inactive</option>
                      </select>
                    </label>
                  )}
                </div>
                {error && <div className="k-sup-error" role="alert">{error}</div>}
                <div className="k-sup-modal-foot">
                  <button type="button" className="btn" onClick={() => setShowForm(false)}>{t('cancel')}</button>
                  <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
                    {saving ? t('saving') : editingId ? 'Save changes' : 'Add supplier'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {stmt && (
        <Portal>
          <div className="k-sup-overlay" role="dialog" aria-modal="true" aria-labelledby="sup-stmt-title">
            <div className="k-sup-modal wide">
              <div className="k-sup-modal-head">
                <div>
                  <h3 id="sup-stmt-title">Statement · {stmt.supplier.name}</h3>
                  <p>{[stmt.supplier.tpin && `TPIN ${stmt.supplier.tpin}`, stmt.supplier.payment_terms && `Terms: ${stmt.supplier.payment_terms}`].filter(Boolean).join(' · ') || 'GRNs, fuel deliveries, payments, 1Card offsets and credit notes'}</p>
                </div>
                <button type="button" onClick={() => setStmt(null)} aria-label="Close"><FiX size={20} /></button>
              </div>
              <div className="k-sup-modal-body">
                <div className="k-sup-stmt-tools">
                  <label>From<input type="date" value={stmt.from} onChange={(e) => loadStatement(stmt.supplier, e.target.value, stmt.to)} /></label>
                  <label>To<input type="date" value={stmt.to} onChange={(e) => loadStatement(stmt.supplier, stmt.from, e.target.value)} /></label>
                  {(stmt.from || stmt.to) && <button type="button" className="btn" onClick={() => loadStatement(stmt.supplier)}>All dates</button>}
                  <button type="button" className="btn btn-primary" onClick={printStatement} disabled={!stmt.data}><FiPrinter /> Print</button>
                </div>
                {stmt.loading && <div className="k-sup-empty">Loading…</div>}
                {stmt.error && <div className="k-sup-error" role="alert">{stmt.error}</div>}
                {stmt.data && (
                  <div className="table-container">
                    <table className="data-table k-sup-table">
                      <thead><tr><th>Date</th><th>Ref</th><th>What</th><th className="r">Owed</th><th className="r">Paid / credit</th><th className="r">Balance</th></tr></thead>
                      <tbody>
                        {stmt.data.from && (
                          <tr><td /><td /><td><i>Opening balance</i></td><td /><td /><td className="r"><Balance sym={sym} value={stmt.data.opening} /></td></tr>
                        )}
                        {stmt.data.lines.length === 0 && <tr><td colSpan={6} className="k-sup-empty">Nothing in these dates.</td></tr>}
                        {stmt.data.lines.map((l, i) => (
                          <tr key={i} className={`is-${l.kind}`}>
                            <td className="k-sup-sub">{fmtDate(l.date)}</td>
                            <td className="k-num">{l.ref || '—'}</td>
                            <td>{l.kind === 'offset' && <span className="k-kind k-kind-fuel" style={{ marginRight: 6 }}>1Card</span>}{l.what}</td>
                            <td className="r k-num">{l.owed ? k2(l.owed) : ''}</td>
                            <td className="r k-num">{l.paid ? k2(l.paid) : ''}</td>
                            <td className="r"><Balance sym={sym} value={l.balance} /></td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr><td /><td /><td><b>Total in these dates</b></td><td className="r k-num"><b>{k2(stmt.data.owed)}</b></td><td className="r k-num"><b>{k2(stmt.data.paid)}</b></td><td className="r"><Balance sym={sym} value={stmt.data.closing} /></td></tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Portal>
      )}

      <Toast message={toast?.msg} type={toast?.type} onClose={() => setToast(null)} />
      {dialog}
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

export default Suppliers;
