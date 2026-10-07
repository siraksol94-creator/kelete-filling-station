// StockTransfers â€” universal page (HQ + per-branch) for moving stock
// between branches. Stored in master.db so both sides see one row.
//
// The "current branch" is derived from the host:
//   - HQ (keletezm.com): use the X-Branch the operator picked in the
//     sidebar dropdown (localStorage 'hq.branch').
//   - Per-branch (kassumbalesa1.keletezm.com): the host's first subdomain.
//
// Tabs:
//   Outgoing â€” transfers SENT from current branch. PENDING ones can be
//              cancelled (restores source stock).
//   Incoming â€” transfers HEADED TO current branch. PENDING ones can be
//              received (increments destination stock).
import React, { useEffect, useState, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import {
  FiRefreshCw, FiPlus, FiTruck, FiInbox, FiCheckCircle, FiXCircle, FiTrash2, FiEye, FiAlertTriangle,
} from 'react-icons/fi';
import {
  isHqHost, getHqBranch, getHqBranches, getBranchSlug,
  getTransferSourceProducts, getOutgoingTransfers, getIncomingTransfers,
  createTransfer, receiveTransfer, cancelTransfer,
  getProducts,
} from '../services/api';
import { sortBranches } from '../utils/sortBranches';
// v1.8.40 â€” show On Hand in the product's configured default unit
// (e.g. Box) instead of the raw base unit (Bottle).
import { formatStockForProduct } from '../utils/unitFormat';
import { matchTokens } from '../utils/tokenSearch';

function currentBranchSlug() {
  if (isHqHost()) return getHqBranch() || '';
  // Electron's hostname is always "localhost" â€” use the slug cached at
  // boot from /api/sync/status's vpsUrl (set in App.js).
  try {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return getBranchSlug() || '';
    }
    return host.split('.')[0];
  } catch { return getBranchSlug() || ''; }
}

// v1.13.53 â€” Kelete is K-only; the $ hard-code was misleading (showed $0
// on Send Transfer even though quantities were valued in Kwacha).
const fmtMoney = (n) => `K${parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty   = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// v1.9.22 â€” default the history date range to the last 30 days. Outgoing
// & Incoming "All Time" hits the LIMIT 500 ceiling on busy branches so
// the page should default to a recent window the user can widen.
const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

export default function StockTransfers() {
  const slug = currentBranchSlug();
  // 2026-09-15 â€” ?tab=incoming (from the incoming transfer notice) opens the
  // Incoming tab, also when the page is already open.
  const location = useLocation();
  const tabFromUrl = new URLSearchParams(location.search).get('tab') === 'incoming' ? 'incoming' : null;
  const [tab, setTab] = useState(tabFromUrl || 'outgoing');
  useEffect(() => { if (tabFromUrl) setTab(tabFromUrl); }, [location.key, tabFromUrl]);
  // v1.9.22 â€” sub-tab inside each main tab: pending | received | cancelled.
  // pending = active queue (no date filter); received/cancelled = history
  // (date filter applies).
  const [subTab, setSubTab]   = useState('pending');
  const [historyFrom, setHistoryFrom] = useState(daysAgoISO(30));
  const [historyTo,   setHistoryTo]   = useState(todayISO());
  const [out, setOut] = useState([]);     // pending only (count badge)
  const [inc, setInc] = useState([]);     // pending only (count badge)
  const [history, setHistory] = useState([]); // current sub-tab's history rows
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [toast, setToast] = useState(null);
  // v1.8.64 â€” View/Receive modal. `viewing` carries the transfer row to show.
  // `mode='view'` is read-only; `mode='receive'` exposes the per-line received
  // qty + reason inputs and a Confirm Receive button (only for PENDING incoming).
  const [viewing, setViewing] = useState(null); // { transfer, mode }

  // v1.9.22 â€” pending lists (small, always loaded for the count badges).
  // History loads on demand per active sub-tab.
  const refresh = async () => {
    if (!slug) return;
    setLoading(true);
    try {
      const [o, i] = await Promise.all([
        getOutgoingTransfers({ slug, status: 'PENDING' }),
        getIncomingTransfers({ slug, status: 'PENDING' }),
      ]);
      setOut(o.data?.transfers || []);
      setInc(i.data?.transfers || []);
    } catch (err) {
      // non-fatal â€” page still renders
    }
    setLoading(false);
  };

  // v1.9.22 â€” load the right history list whenever the user changes
  // tab/sub-tab/date-range. PENDING sub-tab uses the already-loaded
  // out/inc arrays; the historical sub-tabs hit the API with status
  // + date range.
  const refreshHistory = async () => {
    if (!slug) return;
    if (subTab === 'pending') return; // nothing to fetch â€” pending lists drive the table
    setLoading(true);
    try {
      const fetcher = tab === 'outgoing' ? getOutgoingTransfers : getIncomingTransfers;
      const statusMap = {
        received:  'RECEIVED',
        variance:  'RECEIVED_WITH_VARIANCE',
        cancelled: 'CANCELLED',
      };
      // "all" sub-tab: no status filter.
      //
      // 2026-08-29 â€” must be '' and NOT undefined. Axios drops undefined
      // params, so the request went out with no status at all â€” and
      // /transfers/incoming reads a MISSING status as 'PENDING' (its default
      // for the receiving queue). "All" therefore silently showed only
      // pending, i.e. nothing once everything had been received. An empty
      // string is sent, is defined server-side, and filters on nothing.
      // /transfers/outgoing has no such default, which is why Outgoing looked
      // fine and only Incoming was empty.
      const status = subTab === 'all' ? '' : statusMap[subTab];
      const r = await fetcher({ slug, status, from: historyFrom || undefined, to: historyTo || undefined });
      setHistory(r.data?.transfers || []);
    } catch (err) {
      setHistory([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!slug) return;
    refresh();
    // 2026-09-20 â€” alphabetical, by the depot name people see. The list
    // arrives newest-first, so a depot had to be hunted for.
    getHqBranches().then(r => setBranches(sortBranches(r.data?.branches || []))).catch(() => {});
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  // eslint-disable-next-line
  }, [slug]);

  // v1.9.22 â€” re-fetch history whenever the active history view changes.
  useEffect(() => {
    refreshHistory();
  // eslint-disable-next-line
  }, [slug, tab, subTab, historyFrom, historyTo]);

  // v1.9.22 â€” when switching main tab, reset sub-tab to pending so the
  // user always starts on the actionable queue.
  useEffect(() => { setSubTab('pending'); }, [tab]);

  const flash = (text, type) => {
    setToast({ text, type });
    setTimeout(() => setToast(null), type === 'error' ? 4500 : 2500);
  };

  // v1.8.64 â€” Open the View/Receive modal instead of accepting blindly.
  // For incoming + PENDING, the modal exposes per-line received qty +
  // reason so the receiver can record shortages / damage / loss before
  // confirming. Anything else opens read-only.
  const doReceive = (transfer) => {
    setViewing({ transfer, mode: transfer.status === 'PENDING' ? 'receive' : 'view' });
  };
  const doView = (transfer) => {
    setViewing({ transfer, mode: 'view' });
  };
  const submitReceive = async (id, payload) => {
    try {
      const res = await receiveTransfer(id, payload);
      const hadVariance = res?.data?.status === 'RECEIVED_WITH_VARIANCE';
      flash(hadVariance ? 'Stock received with variance â€” HQ notified.' : 'Stock received.', 'success');
      setViewing(null);
      refresh();
      window.dispatchEvent(new Event('stock:refresh'));
    } catch (err) {
      flash(err?.response?.data?.error || 'Receive failed', 'error');
    }
  };

  const doCancel = async (id) => {
    if (!window.confirm('Cancel this transfer? Stock will be returned to the source branch.')) return;
    try {
      await cancelTransfer(id);
      flash('Transfer cancelled.', 'success');
      refresh();
    } catch (err) {
      flash(err?.response?.data?.error || 'Cancel failed', 'error');
    }
  };

  if (!slug) {
    return (
      <div className="page-content">
        <div className="page-header"><div><h1>Stock Transfers</h1></div></div>
        <p style={{ color: '#b91c1c' }}>No branch selected. Pick a branch in the HQ sidebar first.</p>
      </div>
    );
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Stock Transfers</h1>
          <p>Move stock between branches Â· current branch: <strong>{slug}</strong></p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={refresh}
            style={{ padding: '8px 14px', background: '#f1f5f9', color: '#0f172a', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiRefreshCw /> Refresh
          </button>
          <button onClick={() => setShowCreate(true)}
            style={{ padding: '8px 14px', background: '#0ea5e9', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <FiPlus /> Send Transfer
          </button>
        </div>
      </div>

      {toast && (
        <div style={{
          position: 'fixed', top: 80, right: 20, zIndex: 999,
          padding: '12px 18px', borderRadius: 8, color: '#fff', fontWeight: 600,
          background: toast.type === 'error' ? '#dc2626' : '#16a34a',
        }}>{toast.text}</div>
      )}

      {/* Main tabs: Outgoing | Incoming */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 14, background: '#f1f5f9', borderRadius: 8, padding: 3, width: 'fit-content' }}>
        <TabButton active={tab === 'outgoing'} onClick={() => setTab('outgoing')}>
          <FiTruck /> Outgoing ({out.length} pending)
        </TabButton>
        <TabButton active={tab === 'incoming'} onClick={() => setTab('incoming')}>
          <FiInbox /> Incoming ({inc.length} pending)
        </TabButton>
      </div>

      {/* v1.9.22 â€” sub-tabs + date filter. Pending shows the live queue;
          Received / Variance / Cancelled show history (date-filtered). */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { id: 'pending',   label: 'Pending' },
            { id: 'received',  label: 'Received' },
            { id: 'variance',  label: 'With Variance' },
            { id: 'cancelled', label: 'Cancelled' },
            // v1.13.91 â€” "All" shows every historical transfer regardless
            // of status. Same date filter applies; skips the status query.
            { id: 'all',       label: 'All' },
          ].map(s => (
            <button key={s.id} onClick={() => setSubTab(s.id)}
              style={{
                padding: '6px 14px', borderRadius: 16, border: '1px solid',
                borderColor: subTab === s.id ? '#0ea5e9' : '#e2e8f0',
                background: subTab === s.id ? '#0ea5e9' : '#fff',
                color: subTab === s.id ? '#fff' : '#475569',
                cursor: 'pointer', fontSize: 12, fontWeight: 600,
              }}>
              {s.label}
            </button>
          ))}
        </div>
        {subTab !== 'pending' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: '#475569' }}>
            <span>From</span>
            <input type="date" value={historyFrom} onChange={e => setHistoryFrom(e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12 }} />
            <span>To</span>
            <input type="date" value={historyTo} onChange={e => setHistoryTo(e.target.value)}
              style={{ padding: '5px 8px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 12 }} />
            <button onClick={() => { setHistoryFrom(daysAgoISO(30)); setHistoryTo(todayISO()); }}
              style={{ padding: '5px 10px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>
              Last 30d
            </button>
          </div>
        )}
      </div>

      <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        {(() => {
          // v1.9.22 â€” pick which list to render based on main tab + sub-tab.
          // Pending uses the in-memory polled list (out/inc); history sub-
          // tabs use the on-demand fetched list (`history`). Direction
          // controls which action buttons render in the table.
          const rows = subTab === 'pending'
            ? (tab === 'outgoing' ? out : inc)
            : history;
          const direction = tab === 'outgoing' ? 'out' : 'in';
          return direction === 'out'
            ? <TransferTable rows={rows} loading={loading} direction="out" onCancel={doCancel} onView={doView} />
            : <TransferTable rows={rows} loading={loading} direction="in"  onReceive={doReceive} onView={doView} />;
        })()}
      </div>

      {viewing && (
        <TransferDetailModal
          transfer={viewing.transfer}
          mode={viewing.mode}
          onClose={() => setViewing(null)}
          onSubmit={(payload) => submitReceive(viewing.transfer.id, payload)}
        />
      )}

      {showCreate && (
        <CreateTransferModal
          sourceSlug={slug}
          branches={branches}
          onClose={() => setShowCreate(false)}
          onCreated={() => { setShowCreate(false); flash('Transfer sent.', 'success'); refresh(); }}
          onError={(msg) => flash(msg, 'error')}
        />
      )}
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      style={{
        padding: '8px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
        background: active ? '#fff' : 'transparent', color: active ? '#0f172a' : '#64748b',
        fontWeight: active ? 700 : 500, fontSize: 13,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
      }}>{children}</button>
  );
}

function TransferTable({ rows, loading, direction, onReceive, onCancel, onView }) {
  if (loading && rows.length === 0) return <p style={{ color: '#64748b' }}>Loadingâ€¦</p>;
  if (rows.length === 0) return <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>No transfers.</p>;

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead style={{ background: '#f8fafc' }}>
          <tr>
            <th style={th}>Transfer #</th>
            <th style={th}>{direction === 'out' ? 'To' : 'From'}</th>
            <th style={{ ...th, textAlign: 'right' }}>Items</th>
            <th style={{ ...th, textAlign: 'right' }}>Value</th>
            <th style={th}>Status</th>
            <th style={th}>Created</th>
            {/* 2026-09-04 â€” "By" was the sender only. Both names are stored on
                the transfer row (created_by_name at Send, received_by_name at
                Receive) and cost nothing to show, so the two halves are now
                separate. Received by stays blank while a transfer is PENDING,
                which is itself useful â€” it says who has not confirmed yet. */}
            <th style={th}>Sent by</th>
            <th style={th}>Received by</th>
            <th style={th}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map(t => (
            <tr key={t.id} style={{ borderTop: '1px solid #f1f5f9' }}>
              <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{t.transfer_number}</td>
              <td style={td}>
                <strong>{direction === 'out' ? t.to_name : t.from_name}</strong>{' '}
                <span style={{ color: '#94a3b8', fontSize: 11 }}>({direction === 'out' ? t.to_slug : t.from_slug})</span>
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{t.total_items}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(t.total_value)}</td>
              <td style={td}>{statusBadge(t.status)}</td>
              <td style={td}>{t.created_at ? new Date(t.created_at).toLocaleString() : 'â€”'}</td>
              <td style={td}>{t.created_by_name || 'â€”'}</td>
              <td style={{ ...td, color: t.received_by_name ? '#0f172a' : '#94a3b8' }}>
                {t.received_by_name || 'â€”'}
              </td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>
                <div style={{ display: 'inline-flex', gap: 6 }}>
                  {/* v1.8.64 â€” View always visible. Receive routes through
                      the same modal so the user can verify items + record
                      shortages/damage before confirming. */}
                  <button onClick={() => onView(t)}
                    style={{ padding: '5px 12px', background: '#fff', color: '#0369a1', border: '1px solid #bae6fd', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <FiEye size={12} /> View
                  </button>
                  {direction === 'in' && t.status === 'PENDING' && (
                    <button onClick={() => onReceive(t)}
                      style={{ padding: '5px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <FiCheckCircle size={12} /> Receive
                    </button>
                  )}
                  {direction === 'out' && t.status === 'PENDING' && (
                    <button onClick={() => onCancel(t.id)}
                      style={{ padding: '5px 12px', background: '#fff', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <FiXCircle size={12} /> Cancel
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateTransferModal({ sourceSlug, branches, onClose, onCreated, onError }) {
  const [toSlug, setToSlug] = useState('');
  const [products, setProducts] = useState([]);
  const [search, setSearch] = useState('');
  const [cart, setCart] = useState({}); // { product_sync_id: { product, qty } }
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // v1.10.54 â€” WAC redesign push 2: one FX rate per whole transfer.
  // Same shape as the HQ PO modal. Required when destination is
  // tri-currency (USD+FRA / USD+FRA+K), skipped on K-only branches.
  const [costCurrency, setCostCurrency] = useState('');
  const [fxRate, setFxRate] = useState('');
  const destBranch = branches.find(b => b.slug === toSlug);
  const destIsTriCcy = (() => {
    const cm = String(destBranch?.currency_mode || 'K').toUpperCase();
    return cm === 'USD+FRA' || cm === 'USD+FRA+K';
  })();
  useEffect(() => { setCostCurrency(''); setFxRate(''); }, [toSlug]);

  useEffect(() => {
    getTransferSourceProducts(sourceSlug)
      .then(r => setProducts(r.data?.products || []))
      .catch(err => onError(err?.response?.data?.error || 'Failed to load products'));
  // eslint-disable-next-line
  }, [sourceSlug]);

  const filtered = useMemo(() => {
    return products.filter(p => matchTokens(search, p.name, p.code, p.barcode));
  }, [products, search]);

  // v1.8.47 â€” input + cart speak the product's configured default unit
  // (e.g. Box) instead of always the base unit (Bottle). cart.qty is the
  // value the user typed *in that unit*. We convert to base only at
  // submit time so the backend math (conversionToBase) stays identical.
  const getDisplayUnit = (p) => {
    const baseName = p?.unit || '';
    let units = null;
    if (p?.units_json) {
      try { units = JSON.parse(p.units_json); } catch { units = null; }
    }
    if (!Array.isArray(units) || units.length === 0) return { name: baseName, conv: 1 };
    const defaultName = (p?.default_unit || '').trim().toLowerCase();
    if (!defaultName) return { name: baseName, conv: 1 };
    const match = units.find(u => (u.name || '').toLowerCase() === defaultName && parseFloat(u.conv) > 0);
    return match ? { name: match.name, conv: parseFloat(match.conv) } : { name: baseName, conv: 1 };
  };

  const setQty = (p, qty) => {
    const n = parseFloat(qty) || 0;
    setCart(c => {
      const next = { ...c };
      if (n <= 0) delete next[p.sync_id];
      else {
        const u = getDisplayUnit(p);
        next[p.sync_id] = { product: p, qty: n, unitName: u.name, unitConv: u.conv };
      }
      return next;
    });
  };

  const cartItems = Object.values(cart);
  // v1.13.53 â€” prefer avg_cost_price (real WAC blended by GRNs/transfers)
  // over cost_price (static hint entered on create). Same three-step chain
  // profitHelper + cost_at_sale trigger + Item Details use. Was showing $0
  // for products with cost_price=0 even when avg_cost_price was populated.
  const wacOf = (p) => (parseFloat(p?.avg_cost_price) > 0 ? parseFloat(p.avg_cost_price) : parseFloat(p?.cost_price) || 0);
  // qty is in display unit; cost is per base unit â€” multiply by conv.
  const totalValue = cartItems.reduce((s, x) => s + x.qty * (x.unitConv || 1) * wacOf(x.product), 0);

  const submit = async () => {
    if (!toSlug)          return onError('Pick a destination branch');
    if (cartItems.length === 0) return onError('Add at least one product');
    // v1.10.54 â€” validate FX inputs when destination is tri-currency.
    if (destIsTriCcy) {
      if (!costCurrency) return onError('Pick the source cost currency (destination is tri-currency).');
      if (costCurrency !== 'USD' && !(parseFloat(fxRate) > 0)) {
        return onError(`Enter the FX rate: 1 USD = ? ${costCurrency}`);
      }
    }
    setSubmitting(true);
    try {
      await createTransfer({
        from_slug: sourceSlug,
        to_slug:   toSlug,
        notes,
        // v1.10.54 â€” only send FX fields when destination is tri-currency;
        // K-only destinations omit them so backend stores NULL.
        ...(destIsTriCcy && costCurrency
          ? { cost_currency: costCurrency, fx_rate_used: costCurrency === 'USD' ? 1 : parseFloat(fxRate) }
          : {}),
        items: cartItems.map(x => ({
          product_sync_id: x.product.sync_id,
          product_name:    x.product.name,
          // Always send in base unit â€” backend conversionToBase(prod, unit)
          // expects (qty, unit) to be self-consistent. Easiest: convert here.
          unit:            x.product.unit,
          quantity:        x.qty * (x.unitConv || 1),
          // v1.13.53 â€” carry real WAC on the transfer so the destination's
          // WAC blend + cost_at_sale trigger start from truth, not the stale
          // static hint. Same wacOf() helper used in totalValue above.
          cost_price:      wacOf(x.product),
          // v1.8.66 â€” carry the product's default-unit metadata so the
          // View / Receive modal can render qty + cost in the configured
          // default unit (e.g. Box) instead of the raw base unit (Bottle).
          // Stored verbatim in items_json; backend math is unchanged.
          display_unit:    x.unitName || x.product.unit,
          display_conv:    x.unitConv || 1,
        })),
      });
      onCreated();
    } catch (err) {
      onError(err?.response?.data?.error || 'Failed to send');
    }
    setSubmitting(false);
  };

  const destChoices = branches.filter(b => b.slug !== sourceSlug);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 12, width: 'min(880px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Send Transfer Â· from <span style={{ color: '#0ea5e9' }}>{sourceSlug}</span></h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>Ã—</button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div>
              <label style={lbl}>To Branch</label>
              <select value={toSlug} onChange={e => setToSlug(e.target.value)} style={inp}>
                <option value="">â€” pick a destination â€”</option>
                {destChoices.map(b => <option key={b.slug} value={b.slug}>{b.name} ({b.slug})</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Notes (optional)</label>
              <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Truck #, driver, etc." style={inp} />
            </div>
          </div>

          {/* v1.10.54 â€” WAC redesign push 2: FX rate row.
              Only rendered when destination is a tri-currency branch. One
              rate applies to every line on this transfer and is used at
              /receive time to blend delivery CP into destination WAC. */}
          {destIsTriCcy && (
            <div style={{ marginBottom: 14, padding: '10px 12px', background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#78350f', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
                FX Rate (required â€” destination is tri-currency)
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div>
                  <label style={lbl}>Cost currency at source <span style={{ color: '#dc2626' }}>*</span></label>
                  <select value={costCurrency} onChange={e => setCostCurrency(e.target.value)} style={inp}>
                    <option value="">â€” currency â€”</option>
                    <option value="USD">USD ($)</option>
                    <option value="K">K (Kwacha)</option>
                    <option value="FRA">FRA</option>
                  </select>
                </div>
                <div>
                  <label style={lbl}>1 USD = <span style={{ color: '#dc2626' }}>*</span></label>
                  <input type="number" min="0" step="0.0001"
                    value={fxRate}
                    onChange={e => setFxRate(e.target.value)}
                    disabled={!costCurrency || costCurrency === 'USD'}
                    placeholder={costCurrency === 'USD' ? 'n/a â€” USD already' : costCurrency === 'K' ? 'e.g. 25' : costCurrency === 'FRA' ? 'e.g. 2250' : ''}
                    style={{ ...inp, background: (!costCurrency || costCurrency === 'USD') ? '#f9fafb' : '#fff' }} />
                </div>
              </div>
              <div style={{ fontSize: 10.5, color: '#78350f', marginTop: 6, fontStyle: 'italic' }}>
                One rate locks the whole transfer. Used to convert source cost â†’ USD for the destination's WAC.
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 14 }}>
            {/* Product picker */}
            <div>
              <label style={lbl}>Products at {sourceSlug}</label>
              <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Searchâ€¦"
                style={{ ...inp, marginBottom: 8 }} />
              <div style={{ maxHeight: 360, overflowY: 'auto', border: '1px solid #e5e7eb', borderRadius: 8 }}>
                <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ background: '#f8fafc', position: 'sticky', top: 0 }}>
                    <tr><th style={thS}>Product</th><th style={{ ...thS, textAlign: 'right' }}>On Hand</th><th style={{ ...thS, textAlign: 'right', width: 100 }}>Send Qty</th></tr>
                  </thead>
                  <tbody>
                    {filtered.map(p => {
                      // v1.8.47 â€” both On Hand display and Send Qty input now
                      // use the product's configured default unit (e.g. Box).
                      const displayQty = formatStockForProduct(p.current_stock, p, {
                        showBaseInParens: true, decimals: 0,
                        allowNegative: true, preferDefaultUnit: true,
                      });
                      const dispUnit = getDisplayUnit(p);
                      return (
                      <tr key={p.sync_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                        <td style={tdS}>{p.name} <span style={{ color: '#94a3b8', fontSize: 10 }}>{p.unit}</span></td>
                        <td style={{ ...tdS, textAlign: 'right' }}>{displayQty}</td>
                        <td style={{ ...tdS, textAlign: 'right' }}>
                          <input type="number" min="0" step="any" placeholder={`0 ${dispUnit.name}`}
                            value={cart[p.sync_id]?.qty || ''}
                            onChange={e => setQty(p, e.target.value)}
                            title={`Enter quantity in ${dispUnit.name}`}
                            style={{ width: 80, padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, textAlign: 'right' }} />
                        </td>
                      </tr>
                      );
                    })}
                    {filtered.length === 0 && (
                      <tr><td colSpan={3} style={{ ...tdS, color: '#94a3b8', fontStyle: 'italic', padding: 16 }}>No products match.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Cart preview */}
            <div>
              <label style={lbl}>Cart ({cartItems.length} line{cartItems.length === 1 ? '' : 's'})</label>
              <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, background: '#f8fafc', minHeight: 250 }}>
                {cartItems.length === 0 ? (
                  <p style={{ color: '#94a3b8', fontSize: 12, fontStyle: 'italic', textAlign: 'center', margin: '40px 0' }}>Enter quantities in the table to build the transfer.</p>
                ) : (
                  <>
                    {cartItems.map(x => {
                      const unitName = x.unitName || x.product.unit;
                      const conv     = x.unitConv || 1;
                      // v1.13.55 â€” align per-line preview with totalValue by
                      // reading the same wacOf(product) source instead of the
                      // raw cost_price. Was showing K0.00 per line even though
                      // the total was correct.
                      const perUnit  = wacOf(x.product) * conv;
                      const lineTotal= x.qty * perUnit;
                      return (
                        <div key={x.product.sync_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 4px', borderBottom: '1px dashed #e5e7eb' }}>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{x.product.name}</div>
                            <div style={{ fontSize: 10, color: '#64748b' }}>{fmtQty(x.qty)} {unitName} Ã— {fmtMoney(perUnit)}</div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <strong style={{ fontSize: 13 }}>{fmtMoney(lineTotal)}</strong>
                            <button onClick={() => setQty(x.product, 0)} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', padding: 2 }}>
                              <FiTrash2 size={14} />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, paddingTop: 8, borderTop: '1px solid #cbd5e1' }}>
                      <strong>Total value</strong>
                      <strong>{fmtMoney(totalValue)}</strong>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div style={{ padding: 14, borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '10px 18px', background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            Cancel
          </button>
          <button onClick={submit} disabled={submitting || !toSlug || cartItems.length === 0}
            style={{ padding: '10px 22px',
                     background: !toSlug || cartItems.length === 0 || submitting ? '#94a3b8' : 'linear-gradient(135deg,#16a34a,#15803d)',
                     color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 700,
                     display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <FiTruck /> {submitting ? 'Sendingâ€¦' : 'Send Transfer'}
          </button>
        </div>
      </div>
    </div>
  );
}

function statusBadge(s) {
  const map = {
    'PENDING':   ['#fef3c7', '#92400e', 'Pending'],
    'RECEIVED':  ['#dcfce7', '#166534', 'Received'],
    'CANCELLED': ['#fee2e2', '#991b1b', 'Cancelled'],
    'RECEIVED_WITH_VARIANCE': ['#fef3c7', '#92400e', 'Received Â· Variance'],
  };
  const [bg, fg, label] = map[s] || ['#e2e8f0', '#0f172a', s];
  return <span style={{ background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>;
}

// v1.8.64 â€” Transfer detail modal. Two modes:
//   'view'    â€” read-only summary (any transfer, any status)
//   'receive' â€” receiver's confirmation flow. Per-line inputs for
//               received_qty + reason (OK/Short/Damaged/Lost) + notes,
//               with a live variance preview. Submits to /receive.
const REASON_OPTIONS = [
  { value: 'OK',      label: 'OK (qty matches)' },
  { value: 'Short',   label: 'Short (fewer arrived)' },
  { value: 'Damaged', label: 'Damaged' },
  { value: 'Lost',    label: 'Lost in transit' },
];

function TransferDetailModal({ transfer, mode, onClose, onSubmit }) {
  const items = useMemo(() => {
    try {
      const raw = transfer.items_json ? JSON.parse(transfer.items_json) : (Array.isArray(transfer.items) ? transfer.items : []);
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }, [transfer]);

  // v1.8.92 â€” pull the product list so we can resolve each line's CURRENT
  // default_unit (e.g. Box), instead of whatever unit was used at send time.
  // Old behaviour: if a transfer was sent in Bottle (1 conv), the detail
  // modal also showed Bottle â€” wrong for products whose preferred display
  // is Box. Now we always render in the product's configured default_unit.
  // Falls back to items_json's display_unit (then base unit) if the product
  // can't be found in the response (deleted, sync gap, etc).
  const [products, setProducts] = useState([]);
  useEffect(() => {
    getProducts()
      .then(r => setProducts(Array.isArray(r.data) ? r.data : (r.data?.products || [])))
      .catch(() => setProducts([]));
  }, []);
  const productBySync = useMemo(() => {
    const m = {};
    for (const p of products) if (p.sync_id) m[p.sync_id] = p;
    return m;
  }, [products]);
  const getDisplayFor = (it) => {
    const p = productBySync[it.product_sync_id];
    if (p) {
      const baseName = (p.unit || '').toLowerCase();
      const defaultName = (p.default_unit || '').trim();
      if (defaultName && defaultName.toLowerCase() !== baseName) {
        try {
          const units = JSON.parse(p.units_json || '[]');
          const match = (Array.isArray(units) ? units : []).find(u =>
            (u.name || '').toLowerCase() === defaultName.toLowerCase() && parseFloat(u.conv) > 0);
          if (match) return { unit: match.name, conv: parseFloat(match.conv) };
        } catch { /* fall through */ }
      }
      return { unit: p.unit, conv: 1 };
    }
    return { unit: it.display_unit || it.unit, conv: parseFloat(it.display_conv || 1) || 1 };
  };

  // Per-line edit state â€” receive mode only.
  // v1.8.66 â€” qty + cost displayed in the product's default unit (Box).
  // Initial state uses items_json's display info; useEffect below replaces
  // it with the product's current default_unit once products arrive.
  const [lines, setLines] = useState(() =>
    items.map(it => {
      const dispUnit = it.display_unit || it.unit;
      const dispConv = parseFloat(it.display_conv || 1) || 1;
      const sentBase = parseFloat(it.quantity || 0);
      const sentDisp = sentBase / dispConv;
      // v1.13.46 â€” items_json now carries received_qty/reason/notes after
      // /receive (backend stamps them there). For pending transfers or old
      // rows saved before this fix, received_qty is missing â†’ fall back to
      // sent so the Receive modal opens at full and old View modals keep
      // their prior behaviour instead of breaking.
      const hasRecv = it.received_qty !== undefined && it.received_qty !== null;
      const recvBase = hasRecv ? parseFloat(it.received_qty || 0) : sentBase;
      const recvDisp = recvBase / dispConv;
      return {
        product_sync_id: it.product_sync_id,
        product_name:    it.product_name,
        unit:            it.unit,          // base unit (Bottle)
        display_unit:    dispUnit,         // friendly unit (Box)
        display_conv:    dispConv,         // 1 Box = N Bottle
        cost_price:      parseFloat(it.cost_price || 0),    // per BASE unit
        cost_display:    parseFloat(it.cost_price || 0) * dispConv, // per Box
        sent_qty:        sentDisp,         // shown in display unit
        received_qty:    String(recvDisp), // shown in display unit
        reason:          it.receive_reason || 'OK',
        notes:           it.receive_notes || '',
      };
    })
  );

  // v1.8.92 â€” once products load, swap each line's display_unit/conv for the
  // product's CURRENT default_unit. Preserves any received_qty the user typed
  // by converting it to the new unit.
  useEffect(() => {
    if (products.length === 0) return;
    setLines(prev => prev.map((l, i) => {
      const it = items[i];
      if (!it) return l;
      const { unit: newUnit, conv: newConv } = getDisplayFor(it);
      if (l.display_unit === newUnit && Math.abs((l.display_conv || 1) - newConv) < 0.0001) return l;
      const sentBase = parseFloat(it.quantity || 0);
      const oldConv = parseFloat(l.display_conv) || 1;
      const wasUntouched = String(parseFloat(l.received_qty) || 0) === String(parseFloat(l.sent_qty) || 0);
      const recvBaseIfTouched = (parseFloat(l.received_qty) || 0) * oldConv;
      return {
        ...l,
        display_unit: newUnit,
        display_conv: newConv,
        cost_display: parseFloat(l.cost_price || 0) * newConv,
        sent_qty:     sentBase / newConv,
        received_qty: wasUntouched ? String(sentBase / newConv) : String(recvBaseIfTouched / newConv),
      };
    }));
    // eslint-disable-next-line
  }, [productBySync]);
  const [submitting, setSubmitting] = useState(false);

  const setLine = (idx, field, value) => {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, [field]: value } : l));
  };

  // Auto-bump the reason when received_qty changes vs sent_qty.
  const onReceivedChange = (idx, value) => {
    setLines(prev => prev.map((l, i) => {
      if (i !== idx) return l;
      const recv = parseFloat(value || 0);
      const isOk = !isNaN(recv) && Math.abs(recv - l.sent_qty) < 0.0001;
      const next = { ...l, received_qty: value };
      // Only auto-flip the reason if the user hasn't manually set something
      // more specific (Damaged / Lost) â€” preserve their explicit choice.
      if (l.reason === 'OK' || l.reason === 'Short') {
        next.reason = isOk ? 'OK' : 'Short';
      }
      return next;
    }));
  };

  const totalSent = lines.reduce((s, l) => s + (parseFloat(l.sent_qty) || 0), 0);
  const totalRecv = lines.reduce((s, l) => s + (parseFloat(l.received_qty) || 0), 0);
  const totalVar  = totalSent - totalRecv;
  const anyVariance = lines.some(l => {
    const v = (parseFloat(l.sent_qty) || 0) - (parseFloat(l.received_qty) || 0);
    return v > 0.0001 || l.reason === 'Damaged' || l.reason === 'Lost';
  });

  const submit = async () => {
    setSubmitting(true);
    try {
      // v1.8.66 â€” received_qty is in display unit (Box); backend expects
      // base units (Bottle). Multiply by display_conv before sending.
      const payload = {
        received_lines: lines.map(l => ({
          product_sync_id: l.product_sync_id,
          received_qty:    Math.max(0, (parseFloat(l.received_qty) || 0) * (parseFloat(l.display_conv) || 1)),
          reason:          l.reason || 'OK',
          notes:           l.notes || null,
        })),
      };
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  };

  const isReceive = mode === 'receive';
  const fmtQ = (n) => parseFloat(n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: 12, width: 'min(900px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h3 style={{ margin: 0 }}>{isReceive ? 'Receive Transfer' : 'Transfer Detail'} Â· {transfer.transfer_number}</h3>
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
              From <strong>{transfer.from_name || transfer.from_slug}</strong> â†’ To <strong>{transfer.to_name || transfer.to_slug}</strong>
              {transfer.created_by_name && <> Â· Sent by {transfer.created_by_name}</>}
              {transfer.created_at && <> Â· {new Date(transfer.created_at).toLocaleString()}</>}
            </div>
            {transfer.notes && (
              <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>Notes: <em>{transfer.notes}</em></div>
            )}
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: '#64748b' }}>Ã—</button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', flex: 1 }}>
          {items.length === 0 && (
            <p style={{ color: '#94a3b8', fontStyle: 'italic' }}>This transfer has no items.</p>
          )}
          {items.length > 0 && (
            <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead style={{ background: '#f8fafc' }}>
                <tr>
                  <th style={th}>Item</th>
                  <th style={{ ...th, textAlign: 'right' }}>Sent</th>
                  <th style={{ ...th, textAlign: 'right' }}>{isReceive ? 'Received' : 'Received'}</th>
                  <th style={th}>Reason</th>
                  <th style={th}>Notes</th>
                  <th style={{ ...th, textAlign: 'right' }}>Cost / unit</th>
                  <th style={{ ...th, textAlign: 'right' }}>Line $</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, idx) => {
                  const recvNum = parseFloat(l.received_qty) || 0;
                  const variance = (parseFloat(l.sent_qty) || 0) - recvNum;
                  // v1.8.66 â€” cost shown is per-display-unit (per Box) so
                  // the line total = received_qty (in Box) Ã— cost_per_Box.
                  // Numerically identical to received_base Ã— cost_per_base
                  // â€” just easier to read.
                  const dispUnit = l.display_unit || l.unit;
                  const lineDollar = recvNum * (parseFloat(l.cost_display || l.cost_price) || 0);
                  const hasIssue = variance > 0.0001 || l.reason === 'Damaged' || l.reason === 'Lost';
                  return (
                    <tr key={idx} style={{ borderTop: '1px solid #f1f5f9', background: hasIssue ? '#fffbeb' : '#fff' }}>
                      <td style={td}><strong>{l.product_name}</strong> <span style={{ color: '#94a3b8', fontSize: 11 }}>{l.unit}</span></td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmtQ(l.sent_qty)} {dispUnit}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        {isReceive ? (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <input type="number" min="0" step="any" value={l.received_qty}
                              onChange={e => onReceivedChange(idx, e.target.value)}
                              style={{ width: 80, padding: '4px 6px', border: `1px solid ${hasIssue ? '#fbbf24' : '#d1d5db'}`, borderRadius: 4, fontSize: 13, textAlign: 'right' }} />
                            <span style={{ fontSize: 11, color: '#94a3b8' }}>{dispUnit}</span>
                          </div>
                        ) : (
                          <span style={{ fontWeight: 600 }}>{fmtQ(l.received_qty)} {dispUnit}</span>
                        )}
                      </td>
                      <td style={td}>
                        {isReceive ? (
                          <select value={l.reason} onChange={e => setLine(idx, 'reason', e.target.value)}
                            style={{ padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12, background: '#fff' }}>
                            {REASON_OPTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                        ) : (
                          <span style={{ fontSize: 12, color: hasIssue ? '#b45309' : '#16a34a' }}>{l.reason}</span>
                        )}
                      </td>
                      <td style={td}>
                        {isReceive ? (
                          <input value={l.notes} onChange={e => setLine(idx, 'notes', e.target.value)}
                            placeholder={hasIssue ? 'e.g. crate broken on arrival' : ''}
                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 4, fontSize: 12 }} />
                        ) : (
                          <span style={{ fontSize: 12, color: '#475569' }}>{l.notes || 'â€”'}</span>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'right', color: '#64748b' }}>
                        {fmtMoney(l.cost_display || l.cost_price)}
                        <div style={{ fontSize: 10, color: '#cbd5e1' }}>/ {dispUnit}</div>
                      </td>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 700 }}>{fmtMoney(lineDollar)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #e5e7eb', fontWeight: 700 }}>
                  <td style={td}>Totals</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtQ(totalSent)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtQ(totalRecv)}</td>
                  <td colSpan={2} style={{ ...td, color: totalVar > 0.001 ? '#b45309' : '#475569' }}>
                    {totalVar > 0.001 ? `Variance: ${fmtQ(totalVar)}` : ''}
                  </td>
                  <td colSpan={2} style={{ ...td, textAlign: 'right' }}>{fmtMoney(transfer.total_value)}</td>
                </tr>
              </tfoot>
            </table>
          )}

          {isReceive && anyVariance && (
            <div style={{ marginTop: 14, padding: '10px 14px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, fontSize: 12, color: '#92400e', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <FiAlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
              <div>
                <strong>Variance detected.</strong> Confirming will book only the received qty into your stock. The shortfall will be recorded in Transit Variance for HQ to investigate. Make sure the reason + notes are accurate before you confirm.
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '8px 18px', background: '#fff', color: '#374151', border: '1px solid #e5e7eb', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}>
            {isReceive ? 'Cancel' : 'Close'}
          </button>
          {isReceive && (
            <button onClick={submit} disabled={submitting || items.length === 0}
              style={{ padding: '8px 22px', background: submitting ? '#94a3b8' : '#16a34a', color: '#fff', border: 'none', borderRadius: 6, cursor: submitting ? 'not-allowed' : 'pointer', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <FiCheckCircle size={14} /> {submitting ? 'Receivingâ€¦' : (anyVariance ? 'Confirm Receive with Variance' : 'Confirm Receive')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const lbl = { display: 'block', fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 4 };
const inp = { width: '100%', padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13, background: '#fff', boxSizing: 'border-box' };
const th  = { padding: '10px 12px', fontSize: 11, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase', letterSpacing: 0.5 };
const td  = { padding: '8px 12px', color: '#0f172a' };
const thS = { padding: '6px 8px', fontSize: 10, color: '#64748b', fontWeight: 700, textAlign: 'left', textTransform: 'uppercase' };
const tdS = { padding: '6px 8px', color: '#0f172a' };
