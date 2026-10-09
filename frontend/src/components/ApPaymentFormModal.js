// ApPaymentFormModal — shared "Record Payment" modal for supplier
// (Account Payable) payments. Used by Account Payables and the GRN page
// so both produce identical ap_payment rows (split + attachment).
//
// Same pattern as PaymentVoucherFormModal — encapsulates its own form
// state, error handling, and API call; parents pass a supplier context
// and an onSaved callback.
import React, { useEffect, useState } from 'react';
import Portal from '../utils/Portal';
import { FiX } from 'react-icons/fi';
import InvoiceAttachment from './InvoiceAttachment';
import { createApPayment, isHqHost } from '../services/api';
import { useCurrency } from '../context/CurrencyContext';

const todayStr = () => new Date().toISOString().split('T')[0];

// v1.10.78 — form state carries BOTH shapes. HQ uses usd/fra/k (like PV);
// Liquor branches use cash/bank/momo. Only the active set gets values
// filled in; the other set stays blank and is dropped from the payload.
const emptyForm = {
  cash_amount: '', bank_amount: '', momo_amount: '',
  usd_amount:  '', fra_amount:  '', k_amount:    '',
  date: todayStr(),
  description: '',
  invoice_attachment: null,
};

export default function ApPaymentFormModal({ open, supplier, onClose, onSaved, defaultDate, defaultDescription }) {
  const { symbol: curSym, isLiquorStyle: rawLiquorStyle } = useCurrency();
  // v1.10.78 — HQ (bare host) renders the PV-style USD / FRA / K fields
  // regardless of tenant settings. Matches CashReceipt.js v1.10.68 +
  // PaymentVoucherFormModal.js pattern.
  const onHq = isHqHost();
  // v1.13.46 — Kelete HQ is K-only (no tri-currency branches), so drop
  // the Kelete-era `&& !onHq` override that forced USD / FRA / K fields
  // on the HQ host. Business settings drive isLiquorStyle correctly.
  const isLiquorStyle = rawLiquorStyle;
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  // v1.10.111 — supplier balances can be in USD, K, or FRA (each supplier
  // has its own native currency, returned per-row by the backend as
  // supplier.currency — see AccountPayables.js:496 for the same mapping).
  // Use it for BOTH the outstanding-balance display AND the total row,
  // instead of the tenant-wide curSym which gave FLAMINGO's K13,110
  // outstanding an incorrect "$" prefix.
  const supplierCcy = String(supplier?.currency || '').toUpperCase();
  const supplierSym = supplierCcy === 'K'   ? 'K'
                    : supplierCcy === 'FRA' ? ''
                    : supplierCcy === 'USD' ? '$'
                    : curSym;

  // Reset the form whenever the modal is (re)opened for a new supplier.
  useEffect(() => {
    if (!open || !supplier) return;
    const outstanding = parseFloat(supplier.balance) > 0 ? parseFloat(supplier.balance).toFixed(2) : '';
    // v1.10.111 — auto-fill the box matching the supplier's native
    // currency (K → k_amount, FRA → fra_amount, else usd_amount).
    // Cashier no longer has to move the value from USD to K by hand.
    setForm({
      // Pre-fill Cash — the commonest drawer. The cashier moves it to Bank or
      // Mobile Money if that is where the money actually went. The old
      // per-currency pre-fill is gone with the currency fields.
      cash_amount: outstanding,
      bank_amount: '',
      momo_amount: '',
      usd_amount:  '',
      fra_amount:  '',
      k_amount:    '',
      date: defaultDate || todayStr(),
      description: defaultDescription || `Payment to ${supplier.supplier_name || ''}`.trim(),
      invoice_attachment: null,
    });
    setError('');
    setSaving(false);
  }, [open, supplier, defaultDate, defaultDescription, onHq]);

  if (!open || !supplier) return null;

  // 2026-08-29 — the drawers, everywhere, HQ included.
  //
  // HQ used to be offered USD / FRA / K. Red Sea trades in Kwacha only, so two
  // of those could never be used and the third told us nothing about where the
  // money actually came from. Meanwhile the AP Approvals screen DID ask (Paid
  // From: Cash / Bank / MoMo), so the same payment was recorded two different
  // ways depending on which screen you started from — and the Cash Book, which
  // adds the three tiles together, counted such a payment twice.
  //
  // One question, one shape: which drawer did the money leave?
  const fields = [
    { key: 'cash_amount', label: 'Cash',         color: '#16a34a', step: '0.01', placeholder: '0.00' },
    { key: 'bank_amount', label: 'Bank',         color: '#2563eb', step: '0.01', placeholder: '0.00' },
    { key: 'momo_amount', label: 'Mobile Money', color: '#f59e0b', step: '0.01', placeholder: '0.00' },
  ];

  const total = fields.reduce((s, f) => s + (parseFloat(form[f.key] || 0) || 0), 0);

  const handlePay = async () => {
    if (!(total > 0)) { setError('Enter at least one method > 0.'); return; }
    if (!form.date) { setError('Select a date.'); return; }
    setSaving(true);
    try {
      const payload = {
        supplier_id: supplier.id,
        supplier_sync_id: supplier.sync_id || null,
        supplier_name: supplier.supplier_name,
        date: form.date,
        description: form.description,
        invoice_attachment: form.invoice_attachment || null,
      };
      // Drawer amounts ONLY. Sending a currency amount as well would have the
      // Cash Book count this payment twice — once in the drawer tile, once in
      // the currency tile that borrows the same column.
      payload.cash_amount = parseFloat(form.cash_amount || 0) || 0;
      payload.bank_amount = parseFloat(form.bank_amount || 0) || 0;
      payload.momo_amount = parseFloat(form.momo_amount || 0) || 0;
      const res = await createApPayment(payload);
      onSaved && onSaved(res?.data);
      onClose && onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to record payment.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Portal>
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 420, maxWidth: 'calc(100vw - 32px)', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Record Payment</h2>
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280' }}><FiX size={20} /></button>
          </div>

          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', marginBottom: 18 }}>
            <div style={{ fontSize: 13, color: '#166534', fontWeight: 600 }}>{supplier.supplier_name}</div>
            <div style={{ fontSize: 12, color: '#15803d', marginTop: 2 }}>
              {supplier.context_label
                ? supplier.context_label
                : `Outstanding balance: ${supplierSym}${Math.abs(parseFloat(supplier.balance) || 0).toLocaleString()}`}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                Amount Paid (split across methods)
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                {fields.map((f, i) => (
                  <div key={f.key}>
                    <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                    <input type="number" min="0" step={f.step} autoFocus={i === 0}
                      value={form[f.key]}
                      onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(form[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(form[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                  </div>
                ))}
              </div>
              {/* v1.10.111 — Total row removed per user (was confusing when
                  the tenant sym differed from supplier sym; auto-fill already
                  makes the intended amount obvious in the currency field). */}
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Date *</label>
              <input
                type="date"
                value={form.date}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Description</label>
              <input
                type="text"
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                style={{ width: '100%', padding: '9px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>Receipt / Proof of Payment</label>
              <InvoiceAttachment
                value={form.invoice_attachment}
                onChange={path => setForm(f => ({ ...f, invoice_attachment: path }))}
                kind="ap"
              />
            </div>
          </div>

          {error && <div style={{ marginTop: 12, color: '#dc2626', fontSize: 13 }}>{error}</div>}

          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <button onClick={onClose} style={{ flex: 1, padding: '10px', background: '#f3f4f6', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14 }}>
              Cancel
            </button>
            <button onClick={handlePay} disabled={saving} style={{ flex: 1, padding: '10px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>
              {saving ? 'Saving...' : 'Record Payment'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
