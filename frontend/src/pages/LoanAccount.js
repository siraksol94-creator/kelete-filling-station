// Loan Account — liability sub-ledger.
//
// Two views in one page:
//   1. List of loans (top): each loan agreement with derived outstanding balance
//   2. Detail (modal): the loan's full transaction history + buttons to record
//      Disbursement / Principal / Interest entries.
//
// Outflow types DO different things:
//   Principal → reduces what we owe, NOT an expense
//   Interest  → real expense, shows up on Profit Report as Interest Expense
//   Disbursement → money received from the lender, NOT income
import React, { useEffect, useState } from 'react';
import {
  getLoans, getLoanStats, getLoan,
  createLoan, updateLoan, deleteLoan,
  createLoanTransaction, deleteLoanTransaction,
  getSettings,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiPlus, FiEdit2, FiTrash2, FiX, FiEye, FiTrendingDown, FiDollarSign } from 'react-icons/fi';
import Toast from '../components/Toast';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';

const todayStr = new Date().toISOString().split('T')[0];

const formatDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const STATUS_STYLE = {
  Active:     { bg: '#dbeafe', color: '#1e40af', border: '#bfdbfe' },
  'Paid Off': { bg: '#dcfce7', color: '#166534', border: '#86efac' },
  Defaulted:  { bg: '#fee2e2', color: '#991b1b', border: '#fecaca' },
};

const TX_TYPE_STYLE = {
  Disbursement: { bg: '#dcfce7', color: '#166534', border: '#86efac' },
  Principal:    { bg: '#fee2e2', color: '#991b1b', border: '#fecaca' },
  Interest:     { bg: '#fef3c7', color: '#92400e', border: '#fde68a' },
};

const LoanAccount = () => {
  const { hasPermission } = useAuth();
  const { symbol: curSym, methodShown } = useCurrency();
  const [stats, setStats]   = useState({ activeLoans: 0, totalDisbursed: 0, totalPrincipalPaid: 0, outstanding: 0, interestYTD: 0 });
  const [loans, setLoans]   = useState([]);
  const [toast, setToast]   = useState(null);
  const [filterStatus, setFilterStatus] = useState('All');

  // Loan-create / edit modal
  const [showLoanForm, setShowLoanForm] = useState(false);
  const [editLoanId, setEditLoanId] = useState(null);
  const [savingLoan, setSavingLoan] = useState(false);
  const [loanError, setLoanError]   = useState('');
  const [loanForm, setLoanForm] = useState({
    lender_name: '', principal_amount: '', interest_rate: '',
    start_date: todayStr, maturity_date: '', status: 'Active', notes: '',
    // Initial disbursement fields — only used when creating a new loan.
    // On edit the user manages transactions through the detail modal.
    disb_cash: '', disb_bank: '', disb_momo: '',
  });

  // Loan detail modal (with transactions)
  const [detailLoan, setDetailLoan] = useState(null);

  // Transaction modal
  const [showTxForm, setShowTxForm] = useState(false);
  const [txType, setTxType] = useState('Disbursement');
  const [savingTx, setSavingTx] = useState(false);
  const [txError, setTxError] = useState('');
  const [txForm, setTxForm] = useState({
    date: todayStr, cash_amount: '', bank_amount: '', momo_amount: '', description: '',
  });

  useModalScrollLock(showLoanForm || !!detailLoan || showTxForm);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  };

  const fetchAll = async () => {
    try {
      const [listRes, statsRes] = await Promise.all([
        getLoans({ status: filterStatus !== 'All' ? filterStatus : undefined }),
        getLoanStats(),
      ]);
      setLoans(listRes.data || []);
      setStats(statsRes.data || { activeLoans: 0, totalDisbursed: 0, totalPrincipalPaid: 0, outstanding: 0, interestYTD: 0 });
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load loans.', 'error'); }
  };

  useEffect(() => { fetchAll(); }, [filterStatus]); // eslint-disable-line

  const resetLoanForm = () => {
    setLoanForm({
      lender_name: '', principal_amount: '', interest_rate: '',
      start_date: todayStr, maturity_date: '', status: 'Active', notes: '',
      disb_cash: '', disb_bank: '', disb_momo: '',
    });
    setEditLoanId(null);
    setLoanError('');
  };

  const openNewLoan = () => { resetLoanForm(); setShowLoanForm(true); };

  const openEditLoan = (l) => {
    setEditLoanId(l.id);
    setLoanForm({
      lender_name:      l.lender_name || '',
      principal_amount: l.principal_amount > 0 ? String(l.principal_amount) : '',
      interest_rate:    l.interest_rate > 0 ? String(l.interest_rate) : '',
      start_date:       l.start_date || todayStr,
      maturity_date:    l.maturity_date || '',
      status:           l.status || 'Active',
      notes:            l.notes || '',
      disb_cash: '', disb_bank: '', disb_momo: '', // not used on edit
    });
    setLoanError('');
    setShowLoanForm(true);
  };

  const saveLoan = async () => {
    setLoanError('');
    const disbCash = parseFloat(loanForm.disb_cash) || 0;
    const disbBank = parseFloat(loanForm.disb_bank) || 0;
    const disbMomo = parseFloat(loanForm.disb_momo) || 0;
    const disbTotal = disbCash + disbBank + disbMomo;
    // New loans: principal is derived from the disbursement total (the
    // "Principal Amount" field was removed from the New Loan modal because
    // it's always the same as what was actually received). Edit mode keeps
    // the principal field visible so users can correct historical errors.
    if (!editLoanId) {
      if (disbTotal <= 0) return setLoanError('Money Received is required — enter what the lender actually transferred.');
    } else {
      if (!(parseFloat(loanForm.principal_amount) > 0)) return setLoanError('Principal amount is required.');
    }
    setSavingLoan(true);
    try {
      const principal = editLoanId
        ? (parseFloat(loanForm.principal_amount) || 0)
        : disbTotal;
      const payload = {
        lender_name:      loanForm.lender_name.trim() || null,
        principal_amount: principal,
        interest_rate:    parseFloat(loanForm.interest_rate) || 0,
        start_date:       loanForm.start_date,
        maturity_date:    loanForm.maturity_date || null,
        status:           loanForm.status,
        notes:            loanForm.notes.trim() || null,
      };
      if (editLoanId) {
        await updateLoan(editLoanId, payload);
      } else {
        // Create the loan first, then immediately the initial Disbursement
        // transaction. If the transaction fails (network, validation, etc.)
        // soft-delete the orphan loan so the user doesn't end up with a
        // $0-outstanding ghost entry to clean up.
        const loanRes = await createLoan(payload);
        const newLoanId = loanRes?.data?.id;
        try {
          await createLoanTransaction(newLoanId, {
            type: 'Disbursement',
            date: loanForm.start_date,
            cash_amount: disbCash,
            bank_amount: disbBank,
            momo_amount: disbMomo,
            description: 'Initial disbursement',
          });
        } catch (txErr) {
          if (newLoanId) await deleteLoan(newLoanId).catch(() => {});
          throw txErr;
        }
      }
      setShowLoanForm(false);
      resetLoanForm();
      await fetchAll();
      showToast(editLoanId ? 'Loan updated.' : 'Loan created and disbursement recorded.');
    } catch (e) { setLoanError(e.response?.data?.error || 'Save failed.'); }
    finally { setSavingLoan(false); }
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleDeleteLoan = (l) => {
    setPendingDelete({
      subject: `Loan ${l.loan_number} — all transactions will be soft-deleted too`,
      perform: async () => {
        try {
          await deleteLoan(l.id);
          setDetailLoan(null);
          await fetchAll();
          showToast('Loan deleted.', 'error');
        } catch (e) { showToast(e.response?.data?.error || 'Delete failed.', 'error'); }
      },
    });
  };

  const openDetail = async (l) => {
    try {
      const res = await getLoan(l.id);
      setDetailLoan(res.data);
    } catch (e) { showToast(e.response?.data?.error || 'Failed to load.', 'error'); }
  };

  const openTxForm = (type) => {
    setTxType(type);
    setTxForm({ date: todayStr, cash_amount: '', bank_amount: '', momo_amount: '', description: '' });
    setTxError('');
    setShowTxForm(true);
  };

  const saveTx = async () => {
    setTxError('');
    const cash = parseFloat(txForm.cash_amount) || 0;
    const bank = parseFloat(txForm.bank_amount) || 0;
    const momo = parseFloat(txForm.momo_amount) || 0;
    if (cash + bank + momo <= 0) return setTxError('Total must be greater than 0.');
    setSavingTx(true);
    try {
      const payload = {
        type: txType,
        date: txForm.date,
        cash_amount: cash, bank_amount: bank, momo_amount: momo,
        description: txForm.description.trim() || null,
      };
      await createLoanTransaction(detailLoan.id, payload);
      setShowTxForm(false);
      const refreshed = await getLoan(detailLoan.id);
      setDetailLoan(refreshed.data);
      await fetchAll();
      showToast(`${txType} recorded.`);
    } catch (e) { setTxError(e.response?.data?.error || 'Save failed.'); }
    finally { setSavingTx(false); }
  };

  const handleDeleteTx = (tx) => {
    setPendingDelete({
      subject: `Loan transaction ${tx.transaction_number} (${tx.type})`,
      perform: async () => {
        try {
          await deleteLoanTransaction(detailLoan.id, tx.id);
          const refreshed = await getLoan(detailLoan.id);
          setDetailLoan(refreshed.data);
          await fetchAll();
          showToast('Transaction deleted.', 'error');
        } catch (e) { showToast(e.response?.data?.error || 'Delete failed.', 'error'); }
      },
    });
  };

  const canEdit = hasPermission('LoanAccount:Add') || hasPermission('LoanAccount:Edit');
  const canDelete = hasPermission('LoanAccount:Delete');

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Loan Account</h1>
          <p>Liability ledger — loans received from third parties. Interest payments hit Profit Report; principal repayments don't.</p>
        </div>
        {hasPermission('LoanAccount:Add') && (
          <button className="btn btn-primary" onClick={openNewLoan}><FiPlus /> New Loan</button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 18 }}>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#dc2626,#991b1b)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Outstanding</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{curSym}{parseFloat(stats.outstanding).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{stats.activeLoans} active loan{stats.activeLoans !== 1 ? 's' : ''}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#16a34a,#15803d)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Total Disbursed</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{curSym}{parseFloat(stats.totalDisbursed).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#1e40af,#1e3a8a)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Principal Repaid</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{curSym}{parseFloat(stats.totalPrincipalPaid).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
        </div>
        <div style={{ padding: 18, borderRadius: 12, background: 'linear-gradient(135deg,#f59e0b,#b45309)', color: '#fff' }}>
          <div style={{ fontSize: 11, opacity: 0.85, fontWeight: 700, textTransform: 'uppercase' }}>Interest Paid YTD</div>
          <div style={{ fontSize: 24, fontWeight: 800, marginTop: 6 }}>{curSym}{parseFloat(stats.interestYTD).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div>
          <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>real expense on Profit Report</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, padding: 12, background: '#f9fafb', borderRadius: 10 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Status:</span>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, background: '#fff' }}>
          <option value="All">All</option>
          <option value="Active">Active</option>
          <option value="Paid Off">Paid Off</option>
          <option value="Defaulted">Defaulted</option>
        </select>
      </div>

      <div className="data-table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>LOAN #</th><th>LENDER</th><th>START</th>
              <th style={{ textAlign: 'right' }}>PRINCIPAL</th>
              <th style={{ textAlign: 'right' }}>OUTSTANDING</th>
              <th style={{ textAlign: 'right' }}>INTEREST RATE</th>
              <th>STATUS</th>
              <th style={{ textAlign: 'center' }}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {loans.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>No loans recorded.</td></tr>
            ) : loans.map(l => {
              const ss = STATUS_STYLE[l.status] || STATUS_STYLE.Active;
              return (
                <tr key={l.id}>
                  <td style={{ fontWeight: 600 }}>{l.loan_number}</td>
                  <td>{l.lender_name || '—'}</td>
                  <td>{formatDate(l.start_date)}</td>
                  <td style={{ textAlign: 'right' }}>{curSym}{parseFloat(l.principal_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: l.outstanding > 0 ? '#dc2626' : '#16a34a' }}>{curSym}{parseFloat(l.outstanding).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                  <td style={{ textAlign: 'right' }}>{l.interest_rate > 0 ? `${l.interest_rate}%` : '—'}</td>
                  <td><span style={{ padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: ss.bg, color: ss.color, border: `1px solid ${ss.border}` }}>{l.status}</span></td>
                  <td style={{ textAlign: 'center' }}>
                    <button onClick={() => openDetail(l)} title="View / Record transaction" style={{ background: 'none', border: 'none', color: '#0369a1', cursor: 'pointer', padding: 4 }}><FiEye /></button>
                    {canEdit && <button onClick={() => openEditLoan(l)} title="Edit loan" style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', padding: 4 }}><FiEdit2 /></button>}
                    {canDelete && <button onClick={() => handleDeleteLoan(l)} title="Delete" style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 4 }}><FiTrash2 /></button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Loan create/edit modal ─────────────────────────────────────── */}
      {showLoanForm && (
        <Portal>
          <div className="modal-overlay" onClick={() => setShowLoanForm(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>{editLoanId ? 'Edit Loan' : 'New Loan Agreement'}</h3>
                <button className="modal-close" onClick={() => setShowLoanForm(false)}>×</button>
              </div>
              <div className="modal-body">
                {loanError && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{loanError}</div>}
                <div className="form-row">
                  <div className="form-group">
                    <label>Lender</label>
                    <input value={loanForm.lender_name} onChange={e => setLoanForm({ ...loanForm, lender_name: e.target.value })} placeholder="e.g. FNB Bank / Sirak's brother" />
                  </div>
                  <div className="form-group">
                    <label>Status</label>
                    <select value={loanForm.status} onChange={e => setLoanForm({ ...loanForm, status: e.target.value })}>
                      <option value="Active">Active</option>
                      <option value="Paid Off">Paid Off</option>
                      <option value="Defaulted">Defaulted</option>
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  {/* Principal Amount shown only on edit. On new loans it's
                      derived from the Money Received total below — same value,
                      no need to type it twice. */}
                  {editLoanId ? (
                    <>
                      <div className="form-group">
                        <label>Principal Amount ({curSym}) *</label>
                        <input type="number" min="0" step="0.01" value={loanForm.principal_amount} onChange={e => setLoanForm({ ...loanForm, principal_amount: e.target.value })} placeholder="0.00" />
                      </div>
                      <div className="form-group">
                        <label>Interest Rate (% per year)</label>
                        <input type="number" min="0" step="0.01" value={loanForm.interest_rate} onChange={e => setLoanForm({ ...loanForm, interest_rate: e.target.value })} placeholder="0" />
                      </div>
                    </>
                  ) : (
                    <div className="form-group" style={{ flex: 1 }}>
                      <label>Interest Rate (% per year)</label>
                      <input type="number" min="0" step="0.01" value={loanForm.interest_rate} onChange={e => setLoanForm({ ...loanForm, interest_rate: e.target.value })} placeholder="0" />
                    </div>
                  )}
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Start Date</label>
                    <input type="date" value={loanForm.start_date} onChange={e => setLoanForm({ ...loanForm, start_date: e.target.value })} />
                  </div>
                  <div className="form-group">
                    <label>Maturity Date</label>
                    <input type="date" value={loanForm.maturity_date} onChange={e => setLoanForm({ ...loanForm, maturity_date: e.target.value })} />
                  </div>
                </div>
                <div className="form-group">
                  <label>Notes</label>
                  <input value={loanForm.notes} onChange={e => setLoanForm({ ...loanForm, notes: e.target.value })} placeholder="optional" />
                </div>

                {!editLoanId && (
                  <>
                    <div className="form-group" style={{ marginTop: 6 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 8 }}>
                        Money Received (split across methods) *
                      </label>
                      {/* 2026-09-11 — MoMo / Bank follow System Settings → Payment methods shown. */}
                      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${1 + ((methodShown('bank') || parseFloat(loanForm.disb_bank || 0) > 0) ? 1 : 0) + ((methodShown('momo') || parseFloat(loanForm.disb_momo || 0) > 0) ? 1 : 0)}, 1fr)`, gap: 10 }}>
                        {[
                          { key: 'disb_cash', label: 'Cash', color: '#16a34a' },
                          { key: 'disb_bank', label: 'Bank', color: '#2563eb' },
                          { key: 'disb_momo', label: 'MoMo', color: '#f59e0b' },
                        ].filter(f => methodShown(f.label) || parseFloat(loanForm[f.key] || 0) > 0).map(f => (
                          <div key={f.key}>
                            <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                            <input type="number" min="0" step="0.01"
                              value={loanForm[f.key]}
                              onChange={e => setLoanForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                              placeholder="0.00"
                              style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(loanForm[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, color: parseFloat(loanForm[f.key] || 0) > 0 ? f.color : '#374151', boxSizing: 'border-box' }} />
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 13, marginTop: 8 }}>
                        <span style={{ color: '#6b7280' }}>Total received</span>
                        <span style={{ fontWeight: 800, color: '#1d4ed8' }}>
                          {curSym}{(parseFloat(loanForm.disb_cash || 0) + parseFloat(loanForm.disb_bank || 0) + parseFloat(loanForm.disb_momo || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>
                    <div style={{ background: '#dcfce7', border: '1px solid #86efac', padding: 10, borderRadius: 8, fontSize: 12, color: '#166534' }}>
                      💡 The amount above is recorded as the initial Disbursement on the loan's start date. To add more disbursements later (e.g. revolving credit line), open the loan and click + Disbursement.
                    </div>
                  </>
                )}
                {editLoanId && (
                  <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', padding: 10, borderRadius: 8, fontSize: 12, color: '#1e40af' }}>
                    ℹ️ You're editing the loan agreement. To change a specific disbursement, principal, or interest transaction, open the loan detail and edit/delete the transaction directly.
                  </div>
                )}
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowLoanForm(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={saveLoan} disabled={savingLoan}>{savingLoan ? 'Saving...' : editLoanId ? 'Update' : 'Save'}</button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {/* ── Loan detail modal (transactions list + add buttons) ──────────── */}
      {detailLoan && (
        <Portal>
          <div className="modal-overlay" onClick={() => setDetailLoan(null)}>
            <div className="modal" style={{ maxWidth: 820 }} onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>{detailLoan.loan_number} — {detailLoan.lender_name || 'Lender'}</h3>
                <button className="modal-close" onClick={() => setDetailLoan(null)}>×</button>
              </div>
              <div className="modal-body">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
                  <div><div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>Principal</div><div style={{ fontWeight: 700, marginTop: 3 }}>{curSym}{parseFloat(detailLoan.principal_amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div>
                  <div><div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>Outstanding</div><div style={{ fontWeight: 700, marginTop: 3, color: detailLoan.outstanding > 0 ? '#dc2626' : '#16a34a' }}>{curSym}{parseFloat(detailLoan.outstanding).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div>
                  <div><div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase', fontWeight: 700 }}>Interest Rate</div><div style={{ fontWeight: 700, marginTop: 3 }}>{detailLoan.interest_rate > 0 ? `${detailLoan.interest_rate}%` : '—'}</div></div>
                </div>

                {hasPermission('LoanAccount:Add') && (
                  <div style={{ display: 'flex', gap: 8, marginBottom: 14, padding: 10, background: '#f9fafb', borderRadius: 8 }}>
                    <button className="btn btn-primary" style={{ background: '#16a34a' }} onClick={() => openTxForm('Disbursement')}>+ Disbursement</button>
                    <button className="btn btn-primary" style={{ background: '#dc2626' }} onClick={() => openTxForm('Principal')}>+ Principal Payment</button>
                    <button className="btn btn-primary" style={{ background: '#f59e0b' }} onClick={() => openTxForm('Interest')}>+ Interest Payment</button>
                  </div>
                )}

                <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead style={{ background: '#f9fafb' }}>
                      <tr>
                        <th style={{ padding: '8px 10px', textAlign: 'left' }}>TXN #</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left' }}>DATE</th>
                        <th style={{ padding: '8px 10px', textAlign: 'left' }}>TYPE</th>
                        <th style={{ padding: '8px 10px', textAlign: 'right' }}>AMOUNT</th>
                        <th style={{ padding: '8px 10px' }}>NOTE</th>
                        {canDelete && <th />}
                      </tr>
                    </thead>
                    <tbody>
                      {(detailLoan.transactions || []).length === 0 ? (
                        <tr><td colSpan={6} style={{ textAlign: 'center', padding: 30, color: '#9ca3af' }}>No transactions yet. Click + Disbursement to record the loan being received.</td></tr>
                      ) : detailLoan.transactions.map(tx => {
                        const ts = TX_TYPE_STYLE[tx.type] || TX_TYPE_STYLE.Disbursement;
                        const sign = tx.type === 'Disbursement' ? '+' : '−';
                        const color = tx.type === 'Disbursement' ? '#16a34a' : (tx.type === 'Interest' ? '#92400e' : '#dc2626');
                        return (
                          <tr key={tx.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '8px 10px', fontWeight: 600 }}>{tx.transaction_number}</td>
                            <td style={{ padding: '8px 10px' }}>{formatDate(tx.date)}</td>
                            <td style={{ padding: '8px 10px' }}><span style={{ padding: '2px 8px', borderRadius: 12, fontSize: 10, fontWeight: 700, background: ts.bg, color: ts.color, border: `1px solid ${ts.border}` }}>{tx.type}</span></td>
                            <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color }}>{sign}{curSym}{parseFloat(tx.amount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            <td style={{ padding: '8px 10px', color: '#6b7280' }}>{tx.description || '—'}</td>
                            {canDelete && (
                              <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                                <button onClick={() => handleDeleteTx(tx)} title="Delete" style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 2 }}><FiTrash2 size={14} /></button>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setDetailLoan(null)}>Close</button>
              </div>
            </div>
          </div>
        </Portal>
      )}

      {/* ── Transaction modal ─────────────────────────────────────────────── */}
      {showTxForm && detailLoan && (
        <Portal>
          <div className="modal-overlay" onClick={() => setShowTxForm(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>Record {txType} — {detailLoan.loan_number}</h3>
                <button className="modal-close" onClick={() => setShowTxForm(false)}>×</button>
              </div>
              <div className="modal-body">
                {txError && <div style={{ color: '#dc2626', marginBottom: 12, fontSize: 13 }}>{txError}</div>}

                <div style={{ padding: '10px 12px', background: txType === 'Interest' ? '#fef3c7' : (txType === 'Disbursement' ? '#dcfce7' : '#fee2e2'), borderRadius: 8, marginBottom: 14, fontSize: 12 }}>
                  {txType === 'Disbursement' && <>💰 <strong>Disbursement</strong> = money received from the lender. Cash IN. Loan balance goes UP. Not income.</>}
                  {txType === 'Principal'    && <>↩ <strong>Principal Payment</strong> = paying back what you borrowed. Cash OUT. Loan balance goes DOWN. Not an expense.</>}
                  {txType === 'Interest'     && <>💸 <strong>Interest Payment</strong> = the cost of borrowing. Cash OUT. Real expense on the Profit Report. Loan balance unchanged.</>}
                </div>

                <div className="form-group">
                  <label>Date</label>
                  <input type="date" value={txForm.date} onChange={e => setTxForm({ ...txForm, date: e.target.value })} />
                </div>

                <div className="form-group">
                  <label style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Amount (split across methods)</label>
                  {/* 2026-09-11 — MoMo / Bank follow System Settings → Payment methods shown. */}
                  <div style={{ display: 'grid', gridTemplateColumns: `repeat(${1 + ((methodShown('bank') || parseFloat(txForm.bank_amount || 0) > 0) ? 1 : 0) + ((methodShown('momo') || parseFloat(txForm.momo_amount || 0) > 0) ? 1 : 0)}, 1fr)`, gap: 10 }}>
                    {[
                      { key: 'cash_amount', label: 'Cash', color: '#16a34a' },
                      { key: 'bank_amount', label: 'Bank', color: '#2563eb' },
                      { key: 'momo_amount', label: 'MoMo', color: '#f59e0b' },
                    ].filter(f => methodShown(f.label) || parseFloat(txForm[f.key] || 0) > 0).map(f => (
                      <div key={f.key}>
                        <label style={{ fontSize: 11, color: f.color, fontWeight: 700, textTransform: 'uppercase', marginBottom: 3, display: 'block' }}>{f.label}</label>
                        <input type="number" min="0" step="0.01" value={txForm[f.key]}
                          onChange={e => setTxForm(prev => ({ ...prev, [f.key]: e.target.value }))}
                          placeholder="0.00"
                          style={{ width: '100%', padding: '8px 10px', border: `2px solid ${parseFloat(txForm[f.key] || 0) > 0 ? f.color : '#d1d5db'}`, borderRadius: 6, fontSize: 14, fontWeight: 600, boxSizing: 'border-box' }} />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#f9fafb', borderRadius: 6, fontSize: 13, marginTop: 8 }}>
                    <span style={{ color: '#6b7280' }}>Total</span>
                    <span style={{ fontWeight: 800, color: '#1d4ed8' }}>{curSym}{(parseFloat(txForm.cash_amount || 0) + parseFloat(txForm.bank_amount || 0) + parseFloat(txForm.momo_amount || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  </div>
                </div>

                <div className="form-group">
                  <label>Note</label>
                  <input value={txForm.description} onChange={e => setTxForm({ ...txForm, description: e.target.value })} placeholder="optional" />
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn btn-secondary" onClick={() => setShowTxForm(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={saveTx} disabled={savingTx}>{savingTx ? 'Saving...' : 'Record'}</button>
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

export default LoanAccount;
