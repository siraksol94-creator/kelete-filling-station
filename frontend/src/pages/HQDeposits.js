// HQ Deposits — Branch → HQ cash deposit workflow.
//
// One screen, two behaviours by host:
//   - Branch (kassumbalesa1, ...): "Send Deposit" button + own outgoing
//     deposits history. Each row shows status (PENDING / CONFIRMED /
//     REJECTED).
//   - HQ (keletedistributionzm bare):          incoming inbox from every branch with
//     Confirm / Reject actions on PENDING rows.
//
// Cash movement is NOT income/expense — the cash physically moves from
// one drawer to another. No payment_voucher / cash_receipt is written
// on confirm; the per-currency Cash Report aggregation reads cash_deposits
// directly so drawer Expected reflects today's outflow / inflow without
// hitting profit.
import React, { useEffect, useState, useRef } from 'react';
import {
  FiSend, FiCheck, FiX, FiRefreshCw, FiInbox, FiArrowUpRight, FiArrowDownLeft, FiTrash2, FiEdit2,
  FiPaperclip, FiCamera, FiUpload, FiEye, FiFileText, FiImage,
} from 'react-icons/fi';
import {
  getCashDeposits, createCashDeposit, confirmCashDeposit, rejectCashDeposit, deleteCashDeposit,
  getCashDepositTarget,
  editCashDepositDate,
  uploadInvoiceAttachment,
  isHqHost, getBranchSlug,
} from '../services/api';
import { useCurrency } from '../context/CurrencyContext';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { labelFromSlug } from '../utils/useDepositTarget';

const todayStr = () => new Date().toISOString().slice(0, 10);

// v1.8.61 — parse attachment column (string or JSON-array string) into
// an array of paths. Tolerates legacy single-string entries.
const parseAttachments = (raw) => {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  const s = raw.trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.filter(Boolean) : [];
    } catch { /* fall through */ }
  }
  return [s]; // legacy single-path
};

const HQDeposits = () => {
  const { symbol: curSym, currencyMode, isLiquorStyle, methodShown, autoDeposit } = useCurrency();
  const onHq = isHqHost();
  const isDual = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  const hasK   = currencyMode === 'USD+FRA+K';
  // v1.10.29 — currencies this branch can actually deposit. K-only
  // (Liquor-style) branches must NOT be able to select USD/FRA — those
  // drawers don't exist here. Order = display order in the dropdown.
  const depositCcyOptions = currencyMode === 'K'
    ? [{ value: 'K',   label: 'K (Kwacha)' }]
    : currencyMode === 'USD+FRA'
    ? [{ value: 'USD', label: 'USD ($)' }, { value: 'FRA', label: 'FRA' }]
    : currencyMode === 'USD+FRA+K'
    ? [{ value: 'USD', label: 'USD ($)' }, { value: 'FRA', label: 'FRA' }, { value: 'K', label: 'K (Kwacha)' }]
    : [{ value: 'USD', label: 'USD ($)' }];
  const defaultDepositCcy = depositCcyOptions[0].value;

  const [deposits, setDeposits] = useState([]);
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' });
  const [loading, setLoading]   = useState(false);

  // Send Deposit modal (branch only)
  const [showSend, setShowSend] = useState(false);
  const [sendForm, setSendForm] = useState({ currency: defaultDepositCcy, amount: '', from_method: 'Cash', notes: '', deposit_date: todayStr(), attachments: [] });
  const [sending, setSending]   = useState(false);
  const [sendError, setSendError] = useState('');
  // v1.8.61 — multi-file upload state for the deposit slips.
  const fileInputRef = useRef(null);
  const camInputRef  = useRef(null);
  const [uploadingAtt, setUploadingAtt] = useState(false);
  const [attError, setAttError] = useState('');

  // Reject reason modal (HQ only)
  const [rejectingId, setRejectingId]   = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  // v1.10.83 — admin-password gate when confirming with a changed date.
  // Non-null value = the AdminPasswordPrompt is open; { deposit, newDate }
  // are the details we'll POST once the password check passes.
  const [pendingDateChange, setPendingDateChange] = useState(null);

  // Filters
  // 2026-09-17 — opens on Pending (the work waiting), all depots, no dates.
  const [statusFilter, setStatusFilter] = useState('PENDING');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate]     = useState('');
  // 2026-09-11 — HQ: narrow the list to one depot ('' = all depots).
  const [branchFilter, setBranchFilter] = useState('');

  useModalScrollLock(showSend || !!rejectingId);

  // 2026-09-15 — System Settings → Deposit to. A depot sends to HQ or to the
  // depot picked there; that side confirms. Each row carries _dir: 'out' (this
  // depot sent it) or 'in' (sent to this depot / to HQ on the HQ screen).
  const [target, setTarget] = useState(null); // null = HQ
  const targetName = target?.name || 'HQ';
  // Short form for the heading — the full name reads "Kelete Distribution - KABWE".
  const targetLabel = target?.slug ? labelFromSlug(target.slug) : 'HQ';
  useEffect(() => {
    if (onHq) return;
    const slug = getBranchSlug() || (window.location.hostname.split('.')[0] || '');
    if (slug) getCashDepositTarget(slug).then(r => setTarget(r.data?.to || null)).catch(() => {});
  // eslint-disable-next-line
  }, []);

  const fetchDeposits = async () => {
    setLoading(true);
    try {
      const base = statusFilter !== 'ALL' ? { status: statusFilter } : {};
      if (onHq) {
        // Only deposits sent to HQ — depot-to-depot deposits are not HQ's.
        const r = await getCashDeposits({ ...base, to: 'hq' });
        setDeposits((Array.isArray(r.data) ? r.data : []).map(d => ({ ...d, _dir: 'in' })));
      } else {
        const slug = getBranchSlug() || (window.location.hostname.split('.')[0] || '');
        if (slug) {
          const [out, inc] = await Promise.all([
            getCashDeposits({ ...base, from_slug: slug }),
            getCashDeposits({ ...base, to_slug: slug }),
          ]);
          setDeposits([
            ...(Array.isArray(out.data) ? out.data : []).map(d => ({ ...d, _dir: 'out' })),
            ...(Array.isArray(inc.data) ? inc.data : []).map(d => ({ ...d, _dir: 'in' })),
          ]);
        }
      }
    } catch (_) { /* leave list as-is */ }
    setLoading(false);
  };

  useEffect(() => { fetchDeposits(); /* eslint-disable-next-line */ }, [statusFilter]);

  const openSendModal = () => {
    setSendError('');
    setAttError('');
    setSendForm({ currency: defaultDepositCcy, amount: '', from_method: 'Cash', notes: '', deposit_date: todayStr(), attachments: [] });
    setShowSend(true);
  };

  // v1.8.61 — upload one or more files (file picker is multi-select).
  const handleFilesPicked = async (filesList) => {
    if (!filesList || filesList.length === 0) return;
    setAttError('');
    setUploadingAtt(true);
    const newPaths = [];
    try {
      for (const f of Array.from(filesList)) {
        const res = await uploadInvoiceAttachment(f, 'deposit');
        if (res?.data?.path) newPaths.push(res.data.path);
      }
      setSendForm(f => ({ ...f, attachments: [...(f.attachments || []), ...newPaths] }));
    } catch (e) {
      const status = e.response?.status;
      const reason = e.response?.data?.error
        || (status === 413 ? 'File too large (max 10 MB)'
        :   status === 400 ? 'Invalid file type (PDF or image only)'
        :   `Upload failed${status ? ` (${status})` : ''}`);
      setAttError(reason);
    }
    setUploadingAtt(false);
  };

  const removeAttachment = (idx) => {
    setSendForm(f => ({ ...f, attachments: (f.attachments || []).filter((_, i) => i !== idx) }));
  };

  const handleSend = async () => {
    setSendError('');
    const amt = parseFloat(sendForm.amount || 0);
    if (!(amt > 0)) { setSendError('Amount must be > 0'); return; }
    const slug = getBranchSlug() || (window.location.hostname.split('.')[0] || '');
    if (!slug) { setSendError('Branch not detected — cannot send deposit'); return; }
    setSending(true);
    try {
      // Multi-attachment serialised as JSON array. Backend stores the
      // string verbatim in the legacy `attachment` column — parseAttachments()
      // on read tolerates both shapes (single string or JSON array).
      const atts = sendForm.attachments || [];
      const attachmentPayload = atts.length === 0 ? null
        : atts.length === 1 ? atts[0]
        : JSON.stringify(atts);
      await createCashDeposit({
        from_slug:    slug,
        currency:     sendForm.currency,
        amount:       amt,
        // v1.10.48 — send `from_method` only on Liquor branches so backend
        // tags the deposit to the physical drawer (Cash/MoMo/Bank). Kelete
        // omits it → stored as NULL → doesn't affect the per-currency
        // deposit split logic.
        ...(isLiquorStyle ? { from_method: sendForm.from_method } : {}),
        notes:        sendForm.notes || null,
        deposit_date: sendForm.deposit_date,
        attachment:   attachmentPayload,
      });
      setShowSend(false);
      await fetchDeposits();
    } catch (err) {
      setSendError(err?.response?.data?.error || 'Failed to send deposit');
    }
    setSending(false);
  };

  const handleConfirm = async (d) => {
    // v1.10.82 — HQ operator can override the deposit_date at confirm
    // time (e.g. cash arrived last week but they're only clicking
    // confirm now). Blank = keep the branch's original date.
    const currentDate = d.deposit_date || new Date().toISOString().slice(0, 10);
    const input = window.prompt(
      `Confirm deposit ${d.deposit_number}?\n\n` +
      `Effective date (YYYY-MM-DD). Cash Book will show it under this date.\n` +
      `Leave as-is to keep the branch's original date.`,
      currentDate
    );
    if (input === null) return; // user cancelled
    const trimmed = String(input).trim();
    const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
    if (trimmed && !dateOk) { alert('Date must be YYYY-MM-DD.'); return; }

    // v1.10.83 — moving a deposit to a different accounting date shifts
    // where it lands in the Cash Book. That's a sensitive edit, so it
    // needs admin authorization. Unchanged date = fast-path, no prompt.
    if (dateOk && trimmed !== d.deposit_date) {
      setPendingDateChange({ deposit: d, newDate: trimmed, mode: 'confirm' });
      return;
    }

    try {
      await confirmCashDeposit(d.id);
      await fetchDeposits();
    } catch (err) {
      alert(err?.response?.data?.error || 'Failed to confirm deposit');
    }
  };

  // v1.10.84 — edit accounting date of an already-CONFIRMED deposit.
  // Same UX as handleConfirm's date-change path: prompt for a new date,
  // then require admin password before writing. Backend uses PUT /date
  // (not /confirm) because the row is already CONFIRMED.
  const handleEditDate = (d) => {
    const currentDate = d.deposit_date || new Date().toISOString().slice(0, 10);
    const input = window.prompt(
      `Edit accounting date for ${d.deposit_number}?\n\n` +
      `Cash Book will move this deposit to the new date on BOTH sides\n` +
      `(the money in on one side, out on the other).`,
      currentDate
    );
    if (input === null) return;
    const trimmed = String(input).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) { alert('Date must be YYYY-MM-DD.'); return; }
    if (trimmed === d.deposit_date) return; // no change
    setPendingDateChange({ deposit: d, newDate: trimmed, mode: 'edit' });
  };

  // v1.10.83 — runs after admin authorises the date change. In 'confirm'
  // mode we flip PENDING → CONFIRMED with the new date; in 'edit' mode
  // the row is already CONFIRMED, we just move its date.
  const finishConfirmWithDate = async () => {
    if (!pendingDateChange) return;
    const { deposit, newDate, mode } = pendingDateChange;
    setPendingDateChange(null);
    try {
      if (mode === 'edit') {
        await editCashDepositDate(deposit.id, newDate);
      } else {
        await confirmCashDeposit(deposit.id, { deposit_date: newDate });
      }
      await fetchDeposits();
    } catch (err) {
      alert(err?.response?.data?.error || (mode === 'edit' ? 'Failed to edit deposit date' : 'Failed to confirm deposit'));
    }
  };

  const handleReject = async () => {
    if (!rejectingId) return;
    try {
      await rejectCashDeposit(rejectingId, rejectReason);
      setRejectingId(null);
      setRejectReason('');
      await fetchDeposits();
    } catch (err) {
      alert(err?.response?.data?.error || 'Failed to reject deposit');
    }
  };

  const handleDelete = async (d) => {
    const label = `${d.deposit_number} — ${d.currency} ${parseFloat(d.amount).toLocaleString()}`;
    const extra = d.status === 'CONFIRMED'
      ? '\n\nThis deposit was already CONFIRMED. Deleting it removes it from Cash Report reconciliation.'
      : '';
    // 2026-08-28 — deleting a deposit now records WHY. This is cash handed
    // from a branch to HQ; removing it silently changes both sides' books
    // with nothing to say who did it or on what grounds.
    const reason = window.prompt(
      `Delete this deposit?

${label}${extra}

Reason (required, kept on record):`
    );
    if (reason === null) return;                     // cancelled
    if (reason.trim().length < 3) {
      alert('Please give a reason of at least 3 characters — it is kept on the deposit record.');
      return;
    }
    try {
      await deleteCashDeposit(d.id, reason.trim());
      await fetchDeposits();
    } catch (err) {
      alert(err?.response?.data?.error || 'Failed to delete deposit');
    }
  };

  const fmt = (n) => `${curSym}${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtRaw = (n) => Math.round(parseFloat(n || 0)).toLocaleString();

  // Stats — pending count, totals per currency this month.
  // 2026-09-11 — deleted deposits stay in the table (greyed, struck through)
  // as the record, but must not count: the cards summed them too, so a
  // cleaned-up list still showed K1,358,670 confirmed and 19 pending.
  // 2026-09-11 — deleted deposits are no longer listed at all (the row stays
  // in the database with who, when and why). The depot filter narrows the
  // list and the cards together.
  const branchOptions = [...new Map(
    deposits.filter(d => !d.deleted_at).map(d => [d.from_slug, d.from_name || d.from_slug])
  ).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  // 2026-09-17 — the date filter works on the deposit date (the day the cash
  // left), falling back to when the record was created. Blank = no limit.
  const dayOf = (d) => (d.deposit_date || String(d.created_at || '').slice(0, 10) || '');
  const liveDeposits   = deposits.filter(d => !d.deleted_at
    && (!branchFilter || d.from_slug === branchFilter)
    && (!fromDate || dayOf(d) >= fromDate)
    && (!toDate   || dayOf(d) <= toDate));
  // 2026-09-13 — sortable columns (see SortTh). Ties fall back to newest created first.
  // Who is on the other side of the row: the sender for incoming, where it went for outgoing.
  const partyLabel = (d) => onHq ? (d.from_name || d.from_slug || '')
    : d._dir === 'in' ? `From ${d.from_name || d.from_slug || ''}`
    : `To ${d.to_name || 'HQ'}`;
  const sortValue = (d, k) => {
    switch (k) {
      case 'date':       return d.deposit_date || String(d.created_at || '').slice(0, 10);
      case 'from':       return String(partyLabel(d)).toLowerCase();
      case 'notes':      return String(d.notes || '').toLowerCase();
      case 'number':     return String(d.deposit_number || '');
      case 'attachment': return parseAttachments(d.attachment).length;
      case 'amount':     return Number(d.amount) || 0;
      case 'status':     return String(d.status || '');
      case 'created':    return String(d.created_at || '');
      case 'confirmed':  return String(d.confirmed_at || '');
      default:           return '';
    }
  };
  const sortedDeposits = [...liveDeposits].sort((a, b) => {
    const va = sortValue(a, sort.key);
    const vb = sortValue(b, sort.key);
    const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb));
    return (sort.dir === 'asc' ? cmp : -cmp) || String(b.created_at || '').localeCompare(String(a.created_at || ''));
  });
  const pendingCount   = liveDeposits.filter(d => d.status === 'PENDING').length;
  // On a depot the Confirmed cards are what it SENT; money other depots sent
  // to it is its own card, with what is still waiting for it to confirm.
  const confirmedTotal = liveDeposits.filter(d => d.status === 'CONFIRMED' && (onHq || d._dir !== 'in')).reduce((acc, d) => {
    acc[d.currency] = (acc[d.currency] || 0) + parseFloat(d.amount || 0);
    return acc;
  }, {});
  // 2026-09-16 — the Pending card shows the money waiting, not just how many.
  const pendingTotal   = liveDeposits.filter(d => d.status === 'PENDING').reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
  const receivedTotal   = onHq ? 0 : liveDeposits.filter(d => d._dir === 'in' && d.status === 'CONFIRMED').reduce((s, d) => s + (parseFloat(d.amount) || 0), 0);
  const waitingForMe    = onHq ? 0 : liveDeposits.filter(d => d._dir === 'in' && d.status === 'PENDING').length;

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          {/* 2026-09-18 — a depot that deposits to another depot (Bankers →
              Kabwe) is not sending to HQ, so the heading says where it goes. */}
          <h1>{onHq ? 'HQ' : targetLabel} Deposits</h1>
          <p>{onHq
            ? 'Confirm cash deposits sent in from branches'
            : `Send cash to ${targetName} and track confirmations`}</p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={fetchDeposits}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
            <FiRefreshCw size={15} /> Refresh
          </button>
          {/* 2026-09-14 — hidden when System Settings → Auto deposit is on: the
              Cash Report sends the deposit itself, so a manual one would double it. */}
          {!onHq && !autoDeposit && (
            <button onClick={openSendModal}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 20px', borderRadius: 10, border: 'none', backgroundColor: '#d97706', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
              <FiSend size={15} /> Send Deposit
            </button>
          )}
        </div>
      </div>

      {/* Stats cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
        <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 10, padding: 14 }}>
          <div style={{ fontSize: 11, color: '#92400e', fontWeight: 700, textTransform: 'uppercase' }}>Pending</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#78350f' }}>K{fmtRaw(pendingTotal)}</div>
          <div style={{ fontSize: 12, color: '#92400e', fontWeight: 600, marginTop: 2 }}>
            {pendingCount} deposit{pendingCount === 1 ? '' : 's'} waiting
          </div>
        </div>
        {/* 2026-09-11 — USD only where it can happen: a Kwacha-only branch
            (all of Kelete) never has a USD deposit, so no "K0.00 USD" card. */}
        {(currencyMode !== 'K' || (confirmedTotal.USD || 0) > 0) && (
          <div style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 11, color: '#166534', fontWeight: 700, textTransform: 'uppercase' }}>Confirmed (USD)</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#14532d' }}>{fmt(confirmedTotal.USD || 0)}</div>
          </div>
        )}
        {/* v1.10.19 — also show FRA / K cards when actual deposits exist,
            not only when the current branch's currency_mode says so. HQ view
            aggregates across every branch and might see K deposits from a
            Kelete branch even while HQ's own mode is USD-only. */}
        {(isDual || (confirmedTotal.FRA || 0) > 0) && (
          <div style={{ background: '#dbeafe', border: '1px solid #93c5fd', borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 11, color: '#1d4ed8', fontWeight: 700, textTransform: 'uppercase' }}>Confirmed (FRA)</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#1e3a8a' }}>FRA {fmtRaw(confirmedTotal.FRA || 0)}</div>
          </div>
        )}
        {(hasK || (confirmedTotal.K || 0) > 0) && (
          <div style={{ background: '#ede9fe', border: '1px solid #c4b5fd', borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 11, color: '#6d28d9', fontWeight: 700, textTransform: 'uppercase' }}>Confirmed (K)</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#4c1d95' }}>K{fmtRaw(confirmedTotal.K || 0)}</div>
          </div>
        )}
        {waitingForMe > 0 && (
          <div style={{ background: '#fff7ed', border: '1px solid #fdba74', borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 11, color: '#9a3412', fontWeight: 700, textTransform: 'uppercase' }}>Waiting for you to confirm</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: '#7c2d12' }}>{waitingForMe}</div>
          </div>
        )}
        {receivedTotal > 0 && (
          <div style={{ background: '#ecfdf5', border: '1px solid #6ee7b7', borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 11, color: '#065f46', fontWeight: 700, textTransform: 'uppercase' }}>Received from depots (K)</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: '#064e3b' }}>K{fmtRaw(receivedTotal)}</div>
          </div>
        )}
      </div>

      {/* Filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>Status:</label>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
          <option value="ALL">All</option>
          <option value="PENDING">Pending</option>
          <option value="CONFIRMED">Confirmed</option>
          <option value="REJECTED">Rejected</option>
        </select>
        {onHq && (
          <>
            <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600, marginLeft: 8 }}>Depot:</label>
            <select value={branchFilter} onChange={e => setBranchFilter(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }}>
              <option value="">All depots</option>
              {branchOptions.map(([slug, name]) => <option key={slug} value={slug}>{name}</option>)}
            </select>
          </>
        )}
        {/* 2026-09-17 — date range on the deposit date. Blank = every date. */}
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600, marginLeft: 8 }}>From:</label>
        <input type="date" value={fromDate} max={toDate || undefined} onChange={e => setFromDate(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
        <label style={{ fontSize: 13, color: '#6b7280', fontWeight: 600 }}>To:</label>
        <input type="date" value={toDate} min={fromDate || undefined} onChange={e => setToDate(e.target.value)}
          style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 }} />
        {(fromDate || toDate || branchFilter || statusFilter !== 'PENDING') && (
          <button type="button" onClick={() => { setFromDate(''); setToDate(''); setBranchFilter(''); setStatusFilter('PENDING'); }}
            style={{ padding: '6px 12px', border: '1px solid #e5e7eb', background: '#fff', color: '#6b7280', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
            Clear
          </button>
        )}
      </div>

      {/* Deposits table */}
      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
        {liveDeposits.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8' }}>
            <FiInbox size={40} style={{ marginBottom: 12, opacity: 0.4 }} />
            <p style={{ fontStyle: 'italic' }}>{loading ? 'Loading...' : 'No deposits to show.'}</p>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            {/* 2026-09-13 — phone-cards: one card per deposit on phones (HQ and depots). */}
            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  {/* 2026-09-13 — Date, From (HQ only), Notes, Deposit #, Attachment,
                      then the rest. Click a heading to sort by it; click again to reverse.
                      The in/out arrow now sits inside the date cell, so on a phone card
                      the date is the card's title rather than a lone arrow. */}
                  <SortTh k="date"       label="Deposit Date" sort={sort} setSort={setSort} />
                  <SortTh k="from" label={onHq ? 'From' : 'From / To'} sort={sort} setSort={setSort} />
                  <SortTh k="notes"      label="Notes"        sort={sort} setSort={setSort} />
                  <SortTh k="number"     label="Deposit #"    sort={sort} setSort={setSort} />
                  <SortTh k="attachment" label="Attachment"   sort={sort} setSort={setSort} />
                  <SortTh k="amount"     label="Amount"       sort={sort} setSort={setSort} align="right" />
                  <SortTh k="status"     label="Status"       sort={sort} setSort={setSort} />
                  <SortTh k="created"    label="Created"      sort={sort} setSort={setSort} />
                  <SortTh k="confirmed"  label="Confirmed"    sort={sort} setSort={setSort} />
                  <th style={{ ...th, textAlign: 'right' }}></th>
                </tr>
              </thead>
              <tbody>
                {sortedDeposits.map(d => {
                  // A deleted deposit still shows — greyed, struck through and
                  // badged, with the reason on hover — so the record survives.
                  const isDeleted   = !!d.deleted_at;
                  const statusColor = isDeleted ? '#64748b' : d.status === 'CONFIRMED' ? '#16a34a' : d.status === 'REJECTED' ? '#dc2626' : '#d97706';
                  const statusBg    = isDeleted ? '#f1f5f9' : d.status === 'CONFIRMED' ? '#dcfce7' : d.status === 'REJECTED' ? '#fee2e2' : '#fef3c7';
                  // The side the deposit was sent to confirms, rejects and re-dates it.
                  const canReceive  = onHq || d._dir === 'in';
                  return (
                    <tr key={d.id}
                        title={isDeleted
                          ? `Deleted by ${d.deleted_by_name || 'unknown'}${d.delete_reason ? ' — ' + d.delete_reason : ''}`
                          : undefined}
                        style={{ borderTop: '1px solid #f1f5f9',
                                 opacity: isDeleted ? 0.55 : 1,
                                 textDecoration: isDeleted ? 'line-through' : 'none' }}>
                      <td style={{ ...td, color: '#374151', fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {canReceive
                            ? <FiArrowDownLeft size={14} color="#16a34a" title="Incoming" />
                            : <FiArrowUpRight  size={14} color="#d97706" title={`Outgoing to ${d.to_name || 'HQ'}`} />}
                          {d.deposit_date || (d.created_at ? new Date(d.created_at).toLocaleDateString() : '—')}
                        </span>
                      </td>
                      <td style={td}>{partyLabel(d)}</td>
                      <td style={{ ...td, color: '#6b7280', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.notes}>{d.notes || '—'}</td>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>{d.deposit_number}</td>
                      <td style={td}>
                        {(() => {
                          const atts = parseAttachments(d.attachment);
                          if (atts.length === 0) return <span style={{ color: '#cbd5e1', fontSize: 11 }}>—</span>;
                          const apiBase = (process.env.REACT_APP_API_URL || '/api').replace(/\/api\/?$/, '');
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                              {atts.map((p, i) => (
                                <a key={i} href={(d.from_slug && branchUploadUrl(d.from_slug, p)) || `${apiBase}/uploads/${p}`} target="_blank" rel="noopener noreferrer"
                                   style={{ color: '#2563eb', fontSize: 11, textDecoration: 'none', fontWeight: 600 }}>
                                  View {atts.length > 1 ? `#${i + 1}` : ''}
                                </a>
                              ))}
                            </div>
                          );
                        })()}
                      </td>
                      {/* 2026-09-11 — no Currency column (Kelete is all K); the
                          amount carries its symbol in front, K122,356. */}
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap' }}>
                        {d.currency === 'USD' ? fmt(d.amount) : `${d.currency === 'K' ? 'K' : `${d.currency} `}${fmtRaw(d.amount)}`}
                      </td>
                      <td style={td}>
                        <span style={{ padding: '2px 10px', background: statusBg, color: statusColor, borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
                          {d.status}
                        </span>
                        {d.status === 'REJECTED' && d.reject_reason && (
                          <div style={{ fontSize: 10, color: '#b91c1c', fontStyle: 'italic', marginTop: 3 }} title={d.reject_reason}>
                            {d.reject_reason.length > 30 ? d.reject_reason.slice(0, 30) + '…' : d.reject_reason}
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, color: '#6b7280', fontSize: 11 }}>
                        <div>{d.created_at ? new Date(d.created_at).toLocaleString() : '—'}</div>
                        {d.created_by_name && <div style={{ fontSize: 10 }}>by {d.created_by_name}</div>}
                      </td>
                      <td style={{ ...td, color: '#6b7280', fontSize: 11 }}>
                        {d.confirmed_at ? (
                          <>
                            <div>{new Date(d.confirmed_at).toLocaleString()}</div>
                            {d.confirmed_by_name && <div style={{ fontSize: 10 }}>by {d.confirmed_by_name}</div>}
                          </>
                        ) : '—'}
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', gap: 6 }}>
                          {canReceive && d.status === 'PENDING' && (
                            <>
                              <button onClick={() => handleConfirm(d)}
                                style={{ padding: '5px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <FiCheck size={11} /> Confirm
                              </button>
                              <button onClick={() => { setRejectingId(d.id); setRejectReason(''); }}
                                style={{ padding: '5px 12px', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                <FiX size={11} /> Reject
                              </button>
                            </>
                          )}
                          {/* v1.10.84 — HQ can edit accounting date on CONFIRMED
                              deposits. Admin-gated inside handleEditDate. */}
                          {canReceive && d.status === 'CONFIRMED' && (
                            <button onClick={() => handleEditDate(d)} title="Edit accounting date"
                              style={{ padding: '5px 10px', background: '#fff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <FiEdit2 size={11} />
                            </button>
                          )}
                          {/* Delete: a branch can delete its own PENDING rows.
                              2026-09-11 — no delete at HQ: HQ confirms or
                              rejects; a wrong deposit is the depot's to remove. */}
                          {!onHq && d._dir !== 'in' && d.status === 'PENDING' && (
                            <button onClick={() => handleDelete(d)} title="Delete deposit"
                              style={{ padding: '5px 10px', background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              <FiTrash2 size={11} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Send Deposit modal — branch side */}
      {showSend && (
        <Portal>
        <div className="modal-overlay" onClick={() => setShowSend(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="modal-header">
              <h2 style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <FiSend size={18} /> Send Deposit to {targetName}
              </h2>
              <button className="modal-close" onClick={() => setShowSend(false)}><FiX /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0, marginBottom: 14 }}>
                Record cash physically leaving this branch and going to {targetName}. No exchange happens — just enter the raw currency and amount. {targetName} marks it confirmed when they receive it.
              </p>
              <div className="form-row">
                <div className="form-group">
                  <label>Currency</label>
                  <select value={sendForm.currency}
                    onChange={e => setSendForm({ ...sendForm, currency: e.target.value })}>
                    {depositCcyOptions.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Amount ({sendForm.currency})</label>
                  <input type="number" min="0" step="0.01" value={sendForm.amount}
                    onChange={e => setSendForm({ ...sendForm, amount: e.target.value })}
                    placeholder="0.00" autoFocus />
                </div>
              </div>
              {/* v1.10.48 — From Drawer picker on Liquor branches so the
                  Cash Book tiles know which physical bucket shrank. Hidden
                  on Kelete tri-currency where deposits are currency-anchored
                  (USD/FRA/K), not method-anchored. */}
              {isLiquorStyle && (
                <div className="form-group">
                  <label>From Drawer</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {[
                      { value: 'Cash',         label: 'Cash on Hand',  color: '#16a34a' },
                      { value: 'Mobile Money', label: 'Mobile Money',  color: '#ea580c' },
                      { value: 'Bank',         label: 'Bank',          color: '#2563eb' },
                    // 2026-09-11 — MoMo / Bank follow System Settings → Payment methods shown.
                    ].filter(opt => methodShown(opt.value) || sendForm.from_method === opt.value).map(opt => {
                      const active = sendForm.from_method === opt.value;
                      return (
                        <button key={opt.value} type="button"
                          onClick={() => setSendForm({ ...sendForm, from_method: opt.value })}
                          style={{
                            flex: '1 1 130px', padding: '10px 12px', borderRadius: 8,
                            border: `2px solid ${active ? opt.color : '#e5e7eb'}`,
                            background: active ? `${opt.color}15` : '#fff',
                            color: active ? opt.color : '#374151',
                            fontWeight: active ? 700 : 500, fontSize: 13, cursor: 'pointer',
                          }}>
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="form-group">
                <label>Deposit Date</label>
                <input type="date" value={sendForm.deposit_date}
                  max={todayStr()}
                  onChange={e => setSendForm({ ...sendForm, deposit_date: e.target.value || todayStr() })} />
              </div>
              <div className="form-group">
                <label>Notes (optional)</label>
                <input value={sendForm.notes}
                  onChange={e => setSendForm({ ...sendForm, notes: e.target.value })}
                  placeholder="Courier / driver / reference" />
              </div>
              <div className="form-group">
                <label>Attach Deposit Slips (optional) — picture or PDF, multiple allowed</label>
                <div style={{ border: '1px dashed #d1d5db', borderRadius: 8, padding: 10, background: '#fafafa' }}>
                  {/* List of already-uploaded attachments with Remove */}
                  {(sendForm.attachments || []).length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
                      {sendForm.attachments.map((path, idx) => {
                        const isPdf = (path || '').toLowerCase().endsWith('.pdf');
                        const apiBase = (process.env.REACT_APP_API_URL || '/api').replace(/\/api\/?$/, '');
                        const url = `${apiBase}/uploads/${path}`;
                        const shortName = path.length > 36 ? `…${path.slice(-34)}` : path;
                        return (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                            {isPdf ? <FiFileText size={14} color="#dc2626" /> : <FiImage size={14} color="#16a34a" />}
                            <span style={{ flex: 1, fontSize: 11, fontFamily: 'monospace', color: '#374151', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{shortName}</span>
                            <a href={url} target="_blank" rel="noopener noreferrer"
                               style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 8px', background: '#dcfce7', color: '#166534', borderRadius: 4, fontSize: 11, fontWeight: 600, textDecoration: 'none' }}>
                              <FiEye size={11} /> View
                            </a>
                            <button type="button" onClick={() => removeAttachment(idx)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '3px 8px', background: '#fee2e2', color: '#b91c1c', border: 'none', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}>
                              <FiX size={11} /> Remove
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* Add buttons */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input ref={fileInputRef} type="file" accept="image/*,application/pdf" multiple
                      style={{ display: 'none' }}
                      onChange={e => { handleFilesPicked(e.target.files); e.target.value = ''; }} />
                    <input ref={camInputRef} type="file" accept="image/*" capture="environment"
                      style={{ display: 'none' }}
                      onChange={e => { handleFilesPicked(e.target.files); e.target.value = ''; }} />
                    <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploadingAtt}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: '#fff', color: '#2563eb', border: '1px solid #bfdbfe', borderRadius: 6, cursor: uploadingAtt ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600 }}>
                      <FiPaperclip size={12} /> {uploadingAtt ? 'Uploading…' : 'Choose files'}
                    </button>
                    <button type="button" onClick={() => camInputRef.current?.click()} disabled={uploadingAtt}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: '#fff', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: 6, cursor: uploadingAtt ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600 }}>
                      <FiCamera size={12} /> Camera
                    </button>
                    <span style={{ fontSize: 11, color: '#9ca3af', alignSelf: 'center' }}>
                      {(sendForm.attachments || []).length} attached
                    </span>
                  </div>
                  {attError && (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#b91c1c', fontWeight: 600 }}>{attError}</div>
                  )}
                </div>
              </div>
              {sendError && (
                <div style={{ padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6, color: '#991b1b', fontSize: 12, fontWeight: 600 }}>
                  {sendError}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <button onClick={() => setShowSend(false)}
                  style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>
                  Cancel
                </button>
                <button onClick={handleSend} disabled={sending}
                  style={{ padding: '10px 28px', background: sending ? '#9ca3af' : '#d97706', color: '#fff', border: 'none', borderRadius: 8, cursor: sending ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <FiSend size={14} />
                  {sending ? 'Sending...' : 'Send Deposit'}
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* Reject modal — HQ side */}
      {rejectingId && (
        <Portal>
        <div className="modal-overlay" onClick={() => setRejectingId(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h2>Reject Deposit</h2>
              <button className="modal-close" onClick={() => setRejectingId(null)}><FiX /></button>
            </div>
            <div className="modal-body">
              <p style={{ fontSize: 13, color: '#6b7280', marginTop: 0 }}>
                Tell the branch why you're rejecting (cash short, never arrived, wrong amount, etc.).
              </p>
              <div className="form-group">
                <label>Reason</label>
                <input value={rejectReason} onChange={e => setRejectReason(e.target.value)}
                  placeholder="Cash count was short by $50" autoFocus />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <button onClick={() => setRejectingId(null)}
                  style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>
                  Cancel
                </button>
                <button onClick={handleReject}
                  style={{ padding: '10px 28px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <FiX size={14} /> Reject
                </button>
              </div>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* v1.10.83/84 — admin password gate for both:
           - PENDING confirm-with-date-change (mode='confirm')
           - CONFIRMED edit-date (mode='edit') */}
      <AdminPasswordPrompt
        open={!!pendingDateChange}
        actionLabel={pendingDateChange?.mode === 'edit' ? 'Approve Date Edit' : 'Approve Date Change'}
        onConfirm={finishConfirmWithDate}
        onCancel={() => setPendingDateChange(null)}
      />
    </div>
  );
};

const th = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.4 };
const td = { padding: '10px 12px' };

// A clickable column heading. The first click on dates and amounts sorts
// newest / largest first; text columns start A→Z. Clicking again reverses.
const DESC_FIRST = new Set(['date', 'amount', 'created', 'confirmed']);

// 2026-09-13 — a deposit's photo lives in the SENDING depot's upload folder
// (TENANTS_DIR/<slug>/uploads/), and the server only serves a depot's folder
// on that depot's own address. Opened at HQ, a plain /uploads/... link looked
// in HQ's folder and answered "Cannot GET". Same helper as HqGrnArchive.
function branchUploadUrl(branchSlug, path) {
  if (!path || !branchSlug) return null;
  const currentHost = (typeof window !== 'undefined' && window.location && window.location.hostname) || '';
  if (currentHost.startsWith(`${branchSlug}.`)) return `/uploads/${path}`;
  const parts = currentHost.split('.');
  const apex = parts.length > 2 ? parts.slice(1).join('.') : currentHost;
  const proto = (typeof window !== 'undefined' && window.location.protocol) || 'https:';
  return `${proto}//${branchSlug}.${apex}/uploads/${path}`;
}
function SortTh({ k, label, sort, setSort, align }) {
  const active = sort.key === k;
  const onClick = () => setSort(active
    ? { key: k, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
    : { key: k, dir: DESC_FIRST.has(k) ? 'desc' : 'asc' });
  return (
    <th onClick={onClick} title={`Sort by ${label}`}
        aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        style={{ ...th, textAlign: align || 'left', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', color: active ? '#0f172a' : th.color }}>
      {label}
      <span style={{ marginLeft: 4, fontSize: 9, opacity: active ? 1 : 0.35 }}>
        {active ? (sort.dir === 'asc' ? '▲' : '▼') : '▲▼'}
      </span>
    </th>
  );
}

export default HQDeposits;
