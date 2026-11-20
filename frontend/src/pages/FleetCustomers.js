import React, { useEffect, useState } from 'react';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiTruck, FiChevronRight } from 'react-icons/fi';
import {
  getFleetCustomers, getFleetCustomer, createFleetCustomer, updateFleetCustomer, deleteFleetCustomer,
  addFleetVehicle, updateFleetVehicle, deleteFleetVehicle,
} from '../services/fuelApi';
import { S } from './fuelStyles';
import { useAuth } from '../context/AuthContext';
import FleetMergePanel from '../components/FleetMergePanel';
import { useDialog } from '../ux/ForecourtKit';   // UX-10: in-app confirm / alert
import { fmtK } from '../ux/forecourt';

const emptyCust = { name: '', company: '', phone: '', email: '', address: '', credit_limit: 0, status: 'Active' };
const emptyVeh = { registration: '', make: '', model: '', driver_name: '', driver_phone: '', status: 'Active' };

export default function FleetCustomers() {
  const { user } = useAuth();   // F3: the merge review is for Administrators
  const [rows, setRows] = useState([]);
  const [selected, setSelected] = useState(null);  // full row with vehicles
  const [custForm, setCustForm] = useState(null);
  const [vehForm, setVehForm] = useState(null);
  const [err, setErr] = useState('');
  const [dialog, ui] = useDialog();

  const load = async () => { try { setRows((await getFleetCustomers()).data || []); } catch (e) {} };
  useEffect(() => { load(); }, []);

  const openCustomer = async (r) => { try { const d = (await getFleetCustomer(r.id)).data; setSelected(d); } catch (e) {} };

  const saveCust = async (e) => {
    e.preventDefault(); setErr('');
    try {
      if (custForm.id) await updateFleetCustomer(custForm.id, custForm);
      else await createFleetCustomer(custForm);
      setCustForm(null); await load();
      if (selected) await openCustomer(selected);
    } catch (ex) { setErr(ex.response?.data?.error || 'Save failed'); }
  };

  const removeCust = async (r) => {
    if (!(await ui.confirm({ title: 'Delete fleet customer', text: `Delete fleet customer "${r.name}"?`, okLabel: 'Delete', danger: true }))) return;
    try { await deleteFleetCustomer(r.id); setSelected(null); await load(); }
    catch (ex) { await ui.alert({ title: 'Delete failed', text: ex.response?.data?.error || 'Delete failed' }); }
  };

  const saveVeh = async (e) => {
    e.preventDefault(); setErr('');
    try {
      if (vehForm.id) await updateFleetVehicle(vehForm.id, vehForm);
      else await addFleetVehicle(selected.id, vehForm);
      setVehForm(null); await openCustomer(selected);
    } catch (ex) { setErr(ex.response?.data?.error || 'Save failed'); }
  };
  const removeVeh = async (v) => {
    if (!(await ui.confirm({ title: 'Delete vehicle', text: `Delete vehicle ${v.registration}?`, okLabel: 'Delete', danger: true }))) return;
    try { await deleteFleetVehicle(v.id); await openCustomer(selected); } catch (ex) { await ui.alert({ title: 'Delete failed', text: ex.response?.data?.error || 'Delete failed' }); }
  };

  return (
    <div style={S.page} className="k-page">
      <div style={S.header} className="k-page-header">
        <h2 style={S.h2}><FiTruck /> Fleet / Credit Customers</h2>
        <button onClick={() => setCustForm({ ...emptyCust })} style={S.btnPrimary}><FiPlus /> New Customer</button>
      </div>

      {user?.role === 'Administrator' && <FleetMergePanel onDone={load} />}

      <div style={{ display: 'grid', gridTemplateColumns: selected ? '1fr 1fr' : '1fr', gap: 16 }}>
        <div style={S.card}>
          <table style={S.table}>
            <thead><tr><th style={S.th}>Name</th><th style={S.th}>Company</th><th style={{ ...S.th, textAlign: 'right' }}>Credit Limit</th><th style={{ ...S.th, textAlign: 'right' }}>Balance</th><th style={S.th}></th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} onClick={() => openCustomer(r)} style={{ borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: selected?.id === r.id ? '#eff6ff' : undefined }}>
                  <td style={S.td}><strong>{r.name}</strong></td>
                  <td style={S.td}>{r.company || '-'}</td>
                  <td style={S.tdR}>{fmtK(r.credit_limit)}</td>
                  <td style={{ ...S.tdR, color: r.current_balance > 0 ? '#dc2626' : '#0f172a' }}>{fmtK(r.current_balance)}</td>
                  <td style={S.td}><FiChevronRight /></td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={5} style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>No fleet customers yet.</td></tr>}
            </tbody>
          </table>
        </div>

        {selected && (
          <div style={S.card}>
            <div style={{ padding: 16, borderBottom: '1px solid #f1f5f9', background: '#f8fafc', display: 'flex', justifyContent: 'space-between' }}>
              <div>
                <strong style={{ fontSize: 16 }}>{selected.name}</strong>
                {selected.company && <div style={{ color: '#64748b', fontSize: 13 }}>{selected.company}</div>}
                <div style={{ fontSize: 13, marginTop: 6, color: '#334155' }}>
                  Phone: {selected.phone || '-'} &nbsp;|&nbsp; Credit: {fmtK(selected.credit_limit)} &nbsp;|&nbsp;
                  Owing: <strong style={{ color: selected.current_balance > 0 ? '#dc2626' : '#0f172a' }}>{fmtK(selected.current_balance)}</strong>
                </div>
              </div>
              <div>
                <button onClick={() => setCustForm({ ...selected })} style={S.iconBtn}><FiEdit2 /></button>
                <button onClick={() => removeCust(selected)} style={S.iconBtnDanger}><FiTrash2 /></button>
              </div>
            </div>
            <div style={{ padding: 12, borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>Vehicles</strong>
              <button onClick={() => setVehForm({ ...emptyVeh })} style={S.btnSecondary}><FiPlus /> Add Vehicle</button>
            </div>
            <table style={S.table}>
              <thead><tr><th style={S.th}>Reg</th><th style={S.th}>Make/Model</th><th style={S.th}>Driver</th><th style={S.th}></th></tr></thead>
              <tbody>
                {(selected.vehicles || []).map(v => (
                  <tr key={v.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={S.td}><strong>{v.registration}</strong></td>
                    <td style={S.td}>{[v.make, v.model].filter(Boolean).join(' ') || '-'}</td>
                    <td style={S.td}>{v.driver_name || '-'}{v.driver_phone ? ` (${v.driver_phone})` : ''}</td>
                    <td style={S.td}>
                      <button onClick={() => setVehForm(v)} style={S.iconBtn}><FiEdit2 /></button>
                      <button onClick={() => removeVeh(v)} style={S.iconBtnDanger}><FiTrash2 /></button>
                    </td>
                  </tr>
                ))}
                {(selected.vehicles || []).length === 0 && <tr><td colSpan={4} style={{ padding: 16, textAlign: 'center', color: '#64748b', fontSize: 13 }}>No vehicles</td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {custForm && (
        <div style={S.backdrop} className="k-modal-backdrop" onClick={() => setCustForm(null)}>
          <div style={S.modal} className="k-modal" onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}><h3 style={{ margin: 0 }}>{custForm.id ? 'Edit' : 'New'} Fleet Customer</h3><button onClick={() => setCustForm(null)} style={S.iconBtn}><FiX /></button></div>
            <form onSubmit={saveCust}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid} className="k-form-grid">
                <label style={S.lbl}>Name *<input value={custForm.name} onChange={e => setCustForm({ ...custForm, name: e.target.value })} required style={S.input} /></label>
                <label style={S.lbl}>Company<input value={custForm.company || ''} onChange={e => setCustForm({ ...custForm, company: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Phone<input value={custForm.phone || ''} onChange={e => setCustForm({ ...custForm, phone: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Email<input type="email" value={custForm.email || ''} onChange={e => setCustForm({ ...custForm, email: e.target.value })} style={S.input} /></label>
                <label style={{ ...S.lbl, gridColumn: '1 / -1' }}>Address<input value={custForm.address || ''} onChange={e => setCustForm({ ...custForm, address: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Credit Limit (K)<input type="number" step="0.01" value={custForm.credit_limit} onChange={e => setCustForm({ ...custForm, credit_limit: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Status
                  <select value={custForm.status} onChange={e => setCustForm({ ...custForm, status: e.target.value })} style={S.input}>
                    <option>Active</option><option>Inactive</option>
                  </select>
                </label>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setCustForm(null)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" style={S.btnPrimary}>Save</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {vehForm && (
        <div style={S.backdrop} className="k-modal-backdrop" onClick={() => setVehForm(null)}>
          <div style={S.modal} className="k-modal" onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}><h3 style={{ margin: 0 }}>{vehForm.id ? 'Edit' : 'New'} Vehicle</h3><button onClick={() => setVehForm(null)} style={S.iconBtn}><FiX /></button></div>
            <form onSubmit={saveVeh}>
              {err && <div style={S.errBox}>{err}</div>}
              <div style={S.formGrid} className="k-form-grid">
                <label style={S.lbl}>Registration *<input value={vehForm.registration} onChange={e => setVehForm({ ...vehForm, registration: e.target.value.toUpperCase() })} required style={S.input} /></label>
                <label style={S.lbl}>Make<input value={vehForm.make || ''} onChange={e => setVehForm({ ...vehForm, make: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Model<input value={vehForm.model || ''} onChange={e => setVehForm({ ...vehForm, model: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Driver<input value={vehForm.driver_name || ''} onChange={e => setVehForm({ ...vehForm, driver_name: e.target.value })} style={S.input} /></label>
                <label style={S.lbl}>Driver Phone<input value={vehForm.driver_phone || ''} onChange={e => setVehForm({ ...vehForm, driver_phone: e.target.value })} style={S.input} /></label>
              </div>
              <div style={S.modalFooter}>
                <button type="button" onClick={() => setVehForm(null)} style={S.btnSecondary}>Cancel</button>
                <button type="submit" style={S.btnPrimary}>Save</button>
              </div>
            </form>
          </div>
        </div>
      )}
      {dialog}
    </div>
  );
}
