import React, { useEffect, useState } from 'react';
import { FiPlus, FiTrash2, FiX, FiDownloadCloud } from 'react-icons/fi';
import { getFuelDeliveries, createFuelDelivery, deleteFuelDelivery, getTanks } from '../services/fuelApi';
import { getSuppliers } from '../services/api';
import { S } from './fuelStyles';

const emptyForm = {
  supplier_id: '', tank_id: '', delivery_date: new Date().toISOString().slice(0, 10),
  litres_ordered: '', litres_delivered: '', dip_before: '', dip_after: '',
  cost_per_litre: '', invoice_number: '', notes: ''
};

export default function FuelDeliveries() {
  const [rows, setRows] = useState([]);
  const [tanks, setTanks] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState('');

  const load = async () => {
    try {
      const [d, t, s] = await Promise.all([getFuelDeliveries(), getTanks(), getSuppliers()]);
      setRows(d.data || []); setTanks(t.data || []); setSuppliers(s.data || []);
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault(); setErr('');
    try {
      await createFuelDelivery({
        ...form,
        supplier_id: form.supplier_id || null,
      });
      setForm(null); await load();
    } catch (ex) { setErr(ex.response?.data?.error || 'Save failed'); }
  };

  const remove = async (r) => {
    if (!window.confirm(`Delete delivery ${r.delivery_number}? Tank volume will be reversed.`)) return;
    try { await deleteFuelDelivery(r.id); await load(); }
    catch (ex) { alert(ex.response?.data?.error || 'Delete failed'); }
  };

  const total = form ? (Number(form.litres_delivered || 0) * Number(form.cost_per_litre || 0)) : 0;

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h2 style={S.h2}><FiDownloadCloud /> Fuel Deliveries (GRN)</h2>
        <button onClick={() => setForm({ ...emptyForm })} style={S.btnPrimary}><FiPlus /> Record Delivery</button>
      </div>

      <div style={S.card}>
        <table style={S.table}>
          <thead><tr>
            <th style={S.th}>Date</th><th style={S.th}>#</th><th style={S.th}>Supplier</th>
            <th style={S.th}>Tank</th><th style={S.th}>Grade</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Litres</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Cost/L</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Total</th>
            <th style={S.th}></th>
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <td style={S.td}>{r.delivery_date}</td>
                <td style={S.td}><strong>{r.delivery_number}</strong></td>
                <td style={S.td}>{r.supplier_name || '-'}</td>
                <td style={S.td}>{r.tank_code}</td>
                <td style={S.td}>{r.grade_name}</td>
                <td style={S.tdR}>{Number(r.litres_delivered).toFixed(2)}</td>
                <td style={S.tdR}>K {Number(r.cost_per_litre).toFixed(4)}</td>
                <td style={S.tdR}><strong>K {Number(r.total_cost).toFixed(2)}</strong></td>
                <td style={S.td}><button onClick={() => remove(r)} style={S.iconBtnDanger}><FiTrash2 /></button></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No deliveries yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {form && (
        <div style={S.backdrop} onClick={() => setForm(null)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}><h3 style={{ margin: 0 }}>New Fuel Delivery</h3><button onClick={() => setForm(null)} style={S.iconBtn}><FiX /></button></div>
            <form onSubmit={save}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid}>
                <label style={S.lbl}>Date *<input type="date" value={form.delivery_date} onChange={e => setForm({ ...form, delivery_date: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Supplier
                  <select value={form.supplier_id} onChange={e => setForm({ ...form, supplier_id: e.target.value })} style={S.input}>
                    <option value="">-- none --</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </label>
                <label style={S.lbl}>Tank *
                  <select value={form.tank_id} onChange={e => setForm({ ...form, tank_id: e.target.value })} required style={S.input}>
                    <option value="">-- select --</option>
                    {tanks.map(t => <option key={t.id} value={t.id}>{t.code} - {t.grade_name}</option>)}
                  </select>
                </label>
                <label style={S.lbl}>Invoice #<input value={form.invoice_number} onChange={e => setForm({ ...form, invoice_number: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Litres Ordered<input type="number" step="0.01" value={form.litres_ordered} onChange={e => setForm({ ...form, litres_ordered: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Litres Delivered *<input type="number" step="0.01" value={form.litres_delivered} onChange={e => setForm({ ...form, litres_delivered: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Dip Before (L)<input type="number" step="0.01" value={form.dip_before} onChange={e => setForm({ ...form, dip_before: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Dip After (L)<input type="number" step="0.01" value={form.dip_after} onChange={e => setForm({ ...form, dip_after: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Cost / Litre *<input type="number" step="0.0001" value={form.cost_per_litre} onChange={e => setForm({ ...form, cost_per_litre: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Total<input value={`K ${total.toFixed(2)}`} readOnly style={{ ...S.input, background: '#f3f4f6', fontWeight: 700 }} /></label>
                <label style={{ ...S.lbl, gridColumn: '1 / -1' }}>Notes<input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={S.input} /></label>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setForm(null)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" style={S.btnPrimary}>Save Delivery</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
