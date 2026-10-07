import React, { useEffect, useMemo, useState } from 'react';
import { FiDollarSign, FiTruck, FiSmartphone, FiCreditCard, FiCheck, FiX } from 'react-icons/fi';
import { getNozzles, getFleetCustomers, getFleetCustomer, createFuelSale, getFuelSales, getCurrentShift } from '../services/fuelApi';
import { S } from './fuelStyles';

const PAYMENT_METHODS = [
  { key: 'Cash',   label: 'Cash',   icon: <FiDollarSign /> },
  { key: 'Mobile', label: 'Mobile', icon: <FiSmartphone /> },
  { key: 'Card',   label: 'Card',   icon: <FiCreditCard /> },
  { key: 'Fleet',  label: 'Fleet',  icon: <FiTruck /> },
];

export default function FuelPOS() {
  const [nozzles, setNozzles] = useState([]);
  const [fleet, setFleet] = useState([]);
  const [recent, setRecent] = useState([]);
  const [shift, setShift] = useState(null);
  const [nozzleId, setNozzleId] = useState('');
  const [mode, setMode] = useState('litres');   // 'litres' | 'amount'
  const [litres, setLitres] = useState('');
  const [amount, setAmount] = useState('');
  const [payment, setPayment] = useState('Cash');
  const [fleetCustomerId, setFleetCustomerId] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [vehicles, setVehicles] = useState([]);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const load = async () => {
    try {
      const [n, fl, r, cs] = await Promise.all([getNozzles(), getFleetCustomers(), getFuelSales({}), getCurrentShift()]);
      setNozzles(n.data || []); setFleet(fl.data || []); setRecent((r.data || []).slice(0, 15)); setShift(cs.data || null);
    } catch (e) {}
  };
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (fleetCustomerId) getFleetCustomer(fleetCustomerId).then(d => setVehicles(d.data.vehicles || [])).catch(() => setVehicles([]));
    else { setVehicles([]); setVehicleId(''); }
  }, [fleetCustomerId]);

  const selectedNoz = useMemo(() => nozzles.find(n => n.id === Number(nozzleId)), [nozzles, nozzleId]);
  const ppl = selectedNoz ? Number(selectedNoz.price_per_litre || 0) : 0;

  const effLitres = useMemo(() => {
    if (mode === 'amount') return ppl > 0 ? Number(amount || 0) / ppl : 0;
    return Number(litres || 0);
  }, [mode, litres, amount, ppl]);

  const effAmount = useMemo(() => effLitres * ppl, [effLitres, ppl]);

  const submit = async (e) => {
    e.preventDefault(); setErr(''); setSaving(true);
    try {
      if (!selectedNoz) throw new Error('Pick a nozzle');
      if (!(effLitres > 0)) throw new Error('Enter litres or amount');
      if (payment === 'Fleet' && !fleetCustomerId) throw new Error('Pick a fleet customer');
      await createFuelSale({
        shift_id: shift?.id || null,
        nozzle_id: selectedNoz.id,
        litres: effLitres,
        price_per_litre: ppl,
        payment_method: payment,
        fleet_customer_id: payment === 'Fleet' ? Number(fleetCustomerId) : null,
        fleet_vehicle_id: payment === 'Fleet' && vehicleId ? Number(vehicleId) : null,
      });
      setToast(`Sold ${effLitres.toFixed(2)} L for K ${effAmount.toFixed(2)}`);
      setTimeout(() => setToast(''), 2500);
      setLitres(''); setAmount(''); setFleetCustomerId(''); setVehicleId('');
      await load();
    } catch (ex) {
      setErr(ex.response?.data?.error || ex.message || 'Sale failed');
    } finally { setSaving(false); }
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h2 style={S.h2}><FiDollarSign /> Fuel POS</h2>
        <div style={{ fontSize: 13, color: '#6b7280' }}>
          {shift ? <>Active shift: <strong>{shift.attendant_name}</strong></> : <span style={{ color: '#dc2626' }}>No active shift</span>}
        </div>
      </div>

      {toast && <div style={{ padding: 12, background: '#dcfce7', border: '1px solid #86efac', borderRadius: 8, color: '#166534', marginBottom: 16 }}><FiCheck /> {toast}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={S.card}>
          <div style={{ padding: 16, borderBottom: '1px solid #f3f4f6', background: '#f9fafb' }}><strong>New Fuel Sale</strong></div>
          <form onSubmit={submit} style={{ padding: 20 }}>
            {err && <div style={{ ...S.errBox, margin: 0, marginBottom: 16 }}>{err}</div>}

            <label style={S.lbl}>Nozzle *
              <select value={nozzleId} onChange={e => setNozzleId(e.target.value)} required style={{ ...S.input, fontSize: 15 }}>
                <option value="">-- pick a nozzle --</option>
                {nozzles.map(n => (
                  <option key={n.id} value={n.id}>{n.pump_code}-{n.code} ({n.grade_name}) @ K {Number(n.price_per_litre || 0).toFixed(2)}/L</option>
                ))}
              </select>
            </label>

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button type="button" onClick={() => setMode('litres')} style={{ ...(mode === 'litres' ? S.btnPrimary : S.btnSecondary), flex: 1 }}>By Litres</button>
              <button type="button" onClick={() => setMode('amount')} style={{ ...(mode === 'amount' ? S.btnPrimary : S.btnSecondary), flex: 1 }}>By Amount</button>
            </div>

            {mode === 'litres' ? (
              <label style={{ ...S.lbl, marginTop: 12 }}>Litres
                <input type="number" step="0.01" value={litres} onChange={e => setLitres(e.target.value)} placeholder="0.00" style={{ ...S.input, fontSize: 24, fontWeight: 700, padding: 14 }} />
              </label>
            ) : (
              <label style={{ ...S.lbl, marginTop: 12 }}>Amount (K)
                <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" style={{ ...S.input, fontSize: 24, fontWeight: 700, padding: 14 }} />
              </label>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginTop: 16 }}>
              {PAYMENT_METHODS.map(pm => (
                <button key={pm.key} type="button" onClick={() => setPayment(pm.key)} style={{
                  padding: 12, border: 0, borderRadius: 8, cursor: 'pointer', fontWeight: 500,
                  background: payment === pm.key ? '#2563eb' : '#f3f4f6',
                  color: payment === pm.key ? '#fff' : '#111',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                }}>{pm.icon}<span style={{ fontSize: 12 }}>{pm.label}</span></button>
              ))}
            </div>

            {payment === 'Fleet' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
                <label style={S.lbl}>Fleet Customer *
                  <select value={fleetCustomerId} onChange={e => setFleetCustomerId(e.target.value)} required style={S.input}>
                    <option value="">-- select --</option>
                    {fleet.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                </label>
                <label style={S.lbl}>Vehicle
                  <select value={vehicleId} onChange={e => setVehicleId(e.target.value)} style={S.input} disabled={!vehicles.length}>
                    <option value="">-- any --</option>
                    {vehicles.map(v => <option key={v.id} value={v.id}>{v.registration}</option>)}
                  </select>
                </label>
              </div>
            )}

            <div style={{ marginTop: 20, padding: 16, background: '#f9fafb', borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ color: '#6b7280' }}>
                {effLitres.toFixed(2)} L @ K {ppl.toFixed(2)}/L
              </div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>K {effAmount.toFixed(2)}</div>
            </div>

            <button type="submit" disabled={saving || !selectedNoz || !(effLitres > 0)} style={{ ...S.btnPrimary, width: '100%', marginTop: 16, fontSize: 16, padding: 14, justifyContent: 'center' }}>
              {saving ? 'Processing...' : <>Confirm Sale <FiCheck /></>}
            </button>
          </form>
        </div>

        <div style={S.card}>
          <div style={{ padding: 16, borderBottom: '1px solid #f3f4f6', background: '#f9fafb' }}><strong>Recent Sales</strong></div>
          <table style={S.table}>
            <thead><tr>
              <th style={S.th}>#</th><th style={S.th}>Nozzle</th><th style={S.th}>Grade</th>
              <th style={{ ...S.th, textAlign: 'right' }}>L</th>
              <th style={{ ...S.th, textAlign: 'right' }}>K</th>
              <th style={S.th}>Pay</th>
            </tr></thead>
            <tbody>
              {recent.map(s => (
                <tr key={s.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <td style={{ ...S.td, fontSize: 12, color: '#6b7280' }}>{s.sale_number}</td>
                  <td style={S.td}>{s.pump_code}-{s.nozzle_code}</td>
                  <td style={S.td}><span style={S.pill(s.grade_color || '#6b7280')}>{s.grade_name}</span></td>
                  <td style={S.tdR}>{Number(s.litres).toFixed(2)}</td>
                  <td style={S.tdR}><strong>K {Number(s.total).toFixed(2)}</strong></td>
                  <td style={S.td}>{s.payment_method}</td>
                </tr>
              ))}
              {recent.length === 0 && <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#6b7280' }}>No sales yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
