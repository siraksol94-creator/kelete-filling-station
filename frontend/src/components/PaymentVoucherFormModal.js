// Shared Payment Voucher form modal â€” used by both the PV page (general
// accounting) and the Cash Report page (cashier end-of-day). Same UI, same
// fields, same Types dropdown (from pv_types). Caller can lock paid_from
// to a fixed value (e.g. "Cash Drawer" for cash-report use).
import React, { useEffect, useState } from 'react';
import { getPvTypes, createPaymentVoucher, updatePaymentVoucher, createExpenseRequest, isHqHost } from '../services/api';
import { useCurrency } from '../context/CurrencyContext';
import Portal from '../utils/Portal';
import InvoiceAttachment from './InvoiceAttachment';

const todayStr = () => new Date().toISOString().split('T')[0];

const PaymentVoucherFormModal = ({
  open,
  onClose,
  onSaved,             // (savedVoucher) => void â€” called after a successful save
  editVoucher,         // optional â€” pre-fills for edit; null/undefined = new
  defaultPaidFrom,     // optional â€” overrides 'Main cashier' default for new
  lockPaidFrom,        // boolean â€” if true, paid_from select is disabled
  defaultDate,         // optional â€” overrides today's date for new
  defaultCurrency,     // v1.8.18 â€” 'USD' | 'FRA' | 'K' â€” auto-focuses that
                       //   currency's amount input. Other inputs visible but blurred.
  defaultPaidTo,       // v1.8.24 â€” pre-fills the Paid To field on new vouchers
                       //   (e.g. the cashier's name when opened from Cash Report).
  extraPayload,        // optional object â€” merged into the API payload (e.g. { cashier_id })
  prefill,             // 2026-09-18 â€” fills a NEW voucher from an approved
                       //   expense request, so nothing is typed twice.
  onRequested,         // (request) => void â€” called after the depot sends an
                       //   over-the-limit voucher to HQ for approval.
}) => {
  const { symbol: curSym, isLiquorStyle, methodShown } = useCurrency();
  // v1.13.46 â€” Kelete is single-currency K across HQ and every branch,
  // so the Kelete-era `isHqHost() ? false : isLiquorStyle` override no
  // longer applies here â€” it forced USD/FRA/K columns onto Kelete HQ
  // and confused operators. Use the CurrencyContext value directly;
  // business_settings on HQ + branches all have
  //   currency_mode=K, payment_methods=cash_momo_bank
  // which resolves isLiquorStyle=true, giving the correct Cash / MoMo
  // / Bank labels everywhere.
  const effectiveLiquorStyle = isLiquorStyle;
  // v1.10.31 â€” On Liquor-style branches (Lusaka, Mansa, K-only Cash/MoMo/Bank
  // workflow) the three amount inputs are physical methods, not currencies.
  // Storage columns stay the same (usd_amount = Cash, fra_amount = MoMo,
  // k_amount = Bank) to match CashReport's per-method cards and avoid a DB
  // migration. Backend paymentVouchers.js already accepts both shapes.
  const fieldConfigs = effectiveLiquorStyle
    ? [
        { key: 'usd_amount', ccy: 'CASH', label: 'Cash',         color: '#16a34a', step: '0.01', placeholder: '0.00', prefix: curSym },
        { key: 'fra_amount', ccy: 'MOMO', label: 'Mobile Money', color: '#ea580c', step: '0.01', placeholder: '0.00', prefix: curSym },
        { key: 'k_amount',   ccy: 'BANK', label: 'Bank',         color: '#2563eb', step: '0.01', placeholder: '0.00', prefix: curSym },
      ]
    : [
        { key: 'usd_amount', ccy: 'USD',  label: 'USD ($)',      color: '#16a34a', step: '0.01', placeholder: '0.00', prefix: '$' },
        { key: 'fra_amount', ccy: 'FRA',  label: 'FRA',          color: '#7c3aed', step: '1',    placeholder: '0',    prefix: ''  },
        { key: 'k_amount',   ccy: 'K',    label: 'K',            color: '#ea580c', step: '1',    placeholder: '0',    prefix: ''  },
      ];

  const [pvTypes, setPvTypes] = useState([]);
  // v1.8.5 â€” triple-currency. USD ($), FRA, K each in own currency. Legacy
  // cash_amount/bank_amount/momo_amount columns still in DB, kept at 0.
  const [form, setForm] = useState({
    paid_to: '', description: '', category: '',
    usd_amount: '', fra_amount: '', k_amount: '',
    date: todayStr(), paid_from: defaultPaidFrom || 'Main cashier',
    invoice_attachment: null,
  });
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);
  // 2026-09-18 â€” set when the server refuses the voucher for taking the depot
  // over its daily expense limit. Holds what the server said plus the payload,
  // so the same voucher can be sent to HQ for approval with a reason.
  const [overLimit, setOverLimit] = useState(null);
  const [limitReason, setLimitReason] = useState('');
  // 2026-09-11 â€” a method the branch has switched off (System Settings â†’
  // Payment methods shown) is hidden, unless this PV already has money on it.
  const shownFields = fieldConfigs.filter(f => !effectiveLiquorStyle || methodShown(f.label) || parseFloat(form[f.key] || 0) > 0);

  useEffect(() => {
    if (!open) return;
    getPvTypes().then(r => setPvTypes(Array.isArray(r.data) ? r.data : [])).catch(() => setPvTypes([]));
  }, [open]);

  // Reset form whenever the modal is opened / editVoucher changes.
  useEffect(() => {
    if (!open) return;
    if (editVoucher) {
      // v1.8.5 â€” prefer new usd/fra/k columns; fall back to legacy
      // cash/bank/momo (where the same amounts were stored before the rename).
      const usd = parseFloat(editVoucher.usd_amount || editVoucher.cash_amount || 0) || 0;
      const fra = parseFloat(editVoucher.fra_amount || editVoucher.bank_amount || 0) || 0;
      const k   = parseFloat(editVoucher.k_amount   || editVoucher.momo_amount || 0) || 0;
      const splitsSum = usd + fra + k;
      const legacyAmount = parseFloat(editVoucher.amount || 0) || 0;
      setForm({
        paid_to:     editVoucher.paid_to     || '',
        description: editVoucher.description || '',
        category:    editVoucher.category    || '',
        usd_amount:  splitsSum > 0 ? (usd > 0 ? String(usd) : '') : (legacyAmount > 0 ? String(legacyAmount) : ''),
        fra_amount:  fra > 0 ? String(fra) : '',
        k_amount:    k   > 0 ? String(k)   : '',
        date:        editVoucher.date ? editVoucher.date.split('T')[0] : (defaultDate || todayStr()),
        paid_from:   editVoucher.paid_from   || defaultPaidFrom || 'Main cashier',
        invoice_attachment: editVoucher.invoice_attachment || null,
      });
    } else if (prefill) {
      // An HQ-approved voucher, ready to save as it was requested.
      setForm({
        paid_to:     prefill.paid_to     || '',
        description: prefill.description || '',
        // 2026-09-20 â€” whatever the request said, or nothing. It used to
        // fall back to 'Other', which is a real category and quietly the
        // wrong one.
        category:    prefill.category    || '',
        usd_amount:  parseFloat(prefill.usd_amount) > 0 ? String(prefill.usd_amount) : '',
        fra_amount:  parseFloat(prefill.fra_amount) > 0 ? String(prefill.fra_amount) : '',
        k_amount:    parseFloat(prefill.k_amount)   > 0 ? String(prefill.k_amount)   : '',
        date:        prefill.date ? String(prefill.date).split('T')[0] : (defaultDate || todayStr()),
        paid_from:   prefill.paid_from   || defaultPaidFrom || 'Main cashier',
        invoice_attachment: prefill.invoice_attachment || null,
      });
    } else {
      setForm({
        paid_to: defaultPaidTo || '', // v1.8.24 â€” pre-fill with cashier name when provided
        // 2026-09-20 â€” blank, so the dropdown shows its own
        // "- Select Type (required) -" placeholder. It opened on 'Other'
        // and could be saved that way without anyone choosing, which is
        // how expenses end up filed under Other. Save already refuses an
        // empty Type and the button stays disabled until one is picked.
        description: '', category: '',
        usd_amount: '', fra_amount: '', k_amount: '',
        date: defaultDate || todayStr(),
        paid_from: defaultPaidFrom || 'Main cashier',
        invoice_attachment: null,
      });
    }
    setError('');
    setOverLimit(null);
    setLimitReason('');
  }, [open, editVoucher, prefill, defaultPaidFrom, defaultDate, defaultPaidTo]);

  if (!open) return null;

  const handleSave = async () => {
    setError('');
    if (!form.paid_to.trim()) return setError('Paid To is required.');
    // v1.8.25 â€” Type is required. Forces a conscious pick instead of
    // accidentally saving with the wrong default.
    if (!form.category) return setError('Type is required â€” pick one from the dropdown.');
    const usd = parseFloat(form.usd_amount || 0) || 0;
    const fra = parseFloat(form.fra_amount || 0) || 0;
    const k   = parseFloat(form.k_amount   || 0) || 0;
    // Total for the header `amount` column (legacy reports + Cash Book read
    // this). On Kelete, only USD is canonical since FRA & K would need FX;
    // on Liquor the three slots are all the same currency (Cash/MoMo/Bank
    // in K), so `amount` = sum of whichever slot the user filled in.
    // v1.10.31 â€” was reading `usd` only, which zeroed the header amount when
    // a Liquor cashier paid via MoMo or Bank.
    const totalUsd = effectiveLiquorStyle ? (usd + fra + k) : usd;
    if (usd <= 0 && fra <= 0 && k <= 0) return setError(effectiveLiquorStyle ? 'Enter an amount in Cash, Mobile Money, or Bank.' : 'Enter an amount in at least one currency.');

    if (editVoucher) {
      if (!window.confirm('Are you sure you want to update this record?')) return;
    }
    setSaving(true);
    // 2026-09-21 â€” built OUTSIDE the try because the catch needs it: when the
    // server refuses a voucher for being over the daily limit, the approval
    // panel is opened with this payload so it can be sent to HQ as it stands.
    // It used to be declared inside the try, so the catch threw
    // "payload is not defined" before it could open the panel OR show the
    // error â€” the depot clicked Save on an over-limit voucher and got
    // absolutely nothing, with the refusal sitting unseen in the console.
    // 2026-09-21 â€” an approved request keeps what it was RAISED with.
    //
    // The chain that broke: an expense raised on Cash Report goes over the
    // limit, HQ approves it, the badge opens this modal on the Payment
    // Voucher page â€” and this line overwrote paid_from with "Cash drawer" and
    // attached no cashier, so the voucher landed outside the Cash Report it
    // came from and the cashier never saw her own expense.
    //
    // The request already carries both, so they are used as they are. A
    // request raised on the PV page still saves exactly as before.
    let resolvedPaidFrom = form.paid_from;
    if (prefill?.paid_from) resolvedPaidFrom = prefill.paid_from;
    else if (!lockPaidFrom) resolvedPaidFrom = 'Cash drawer';
    const payload = {
      paid_to:     form.paid_to.trim(),
      description: (form.description || '').trim(),
      category:    form.category,
      amount:      totalUsd,
      usd_amount:  usd,
      fra_amount:  fra,
      k_amount:    k,
      date:        form.date,
      paid_from:   resolvedPaidFrom,
      invoice_attachment: form.invoice_attachment,
      ...(extraPayload || {}),
      // The cashier it was raised for, so an approved Cash Report expense
      // lands back in that cashier's report. extraPayload still wins where
      // this modal is opened FROM the Cash Report.
      ...(prefill && prefill.cashier_id !== undefined && prefill.cashier_id !== null && !extraPayload?.cashier_id
        ? { cashier_id: parseInt(prefill.cashier_id) || 0 }
        : {}),
    };
    try {
      const res = editVoucher
        ? await updatePaymentVoucher(editVoucher.id, payload)
        : await createPaymentVoucher(payload);
      onSaved && onSaved(res?.data);
      onClose();
    } catch (err) {
      const data = err.response?.data || {};
      // 2026-09-18 â€” over the depot's daily expense limit: offer to send it to
      // HQ instead. `pending_request` means one is already waiting.
      if (data.needs_approval) setOverLimit({ ...data, payload });
      setError(data.error || 'Failed to save voucher.');
    } finally {
      setSaving(false);
    }
  };

  // Send the refused voucher to HQ for approval. The voucher is not saved.
  const sendForApproval = async () => {
    if (limitReason.trim().length < 3) { setError('Give a reason of at least 3 characters for HQ.'); return; }
    setSaving(true);
    try {
      const res = await createExpenseRequest({ ...overLimit.payload, reason: limitReason.trim() });
      onRequested && onRequested(res?.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Could not send the request to HQ.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Portal>
      {/* v1.8.24 â€” click-outside does NOT close. Backdrop is decorative.
          User must click Cancel or X to dismiss. Prevents losing typed
          amounts when accidentally clicking outside the modal. */}
      <div className="modal-overlay">
        <div className="modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h3>{editVoucher ? 'Edit Payment Voucher' : 'New Payment Voucher'}</h3>
            <button className="modal-close" onClick={onClose}>Ã—</button>
          </div>
          <div className="modal-body">
            {error && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{error}</div>}

            {/* 2026-09-18 â€” over the depot's daily expense limit. The voucher
                is not saved; it goes to HQ with a reason and waits there. */}
            {overLimit && (
              <div style={{ marginBottom: 14, padding: '12px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#991b1b', marginBottom: 6 }}>Over today's expense limit</div>
                <div style={{ fontSize: 12.5, color: '#7f1d1d', marginBottom: 10 }}>
                  Send this voucher to HQ for approval. It is not saved until an HQ administrator approves it,
                  and no other expense can be raised while it waits.
                </div>
                <label style={{ fontSize: 11, fontWeight: 700, color: '#991b1b', textTransform: 'uppercase', letterSpacing: 0.4 }}>Reason for HQ</label>
                <input value={limitReason} onChange={e => setLimitReason(e.target.value)}
                  placeholder="Why this expense is needed today"
                  style={{ width: '100%', padding: '9px 12px', marginTop: 4, border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }} />
                <button type="button" onClick={sendForApproval} disabled={saving}
                  style={{ marginTop: 10, padding: '9px 18px', background: saving ? '#fca5a5' : '#dc2626', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: saving ? 'wait' : 'pointer' }}>
                  {saving ? 'Sendingâ€¦' : 'Send to HQ for approval'}
                </button>
              </div>
            )}

            <div className="form-row">
              <div className="form-group">
                <label>Date</label>
                <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Type <span style={{ color: '#dc2626' }}>*</span></label>
                {/* v1.8.25 â€” start blank so the user can't save with the
                    wrong default ('Council' wasn't always right). Save
                    handler rejects empty category with an error.
                    v1.8.53 â€” Update button also disabled until Type is set. */}
                <select value={form.category} required
                  onChange={e => setForm({ ...form, category: e.target.value })}
                  style={{ borderColor: form.category ? '' : '#dc2626', background: form.category ? '' : '#fef2f2' }}>
                  <option value="">â€” Select Type (required) â€”</option>
                  {pvTypes.length === 0
                    ? <option value="Other">Other</option>
                    : pvTypes.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
                </select>
              </div>
            </div>

            <div className="form-group">
              <label>Paid To</label>
              <input value={form.paid_to} onChange={e => setForm({ ...form, paid_to: e.target.value })} placeholder="Name of payee" />
            </div>

            {lockPaidFrom && (
              <div className="form-group">
                <label>Paid From</label>
                <input value={form.paid_from} disabled
                  style={{ background: '#f3f4f6', fontWeight: 600, cursor: 'not-allowed' }} />
              </div>
            )}

            {/* Amount split across methods â€” mirrors the AP Record Payment modal. */}
            <div className="form-group">
              <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                Amount Paid (split across methods)
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${shownFields.length}, 1fr)`, gap: 10 }}>
                {shownFields.map((f) => {
                  const isDefault = defaultCurrency && f.ccy === defaultCurrency;
                  // v1.8.24 â€” one PV = one method/currency. Disable an input
                  // when ANY OTHER already has a value > 0.
                  const otherKeys = fieldConfigs.map(x => x.key).filter(k => k !== f.key);
                  const someoneElseHasValue = otherKeys.some(k => parseFloat(form[k] || 0) > 0);
                  const locked = someoneElseHasValue;
                  return (
                    <div key={f.key}>
                      <label style={{ fontSize: 11, color: locked ? '#cbd5e1' : f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}{locked && ' (locked)'}</label>
                      <input type="number" min="0" step={f.step}
                        autoFocus={isDefault}
                        disabled={locked}
                        value={form[f.key]}
                        onChange={e => setForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                        placeholder={f.placeholder}
                        title={locked ? (effectiveLiquorStyle ? 'Clear the other method to switch â€” one PV = one method.' : 'Clear the other currency to switch â€” one PV = one currency.') : ''}
                        style={{
                          width: '100%', padding: '8px 10px',
                          border: `2px solid ${locked ? '#e5e7eb' : (parseFloat(form[f.key] || 0) > 0 || isDefault ? f.color : '#d1d5db')}`,
                          borderRadius: 6, fontSize: 14, fontWeight: 600,
                          color: locked ? '#cbd5e1' : (parseFloat(form[f.key] || 0) > 0 ? f.color : '#374151'),
                          background: locked ? '#f9fafb' : '#fff',
                          cursor: locked ? 'not-allowed' : 'text',
                          boxSizing: 'border-box',
                          boxShadow: isDefault && !locked ? `0 0 0 3px ${f.color}25` : 'none',
                        }} />
                    </div>
                  );
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 13, marginTop: 8 }}>
                {(() => {
                  // v1.10.31 â€” Liquor totals sum all three inputs in one currency
                  // (only one is non-zero due to the lock, so this reads the
                  // active method's value). Kelete keeps the USD-only header total
                  // that the DB `amount` column tracks.
                  if (effectiveLiquorStyle) {
                    const t = fieldConfigs.reduce((s, f) => s + (parseFloat(form[f.key] || 0) || 0), 0);
                    return (
                      <>
                        <span style={{ color: '#6b7280' }}>Total</span>
                        <span style={{ fontWeight: 800, color: '#1d4ed8' }}>
                          {curSym}{t.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </>
                    );
                  }
                  return (
                    <>
                      <span style={{ color: '#6b7280' }}>Header total (USD only)</span>
                      <span style={{ fontWeight: 800, color: '#1d4ed8' }}>
                        ${(parseFloat(form.usd_amount || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                    </>
                  );
                })()}
              </div>
            </div>

            <div className="form-group">
              <label>Description</label>
              <input value={form.description}
                onChange={e => setForm({ ...form, description: e.target.value })}
                placeholder="Payment details" />
            </div>

            <div className="form-group">
              <label>Invoice Attachment</label>
              <InvoiceAttachment
                value={form.invoice_attachment}
                onChange={(p) => setForm({ ...form, invoice_attachment: p })}
                kind="pv"
              />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving || !form.category}
              title={!form.category ? 'Pick a Type first' : ''}>
              {saving ? 'Saving...' : editVoucher ? 'Update Voucher' : 'Save Voucher'}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
};

export default PaymentVoucherFormModal;
