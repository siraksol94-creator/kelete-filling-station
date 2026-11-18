// HqProducts — HQ-owned product catalogue.
//
// v1.5.0 split (per user spec on 2026-06-23):
//   HQ owns: code, name, category, base unit, packagings, default unit,
//            photo, container link, UB barcode.
//   Branch owns: cost / selling / alt price, min stock, status, opening
//                stock, notes.
// HQ creates here; every registered branch gets a copy in its own
// products table with is_hq_owned=1 (same sync_id linker). Branch
// prices are NEVER touched by HQ — every HQ edit overwrites only the
// HQ-owned fields on every branch.
import React, { useEffect, useState } from 'react';
import {
  FiRefreshCw, FiPlus, FiEdit2, FiTrash2, FiEye, FiSearch,
  FiPackage, FiAlertTriangle, FiUpload,
} from 'react-icons/fi';
import {
  getHqProducts, getHqProduct, createHqProduct, updateHqProduct,
  deleteHqProduct, pushHqProduct,
} from '../services/api';

const fmtMoney = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export default function HqProducts() {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ]             = useState('');
  const [statusFilter, setStatusFilter] = useState('Active');
  const [showForm, setShowForm] = useState(null); // null | 'new' | row
  const [viewing, setViewing] = useState(null);
  const [toast, setToast]     = useState(null);

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  const refresh = async () => {
    setLoading(true);
    try {
      const r = await getHqProducts({
        status: statusFilter || undefined,
        q: q || undefined,
      });
      setRows(r.data?.products || []);
    } catch (err) {
      flash(err?.response?.data?.error || 'Failed to load', 'error');
    }
    setLoading(false);
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [statusFilter]);

  const openView = async (id) => {
    try {
      const r = await getHqProduct(id);
      setViewing(r.data);
    } catch (err) { flash('Failed to load detail', 'error'); }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete "${row.name}"? The product will disappear from HQ + every branch, the name becomes free for re-use, and historical orders / GRNs that referenced it still render.`)) return;
    try {
      await deleteHqProduct(row.id);
      flash('Product deleted.', 'success');
      refresh();
    } catch (err) { flash(err?.response?.data?.error || 'Delete failed', 'error'); }
  };

  const repush = async (row) => {
    try {
      const r = await pushHqProduct(row.id);
      flash(`Pushed: +${r.data?.pushed || 0} created, ${r.data?.updated || 0} updated, ${r.data?.errors?.length || 0} errored.`, 'success');
    } catch (err) { flash(err?.response?.data?.error || 'Push failed', 'error'); }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>HQ Products</h1>
          <p>Master catalogue — pushed to every branch on save</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={refresh}
            style={{ padding: '8px 14px', background: '#f1f5f9', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
          <button onClick={() => setShowForm('new')}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <FiPlus /> New Product
          </button>
        </div>
      </div>

      {/* Filters */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, marginBottom: 12, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 240px' }}>
          <FiSearch size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input type="text" value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') refresh(); }}
            onBlur={refresh}
            placeholder="Search by name…"
            style={{ width: '100%', padding: '8px 10px 8px 30px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, boxSizing: 'border-box' }} />
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff' }}>
          <option value="">All status</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
        </select>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 20, zIndex: 999,
          padding: '12px 18px', borderRadius: 8, color: '#fff', fontWeight: 600,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
        }}>{toast.text}</div>
      )}

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {loading && rows.length === 0 ? (
          <p style={{ color: '#64748b' }}>Loading…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: '#94a3b8', fontStyle: 'italic' }}><FiPackage /> No products yet. Click <strong>New Product</strong> to seed the catalogue.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Code</th>
                  <th style={th}>Name</th>
                  <th style={th}>Category</th>
                  <th style={th}>Base Unit</th>
                  <th style={th}>Default Unit</th>
                  <th style={{ ...th, textAlign: 'right' }}>Packagings</th>
                  <th style={th}>Status</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  let packCount = 0;
                  try { const arr = r.units_json ? JSON.parse(r.units_json) : []; packCount = Array.isArray(arr) ? Math.max(0, arr.length - 1) : 0; } catch {}
                  return (
                    <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9', opacity: r.status === 'Inactive' ? 0.55 : 1 }}>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{r.code || '—'}</td>
                      <td style={{ ...td, fontWeight: 600 }}>{r.name}</td>
                      <td style={td}>{r.category_name || '—'}</td>
                      <td style={td}>{r.unit}</td>
                      <td style={td}>{r.default_unit || <span style={{ color: '#94a3b8' }}>—</span>}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{packCount}</td>
                      <td style={td}>{statusBadge(r.status)}</td>
                      <td style={{ ...td, whiteSpace: 'nowrap' }}>
                        <button onClick={() => openView(r.id)} style={btnIcon('#0ea5e9')}><FiEye size={12} /> View</button>
                        <button onClick={() => setShowForm(r)} style={btnIcon('#64748b')}><FiEdit2 size={12} /> Edit</button>
                        <button onClick={() => repush(r)} style={btnIcon('#16a34a')} title="Re-push to all branches"><FiUpload size={12} /></button>
                        <button onClick={() => remove(r)} style={btnIcon('#dc2626')}><FiTrash2 size={12} /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <ProductForm
          existing={showForm === 'new' ? null : showForm}
          onClose={() => setShowForm(null)}
          onSaved={(report) => {
            setShowForm(null);
            const summary = report
              ? `+${report.pushed || 0} created, ${report.updated || 0} updated${report.errors?.length ? `, ${report.errors.length} errored` : ''}`
              : '';
            flash(`Saved. ${summary}`, 'success');
            refresh();
          }}
          onError={(m) => flash(m, 'error')}
        />
      )}

      {viewing && <DetailModal data={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

function statusBadge(s) {
  const map = {
    Active:   ['#dcfce7', '#166534', 'Active'],
    Inactive: ['#fee2e2', '#991b1b', 'Inactive'],
  };
  const [bg, fg, label] = map[s] || ['#e2e8f0', '#0f172a', s];
  return <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>;
}

function ProductForm({ existing, onClose, onSaved, onError }) {
  // Parse existing units_json into [{ name, conv }] for the packagings
  // editor. Index 0 is the base unit row and stays in sync with `unit`.
  const initialPacks = (() => {
    try {
      const arr = existing?.units_json ? JSON.parse(existing.units_json) : [];
      if (!Array.isArray(arr) || arr.length === 0) return [];
      return arr.slice(1).map(u => ({ name: u.name || '', conv: u.conv ?? u.factor ?? '' }));
    } catch { return []; }
  })();

  const [form, setForm] = useState({
    code:                       existing?.code                       || '',
    name:                       existing?.name                       || '',
    category_name:              existing?.category_name              || '',
    main_category_name:         existing?.main_category_name         || '',
    unit:                       existing?.unit                       || 'pcs',
    default_unit:               existing?.default_unit               || '',
    image_url:                  existing?.image_url                  || '',
    container_product_sync_id:  existing?.container_product_sync_id  || '',
    units_per_container:        existing?.units_per_container        || '',
    ub_number_start:            existing?.ub_number_start            ?? 1,
    ub_number_length:           existing?.ub_number_length           ?? 6,
    ub_quantity_start:          existing?.ub_quantity_start          ?? 7,
    ub_quantity_length:         existing?.ub_quantity_length         ?? 0,
    ub_decimal_start:           existing?.ub_decimal_start           ?? 2,
    status:                     existing?.status                     || 'Active',
  });
  const [packagings, setPackagings] = useState(initialPacks);
  const [submitting, setSubmitting] = useState(false);
  const update = (field, v) => setForm(f => ({ ...f, [field]: v }));

  const addPack = () => setPackagings(p => [...p, { name: '', conv: '' }]);
  const setPack = (i, patch) => setPackagings(p => p.map((row, idx) => idx === i ? { ...row, ...patch } : row));
  const removePack = (i) => setPackagings(p => p.filter((_, idx) => idx !== i));

  const submit = async () => {
    if (!form.name.trim()) return onError('Name is required');
    if (!form.unit.trim())  return onError('Base unit is required');
    for (const p of packagings) {
      if (!p.name.trim())                              return onError('Packaging name cannot be empty');
      if (!p.conv || parseFloat(p.conv) <= 0)          return onError(`Conversion factor for "${p.name}" must be > 0`);
      if (p.name.trim().toLowerCase() === form.unit.trim().toLowerCase()) return onError(`Packaging name "${p.name}" duplicates the base unit`);
    }
    // Build units_json: [base, ...extras] with conv stored as factor for compatibility.
    const unitsJson = JSON.stringify([
      { name: form.unit.trim(), conv: 1, factor: 1, is_base: true },
      ...packagings.map(p => ({ name: p.name.trim(), conv: parseFloat(p.conv), factor: parseFloat(p.conv) })),
    ]);
    setSubmitting(true);
    try {
      const payload = {
        code: form.code || null,
        name: form.name.trim(),
        category_name: form.category_name || null,
        main_category_name: form.main_category_name || null,
        unit: form.unit.trim(),
        units_json: unitsJson,
        default_unit: form.default_unit || null,
        image_url: form.image_url || null,
        container_product_sync_id: form.container_product_sync_id || null,
        units_per_container: form.units_per_container || null,
        ub_number_start:    parseInt(form.ub_number_start)    || 1,
        ub_number_length:   parseInt(form.ub_number_length)   || 6,
        ub_quantity_start:  parseInt(form.ub_quantity_start)  || 7,
        ub_quantity_length: parseInt(form.ub_quantity_length) || 0,
        ub_decimal_start:   parseInt(form.ub_decimal_start)   || 2,
        status: form.status,
      };
      const res = existing
        ? await updateHqProduct(existing.id, payload)
        : await createHqProduct(payload);
      onSaved(res.data?.push);
    } catch (err) {
      onError(err?.response?.data?.error || 'Save failed');
    }
    setSubmitting(false);
  };

  const unitOptions = [form.unit, ...packagings.map(p => p.name)].filter(Boolean);

  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(720px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>{existing ? 'Edit Product' : 'New Product'}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>
        <div style={{ padding: 16, overflowY: 'auto', flex: 1, display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
            <Field label="Code"><input type="text" value={form.code} onChange={e => update('code', e.target.value)} placeholder="SKU" style={inp} /></Field>
            <Field label="Name *"><input type="text" value={form.name} onChange={e => update('name', e.target.value)} style={inp} autoFocus /></Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Category"><input type="text" value={form.category_name} onChange={e => update('category_name', e.target.value)} placeholder="e.g. Beer" style={inp} /></Field>
            <Field label="Main category"><input type="text" value={form.main_category_name} onChange={e => update('main_category_name', e.target.value)} placeholder="e.g. Beverage" style={inp} /></Field>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Base Unit *"><input type="text" value={form.unit} onChange={e => update('unit', e.target.value)} placeholder="pcs / Bottle" style={inp} /></Field>
            <Field label="Default Unit (auto-selected on GRN/SIV/POS)">
              <select value={form.default_unit} onChange={e => update('default_unit', e.target.value)} style={inp}>
                <option value="">— Use base unit ({form.unit || 'pcs'}) —</option>
                {unitOptions.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
          </div>

          {/* Packagings */}
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <strong style={{ fontSize: 13 }}>Packagings (larger units)</strong>
              <button type="button" onClick={addPack} style={{ padding: '4px 10px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>+ Add</button>
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>Base unit is <b>{form.unit || 'pcs'}</b>. Add packs/boxes that contain multiple base units (e.g. 1 Crate = 24 Bottle).</div>
            {packagings.length === 0 ? (
              <div style={{ color: '#94a3b8', fontSize: 12, fontStyle: 'italic' }}>No extra packagings yet.</div>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {packagings.map((p, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6, alignItems: 'center' }}>
                    <input type="text" value={p.name} onChange={e => setPack(i, { name: e.target.value })} placeholder="e.g. Box" style={inp} />
                    <input type="number" step="any" min="0" value={p.conv} onChange={e => setPack(i, { conv: e.target.value })} placeholder={`How many ${form.unit || 'pcs'} per ${p.name || 'pack'}`} style={inp} />
                    <button type="button" onClick={() => removePack(i)} style={{ padding: '6px 10px', background: '#fee2e2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Container link */}
          <div style={{ background: '#fefce8', border: '1px solid #fde68a', borderRadius: 8, padding: 12 }}>
            <strong style={{ fontSize: 13, color: '#92400e' }}>Returnable Container (Crate / Empties)</strong>
            <div style={{ fontSize: 11, color: '#92400e', margin: '4px 0 8px 0' }}>If this product is sold in a deposit-bearing crate, link the empty-crate product here.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
              <Field label="Container sync_id"><input type="text" value={form.container_product_sync_id} onChange={e => update('container_product_sync_id', e.target.value)} placeholder="paste empty-crate sync_id" style={inp} /></Field>
              <Field label="Units per container"><input type="number" step="any" min="0" value={form.units_per_container} onChange={e => update('units_per_container', e.target.value)} placeholder="24" style={inp} /></Field>
            </div>
          </div>

          {/* Photo */}
          <Field label="Photo URL"><input type="text" value={form.image_url} onChange={e => update('image_url', e.target.value)} placeholder="https://… (or upload via Item Details later)" style={inp} /></Field>

          {/* UB Barcode */}
          <details style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: 10 }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#0f172a' }}>Barcode (UB) settings — advanced</summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginTop: 10 }}>
              <Field label="Num. start"><input type="number" min="0" value={form.ub_number_start} onChange={e => update('ub_number_start', e.target.value)} style={inp} /></Field>
              <Field label="Num. length"><input type="number" min="0" value={form.ub_number_length} onChange={e => update('ub_number_length', e.target.value)} style={inp} /></Field>
              <Field label="Qty start"><input type="number" min="0" value={form.ub_quantity_start} onChange={e => update('ub_quantity_start', e.target.value)} style={inp} /></Field>
              <Field label="Qty length"><input type="number" min="0" value={form.ub_quantity_length} onChange={e => update('ub_quantity_length', e.target.value)} style={inp} /></Field>
              <Field label="Decimal start"><input type="number" min="0" value={form.ub_decimal_start} onChange={e => update('ub_decimal_start', e.target.value)} style={inp} /></Field>
            </div>
          </details>

          {existing && (
            <Field label="Status">
              <select value={form.status} onChange={e => update('status', e.target.value)} style={inp}>
                <option value="Active">Active</option>
                <option value="Inactive">Inactive</option>
              </select>
            </Field>
          )}

          <div style={{ padding: '10px 12px', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, fontSize: 12, color: '#1e3a8a' }}>
            <strong>HQ-owned fields only.</strong> Branches CANNOT edit these. Each branch sets its own <b>Cost / Selling / Min stock / Status / Opening stock / Notes</b>. The product stays hidden from a branch's POS until the branch sets a selling price.
          </div>
        </div>
        <div style={{ padding: 14, borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ padding: '10px 18px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
          <button onClick={submit} disabled={submitting}
            style={{ padding: '10px 22px',
                     background: submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                     color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700 }}>
            {submitting ? 'Saving…' : 'Save + Push'}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailModal({ data, onClose }) {
  const p = data.product;
  return (
    <div style={overlay}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(720px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: 0 }}>{p.name}</h3>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              {p.code ? <span style={{ fontFamily: 'monospace' }}>{p.code} · </span> : null}
              {p.category_name || 'no category'} · {p.unit}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>×</button>
        </div>
        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            <Stat label="Base Unit"       value={p.unit} />
            <Stat label="Default Unit"    value={p.default_unit || '—'} />
            <Stat label="Container"       value={p.container_product_sync_id ? `${p.units_per_container || '?'} per crate` : '—'} />
            <Stat label="Status"          value={statusBadge(p.status)} />
          </div>
          <h4 style={{ margin: '14px 0 8px 0', fontSize: 13, color: '#0f172a' }}>Per-branch snapshot (branch-owned values)</h4>
          {data.branches?.length === 0 ? (
            <p style={{ color: '#94a3b8', fontSize: 12 }}>No branches registered.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Branch</th>
                  <th style={th}>Linked</th>
                  <th style={{ ...th, textAlign: 'right' }}>Cost</th>
                  <th style={{ ...th, textAlign: 'right' }}>Selling</th>
                  <th style={{ ...th, textAlign: 'right' }}>On hand</th>
                </tr>
              </thead>
              <tbody>
                {data.branches?.map(b => (
                  <tr key={b.slug} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={td}>{b.name} <span style={{ color: '#94a3b8', fontSize: 11 }}>({b.slug})</span></td>
                    <td style={td}>
                      {b.error ? <span style={{ color: '#dc2626', fontSize: 11 }}><FiAlertTriangle size={11} /> {b.error}</span>
                               : b.found ? <span style={{ color: '#166534' }}>Yes</span>
                                          : <span style={{ color: '#94a3b8' }}>Missing</span>}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{b.found ? fmtMoney(b.cost_price) : '—'}</td>
                    <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: b.found && (b.selling_price || 0) <= 0 ? '#dc2626' : '#0f172a' }}>
                      {b.found ? (b.selling_price > 0 ? fmtMoney(b.selling_price) : '$0 (hidden from POS)') : '—'}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>{b.found ? fmtQty(b.current_stock) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}
function Stat({ label, value }) {
  return (
    <div style={{ background: '#f8fafc', border: '1px solid #f1f5f9', borderRadius: 8, padding: 10 }}>
      <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 800, color: '#0f172a', marginTop: 2 }}>{value}</div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '8px 10px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '6px 10px', color: '#0f172a' };
const btnIcon = (color) => ({
  padding: '4px 8px', background: 'transparent', color, border: `1px solid ${color}33`, borderRadius: 4,
  cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 3,
  marginRight: 4,
});
