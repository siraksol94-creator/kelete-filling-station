// HQ AP Approvals queue (v1.13.30).
//
// Kelete's payable workflow: Store Manager confirms the GRN â†’ Accounts
// clerk checks â†’ Finance Head approves â†’ Main Cashier records payment.
// Each stage stamps who + when on hq_confirmed_grn_totals. Send-Back
// isn't exposed in this UI per user choice (Option A / delete-only
// remediation); the backend endpoint stays wired if we ever change our
// mind.
//
// v1.13.33 â€” added scrollable rows container + View Details modal so
// checkers/approvers/cashiers can inspect items + invoice attachment
// before clicking through.
import React, { useEffect, useState } from 'react';
import { getApApprovalQueue, apConfirmDelivery, apPendingCredits, confirmCreditNote, apCheck, apApprove, apApproveBatch, apConfirmReview, apUnconfirmReview,
         apCheckCredit, apConfirmCredit, apUnconfirmCredit, apApproveCreditBatch, apSendBackCredit, createApPayment, createApPaymentBatch, getHqGrnDetail, apSendBack, getApRejectReasons } from '../services/api';
import InvoiceAttachment from '../components/InvoiceAttachment';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import { FiCheck, FiCheckCircle, FiDollarSign, FiRefreshCw, FiClock, FiUser, FiFileText, FiEye, FiX, FiPaperclip, FiXCircle, FiChevronDown, FiChevronRight } from 'react-icons/fi';

const STATUS_META = {
  // 2026-09-06 â€” the delivery confirmation, in front of everything else.
  // Every GRN lands here when it is generated and waits while the depot
  // finishes offloading and raises whatever credits the truck produced. The
  // Store Manager confirms once, against the supplier's invoice - which
  // arrives by WhatsApp when offloading is done, and is why nothing needs a
  // "returns complete" button.
  UNCONFIRMED: { label: 'Awaiting Confirmation', color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
  PENDING:  { label: 'Awaiting Check',    color: '#6b7280', bg: '#f3f4f6', border: '#e5e7eb' },
  // 2026-08-31 â€” the CHECKED stage now has two halves: Finance has to open
  // and confirm each GRN, then approve the confirmed ones as a batch. The tab
  // is named for the action that actually gates it, and the row badge below
  // switches to 'Awaiting Approval' once a row has been confirmed â€” a row
  // reading "Awaiting Approval" when nobody has looked at it was a lie.
  // 2026-09-06 â€” renamed from "Awaiting Confirmation". That name now belongs
  // to the Store Manager's stage above, and this one is Finance's approval -
  // which is what the code has always called it in its own messages.
  CHECKED:  { label: 'Awaiting Approval', color: '#b45309', bg: '#fef3c7', border: '#fde68a' },
  APPROVED: { label: 'Ready for Payment', color: '#0e7490', bg: '#cffafe', border: '#67e8f9' },
  // 2026-08-30 â€” a part-paid GRN still owes money, so it keeps the Ready for
  // Payment tab and is badged Partially Paid. It used to be stamped PAID on
  // any payment at all and vanish into the Paid tab with the balance hidden.
  PARTIAL:  { label: 'Partially Paid',    color: '#b45309', bg: '#fef3c7', border: '#fcd34d' },
  PAID:     { label: 'Paid',              color: '#166534', bg: '#dcfce7', border: '#86efac' },
  ALL:      { label: 'All',               color: '#334155', bg: '#f1f5f9', border: '#cbd5e1' },
};
// PARTIAL is not its own tab â€” the backend returns it alongside APPROVED so
// everything still owed sits together.
// ALL sits last so the workflow order reads left to right and the default
// landing tab is unchanged.
const TABS = ['UNCONFIRMED', 'PENDING', 'CHECKED', 'APPROVED', 'PAID', 'ALL'];

const fmtDate = (s) => s ? new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'â€”';

// v1.10.3 â€” cross-subdomain URL for branch-hosted invoice photos. The
// upload landed in TENANTS_DIR/<slug>/uploads/, so we point the browser at
// <slug>.<apex>/uploads/<path>. Same helper as HqGrnArchive.
function branchUploadUrl(branchSlug, path) {
  if (!path || !branchSlug) return null;
  const currentHost = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
  if (currentHost.startsWith(`${branchSlug}.`)) return `/uploads/${path}`;
  const parts = currentHost.split('.');
  const apex = parts.length > 2 ? parts.slice(1).join('.') : currentHost;
  const proto = (typeof window !== 'undefined' && window.location.protocol) || 'https:';
  return `${proto}//${branchSlug}.${apex}/uploads/${path}`;
}

const HqApApprovals = () => {
  const { hasPermission, hasPageAccess } = useAuth();
  const { symbol } = useCurrency();
  // 2026-08-30 â€” View is sight only; Add, Edit and Delete each grant the
  // action. Delete used to be ignored, so a user given only Delete on
  // AP - Approve could open the page and do nothing, with no hint why.
  const canAct = (page) => ['Add', 'Edit', 'Delete'].some(a => hasPermission(`${page}:${a}`));
  const canConfirm = canAct('APConfirm');
  const canCheck   = canAct('APCheck');
  const canApprove = canAct('APApprove');
  const canPay     = canAct('APPay');
  // The two read-only views are gated on their own permissions.
  const canSeePaid = hasPageAccess('APPaid');
  const canSeeAll  = hasPageAccess('APAll');

  // 2026-09-12 â€” opens on Awaiting Confirmation, the first stage a GRN lands
  // in. It used to open on PENDING (Awaiting Check), so the depot's unconfirmed
  // deliveries sat a tab away and were only found by clicking.
  const [tab, setTab] = useState('UNCONFIRMED');
  const [rows, setRows] = useState([]);
  // 2026-08-30 â€” narrow the queue by supplier, or by GRN / PO / invoice number.
  // Client-side over the rows already fetched, so it is instant and the tab
  // counts stay honest (they count everything, the list shows the match).
  const [rejectReasons, setRejectReasons] = useState([]);
  const [supplierFilter, setSupplierFilter] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [payModal, setPayModal] = useState(null); // { row, amount, paidFrom }
  // 2026-08-30 â€” batch payment: one amount settling several GRNs of ONE
  // supplier. Selection is held as a Set of grn_sync_id; batchSupplier locks
  // the batch to the first supplier picked, because the payment row carries a
  // single supplier and a mixed batch would file another supplier's money here.
  const [batchSel, setBatchSel] = useState(() => new Set());
  const [batchSupplier, setBatchSupplier] = useState(null);
  const [batchModal, setBatchModal] = useState(null); // { amount, paidFrom, busy }
  // Batches start collapsed â€” the point of the grouping is a shorter queue.
  const [expandedBatches, setExpandedBatches] = useState(() => new Set());
  const [detailModal, setDetailModal] = useState(null); // { row, grn, items, credit_notes, loading, error }

  const load = async (nextTab = tab) => {
    setLoading(true);
    try {
      const { data } = await getApApprovalQueue(nextTab);
      setRows(data?.rows || []);
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
    setLoading(false);
  };
  // If the selected tab is one the user may not see (Paid / All), drop back to
  // the work queue rather than showing an empty page with no explanation.
  useEffect(() => {
    if ((tab === 'PAID' && !canSeePaid) || (tab === 'ALL' && !canSeeAll)) setTab('PENDING');
  /* eslint-disable-next-line */ }, [canSeePaid, canSeeAll]);
  useEffect(() => { load(tab); /* eslint-disable-next-line */ }, [tab]);
  // Previously-used reject reasons, fetched once so the panel can offer them.
  useEffect(() => { loadRejectReasons(); /* eslint-disable-next-line */ }, []);

  const runAction = async (action, row, closeDetail = false) => {
    setMessage(null);
    try {
      await action(row.grn_sync_id);
      if (closeDetail) setDetailModal(null);
      load();
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
  };

  // 2026-08-30 â€” reject: send the GRN back one stage with a reason.
  const doReject = async (reason) => {
    setMessage(null);
    const row = detailModal?.row;
    if (!row) return;
    try {
      const res = await apSendBack(row.grn_sync_id, reason);
      setDetailModal(null);
      setMessage({ type: 'ok', text: `Sent back to ${res?.data?.status === 'CHECKED' ? 'Awaiting Approval' : 'Awaiting Check'}` });
      loadRejectReasons();   // the reason just used becomes a suggestion
      load();
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
  };

  const loadRejectReasons = async () => {
    try {
      const res = await getApRejectReasons();
      setRejectReasons(res.data?.reasons || []);
    } catch (_) { /* suggestions are a convenience â€” never block the page */ }
  };

  // 2026-08-30 â€” pre-fill the BALANCE, not the full payable: on a part-paid
  // GRN the cashier would otherwise be offered the whole amount again.
  const openPay = (row) => {
    const remaining = parseFloat(row.remaining_amount);
    const amount = Number.isFinite(remaining) && remaining > 0 ? remaining : (row.final_payable || 0);
    setPayModal({ row, amount: String(amount), paidFrom: 'Bank' });
  };

  const openDetail = async (row) => {
    // 2026-08-31 â€” a standalone credit note has no GRN behind it, so there is
    // nothing to fetch. Everything worth showing is already on the row.
    if (row.is_credit) {
      setDetailModal({ row, grn: null, items: [], credit_notes: [], loading: false, error: null });
      return;
    }
    setDetailModal({ row, grn: null, items: [], credit_notes: [], loading: true, error: null });
    try {
      const { data } = await getHqGrnDetail(row.grn_sync_id);
      setDetailModal({
        row,
        grn: data?.grn || {},
        items: data?.items || [],
        credit_notes: data?.credit_notes || [],
        loading: false,
        error: null,
      });
    } catch (e) {
      setDetailModal({
        row, grn: null, items: [], credit_notes: [], loading: false,
        error: e?.response?.data?.error || e.message,
      });
    }
  };

  const submitPay = async () => {
    if (!payModal) return;
    const { row, amount, paidFrom } = payModal;
    const amt = parseFloat(amount) || 0;
    if (!(amt > 0)) { setMessage({ type: 'err', text: 'Amount must be > 0' }); return; }
    try {
      // Route the payment through the standard AP payments endpoint â€”
      // it will refuse anything that isn't APPROVED, and stamp the
      // snapshot to PAID on success.
      // 2026-08-29 â€” record WHICH DRAWER the money left, not just that it was
      // Kwacha. All three branches used to set k_amount, so the Paid From
      // choice was collected and thrown away: every payment landed in the
      // "Bank" tile whether it was cash, bank or mobile money.
      //
      // Only ONE field is set. Writing both a drawer amount and a currency
      // amount makes the Cash Book count the same payment twice, once per
      // tile â€” K60,000 paid appearing as K120,000 in Supplier Paid.
      const paymentAmt =
          paidFrom === 'Bank'         ? { bank_amount: amt }
        : paidFrom === 'Mobile Money' ? { momo_amount: amt }
        :                               { cash_amount: amt };
      await createApPayment({
        supplier_id: row.supplier_id,
        supplier_sync_id: row.supplier_sync_id,
        supplier_name: row.supplier_name,
        amount: amt,
        ...paymentAmt,
        date: new Date().toISOString().slice(0, 10),
        paid_from: paidFrom,
        description: `GRN ${row.grn_number} â€” Invoice ${row.invoice_number || 'â€”'}`,
        grn_sync_id: row.grn_sync_id,
      });
      setPayModal(null);
      setDetailModal(null);
      setMessage({ type: 'ok', text: `Paid ${symbol}${amt.toLocaleString()} to ${row.supplier_name}` });
      load();
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
  };

  const fmtMoney = (n) => `${symbol}${(parseFloat(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // â”€â”€ Batch payment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // What a row still owes. remaining_amount is supplied by the queue, but fall
  // back to the payable so a row from an older server build is still selectable
  // rather than silently counting as zero outstanding.
  const rowOutstanding = (r) => {
    const rem = parseFloat(r.remaining_amount);
    if (Number.isFinite(rem) && rem > 0) return rem;
    if (parseFloat(r.paid_amount || 0) > 0) return 0;
    return parseFloat(r.final_payable || 0) || 0;
  };

  // Selection serves two stages now:
  //   Awaiting Approval â†’ approve a supplier's invoices as ONE payment batch
  //   Ready for Payment â†’ pay several GRNs with one amount
  // Same selection mechanics, different verb at the end.
  const selectMode =
      (tab === 'CHECKED'  && canApprove) ? 'approve'
    : (tab === 'APPROVED' && canPay)     ? 'pay'
    : null;
  const batchSelectable = !!selectMode;
  // 2026-08-31 â€” a row can only join an approval batch once Finance has opened
  // it and confirmed. Before this the checkbox sat on the row, so an entire
  // page could be approved without anything being read.
  const isConfirmed = (r) => !!r.review_confirmed_at;

  // Confirm Delivery â€” its own small modal rather than a row button, because
  // it takes a file. { row, attachment, busy, error }
  const [confirmModal, setConfirmModal] = useState(null);
  // 2026-09-12 â€” "this delivery has no credit note at all". Two separate
  // things have to be empty: cn_total, which is what has already been credited
  // against the GRN, and the pending list, which only carries credits nobody
  // has agreed yet (branch_confirmed_at IS NULL). An empty pending list alone
  // would also be true of a delivery whose credit was already settled.
  // `credits === null` means still loading, so this stays false until it lands.
  const grnHasNoCredit = (m) => !!m
    && !(parseFloat(m.row?.cn_total) > 0)
    && Array.isArray(m.credits) && m.credits.length === 0;
  const openConfirm = async (row) => {
    setConfirmModal({ row, attachment: null, busy: false, error: '', credits: null, noCnAck: false });
    try {
      const r = await apPendingCredits(row.grn_sync_id);
      setConfirmModal(m => (m && m.row.grn_sync_id === row.grn_sync_id
        ? { ...m, credits: r.data?.rows || [] } : m));
    } catch (_) {
      setConfirmModal(m => (m ? { ...m, credits: [] } : m));
    }
  };
  // Confirming a credit here is the same action as on the Credit Notes page â€”
  // same endpoint, same rule that only HQ may do it. Once it is agreed the
  // payable moves, so the row is refreshed underneath.
  const confirmOneCredit = async (cn) => {
    setConfirmModal(m => ({ ...m, busy: true, error: '' }));
    try {
      await confirmCreditNote(cn.sync_id);
      const r = await apPendingCredits(confirmModal.row.grn_sync_id);
      setConfirmModal(m => ({ ...m, busy: false, credits: r.data?.rows || [] }));
      load();
    } catch (err) {
      setConfirmModal(m => ({ ...m, busy: false, error: err?.response?.data?.error || 'Could not confirm that credit.' }));
    }
  };
  const submitConfirm = async () => {
    if (!confirmModal) return;
    setConfirmModal(m => ({ ...m, busy: true, error: '' }));
    try {
      await apConfirmDelivery(confirmModal.row.grn_sync_id, confirmModal.attachment || '');
      setConfirmModal(null);
      setMessage({ type: 'ok', text: 'Delivery confirmed â€” sent to Awaiting Check.' });
      load();
    } catch (err) {
      setConfirmModal(m => ({ ...m, busy: false, error: err?.response?.data?.error || 'Could not confirm.' }));
    }
  };
  const selectableRow = (r) => selectMode !== 'approve' || isConfirmed(r);

  const clearBatch = () => { setBatchSel(new Set()); setBatchSupplier(null); };

  const toggleBatch = (r) => {
    setBatchSel(prev => {
      const next = new Set(prev);
      if (next.has(r.grn_sync_id)) {
        next.delete(r.grn_sync_id);
        if (next.size === 0) setBatchSupplier(null);
      } else {
        next.add(r.grn_sync_id);
        if (next.size === 1) setBatchSupplier(r.supplier_name || null);
      }
      return next;
    });
  };

  // From `rows`, not visibleRows: visibleRows is declared further down, and
  // reading it here would throw before initialisation. Sourcing the selection
  // from the full queue also means changing the supplier filter mid-selection
  // does not silently drop GRNs the user already ticked.
  const batchRows = rows.filter(r => batchSel.has(r.grn_sync_id));
  // 2026-08-31 â€” a selection can now hold both: GRNs are what is owed, credit
  // notes come off it. GRN1 + GRN2 - SCN001.
  const batchGrns    = batchRows.filter(r => !r.is_credit);
  const batchCredits = batchRows.filter(r =>  r.is_credit);
  const batchGrnTotal    = batchGrns.reduce((n, r) => n + rowOutstanding(r), 0);
  const batchCreditTotal = batchCredits.reduce((n, r) => n + (parseFloat(r.final_payable) || 0), 0);
  const batchTotal = batchGrnTotal - batchCreditTotal;

  // Approve the selected GRNs together. They become one batch and land in
  // Ready for Payment as a single collapsible line.
  // 2026-08-31 â€” attaching a credit at check time.
  //
  // Which GRN a standalone credit belongs against is a judgement, not a
  // calculation: splitting it across invoices by formula would have been a
  // guess presented as a fact. The checker picks, and from then on the credit
  // behaves exactly like one raised at Generate GRN.
  //
  // Only that supplier's unpaid GRNs are offered â€” a paid one cannot absorb a
  // credit, the money has already gone.
  const attachableGrnsFor = (creditRow) => rows.filter(r =>
    !r.is_credit &&
    r.supplier_name === creditRow.supplier_name &&
    r.ap_status !== 'PAID' &&
    (parseFloat(r.final_payable) || 0) > 0
  );

  const checkCredit = async (row, grnSyncId) => {
    if (!grnSyncId) { setMessage({ type: 'err', text: 'Choose which GRN this credit applies to.' }); return; }
    try {
      const { data } = await apCheckCredit(row.grn_sync_id, grnSyncId);
      setDetailModal(null);
      setMessage({
        type: 'ok',
        text: `${row.grn_number} applied to ${data?.attached_to || 'the GRN'}`
            + (data?.final_payable != null ? ` â€” now payable ${fmtMoney(data.final_payable)}` : ''),
      });
      load();
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
  };

  const toggleReview = async (row, confirm) => {
    try {
      const fn = row.is_credit
        ? (confirm ? apConfirmCredit : apUnconfirmCredit)
        : (confirm ? apConfirmReview : apUnconfirmReview);
      await fn(row.grn_sync_id);
      setMessage({ type: 'ok', text: confirm
        ? `${row.grn_number} confirmed â€” tick it and approve when ready.`
        : `${row.grn_number} unconfirmed.` });
      setDetailModal(null);
      load();
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
  };

  const submitApproveBatch = async () => {
    if (batchRows.length === 0) return;
    try {
      // GRNs and credits live in different tables and have their own endpoint
      // each; a mixed selection approves both, then reports once.
      if (batchCredits.length > 0) {
        await apApproveCreditBatch(batchCredits.map(r => r.grn_sync_id));
      }
      if (batchGrns.length === 0) {
        clearBatch();
        setMessage({ type: 'ok', text: `Approved ${batchCredits.length} credit note(s).` });
        load();
        return;
      }
      const { data } = await apApproveBatch(batchGrns.map(r => r.grn_sync_id));
      clearBatch();
      setMessage({
        type: 'ok',
        text: data?.batch_number
          ? `Approved ${data.count} GRNs as ${data.batch_number} Â· ${fmtMoney(data.total)} to ${data.supplier_name || 'supplier'}`
          : `Approved ${data?.count || batchRows.length} GRN(s)`,
      });
      load();
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
  };

  const submitBatch = async () => {
    if (!batchModal) return;
    const amt = parseFloat(batchModal.amount) || 0;
    if (!(amt > 0)) { setMessage({ type: 'err', text: 'Amount must be > 0' }); return; }
    // The server refuses overpayment independently â€” this is only so the user
    // is told before submitting, not the gate.
    if (amt > batchTotal + 0.01) {
      setMessage({ type: 'err', text: `That is ${fmtMoney(amt - batchTotal)} more than the selected GRNs owe. Select another GRN, or reduce the amount.` });
      return;
    }
    const paidFrom = batchModal.paidFrom;
    const paymentAmt =
        paidFrom === 'Bank'         ? { bank_amount: amt }
      : paidFrom === 'Mobile Money' ? { momo_amount: amt }
      :                               { cash_amount: amt };
    setBatchModal(m => ({ ...m, busy: true }));
    try {
      const { data } = await createApPaymentBatch({
        supplier_id:      batchGrns[0]?.supplier_id,
        supplier_sync_id: batchGrns[0]?.supplier_sync_id,
        supplier_name:    batchGrns[0]?.supplier_name,
        grn_sync_ids:     batchGrns.map(r => r.grn_sync_id),
        credit_sync_ids:  batchCredits.map(r => r.grn_sync_id),
        amount: amt,
        ...paymentAmt,
        date: new Date().toISOString().slice(0, 10),
        paid_from: paidFrom,
      });
      const paidCount = (data?.allocations || []).filter(a => a.status === 'PAID').length;
      const partial   = (data?.allocations || []).find(a => a.status === 'PARTIAL');
      setBatchModal(null);
      clearBatch();
      setMessage({
        type: 'ok',
        text: `Paid ${fmtMoney(amt)} to ${data?.supplier_name || 'supplier'} â€” `
            + `${paidCount} GRN${paidCount === 1 ? '' : 's'} settled`
            + (partial ? `, ${partial.grn_number} part-paid (${fmtMoney(partial.remaining_after)} left)` : '')
            + `. Ref ${data?.batch_ref || ''}`,
      });
      load();
    } catch (e) {
      setBatchModal(m => m ? ({ ...m, busy: false }) : m);
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
  };

  const AuditStrip = ({ r }) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11, color: '#6b7280', marginTop: 6 }}>
      <span title="HQ Store Manager confirmed the GRN"><FiUser size={11} /> Confirmed: <strong>{r.confirmed_by_name || 'â€”'}</strong> Â· {fmtDate(r.confirmed_at)}</span>
      {r.checked_at && <span title="Accounts clerk checked"><FiCheck size={11} /> Checked: <strong>{r.checked_by_name || 'â€”'}</strong> Â· {fmtDate(r.checked_at)}</span>}
      {r.approved_at && <span title="Finance Head approved"><FiCheckCircle size={11} /> Approved: <strong>{r.approved_by_name || 'â€”'}</strong> Â· {fmtDate(r.approved_at)}</span>}
      {r.paid_at && <span title="Cashier paid"><FiDollarSign size={11} /> Paid: <strong>{r.paid_by_name || 'â€”'}</strong> Â· {fmtDate(r.paid_at)}</span>}
    </div>
  );


  // Supplier list for the picker, from what is actually in the queue.
  const supplierOptions = Array.from(
    new Set(rows.map(r => r.supplier_name).filter(Boolean))
  ).sort((a, b) => a.localeCompare(b));

  const visibleRows = rows.filter(r => {
    if (supplierFilter && r.supplier_name !== supplierFilter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return [r.grn_number, r.po_number, r.invoice_number]
      .some(v => String(v || '').toLowerCase().includes(q));
  });

  // 2026-08-30 â€” collapse a payment batch into one line.
  //
  // GRNs approved together share ap_batch_ref. They render as a single header
  // showing the supplier, the batch number and the combined outstanding, and
  // expand to the individual invoices. A batch with only one member left â€”
  // because the others were sent back â€” renders as an ordinary row, since the
  // grouping is presentation and a "batch of one" is just an invoice.
  const displayItems = (() => {
    const items = [];
    const done  = new Set();
    for (const r of visibleRows) {
      const ref = r.ap_batch_ref;
      if (!ref) { items.push({ type: 'row', r }); continue; }
      if (done.has(ref)) continue;
      done.add(ref);
      const members = visibleRows.filter(x => x.ap_batch_ref === ref);
      if (members.length < 2) { items.push({ type: 'row', r }); continue; }
      items.push({ type: 'batch', ref, members });
      if (expandedBatches.has(ref)) {
        members.forEach(m => items.push({ type: 'row', r: m, child: true }));
      }
    }
    return items;
  })();

  return (
    <div style={{ padding: 24, background: '#f8fafc', height: '100vh', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12, flexShrink: 0 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>AP Approvals</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            HQ Store Manager confirms â†’ Accounts checks â†’ Finance approves â†’ Cashier pays.
          </p>
        </div>
        <button onClick={() => load()} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
          <FiRefreshCw size={14} /> Refresh
        </button>
      </div>

      {message && (
        <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, fontSize: 13, flexShrink: 0,
                       background: message.type === 'ok' ? '#f0fdf4' : '#fef2f2',
                       color:      message.type === 'ok' ? '#166534' : '#b91c1c',
                       border:     `1px solid ${message.type === 'ok' ? '#86efac' : '#fecaca'}` }}>
          {message.text}
        </div>
      )}

      {/* Filters â€” supplier picker + free search over GRN / PO / invoice */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', flexShrink: 0 }}>
        <select value={supplierFilter} onChange={e => setSupplierFilter(e.target.value)}
                style={{ padding: '8px 12px', borderRadius: 8, border: '1.5px solid #cbd5e1', fontSize: 13,
                         fontWeight: 600, color: '#334155', background: '#fff', minWidth: 220 }}>
          <option value="">All suppliers ({supplierOptions.length})</option>
          {supplierOptions.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
        <input value={search} onChange={e => setSearch(e.target.value)}
               placeholder="Search GRN, PO or invoice number..."
               style={{ padding: '8px 12px', borderRadius: 8, border: '1.5px solid #cbd5e1', fontSize: 13,
                        flex: 1, minWidth: 220 }} />
        {(supplierFilter || search) && (
          <button onClick={() => { setSupplierFilter(''); setSearch(''); }}
                  style={{ padding: '8px 14px', borderRadius: 8, border: '1.5px solid #cbd5e1',
                           background: '#fff', color: '#334155', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
            Clear
          </button>
        )}
        <span style={{ alignSelf: 'center', fontSize: 12, color: '#6b7280' }}>
          {visibleRows.length} of {rows.length}
        </span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '2px solid #e5e7eb', flexShrink: 0 }}>
        {TABS.filter(t => (t !== 'PAID' || canSeePaid) && (t !== 'ALL' || canSeeAll)).map(t => {
          const meta = STATUS_META[t];
          const active = tab === t;
          return (
            <button key={t} onClick={() => { setTab(t); clearBatch(); }}
                    style={{ padding: '10px 18px', border: 'none', background: 'none', cursor: 'pointer',
                             fontSize: 13, fontWeight: 700,
                             color: active ? meta.color : '#6b7280',
                             borderBottom: active ? `3px solid ${meta.color}` : '3px solid transparent',
                             marginBottom: -2 }}>
              {meta.label}
            </button>
          );
        })}
      </div>

      {/* Rows â€” scrollable so the header + tabs stay pinned */}
      {/* Extra room at the foot of the list while the floating batch bar is up,
          so the last row's View button is never sitting underneath it. */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, overflowY: 'auto', flex: 1, minHeight: 0,
                    paddingBottom: (batchSelectable && batchRows.length > 0) ? 84 : 0 }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loadingâ€¦</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Nothing to show for {STATUS_META[tab].label}.</div>
        ) : displayItems.map(item => {
          // â”€â”€ Batch header: one line standing for several invoices â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          if (item.type === 'batch') {
            const { ref, members } = item;
            const open  = expandedBatches.has(ref);
            const total = members.reduce((n, m) => n + rowOutstanding(m), 0);
            const first = members[0];
            const allPaid = members.every(m => rowOutstanding(m) <= 0.01);
            return (
              <div key={`batch-${ref}`} style={{ borderBottom: '1px solid #e5e7eb', background: '#f8fafc' }}>
                <div style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <button onClick={() => setExpandedBatches(prev => {
                            const next = new Set(prev);
                            if (next.has(ref)) next.delete(ref); else next.add(ref);
                            return next;
                          })}
                          title={open ? 'Collapse' : 'Show the invoices in this batch'}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280',
                                   fontSize: 13, padding: 0, display: 'flex', alignItems: 'center' }}>
                    {open ? <FiChevronDown size={18} /> : <FiChevronRight size={18} />}
                  </button>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{first.supplier_name || 'Supplier'}</span>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', fontWeight: 700, color: '#4f46e5',
                                   background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 10, padding: '2px 8px' }}>
                      {first.ap_batch_number || 'BATCH'}
                    </span>
                    <span style={{ fontSize: 11, color: '#6b7280' }}>Â· {members.length} GRNs</span>
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: '#374151' }}>
                      Outstanding <strong style={{ fontSize: 15, color: '#111827' }}>{fmtMoney(total)}</strong>
                    </span>
                    {canPay && !allPaid && (
                      <button onClick={() => {
                                setBatchSel(new Set(members.map(m => m.grn_sync_id)));
                                setBatchSupplier(first.supplier_name || null);
                                setBatchModal({ amount: String(total.toFixed(2)), paidFrom: 'Bank', busy: false });
                              }}
                              style={{ background: '#dc2626', border: 'none', color: '#fff', borderRadius: 8,
                                       padding: '7px 16px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                        Pay Batch
                      </button>
                    )}
                  </div>
                </div>
                <div style={{ padding: '0 18px 12px 48px', fontSize: 11, color: '#6b7280' }}>
                  Approved: <strong>{first.approved_by_name || 'â€”'}</strong> Â· {fmtDate(first.approved_at)}
                  {!open && (
                    <> Â· <span style={{ color: '#9ca3af' }}>
                      {members.map(m => m.invoice_number ? `${m.grn_number} (Inv ${m.invoice_number})` : m.grn_number).join(', ')}
                    </span></>
                  )}
                </div>
              </div>
            );
          }

          const r = item.r;
          const meta = STATUS_META[r.ap_status || 'PENDING'];
          return (
            <div key={r.grn_sync_id} style={{ padding: '16px 18px', borderBottom: '1px solid #f1f5f9', display: 'flex', flexDirection: 'column', gap: 8,
                                              ...(tab === 'CHECKED' && isConfirmed(r) ? { background: '#f6fefa' } : null),
                                              ...(item.child ? { paddingLeft: 48, background: '#fcfdff', borderLeft: '3px solid #c7d2fe' } : null) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  {/* 2026-08-30 â€” batch select. Only on Ready for Payment, only
                      for a user who may pay, and only while the row still owes
                      something. Rows of another supplier grey out once the
                      batch has one, since a payment row carries one supplier. */}
                  {batchSelectable && (() => {
                    // In approve mode a zero-payable GRN is still approvable â€”
                    // the "must owe something" rule only makes sense when the
                    // next step is handing over money.
                    const owes  = selectMode === 'pay' ? rowOutstanding(r) > 0.01 : true;
                    const other = batchSupplier && r.supplier_name !== batchSupplier;
                    const unreviewed = !selectableRow(r);
                    const off   = !owes || other || unreviewed;
                    return (
                      <input
                        type="checkbox"
                        checked={batchSel.has(r.grn_sync_id)}
                        disabled={off}
                        onChange={() => toggleBatch(r)}
                        title={unreviewed ? 'Open this GRN and confirm it first'
                             : other ? `Batch is for ${batchSupplier} â€” clear it to pay another supplier`
                             : (!owes ? 'Nothing outstanding on this GRN' : 'Include in the batch')}
                        style={{ width: 16, height: 16, cursor: off ? 'not-allowed' : 'pointer',
                                 alignSelf: 'center', opacity: off ? 0.35 : 1, accentColor: '#dc2626' }}
                      />
                    );
                  })()}
                  <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>{r.supplier_name || 'Supplier'}</span>
                  {/* 2026-08-31 â€” a standalone credit reads as a credit, not as
                      another invoice: its own label, and the amount negative. */}
                  {r.is_credit ? (
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#166534', background: '#dcfce7',
                                   border: '1px solid #bbf7d0', borderRadius: 10, padding: '2px 8px' }}>
                      CREDIT Â· {r.grn_number}
                    </span>
                  ) : (
                    <span style={{ fontSize: 11, color: '#6b7280' }}>Â· GRN {r.grn_number}</span>
                  )}
                  {r.po_number && <span style={{ fontSize: 11, color: '#6b7280' }}>Â· PO {r.po_number}</span>}
                  <span style={{ fontSize: 11, color: '#6b7280' }}>Â· Branch {r.branch_name || r.branch_slug}</span>
                  {r.invoice_number && <span style={{ fontSize: 11, color: '#6b7280', display: 'inline-flex', alignItems: 'center', gap: 3 }}><FiFileText size={11} /> Inv {r.invoice_number}</span>}
                </div>
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  {/* Confirmed rows read differently, so an approver can see at
                      a glance what is still waiting to be looked at. */}
                  {tab === 'CHECKED' && isConfirmed(r) && (
                    <span title={`Confirmed by ${r.review_confirmed_by_name || 'finance'}`}
                          style={{ padding: '3px 9px', borderRadius: 14, fontSize: 11, fontWeight: 700,
                                   background: '#dcfce7', color: '#166534', border: '1px solid #bbf7d0',
                                   display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <FiCheckCircle size={11} /> Confirmed
                    </span>
                  )}
                  <span style={{ padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 700,
                                 background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
                    {/* A confirmed row genuinely IS awaiting approval; an
                        unconfirmed one is waiting to be looked at. */}
                    {meta.label}
                  </span>
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ fontSize: 13, color: '#374151' }}>
                  {r.is_credit ? (
                    <span>Credit <strong style={{ color: '#166534', fontSize: 15 }}>âˆ’ {fmtMoney(r.final_payable)}</strong>
                      {r.reason && <span style={{ marginLeft: 10, color: '#6b7280' }}>Â· {r.reason}</span>}
                    </span>
                  ) : (
                  <span>Subtotal <strong>{fmtMoney(r.items_subtotal)}</strong></span>
                  )}
                  {!r.is_credit && <>
                  {parseFloat(r.cn_total) > 0 && <span style={{ marginLeft: 12, color: '#dc2626' }}>âˆ’ CN <strong>{fmtMoney(r.cn_total)}</strong></span>}
                  <span style={{ marginLeft: 12 }}>= Payable <strong style={{ color: '#111827', fontSize: 15 }}>{fmtMoney(r.final_payable)}</strong></span>
                  </>}
                  {/* 2026-08-30 â€” what has been paid and what is still owed.
                      The card showed the payable alone, so a part payment was
                      invisible and a short-paid GRN read as settled. */}
                  {parseFloat(r.paid_amount || 0) > 0 && (
                    <span style={{ marginLeft: 12 }}>
                      Â· Paid <strong style={{ color: '#166534' }}>{fmtMoney(r.paid_amount)}</strong>
                      {parseFloat(r.remaining_amount || 0) > 0 && (
                        <> Â· Remaining <strong style={{ color: '#b45309' }}>{fmtMoney(r.remaining_amount)}</strong></>
                      )}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => openDetail(r)}
                          style={{ padding: '7px 14px', borderRadius: 8, border: '1.5px solid #cbd5e1', background: '#fff', color: '#334155', cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <FiEye size={12} /> View
                  </button>
                  {/* The one action that is NOT in the detail modal: it needs
                      a file, and the decision it represents - "this delivery
                      and its credits are what the supplier says" - is made
                      against the paper, not against the line items. */}
                  {r.ap_status === 'UNCONFIRMED' && !r.is_credit && canConfirm && (
                    <button onClick={() => openConfirm(r)}
                            style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#7c3aed', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <FiCheckCircle size={12} /> Confirm Delivery
                    </button>
                  )}
                  {/* 2026-08-30 â€” Check / Approve / Record Payment have moved
                      into the detail modal. Approving money from a summary row
                      means acting on a supplier name and a total, without
                      having opened the line items, the invoice attachment or
                      what has already been paid. The modal is where all of
                      that is, so that is where the decision belongs. */}
                </div>
              </div>
              {r.sent_back_reason && r.ap_status === 'PENDING' && (
                <div style={{ padding: '6px 10px', borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', fontSize: 11, color: '#b91c1c' }}>
                  <FiClock size={11} style={{ verticalAlign: 'middle' }} /> Sent back from {r.sent_back_from_stage} by <strong>{r.sent_back_by_name}</strong>: {r.sent_back_reason}
                </div>
              )}
              <AuditStrip r={r} />
            </div>
          );
        })}
      </div>

      {confirmModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
             onClick={() => { if (!confirmModal.busy) setConfirmModal(null); }}>
          <div onClick={e => e.stopPropagation()}
               style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 520, padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 17, color: '#0f172a' }}>Confirm {confirmModal.row.grn_number}</h3>
            <p style={{ margin: '0 0 14px', fontSize: 13, color: '#64748b' }}>
              {confirmModal.row.supplier_name} Â· {confirmModal.row.branch_name || confirmModal.row.branch_slug}
              {confirmModal.row.invoice_number ? ` Â· Invoice ${confirmModal.row.invoice_number}` : ''}
            </p>
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', fontSize: 13, marginBottom: 14 }}>
              <div>Subtotal <strong>{fmtMoney(confirmModal.row.items_subtotal)}</strong></div>
              {parseFloat(confirmModal.row.cn_total) > 0 && (
                <div style={{ color: '#dc2626' }}>Credit notes <strong>âˆ’ {fmtMoney(confirmModal.row.cn_total)}</strong></div>
              )}
              <div style={{ marginTop: 4 }}>Payable <strong style={{ fontSize: 15 }}>{fmtMoney(confirmModal.row.final_payable)}</strong></div>
            </div>
            {/* Credits the depot raised against this delivery and nobody has
                agreed yet. They change what is payable, so the delivery
                cannot be released past them. */}
            {confirmModal.credits === null ? (
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 12 }}>Checking for credit notesâ€¦</div>
            ) : confirmModal.credits.length > 0 && (
              <div style={{ marginBottom: 14, border: '1px solid #fed7aa', background: '#fff7ed', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#9a3412', marginBottom: 6 }}>
                  {confirmModal.credits.length} credit note{confirmModal.credits.length > 1 ? 's' : ''} waiting on this delivery
                </div>
                {confirmModal.credits.map(c => (
                  <div key={c.sync_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, padding: '5px 0', borderTop: '1px solid #fed7aa' }}>
                    <div style={{ fontSize: 12, color: '#7c2d12', minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontFamily: 'monospace' }}>{c.credit_note_number}</div>
                      <div style={{ opacity: 0.85 }}>
                        {c.reason} Â· {fmtMoney(c.amount)}
                        {c.raised_by_name ? ` Â· ${c.raised_by_name}` : ''}
                        {c.raised_by_branch ? ` (${c.raised_by_branch})` : ''}
                      </div>
                      {c.notes && <div style={{ opacity: 0.7, fontStyle: 'italic' }}>{c.notes}</div>}
                    </div>
                    <button onClick={() => confirmOneCredit(c)} disabled={confirmModal.busy}
                      style={{ flexShrink: 0, padding: '6px 12px', background: confirmModal.busy ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: confirmModal.busy ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700 }}>
                      Confirm
                    </button>
                  </div>
                ))}
                <div style={{ fontSize: 11, color: '#9a3412', marginTop: 6, opacity: 0.85 }}>
                  Wrong or disputed? Reject it on the Credit Notes page instead.
                </div>
              </div>
            )}
            {/* 2026-09-12 â€” a delivery with no credit note at all has to be
                asserted, not assumed. Short, damaged and returned goods are
                exactly what gets noticed on the bay and forgotten by the time
                the invoice is confirmed, and once this is confirmed the
                payable is what the supplier says it is. A tick rather than a
                second click on the button, so a double-tap cannot pass it. */}
            {grnHasNoCredit(confirmModal) && (
              <label style={{ display: 'flex', gap: 9, alignItems: 'flex-start', marginBottom: 14, padding: '10px 12px',
                              background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!confirmModal.noCnAck}
                  onChange={e => setConfirmModal(m => ({ ...m, noCnAck: e.target.checked, error: '' }))}
                  style={{ marginTop: 2, flexShrink: 0, width: 16, height: 16, cursor: 'pointer' }} />
                <span style={{ fontSize: 12.5, color: '#92400e', lineHeight: 1.45 }}>
                  <strong>No credit note on this delivery.</strong> Subtotal and payable are the
                  same â€” nothing short, damaged or returned.
                  <span style={{ display: 'block', fontWeight: 700, marginTop: 3 }}>
                    Are you sure? Tick to confirm there is no credit note.
                  </span>
                </span>
              </label>
            )}
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>
              Supplier invoice <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <InvoiceAttachment value={confirmModal.attachment}
                               onChange={(v) => setConfirmModal(m => ({ ...m, attachment: v, error: '' }))} />
            {confirmModal.error && (
              <div style={{ marginTop: 10, padding: '9px 11px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', fontSize: 12.5 }}>
                {confirmModal.error}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={() => setConfirmModal(null)} disabled={confirmModal.busy}
                style={{ padding: '9px 16px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontWeight: 600 }}>
                Cancel
              </button>
              {(() => {
                const blocked = !!(confirmModal.credits && confirmModal.credits.length > 0);
                // Held until the "no credit note" tick above, when there is none.
                const needsAck = grnHasNoCredit(confirmModal) && !confirmModal.noCnAck;
                const off = confirmModal.busy || blocked || needsAck;
                return (
                  <button onClick={submitConfirm} disabled={off}
                    title={blocked ? 'Settle the credit notes above first'
                         : needsAck ? 'Tick the box above to confirm there is no credit note' : ''}
                    style={{ padding: '9px 16px', background: off ? '#9ca3af' : '#7c3aed', color: '#fff', border: 'none', borderRadius: 8, cursor: off ? 'not-allowed' : 'pointer', fontWeight: 700 }}>
                    {confirmModal.busy ? 'Confirmingâ€¦' : blocked ? 'Credits outstanding' : 'Confirm delivery'}
                  </button>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Detail modal â€” items + invoice attachment */}
      {detailModal && (
        <DetailModal
          state={detailModal}
          symbol={symbol}
          fmtMoney={fmtMoney}
          fmtDate={fmtDate}
          onClose={() => setDetailModal(null)}
          onCheck={canCheck
            ? (detailModal.row.is_credit
                ? (grnSyncId) => checkCredit(detailModal.row, grnSyncId)
                : () => runAction(apCheck, detailModal.row, true))
            : null}
          attachOptions={detailModal.row.is_credit ? attachableGrnsFor(detailModal.row) : null}
          onApprove={null}
          onConfirmReview={canApprove ? (confirm) => toggleReview(detailModal.row, confirm) : null}
          isConfirmed={isConfirmed(detailModal.row)}
          onPay={canPay     ? () => { setDetailModal(null); openPay(detailModal.row); } : null}
          onReject={(canCheck || canApprove) ? doReject : null}
          rejectReasons={rejectReasons}
        />
      )}

      {/* 2026-08-30 â€” batch bar. Appears only once something is ticked, so the
          Ready-for-Payment queue looks unchanged until the feature is used. */}
      {batchSelectable && batchRows.length > 0 && (
        // 2026-08-30 â€” floated, not in flow.
        //
        // This page is height:100vh but Layout renders it BELOW a top header
        // bar, so the container's bottom edge sits a header's height off the
        // screen. A bar placed at the end of the flex column is therefore
        // invisible. Nothing else on the page puts controls at the bottom, so
        // the quirk had never surfaced. Anchored to the viewport instead, and
        // to the RIGHT so it clears the sidebar whatever width it is.
        <div style={{ position: 'fixed', bottom: 20, right: 28, zIndex: 1500,
                      padding: '12px 16px', background: '#111827', color: '#fff',
                      borderRadius: 12, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                      boxShadow: '0 10px 30px rgba(0,0,0,0.28)', maxWidth: 'calc(100vw - 300px)' }}>
          <span style={{ fontSize: 13 }}>
            {/* 2026-08-31 â€” say what is actually selected. "3 GRNs" when one of
                them is a credit note reads as more debt, not less. */}
            <strong>{batchGrns.length}</strong> GRN{batchGrns.length === 1 ? '' : 's'}
            {batchCredits.length > 0 && (
              <> âˆ’ <strong>{batchCredits.length}</strong> credit{batchCredits.length === 1 ? '' : 's'}</>
            )}
            {batchSupplier && <> Â· <strong>{batchSupplier}</strong></>}
          </span>
          <span style={{ fontSize: 13, marginLeft: 'auto', textAlign: 'right' }}>
            {batchCredits.length > 0 && (
              <span style={{ opacity: 0.75, marginRight: 10 }}>
                {fmtMoney(batchGrnTotal)} âˆ’ {fmtMoney(batchCreditTotal)} =
              </span>
            )}
            {selectMode === 'approve' ? 'Total' : 'Net'} <strong style={{ fontSize: 15 }}>{fmtMoney(batchTotal)}</strong>
          </span>
          <button onClick={clearBatch}
                  style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.35)', color: '#fff',
                           borderRadius: 8, padding: '7px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            Clear
          </button>
          {selectMode === 'approve' ? (
            <button onClick={submitApproveBatch}
                    title="Approve these together â€” they become one line in Ready for Payment"
                    style={{ background: '#4f46e5', border: 'none', color: '#fff', borderRadius: 8,
                             padding: '8px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              Approve as One Batch
            </button>
          ) : (
            <button onClick={() => setBatchModal({ amount: String(batchTotal.toFixed(2)), paidFrom: 'Bank', busy: false })}
                    style={{ background: '#dc2626', border: 'none', color: '#fff', borderRadius: 8,
                             padding: '8px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
              Pay Selected
            </button>
          )}
        </div>
      )}

      {/* Batch pay modal */}
      {batchModal && (() => {
        const amt      = parseFloat(batchModal.amount) || 0;
        const over     = amt - batchTotal;
        const isOver   = over > 0.01;
        const isShort  = amt > 0 && batchTotal - amt > 0.01;
        // Preview the same oldest-first split the server will perform, so the
        // outcome is visible BEFORE the money moves rather than after.
        const preview = (() => {
          if (!(amt > 0) || isOver) return [];
          // GRNs only: a credit funds the settlement, it does not receive any.
          const sorted = [...batchGrns].sort((a, b) =>
            String(a.date || '').localeCompare(String(b.date || '')) ||
            String(a.grn_number || '').localeCompare(String(b.grn_number || '')));
          // Cash PLUS credit is what settles the GRNs â€” the same figure the
          // server allocates. Previewing the cash alone would show GRNs left
          // part-paid that the payment actually closes.
          let left = amt + batchCreditTotal;
          const out = [];
          for (const r of sorted) {
            if (left <= 0.01) break;
            const owed = rowOutstanding(r);
            const take = Math.min(owed, left);
            out.push({ r, take, after: owed - take });
            left -= take;
          }
          return out;
        })();
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
               onClick={() => !batchModal.busy && setBatchModal(null)}>
            <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520, padding: 22, maxHeight: '86vh', overflowY: 'auto' }}
                 onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700, color: '#111827' }}>Pay Several GRNs</h3>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>
                {batchSupplier} Â· {batchGrns.length} GRN{batchGrns.length === 1 ? '' : 's'}
                {batchCredits.length > 0 && <> Â· {batchCredits.length} credit note{batchCredits.length === 1 ? '' : 's'} applied</>}
                {' '}Â· to pay {fmtMoney(batchTotal)}
              </p>
              {batchCredits.length > 0 && (
                <div style={{ marginBottom: 12, padding: '9px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0',
                              borderRadius: 8, fontSize: 12, color: '#166534' }}>
                  {batchGrns.length} GRN{batchGrns.length === 1 ? '' : 's'} worth <strong>{fmtMoney(batchGrnTotal)}</strong>,
                  less <strong>{fmtMoney(batchCreditTotal)}</strong> of credit
                  ({batchCredits.map(c => c.grn_number).join(', ')}).
                  The credit is used up by this payment and cannot be applied again.
                </div>
              )}

              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Amount</label>
              <input type="number" autoFocus value={batchModal.amount}
                     onChange={e => setBatchModal(m => ({ ...m, amount: e.target.value }))}
                     style={{ width: '100%', padding: '10px 12px', border: `1px solid ${isOver ? '#dc2626' : '#d1d5db'}`,
                              borderRadius: 8, fontSize: 15, boxSizing: 'border-box' }} />

              {isOver && (
                <div style={{ marginTop: 8, padding: '9px 12px', background: '#fef2f2', border: '1px solid #fecaca',
                              borderRadius: 8, fontSize: 12, color: '#b91c1c' }}>
                  <strong>{fmtMoney(over)} over.</strong> Select another GRN, or reduce the amount.
                </div>
              )}
              {isShort && (
                <div style={{ marginTop: 8, padding: '9px 12px', background: '#fffbeb', border: '1px solid #fde68a',
                              borderRadius: 8, fontSize: 12, color: '#92400e' }}>
                  Short by {fmtMoney(batchTotal - amt)} â€” the oldest GRNs are settled first and the last one is part-paid.
                </div>
              )}

              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', margin: '14px 0 4px' }}>Paid from</label>
              <select value={batchModal.paidFrom} onChange={e => setBatchModal(m => ({ ...m, paidFrom: e.target.value }))}
                      style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' }}>
                <option>Bank</option><option>Cash</option><option>Mobile Money</option>
              </select>

              {preview.length > 0 && (
                <div style={{ marginTop: 16, border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                  <div style={{ background: '#f9fafb', padding: '8px 12px', fontSize: 11, fontWeight: 700, color: '#374151', letterSpacing: 0.4 }}>
                    HOW IT WILL BE APPLIED â€” OLDEST FIRST
                  </div>
                  {preview.map(({ r, take, after }) => (
                    <div key={r.grn_sync_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                                                      borderTop: '1px solid #f3f4f6', fontSize: 12 }}>
                      <span style={{ fontFamily: 'monospace', color: '#111827' }}>{r.grn_number}</span>
                      {/* The invoice number is what the supplier will quote back,
                          so it belongs beside the GRN when confirming a payment. */}
                      {r.invoice_number && (
                        <span style={{ color: '#6b7280', fontSize: 11 }}>Â· Inv {r.invoice_number}</span>
                      )}
                      <span style={{ marginLeft: 'auto', color: '#374151' }}>{fmtMoney(take)}</span>
                      <span style={{ padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700,
                                     background: after <= 0.01 ? '#dcfce7' : '#fef3c7',
                                     color:      after <= 0.01 ? '#166534' : '#92400e' }}>
                        {after <= 0.01 ? 'PAID' : `${fmtMoney(after)} left`}
                      </span>
                    </div>
                  ))}
                  {preview.length < batchGrns.length && (
                    <div style={{ padding: '8px 12px', borderTop: '1px solid #f3f4f6', fontSize: 11, color: '#9ca3af' }}>
                      {batchGrns.length - preview.length} selected GRN{batchGrns.length - preview.length === 1 ? '' : 's'} receive nothing â€” the amount runs out first.
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
                <button onClick={() => setBatchModal(null)} disabled={batchModal.busy}
                        style={{ flex: 1, padding: '10px', border: '1px solid #d1d5db', background: '#fff',
                                 borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                  Cancel
                </button>
                <button onClick={submitBatch} disabled={batchModal.busy || isOver || !(amt > 0)}
                        style={{ flex: 1, padding: '10px', border: 'none',
                                 background: (batchModal.busy || isOver || !(amt > 0)) ? '#fca5a5' : '#dc2626',
                                 color: '#fff', borderRadius: 8, fontSize: 13, fontWeight: 700,
                                 cursor: (batchModal.busy || isOver || !(amt > 0)) ? 'not-allowed' : 'pointer' }}>
                  {batchModal.busy ? 'Payingâ€¦' : 'Record Payment'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Pay modal */}
      {payModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={() => setPayModal(null)}>
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 420, padding: 22 }} onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700, color: '#111827' }}>Record Payment</h3>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: '#6b7280' }}>{payModal.row.supplier_name} Â· GRN {payModal.row.grn_number}</p>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Amount ({symbol})</label>
              <input type="number" value={payModal.amount} onChange={e => setPayModal(m => ({ ...m, amount: e.target.value }))}
                     style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, boxSizing: 'border-box' }} />
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Paid From</label>
              <select value={payModal.paidFrom} onChange={e => setPayModal(m => ({ ...m, paidFrom: e.target.value }))}
                      style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 14, boxSizing: 'border-box' }}>
                <option value="Bank">Bank</option>
                <option value="Cash">Cash</option>
                <option value="Mobile Money">Mobile Money</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setPayModal(null)} style={{ padding: '9px 16px', border: '1.5px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Cancel</button>
              <button onClick={submitPay} style={{ padding: '9px 20px', border: 'none', borderRadius: 8, background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>Pay</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// v1.13.33 â€” Full-doc modal. Header + provenance + items + credit notes
// + totals + stage-appropriate action buttons at the bottom.
function DetailModal({ state, symbol, fmtMoney, fmtDate, onClose, onCheck, onApprove, onConfirmReview, isConfirmed, onPay, onReject, rejectReasons, attachOptions }) {
  // Which GRN this credit note is being applied to. Only used for a credit.
  const [attachTo, setAttachTo] = React.useState('');
  // 2026-08-30 â€” reject panel, opened from the footer. Kept inside the modal
  // so the reason is written with the line items and the invoice in view.
  const [rejecting, setRejecting] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const { row, grn, items, credit_notes, loading, error } = state;
  const invoiceUrl = grn ? branchUploadUrl(grn.branch_slug, grn.invoice_attachment) : null;
  const itemsSubtotal = items.reduce((s, i) => s + (parseFloat(i.quantity) || 0) * (parseFloat(i.unit_price) || 0), 0);
  const cnTotal = credit_notes.reduce((s, c) => s + (parseFloat(c.amount) || 0), 0);
  const payable = itemsSubtotal - cnTotal;
  const ap = row.ap_status || 'PENDING';

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           style={{ background: '#fff', borderRadius: 12, width: 'min(960px, 95vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        {/* Header */}
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#111827' }}>
              GRN {row.grn_number}
              <span style={{ marginLeft: 10, padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 700,
                             background: STATUS_META[ap].bg, color: STATUS_META[ap].color,
                             border: `1px solid ${STATUS_META[ap].border}` }}>
                {STATUS_META[ap].label}
              </span>
            </h3>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 3 }}>
              {row.supplier_name || 'Supplier'} Â· Branch {row.branch_name || row.branch_slug}
              {row.po_number && <> Â· PO {row.po_number}</>}
              {(row.date || grn?.date) && <> Â· {row.date || grn?.date}</>}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}><FiX size={20} /></button>
        </div>

        {/* Body */}
        <div style={{ padding: 20, overflowY: 'auto', flex: 1 }}>
          {loading ? (
            <p style={{ color: '#64748b', textAlign: 'center', padding: 30 }}>Loadingâ€¦</p>
          ) : error ? (
            <div style={{ padding: 14, background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 8 }}>
              {error}
            </div>
          ) : (
            <>
              {/* Provenance */}
              <div style={{ padding: 14, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <ProvenanceField label="Supplier" value={row.supplier_name || grn?.supplier_name || 'â€”'} />
                <ProvenanceField label="From PO" value={row.po_number || 'â€”'} mono />
                <ProvenanceField
                  label="Supplier Invoice #"
                  value={row.invoice_number || grn?.supplier_invoice_number || 'â€”'}
                  extra={invoiceUrl && (
                    <a href={invoiceUrl} target="_blank" rel="noopener noreferrer"
                       style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 4, color: '#1d4ed8', fontSize: 12, fontWeight: 600, textDecoration: 'none' }}>
                      <FiPaperclip size={12} /> View attachment
                    </a>
                  )}
                />
                <ProvenanceField
                  label={<><FiUser size={11} style={{ verticalAlign: 'middle' }}/> Confirmed by HQ</>}
                  value={row.confirmed_by_name || 'â€”'}
                  extra={row.confirmed_at && (
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                      <FiClock size={10} style={{ verticalAlign: 'middle' }}/> {fmtDate(row.confirmed_at)}
                    </div>
                  )}
                />
                {row.checked_at && (
                  <ProvenanceField label={<><FiCheck size={11} style={{ verticalAlign: 'middle' }}/> Checked</>}
                    value={row.checked_by_name || 'â€”'}
                    extra={<div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}><FiClock size={10} style={{ verticalAlign: 'middle' }}/> {fmtDate(row.checked_at)}</div>} />
                )}
                {row.approved_at && (
                  <ProvenanceField label={<><FiCheckCircle size={11} style={{ verticalAlign: 'middle' }}/> Approved</>}
                    value={row.approved_by_name || 'â€”'}
                    extra={<div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}><FiClock size={10} style={{ verticalAlign: 'middle' }}/> {fmtDate(row.approved_at)}</div>} />
                )}
                {row.paid_at && (
                  <ProvenanceField label={<><FiDollarSign size={11} style={{ verticalAlign: 'middle' }}/> Paid</>}
                    value={row.paid_by_name || 'â€”'}
                    extra={<div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}><FiClock size={10} style={{ verticalAlign: 'middle' }}/> {fmtDate(row.paid_at)}</div>} />
                )}
              </div>

              {/* Items */}
              <h4 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: '#111827' }}>Line Items ({items.length})</h4>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', marginBottom: 16 }}>
                <div style={{ overflowX: 'auto' }}>
                  <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: '#f8fafc', color: '#475569' }}>
                        <th style={thStyle}>#</th>
                        <th style={{ ...thStyle, textAlign: 'left' }}>Product</th>
                        <th style={thStyle}>Unit</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Qty</th>
                        {/* 2026-08-30 â€” the supplier's own figures. Whoever
                            approves a payment could previously see only the
                            derived cost, with no way to tell why it was
                            K574.01 when the invoice says K504.56. */}
                        <th style={{ ...thStyle, textAlign: 'right' }}>Base Price</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Total Base</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>VAT</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Discount</th>
                        {/* The one column NOT on the invoice â€” what the system
                            derived and what stock is valued at. */}
                        <th style={{ ...thStyle, textAlign: 'right', color: '#7c3aed' }}>Cost</th>
                        <th style={{ ...thStyle, textAlign: 'right' }}>Line Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.length === 0 ? (
                        <tr><td colSpan={10} style={{ padding: 20, textAlign: 'center', color: '#9ca3af' }}>No items on this GRN.</td></tr>
                      ) : items.map((it, idx) => {
                        const qty = parseFloat(it.quantity) || 0;
                        const price = parseFloat(it.unit_price) || 0;
                        return (
                          <tr key={it.id || idx} style={{ borderTop: '1px solid #f1f5f9' }}>
                            <td style={tdStyle}>{idx + 1}</td>
                            <td style={{ ...tdStyle, textAlign: 'left' }}>
                              <div style={{ fontWeight: 600, color: '#111827' }}>{it.product_name || it.name || 'â€”'}</div>
                              {it.product_code && <div style={{ fontSize: 10, color: '#6b7280' }}>{it.product_code}</div>}
                            </td>
                            <td style={tdStyle}>{it.unit || it.product_base_unit || 'â€”'}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{qty.toLocaleString()}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(it.base_price)}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(qty * (parseFloat(it.base_price) || 0))}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(it.vat_amount)}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(it.discount_amount)}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: '#7c3aed', fontWeight: 700, background: '#faf5ff' }}>{fmtMoney(price)}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(qty * price)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {/* 2026-08-31 â€” subtotal at the foot of the lines, not only
                        in the summary far below. Someone checking the GRN
                        against the invoice needs it where the lines end. */}
                    {items.length > 0 && (
                      <tfoot>
                        <tr style={{ background: '#f8fafc', borderTop: '2px solid #e5e7eb' }}>
                          <td colSpan={9} style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: '#0f172a' }}>Items Subtotal</td>
                          <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 800, color: '#0f172a' }}>
                            {fmtMoney(items.reduce((a, x) => a + (parseFloat(x.quantity) || 0) * (parseFloat(x.unit_price) || 0), 0))}
                          </td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>

              {/* Credit Notes â€” full detail per note incl. items */}
              {credit_notes.length > 0 && (
                <>
                  <h4 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: '#111827' }}>Credit Notes ({credit_notes.length})</h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 16 }}>
                    {credit_notes.map(cn => {
                      const cnItems = Array.isArray(cn.items) ? cn.items : [];
                      return (
                        <div key={cn.id} style={{ border: '1px solid #fecaca', borderRadius: 10, background: '#fef2f2', overflow: 'hidden' }}>
                          {/* CN header strip */}
                          <div style={{ padding: '10px 14px', borderBottom: cnItems.length ? '1px solid #fecaca' : 'none', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'baseline' }}>
                              <strong style={{ fontSize: 13, color: '#7f1d1d' }}>{cn.credit_note_number || '(no #)'}</strong>
                              {cn.reason && <span style={{ fontSize: 12, color: '#991b1b', padding: '2px 8px', borderRadius: 10, background: '#fecaca', fontWeight: 600 }}>{cn.reason}</span>}
                              {/* 2026-08-31 â€” say which kind it is. One came
                                  with the invoice; the other was raised on its
                                  own and applied to this GRN by a person. */}
                              {cn.is_free_credit ? (
                                <span style={{ fontSize: 11, fontWeight: 700, color: '#166534', background: '#dcfce7',
                                               border: '1px solid #bbf7d0', borderRadius: 10, padding: '2px 8px' }}>
                                  Free credit note
                                  {cn.created_by_name && <> Â· applied by {cn.created_by_name}</>}
                                </span>
                              ) : (
                                <span style={{ fontSize: 11, color: '#991b1b', opacity: 0.8 }}>with invoice</span>
                              )}
                              {cn.date && <span style={{ fontSize: 11, color: '#991b1b' }}>Â· {cn.date}</span>}
                              {cn.reference && <span style={{ fontSize: 11, color: '#991b1b' }}>Â· Ref: {cn.reference}</span>}
                              {cn.created_by_name && <span style={{ fontSize: 11, color: '#991b1b' }}>Â· by {cn.created_by_name}</span>}
                            </div>
                            <strong style={{ fontSize: 14, color: '#991b1b' }}>âˆ’ {fmtMoney(cn.amount)}</strong>
                          </div>

                          {/* CN items (goods return / crates / bottles) */}
                          {cnItems.length > 0 && (
                            <div style={{ overflowX: 'auto', background: '#fff' }}>
                              <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <thead>
                                  <tr style={{ background: '#fef2f2', color: '#7f1d1d' }}>
                                    <th style={thStyle}>#</th>
                                    <th style={{ ...thStyle, textAlign: 'left' }}>Product</th>
                                    <th style={thStyle}>Unit</th>
                                    <th style={{ ...thStyle, textAlign: 'right' }}>Qty</th>
                                    <th style={{ ...thStyle, textAlign: 'right' }}>Unit Value</th>
                                    {/* 2026-08-30 â€” the supplier's credit note
                                        prints a discount per line; without it
                                        the totals here cannot be reconciled
                                        against the paper. */}
                                    <th style={{ ...thStyle, textAlign: 'right' }}>Discount</th>
                                    <th style={{ ...thStyle, textAlign: 'right' }}>Total</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {cnItems.map((it, idx) => {
                                    const qty = parseFloat(it.quantity) || 0;
                                    const uv  = parseFloat(it.unit_value) || 0;
                                    // total_price is stored net of the discount.
                                    const tot = parseFloat(it.total_price) || ((qty * uv) - (parseFloat(it.discount) || 0));
                                    return (
                                      <tr key={idx} style={{ borderTop: '1px solid #fee2e2' }}>
                                        <td style={tdStyle}>{idx + 1}</td>
                                        <td style={{ ...tdStyle, textAlign: 'left' }}>{it.product_name || 'â€”'}</td>
                                        <td style={tdStyle}>{it.unit || 'â€”'}</td>
                                        <td style={{ ...tdStyle, textAlign: 'right' }}>{qty.toLocaleString()}</td>
                                        <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(uv)}</td>
                                        <td style={{ ...tdStyle, textAlign: 'right' }}>{fmtMoney(it.discount)}</td>
                                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(tot)}</td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                                {/* Mirrors the footer of the supplier's credit
                                    note, so the header amount can be traced. */}
                                <tfoot>
                                  <tr style={{ background: '#fff7f7', borderTop: '1px solid #fecaca' }}>
                                    <td colSpan={6} style={{ ...tdStyle, textAlign: 'right', color: '#7f1d1d' }}>Total</td>
                                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: '#7f1d1d' }}>
                                      {fmtMoney(cnItems.reduce((a, x) => a + (parseFloat(x.total_price) || 0), 0))}
                                    </td>
                                  </tr>
                                  <tr style={{ background: '#fff7f7' }}>
                                    <td colSpan={6} style={{ ...tdStyle, textAlign: 'right', color: '#7f1d1d' }}>VAT Amount</td>
                                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700, color: '#7f1d1d' }}>{fmtMoney(cn.vat_amount)}</td>
                                  </tr>
                                  <tr style={{ background: '#fef2f2', borderTop: '1px solid #fecaca' }}>
                                    <td colSpan={6} style={{ ...tdStyle, textAlign: 'right', fontWeight: 800, color: '#991b1b' }}>Grand Total</td>
                                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 800, color: '#991b1b' }}>âˆ’ {fmtMoney(cn.amount)}</td>
                                  </tr>
                                </tfoot>
                              </table>
                            </div>
                          )}

                          {/* Free-text note */}
                          {cn.notes && (
                            <div style={{ padding: '8px 14px', fontSize: 12, color: '#7f1d1d', background: '#fff5f5', borderTop: '1px solid #fecaca' }}>
                              <strong>Note:</strong> {cn.notes}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Totals */}
              <div style={{ padding: 14, background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 10, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Items Subtotal</span>
                  <strong>{fmtMoney(itemsSubtotal || row.items_subtotal)}</strong>
                </div>
                {(cnTotal > 0 || parseFloat(row.cn_total) > 0) && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', color: '#dc2626' }}>
                    <span>âˆ’ Credit Notes</span>
                    <strong>{fmtMoney(cnTotal || row.cn_total)}</strong>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #e5e7eb', paddingTop: 6, fontSize: 15 }}>
                  <span style={{ fontWeight: 700 }}>Payable</span>
                  <strong style={{ color: '#111827' }}>{fmtMoney(payable || row.final_payable)}</strong>
                </div>
                {/* 2026-08-30 â€” settlement, not just what was owed. The detail
                    view ended at Payable, so opening a GRN told you nothing
                    about whether it had been paid â€” the one thing you open it
                    to check. Balance is highlighted because that is the number
                    someone chasing a supplier actually needs. */}
                {parseFloat(row.paid_amount || 0) > 0 && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, marginTop: 4 }}>
                      <span>Paid to date</span>
                      <strong style={{ color: '#166534' }}>{fmtMoney(row.paid_amount)}</strong>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15,
                                  borderTop: '1px solid #e5e7eb', paddingTop: 6, marginTop: 4 }}>
                      <span style={{ fontWeight: 700 }}>Balance</span>
                      <strong style={{ color: parseFloat(row.remaining_amount || 0) > 0 ? '#b45309' : '#166534' }}>
                        {fmtMoney(row.remaining_amount || 0)}
                      </strong>
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer with stage action */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8, flexShrink: 0, background: '#fff', borderRadius: '0 0 12px 12px' }}>
          <button onClick={onClose}
                  style={{ padding: '9px 16px', border: '1.5px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            Close
          </button>
          {/* A credit note is checked BY choosing its GRN, so the picker sits
              next to the button rather than in a separate step. */}
          {ap === 'PENDING' && onCheck && attachOptions && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginRight: 'auto' }}>
              <span style={{ fontSize: 12, color: '#374151', fontWeight: 600 }}>Apply to</span>
              <select value={attachTo} onChange={e => setAttachTo(e.target.value)}
                      style={{ padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, minWidth: 260 }}>
                <option value="">â€” choose a GRN â€”</option>
                {attachOptions.map(g => (
                  <option key={g.grn_sync_id} value={g.grn_sync_id}>
                    {g.grn_number} Â· {symbol}{(parseFloat(g.final_payable) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </option>
                ))}
              </select>
              {attachOptions.length === 0 && (
                <span style={{ fontSize: 11, color: '#b45309' }}>
                  No unpaid GRN for this supplier to apply it to.
                </span>
              )}
            </div>
          )}
          {ap === 'PENDING' && onCheck && attachOptions && (
            <button onClick={() => onCheck(attachTo)} disabled={!attachTo}
                    style={{ padding: '9px 18px', borderRadius: 8, border: 'none',
                             background: attachTo ? '#16a34a' : '#bbf7d0', color: '#fff',
                             cursor: attachTo ? 'pointer' : 'not-allowed', fontSize: 13, fontWeight: 700,
                             display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <FiCheck size={14} /> Apply &amp; Check
            </button>
          )}
          {ap === 'PENDING' && onCheck && !attachOptions && (
            <button onClick={onCheck}
                    style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <FiCheck size={14} /> Check
            </button>
          )}
          {/* 2026-08-31 â€” Confirm, not Approve. Approving is a batch action on
              the list; this records that Finance opened THIS one and agreed.
              The button lives here on purpose â€” confirming is only a real
              control if you had to open the thing to do it. */}
          {ap === 'CHECKED' && onConfirmReview && (
            isConfirmed ? (
              <button onClick={() => onConfirmReview(false)}
                      title="Undo the confirmation while it is still unapproved"
                      style={{ padding: '9px 18px', borderRadius: 8, border: '1.5px solid #bbf7d0', background: '#f0fdf4', color: '#166534', cursor: 'pointer', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <FiCheckCircle size={14} /> Confirmed Â· Undo
              </button>
            ) : (
              <button onClick={() => onConfirmReview(true)}
                      style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#0e7490', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <FiCheckCircle size={14} /> Confirm
              </button>
            )
          )}
          {(ap === 'APPROVED' || ap === 'PARTIAL') && onPay && (
            <button onClick={onPay}
                    style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <FiDollarSign size={14} /> Record Payment
            </button>
          )}
          {/* Reject sends the GRN back ONE stage with a reason. Only from a
              stage that has something to go back to â€” nothing precedes
              Awaiting Check, and a GRN with money against it is not a
              paperwork problem. */}
          {(ap === 'CHECKED' || ap === 'APPROVED') && onReject && !rejecting && (
            <button onClick={() => setRejecting(true)}
                    style={{ padding: '9px 18px', borderRadius: 8, border: '1.5px solid #fca5a5', background: '#fff', color: '#b91c1c', cursor: 'pointer', fontSize: 13, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <FiXCircle size={14} /> Reject
            </button>
          )}
        </div>

        {rejecting && (
          <div style={{ padding: '14px 20px', borderTop: '1px solid #fecaca', background: '#fef2f2', flexShrink: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#b91c1c', marginBottom: 6 }}>
              Reject â€” goes back to {ap === 'APPROVED' ? 'Awaiting Approval' : 'Awaiting Check'}
            </div>
            {/* Reasons already used, most recent first. The same few recur, and
                retyping them by hand produces near-duplicates that cannot be
                searched or reported on later. */}
            {(rejectReasons || []).length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {rejectReasons.slice(0, 6).map(rr => (
                  <button key={rr} type="button" onClick={() => setReason(rr)}
                          style={{ padding: '4px 10px', borderRadius: 14, border: '1px solid #fecaca', background: '#fff', color: '#b91c1c', cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                    {rr}
                  </button>
                ))}
              </div>
            )}
            <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2}
                      placeholder="Why is this being sent back? The person who picks it up will see this."
                      style={{ width: '100%', padding: '9px 11px', borderRadius: 8, border: '1.5px solid #fca5a5', fontSize: 13, boxSizing: 'border-box', resize: 'vertical' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button onClick={() => { setRejecting(false); setReason(''); }}
                      style={{ padding: '8px 14px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                Cancel
              </button>
              <button disabled={reason.trim().length < 3}
                      onClick={() => onReject(reason.trim())}
                      style={{ padding: '8px 18px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 700, color: '#fff',
                               background: reason.trim().length < 3 ? '#fca5a5' : '#b91c1c',
                               cursor: reason.trim().length < 3 ? 'not-allowed' : 'pointer' }}>
                Confirm Reject
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const thStyle = { padding: '8px 10px', fontSize: 11, fontWeight: 700, textAlign: 'center', textTransform: 'uppercase', letterSpacing: 0.4 };
const tdStyle = { padding: '8px 10px', fontSize: 12, textAlign: 'center', color: '#374151' };

function ProvenanceField({ label, value, extra, mono }) {
  return (
    <div>
      <div style={{ fontSize: 10, textTransform: 'uppercase', color: '#64748b', fontWeight: 600, letterSpacing: 0.4, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#111827', fontFamily: mono ? 'ui-monospace, monospace' : undefined }}>{value}</div>
      {extra}
    </div>
  );
}

export default HqApApprovals;
